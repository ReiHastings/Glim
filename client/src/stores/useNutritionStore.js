// -----------------------------------------------------------------------------
// Title:       useNutritionStore.js
// Project:     Glim
// Author:      Reina Hastings (reinahastings13@gmail.com)
// Created:     2026-04-04
// Last Modified: 2026-04-04
// Purpose:     Zustand store for nutrition tracking. Persists to localStorage
//              under key 'glim-nutrition'. Tracks daily log entries and per-
//              nutrient goals (two-tier: min/ideal). Exposes computed selectors
//              for today's totals, progress state, streaks, and weekly averages.
// Inputs:      None (reads localStorage on import)
// Outputs:     Zustand store hook exported as useNutritionStore
// -----------------------------------------------------------------------------

import { create } from 'zustand';
import { notifyLocalWrite, DOMAINS } from '../syncBus';
import { todayStr, toLogicalDateStr } from '../utils/dateUtils';

const STORAGE_KEY = 'glim-nutrition';

const DEFAULT_GOALS = {
  protein: { min: 80,  ideal: 100 },  // grams
  fiber:   { min: 25,  ideal: 35  },  // grams
  fruit:   { min: 2,   ideal: 3   },  // servings
  veggie:  { min: 3,   ideal: 5   },  // servings
};

// --- Persistence helpers ---

function genId() {
  try { return crypto.randomUUID(); } catch { return String(Date.now()) + Math.random(); }
}

function loadNutrition() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return { logs: [], goals: DEFAULT_GOALS, configUpdatedAt: null };
}

function saveNutrition(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      logs:            state.logs,
      goals:           state.goals,
      configUpdatedAt: state.configUpdatedAt,
    }));
    notifyLocalWrite(DOMAINS.NUTRITION);
  } catch { /* ignore */ }
}

// --- Computed helpers ---

// Sums today's active (non-deleted) log entries, clamped to 0.
// Returns { protein, fiber, fruit, veggie } using unified key names.
function getTodayTotals(logs) {
  const today = todayStr();
  let protein = 0, fiber = 0, fruit = 0, veggie = 0;
  for (const e of logs) {
    if (e.date !== today || e.deletedAt) continue;
    protein += e.protein        || 0;
    fiber   += e.fiber          || 0;
    fruit   += e.fruitServings  || 0;
    veggie  += e.vegServings    || 0;
  }
  return {
    protein: Math.max(0, protein),
    fiber:   Math.max(0, fiber),
    fruit:   Math.max(0, fruit),
    veggie:  Math.max(0, veggie),
  };
}

// Builds a map of { [dateStr]: { protein, fiber, fruit, veggie } } across all logs.
// Used for streak and weekly avg computations.
function getDailyTotals(logs) {
  const byDate = {};
  for (const e of logs) {
    if (e.deletedAt) continue;
    const d = e.date;
    if (!byDate[d]) byDate[d] = { protein: 0, fiber: 0, fruit: 0, veggie: 0 };
    byDate[d].protein += e.protein       || 0;
    byDate[d].fiber   += e.fiber         || 0;
    byDate[d].fruit   += e.fruitServings || 0;
    byDate[d].veggie  += e.vegServings   || 0;
  }
  // Clamp negatives to 0 per day
  for (const d of Object.keys(byDate)) {
    byDate[d].protein = Math.max(0, byDate[d].protein);
    byDate[d].fiber   = Math.max(0, byDate[d].fiber);
    byDate[d].fruit   = Math.max(0, byDate[d].fruit);
    byDate[d].veggie  = Math.max(0, byDate[d].veggie);
  }
  return byDate;
}

// Consecutive days (counting back from today) where a single nutrient met its min.
// Today is included if its clamped total >= min.
function computeStreak(logs, goals, nutrientKey) {
  const byDate = getDailyTotals(logs);
  const minGoal = goals[nutrientKey]?.min ?? 0;
  let streak = 0;
  const base = new Date();
  for (let i = 0; i < 365; i++) {
    const d = new Date(base);
    d.setDate(d.getDate() - i);
    const dStr = toLogicalDateStr(d);
    if ((byDate[dStr]?.[nutrientKey] ?? 0) >= minGoal) {
      streak++;
    } else {
      break;
    }
  }
  return streak;
}

// Consecutive days where ALL four nutrients met their minimums.
function computeAllStreak(logs, goals) {
  const byDate = getDailyTotals(logs);
  let streak = 0;
  const base = new Date();
  for (let i = 0; i < 365; i++) {
    const d = new Date(base);
    d.setDate(d.getDate() - i);
    const dStr = toLogicalDateStr(d);
    const t = byDate[dStr] ?? { protein: 0, fiber: 0, fruit: 0, veggie: 0 };
    const allMet =
      t.protein >= (goals.protein?.min ?? 0) &&
      t.fiber   >= (goals.fiber?.min   ?? 0) &&
      t.fruit   >= (goals.fruit?.min   ?? 0) &&
      t.veggie  >= (goals.veggie?.min  ?? 0);
    if (allMet) {
      streak++;
    } else {
      break;
    }
  }
  return streak;
}

// Average daily total for a nutrient over the last 7 complete days (excludes today).
// Grams: rounded to 1 decimal. Servings: whole number.
function computeWeeklyAvg(logs, nutrientKey) {
  const byDate = getDailyTotals(logs);
  const base = new Date();
  let total = 0;
  for (let i = 1; i <= 7; i++) {
    const d = new Date(base);
    d.setDate(d.getDate() - i);
    const dStr = toLogicalDateStr(d);
    total += byDate[dStr]?.[nutrientKey] ?? 0;
  }
  const avg = total / 7;
  if (nutrientKey === 'fruit' || nutrientKey === 'veggie') return Math.round(avg);
  return Math.round(avg * 10) / 10;
}

// --- Store ---

const initial = loadNutrition();

export const useNutritionStore = create((set, get) => ({
  logs:            initial.logs  ?? [],
  goals:           { ...DEFAULT_GOALS, ...(initial.goals ?? {}) },
  configUpdatedAt: initial.configUpdatedAt ?? null,

  // ============ Actions ============

  // Log a library item. Panel passes the full item object to avoid cross-store reads.
  // quantity defaults to 1. Nutrient values are denormalized at log time.
  logFromLibrary: (item, quantity = 1) => {
    const entry = {
      id:            genId(),
      itemId:        item.id,
      name:          item.name,
      quantity,
      protein:       (item.protein       || 0) * quantity,
      fiber:         (item.fiber         || 0) * quantity,
      fruitServings: (item.fruitServings || 0) * quantity,
      vegServings:   (item.vegServings   || 0) * quantity,
      meal:          null,
      createdAt:     new Date().toISOString(),
      date:          todayStr(),
      deletedAt:     null,
    };
    set(state => {
      const next = { ...state, logs: [...state.logs, entry] };
      saveNutrition(next);
      return next;
    });
    return entry;
  },

  // Log a raw amount for a single nutrient. Amount may be negative (correction).
  // nutrientKey: 'protein' | 'fiber' | 'fruitServings' | 'vegServings'
  logRaw: (nutrientKey, amount) => {
    const entry = {
      id:            genId(),
      itemId:        null,
      name:          null,
      quantity:      null,
      protein:       nutrientKey === 'protein'       ? amount : 0,
      fiber:         nutrientKey === 'fiber'         ? amount : 0,
      fruitServings: nutrientKey === 'fruitServings' ? amount : 0,
      vegServings:   nutrientKey === 'vegServings'   ? amount : 0,
      meal:          null,
      createdAt:     new Date().toISOString(),
      date:          todayStr(),
      deletedAt:     null,
    };
    set(state => {
      const next = { ...state, logs: [...state.logs, entry] };
      saveNutrition(next);
      return next;
    });
    return entry;
  },

  // Soft-delete the most recent active log entry for today.
  // Uses soft-delete (not hard-delete) because multi-nutrient entries are complex
  // and sync re-introduction of a hard-deleted entry would corrupt multiple counters.
  undoLast: () => {
    set(state => {
      const today = todayStr();
      const todayActive = state.logs
        .filter(e => e.date === today && !e.deletedAt)
        .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
      if (todayActive.length === 0) return state;
      const lastId = todayActive[todayActive.length - 1].id;
      const now = new Date().toISOString();
      const next = {
        ...state,
        logs: state.logs.map(e => e.id === lastId ? { ...e, deletedAt: now } : e),
      };
      saveNutrition(next);
      return next;
    });
  },

  setGoal: (nutrientKey, min, ideal) => {
    set(state => {
      const next = {
        ...state,
        goals:           { ...state.goals, [nutrientKey]: { min, ideal } },
        configUpdatedAt: new Date().toISOString(),
      };
      saveNutrition(next);
      return next;
    });
  },

  // Re-reads localStorage into Zustand state. Called by sync.js after remote pull.
  reload: () => {
    const data = loadNutrition();
    set({
      logs:            data.logs  ?? [],
      goals:           { ...DEFAULT_GOALS, ...(data.goals ?? {}) },
      configUpdatedAt: data.configUpdatedAt ?? null,
    });
  },

  // ============ Selectors ============

  getToday: () => getTodayTotals(get().logs),

  // Returns per-nutrient progress with minMet/idealMet flags.
  getProgress: () => {
    const totals = getTodayTotals(get().logs);
    const goals  = get().goals;
    const build  = (key) => ({
      current:  totals[key],
      min:      goals[key].min,
      ideal:    goals[key].ideal,
      minMet:   totals[key] >= goals[key].min,
      idealMet: totals[key] >= goals[key].ideal,
    });
    return {
      protein: build('protein'),
      fiber:   build('fiber'),
      fruit:   build('fruit'),
      veggie:  build('veggie'),
    };
  },

  getStreak:    (nutrientKey) => computeStreak(get().logs, get().goals, nutrientKey),
  getAllStreak:  ()            => computeAllStreak(get().logs, get().goals),
  getWeeklyAvg: (nutrientKey) => computeWeeklyAvg(get().logs, nutrientKey),
}));
