// In-memory Firestore mock (test-only). Implements the subset of the modular
// firebase/firestore API that sync.js uses: collection, doc, getDoc, getDocs,
// setDoc. Documents are stored by their full slash path (e.g.
// 'users/A/water/w1'). Deep-clones on read/write so callers cannot alias the
// backing store. Extra __-prefixed helpers let tests seed and inspect state,
// observe writes (write hook), and hold any of the three awaited calls open
// (read, doc-read, and write gates) to simulate a slow network mid-run.

const store = new Map();
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

// --- Test helpers (not part of the real API) ---
export function __reset() { store.clear(); }
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
  const next = opts.merge && prev ? { ...prev, ...clone(data) } : clone(data);
  if (writeHook) writeHook(docRef.path, clone(prev), clone(next));
  store.set(docRef.path, next);
}

export async function getDoc(docRef) {
  if (docReadGate) await docReadGate(docRef.path);
  const has = store.has(docRef.path);
  const val = store.get(docRef.path);
  return { exists: () => has, data: () => clone(val), id: docRef.path.split('/').pop() };
}

export async function getDocs(colRef) {
  if (readGate) await readGate(colRef.path);
  const prefix = colRef.path + '/';
  const docs = [];
  for (const [k, v] of store.entries()) {
    if (k.startsWith(prefix) && !k.slice(prefix.length).includes('/')) {
      docs.push({ id: k.slice(prefix.length), data: () => clone(v) });
    }
  }
  return { forEach: (cb) => docs.forEach(cb), docs };
}
