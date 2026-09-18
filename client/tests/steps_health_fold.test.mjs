// title: steps_health_fold.test.mjs
// project: Glim
// author: Reina Hastings
// contact: reinahastings13@gmail.com
//
// purpose:
//   Invariant tests for the pure date arithmetic of the health step import
//   (src/health/fold.js): which logical days an import may write, and how
//   hourly platform buckets fold into Glim's 3 AM day.
//
//   These are the tests that defend the two subtle correctness claims of the
//   import: that the expected-date list survives a DST transition (the noon
//   anchor), and that the fold never invents, loses, or clamps away a day's
//   steps. Both were wrong in earlier drafts of the spec.
//
// inputs:  none (constructs its own Dates)
// outputs: per-check pass/fail lines; exits non-zero if any check fails
//
// usage:
//   cd client && TZ=America/New_York node --import ./tests/register-hooks.mjs \
//     tests/steps_health_fold.test.mjs
//
//   THE TZ IS REQUIRED. toLogicalDateStr resolves through host-local time, so
//   on a UTC host every DST assertion below passes vacuously. The pin must come
//   from the command line: ESM evaluates imported modules before the first
//   statement of this file, so setting process.env.TZ here would be too late.

// --- Tiny assert harness ---
let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.error(`  FAIL ${name}`); }
}

// Guard the guard: a bare `node tests/...` invocation must fail loudly rather
// than report a green suite that tested nothing.
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
check(`test host timezone is pinned to America/New_York (got ${tz})`, tz === 'America/New_York');
if (tz !== 'America/New_York') {
  console.error('\n  run as: TZ=America/New_York node --import ./tests/register-hooks.mjs tests/steps_health_fold.test.mjs\n');
  process.exit(1);
}

const { expectedLogicalDates, foldHourlyBuckets } = await import('../src/health/fold.js');
const { toLogicalDateStr, logicalDayStart } = await import('../src/utils/dateUtils.js');

// US DST 2026: spring forward Sun 8 March (02:00 -> 03:00), fall back Sun 1 Nov.
//
// Glim's day runs 03:00 to 03:00, so the SHORT and LONG logical days are the
// ones that CONTAIN a transition, which are the days before the transition
// dates: logical 7 March runs 03:00 Mar 7 -> 03:00 Mar 8 and loses the skipped
// 02:00 hour (23 real hours); logical 31 October runs to 03:00 Nov 1 and gains
// the repeated 01:00 hour (25 real hours).
const SHORT_DAY = '2026-03-07';   // 23 hours
const LONG_DAY  = '2026-10-31';   // 25 hours

// Local Date constructor, explicit about what it means.
const at = (y, m, d, hh = 12, mm = 0) => new Date(y, m - 1, d, hh, mm, 0, 0);

// =============================================================================
//  expectedLogicalDates
// =============================================================================

function assertWindow(label, now, n = 8) {
  const dates = expectedLogicalDates(now, n);
  const unique = new Set(dates);
  check(`${label}: returns ${n} dates`, dates.length === n);
  check(`${label}: all distinct`, unique.size === n);
  check(`${label}: ends at the logical date of now`, dates[n - 1] === toLogicalDateStr(now));

  // Strictly consecutive calendar days, checked by date arithmetic rather than
  // by string order (a duplicated or skipped day is exactly the DST bug).
  let consecutive = true;
  for (let i = 1; i < dates.length; i++) {
    const [py, pm, pd] = dates[i - 1].split('-').map(Number);
    const expectedNext = new Date(py, pm - 1, pd + 1, 12, 0, 0, 0);
    if (toLogicalDateStr(expectedNext) !== dates[i]) consecutive = false;
  }
  check(`${label}: strictly consecutive days`, consecutive);
}

console.log('\n--- expectedLogicalDates: ordinary day ---');
assertWindow('midday, no DST nearby', at(2026, 6, 15, 14, 30));
assertWindow('just before the 3 AM boundary', at(2026, 6, 15, 2, 59));
assertWindow('just after the 3 AM boundary', at(2026, 6, 15, 3, 1));

console.log('\n--- expectedLogicalDates: across the spring-forward (the C1 regression) ---');
// The failing band was one hour of clock time on each of the seven days after a
// transition. 02:30 on the transition day itself is the worst case: that local
// time does not exist on 8 March, so naive setDate() arithmetic normalizes it
// forward an hour and collapses two entries onto one date.
for (const [dd, label] of [[8, 'transition day'], [9, 'day after'], [12, 'four days after'], [15, 'a week after']]) {
  for (const [hh, mm] of [[0, 0], [2, 30], [3, 0], [12, 0]]) {
    assertWindow(`${label} ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`, at(2026, 3, dd, hh, mm));
  }
}

console.log('\n--- expectedLogicalDates: across the fall-back ---');
for (const [dd, label] of [[1, 'transition day'], [2, 'day after'], [5, 'four days after']]) {
  for (const [hh, mm] of [[0, 0], [1, 30], [2, 30], [12, 0]]) {
    assertWindow(`${label} ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`, at(2026, 11, dd, hh, mm));
  }
}

// =============================================================================
//  foldHourlyBuckets
// =============================================================================

// One bucket per hour of a logical day, from its 03:00 start up to the next
// day's 03:00 start.
//
// Stepped in REAL TIME (+3_600_000 ms), not by incrementing the hour field:
// on a fall-back day the local hour 01:00 occurs twice and on a spring-forward
// day 02:00 never occurs, so hour-field arithmetic cannot represent the day's
// actual 23 or 25 hours. This mirrors what HealthKit returns, which is one
// bucket per elapsed hour.
const HOUR_MS = 3_600_000;
function hourlyDay(dateString, stepsPerHour) {
  const start = logicalDayStart(dateString);
  const [y, m, d] = dateString.split('-').map(Number);
  const end = logicalDayStart(toLogicalDateStr(new Date(y, m - 1, d + 1, 12, 0, 0, 0)));
  const out = [];
  for (let t = start.getTime(); t < end.getTime(); t += HOUR_MS) {
    out.push({ start: new Date(t), steps: stepsPerHour });
  }
  return out;
}

const sum = (rows) => rows.reduce((t, r) => t + r.steps, 0);

console.log('\n--- foldHourlyBuckets: ordinary day ---');
{
  const dates   = expectedLogicalDates(at(2026, 6, 15), 8);
  const target  = dates[4];
  const buckets = hourlyDay(target, 100);
  const folded  = foldHourlyBuckets(buckets, dates);
  check('24 hourly buckets fold to exactly one date', folded.length === 1);
  check('that date is the logical day they belong to', folded[0]?.date === target);
  check('the total is preserved', folded[0]?.steps === 2400);
}

console.log('\n--- foldHourlyBuckets: the 02:00 bucket belongs to the PREVIOUS logical day ---');
{
  const dates = expectedLogicalDates(at(2026, 6, 15), 8);
  const [y, m, d] = dates[5].split('-').map(Number);
  // 02:30 on the calendar date of dates[5] is still logical day dates[4].
  const folded = foldHourlyBuckets([{ start: new Date(y, m - 1, d, 2, 30, 0, 0), steps: 77 }], dates);
  check('a 02:00-02:59 bucket lands on the previous logical date',
    folded.length === 1 && folded[0].date === dates[4] && folded[0].steps === 77);
}

console.log('\n--- foldHourlyBuckets: DST days keep their full total ---');
{
  const shortBuckets = hourlyDay(SHORT_DAY, 100);
  const longBuckets  = hourlyDay(LONG_DAY, 100);
  check('the spring-forward logical day really is 23 hours', shortBuckets.length === 23);
  check('the fall-back logical day really is 25 hours', longBuckets.length === 25);

  const springDates = expectedLogicalDates(at(2026, 3, 10), 8);
  const spring = foldHourlyBuckets(shortBuckets, springDates);
  check('a 23-hour day folds to exactly one date', spring.length === 1 && spring[0].date === SHORT_DAY);
  check('a 23-hour day loses nothing', spring[0]?.steps === 2300);

  const fallDates = expectedLogicalDates(at(2026, 11, 2), 8);
  const fall = foldHourlyBuckets(longBuckets, fallDates);
  check('a 25-hour day folds to exactly one date', fall.length === 1 && fall[0].date === LONG_DAY);
  check('a 25-hour day loses nothing', fall[0]?.steps === 2500);
}

console.log('\n--- foldHourlyBuckets: the clamp (R8) ---');
{
  const dates = expectedLogicalDates(at(2026, 6, 15), 8);
  const [y, m, d] = dates[0].split('-').map(Number);
  // 00:00-02:59 of the oldest calendar day belongs to a NINTH, older logical
  // day. Writing its partial sum would overwrite a complete stored total.
  const stray = [
    { start: new Date(y, m - 1, d, 0, 30, 0, 0), steps: 500 },
    { start: new Date(y, m - 1, d, 2, 30, 0, 0), steps: 500 },
  ];
  const folded = foldHourlyBuckets([...stray, ...hourlyDay(dates[0], 10)], dates);
  check('buckets before the window are dropped', folded.length === 1 && folded[0].date === dates[0]);
  check('the clamped buckets do not leak into the oldest kept day', folded[0]?.steps === 240);
}

console.log('\n--- foldHourlyBuckets: a day with no buckets produces NO row (R8a) ---');
{
  const dates  = expectedLogicalDates(at(2026, 6, 15), 8);
  const folded = foldHourlyBuckets(hourlyDay(dates[3], 50), dates);
  check('only dates that carry buckets appear', folded.length === 1);
  check('no zero rows are invented for the other seven days',
    !folded.some(r => r.steps === 0));
}

console.log('\n--- foldHourlyBuckets: metamorphic properties ---');
{
  const dates = expectedLogicalDates(at(2026, 6, 15), 8);
  const base  = [...hourlyDay(dates[2], 100), ...hourlyDay(dates[5], 250)];
  const ref   = foldHourlyBuckets(base, dates);

  const shuffled = [...base].reverse();
  check('permuting the buckets does not change the result',
    JSON.stringify(foldHourlyBuckets(shuffled, dates)) === JSON.stringify(ref));

  // Splitting one bucket into two halves inside the same logical day.
  const split = base.flatMap(b => (
    b.steps === 100
      ? [{ start: b.start, steps: 40 }, { start: new Date(b.start.getTime() + 60_000), steps: 60 }]
      : [b]
  ));
  check('splitting a bucket within a day leaves the day total unchanged',
    JSON.stringify(foldHourlyBuckets(split, dates)) === JSON.stringify(ref));

  // Conservation: nothing is invented, and what is dropped is exactly what the
  // clamp was aimed at.
  const [y, m, d] = dates[0].split('-').map(Number);
  const withStray = [...base, { start: new Date(y, m - 1, d, 1, 0, 0, 0), steps: 999 }];
  const out = foldHourlyBuckets(withStray, dates);
  check('folded total + clamped total = input total',
    sum(out) + 999 === withStray.reduce((t, b) => t + b.steps, 0));
}

console.log('\n--- foldHourlyBuckets: junk input ---');
{
  const dates = expectedLogicalDates(at(2026, 6, 15), 8);
  const [y, m, d] = dates[4].split('-').map(Number);
  const good = { start: new Date(y, m - 1, d, 10, 0, 0, 0), steps: 10 };
  const junk = [
    good,
    { start: new Date(y, m - 1, d, 11, 0, 0, 0), steps: NaN },
    { start: new Date(y, m - 1, d, 12, 0, 0, 0), steps: Infinity },
    { start: new Date(y, m - 1, d, 13, 0, 0, 0), steps: -50 },
    { start: new Date('nonsense'), steps: 10 },
    { steps: 10 },
    null,
  ];
  const folded = foldHourlyBuckets(junk, dates);
  check('non-finite, negative and undated buckets are dropped',
    folded.length === 1 && folded[0].steps === 10);
  check('empty input yields no rows', foldHourlyBuckets([], dates).length === 0);
  check('missing input yields no rows', foldHourlyBuckets(undefined, dates).length === 0);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
