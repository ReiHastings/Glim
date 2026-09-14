// title: sync_scenarios.test.mjs
// project: Glim
// author: Reina Hastings
// contact: reinahastings13@gmail.com
//
// purpose:
//   Deterministic simulations of the sync-layer smoke tests, running the REAL
//   syncWater merge code against an in-memory Firestore mock. Covers what the
//   browser smoke tests target for the data layer but which cannot be exercised
//   headlessly against live Firestore:
//     S2 - an undone (soft-deleted) bottle does not reappear after a sync pull
//     S3 - an undo propagates cross-device (device B receives the soft-delete)
//     S6 - a returning user's real config survives an account switch (M1)
//   The real browser/auth/eviction paths still require a manual pass.
//
// usage:
//   cd client && node --import ./tests/register-sync-mocks.mjs tests/sync_scenarios.test.mjs

// --- Environment shims (set before importing the source) ---
let mem = new Map();                        // active "device" localStorage; swapped per device
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => { mem.set(k, String(v)); },
  removeItem: (k) => { mem.delete(k); },
  clear: () => mem.clear(),
  key: (i) => [...mem.keys()][i] ?? null,
  get length() { return mem.size; },
};
globalThis.window = { dispatchEvent: () => {} };   // notify() dispatches a CustomEvent
if (typeof globalThis.CustomEvent === 'undefined') {
  globalThis.CustomEvent = class { constructor(type, opts) { this.type = type; Object.assign(this, opts); } };
}

import * as FS from './mocks/firestore.mock.mjs';
const sync = await import('../src/sync.js');
const { syncWater } = sync.__test;

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.error(`  FAIL ${name}`); }
}

const iso = (ms) => new Date(ms).toISOString();
const EPOCH = iso(0);
const getWater = () => JSON.parse(mem.get('glim-water'));
const activeCount = (w) => w.entries.filter(e => !e.deletedAt).length;
function setWater(entries, cfg = {}) {
  mem.set('glim-water', JSON.stringify({
    entries,
    bottleOz: cfg.bottleOz ?? 24,
    goal: cfg.goal ?? 6,
    configUpdatedAt: cfg.configUpdatedAt ?? EPOCH,
  }));
}
// Any deletedAt changes the row's marker (spec R15), so the push picks it up;
// there is no watermark to clear since 2026-09-13.
const afterPush = () => iso(Date.now());

// ===== S2: an undone bottle does not reappear after a sync =====
FS.__reset(); mem = new Map();
setWater([{ id: 'w1', timestamp: Date.now(), bottleOz: 24 }]);
await syncWater('A');
check('S2: entry pushed to Firestore', FS.__has('users/A/water/w1'));

const w = getWater(); w.entries[0].deletedAt = afterPush(); mem.set('glim-water', JSON.stringify(w));
await syncWater('A');
check('S2: soft-delete pushed to Firestore', !!FS.__get('users/A/water/w1')?.deletedAt);
await syncWater('A');   // another full cycle - the pull must not resurrect it
check('S2: entry stays soft-deleted locally (no reappear)', !!getWater().entries[0].deletedAt);
check('S2: active count is 0 after undo', activeCount(getWater()) === 0);

// ===== S3: undo propagates cross-device =====
FS.__reset();
const mapA = new Map(), mapB = new Map();
mem = mapA; setWater([{ id: 'x1', timestamp: Date.now(), bottleOz: 24 }]);
await syncWater('SHARED');                       // A pushes x1
mem = mapB; setWater([]);
await syncWater('SHARED');                       // B pulls x1
check('S3: device B pulled the entry', getWater().entries.some(e => e.id === 'x1' && !e.deletedAt));

mem = mapA;
{ const wa = getWater(); wa.entries.find(e => e.id === 'x1').deletedAt = afterPush(); mem.set('glim-water', JSON.stringify(wa)); }
await syncWater('SHARED');                       // A pushes the soft-delete
mem = mapB;
await syncWater('SHARED');                       // B pulls the soft-delete
const bx = getWater().entries.find(e => e.id === 'x1');
check('S3: device B received the soft-delete', !!bx?.deletedAt);
check('S3: device B active count is 0', activeCount(getWater()) === 0);

// ===== S6: config survives an account switch (M1) =====
FS.__reset(); mem = new Map();
FS.__seed('users/B/water-config/current', { bottleOz: 32, goal: 9, configUpdatedAt: iso(Date.now()) });
// Shared browser just switched to B: cleared/default local store (epoch config = the M1 fix)
setWater([], { bottleOz: 24, goal: 6, configUpdatedAt: EPOCH });
await syncWater('B');
const wb = getWater();
check('S6: local adopts remote goal (not default 6)', wb.goal === 9);
check('S6: local adopts remote bottleOz (not default 24)', wb.bottleOz === 32);
check('S6: remote config not clobbered by the default', FS.__get('users/B/water-config/current').goal === 9);

// The run-generation guard (Decision Register 2026-09-10) must never fire on a
// live session. These scenarios never call startSync/stopSync, so a skip here
// means a domain function captured its generation AFTER an await.
check('no stale-run skips across the suite', sync.__test.staleSkips() === 0);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
