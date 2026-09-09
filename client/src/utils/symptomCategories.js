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
