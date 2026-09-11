// title: sync_generation_guard.test.mjs
// project: Glim
// author: Reina Hastings
// contact: reinahastings13@gmail.com
// date created: 2026-09-10
//
// purpose:
//   Static-analysis presence test (no framework, no Firebase import) for the
//   run-generation guard in sync.js (Decision Register 2026-09-10). It answers
//   ONE question: does every sync function capture the generation and check it?
//   It deliberately does NOT count guards per await - a count is satisfiable by
//   a guard in the wrong place. Placement is a behavioural property, covered by
//   tests/sync_stale_run.test.mjs (R1-R6) and by the staleSkips === 0 checks in
//   the scenario suites.
//
//   Why a static test at all: the account-switch guard's history is three
//   rounds of "a new domain was added and the guard missed it" (nutrition,
//   a53da46; both symptom stores before Phase 1.5). A behavioural test only
//   exercises domains that exist when it is written; this one fails the moment
//   a fourteenth sync function appears without the guard.
//
// usage:
//   cd client && node --import ./tests/register-hooks.mjs tests/sync_generation_guard.test.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '../src/sync.js'), 'utf8');

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.error(`  FAIL ${name}`); }
}

// --- Module state and lifecycle ---
check('generation counter is declared', /^let generation = 0;/m.test(src));
check('stale() helper is declared', /^function stale\(gen, what\)/m.test(src));
const startBody = src.slice(src.indexOf('export function startSync('), src.indexOf('export function stopSync('));
const stopBody  = src.slice(src.indexOf('export function stopSync('), src.indexOf('export const __test'));
check('startSync bumps the generation', /generation\+\+/.test(startBody));
check('stopSync bumps the generation', /generation\+\+/.test(stopBody));

// --- Every sync function and both shared helpers capture and check ---
// A "sync function" is any top-level `async function <name>(` whose name starts
// with sync, plus pushEntries and flushSync. flushSync is included because it
// calls pushEntries four times in sequence and must guard calls 2-4 itself (the
// helper's own capture is post-await there; 2026-09-10 review finding). syncAll
// only fans out and awaits; the five one-line mutable wrappers delegate to
// syncUpdatedAtCollection. Both exemptions are verified below.
const DELEGATES = new Set(['syncAll', 'syncSymptoms', 'syncSymptomsLibrary',
  'syncSymptomsCategories', 'syncSymptomClearDays', 'syncNutritionLibrary']);
const decl = /^(?:export )?async function (\w+)\(/gm;
const names = [];
for (const m of src.matchAll(decl)) names.push({ name: m[1], at: m.index });
const targets = names.filter(n => (n.name.startsWith('sync') || n.name === 'pushEntries' || n.name === 'flushSync') && !DELEGATES.has(n.name));
check('found the expected number of guarded functions (11)', targets.length === 11);

for (let i = 0; i < names.length; i++) {
  const n = names[i];
  if (!targets.includes(n)) continue;
  const next = names[i + 1]?.at ?? src.length;
  const body = src.slice(n.at, next);
  // First statement after the signature line must be the capture.
  const firstStmt = body.split('\n').slice(1).map(l => l.trim()).find(l => l && !l.startsWith('//'));
  check(`${n.name}: first statement captures the generation`, /^const gen\s*=\s*generation;/.test(firstStmt ?? ''));
  check(`${n.name}: checks stale(gen, ...) at least once`, /stale\(gen,/.test(body));
}

// The delegates must really delegate (so their exemption is honest).
for (const d of ['syncSymptoms', 'syncSymptomsLibrary', 'syncSymptomsCategories', 'syncSymptomClearDays', 'syncNutritionLibrary']) {
  const n = names.find(x => x.name === d);
  const next = names[names.indexOf(n) + 1]?.at ?? src.length;
  check(`${d} delegates to syncUpdatedAtCollection`, n && src.slice(n.at, next).includes('return syncUpdatedAtCollection('));
}

// syncAll's exemption is honest only while it performs no write of its own.
{
  const n = names.find(x => x.name === 'syncAll');
  const next = names[names.indexOf(n) + 1]?.at ?? src.length;
  const body = src.slice(n.at, next);
  check('syncAll performs no write of its own', !/localSet|localSetRaw|setSyncMeta|setDoc\(|notify\(/.test(body));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
