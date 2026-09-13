// In-memory Firestore mock (test-only). Implements the subset of the modular
// firebase/firestore API that sync.js uses: collection, doc, getDoc, getDocs,
// setDoc, onSnapshot (single-document listeners only), serverTimestamp.
//
// Server timestamps (2026-09-12): serverTimestamp() returns a sentinel that
// setDoc resolves against a mock SERVER CLOCK at commit. The clock starts at
// REAL time, captured once at module load so a test that stubs Date cannot
// move it, and advances 1 ms per resolved sentinel so ordering is
// deterministic. Real time matters: a skew test that puts a device clock "5
// minutes ahead" needs that to be ahead of the server too, which a fixed
// far-future clock would silently defeat. Stored form is { __ts: ms } (survives
// the JSON clone); data() rehydrates top-level fields into MockTimestamp, whose
// valueOf() returns the SDK's zero-padded string so that `timestamp <= isoString`
// misbehaves exactly as it does with the real Timestamp class.
//
// Optimistic echo: like the real client, setDoc first delivers a PENDING
// snapshot (metadata.hasPendingWrites true, unresolved sentinels read as null)
// and then, after commit, the acknowledged one. The pending snapshot is built
// synchronously inside setDoc, before the store changes; only its delivery is
// queued. The mock cannot tell devices apart, so every listener on the path
// gets the echo, which over-approximates the real SDK (writer only). Documents are stored by their full slash path (e.g.
// 'users/A/water/w1'). Deep-clones on read/write so callers cannot alias the
// backing store. Extra __-prefixed helpers let tests seed and inspect state,
// observe writes (write hook), and hold any of the three awaited calls open
// (read, doc-read, and write gates) to simulate a slow network mid-run.

const store = new Map();
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

// --- Server clock and timestamps ---
const REAL_NOW_AT_LOAD = Date.now();
let serverNow = REAL_NOW_AT_LOAD;
export function __setServerClock(ms) { serverNow = ms; }
export function __serverClock() { return serverNow; }

export function serverTimestamp() { return { __serverTimestamp: true }; }
const isSentinel = (v) => !!v && typeof v === 'object' && v.__serverTimestamp === true;
const isStoredTs = (v) => !!v && typeof v === 'object' && typeof v.__ts === 'number';

export class MockTimestamp {
  constructor(ms) { this.seconds = Math.floor(ms / 1000); this.nanoseconds = (ms - this.seconds * 1000) * 1e6; }
  toMillis() { return this.seconds * 1000 + Math.floor(this.nanoseconds / 1e6); }
  isEqual(o) { return !!o && this.seconds === o.seconds && this.nanoseconds === o.nanoseconds; }
  // The SDK's valueOf: a zero-padded string so relational operators order two
  // Timestamps correctly - and order a Timestamp BEFORE any ISO string, which
  // is the mixed-type hazard the signal listener must never rely on.
  valueOf() {
    const adjusted = this.seconds - -62135596800;  // SDK offsets by the min seconds
    return String(adjusted).padStart(12, '0') + '.' + String(this.nanoseconds).padStart(9, '0');
  }
  toJSON() { return { __ts: this.toMillis() }; }
}

// Top-level fields only, matching how sync.js writes documents.
function resolveSentinels(obj, resolver) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k] = isSentinel(v) ? resolver() : v;
  return out;
}
function hydrate(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k] = isStoredTs(v) ? new MockTimestamp(v.__ts) : v;
  return out;
}

// --- Test helpers (not part of the real API) ---
export function __reset() { store.clear(); listeners.clear(); initialPending.clear(); serverNow = REAL_NOW_AT_LOAD; }
// Milliseconds of a stored server stamp at `field` (default 'at'), or null.
export function __signalStamp(path, field = 'at') {
  const v = store.get(path)?.[field];
  return isStoredTs(v) ? v.__ts : null;
}
export function __seed(path, data) { store.set(path, clone(data)); }
export function __has(path) { return store.has(path); }
export function __get(path) { return clone(store.get(path)); }

// Write hook: called as hook(path, prev, next) before every setDoc lands. Lets a
// test observe each write (e.g. assert updatedAt never regresses) or make one
// fail by throwing, which setDoc propagates exactly as a network error would.
let writeHook = null;
export function __setWriteHook(fn) { writeHook = fn; }

// Read gate: called as gate(collectionPath) at the top of every getDocs. If it
// returns a promise, getDocs waits on it before reading, so a test can hold a
// pull open (a slow network) and act while it is in flight - e.g. end the sync
// session, then release the gate and assert the stale run wrote nothing.
// Returning undefined lets the read proceed at once.
let readGate = null;
export function __setReadGate(fn) { readGate = fn; }

// Same idea for the two other awaited calls sync.js makes. getDoc gate: called
// as gate(docPath) before a singleton read (pokes, settings, *-config), so the
// five singleton domains can be held in flight too. setDoc gate: called as
// gate(docPath) before a write lands, so a push LOOP can be held between
// iterations (session ends after row 1, before row 2) - the case a read gate
// alone cannot reach. All three gates return undefined to let the call proceed.
let docReadGate = null;
export function __setDocReadGate(fn) { docReadGate = fn; }
let writeGate = null;
export function __setWriteGate(fn) { writeGate = fn; }

// Document listeners (onSnapshot). Keyed by doc path. Each callback receives
// the current snapshot once on attach (asynchronously, as the real SDK does)
// and again after every setDoc to that path. Snapshots carry
// metadata.hasPendingWrites = false: the mock has no local-first write echo.
const listeners = new Map();
function snapshotOf(path, data = store.get(path), pending = false) {
  const has = data !== undefined;
  return { exists: () => has, data: () => hydrate(clone(data)), id: path.split('/').pop(), metadata: { hasPendingWrites: pending } };
}
export function __listenerCount(path) { return listeners.get(path)?.size ?? 0; }
// Re-send the current acknowledged snapshot to the path's listeners (a
// listener reconnect re-delivering an unchanged document).
export function __redeliver(path) {
  const snap = snapshotOf(path);
  for (const cb of listeners.get(path) ?? []) queueMicrotask(() => cb(snap));
}

// Attach-while-writing: the real SDK can deliver a listener's FIRST snapshot
// as pending (an own write still in flight at attach, server stamps null).
// __setInitialPending(path) makes the next onSnapshot on that path do so: a
// pending snapshot with every stored stamp read as null, then the acknowledged
// one. One-shot.
const initialPending = new Set();
export function __setInitialPending(path) { initialPending.add(path); }
function withStampsNulled(data) {
  if (!data || typeof data !== 'object') return data;
  const out = {};
  for (const [k, v] of Object.entries(data)) out[k] = isStoredTs(v) ? null : v;
  return out;
}

export function onSnapshot(docRef, onNext, _onError) {
  const set = listeners.get(docRef.path) ?? new Set();
  set.add(onNext);
  listeners.set(docRef.path, set);
  if (initialPending.delete(docRef.path)) {
    const pendingSnap = snapshotOf(docRef.path, withStampsNulled(store.get(docRef.path)), true);
    queueMicrotask(() => { if (set.has(onNext)) onNext(pendingSnap); });
  }
  queueMicrotask(() => { if (set.has(onNext)) onNext(snapshotOf(docRef.path)); });
  return () => { set.delete(onNext); };
}

// Reset every hook and gate. Call between scenarios so a gate left installed by
// one cannot hold or observe the next.
export function __clearHooks() { writeHook = null; readGate = null; docReadGate = null; writeGate = null; }

// --- Mocked firebase/firestore surface ---
export function collection(_db, ...segments) {
  return { __type: 'col', path: segments.join('/') };
}

export function doc(ref, ...rest) {
  // doc(collectionRef, id) -> append to the collection path
  // doc(db, ...segments)   -> join segments from the db root
  const path = ref && ref.__type === 'col' ? [ref.path, ...rest].join('/') : rest.join('/');
  return { __type: 'doc', path };
}

export async function setDoc(docRef, data, opts = {}) {
  if (writeGate) await writeGate(docRef.path);
  const prev = store.get(docRef.path);
  const merged = opts.merge && prev ? { ...prev, ...clone(data) } : clone(data);
  const subs = listeners.get(docRef.path) ?? new Set();
  // Optimistic echo: materialised NOW, before commit, sentinels unresolved (null).
  if (subs.size) {
    const pendingSnap = snapshotOf(docRef.path, resolveSentinels(merged, () => null), true);
    for (const cb of subs) queueMicrotask(() => cb(pendingSnap));
  }
  const next = resolveSentinels(merged, () => ({ __ts: ++serverNow }));
  if (writeHook) writeHook(docRef.path, clone(prev), clone(next));
  store.set(docRef.path, next);
  const ackSnap = snapshotOf(docRef.path);
  for (const cb of subs) queueMicrotask(() => cb(ackSnap));
}

export async function getDoc(docRef) {
  if (docReadGate) await docReadGate(docRef.path);
  const has = store.has(docRef.path);
  const val = store.get(docRef.path);
  return { exists: () => has, data: () => hydrate(clone(val)), id: docRef.path.split('/').pop() };
}

export async function getDocs(colRef) {
  if (readGate) await readGate(colRef.path);
  const prefix = colRef.path + '/';
  const docs = [];
  for (const [k, v] of store.entries()) {
    if (k.startsWith(prefix) && !k.slice(prefix.length).includes('/')) {
      docs.push({ id: k.slice(prefix.length), data: () => hydrate(clone(v)) });
    }
  }
  return { forEach: (cb) => docs.forEach(cb), docs, size: docs.length };
}
