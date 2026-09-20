// title: cycle_segment.test.mjs
// project: Glim
// author: Reina Hastings
// contact: reinahastings13@gmail.com
//
// purpose:
//   Fixture tests for cycle segmentation (Phase 1). One fixture per case that a
//   previous draft of the rules got wrong, plus the ordinary cases.
//
//   The headline fixture is `c1`: a single stray `light` day logged mid-cycle
//   must not swallow the real period that follows it. Three drafts of the
//   English rules produced 20- and 38-day cycles there instead of 29 and 29,
//   with no outlier flag raised on either.
//
// inputs:  none
// outputs: per-check pass/fail lines; exits non-zero if any check fails
//
// usage:
//   cd client && TZ=America/New_York node --import ./tests/register-hooks.mjs tests/cycle_segment.test.mjs

if (process.env.TZ !== 'America/New_York') {
  console.error('FAIL this test must run under TZ=America/New_York (see tests/README.md)');
  process.exit(1);
}

const { segmentCycles } = await import('../src/cycle/segment.js');
const { addDaysStr } = await import('../src/utils/dateUtils.js');

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.error(`  FAIL ${name}${detail ? '  -> ' + detail : ''}`); }
}

const BASE = '2026-03-01';
const D = (n) => addDaysStr(BASE, n);
// Build rows from a compact spec: [dayOffset, flow, isPeriodStart?]
const rows = (spec) => spec.map(([n, flow, ips = null]) =>
  ({ id: D(n), date: D(n), flow, isPeriodStart: ips, updatedAt: '2026-03-01T00:00:00.000Z' }));
const bleed = (start, len, flow = 'medium') =>
  Array.from({ length: len }, (_, k) => [start + k, flow]);
const lens = (cycles) => cycles.map(c => c.cycleLength);
const starts = (cycles) => cycles.map(c => c.startDate);

console.log('\n-- ordinary segmentation --');
{
  const cs = segmentCycles(rows([...bleed(0, 4), ...bleed(29, 4), ...bleed(58, 4)]), D(70));
  check('three periods 29 days apart give lengths [29, 29, null]',
    JSON.stringify(lens(cs)) === JSON.stringify([29, 29, null]), JSON.stringify(lens(cs)));
  check('final cycle is incomplete', cs[2].isComplete === false);
  check('period length is the bleeding run', cs[0].periodLength === 4, String(cs[0].periodLength));
}

console.log('\n-- the C1 fixture: a stray mid-cycle bleed must not swallow the real period --');
{
  const spec = [...bleed(0, 4), [20, 'light'], ...bleed(29, 4), ...bleed(58, 4)];
  const cs = segmentCycles(rows(spec), D(70));
  check('starts are [0, 29, 58], not [0, 20, 58]',
    JSON.stringify(starts(cs)) === JSON.stringify([D(0), D(29), D(58)]), JSON.stringify(starts(cs)));
  check('cycle lengths stay [29, 29, null]',
    JSON.stringify(lens(cs)) === JSON.stringify([29, 29, null]), JSON.stringify(lens(cs)));
  const clean = segmentCycles(rows([...bleed(0, 4), ...bleed(29, 4), ...bleed(58, 4)]), D(70));
  check('one stray tap changes nothing versus the clean history',
    JSON.stringify(lens(cs)) === JSON.stringify(lens(clean)));
}

console.log('\n-- the case the refractory window exists for --');
{
  // bleed 0-3, spotting 4-8, bleed 9-10: one period, not two.
  const spec = [...bleed(0, 4), [4, 'spotting'], [5, 'spotting'], [6, 'spotting'],
                [7, 'spotting'], [8, 'spotting'], ...bleed(9, 2), ...bleed(30, 4)];
  const cs = segmentCycles(rows(spec), D(40));
  check('spotting tail then resumed bleeding is ONE period',
    starts(cs).length === 2, JSON.stringify(starts(cs)));
  check('and the cycle is 30 days, not 9 then 21', cs[0].cycleLength === 30, String(cs[0].cycleLength));
}

console.log('\n-- a light start followed by heavier bleeding keeps the EARLIER day 1 --');
{
  // bleed 0-1 (2 days), spotting 2-6, bleed 7-11 (5 days). Day 1 is day 0.
  const spec = [...bleed(0, 2, 'light'), [2, 'spotting'], [3, 'spotting'], [4, 'spotting'],
                [5, 'spotting'], [6, 'spotting'], ...bleed(7, 5, 'heavy')];
  const cs = segmentCycles(rows(spec), D(20));
  check('a multi-day first run keeps the anchor', cs[0].startDate === D(0), cs[0].startDate);
  check('and it is a single period', cs.length === 1, String(cs.length));
}

console.log('\n-- gap rule: 1 quiet day continues, 2 end the period --');
{
  const one = segmentCycles(rows([...bleed(0, 2), ...bleed(3, 2), ...bleed(40, 2)]), D(50));
  check('a single quiet day does not split a period', one.length === 2, String(one.length));
  const two = segmentCycles(rows([...bleed(0, 2), ...bleed(4, 2), ...bleed(40, 2)]), D(50));
  check('two quiet days end it, but the refractory window absorbs the resumption',
    two.length === 2, String(two.length));
}

console.log('\n-- 16 days of continuous bleeding --');
{
  const cs = segmentCycles(rows([...bleed(0, 16), ...bleed(40, 3)]), D(50));
  check('is one period, not two', cs.length === 2, JSON.stringify(starts(cs)));
  check('periodLength is not truncated at MAX_PERIOD_DAYS', cs[0].periodLength > 10,
    String(cs[0].periodLength));
  check('and carries the long-period flag', cs[0].flags.includes('long-period'),
    JSON.stringify(cs[0].flags));
}

console.log('\n-- user overrides --');
{
  const forced = segmentCycles(rows([...bleed(0, 4), [5, 'medium', true], ...bleed(40, 3)]), D(50));
  check('isPeriodStart:true forces a start inside the refractory window',
    starts(forced).includes(D(5)), JSON.stringify(starts(forced)));
  check('the forced cycle carries the forced flag',
    forced.find(c => c.startDate === D(5))?.flags.includes('forced') === true);

  const excluded = segmentCycles(rows([[0, 'medium', false], ...bleed(10, 4)]), D(30));
  check('isPeriodStart:false on the first bleeding day: that day belongs to no period',
    starts(excluded).length === 1 && excluded[0].startDate === D(10),
    JSON.stringify(starts(excluded)));

  const far = segmentCycles(rows([...bleed(0, 4), [40, 'medium', false], ...bleed(60, 3)]), D(70));
  check('an excluded bleed 40 days later is NOT absorbed into the earlier period',
    far[0].periodLength === 4, String(far[0].periodLength));
  check('and it does not create a cycle', starts(far).length === 2, JSON.stringify(starts(far)));
}

console.log('\n-- flags --');
{
  // 29, 29, then a forgotten log producing 58
  const cs = segmentCycles(rows([...bleed(0, 3), ...bleed(29, 3), ...bleed(58, 3), ...bleed(116, 3)]), D(130));
  check('a doubled cycle is flagged possible-skip',
    cs[2].flags.includes('possible-skip'), JSON.stringify(cs[2].flags));
  const short = segmentCycles(rows([...bleed(0, 3), ...bleed(29, 3), ...bleed(58, 3), ...bleed(74, 3)]), D(90));
  check('a 16-day cycle is flagged possible-split',
    short[2].flags.includes('possible-split'), JSON.stringify(short[2].flags));
  check('neither flag applies before two clean prior lengths',
    cs[0].flags.every(f => f !== 'possible-skip' && f !== 'possible-split'));
}

console.log('\n-- a row dated after the logical day (R4a: logging at 01:30) --');
{
  // Between midnight and DAY_BOUNDARY_HOUR the calendar date is todayStr() + 1,
  // and R4a lets the user choose it. That row must still land inside a cycle.
  const spec = [...bleed(0, 2), ...bleed(29, 2)];
  const cs = segmentCycles(rows(spec), D(29), D(30));
  const last = cs[cs.length - 1];
  check('the open cycle extends to cover a row dated past `today`',
    last.endDate >= D(30), last.endDate);
  check('startDate <= endDate still holds', last.startDate <= last.endDate);
  check('periodLength counts both bleeding days', last.periodLength === 2,
    String(last.periodLength));
}

console.log('\n-- degenerate inputs --');
{
  check('no rows', segmentCycles([], D(0)).length === 0);
  check('only quiet rows', segmentCycles(rows([[0, 'none'], [1, 'spotting']]), D(5)).length === 0);
  check('one bleeding day', segmentCycles(rows([[0, 'medium']]), D(5)).length === 1);
  check('malformed rows are ignored',
    segmentCycles([{ date: 'nope', flow: 'medium' }, ...rows([[0, 'medium']])], D(5)).length === 1);
  check('a row dated after the calendar date is dropped',
    segmentCycles(rows([[0, 'medium'], [9, 'medium']]), D(3), D(3)).length === 1);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
