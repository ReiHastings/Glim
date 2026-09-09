// -----------------------------------------------------------------------------
// Title:       useSymptomsLibraryStore.js
// Project:     Glim
// Author:      Reina Hastings (reinahastings13@gmail.com)
// Created:     2026-08-14
// Last Modified: 2026-09-06
// Purpose:     Zustand store for the personal symptom library. Persists to
//              localStorage under key 'glim-symptoms-library'. Reference list of
//              symptom names that populates the companion chip grid. Log entries
//              store only symptomId and resolve the name at render time, so a
//              rename propagates through history and the export. Archiving is a
//              soft delete: archived items leave the grid but stay resolvable for
//              historical entries.
//
//              Categories are NOT owned here. An item holds a categoryId
//              referencing useSymptomsCategoriesStore, and the panel resolves the
//              name (stores never import each other). A one-time, idempotent
//              migration rewrites the legacy `category` string field.
// Inputs:      None (reads localStorage on import)
// Outputs:     Zustand store hook exported as useSymptomsLibraryStore
// -----------------------------------------------------------------------------

import { create } from 'zustand';
import { LEGACY_CATEGORY_IDS, DEFAULT_CATEGORY_ID } from '../utils/symptomCategories';

const STORAGE_KEY = 'glim-symptoms-library';

// --- Persistence helpers ---

function genId() {
  try { return crypto.randomUUID(); } catch { return String(Date.now()) + Math.random(); }
}

// --- Legacy category migration (Phase 1.5) ---
//
// Phase 1 items carried `category: '<string>'`; they now carry
// `categoryId: '<id>'` pointing into the categories store. Runs on every load and
// is IDEMPOTENT: an item that already has a categoryId is left exactly as it was,
// so a second pass is a no-op and there is no convergence loop.
//
// Deliberately does NOT bump updatedAt. This is a local schema normalisation, not
// a user edit: bumping it would push every library item on every device the first
// time it loads, and the newest such push would win the last-write-wins merge
// against a genuine concurrent rename. The mapping is deterministic and the seed
// ids are fixed, so every device migrates the same legacy string to the same id
// independently and converges without syncing anything.
function migrateCategories(items) {
  let changed = false;
  const migrated = items.map(item => {
    if (item.categoryId !== undefined && item.category === undefined) return item;
    changed = true;
    const { category, ...rest } = item;
    return {
      ...rest,
      categoryId: item.categoryId ?? LEGACY_CATEGORY_IDS[category] ?? DEFAULT_CATEGORY_ID,
    };
  });
  return changed ? migrated : items;
}

function loadLibrary() {
  let items = [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed?.items)) items = parsed.items;
    }
  } catch { /* ignore */ }

  const migrated = migrateCategories(items);
  if (migrated !== items) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ items: migrated }));
    } catch { /* ignore */ }
  }
  return { items: migrated };
}

function saveLibrary(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ items: state.items }));
  } catch { /* ignore */ }
}

// --- Store ---

const initial = loadLibrary();

export const useSymptomsLibraryStore = create((set, get) => ({
  items: initial.items ?? [],

  // ============ Actions ============

  // Creates a library item. Name is stored exactly as typed. Returns the new id
  // so the companion "+ add" flow can immediately log a moment for it.
  // categoryId is stored AS GIVEN, with no membership check: categories are now
  // user-defined entities, so this store has no list to validate against (and
  // could not read one - stores never import each other). An id that does not
  // resolve renders as "uncategorized", which is the correct outcome for an
  // archived or deleted category anyway.
  addItem: (name, categoryId = DEFAULT_CATEGORY_ID) => {
    const now = new Date().toISOString();
    const item = {
      id:         genId(),
      name,
      categoryId: categoryId ?? DEFAULT_CATEGORY_ID,
      createdAt:  now,
      updatedAt:  now,
      deletedAt:  null,
    };
    set(state => {
      const next = { ...state, items: [...state.items, item] };
      saveLibrary(next);
      return next;
    });
    return item.id;
  },

  // Rename / recategorize. The updatedAt bump is required by the sync strategy:
  // without it the edit never wins the last-write-wins merge and does not
  // propagate cross-device.
  updateItem: (id, fields) => {
    set(state => {
      const next = {
        ...state,
        items: state.items.map(item =>
          item.id === id ? { ...item, ...fields, updatedAt: new Date().toISOString() } : item
        ),
      };
      saveLibrary(next);
      return next;
    });
  },

  // Archive = soft delete. Historical entries keep resolving through getItem.
  archive: (id) => {
    const now = new Date().toISOString();
    set(state => {
      const next = {
        ...state,
        items: state.items.map(item =>
          item.id === id ? { ...item, deletedAt: now, updatedAt: now } : item
        ),
      };
      saveLibrary(next);
      return next;
    });
  },

  unarchive: (id) => {
    const now = new Date().toISOString();
    set(state => {
      const next = {
        ...state,
        items: state.items.map(item =>
          item.id === id ? { ...item, deletedAt: null, updatedAt: now } : item
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

  // Active (non-archived) items ordered by recency of use, most recent first.
  // recencyById is { [symptomId]: latest startedAt ISO }, built by the PANEL from
  // the log store and passed in: this store never imports the symptoms store
  // (stores never import each other; the panel orchestrates the cross-store read).
  // Never-used items sort last, newest-created first.
  getActiveItems: (recencyById = {}) => {
    return get().items
      .filter(item => !item.deletedAt)
      .slice()
      .sort((a, b) => {
        const ra = recencyById[a.id] ?? null;
        const rb = recencyById[b.id] ?? null;
        if (ra && rb) return new Date(rb) - new Date(ra);
        if (ra) return -1;
        if (rb) return 1;
        return new Date(b.createdAt) - new Date(a.createdAt);
      });
  },

  // Resolves an item by id INCLUDING archived ones - history and the export
  // depend on archived symptoms still rendering their name normally.
  getItem: (id) => get().items.find(item => item.id === id) ?? null,

  getArchivedItems: () =>
    get().items
      .filter(item => item.deletedAt)
      .slice()
      .sort((a, b) => new Date(b.deletedAt) - new Date(a.deletedAt)),
}));
