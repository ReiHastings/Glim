// -----------------------------------------------------------------------------
// Title:       sync.js
// Project:     Glim
// Author:      Reina Hastings (reinahastings13@gmail.com)
// Created:     2026-03-26
// Last Modified: 2026-09-10
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
//              Sync is EVENT-TRIGGERED (since 2026-09-10; before that a 60 s
//              poll). A full run (push + pull, all 13 domains) starts on:
//                - startup (startSync), tab focus, and the browser's 'online'
//                  event: immediately;
//                - a local write (a store calling notifyLocalWrite on
//                  syncBus.js) or a remote write (another device touching the
//                  signal document users/{uid}/sync/signal, watched with one
//                  onSnapshot listener): after a short debounce;
//                - a slow fallback interval, as a safety net only.
//              A run that pushed at least one document touches the signal
//              document afterwards, which is what wakes the other devices.
//              The signal's `at` is SERVER-assigned (serverTimestamp()), so
//              the listener orders stamps from one clock and a device's own
//              clock never matters (Decision Register 2026-09-12).
//              Nothing is written on an idle run, so two open devices cannot
//              trigger each other (every push condition is strict; see
//              Decision Register 2026-09-10, strict singleton comparison).
//              Tab-hide runs flushWriteOnce (write-once push only). Sign-out
//              awaits flushSync, a full run that first waits for any run in
//              flight. A hidden tab's timers are throttled or frozen by the
//              browser, so the honest bound on "next run" for a backgrounded
//              tab is "when it is next foregrounded".
//
//              A run that is still in flight when the session ends (stopSync,
//              or startSync for another account) must not write: see the
//              run-generation counter below. Every domain function, both
//              shared helpers, and flushSync capture the generation first and
//              check it before each post-await write. Decision Register
//              2026-09-10.
//
//              After a pull that changes localStorage, fires a
//              'glim-data-updated' CustomEvent so DesktopPet can reload.
//
// Inputs:      Firebase db from firebase.js; local-write events from syncBus.js
// Outputs:     CustomEvent('glim-data-updated', { detail: { domains: [...] } });
//              users/{uid}/sync/signal { at, by } after a run that pushed
// Usage:       import { startSync, stopSync, flushSync } from './sync'
//              startSync(uid)               // call after auth
//              await flushSync('sign-out')  // full reconcile, waits for in-flight run
//              stopSync()                   // call on sign-out
//              localStorage['glim-debug-sync'] = '1'  // per-run counters in the console
// -----------------------------------------------------------------------------

import { db } from './firebase';
import {
  collection, doc, getDocs, setDoc, getDoc, onSnapshot, serverTimestamp,
} from 'firebase/firestore';
import { onLocalWrite } from './syncBus';

// --- Internal state ---

let currentUid = null;

// Teardown functions for everything startSync registers (signal listener,
// local-write subscription, debounce timer, online and visibility handlers,
// fallback interval). stopSync drains it. startSync calls stopSync first, so a
// re-entrant call (StrictMode double-mount, direct account switch, same-user
// re-fire of onAuthStateChanged) can never leave a second listener behind.
let handles = [];

// Identifies the current sync session. Bumped by startSync and stopSync, so a
// run that captured an older value belongs to a session that has ended or been
// replaced and must not write: a slow read can resolve after the account
// changed, and its localSet would put the previous user's rows into the next
// user's localStorage (from where the next sync pushes them under the new uid).
// Every domain function captures `const gen = generation` as its FIRST
// statement and checks stale(gen) before every write that follows an await.
let generation = 0;

// Count of writes skipped because the session ended mid-run. Exposed to tests,
// which assert it stays 0 across a live session.
let staleSkips = 0;

// True when the session `gen` was captured under has ended. Returning (not
// throwing) is the caller's job: a stale run is not an error.
function stale(gen, what) {
  if (gen === generation) return false;
  staleSkips++;
  console.info(`[glim sync] ${what}: session ended mid-run, discarding`);
  return true;
}

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
  const retired = RETIRED_META_KEYS.filter(k => k in meta);
  if (retired.length === 0) return;
  for (const k of retired) delete meta[k];
  localSet('glim-sync-meta', meta);
}

// Millisecond value of an ISO timestamp; 0 when absent, NaN when malformed.
function ts(v) {
  return v ? new Date(v).getTime() : 0;
}

// Milliseconds of a signal stamp: a Firestore Timestamp (server-written, the
// only form this client ever writes) or null (a pending server timestamp, or
// absent). Deliberately no string branch: the signal document was never
// deployed with a client-written string, and comparing a client stamp against
// a server stamp would carry the writer's clock skew forward.
function signalMs(v) {
  return v && typeof v.toMillis === 'function' ? v.toMillis() : null;
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

// --- Per-run read/write accounting ---
//
// Every domain function reports { domain, docsRead, docsPushed } once per run.
// docsPushed is summed into runPushed, which is the ONE source of truth for
// "did this run push anything": the scheduler touches the signal document
// only when it is greater than zero. docsRead is snapshot.size for a getDocs
// pull and 1 for a getDoc singleton. Firestore bills at least one read per
// query, so the billed figure for an EMPTY collection is 1, not the 0 logged
// here. docsPushed counts setDoc calls attempted, whether or not they
// succeeded.
//
// Logging is off by default. Set localStorage 'glim-debug-sync' to '1'
// (devtools, no rebuild or reload needed) to log one line per domain per run,
// plus one line per run start and per signal write.
let runPushed = 0;

function debugSyncEnabled() {
  try { return typeof localStorage !== 'undefined' && localStorage.getItem('glim-debug-sync') === '1'; }
  catch { return false; }
}

function recordDomain(domain, docsRead, docsPushed) {
  runPushed += docsPushed;
  if (debugSyncEnabled()) console.debug('[glim sync]', { domain, docsRead, docsPushed });
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
  const gen = generation;
  const ref = collection(db, 'users', uid, collectionName);
  const toPush = list.filter(e => needsPush(e, lastPushedAt));
  for (const entry of toPush) {
    if (stale(gen, collectionName)) return;   // each iteration awaits
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
  const gen = generation;
  const meta = getSyncMeta();
  const lastPushedAt = meta.journalPushedAt ? new Date(meta.journalPushedAt) : new Date(0);

  const rawEntries = localGet('glim-journal');
  const entries = Array.isArray(rawEntries) ? rawEntries : [];

  const journalRef = collection(db, 'users', uid, 'journal');

  // --- PUSH: entries that are new or newly soft-deleted since last push ---
  const toPush = entries.filter(e => journalNeedsPush(e, lastPushedAt));

  for (const entry of toPush) {
    if (stale(gen, 'journal')) return;
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

  if (stale(gen, 'journal')) return;
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
  recordDomain('journal', snapshot.size, toPush.length);
}

// =============================================================================
//  Pokes sync
//  Strategy: take the max of local and remote (pokes only ever increase).
//  Firestore path: users/{uid}/pokes/counters
// =============================================================================

async function syncPokes(uid) {
  const gen = generation;
  const localRaw = localStorage.getItem('glim-pokes');
  const localTotal = localRaw ? (parseInt(localRaw, 10) || 0) : 0;

  const pokesRef = doc(db, 'users', uid, 'pokes', 'counters');

  try {
    const snap = await getDoc(pokesRef);
    const remoteTotal = snap.exists() ? (snap.data().total ?? 0) : 0;
    if (stale(gen, 'pokes')) return;

    if (!snap.exists() || localTotal > remoteTotal) {
      // Local has more pokes, or no remote doc yet: push to Firestore
      await setDoc(pokesRef, {
        total: localTotal,
        lastModified: new Date().toISOString(),
      }, { merge: true });
      recordDomain('pokes', 1, 1);
    } else if (remoteTotal > localTotal) {
      // Remote has more pokes: update local
      localSetRaw('glim-pokes', String(remoteTotal));
      notify(['pokes']);
      recordDomain('pokes', 1, 0);
    } else {
      // Equal totals: the count already on the server. Nothing moves, and in
      // particular lastModified is NOT rewritten (a write here on every idle
      // run would touch the signal document and ping-pong two open devices).
      recordDomain('pokes', 1, 0);
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
  const gen = generation;
  let localSettings = null;
  try {
    const val = localStorage.getItem('glim-settings');
    localSettings = val ? JSON.parse(val) : null;
  } catch { /* ignore */ }

  const settingsRef = doc(db, 'users', uid, 'settings', 'current');

  try {
    const snap = await getDoc(settingsRef);
    const remoteSettings = snap.exists() ? snap.data() : null;
    if (stale(gen, 'settings')) return;

    const localTime = localSettings?.lastModified ? new Date(localSettings.lastModified) : new Date(0);
    const remoteTime = remoteSettings?.lastModified ? new Date(remoteSettings.lastModified) : new Date(0);

    if (!snap.exists() || localTime > remoteTime) {
      // Local is strictly newer, or no remote doc yet: push to Firestore
      if (localSettings) {
        await setDoc(settingsRef, localSettings, { merge: true });
      }
      recordDomain('settings', 1, localSettings ? 1 : 0);
    } else if (remoteTime > localTime) {
      // Remote is newer: update local
      localSet('glim-settings', remoteSettings);
      notify(['settings']);
      recordDomain('settings', 1, 0);
    } else {
      // Equal lastModified: the same write, already pushed (every save stamps
      // a fresh lastModified). Nothing moves.
      recordDomain('settings', 1, 0);
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
  const gen          = generation;
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
    if (stale(gen, 'water')) return;
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
  let configPushed   = 0;

  try {
    const configSnap   = await getDoc(configRef);
    const remoteConfig = configSnap.exists() ? configSnap.data() : null;
    if (stale(gen, 'water')) return;
    const localTime    = localConfig.configUpdatedAt ? new Date(localConfig.configUpdatedAt) : new Date(0);
    const remoteTime   = remoteConfig?.configUpdatedAt ? new Date(remoteConfig.configUpdatedAt) : new Date(0);

    if (!configSnap.exists() || localTime > remoteTime) {
      // Local strictly newer, or no remote doc yet: push
      await setDoc(configRef, localConfig, { merge: true });
      configPushed = 1;
    } else if (remoteTime > localTime) {
      // Remote newer: pull
      local   = { ...local, bottleOz: remoteConfig.bottleOz, goal: remoteConfig.goal, configUpdatedAt: remoteConfig.configUpdatedAt };
      changed = true;
    }
    // Equal configUpdatedAt: the same write, already pushed. Nothing moves.
  } catch (e) {
    console.warn('[glim sync] water config sync failed:', e);
  }

  // Reached after the config getDoc even when that read failed and was caught.
  if (stale(gen, 'water')) return;
  if (changed) {
    localSet('glim-water', local);
    notify(['water']);
  }

  // Always advance pushedAt, even when there was nothing to push locally.
  // A device that only pulled remote entries would otherwise keep lastPushedAt
  // at epoch and re-push all pulled entries on the next cycle.
  setSyncMeta({ waterPushedAt: new Date().toISOString() });
  // Reads: the entries getDocs plus the one water-config getDoc.
  recordDomain('water', snapshot.size + 1, toPush.length + configPushed);
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
  const gen          = generation;
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
    if (stale(gen, 'steps')) return;
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

  if (stale(gen, 'steps')) return;
  const localIdSet = new Set(entries.map(e => String(e.id)));
  const toAdd = [];
  snapshot.forEach(d => {
    if (!localIdSet.has(d.id)) toAdd.push(d.data());
  });

  if (toAdd.length > 0) {
    const merged = [...entries, ...toAdd].sort((a, b) => a.timestamp - b.timestamp);
    local = { ...local, entries: merged };
    localSet('glim-steps', local);
    notify(['steps']);
  }

  // Always advance pushedAt, even when there was nothing to push locally.
  // A device that only pulled remote entries would otherwise keep lastPushedAt
  // at epoch and re-push all pulled entries on the next cycle.
  setSyncMeta({ stepsPushedAt: new Date().toISOString() });
  recordDomain('steps', snapshot.size, toPush.length);
}

// =============================================================================
//  Steps config sync
//  Strategy: last-write-wins by configUpdatedAt (same as water/nutrition config).
//  Firestore path: users/{uid}/steps-config/current
//  Config lives inside the same 'glim-steps' localStorage blob as the entries
//  but syncs through its own Firestore doc, matching the water pattern.
// =============================================================================

async function syncStepsConfig(uid) {
  const gen = generation;
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
    if (stale(gen, 'steps-config')) return;
    const localTime    = new Date(localConfig.configUpdatedAt);
    const remoteTime   = remoteConfig?.configUpdatedAt ? new Date(remoteConfig.configUpdatedAt) : new Date(0);

    if (!snap.exists() || localTime > remoteTime) {
      // Local strictly newer, or no remote doc yet: push
      await setDoc(configRef, localConfig, { merge: true });
      recordDomain('steps-config', 1, 1);
    } else if (remoteTime > localTime) {
      // Remote is newer: pull
      local = { ...local, goal: remoteConfig.goal, configUpdatedAt: remoteConfig.configUpdatedAt };
      localSet('glim-steps', local);
      notify(['steps']);
      recordDomain('steps-config', 1, 0);
    } else {
      // Equal configUpdatedAt: the same write, already pushed. Nothing moves.
      recordDomain('steps-config', 1, 0);
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
  const gen          = generation;
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
    if (stale(gen, 'nutrition')) return;
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

  if (stale(gen, 'nutrition')) return;
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
  recordDomain('nutrition', snapshot.size, toPush.length);
}

// =============================================================================
//  Nutrition config sync
//  Strategy: last-write-wins by configUpdatedAt (same as water config).
//  Firestore path: users/{uid}/nutrition-config/current
// =============================================================================

async function syncNutritionConfig(uid) {
  const gen = generation;
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
    if (stale(gen, 'nutrition-config')) return;
    const localTime    = new Date(localConfigUpdatedAt);
    const remoteTime   = remoteConfig?.configUpdatedAt ? new Date(remoteConfig.configUpdatedAt) : new Date(0);

    if (!snap.exists() || localTime > remoteTime) {
      // Local strictly newer, or no remote doc yet: push
      await setDoc(configRef, { goals: localGoals, configUpdatedAt: localConfigUpdatedAt }, { merge: true });
      recordDomain('nutrition-config', 1, 1);
    } else if (remoteTime > localTime) {
      // Remote is newer: pull
      local = { ...local, goals: remoteConfig.goals, configUpdatedAt: remoteConfig.configUpdatedAt };
      localSet('glim-nutrition', local);
      notify(['nutrition']);
      recordDomain('nutrition-config', 1, 0);
    } else {
      // Equal configUpdatedAt: the same write, already pushed. Nothing moves.
      recordDomain('nutrition-config', 1, 0);
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
  const gen = generation;
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

  if (stale(gen, collectionName)) return;
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
  let pushed = 0;
  for (const entry of finalDocs) {
    const remote = remoteById.get(String(entry.id));
    if (remote && !beats(entry.updatedAt, remote.updatedAt)) continue;
    if (stale(gen, collectionName)) return;   // each iteration awaits
    pushed += 1;
    try {
      await setDoc(doc(docsRef, String(entry.id)), entry, { merge: true });
    } catch (e) {
      console.warn(`[glim sync] ${collectionName} push failed:`, entry.id, e);
    }
  }
  recordDomain(domain, snapshot.size, pushed);
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

// Private fan-out over the 13 domain functions: one full push + pull. Not
// exported; the scheduler below (runSync / flushSync) is the only production
// caller, so a run can never overlap the watermark advance of another one
// started from outside. Tests reach it through the __test seam. `uid`
// defaults to the active session for that seam.
//
// allSettled, not all: every domain function catches its own I/O errors, but a
// synchronous throw (corrupt local data) rejects that domain's promise, and
// Promise.all would then resolve syncAll early while the other domains were
// still mid-push - which, on the sign-out path, lets signOut() revoke the
// token underneath them. One bad domain must not void the others.
async function syncAll(uid = currentUid) {
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
//  flushWriteOnce - opportunistic push of unsynced WRITE-ONCE data only
//  (named flushSync until 2026-09-10; that name now belongs to the awaited
//  full run below)
//
//  Called on tab-hide to shrink the window in which a just-written entry could
//  be lost (storage eviction, tab suspension) before the next full run. It is
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
//  reconcile on the full run, which has the read that makes their push safe,
//  and sign-out awaits a full run (flushSync) for the same reason.
//
//  It does NOT push pokes, settings, or any *-config doc either: those are
//  take-the-max or last-write-wins singletons whose safe "push" requires first
//  READING the remote copy and comparing.
//
//  The mutable domains were briefly in this scope (Phase 1 to Phase 1.5) on the
//  id-keyed argument. tests/flushsync_scope.test.mjs now asserts they are absent.
// =============================================================================

export async function flushWriteOnce(uid = currentUid) {
  const gen = generation;
  if (!uid) return;
  const meta = getSyncMeta();
  const at   = (v) => (v ? new Date(v) : new Date(0));

  try {
    const journal = localGet('glim-journal');
    await pushEntries(uid, 'journal',
      Array.isArray(journal) ? journal : [], at(meta.journalPushedAt), journalNeedsPush);

    if (stale(gen, 'flush')) return;   // the previous pushEntries awaited
    const water = localGet('glim-water');
    await pushEntries(uid, 'water',
      Array.isArray(water?.entries) ? water.entries : [], at(meta.waterPushedAt), waterEntryNeedsPush);

    if (stale(gen, 'flush')) return;   // the previous pushEntries awaited
    const steps = localGet('glim-steps');
    await pushEntries(uid, 'steps',
      Array.isArray(steps?.entries) ? steps.entries : [], at(meta.stepsPushedAt), stepsEntryNeedsPush);

    if (stale(gen, 'flush')) return;   // the previous pushEntries awaited
    const nutrition = localGet('glim-nutrition');
    await pushEntries(uid, 'nutrition',
      Array.isArray(nutrition?.logs) ? nutrition.logs : [], at(meta.nutritionPushedAt), nutritionLogNeedsPush);
  } catch (e) {
    console.warn('[glim flush] flushWriteOnce failed:', e);
  }
}

// =============================================================================
//  Scheduler: event-triggered runs
//
//  Replaces the 60 s poll (2026-09-10). A run is a full push + pull over every
//  domain (syncAll). Runs are serialised: runSync coalesces a request that
//  arrives while a run is in flight into ONE follow-up run after it, so two
//  runs can never interleave on the pushedAt watermarks.
//
//  Triggers and their reasons (logged under the debug flag):
//    startup   startSync, immediately
//    focus     visibilitychange to visible, immediately
//    online    window 'online', immediately
//    local:*   a store persisted to localStorage (syncBus), debounced
//    signal    another device touched users/{uid}/sync/signal, debounced
//    fallback  slow interval, safety net only
//    sign-out  flushSync('sign-out') from SettingsView
//
//  The signal document is the only cross-device wake-up. A run that pushed at
//  least one document (runPushed > 0) writes { at, by: deviceId } to it; the
//  other device's listener sees the change, ignores writes carrying its own
//  device id, and schedules a run. Because every push condition is strict, an
//  idle run pushes nothing and does not touch the signal, so two open devices
//  settle after one exchange instead of waking each other forever.
//
//  Cost per idle hour with the tab open: zero reads and zero writes beyond the
//  fallback runs (one listener on a single document is free while idle).
// =============================================================================

const DEBOUNCE_MS          = 2_000;
const FALLBACK_INTERVAL_MS = 15 * 60_000;
// Mutable so tests can shrink them (see __test.setTimings).
const timings = { debounceMs: DEBOUNCE_MS, fallbackMs: FALLBACK_INTERVAL_MS };

let runPromise     = null;   // the run in flight, or null
let syncInFlight   = false;  // mirrors runPromise !== null; read by flushSync
let rerunRequested = false;  // a trigger arrived mid-run: run once more after
let rerunReason    = null;
let debounceTimer  = null;
let lastRunPushed  = 0;      // runPushed of the most recent completed run (tests)
let signalWrites   = 0;      // touchSignal calls this session (tests)

// A stable id for this browser profile, so a device can recognise its own
// signal writes. Two tabs of the same browser share it, which is correct: they
// also share localStorage, so neither has anything to pull from the other.
function deviceId() {
  try {
    let id = localStorage.getItem('glim-device-id');
    if (!id) {
      id = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      localStorage.setItem('glim-device-id', id);
    }
    return id;
  } catch {
    return 'unknown';
  }
}

function signalRef(uid) {
  return doc(db, 'users', uid, 'sync', 'signal');
}

// Written after a run that pushed something. Full overwrite (no merge): the
// document has exactly two fields and nothing else should ever accumulate in
// it. `at` is stamped by the SERVER: two devices' clocks are never compared,
// so a skewed clock cannot make one device ignore the other (plan review
// 2026-09-11). Guarded like every other post-await write.
async function touchSignal(uid, gen) {
  if (stale(gen, 'signal')) return;
  try {
    await setDoc(signalRef(uid), { at: serverTimestamp(), by: deviceId() });
    signalWrites++;
    if (debugSyncEnabled()) console.debug('[glim sync] touchSignal', { uid });
  } catch (e) {
    console.warn('[glim sync] signal write failed:', e);
  }
}

// One full run, then the signal write if anything was pushed. A run whose
// session ended mid-way does not attempt the signal at all (its domain writes
// were already discarded one by one); touchSignal's own guard is the backstop
// for a session ending during the fan-out's final await.
async function runOnce(uid, reason) {
  const gen = generation;
  runPushed = 0;
  if (debugSyncEnabled()) console.debug(`[glim sync] run (${reason})`);
  await syncAll(uid);
  lastRunPushed = runPushed;
  if (runPushed > 0 && gen === generation) await touchSignal(uid, gen);
}

// Start a run now, or fold the request into the run already in flight (which
// then runs once more when it finishes). Returns a promise that resolves when
// the run this request is part of, follow-up included, has completed.
function runSync(reason) {
  const uid = currentUid;
  if (!uid) return Promise.resolve();
  if (runPromise) {
    rerunRequested = true;
    rerunReason = reason;
    return runPromise;
  }
  const gen = generation;
  const p = (async () => {
    try {
      let r = reason;
      do {
        rerunRequested = false;
        await runOnce(uid, r);
        r = rerunReason;
      } while (rerunRequested && gen === generation);
    } finally {
      // stopSync may already have detached this run and a new session may own
      // runPromise now; only clear what is still ours.
      if (runPromise === p) { runPromise = null; syncInFlight = false; }
    }
  })();
  runPromise = p;
  syncInFlight = true;
  return p;
}

// Debounced trigger for bursty sources (a user logging three bottles in a row,
// or the other device pushing them). Each new event restarts the timer.
function schedule(reason) {
  if (!currentUid) return;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    runSync(reason);
  }, timings.debounceMs);
}

// One onSnapshot on the signal document. Pending snapshots (this device's own
// optimistic echo, in which the server timestamp reads as null) are dropped
// first, so they can never become the baseline. The first acknowledged
// snapshot is the baseline (the startup run, which begins right after this
// listener attaches, covers anything already on the server); later snapshots
// schedule a run unless they are this device's own acknowledged write or a
// re-delivery of a stamp already seen (listener reconnect). All stamps are
// server-assigned, so `<=` is a valid ordering regardless of device clocks.
//
// Known gap: if the very first snapshot after attach is pending (StrictMode
// double mount immediately after a run that touched the signal), the baseline
// is taken from the NEXT acknowledged snapshot and that one is swallowed even
// if foreign; the fallback covers it. Same-millisecond commits compare equal
// under toMillis() and the second is dropped; unreachable for one document.
function watchSignal(uid) {
  let seenMs;   // undefined until the baseline (first acknowledged) snapshot
  return onSnapshot(
    signalRef(uid),
    (snap) => {
      if (snap.metadata?.hasPendingWrites) return;
      const data = snap.exists() ? snap.data() : null;
      const atMs = signalMs(data?.at);
      const by   = data?.by ?? null;
      if (seenMs === undefined) { seenMs = atMs; return; }
      if (atMs !== null && seenMs !== null && atMs <= seenMs) return;
      seenMs = atMs;
      if (by === deviceId()) return;
      schedule('signal');
    },
    (e) => console.warn('[glim sync] signal listener error:', e),
  );
}

// Awaited full run for callers outside the scheduler (sign-out). Waits for any
// run in flight so its own run cannot overlap it, then runs. Performs no write
// of its own.
export async function flushSync(reason = 'flush') {
  while (syncInFlight) await new Promise((r) => setTimeout(r, 50));
  await runSync(reason);
}

// =============================================================================
//  Public API
// =============================================================================

export function startSync(uid) {
  // Idempotent: tear down everything a prior session registered first, so a
  // re-entrant call (StrictMode double-mount in dev, a direct account switch
  // with no intervening sign-out, a same-user re-fire of onAuthStateChanged)
  // can never leave a second listener, subscription, or timer running.
  stopSync();
  currentUid = uid;
  generation++;          // stopSync above bumped too; a second bump is harmless
  pruneStaleSyncMeta();

  // 1. Remote writes: the signal listener. Attached BEFORE the startup run so
  //    a signal written after its baseline snapshot is never missed.
  handles.push(watchSignal(uid));

  // 2. Local writes: stores announce each localStorage persist on syncBus.
  handles.push(onLocalWrite((domain) => schedule(`local:${domain}`)));

  // 3. The debounce timer, so a pending trigger dies with the session.
  handles.push(() => {
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
  });

  // 4. Connectivity regained.
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    const onOnline = () => runSync('online');
    window.addEventListener('online', onOnline);
    handles.push(() => window.removeEventListener('online', onOnline));
  }

  // 5. Tab focus: full run. Tab hide: best-effort flush of unsynced
  //    write-once rows before the tab may be suspended or evicted.
  const onVisibility = () => {
    if (document.hidden) flushWriteOnce();
    else runSync('focus');
  };
  document.addEventListener('visibilitychange', onVisibility);
  handles.push(() => document.removeEventListener('visibilitychange', onVisibility));

  // 6. Fallback interval: safety net for a missed signal (listener dropped,
  //    write failed). Throttled or frozen by the browser while hidden.
  const fallback = setInterval(() => runSync('fallback'), timings.fallbackMs);
  handles.push(() => clearInterval(fallback));

  // Startup run: pull cross-device data, push anything unsynced.
  runSync('startup');
}

export function stopSync() {
  currentUid = null;
  generation++;          // any run still in flight now fails its stale() checks
  for (const teardown of handles.splice(0)) {
    try { teardown(); } catch (e) { console.warn('[glim sync] teardown failed:', e); }
  }
  // Detach the in-flight run, if any. It keeps running but every write it
  // attempts from here on is discarded by the generation guard.
  runPromise = null;
  syncInFlight = false;
  rerunRequested = false;
}

// Test seam: expose internal sync functions (which already take an explicit uid)
// so the standalone .mjs scenario tests can drive real merge logic against an
// in-memory Firestore mock. Not used by the application at runtime.
export const __test = {
  syncWater, syncSymptoms, syncSymptomsLibrary,
  syncSymptomsCategories, syncSymptomClearDays, syncNutritionLibrary,
  syncNutritionLogs, syncJournal, pruneStaleSyncMeta, writeOncePayload, beats,
  syncAll,
  generation:    () => generation,
  staleSkips:    () => staleSkips,
  lastRunPushed: () => lastRunPushed,
  signalWrites:  () => signalWrites,
  inFlight:      () => syncInFlight,
  handleCount:   () => handles.length,
  deviceId,
  // Shrink the scheduler's timers so a test can wait milliseconds, not minutes.
  setTimings: ({ debounceMs, fallbackMs } = {}) => {
    if (debounceMs !== undefined) timings.debounceMs = debounceMs;
    if (fallbackMs !== undefined) timings.fallbackMs = fallbackMs;
  },
};
