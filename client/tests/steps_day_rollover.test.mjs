// title: steps_day_rollover.test.mjs
// project: Glim
// author: Reina Hastings
// contact: reinahastings13@gmail.com
// date created: 2026-09-18
//
// purpose:
//   Acceptance criterion 5 of docs/plan_steps_derivation_cost.md: the steps day
//   walk must start at the LOGICAL day, not the calendar day.
//
//   `logicalDaysBack` used to anchor on `new Date(); setHours(12,...)`, the
//   CALENDAR date. Between 00:00 and 03:00 local (DAY_BOUNDARY_HOUR = 3) the
//   calendar date is already tomorrow while the logical date is still today, so
//   the walk started on a logical day that had not begun. Nothing can have been
//   recorded for it, `computeStreak` breaks at the first day below tier 1, and
//   the streak therefore read 0 for three hours every night. The same anchor is
//   used by `computeWeeklyAvg`, so the 7-day window slid too.
//
//   Covers three things:
//     1. the streak and the weekly average at six instants, four of them inside
//        the 00:00-03:00 window and two of them DST transition days;
//     2. logicalDaysBack both WITH an injected `now` and with the DEFAULT
//        argument. The default path is the one production takes, and a fix that
//        corrected only the injected path would satisfy every other check here;
//     3. useClockStore.tick, which the panel's memo depends on: no notification
//        inside a logical day, exactly one across the boundary.
//
// inputs:  none (seeds its own localStorage, stubs the Date constructor)
// outputs: per-check pass/fail lines; exits non-zero if any check fails
//
// usage:
//   cd client
//   TZ=America/New_York node --import ./tests/register-hooks.mjs tests/steps_day_rollover.test.mjs

// --- Timezone guard (hard). Criterion 5 pins DST instants; under any other
//     zone the walk cannot be checked, so fail up front rather than warn. ---
if (process.env.TZ !== 'America/New_York') {
  console.error('FAIL this test must run under TZ=America/New_York (see tests/README.md)');
  process.exit(1);
}

// --- localStorage shim, before the stores are imported ---
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
  if (cond) { passed++; console.log(`  ok      ${name}`); }
  else { failed++; console.error(`  FAIL    ${name}`); }
}

// HISTORY: while this file was written before the fix, the eight in-window
// assertions below went through a red() helper that reported them without
// failing the run. The fix has landed, so they are ordinary checks and MUST be
// able to fail. A code review demonstrated why that conversion matters: with
// red() in place, reverting logicalDaysBack's DEFAULT parameter path to the
// calendar anchor - the realistic regression, since production never passes
// `now` - left this file exiting 0 with the nightly bug back in production.

const storeMod = await import('../src/stores/useStepsStore.js');
const { useStepsStore, TIERS } = storeMod;
const { toLogicalDateStr, logicalDayStart, todayStr } = await import('../src/utils/dateUtils.js');

const steps = () => useStepsStore.getState();

// =============================================================================
//  Clock control. The Date CONSTRUCTOR is stubbed, not just Date.now: the code
//  under test calls `new Date()`, which does not consult Date.now, and stubbing
//  only the latter would make every assertion here vacuous (the same lesson
//  recorded for sync_scheduler.test.mjs S4 in tests/README.md).
// =============================================================================

const RealDate = Date;

function withClock(instantMs, fn) {
  globalThis.Date = class extends RealDate {
    constructor(...a) { if (a.length === 0) super(instantMs); else super(...a); }
    static now() { return instantMs; }
  };
  try { return fn(); } finally { globalThis.Date = RealDate; }
}

const localInstant = (y, m, d, h, min) => new RealDate(y, m - 1, d, h, min, 0, 0).getTime();

// The logical day of an instant, computed without the code under test.
function logicalDayOf(nowMs) {
  const shifted = new RealDate(nowMs);
  shifted.setHours(shifted.getHours() - 3);        // DAY_BOUNDARY_HOUR
  return shifted.toLocaleDateString('en-CA');
}

// The correct logical-day window ending at `now`, oldest last.
function logicalWindow(n, nowMs) {
  const anchor = logicalDayStart(logicalDayOf(nowMs));
  anchor.setHours(12, 0, 0, 0);
  const out = [];
  for (let i = 0; i < n; i++) {
    const d = new RealDate(anchor);
    d.setDate(d.getDate() - i);
    out.push(toLogicalDateStr(d));
  }
  return out;
}

// =============================================================================
//  Fixture: an import-only user with an unbroken run of tier-clearing days.
//  Import-only (no manual entries) is deliberate: it is the case the first plan
//  review caught, and it keeps the fixture independent of manual precedence.
// =============================================================================

const RUN_DAYS = 10;
const PER_DAY  = 6000;

function rowOn(dateString, stepsCount) {
  return { id: `healthkit:${dateString}`, source: 'healthkit', date: dateString,
           steps: stepsCount, updatedAt: '2026-01-01T12:00:00.000Z' };
}

function fixtureFor(nowMs) {
  return logicalWindow(RUN_DAYS, nowMs).map(d => rowOn(d, PER_DAY));
}

function resetStore() {
  localStorage.removeItem('glim-steps');
  steps().reload();
}

console.log(`\n=== Criterion 5: the day walk anchors on the LOGICAL day (TZ=${process.env.TZ ?? 'unset'}) ===`);
if (process.env.TZ !== 'America/New_York') {
  console.warn('  WARNING: not running under TZ=America/New_York; the DST instants prove nothing.');
}
console.log(`  fixture: ${RUN_DAYS} consecutive imported days of ${PER_DAY} steps ` +
            `(tier 1 = ${TIERS[0]})\n`);

// =============================================================================
//  The instants. 23:59 and 03:30 straddle the boundary and must behave the same
//  as each other; 00:30 and 01:30 are inside the window where the anchors differ.
// =============================================================================

const CASES = [
  { label: '23:59, before midnight',        ms: localInstant(2026, 6, 14, 23, 59), inWindow: false },
  { label: '00:30, after midnight',         ms: localInstant(2026, 6, 15,  0, 30), inWindow: true  },
  { label: '01:30, mid-window',             ms: localInstant(2026, 6, 15,  1, 30), inWindow: true  },
  { label: '03:30, after the day boundary', ms: localInstant(2026, 6, 15,  3, 30), inWindow: false },
  { label: 'DST spring forward, 01:30',     ms: localInstant(2026, 3,  8,  1, 30), inWindow: true  },
  { label: 'DST fall back, 01:30',          ms: localInstant(2026, 11, 1,  1, 30), inWindow: true  },
];

for (const c of CASES) {
  withClock(c.ms, () => {
    resetStore();
    const rows = fixtureFor(c.ms);
    const expectedDay = logicalDayOf(c.ms);

    // Sanity: the fixture really is keyed to the logical day, and todayStr agrees.
    check(`${c.label}: todayStr() is the logical day (${expectedDay})`, todayStr() === expectedDay);
    check(`${c.label}: the fixture covers today`, rows.some(r => r.date === expectedDay));

    const streak = steps().getStreak(rows);
    const avg    = steps().getWeeklyAvg(rows);

    check(`${c.label}: streak counts the run (${RUN_DAYS}), got ${streak}`, streak === RUN_DAYS);
    check(`${c.label}: weekly average is ${PER_DAY}, got ${avg}`, avg === PER_DAY);
  });
  console.log('');
}

// =============================================================================
//  The exported seam. logicalDaysBack(n, now = new Date()) is exported so the
//  walk's first day can be asserted directly rather than inferred from a streak.
// =============================================================================

console.log('=== The day-walk seam ===');
for (const c of CASES) {
  const first = storeMod.logicalDaysBack(7, new RealDate(c.ms))[0];
  check(`${c.label}: logicalDaysBack(n, now) starts at the logical day (${logicalDayOf(c.ms)}), got ${first}`,
    first === logicalDayOf(c.ms));
}
{
  const c = CASES[2];
  const window7 = storeMod.logicalDaysBack(7, new RealDate(c.ms));
  check('the 7-day window is the logical-day window',
    JSON.stringify(window7) === JSON.stringify(logicalWindow(7, c.ms)));
}

// THE PRODUCTION PATH. Every check above passes `now` explicitly; nothing in the
// app ever does. A regression that fixes the anchor only when `now` is supplied
// would satisfy all of them and still ship the bug, which is precisely the
// mutant a code review used to defeat this file. These call logicalDaysBack with
// NO argument, under the stubbed clock, so the default parameter is what is
// under test.
console.log('\n=== The day-walk seam: DEFAULT argument (the production path) ===');
for (const c of CASES) {
  withClock(c.ms, () => {
    const first = storeMod.logicalDaysBack(7)[0];
    check(`${c.label}: logicalDaysBack(n) with no \`now\` starts at the logical day ` +
          `(${logicalDayOf(c.ms)}), got ${first}`,
      first === logicalDayOf(c.ms));
  });
}

// =============================================================================
//  The clock store. The whole memo strategy in StepsPanel rests on tick()
//  notifying subscribers when, and only when, the logical day changes.
// =============================================================================

console.log('\n=== useClockStore.tick ===');
{
  const { useClockStore } = await import('../src/stores/useClockStore.js');

  // Inside one logical day: repeated ticks must not notify, or every subscriber
  // re-renders once a minute for nothing.
  withClock(localInstant(2026, 6, 15, 12, 0), () => {
    useClockStore.getState().tick();
    let notifications = 0;
    const off = useClockStore.subscribe(() => { notifications++; });
    useClockStore.getState().tick();
    useClockStore.getState().tick();
    useClockStore.getState().tick();
    off();
    check(`three ticks inside one logical day notify nobody (got ${notifications})`,
      notifications === 0);
    check('logicalDay is the logical day',
      useClockStore.getState().logicalDay === logicalDayOf(localInstant(2026, 6, 15, 12, 0)));
  });

  // Across the boundary: exactly one notification, and the new value.
  let notifications = 0;
  const off = useClockStore.subscribe(() => { notifications++; });
  withClock(localInstant(2026, 6, 16, 3, 30), () => {
    useClockStore.getState().tick();
    useClockStore.getState().tick();     // second tick, same new day: still one notification
  });
  off();
  check(`crossing the day boundary notifies exactly once (got ${notifications})`,
    notifications === 1);
  check('logicalDay advanced to the new logical day',
    useClockStore.getState().logicalDay === logicalDayOf(localInstant(2026, 6, 16, 3, 30)));
}

// =============================================================================

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
