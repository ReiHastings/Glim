// title: water_softdelete.test.mjs
// project: Glim
// author: Reina Hastings
// contact: reinahastings13@gmail.com
//
// purpose:
//   Standalone invariant tests (no framework) for the water soft-delete work and
//   the water config default. Drives the REAL useWaterStore via a dynamic import
//   over a minimal localStorage shim. Guards Fix 2 (soft-delete round-trip,
//   selector arithmetic, distinct ids, no entry loss) and Fix 1 M1 (fresh config
//   defaults to epoch so it cannot clobber a returning user's real remote config).
//
// usage:
//   cd client && node --import ./tests/register-hooks.mjs tests/water_softdelete.test.mjs

// --- Minimal localStorage shim (Node has none). Must exist before the store is
//     imported, so the import is dynamic (below) rather than static/hoisted. ---
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => { mem.set(k, String(v)); },
  removeItem: (k) => { mem.delete(k); },
  clear: () => mem.clear(),
  key: (i) => [...mem.keys()][i] ?? null,
  get length() { return mem.size; },
};

// --- Tiny assert harness ---
let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.error(`  FAIL ${name}`); }
}

const { useWaterStore } = await import('../src/stores/useWaterStore.js');
const EPOCH = new Date(0).toISOString();
const state = () => useWaterStore.getState();

function reset() {
  localStorage.removeItem('glim-water');
  state().reload();
}

// --- Fix 1 / M1: fresh or cleared store defaults configUpdatedAt to epoch ---
reset();
check('M1: fresh water configUpdatedAt is epoch (not now)', state().configUpdatedAt === EPOCH);
state().setGoal(8);
check('M1: a real config edit stamps a post-epoch time', new Date(state().configUpdatedAt) > new Date(0));

// --- Fix 2 / T1: soft-delete round-trip ---
reset();
state().logBottle();
check('log adds one entry', state().entries.length === 1);
check('getToday is 1 after one log', state().getToday() === 1);
state().undoLast();
check('T1: entry retained after undo (soft-delete, not removed)', state().entries.length === 1);
check('T1: undone entry carries deletedAt', !!state().entries[0].deletedAt);
check('T1: getToday is 0 after undo', state().getToday() === 0);

// --- Fix 2 / T2 + T5: selector invariant and no entry loss ---
reset();
state().logBottle();
state().logBottle();
state().logBottle();
state().undoLast();
const s = state();
const nonDeleted = s.entries.filter(e => !e.deletedAt).length;
check('T2: getToday === non-deleted entry count (and equals 2)', s.getToday() === nonDeleted && s.getToday() === 2);
check('T5: entry array does not shrink on undo (soft-delete)', s.entries.length === 3);

// --- Fix 2 / T3: distinct ids + a single undo deletes exactly one ---
reset();
state().logBottle();
state().logBottle();
const ids = state().entries.map(e => e.id);
check('T3: two logs get distinct ids', ids[0] !== ids[1] && ids.every(Boolean));
state().undoLast();
check('T3: a single undo soft-deletes exactly one entry', state().entries.filter(e => e.deletedAt).length === 1);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
