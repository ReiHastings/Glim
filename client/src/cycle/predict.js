// -----------------------------------------------------------------------------
// Title:       predict.js
// Project:     Glim - cycle tracking Phase 1
// Author:      Reina Hastings (reihastings@gmail.com)
// Created:     2026-09-18
// Purpose:     Stage 1 next-period prediction from derived cycles. PURE: no
//              store, no React, no clock. `today` is always a parameter.
//
//              Returns a WINDOW, never a bare date, and never suppresses it.
//              Measurement showed that hiding wide windows makes the windows
//              that remain visible systematically over-confident, because the
//              ones hidden are the honest ones. What the panel DRAWS is a
//              separate question, carried by the `display` field.
//
//              This file is imported directly by
//              docs/cycle_tracking_feature/interval_calibration.mjs, so the
//              calibrated estimator and the shipped estimator are the same code
//              rather than two implementations that can drift apart.
//
// Inputs:      cycles - output of segmentCycles(), ascending
//              today  - logical date string
// Outputs:     predict(cycles, today) -> see the returned shape below
// Usage:       import { predict } from './predict';
//              const p = predict(segmentCycles(rows, todayStr()), todayStr());
// -----------------------------------------------------------------------------

import { addDaysStr, daysBetweenStr } from '../utils/dateUtils';
import {
  POP_MEAN_CYCLE, POP_SPREAD, LUTEAL_DAYS, FERTILE_SPAN,
  REFRACTORY_DAYS, MAX_CYCLE, WINDOW_CYCLES,
  Q_LO, Q_HI, VARIABLE_WIDTH, DISCARD_RATE, WIDE_WIDTH,
} from './constants';

// --- Statistics ---

export function median(a) {
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Linear interpolation between order statistics (R's type 7). Distribution-free:
// no assumption that cycle lengths are normal, which they are not - the real
// distribution is right-skewed.
export function quantile(a, p) {
  const s = [...a].sort((x, y) => x - y);
  if (s.length === 1) return s[0];
  const h = (s.length - 1) * p;
  const lo = Math.floor(h);
  return s[lo] + (h - lo) * (s[Math.min(lo + 1, s.length - 1)] - s[lo]);
}

// Student t, two-sided 90% (t_{n-1, 0.95}). Small table; above it, z.
const T_TABLE = {
  1: 6.314, 2: 2.920, 3: 2.353, 4: 2.132, 5: 2.015, 6: 1.943, 7: 1.895,
  8: 1.860, 9: 1.833, 10: 1.812, 11: 1.796, 12: 1.782, 13: 1.771, 14: 1.761,
  15: 1.753, 16: 1.746, 17: 1.740, 18: 1.734, 19: 1.729, 20: 1.725,
};
const Z90 = 1.645;

export function tMultiplier(n) {
  const df = Math.max(1, n - 1);
  return T_TABLE[df] ?? Z90;
}

// The widening factor.
//
// An empirical quantile of past cycle lengths describes what ALREADY happened.
// A prediction interval for the NEXT cycle must also carry the uncertainty in
// the estimate itself, so it is strictly wider. Two parts:
//
//   t(n-1, 0.95) / 1.645   the small-sample multiplier. At n = 5 this is worth
//                          42%; an earlier draft used sqrt(1 + 1/n), worth 9.5%,
//                          and measured 0.50 coverage at n = 2 as a result.
//   sqrt(1 + PI/(2n))      the median's analogue of the textbook sqrt(1 + 1/n)
//                          for a mean: a median's sampling variance is about
//                          1.5708 * sigma^2 / n, not sigma^2 / n.
//
// HONEST LABEL: this is a calibrated construction, not a derived one. The two
// parts are principled individually, but applying a t-ratio to the distance
// between a sample median and a sample quantile is not a standard result. It is
// kept because interval_calibration.mjs measures what it actually achieves;
// if the measurement moves, change the factor, not the measurement.
export function wideningFactor(n) {
  return (tMultiplier(n) / Z90) * Math.sqrt(1 + Math.PI / (2 * n));
}

/**
 * Splits complete cycles into the lengths that feed the estimate and the count
 * excluded for being implausible.
 *
 * The recency cap is applied AFTER counting discards, and deliberately does not
 * add to `discardedCount`. Counting it would mean a diligent user with 30 clean
 * cycles reports 18 "discarded", trips DISCARD_RATE, and is labelled 'variable'
 * forever for the crime of logging consistently.
 */
export function usableLengths(cycles) {
  const complete = cycles.filter(c => c.isComplete && typeof c.cycleLength === 'number');
  const kept = complete.filter(c =>
    c.cycleLength > REFRACTORY_DAYS && c.cycleLength <= MAX_CYCLE
    && !c.flags.includes('possible-skip') && !c.flags.includes('possible-split'));
  return {
    usable: kept.slice(-WINDOW_CYCLES).map(c => c.cycleLength),
    discardedCount: complete.length - kept.length,
  };
}

const EMPTY = {
  basis: 'population', quality: 'population', display: 'none',
  usableCount: 0, discardedCount: 0, recentLengths: [],
  estLength: POP_MEAN_CYCLE, nextStart: null, nextWindow: null, windowWidth: null,
  overdueBy: 0, ovulation: null, fertileWindow: null, cycleDay: null,
};

/**
 * Predicts the next period start as a window.
 *
 * @param {Array} cycles output of segmentCycles(), ascending
 * @param {string} today logical date string
 */
export function predict(cycles, today) {
  if (!Array.isArray(cycles) || cycles.length === 0) return { ...EMPTY };

  const lastStart = cycles[cycles.length - 1].startDate;
  const { usable, discardedCount } = usableLengths(cycles);
  const n = usable.length;

  let basis, estLength, lo, hi;
  if (n < 2) {
    basis = 'population';
    estLength = POP_MEAN_CYCLE;
    lo = estLength - POP_SPREAD;
    hi = estLength + POP_SPREAD;
  } else {
    basis = 'personal';
    estLength = Math.round(median(usable));
    const k = wideningFactor(n);
    let qlo = quantile(usable, Q_LO);
    let qhi = quantile(usable, Q_HI);
    lo = Math.floor(estLength - (estLength - qlo) * k);
    hi = Math.ceil(estLength + (qhi - estLength) * k);
    // Never a zero-width window: identical past lengths are not certainty.
    if (estLength - lo < 1) lo = estLength - 1;
    if (hi - estLength < 1) hi = estLength + 1;
  }

  const nextStart = addDaysStr(lastStart, estLength);
  const nextWindow = [addDaysStr(lastStart, lo), addDaysStr(lastStart, hi)];
  const windowWidth = hi - lo;

  const discardShare = (n + discardedCount) > 0
    ? discardedCount / (n + discardedCount) : 0;
  const quality =
    basis === 'population' ? 'population'
    : n < 5 ? 'few-cycles'
    : (windowWidth > VARIABLE_WIDTH || discardShare > DISCARD_RATE) ? 'variable'
    : 'steady';

  const overdueBy = today > nextStart ? daysBetweenStr(nextStart, today) : 0;

  // The in-progress-cycle assumption has failed: a gap this long is not a cycle
  // Glim would accept as one, so it stops claiming to predict from it.
  const stale = overdueBy > MAX_CYCLE;
  const display = stale ? 'none' : (windowWidth > WIDE_WIDTH ? 'range' : 'window');

  // Computed, never rendered in Phase 1. Both inherit the whole uncertainty of
  // nextStart, so anything that displays them later must widen them to match.
  const ovulation = addDaysStr(nextStart, -LUTEAL_DAYS);
  const fertileWindow = [addDaysStr(ovulation, -(FERTILE_SPAN - 1)), ovulation];

  return {
    basis, quality, display,
    usableCount: n, discardedCount, recentLengths: [...usable].sort((a, b) => a - b),
    estLength, nextStart, nextWindow, windowWidth, overdueBy,
    ovulation, fertileWindow,
    cycleDay: daysBetweenStr(lastStart, today) + 1,
  };
}
