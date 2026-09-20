// -----------------------------------------------------------------------------
// Title:       enable.js
// Project:     Glim - cycle tracking Phase 1
// Author:      Reina Hastings (reihastings@gmail.com)
// Created:     2026-09-18
// Purpose:     Plans the cycle feature's first-enable setup. PURE: it reads
//              nothing and writes nothing. It takes the library's current items
//              and returns what SHOULD be created plus any name collisions the
//              user ought to see first; the panel performs the writes.
//
//              That split exists because stores never import each other in this
//              codebase, so the orchestration belongs in the panel. Keeping the
//              DECISION here rather than in the panel means it is testable
//              without rendering anything.
//
//              Why collisions are surfaced rather than silently accepted: a
//              symptom name may legitimately live in two categories, and the
//              duplicate is meaningful precisely because the USER chose it.
//              A duplicate Glim creates on its own encodes nothing and is
//              indistinguishable from a chosen one in the grid. So if a
//              `bloating` already exists elsewhere, the user is asked.
// Inputs:      existingItems - live library items: { id, name, categoryId }
// Outputs:     planEnable(existingItems) -> { toCreate, collisions, category }
// Usage:       import { planEnable } from './enable';
//              const plan = planEnable(library.getActiveItems());
//              // show plan.collisions, then create plan.toCreate minus any skipped
// -----------------------------------------------------------------------------

import { MENSTRUAL_CATEGORY, MENSTRUAL_CATEGORY_ID, MENSTRUAL_STARTERS }
  from '../utils/symptomCategories';
import { itemsCollidingWith } from '../utils/symptomNames';

/**
 * @param {Array} existingItems live library items
 * @returns {{
 *   category: object,                     the category row to ensure
 *   toCreate: Array,                      starter rows, ready for ensureItem
 *   collisions: Array<{starter, existing}> starters whose name already exists
 * }}
 */
export function planEnable(existingItems = []) {
  const live = existingItems.filter(i => i && !i.deletedAt);
  const toCreate = [];
  const collisions = [];

  for (const starter of MENSTRUAL_STARTERS) {
    const row = { ...starter, categoryId: MENSTRUAL_CATEGORY_ID };
    // Already created here (or pulled from another device): nothing to do, and
    // nothing to warn about. ensureItem would no-op anyway, but reporting it as
    // a collision would ask the user about their own past choice every time.
    if (live.some(i => i.id === starter.id)) continue;

    const clashing = itemsCollidingWith(starter.name, live);
    if (clashing.length > 0) collisions.push({ starter: row, existing: clashing });
    toCreate.push(row);
  }

  return { category: MENSTRUAL_CATEGORY, toCreate, collisions };
}
