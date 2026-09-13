// -----------------------------------------------------------------------------
// Title:       useSymptomClearDaysStore.js
// Project:     Glim
// Author:      Reina Hastings (reinahastings13@gmail.com)
// Created:     2026-09-06
// Last Modified: 2026-09-09
// Purpose:     Zustand store for "nothing today" records. Persists to
//              localStorage under key 'glim-symptom-days'. A clear day makes
//              ABSENCE OF SYMPTOMS distinguishable from ABSENCE OF DATA, which is
//              the only thing that makes a "proportion of days affected" figure
//              mean anything.
//
//              Deliberately a SEPARATE DOMAIN, not a sentinel log entry: a
//              sentinel would flow into getTodayEntries, getEntriesByDay,
//              getAffectedDays and every selector written after them, forcing a
//              special case into each one forever.
//
//              THE DOCUMENT ID IS THE LOGICAL DATE STRING. That makes the record
//              naturally idempotent per day (one row can only ever exist once)
//              and safe under the id-keyed last-write-wins sync.
//
//              PRECEDENCE RULE (D3/D4, 2026-09-08): a clear-day row is only
//              meaningful for a day with NO symptom entries. Writers enforce
//              this (markClear refuses an affected day; every entry write
//              unmarks the entry's start day and any KNOWN clear rows in its
//              span), but two devices can still disagree
//              offline and last-write-wins resolves by timestamp, not by rule.
//              So READERS must apply the precedence too: a day with any entry
//              is never displayed or counted as clear, whatever this store
//              says. SymptomsPanel derives isClearToday that way, and any
//              future consumer of getClearDays must subtract getAffectedDays
//              over the same range.
//
//              A consequence worth knowing: mark a day clear, log a symptom
//              (the row is tombstoned), then undo the log. The day is now "no
//              record", not "clear". The earlier claim is not restored, and the
//              reminder may ask again. Deliberate: absence of data is the
//              honest state once the user has changed their mind twice.
// Inputs:      None (reads localStorage on import)
// Outputs:     Zustand store hook exported as useSymptomClearDaysStore
// -----------------------------------------------------------------------------

import { create } from 'zustand';
import { notifyLocalWrite, DOMAINS } from '../syncBus';

const STORAGE_KEY = 'glim-symptom-days';

// --- Persistence helpers ---

function loadDays() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed?.days)) return { days: parsed.days };
    }
  } catch { /* ignore */ }
  return { days: [] };
}

function saveDays(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ days: state.days }));
    notifyLocalWrite(DOMAINS.SYMPTOM_DAYS);
  } catch { /* ignore */ }
}

// How many symptoms the caller says are present on the day. Accepts the Set
// that getAffectedDays(date, date).get(date) yields, or an array, or nothing.
function affectedCount(affected) {
  if (!affected) return 0;
  if (affected instanceof Set) return affected.size;
  if (Array.isArray(affected)) return affected.length;
  return 0;
}

// --- Store ---

const initial = loadDays();

export const useSymptomClearDaysStore = create((set, get) => ({
  days: initial.days ?? [],

  // ============ Actions ============

  // Records "nothing today" for a logical date. Retroactive marking of a past day
  // is allowed, so gaps in the record can be filled in later.
  //
  // REFUSES when any symptom is present on the day: "nothing today" and "a
  // symptom was logged today" are contradictory claims. The caller passes IN
  // the day's affected set from useSymptomsStore.getAffectedDays(date, date) -
  // this store never reads that one (stores never import each other; the panel
  // orchestrates), the same composition the library store's
  // getActiveItems(recencyById) uses. Using the affected-days primitive rather
  // than "is an episode open" means a CLOSED episode that spanned the day, or a
  // moment logged on it, refuses too; the earlier open-episode check let a
  // retroactive clear day land inside a closed multi-day flare.
  //
  // Returns { ok: true, day } or { ok: false, error }.
  markClear: (dateString, affectedSymptomIds) => {
    if (typeof dateString !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateString)) {
      return { ok: false, error: 'invalid date' };
    }
    // REQUIRED, and must be the Set (or an array) the caller got from the
    // symptoms store. A permissive default would let a caller that forgot the
    // argument - or passed the whole Map by mistake - mark an affected day
    // clear without a sound.
    if (!(affectedSymptomIds instanceof Set) && !Array.isArray(affectedSymptomIds)) {
      return { ok: false, error: 'affected set required' };
    }
    if (affectedCount(affectedSymptomIds) > 0) {
      return { ok: false, error: 'symptoms are logged for this day' };
    }

    const now = new Date().toISOString();
    const existing = get().days.find(d => d.id === dateString);
    const day = existing
      // Re-marking a previously cleared-then-unmarked day revives the SAME row
      // rather than adding a second one: the id is the date, so there is exactly
      // one row per day by construction.
      ? { ...existing, status: 'none', deletedAt: null, updatedAt: now }
      : { id: dateString, status: 'none', recordedAt: now, updatedAt: now, deletedAt: null };

    set(state => {
      const next = {
        ...state,
        days: existing
          ? state.days.map(d => (d.id === dateString ? day : d))
          : [...state.days, day],
      };
      saveDays(next);
      return next;
    });
    return { ok: true, day };
  },

  // Records that the day is NOT clear. Called by the panel on every entry write
  // (log, log-again, and an edit that lands the entry on a day), keyed on the
  // entry's date - a clear day and a logged symptom are mutually exclusive
  // claims, and the log wins.
  //
  // ALWAYS WRITES, even when no row exists locally (D4). Without a row here,
  // this device cannot know whether another device has marked the day clear
  // and simply not synced yet; a no-op would let that mark arrive later and sit
  // beside the entry. So a missing row gets a TOMBSTONE (a soft-deleted row
  // stamped now), and an existing row - deleted or not - has its updatedAt
  // bumped, so this device's "not clear" claim carries the newest timestamp and
  // wins the merge against any mark made before it. Cost: one small row per
  // logged day, and one push per sync while logging continues. Soft delete
  // throughout, per the domain-wide rule.
  unmarkClear: (dateString) => {
    const now = new Date().toISOString();
    set(state => {
      const existing = state.days.find(d => d.id === dateString);
      const next = {
        ...state,
        days: existing
          ? state.days.map(d => (d.id === dateString
              ? { ...d, deletedAt: d.deletedAt ?? now, updatedAt: now }
              : d))
          : [...state.days, { id: dateString, status: 'none', recordedAt: now, updatedAt: now, deletedAt: now }],
      };
      saveDays(next);
      return next;
    });
  },

  // Re-reads localStorage into Zustand state. Called by sync.js after a remote
  // pull and by reloadAllStores on an account switch.
  reload: () => {
    const data = loadDays();
    set({ days: data.days ?? [] });
  },

  // ============ Selectors ============

  isClear: (dateString) =>
    get().days.some(d => d.id === dateString && !d.deletedAt),

  // Clear days in an inclusive logical-date range, oldest first. null is
  // unbounded on either end. Returns date strings, which is all any consumer
  // needs (the row carries no data beyond "this day was clear").
  getClearDays: (rangeStart = null, rangeEnd = null) =>
    get().days
      .filter(d => !d.deletedAt)
      .filter(d => (rangeStart === null || d.id >= rangeStart) &&
                   (rangeEnd   === null || d.id <= rangeEnd))
      .map(d => d.id)
      .sort(),

}));
