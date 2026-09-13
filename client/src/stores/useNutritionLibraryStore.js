// -----------------------------------------------------------------------------
// Title:       useNutritionLibraryStore.js
// Project:     Glim
// Author:      Reina Hastings (reinahastings13@gmail.com)
// Created:     2026-04-04
// Last Modified: 2026-07-14
// Purpose:     Zustand store for the personal food item library. Persists to
//              localStorage under key 'glim-nutrition-library'. Manages a
//              reference list of food items with per-unit nutrient values.
//              Separate from useNutritionStore: different data shape (reference
//              vs. event log), different sync strategy, different access patterns.
// Inputs:      None (reads localStorage on import)
// Outputs:     Zustand store hook exported as useNutritionLibraryStore
// -----------------------------------------------------------------------------

import { create } from 'zustand';
import { notifyLocalWrite, DOMAINS } from '../syncBus';
import { todayStr } from '../utils/dateUtils';

const STORAGE_KEY = 'glim-nutrition-library';

// --- Persistence helpers ---

function genId() {
  try { return crypto.randomUUID(); } catch { return String(Date.now()) + Math.random(); }
}

function loadLibrary() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return { items: [] };
}

function saveLibrary(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ items: state.items }));
    notifyLocalWrite(DOMAINS.NUTRITION_LIBRARY);
  } catch { /* ignore */ }
}

// --- Store ---

const initial = loadLibrary();

export const useNutritionLibraryStore = create((set, get) => ({
  items: initial.items ?? [],

  // ============ Actions ============

  // Creates a new food item. Returns the created item so the panel can use it immediately.
  addItem: ({ name, protein = 0, fiber = 0, fruitServings = 0, vegServings = 0, unit = '' }) => {
    const item = {
      id:            genId(),
      name,
      protein,
      fiber,
      fruitServings,
      vegServings,
      unit,
      hidden:        false,
      usageCount:    0,
      lastUsed:      null,
      createdAt:     new Date().toISOString(),
      updatedAt:     new Date().toISOString(),
      deletedAt:     null,
    };
    set(state => {
      const next = { ...state, items: [...state.items, item] };
      saveLibrary(next);
      return next;
    });
    return item;
  },

  // Merges partial updates into the matching item. Does not affect log entries
  // (nutrient values are denormalized at log time, so edits only affect future logs).
  editItem: (itemId, updates) => {
    set(state => {
      const next = {
        ...state,
        items: state.items.map(item =>
          item.id === itemId ? { ...item, ...updates, updatedAt: new Date().toISOString() } : item
        ),
      };
      saveLibrary(next);
      return next;
    });
  },

  // Hides an item from the quick-add list (logs still reference it by id).
  // updatedAt bump is required for the sync edit-propagation strategy: without
  // it, visibility toggles never win the field-level merge and don't propagate
  // cross-device.
  hideItem: (itemId) => {
    set(state => {
      const next = {
        ...state,
        items: state.items.map(item =>
          item.id === itemId ? { ...item, hidden: true, updatedAt: new Date().toISOString() } : item
        ),
      };
      saveLibrary(next);
      return next;
    });
  },

  unhideItem: (itemId) => {
    set(state => {
      const next = {
        ...state,
        items: state.items.map(item =>
          item.id === itemId ? { ...item, hidden: false, updatedAt: new Date().toISOString() } : item
        ),
      };
      saveLibrary(next);
      return next;
    });
  },

  // Soft-delete: sets deletedAt. Hidden-but-not-deleted items still appear in logs.
  deleteItem: (itemId) => {
    const now = new Date().toISOString();
    set(state => {
      const next = {
        ...state,
        items: state.items.map(item =>
          item.id === itemId ? { ...item, deletedAt: now, updatedAt: now } : item
        ),
      };
      saveLibrary(next);
      return next;
    });
  },

  // Called by the panel after a successful logFromLibrary. NOT called by the nutrition store.
  // Cross-store flow: panel orchestrates both stores; stores never import each other.
  recordUsage: (itemId) => {
    set(state => {
      const next = {
        ...state,
        items: state.items.map(item =>
          item.id === itemId
            ? { ...item, usageCount: item.usageCount + 1, lastUsed: todayStr(), updatedAt: new Date().toISOString() }
            : item
        ),
      };
      saveLibrary(next);
      return next;
    });
  },

  // Re-reads localStorage into Zustand state. Called by sync.js after remote pull.
  reload: () => {
    const data = loadLibrary();
    set({ items: data.items ?? [] });
  },

  // ============ Selectors ============

  // Returns visible (non-hidden, non-deleted) items sorted by usage frequency.
  // Optionally filters by case-insensitive substring match on name.
  getVisibleItems: (searchQuery) => {
    const items = get().items.filter(
      item => !item.hidden && !item.deletedAt
    );
    const filtered = searchQuery
      ? items.filter(item => item.name.toLowerCase().includes(searchQuery.toLowerCase()))
      : items;
    return filtered.slice().sort((a, b) => b.usageCount - a.usageCount);
  },

  // Returns a single item by id regardless of hidden/deleted status.
  // Used by the panel to pass the full item to logFromLibrary.
  getItemById: (itemId) => {
    return get().items.find(item => item.id === itemId) ?? null;
  },
}));
