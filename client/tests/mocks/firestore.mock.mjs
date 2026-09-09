// In-memory Firestore mock (test-only). Implements the subset of the modular
// firebase/firestore API that sync.js uses: collection, doc, getDoc, getDocs,
// setDoc. Documents are stored by their full slash path (e.g.
// 'users/A/water/w1'). Deep-clones on read/write so callers cannot alias the
// backing store. Extra __-prefixed helpers let tests seed and inspect state.

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
  const prev = store.get(docRef.path);
  const next = opts.merge && prev ? { ...prev, ...clone(data) } : clone(data);
  if (writeHook) writeHook(docRef.path, clone(prev), clone(next));
  store.set(docRef.path, next);
}

export async function getDoc(docRef) {
  const has = store.has(docRef.path);
  const val = store.get(docRef.path);
  return { exists: () => has, data: () => clone(val), id: docRef.path.split('/').pop() };
}

export async function getDocs(colRef) {
  const prefix = colRef.path + '/';
  const docs = [];
  for (const [k, v] of store.entries()) {
    if (k.startsWith(prefix) && !k.slice(prefix.length).includes('/')) {
      docs.push({ id: k.slice(prefix.length), data: () => clone(v) });
    }
  }
  return { forEach: (cb) => docs.forEach(cb), docs };
}
