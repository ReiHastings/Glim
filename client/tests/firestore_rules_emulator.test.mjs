// title: firestore_rules_emulator.test.mjs
// project: Glim
// author: Reina Hastings
// contact: reinahastings13@gmail.com
// created: 2026-09-21
//
// purpose:
//   Behavioural test for firestore.rules. Loads the rules into the Firestore
//   emulator and attempts real reads and writes as different users, asserting
//   what the rules engine allows. The static firestore_rules.test.mjs checks
//   the file kept its shape; this one checks the rules do what they say.
//   Spec and the case table: docs/plan_stage1_rules.md Section 3.3.
//
//   Case 42 asserts CURRENT behaviour that is arguably a gap (a legacy invalid
//   row can never receive the syncedAt backfill), so that a later rules change
//   flips it visibly. Cases 23 and 54 pinned two other gaps until 2026-09-21,
//   when the rules closed them; they now assert the closed behaviour.
//
//   Cycle cases write at the document path equal to the row's id, because the
//   rules now require it; isolation comes from clearFirestore() before every
//   case, not from distinct paths.
//
// inputs:
//   FIRESTORE_EMULATOR_HOST  set by `firebase emulators:exec`; required
//   GLIM_RULES_FILE          optional path to a rules file (the mutation test
//                            uses this); default is the repo's firestore.rules,
//                            resolved against THIS file, never the cwd
//   GLIM_SHUFFLE             optional; any value runs the cases in random order
// outputs:
//   one line per check: `ok <nn> <name>` or `FAIL <nn> <name>` (the mutation
//   test parses these); exit 0 iff all 58 ran and passed; exit 3 if the rules
//   file failed to load (so a mutation that breaks compilation is
//   distinguishable from one that turns cases red)
//
// usage:
//   cd client && npx --yes firebase-tools@15.30.2 emulators:exec --only firestore --project demo-glim "node tests/firestore_rules_emulator.test.mjs"

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// --- Guards ------------------------------------------------------------------

// The port has one source, firebase.json, which the runner reads too.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = JSON.parse(readFileSync(path.resolve(HERE, '../../firebase.json'), 'utf8'))?.emulators?.firestore?.port;
const HOST = process.env.FIRESTORE_EMULATOR_HOST;
if (!Number.isInteger(PORT) || !HOST || !new RegExp(`^(127\\.0\\.0\\.1|localhost|\\[::1\\]):${PORT}$`).test(HOST)) {
  console.error(`FAIL this test must run inside \`firebase emulators:exec\` (FIRESTORE_EMULATOR_HOST=${HOST ?? 'unset'}; expected localhost:${PORT}). See the usage line in this file's header.`);
  process.exit(1);
}

const {
  initializeTestEnvironment, assertSucceeds, assertFails,
} = await import('@firebase/rules-unit-testing');
const {
  doc, getDoc, setDoc, deleteDoc, getDocs, collection, query, where,
  Timestamp, serverTimestamp,
} = await import('firebase/firestore');

// --- Constants ---------------------------------------------------------------

const EXPECTED_CHECKS = 58;
const PROJECT_ID = 'demo-glim';   // must match --project; demo- never reaches a real project
const RULES_FILE = process.env.GLIM_RULES_FILE
  ? path.resolve(process.env.GLIM_RULES_FILE)
  : path.resolve(HERE, '../../firestore.rules');

// Case 22 depends on '2026-09-21' sorting BELOW T as a string, which holds only
// because T shares that date prefix. Do not move T to another day without
// moving the malformed stamp in case 22 with it.
const T       = '2026-09-21T12:00:00.000Z';
const T_MINUS = '2026-09-21T11:59:59.000Z';
const T_PLUS  = '2026-09-21T12:00:01.000Z';

// Minimal valid payloads. steps-health has hasOnly and no hasAll, so id and
// syncedAt are permitted, not required. cycle has both.
const STEPS = { source: 'healthkit', date: '2026-09-01', steps: 12345, updatedAt: T };
const CYCLE = { id: '2026-09-01', date: '2026-09-01', flow: 'light', createdAt: T, updatedAt: T };

// --- Environment -------------------------------------------------------------

let env;
try {
  env = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { rules: readFileSync(RULES_FILE, 'utf8') },
  });
} catch (err) {
  console.error(`RULES FAILED TO LOAD from ${RULES_FILE}\n${err?.message ?? err}`);
  process.exit(3);
}

const alice = env.authenticatedContext('alice').firestore();
const bob   = env.authenticatedContext('bob').firestore();
const anon  = env.unauthenticatedContext().firestore();

const A = (coll, id) => `users/alice/${coll}/${id}`;
const seed = (docPath, data) =>
  env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), docPath), data));

// --- Cases -------------------------------------------------------------------
// { n, name, expect: 'allow' | 'deny', seed?: async () => {}, op: () => Promise }

const cases = [
  // Ownership
  { n: 1,  name: 'alice gets her user document', expect: 'allow', op: () => getDoc(doc(alice, 'users/alice')) },
  { n: 2,  name: "bob gets alice's user document", expect: 'deny', op: () => getDoc(doc(bob, 'users/alice')) },
  { n: 3,  name: "anon gets alice's user document", expect: 'deny', op: () => getDoc(doc(anon, 'users/alice')) },
  { n: 4,  name: 'anon creates under alice', expect: 'deny', op: () => setDoc(doc(anon, A('water', 'c04')), { a: 1 }) },
  { n: 5,  name: 'alice creates a water entry', expect: 'allow', op: () => setDoc(doc(alice, A('water', 'c05')), { a: 1 }) },
  { n: 6,  name: 'bob creates under alice', expect: 'deny', op: () => setDoc(doc(bob, A('water', 'c06')), { a: 1 }) },
  { n: 7,  name: 'alice gets her own entry', expect: 'allow', seed: () => seed(A('water', 'c07'), { a: 1 }), op: () => getDoc(doc(alice, A('water', 'c07'))) },
  { n: 8,  name: "bob gets alice's entry", expect: 'deny', seed: () => seed(A('water', 'c08'), { a: 1 }), op: () => getDoc(doc(bob, A('water', 'c08'))) },
  { n: 9,  name: 'alice lists her symptoms', expect: 'allow', op: () => getDocs(collection(alice, 'users/alice/symptoms')) },
  { n: 10, name: "bob lists alice's symptoms", expect: 'deny', op: () => getDocs(collection(bob, 'users/alice/symptoms')) },
  { n: 11, name: 'alice runs the sync-shaped where(syncedAt > Timestamp) query', expect: 'allow',
    op: () => getDocs(query(collection(alice, 'users/alice/symptoms'), where('syncedAt', '>', Timestamp.fromMillis(0)))) },
  { n: 12, name: 'alice writes two segments deeper than a data document (catch-all)', expect: 'deny', op: () => setDoc(doc(alice, A('water', 'c12') + '/x/y'), { a: 1 }) },
  { n: 13, name: 'alice writes a top-level collection (catch-all)', expect: 'deny', op: () => setDoc(doc(alice, 'other/c13'), { a: 1 }) },
  { n: 14, name: 'alice reads a top-level collection (catch-all)', expect: 'deny', op: () => getDoc(doc(alice, 'other/c14')) },
  { n: 15, name: 'alice deletes her own entry', expect: 'allow', seed: () => seed(A('water', 'c15'), { a: 1 }), op: () => deleteDoc(doc(alice, A('water', 'c15'))) },
  { n: 16, name: "bob deletes alice's entry", expect: 'deny', seed: () => seed(A('water', 'c16'), { a: 1 }), op: () => deleteDoc(doc(bob, A('water', 'c16'))) },

  // Monotonicity (symptoms is a mutable collection with no field validator)
  { n: 17, name: 'stale update (T-1s over T) is refused', expect: 'deny', seed: () => seed(A('symptoms', 'c17'), { updatedAt: T }), op: () => setDoc(doc(alice, A('symptoms', 'c17')), { updatedAt: T_MINUS }) },
  { n: 18, name: 'idempotent re-push (T over T) succeeds', expect: 'allow', seed: () => seed(A('symptoms', 'c18'), { updatedAt: T }), op: () => setDoc(doc(alice, A('symptoms', 'c18')), { updatedAt: T }) },
  { n: 19, name: 'newer update (T+1s over T) succeeds', expect: 'allow', seed: () => seed(A('symptoms', 'c19'), { updatedAt: T }), op: () => setDoc(doc(alice, A('symptoms', 'c19')), { updatedAt: T_PLUS }) },
  { n: 20, name: 'existing row with no updatedAt can be updated', expect: 'allow', seed: () => seed(A('symptoms', 'c20'), { a: 1 }), op: () => setDoc(doc(alice, A('symptoms', 'c20')), { updatedAt: T }) },
  { n: 21, name: 'existing row with a garbage updatedAt can be repaired', expect: 'allow', seed: () => seed(A('symptoms', 'c21'), { updatedAt: 'garbage' }), op: () => setDoc(doc(alice, A('symptoms', 'c21')), { updatedAt: T }) },
  { n: 22, name: "malformed incoming stamp that sorts below T ('2026-09-21') is refused", expect: 'deny', seed: () => seed(A('symptoms', 'c22'), { updatedAt: T }), op: () => setDoc(doc(alice, A('symptoms', 'c22')), { updatedAt: '2026-09-21' }) },
  { n: 23, name: 'malformed incoming stamp that sorts ABOVE T is refused (gap closed 2026-09-21)', expect: 'deny', seed: () => seed(A('symptoms', 'c23'), { updatedAt: T }), op: () => setDoc(doc(alice, A('symptoms', 'c23')), { updatedAt: T + ' junk' }) },
  { n: 24, name: 'update carrying no updatedAt is allowed', expect: 'allow', seed: () => seed(A('symptoms', 'c24'), { updatedAt: T }), op: () => setDoc(doc(alice, A('symptoms', 'c24')), { a: 1 }) },
  { n: 25, name: 'write-once collection (water) is not gated on updatedAt', expect: 'allow', seed: () => seed(A('water', 'c25'), { updatedAt: T }), op: () => setDoc(doc(alice, A('water', 'c25')), { updatedAt: T_MINUS }) },
  { n: 26, name: 'delete in a mutable collection is not gated', expect: 'allow', seed: () => seed(A('symptoms', 'c26'), { updatedAt: T }), op: () => deleteDoc(doc(alice, A('symptoms', 'c26'))) },

  // steps-health validator
  { n: 27, name: 'steps-health: minimal valid row', expect: 'allow', op: () => setDoc(doc(alice, A('steps-health', 'c27')), { ...STEPS }) },
  { n: 28, name: 'steps-health: id and syncedAt are permitted', expect: 'allow', op: () => setDoc(doc(alice, A('steps-health', 'c28')), { ...STEPS, id: 'c28', syncedAt: serverTimestamp() }) },
  { n: 29, name: 'steps-health: zero steps is valid', expect: 'allow', op: () => setDoc(doc(alice, A('steps-health', 'c29')), { ...STEPS, steps: 0 }) },
  { n: 30, name: 'steps-health: non-integral steps refused', expect: 'deny', op: () => setDoc(doc(alice, A('steps-health', 'c30')), { ...STEPS, steps: 1000.5 }) },
  { n: 31, name: 'steps-health: negative steps refused', expect: 'deny', op: () => setDoc(doc(alice, A('steps-health', 'c31')), { ...STEPS, steps: -1 }) },
  { n: 32, name: 'steps-health: extra field refused', expect: 'deny', op: () => setDoc(doc(alice, A('steps-health', 'c32')), { ...STEPS, mood: 'x' }) },
  { n: 33, name: 'steps-health: unknown source refused', expect: 'deny', op: () => setDoc(doc(alice, A('steps-health', 'c33')), { ...STEPS, source: 'fitbit' }) },
  { n: 34, name: 'steps-health: missing source refused', expect: 'deny', op: () => { const { source: _s, ...rest } = STEPS; return setDoc(doc(alice, A('steps-health', 'c34')), rest); } },
  { n: 35, name: 'steps-health: malformed date refused', expect: 'deny', op: () => setDoc(doc(alice, A('steps-health', 'c35')), { ...STEPS, date: '2026-9-1' }) },
  { n: 36, name: 'steps-health: malformed updatedAt refused', expect: 'deny', op: () => setDoc(doc(alice, A('steps-health', 'c36')), { ...STEPS, updatedAt: 'yesterday' }) },

  // Composition: validators and monotonicity apply TOGETHER
  { n: 37, name: 'composition: field-valid but stale steps-health write refused', expect: 'deny', seed: () => seed(A('steps-health', 'c37'), { ...STEPS }), op: () => setDoc(doc(alice, A('steps-health', 'c37')), { ...STEPS, updatedAt: T_MINUS }) },
  { n: 38, name: 'composition: newer but field-invalid steps-health write refused', expect: 'deny', seed: () => seed(A('steps-health', 'c38'), { ...STEPS }), op: () => setDoc(doc(alice, A('steps-health', 'c38')), { ...STEPS, updatedAt: T_PLUS, mood: 'x' }) },
  { n: 39, name: 'composition: field-valid but stale cycle write refused', expect: 'deny', seed: () => seed(A('cycle', CYCLE.id), { ...CYCLE }), op: () => setDoc(doc(alice, A('cycle', CYCLE.id)), { ...CYCLE, updatedAt: T_MINUS }) },
  { n: 40, name: 'composition: newer but field-invalid cycle write refused', expect: 'deny', seed: () => seed(A('cycle', CYCLE.id), { ...CYCLE }), op: () => setDoc(doc(alice, A('cycle', CYCLE.id)), { ...CYCLE, updatedAt: T_PLUS, flow: 'flood' }) },
  { n: 41, name: 'merge write of syncedAt only onto a valid cycle row (the backfill shape)', expect: 'allow', seed: () => seed(A('cycle', CYCLE.id), { ...CYCLE }), op: () => setDoc(doc(alice, A('cycle', CYCLE.id)), { syncedAt: serverTimestamp() }, { merge: true }) },
  { n: 42, name: 'BEHAVIOUR: the same backfill onto a field-invalid legacy row is refused', expect: 'deny', seed: () => seed(A('cycle', CYCLE.id), { ...CYCLE, id: 'x' }), op: () => setDoc(doc(alice, A('cycle', CYCLE.id)), { syncedAt: serverTimestamp() }, { merge: true }) },

  // cycle validator
  { n: 43, name: 'cycle: minimal valid row', expect: 'allow', op: () => setDoc(doc(alice, A('cycle', CYCLE.id)), { ...CYCLE }) },
  { n: 44, name: 'cycle: optional fields accepted', expect: 'allow', op: () => setDoc(doc(alice, A('cycle', CYCLE.id)), { ...CYCLE, note: null, isPeriodStart: true, deletedAt: null }) },
  { n: 45, name: 'cycle: id differing from date refused (written at path x, so only id == date decides)', expect: 'deny', op: () => setDoc(doc(alice, A('cycle', 'x')), { ...CYCLE, id: 'x' }) },
  { n: 46, name: 'cycle: malformed date refused (id == date == path, so only the regex decides)', expect: 'deny', op: () => setDoc(doc(alice, A('cycle', '2026-9-1')), { ...CYCLE, id: '2026-9-1', date: '2026-9-1' }) },
  { n: 47, name: 'cycle: unknown flow refused', expect: 'deny', op: () => setDoc(doc(alice, A('cycle', CYCLE.id)), { ...CYCLE, flow: 'flood' }) },
  { n: 48, name: 'cycle: missing createdAt refused', expect: 'deny', op: () => { const { createdAt: _c, ...rest } = CYCLE; return setDoc(doc(alice, A('cycle', CYCLE.id)), rest); } },
  { n: 49, name: 'cycle: extra field refused', expect: 'deny', op: () => setDoc(doc(alice, A('cycle', CYCLE.id)), { ...CYCLE, mood: 'x' }) },
  { n: 50, name: 'cycle: 501-character note refused', expect: 'deny', op: () => setDoc(doc(alice, A('cycle', CYCLE.id)), { ...CYCLE, note: 'n'.repeat(501) }) },
  { n: 51, name: 'cycle: non-boolean isPeriodStart refused', expect: 'deny', op: () => setDoc(doc(alice, A('cycle', CYCLE.id)), { ...CYCLE, isPeriodStart: 'yes' }) },
  { n: 52, name: 'cycle: malformed createdAt refused', expect: 'deny', op: () => setDoc(doc(alice, A('cycle', CYCLE.id)), { ...CYCLE, createdAt: 'garbage' }) },
  { n: 53, name: 'cycle: bob cannot write a valid row under alice', expect: 'deny', op: () => setDoc(doc(bob, A('cycle', CYCLE.id)), { ...CYCLE }) },
  { n: 54, name: 'cycle: a valid row at a document path that differs from its id field is refused (gap closed 2026-09-21)', expect: 'deny', op: () => setDoc(doc(alice, A('cycle', 'zzz')), { ...CYCLE }) },

  // Auth edges
  { n: 55, name: "anon lists alice's symptoms", expect: 'deny', op: () => getDocs(collection(anon, 'users/alice/symptoms')) },
  { n: 56, name: "anon deletes alice's entry", expect: 'deny', seed: () => seed(A('water', 'c56'), { a: 1 }), op: () => deleteDoc(doc(anon, A('water', 'c56'))) },
  { n: 57, name: 'alice creates her user document', expect: 'allow', op: () => setDoc(doc(alice, 'users/alice'), { createdAt: T }) },
  { n: 58, name: 'a CREATE carrying a malformed updatedAt is refused in a mutable collection', expect: 'deny', op: () => setDoc(doc(alice, A('symptoms', 'c58')), { updatedAt: 'garbage' }) },
];

// --- Run ---------------------------------------------------------------------

if (process.env.GLIM_SHUFFLE) {
  for (let i = cases.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [cases[i], cases[j]] = [cases[j], cases[i]];
  }
}

let passed = 0, failed = 0, executed = 0;
for (const c of cases) {
  const tag = `${String(c.n).padStart(2, '0')} ${c.name}`;
  try {
    await env.clearFirestore();          // every case starts from an empty database
    if (c.seed) await c.seed();
    await (c.expect === 'allow' ? assertSucceeds(c.op()) : assertFails(c.op()));
    passed++; console.log(`ok ${tag}`);
  } catch (err) {
    // The reason goes AFTER the tag so the mutation harness's `^FAIL <nn> `
    // parse is unaffected. It separates "the rules allowed it" from "denied"
    // from "the emulator was unreachable".
    const why = String(err?.message ?? err).split('\n')[0].slice(0, 160);
    failed++; console.log(`FAIL ${tag} (expected ${c.expect}; ${why})`);
  }
  executed++;
}

await env.cleanup();

if (executed !== EXPECTED_CHECKS || new Set(cases.map((c) => c.n)).size !== EXPECTED_CHECKS) {
  console.log(`FAIL 00 expected ${EXPECTED_CHECKS} distinct checks, executed ${executed}`);
  failed++;
}
console.log(`\nfirestore rules (emulator): ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
