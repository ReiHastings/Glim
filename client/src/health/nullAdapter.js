// -----------------------------------------------------------------------------
// Title:       nullAdapter.js
// Project:     Glim
// Author:      Reina Hastings (reinahastings13@gmail.com)
// Created:     2026-09-17
// Last Modified: 2026-09-17
// Purpose:     The health adapter for platforms with no health platform: the
//              PWA in a browser, the desktop tab, and the Node test harness.
//              Every method answers "nothing here" without throwing, so callers
//              above the adapter never branch on platform.
//
//              A SEPARATE FILE from the plugin-backed adapter on purpose: this
//              one imports nothing, so it can be loaded anywhere, while the
//              plugin adapter is only ever reached through the dynamic import in
//              adapter.js on a native platform.
// Inputs:      None
// Outputs:     nullAdapter object (the shape described in adapter.js)
// -----------------------------------------------------------------------------

// isAvailable() resolving false is the only signal callers need: the import
// service returns early on it, so the remaining methods are unreachable in
// practice. They still RESOLVE rather than reject (spec R1, review finding m5):
// a rejection would have to be caught at every call site to no benefit, and a
// caller that reaches them despite isAvailable() is asking "what does this
// platform have", whose honest answer is "nothing", not "an error".
export const nullAdapter = Object.freeze({
  source: null,
  isAvailable:     async () => false,
  requestAccess:   async () => {},
  hasBeenAsked:    async () => false,
  readHourlySteps: async () => [],
});
