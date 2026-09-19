// -----------------------------------------------------------------------------
// Title:       index.js (stores barrel)
// Project:     Glim
// Author:      Reina Hastings (reinahastings13@gmail.com)
// Created:     2026-03-27
// Last Modified: 2026-09-06
// Purpose:     Barrel export for all Glim stores, plus reloadAllStores() - the
//              single re-hydration entry point used by the UID-change guard in
//              App.jsx. Registering a store in ALL_STORES below is the ONLY step
//              needed for it to be cleared correctly on an account switch: the
//              guard no longer names stores individually, so a domain added later
//              cannot be silently forgotten (the bug class of commit a53da46 and
//              of the two symptom stores before this change).
// Inputs:      None
// Outputs:     Named store hooks, ALL_STORES, reloadAllStores()
// -----------------------------------------------------------------------------

import { useCreatureStore } from './useCreatureStore';
import { useClockStore } from './useClockStore';
import { useMessageStore } from './useMessageStore';
import { useSettingsStore } from './useSettingsStore';
import { useUIStore } from './useUIStore';
import { useJournalStore } from './useJournalStore';
import { usePokesStore } from './usePokesStore';
import { useWaterStore } from './useWaterStore';
import { useStepsStore } from './useStepsStore';
import { useNutritionStore } from './useNutritionStore';
import { useNutritionLibraryStore } from './useNutritionLibraryStore';
import { useSymptomsStore } from './useSymptomsStore';
import { useSymptomsLibraryStore } from './useSymptomsLibraryStore';
import { useSymptomsCategoriesStore } from './useSymptomsCategoriesStore';
import { useSymptomClearDaysStore } from './useSymptomClearDaysStore';
import { useStepsHealthStore } from './useStepsHealthStore';

export {
  useCreatureStore,
  useClockStore,
  useMessageStore,
  useSettingsStore,
  useUIStore,
  useJournalStore,
  usePokesStore,
  useWaterStore,
  useStepsStore,
  useNutritionStore,
  useNutritionLibraryStore,
  useSymptomsStore,
  useSymptomsLibraryStore,
  useSymptomsCategoriesStore,
  useSymptomClearDaysStore,
  useStepsHealthStore,
};

// Every store, in one place. Stores with no persistence (creature, message, UI)
// are listed too and are simply skipped by reloadAllStores, which reloads only
// what defines reload(). A static test asserts this array and the export list
// above stay in step.
export const ALL_STORES = [
  useCreatureStore,
  useClockStore,
  useMessageStore,
  useSettingsStore,
  useUIStore,
  useJournalStore,
  usePokesStore,
  useWaterStore,
  useStepsStore,
  useNutritionStore,
  useNutritionLibraryStore,
  useSymptomsStore,
  useSymptomsLibraryStore,
  useSymptomsCategoriesStore,
  useSymptomClearDaysStore,
  useStepsHealthStore,
];

// Re-reads localStorage into every persisted store. Called by the UID-change
// guard after the localStorage prefix scan has wiped the previous user's data:
// without it, the outgoing user's rows survive in Zustand memory, get
// re-persisted on the next mutation, and are pushed to Firestore under the NEW
// user's uid. For the symptom diary that is health data crossing accounts.
export function reloadAllStores() {
  for (const store of ALL_STORES) {
    const state = store.getState();
    if (typeof state.reload === 'function') state.reload();
  }
}
