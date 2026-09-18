// -----------------------------------------------------------------------------
// Title:       useStepsHealthStore.js
// Project:     Glim
// Author:      Reina Hastings (reinahastings13@gmail.com)
// Created:     2026-09-17
// Last Modified: 2026-09-17
// Purpose:     Zustand store for step totals IMPORTED from a health platform
//              (HealthKit today, Health Connect in Phase 4). Persists to
//              localStorage under key 'glim-steps-health'. One mutable row per
//              (source, logical date).
//
//              DELIBERATELY A SEPARATE DOMAIN from 'glim-steps' (handoff spec
//              Section 11, decision of 2026-09-16). A daily total from a health
//              platform is an inherently MUTABLE per-day value - yesterday's
//              total rises when the Watch syncs at breakfast - whereas manual
//              step entries are append-only events on the write-once sync path,
//              which ignores rows the server already holds. Storing imports
//              inside 'glim-steps' would therefore either fail to propagate
//              updates or force the whole steps domain onto the mutable path.
//
//              PRECEDENCE: a manual entry for a date always wins over an
//              imported row for that date. That rule lives in useStepsStore's
//              resolveDayCount, not here; this store only records what the
//              platform said. Stores never import each other (the panel
//              composes), so readers pass these rows in.
// Inputs:      None (reads localStorage on import)
// Outputs:     Zustand store hook exported as useStepsHealthStore
// -----------------------------------------------------------------------------

import { create } from 'zustand';
import { notifyLocalWrite, DOMAINS } from '../syncBus';

const STORAGE_KEY = 'glim-steps-health';

const SOURCES = ['healthkit', 'health_connect'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// --- Persistence helpers ---

function loadRows() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed?.rows)) return { rows: parsed.rows };
    }
  } catch { /* ignore */ }
  return { rows: [] };
}

function saveRows(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ rows: state.rows }));
    notifyLocalWrite(DOMAINS.STEPS_HEALTH);
  } catch { /* ignore */ }
}

// --- Store ---

const initial = loadRows();

export const useStepsHealthStore = create((set) => ({
  rows: initial.rows ?? [],

  // ============ Actions ============

  // Writes (or replaces) the imported total for one (source, date).
  //
  // The id is DETERMINISTIC - `${source}:${date}` - so a day can only ever hold
  // one row per source, no matter how many times the import runs. That is what
  // makes the id-keyed last-write-wins sync safe here: two devices importing the
  // same day converge on the later write, and both read the same platform truth.
  //
  // Callers MUST skip unchanged values (spec R9): every write triggers a sync
  // push, so re-writing an unchanged row on every foreground is pure Firestore
  // cost. This action does not dedupe for them, because "unchanged" is the
  // import service's decision (it holds the previous value it just read).
  //
  // Returns { ok: true, row } or { ok: false, error }. Bad input is refused
  // loudly rather than stored: these rows are synced and validated server-side,
  // and a malformed one would be rejected by firestore.rules on every sync run
  // forever, visible only as a console warning.
  upsertHealthRow: ({ source, date, steps }) => {
    if (!SOURCES.includes(source))                  return { ok: false, error: 'unknown source' };
    if (typeof date !== 'string' || !DATE_RE.test(date)) return { ok: false, error: 'invalid date' };
    if (!Number.isFinite(steps) || steps < 0)       return { ok: false, error: 'invalid steps' };

    const row = {
      id: `${source}:${date}`,
      source,
      date,
      steps: Math.round(steps),
      updatedAt: new Date().toISOString(),
    };

    set(state => {
      const rows = state.rows.filter(r => r.id !== row.id);
      rows.push(row);
      rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
      const next = { ...state, rows };
      saveRows(next);
      return next;
    });

    return { ok: true, row };
  },

  // Called by the sync service after a pull that updates localStorage.
  reload: () => {
    const data = loadRows();
    set({ rows: data.rows ?? [] });
  },
}));

// Rows recorded for one logical date, any source. Exported for the panel and
// for resolveDayCount's callers; kept here so the row shape stays in one file.
export function rowsForDate(rows, dateString) {
  return (rows ?? []).filter(r => r?.date === dateString);
}
