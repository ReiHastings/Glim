// title: views.mjs
// project: Glim
// author: Reina Hastings
// contact: reinahastings13@gmail.com
// created: 2026-09-18
//
// purpose:
//   The registry the whole visual harness is driven from: one entry per
//   screenshot-able surface, giving the localStorage seed it needs and the
//   useUIStore state that reveals it. Adding a surface is one entry here; no
//   other harness file names a view.
//
//   DETERMINISM. Two things would otherwise make a screenshot differ between
//   runs of an unchanged app, which destroys baseline diffing:
//     - Wall-clock dates. Every seed timestamp is derived from FIXED_NOW, and
//       the driver pins the page clock and timezone to match, so "today" is
//       the same day forever and streak arithmetic lands on the same numbers.
//     - Random content. Glim picks messages and journal prompts with
//       pickRandom at module load, so the speech bubble and the journal prompt
//       differ on every load. The driver seeds Math.random rather than masking
//       those elements: masking hides the element but still lets its text
//       change, and the text length is exactly what the layout is being judged
//       on. See browser.mjs.
//
// inputs:  none
// outputs: FIXED_NOW, TIMEZONE, VIEWPORTS, VIEWS
//
// usage:   imported by capture.mjs, sweep.mjs and measure.mjs

// Midday, so no seed lands near Glim's 3 AM day boundary, where an off-by-one
// hour would silently move an entry into the previous day and change a count.
export const FIXED_NOW = '2026-09-18T16:00:00.000Z';  // 12:00 America/New_York
export const TIMEZONE = 'America/New_York';

const now = new Date(FIXED_NOW);
const iso = (msAgo) => new Date(now.getTime() - msAgo).toISOString();
const HOUR = 3600e3;
const DAY = 24 * HOUR;
const dateStr = (daysAgo) =>
  new Date(now.getTime() - daysAgo * DAY).toLocaleDateString('en-CA', { timeZone: TIMEZONE });

// Ids are literals, not crypto.randomUUID(), so the seed itself is identical
// on every run. Nothing in the UI displays them.
const id = (n) => `seed-${n}`;

// --- Viewports ----------------------------------------------------------
// 'phone' is the one that matters: it is under the 599px breakpoint, so it
// exercises the media-query token block and the Capacitor build's layout.
// 'desktop' exercises the base token block. Both are needed because the two
// blocks are tuned independently (see tests/token_parity.test.mjs).
export const VIEWPORTS = {
  phone:   { width: 393, height: 852, deviceScaleFactor: 3, isMobile: true,  hasTouch: true },
  desktop: { width: 1280, height: 800, deviceScaleFactor: 2, isMobile: false, hasTouch: false },
};

// --- Seeds --------------------------------------------------------------
// Shapes mirror each store's save function exactly. A field named wrongly here
// does not error; the store just falls back to its default and the screenshot
// quietly shows an empty state, so these are worth keeping in step.

const water = {
  // Four of a six-bottle goal today, plus three full days behind it so the
  // streak counter has something to show.
  entries: [
    ...[2, 4, 6, 8].map((h, i) => ({ id: id(`w${i}`), timestamp: iso(h * HOUR), deletedAt: null })),
    ...[1, 2, 3].flatMap((d) =>
      Array.from({ length: 6 }, (_, i) => ({
        id: id(`w${d}-${i}`), timestamp: iso(d * DAY + (i + 2) * HOUR), deletedAt: null,
      }))),
  ],
  bottleOz: 24,
  goal: 6,
  configUpdatedAt: iso(30 * DAY),
};

const steps = {
  // Between tier 3 and the goal, which is the most informative state for the
  // tiered milestone row: some tiers hit, one not.
  entries: [
    { id: id('s0'), timestamp: iso(1 * HOUR), count: 8420 },
    { id: id('s1'), timestamp: iso(1 * DAY), count: 11300 },
    { id: id('s2'), timestamp: iso(2 * DAY), count: 9880 },
  ],
  goal: 10000,
  configUpdatedAt: iso(30 * DAY),
};

const nutritionLog = (n, fields, daysAgo = 0) => ({
  id: id(`n${n}`), itemId: null, name: null, quantity: null,
  protein: 0, fiber: 0, fruitServings: 0, vegServings: 0,
  ...fields,
  meal: null, createdAt: iso(daysAgo * DAY + 4 * HOUR), date: dateStr(daysAgo), deletedAt: null,
});

const nutrition = {
  // Deliberately mixed against the goals: protein and fruit near ideal, fibre
  // and veg short. A screenshot where every meter is full tells you nothing
  // about how a partial meter looks.
  logs: [
    nutritionLog(0, { protein: 62 }),
    nutritionLog(1, { protein: 24, fiber: 9 }),
    nutritionLog(2, { fruitServings: 2, vegServings: 1 }),
    nutritionLog(3, { protein: 95, fiber: 28, fruitServings: 3, vegServings: 5 }, 1),
  ],
  goals: {
    protein: { min: 80, ideal: 100 },
    fiber:   { min: 25, ideal: 35 },
    fruit:   { min: 2,  ideal: 3 },
    veggie:  { min: 3,  ideal: 5 },
  },
  configUpdatedAt: iso(30 * DAY),
};

// Journal is a bare array, not an object (see useJournalStore.saveEntries).
// One long entry and one short one, because the list has to hold both.
const journal = [
  {
    id: id('j0'),
    text: 'Slept badly and the morning was a write-off, but the walk after lunch '
        + 'reset something. Noting it here so future me believes it next time.',
    prompt: 'What is one thing that went better than expected today?',
    date: iso(5 * HOUR),
  },
  { id: id('j1'), text: 'Short one today.', prompt: 'How are you arriving?', date: iso(1 * DAY) },
];

// --- The registry -------------------------------------------------------
// ui: the useUIStore fields to set. Everything not named is left at its
// default, so each entry states only what distinguishes its surface.
export const VIEWS = {
  home: {
    description: 'The creature with no panel open; the nav bar is the whole chrome.',
    seed: { 'glim-water': water, 'glim-steps': steps },
    ui: { activeNav: 'home', activePanel: null },
  },
  water: {
    // Today sits BELOW the goal (4 of 6) while the three days behind it are
    // complete, so the panel shows a partial ring and 'no streak yet'. A
    // seed that met the goal today would hide the partial-ring state, which
    // is the one most worth looking at.
    description: 'Water panel, 4 of a 6-bottle goal, three complete days behind it.',
    seed: { 'glim-water': water },
    ui: { activeNav: 'water', activePanel: 'water' },
  },
  steps: {
    description: 'Steps panel between tier 3 and the goal.',
    seed: { 'glim-steps': steps },
    ui: { activeNav: 'steps', activePanel: 'steps' },
  },
  nutrition: {
    description: 'Nutrition panel with four nutrients at different fill levels.',
    seed: { 'glim-nutrition': nutrition },
    ui: { activeNav: 'nutrition', activePanel: 'nutrition' },
  },
  symptoms: {
    // Seeded empty on purpose: the symptom diary needs a library and
    // categories to show rows, and its seed is a larger job than the four
    // above. The empty state is still worth a baseline, and this entry is
    // where a populated seed would go.
    description: 'Symptoms panel, empty state.',
    seed: {},
    ui: { activePanel: 'symptoms' },
  },
  journal: {
    description: 'Journal panel, write view, with two saved entries behind it.',
    seed: { 'glim-journal': journal },
    ui: { showJournal: true },
  },
  more: {
    description: 'The "more" feature grid overlay.',
    seed: {},
    ui: { showMoreMenu: true },
  },
  settings: {
    description: 'Settings view, the longest scrolling surface in the app.',
    seed: { 'glim-water': water, 'glim-steps': steps },
    ui: { showSettings: true },
  },
};

export const VIEW_NAMES = Object.keys(VIEWS);
