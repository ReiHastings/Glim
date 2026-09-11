// title: sync_stale_run.test.mjs
// project: Glim
// author: Reina Hastings
// contact: reinahastings13@gmail.com
// date created: 2026-09-10
//
// purpose:
//   Acceptance test for the handoff item "Guard in-flight sync runs against
//   sign-out and account switch" (discovered 2026-09-08; Decision Register
//   2026-09-10). A syncAll that is already in flight when the session ends must
//   perform NO write afterwards: no localSet (that is how the previous user's
//   rows reach the next user's localStorage), no notify (which would reload
//   them into Zustand memory), and no setDoc (the mock enforces no ownership
//   rules, so it must be asserted here).
//
//   Drives the REAL startSync / stopSync / syncAll against the in-memory
//   Firestore mock, holding one awaited call open with the mock's gates:
//     R1  - stale run (mutable domain): session ends while the symptoms pull is
//           blocked; after release, glim-symptoms and glim-sync-meta are
//           untouched, no document was written, no reload event fired.
//     R1b - live-B variant: B signs in and B's sync RUNS while A's stale pull is
//           still blocked; after release, none of A's rows are in B's
//           localStorage or under users/B, and B's own row is present (B's run
//           was not discarded).
//     R2  - negative control: same run as R1 with the session still live; the
//           pulled row lands on disk and the local-only row is pushed. Proves
//           the gates and assertions have teeth.
//     R3  - stale run (write-once domain): the water pull is held; after
//           release, no glim-water write, no glim-sync-meta write, no setDoc.
//     R4  - mid-loop: the FIRST push of a two-row mutable run is held with the
//           write gate (a dispatched write cannot be recalled, so it lands);
//           session ends; the loop's next iteration must not write the second.
//     R5  - singletons: pokes and settings reads are held with the doc-read
//           gate; session ends; neither glim-pokes nor glim-settings is written.
//     R6  - non-regression: two overlapping syncAll under one live session both
//           complete, the final state equals a single run's, and staleSkips is 0.
//     R7  - flushSync (tab-hide): its first push is held; account switch; the
//           remaining three pushes must not run (they would read the NEXT user's
//           rows and push them under the previous uid).
//     R8  - same-user sign-out and sign-in with a run held across it: the held
//           run is discarded (uids match; generations do not).
//   The test uses the public API only (startSync, stopSync, syncAll), so it is
//   indifferent to HOW the guard is implemented.
//
// usage:
//   cd client && node --import ./tests/register-sync-mocks.mjs tests/sync_stale_run.test.mjs

// --- Environment shims (set before importing the source) ---
let mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => { mem.set(k, String(v)); },
  removeItem: (k) => { mem.delete(k); },
  clear: () => mem.clear(),
  key: (i) => [...mem.keys()][i] ?? null,
  get length() { return mem.size; },
};
let dispatched = 0;                   // notify() -> window.dispatchEvent
globalThis.window = { dispatchEvent: () => { dispatched++; } };
// startSync registers a visibilitychange handler; stopSync removes it.
globalThis.document = { hidden: false, addEventListener: () => {}, removeEventListener: () => {} };
if (typeof globalThis.CustomEvent === 'undefined') {
  globalThis.CustomEvent = class { constructor(type, opts) { this.type = type; Object.assign(this, opts); } };
}
const origInfo = console.info;
console.info = () => {};              // the guard logs each discarded run; keep output readable

import * as FS from './mocks/firestore.mock.mjs';
const sync = await import('../src/sync.js');
const { startSync, stopSync, syncAll } = sync;

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.error(`  FAIL ${name}`); }
}

// Let every ungated domain finish its awaits. Relies on the mock resolving
// without timers: Node drains the whole microtask queue before running this
// macrotask, so one setTimeout(0) is enough. If the mock ever gains timer-based
// latency, this becomes a race and must await the domains explicitly.
const settle = () => new Promise(r => setTimeout(r, 0));

const iso = (ms) => new Date(ms).toISOString();
const row = (id, ms) => ({
  id, kind: 'point', date: '2026-09-01', createdAt: iso(ms), updatedAt: iso(ms), deletedAt: null,
  symptomId: 'sym1', intensity: 2, note: '',
});
const waterRow = (id, ms) => ({ id, timestamp: ms, oz: 24, deletedAt: null });

// Fixture: user A has one local-only symptom row (s2) and one remote-only row
// (s1). A live pull writes s1 to disk; a live push writes s2 to Firestore.
function seedUserA() {
  FS.__reset(); mem = new Map(); dispatched = 0;
  mem.set('glim-uid', 'A');
  mem.set('glim-symptoms', JSON.stringify({ logs: [row('s2', 2_000)] }));
  FS.__seed('users/A/symptoms/s1', row('s1', 1_000));
}

// A gate that blocks exactly one path and lets everything else through.
// Returns { release, reached }: `reached` resolves when the blocked call arrives.
function hold(setter, blockedPath) {
  let release, arrive;
  const held    = new Promise(r => { release = r; });
  const reached = new Promise(r => { arrive = r; });
  setter((path) => { if (path === blockedPath) { arrive(); return held; } return undefined; });
  return { release, reached };
}

// Replicates the App.jsx UID-change guard's localStorage half.
function switchAccountTo(uid) {
  for (const k of [...mem.keys()]) if (k.startsWith('glim-') && k !== 'glim-uid') mem.delete(k);
  mem.set('glim-uid', uid);
}

const symptomIds = () => JSON.parse(mem.get('glim-symptoms') ?? '{"logs":[]}').logs.map(e => e.id);

// ===== R1: a run in flight at sign-out writes nothing =====
console.log('R1: stale run after stopSync (mutable domain)');
{
  seedUserA();
  const writes = [];
  FS.__setWriteHook((path) => { writes.push(path); });
  const { release } = hold(FS.__setReadGate, 'users/A/symptoms');

  startSync('A');                 // startup syncAll: 12 domains finish, symptoms blocks
  await settle();
  const writesBeforeStop = writes.length;
  const eventsBeforeStop = dispatched;

  stopSync();                     // sign-out
  switchAccountTo('B');           // App.jsx wipe; B signs in but sync is NOT started here

  release();                      // A's slow getDocs finally resolves
  await settle();

  check('R1: glim-symptoms not written by the stale run', !mem.has('glim-symptoms'));
  check('R1: glim-sync-meta not written by the stale run', !mem.has('glim-sync-meta'));
  check('R1: no Firestore write after stopSync', writes.length === writesBeforeStop);
  check('R1: nothing landed under users/A/symptoms', !FS.__has('users/A/symptoms/s2'));
  check('R1: no reload event after stopSync', dispatched === eventsBeforeStop);
  check('R1: glim-uid still B', mem.get('glim-uid') === 'B');
  FS.__clearHooks();
}

// ===== R1b: B's sync is LIVE while A's stale pull resolves =====
console.log('R1b: stale A run resolves while B is live');
{
  seedUserA();
  FS.__seed('users/B/symptoms/b1', row('b1', 3_000));
  const { release } = hold(FS.__setReadGate, 'users/A/symptoms');

  startSync('A');
  await settle();

  stopSync();
  switchAccountTo('B');
  startSync('B');                 // B's startup sync runs to completion (users/B is ungated)
  await settle();

  release();                      // A's stale pull resolves into B's session
  await settle();
  await syncAll();                // B's NEXT sync: this is where a leaked row would be pushed under B

  const ids = symptomIds();
  check('R1b: B holds its own row b1', ids.includes('b1'));
  check('R1b: A\'s remote row s1 is NOT in B\'s localStorage', !ids.includes('s1'));
  check('R1b: A\'s local row s2 is NOT in B\'s localStorage', !ids.includes('s2'));
  check('R1b: after B\'s next sync, nothing of A\'s under users/B', !FS.__has('users/B/symptoms/s1') && !FS.__has('users/B/symptoms/s2'));
  stopSync();
  FS.__clearHooks();
}

// ===== R2: negative control - same run, session still live, must write =====
console.log('R2: live run (negative control)');
{
  seedUserA();
  const writes = [];
  FS.__setWriteHook((path) => { writes.push(path); });
  const { release } = hold(FS.__setReadGate, 'users/A/symptoms');

  startSync('A');
  await settle();
  const writesBeforeRelease = writes.length;
  const eventsBeforeRelease = dispatched;

  release();
  await settle();

  const ids = symptomIds();
  check('R2: pulled row s1 is on disk', ids.includes('s1'));
  check('R2: local row s2 survives', ids.includes('s2'));
  check('R2: local-only row s2 was pushed', FS.__has('users/A/symptoms/s2'));
  check('R2: a Firestore write happened after release', writes.length > writesBeforeRelease);
  check('R2: a reload event fired after release', dispatched > eventsBeforeRelease);
  stopSync();
  FS.__clearHooks();
}

// ===== R3: stale run on a WRITE-ONCE domain (water: pushEntries-style loop + pull) =====
console.log('R3: stale run after stopSync (write-once domain)');
{
  FS.__reset(); mem = new Map(); dispatched = 0;
  mem.set('glim-uid', 'A');
  mem.set('glim-water', JSON.stringify({ entries: [waterRow('w2', 2_000)], bottleOz: 24, goal: 6, configUpdatedAt: iso(0) }));
  FS.__seed('users/A/water/w1', waterRow('w1', 1_000));
  const writes = [];
  FS.__setWriteHook((path) => { writes.push(path); });
  const { release } = hold(FS.__setReadGate, 'users/A/water');

  startSync('A');
  await settle();
  const writesBeforeStop = writes.filter(p => p.startsWith('users/A/water')).length;

  stopSync();
  switchAccountTo('B');
  release();
  await settle();

  check('R3: glim-water not written by the stale run', !mem.has('glim-water'));
  check('R3: glim-sync-meta not written by the stale run', !mem.has('glim-sync-meta'));
  check('R3: no water or water-config write after stopSync',
    writes.filter(p => p.startsWith('users/A/water')).length === writesBeforeStop);
  FS.__clearHooks();
}

// ===== R4: session ends BETWEEN two pushes of one run =====
// The write gate sits inside the mock's setDoc, i.e. AFTER the guard for that
// row has already passed - exactly like a network write already dispatched,
// which no guard can recall. So the held row (s2) is expected to land. What the
// guard must prevent is the NEXT iteration: s3 must not be written.
console.log('R4: mid-loop stop (write gate on the first push)');
{
  FS.__reset(); mem = new Map(); dispatched = 0;
  mem.set('glim-uid', 'A');
  // Two local-only rows; finalDocs is sorted by createdAt, so s2 pushes before s3.
  mem.set('glim-symptoms', JSON.stringify({ logs: [row('s2', 2_000), row('s3', 3_000)] }));
  const { release, reached } = hold(FS.__setWriteGate, 'users/A/symptoms/s2');

  startSync('A');
  await reached;                  // s2's setDoc has been dispatched and is held
  check('R4: nothing written yet while the first push is held', !FS.__has('users/A/symptoms/s2') && !FS.__has('users/A/symptoms/s3'));

  stopSync();
  release();
  await settle();

  check('R4: the already-dispatched row s2 landed (cannot be recalled)', FS.__has('users/A/symptoms/s2'));
  check('R4: the NEXT row s3 was NOT written after the stop', !FS.__has('users/A/symptoms/s3'));
  FS.__clearHooks();
}

// ===== R5: singleton domains (getDoc path) =====
console.log('R5: stale run on singletons (doc-read gate)');
{
  FS.__reset(); mem = new Map(); dispatched = 0;
  mem.set('glim-uid', 'A');
  mem.set('glim-pokes', '3');
  mem.set('glim-settings', JSON.stringify({ wellness: 30, lastModified: iso(1_000) }));
  FS.__seed('users/A/pokes/counters', { total: 10, lastModified: iso(500) });     // remote wins -> would write local
  FS.__seed('users/A/settings/current', { wellness: 45, lastModified: iso(9_000) }); // remote newer -> would write local
  const heldPaths = new Set(['users/A/pokes/counters', 'users/A/settings/current']);
  let release;
  const held = new Promise(r => { release = r; });
  FS.__setDocReadGate((path) => (heldPaths.has(path) ? held : undefined));

  startSync('A');
  await settle();
  stopSync();
  switchAccountTo('B');
  release();
  await settle();

  check('R5: glim-pokes not written by the stale run', !mem.has('glim-pokes'));
  check('R5: glim-settings not written by the stale run', !mem.has('glim-settings'));
  FS.__clearHooks();
}

// ===== R6: overlapping live runs are NOT discarded =====
console.log('R6: two overlapping syncAll under one live session (non-regression)');
{
  seedUserA();
  const skipsBefore = sync.__test.staleSkips();
  startSync('A');                 // run 1 (startup)
  const second = syncAll();       // run 2, overlapping, same session
  await second;
  await settle();

  const ids = symptomIds();
  check('R6: both rows present after overlapping runs', ids.includes('s1') && ids.includes('s2'));
  check('R6: exactly two rows (no duplicate merge)', ids.length === 2);
  check('R6: local row pushed', FS.__has('users/A/symptoms/s2'));
  check('R6: no stale skips on a live session', sync.__test.staleSkips() === skipsBefore);
  stopSync();
  FS.__clearHooks();
}

// ===== R7: flushSync (tab-hide) - session ends during its FIRST push =====
// flushSync runs four pushEntries calls in sequence. The helper captures its own
// generation at entry, which for calls 2-4 is AFTER an await, so flushSync must
// capture and check itself. Found by the 2026-09-10 code review: without that,
// a held first push followed by an account switch made calls 2-4 read the NEXT
// user's rows and push them under the previous uid.
console.log('R7: flushSync stopped during its first push');
{
  FS.__reset(); mem = new Map(); dispatched = 0;
  mem.set('glim-uid', 'A');
  mem.set('glim-journal', JSON.stringify([{ id: 'j1', createdAt: iso(2_000), text: 'a', deletedAt: null }]));
  startSync('A');
  await settle();                 // startup sync done; journal j1 pushed and watermark advanced
  mem.set('glim-journal', JSON.stringify([{ id: 'j1', createdAt: iso(2_000), text: 'a', deletedAt: null },
                                          { id: 'j2', createdAt: iso(9_999_999_999_999), text: 'b', deletedAt: null }]));
  const { release, reached } = hold(FS.__setWriteGate, 'users/A/journal/j2');

  const flush = sync.flushSync(); // tab-hide path, first push (j2) held
  await reached;

  stopSync();
  switchAccountTo('B');
  // wB must be NEWER than A's waterPushedAt watermark (captured by the flush at
  // its start), otherwise the stale flush has nothing to push and the test is
  // vacuous - which is how its first version passed with the guard removed.
  mem.set('glim-water', JSON.stringify({ entries: [waterRow('wB', Date.now() + 60_000)], bottleOz: 24, goal: 6, configUpdatedAt: iso(0) }));
  startSync('B');                 // B's startup sync pushes wB under users/B
  await settle();

  release();
  await flush;

  check('R7: B\'s water row was NOT pushed under users/A by the stale flush', !FS.__has('users/A/water/wB'));
  check('R7: B\'s water row is under users/B (B\'s own run was live)', FS.__has('users/B/water/wB'));
  stopSync();
  FS.__clearHooks();
}

// ===== R8: same-user sign-out and sign-in while a run is held =====
// The counter's advantage over a uid comparison: uids match, generations do not.
console.log('R8: same-user re-sign-in during a held run');
{
  seedUserA();
  let arrivals = 0, release;
  const held = new Promise(r => { release = r; });
  FS.__setReadGate((path) => (path === 'users/A/symptoms' && ++arrivals === 1 ? held : undefined));

  startSync('A');                 // run 1: symptoms pull held
  await settle();
  stopSync();
  startSync('A');                 // same user again; App.jsx would NOT wipe localStorage
  await settle();                 // run 2 completes: s1 pulled, s2 pushed
  const eventsAfterRun2 = dispatched;
  const skipsBefore = sync.__test.staleSkips();

  release();                      // run 1 resolves under the new generation
  await settle();

  check('R8: run 2 (live) pulled s1', symptomIds().includes('s1'));
  check('R8: run 1 (stale) was discarded: one skip recorded', sync.__test.staleSkips() === skipsBefore + 1);
  check('R8: run 1 fired no reload event', dispatched === eventsAfterRun2);
  stopSync();
  FS.__clearHooks();
}

console.info = origInfo;
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
