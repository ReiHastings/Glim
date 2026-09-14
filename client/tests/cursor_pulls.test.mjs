// title: cursor_pulls.test.mjs
// project: Glim
// author: Reina Hastings
// contact: reinahastings13@gmail.com
// date created: 2026-09-13
//
// purpose:
//   Acceptance tests for the cursor-bounded Firestore pulls, the per-row push
//   record, and the hidden-tab fallback skip (spec
//   docs/glim_handoff_cursor_pulls_2026-09-13.md, revision 6, Section 9.1).
//   Drives the REAL sync.js against the in-memory Firestore mock.
//     U   - unit: withSyncedAt (adds, overrides, no mutation), stripSyncedAt,
//           rowMarker (pure, changes on stamp or deletedAt, journal rows
//           carrying only `date` do not collapse to an empty stamp)
//     F   - the fallback interval does not run while document.hidden; runs
//           again once visible
//     C1  - legacy pull backfills syncedAt, sets cursor 0; the next run reads
//           everything once and sets the cursor to the newest stamp; inside
//           the overlap window the newest documents are re-read; after the
//           window a quiet run returns 0 (water 1: its config getDoc)
//     C2  - a non-finite cursor is treated as absent (legacy pull, no throw)
//     C3  - persist order: a failed data write holds the cursor
//     C4  - metamorphic: two quiet pulls; a late-committed document stamped
//           inside the overlap is still picked up, cursor unchanged
//     C5  - backfill failure: no cursor, legacy pull again next run
//     C6  - backfill repairs a string and a map syncedAt
//     S   - seeding: rows equal to remote are recorded, not pushed; a
//           local-only row is pushed; a second run pushes nothing
//     E1  - no echo of foreign rows across three runs, one with this device's
//           clock 5 minutes behind
//     E2  - adopted-and-superseded: a locally edited row loses to a newer
//           remote copy; zero setDoc; record equals the remote marker
//     E6  - the race: server regressed underneath a confirmed push; the device
//           with the newer copy re-pushes; and if that re-push fails it is
//           retried on the next run WITHOUT the document being returned again
//     E5  - a soft-delete of an old entry reaches the other device through a
//           bounded pull
//     R1  - failed write-once push (a soft-delete) is retried next run
//     R2  - record merge under overlap: the flush and a full run write the
//           same domain record concurrently; nothing is lost; next run quiet
//     R3  - R4-shape account switch during a push loop: nothing of A's lands
//           in B's record; B pushes its own rows
//     R4  - the flush skips a domain that has never been seeded
//     H1  - verifyBackfill stamps what the implicit path missed, reports
//           counts, creates no cursor; clearPullCursors forces full pulls
//     I   - session invariant: records and cursors survive restart, every
//           *PushedAt key is pruned; steady-state docsRead across all nine
//           domains; the idempotent-record invariant; no syncedAt anywhere in
//           localStorage
//
// usage:
//   cd client && node --import ./tests/register-sync-mocks.mjs tests/cursor_pulls.test.mjs

// --- Environment shims (set before importing the source) ---
let mem = new Map();
let throwOnKey = null;                 // C3: make setItem throw for one key
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => { if (k === throwOnKey) throw new Error('QuotaExceededError (simulated)'); mem.set(k, String(v)); },
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
const origWarn = console.warn;
console.warn = () => {};               // expected failures are noisy

import * as FS from './mocks/firestore.mock.mjs';
const sync = await import('../src/sync.js');
const { startSync, stopSync, flushSync, flushWriteOnce } = sync;
const T = sync.__test;
const { syncWater, syncSymptoms, syncAll } = T;

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.error(`  FAIL ${name}`); }
}
const sleep  = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = () => sleep(0);
const iso    = (ms) => new Date(ms).toISOString();
const NOW    = Date.now();
const ago    = (s) => iso(NOW - s * 1000);

// Device clock control (the mock's server clock is independent and real).
const RealDate = Date;
function setClockOffset(ms) {
  if (ms === 0) { globalThis.Date = RealDate; return; }
  globalThis.Date = class extends RealDate {
    constructor(...a) { if (a.length === 0) super(RealDate.now() + ms); else super(...a); }
    static now() { return RealDate.now() + ms; }
  };
}
const PAST_WINDOW = T.OVERLAP_WINDOW_MS + 1000;

// Debug-log capture: one { domain, docsRead, docsPushed, ... } line per domain per run.
let lines = [];
let runs  = [];
console.debug = (tag, obj) => {
  if (tag === '[glim sync]' && obj && typeof obj === 'object') lines.push(obj);
  else if (typeof tag === 'string') { const m = tag.match(/run \((.+)\)/); if (m) runs.push(m[1]); }
};
const line = (domain) => lines.filter(l => l.domain === domain).at(-1);

// Non-backfill writes (pushes and signal writes) observed at the hook.
let pushes = [];
function observePushes() {
  pushes = [];
  FS.__setWriteHook((path, prev, next) => { if (!FS.__isBackfill(prev, next)) pushes.push(path); });
}
function resetAll() {
  FS.__reset(); FS.__clearHooks(); mem = new Map(); throwOnKey = null; lines = []; runs = [];
  mem.set('glim-debug-sync', '1'); setClockOffset(0); observePushes();
}
const meta   = () => JSON.parse(mem.get('glim-sync-meta') ?? '{}');
const water  = () => JSON.parse(mem.get('glim-water'));
const setWater = (entries) => mem.set('glim-water', JSON.stringify({ entries, bottleOz: 24, goal: 6, configUpdatedAt: iso(0) }));
const wRow   = (id, ms, over = {}) => ({ id, timestamp: ms, bottleOz: 24, ...over });
const sRow   = (id, at, over = {}) => ({ id, kind: 'point', date: '2026-09-01', createdAt: ago(900), updatedAt: at, deletedAt: null, symptomId: 'sym1', intensity: 2, note: '', ...over });
const setLogs = (logs) => mem.set('glim-symptoms', JSON.stringify({ logs }));
const logs    = () => JSON.parse(mem.get('glim-symptoms')).logs;
// A server document stamped by the mock server clock (stored form).
function seedStamped(path, data, offsetMs = 1) {
  const ms = FS.__serverClock() + offsetMs;
  FS.__seed(path, { ...data, syncedAt: { __ts: ms } });
  if (ms > FS.__serverClock()) FS.__setServerClock(ms);
  return ms;
}
function noSyncedAtLocally() {
  for (const [k, v] of mem) if (k.startsWith('glim-') && k !== 'glim-sync-meta' && /syncedAt/.test(v)) return false;
  return true;
}
const stampedOnServer = (path) => typeof FS.__get(path)?.syncedAt?.__ts === 'number';

// ===== U: unit checks =====
console.log('U: withSyncedAt, stripSyncedAt, rowMarker');
{
  const input = { id: 'x', a: 1, syncedAt: { seconds: 1, nanoseconds: 0 } };
  const out = T.withSyncedAt(input);
  check('U: withSyncedAt adds a serverTimestamp sentinel and keeps other fields', out.a === 1 && out.id === 'x' && out.syncedAt && out.syncedAt.__serverTimestamp === true);
  check('U: withSyncedAt OVERRIDES an existing syncedAt of any shape', out.syncedAt !== input.syncedAt);
  check('U: withSyncedAt does not mutate its input', input.syncedAt.seconds === 1 && Object.keys(input).length === 3);
  const stripped = T.stripSyncedAt({ id: 'y', syncedAt: 5, b: 2 });
  check('U: stripSyncedAt removes only syncedAt', !('syncedAt' in stripped) && stripped.b === 2 && stripped.id === 'y');
  check('U: stripSyncedAt leaves a row without the field untouched', T.stripSyncedAt({ id: 'z' }).id === 'z');
  const W = T.WRITE_ONCE, M = T.MUTABLE;
  check('U: rowMarker is a pure function of the row', T.rowMarker(W.water, wRow('a', 5)) === T.rowMarker(W.water, wRow('a', 5)));
  check('U: rowMarker changes when the stamp changes', T.rowMarker(W.water, wRow('a', 5)) !== T.rowMarker(W.water, wRow('a', 6)));
  check('U: rowMarker changes when deletedAt is set', T.rowMarker(W.water, wRow('a', 5)) !== T.rowMarker(W.water, wRow('a', 5, { deletedAt: ago(1) })));
  check('U: mutable rowMarker changes on updatedAt', T.rowMarker(M.symptoms, sRow('s', ago(5))) !== T.rowMarker(M.symptoms, sRow('s', ago(4))));
  check('U: a journal row carrying only `date` does not collapse to an empty stamp',
    T.rowMarker(W.journal, { id: 'j', text: 't', date: ago(3) }) !== '|' && T.rowMarker(W.journal, { id: 'j', date: ago(3) }).startsWith(ago(3)));
}

// ===== F: fallback is skipped while hidden =====
console.log('F: hidden-tab fallback skip');
{
  resetAll();
  T.setTimings({ debounceMs: 5, fallbackMs: 12 });
  document.hidden = true;
  startSync('A'); await settle(); await settle();
  runs = [];
  await sleep(70);
  check('F: no fallback run while document.hidden', runs.filter(r => r === 'fallback').length === 0);
  document.hidden = false;
  await sleep(50);
  check('F: fallback runs resume once visible', runs.filter(r => r === 'fallback').length >= 1);
  stopSync();
  T.setTimings({ debounceMs: 20, fallbackMs: 60 * 60 * 1000 });
}

// ===== C1: legacy pull, backfill, cursor, overlap window, quiet floor =====
console.log('C1: legacy pull -> backfill -> bounded pulls -> quiet floor');
{
  resetAll();
  setWater([]);
  FS.__seed('users/A/water-config/current', { bottleOz: 24, goal: 6, configUpdatedAt: iso(0) });   // equal: no config push
  FS.__seed('users/A/water/w1', wRow('w1', 1000));
  FS.__seed('users/A/water/w2', wRow('w2', 2000));
  FS.__seed('users/A/water/w3', wRow('w3', 3000));
  await syncWater('A');                                            // run 1: legacy
  check('C1: run 1 reads the whole collection', line('water').docsRead === 3 + 1);
  check('C1: run 1 backfilled every unstamped document', ['w1', 'w2', 'w3'].every(id => stampedOnServer(`users/A/water/${id}`)) && line('water').docsBackfilled === 3);
  check('C1: run 1 pulled all three rows locally, without syncedAt', water().entries.length === 3 && noSyncedAtLocally());
  check('C1: run 1 set the cursor to 0 (no stamped document was returned)', meta().waterPullCursor === 0 && typeof meta().waterPullCursorSetAt === 'number');
  check('C1: run 1 recorded the three adopted rows', Object.keys(meta().waterPushed).length === 3);
  check('C1: run 1 pushed nothing and the backfill did not count as a push', pushes.length === 0 && line('water').docsPushed === 0);
  const before = pushes.length;
  await syncWater('A');                                            // run 2: bounded from 0
  const c2 = meta().waterPullCursor;
  check('C1: run 2 reads everything once (bounded from 0) and sets the cursor to the newest stamp',
    line('water').docsRead === 3 + 1 && c2 > 0 && c2 === FS.__get('users/A/water/w3').syncedAt.__ts);
  await syncWater('A');                                            // run 3: inside the overlap window
  check('C1: run 3 (window open) re-reads the documents inside the overlap, cursor unchanged',
    line('water').docsRead === 3 + 1 && meta().waterPullCursor === c2);
  setClockOffset(PAST_WINDOW);
  await syncWater('A');                                            // run 4: window closed
  check('C1: run 4 (window closed) returns 0 documents: docsRead 1 for water (its config getDoc)', line('water').docsRead === 1);
  check('C1: no write of any kind on runs 2-4', pushes.length === before);
  check('C1: cursor unchanged by a quiet run', meta().waterPullCursor === c2);
  setClockOffset(0);
}

// ===== C2: a non-finite cursor is treated as absent =====
console.log('C2: corrupt cursor');
{
  resetAll();
  setWater([]);
  seedStamped('users/A/water/w1', wRow('w1', 1000));
  mem.set('glim-sync-meta', JSON.stringify({ waterPullCursor: 'garbage', waterPullCursorSetAt: 'x' }));
  let threw = false;
  try { await syncWater('A'); } catch { threw = true; }
  check('C2: a string cursor does not throw', !threw);
  check('C2: the run performed the legacy full pull and repaired the cursor', water().entries.length === 1 && typeof meta().waterPullCursor === 'number');
}

// ===== C3: persist order - a failed data write holds the cursor =====
console.log('C3: persist-after-apply');
{
  resetAll();
  setWater([]);
  await syncWater('A');                                            // seeds an empty domain (cursor absent: N = 0)
  seedStamped('users/A/water/w9', wRow('w9', 9000));
  throwOnKey = 'glim-water';
  await syncWater('A');
  check('C3: the data write failed (row not stored)', water().entries.length === 0);
  check('C3: the cursor was NOT advanced past the unstored row', meta().waterPullCursor === undefined);
  check('C3: the adoption was not recorded either', !(meta().waterPushed && 'w9' in meta().waterPushed));
  check('C3: the unstored adopted row was not pushed back either', !pushes.includes('users/A/water/w9'));
  throwOnKey = null;
  await syncWater('A');
  check('C3: the next run re-fetches the window and stores the row', water().entries.length === 1 && typeof meta().waterPullCursor === 'number');
}

// ===== C4: metamorphic double pull and the late-commit race =====
console.log('C4: metamorphic quiet pulls and a late-committed document');
{
  resetAll();
  setWater([]);
  seedStamped('users/A/water/w1', wRow('w1', 1000));
  await syncWater('A');                                            // legacy: nothing to backfill, cursor = w1 stamp
  const c = meta().waterPullCursor;
  check('C4: legacy pull on stamped documents sets the cursor to the newest stamp', c === FS.__get('users/A/water/w1').syncedAt.__ts);
  await syncWater('A');
  check('C4: second pull inside the window returns the overlap set only, cursor unchanged', line('water').docsRead === 2 && meta().waterPullCursor === c);
  // A write whose server stamp precedes the cursor but whose commit landed after the previous read.
  FS.__seed('users/A/water/late', { ...wRow('late', 500), syncedAt: { __ts: c - 5000 } });
  await syncWater('A');
  check('C4: the late-committed document inside the overlap is pulled', water().entries.some(e => e.id === 'late'));
  check('C4: the cursor did not move backwards or forwards for it', meta().waterPullCursor === c);
  setClockOffset(PAST_WINDOW);
  await syncWater('A'); const before = pushes.length; await syncWater('A');
  check('C4: after the window two consecutive quiet pulls return 0 and write nothing', line('water').docsRead === 1 && pushes.length === before);
  setClockOffset(0);
}

// ===== C5: backfill failure holds the cursor and retries on the legacy path =====
console.log('C5: backfill batch failure');
{
  resetAll();
  setWater([]);
  FS.__seed('users/A/water/w1', wRow('w1', 1000));
  FS.__seed('users/A/water/w2', wRow('w2', 2000));
  FS.__setWriteHook((path, prev, next) => { if (FS.__isBackfill(prev, next)) throw new Error('batch failed (simulated)'); });
  await syncWater('A');
  check('C5: rows were still pulled locally', water().entries.length === 2);
  check('C5: no cursor was set for the domain', meta().waterPullCursor === undefined);
  check('C5: the documents are still unstamped', !stampedOnServer('users/A/water/w1'));
  observePushes();
  await syncWater('A');
  check('C5: the next run took the legacy path again and stamped them', line('water').docsRead === 3 && stampedOnServer('users/A/water/w1') && stampedOnServer('users/A/water/w2'));
  check('C5: and then set the cursor', meta().waterPullCursor === 0);
}

// ===== C6: backfill repairs a wrong-typed syncedAt =====
console.log('C6: backfill criterion is "absent or not a Timestamp"');
{
  resetAll();
  setWater([]);
  FS.__seed('users/A/water/s', { ...wRow('s', 1000), syncedAt: '2026-09-13T00:00:00.000Z' });
  FS.__seed('users/A/water/m', { ...wRow('m', 2000), syncedAt: { seconds: 1, nanoseconds: 0 } });
  await syncWater('A');
  check('C6: string and map syncedAt were both re-stamped', stampedOnServer('users/A/water/s') && stampedOnServer('users/A/water/m'));
  await syncWater('A');
  check('C6: the bounded query then returns them', line('water').docsRead === 3);
}

// ===== S: seeding on the first run =====
console.log('S: first run seeds the record');
{
  resetAll();
  const t = 1700000000000;
  seedStamped('users/A/water/w1', wRow('w1', t));
  seedStamped('users/A/water/w2', wRow('w2', t + 1));
  setWater([wRow('w1', t), wRow('w2', t + 1), wRow('local', t + 2)]);
  await syncWater('A');
  const rec = meta().waterPushed;
  check('S: rows equal to remote are recorded, not pushed', rec.w1 && rec.w2 && !pushes.includes('users/A/water/w1') && !pushes.includes('users/A/water/w2'));
  check('S: the local-only row is pushed and recorded', FS.__has('users/A/water/local') && rec.local === T.rowMarker(T.WRITE_ONCE.water, wRow('local', t + 2)));
  observePushes();
  await syncWater('A');
  check('S: a second run pushes nothing', pushes.length === 0 && line('water').docsPushed === 0);
}

// ===== E1: no echo of foreign rows, including under clock skew =====
console.log('E1: no echo');
{
  resetAll();
  const A = new Map(), B = new Map();
  mem = B; B.set('glim-debug-sync', '1'); setLogs([sRow('x', ago(50), { note: 'from B' })]);
  await syncSymptoms('S');                                         // B pushes x
  mem = A; A.set('glim-debug-sync', '1'); setLogs([]);
  observePushes();
  await syncSymptoms('S');                                         // A adopts x
  setClockOffset(-5 * 60 * 1000);                                  // A's clock 5 minutes behind
  await syncSymptoms('S');
  setClockOffset(0);
  await syncSymptoms('S');
  check('E1: A adopted the row', logs().some(l => l.id === 'x' && l.note === 'from B'));
  check('E1: A performed zero pushes across three runs, skew included', pushes.length === 0);
  check('E1: A\'s record equals the adopted marker', JSON.parse(A.get('glim-sync-meta')).symptomsPushed.x === T.rowMarker(T.MUTABLE.symptoms, logs()[0]));
}

// ===== E2: adopted-and-superseded =====
console.log('E2: a local edit superseded by a newer remote copy in the same pull');
{
  resetAll();
  const A = new Map(), B = new Map();
  mem = A; A.set('glim-debug-sync', '1'); setLogs([sRow('x', ago(300))]);
  await syncSymptoms('S');                                         // A pushes x (T-300)
  mem = B; B.set('glim-debug-sync', '1'); setLogs([]);
  await syncSymptoms('S');                                         // B pulls x
  { const l = logs(); l[0].updatedAt = ago(10); l[0].note = 'B newer'; setLogs(l); }
  await syncSymptoms('S');                                         // B pushes T-10
  mem = A;
  { const l = logs(); l[0].updatedAt = ago(50); l[0].note = 'A older edit'; setLogs(l); }   // edited after A's last push
  observePushes();
  await syncSymptoms('S');
  check('E2: A adopted the newer remote copy', logs()[0].note === 'B newer');
  check('E2: A pushed nothing (no stale blind push)', pushes.length === 0 && FS.__get('users/S/symptoms/x').note === 'B newer');
  check('E2: A\'s record equals the remote marker', JSON.parse(A.get('glim-sync-meta')).symptomsPushed.x === T.rowMarker(T.MUTABLE.symptoms, logs()[0]));
}

// ===== E6: the race, and a failed re-push retried without a re-pull =====
console.log('E6: server regressed underneath a confirmed push');
{
  resetAll();
  const B = new Map();
  mem = B; B.set('glim-debug-sync', '1'); setLogs([sRow('x', ago(50), { note: 'B 10:05' })]);
  await syncSymptoms('S');                                         // B pushes T-50 and records it
  // A's older push commits AFTER B's: server holds T-100 with a NEWER syncedAt.
  seedStamped('users/S/symptoms/x', sRow('x', ago(100), { note: 'A 10:00' }), 1000);
  observePushes();
  await syncSymptoms('S');
  check('E6: B re-pushed its newer copy over the regressed server copy', FS.__get('users/S/symptoms/x').note === 'B 10:05' && pushes.includes('users/S/symptoms/x'));

  // Same race, but B's re-push fails once. No document changes on the server
  // afterwards, so the next bounded pull (window closed) returns nothing; the
  // record alone must drive the retry.
  seedStamped('users/S/symptoms/x', sRow('x', ago(100), { note: 'A 10:00' }), 1000);
  FS.__setWriteHook((path) => { if (path.endsWith('/x')) throw new Error('simulated failure'); });
  await syncSymptoms('S');
  check('E6: the re-push genuinely failed', FS.__get('users/S/symptoms/x').note === 'A 10:00');
  const rec = JSON.parse(B.get('glim-sync-meta')).symptomsPushed.x;
  check('E6: the record holds the REMOTE marker after the failed re-push', rec === T.rowMarker(T.MUTABLE.symptoms, sRow('x', ago(100))));
  observePushes();
  setClockOffset(PAST_WINDOW);
  await syncSymptoms('S');
  setClockOffset(0);
  check('E6: the next run returned no document for x, yet pushed it from the record alone', line('symptoms').docsRead === 0 && FS.__get('users/S/symptoms/x').note === 'B 10:05');
}

// ===== E5: a soft-delete of an old entry through a bounded pull =====
console.log('E5: soft-delete propagation via a bounded pull');
{
  resetAll();
  const phone = new Map(), desk = new Map();
  const march = Date.UTC(2026, 2, 3);
  mem = phone; phone.set('glim-debug-sync', '1'); setWater([wRow('old', march)]);
  await syncWater('W');
  mem = desk; desk.set('glim-debug-sync', '1'); setWater([]);
  await syncWater('W'); await syncWater('W');                     // desk has a cursor
  setClockOffset(PAST_WINDOW);
  mem = phone;
  { const w = water(); w.entries[0].deletedAt = ago(1); mem.set('glim-water', JSON.stringify(w)); }
  await syncWater('W');
  check('E5: the phone pushed the delete with a fresh syncedAt', !!FS.__get('users/W/water/old').deletedAt);
  mem = desk;
  await syncWater('W');
  setClockOffset(0);
  check('E5: the desktop\'s bounded pull returned exactly that document', line('water').docsRead === 1 + 1);
  check('E5: the soft-delete propagated', !!water().entries[0].deletedAt);
}

// ===== R1: a failed write-once push is retried =====
console.log('R1: failed write-once push retried');
{
  resetAll();
  setWater([wRow('w1', 1000)]);
  await syncWater('A');
  { const w = water(); w.entries[0].deletedAt = ago(1); mem.set('glim-water', JSON.stringify(w)); }
  FS.__setWriteHook((path) => { if (path.endsWith('/w1')) throw new Error('simulated failure'); });
  await syncWater('A');
  check('R1: the delete push failed', !FS.__get('users/A/water/w1').deletedAt);
  observePushes();
  setClockOffset(PAST_WINDOW);
  await syncWater('A');
  setClockOffset(0);
  check('R1: retried on the next run without the document having been returned', line('water').docsRead === 1 && !!FS.__get('users/A/water/w1').deletedAt);
}

// ===== R2: record merge under overlap (flush vs full run) =====
console.log('R2: flush and full run write the same record concurrently');
{
  resetAll();
  setWater([wRow('w1', 1000)]);
  startSync('A'); await settle(); await settle();                  // run 1 seeds every domain
  await flushSync('test');
  const c = meta().waterPullCursor;
  seedStamped('users/A/water/w6', wRow('w6', 6000), 50);           // foreign row, newer than the cursor
  let release; const held = new Promise(r => { release = r; });
  FS.__setReadGate((path) => (path === 'users/A/water' ? held : undefined));
  const run = syncAll();                                           // full run: water pull held
  await settle();
  { const w = water(); w.entries.push(wRow('w5', 5000)); mem.set('glim-water', JSON.stringify(w)); }
  await flushWriteOnce();                                          // the flush pushes w5 and records it
  check('R2: the flush pushed the local row while the run was held', FS.__has('users/A/water/w5'));
  release(); await run; await settle();
  const rec = meta().waterPushed;
  check('R2: the record holds the run\'s adoption AND the flush\'s push', rec.w1 && rec.w5 && rec.w6);
  check('R2: the cursor advanced to the foreign row', meta().waterPullCursor > c);
  observePushes();
  await flushSync('test');
  check('R2: the following run performs zero setDoc', pushes.length === 0);
  stopSync();
}

// ===== R3: account switch during a push loop (R4 shape) =====
console.log('R3: stale record write after an account switch');
{
  resetAll();
  const cat = (id, at) => ({ id, name: id, color: '#000', order: 0, createdAt: at, updatedAt: at, deletedAt: null });
  mem.set('glim-uid', 'A');
  mem.set('glim-symptoms-categories', JSON.stringify({ items: [cat('cat-a1', ago(20)), cat('cat-a2', ago(10))] }));
  let release; const held = new Promise(r => { release = r; }); let reached;
  const arrived = new Promise(r => { reached = r; });
  FS.__setWriteGate((path) => { if (path === 'users/A/symptom-categories/cat-a1') { reached(); return held; } return undefined; });
  startSync('A'); await arrived;
  stopSync();
  for (const k of [...mem.keys()]) if (k.startsWith('glim-') && k !== 'glim-uid') mem.delete(k);
  mem.set('glim-uid', 'B'); mem.set('glim-debug-sync', '1');
  mem.set('glim-symptoms-categories', JSON.stringify({ items: [cat('cat-pain', ago(5))] }));
  startSync('B'); await settle(); await settle();
  release(); await settle(); await settle();
  const rec = meta().symptomsCategoriesPushed ?? {};
  check('R3: nothing of A\'s in B\'s record', !('cat-a1' in rec) && !('cat-a2' in rec));
  check('R3: B pushed and recorded its own row', FS.__has('users/B/symptom-categories/cat-pain') && 'cat-pain' in rec);
  check('R3: A\'s second row was not written after the stop', !FS.__has('users/A/symptom-categories/cat-a2'));
  stopSync();
}

// ===== R4: the flush skips an unseeded domain =====
console.log('R4: flush skips unseeded domains');
{
  resetAll();
  setWater([wRow('w1', 1000)]);
  await flushWriteOnce('A');
  check('R4: with no waterPushed record the flush pushes nothing', !FS.__has('users/A/water/w1'));
  await syncWater('A');
  { const w = water(); w.entries.push(wRow('w2', 2000)); mem.set('glim-water', JSON.stringify(w)); }
  observePushes();
  await flushWriteOnce('A');
  check('R4: once seeded, the flush pushes only the unrecorded row', pushes.length === 1 && pushes[0] === 'users/A/water/w2');
}

// ===== H1: verifyBackfill and clearPullCursors =====
console.log('H1: dev helpers');
{
  resetAll();
  setWater([wRow('w1', 1000)]);
  await syncWater('A');
  FS.__seed('users/A/water/old-build', wRow('old-build', 2000));          // written by an old build: no syncedAt
  FS.__seed('users/A/water/map', { ...wRow('map', 3000), syncedAt: { seconds: 2, nanoseconds: 0 } });
  const before = meta().waterPullCursor;
  const report = await T.verifyBackfill('A');
  check('H1: verifyBackfill reports remote and local counts', report.water.remote === 3 && report.water.local === 1);
  check('H1: verifyBackfill found and stamped the two bad documents', report.water.found === 2 && report.water.stamped === 2 && report.water.errors === 0);
  check('H1: verifyBackfill touched no cursor and no localStorage', meta().waterPullCursor === before && water().entries.length === 1);
  const again = await T.verifyBackfill('A');
  check('H1: a second invocation finds nothing', again.water.found === 0 && again.water.stamped === 0);
  await syncWater('A');
  check('H1: the repaired documents now reach the device through the bounded pull', water().entries.length === 3);
  T.clearPullCursors();
  check('H1: clearPullCursors removed every cursor, SetAt and record key', !Object.keys(meta()).some(k => /PullCursor|Pushed$/.test(k)));
  const rows = JSON.stringify(water());
  await syncWater('A');
  check('H1: the next run performed the full pull and repopulated the keys with no data change',
    line('water').docsRead === 3 + 1 && typeof meta().waterPullCursor === 'number' && meta().waterPushed && JSON.stringify(water()) === rows);
}

// ===== I: session invariant, steady-state floor, idempotent record, no local syncedAt =====
console.log('I: whole-account invariants');
{
  resetAll();
  const d = (n) => new Date(Date.UTC(2026, 0, 1 + n)).toISOString();
  const seed = (p, data) => FS.__seed(p, data);
  seed('users/A/journal/j1', { id: 'j1', text: 'hi', createdAt: d(1) });
  seed('users/A/water/w1', wRow('w1', 1700000000000));
  seed('users/A/water-config/current', { bottleOz: 24, goal: 6, configUpdatedAt: d(2) });
  seed('users/A/steps/s1', { id: 's1', timestamp: 1700000000000, count: 100 });
  seed('users/A/steps-config/current', { goal: 8000, configUpdatedAt: d(2) });
  seed('users/A/nutrition/n1', { id: 'n1', createdAt: d(1) });
  seed('users/A/nutrition-config/current', { goals: { protein: 100 }, configUpdatedAt: d(2) });
  seed('users/A/nutrition-library/l1', { id: 'l1', createdAt: d(1), updatedAt: d(1) });
  seed('users/A/symptoms/y1', { id: 'y1', createdAt: d(1), updatedAt: d(1) });
  seed('users/A/symptoms-library/yl1', { id: 'yl1', createdAt: d(1), updatedAt: d(1) });
  seed('users/A/symptom-categories/c1', { id: 'c1', createdAt: d(1), updatedAt: d(1) });
  seed('users/A/symptom-days/2026-01-05', { id: '2026-01-05', createdAt: d(1), updatedAt: d(1) });
  seed('users/A/pokes/counters', { total: 3, lastModified: d(2) });
  seed('users/A/settings/current', { wellnessInterval: 30, lastModified: d(2) });
  mem.set('glim-pokes', '3');
  mem.set('glim-settings', JSON.stringify({ wellnessInterval: 30, lastModified: d(2) }));
  mem.set('glim-steps', JSON.stringify({ entries: [], goal: 8000, configUpdatedAt: d(2) }));
  mem.set('glim-nutrition', JSON.stringify({ logs: [], goals: { protein: 100 }, configUpdatedAt: d(2) }));
  mem.set('glim-water', JSON.stringify({ entries: [], bottleOz: 24, goal: 6, configUpdatedAt: d(2) }));
  // Stale watermarks from the previous build must be pruned at startSync.
  mem.set('glim-sync-meta', JSON.stringify({ journalPushedAt: d(3), waterPushedAt: d(3), symptomsPushedAt: d(3) }));
  const skipsBefore = T.staleSkips();

  startSync('A'); await settle(); await settle();                  // run 1: legacy + backfill
  await flushSync('test');                                         // run 2: bounded from 0
  check('I: every *PushedAt key was pruned at startSync', !Object.keys(meta()).some(k => k.endsWith('PushedAt')));
  const EVENT = [...Object.values(T.WRITE_ONCE), ...Object.values(T.MUTABLE)];
  check('I: after run 2 every event-log domain has a numeric cursor and a record',
    EVENT.every(cfg => typeof meta()[`${cfg.metaPrefix}PullCursor`] === 'number' && typeof meta()[`${cfg.metaPrefix}Pushed`] === 'object'));
  const snapshot = JSON.stringify(meta());
  stopSync(); startSync('A'); await settle(); await settle();     // restart: keys must survive
  check('I: cursors and records survive stopSync/startSync',
    EVENT.every(cfg => meta()[`${cfg.metaPrefix}PullCursor`] === JSON.parse(snapshot)[`${cfg.metaPrefix}PullCursor`]));

  setClockOffset(PAST_WINDOW);
  observePushes(); lines = [];
  await flushSync('test');                                         // quiet run, window closed
  setClockOffset(0);
  const reads = Object.fromEntries(EVENT.map(cfg => [cfg.collectionName, line(cfg.collectionName)?.docsRead]));
  check(`I: steady-state docsRead is 0 for eight event-log domains and 1 for water (${JSON.stringify(reads)})`,
    EVENT.every(cfg => reads[cfg.collectionName] === (cfg.collectionName === 'water' ? 1 : 0)));
  check('I: the quiet run wrote nothing and pushed nothing', pushes.length === 0 && T.lastRunPushed() === 0);
  check('I: idempotent record: every local row\'s marker equals its record entry',
    EVENT.every(cfg => {
      const raw = JSON.parse(mem.get(cfg.storageKey) ?? 'null');
      const rows = cfg.arrayField === null ? (raw ?? []) : (raw?.[cfg.arrayField] ?? []);
      const rec = meta()[`${cfg.metaPrefix}Pushed`] ?? {};
      return rows.every(r => rec[String(r.id)] === T.rowMarker(cfg, r));
    }));
  check('I: no syncedAt in any glim-* localStorage value', noSyncedAtLocally());
  check('I: no stale-run skips in this scenario (R3 above deliberately produced one)', T.staleSkips() === skipsBefore);
  stopSync();
}

console.warn = origWarn;
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
