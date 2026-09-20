// -----------------------------------------------------------------------------
// Title:       waterFill.js
// Project:     Glim
// Author:      Reina Hastings (reinahastings13@gmail.com)
// Created:     2026-09-18
// Purpose:     The single source of truth for "how full is today's water?".
//              Used by BOTH the progress ring and the panel's background fill
//              in WaterPanel.jsx. It is a standalone module rather than a
//              helper inside the component so it can be unit-tested in bare
//              Node, without React or zustand.
//
//              Why one function for two consumers: the ring previously
//              computed its own fraction as
//                Math.min((current / Math.max(goal, 1)) * RING_CIRC, RING_CIRC)
//              which yields NaN when `goal` is undefined, because
//              Math.max(undefined, 1) is NaN. That state is reachable in
//              production: loadWater() returns JSON.parse(raw) verbatim with no
//              default merge, so a stored or synced record missing `goal` gives
//              goal === undefined, and the ring renders
//              strokeDasharray="NaN NaN". With a second visual channel drawing
//              the same number, two different answers four lines apart would be
//              visible on screen at once. Both now read this function.
//
//              It returns a safe 0 rather than throwing. This runs during
//              render, so throwing on a corrupt synced value would blank the
//              panel instead of degrading; the loud failure belongs at the
//              store/sync boundary, not here.
//
//              Also owns the two derived quantities the flowing surface needs:
//              how many bubbles a given fill level gets, and the wave geometry.
//              Both are pure and unit-tested, because neither can be verified
//              from a screenshot: the visual harness freezes CSS animation
//              before mount, so it only ever sees one frame.
//
// Inputs:      current - bottles logged today (number)
//              goal    - the daily bottle goal (number)
// Outputs:     a fraction in [0, 1]; over-goal is capped at 1, plus
//              bubbleCount() and waveSamples()/wavePath()
// -----------------------------------------------------------------------------

/**
 * Fraction of today's water goal that has been met, clamped to [0, 1].
 *
 * Returns 0 for any input that cannot describe a real goal: a non-finite
 * current or goal (undefined, null, NaN, Infinity) or a goal of zero or less.
 * A goal of zero has no meaningful completion fraction, and treating it as
 * "full" would show a full panel to someone who has logged nothing.
 *
 * @param {number} current bottles logged today
 * @param {number} goal    the daily bottle goal
 * @returns {number} fraction in [0, 1]
 */
export function waterFillFraction(current, goal) {
  if (!Number.isFinite(current) || !Number.isFinite(goal)) return 0;
  if (goal <= 0) return 0;
  if (current <= 0) return 0;
  return Math.min(current / goal, 1);
}


// --- Bubbles -------------------------------------------------------------

// The most bubbles a full panel gets. Five was chosen from the mock-ups.
export const MAX_BUBBLES = 5;

/**
 * How many bubbles to render at a given fill fraction.
 *
 * Scales with the level rather than being constant, because at one bottle of
 * six the water is a thin band and a full set crowds it. Roughly one bubble
 * per 20% of fill.
 *
 * ZERO IS A HARD ZERO, not a rounding outcome. With no water there must be no
 * bubbles at all, and no bubble elements in the DOM either: a transparent one
 * still paints a compositing layer and still shows in a screenshot as a faint
 * mark. views.mjs states the same contract for the fill itself ("absent, not
 * a sliver").
 *
 * @param {number} fraction fill fraction, normally from waterFillFraction
 * @returns {number} integer in [0, MAX_BUBBLES]
 */
export function bubbleCount(fraction) {
  if (!Number.isFinite(fraction) || fraction <= 0) return 0;
  // ceil, so any water at all earns at least one bubble and each 20% band adds
  // one; clamped because fraction can be 1 exactly and nothing above.
  return Math.min(MAX_BUBBLES, Math.max(1, Math.ceil(fraction * MAX_BUBBLES)));
}

// --- Wave geometry -------------------------------------------------------

// The wave is drawn in abstract viewBox units and stretched to the panel by
// preserveAspectRatio="none", so ONE WAVELENGTH IS ALWAYS ONE PANEL WIDTH,
// whatever the viewport. That is deliberate: a wavelength expressed in px
// would render as a different shape on a 393px phone and a 1280px desktop,
// and there would be no sensible way to relate the two values.
export const WAVE_UNITS = { wavelength: 100, span: 200, mean: 50, height: 100 };

/**
 * Sample the surface curve. Exported separately from wavePath so the
 * properties below can be tested as numbers rather than parsed out of a string.
 *
 * TWO wavelengths wide. The animation translates by exactly one, so the curve
 * that arrives is identical to the one that left and the loop has no seam. A
 * one-wavelength path would drift off and leave dry panel behind it.
 *
 * A PHASE offset matters more than it looks. The two waves animate at
 * different speeds, so in motion they drift in and out of step on their own.
 * But the visual harness freezes every animation at t=0, where both tracks sit
 * at translateX(0): without a phase baked into the path itself, the two curves
 * would coincide in every screenshot and the parallax layer would be invisible
 * in the baselines meant to protect it.
 *
 * @param {number} amp amplitude in viewBox units
 * @param {number} [phase] phase offset in radians
 * @param {number} [step] sampling interval in viewBox units
 * @returns {Array<[number, number]>} [x, y] pairs
 */
export function waveSamples(amp, phase = 0, step = 2) {
  const { wavelength, span, mean } = WAVE_UNITS;
  const out = [];
  for (let x = 0; x <= span; x += step) {
    out.push([x, mean + Math.sin((x / wavelength) * Math.PI * 2 + phase) * amp]);
  }
  return out;
}

/**
 * The filled surface band: the curve, then down to the bottom of the band.
 *
 * The curve oscillates ABOUT the mean line, which is pinned to the fill
 * element's top edge. That is what keeps the panel honest: the painted water
 * reads at the true level, with the crest above it and the trough below. A
 * curve sitting entirely above the edge would overstate the level by a
 * constant, largest in proportion exactly when there is least water.
 *
 * @param {number} amp amplitude in viewBox units
 * @param {number} [phase] phase offset in radians
 * @returns {string} an SVG path
 */
export function wavePath(amp, phase = 0) {
  const { span, height } = WAVE_UNITS;
  const pts = waveSamples(amp, phase).map(([x, y]) => `${x},${y.toFixed(3)}`);
  return `M${pts.join(' L')} L${span},${height} L0,${height} Z`;
}
