// title: cycle_phase.test.mjs
// project: Glim
// author: Reina Hastings
// contact: reinahastings13@gmail.com
//
// purpose:
//   Tests for phase.js, the read-time join between the flow log and the symptom
//   log. Nothing here is stored on any row; that is the point.
//
// usage:
//   cd client && TZ=America/New_York node --import ./tests/register-hooks.mjs tests/cycle_phase.test.mjs

if (process.env.TZ !== 'America/New_York') {
  console.error('FAIL this test must run under TZ=America/New_York');
  process.exit(1);
}
const { cycleDayFor, cycleFor, groupByCycleDay } = await import('../src/cycle/phase.js');
const { segmentCycles } = await import('../src/cycle/segment.js');
const { addDaysStr } = await import('../src/utils/dateUtils.js');

let passed = 0, failed = 0;
const check = (n, c, d) => { if (c) { passed++; console.log(`  ok   ${n}`); }
  else { failed++; console.error(`  FAIL ${n}${d ? '  -> ' + d : ''}`); } };

const B = '2026-03-01', D = n => addDaysStr(B, n);
const rows = spec => spec.map(([n, f]) =>
  ({ id: D(n), date: D(n), flow: f, isPeriodStart: null, updatedAt: '2026-03-01T00:00:00.000Z' }));
const bleed = (s, l) => Array.from({ length: l }, (_, k) => [s + k, 'medium']);
const cycles = segmentCycles(rows([...bleed(0, 4), ...bleed(29, 4), ...bleed(58, 4)]), D(70));

check('day 1 is the first day of the period', cycleDayFor(D(0), cycles) === 1);
check('day 5 of the first cycle', cycleDayFor(D(4), cycles) === 5);
check('the day before the next period is the last day', cycleDayFor(D(28), cycles) === 29);
check('the next period restarts at day 1', cycleDayFor(D(29), cycles) === 1);
check('a date before all cycles is null, not 0', cycleDayFor(addDaysStr(B, -5), cycles) === null);
check('null rather than 0 so "not in a cycle" cannot read as day zero',
  cycleDayFor(addDaysStr(B, -5), cycles) !== 0);
check('cycleFor returns the containing cycle', cycleFor(D(10), cycles).startDate === D(0));
check('no cycles at all yields null', cycleDayFor(D(0), []) === null);
check('a bad date yields null', cycleDayFor(null, cycles) === null);

{
  const entries = [
    { id: 'a', date: D(0) }, { id: 'b', date: D(1) }, { id: 'c', date: D(1) },
    { id: 'd', date: D(40) },
  ];
  const g = groupByCycleDay(entries, cycles[0]);
  check('groups by cycle day', g[1].length === 1 && g[2].length === 2);
  check('and drops records outside the cycle', g[12] === undefined && !Object.values(g).flat().some(r => r.id === 'd'));
  check('an empty cycle groups to {}', Object.keys(groupByCycleDay([], cycles[0])).length === 0);
  check('a null cycle groups to {}', Object.keys(groupByCycleDay(entries, null)).length === 0);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
