// title: cycle_enable.test.mjs
// project: Glim
// author: Reina Hastings
// contact: reinahastings13@gmail.com
//
// purpose:
//   Tests for the cycle feature's first-enable path: the fixed-id ensure
//   actions, the per-device record, the name-collision predicate, and the
//   enable planner.
//
//   The load-bearing property is CONVERGENCE, not idempotence. Two devices
//   enabling while offline each run setup independently, then merge by id. With
//   random ids that produces duplicate `cramps` rows with no dedupe path; with
//   fixed ids and a SEED_AT stamp they converge on one row and a later rename
//   still wins. This file simulates that merge rather than asserting it.
//
// inputs:  none (seeds its own localStorage)
// outputs: per-check pass/fail; exits non-zero if any check fails
//
// usage:
//   cd client && node --import ./tests/register-hooks.mjs tests/cycle_enable.test.mjs

const mem = new Map();
globalThis.localStorage = {
  getItem: k => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => { mem.set(k, String(v)); },
  removeItem: k => { mem.delete(k); },
  clear: () => mem.clear(),
  key: i => [...mem.keys()][i] ?? null,
  get length() { return mem.size; },
};

const { useSymptomsLibraryStore } = await import('../src/stores/useSymptomsLibraryStore.js');
const { useSymptomsCategoriesStore } = await import('../src/stores/useSymptomsCategoriesStore.js');
const { readCycleRecord, writeCycleRecord } = await import('../src/cycle/deviceRecord.js');
const { planEnable } = await import('../src/cycle/enable.js');
const { normalizeName, namesCollide, collidingIds, itemsCollidingWith } =
  await import('../src/utils/symptomNames.js');
const { MENSTRUAL_CATEGORY, MENSTRUAL_CATEGORY_ID, MENSTRUAL_STARTERS, SEED_AT } =
  await import('../src/utils/symptomCategories.js');

let passed = 0, failed = 0;
const check = (name, cond, detail) => {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.error(`  FAIL ${name}${detail ? '  -> ' + detail : ''}`); }
};
const L = () => useSymptomsLibraryStore.getState();
const C = () => useSymptomsCategoriesStore.getState();
const resetStores = () => {
  mem.clear();
  useSymptomsLibraryStore.setState({ items: [] });
  useSymptomsCategoriesStore.setState({ items: [] });
};

console.log('\n-- the collision predicate --');
{
  check('identical names collide', namesCollide('back ache', 'back ache'));
  check('case differences collide', namesCollide('Back Ache', 'back ache'));
  check('extra internal whitespace collides', namesCollide('back  ache', 'back ache'));
  check('leading/trailing whitespace collides', namesCollide('  back ache ', 'back ache'));
  check('composed vs decomposed accents collide',
    namesCollide('malaisé', 'malaisé'.replace('é', 'é')) ||
    namesCollide('café', 'café'));
  check('backache does NOT collide with back ache', !namesCollide('backache', 'back ache'));
  check('different names do not collide', !namesCollide('cramps', 'bloating'));
  check('empty names never collide', !namesCollide('', '') && !namesCollide('  ', ''));
  // toLowerCase, not toLocaleLowerCase: the locale-aware form uses the HOST
  // locale, so a Turkish device would fold I differently and two devices would
  // disagree about the same pair of rows.
  check('normalize is locale-independent for I', normalizeName('IRRITABLE') === 'irritable');
}

console.log('\n-- collidingIds --');
{
  const items = [
    { id: 'a', name: 'back ache' }, { id: 'b', name: 'Back  Ache' },
    { id: 'c', name: 'cramps' },    { id: 'd', name: 'backache' },
  ];
  const clash = collidingIds(items);
  check('both members of a colliding pair are flagged', clash.has('a') && clash.has('b'));
  check('a unique name is not flagged', !clash.has('c'));
  check('a near-miss is not flagged', !clash.has('d'));
  check('exactly two ids flagged', clash.size === 2, String(clash.size));
}

console.log('\n-- ensureCategory --');
{
  resetStores();
  const r1 = C().ensureCategory(MENSTRUAL_CATEGORY);
  check('creates the category', r1.created === true);
  const row = C().getCategory(MENSTRUAL_CATEGORY_ID);
  check('with the fixed id', row.id === 'cat-menstrual');
  check('stamped SEED_AT, not now', row.createdAt === SEED_AT && row.updatedAt === SEED_AT);
  const snapshot = JSON.stringify(C().items);
  const r2 = C().ensureCategory(MENSTRUAL_CATEGORY);
  check('a second call creates nothing', r2.created === false);
  check('and leaves state byte-identical', JSON.stringify(C().items) === snapshot);
}

console.log('\n-- ensureItem --');
{
  resetStores();
  for (const s of MENSTRUAL_STARTERS) L().ensureItem({ ...s, categoryId: MENSTRUAL_CATEGORY_ID });
  check(`creates all ${MENSTRUAL_STARTERS.length} starters`,
    L().items.length === MENSTRUAL_STARTERS.length, String(L().items.length));
  check('with fixed ids', L().items.every(i => i.id.startsWith('sym-menstrual-')));
  check('all in the menstrual category',
    L().items.every(i => i.categoryId === MENSTRUAL_CATEGORY_ID));
  check('stamped SEED_AT', L().items.every(i => i.createdAt === SEED_AT));
  const snapshot = JSON.stringify(L().items);
  for (const s of MENSTRUAL_STARTERS) L().ensureItem({ ...s, categoryId: MENSTRUAL_CATEGORY_ID });
  check('re-running setup is byte-identical', JSON.stringify(L().items) === snapshot);
}

console.log('\n-- convergence: two devices enabling offline, then merging --');
{
  // Device A
  resetStores();
  for (const s of MENSTRUAL_STARTERS) L().ensureItem({ ...s, categoryId: MENSTRUAL_CATEGORY_ID });
  C().ensureCategory(MENSTRUAL_CATEGORY);
  const deviceA = { items: JSON.parse(JSON.stringify(L().items)), cats: JSON.parse(JSON.stringify(C().items)) };
  // Device B, independently
  resetStores();
  for (const s of MENSTRUAL_STARTERS) L().ensureItem({ ...s, categoryId: MENSTRUAL_CATEGORY_ID });
  C().ensureCategory(MENSTRUAL_CATEGORY);
  const deviceB = { items: JSON.parse(JSON.stringify(L().items)), cats: JSON.parse(JSON.stringify(C().items)) };

  // The id-keyed last-write-wins merge sync.js performs.
  const merge = (a, b) => {
    const byId = new Map(a.map(r => [r.id, r]));
    for (const r of b) {
      const cur = byId.get(r.id);
      if (!cur || String(r.updatedAt) > String(cur.updatedAt)) byId.set(r.id, r);
    }
    return [...byId.values()];
  };
  check(`merged libraries hold ${MENSTRUAL_STARTERS.length} rows, not double`,
    merge(deviceA.items, deviceB.items).length === MENSTRUAL_STARTERS.length,
    String(merge(deviceA.items, deviceB.items).length));
  check('merged categories hold ONE menstrual row, not two',
    merge(deviceA.cats, deviceB.cats).filter(c => c.id === MENSTRUAL_CATEGORY_ID).length === 1);

  // A rename on one device must survive the merge against the other's creation.
  const renamed = deviceA.items.map(i =>
    i.id === 'sym-menstrual-cramps'
      ? { ...i, name: 'period cramps', updatedAt: '2026-09-18T12:00:00.000Z' } : i);
  const after = merge(renamed, deviceB.items);
  check('a rename beats the other device’s SEED_AT creation',
    after.find(i => i.id === 'sym-menstrual-cramps').name === 'period cramps');
}

console.log('\n-- planEnable --');
{
  resetStores();
  const clean = planEnable([]);
  check('plans every starter on a clean library',
    clean.toCreate.length === MENSTRUAL_STARTERS.length, String(clean.toCreate.length));
  check('reports no collisions', clean.collisions.length === 0);
  check('and carries the category row', clean.category.id === MENSTRUAL_CATEGORY_ID);

  const withBloating = planEnable([
    { id: 'user-1', name: 'Bloating', categoryId: 'cat-digestive' },
  ]);
  check('detects a pre-existing colliding name', withBloating.collisions.length === 1,
    JSON.stringify(withBloating.collisions.map(c => c.starter.name)));
  check('names the colliding starter', withBloating.collisions[0].starter.name === 'bloating');
  check('and points at the existing item', withBloating.collisions[0].existing[0].id === 'user-1');
  check('still offers them all (the user decides)',
    withBloating.toCreate.length === MENSTRUAL_STARTERS.length);

  const alreadySetUp = planEnable(
    MENSTRUAL_STARTERS.map(s => ({ ...s, categoryId: MENSTRUAL_CATEGORY_ID })));
  check('a second enable plans nothing', alreadySetUp.toCreate.length === 0);
  check('and does not re-ask about the user’s own past choice',
    alreadySetUp.collisions.length === 0);

  const archivedOnly = planEnable([
    { id: 'user-2', name: 'bloating', categoryId: 'cat-digestive', deletedAt: '2026-01-01T00:00:00.000Z' },
  ]);
  check('an archived item is not a collision', archivedOnly.collisions.length === 0);
}

console.log('\n-- the per-device record --');
{
  mem.clear();
  check('defaults to off', readCycleRecord().enabled === false);
  check('and to setup not done', readCycleRecord().setupDone === false);
  writeCycleRecord({ enabled: true, setupDone: true, enabledAt: '2026-09-18T00:00:00.000Z' });
  check('persists', readCycleRecord().enabled === true && readCycleRecord().setupDone === true);
  check('uses a glim- prefixed key so the account-switch guard wipes it',
    [...mem.keys()].some(k => k === 'glim-cycle-device'));
  check('is NOT in the synced domain list', !mem.has('glim-cycle-device-synced'));
  mem.set('glim-cycle-device', 'garbage{');
  check('malformed storage falls back to defaults', readCycleRecord().enabled === false);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
