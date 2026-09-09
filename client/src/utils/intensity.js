// -----------------------------------------------------------------------------
// Title:       intensity.js
// Project:     Glim
// Author:      Reina Hastings (reinahastings13@gmail.com)
// Created:     2026-09-06
// Last Modified: 2026-09-06
// Purpose:     The one place the symptom diary's null-intensity policy lives.
//              An unrecorded intensity is STORED as null and INTERPRETED as 0 in
//              aggregates; it is never stored as 0. Keeping "stored" and
//              "interpreted" apart is the whole point: once a null is written
//              back as 0 the distinction between "I did not rate this" and "this
//              was a 0" is gone permanently, including on every other device
//              after sync.
//
//              Surface scope:
//                - entry rows / meta lines -> hasRecordedIntensity (render nothing)
//                - aggregates and trends   -> resolveIntensity / meanIntensity
//                - the edit sheet          -> NEITHER (raw stored value only)
//
// Inputs:      Symptom log entries ({ intensity: number | null | undefined })
// Outputs:     INTENSITY_NULL_POLICY, hasRecordedIntensity, resolveIntensity,
//              meanIntensity
// Usage:       import { hasRecordedIntensity, meanIntensity } from '../utils/intensity';
//              const { mean, covered, total } = meanIntensity(entries);
// -----------------------------------------------------------------------------

// 'zero'    - an unrated entry contributes 0 to an aggregate (current policy).
// 'exclude' - an unrated entry is dropped from the aggregate entirely.
export const INTENSITY_NULL_POLICY = 'zero';

// True only when the user actually recorded a number. The display surfaces use
// this and nothing else, so an unrated entry renders no pill and no "x/10".
export function hasRecordedIntensity(entry) {
  return entry.intensity !== null && entry.intensity !== undefined;
}

// The aggregate-facing value. `policy` is an injection seam for the tests, which
// must exercise both branches; application code passes nothing and gets the
// module-level policy.
export function resolveIntensity(entry, policy = INTENSITY_NULL_POLICY) {
  if (hasRecordedIntensity(entry)) return entry.intensity;
  return policy === 'zero' ? 0 : null;
}

// Mean intensity plus the COVERAGE the mean was computed from. covered/total is
// not optional decoration: under the 'zero' policy a day of unrated entries
// reads as a mean of 0, which is indistinguishable from a genuinely mild day
// unless the caller can also see that 0 of 5 entries were rated. Any surface
// that displays the mean must display the coverage with it.
// Returns { mean: number | null, covered: number, total: number }.
export function meanIntensity(entries, policy = INTENSITY_NULL_POLICY) {
  const values  = entries.map(e => resolveIntensity(e, policy)).filter(v => v !== null);
  const covered = entries.filter(hasRecordedIntensity).length;
  if (values.length === 0) return { mean: null, covered: 0, total: entries.length };
  return {
    mean: values.reduce((a, b) => a + b, 0) / values.length,
    covered,
    total: entries.length,
  };
}
