// -----------------------------------------------------------------------------
// Title:       logSymptom.js
// Project:     Glim
// Author:      Reina Hastings (reihastings@gmail.com)
// Created:     2026-09-18
// Purpose:     The one place the two invariants that must hold on EVERY symptom
//              log are enforced: the entry's day stops being a clear day, and
//              the caller gets back the id and the date it landed on.
//
//              Extracted when the cycle panel gained its own chip grid. Both
//              panels log into the SAME symptoms domain, so both carry the same
//              obligation, and two copies of it is how they drift. The clear-day
//              store's header states the writer-side rule and why the unmark is
//              unconditional: another device may hold a clear-day row this one
//              has not pulled, and a tombstone written here is what stops that
//              stale row winning the cross-device merge.
//
//              Keyed on the ENTRY'S date read fresh from the store, never on
//              "today": the render snapshot predates the write, and an entry can
//              land on a different day than the one the panel is showing.
//
//              Takes its dependencies as arguments rather than importing the
//              stores, so it stays pure enough to test and so it does not become
//              a route by which one store reaches another.
// Inputs:      deps - { logMoment, getLogs, unmarkClear, fallbackDate }
// Outputs:     logSymptomAndClearDay(deps, symptomId) -> { id, date }
// Usage:       const { id } = logSymptomAndClearDay({
//                logMoment: symptoms.logMoment,
//                getLogs:   () => useSymptomsStore.getState().logs,
//                unmarkClear: clearDays.unmarkClear,
//                fallbackDate: today,
//              }, item.id);
// -----------------------------------------------------------------------------

export function logSymptomAndClearDay(deps, symptomId) {
  const { logMoment, getLogs, unmarkClear, fallbackDate } = deps;
  const id = logMoment(symptomId);
  // The entry may not be found if the write was rejected; fall back rather than
  // throwing, because failing to unmark is worse than unmarking the wrong day.
  const date = getLogs().find(e => e.id === id)?.date ?? fallbackDate;
  unmarkClear(date);
  return { id, date };
}
