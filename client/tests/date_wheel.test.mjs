// title: date_wheel.test.mjs
// project: Glim
// author: Reina Hastings
// contact: reinahastings13@gmail.com
//
// purpose:
//   The date arithmetic behind the wheel picker. Extracted from the component
//   so the awkward cases - month lengths, leap years, and scrolling the month
//   while the day is 31 - can be checked without rendering.
//
// usage:
//   cd client && node --import ./tests/register-hooks.mjs tests/date_wheel.test.mjs

const { daysInMonth, partsOf, toDateStr, clampParts, MONTH_LABELS } =
  await import('../src/utils/dateWheel.js');

let passed = 0, failed = 0;
const check = (n, c, d) => { if (c) { passed++; console.log(`  ok   ${n}`); }
  else { failed++; console.error(`  FAIL ${n}${d ? '  -> ' + d : ''}`); } };

console.log('\n-- month lengths --');
check('january has 31', daysInMonth(2026, 1) === 31);
check('april has 30', daysInMonth(2026, 4) === 30);
check('february 2026 has 28', daysInMonth(2026, 2) === 28);
check('february 2024 has 29 (leap)', daysInMonth(2024, 2) === 29);
check('february 1900 has 28 (century, not leap)', daysInMonth(1900, 2) === 28);
check('february 2000 has 29 (400-year rule)', daysInMonth(2000, 2) === 29);
check('twelve month labels', MONTH_LABELS.length === 12);

console.log('\n-- round trip --');
check('partsOf then toDateStr is identity', toDateStr(partsOf('2026-09-19')) === '2026-09-19');
check('zero-pads single digits', toDateStr({ year: 2026, month: 3, day: 7 }) === '2026-03-07');

console.log('\n-- the day outruns the month --');
const MAX = '2030-12-31';
check('31 jan -> feb clamps to 28 in a common year',
  clampParts({ year: 2026, month: 2, day: 31 }, MAX) === '2026-02-28');
check('31 jan -> feb clamps to 29 in a leap year',
  clampParts({ year: 2024, month: 2, day: 31 }, MAX) === '2024-02-29');
check('31 -> april clamps to 30',
  clampParts({ year: 2026, month: 4, day: 31 }, MAX) === '2026-04-30');
check('a valid day is untouched',
  clampParts({ year: 2026, month: 4, day: 12 }, MAX) === '2026-04-12');

console.log('\n-- the future is not loggable --');
const TODAY = '2026-09-19';
check('a future date clamps back to the max',
  clampParts({ year: 2026, month: 12, day: 25 }, TODAY) === TODAY);
check('the max itself is allowed',
  clampParts({ year: 2026, month: 9, day: 19 }, TODAY) === TODAY);
check('yesterday is untouched',
  clampParts({ year: 2026, month: 9, day: 18 }, TODAY) === '2026-09-18');
check('a lower bound is honoured too',
  clampParts({ year: 2020, month: 1, day: 1 }, TODAY, '2024-01-01') === '2024-01-01');

console.log('\n-- degenerate input --');
check('month 0 clamps up to january',
  clampParts({ year: 2026, month: 0, day: 5 }, MAX) === '2026-01-05');
check('month 13 clamps down to december',
  clampParts({ year: 2026, month: 13, day: 5 }, MAX) === '2026-12-05');
check('day 0 clamps up to the 1st',
  clampParts({ year: 2026, month: 5, day: 0 }, MAX) === '2026-05-01');
check('the result always matches YYYY-MM-DD',
  /^\d{4}-\d{2}-\d{2}$/.test(clampParts({ year: 2026, month: 13, day: 99 }, MAX)));

console.log('\n-- exhaustive: every day of a leap year round-trips --');
{
  let bad = null;
  for (let m = 1; m <= 12 && !bad; m++) {
    for (let d = 1; d <= daysInMonth(2024, m); d++) {
      const s = clampParts({ year: 2024, month: m, day: d }, '2030-01-01');
      if (s !== toDateStr({ year: 2024, month: m, day: d })) { bad = s; break; }
    }
  }
  check('all 366 days of 2024 survive clamping unchanged', bad === null, bad);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
