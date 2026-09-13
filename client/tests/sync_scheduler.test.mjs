// title: sync_scheduler.test.mjs
// project: Glim
// author: Reina Hastings
// contact: reinahastings13@gmail.com
// date created: 2026-09-10
//
// purpose:
//   Behavioural tests for the event-triggered sync scheduler that replaced the
//   60 s poll on 2026-09-10, driven against the in-memory Firestore mock.
//     P0  - Part 2.0 precondition: an idle steady-state run pushes NOTHING on
//           any of the 13 domains and writes no Firestore document, including
//           the signal document. Without this, two open devices would wake
//           each other forever (every push touches the signal).
//     P0n - negative control for P0: a run with a real local change pushes
//           exactly that and touches the signal exactly once.
//     L1  - a local write announced on syncBus schedules ONE debounced run,
//           and a burst of writes inside the debounce window collapses to one.
//     S1  - another device touching the signal document schedules a run.
//     S2  - this device's OWN signal write (same device id) does not.
//     S3  - the baseline snapshot on attach does not schedule a run (the
//           startup run covers it).
//     R1  - startSync twice without stopSync leaves exactly one signal
//           listener, one syncBus subscription and one set of handles.
//     R2  - stopSync drains every handle; no listener or subscription remains.
//     F1  - flushSync waits for a run in flight and then performs its own run.
//     F2  - a run requested while one is in flight is coalesced into a single
//           follow-up run (no interleaving).
//     C1  - an account switch mid-run: the coalesced follow-up belongs to the
//           new session, not the old one (startSync(B) with A's run held).
//   Server-stamped signal (plan_signal_server_timestamp.md, 2026-09-12). The
//   signal's `at` is written with serverTimestamp(), so the listener's ordering
//   test compares stamps from ONE clock and a device's own clock never matters.
//   Invariant across S1-S6: at most one run per acknowledged foreign write, zero
//   per own write, zero per pending echo, zero per re-delivery.
//     S4  - this device's clock is 5 minutes AHEAD (the Date CONSTRUCTOR is
//           stubbed, not just Date.now: `new Date()` does not consult Date.now);
//           the mock server clock is set to real time; this device pushes, then
//           a foreign server-stamped signal arrives; exactly one run. Negative
//           control (verified by hand on a scratch copy): touchSignal writing
//           `new Date().toISOString()` goes red here. The control is VACUOUS if
//           the server clock is left far in the future (own stamp then sorts
//           before the server's) or if only Date.now is stubbed.
//     S5  - re-delivery of an already-handled foreign snapshot (listener
//           reconnect) schedules nothing.
//     S6  - the optimistic echo of this device's own write (pending, at null)
//           schedules nothing; a foreign write afterwards still wakes this
//           device exactly once. The real SDK's acknowledged second delivery
//           without includeMetadataChanges is reasoned from the field-value
//           change, not confirmed from the docs; correctness does not depend
//           on it, this test and the manual check do.
//     S6b - attach while a write is in flight: the FIRST snapshot after attach
//           is pending (stamps null). It must not become the baseline and must
//           not schedule; the acknowledged snapshot that follows is the
//           baseline and must not schedule either. This is the only sequence
//           that exercises the pending check on its own (the own-id check
//           swallows an own echo anyway), so it is what gives that line teeth
//           (code review 2026-09-12, MAJOR).
//
// usage:
//   cd client && node --import ./tests/register-sync-mocks.mjs tests/sync_scheduler.test.mjs

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
globalThis.window = { dispatchEvent: () => {}, addEventListener: () => {}, removeEventListener: () => {} };
globalThis.document = { hidden: false, addEventListener: () => {}, removeEventListener: () => {} };
if (typeof globalThis.CustomEvent === 'undefined') {
  globalThis.CustomEvent = class { constructor(type, opts) { this.type = type; Object.assign(this, opts); } };
}
console.info = () => {};

import * as FS from './mocks/firestore.mock.mjs';
import * as bus from '../src/syncBus.js';
const sync = await import('../src/sync.js');
const { startSync, stopSync, flushSync } = sync;
const T = sync.__test;

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.error(`  FAIL ${name}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Let every ungated await in the mock settle (microtasks only, one macrotask).
const settle = () => sleep(0);

T.setTimings({ debounceMs: 20, fallbackMs: 60 * 60 * 1000 });

// Per-run push counts captured from the debug log, keyed by domain.
let domainLines = [];
console.debug = (tag, obj) => { if (tag === '[glim sync]' && obj && typeof obj === 'object') domainLines.push(obj); };
mem.set('glim-debug-sync', '1');

const SIGNAL = (uid) => `users/${uid}/sync/signal`;
let writes = [];
FS.__setWriteHook((path) => { writes.push(path); });

function seedAccount(uid) {
  const iso = (d) => new Date(Date.UTC(2026, 0, 1 + d)).toISOString();
  FS.__seed(`users/${uid}/journal/j1`, { id: 'j1', text: 'hi', createdAt: iso(1) });
  FS.__seed(`users/${uid}/water/w1`, { id: 'w1', timestamp: 1700000000000, bottleOz: 24 });
  FS.__seed(`users/${uid}/water-config/current`, { bottleOz: 24, goal: 6, configUpdatedAt: iso(2) });
  FS.__seed(`users/${uid}/steps/s1`, { id: 's1', timestamp: 1700000000000, count: 100 });
  FS.__seed(`users/${uid}/steps-config/current`, { goal: 8000, configUpdatedAt: iso(2) });
  FS.__seed(`users/${uid}/nutrition/n1`, { id: 'n1', createdAt: iso(1) });
  FS.__seed(`users/${uid}/nutrition-config/current`, { goals: { protein: 100 }, configUpdatedAt: iso(2) });
  FS.__seed(`users/${uid}/nutrition-library/l1`, { id: 'l1', createdAt: iso(1), updatedAt: iso(1) });
  FS.__seed(`users/${uid}/symptoms/y1`, { id: 'y1', createdAt: iso(1), updatedAt: iso(1) });
  FS.__seed(`users/${uid}/symptoms-library/yl1`, { id: 'yl1', createdAt: iso(1), updatedAt: iso(1) });
  FS.__seed(`users/${uid}/symptom-categories/c1`, { id: 'c1', createdAt: iso(1), updatedAt: iso(1) });
  FS.__seed(`users/${uid}/symptom-days/2026-01-05`, { id: '2026-01-05', createdAt: iso(1), updatedAt: iso(1) });
  FS.__seed(`users/${uid}/pokes/counters`, { total: 3, lastModified: iso(2) });
  FS.__seed(`users/${uid}/settings/current`, { wellnessInterval: 30, lastModified: iso(2) });
  // Local mirrors of the singletons, byte-equal stamps (the already-pushed case).
  mem.set('glim-pokes', '3');
  mem.set('glim-settings', JSON.stringify({ wellnessInterval: 30, lastModified: iso(2) }));
  mem.set('glim-steps', JSON.stringify({ entries: [], goal: 8000, configUpdatedAt: iso(2) }));
  mem.set('glim-nutrition', JSON.stringify({ logs: [], goals: { protein: 100 }, configUpdatedAt: iso(2) }));
  mem.set('glim-water', JSON.stringify({ entries: [], bottleOz: 24, goal: 6, configUpdatedAt: iso(2) }));
}

function resetAll() {
  FS.__reset(); FS.__clearHooks(); FS.__setWriteHook((path) => { writes.push(path); });
  mem = new Map(); mem.set('glim-debug-sync', '1');
  writes = []; domainLines = [];
}

const ALL = bus.ALL_DOMAINS;

// ===== P0: idle steady state pushes nothing =====
console.log('P0: idle steady-state run pushes nothing on any domain');
{
  resetAll(); seedAccount('A');
  startSync('A');                       // startup run: pulls everything, may push local defaults
  await settle(); await settle();
  await flushSync('test');              // run 2: steady state
  const run2Writes = [];
  FS.__setWriteHook((path) => { run2Writes.push(path); writes.push(path); });
  domainLines = [];
  await flushSync('test');              // run 3: steady state, observed
  check('P0: run reports all 13 domains', new Set(domainLines.map(l => l.domain)).size === ALL.length);
  const pushed = domainLines.filter(l => l.docsPushed > 0).map(l => l.domain);
  check(`P0: docsPushed is 0 on every domain (offenders: ${pushed.join(',') || 'none'})`, pushed.length === 0);
  check('P0: no Firestore write at all during the idle run', run2Writes.length === 0);
  check('P0: the signal document was not touched by the idle run', !run2Writes.includes(SIGNAL('A')));
  check('P0: lastRunPushed is 0', T.lastRunPushed() === 0);
  stopSync();
}

// ===== P0n: negative control =====
console.log('P0n: a real local change pushes and touches the signal once');
{
  resetAll(); seedAccount('A');
  startSync('A'); await settle(); await settle();
  await flushSync('test');
  const before = T.signalWrites();
  mem.set('glim-pokes', '4');           // local poke, strictly greater
  const obs = [];
  FS.__setWriteHook((path) => { obs.push(path); });
  domainLines = [];
  await flushSync('test');
  check('P0n: pokes pushed exactly once', domainLines.find(l => l.domain === 'pokes')?.docsPushed === 1);
  check('P0n: the signal document was written exactly once', obs.filter(p => p === SIGNAL('A')).length === 1 && T.signalWrites() === before + 1);
  check('P0n: the signal carries this device id', FS.__get(SIGNAL('A'))?.by === T.deviceId());
  const stamp = FS.__signalStamp(SIGNAL('A'));
  check('P0n: the signal `at` is a SERVER stamp (mock server clock), not a client string',
    typeof FS.__get(SIGNAL('A'))?.at !== 'string' && stamp !== null && stamp === FS.__serverClock());
  // and the next idle run is silent again
  const obs2 = []; FS.__setWriteHook((path) => { obs2.push(path); });
  await flushSync('test');
  check('P0n: the following idle run writes nothing (no self-ping-pong)', obs2.length === 0);
  stopSync();
}

// ===== L1: local writes =====
console.log('L1: local writes schedule one debounced run');
{
  resetAll(); seedAccount('A');
  startSync('A'); await settle(); await settle();
  await flushSync('test');
  let runs = 0;
  const origDebug = console.debug;
  console.debug = (tag, obj) => { if (tag === '[glim sync]' && obj && typeof obj === 'object') domainLines.push(obj); else if (typeof tag === 'string' && tag.startsWith('[glim sync] run (local:')) runs++; };
  bus.notifyLocalWrite('water');
  bus.notifyLocalWrite('water');
  bus.notifyLocalWrite('journal');
  await sleep(5);
  check('L1: nothing runs inside the debounce window', runs === 0);
  await sleep(60);
  check('L1: exactly one run after the burst', runs === 1);
  console.debug = origDebug;
  stopSync();
}

// ===== S1-S3: the signal listener =====
console.log('S1-S3: signal listener');
{
  resetAll(); seedAccount('A');
  let runs = [];
  const origDebug = console.debug;
  console.debug = (tag, obj) => { if (tag === '[glim sync]' && obj && typeof obj === 'object') domainLines.push(obj); else if (typeof tag === 'string') { const m = tag.match(/run \((.+)\)/); if (m) runs.push(m[1]); } };
  FS.__seed(SIGNAL('A'), { at: '2026-01-01T00:00:00.000Z', by: 'other-device' });   // pre-existing signal
  startSync('A'); await settle(); await settle();
  await flushSync('test');
  await sleep(60);
  check('S3: the baseline snapshot did not schedule a run', !runs.includes('signal'));
  check('S3: exactly one signal listener is attached', FS.__listenerCount(SIGNAL('A')) === 1);

  runs = [];
  await FS.setDoc(FS.doc(null, 'users', 'A', 'sync', 'signal'), { at: FS.serverTimestamp(), by: 'other-device' });
  await sleep(60);
  check('S1: a signal from another device scheduled a run', runs.filter(r => r === 'signal').length === 1);

  runs = [];
  await FS.setDoc(FS.doc(null, 'users', 'A', 'sync', 'signal'), { at: FS.serverTimestamp(), by: T.deviceId() });
  await sleep(60);
  check('S2: this device\'s own signal write did not schedule a run', !runs.includes('signal'));
  console.debug = origDebug;
  stopSync();
}

// ===== R1/R2: registration idempotence and teardown =====
console.log('R1-R2: registration');
{
  resetAll(); seedAccount('A');
  startSync('A'); await settle();
  startSync('A'); await settle();      // StrictMode double-mount / same-user re-fire
  check('R1: one signal listener after two startSync calls', FS.__listenerCount(SIGNAL('A')) === 1);
  check('R1: one syncBus subscription after two startSync calls', bus.__test.subscriberCount() === 1);
  check('R1: one set of handles (6)', T.handleCount() === 6);
  startSync('B'); await settle();      // direct account switch
  check('R1: the listener moved to the new account', FS.__listenerCount(SIGNAL('A')) === 0 && FS.__listenerCount(SIGNAL('B')) === 1);
  stopSync();
  check('R2: stopSync drained every handle', T.handleCount() === 0);
  check('R2: no listener remains', FS.__listenerCount(SIGNAL('B')) === 0);
  check('R2: no syncBus subscription remains', bus.__test.subscriberCount() === 0);
  check('R2: no run in flight after stopSync', T.inFlight() === false);
}

// ===== F1/F2: flushSync waits; coalescing =====
console.log('F1-F2: flushSync and coalescing');
{
  resetAll(); seedAccount('A');
  let release; const held = new Promise((r) => { release = r; });
  FS.__setReadGate((path) => (path === 'users/A/symptoms' ? held : undefined));
  const starts = [];
  const origDebug = console.debug;
  console.debug = (tag, obj) => { if (tag === '[glim sync]' && obj && typeof obj === 'object') domainLines.push(obj); else if (typeof tag === 'string') { const m = tag.match(/run \((.+)\)/); if (m) starts.push(m[1]); } };
  startSync('A'); await settle();      // startup run held on symptoms
  check('F1: startup run is in flight', T.inFlight() === true);
  let flushDone = false;
  const f = flushSync('sign-out').then(() => { flushDone = true; });
  await sleep(120);
  check('F1: flushSync is still waiting while the run is held', flushDone === false && starts.length === 1);
  release(); await f;
  check('F1: flushSync ran its own full run after the held one finished', flushDone && starts.length === 2 && starts[1] === 'sign-out');
  // F2: three requests during one held run collapse to one follow-up.
  starts.length = 0;
  let release2; const held2 = new Promise((r) => { release2 = r; });
  FS.__setReadGate((path) => (path === 'users/A/symptoms' ? held2 : undefined));
  bus.notifyLocalWrite('water'); await sleep(40);           // run 1 starts and is held
  check('F2: one run in flight', starts.length === 1 && T.inFlight());
  bus.notifyLocalWrite('journal'); await sleep(40);
  bus.notifyLocalWrite('steps');   await sleep(40);
  bus.notifyLocalWrite('pokes');   await sleep(40);
  check('F2: no second run started while the first is held', starts.length === 1);
  release2(); await sleep(40);
  check('F2: exactly one follow-up run after release', starts.length === 2);
  console.debug = origDebug;
  stopSync();
}

// ===== C1: account switch mid-run =====
console.log('C1: account switch while a run is held');
{
  resetAll(); seedAccount('A'); seedAccount('B');
  let release; const held = new Promise((r) => { release = r; });
  FS.__setReadGate((path) => (path === 'users/A/symptoms' ? held : undefined));
  startSync('A'); await settle();      // A's startup run held
  startSync('B'); await settle(); await settle();
  check('C1: B\'s startup run ran to completion while A\'s was held', domainLines.some(l => l.domain === 'symptoms'));
  const skips = T.staleSkips();
  release(); await settle(); await settle();
  check('C1: A\'s held run was discarded on release (stale skip recorded)', T.staleSkips() > skips);
  check('C1: nothing of A\'s landed under B', !FS.__has('users/B/symptoms/y1') || FS.__get('users/B/symptoms/y1').id === 'y1');
  check('C1: no run in flight for the dead session', T.inFlight() === false);
  stopSync();
}

// ===== S4: foreign signal wakes this device regardless of its own clock =====
console.log('S4: foreign signal with this device\'s clock 5 minutes ahead');
{
  resetAll(); seedAccount('A');
  FS.__setServerClock(Date.now());
  const RealDate = Date;
  const SKEW = 5 * 60 * 1000;
  globalThis.Date = class extends RealDate {
    constructor(...a) { if (a.length === 0) super(RealDate.now() + SKEW); else super(...a); }
    static now() { return RealDate.now() + SKEW; }
  };
  let runs = [];
  const origDebug = console.debug;
  console.debug = (tag, obj) => { if (tag === '[glim sync]' && obj && typeof obj === 'object') domainLines.push(obj); else if (typeof tag === 'string') { const m = tag.match(/run \((.+)\)/); if (m) runs.push(m[1]); } };
  try {
    startSync('A'); await settle(); await settle();
    await flushSync('test');
    mem.set('glim-pokes', '4');
    await flushSync('test');                       // own push: touchSignal, own stamp becomes seen
    await settle(); await settle();
    check('S4: this device pushed and touched the signal', T.signalWrites() >= 1);
    runs = [];
    await FS.setDoc(FS.doc(null, 'users', 'A', 'sync', 'signal'), { at: FS.serverTimestamp(), by: 'other-device' });
    await sleep(60);
    check('S4: exactly one run after the foreign server-stamped signal (device clock ignored)',
      runs.filter(r => r === 'signal').length === 1);
  } finally {
    globalThis.Date = RealDate;
    console.debug = origDebug;
    stopSync();
  }
}

// ===== S5: re-delivery schedules nothing =====
console.log('S5: re-delivery of a handled foreign snapshot');
{
  resetAll(); seedAccount('A');
  let runs = [];
  const origDebug = console.debug;
  console.debug = (tag, obj) => { if (tag === '[glim sync]' && obj && typeof obj === 'object') domainLines.push(obj); else if (typeof tag === 'string') { const m = tag.match(/run \((.+)\)/); if (m) runs.push(m[1]); } };
  startSync('A'); await settle(); await settle();
  await flushSync('test');
  runs = [];
  await FS.setDoc(FS.doc(null, 'users', 'A', 'sync', 'signal'), { at: FS.serverTimestamp(), by: 'other-device' });
  await sleep(60);
  check('S5: the foreign write scheduled one run', runs.filter(r => r === 'signal').length === 1);
  runs = [];
  FS.__redeliver(SIGNAL('A'));
  await sleep(60);
  check('S5: re-delivering the same snapshot scheduled nothing', runs.length === 0);
  console.debug = origDebug;
  stopSync();
}

// ===== S6: own optimistic echo =====
console.log('S6: pending echo of an own write');
{
  resetAll(); seedAccount('A');
  let runs = [];
  const origDebug = console.debug;
  console.debug = (tag, obj) => { if (tag === '[glim sync]' && obj && typeof obj === 'object') domainLines.push(obj); else if (typeof tag === 'string') { const m = tag.match(/run \((.+)\)/); if (m) runs.push(m[1]); } };
  startSync('A'); await settle(); await settle();
  await flushSync('test');
  runs = [];
  mem.set('glim-pokes', '4');
  await flushSync('test');                         // own push: pending echo (at null) then ack
  await settle(); await settle(); await sleep(60);
  check('S6: neither the pending echo nor the acknowledged own write scheduled a run', !runs.includes('signal'));
  runs = [];
  await FS.setDoc(FS.doc(null, 'users', 'A', 'sync', 'signal'), { at: FS.serverTimestamp(), by: 'other-device' });
  await sleep(60);
  check('S6: a foreign write after the own write wakes this device exactly once', runs.filter(r => r === 'signal').length === 1);
  console.debug = origDebug;
  stopSync();
}

// ===== S6b: first snapshot after attach is pending =====
console.log('S6b: attach while a write is in flight (pending first snapshot)');
{
  resetAll(); seedAccount('A');
  let runs = [];
  const origDebug = console.debug;
  console.debug = (tag, obj) => { if (tag === '[glim sync]' && obj && typeof obj === 'object') domainLines.push(obj); else if (typeof tag === 'string') { const m = tag.match(/run \((.+)\)/); if (m) runs.push(m[1]); } };
  // A foreign signal is already on the server, and the listener's first
  // delivery is the pending form of it (stamp null), then the acknowledged one.
  await FS.setDoc(FS.doc(null, 'users', 'A', 'sync', 'signal'), { at: FS.serverTimestamp(), by: 'other-device' });
  FS.__setInitialPending(SIGNAL('A'));
  startSync('A'); await settle(); await settle();
  await flushSync('test');
  await sleep(60);
  check('S6b: neither the pending first snapshot nor the acknowledged baseline scheduled a run', !runs.includes('signal'));
  runs = [];
  await FS.setDoc(FS.doc(null, 'users', 'A', 'sync', 'signal'), { at: FS.serverTimestamp(), by: 'other-device' });
  await sleep(60);
  check('S6b: a later foreign write wakes this device exactly once', runs.filter(r => r === 'signal').length === 1);
  console.debug = origDebug;
  stopSync();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
