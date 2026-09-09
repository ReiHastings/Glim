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
