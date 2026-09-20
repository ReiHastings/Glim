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
//   Sections 2 and 3 cover the flowing surface's two derived quantities. They
//   are unit-tested rather than screenshot-tested for a specific reason: the
//   visual harness injects `animation-delay: 0s` and pauses every animation
//   before React mounts, so a screenshot shows one frozen frame and can say
//   nothing about a loop being seamless or a bubble count being right.
//
// inputs:  src/utils/waterFill.js
// outputs: one line per check, then a pass/fail tally; exit 1 on any failure
//
// usage:
//   cd client && node --import ./tests/register-hooks.mjs tests/water_fill.test.mjs

import { waterFillFraction, bubbleCount, MAX_BUBBLES,
         waveSamples, wavePath, WAVE_UNITS } from '../src/utils/waterFill.js';

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

// =============================================================================
//  2. bubbleCount
// =============================================================================

eq('no water means no bubbles',        bubbleCount(0), 0);
eq('a trace of water earns one',       bubbleCount(0.01), 1);
eq('20% is still one',                 bubbleCount(0.2), 1);
eq('just over 20% is two',             bubbleCount(0.2001), 2);
eq('40% is two',                       bubbleCount(0.4), 2);
eq('half is three',                    bubbleCount(0.5), 3);
eq('80% is four',                      bubbleCount(0.8), 4);
eq('full is five',                     bubbleCount(1), MAX_BUBBLES);
eq('over full is still five',          bubbleCount(1.4), MAX_BUBBLES);
eq('negative is none',                 bubbleCount(-0.5), 0);
eq('NaN is none',                      bubbleCount(NaN), 0);
eq('undefined is none',                bubbleCount(undefined), 0);

// The hard zero is the one that matters. A transparent bubble still paints a
// compositing layer and still appears in a baseline screenshot, so "no water,
// no bubbles" has to mean no elements, not invisible ones.
check('zero is reached only at zero, never by rounding',
  bubbleCount(0) === 0 && bubbleCount(Number.MIN_VALUE) === 1);
check('every count over a 0..1 sweep is an integer within [0, MAX_BUBBLES]',
  Array.from({ length: 101 }, (_, i) => bubbleCount(i / 100))
    .every(n => Number.isInteger(n) && n >= 0 && n <= MAX_BUBBLES));
check('count never decreases as the level rises',
  Array.from({ length: 101 }, (_, i) => bubbleCount(i / 100))
    .every((n, i, a) => i === 0 || n >= a[i - 1]));

// =============================================================================
//  3. Wave geometry
// =============================================================================

const { wavelength, span, mean, height } = WAVE_UNITS;
const AMP = 20;
// Explicit phase 0: waveSamples is (amp, phase, step), and passing step
// positionally as the second argument silently reads as a phase.
const samples = waveSamples(AMP, 0, 1);
const yAt = (x) => samples.find(([sx]) => sx === x)?.[1];

// Seamlessness. The animation translates by exactly one wavelength, so the
// curve arriving must equal the curve that left. A loop that jumps is the most
// visible defect this feature can have, and no screenshot can detect it.
let seamless = true;
for (let x = 0; x <= wavelength; x += 1) {
  if (Math.abs(yAt(x) - yAt(x + wavelength)) > 1e-9) seamless = false;
}
check('the curve repeats exactly one wavelength later', seamless);
check('the start and end of the span agree',
  Math.abs(yAt(0) - yAt(span)) < 1e-9);

// The mean line IS the true water level, which is what keeps the fill honest.
const over = samples.filter(([x]) => x < wavelength);
const avg = over.reduce((t, [, y]) => t + y, 0) / over.length;
check(`the curve's mean over one wavelength is the midline ` +
      `(${avg.toFixed(6)} vs ${mean})`, Math.abs(avg - mean) < 1e-6);

const ys = samples.map(([, y]) => y);
check('peak-to-trough is twice the amplitude',
  Math.abs((Math.max(...ys) - Math.min(...ys)) - 2 * AMP) < 1e-6);
check('the curve never leaves the band',
  Math.min(...ys) >= mean - AMP - 1e-9 && Math.max(...ys) <= mean + AMP + 1e-9);

// A zero amplitude must give a flat line, not a degenerate path: this is the
// shape a reduced-amplitude token would produce.
check('zero amplitude is a flat line at the midline',
  waveSamples(0, 0, 1).every(([, y]) => Math.abs(y - mean) < 1e-9));

// The phase offset must not cost seamlessness or honesty, since the back wave
// relies on it.
const phased = waveSamples(AMP, Math.PI, 1);
const pAt = (x) => phased.find(([sx]) => sx === x)?.[1];
let phasedSeamless = true;
for (let x = 0; x <= wavelength; x += 1) {
  if (Math.abs(pAt(x) - pAt(x + wavelength)) > 1e-9) phasedSeamless = false;
}
check('a phase-offset curve is still seamless', phasedSeamless);
const pOver = phased.filter(([x]) => x < wavelength);
const pAvg = pOver.reduce((t2, [, y]) => t2 + y, 0) / pOver.length;
check(`a phase-offset curve still has the midline as its mean ` +
      `(${pAvg.toFixed(6)})`, Math.abs(pAvg - mean) < 1e-6);
check('half a wavelength of phase inverts the curve',
  Math.abs(pAt(25) - (mean - (yAt(25) - mean))) < 1e-9);

const d = wavePath(AMP);
check('the path starts with a move and closes', d.startsWith('M') && d.endsWith('Z'));
check('the path closes down to the bottom of the band',
  d.includes(`L${span},${height}`) && d.includes('L0,' + height));
check('the path has no NaN in it', !/NaN/.test(d));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
