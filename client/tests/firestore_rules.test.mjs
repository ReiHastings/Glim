// title: firestore_rules.test.mjs
// project: Glim
// author: Reina Hastings
// contact: reinahastings13@gmail.com
//
// purpose:
//   Static-structure test for firestore.rules (no emulator; the emulator run is
//   the deploy gate, this is the "did the file keep its shape" gate). Locks the
//   property that made the first draft of the monotonicity backstop a no-op:
//   Firestore grants a request if ANY matching allow statement is true, so a
//   recursive {document=**} ownership rule under /users alongside the specific
//   per-collection rule granted every write the specific rule denied. Asserts
//   exactly one rule matches a Glim data path, that the five mutable collections
//   are the ones gated, that the gate applies to create/update and not delete,
//   and that the comparison is >= (idempotent re-push must succeed).
//
// usage:
//   cd client && node tests/firestore_rules.test.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here  = dirname(fileURLToPath(import.meta.url));
const rules = readFileSync(join(here, '../../firestore.rules'), 'utf8');

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.error(`  FAIL ${name}`); }
}

check('rules_version is 2 (recursive wildcards match zero-or-more segments)',
  /rules_version = '2'/.test(rules));

// --- No overlapping match under /users ---
const userMatches = rules.match(/match \/users\/[^\s{]*/g) || [];
check('no recursive {document=**} rule under /users',
  !/match \/users\/\{userId\}\/\{document=\*\*\}/.test(rules));
check('exactly two match blocks under /users (the user doc, and one data level)',
  userMatches.length === 2);
check('the user document itself has a rule (ensureUserDocument writes it)',
  /match \/users\/\{userId\} \{/.test(rules));
check('every data document is matched by the single-level rule',
  /match \/users\/\{userId\}\/\{collectionId\}\/\{docId\} \{/.test(rules));

// --- The gate ---
const MUTABLE = ['nutrition-library', 'symptoms', 'symptoms-library', 'symptom-categories', 'symptom-days', 'steps-health', 'cycle'];
const isMutableBody = rules.slice(rules.indexOf('function isMutable'), rules.indexOf('}', rules.indexOf('function isMutable')));
for (const c of MUTABLE) check(`isMutable lists '${c}'`, isMutableBody.includes(`'${c}'`));
check('isMutable lists nothing else',
  (isMutableBody.match(/'[a-z-]+'/g) || []).length === MUTABLE.length);

const dataBlock = rules.slice(rules.indexOf('match /users/{userId}/{collectionId}/{docId}'));
check('create and update are gated on the mutable check',
  /allow create, update: if isOwner\(userId\)\s*&& \(!isMutable\(collectionId\) \|\| updatedAtNotRegressing\(\)\)/.test(dataBlock));
// --- steps-health field validation (2026-09-17) ---
// Static only: this suite reads the rules TEXT; nothing here can evaluate a
// rules expression (there is no emulator, see README). The behavioral gate is
// the manual device write plus a deliberately malformed console write, both
// recorded in the Phase 2 handoff spec Section 9.2.
check('steps-health writes are gated on the field validator',
  /&& \(collectionId != 'steps-health' \|\| stepsHealthValid\(\)\)/.test(dataBlock));
const validator = rules.slice(rules.indexOf('function stepsHealthValid'), rules.indexOf('\n    }', rules.indexOf('function stepsHealthValid')));
check('the validator exists', validator.length > 0);
for (const [name, re] of [
  ['source is restricted to the two known platforms', /source in \['healthkit', 'health_connect'\]/],
  ['steps must be a non-negative integer',            /steps is int && .*steps >= 0/],
  ['date must be YYYY-MM-DD',                         /date\.matches\('\^\[0-9\]\{4\}-\[0-9\]\{2\}-\[0-9\]\{2\}\$'\)/],
  ['updatedAt must be an ISO stamp',                  /isIsoStamp\(d\.updatedAt\)/],
  ['no unexpected fields are accepted',               /keys\(\)\.hasOnly\(/],
]) check(`validator: ${name}`, re.test(validator));

check('delete is ownership-only (request.resource is null on delete)',
  /allow delete: if isOwner\(userId\);/.test(dataBlock));
check('no bare "allow write" remains on the data path',
  !/allow (read, )?write/.test(dataBlock.slice(0, dataBlock.indexOf('match /{document=**}'))));

// The global catch-all also matches every data path, and Firestore grants on
// ANY true allow. If it were ever loosened to `request.auth != null`, every
// signed-in user could read and write every other user's subtree, and the
// monotonicity gate above would be bypassed. It must deny unconditionally.
const catchAll = rules.slice(rules.indexOf('match /{document=**}'));
check('the global catch-all denies unconditionally (if false)',
  /allow read, write: if false;/.test(catchAll));

// --- The comparison ---
check('comparison is >= so an idempotent re-push succeeds',
  /request\.resource\.data\.updatedAt >= resource\.data\.updatedAt/.test(rules));
check('a corrupt existing stamp does not block repair',
  /!isIsoStamp\(resource\.data\.updatedAt\)/.test(rules));
check('missing updatedAt on either side is allowed through',
  /!\('updatedAt' in resource\.data\)/.test(rules) &&
  /!\('updatedAt' in request\.resource\.data\)/.test(rules));

// The probe character is computed, not written literally, so this file itself
// stays free of it.
check('no em dash in the rules file', !rules.includes(String.fromCharCode(0x2014)));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
