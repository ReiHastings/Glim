// title: water_fill.test.mjs
// project: Glim
// author: Reina Hastings
// contact: reinahastings13@gmail.com
// created: 2026-09-18
//
// purpose:
//   Unit test for waterFillFraction (src/utils/waterFill.js), the single
//   fraction used by BOTH the water panel's progress ring and its background
//   fill. Pure arithmetic, so it runs in bare Node with no browser.
//
//   The cases that matter are the degenerate ones, not the arithmetic. The
//   function exists because the ring's previous inline expression,
//   Math.min((current / Math.max(goal, 1)) * RING_CIRC, RING_CIRC), returns
//   NaN when goal is undefined (Math.max(undefined, 1) is NaN), and that state
//   is reachable: loadWater() returns JSON.parse(raw) verbatim with no default
//   merge, so a record missing `goal` produces it. With the fill drawing the
//   same number, a disagreement would be visible on screen.
//
//   The cap is the feature under test as much as the fraction: over-goal must
//   read as full, never as more than full, or the fill would overflow its
//   container.
//
// inputs:  src/utils/waterFill.js
// outputs: one line per check, then a pass/fail tally; exit 1 on any failure
//
// usage:
//   cd client && node --import ./tests/register-hooks.mjs tests/water_fill.test.mjs

import { waterFillFraction } from '../src/utils/waterFill.js';

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.error(`  FAIL ${name}`); }
}
function eq(name, actual, expected) {
  check(`${name} (got ${actual}, want ${expected})`, Object.is(actual, expected));
}

// --- The ordinary range ---
eq('0 of 6 is empty',        waterFillFraction(0, 6), 0);
eq('3 of 6 is half',         waterFillFraction(3, 6), 0.5);
eq('6 of 6 is full',         waterFillFraction(6, 6), 1);
eq('1 of 4 is a quarter',    waterFillFraction(1, 4), 0.25);
eq('2 of 4 is half',         waterFillFraction(2, 4), 0.5);

// --- The cap ---
// Over-goal must read as full. Without the cap the fill element would be taller
// than its container and would either overflow or be clipped, and the ring's
// dash array would exceed its circumference.
eq('7 of 6 caps at full',    waterFillFraction(7, 6), 1);
eq('600 of 6 caps at full',  waterFillFraction(600, 6), 1);

// --- Degenerate goals ---
// A goal of zero has no completion fraction. Returning 1 ("nothing required,
// so everything is done") would show a full panel to someone who has logged
// nothing, which is the more misleading of the two readings.
eq('goal of 0 is empty',          waterFillFraction(3, 0), 0);
eq('negative goal is empty',      waterFillFraction(3, -6), 0);
eq('undefined goal is empty',     waterFillFraction(3, undefined), 0);
eq('null goal is empty',          waterFillFraction(3, null), 0);
eq('NaN goal is empty',           waterFillFraction(3, NaN), 0);
eq('Infinite goal is empty',      waterFillFraction(3, Infinity), 0);
eq('string goal is empty',        waterFillFraction(3, '6'), 0);

// --- Degenerate current ---
eq('undefined current is empty',  waterFillFraction(undefined, 6), 0);
eq('NaN current is empty',        waterFillFraction(NaN, 6), 0);
eq('negative current clamps to 0', waterFillFraction(-4, 6), 0);

// --- The properties the UI depends on ---
// Every output is a real number in [0, 1]. A NaN reaching the DOM is the
// specific failure this module was written to prevent: it does not throw, it
// renders as "NaN%" or "NaN NaN" and the control silently disappears.
const inputs = [0, 1, 3, 6, 7, -1, 0.5, 1e9, NaN, Infinity, undefined, null, '4'];
let allFinite = true, allInRange = true;
for (const c of inputs) {
  for (const g of inputs) {
    const f = waterFillFraction(c, g);
    if (!Number.isFinite(f)) allFinite = false;
    if (!(f >= 0 && f <= 1)) allInRange = false;
  }
}
check(`every result over ${inputs.length}x${inputs.length} inputs is finite`, allFinite);
check('every result is within [0, 1]', allInRange);

// Monotone in current: more water never shows less fill. This is what the
// visual harness asserts across its fill-level views, checked here cheaply.
let monotone = true;
for (let c = 0; c < 12; c++) {
  if (waterFillFraction(c + 1, 6) < waterFillFraction(c, 6)) monotone = false;
}
check('fraction is monotone non-decreasing in current', monotone);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
