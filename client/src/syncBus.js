// -----------------------------------------------------------------------------
// Title:       syncBus.js
// Project:     Glim
// Author:      Reina Hastings (reinahastings13@gmail.com)
// Created:     2026-09-10
// Purpose:     Tiny in-process event bus between the Zustand stores and the
//              sync service. A store calls notifyLocalWrite(domain) right after
//              it persists to localStorage; sync.js subscribes with
//              onLocalWrite and schedules a debounced run. This module imports
//              NOTHING from Firebase, so a store that imports it stays free of
//              the network layer (stores never import sync.js).
//
//              DOMAINS is the single list of sync-domain names. sync.js logs
//              and counts per run under these same strings, and a static test
//              asserts every store notifies with a member of this list.
// Inputs:      None
// Outputs:     DOMAINS, ALL_DOMAINS, notifyLocalWrite(domain), onLocalWrite(fn)
// Usage:       import { notifyLocalWrite, DOMAINS } from '../syncBus';
//              notifyLocalWrite(DOMAINS.WATER);      // after localStorage.setItem
//              const off = onLocalWrite((domain) => { ... }); off();
// -----------------------------------------------------------------------------

// --- Domain names ---
// One entry per line the sync service records. steps-config and
// nutrition-config are separate Firestore documents but live in the same
// localStorage blob as their entries, so their stores notify under 'steps' and
// 'nutrition'; every run is a full run, so the distinction only matters for
// the per-domain log line.
export const DOMAINS = Object.freeze({
  JOURNAL:            'journal',
  POKES:              'pokes',
  SETTINGS:           'settings',
  WATER:              'water',
  STEPS:              'steps',
  STEPS_CONFIG:       'steps-config',
  NUTRITION:          'nutrition',
  NUTRITION_CONFIG:   'nutrition-config',
  NUTRITION_LIBRARY:  'nutrition-library',
  SYMPTOMS:           'symptoms',
  SYMPTOMS_LIBRARY:   'symptoms-library',
  SYMPTOM_CATEGORIES: 'symptom-categories',
  SYMPTOM_DAYS:       'symptom-days',
  STEPS_HEALTH:       'steps-health',
});

export const ALL_DOMAINS = Object.freeze(Object.values(DOMAINS));

// --- Subscribers ---

const subscribers = new Set();

// Subscribe to local writes. Returns the unsubscribe function.
export function onLocalWrite(fn) {
  if (typeof fn !== 'function') throw new TypeError('onLocalWrite expects a function');
  subscribers.add(fn);
  return () => { subscribers.delete(fn); };
}

// Announce that `domain` was just written to localStorage. An unknown domain
// is logged loudly but still delivered: the store's write has already landed,
// and a missed sync is worse than a mislabeled one.
export function notifyLocalWrite(domain) {
  if (!ALL_DOMAINS.includes(domain)) {
    console.error(`[glim syncBus] notifyLocalWrite: unknown domain '${domain}'`);
  }
  for (const fn of subscribers) {
    try { fn(domain); } catch (e) { console.warn('[glim syncBus] subscriber threw:', e); }
  }
}

// Test seam.
export const __test = { subscriberCount: () => subscribers.size };
