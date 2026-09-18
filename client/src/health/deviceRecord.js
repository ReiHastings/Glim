// -----------------------------------------------------------------------------
// Title:       deviceRecord.js
// Project:     Glim
// Author:      Reina Hastings (reinahastings13@gmail.com)
// Created:     2026-09-18
// Last Modified: 2026-09-18
// Purpose:     The per-DEVICE health record: whether this phone imports steps,
//              whether its owner has seen the platform permission prompt, and
//              whether health has gone quiet. localStorage key 'glim-health'.
//
//              DELIBERATELY NOT SYNCED, and deliberately not a Zustand store.
//              HealthKit permission is a property of one phone, not of a Glim
//              account: syncing "import is on" to the desktop tab would claim a
//              permission that device never granted and can never have.
//
//              The 'glim-' prefix matters. The account-switch guard in App.jsx
//              wipes every 'glim-*' key, so a different user signing in on this
//              phone starts with the toggle off and must consent again, even
//              though iOS still remembers granting Glim access at the OS level.
//              The toggle IS the consent, not the OS prompt.
// Inputs:      None (reads localStorage on call)
// Outputs:     readDeviceRecord(), writeDeviceRecord(patch)
//
// Usage example:
//   import { readDeviceRecord, writeDeviceRecord } from './deviceRecord';
//   if (readDeviceRecord().stepsImport) { ... }
//   writeDeviceRecord({ askedAt: new Date().toISOString() });
// -----------------------------------------------------------------------------

const STORAGE_KEY = 'glim-health';

const EMPTY = Object.freeze({
  stepsImport:   false,  // is the import switched on for this device
  askedAt:       null,   // ISO, when the platform prompt was last shown
  emptySince:    null,   // ISO, since when health has returned nothing at all
  firstImportAt: null,   // ISO, when this device first imported a non-zero day
  firstImportAnnounced: false, // has Glim said something about it (once per device)
});

/**
 * The device record, always a complete object. A missing, unparseable or
 * non-object value reads as the empty record rather than throwing: this is
 * consulted on the startup path, and a corrupt key must not stop the app.
 */
export function readDeviceRecord() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...EMPTY };
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ...EMPTY };
    return { ...EMPTY, ...parsed };
  } catch {
    return { ...EMPTY };
  }
}

/**
 * Merges `patch` into the record. Returns the record as written, so callers can
 * act on it without a second read.
 *
 * This key is device-local and is deliberately NOT announced on the sync bus:
 * it must never leave the phone. That is also why the file lives outside
 * src/stores, and a static test asserts the omission directly.
 */
export function writeDeviceRecord(patch) {
  const next = { ...readDeviceRecord(), ...patch };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch (e) {
    console.warn('[glim health] could not persist the device record:', e);
  }
  return next;
}
