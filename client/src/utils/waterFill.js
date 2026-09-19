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
// Inputs:      current - bottles logged today (number)
//              goal    - the daily bottle goal (number)
// Outputs:     a fraction in [0, 1]; over-goal is capped at 1
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
