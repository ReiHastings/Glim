// -----------------------------------------------------------------------------
// Title:       useStepsStore.js
// Project:     Glim
// Author:      Reina Hastings (reinahastings13@gmail.com)
// Created:     2026-03-30
// Last Modified: 2026-03-30
// Purpose:     Zustand store for step tracking. Persists to localStorage under
//              key 'glim-steps'. Replace-style: latest entry per date wins when
//              deriving today's count. Tracks all raw entries for cross-device
//              sync (additive merge at storage layer, replace-style at derived
//              value layer). Exposes streak (consecutive days >= tier 1) and
//              7-day rolling average.
// Inputs:      None (reads localStorage on import)
// Outputs:     Zustand store hook exported as useStepsStore
// -----------------------------------------------------------------------------

import { create } from 'zustand';
import { notifyLocalWrite, DOMAINS } from '../syncBus';
import { todayStr, dateStr, toLogicalDateStr } from '../utils/dateUtils';

// Re-export so existing consumers (StepsPanel) don't break
export { dateStr };

const STORAGE_KEY = 'glim-steps';

// Default goal and auto-tier computation
const DEFAULT_GOAL = 10000;

// Compute four milestone tiers from a single goal value.
// First three round to nearest 100; fourth is the exact goal.
export function computeTiers(goal) {
  const fractions = [0.25, 0.5, 0.75, 1.0];
  return fractions.map((f, i) => {
    if (i === 3) return goal;
    return Math.round((goal * f) / 100) * 100;
  });
}

// Exported for consumers that still read TIERS directly
export const TIERS = computeTiers(DEFAULT_GOAL);

// --- Persistence helpers ---

function loadSteps() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return { entries: [], goal: DEFAULT_GOAL };
}

function saveSteps(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      entries: state.entries,
      goal: state.goal,
      configUpdatedAt: state.configUpdatedAt,
    }));
    notifyLocalWrite(DOMAINS.STEPS);
  } catch { /* ignore */ }
}

// --- Computed helpers ---

// The MANUAL value for a date, or null when the user has said nothing about it.
//
// Replace-style: the latest entry per date wins. Returns null in two cases that
// must stay distinguishable from a real zero:
//   - no entries for the date at all
//   - the latest entry is a CLEAR MARKER (count === null), written by
//     clearManualForToday to hand the day back to the health import
// A manual entry OF zero is a real statement and returns 0, not null.
export function manualCountForDate(entries, dateString) {
  const dayEntries = (entries ?? []).filter(e => dateStr(e.timestamp) === dateString);
  if (dayEntries.length === 0) return null;
  // `>=`, so that two entries sharing a millisecond resolve to the LATER
  // APPENDED one. Human taps never collide, but clearManualForToday can be
  // called in the same millisecond as the entry it supersedes, and the clear
  // must win: the array order is the order the statements were made.
  const latest = dayEntries.reduce((a, e) => (e.timestamp >= a.timestamp ? e : a));
  return latest.count ?? null;
}

// Milliseconds of an ISO stamp, mirroring sync.js's ts(): a missing or
// malformed stamp must not win a comparison by accident.
function stampMs(v) {
  const t = v ? new Date(v).getTime() : 0;
  return Number.isNaN(t) ? 0 : t;
}

// The count Glim shows for a date, and where it came from.
//
// PRECEDENCE (handoff spec D2): a manual entry always beats an imported row for
// the same date. A manual entry is a deliberate act; an import is automatic and
// reruns on every foreground, so "latest write wins" would let the automatic
// path overwrite a deliberate correction within minutes.
//
// healthRows are passed IN rather than read from useStepsHealthStore: stores in
// this project never import each other (the panel composes them), and keeping
// this function pure is what makes the precedence rules testable in bare Node.
export function resolveDayCount(entries, healthRows, dateString) {
  const manual = manualCountForDate(entries, dateString);
  if (manual !== null) return { count: manual, source: 'manual' };

  const rows = (healthRows ?? []).filter(r => r?.date === dateString);
  if (rows.length === 0) return { count: 0, source: null };

  // Two rows for one date means two platforms imported for the same account
  // (iOS and Android). Latest write wins; both measure the same person.
  const best = rows.reduce((a, b) => (stampMs(b.updatedAt) > stampMs(a.updatedAt) ? b : a));
  return { count: best.steps, source: best.source };
}

// Replace-style count for a date, health-inclusive.
// The third argument is optional so that two-argument callers written before the
// health import keep their manual-only behavior.
export function countForDate(entries, dateString, healthRows = []) {
  return resolveDayCount(entries, healthRows, dateString).count;
}

// Walks back `n` logical days from today, oldest last, yielding date strings.
//
// ANCHORED AT NOON for the same reason health/fold.js is (spec R7a): carrying
// the current time of day into setDate() arithmetic can land on a local time
// that DST skips, which JS normalizes forward an hour and which then shifts the
// logical date by a whole day. Noon exists on every day in every zone.
function logicalDaysBack(n) {
  const anchor = new Date();
  anchor.setHours(12, 0, 0, 0);
  const out = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(anchor);
    d.setDate(d.getDate() - i);
    out.push(toLogicalDateStr(d));
  }
  return out;
}

// Streak: consecutive days reaching tier 1 (2,500 steps), counting back from today.
// Health-imported days count: a user who never types a number still has a streak.
function computeStreak(entries, healthRows = []) {
  let streak = 0;
  for (const dStr of logicalDaysBack(365)) {
    if (countForDate(entries, dStr, healthRows) >= TIERS[0]) {
      streak++;
    } else {
      break;
    }
  }
  return streak;
}

// 7-day rolling average of daily step counts (using replace-style counts per day)
function computeWeeklyAvg(entries, healthRows = []) {
  let total = 0;
  for (const dStr of logicalDaysBack(7)) {
    total += countForDate(entries, dStr, healthRows);
  }
  return Math.round((total / 7) * 10) / 10;
}

// --- Store ---

const initial = loadSteps();

export const useStepsStore = create((set, get) => ({
  entries: initial.entries ?? [],
  goal: initial.goal ?? DEFAULT_GOAL,
  configUpdatedAt: initial.configUpdatedAt ?? null,

  // Update the daily step goal. Tiers auto-derive via computeTiers().
  setGoal: (n) => {
    const goal = Math.max(100, Math.round(n));
    set(state => {
      const next = { ...state, goal, configUpdatedAt: new Date().toISOString() };
      saveSteps(next);
      return next;
    });
  },

  // Creates a new log entry. Replace-style resolution happens at the derived
  // value layer (countForDate picks the latest entry per date), not here.
  logSteps: (count) => {
    const entry = { id: Date.now(), timestamp: Date.now(), count };
    set(state => {
      const next = { ...state, entries: [...state.entries, entry] };
      saveSteps(next);
      return next;
    });
  },

  // Hands today back to the health import after a manual entry.
  //
  // Appends an ordinary entry whose count is null - a CLEAR MARKER, not a
  // deletion. Manual entries are append-only and sync on the write-once path,
  // where nothing is ever edited or removed, so "undo" has to be expressed as a
  // later statement rather than as a removal. manualCountForDate reads the
  // latest entry for the day, sees null, and lets resolveDayCount fall through
  // to the imported row. Typing a number afterwards supersedes the marker.
  clearManualForToday: () => {
    const entry = { id: Date.now(), timestamp: Date.now(), count: null };
    set(state => {
      const next = { ...state, entries: [...state.entries, entry] };
      saveSteps(next);
      return next;
    });
  },

  // Called by sync service after a pull that updates localStorage
  reload: () => {
    const data = loadSteps();
    set({
      entries: data.entries ?? [],
      goal: data.goal ?? DEFAULT_GOAL,
      configUpdatedAt: data.configUpdatedAt ?? null,
    });
  },

  // Computed selectors - read current state via get().
  //
  // healthRows come from the CALLER (the panel, which subscribes to
  // useStepsHealthStore) rather than from a cross-store getState() call: stores
  // here never import each other, and a getState() read would not subscribe the
  // component to health-store changes, so the panel would show a stale number
  // after an import until something else re-rendered it.
  getTodayCount:  (healthRows = []) => countForDate(get().entries, todayStr(), healthRows),
  getTodaySource: (healthRows = []) => resolveDayCount(get().entries, healthRows, todayStr()).source,
  getStreak:      (healthRows = []) => computeStreak(get().entries, healthRows),
  getWeeklyAvg:   (healthRows = []) => computeWeeklyAvg(get().entries, healthRows),
}));
