// -----------------------------------------------------------------------------
// Title:       deviceRecord.js
// Project:     Glim - cycle tracking Phase 1
// Author:      Reina Hastings (reihastings@gmail.com)
// Created:     2026-09-18
// Purpose:     The per-DEVICE cycle record: whether this device shows the cycle
//              panel, and whether its first-enable setup has run.
//              localStorage key 'glim-cycle-device'.
//
//              DELIBERATELY NOT SYNCED, and deliberately not a Zustand store.
//              Follows client/src/health/deviceRecord.js exactly, for a related
//              reason: syncing "cycle tracking is on" would turn the panel on in
//              a shared desktop browser tab because it was enabled on a phone.
//              For menstrual data that is the exposure the whole feature is
//              careful about, so the toggle is a property of one device.
//
//              The 'glim-' prefix matters. The account-switch guard in App.jsx
//              wipes every 'glim-*' key, so a different user signing in on this
//              device starts with the panel off.
//
//              `setupDone` is a per-device convenience only - it stops the
//              first-enable check re-running on every open. It is NOT a
//              correctness guard: ensureCategory and ensureItem are idempotent
//              and fixed-id, so re-running setup converges rather than
//              duplicating. That is the property that makes an unsynced flag
//              safe here, where a synced settings flag would not be.
//
// Inputs:      none (reads localStorage on call)
// Outputs:     readCycleRecord(), writeCycleRecord(patch), DEFAULT_CYCLE_RECORD
// Usage:       import { readCycleRecord, writeCycleRecord } from './deviceRecord';
//              if (readCycleRecord().enabled) showCyclePanel();
//              writeCycleRecord({ enabled: true, setupDone: true });
// -----------------------------------------------------------------------------

const STORAGE_KEY = 'glim-cycle-device';

export const DEFAULT_CYCLE_RECORD = Object.freeze({
  enabled: false,     // does this device show the cycle panel
  setupDone: false,   // has first-enable setup run here
  enabledAt: null,    // ISO stamp, for the panel's own copy
});

export function readCycleRecord() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') return { ...DEFAULT_CYCLE_RECORD, ...parsed };
    }
  } catch { /* ignore */ }
  return { ...DEFAULT_CYCLE_RECORD };
}

export function writeCycleRecord(patch) {
  const next = { ...readCycleRecord(), ...patch };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch { /* ignore */ }
  return next;
}
