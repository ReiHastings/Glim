// -----------------------------------------------------------------------------
// Title:       sync.js
// Project:     Glim
// Author:      Reina Hastings (reinahastings13@gmail.com)
// Created:     2026-03-26
// Last Modified: 2026-09-08
// Purpose:     Background sync service. Pushes localStorage data to Firestore
//              and pulls remote changes back into localStorage so data stays
//              in sync across devices. localStorage remains the primary
//              read/write layer - the app never waits on Firebase.
//
//              Two families of id-keyed document domain, with DIFFERENT push
//              rules, and the distinction is load-bearing:
//
//              WRITE-ONCE (journal, water, steps, nutrition logs): a row is
//              created and never edited afterwards, except that undo sets
//              deletedAt. A re-push therefore carries the same fields as the
//              first push, PLUS deletedAt once set, and never a null deletedAt
//              (writeOncePayload strips it) - so a blind setDoc with merge can
//              only ever add a soft-delete, never clear one. That is what makes
//              it idempotent and safe on any path, including the
//              fire-and-forget tab-hide flush.
//
//              MUTABLE (nutrition-library, symptoms, symptoms-library,
//              symptom-categories, symptom-days): rows are edited in place and
//              carry updatedAt. A blind push of a stale copy overwrites a newer
//              remote copy INCLUDING its updatedAt, after which last-write-wins
//              has nothing newer left to prefer and the two devices diverge
//              permanently. These domains therefore PULL BEFORE THEY PUSH and
//              push only what the snapshot shows to be newer or absent
//              (syncUpdatedAtCollection), and they never ride the tab-hide
//              flush. See the Decision Register entry of 2026-09-06.
//
//              Sync triggers: startup, every 60 seconds while foregrounded,
//              and tab focus all run syncAll (push + pull). Tab-hide runs
//              flushSync (write-once push only). Sign-out awaits a full
//              syncAll. A hidden tab's interval is throttled or frozen by the
//              browser, so the honest bound on "next syncAll" for a
//              backgrounded tab is "when it is next foregrounded".
//
//              After a pull that changes localStorage, fires a
//              'glim-data-updated' CustomEvent so DesktopPet can reload.
//
// Inputs:      Firebase db and auth from firebase.js
// Outputs:     CustomEvent('glim-data-updated', { detail: { domains: [...] } })
// Usage:       import { startSync, stopSync, syncAll } from './sync'
//              startSync(uid)   // call after auth
//              await syncAll()  // call before sign-out (full reconcile)
//              stopSync()       // call on sign-out
// -----------------------------------------------------------------------------

import { db } from './firebase';
import {
  collection, doc, getDocs, setDoc, getDoc,
} from 'firebase/firestore';

// --- Internal state ---

let syncInterval = null;
let visibilityHandler = null;
let currentUid = null;

// --- localStorage helpers ---

function localGet(key) {
  try {
    const val = localStorage.getItem(key);
    return val ? JSON.parse(val) : null;
  } catch {
    return null;
  }
}

function localSetRaw(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch (e) {
    console.warn('[glim sync] localStorage write failed:', e);
  }
}

function localSet(key, data) {
  localSetRaw(key, JSON.stringify(data));
}

// --- Sync metadata (last push time for the four write-once domains only) ---

function getSyncMeta() {
  return localGet('glim-sync-meta') ?? {};
}

function setSyncMeta(updates) {
  localSet('glim-sync-meta', { ...getSyncMeta(), ...updates });
}

// Watermark keys retired on 2026-09-06, when the mutable domains stopped gating
// their push on a pushedAt stamp and started gating on the remote snapshot
// instead (see syncUpdatedAtCollection). Nothing reads them any more; they are
// pruned once per session so glim-sync-meta reflects what the code uses and
// cannot mislead a future reader into thinking these domains still have a
// watermark to advance.
const RETIRED_META_KEYS = [
  'nutritionLibraryPushedAt', 'symptomsPushedAt', 'symptomsLibraryPushedAt',
  'symptomsCategoriesPushedAt', 'symptomDaysPushedAt',
];

function pruneStaleSyncMeta() {
  const meta  = getSyncMeta();
  const stale = RETIRED_META_KEYS.filter(k => k in meta);
  if (stale.length === 0) return;
  for (const k of stale) delete meta[k];
  localSet('glim-sync-meta', meta);
}

// Millisecond value of an ISO timestamp; 0 when absent, NaN when malformed.
function ts(v) {
  return v ? new Date(v).getTime() : 0;
}

// Does timestamp `a` beat timestamp `b`? Strictly greater wins; a missing stamp
// is 0 and so loses to any real one.
//
// A MALFORMED stamp (NaN) never wins and always loses. This matters: a naive
// `ts(a) > ts(b)` is false in BOTH directions when either side is NaN, which
// made a corrupt row a mutual veto - the good copy was never pushed over it and
// it was never replaced by the good copy, so it froze on the server and
// propagated to every new device. Well-formed must beat malformed so the one
// good copy can heal the rest. Two malformed stamps tie and nothing moves.
function beats(a, b) {
  const ta = ts(a), tb = ts(b);
  const aOk = !Number.isNaN(ta), bOk = !Number.isNaN(tb);
  if (!aOk) return false;
  if (!bOk) return true;
  return ta > tb;
}

// The document a WRITE-ONCE row is pushed as. Identical to the row except that
// a null/undefined deletedAt is OMITTED rather than written. setDoc with merge
// writes every field it is given, null included, so a stale re-push of a row
// created with `deletedAt: null` would overwrite a soft-delete another device
// has since recorded - and every pull branch that propagates a soft-delete
// (water, nutrition, and journal since 2026-09-08) does so only for a TRUTHY
// remote deletedAt, so a null written over a timestamp would never be repaired.
// Omitting the field means a re-push can add a soft-delete but never clear one.
// Nutrition logs are created with the explicit null; water and journal happen
// to omit the key at creation; steps has no soft-delete at all. This helper
// makes all four domains behave the same regardless.
function writeOncePayload(entry) {
  if (entry.deletedAt === null || entry.deletedAt === undefined) {
    const { deletedAt: _omit, ...rest } = entry;
    return rest;
  }
  return entry;
}

// --- Notify React components that localStorage has changed ---

function notify(domains) {
  window.dispatchEvent(new CustomEvent('glim-data-updated', { detail: { domains } }));
}

// --- Write-once push helpers (shared by full sync and flushSync) ---
//
// These operate ONLY on the four WRITE-ONCE event-log domains (journal, water,
// steps, nutrition logs). Blind-pushing one of their rows is safe for two
// reasons that must BOTH hold: the row is keyed by its own unique id, so it can
// never overwrite a different row; and the row is never edited after creation,
// so a re-push is byte-identical and cannot overwrite a newer version of
// itself. Being id-keyed alone is NOT sufficient - the mutable domains are also
// id-keyed and are unsafe to blind-push (see syncUpdatedAtCollection).
//
// The push-filter functions are module-scoped so the full sync functions and
// flushSync share one definition (no drift). pushEntries deliberately does NOT
// advance the pushedAt watermark: flushSync runs opportunistically (tab-hide,
// possibly offline), and advancing the watermark on a push that silently failed
// would skip that entry on the next real sync. Re-pushing on the next syncAll is
// idempotent (setDoc merge by id), so not advancing here only costs a harmless
// re-push.

function journalNeedsPush(e, last) {
  const created = new Date(e.createdAt || e.date || 0);
  const deleted = e.deletedAt ? new Date(e.deletedAt) : null;
  return created > last || (deleted && deleted > last);
}

function stepsEntryNeedsPush(e, last) {
  return new Date(e.timestamp) > last;
}

// Water entries: shared by syncWater and flushSync so the soft-delete-aware
// filter lives in exactly one place.
function waterEntryNeedsPush(e, last) {
  const created = new Date(e.timestamp);
  const deleted = e.deletedAt ? new Date(e.deletedAt) : null;
  return created > last || (deleted && deleted > last);
}

function nutritionLogNeedsPush(e, last) {
  const created = new Date(e.createdAt || 0);
  const deleted = e.deletedAt ? new Date(e.deletedAt) : null;
  return created > last || (deleted && deleted > last);
}

async function pushEntries(uid, collectionName, list, lastPushedAt, needsPush) {
  const ref = collection(db, 'users', uid, collectionName);
  const toPush = list.filter(e => needsPush(e, lastPushedAt));
  for (const entry of toPush) {
    try {
      await setDoc(doc(ref, String(entry.id)), writeOncePayload(entry), { merge: true });
    } catch (e) {
      console.warn(`[glim flush] ${collectionName} push failed:`, entry.id, e);
    }
  }
}

// =============================================================================
//  Journal sync
//  Strategy: event-log merge. One Firestore doc per entry.
//  Firestore path: users/{uid}/journal/{entryId}
//  Push: entries created/soft-deleted after lastPushedAt
//  Pull: entries in Firestore not present in localStorage, plus soft-deletes
//        for entries present on both sides (newer remote deletedAt wins)
// =============================================================================

async function syncJournal(uid) {
  const meta = getSyncMeta();
  const lastPushedAt = meta.journalPushedAt ? new Date(meta.journalPushedAt) : new Date(0);

  const rawEntries = localGet('glim-journal');
  const entries = Array.isArray(rawEntries) ? rawEntries : [];

  const journalRef = collection(db, 'users', uid, 'journal');

  // --- PUSH: entries that are new or newly soft-deleted since last push ---
  const toPush = entries.filter(e => journalNeedsPush(e, lastPushedAt));

  for (const entry of toPush) {
    try {
      await setDoc(doc(journalRef, String(entry.id)), writeOncePayload(entry), { merge: true });
    } catch (e) {
      console.warn('[glim sync] journal push failed for entry:', entry.id, e);
    }
  }

  // --- PULL: Firestore entries not in localStorage ---
  let snapshot;
  try {
    snapshot = await getDocs(journalRef);
  } catch (e) {
    console.warn('[glim sync] journal pull failed:', e);
    return;
  }

  // Add entries missing locally, and propagate soft-deletes for entries present
  // on both sides (an entry deleted on another device carries a newer
  // deletedAt). Ported from syncWater on 2026-09-08: journal was the first sync
  // domain and predated that branch, so a journal delete reached the server but
  // never reached a second device that already held the entry.
  const localById = new Map(entries.map(e => [String(e.id), e]));
  const toAdd = [];
  let updated = false;

  snapshot.forEach(d => {
    const remote = d.data();
    const localE = localById.get(d.id);
    if (!localE) {
      toAdd.push(remote);
    } else if (remote.deletedAt && (!localE.deletedAt || new Date(remote.deletedAt) > new Date(localE.deletedAt))) {
      localE.deletedAt = remote.deletedAt;
      updated = true;
    }
  });

  if (toAdd.length > 0 || updated) {
    const merged = [...entries, ...toAdd].sort(
      (a, b) => new Date(b.createdAt || b.date || 0) - new Date(a.createdAt || a.date || 0)
    );
    localSet('glim-journal', merged);
    notify(['journal']);
  }

  // Always advance pushedAt, even when there was nothing to push locally.
  // A device that only pulled remote entries would otherwise keep lastPushedAt
  // at epoch and re-push all pulled entries on the next cycle.
  setSyncMeta({ journalPushedAt: new Date().toISOString() });
}

// =============================================================================
//  Pokes sync
//  Strategy: take the max of local and remote (pokes only ever increase).
//  Firestore path: users/{uid}/pokes/counters
// =============================================================================

async function syncPokes(uid) {
  const localRaw = localStorage.getItem('glim-pokes');
  const localTotal = localRaw ? (parseInt(localRaw, 10) || 0) : 0;

  const pokesRef = doc(db, 'users', uid, 'pokes', 'counters');

  try {
    const snap = await getDoc(pokesRef);
    const remoteTotal = snap.exists() ? (snap.data().total ?? 0) : 0;

    if (localTotal >= remoteTotal) {
      // Local has more pokes (or same): push to Firestore
      await setDoc(pokesRef, {
        total: localTotal,
        lastModified: new Date().toISOString(),
      }, { merge: true });
    } else {
      // Remote has more pokes: update local
      localSetRaw('glim-pokes', String(remoteTotal));
      notify(['pokes']);
    }
  } catch (e) {
    console.warn('[glim sync] pokes sync failed:', e);
  }
}

// =============================================================================
//  Settings sync
//  Strategy: last-write-wins by lastModified timestamp.
//  Firestore path: users/{uid}/settings/current
// =============================================================================

async function syncSettings(uid) {
  let localSettings = null;
  try {
    const val = localStorage.getItem('glim-settings');
    localSettings = val ? JSON.parse(val) : null;
  } catch { /* ignore */ }

  const settingsRef = doc(db, 'users', uid, 'settings', 'current');

  try {
    const snap = await getDoc(settingsRef);
    const remoteSettings = snap.exists() ? snap.data() : null;

    const localTime = localSettings?.lastModified ? new Date(localSettings.lastModified) : new Date(0);
    const remoteTime = remoteSettings?.lastModified ? new Date(remoteSettings.lastModified) : new Date(0);

    if (!remoteSettings || localTime >= remoteTime) {
      // Local is newer (or no remote yet): push to Firestore
      if (localSettings) {
        await setDoc(settingsRef, localSettings, { merge: true });
      }
    } else {
      // Remote is newer: update local
      localSet('glim-settings', remoteSettings);
      notify(['settings']);
    }
  } catch (e) {
    console.warn('[glim sync] settings sync failed:', e);
  }
}

// =============================================================================
//  Water sync
//  Entries strategy: additive merge. One Firestore doc per entry.
//  Firestore path: users/{uid}/water/{entryId}
//  Push: entries created after waterPushedAt
//  Pull: entries in Firestore not present in localStorage
//
//  Config strategy: last-write-wins by configUpdatedAt.
//  Firestore path: users/{uid}/water-config/current
// =============================================================================

async function syncWater(uid) {
  const meta         = getSyncMeta();
  const lastPushedAt = meta.waterPushedAt ? new Date(meta.waterPushedAt) : new Date(0);

  let local;
  try {
    const raw = localStorage.getItem('glim-water');
    local = raw ? JSON.parse(raw) : { entries: [], bottleOz: 24, goal: 6, configUpdatedAt: new Date(0).toISOString() };
  } catch {
    return;
  }

  const entries    = Array.isArray(local.entries) ? local.entries : [];
  const entriesRef = collection(db, 'users', uid, 'water');

  // --- PUSH: entries created or soft-deleted since last push ---
  const toPush = entries.filter(e => waterEntryNeedsPush(e, lastPushedAt));

  for (const entry of toPush) {
    try {
      await setDoc(doc(entriesRef, String(entry.id)), writeOncePayload(entry), { merge: true });
    } catch (e) {
      console.warn('[glim sync] water entry push failed:', entry.id, e);
    }
  }

  // --- PULL: Firestore entries not in local ---
  let snapshot;
  try {
    snapshot = await getDocs(entriesRef);
  } catch (e) {
    console.warn('[glim sync] water pull failed:', e);
    return;
  }

  // Add entries missing locally, and propagate soft-deletes for entries present
  // on both sides (a bottle undone on another device carries a newer deletedAt).
  const localById = new Map(entries.map(e => [String(e.id), e]));
  const toAdd = [];
  let updated = false;
  snapshot.forEach(d => {
    const remote = d.data();
    const localE = localById.get(d.id);
    if (!localE) {
      toAdd.push(remote);
    } else if (remote.deletedAt && (!localE.deletedAt || new Date(remote.deletedAt) > new Date(localE.deletedAt))) {
      localE.deletedAt = remote.deletedAt;
      updated = true;
    }
  });

  let changed = false;
  if (toAdd.length > 0 || updated) {
    const merged = [...entries, ...toAdd].sort((a, b) => a.timestamp - b.timestamp);
    local = { ...local, entries: merged };
    changed = true;
  }

  // --- CONFIG: last-write-wins by configUpdatedAt ---
  const configRef    = doc(db, 'users', uid, 'water-config', 'current');
  const localConfig  = { bottleOz: local.bottleOz, goal: local.goal, configUpdatedAt: local.configUpdatedAt ?? new Date(0).toISOString() };

  try {
    const configSnap   = await getDoc(configRef);
    const remoteConfig = configSnap.exists() ? configSnap.data() : null;
    const localTime    = localConfig.configUpdatedAt ? new Date(localConfig.configUpdatedAt) : new Date(0);
    const remoteTime   = remoteConfig?.configUpdatedAt ? new Date(remoteConfig.configUpdatedAt) : new Date(0);

    if (!remoteConfig || localTime >= remoteTime) {
      await setDoc(configRef, localConfig, { merge: true });
    } else {
      local   = { ...local, bottleOz: remoteConfig.bottleOz, goal: remoteConfig.goal, configUpdatedAt: remoteConfig.configUpdatedAt };
      changed = true;
    }
  } catch (e) {
    console.warn('[glim sync] water config sync failed:', e);
  }

  if (changed) {
    localSet('glim-water', local);
    notify(['water']);
  }

  // Always advance pushedAt, even when there was nothing to push locally.
  // A device that only pulled remote entries would otherwise keep lastPushedAt
  // at epoch and re-push all pulled entries on the next cycle.
  setSyncMeta({ waterPushedAt: new Date().toISOString() });
}

// =============================================================================
//  Steps sync
//  Entries strategy: additive merge. One Firestore doc per entry.
//  Firestore path: users/{uid}/steps/{entryId}
//  Push: entries created after stepsPushedAt
//  Pull: entries in Firestore not present in localStorage
//
//  Replace-style resolution (latest entry per date wins) happens in the store's
//  derived value layer (countForDate), not here. The sync layer is purely
//  additive - it only adds missing entries, never removes or overwrites.
// =============================================================================

async function syncSteps(uid) {
  const meta         = getSyncMeta();
  const lastPushedAt = meta.stepsPushedAt ? new Date(meta.stepsPushedAt) : new Date(0);

  let local;
  try {
    const raw = localStorage.getItem('glim-steps');
    local = raw ? JSON.parse(raw) : { entries: [] };
  } catch {
    return;
  }

  const entries    = Array.isArray(local.entries) ? local.entries : [];
  const entriesRef = collection(db, 'users', uid, 'steps');

  // --- PUSH: entries created since last push ---
  const toPush = entries.filter(e => stepsEntryNeedsPush(e, lastPushedAt));

  for (const entry of toPush) {
    try {
      await setDoc(doc(entriesRef, String(entry.id)), writeOncePayload(entry), { merge: true });
    } catch (e) {
      console.warn('[glim sync] steps entry push failed:', entry.id, e);
    }
  }

  // --- PULL: Firestore entries not in local ---
  let snapshot;
  try {
    snapshot = await getDocs(entriesRef);
  } catch (e) {
    console.warn('[glim sync] steps pull failed:', e);
    return;
  }

  const localIdSet = new Set(entries.map(e => String(e.id)));
  const toAdd = [];
  snapshot.forEach(d => {
    if (!localIdSet.has(d.id)) toAdd.push(d.data());
  });

  if (toAdd.length > 0) {
    const merged = [...entries, ...toAdd].sort((a, b) => a.timestamp - b.timestamp);
    local = { ...local, entries: merged };
    localStorage.setItem('glim-steps', JSON.stringify(local));
    notify(['steps']);
  }

  // Always advance pushedAt, even when there was nothing to push locally.
  // A device that only pulled remote entries would otherwise keep lastPushedAt
  // at epoch and re-push all pulled entries on the next cycle.
  setSyncMeta({ stepsPushedAt: new Date().toISOString() });
}

// =============================================================================
//  Steps config sync
//  Strategy: last-write-wins by configUpdatedAt (same as water/nutrition config).
//  Firestore path: users/{uid}/steps-config/current
//  Config lives inside the same 'glim-steps' localStorage blob as the entries
//  but syncs through its own Firestore doc, matching the water pattern.
// =============================================================================

async function syncStepsConfig(uid) {
  let local;
  try {
    const raw = localStorage.getItem('glim-steps');
    local = raw ? JSON.parse(raw) : null;
  } catch {
    return;
  }
  if (!local) return;

  const localConfig = {
    goal:            local.goal,
    configUpdatedAt: local.configUpdatedAt ?? new Date(0).toISOString(),
  };
  const configRef = doc(db, 'users', uid, 'steps-config', 'current');

  try {
    const snap         = await getDoc(configRef);
    const remoteConfig = snap.exists() ? snap.data() : null;
    const localTime    = new Date(localConfig.configUpdatedAt);
    const remoteTime   = remoteConfig?.configUpdatedAt ? new Date(remoteConfig.configUpdatedAt) : new Date(0);

    if (!remoteConfig || localTime >= remoteTime) {
      // Local is newer (or no remote): push
      await setDoc(configRef, localConfig, { merge: true });
    } else {
      // Remote is newer: pull
      local = { ...local, goal: remoteConfig.goal, configUpdatedAt: remoteConfig.configUpdatedAt };
      localSet('glim-steps', local);
      notify(['steps']);
    }
  } catch (e) {
    console.warn('[glim sync] steps config sync failed:', e);
  }
}

// =============================================================================
//  Nutrition logs sync
//  Strategy: additive merge + soft-delete propagation (same as journal).
//  Firestore path: users/{uid}/nutrition/{entryId}
//  Push: entries with createdAt or deletedAt newer than nutritionPushedAt
//  Pull: entries not present locally, or remote deletedAt newer than local
// =============================================================================

async function syncNutritionLogs(uid) {
  const meta         = getSyncMeta();
  const lastPushedAt = meta.nutritionPushedAt ? new Date(meta.nutritionPushedAt) : new Date(0);

  let local;
  try {
    const raw = localStorage.getItem('glim-nutrition');
    local = raw ? JSON.parse(raw) : { logs: [], goals: {}, configUpdatedAt: null };
  } catch {
    return;
  }

  const logs      = Array.isArray(local.logs) ? local.logs : [];
  const logsRef   = collection(db, 'users', uid, 'nutrition');

  // --- PUSH: entries created or soft-deleted since last push ---
  const toPush = logs.filter(e => nutritionLogNeedsPush(e, lastPushedAt));

  for (const entry of toPush) {
    try {
      await setDoc(doc(logsRef, String(entry.id)), writeOncePayload(entry), { merge: true });
    } catch (e) {
      console.warn('[glim sync] nutrition log push failed:', entry.id, e);
    }
  }

  // --- PULL: Firestore entries not in localStorage, or with newer deletedAt ---
  let snapshot;
  try {
    snapshot = await getDocs(logsRef);
  } catch (e) {
    console.warn('[glim sync] nutrition log pull failed:', e);
    return;
  }

  const localById = new Map(logs.map(e => [String(e.id), e]));
  const toAdd     = [];
  let updated     = false;

  snapshot.forEach(d => {
    const remote  = d.data();
    const localE  = localById.get(d.id);
    if (!localE) {
      toAdd.push(remote);
    } else if (remote.deletedAt && (!localE.deletedAt || new Date(remote.deletedAt) > new Date(localE.deletedAt))) {
      // Remote has a newer soft-delete - propagate it
      localE.deletedAt = remote.deletedAt;
      updated = true;
    }
  });

  if (toAdd.length > 0 || updated) {
    const merged = [...logs, ...toAdd].sort(
      (a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0)
    );
    local = { ...local, logs: merged };
    localSet('glim-nutrition', local);
    notify(['nutrition']);
  }

  setSyncMeta({ nutritionPushedAt: new Date().toISOString() });
}

// =============================================================================
//  Nutrition config sync
//  Strategy: last-write-wins by configUpdatedAt (same as water config).
//  Firestore path: users/{uid}/nutrition-config/current
// =============================================================================

async function syncNutritionConfig(uid) {
  let local;
  try {
    const raw = localStorage.getItem('glim-nutrition');
    local = raw ? JSON.parse(raw) : null;
  } catch {
    return;
  }
  if (!local) return;

  const localGoals           = local.goals ?? {};
  const localConfigUpdatedAt = local.configUpdatedAt ?? new Date(0).toISOString();
  const configRef            = doc(db, 'users', uid, 'nutrition-config', 'current');

  try {
    const snap         = await getDoc(configRef);
    const remoteConfig = snap.exists() ? snap.data() : null;
    const localTime    = new Date(localConfigUpdatedAt);
    const remoteTime   = remoteConfig?.configUpdatedAt ? new Date(remoteConfig.configUpdatedAt) : new Date(0);

    if (!remoteConfig || localTime >= remoteTime) {
      // Local is newer (or no remote): push
      await setDoc(configRef, { goals: localGoals, configUpdatedAt: localConfigUpdatedAt }, { merge: true });
    } else {
      // Remote is newer: pull
      local = { ...local, goals: remoteConfig.goals, configUpdatedAt: remoteConfig.configUpdatedAt };
      localSet('glim-nutrition', local);
      notify(['nutrition']);
    }
  } catch (e) {
    console.warn('[glim sync] nutrition config sync failed:', e);
  }
}

// =============================================================================
//  Nutrition library sync
//  Mutable domain: rides syncUpdatedAtCollection (defined below) exactly as the
//  symptom collections do. It previously had its own copy of the same
//  push-then-pull merge, which carried the same stale-push hole; one
//  implementation means one place to get this right.
//  Firestore path: users/{uid}/nutrition-library/{itemId}
// =============================================================================

async function syncNutritionLibrary(uid) {
  return syncUpdatedAtCollection(uid, {
    storageKey:     'glim-nutrition-library',
    arrayField:     'items',
    collectionName: 'nutrition-library',
    domain:         'nutrition-library',
  });
}

// =============================================================================
//  Mutable-domain sync (symptoms, symptoms-library, symptom-categories,
//  symptom-days, nutrition-library)
//
//  Strategy for ALL FIVE: additive merge by id + edit propagation via updatedAt
//  last-write-wins per document, including deletedAt propagation.
//  Firestore paths: users/{uid}/symptoms/{entryId}
//                   users/{uid}/symptoms-library/{itemId}
//                   users/{uid}/symptom-categories/{categoryId}
//                   users/{uid}/symptom-days/{logicalDateString}
//                   users/{uid}/nutrition-library/{itemId}
//
//  ORDER IS THE WHOLE POINT: PULL, MERGE, THEN PUSH.
//
//  The previous shape was push-then-pull, with the push gated only on a local
//  watermark. A device that edited a row while offline would, on reconnecting,
//  blind-push its stale copy over a newer remote copy - and because updatedAt is
//  a field on the row, the push overwrote THAT too, so the subsequent pull had
//  nothing newer to prefer. The other device would never re-push (its watermark
//  had already advanced) and never adopt (its local was newer than the regressed
//  remote). Permanent, silent divergence. Reproduced in
//  tests/symptoms_sync.test.mjs (Y8).
//
//  Pulling first supplies the missing information at zero extra cost: getDocs
//  was already being called, one step too late to be useful. The push is then
//  gated on the snapshot itself - a row is sent only when the server has no copy
//  of it or the local copy is strictly newer - so a stale row is never written.
//  The residual window is the single round trip between getDocs and setDoc,
//  versus the previous window, which was however long the device was offline.
//
//  NO WATERMARK. With the snapshot in hand, comparing every local row against
//  its remote counterpart is free and strictly more accurate than a pushedAt
//  stamp. It also makes the push self-healing: a setDoc that failed on a flaky
//  connection is retried on the next sync until it lands, whereas a watermark
//  that had already advanced past that row would have abandoned it forever.
//  Steady state is zero pushes, because every row matches.
//
//  If the pull fails we push NOTHING. Without the snapshot we cannot know what
//  we would be overwriting, and an offline device's writes would fail anyway.
//  (A read that fails while writes would succeed - read quota exhausted, say -
//  therefore withholds the push until the next sync. Accepted.)
//
//  KNOWN NON-CONVERGENT STATES, all accepted (decision of 2026-09-08):
//    - equal updatedAt with different content: neither side is strictly newer,
//      so nothing moves. Reachable only by a same-millisecond edit on two
//      devices or a bug that reuses a stamp.
//    - malformed updatedAt on BOTH sides: beats() ties, nothing moves. A
//      malformed stamp on ONE side loses to the well-formed one (see beats).
//    - remote row with NO updatedAt key (legacy) against a local row with a
//      MALFORMED one: beats(missing, malformed) is true, so the merge adopts,
//      but Object.assign cannot remove a key the remote lacks, so the corrupt
//      local stamp survives and the same adoption repeats every sync - one
//      localSet and one store reload per tick, no push, no data change. Left
//      as is: it needs a pre-updatedAt legacy row AND a corrupt local stamp on
//      the same document, which no code path of this client can produce. The
//      fix, if it is ever needed, is to rank missing and malformed as equal in
//      beats() so that cell becomes a tie.
//
//  The merge is deliberately WHOLESALE: on a concurrent offline edit of the same
//  row, the newer updatedAt wins every field. No field-level merge (accepted
//  lost-update window, Decision Register 2026-08-14).
//
//  symptom-categories is keyed by a category id, which for the four seeded rows
//  is a FIXED string (cat-pain, ...) generated identically on every device - see
//  utils/symptomCategories.js. symptom-days is keyed by the LOGICAL DATE STRING,
//  so two devices used on the same day necessarily contend for the same
//  document; it is the domain for which this ordering matters most.
// =============================================================================

async function syncUpdatedAtCollection(uid, { storageKey, arrayField, collectionName, domain }) {
  let local;
  try {
    const raw = localStorage.getItem(storageKey);
    local = raw ? JSON.parse(raw) : { [arrayField]: [] };
  } catch {
    return;
  }

  // Non-object elements (a null from a bad write, say) are dropped here rather
  // than allowed to throw at `d.id` below, which would reject this domain's
  // promise and, before syncAll used allSettled, race sign-out for every other
  // domain.
  const rawDocs = Array.isArray(local[arrayField]) ? local[arrayField] : [];
  const docs    = rawDocs.filter(d => d && typeof d === 'object');
  if (docs.length !== rawDocs.length) {
    console.warn(`[glim sync] ${collectionName}: skipped ${rawDocs.length - docs.length} malformed local row(s)`);
    // Keep `local` and `docs` in step, so the post-merge push below (which
    // reads from `local`) never sees the elements filtered out here.
    local = { ...local, [arrayField]: docs };
  }
  const docsRef = collection(db, 'users', uid, collectionName);

  // --- Step 1: PULL the whole collection. No snapshot, no push. ---
  let snapshot;
  try {
    snapshot = await getDocs(docsRef);
  } catch (e) {
    console.warn(`[glim sync] ${collectionName} pull failed; skipping push:`, e);
    return;
  }

  const remoteById = new Map();
  snapshot.forEach(d => remoteById.set(d.id, d.data()));

  // --- Step 2: MERGE remote-newer rows into local (last-write-wins) ---
  const localById = new Map(docs.map(d => [String(d.id), d]));
  const toAdd     = [];
  let updated     = false;

  for (const [id, remote] of remoteById) {
    const localDoc = localById.get(id);
    if (!localDoc) {
      toAdd.push(remote);                       // new row from another device
    } else if (beats(remote.updatedAt, localDoc.updatedAt)) {
      // Remote wins wholesale. Object.assign overwrites every key remote
      // carries; a key present locally but absent remotely survives. Rows
      // written by this client always carry every key (null, never undefined,
      // because Firestore rejects undefined), so that only arises across a
      // schema change.
      Object.assign(localDoc, remote);
      updated = true;
    }
  }

  if (toAdd.length > 0 || updated) {
    const merged = [...docs, ...toAdd].sort((a, b) => ts(a.createdAt) - ts(b.createdAt));
    local = { ...local, [arrayField]: merged };
    localSet(storageKey, local);
    notify([domain]);
  }

  // --- Step 3: PUSH only what the snapshot shows to be absent or older ---
  // Runs over the post-merge list, so a row the pull just replaced compares
  // equal to its remote copy and is skipped.
  const finalDocs = Array.isArray(local[arrayField]) ? local[arrayField] : [];
  for (const entry of finalDocs) {
    const remote = remoteById.get(String(entry.id));
    if (remote && !beats(entry.updatedAt, remote.updatedAt)) continue;
    try {
      await setDoc(doc(docsRef, String(entry.id)), entry, { merge: true });
    } catch (e) {
      console.warn(`[glim sync] ${collectionName} push failed:`, entry.id, e);
    }
  }
}

async function syncSymptoms(uid) {
  return syncUpdatedAtCollection(uid, {
    storageKey:     'glim-symptoms',
    arrayField:     'logs',
    collectionName: 'symptoms',
    domain:         'symptoms',
  });
}

async function syncSymptomsLibrary(uid) {
  return syncUpdatedAtCollection(uid, {
    storageKey:     'glim-symptoms-library',
    arrayField:     'items',
    collectionName: 'symptoms-library',
    domain:         'symptoms-library',
  });
}

async function syncSymptomsCategories(uid) {
  return syncUpdatedAtCollection(uid, {
    storageKey:     'glim-symptoms-categories',
    arrayField:     'items',
    collectionName: 'symptom-categories',
    domain:         'symptom-categories',
  });
}

async function syncSymptomClearDays(uid) {
  return syncUpdatedAtCollection(uid, {
    storageKey:     'glim-symptom-days',
    arrayField:     'days',
    collectionName: 'symptom-days',
    domain:         'symptom-days',
  });
}

// =============================================================================
//  Sync orchestrator
// =============================================================================

// `uid` defaults to the active session; the parameter exists for the tests,
// which drive this against the Firestore mock without startSync.
//
// allSettled, not all: every domain function catches its own I/O errors, but a
// synchronous throw (corrupt local data) rejects that domain's promise, and
// Promise.all would then resolve syncAll early while the other domains were
// still mid-push - which, on the sign-out path, lets signOut() revoke the
// token underneath them. One bad domain must not void the others.
export async function syncAll(uid = currentUid) {
  if (!uid) return;
  const results = await Promise.allSettled([
    syncJournal(uid),
    syncPokes(uid),
    syncSettings(uid),
    syncWater(uid),
    syncSteps(uid),
    syncStepsConfig(uid),
    syncNutritionLogs(uid),
    syncNutritionConfig(uid),
    syncNutritionLibrary(uid),
    syncSymptoms(uid),
    syncSymptomsLibrary(uid),
    syncSymptomsCategories(uid),
    syncSymptomClearDays(uid),
  ]);
  for (const r of results) {
    if (r.status === 'rejected') console.warn('[glim sync] a domain failed in syncAll:', r.reason);
  }
}

// =============================================================================
//  flushSync - opportunistic push of unsynced WRITE-ONCE data only
//
//  Called on tab-hide to shrink the window in which a just-written entry could
//  be lost (storage eviction, tab suspension) before the next 60s sync. It is
//  fire-and-forget on a path where the page may be frozen mid-flight, so it
//  performs no reads.
//
//  Scope is deliberately limited to the four WRITE-ONCE entry logs (journal,
//  water, steps, nutrition logs). A blind push of one of their rows is
//  idempotent: the row was created once and is never edited, so a re-push is
//  byte-identical and cannot overwrite a newer version of itself.
//
//  It does NOT push the mutable domains (nutrition-library, symptoms,
//  symptoms-library, symptom-categories, symptom-days). They are id-keyed too,
//  but id-keyed is not the property that makes a blind push safe - write-once
//  is. A stale mutable row pushed here would overwrite a newer remote copy,
//  updatedAt included, and the devices would diverge permanently. Those domains
//  reconcile on syncAll, which has the read that makes their push safe, and
//  sign-out awaits a full syncAll for the same reason.
//
//  It does NOT push pokes, settings, or any *-config doc either: those are
//  take-the-max or last-write-wins singletons whose safe "push" requires first
//  READING the remote copy and comparing.
//
//  The mutable domains were briefly in this scope (Phase 1 to Phase 1.5) on the
//  id-keyed argument. tests/flushsync_scope.test.mjs now asserts they are absent.
// =============================================================================

export async function flushSync(uid = currentUid) {
  if (!uid) return;
  const meta = getSyncMeta();
  const at   = (v) => (v ? new Date(v) : new Date(0));

  try {
    const journal = localGet('glim-journal');
    await pushEntries(uid, 'journal',
      Array.isArray(journal) ? journal : [], at(meta.journalPushedAt), journalNeedsPush);

    const water = localGet('glim-water');
    await pushEntries(uid, 'water',
      Array.isArray(water?.entries) ? water.entries : [], at(meta.waterPushedAt), waterEntryNeedsPush);

    const steps = localGet('glim-steps');
    await pushEntries(uid, 'steps',
      Array.isArray(steps?.entries) ? steps.entries : [], at(meta.stepsPushedAt), stepsEntryNeedsPush);

    const nutrition = localGet('glim-nutrition');
    await pushEntries(uid, 'nutrition',
      Array.isArray(nutrition?.logs) ? nutrition.logs : [], at(meta.nutritionPushedAt), nutritionLogNeedsPush);
  } catch (e) {
    console.warn('[glim flush] flushSync failed:', e);
  }
}

// =============================================================================
//  Public API
// =============================================================================

export function startSync(uid) {
  // Idempotent: clear any prior interval/listener first, so a re-entrant call
  // (e.g. a direct account switch with no intervening sign-out) cannot leave a
  // second 60s timer and a second visibility handler running.
  stopSync();
  currentUid = uid;
  pruneStaleSyncMeta();

  // Sync immediately on app load to pull cross-device data
  syncAll();

  // Periodic sync every 60 seconds
  syncInterval = setInterval(syncAll, 60_000);

  // On tab focus: full sync (pull cross-device updates). On tab hide: best-effort
  // flush of unsynced entry-log data before the tab may be suspended or evicted.
  visibilityHandler = () => {
    if (document.hidden) flushSync();
    else syncAll();
  };
  document.addEventListener('visibilitychange', visibilityHandler);
}

export function stopSync() {
  currentUid = null;
  if (syncInterval) {
    clearInterval(syncInterval);
    syncInterval = null;
  }
  if (visibilityHandler) {
    document.removeEventListener('visibilitychange', visibilityHandler);
    visibilityHandler = null;
  }
}

// Test seam: expose internal sync functions (which already take an explicit uid)
// so the standalone .mjs scenario tests can drive real merge logic against an
// in-memory Firestore mock. Not used by the application at runtime.
export const __test = {
  syncWater, syncSymptoms, syncSymptomsLibrary,
  syncSymptomsCategories, syncSymptomClearDays, syncNutritionLibrary,
  syncNutritionLogs, syncJournal, pruneStaleSyncMeta, writeOncePayload, beats,
};
