// title: steps_import.test.mjs
// project: Glim
// author: Reina Hastings
// contact: reinahastings13@gmail.com
//
// purpose:
//   Invariant tests for the health step import service (src/health/
//   stepsImport.js), driving the REAL importSteps and the REAL
//   useStepsHealthStore against a FAKE adapter and a stubbed uid source.
//
//   Covers the four guards (toggle off, in flight, interval floor, platform
//   unavailable), the change guard that keeps unchanged days out of Firestore,
//   idempotence, the empty-window detection that drives the panel's copy, and
//   the account-switch abandonment - which is asserted MID-LOOP, because a
//   guard that only checks at the end of a run discards nothing.
//
// inputs:  none (seeds its own localStorage)
// outputs: per-check pass/fail lines; exits non-zero if any check fails
//
// usage:
//   cd client && node --import ./tests/register-hooks.mjs tests/steps_import.test.mjs

// --- localStorage shim, before any store is imported ---
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => { mem.set(k, String(v)); },
  removeItem: (k) => { mem.delete(k); },
  clear: () => mem.clear(),
  key: (i) => [...mem.keys()][i] ?? null,
  get length() { return mem.size; },
};

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.error(`  FAIL ${name}`); }
}

const { importSteps, __resetImportGuards } = await import('../src/health/stepsImport.js');
const { useStepsHealthStore } = await import('../src/stores/useStepsHealthStore.js');
const { readDeviceRecord, writeDeviceRecord } = await import('../src/health/deviceRecord.js');
const { expectedLogicalDates } = await import('../src/health/fold.js');
const { logicalDayStart } = await import('../src/utils/dateUtils.js');

const rows = () => useStepsHealthStore.getState().rows;

// --- A fake adapter that records what it was asked ---
//
// `stepsByDate` maps a logical date to a whole-day total, which the fake spreads
// over that day's hours. Tests therefore state intent ("this day has 8000
// steps") rather than constructing 24 buckets by hand.
function fakeAdapter({ stepsByDate = {}, available = true, asked = true, throwOnRead = false } = {}) {
  const calls = { isAvailable: 0, requestAccess: 0, hasBeenAsked: 0, readHourlySteps: 0, ranges: [] };
  return {
    source: 'healthkit',
    calls,
    async isAvailable() { calls.isAvailable++; return available; },
    async requestAccess() { calls.requestAccess++; },
    async hasBeenAsked() { calls.hasBeenAsked++; return asked; },
    async readHourlySteps(from, to) {
      calls.readHourlySteps++;
      calls.ranges.push([from, to]);
      if (throwOnRead) throw new Error('health read exploded');
      const out = [];
      for (const [date, total] of Object.entries(stepsByDate)) {
        if (total === 0) continue;             // an empty day yields NO buckets
        const start = logicalDayStart(date);
        for (let h = 0; h < 4; h++) {
          out.push({
            start: new Date(start.getTime() + h * 3_600_000),
            end:   new Date(start.getTime() + (h + 1) * 3_600_000),
            steps: total / 4,
          });
        }
      }
      return out;
    },
  };
}

const uidStub = (value) => async () => value;

function reset({ toggle = true } = {}) {
  mem.clear();
  useStepsHealthStore.getState().reload();
  __resetImportGuards();
  writeDeviceRecord({ stepsImport: toggle, askedAt: toggle ? new Date().toISOString() : null });
}

const DATES = expectedLogicalDates(new Date(), 8);
const TODAY = DATES[7];
const YESTERDAY = DATES[6];

// =============================================================================
//  Guards
// =============================================================================
console.log('\n--- guard: the device toggle ---');
{
  reset({ toggle: false });
  const a = fakeAdapter({ stepsByDate: { [TODAY]: 8000 } });
  const res = await importSteps({ reason: 'startup', adapter: a, getUid: uidStub('U') });
  check('an import with the toggle off does not run', res.ran === false && res.skipped === 'toggle-off');
  check('...and never touches the adapter at all', a.calls.isAvailable === 0 && a.calls.readHourlySteps === 0);
  check('...and writes no rows', rows().length === 0);
}

console.log('\n--- guard: the platform must have health data ---');
{
  reset();
  const a = fakeAdapter({ available: false, stepsByDate: { [TODAY]: 8000 } });
  const res = await importSteps({ reason: 'startup', adapter: a, getUid: uidStub('U') });
  check('an unavailable platform does not run', res.ran === false && res.skipped === 'unavailable');
  check('...and is never read from', a.calls.readHourlySteps === 0);
  check('...and writes no rows', rows().length === 0);
}

console.log('\n--- guard: the interval floor ---');
{
  reset();
  const a = fakeAdapter({ stepsByDate: { [TODAY]: 8000 } });
  const first = await importSteps({ reason: 'startup', adapter: a, getUid: uidStub('U') });
  check('the first import runs', first.ran === true && first.written === 1);

  const second = await importSteps({ reason: 'resume', adapter: a, getUid: uidStub('U') });
  check('a second import a moment later is skipped', second.ran === false && second.skipped === 'too-soon');
  check('...without reading health again', a.calls.readHourlySteps === 1);

  const forced = await importSteps({ reason: 'toggle', force: true, adapter: a, getUid: uidStub('U') });
  check('force bypasses the floor', forced.ran === true);
  check('...and does read again', a.calls.readHourlySteps === 2);
  check('...but writes nothing, because nothing changed', forced.written === 0);
}

console.log('\n--- guard: one import at a time ---');
{
  reset();
  let release;
  const gate = new Promise(res => { release = res; });
  const slow = fakeAdapter({ stepsByDate: { [TODAY]: 8000 } });
  const baseRead = slow.readHourlySteps.bind(slow);
  slow.readHourlySteps = async (f, t) => { await gate; return baseRead(f, t); };

  const running = importSteps({ reason: 'startup', adapter: slow, getUid: uidStub('U') });
  const concurrent = await importSteps({ reason: 'panel', adapter: slow, getUid: uidStub('U') });
  check('a second import while one is in flight is skipped',
    concurrent.ran === false && concurrent.skipped === 'in-flight');

  release();
  const first = await running;
  check('the in-flight one still completes', first.ran === true && first.written === 1);

  // A forced call must never be silently dropped: the user has just granted
  // access, and the run already in flight may have read nothing.
  reset();
  let release2;
  const gate2 = new Promise(res => { release2 = res; });
  const slow2 = fakeAdapter({ stepsByDate: { [TODAY]: 5000 } });
  const baseRead2 = slow2.readHourlySteps.bind(slow2);
  slow2.readHourlySteps = async (f, t) => { await gate2; return baseRead2(f, t); };
  const running2 = importSteps({ reason: 'startup', adapter: slow2, getUid: uidStub('U') });
  const forcedP = importSteps({ reason: 'toggle', force: true, adapter: slow2, getUid: uidStub('U') });
  release2();
  await running2;
  const forced = await forcedP;
  check('a forced import waits for the running one and then runs', forced.ran === true);
  check('...reading health a second time', slow2.calls.readHourlySteps === 2);
}

// =============================================================================
//  The change guard (every write costs a Firestore push)
// =============================================================================
console.log('\n--- the change guard ---');
{
  reset();
  const a = fakeAdapter({ stepsByDate: { [TODAY]: 8000, [YESTERDAY]: 12000 } });
  const first = await importSteps({ reason: 'startup', adapter: a, getUid: uidStub('U') });
  check('a first import writes every day it found', first.written === 2 && rows().length === 2);

  __resetImportGuards();
  const again = await importSteps({ reason: 'resume', adapter: a, getUid: uidStub('U') });
  check('IDEMPOTENT: re-importing unchanged data writes nothing', again.ran === true && again.written === 0);

  // E1: the Watch syncs and yesterday's total rises.
  __resetImportGuards();
  const b = fakeAdapter({ stepsByDate: { [TODAY]: 8000, [YESTERDAY]: 13000 } });
  const third = await importSteps({ reason: 'resume', adapter: b, getUid: uidStub('U') });
  check('E1: only the day that changed is written', third.written === 1);
  check('...and it holds the new value',
    rows().find(r => r.date === YESTERDAY).steps === 13000);
  check('...while the unchanged day keeps its original stamp', rows().length === 2);
}

console.log('\n--- a day with no data gets no row ---');
{
  reset();
  const a = fakeAdapter({ stepsByDate: { [TODAY]: 8000, [YESTERDAY]: 0 } });
  await importSteps({ reason: 'startup', adapter: a, getUid: uidStub('U') });
  check('a zero day is not stored as a zero row',
    rows().length === 1 && rows()[0].date === TODAY);
}

console.log('\n--- the read window ---');
{
  reset();
  const a = fakeAdapter({ stepsByDate: { [TODAY]: 100 } });
  await importSteps({ reason: 'startup', adapter: a, getUid: uidStub('U') });
  const [from, to] = a.calls.ranges[0];
  check('the window starts at 03:00 of the oldest expected day',
    from.getTime() === logicalDayStart(DATES[0]).getTime());
  check('the window ends at (about) now', Math.abs(to.getTime() - Date.now()) < 5000);
}

console.log('\n--- a failing read is not fatal ---');
{
  reset();
  const good = fakeAdapter({ stepsByDate: { [TODAY]: 8000 } });
  await importSteps({ reason: 'startup', adapter: good, getUid: uidStub('U') });
  const before = JSON.stringify(rows());

  __resetImportGuards();
  const bad = fakeAdapter({ throwOnRead: true });
  const res = await importSteps({ reason: 'resume', adapter: bad, getUid: uidStub('U') });
  check('a throwing read reports itself rather than propagating',
    res.ran === false && res.skipped === 'read-failed');
  check('...and leaves the stored rows untouched', JSON.stringify(rows()) === before);
}

// =============================================================================
//  Empty-window detection (what the panel's copy keys off)
// =============================================================================
console.log('\n--- empty-window detection ---');
{
  reset();
  const empty = fakeAdapter({ stepsByDate: {}, asked: true });
  await importSteps({ reason: 'startup', adapter: empty, getUid: uidStub('U') });
  check('nothing at all, after the prompt was shown -> emptySince is recorded',
    typeof readDeviceRecord().emptySince === 'string');

  __resetImportGuards();
  const first = readDeviceRecord().emptySince;
  await importSteps({ reason: 'resume', adapter: empty, getUid: uidStub('U') });
  check('...and is not overwritten on the next empty run', readDeviceRecord().emptySince === first);

  __resetImportGuards();
  const arriving = fakeAdapter({ stepsByDate: { [TODAY]: 3000 } });
  await importSteps({ reason: 'resume', adapter: arriving, getUid: uidStub('U') });
  check('data arriving clears emptySince', readDeviceRecord().emptySince === null);
  check('...and records the first import for this device',
    typeof readDeviceRecord().firstImportAt === 'string');

  const stamp = readDeviceRecord().firstImportAt;
  __resetImportGuards();
  const more = fakeAdapter({ stepsByDate: { [TODAY]: 4000 } });
  await importSteps({ reason: 'resume', adapter: more, getUid: uidStub('U') });
  check('firstImportAt is set once and never moves', readDeviceRecord().firstImportAt === stamp);
}

console.log('\n--- empty window BEFORE the prompt has been shown ---');
{
  reset();
  const neverAsked = fakeAdapter({ stepsByDate: {}, asked: false });
  await importSteps({ reason: 'startup', adapter: neverAsked, getUid: uidStub('U') });
  check('nothing is claimed about health when the prompt was never shown',
    readDeviceRecord().emptySince === null);
}

// =============================================================================
//  Account switch mid-import (E10)
// =============================================================================
console.log('\n--- the account check runs before EVERY write, not once at the end ---');
{
  reset();
  // Three days of data. The uid changes after the first row is written, which a
  // guard that only checks at the end could not act on: by then all three rows
  // would already be in localStorage and announced to the sync bus.
  const a = fakeAdapter({ stepsByDate: { [DATES[5]]: 1000, [DATES[6]]: 2000, [DATES[7]]: 3000 } });
  let calls = 0;
  const flipping = async () => (++calls <= 2 ? 'USER_A' : 'USER_B');

  const res = await importSteps({ reason: 'startup', adapter: a, getUid: flipping });
  check('the import reports that it abandoned the run',
    res.ran === false && res.skipped === 'account-changed');
  check('rows written before the switch survive', rows().length === 1);
  check('...and rows after it were never written', rows().length < 3);
  check('the abandoned run writes no device-record claims either',
    readDeviceRecord().firstImportAt === null);
}

console.log('\n--- a stable account writes everything ---');
{
  reset();
  const a = fakeAdapter({ stepsByDate: { [DATES[5]]: 1000, [DATES[6]]: 2000, [DATES[7]]: 3000 } });
  const res = await importSteps({ reason: 'startup', adapter: a, getUid: uidStub('U') });
  check('all three days are stored', res.ran === true && res.written === 3 && rows().length === 3);
  check('each row carries the adapter source', rows().every(r => r.source === 'healthkit'));
  check('each row has a deterministic id', rows().every(r => r.id === `healthkit:${r.date}`));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
