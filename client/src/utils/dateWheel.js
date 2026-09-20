// -----------------------------------------------------------------------------
// Title:       dateWheel.js
// Project:     Glim
// Author:      Reina Hastings (reihastings@gmail.com)
// Created:     2026-09-19
// Purpose:     Date arithmetic for the wheel picker. PURE, and separate from the
//              component so the awkward parts - month lengths, leap years, and
//              what happens when you scroll the month while the day is 31 - are
//              testable without rendering anything.
//
//              Everything here works on plain {year, month, day} parts and
//              YYYY-MM-DD strings. It deliberately does NOT touch Date objects
//              or the logical-day boundary: a wheel shows a calendar date, and
//              the caller decides what that date means.
// Inputs:      date parts, or a YYYY-MM-DD string
// Outputs:     daysInMonth, partsOf, toDateStr, clampParts, MONTH_LABELS
// Usage:       import { clampParts, toDateStr } from '../utils/dateWheel';
//              const next = clampParts({ year, month, day: 31 }, maxDateStr);
// -----------------------------------------------------------------------------

export const MONTH_LABELS = Object.freeze([
  'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec',
]);

/** Days in a 1-indexed month. Handles leap years, including the century rules. */
export function daysInMonth(year, month) {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** 'YYYY-MM-DD' -> { year, month, day }, all numbers, month 1-indexed. */
export function partsOf(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  return { year: y, month: m, day: d };
}

/** { year, month, day } -> 'YYYY-MM-DD', zero-padded. */
export function toDateStr({ year, month, day }) {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Makes a set of wheel parts into a real, allowed date.
 *
 * Two things go wrong on a wheel and both are handled here rather than in the
 * component:
 *
 * 1. The day outruns the month. Scroll from 31 jan to feb and day 31 does not
 *    exist. The day is clamped DOWN to the month's length, which is what every
 *    native picker does - it is less surprising than refusing to move.
 * 2. The date runs past what the caller allows. Flow cannot be logged into the
 *    future, so the whole date is clamped to `maxDateStr`. Clamping the date
 *    rather than freezing the wheel means the user can always scroll and always
 *    sees where they landed.
 *
 * @param {object} parts   { year, month, day }
 * @param {string} maxDateStr inclusive upper bound, 'YYYY-MM-DD'
 * @param {string} [minDateStr] optional inclusive lower bound
 */
export function clampParts(parts, maxDateStr, minDateStr = null) {
  const year = parts.year;
  const month = Math.min(12, Math.max(1, parts.month));
  const day = Math.min(daysInMonth(year, month), Math.max(1, parts.day));
  let out = toDateStr({ year, month, day });
  if (maxDateStr && out > maxDateStr) out = maxDateStr;
  if (minDateStr && out < minDateStr) out = minDateStr;
  return out;
}

/**
 * The values each wheel column should offer for the currently shown date.
 *
 * Columns are NOT pre-filtered to only-valid combinations. A wheel that hides
 * values as you scroll another column jumps under the finger, which reads as a
 * bug. Every day 1..31 and every month is offered, and clampParts corrects the
 * result on commit.
 */
export function wheelOptions(parts, { minYear, maxYear }) {
  return {
    days: Array.from({ length: 31 }, (_, i) => i + 1),
    months: MONTH_LABELS.map((label, i) => ({ value: i + 1, label })),
    years: Array.from({ length: maxYear - minYear + 1 }, (_, i) => minYear + i),
  };
}
