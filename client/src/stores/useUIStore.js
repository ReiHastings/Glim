// -----------------------------------------------------------------------------
// Title:       useUIStore.js
// Project:     Glim
// Author:      Reina Hastings (reinahastings13@gmail.com)
// Created:     2026-03-27
// Last Modified: 2026-09-06
// Purpose:     Zustand store for panel visibility and transient UI state.
//              Includes journal panel view state (journalView, journalText,
//              journalPrompt). Holds nav active state and companion panel
//              routing (activeNav, activePanel) added in Phase 1.
//              No localStorage persistence - all ephemeral.
// -----------------------------------------------------------------------------

import { create } from 'zustand';
import { pickRandom } from '../utils';
import { JOURNAL_PROMPTS } from '../messages';

export const useUIStore = create((set) => ({
  showSettings: false,
  showJournal:  false,

  // Nav bar and companion panel state (Phase 1)
  activeNav:    'home',   // 'home' | 'water' | 'steps' | 'nutrition' | 'tasks' | 'more'
  activePanel:  null,     // null | 'water' | 'steps' | 'nutrition' | 'tasks' | 'focus'
  navBarHeight: 80,       // measured via ResizeObserver in NavBar.jsx
  requestClose: false,    // signal from NavBar to CompanionPanel to animate closed

  // Signal from SymptomsPanel to DesktopPet, same precedent as requestClose
  // above. The panel receives no props and must not call showMessage or
  // useMessageStore itself: bubble timing (and the wellness/msgType bookkeeping)
  // lives in DesktopPet, and calling the message store directly would bypass it.
  // So the panel names the EVENT and DesktopPet decides whether Glim speaks -
  // which is also where the once-per-30-minutes rate limit belongs.
  // null | 'symptom-logged' | 'episode-ended' | 'clear-day'
  pendingReaction: null,
  showMoreMenu: false,    // controls the "more" feature grid overlay
  focusView: null,        // null | 'settings' | 'library' (focus mode screen routing)

  // Journal panel internal state
  journalView:   "write",
  journalText:   "",
  journalPrompt: pickRandom(JOURNAL_PROMPTS),

  setShowMoreMenu: (v) => set({ showMoreMenu: v }),
  setFocusView:    (v) => set({ focusView: v }),
  setShowSettings: (v) => set({ showSettings: v }),
  setShowJournal:  (v) => set({ showJournal: v }),
  setActiveNav:    (v) => set({ activeNav: v }),
  setActivePanel:  (v) => set({ activePanel: v }),
  setNavBarHeight: (h) => set({ navBarHeight: h }),
  setRequestClose: (v) => set({ requestClose: v }),
  setPendingReaction: (v) => set({ pendingReaction: v }),
  setJournalView:  (v) => set({ journalView: v }),
  setJournalText:  (v) => set({ journalText: v }),
  setJournalPrompt:(v) => set({ journalPrompt: v }),
}));
