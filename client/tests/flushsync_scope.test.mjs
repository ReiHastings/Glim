// title: flushsync_scope.test.mjs
// project: Glim
// author: Reina Hastings
// contact: reinahastings13@gmail.com
//
// purpose:
//   Static-analysis invariant test (no framework, no Firebase import) that locks
//   the C1 guarantee: flushWriteOnce (the tab-hide push, named flushSync until
//   2026-09-10) must push ONLY the four WRITE-ONCE entry-log domains (journal,
//   water, steps, nutrition logs) and nothing else.
//
//   Two families are excluded, for two different reasons:
//     - singletons (pokes, settings, *-config): take-the-max / last-write-wins
//       docs whose safe push requires first READING the remote copy. A blind
//       push would skip that read and clobber newer remote data.
//     - MUTABLE id-keyed domains (nutrition-library, symptoms, symptoms-library,
//       symptom-categories, symptom-days): edited in place. A blind push of a
//       stale row overwrites a newer remote copy INCLUDING its updatedAt, after
//       which last-write-wins has nothing newer to prefer and the devices
//       diverge permanently. Being id-keyed is NOT the property that makes a
//       blind push safe; write-once is. These were in flush scope from Phase 1
//       to Phase 1.5 on the id-keyed argument, and this test previously
//       asserted their presence. It now asserts their absence.
//
//   Also asserts: the mutable-domain sync pulls BEFORE it pushes; sign-out
//   awaits flushSync (the full run, which has the read) rather than
//   flushWriteOnce; syncAll is private to the scheduler; the flush-on-tab-hide
//   wiring is present.
//
//   Also guards the W1 UID-change fix: App.jsx must re-hydrate stores through
//   reloadAllStores() and must never carry a hardcoded per-store reload list,
//   which is how the nutrition (a53da46) and symptom domains were each missed.
//
// usage:
//   cd client && node tests/flushsync_scope.test.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '../src/sync.js'), 'utf8');

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.error(`  FAIL ${name}`); }
}

// Isolate the flushWriteOnce function body (from its declaration to the
// scheduler banner that follows it).
const start = src.indexOf('export async function flushWriteOnce(');
check('flushWriteOnce is exported', start !== -1);
const end = src.indexOf('//  Scheduler: event-triggered runs', start);
check('the scheduler banner follows flushWriteOnce (body isolation is bounded)', end !== -1);
const body = src.slice(start, end === -1 ? undefined : end);

// Must push each of the four WRITE-ONCE collections.
const FLUSH_DOMAINS = ['journal', 'water', 'steps', 'nutrition'];
for (const col of FLUSH_DOMAINS) {
  check(`flushWriteOnce pushes '${col}'`, body.includes(`'${col}'`));
}

// Must call pushEntries exactly once per write-once domain, and no more: an
// extra call is the signal that something has crept into flush scope.
const pushCount = (body.match(/pushEntries\(/g) || []).length;
check(`flushWriteOnce calls pushEntries exactly ${FLUSH_DOMAINS.length} times`,
  pushCount === FLUSH_DOMAINS.length);

// Must NOT push any MUTABLE id-keyed domain. These are the collections whose
// rows change after creation; a blind push of a stale one is the D1 data-loss
// path.
const MUTABLE_DOMAINS = [
  'nutrition-library', 'symptoms', 'symptoms-library', 'symptom-categories', 'symptom-days',
];
for (const col of MUTABLE_DOMAINS) {
  check(`flushWriteOnce does NOT push mutable domain '${col}'`, !body.includes(`'${col}'`));
}

// Must NOT reference any singleton / counter sync or its Firestore path, and must
// perform no reads (getDoc) - a read on the fire-and-forget tab-hide path would
// be the wrong fix; the right one is to keep the read-requiring domains out.
for (const forbidden of [
  'syncPokes', 'syncSettings', 'syncStepsConfig', 'syncNutritionConfig',
  "'pokes'", "'settings'", "'water-config'", "'steps-config'", "'nutrition-config'",
  'getDoc(', 'getDocs(',
]) {
  check(`flushWriteOnce does not reference ${forbidden}`, !body.includes(forbidden));
}

// =============================================================================
//  Mutable-domain sync: PULL BEFORE PUSH (the D1 fix)
// =============================================================================

const mStart = src.indexOf('async function syncUpdatedAtCollection(');
check('syncUpdatedAtCollection exists', mStart !== -1);
const mEnd  = src.indexOf('\n}\n', mStart);
const mBody = src.slice(mStart, mEnd);

const firstRead  = mBody.indexOf('getDocs(');
const firstWrite = mBody.indexOf('setDoc(');
check('syncUpdatedAtCollection reads the collection (getDocs)', firstRead !== -1);
check('syncUpdatedAtCollection writes (setDoc)', firstWrite !== -1);
check('syncUpdatedAtCollection PULLS BEFORE IT PUSHES',
  firstRead !== -1 && firstWrite !== -1 && firstRead < firstWrite);

// The push must be gated on the remote snapshot, not on a local watermark: a
// watermark cannot know what the server holds, and it abandons a row whose push
// failed once. No metaKey, no PushedAt.
check('syncUpdatedAtCollection uses no push watermark',
  !/PushedAt|metaKey|getSyncMeta\(/.test(mBody));
check('syncUpdatedAtCollection compares local updatedAt against the remote copy before pushing',
  /remoteById\.get\(String\(entry\.id\)\)/.test(mBody) &&
  /beats\(entry\.updatedAt, remote\.updatedAt\)/.test(mBody));

// Every mutable domain must ride that one implementation. A second copy of the
// merge is a second place for the push-then-pull hole to reappear.
for (const fn of ['syncNutritionLibrary', 'syncSymptoms', 'syncSymptomsLibrary',
                  'syncSymptomsCategories', 'syncSymptomClearDays']) {
  const fStart = src.indexOf(`async function ${fn}(`);
  const fBody  = src.slice(fStart, src.indexOf('\n}\n', fStart));
  check(`${fn} delegates to syncUpdatedAtCollection`,
    fStart !== -1 && fBody.includes('return syncUpdatedAtCollection('));
}
check('no second copy of the mutable merge remains',
  (src.match(/Object\.assign\(localDoc, remote\)|Object\.assign\(localItem, remote\)/g) || []).length === 1);

// =============================================================================
//  Sign-out runs the FULL sync (flushSync), not the write-once flush
// =============================================================================

const settings = readFileSync(join(here, '../src/components/SettingsView.jsx'), 'utf8');
check('sign-out awaits flushSync (the full run, which has the read)',
  /await flushSync\('sign-out'\)/.test(settings));
check('sign-out does not call flushWriteOnce', !/flushWriteOnce\(/.test(settings));
check('sign-out does not call syncAll directly', !/syncAll\(/.test(settings));
check('syncAll is private (only the scheduler and the test seam reach it)',
  /^async function syncAll\(/m.test(src) && !/export async function syncAll\(/.test(src));
check('flushSync waits for a run in flight before running',
  /while \(syncInFlight\) await new Promise/.test(src));

// One domain rejecting (a synchronous throw on corrupt local data) must not
// resolve syncAll early while the others are mid-push: on the sign-out path
// that lets signOut() revoke the token underneath them.
const saStart = src.indexOf('async function syncAll(');
const saBody  = src.slice(saStart, src.indexOf('\n}\n', saStart));
check('syncAll uses Promise.allSettled, not Promise.all',
  saBody.includes('Promise.allSettled(') && !saBody.includes('Promise.all('));

// =============================================================================
//  Write-once pushes must never write a null deletedAt
// =============================================================================
// setDoc with merge writes every field given, null included, so a stale
// re-push of a row created with `deletedAt: null` would clear a soft-delete
// another device has recorded. Every write-once setDoc site must go through
// writeOncePayload, which omits the field when null.
// \w+ rather than [a-zA-Z]+Ref: pushEntries names its collection ref `ref`.
const writeOnceSites = (src.match(/setDoc\(doc\(\w+, String\(entry\.id\)\), writeOncePayload\(entry\), \{ merge: true \}\)/g) || []).length;
const rawSites       = (src.match(/setDoc\(doc\(\w+, String\(entry\.id\)\), entry, \{ merge: true \}\)/g) || []).length;
check('all five write-once setDoc sites (pushEntries + 4 sync fns) use writeOncePayload',
  writeOnceSites === 5);
check('the only raw setDoc(entry) site left is the mutable-domain push (which needs the full row)',
  rawSites === 1 && mBody.includes('setDoc(doc(docsRef, String(entry.id)), entry, { merge: true })'));

// Merge and push must both use beats(), the NaN-aware comparison, not a bare >.
check('mutable merge adopts remote via beats()',
  /beats\(remote\.updatedAt, localDoc\.updatedAt\)/.test(mBody));
check('mutable push gates via beats()',
  /!beats\(entry\.updatedAt, remote\.updatedAt\)/.test(mBody));
check('no bare ts() > ts() comparison remains in the mutable sync',
  !/ts\([^)]*\) > ts\(/.test(mBody));

// Flush-on-hide wiring must be present in startSync.
check('startSync flushes write-once rows on tab-hide', /if \(document\.hidden\) flushWriteOnce\(\)/.test(src));

// =============================================================================
//  W1 - the UID-change guard must not name stores individually
// =============================================================================

const app = readFileSync(join(here, '../src/App.jsx'), 'utf8');

check('App.jsx re-hydrates through reloadAllStores()',
  /reloadAllStores\(\)/.test(app) &&
  /import \{[^}]*reloadAllStores[^}]*\} from '\.\/stores'/.test(app));

// The failure mode this locks: a per-store list silently omits a domain added
// later, leaving the OUTGOING user's rows in Zustand memory to be re-persisted
// and pushed to Firestore under the NEW user's uid. For the symptom diary that
// is health data crossing accounts.
const namedReloads = app.match(/use[A-Za-z]+Store\.getState\(\)\.reload\(\)/g) || [];
check('App.jsx contains no hardcoded per-store reload list',
  namedReloads.length === 0);
check('App.jsx imports no individual store modules',
  !/from '\.\/stores\/use[A-Za-z]+Store'/.test(app));

// The barrel's registry and its export list must stay in step, since the
// registry is what reloadAllStores walks.
const barrel = readFileSync(join(here, '../src/stores/index.js'), 'utf8');
const exportBlock   = barrel.slice(barrel.indexOf('export {'), barrel.indexOf('};', barrel.indexOf('export {')));
const registryBlock = barrel.slice(barrel.indexOf('export const ALL_STORES = ['), barrel.indexOf('];'));
const names = (block) =>
  [...new Set(block.match(/use[A-Za-z]+Store/g) || [])].sort().join(',');
check('every exported store is registered in ALL_STORES',
  names(exportBlock) === names(registryBlock) && names(exportBlock).length > 0);
check('ALL_STORES registers both new symptom domains',
  registryBlock.includes('useSymptomsCategoriesStore') &&
  registryBlock.includes('useSymptomClearDaysStore'));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
