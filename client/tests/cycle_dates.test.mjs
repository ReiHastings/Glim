// title: cycle_dates.test.mjs
// project: Glim
// author: Reina Hastings
// contact: reinahastings13@gmail.com
//
// purpose:
//   Invariant tests for addDaysStr and daysBetweenStr, the two date helpers the
//   whole cycle feature rests on.
//
//   THE INVARIANT: daysBetweenStr(d, addDaysStr(d, n)) === n, for every date and
//   every n, in every timezone.
//
//   Why this file exists at all: the obvious implementation,
//   logicalDayStart(d).getTime() + n * 86400000, lands at 02:00 on a US
//   spring-forward day, and toLogicalDateStr's setHours(getHours() - 3) then
//   returns 23:00 of the SAME date. One silently lost day per transition, twice
//   a year, in every cycle boundary and every prediction.
//
//   THE TZ PIN IS REQUIRED, not decoration: toLogicalDateStr resolves through
//   host-local time, so on a UTC host every DST assertion passes vacuously. The
//   pin cannot be set inside the file (ESM evaluates imports first), so this
//   test asserts the timezone as its first check and exits non-zero without it.
//
//   Four zones, because the invariant says "every timezone" and one northern
//   one-hour zone does not test that claim:
//     America/New_York    northern, 1-hour DST, 02:00 transition
//     Australia/Lord_Howe southern, 30-MINUTE DST shift
//     America/Santiago    southern, transition near midnight
//     UTC                 control, no DST at all
//
// inputs:  none
// outputs: per-check pass/fail; exits non-zero if any check fails
//
// usage (run ALL FOUR; a single zone does not test the invariant):
//   cd client
//   TZ=America/New_York    node --import ./tests/register-hooks.mjs tests/cycle_dates.test.mjs
//   TZ=Australia/Lord_Howe node --import ./tests/register-hooks.mjs tests/cycle_dates.test.mjs
//   TZ=America/Santiago    node --import ./tests/register-hooks.mjs tests/cycle_dates.test.mjs
//   TZ=UTC                 node --import ./tests/register-hooks.mjs tests/cycle_dates.test.mjs

const ZONES = ['America/New_York', 'Australia/Lord_Howe', 'America/Santiago', 'UTC'];
if (!ZONES.includes(process.env.TZ)) {
  console.error(`FAIL TZ must be one of: ${ZONES.join(', ')} (got ${process.env.TZ ?? 'unset'})`);
  console.error('     See the usage block at the top of this file: run all four.');
  process.exit(1);
}
console.log(`  TZ = ${process.env.TZ}`);

const { addDaysStr, daysBetweenStr, toLogicalDateStr, logicalDayStart, todayStr } =
  await import('../src/utils/dateUtils.js');

let passed = 0, failed = 0;
const check = (name, cond, detail) => {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.error(`  FAIL ${name}${detail ? '  -> ' + detail : ''}`); }
};

// --- The round-trip invariant, exhaustively over a wide range --------------
{
  let worst = null;
  const anchors = ['2026-01-01', '2026-03-08', '2026-03-09', '2026-11-01',
                   '2026-06-15', '2025-12-31', '2027-02-28', '2024-02-29'];
  for (const d of anchors) {
    for (let n = -400; n <= 400; n++) {
      const back = daysBetweenStr(d, addDaysStr(d, n));
      if (back !== n) { worst = `${d} +${n} -> ${back}`; break; }
    }
    if (worst) break;
  }
  check('daysBetweenStr(d, addDaysStr(d, n)) === n for n in [-400, 400] over 8 anchors',
    worst === null, worst);
}

// --- Round-tripping a date string through logicalDayStart ------------------
{
  let bad = null;
  for (let n = 0; n < 800; n++) {
    const d = addDaysStr('2025-06-01', n);
    if (toLogicalDateStr(logicalDayStart(d)) !== d) { bad = d; break; }
  }
  check('toLogicalDateStr(logicalDayStart(d)) === d across 800 consecutive days',
    bad === null, bad);
}

// --- Stepping one day at a time never skips or repeats ---------------------
{
  let d = '2025-11-01';
  const seen = new Set([d]);
  let dupOrSkip = null;
  for (let i = 0; i < 500; i++) {
    const next = addDaysStr(d, 1);
    if (seen.has(next)) { dupOrSkip = `repeat at ${next}`; break; }
    if (daysBetweenStr(d, next) !== 1) { dupOrSkip = `${d} -> ${next} is not 1 day`; break; }
    seen.add(next); d = next;
  }
  check('500 single-day steps produce 500 distinct consecutive days', dupOrSkip === null, dupOrSkip);
}

// --- Additivity and symmetry ----------------------------------------------
{
  const d = '2026-03-01';
  check('addDaysStr is additive', addDaysStr(addDaysStr(d, 17), 23) === addDaysStr(d, 40));
  check('addDaysStr(d, 0) is identity', addDaysStr(d, 0) === d);
  check('daysBetweenStr is antisymmetric',
    daysBetweenStr(d, addDaysStr(d, 29)) === -daysBetweenStr(addDaysStr(d, 29), d));
  check('daysBetweenStr(d, d) === 0', daysBetweenStr(d, d) === 0);
}

// --- Spans that straddle a transition -------------------------------------
// A 29-day cycle must be 29 days whether or not a clock change falls inside it.
{
  const controls = ['2026-05-01', '2026-09-01'];   // no transition in either hemisphere
  const straddles = ['2026-02-20', '2026-03-25', '2026-10-20', '2026-03-28', '2026-04-01'];
  let bad = null;
  for (const start of [...controls, ...straddles]) {
    const end = addDaysStr(start, 29);
    if (daysBetweenStr(start, end) !== 29) { bad = `${start} -> ${end}`; break; }
  }
  check('a 29-day span measures 29 days across every transition window', bad === null, bad);
}

// --- Negative steps behave ------------------------------------------------
{
  const d = '2026-03-15';
  check('going back then forward returns the original',
    addDaysStr(addDaysStr(d, -37), 37) === d);
  check('ovulation-style backward arithmetic is exact',
    daysBetweenStr(addDaysStr(d, -13), d) === 13);
}

// --- todayStr is a well-formed logical date -------------------------------
{
  check('todayStr() matches YYYY-MM-DD', /^\d{4}-\d{2}-\d{2}$/.test(todayStr()));
  check('todayStr() round-trips', addDaysStr(addDaysStr(todayStr(), 5), -5) === todayStr());
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
