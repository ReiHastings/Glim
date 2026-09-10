// -----------------------------------------------------------------------------
// Title:       symptomReminder.js
// Project:     Glim
// Author:      Reina Hastings (reinahastings13@gmail.com)
// Created:     2026-09-08
// Last Modified: 2026-09-09
// Purpose:     The end-of-day symptom reminder's DECISIONS, as pure functions
//              with no store or React imports, so they can be tested directly
//              rather than reproduced by hand in a test. DesktopPet gathers the
//              inputs and applies the outputs; nothing here reads state.
//
//              Three decisions:
//                shouldPromptForClearDay - may the card be shown right now?
//                dayHasRecord            - has the day acquired a record, so
//                                          the question is moot?
//                resolveClearDayAnswer   - what an answer means: close the
//                                          card, stamp the day, or show why not.
//
//              The load-bearing rule is in resolveClearDayAnswer: a REFUSED
//              "yes" (markClear said no: a symptom is present that day) must NOT
//              stamp the day. Stamping suppresses the card until tomorrow, and
//              a stamped refusal is an answer silently thrown away with the one
//              mechanism that could re-ask it disabled.
// Inputs:      Plain values gathered by the caller (see each function)
// Outputs:     REMINDER_STAMP_KEY, shouldPromptForClearDay, dayHasRecord,
//              resolveClearDayAnswer
// Usage:       const outcome = resolveClearDayAnswer('yes', markClear(today, affected));
//              if (outcome.stamp) localStorage.setItem(REMINDER_STAMP_KEY, today);
// -----------------------------------------------------------------------------

// Per-device, deliberately unsynced: whether THIS device already asked today is
// not a fact about the user's health record.
export const REMINDER_STAMP_KEY = 'glim-symptom-reminder-prompted';

// True when the day already carries a record either way (a symptom present, or
// an explicit clear-day row), which is exactly when the question has no point.
//
// presentCount is getAffectedDays(today, today).get(today).size - the number of
// symptoms PRESENT today - and deliberately NOT getTodayEntries().length. The
// two disagree for a closed episode that started on an earlier logical day and
// ended today: it is present today (its span covers the day, so markClear will
// refuse) but absent from the today list. Gating on the list would show a card
// whose only answer is refused, with no way to dismiss it but "not now".
export function dayHasRecord({ presentCount, isClearToday }) {
  return presentCount > 0 || isClearToday === true;
}

// The gate. Every condition as data; the caller supplies the clock.
//   enabled         - the opt-in setting
//   hourNow         - wall-clock hour (0-23)
//   reminderHour    - the configured "ask after" hour
//   stampedDate     - the date string in REMINDER_STAMP_KEY, or null
//   today           - the current logical date string
//   presentCount    - symptoms present today, per getAffectedDays (see dayHasRecord)
//   isClearToday    - isClear(today)
export function shouldPromptForClearDay({
  enabled, hourNow, reminderHour, stampedDate, today, presentCount, isClearToday,
}) {
  if (!enabled) return false;
  if (stampedDate === today) return false;
  if (hourNow < reminderHour) return false;
  return !dayHasRecord({ presentCount, isClearToday });
}

// What to do with an answer.
//   'not-now'      -> close and stamp (declining must suppress for the day).
//   'yes' + ok     -> close and stamp.
//   'yes' + refused -> keep the card OPEN, do NOT stamp, surface the reason.
// A 'yes' with no result at all is treated as refused: never stamp on unknown.
// Returns { close: boolean, stamp: boolean, error: string | null }.
export function resolveClearDayAnswer(answer, result = null) {
  if (answer === 'not-now') return { close: true, stamp: true, error: null };
  if (answer === 'yes') {
    if (result && result.ok === true) return { close: true, stamp: true, error: null };
    return { close: false, stamp: false, error: result?.error ?? 'could not record the day' };
  }
  throw new Error(`resolveClearDayAnswer: unknown answer "${answer}"`);
}
