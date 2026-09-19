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
import { todayStr, dateStr, toLogicalDateStr, logicalDayStart } from '../utils/dateUtils';

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
  return resolveManualFromIndex(buildDayIndex(entries, EMPTY), dateString);
}

// --- Day index -----------------------------------------------------------
//
// PERFORMANCE (profiling pass 2026-09-18, docs/plan_steps_derivation_cost.md):
// the previous implementation re-scanned `entries` once PER DAY WALKED, calling
// toLocaleDateString (an Intl format) per entry per day. computeStreak was
// therefore quadratic: 86% of all main-thread time with the panel open, 120 ms
// at a 365-day streak, and 142 ms per pointer-move event on a phone-class CPU.
//
// The index does one pass over each array and answers every date in O(1). It is
// built per call and lives no longer than the call: there is deliberately NO
// cross-call cache, because a cache would need an invalidation contract keyed on
// array identity, and the per-day rescan (not the repeat calls) is the whole
// cost. See plan section 3.1 and review round 1 finding M7.
//
// OWNERSHIP: the returned maps hold references to the caller's elements. Treat
// the index as read-only and do not retain it across a store write.

// Frozen: this one instance is handed to several callers, so a stray push by a
// future caller would be a cross-caller bug. Frozen, it throws at the push.
const EMPTY = Object.freeze([]);

// Labels already reported, so a corrupt blob logs once per session rather than
// once per call. buildDayIndex runs from the panel memo, from openEditor, from
// handleLog and from the milestone scan; without this, one bad blob produces a
// console line on every editor open and every write.
const reportedBadInput = new Set();

// A malformed localStorage blob must not take the UI down: this runs inside a
// React render body and the app has no error boundary around the panel, so a
// throw here is a white screen. Loud in the log, empty in the UI.
function asArray(value, label) {
  if (value == null) return EMPTY;
  if (Array.isArray(value)) return value;
  if (!reportedBadInput.has(label)) {
    reportedBadInput.add(label);
    console.error(`[glim steps] expected an array for ${label}, got ${typeof value}; treating as empty`);
  }
  return EMPTY;
}

// Test seam: lets a test assert the once-per-label behaviour without a fresh
// module instance.
export const __resetBadInputReports = () => reportedBadInput.clear();

// Winning manual entry and winning health row per logical date.
//
// The two comparisons point in OPPOSITE directions, deliberately:
//   - entries use `>=`, so the LAST element in array order wins a tie. Load
//     bearing: clearManualForToday can write a clear marker in the same
//     millisecond as the entry it supersedes, and the clear must win.
//   - health rows use strict `>`, so the FIRST element in array order wins a
//     tie, matching the reduce this replaces.
// Flipping either silently changes which value a day resolves to. Both are
// pinned by tests/steps_precedence.test.mjs.
export function buildDayIndex(entries, healthRows) {
  const manual = new Map();
  const health = new Map();

  for (const e of asArray(entries, 'glim-steps entries')) {
    if (!e) continue;
    const d = dateStr(e.timestamp);
    const prev = manual.get(d);
    if (!prev || e.timestamp >= prev.timestamp) manual.set(d, e);
  }

  for (const r of asArray(healthRows, 'glim-steps-health rows')) {
    if (!r?.date) continue;
    const prev = health.get(r.date);
    if (!prev || stampMs(r.updatedAt) > stampMs(prev.updatedAt)) health.set(r.date, r);
  }

  return { manual, health };
}

// The manual count for a date, from a prebuilt index. Returns null for "no
// manual statement", which stays distinct from a manual entry OF zero.
export function resolveManualFromIndex(index, dateString) {
  const winner = index.manual.get(dateString);
  if (!winner) return null;
  return winner.count ?? null;
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
  return resolveDayFromIndex(buildDayIndex(entries, healthRows), dateString);
}

// The same resolution, from a prebuilt index. THIS is the multi-date path:
// computeStreak, computeWeeklyAvg and the panel's milestone scan build one index
// and call this per day. It takes the index and NOTHING ELSE, so an index can
// never be paired with arrays it was not built from - a mismatch that an
// optional-parameter design would have made silent (review round 2, M2).
export function resolveDayFromIndex(index, dateString) {
  const manual = resolveManualFromIndex(index, dateString);
  if (manual !== null) return { count: manual, source: 'manual' };

  // Two rows for one date means two platforms imported for the same account
  // (iOS and Android). Latest write wins; both measure the same person.
  const best = index.health.get(dateString);
  if (!best) return { count: 0, source: null };
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
// ANCHORED ON THE LOGICAL DAY, then at noon (2026-09-18, plan section 3.2).
//
// The previous form anchored on `new Date()` at noon, the CALENDAR date. Between
// 00:00 and DAY_BOUNDARY_HOUR the calendar date is already tomorrow while the
// logical date is still today, so the walk started on a logical day that had not
// begun: nothing can be recorded for it, computeStreak breaks at the first day
// below tier 1, and the streak read exactly 0 for three hours every night. The
// 7-day average window slid by a day over the same period. This is the pattern
// health/fold.js:45-46 already used correctly.
//
// `now` is injectable so the walk can be asserted at a fixed instant; see
// tests/steps_day_rollover.test.mjs. Exported for the same reason.
export function logicalDaysBack(n, now = new Date()) {
  const anchor = logicalDayStart(toLogicalDateStr(now));  // 03:00 local, today's LOGICAL date
  anchor.setHours(12, 0, 0, 0);                           // same calendar date, safely mid-day
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
  return streakFromIndex(buildDayIndex(entries, healthRows));
}

// 7-day rolling average of daily step counts (using replace-style counts per day)
function computeWeeklyAvg(entries, healthRows = []) {
  return weeklyAvgFromIndex(buildDayIndex(entries, healthRows));
}

// Index-taking forms. One index serves all 365 lookups, which is what removes
// the quadratic term; see buildDayIndex.
function streakFromIndex(index) {
  let streak = 0;
  for (const dStr of logicalDaysBack(365)) {
    if (resolveDayFromIndex(index, dStr).count >= TIERS[0]) {
      streak++;
    } else {
      break;
    }
  }
  return streak;
}

function weeklyAvgFromIndex(index) {
  let total = 0;
  for (const dStr of logicalDaysBack(7)) {
    total += resolveDayFromIndex(index, dStr).count;
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

  // All four derived values from ONE index, for the panel's memo. Calling the
  // four selectors above would build four identical indexes per render. They
  // stay because the tests call them directly and because StepsPanel needs
  // getStreak on its own after a write.
  getDaySummary: (healthRows = []) => {
    const index = buildDayIndex(get().entries, healthRows);
    const today = todayStr();
    const { count, source } = resolveDayFromIndex(index, today);
    return {
      todayCount:  count,
      todaySource: source,
      streak:      streakFromIndex(index),
      weeklyAvg:   weeklyAvgFromIndex(index),
    };
  },
}));
