// -----------------------------------------------------------------------------
// Title:       constants.js
// Project:     Glim - cycle tracking Phase 1
// Author:      Reina Hastings (reihastings@gmail.com)
// Created:     2026-09-18
// Purpose:     Tunable constants for cycle segmentation and prediction. Every
//              value carries its source. Where a value is GLIM'S OWN CHOICE
//              rather than a published figure, the comment says so, because the
//              first draft of this feature blurred the two and a later reader
//              could not tell which numbers were defensible from the literature.
// Inputs:      none (pure constants)
// Outputs:     the named constants below
// Usage:       import { GAP_DAYS, REFRACTORY_DAYS } from './constants';
// -----------------------------------------------------------------------------

// --- Population priors (Bull et al. 2019, npj Digital Medicine, 612,613 cycles) ---
export const POP_MEAN_CYCLE  = 29;   // reported mean 29.3, rounded
export const POP_SPREAD      = 8;    // GLIM'S CHOICE: HALF-WIDTH of the population window, used
                                     // before two usable cycles exist. Sized as 1.645 x the ~5-day
                                     // between-woman sd so the band is nominally 90%, not 1 sd.
                                     // An earlier value of 5 conflated the two and measured 0.40
                                     // coverage at high variability (Part F of the calibration).
export const LUTEAL_DAYS     = 13;   // GLIM'S CHOICE: Bull reports mean luteal 12.4; rounded UP so a
                                     // backward-counted ovulation estimate errs earlier. NOT a constant
                                     // in reality (Prior et al. 2024). Computed, never displayed.
export const FERTILE_SPAN    = 6;    // Wilcox et al. 1995: six days INCLUSIVE ending on ovulation

// --- Segmentation ---
// The period definition is Li, Urteaga et al. 2020 (npj Digital Medicine):
// "A period consists of sequential days of bleeding (greater than spotting and
// within ten days after the first greater-than-spotting bleeding event)
// unbroken by no more than one day on which only spotting or no bleeding
// occurred."
export const GAP_DAYS        = 1;    // "no more than one day" of spotting or no bleeding
export const MAX_PERIOD_DAYS = 10;   // "menses duration longer than 10 days is an outlier"
export const MAX_CYCLE       = 90;   // Li/Urteaga 2020 exclusion bound
export const SHORT_CYCLE     = 24;   // FIGO 2018: below this is abnormally frequent. DISPLAY FLAG ONLY.

// GLIM'S RULE, not the paper's. The paper's "within ten days" clause scopes
// which bleeding days count toward a period; it says nothing about when a NEW
// period may begin. Glim reuses the number as a refractory window because
// without one, a spotting tail followed by resumed bleeding yields an absurd
// 8-day cycle. The number is borrowed; the rule is ours.
export const REFRACTORY_DAYS = 10;

// --- Estimation ---
export const OUTLIER_FACTOR  = 1.5;  // GLIM'S CHOICE: symmetric exclusion band about the running median
export const WINDOW_CYCLES   = 12;   // GLIM'S CHOICE: most recent cycles used for estimation

// --- Prediction interval ---
// Nominal 90%: the 5th and 95th percentiles of past cycle lengths, then widened
// for the uncertainty in the estimate itself. See predict.js for why the
// widening factor has the shape it does.
export const Q_LO           = 0.05;
export const Q_HI           = 0.95;

// --- Display thresholds. GLIM'S CHOICE; these drive copy, not the model. ---
export const VARIABLE_WIDTH = 14;  // above this window width, quality is 'variable'
export const DISCARD_RATE   = 0.2; // above this share of cycles discarded, quality is 'variable'
export const WIDE_WIDTH     = 21;  // above this, show past lengths instead of a date band

export const BLEEDING_FLOWS = Object.freeze(['light', 'medium', 'heavy']);
export const ALL_FLOWS      = Object.freeze(['none', 'spotting', ...BLEEDING_FLOWS]);
