// -----------------------------------------------------------------------------
// Title:       fold.js
// Project:     Glim
// Author:      Reina Hastings (reinahastings13@gmail.com)
// Created:     2026-09-17
// Last Modified: 2026-09-17
// Purpose:     Pure date/bucket arithmetic for the health step import (Phase 2,
//              handoff spec R7/R7a/R8/R8a). Health platforms hand back HOURLY
//              step buckets anchored at calendar midnight; Glim's day rolls at
//              3 AM. This module turns those buckets into Glim logical days and
//              decides which days the import is allowed to touch.
//
//              No plugin, store, or browser API is imported here, so the whole
//              correctness-critical surface of the import is testable in bare
//              Node.
// Inputs:      A Date ("now"), and arrays of { start: Date, steps: number }
//              buckets as produced by the health adapter (R2).
// Outputs:     expectedLogicalDates() -> array of YYYY-MM-DD strings
//              foldHourlyBuckets()    -> array of { date, steps } (integers)
//
// Usage example:
//   import { expectedLogicalDates, foldHourlyBuckets } from './health/fold';
//   const dates = expectedLogicalDates(new Date(), 8);
//   const days  = foldHourlyBuckets(buckets, dates);
// -----------------------------------------------------------------------------

import { toLogicalDateStr, logicalDayStart } from '../utils/dateUtils';

// --- Expected window ---------------------------------------------------------

/**
 * The logical dates an import is allowed to write, oldest first, ending at the
 * logical date of `now`. Default 8 = today plus the previous seven days.
 *
 * ANCHORED AT NOON, deliberately (spec R7, review finding C1). The obvious form
 * - `const d = new Date(now); d.setDate(d.getDate() - i)` - carries `now`'s time
 * of day into the arithmetic. On a spring-forward day the constructed local time
 * can land in the hour the clock skips, which JS normalizes FORWARD by an hour,
 * shifting that entry's logical date by a whole day: the list then holds one
 * date twice and omits its neighbour entirely, and the fold below silently drops
 * every bucket belonging to the missing day. Noon exists on every day in every
 * zone, so anchoring there cannot land in a skipped hour.
 */
export function expectedLogicalDates(now = new Date(), n = 8) {
  const anchor = logicalDayStart(toLogicalDateStr(now)); // 03:00 local, today's logical date
  anchor.setHours(12, 0, 0, 0);                          // same calendar date, safely mid-day

  const dates = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(anchor);
    d.setDate(d.getDate() - i);
    dates.push(toLogicalDateStr(d));
  }
  return dates;
}

// --- Folding -----------------------------------------------------------------

/**
 * Sums hourly buckets into Glim logical days.
 *
 * Each bucket is attributed by its OWN start time, so a 23- or 25-hour DST day
 * folds correctly without special-casing: the bucket that starts at 02:00 local
 * belongs to the previous logical day, whatever the day's length.
 *
 * CLAMPED to `expectedDates` (spec R8, review finding on the leading partial
 * day). The query window starts at 03:00 but the platform anchors its buckets at
 * calendar midnight, so it can return 00:00-02:59 buckets belonging to a NINTH,
 * older logical day. Those buckets hold at most a fragment of that day, and
 * writing their sum would overwrite a complete stored total with a smaller one.
 *
 * A date with no buckets produces NO entry (spec R8a). It must not appear with
 * `steps: 0`: the panel distinguishes "health has nothing for this day" from
 * "health says zero", and a zero row would also overwrite nothing with nothing
 * on every import.
 *
 * @param {Array<{ start: Date, steps: number }>} buckets
 * @param {string[]} expectedDates  from expectedLogicalDates()
 * @returns {Array<{ date: string, steps: number }>} oldest first, integers
 */
export function foldHourlyBuckets(buckets, expectedDates) {
  const allowed = new Set(expectedDates ?? []);
  const totals  = new Map();

  for (const bucket of buckets ?? []) {
    if (!bucket || !(bucket.start instanceof Date) || Number.isNaN(bucket.start.getTime())) {
      console.warn('[glim health] fold: bucket with no usable start, skipped:', bucket);
      continue;
    }
    // Non-finite or negative step values are data the platform should never
    // produce; drop them loudly rather than poison a day's total.
    if (!Number.isFinite(bucket.steps) || bucket.steps < 0) {
      console.warn('[glim health] fold: bucket with unusable steps, skipped:', bucket);
      continue;
    }

    const date = toLogicalDateStr(bucket.start);
    if (!allowed.has(date)) continue;   // the clamp

    totals.set(date, (totals.get(date) ?? 0) + bucket.steps);
  }

  return [...totals.entries()]
    .map(([date, steps]) => ({ date, steps: Math.round(steps) }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}
