// -----------------------------------------------------------------------------
// Title:       usePokesStore.js
// Project:     Glim
// Author:      Reina Hastings (reinahastings13@gmail.com)
// Created:     2026-03-27
// Last Modified: 2026-03-27
// Purpose:     Zustand store for the poke counter. Reads and writes the
//              'glim-pokes' localStorage key (plain integer string).
//              Sync strategy: take-the-max (pokes only ever increase).
// Inputs:      localStorage key: 'glim-pokes' (integer string)
// Outputs:     localStorage key: 'glim-pokes' (integer string)
// -----------------------------------------------------------------------------

import { create } from 'zustand';
import { notifyLocalWrite, DOMAINS } from '../syncBus';

function loadTotal() {
  try {
    const raw = localStorage.getItem('glim-pokes');
    return raw ? (parseInt(raw, 10) || 0) : 0;
  } catch { return 0; }
}

export const usePokesStore = create((set, get) => ({
  total: loadTotal(),

  increment: () => {
    const total = get().total + 1;
    set({ total });
    try { localStorage.setItem('glim-pokes', String(total)); } catch { /* ignore */ }
    notifyLocalWrite(DOMAINS.POKES);
  },

  // Called by sync service event handler when remote total arrives
  reload: () => {
    const total = loadTotal();
    set({ total });
  },
}));
