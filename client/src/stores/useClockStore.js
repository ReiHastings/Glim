// -----------------------------------------------------------------------------
// Title:       useClockStore.js
// Project:     Glim
// Author:      Reina Hastings (reinahastings13@gmail.com)
// Created:     2026-09-18
// Last Modified: 2026-09-18
// Purpose:     Holds the current LOGICAL day as a subscribable value, so a
//              component that memoizes day-dependent derived data has something
//              to depend on. No localStorage persistence - derived from the
//              clock, never stored.
//
//              WHY THIS EXISTS. Panels read todayStr() at render time and until
//              now self-corrected at the day boundary only by accident: the
//              60-second updateTime() interval in DesktopPet re-rendered the
//              whole tree because nothing was memoized. The moment a panel
//              memoizes its derived values (docs/plan_steps_derivation_cost.md
//              section 3.4) that accident stops working, and the planned
//              re-render fix removes it entirely. A panel left open across the
//              boundary would then keep showing yesterday's numbers, and - worse
//              - the steps editor would prefill from them and could commit
//              yesterday's count as today's manual entry, which wins precedence
//              over the health import for the whole day.
//
//              tick() must therefore be called from every path that can resume
//              a stale view, not only the interval: see DesktopPet.jsx (interval
//              plus visibilitychange) and App.jsx (Capacitor appStateChange).
//              A frozen tab or a backgrounded app does not run its interval.
// Inputs:      None (reads the clock via todayStr)
// Outputs:     Zustand store hook exported as useClockStore
// Usage:       const logicalDay = useClockStore(s => s.logicalDay);
//              useMemo(() => derive(...), [entries, logicalDay]);
// -----------------------------------------------------------------------------

import { create } from 'zustand';
import { todayStr } from '../utils/dateUtils';

export const useClockStore = create((set) => ({
  logicalDay: todayStr(),

  // Re-reads the logical day. Returning the EXISTING state object when the day
  // has not changed is a genuine no-op in zustand v5: setState compares with
  // Object.is before merging and notifying, so subscribers re-render once per
  // day rather than once per tick.
  tick: () => {
    const day = todayStr();
    set(state => (state.logicalDay === day ? state : { logicalDay: day }));
  },
}));
