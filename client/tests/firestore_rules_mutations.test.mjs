// title: firestore_rules_mutations.test.mjs
// project: Glim
// author: Reina Hastings
// contact: reinahastings13@gmail.com
// created: 2026-09-21
//
// purpose:
//   Proves firestore_rules_emulator.test.mjs has teeth. For each mutation below
//   it writes a deliberately broken copy of firestore.rules to a temp file,
//   runs the emulator test against it, and asserts that the cases the mutation
//   should break DO go red. A rules test that stays green when the rule it
//   covers is deleted is not testing that rule.
//
//   Each mutation is an exact before/after text replacement that must match
//   EXACTLY ONCE, so an edit to firestore.rules that moves the text fails here
//   loudly instead of silently mutating nothing. A mutated file that no longer
//   compiles is reported separately (the child exits 3), because it would fail
//   every case and prove nothing.
//
//   E1 is an equivalence check, not a mutation: hasAll in cycleValid is
//   believed redundant (every field it names is dereferenced unguarded further
//   down, and reading an absent key is an error that denies). Removing it must
//   turn NOTHING red. If that ever fails, the belief or the rules changed.
//
// inputs:  FIRESTORE_EMULATOR_HOST (set by `firebase emulators:exec`); the
//          repo's firestore.rules; tests/firestore_rules_emulator.test.mjs
// outputs: one line per mutation with its red set; exits non-zero if any
//          mutation is not detected, breaks compilation, or E1 turns a case red
//
// usage:
//   cd client && npx --yes firebase-tools@15.30.2 emulators:exec --only firestore --project demo-glim "node tests/firestore_rules_mutations.test.mjs"

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.error('FAIL this test must run inside `firebase emulators:exec` (see the usage line in the header)');
  process.exit(1);
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RULES = readFileSync(path.resolve(HERE, '../../firestore.rules'), 'utf8');
const TARGET = path.resolve(HERE, 'firestore_rules_emulator.test.mjs');

// --- Mutations ---------------------------------------------------------------
// { id, what, before, after, mustRed: [case numbers that must fail] }

const GATE_STEPS = "\n          && (collectionId != 'steps-health' || stepsHealthValid())";
const SPLIT_BLOCK =
  "    match /users/{userId}/steps-health/{docId} {\n" +
  "      allow create, update: if isOwner(userId) && stepsHealthValid();\n" +
  "    }\n\n";
const CATCH_ALL_COMMENT = "    // Deny everything else, including any path deeper than the above.";

const MUTATIONS = [
  { id: 'M1', what: 'monotonicity gate removed',
    before: "\n          && (!isMutable(collectionId) || updatedAtNotRegressing())", after: '', mustRed: [17, 22, 37, 39] },
  { id: 'M2', what: '>= weakened to > (idempotent re-push would fail)',
    before: 'request.resource.data.updatedAt >= resource.data.updatedAt', after: 'request.resource.data.updatedAt > resource.data.updatedAt', mustRed: [18] },
  { id: 'M3', what: 'repair path for a corrupt existing stamp removed',
    before: "\n          || !isIsoStamp(resource.data.updatedAt)", after: '', mustRed: [21] },
  { id: 'M4', what: 'create escape (resource == null) removed',
    before: 'return resource == null', after: 'return false', mustRed: [27, 28, 29, 43, 44] },
  { id: 'M5', what: 'request-without-updatedAt escape removed',
    before: "\n          || !('updatedAt' in request.resource.data)", after: '', mustRed: [24] },
  { id: 'M6', what: 'steps-health validator removed from the gate',
    before: GATE_STEPS, after: '', mustRed: [30, 31, 32, 33, 34, 35, 36, 38] },
  { id: 'M7', what: '`is int` relaxed to `is number`',
    before: 'd.steps is int && d.steps >= 0', after: 'd.steps is number && d.steps >= 0', mustRed: [30] },
  { id: 'M8', what: 'steps >= 0 removed',
    before: 'd.steps is int && d.steps >= 0', after: 'd.steps is int', mustRed: [31] },
  { id: 'M9', what: 'steps-health hasOnly removed',
    before: "return d.keys().hasOnly(['id', 'source', 'date', 'steps', 'updatedAt', 'syncedAt'])", after: 'return true', mustRed: [32, 38] },
  { id: 'M10', what: 'cycle hasOnly removed',
    before: "return d.keys().hasOnly(['id', 'date', 'flow', 'isPeriodStart', 'note',\n                               'createdAt', 'updatedAt', 'deletedAt', 'syncedAt'])", after: 'return true', mustRed: [49] },
  { id: 'M11', what: 'cycle id == date removed',
    before: "\n          && d.id == d.date", after: '', mustRed: [45] },
  { id: 'M12', what: 'catch-all opened to any signed-in user',
    before: '      allow read, write: if false;', after: '      allow read, write: if request.auth != null;', mustRed: [12, 13, 14] },
  { id: 'M13', what: 'BLOCK SPLIT: steps-health validator moved to its own match block (the bypass the rules comments warn about)',
    edits: [[GATE_STEPS, ''], [CATCH_ALL_COMMENT, SPLIT_BLOCK + CATCH_ALL_COMMENT]], mustRed: [37] },
  { id: 'M14', what: "'cycle' dropped from isMutable",
    before: "'symptom-categories', 'symptom-days', 'steps-health', 'cycle'", after: "'symptom-categories', 'symptom-days', 'steps-health'", mustRed: [39] },
  { id: 'M15', what: 'ownership reduced to "any signed-in user"',
    before: 'return request.auth != null && request.auth.uid == userId;', after: 'return request.auth != null;', mustRed: [2, 6, 8, 10, 16, 53] },
  { id: 'M16', what: 'delete opened to everyone',
    before: 'allow delete: if isOwner(userId);', after: 'allow delete: if true;', mustRed: [16, 56] },
  { id: 'E1', what: 'EQUIVALENCE: cycle hasAll removed (believed redundant; must turn nothing red)',
    before: "\n          && d.keys().hasAll(['id', 'date', 'flow', 'createdAt', 'updatedAt'])", after: '', mustRed: [], mustBeGreen: true },
];

// --- Harness -----------------------------------------------------------------

const tmp = mkdtempSync(path.join(os.tmpdir(), 'glim-rules-mut-'));
// An 'exit' handler, not try/finally: process.exit() inside a try skips the finally.
process.on('exit', () => rmSync(tmp, { recursive: true, force: true }));
let problems = 0;

function applyEdits(m) {
  let text = RULES;
  for (const [before, after] of m.edits ?? [[m.before, m.after]]) {
    const n = text.split(before).length - 1;
    if (n !== 1) throw new Error(`${m.id}: expected the 'before' text exactly once in firestore.rules, found it ${n} times. The rules moved; update this mutation.`);
    text = text.replace(before, () => after);
  }
  return text;
}

function runAgainst(rulesFile) {
  const res = spawnSync(process.execPath, [TARGET], {
    env: { ...process.env, GLIM_RULES_FILE: rulesFile, GLIM_SHUFFLE: '' }, encoding: 'utf8',
  });
  const red = [...(res.stdout ?? '').matchAll(/^FAIL (\d+) /gm)].map((x) => Number(x[1])).sort((a, b) => a - b);
  const ran = [...(res.stdout ?? '').matchAll(/^(?:ok|FAIL) \d+ /gm)].length;
  return { code: res.status, red, ran, stderr: res.stderr ?? '' };
}

{
  // Control: the unmutated rules must pass, or nothing below means anything.
  const controlFile = path.join(tmp, 'control.rules');
  writeFileSync(controlFile, RULES);
  const control = runAgainst(controlFile);
  if (control.code !== 0 || control.red.length) {
    console.error(`FAIL control: the unmutated rules do not pass (exit ${control.code}, red ${control.red}). Fix that first.`);
    process.exit(1);
  }
  console.log(`  ok   control: unmutated rules pass (${control.ran} checks)`);

  for (const m of MUTATIONS) {
    let file;
    try {
      file = path.join(tmp, `${m.id}.rules`);
      writeFileSync(file, applyEdits(m));
    } catch (err) {
      problems++; console.error(`  FAIL ${m.id} ${err.message}`); continue;
    }
    const r = runAgainst(file);
    if (r.code !== 3 && r.ran !== 0 && r.ran !== control.ran) {
      // A child that died partway could already have reddened its mustRed
      // cases; without this it would be reported ok on a truncated run.
      problems++; console.error(`  FAIL ${m.id} TRUNCATED RUN: executed ${r.ran} checks, the control executed ${control.ran} - ${m.what}`);
      continue;
    }
    if (r.code === 3 || r.ran === 0) {
      problems++; console.error(`  FAIL ${m.id} MUTATION BROKE COMPILATION (it proves nothing): ${m.what}\n${r.stderr.trim().split('\n').slice(0, 3).join('\n')}`);
      continue;
    }
    if (m.mustBeGreen) {
      if (r.red.length === 0 && r.code === 0) console.log(`  ok   ${m.id} red: none, as asserted - ${m.what}`);
      else { problems++; console.error(`  FAIL ${m.id} expected NO red cases, got [${r.red}] - ${m.what}`); }
      continue;
    }
    const missing = m.mustRed.filter((n) => !r.red.includes(n));
    if (r.red.length > 0 && missing.length === 0) console.log(`  ok   ${m.id} red: [${r.red}] - ${m.what}`);
    else { problems++; console.error(`  FAIL ${m.id} NOT DETECTED: expected at least [${m.mustRed}] red, got [${r.red}] (missing [${missing}]) - ${m.what}`); }
  }
}

console.log(`\nrules mutations: ${MUTATIONS.length - problems} of ${MUTATIONS.length} behaved as specified`);
process.exit(problems === 0 ? 0 : 1);
