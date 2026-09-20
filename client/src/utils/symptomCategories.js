// -----------------------------------------------------------------------------
// Title:       symptomCategories.js
// Project:     Glim
// Author:      Reina Hastings (reinahastings13@gmail.com)
// Created:     2026-09-06
// Last Modified: 2026-09-06
// Purpose:     Shared constants for symptom categories: the seed rows and the
//              legacy-string -> seed-id map. They live in utils rather than in
//              useSymptomsCategoriesStore because the LIBRARY store needs the
//              legacy map for its migration, and stores never import each other -
//              not even for a constant, since that is how a state import creeps
//              in later.
// Inputs:      none (pure constants)
// Outputs:     SEED_AT, SEED_CATEGORIES, LEGACY_CATEGORY_IDS,
//              DEFAULT_CATEGORY_ID, UNCATEGORIZED_LABEL
// -----------------------------------------------------------------------------

export const UNCATEGORIZED_LABEL = 'uncategorized';

// Seed timestamp, deliberately constant and in the past.
//
// Two properties depend on it. (1) Every device the user installs seeds the same
// four rows; if each stamped createdAt/updatedAt with its own "now", the device
// that seeded last would win the last-write-wins merge and silently revert a
// rename or an archive made on another device. A fixed past timestamp guarantees
// any real user edit is newer and therefore wins. (2) Re-seeding is idempotent:
// a repeat write produces a byte-identical row.
export const SEED_AT = '2026-01-01T00:00:00.000Z';

// FIXED IDS, never crypto.randomUUID(). These rows are created independently on
// every device, before any sync has run. Random ids would give "pain" a different
// id per device, and the id-keyed merge would then union them into duplicate
// categories with no way to reconcile - each device's library items already point
// at that device's id.
export const SEED_CATEGORIES = [
  { id: 'cat-pain',      name: 'pain',      color: '#d98a9c', order: 0 },
  { id: 'cat-digestive', name: 'digestive', color: '#6ee7d0', order: 1 },
  { id: 'cat-fatigue',   name: 'fatigue',   color: '#b79df5', order: 2 },
  { id: 'cat-other',     name: 'other',     color: '#9b96b8', order: 3 },
];

// Legacy Phase 1 category STRING -> seed id, used by the library migration.
export const LEGACY_CATEGORY_IDS = {
  pain:      'cat-pain',
  digestive: 'cat-digestive',
  fatigue:   'cat-fatigue',
  other:     'cat-other',
};

export const DEFAULT_CATEGORY_ID = LEGACY_CATEGORY_IDS.other;

// --- Menstrual category (cycle tracking Phase 1) ---
//
// NOT in SEED_CATEGORIES, deliberately. Seeding it would put a "menstrual"
// category in the symptoms panel of every install whether or not the feature is
// wanted, including on a shared or demo device. It is created on FIRST ENABLE
// instead, by ensureCategory.
//
// Fixed id and SEED_AT stamp for the same reasons the seeds above use them: two
// devices enabling while offline must converge on ONE row rather than two, and a
// later rename or archive must beat the creation under last-write-wins.
//
// order 4 may tie with a user-made category (addCategory assigns maxOrder + 1).
// getActiveCategories breaks ties on name, so the result is deterministic; it
// just is not guaranteed to sit last in the picker.
export const MENSTRUAL_CATEGORY_ID = 'cat-menstrual';
export const MENSTRUAL_CATEGORY = Object.freeze({
  id: MENSTRUAL_CATEGORY_ID, name: 'menstrual', color: '#c98bb9', order: 4,
});

// Starter library items, also FIXED ID. addItem generates a random id, so two
// devices enabling offline would create two rows per name and the id-keyed merge
// would union them into duplicates with no dedupe path - exactly the failure the
// SEED_CATEGORIES comment above describes.
//
// ELEVEN, chosen by Rei 2026-09-19 from a longer candidate list. The set is a
// balance: enough that the common experiences are one tap away, few enough that
// the grid does not read as a wall. The "+ add" chip covers everything else.
//
// Four of these (back ache, headache, low energy, and arguably anxious) may
// collide with names already in the user's library under another category. That
// is ALLOWED and meaningful - `back ache` under menstrual and under pain record
// two different judgements about the same sensation - but it must be the user's
// choice. planEnable surfaces any collision before these are created, and the
// enable screen offers to skip the clashing ones.
export const MENSTRUAL_STARTERS = Object.freeze([
  { id: 'sym-menstrual-cramps',            name: 'cramps' },
  { id: 'sym-menstrual-breast-tenderness', name: 'breast tenderness' },
  { id: 'sym-menstrual-bloating',          name: 'bloating' },
  { id: 'sym-menstrual-mood-swing',        name: 'mood swing' },
  { id: 'sym-menstrual-back-ache',         name: 'back ache' },
  { id: 'sym-menstrual-headache',          name: 'headache' },
  { id: 'sym-menstrual-irritability',      name: 'irritability' },
  { id: 'sym-menstrual-anxious',           name: 'anxious' },
  { id: 'sym-menstrual-low-energy',        name: 'low energy' },
  { id: 'sym-menstrual-acne',              name: 'acne' },
  { id: 'sym-menstrual-cravings',          name: 'cravings' },
]);
