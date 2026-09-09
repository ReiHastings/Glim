// In-memory stand-in for ../src/firebase.js (test-only). Provides just the `db`
// sentinel the sync module imports; the firestore mock keys everything off paths,
// so `db` only needs to be a distinguishable object.
export const db = { __mockDb: true };
