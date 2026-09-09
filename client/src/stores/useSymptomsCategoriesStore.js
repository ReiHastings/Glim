// -----------------------------------------------------------------------------
// Title:       useSymptomsCategoriesStore.js
// Project:     Glim
// Author:      Reina Hastings (reinahastings13@gmail.com)
// Created:     2026-09-06
// Last Modified: 2026-09-06
// Purpose:     Zustand store for user-defined symptom categories. Persists to
//              localStorage under key 'glim-symptoms-categories'. Categories are
//              first-class entities with ids, exactly as symptoms are: library
//              items reference categoryId and resolve the name at render time, so
//              a rename propagates through the grid, history and any future
//              export for free. Mirrors useSymptomsLibraryStore's CRUD and
//              archive semantics one for one.
//
//              The four historical categories are SEEDED WITH FIXED IDS and a
//              FIXED TIMESTAMP - see SEED_CATEGORIES for why both matter.
//
//              Seed rows and the legacy id map live in utils/symptomCategories.js
//              so the library store's migration can share them without importing
//              a store.
// Inputs:      None (reads localStorage on import)
// Outputs:     Zustand store hook useSymptomsCategoriesStore
// -----------------------------------------------------------------------------

import { create } from 'zustand';
import { SEED_CATEGORIES, SEED_AT, UNCATEGORIZED_LABEL } from '../utils/symptomCategories';

const STORAGE_KEY = 'glim-symptoms-categories';

// --- Persistence helpers ---

function genId() {
  try { return crypto.randomUUID(); } catch { return String(Date.now()) + Math.random(); }
}

// Adds any seed category the stored list is missing, leaving every existing row
// (including renamed and archived ones) untouched. Idempotent: a seed row is
// soft-deleted on archive, never removed, so an archived seed is "present" and
// is not resurrected.
function withSeeds(items) {
  const present = new Set(items.map(i => i.id));
  const missing = SEED_CATEGORIES
    .filter(c => !present.has(c.id))
    .map(c => ({ ...c, createdAt: SEED_AT, updatedAt: SEED_AT, deletedAt: null }));
  return missing.length > 0 ? [...items, ...missing] : items;
}

function loadCategories() {
  let items = [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed?.items)) items = parsed.items;
    }
  } catch { /* ignore */ }

  const seeded = withSeeds(items);
  if (seeded !== items) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ items: seeded }));
    } catch { /* ignore */ }
  }
  return { items: seeded };
}

function saveCategories(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ items: state.items }));
  } catch { /* ignore */ }
}

// --- Store ---

const initial = loadCategories();

export const useSymptomsCategoriesStore = create((set, get) => ({
  items: initial.items ?? [],

  // ============ Actions ============

  // Creates a category. Returns the new id so the add-a-symptom flow can select
  // it immediately. `order` defaults to the end of the current list.
  addCategory: (name, color = null) => {
    const now = new Date().toISOString();
    const maxOrder = get().items.reduce((m, c) => Math.max(m, c.order ?? 0), -1);
    const category = {
      id:        genId(),
      name,
      color:     color ?? '#9b96b8',
      order:     maxOrder + 1,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    set(state => {
      const next = { ...state, items: [...state.items, category] };
      saveCategories(next);
      return next;
    });
    return category.id;
  },

  // Rename / recolour / reorder. The updatedAt bump is required by the sync
  // strategy: without it the edit never wins the last-write-wins merge and does
  // not propagate cross-device.
  updateCategory: (id, fields) => {
    set(state => {
      const next = {
        ...state,
        items: state.items.map(c =>
          c.id === id ? { ...c, ...fields, updatedAt: new Date().toISOString() } : c
        ),
      };
      saveCategories(next);
      return next;
    });
  },

  // Archive = soft delete. Library items pointing at an archived category keep
  // resolving through getCategory, but READ as uncategorized (getCategoryName).
  archive: (id) => {
    const now = new Date().toISOString();
    set(state => {
      const next = {
        ...state,
        items: state.items.map(c => (c.id === id ? { ...c, deletedAt: now, updatedAt: now } : c)),
      };
      saveCategories(next);
      return next;
    });
  },

  unarchive: (id) => {
    const now = new Date().toISOString();
    set(state => {
      const next = {
        ...state,
        items: state.items.map(c => (c.id === id ? { ...c, deletedAt: null, updatedAt: now } : c)),
      };
      saveCategories(next);
      return next;
    });
  },

  // Re-reads localStorage into Zustand state. Called by sync.js after a remote
  // pull and by reloadAllStores on an account switch.
  reload: () => {
    const data = loadCategories();
    set({ items: data.items ?? [] });
  },

  // ============ Selectors ============

  // Active categories in display order, for the add-a-symptom picker. Surfacing
  // these prominently is what stops free-form categories proliferating: the user
  // should be picking, not retyping.
  getActiveCategories: () =>
    get().items
      .filter(c => !c.deletedAt)
      .slice()
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name)),

  getArchivedCategories: () =>
    get().items
      .filter(c => c.deletedAt)
      .slice()
      .sort((a, b) => new Date(b.deletedAt) - new Date(a.deletedAt)),

  // Resolves a category by id INCLUDING archived ones, so a historical library
  // item can still be inspected. Returns null when the id is unknown.
  getCategory: (id) => get().items.find(c => c.id === id) ?? null,

  // The DISPLAY name. An archived or unknown category reads as "uncategorized":
  // an archived category has been retired by the user and should not keep
  // labelling the live grid, and a missing one has no name to show.
  getCategoryName: (id) => {
    const c = get().getCategory(id);
    return c && !c.deletedAt ? c.name : UNCATEGORIZED_LABEL;
  },
}));
