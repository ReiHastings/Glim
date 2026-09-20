// -----------------------------------------------------------------------------
// Title:       segment.js
// Project:     Glim - cycle tracking Phase 1
// Author:      Reina Hastings (reihastings@gmail.com)
// Created:     2026-09-18
// Purpose:     Derives menstrual cycles from the flow log. PURE: no store, no
//              React, no localStorage, no clock. Every function that needs
//              "today" or "the calendar date" takes it as an argument, which is
//              what makes the metamorphic tests (translate every date by +N,
//              expect every output to move by +N) meaningful.
//
//              Cycles are DERIVED, never stored. A backfilled period changes
//              the answer, and persisting it would turn every backfill into a
//              migration and every cross-device merge into an unresolvable
//              conflict.
//
//              This file was written BEFORE the spec prose that documents it.
//              Three earlier attempts to specify these rules in English read as
//              complete and were not: each left an input class unclassified or
//              two rules contradicting each other on a case nobody pictured.
//              The property test is the real specification; treat the handoff
//              doc's R8 as documentation of this code, not the reverse.
//
// Inputs:      rows  - live (non-deleted) flow rows: { date, flow, isPeriodStart }
//              today - logical date string, the upper bound of the final cycle
// Outputs:     segmentCycles(rows, today) -> Cycle[] ascending by startDate
// Usage:       import { segmentCycles } from './segment';
//              const cycles = segmentCycles(store.days.filter(d => !d.deletedAt), todayStr());
// -----------------------------------------------------------------------------

import { addDaysStr, daysBetweenStr } from '../utils/dateUtils';
import {
  BLEEDING_FLOWS, GAP_DAYS, REFRACTORY_DAYS, MAX_PERIOD_DAYS,
  MAX_CYCLE, SHORT_CYCLE, OUTLIER_FACTOR,
} from './constants';

// --- Day classification ---
//
// Three states, and the third is the one the user controls.
//
//   bleeding  - light | medium | heavy. Can start, continue or resume a period.
//   quiet     - spotting | none | no row at all. Spotting is QUIET: the source
//               definition says a period is "greater than spotting" and that a
//               day of "only spotting or no bleeding" counts toward the gap.
//   excluded  - a bleeding day the user marked isPeriodStart: false, meaning
//               "this bleeding belongs to no period". Treated exactly as quiet.
//
// The excluded class is why classification is total. An earlier design read
// isPeriodStart:false as merely "not a day 1", which left the first bleeding
// day of a log as a "continuation" of a period that did not exist, and absorbed
// a bleed 40 days later into a period 40 days earlier. Reading it as "not
// menstrual bleeding at all" is both what a user means by the control and the
// reading that makes the rules close.

const isBleedFlow = (flow) => BLEEDING_FLOWS.includes(flow);

function classifyDay(row) {
  if (!row || !isBleedFlow(row.flow)) return 'quiet';
  if (row.isPeriodStart === false) return 'excluded';
  return 'bleeding';
}

// --- Input normalisation ---
//
// Rows arrive from localStorage or from a cross-device merge, so nothing about
// them can be assumed. Sorting here (rather than relying on caller order) is
// what makes segmentation order-invariant, which the property test asserts.
function normalise(rows, calendarToday) {
  const byDate = new Map();
  for (const r of rows ?? []) {
    if (!r || typeof r.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(r.date)) continue;
    if (r.deletedAt) continue;
    // A row dated after the CALENDAR date can only arrive from a device with a
    // skewed clock. Dropping it here keeps every later rule working on dates
    // that actually exist. The calendar date is passed in, never read from a
    // clock, so this stays pure.
    if (calendarToday && r.date > calendarToday) continue;
    const prev = byDate.get(r.date);
    // The document id IS the date, so a duplicate can only come from a merge.
    // Newest updatedAt wins; an exact tie keeps the first seen AFTER sorting,
    // which is deterministic because the sort key is the full row.
    if (!prev || String(r.updatedAt ?? '') > String(prev.updatedAt ?? '')) byDate.set(r.date, r);
  }
  return [...byDate.values()].sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
}

// --- Bleeding runs ---
//
// A run is a maximal stretch of bleeding days separated by at most GAP_DAYS
// quiet days. Runs, not individual days, are what the start rules reason about,
// because "was this one stray tap or a real period" is a question about the run.
function bleedingRuns(days) {
  const runs = [];
  let cur = null;
  for (const d of days) {
    if (d.cls !== 'bleeding') continue;
    if (cur && daysBetweenStr(cur.lastBleed, d.date) <= GAP_DAYS + 1) {
      cur.lastBleed = d.date;
      cur.bleedDays.push(d.date);
    } else {
      cur = { firstBleed: d.date, lastBleed: d.date, bleedDays: [d.date] };
      runs.push(cur);
    }
  }
  return runs;
}

// --- Start resolution ---
//
// Every run's first bleeding day is a CANDIDATE start. Candidates are then
// walked in order and accepted, rejected, or used to REPLACE the previous one.
//
// The replacement rule is the part that took three tries to get right. Without
// it, a single stray `light` day logged 20 days into a cycle becomes a start,
// and the real period nine days later falls inside its refractory window and is
// swallowed as a resumption. The result was two wrong cycle lengths (20 and 38
// in place of 29 and 29), neither of which tripped any outlier flag, from one
// stray tap. See the c1 fixture in cycle_segment.test.mjs.
//
// So: a DERIVED start anchored on a single isolated bleeding day yields to a
// longer run that begins inside its refractory window. That targets the actual
// failure (a one-day blip is far more likely spotting logged as light than a
// real menses) without disturbing the case the refractory window exists for
// (bleed, spotting tail, bleed again - there the first run is multi-day and
// keeps the anchor).
//
// A FORCED start (isPeriodStart: true) is never replaced and never rejected.
// The user outranks the heuristic, which is the whole point of the control.
function resolveStarts(days, runs) {
  const forced = days.filter(d => d.isPeriodStart === true).map(d => d.date);
  const forcedSet = new Set(forced);

  const candidates = runs
    .map(run => ({ date: run.firstBleed, runLength: run.bleedDays.length }))
    .filter(c => !forcedSet.has(c.date));

  const merged = [
    ...forced.map(date => ({ date, runLength: runLengthAt(runs, date), forced: true })),
    ...candidates.map(c => ({ ...c, forced: false })),
  ].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const accepted = [];
  for (const cand of merged) {
    const last = accepted[accepted.length - 1];

    if (cand.forced) { accepted.push(cand); continue; }
    if (!last) { accepted.push(cand); continue; }

    if (daysBetweenStr(last.date, cand.date) > REFRACTORY_DAYS) {
      accepted.push(cand);
      continue;
    }

    // Inside the refractory window of the previous start.
    //
    // `accepted.length > 1` is load-bearing and was found by the property test,
    // not by any fixture. Replacing the ONLY accepted start moves the first
    // cycle's startDate forward, which orphans the blip's own bleeding day: it
    // is real bleeding lying before every cycle, so P1 ("every effective
    // bleeding day belongs to exactly one cycle") fails. A history that OPENS
    // with a stray light day is an ordinary shape, not a corner. When the blip
    // is the first start we keep it and treat the later run as a resumption,
    // which anchors that one cycle a few days early and keeps every day
    // accounted for. That is the better trade: the error is bounded, confined
    // to the earliest cycle, and visible, where an orphaned day is none of those.
    if (accepted.length > 1
        && !last.forced && last.runLength === 1 && cand.runLength > last.runLength) {
      accepted[accepted.length - 1] = cand;   // the blip yields to the real period
    }
    // Otherwise this bleeding is a resumption of `last`, not a new period.
  }
  return accepted;
}

function runLengthAt(runs, date) {
  const run = runs.find(r => r.firstBleed <= date && date <= r.lastBleed);
  return run ? run.bleedDays.length : 1;
}

// --- Flags ---
//
// Flags never remove a cycle from history; R9a decides separately what to feed
// the estimator. The skip and split rules are deliberately SYMMETRIC about the
// running median: an earlier draft excluded only implausibly long cycles, so a
// forgotten log was caught while its mirror image (a spurious extra start,
// which shortens two cycles) was not, and the estimate drifted low with nothing
// to detect it.
//
// 'short' and 'long' are clinical labels for display only. A genuinely 22-day
// cycle is real data, not an artefact, and must not be silently dropped.
function flagsFor(cycleLength, cleanPrior, forced) {
  const flags = [];
  if (forced) flags.push('forced');
  if (cycleLength === null) return flags;
  if (cycleLength < SHORT_CYCLE) flags.push('short');
  if (cycleLength > MAX_CYCLE) flags.push('long');
  // Needs two clean prior lengths before a median means anything.
  if (cleanPrior.length >= 2) {
    const m = median(cleanPrior);
    if (cycleLength > OUTLIER_FACTOR * m) flags.push('possible-skip');
    else if (cycleLength < m / OUTLIER_FACTOR) flags.push('possible-split');
  }
  return flags;
}

function median(a) {
  const s = [...a].sort((x, y) => x - y);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// --- Public API ---

/**
 * Derives cycles from flow rows.
 *
 * @param {Array} rows          live flow rows: { date, flow, isPeriodStart, deletedAt? }
 * @param {string} today        logical date string; bounds the final open cycle
 * @param {string} calendarToday optional; rows dated after it are dropped as clock skew.
 *                              Defaults to `today`, which is correct except between
 *                              midnight and DAY_BOUNDARY_HOUR, when the caller should
 *                              pass the real calendar date so a deliberately
 *                              forward-dated row is not discarded.
 * @returns {Array} cycles ascending: { startDate, endDate, cycleLength, periodLength, isComplete, flags }
 */
export function segmentCycles(rows, today, calendarToday = today) {
  const norm = normalise(rows, calendarToday);
  if (norm.length === 0) return [];

  const days = norm.map(r => ({ ...r, cls: classifyDay(r) }));
  const runs = bleedingRuns(days);
  const starts = resolveStarts(days, runs);
  if (starts.length === 0) return [];

  const cycles = [];
  const cleanPrior = [];

  for (let i = 0; i < starts.length; i++) {
    const startDate = starts[i].date;
    const nextStart = i + 1 < starts.length ? starts[i + 1].date : null;
    const isComplete = nextStart !== null;
    // The open cycle runs to `today`, EXCEPT where a row is dated later. That
    // is reachable in normal use: R4a lets the user log the calendar date
    // between midnight and DAY_BOUNDARY_HOUR, which is todayStr() + 1. Clamping
    // to `today` would leave that row's bleeding day outside every cycle.
    const endDate = isComplete
      ? addDaysStr(nextStart, -1)
      : maxDate(today, days[days.length - 1].date);
    const cycleLength = isComplete ? daysBetweenStr(startDate, nextStart) : null;

    // Period length: start through the last bleeding day still inside this
    // cycle and inside the refractory window. Bounded by the cycle so it can
    // never run past the next start; NOT truncated at MAX_PERIOD_DAYS, because
    // truncating would make the number disagree with the log the user can see.
    const limit = isComplete
      ? minDate(addDaysStr(startDate, REFRACTORY_DAYS), addDaysStr(nextStart, -1))
      : minDate(addDaysStr(startDate, REFRACTORY_DAYS), endDate);
    let lastBleed = startDate;
    for (const d of days) {
      if (d.date < startDate || d.date > limit) continue;
      if (d.cls === 'bleeding') lastBleed = d.date;
    }
    const periodLength = daysBetweenStr(startDate, lastBleed) + 1;

    const flags = flagsFor(cycleLength, cleanPrior, starts[i].forced === true);
    if (periodLength > MAX_PERIOD_DAYS) flags.push('long-period');

    if (cycleLength !== null
        && !flags.includes('possible-skip') && !flags.includes('possible-split')) {
      cleanPrior.push(cycleLength);
    }

    cycles.push({ startDate, endDate, cycleLength, periodLength, isComplete, flags });
  }
  return cycles;
}

const minDate = (a, b) => (a < b ? a : b);
const maxDate = (a, b) => (a > b ? a : b);

// Test seam: the classification of each day, which the property test needs to
// assert that every effective bleeding day lands in exactly one cycle.
export const __test = { classifyDay, bleedingRuns, resolveStarts, normalise };
