// -----------------------------------------------------------------------------
// Title:       useSymptomClearDaysStore.js
// Project:     Glim
// Author:      Reina Hastings (reinahastings13@gmail.com)
// Created:     2026-09-06
// Last Modified: 2026-09-06
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
// Inputs:      None (reads localStorage on import)
// Outputs:     Zustand store hook exported as useSymptomClearDaysStore
// -----------------------------------------------------------------------------

import { create } from 'zustand';
import { toLogicalDateStr } from '../utils/dateUtils';

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
  } catch { /* ignore */ }
}

// Does an open episode cover this logical day? An open episode runs from its
// onset date up to now, so it contradicts a clear day on any date at or after
// its onset. Closed episodes are ignored here: they are already represented by
// log entries, and the caller's rule-2 unmark handles the day they fall on.
function coveredByOpenEpisode(dateString, openEpisodes) {
  return openEpisodes.some(e => e.date <= dateString);
}

// --- Store ---

const initial = loadDays();

export const useSymptomClearDaysStore = create((set, get) => ({
  days: initial.days ?? [],

  // ============ Actions ============

  // Records "nothing today" for a logical date. Retroactive marking of a past day
  // is allowed, so gaps in the record can be filled in later.
  //
  // REFUSES while an episode is open, because "nothing today" and "this symptom
  // is still going" are contradictory claims about the same day; the caller
  // should offer to close the episode instead. openEpisodes is passed IN by the
  // panel from useSymptomsStore.getOpenEpisodes() - this store never reads that
  // one (stores never import each other; the panel orchestrates), the same
  // composition the library store's getActiveItems(recencyById) uses.
  //
  // Returns { ok: true, day } or { ok: false, error }.
  markClear: (dateString, openEpisodes = []) => {
    if (typeof dateString !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateString)) {
      return { ok: false, error: 'invalid date' };
    }
    if (coveredByOpenEpisode(dateString, openEpisodes)) {
      return { ok: false, error: 'an episode is still going' };
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

  // Soft delete, per the domain-wide rule: hard deletion would let a sync pull
  // re-introduce the record. Called directly by the panel whenever a symptom is
  // logged - a clear day and a logged symptom are mutually exclusive claims, and
  // the log wins.
  unmarkClear: (dateString) => {
    const now = new Date().toISOString();
    set(state => {
      const next = {
        ...state,
        days: state.days.map(d =>
          d.id === dateString && !d.deletedAt ? { ...d, deletedAt: now, updatedAt: now } : d
        ),
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

  // Convenience for the reminder check, which works from a Date.
  isClearOn: (date) => get().isClear(toLogicalDateStr(date)),
}));
