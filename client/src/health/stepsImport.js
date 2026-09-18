// -----------------------------------------------------------------------------
// Title:       stepsImport.js
// Project:     Glim
// Author:      Reina Hastings (reinahastings13@gmail.com)
// Created:     2026-09-18
// Last Modified: 2026-09-18
// Purpose:     The one entry point that reads step totals out of the platform
//              health store and records them in Glim: importSteps({ reason }).
//              Reads the last eight logical days as hourly buckets, folds them
//              into Glim's 3 AM days, and writes ONLY the days whose total
//              changed.
//
//              Runs on app start, on return to the foreground, when the steps
//              panel opens, and once when the user switches the toggle on. It
//              is safe to call at any of those moments: the guards below
//              collapse a burst into one read.
// Inputs:      { reason, force?, adapter?, getUid? } - the last two are test
//              seams; production callers pass neither.
// Outputs:     Promise<{ ran, reason, written?, days?, skipped? }> for logging
//              and tests. Side effects: rows in useStepsHealthStore, fields in
//              the device record.
//
// Usage example:
//   import { importSteps } from './health/stepsImport';
//   await importSteps({ reason: 'resume' });
//
//   Debug logging: localStorage['glim-debug-health'] = '1'
// -----------------------------------------------------------------------------

import { getHealthAdapter } from './adapter';
import { expectedLogicalDates, foldHourlyBuckets } from './fold';
import { readDeviceRecord, writeDeviceRecord } from './deviceRecord';
import { useStepsHealthStore } from '../stores/useStepsHealthStore';
import { logicalDayStart, toLogicalDateStr } from '../utils/dateUtils';

// How many logical days each import re-reads: today plus the previous seven.
// Watch data arrives late and HealthKit backfills, so yesterday's total can
// still rise at breakfast. Re-reading a week costs one query.
const WINDOW_DAYS = 8;

// The floor between two completed imports on this device. Startup, a resume and
// a panel open can all land within a second of each other; without this they
// would be three reads and three rounds of writes for the same data.
const MIN_INTERVAL_MS = 60_000;

// Module-scoped, not stored: both are properties of this page session.
let inFlight = null;
let lastCompletedAt = 0;

function debug(...args) {
  try {
    if (localStorage.getItem('glim-debug-health') === '1') console.info('[glim health]', ...args);
  } catch { /* ignore */ }
}

// The default uid source. Imported LAZILY so that this module can be tested in
// bare Node: the real firebase.js reads import.meta.env (undefined outside
// Vite) and the test harness's firebase mock exports only `db`, so a top-level
// `import { auth }` would fail at link time and take every test with it.
async function defaultGetUid() {
  try {
    const { auth } = await import('../firebase');
    return auth?.currentUser?.uid ?? null;
  } catch (e) {
    debug('could not read auth state:', e);
    return null;
  }
}

/**
 * Reads the platform's step totals for the last eight logical days and records
 * the ones that changed.
 *
 * @param {object}   opts
 * @param {string}   opts.reason    'startup' | 'resume' | 'panel' | 'toggle'
 * @param {boolean} [opts.force]    skip only the MIN_INTERVAL_MS floor
 * @param {object}  [opts.adapter]  test seam; defaults to getHealthAdapter()
 * @param {Function}[opts.getUid]   test seam; defaults to Firebase auth
 */
export async function importSteps({ reason, force = false, adapter, getUid = defaultGetUid } = {}) {
  // --- Guard 1: the device must want this ---
  // Cheapest check and the most common "no", so it goes first: on the desktop
  // tab and for anyone who has not switched the import on, nothing else runs.
  const record = readDeviceRecord();
  if (!record.stepsImport) {
    debug(`skip (${reason}): import is off for this device`);
    return { ran: false, reason, skipped: 'toggle-off' };
  }

  // --- Guard 2: one import at a time ---
  // A forced call (the toggle) must not be dropped, so it waits for the run in
  // flight and then runs itself: the user has just granted access, and the
  // in-flight run was started before that and may have read nothing.
  if (inFlight) {
    if (!force) {
      debug(`skip (${reason}): an import is already running`);
      return { ran: false, reason, skipped: 'in-flight' };
    }
    debug(`(${reason}): waiting for the running import before forcing a fresh one`);
    try { await inFlight; } catch { /* its own caller logged it */ }
  }

  // --- Guard 3: the interval floor ---
  if (!force && Date.now() - lastCompletedAt < MIN_INTERVAL_MS) {
    debug(`skip (${reason}): last import was less than ${MIN_INTERVAL_MS / 1000}s ago`);
    return { ran: false, reason, skipped: 'too-soon' };
  }

  const run = doImport({ reason, adapter, getUid });
  inFlight = run;
  try {
    return await run;
  } finally {
    inFlight = null;
    lastCompletedAt = Date.now();
  }
}

async function doImport({ reason, adapter, getUid }) {
  const health = adapter ?? await getHealthAdapter();

  // --- Guard 4: the platform must actually have health data ---
  // Deliberately after the toggle check and inside the run: on iPad or a Mac
  // build isAvailable() is false, and the toggle should never have been shown
  // there in the first place.
  if (!(await health.isAvailable())) {
    debug(`skip (${reason}): no health data on this platform`);
    return { ran: false, reason, skipped: 'unavailable' };
  }

  // The uid this import belongs to. Everything it writes is checked against
  // this before each write (see writeIfStillOurs).
  const startUid = await getUid();

  // ONE `now` for the whole import. The window, the clamp and "which day is
  // today" all derive from it: if the clock crossed 3 AM between computing the
  // window and folding the result, the two halves would disagree about the
  // logical date and the clamp would discard every bucket.
  const now = new Date();
  const dates = expectedLogicalDates(now, WINDOW_DAYS);
  const from = logicalDayStart(dates[0]);   // 03:00 local of the oldest day

  let buckets;
  try {
    buckets = await health.readHourlySteps(from, now);
  } catch (e) {
    // A failed read is not an error state to show the user: the next foreground
    // tries again, and the panel keeps showing what it already had.
    console.warn('[glim health] reading steps failed:', e);
    return { ran: false, reason, skipped: 'read-failed' };
  }

  const folded = foldHourlyBuckets(buckets, dates);
  debug(`(${reason}) read ${buckets.length} buckets -> ${folded.length} day(s)`, folded);

  // --- Write only what changed ---
  const source = health.source;
  let written = 0;
  let abandoned = false;

  for (const day of folded) {
    const existing = useStepsHealthStore.getState().rows
      .find(r => r.id === `${source}:${day.date}`);
    if (existing && existing.steps === day.steps) continue;   // the change guard

    // THE ACCOUNT CHECK, immediately before the write and not once at the end.
    // By the time a run finished, every upsert has already written localStorage
    // and notified the sync bus, so there would be nothing left to discard: the
    // previous user's health totals would already be sitting in the next user's
    // storage, and the next sync would push them under the new uid. This is the
    // leak the App.jsx prefix wipe and reloadAllStores exist to prevent.
    if (await getUid() !== startUid) {
      debug(`(${reason}) account changed mid-import; abandoning before writing ${day.date}`);
      abandoned = true;
      break;
    }

    const res = useStepsHealthStore.getState().upsertHealthRow({ source, date: day.date, steps: day.steps });
    if (res.ok) written++;
    else console.warn(`[glim health] refused to store ${day.date}:`, res.error);
  }

  if (abandoned) return { ran: false, reason, written, skipped: 'account-changed' };

  // --- Has health gone quiet? ---
  // Only meaningful once the prompt has been shown. iOS never tells an app that
  // a read was denied, so "no data at all" is the ONLY symptom available, and
  // it is ambiguous: access off, or genuinely no steps recorded. The UI must
  // phrase it as uncertainty.
  const total = folded.reduce((t, d) => t + d.steps, 0);
  if (await getUid() === startUid) {
    if (total > 0) {
      const rec = readDeviceRecord();
      const patch = {};
      if (rec.emptySince) patch.emptySince = null;
      if (!rec.firstImportAt) patch.firstImportAt = new Date().toISOString();
      if (Object.keys(patch).length) writeDeviceRecord(patch);
    } else if (await health.hasBeenAsked()) {
      const rec = readDeviceRecord();
      if (!rec.emptySince) writeDeviceRecord({ emptySince: new Date().toISOString() });
    }
  }

  debug(`(${reason}) wrote ${written} day(s); window total ${total}`);
  return { ran: true, reason, written, days: folded.length, today: toLogicalDateStr(now) };
}

// Test seam: the guards above are module state by design (they are properties of
// this page session, not of any account), so tests need a way back to a clean
// slate between scenarios.
export function __resetImportGuards() {
  inFlight = null;
  lastCompletedAt = 0;
}
