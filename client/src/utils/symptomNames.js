// -----------------------------------------------------------------------------
// Title:       symptomNames.js
// Project:     Glim
// Author:      Reina Hastings (reihastings@gmail.com)
// Created:     2026-09-18
// Purpose:     Name comparison for symptom library items, and the collision
//              detection that hangs off it.
//
//              A symptom NAME may legitimately exist in more than one category:
//              a user may hold `back ache` under menstrual for the ones they
//              read as cycle-related and `back ache` under pain for the ones
//              they do not, and pick between them at log time. That choice is
//              the user's own attribution, which nothing in the data can
//              derive. See the cycle Phase 1 spec, D13.
//
//              The cost is that two chips then read identically in a flat,
//              recency-sorted grid. Every surface that names a symptom has to
//              disambiguate the colliding ones, and that starts with agreeing
//              on what "colliding" means.
// Inputs:      none (pure functions)
// Outputs:     normalizeName, namesCollide, collidingIds
// Usage:       import { collidingIds } from '../utils/symptomNames';
//              const clashing = collidingIds(library.getActiveItems());
//              if (clashing.has(item.id)) showCategoryAlongsideName(item);
// -----------------------------------------------------------------------------

/**
 * The comparison key for a symptom name.
 *
 * Order matters. NFC first, so a composed and a decomposed "é" agree before
 * anything else looks at them; then whitespace; then case.
 *
 * `toLowerCase()`, NOT `toLocaleLowerCase()`. The locale-aware form uses the
 * HOST locale, so on a Turkish-locale device `I` folds to a dotless `ı` and two
 * devices would disagree about whether the same pair of items collides. A
 * collision must be a property of the data, not of the phone.
 *
 * Deliberately NOT a full Unicode case fold: `ß` and `SS` stay distinct. A
 * missed collision costs a warning nobody sees; a false one blocks a name the
 * user legitimately wants.
 */
export function normalizeName(name) {
  if (typeof name !== 'string') return '';
  return name
    .normalize('NFC')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

/** True when two names would read identically to a person. */
export function namesCollide(a, b) {
  const na = normalizeName(a);
  return na !== '' && na === normalizeName(b);
}

/**
 * The ids of items whose name is shared with at least one OTHER item in the
 * list. Pass only the items a user can currently see (live, non-archived):
 * an archived item is not in the grid and cannot be confused with anything.
 *
 * Returns a Set, so a render loop can ask `clashing.has(item.id)` per chip
 * without re-scanning.
 */
export function collidingIds(items) {
  const byKey = new Map();
  for (const item of items ?? []) {
    const key = normalizeName(item?.name);
    if (!key) continue;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(item.id);
  }
  const out = new Set();
  for (const ids of byKey.values()) {
    if (ids.length > 1) for (const id of ids) out.add(id);
  }
  return out;
}

/**
 * Items already in the library whose name would collide with `name`.
 * Used by the add-a-symptom flow and by the cycle feature's first-enable check,
 * so a duplicate is always something the user chose rather than something Glim
 * created underneath them.
 */
export function itemsCollidingWith(name, items) {
  const key = normalizeName(name);
  if (!key) return [];
  return (items ?? []).filter(i => normalizeName(i?.name) === key);
}
