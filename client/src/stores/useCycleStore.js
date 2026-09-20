// -----------------------------------------------------------------------------
// Title:       useCycleStore.js
// Project:     Glim
// Author:      Reina Hastings (reihastings@gmail.com)
// Created:     2026-09-18
// Purpose:     Zustand store for the menstrual flow log. Persists to
//              localStorage under key 'glim-cycle'.
//
//              THE DOCUMENT ID IS THE LOGICAL DATE STRING, following
//              useSymptomClearDaysStore. Flow is a per-day STATE, not a moment,
//              so one row per day is the natural shape and the id makes that
//              structurally impossible to violate. It also makes every write
//              idempotent under the id-keyed last-write-wins merge.
//
//              THIS STORE ONLY STORES. Cycles, period boundaries and
//              predictions are DERIVED by client/src/cycle/, never persisted: a
//              backfilled period changes the answer, so persisting it would
//              turn every backfill into a migration and every cross-device
//              merge into a conflict with no correct resolution. This file
//              therefore imports nothing from ../cycle and nothing from another
//              store.
//
//              VALIDATION MIRRORS THE SERVER. firestore.rules' cycleValid()
//              is a backstop, not the specification: a row the client accepts
//              and the server refuses pushes forever and fails forever,
//              surfacing only as a console.warn in sync.js. Every constraint
//              there has a rejection here.
//
// Inputs:      None (reads localStorage on import)
// Outputs:     useCycleStore, FLOW_VALUES, validateRow
// Usage:       import { useCycleStore } from './useCycleStore';
//              const setFlow = useCycleStore(s => s.setFlow);
//              const res = setFlow('2026-09-18', 'medium');
//              if (!res.ok) showError(res.error);
//
//              Subscribe through the hook, never through a static read: a
//              static read returns the right value once but does not subscribe
//              the component, so a row arriving from a sync pull would land
//              silently and the panel would keep showing the old state. A
//              static test in syncbus_wiring enforces this across all stores.
// -----------------------------------------------------------------------------

import { create } from 'zustand';
import { notifyLocalWrite, DOMAINS } from '../syncBus';
import { calendarTodayStr } from '../utils/dateUtils';

const STORAGE_KEY = 'glim-cycle';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const NOTE_MAX = 500;

// Ordered least to most. The order is meaningful to the UI, not to the store.
export const FLOW_VALUES = Object.freeze(['none', 'spotting', 'light', 'medium', 'heavy']);

// --- Persistence ---

function loadCycle() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed?.days)) return { days: parsed.days };
    }
  } catch { /* ignore */ }
  return { days: [] };
}

function saveCycle(days) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ days }));
    notifyLocalWrite(DOMAINS.CYCLE);
  } catch { /* ignore */ }
}

// --- Validation (R3, R3a) ---
//
// Returns { ok: true } or { ok: false, error }. The { ok, error } shape follows
// markClear in useSymptomClearDaysStore; note it is NOT the shape of
// validateEntry in useSymptomsStore, which returns a bare string.

export function validateRow(row, today = calendarTodayStr()) {
  if (!row || typeof row !== 'object') return { ok: false, error: 'missing row' };
  if (typeof row.date !== 'string' || !DATE_RE.test(row.date)) {
    return { ok: false, error: 'date must look like 2026-09-18' };
  }
  // Mirrors cycleValid()'s `d.id == d.date`. Without this the row pushes
  // forever and fails forever, visible only as a console.warn.
  if (row.id !== row.date) return { ok: false, error: 'id must equal date' };
  // The CALENDAR date, not todayStr(): between midnight and DAY_BOUNDARY_HOUR
  // the user may deliberately choose the new calendar day, and that write must
  // be accepted. See dateUtils.calendarTodayStr.
  if (row.date > today) return { ok: false, error: 'that date is in the future' };
  if (!FLOW_VALUES.includes(row.flow)) {
    return { ok: false, error: `flow must be one of ${FLOW_VALUES.join(', ')}` };
  }
  if (!(row.isPeriodStart === true || row.isPeriodStart === false || row.isPeriodStart === null)) {
    return { ok: false, error: 'isPeriodStart must be true, false or null' };
  }
  if (row.note !== null && row.note !== undefined) {
    if (typeof row.note !== 'string') return { ok: false, error: 'note must be text' };
    if (row.note.length > NOTE_MAX) return { ok: false, error: `note must be under ${NOTE_MAX} characters` };
  }
  return { ok: true };
}

const nowIso = () => new Date().toISOString();

// --- Store ---

const initial = loadCycle();

export const useCycleStore = create((set, get) => ({
  days: initial.days ?? [],

  // ============ Internal ============

  // Applies `patch` to the row for `date`, creating it when `allowCreate`.
  // One write path so validation, timestamps and persistence cannot diverge.
  _write: (date, patch, { allowCreate, missingError }) => {
    const existing = get().days.find(d => d.id === date);
    if (!existing && !allowCreate) return { ok: false, error: missingError };

    const iso = nowIso();
    const base = existing ?? {
      id: date, date, flow: 'none', isPeriodStart: null, note: null,
      createdAt: iso, updatedAt: iso, deletedAt: null,
    };
    // A write to a soft-deleted row revives it: the user is re-stating the day.
    const next = { ...base, ...patch, id: date, date, updatedAt: iso, deletedAt: null };

    const v = validateRow(next);
    if (!v.ok) return v;

    set(state => {
      const days = existing
        ? state.days.map(d => (d.id === date ? next : d))
        : [...state.days, next];
      saveCycle(days);
      return { days };
    });
    return { ok: true, row: next };
  },

  // ============ Actions ============

  setFlow: (date, flow) =>
    get()._write(date, { flow }, { allowCreate: true }),

  // Only meaningful on a day that already has a flow: "this is day 1" and "this
  // bleeding belongs to no period" are both statements ABOUT a recorded flow.
  setPeriodStart: (date, value) =>
    get()._write(date, { isPeriodStart: value }, {
      allowCreate: false,
      missingError: 'record a flow for that day first',
    }),

  // A note with no flow is not a cycle observation and would leave a row the
  // segmenter reads as `none`, quietly changing where a period ends.
  setNote: (date, note) =>
    get()._write(date, { note }, {
      allowCreate: false,
      missingError: 'record a flow for that day first',
    }),

  // Soft delete. Derivation filters on deletedAt; sync propagates the tombstone.
  clearDay: (date) => {
    const existing = get().days.find(d => d.id === date);
    if (!existing) return { ok: false, error: 'nothing recorded for that day' };
    const next = { ...existing, deletedAt: nowIso(), updatedAt: nowIso() };
    set(state => {
      const days = state.days.map(d => (d.id === date ? next : d));
      saveCycle(days);
      return { days };
    });
    return { ok: true };
  },

  // Tombstones EVERY row, for the scoped "delete cycle data" action.
  //
  // Deliberately NOT a hard delete. sync.js pulls bounded by a cursor and merges
  // remote rows into local, so a remote ABSENCE never propagates: another device
  // would keep its full local history and could re-push it. Every other domain
  // in this tree deletes by tombstone for the same reason.
  tombstoneAll: () => {
    const iso = nowIso();
    let touched = 0;
    set(state => {
      const days = state.days.map(d => {
        if (d.deletedAt) return d;
        touched++;
        return { ...d, deletedAt: iso, updatedAt: iso };
      });
      saveCycle(days);
      return { days };
    });
    return { ok: true, tombstoned: touched };
  },

  // ============ Selectors ============

  getLiveDays: () => get().days.filter(d => !d.deletedAt),
  getDay: (date) => get().days.find(d => d.id === date && !d.deletedAt) ?? null,

  // ============ Lifecycle ============

  reload: () => set(loadCycle()),
}));
