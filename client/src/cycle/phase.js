// -----------------------------------------------------------------------------
// Title:       phase.js
// Project:     Glim - cycle tracking Phase 1
// Author:      Reina Hastings (reihastings@gmail.com)
// Created:     2026-09-18
// Purpose:     Maps a date to its position within the derived cycles. PURE.
//
//              This is the JOIN KEY between the flow log and the symptom log,
//              and it is computed at READ TIME and stored on nothing. A symptom
//              entry knows only its own date; which cycle day that was is an
//              inference over flow rows that changes whenever a period is
//              backfilled. Persisting it on the entry would make every backfill
//              a migration.
// Inputs:      dateStr - logical date string
//              cycles  - output of segmentCycles(), ascending
// Outputs:     cycleDayFor, cycleFor, groupByCycleDay
// Usage:       import { cycleDayFor } from './phase';
//              const day = cycleDayFor(entry.date, cycles);   // 1-indexed, or null
// -----------------------------------------------------------------------------

import { daysBetweenStr } from '../utils/dateUtils';

/** The cycle containing `dateStr`, or null when it precedes all known cycles. */
export function cycleFor(dateStr, cycles) {
  if (!dateStr || !Array.isArray(cycles)) return null;
  for (const c of cycles) {
    if (c.startDate <= dateStr && dateStr <= c.endDate) return c;
  }
  return null;
}

/**
 * The 1-indexed day within the containing cycle, or null.
 *
 * Day 1 is the first day of the period, following the convention every clinical
 * source uses. Returns null rather than 0 for a date outside every cycle, so a
 * caller cannot mistake "not in a cycle" for "day zero".
 */
export function cycleDayFor(dateStr, cycles) {
  const c = cycleFor(dateStr, cycles);
  if (!c) return null;
  return daysBetweenStr(c.startDate, dateStr) + 1;
}

/**
 * Groups dated records into `{ [cycleDay]: records[] }` for one cycle.
 *
 * Used by the panel's "which symptoms fell on which cycle day" view. Takes any
 * record carrying a `date`, so it serves symptom entries and flow rows alike.
 */
export function groupByCycleDay(records, cycle) {
  const out = {};
  if (!cycle) return out;
  for (const r of records ?? []) {
    if (!r?.date || r.date < cycle.startDate || r.date > cycle.endDate) continue;
    const day = daysBetweenStr(cycle.startDate, r.date) + 1;
    (out[day] ??= []).push(r);
  }
  return out;
}
