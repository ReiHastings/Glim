// -----------------------------------------------------------------------------
// Title:       dateUtils.js
// Project:     Glim
// Author:      Reina Hastings (reinahastings13@gmail.com)
// Created:     2026-03-31
// Last Modified: 2026-08-14
// Purpose:     Shared date utility functions for the tracker stores.
//              Centralizes the "what day is it" logic so all stores agree on
//              day boundaries. DAY_BOUNDARY_HOUR controls when the logical day
//              rolls over (0 = midnight, 3 = 3 AM, etc.).
// Inputs:      Date objects or timestamps (ms since epoch)
// Outputs:     YYYY-MM-DD date strings
// -----------------------------------------------------------------------------

/**
 * Returns the logical day boundary offset in hours.
 * The "day" doesn't roll over at midnight - it rolls over at DAY_BOUNDARY_HOUR.
 * When set to 3, 1 AM on March 31 counts as March 30.
 * Set to 0 for standard midnight boundary.
 */
const DAY_BOUNDARY_HOUR = 3;

/**
 * Converts a Date object to a logical-day date string (YYYY-MM-DD).
 * Subtracts DAY_BOUNDARY_HOUR hours before extracting the date.
 */
export function toLogicalDateStr(date) {
  const shifted = new Date(date.getTime());
  shifted.setHours(shifted.getHours() - DAY_BOUNDARY_HOUR);
  return shifted.toLocaleDateString('en-CA');
}

/**
 * Returns today's logical date string.
 */
export function todayStr() {
  return toLogicalDateStr(new Date());
}

/**
 * Converts a timestamp (ms since epoch) to a logical-day date string.
 */
export function dateStr(timestamp) {
  return toLogicalDateStr(new Date(timestamp));
}

/**
 * Returns the Date at which a logical day STARTS, in local time.
 * Logical day "2026-04-24" runs from 2026-04-24 03:00 local (when
 * DAY_BOUNDARY_HOUR is 3) up to 2026-04-25 03:00 local, so the start is
 * midnight of that calendar date plus DAY_BOUNDARY_HOUR - NOT literal midnight.
 * Inverse of toLogicalDateStr: toLogicalDateStr(logicalDayStart(d)) === d.
 * Used by the symptoms store to anchor all-day entries.
 */
export function logicalDayStart(dateString) {
  const [y, m, d] = String(dateString).split('-').map(Number);
  return new Date(y, m - 1, d, DAY_BOUNDARY_HOUR, 0, 0, 0);
}

/**
 * Returns the logical date string `n` days after `dateString` (n may be negative).
 *
 * MUST go through logicalDayStart + setDate rather than millisecond arithmetic.
 * `logicalDayStart(d).getTime() + n * 86400000` lands at 02:00 on a US
 * spring-forward day, and toLogicalDateStr's `setHours(getHours() - 3)` then
 * returns 23:00 of the SAME date, silently losing a day twice a year.
 * setDate goes through the calendar and is DST-safe.
 *
 * Invariant: daysBetweenStr(d, addDaysStr(d, n)) === n, in every timezone.
 */
export function addDaysStr(dateString, n) {
  const d = logicalDayStart(dateString);
  d.setDate(d.getDate() + n);
  return toLogicalDateStr(d);
}

/**
 * Whole logical days from `from` to `to` (positive when `to` is later).
 *
 * Rounds the millisecond difference because a span crossing a DST transition is
 * 23 or 25 hours, not 24; truncating would report 0 days for a real one-day gap.
 */
export function daysBetweenStr(from, to) {
  const a = logicalDayStart(from);
  const b = logicalDayStart(to);
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

/**
 * Today's CALENDAR date (YYYY-MM-DD), ignoring DAY_BOUNDARY_HOUR.
 *
 * Distinct from todayStr(), which applies the 3 AM boundary. Between midnight
 * and DAY_BOUNDARY_HOUR the two differ by one day, and that gap is deliberate:
 * the cycle panel DEFAULTS to the logical date (consistent with every other
 * tracker) but VALIDATES against the calendar date, so a user logging at 01:30
 * who means the new calendar day can advance it and have the write accepted.
 *
 * Built from local date parts rather than toLocaleDateString('en-CA'), which is
 * a known-fragile idiom on reduced-ICU Node builds and in some test runners: a
 * format change there would make every cycle write fail validation.
 */
export function calendarTodayStr(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
