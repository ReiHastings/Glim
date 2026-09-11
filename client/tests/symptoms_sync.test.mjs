// title: symptoms_sync.test.mjs
// project: Glim
// author: Reina Hastings
// contact: reinahastings13@gmail.com
//
// purpose:
//   Deterministic simulations of the symptom-diary sync path, running the REAL
//   syncSymptoms / syncSymptomsLibrary merge code against the in-memory
//   Firestore mock. Covers what the store-level tests cannot:
//     Y1 - a new entry pushes, and a second device pulls it
//     Y2 - an EDIT propagates cross-device via updatedAt (not just creation)
//     Y3 - edge case 7: two offline edits of the same entry resolve wholesale to
//          the newer updatedAt, with no field-level merge
//     Y4 - a soft-deleted entry does not reappear after a pull, and the delete
//          propagates to the other device
//     Y5 - a library archive propagates, and a rename resolves by id
//     Y6 - symptom CATEGORIES round-trip, and the fixed seed ids let two devices
//          that seeded independently converge to one row instead of duplicates
//     Y7 - a CLEAR DAY record round-trips, and a mark/unmark race resolves by
//          updatedAt on the date-keyed document
//     Y8 - THE D1 REGRESSION: a device holding an OLDER unpushed edit must not
//          overwrite a NEWER remote copy when it reconnects, and the two devices
//          must converge to byte-identical documents (metamorphic: four syncs
//          in alternation reach a fixed point). Under the previous
//          push-then-pull ordering this failed and the divergence was permanent.
//     Y9 - INVARIANT: no push ever lowers a remote document's updatedAt, for
//          any of the five mutable domains, observed at the mock's write hook.
//    Y10 - a push that fails once is retried on the next sync. The old
//          watermark gate abandoned such a row forever.
//    Y11 - the five retired *PushedAt keys are pruned from glim-sync-meta on
//          startup, and the live write-once watermarks are left alone.
//    Y12 - a MALFORMED updatedAt on one side loses to the well-formed side in
//          both directions, so a corrupt row is healed rather than frozen; two
//          malformed stamps tie and nothing moves.
//    Y13 - a WRITE-ONCE re-push (flushSync, then syncNutritionLogs) never clears
//          a soft-delete another device recorded in between: the null deletedAt
//          is omitted from the payload, so merge cannot overwrite it.
//    Y14 - a null element in a local array is skipped with a warning; the good
//          rows in that domain still sync.
//    Y15 - a JOURNAL soft-delete propagates to a device that already holds the
//          entry (the water pull branch, ported 2026-09-08; syncJournal never
//          had it), and a newer local deletedAt is not overwritten by an older
//          remote one.
//    Y16 - D4, the SYNC half: a clear-day mark made on device A that has not
//          yet reached device B loses to B's newer tombstone row, and both
//          devices converge on "not clear". The tombstone is seeded directly;
//          that the store LAYS it on unmarkClear is covered in
//          symptoms_phase15 (D4 block), not here.
//   The real browser/auth paths still require a manual pass.
//
// usage:
//   cd client && node --import ./tests/register-sync-mocks.mjs tests/symptoms_sync.test.mjs

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
const {
  syncSymptoms, syncSymptomsLibrary, syncSymptomsCategories, syncSymptomClearDays,
  syncNutritionLibrary, syncNutritionLogs, syncJournal, pruneStaleSyncMeta, writeOncePayload, beats,
} = sync.__test;
const { flushSync } = sync;

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.error(`  FAIL ${name}`); }
}

const iso = (ms) => new Date(ms).toISOString();
const now = Date.now();

// Edits are stamped in the PAST, as real edits always are, and the device's push
// watermark is rewound to just before the edit - which is exactly what an offline
// device looks like when it reconnects. Stamping edits in the future instead
// would let a device re-push an already-pushed document forever, which no real
// clock produces.
const ago = (seconds) => iso(now - seconds * 1000);
// Only the write-once domains have a watermark now; the mutable domains gate
// their push on the remote snapshot instead, so for Y2-Y7 this is inert setup
// kept for the (now historical) shape of an offline device reconnecting.
function rewindWatermark(seconds) {
  const meta = JSON.parse(mem.get('glim-sync-meta') ?? '{}');
  meta.nutritionPushedAt = ago(seconds);
  mem.set('glim-sync-meta', JSON.stringify(meta));
}

const getLogs  = () => JSON.parse(mem.get('glim-symptoms')).logs;
const getItems = () => JSON.parse(mem.get('glim-symptoms-library')).items;
const findLog  = (id) => getLogs().find(e => e.id === id);

function setLogs(logs)   { mem.set('glim-symptoms', JSON.stringify({ logs })); }
function setItems(items) { mem.set('glim-symptoms-library', JSON.stringify({ items })); }

function entry(over = {}) {
  const at = over.updatedAt ?? ago(300);
  return {
    id: 'e1', symptomId: 's1', kind: 'moment', intensity: null, note: null,
    startedAt: ago(300), endedAt: null, createdAt: ago(300), updatedAt: at,
    date: '2026-08-14', deletedAt: null, ...over,
  };
}

// ===== Y1: a new entry pushes, and device B pulls it =====
FS.__reset();
const devA = new Map(), devB = new Map();
mem = devA; setLogs([entry({ id: 'e1', note: 'first' })]);
await syncSymptoms('U');
check('Y1: entry pushed to Firestore', FS.__has('users/U/symptoms/e1'));

mem = devB; setLogs([]);
await syncSymptoms('U');
check('Y1: device B pulled the entry', !!findLog('e1') && findLog('e1').note === 'first');

// ===== Y2: an EDIT (not a creation) propagates =====
mem = devA;
{
  const logs = getLogs();
  logs[0].intensity = 6;
  logs[0].note      = 'worse when i woke up';
  logs[0].updatedAt = ago(120);
  setLogs(logs);
}
rewindWatermark(180);          // the edit happened after A last pushed
await syncSymptoms('U');
check('Y2: the edit reached Firestore', FS.__get('users/U/symptoms/e1').intensity === 6);

mem = devB;
await syncSymptoms('U');
check('Y2: device B received the edited intensity', findLog('e1').intensity === 6);
check('Y2: device B received the edited note', findLog('e1').note === 'worse when i woke up');

// ===== Y3: EDGE CASE 7 - concurrent offline edits, newer updatedAt wins wholesale =====
FS.__reset();
const devC = new Map(), devD = new Map();

// Both devices start from the same synced entry.
mem = devC; setLogs([entry({ id: 'e2', intensity: 3, note: 'base' })]);
await syncSymptoms('V');
mem = devD; setLogs([]);
await syncSymptoms('V');
check('Y3: both devices hold the same base entry', findLog('e2').intensity === 3);

// Offline: C changes the note (older edit), D changes the intensity (newer edit).
mem = devC;
{ const l = getLogs(); l[0].note = 'edited on C'; l[0].updatedAt = ago(120); setLogs(l); rewindWatermark(150); }
mem = devD;
{ const l = getLogs(); l[0].intensity = 9; l[0].updatedAt = ago(60); setLogs(l); rewindWatermark(150); }

// Both come back online; C pushes first, D second (D's doc is newer).
mem = devC; await syncSymptoms('V');
mem = devD; await syncSymptoms('V');
mem = devC; await syncSymptoms('V');   // C pulls: it must adopt D's newer document

check('Y3: the newer edit wins on the losing device', findLog('e2').intensity === 9);
check('Y3: the merge is WHOLESALE - the older device\'s note edit is dropped, not merged',
  findLog('e2').note === 'base');
check('Y3: remote reflects the newer document', FS.__get('users/V/symptoms/e2').intensity === 9);

// ===== Y4: soft-delete does not reappear, and propagates =====
FS.__reset();
const devE = new Map(), devF = new Map();
mem = devE; setLogs([entry({ id: 'e3' })]);
await syncSymptoms('W');
mem = devF; setLogs([]);
await syncSymptoms('W');
check('Y4: device F pulled the entry', !!findLog('e3'));

mem = devE;
{
  const l = getLogs();
  l[0].deletedAt = ago(60);
  l[0].updatedAt = ago(60);
  setLogs(l);
}
rewindWatermark(120);
await syncSymptoms('W');
await syncSymptoms('W');   // a second cycle must not resurrect it locally
check('Y4: the entry stays soft-deleted locally', !!findLog('e3').deletedAt);

mem = devF; await syncSymptoms('W');
check('Y4: the soft-delete propagated to device F', !!findLog('e3').deletedAt);
check('Y4: the row itself is retained (soft, not hard, delete)', getLogs().length === 1);

// ===== Y5: library rename and archive propagate =====
FS.__reset();
const libA = new Map(), libB = new Map();
mem = libA;
setItems([{ id: 'i1', name: 'wrist pain', category: 'pain',
  createdAt: ago(300), updatedAt: ago(300), deletedAt: null }]);
await syncSymptomsLibrary('X');
mem = libB; setItems([]);
await syncSymptomsLibrary('X');
check('Y5: device B pulled the library item', getItems()[0]?.name === 'wrist pain');

mem = libA;
{
  const items = getItems();
  items[0].name      = 'left wrist pain';
  items[0].deletedAt = ago(60);               // archived
  items[0].updatedAt = ago(60);
  setItems(items);
}
rewindWatermark(120);
await syncSymptomsLibrary('X');
mem = libB; await syncSymptomsLibrary('X');
check('Y5: the rename propagated', getItems()[0].name === 'left wrist pain');
check('Y5: the archive propagated', !!getItems()[0].deletedAt);

// ===== Y6: categories round-trip, and fixed seed ids converge =====
FS.__reset();
const getCats = () => JSON.parse(mem.get('glim-symptoms-categories')).items;
const setCats = (items) => mem.set('glim-symptoms-categories', JSON.stringify({ items }));

// The seed row EVERY device writes for itself, byte-identical by construction:
// fixed id, fixed timestamps. See utils/symptomCategories.js.
const seedRow = (id, name) => ({
  id, name, color: '#9b96b8', order: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  deletedAt: null,
});

const catA = new Map(), catB = new Map();
mem = catA; setCats([seedRow('cat-pain', 'pain'), seedRow('cat-other', 'other')]);
await syncSymptomsCategories('Y');
check('Y6: categories pushed to Firestore', FS.__has('users/Y/symptom-categories/cat-pain'));

// Device B seeded ITSELF before ever syncing - the real situation on a second
// install. Because the ids are fixed rather than uuids, the id-keyed merge sees
// the same documents and produces two rows, not four duplicates.
mem = catB; setCats([seedRow('cat-pain', 'pain'), seedRow('cat-other', 'other')]);
await syncSymptomsCategories('Y');
check('Y6: independently seeded devices converge to ONE row per category',
  getCats().length === 2 &&
  getCats().filter(c => c.id === 'cat-pain').length === 1);

// A rename on A must beat B's freshly written seed row, which is exactly what
// the fixed PAST seed timestamp guarantees.
mem = catA;
{ const c = getCats(); c[0].name = 'aches'; c[0].updatedAt = ago(60); setCats(c); }
rewindWatermark(120);
await syncSymptomsCategories('Y');
mem = catB; await syncSymptomsCategories('Y');
check('Y6: a rename beats a freshly seeded row on another device',
  getCats().find(c => c.id === 'cat-pain').name === 'aches');

// Archive propagates like every other soft delete here.
mem = catA;
{ const c = getCats(); c[0].deletedAt = ago(30); c[0].updatedAt = ago(30); setCats(c); }
rewindWatermark(60);
await syncSymptomsCategories('Y');
mem = catB; await syncSymptomsCategories('Y');
check('Y6: a category archive propagates',
  !!getCats().find(c => c.id === 'cat-pain').deletedAt);

// ===== Y7: clear-day records round-trip, keyed by the logical date =====
FS.__reset();
const getDays = () => JSON.parse(mem.get('glim-symptom-days')).days;
const setDays = (days) => mem.set('glim-symptom-days', JSON.stringify({ days }));

const dayA = new Map(), dayB = new Map();
mem = dayA;
setDays([{ id: '2026-09-04', status: 'none', recordedAt: ago(300), updatedAt: ago(300), deletedAt: null }]);
await syncSymptomClearDays('Z');
check('Y7: the clear day is stored under the LOGICAL DATE as its document id',
  FS.__has('users/Z/symptom-days/2026-09-04'));

mem = dayB; setDays([]);
await syncSymptomClearDays('Z');
check('Y7: device B pulled the clear day',
  getDays().length === 1 && getDays()[0].id === '2026-09-04' &&
  getDays()[0].status === 'none');

// B logs a symptom on that day, which unmarks the record; the date-keyed
// document means the two devices are editing ONE row, resolved by updatedAt.
mem = dayB;
{ const d = getDays(); d[0].deletedAt = ago(60); d[0].updatedAt = ago(60); setDays(d); }
rewindWatermark(120);
await syncSymptomClearDays('Z');
mem = dayA; await syncSymptomClearDays('Z');
check('Y7: an unmark propagates as a soft delete', !!getDays()[0].deletedAt);
check('Y7: the day still has exactly one row', getDays().length === 1);

// Re-marking the same day later must revive the same document, never add a
// second - the idempotence the date-as-id buys.
mem = dayA;
{ const d = getDays(); d[0].deletedAt = null; d[0].updatedAt = ago(10); setDays(d); }
rewindWatermark(30);
await syncSymptomClearDays('Z');
mem = dayB; await syncSymptomClearDays('Z');
check('Y7: re-marking revives the same document', !getDays()[0].deletedAt && getDays().length === 1);

// ===== Y8: THE D1 REGRESSION - stale offline edit must not clobber newer remote =====
//
// Timeline (the reviewer's reproduction, verbatim):
//   T1  phone marks the day clear, OFFLINE
//   T2  laptop unmarks it (logged a symptom), and syncs -> remote = unmarked, T2
//   T3  phone reconnects and syncs
// The phone's copy is OLDER. It must lose, and both devices must end up holding
// the laptop's T2 document. Before the fix the phone's blind push wrote T1 over
// T2 (updatedAt included), the laptop never re-pushed (its watermark had
// advanced) and never adopted (its local T2 beat the regressed remote T1):
// permanent divergence.
FS.__reset();
const phone = new Map(), laptop = new Map();
const D = '2026-09-06';

mem = laptop;
setDays([{ id: D, status: 'none', recordedAt: ago(300), updatedAt: ago(120), deletedAt: ago(120) }]);
await syncSymptomClearDays('Q');           // laptop's newer UNMARK is on the server
check('Y8: setup - remote holds the newer (unmarked) copy',
  !!FS.__get(`users/Q/symptom-days/${D}`).deletedAt);

mem = phone;
setDays([{ id: D, status: 'none', recordedAt: ago(300), updatedAt: ago(200), deletedAt: null }]);
await syncSymptomClearDays('Q');           // phone reconnects with its OLDER mark

check('Y8: the stale push did NOT overwrite the newer remote copy',
  !!FS.__get(`users/Q/symptom-days/${D}`).deletedAt &&
  FS.__get(`users/Q/symptom-days/${D}`).updatedAt === ago(120));
check('Y8: the phone adopted the newer remote copy instead',
  !!getDays()[0].deletedAt && getDays()[0].updatedAt === ago(120));

// Metamorphic convergence: alternate syncs until nothing moves, then both
// devices and the server must hold byte-identical documents.
mem = laptop; await syncSymptomClearDays('Q');
mem = phone;  await syncSymptomClearDays('Q');
mem = laptop; await syncSymptomClearDays('Q');
const phoneDoc  = JSON.stringify((phone.get('glim-symptom-days')  && JSON.parse(phone.get('glim-symptom-days')).days[0]));
const laptopDoc = JSON.stringify((laptop.get('glim-symptom-days') && JSON.parse(laptop.get('glim-symptom-days')).days[0]));
const remoteDoc = JSON.stringify(FS.__get(`users/Q/symptom-days/${D}`));
check('Y8: both devices converge to byte-identical documents',
  phoneDoc === laptopDoc && laptopDoc === remoteDoc);

// Same shape for a UUID-keyed domain, with the roles reversed so the fix is
// not accidentally direction-dependent.
FS.__reset();
const devP = new Map(), devQ = new Map();
mem = devP; setLogs([entry({ id: 'e9', intensity: 2, updatedAt: ago(200) })]);
await syncSymptoms('R');
mem = devQ; setLogs([]);
await syncSymptoms('R');
{ const l = getLogs(); l[0].intensity = 8; l[0].updatedAt = ago(60); setLogs(l); }
await syncSymptoms('R');                                     // Q pushes the newer edit
mem = devP;
{ const l = getLogs(); l[0].intensity = 5; l[0].updatedAt = ago(150); setLogs(l); }  // older edit, made offline
await syncSymptoms('R');                                     // P reconnects
check('Y8: (symptoms) the older offline edit loses to the newer remote edit',
  findLog('e9').intensity === 8 && FS.__get('users/R/symptoms/e9').intensity === 8);

// ===== Y9: INVARIANT - a push never lowers a remote document's updatedAt =====
//
// Observed at the mock's write hook across every mutable domain, with each
// device holding a mix of older and newer rows relative to the server. This is
// the property the Firestore rule in firestore.rules also enforces server-side.
// Note the fixture: device B has no watermark (first sync / meta evicted), which
// is why the OLD code fails it - with a realistic watermark the old code would
// not have pushed B's stale row in this particular fixture. Y8 is the test that
// carries the offline-edit case; Y9 is the first-sync case.
FS.__reset();
const regressions = [];
FS.__setWriteHook((path, prev, next) => {
  if (prev && prev.updatedAt && next.updatedAt && next.updatedAt < prev.updatedAt) {
    regressions.push(path);
  }
});

const mkRow = (id, updatedAt, extra = {}) =>
  ({ id, createdAt: ago(1000), updatedAt, deletedAt: null, ...extra });

const DOMAINS = [
  { fn: syncSymptoms,           key: 'glim-symptoms',            field: 'logs',  mk: (id, t) => entry({ id, updatedAt: t }) },
  { fn: syncSymptomsLibrary,    key: 'glim-symptoms-library',    field: 'items', mk: (id, t) => mkRow(id, t, { name: id, categoryId: 'cat-other' }) },
  { fn: syncSymptomsCategories, key: 'glim-symptoms-categories', field: 'items', mk: (id, t) => mkRow(id, t, { name: id, color: '#000', order: 0 }) },
  { fn: syncSymptomClearDays,   key: 'glim-symptom-days',        field: 'days',  mk: (id, t) => ({ id, status: 'none', recordedAt: t, updatedAt: t, deletedAt: null }) },
  { fn: syncNutritionLibrary,   key: 'glim-nutrition-library',   field: 'items', mk: (id, t) => mkRow(id, t, { name: id, usageCount: 0 }) },
];

for (const d of DOMAINS) {
  const a = new Map(), b = new Map();
  // Server (via A): row x at T-100, row y at T-100.
  mem = a; a.set(d.key, JSON.stringify({ [d.field]: [d.mk('x', ago(100)), d.mk('y', ago(100))] }));
  await d.fn('S');
  // B: x is OLDER than the server (must not push), y is NEWER (must push), z is new.
  mem = b; b.set(d.key, JSON.stringify({ [d.field]: [d.mk('x', ago(300)), d.mk('y', ago(50)), d.mk('z', ago(10))] }));
  await d.fn('S');
  mem = a; await d.fn('S');
  mem = b; await d.fn('S');
  const rows = (m) => JSON.parse(m.get(d.key))[d.field].map(r => `${r.id}:${r.updatedAt}`).sort().join('|');
  check(`Y9: (${d.key}) devices converge and the newer row wins`,
    rows(a) === rows(b) && rows(a) === ['x:' + ago(100), 'y:' + ago(50), 'z:' + ago(10)].join('|'));
}
FS.__setWriteHook(null);
check('Y9: no push lowered any remote updatedAt across all five mutable domains',
  regressions.length === 0);

// ===== Y10: a failed push is retried on the next sync =====
//
// Under the watermark gate, the sync stamped pushedAt = now at the END of the
// run regardless of per-row success, so a row whose setDoc failed was never
// considered "new" again. Gating on the remote snapshot instead means a row the
// server does not hold is pushed on every sync until it lands.
FS.__reset();
const flaky = new Map();
mem = flaky; setLogs([entry({ id: 'e10', note: 'must arrive' })]);

const origWarn = console.warn;
console.warn = () => {};                                   // silence the expected failure
FS.__setWriteHook((path) => { if (path.endsWith('/e10')) throw new Error('simulated network failure'); });
await syncSymptoms('T');
console.warn = origWarn;
FS.__setWriteHook(null);
check('Y10: the push genuinely failed', !FS.__has('users/T/symptoms/e10'));

await syncSymptoms('T');                                   // next sync, network fine
check('Y10: the row is retried and lands on the next sync',
  FS.__has('users/T/symptoms/e10') && FS.__get('users/T/symptoms/e10').note === 'must arrive');

// Steady state: once every row matches, a sync performs zero writes.
let writes = 0;
FS.__setWriteHook(() => { writes++; });
await syncSymptoms('T');
FS.__setWriteHook(null);
check('Y10: a fully synced collection performs zero pushes', writes === 0);

// ===== Y11: retired watermark keys are pruned; live ones survive =====
mem = new Map();
mem.set('glim-sync-meta', JSON.stringify({
  journalPushedAt: ago(5), waterPushedAt: ago(6), stepsPushedAt: ago(7), nutritionPushedAt: ago(8),
  nutritionLibraryPushedAt: ago(9), symptomsPushedAt: ago(9), symptomsLibraryPushedAt: ago(9),
  symptomsCategoriesPushedAt: ago(9), symptomDaysPushedAt: ago(9),
}));
pruneStaleSyncMeta();
const metaAfter = JSON.parse(mem.get('glim-sync-meta'));
check('Y11: all five retired *PushedAt keys are pruned',
  ['nutritionLibraryPushedAt', 'symptomsPushedAt', 'symptomsLibraryPushedAt',
   'symptomsCategoriesPushedAt', 'symptomDaysPushedAt'].every(k => !(k in metaAfter)));
check('Y11: the four live write-once watermarks are retained untouched',
  metaAfter.journalPushedAt === ago(5) && metaAfter.waterPushedAt === ago(6) &&
  metaAfter.stepsPushedAt === ago(7) && metaAfter.nutritionPushedAt === ago(8));
const before = mem.get('glim-sync-meta');
pruneStaleSyncMeta();
check('Y11: pruning an already-clean meta is a no-op write',
  mem.get('glim-sync-meta') === before);

// ===== Y12: a malformed updatedAt loses; two malformed stamps tie =====
check('Y12: beats() - well-formed beats malformed', beats(ago(10), 'garbage') === true);
check('Y12: beats() - malformed never beats well-formed', beats('garbage', ago(1000)) === false);
check('Y12: beats() - two malformed stamps tie', beats('garbage', 'nonsense') === false);
check('Y12: beats() - missing loses to any real stamp', beats(undefined, ago(1000)) === false && beats(ago(1000), undefined) === true);
check('Y12: beats() - equal stamps do not beat each other', beats(ago(5), ago(5)) === false);

// Remote corrupt, local good: the good copy must reach the server and a fresh
// device must receive the good copy, not the corrupt one.
FS.__reset();
FS.__seed('users/M/symptoms/c1', entry({ id: 'c1', note: 'garbage-remote', updatedAt: 'not-a-date' }));
const good = new Map(), fresh = new Map();
mem = good; setLogs([entry({ id: 'c1', note: 'good-local', updatedAt: ago(100) })]);
await syncSymptoms('M');
check('Y12: a well-formed local copy is pushed OVER a malformed remote one',
  FS.__get('users/M/symptoms/c1').note === 'good-local' &&
  FS.__get('users/M/symptoms/c1').updatedAt === ago(100));
check('Y12: the malformed remote copy was not adopted locally', findLog('c1').note === 'good-local');
mem = fresh; setLogs([]);
await syncSymptoms('M');
check('Y12: a fresh device receives the healed copy', findLog('c1').note === 'good-local');

// Local corrupt, remote good: the good remote copy must replace it.
FS.__reset();
FS.__seed('users/M2/symptoms/c2', entry({ id: 'c2', note: 'good-remote', updatedAt: ago(100) }));
const corrupt = new Map();
mem = corrupt; setLogs([entry({ id: 'c2', note: 'garbage-local', updatedAt: 'not-a-date' })]);
let corruptWrites = 0;
FS.__setWriteHook(() => { corruptWrites++; });
await syncSymptoms('M2');
FS.__setWriteHook(null);
check('Y12: a malformed local copy is replaced by the well-formed remote one',
  findLog('c2').note === 'good-remote' && findLog('c2').updatedAt === ago(100));
check('Y12: the malformed local copy was never pushed', corruptWrites === 0);

// Both corrupt: accepted non-convergent state, nothing moves.
FS.__reset();
FS.__seed('users/M3/symptoms/c3', entry({ id: 'c3', note: 'r', updatedAt: 'x' }));
const both = new Map();
mem = both; setLogs([entry({ id: 'c3', note: 'l', updatedAt: 'y' })]);
let bothWrites = 0;
FS.__setWriteHook(() => { bothWrites++; });
await syncSymptoms('M3');
FS.__setWriteHook(null);
check('Y12: two malformed stamps tie - no write, no adoption (documented)',
  bothWrites === 0 && findLog('c3').note === 'l' && FS.__get('users/M3/symptoms/c3').note === 'r');

// ===== Y13: a write-once re-push never clears a soft-delete =====
//
// Nutrition logs are created with an explicit `deletedAt: null`. Timeline:
//   phone logs an entry; tab hides; flushSync pushes it (watermark NOT advanced,
//   by design). Laptop pulls it, undoes it (deletedAt = T), pushes. Phone
//   foregrounds; syncNutritionLogs re-pushes the row because createdAt is still
//   newer than its watermark. With merge:true and a literal null, that write
//   cleared the laptop's deletedAt, and the pull side (which only propagates a
//   TRUTHY remote deletedAt) could never repair it.
check('Y13: writeOncePayload omits a null deletedAt',
  !('deletedAt' in writeOncePayload({ id: 'p', deletedAt: null })));
check('Y13: writeOncePayload omits an undefined deletedAt',
  !('deletedAt' in writeOncePayload({ id: 'p' })));
check('Y13: writeOncePayload keeps a real deletedAt',
  writeOncePayload({ id: 'p', deletedAt: ago(1) }).deletedAt === ago(1));
check('Y13: writeOncePayload does not mutate its input',
  (() => { const e = { id: 'p', deletedAt: null }; writeOncePayload(e); return 'deletedAt' in e; })());

FS.__reset();
const nLog = (over = {}) => ({
  id: 'n1', date: '2026-09-06', createdAt: ago(300), deletedAt: null,
  items: [], ...over,
});
const phoneN = new Map(), laptopN = new Map();
const clears = [];
FS.__setWriteHook((path, prev, next) => {
  if (prev && prev.deletedAt && next.deletedAt === null) clears.push(path);
});

mem = phoneN; phoneN.set('glim-nutrition', JSON.stringify({ logs: [nLog()] }));
await flushSync('N');                                       // tab-hide push, no watermark advance
check('Y13: the flushed row carries NO deletedAt key on the server',
  FS.__has('users/N/nutrition/n1') && !('deletedAt' in FS.__get('users/N/nutrition/n1')));

mem = laptopN; laptopN.set('glim-nutrition', JSON.stringify({ logs: [] }));
await syncNutritionLogs('N');
check('Y13: laptop pulled the row', JSON.parse(laptopN.get('glim-nutrition')).logs[0]?.id === 'n1');
{ const l = JSON.parse(laptopN.get('glim-nutrition')).logs; l[0].deletedAt = ago(60); laptopN.set('glim-nutrition', JSON.stringify({ logs: l })); }
rewindWatermark(120);
await syncNutritionLogs('N');
check('Y13: the laptop undo reached the server', FS.__get('users/N/nutrition/n1').deletedAt === ago(60));

mem = phoneN;                                               // foreground: re-push is inevitable
await syncNutritionLogs('N');
FS.__setWriteHook(null);
check('Y13: the phone re-push did NOT clear the soft-delete on the server',
  FS.__get('users/N/nutrition/n1').deletedAt === ago(60));
check('Y13: no write anywhere cleared a deletedAt', clears.length === 0);
check('Y13: the phone adopted the soft-delete on its pull',
  JSON.parse(phoneN.get('glim-nutrition')).logs[0].deletedAt === ago(60));

// ===== Y14: a null element in a local array is skipped, not fatal =====
FS.__reset();
const nully = new Map();
mem = nully; nully.set('glim-symptoms', JSON.stringify({ logs: [null, entry({ id: 'ok1' }), 42] }));
const warns = [];
const origWarn2 = console.warn;
console.warn = (...a) => { warns.push(a.join(' ')); };
let threw = false;
try { await syncSymptoms('Z9'); } catch { threw = true; }
console.warn = origWarn2;
check('Y14: a null element does not throw', threw === false);
check('Y14: the good row in the same domain still syncs', FS.__has('users/Z9/symptoms/ok1'));
check('Y14: the skip is warned, naming the count', warns.some(w => /skipped 2 malformed/.test(w)));

// ===== Y15: a journal soft-delete reaches a device that already has the entry =====
// glim-journal is a bare array (no wrapper object), and entries carry `date`
// rather than createdAt, exactly as DesktopPet.saveJournalEntry writes them.
FS.__reset();
const jA = new Map(), jB = new Map();
const jEntry = { id: 'j1', text: 'first', prompt: 'p', date: ago(300) };

mem = jA; jA.set('glim-journal', JSON.stringify([jEntry]));
await syncJournal('J');
mem = jB; jB.set('glim-journal', JSON.stringify([]));
await syncJournal('J');
check('Y15: device B pulled the journal entry',
  JSON.parse(jB.get('glim-journal')).some(e => e.id === 'j1' && !e.deletedAt));

// A deletes; its watermark is rewound so the push filter sees the deletion.
mem = jA;
{ const j = JSON.parse(jA.get('glim-journal')); j[0].deletedAt = ago(60); jA.set('glim-journal', JSON.stringify(j)); }
{ const m = JSON.parse(jA.get('glim-sync-meta') ?? '{}'); m.journalPushedAt = ago(120); jA.set('glim-sync-meta', JSON.stringify(m)); }
await syncJournal('J');
check('Y15: the soft-delete reached the server', FS.__get('users/J/journal/j1').deletedAt === ago(60));

mem = jB; await syncJournal('J');
check('Y15: device B, which already held the entry, adopted the soft-delete',
  JSON.parse(jB.get('glim-journal')).find(e => e.id === 'j1').deletedAt === ago(60));
check('Y15: the row is retained (soft, not hard, delete)',
  JSON.parse(jB.get('glim-journal')).length === 1);

// A newer local deletedAt must not be overwritten by an older remote one.
{ const j = JSON.parse(jB.get('glim-journal')); j[0].deletedAt = ago(10); jB.set('glim-journal', JSON.stringify(j)); }
await syncJournal('J');
check('Y15: a newer local deletedAt survives a pull carrying an older one',
  JSON.parse(jB.get('glim-journal')).find(e => e.id === 'j1').deletedAt === ago(10));

// ===== Y16: D4 - a not-yet-synced clear-day mark loses to the log's tombstone =====
FS.__reset();
const dA = new Map(), dB = new Map();
const DD = '2026-09-05';
mem = dA;
setDays([{ id: DD, status: 'none', recordedAt: ago(100), updatedAt: ago(100), deletedAt: null }]);
await syncSymptomClearDays('D4');                              // A's mark is on the server
// B has never seen the mark. B logs a symptom on that day; the panel calls
// unmarkClear, which (D4) lays a tombstone even with no local row.
mem = dB;
setDays([{ id: DD, status: 'none', recordedAt: ago(50), updatedAt: ago(50), deletedAt: ago(50) }]);
await syncSymptomClearDays('D4');                              // B pulls A's older mark, keeps its tombstone, pushes it
check('Y16: B keeps its tombstone against the older remote mark',
  !!getDays().find(d => d.id === DD).deletedAt);
check('Y16: the tombstone reached the server', !!FS.__get(`users/D4/symptom-days/${DD}`).deletedAt);
mem = dA; await syncSymptomClearDays('D4');
check('Y16: A adopts the tombstone - the day is not clear anywhere',
  !!getDays().find(d => d.id === DD).deletedAt);
check('Y16: still exactly one row per day on both devices',
  JSON.parse(dA.get('glim-symptom-days')).days.length === 1 &&
  JSON.parse(dB.get('glim-symptom-days')).days.length === 1);

// The run-generation guard (Decision Register 2026-09-10) must never fire on a
// live session. These scenarios never call startSync/stopSync, so a skip here
// means a domain function captured its generation AFTER an await.
check('no stale-run skips across the suite', sync.__test.staleSkips() === 0);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
