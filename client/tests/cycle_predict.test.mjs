// title: cycle_predict.test.mjs
// project: Glim
// author: Reina Hastings
// contact: reinahastings13@gmail.com
//
// purpose:
//   Unit and invariant tests for predict.js. Calibration (coverage, per-side
//   misses, suppression) lives in cycle_calibration.test.mjs; this file pins the
//   contract, the branches and the cases earlier drafts got wrong.
//
// inputs:  none
// outputs: per-check pass/fail; exits non-zero if any check fails
//
// usage:
//   cd client && TZ=America/New_York node --import ./tests/register-hooks.mjs tests/cycle_predict.test.mjs

if (process.env.TZ !== 'America/New_York') {
  console.error('FAIL this test must run under TZ=America/New_York (see tests/README.md)');
  process.exit(1);
}

const { predict, usableLengths, wideningFactor } = await import('../src/cycle/predict.js');
const { addDaysStr, daysBetweenStr } = await import('../src/utils/dateUtils.js');
const C = await import('../src/cycle/constants.js');

let passed = 0, failed = 0;
const check = (name, cond, detail) => {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.error(`  FAIL ${name}${detail ? '  -> ' + detail : ''}`); }
};

const BASE = '2026-03-01', D = n => addDaysStr(BASE, n);
// Build a cycles array from lengths; the last cycle is always the open one.
function cyclesFrom(lengths, flags = []) {
  const out = []; let day = 0;
  lengths.forEach((L, i) => {
    out.push({ startDate: D(day), endDate: D(day + L - 1), cycleLength: L,
               periodLength: 4, isComplete: true, flags: flags[i] ?? [] });
    day += L;
  });
  out.push({ startDate: D(day), endDate: D(day), cycleLength: null,
             periodLength: 4, isComplete: false, flags: [] });
  return { cycles: out, lastStart: D(day) };
}

console.log('\n-- branches --');
{
  check('no cycles: display none, all dates null',
    (() => { const p = predict([], D(0));
      return p.display === 'none' && p.nextStart === null && p.basis === 'population'; })());

  const one = cyclesFrom([]);
  const p1 = predict(one.cycles, one.lastStart);
  check('one open cycle: population basis with a window',
    p1.basis === 'population' && p1.quality === 'population' && p1.nextWindow !== null);
  check('population window is 2 x POP_SPREAD wide',
    p1.windowWidth === 2 * C.POP_SPREAD, String(p1.windowWidth));

  const { cycles, lastStart } = cyclesFrom([28, 30, 29, 31, 29, 30]);
  const p = predict(cycles, lastStart);
  check('six usable cycles: personal basis', p.basis === 'personal');
  check('estLength is the median', p.estLength === 30 || p.estLength === 29, String(p.estLength));
  check('quality is steady for a tight history', p.quality === 'steady', p.quality);
  check('display is a window', p.display === 'window', p.display);
}

console.log('\n-- the regression that started all this --');
{
  const { cycles, lastStart } = cyclesFrom([28, 28, 28, 28, 35, 40]);
  const p = predict(cycles, lastStart);
  check('[28,28,28,28,35,40] does NOT give a 2-day window',
    p.windowWidth > 2, String(p.windowWidth));
  check('and is NOT labelled steady', p.quality !== 'steady', p.quality);
}

console.log('\n-- never zero width --');
{
  const { cycles, lastStart } = cyclesFrom([28, 28, 28, 28]);
  const p = predict(cycles, lastStart);
  check('identical lengths give +/- 1 day, not zero', p.windowWidth === 2, String(p.windowWidth));
  check('and nextStart sits inside the window',
    p.nextWindow[0] <= p.nextStart && p.nextStart <= p.nextWindow[1]);
}

console.log('\n-- discards do not punish a diligent logger (the WINDOW_CYCLES trap) --');
{
  const many = Array.from({ length: 30 }, () => 29);
  const { cycles, lastStart } = cyclesFrom(many);
  const p = predict(cycles, lastStart);
  check('30 clean cycles report 0 discarded, not 18', p.discardedCount === 0, String(p.discardedCount));
  check('and are not labelled variable', p.quality !== 'variable', p.quality);
  check('only the most recent WINDOW_CYCLES feed the estimate',
    p.usableCount === C.WINDOW_CYCLES, String(p.usableCount));
}

console.log('\n-- flagged cycles are excluded and counted --');
{
  const { cycles, lastStart } = cyclesFrom([29, 29, 58, 29, 29],
    [[], [], ['possible-skip'], [], []]);
  const p = predict(cycles, lastStart);
  check('a possible-skip cycle is excluded', p.usableCount === 4, String(p.usableCount));
  check('and counted as discarded', p.discardedCount === 1, String(p.discardedCount));
  const { usable } = usableLengths(cycles);
  check('the 58 never reaches the estimator', !usable.includes(58));
}

console.log('\n-- wide windows switch the DISPLAY, never the model --');
{
  const { cycles, lastStart } = cyclesFrom([18, 41, 22, 38, 26, 35]);
  const p = predict(cycles, lastStart);
  check('a very variable history still returns a window (no suppression)',
    p.nextWindow !== null && p.windowWidth !== null);
  if (p.windowWidth > C.WIDE_WIDTH) check('and switches display to range', p.display === 'range', p.display);
  else check('display stays a window below WIDE_WIDTH', p.display === 'window');
}

console.log('\n-- overdue --');
{
  const { cycles, lastStart } = cyclesFrom([29, 29, 29, 29]);
  const late = predict(cycles, addDaysStr(lastStart, 40));
  check('overdueBy counts days past nextStart', late.overdueBy === 11, String(late.overdueBy));
  check('the window is still returned', late.nextWindow !== null);
  const stale = predict(cycles, addDaysStr(lastStart, 200));
  check('past MAX_CYCLE overdue, display stops claiming a prediction',
    stale.display === 'none', stale.display);
}

console.log('\n-- invariants --');
{
  const { cycles, lastStart } = cyclesFrom([27, 31, 29, 30, 28, 32]);
  const p = predict(cycles, lastStart);
  check('ovulation precedes nextStart', p.ovulation < p.nextStart);
  check('fertile window ends on ovulation', p.fertileWindow[1] === p.ovulation);
  check('fertile window is FERTILE_SPAN days inclusive',
    daysBetweenStr(p.fertileWindow[0], p.fertileWindow[1]) === C.FERTILE_SPAN - 1);
  check('basis population iff quality population',
    (p.basis === 'population') === (p.quality === 'population'));
  check('predict is pure', JSON.stringify(predict(cycles, lastStart)) === JSON.stringify(p));
  const N = 37;
  const shifted = cycles.map(c => ({ ...c, startDate: addDaysStr(c.startDate, N),
                                     endDate: addDaysStr(c.endDate, N) }));
  const ps = predict(shifted, addDaysStr(lastStart, N));
  check('translation invariance', ps.nextStart === addDaysStr(p.nextStart, N)
    && ps.windowWidth === p.windowWidth && ps.quality === p.quality);
}

console.log('\n-- the widening factor --');
{
  check('grows as n shrinks', wideningFactor(2) > wideningFactor(6));
  check('and approaches 1 for large n', wideningFactor(60) < 1.1, String(wideningFactor(60)));
  check('at n=5 it is materially more than sqrt(1+1/n)',
    wideningFactor(5) > 1.3, String(wideningFactor(5)));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
