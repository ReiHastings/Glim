// -----------------------------------------------------------------------------
// Title:       useWaterStore.js
// Project:     Glim
// Author:      Reina Hastings (reinahastings13@gmail.com)
// Created:     2026-03-27
// Last Modified: 2026-03-27
// Purpose:     Zustand store for water tracking. Persists to localStorage under
//              key 'glim-water'. Tracks bottle log entries, bottle size, and
//              daily goal. Exposes computed selectors for today's count, streak
//              (consecutive days at or above goal), and 7-day rolling average.
// Inputs:      None (reads localStorage on import)
// Outputs:     Zustand store hook exported as useWaterStore
// -----------------------------------------------------------------------------

import { create } from 'zustand';
import { notifyLocalWrite, DOMAINS } from '../syncBus';
import { todayStr, dateStr, toLogicalDateStr } from '../utils/dateUtils';

const STORAGE_KEY = 'glim-water';

// Unique id for new entries. crypto.randomUUID guarantees cross-device
// uniqueness; the fallback covers non-secure contexts. Date.now() alone can
// collide for two rapid logs (or two devices at the same millisecond), which
// would corrupt soft-delete targeting and sync dedupe.
function genId() {
  try { return crypto.randomUUID(); } catch { return String(Date.now()) + Math.random(); }
}

// --- Persistence helpers ---

function loadWater() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  // configUpdatedAt defaults to epoch (not now) so an untouched or freshly
  // cleared store looks OLDER than any real remote config. Otherwise, after an
  // account switch clears localStorage, a returning user's default config would
  // out-timestamp and overwrite their real saved bottleOz/goal on first sync.
  // A genuine config edit (setBottleOz/setGoal) stamps the real current time.
  return { entries: [], bottleOz: 24, goal: 6, configUpdatedAt: new Date(0).toISOString() };
}

function saveWater(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      entries:          state.entries,
      bottleOz:         state.bottleOz,
      goal:             state.goal,
      configUpdatedAt:  state.configUpdatedAt,
    }));
    notifyLocalWrite(DOMAINS.WATER);
  } catch { /* ignore */ }
}

// --- Computed helpers ---

function countToday(entries) {
  const today = todayStr();
  return entries.filter(e => !e.deletedAt && dateStr(e.timestamp) === today).length;
}

// Consecutive days at or above goal, counting backward from today
function computeStreak(entries, goal) {
  if (entries.length === 0) return 0;

  const byDate = {};
  for (const e of entries) {
    if (e.deletedAt) continue;
    const d = dateStr(e.timestamp);
    byDate[d] = (byDate[d] || 0) + 1;
  }

  let streak = 0;
  const base = new Date();
  for (let i = 0; i < 365; i++) {
    const d = new Date(base);
    d.setDate(d.getDate() - i);
    const dStr = toLogicalDateStr(d);
    if ((byDate[dStr] || 0) >= goal) {
      streak++;
    } else {
      break;
    }
  }
  return streak;
}

// Average bottles per day over the last 7 days (including today)
function computeWeeklyAvg(entries) {
  const byDate = {};
  for (const e of entries) {
    if (e.deletedAt) continue;
    const d = dateStr(e.timestamp);
    byDate[d] = (byDate[d] || 0) + 1;
  }
  const base = new Date();
  let total = 0;
  for (let i = 0; i < 7; i++) {
    const d = new Date(base);
    d.setDate(d.getDate() - i);
    const dStr = toLogicalDateStr(d);
    total += byDate[dStr] || 0;
  }
  return Math.round((total / 7) * 10) / 10;
}

// --- Store ---

const initial = loadWater();

export const useWaterStore = create((set, get) => ({
  entries:         initial.entries,
  bottleOz:        initial.bottleOz,
  goal:            initial.goal,
  configUpdatedAt: initial.configUpdatedAt ?? new Date(0).toISOString(),

  logBottle: () => {
    const entry = {
      id:        genId(),
      timestamp: Date.now(),
      bottleOz:  get().bottleOz,
    };
    set(state => {
      const next = { ...state, entries: [...state.entries, entry] };
      saveWater(next);
      return next;
    });
  },

  undoLast: () => {
    set(state => {
      const today = todayStr();
      // Most recent non-deleted entry for today, by timestamp (not array order,
      // which can change after a sync merge).
      const candidates = state.entries
        .filter(e => !e.deletedAt && dateStr(e.timestamp) === today)
        .sort((a, b) => a.timestamp - b.timestamp);
      if (candidates.length === 0) return state;
      const lastId = candidates[candidates.length - 1].id;
      // Soft-delete (set deletedAt) instead of removing, so the deletion
      // propagates on sync and an already-pushed bottle cannot reappear on the
      // next pull. Selectors and pushes both key off deletedAt.
      const deletedAt = new Date().toISOString();
      const next = {
        ...state,
        entries: state.entries.map(e => (e.id === lastId ? { ...e, deletedAt } : e)),
      };
      saveWater(next);
      return next;
    });
  },

  setBottleOz: (oz) => {
    set(state => {
      const next = { ...state, bottleOz: oz, configUpdatedAt: new Date().toISOString() };
      saveWater(next);
      return next;
    });
  },

  setGoal: (n) => {
    set(state => {
      const next = { ...state, goal: n, configUpdatedAt: new Date().toISOString() };
      saveWater(next);
      return next;
    });
  },

  // Called by sync service after a pull that updates localStorage
  reload: () => {
    const data = loadWater();
    set({
      entries:         data.entries,
      bottleOz:        data.bottleOz,
      goal:            data.goal,
      configUpdatedAt: data.configUpdatedAt ?? new Date(0).toISOString(),
    });
  },

  // Computed selectors - read current state via get()
  getToday:     () => countToday(get().entries),
  getStreak:    () => computeStreak(get().entries, get().goal),
  getWeeklyAvg: () => computeWeeklyAvg(get().entries),
}));
