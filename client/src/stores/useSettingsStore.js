// -----------------------------------------------------------------------------
// Title:       useSettingsStore.js
// Project:     Glim
// Author:      Reina Hastings (reinahastings13@gmail.com)
// Created:     2026-03-27
// Last Modified: 2026-09-06
// Purpose:     Zustand store for user-configurable reminder intervals and the
//              opt-in end-of-day symptom reminder.
//              Initializes synchronously from localStorage on import.
//              Writes back to localStorage (with lastModified) on every
//              setter call, preserving the format expected by sync.js.
// Inputs:      localStorage key: 'glim-settings'
// Outputs:     localStorage key: 'glim-settings' (JSON with lastModified)
// -----------------------------------------------------------------------------

import { create } from 'zustand';
import { notifyLocalWrite, DOMAINS } from '../syncBus';

// --- Load initial values from localStorage ---
function loadSettings() {
  try {
    const raw = localStorage.getItem('glim-settings');
    if (raw) {
      const s = JSON.parse(raw);
      // GOTCHA: loadSettings and saveSettings both enumerate fields explicitly.
      // A field added to only one of them is silently dropped on the next write
      // and never syncs. Any new setting must appear in BOTH.
      return {
        wellnessInterval: s.wellnessInterval ?? 20,
        moveInterval:     s.moveInterval     ?? 45,
        eyesInterval:     s.eyesInterval     ?? 20,
        symptomReminderEnabled: s.symptomReminderEnabled ?? false,
        symptomReminderHour:    s.symptomReminderHour    ?? 21,
      };
    }
  } catch { /* ignore */ }
  return {
    wellnessInterval: 20, moveInterval: 45, eyesInterval: 20,
    symptomReminderEnabled: false, symptomReminderHour: 21,
  };
}

// --- Write current state back to localStorage ---
function saveSettings(state) {
  try {
    localStorage.setItem('glim-settings', JSON.stringify({
      wellnessInterval: state.wellnessInterval,
      moveInterval:     state.moveInterval,
      eyesInterval:     state.eyesInterval,
      symptomReminderEnabled: state.symptomReminderEnabled,
      symptomReminderHour:    state.symptomReminderHour,
      lastModified:     new Date().toISOString(),
    }));
    notifyLocalWrite(DOMAINS.SETTINGS);
  } catch { /* ignore */ }
}

export const useSettingsStore = create((set, get) => ({
  ...loadSettings(),

  setWellnessInterval: (v) => { set({ wellnessInterval: v }); saveSettings({ ...get(), wellnessInterval: v }); },
  setMoveInterval:     (v) => { set({ moveInterval: v });     saveSettings({ ...get(), moveInterval: v });     },
  setEyesInterval:     (v) => { set({ eyesInterval: v });     saveSettings({ ...get(), eyesInterval: v });     },

  setSymptomReminderEnabled: (v) => { set({ symptomReminderEnabled: v }); saveSettings({ ...get(), symptomReminderEnabled: v }); },
  setSymptomReminderHour:    (v) => { set({ symptomReminderHour: v });    saveSettings({ ...get(), symptomReminderHour: v });    },

  // Called by sync service event handler when remote settings arrive
  reload: () => { set(loadSettings()); },
}));
