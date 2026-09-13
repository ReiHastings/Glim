// -----------------------------------------------------------------------------
// Title:       useJournalStore.js
// Project:     Glim
// Author:      Reina Hastings (reinahastings13@gmail.com)
// Created:     2026-03-27
// Last Modified: 2026-03-27
// Purpose:     Zustand store for journal entries. Reads and writes the
//              'glim-journal' localStorage key (array of entry objects).
//              Soft-delete pattern: deletedAt timestamp set, entry kept,
//              so sync.js can propagate deletions across devices.
// Inputs:      localStorage key: 'glim-journal' (JSON array)
// Outputs:     localStorage key: 'glim-journal' (JSON array)
// -----------------------------------------------------------------------------

import { create } from 'zustand';
import { notifyLocalWrite, DOMAINS } from '../syncBus';

function saveEntries(entries) {
  try {
    localStorage.setItem('glim-journal', JSON.stringify(entries));
    notifyLocalWrite(DOMAINS.JOURNAL);
  } catch { /* ignore */ }
}

export const useJournalStore = create((set) => ({
  entries: [],
  loading: true,

  // Called on mount and by sync service event handler
  reload: () => {
    try {
      const raw = localStorage.getItem('glim-journal');
      if (raw) {
        set({ entries: JSON.parse(raw), loading: false });
        return;
      }
    } catch { /* ignore */ }
    set({ loading: false });
  },

  // Add a new entry (prepend, newest first)
  addEntry: (entry) => set((state) => {
    const entries = [entry, ...state.entries];
    saveEntries(entries);
    return { entries };
  }),

  // Soft delete by id
  deleteEntry: (id) => set((state) => {
    const entries = state.entries.map((e) =>
      e.id === id ? { ...e, deletedAt: new Date().toISOString() } : e
    );
    saveEntries(entries);
    return { entries };
  }),
}));
