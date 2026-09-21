// title: steps_precedence.test.mjs
// project: Glim
// author: Reina Hastings
// contact: reinahastings13@gmail.com
//
// purpose:
//   Invariant tests for the manual-versus-imported precedence rules of the
//   health step import (Phase 2), driving the REAL useStepsStore and
//   useStepsHealthStore over a localStorage shim.
//
//   Covers: manual always beats imported for the same day (D2); a manual entry
//   OF ZERO is a real statement and must stay distinguishable from "no manual
//   entry"; the clear marker (count: null) hands a day back to the import;
//   imported days count toward streaks and the weekly average for a user who
//   has never typed a number (the bug the first plan review caught); and the
//   health store's row shape, deterministic ids and input validation.
//
// inputs:  none (seeds its own localStorage)
// outputs: per-check pass/fail lines; exits non-zero if any check fails
//
// usage:
//   cd client && TZ=America/New_York node --import ./tests/register-hooks.mjs tests/steps_precedence.test.mjs

// --- Timezone guard. The streak and weekly-average checks below walk logical
//     days through host-local time, so under any other zone they prove less
//     than they claim. Exit rather than warn: a green run must mean something. ---
if (process.env.TZ !== 'America/New_York') {
  console.error('FAIL this test must run under TZ=America/New_York (see tests/README.md)');
  process.exit(1);
}

// --- Minimal localStorage shim (Node has none). Must exist before the stores
//     are imported, so the imports below are dynamic rather than hoisted. ---
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

const {
  useStepsStore, resolveDayCount, manualCountForDate, countForDate, TIERS,
  __resetBadInputReports,
} = await import('../src/stores/useStepsStore.js');
const { useStepsHealthStore, rowsForDate } = await import('../src/stores/useStepsHealthStore.js');
const { todayStr, toLogicalDateStr, logicalDayStart } = await import('../src/utils/dateUtils.js');

const steps  = () => useStepsStore.getState();
const health = () => useStepsHealthStore.getState();

function reset() {
  localStorage.removeItem('glim-steps');
  localStorage.removeItem('glim-steps-health');
  steps().reload();
  health().reload();
}

// A manual entry on a given logical date: midday of that date, so the entry's
// logical date is unambiguous.
function entryOn(dateString, count, offsetMs = 0) {
  const t = logicalDayStart(dateString).getTime() + 9 * 3_600_000 + offsetMs;
  return { id: t, timestamp: t, count };
}

// The logical date `back` days before today, computed the DST-safe way.
//
// ANCHORED ON THE LOGICAL DAY, matching logicalDaysBack (2026-09-18, plan
// section 3.2). The previous form anchored on the CALENDAR date, the same
// off-by-one the implementation had. Because helper and implementation shared
// the bug, the streak assertions below passed at every hour; run between 00:00
// and DAY_BOUNDARY_HOUR against the corrected implementation they failed,
// because the fixture was keyed one day off. Verified: with the old helper and
// the clock stubbed to 01:30, this file failed 2 checks.
function daysAgo(back) {
  const d = logicalDayStart(toLogicalDateStr(new Date()));
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - back);
  return toLogicalDateStr(d);
}

const row = (date, steps, updatedAt, source = 'healthkit') => ({
  id: `${source}:${date}`, source, date, steps, updatedAt,
});

// =============================================================================
//  manualCountForDate
// =============================================================================
console.log('\n--- manualCountForDate ---');
{
  const D = '2026-06-15';
  check('no entries for the date -> null', manualCountForDate([], D) === null);
  check('a typed value -> that value', manualCountForDate([entryOn(D, 5000)], D) === 5000);
  check('a typed ZERO is a real statement, not "nothing said"',
    manualCountForDate([entryOn(D, 0)], D) === 0);
  check('the LATEST entry for the day wins (replace-style)',
    manualCountForDate([entryOn(D, 5000), entryOn(D, 9000, 1000)], D) === 9000);
  check('a clear marker (count: null) reads as "nothing said"',
    manualCountForDate([entryOn(D, 5000), entryOn(D, null, 1000)], D) === null);
  check('typing after a clear marker supersedes it',
    manualCountForDate([entryOn(D, 5000), entryOn(D, null, 1000), entryOn(D, 7000, 2000)], D) === 7000);
  check('entries on other days are ignored',
    manualCountForDate([entryOn('2026-06-14', 5000)], D) === null);
}

// =============================================================================
//  resolveDayCount
// =============================================================================
console.log('\n--- resolveDayCount: precedence (D2) ---');
{
  const D = '2026-06-15';
  const manual = [entryOn(D, 5000)];
  const rows   = [row(D, 9000, '2026-06-15T18:00:00.000Z')];

  check('nothing at all -> 0 from no source',
    JSON.stringify(resolveDayCount([], [], D)) === JSON.stringify({ count: 0, source: null }));
  check('health only -> the imported value, tagged with its source',
    JSON.stringify(resolveDayCount([], rows, D)) === JSON.stringify({ count: 9000, source: 'healthkit' }));
  check('manual only -> the typed value, tagged manual',
    JSON.stringify(resolveDayCount(manual, [], D)) === JSON.stringify({ count: 5000, source: 'manual' }));
  check('E4: manual beats health for the same day',
    JSON.stringify(resolveDayCount(manual, rows, D)) === JSON.stringify({ count: 5000, source: 'manual' }));
  check('a manual ZERO still beats a health row (a deliberate statement)',
    JSON.stringify(resolveDayCount([entryOn(D, 0)], rows, D)) === JSON.stringify({ count: 0, source: 'manual' }));
  check('E16: after a clear marker the day falls back to health',
    JSON.stringify(resolveDayCount([entryOn(D, 5000), entryOn(D, null, 1000)], rows, D))
      === JSON.stringify({ count: 9000, source: 'healthkit' }));
  check('a clear marker with no health row reads as empty',
    JSON.stringify(resolveDayCount([entryOn(D, 5000), entryOn(D, null, 1000)], [], D))
      === JSON.stringify({ count: 0, source: null }));
}

console.log('\n--- resolveDayCount: two sources for one day (E6) ---');
{
  const D = '2026-06-15';
  const older = row(D, 100, '2026-06-15T10:00:00.000Z', 'healthkit');
  const newer = row(D, 8000, '2026-06-15T20:00:00.000Z', 'health_connect');
  check('the later updatedAt wins',
    JSON.stringify(resolveDayCount([], [older, newer], D)) === JSON.stringify({ count: 8000, source: 'health_connect' }));
  check('order of the rows does not matter',
    JSON.stringify(resolveDayCount([], [newer, older], D)) === JSON.stringify({ count: 8000, source: 'health_connect' }));
  check('a row with a missing stamp never beats a stamped one',
    resolveDayCount([], [row(D, 1, undefined), newer], D).count === 8000);
  check('a row with a malformed stamp never beats a stamped one',
    resolveDayCount([], [row(D, 1, 'not-a-date'), newer], D).count === 8000);
}

// =============================================================================
//  Tie-breaks, both directions (plan criterion 3)
//
//  The two arrays resolve ties in OPPOSITE directions, and a day index written
//  for one and copied to the other flips the other silently. A code review
//  demonstrated the gap: flipping the health comparison from `>` to `>=` left
//  the whole suite green. These checks exist to make that mutation fail.
// =============================================================================
console.log('\n--- tie-breaks: equal stamps, both arrays ---');
{
  const D = '2026-06-15';

  // MANUAL: `>=`, so the LAST element in array order wins an equal timestamp.
  const a = entryOn(D, 5000);
  const b = { ...entryOn(D, 7000), timestamp: a.timestamp };   // same millisecond
  check('manual, equal timestamps: the LAST array element wins',
    manualCountForDate([a, b], D) === 7000);
  check('manual, equal timestamps, other order: still the last array element',
    manualCountForDate([b, a], D) === 5000);

  // The case the rule exists for: clearManualForToday can write its marker in
  // the same millisecond as the entry it supersedes, and the clear must win.
  const entry = entryOn(D, 5000);
  const clear = { ...entryOn(D, null), timestamp: entry.timestamp };
  check('a clear marker in the SAME millisecond supersedes the entry',
    manualCountForDate([entry, clear], D) === null);
  check('and an entry written after a same-millisecond clear supersedes it',
    manualCountForDate([clear, entry], D) === 5000);

  // HEALTH: strict `>`, so the FIRST element in array order wins an equal stamp.
  const S = '2026-06-15T12:00:00.000Z';
  const first  = row(D, 3000, S, 'healthkit');
  const second = row(D, 9000, S, 'health_connect');
  check('health, equal updatedAt: the FIRST array element wins',
    resolveDayCount([], [first, second], D).count === 3000);
  check('health, equal updatedAt, other order: still the first array element',
    resolveDayCount([], [second, first], D).count === 9000);
}

// =============================================================================
//  Malformed input (plan criterion 4)
//
//  Two DECLARED behaviour changes of the 2026-09-18 derivation work: a null
//  element in `entries` is skipped rather than throwing a TypeError, and a
//  non-array `entries` degrades to empty with one console.error rather than
//  throwing inside a React render body that has no error boundary above it.
//  Both were unpinned until a code review mutated them and the suite stayed
//  green.
// =============================================================================
console.log('\n--- malformed input ---');
{
  const D = '2026-06-15';

  check('a null element in entries is skipped, not fatal',
    manualCountForDate([null, entryOn(D, 5000)], D) === 5000);
  check('a null element in entries does not hide a later entry',
    manualCountForDate([entryOn(D, 5000), null], D) === 5000);
  check('entries of only a null element resolves to no manual statement',
    manualCountForDate([null], D) === null);
  check('a null element in healthRows is skipped, not fatal',
    resolveDayCount([], [null, row(D, 9000, '2026-06-15T18:00:00.000Z')], D).count === 9000);
  check('a health row with no date is skipped',
    resolveDayCount([], [{ steps: 1, updatedAt: '2026-06-15T18:00:00.000Z' },
                         row(D, 9000, '2026-06-15T18:00:00.000Z')], D).count === 9000);

  // Non-array input: degrades, logs once, does not throw.
  __resetBadInputReports();
  const errors = [];
  const origError = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  let threw = false;
  let result = null;
  try {
    result = resolveDayCount({ not: 'an array' }, [], D);
    resolveDayCount({ not: 'an array' }, [], D);   // second call: must not log again
  } catch { threw = true; } finally { console.error = origError; }

  check('a non-array entries blob does not throw', !threw);
  check('a non-array entries blob resolves to an empty day',
    result !== null && result.count === 0 && result.source === null);
  check('and it is reported exactly once per label, not once per call',
    errors.length === 1 && errors[0].includes('glim-steps entries'));
}

// =============================================================================
//  countForDate back-compatibility
// =============================================================================
console.log('\n--- countForDate ---');
{
  const D = '2026-06-15';
  check('two-argument callers keep manual-only behavior',
    countForDate([entryOn(D, 5000)], D) === 5000);
  check('two-argument call on an empty day is still 0 (not null)',
    countForDate([], D) === 0);
  check('three-argument call is health-inclusive',
    countForDate([], D, [row(D, 9000, '2026-06-15T18:00:00.000Z')]) === 9000);
}

// =============================================================================
//  Streak and weekly average with NO manual entries at all
//  (the first plan review's finding: computeStreak returned 0 for import-only
//  users because it short-circuited on entries.length === 0)
// =============================================================================
console.log('\n--- streak and weekly average for an import-only user ---');
{
  reset();
  const rows = [];
  for (let i = 0; i < 7; i++) rows.push(row(daysAgo(i), 6000, `2026-01-0${i + 1}T12:00:00.000Z`));
  check('the fixture clears tier 1', 6000 >= TIERS[0]);

  check('streak counts imported days with zero manual entries',
    steps().getStreak(rows) === 7);
  check('weekly average counts imported days', steps().getWeeklyAvg(rows) === 6000);
  check('with neither source the streak is 0', steps().getStreak([]) === 0);

  // A manual entry below tier 1 on today must break the streak, because manual wins.
  useStepsStore.setState({ entries: [entryOn(todayStr(), 10)] });
  check('a low manual entry today overrides a high health row and breaks the streak',
    steps().getStreak(rows) === 0);
  reset();
}

// =============================================================================
//  Store actions
// =============================================================================
console.log('\n--- useStepsStore.clearManualForToday ---');
{
  reset();
  steps().logSteps(5000);
  check('a typed value is today\'s count', steps().getTodayCount([]) === 5000);
  check('and its source is manual', steps().getTodaySource([]) === 'manual');

  const rows = [row(todayStr(), 9000, new Date().toISOString())];
  check('health does not override it', steps().getTodayCount(rows) === 5000);

  steps().clearManualForToday();
  check('the clear marker is an ordinary appended entry, nothing deleted',
    steps().entries.length === 2 && steps().entries[1].count === null);
  check('after clearing, today reads from health', steps().getTodayCount(rows) === 9000);
  check('and reports the health source', steps().getTodaySource(rows) === 'healthkit');
  check('with no health row, a cleared day reads as empty', steps().getTodayCount([]) === 0);

  const persisted = JSON.parse(localStorage.getItem('glim-steps'));
  check('the marker is persisted for sync', persisted.entries.length === 2 && persisted.entries[1].count === null);
}

console.log('\n--- useStepsHealthStore.upsertHealthRow ---');
{
  reset();
  const D = '2026-06-15';
  const first = health().upsertHealthRow({ source: 'healthkit', date: D, steps: 8123 });
  check('a valid row is accepted', first.ok === true);
  check('the id is deterministic', first.row.id === `healthkit:${D}`);
  check('updatedAt is an ISO stamp', /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(first.row.updatedAt));
  check('the row is persisted under glim-steps-health',
    JSON.parse(localStorage.getItem('glim-steps-health')).rows.length === 1);

  health().upsertHealthRow({ source: 'healthkit', date: D, steps: 9000 });
  check('re-importing the same day REPLACES the row rather than adding one',
    health().rows.length === 1 && health().rows[0].steps === 9000);

  health().upsertHealthRow({ source: 'healthkit', date: '2026-06-16', steps: 100 });
  check('a different day adds a row', health().rows.length === 2);
  check('rows stay sorted by date', health().rows[0].date < health().rows[1].date);
  check('rowsForDate filters by logical date', rowsForDate(health().rows, D).length === 1);

  check('steps are rounded to integers',
    health().upsertHealthRow({ source: 'healthkit', date: D, steps: 10.6 }).row.steps === 11);

  const before = health().rows.length;
  for (const [label, bad] of [
    ['an unknown source',   { source: 'fitbit',    date: D,           steps: 10 }],
    ['a malformed date',    { source: 'healthkit', date: '15-06-2026', steps: 10 }],
    ['a negative count',    { source: 'healthkit', date: D,           steps: -1 }],
    ['a non-finite count',  { source: 'healthkit', date: D,           steps: NaN }],
    ['a missing count',     { source: 'healthkit', date: D }],
  ]) {
    const res = health().upsertHealthRow(bad);
    check(`${label} is refused`, res.ok === false && typeof res.error === 'string');
  }
  check('no bad row was stored', health().rows.length === before);

  check('reload re-reads localStorage',
    (() => { health().reload(); return health().rows.length === before; })());
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
