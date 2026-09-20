// title: cycle_store.test.mjs
// project: Glim
// author: Reina Hastings
// contact: reinahastings13@gmail.com
//
// purpose:
//   Invariant tests for useCycleStore, driving the REAL store over a
//   localStorage shim.
//
//   The load-bearing checks are the REJECTIONS. Every constraint in
//   firestore.rules' cycleValid() must also be rejected here: a row the client
//   accepts and the server refuses pushes forever and fails forever, visible
//   only as a console.warn in sync.js. A rejection must also leave storage
//   BYTE-IDENTICAL, not merely "unchanged looking".
//
// inputs:  none (seeds its own localStorage)
// outputs: per-check pass/fail; exits non-zero if any check fails
//
// usage:
//   cd client && TZ=America/New_York node --import ./tests/register-hooks.mjs tests/cycle_store.test.mjs

if (process.env.TZ !== 'America/New_York') {
  console.error('FAIL this test must run under TZ=America/New_York (see tests/README.md)');
  process.exit(1);
}

const mem = new Map();
globalThis.localStorage = {
  getItem: k => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => { mem.set(k, String(v)); },
  removeItem: k => { mem.delete(k); },
  clear: () => mem.clear(),
  key: i => [...mem.keys()][i] ?? null,
  get length() { return mem.size; },
};

const { useCycleStore, FLOW_VALUES, validateRow } = await import('../src/stores/useCycleStore.js');
const { calendarTodayStr, addDaysStr, todayStr } = await import('../src/utils/dateUtils.js');
const { DOMAINS, ALL_DOMAINS } = await import('../src/syncBus.js');

let passed = 0, failed = 0;
const check = (name, cond, detail) => {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.error(`  FAIL ${name}${detail ? '  -> ' + detail : ''}`); }
};
const S = () => useCycleStore.getState();
const raw = () => localStorage.getItem('glim-cycle');
const reset = () => { mem.clear(); useCycleStore.setState({ days: [] }); };

const TODAY = calendarTodayStr();
const D = n => addDaysStr(TODAY, n);

console.log('\n-- registration --');
check("DOMAINS.CYCLE is 'cycle'", DOMAINS.CYCLE === 'cycle');
check('and is in ALL_DOMAINS', ALL_DOMAINS.includes('cycle'));

console.log('\n-- the happy path --');
{
  reset();
  const r = S().setFlow(TODAY, 'medium');
  check('setFlow creates a row', r.ok === true, r.error);
  const row = S().getDay(TODAY);
  check('id equals date', row.id === row.date && row.id === TODAY);
  check('defaults are set', row.isPeriodStart === null && row.note === null && row.deletedAt === null);
  check('createdAt and updatedAt are ISO', /T.*Z$/.test(row.createdAt) && /T.*Z$/.test(row.updatedAt));
  check('exactly one row', S().days.length === 1);
  S().setFlow(TODAY, 'heavy');
  check('setFlow twice on one date still leaves one row', S().days.length === 1);
  check('and merges rather than appends', S().getDay(TODAY).flow === 'heavy');
  check('createdAt is preserved across a merge', S().getDay(TODAY).createdAt === row.createdAt);
}

console.log('\n-- every flow value is accepted --');
{
  reset();
  let allOk = true;
  FLOW_VALUES.forEach((f, i) => { if (!S().setFlow(D(-i), f).ok) allOk = false; });
  check(`all ${FLOW_VALUES.length} flow values accepted`, allOk);
}

console.log('\n-- rejections leave storage byte-identical --');
{
  reset();
  S().setFlow(TODAY, 'medium');
  const before = raw();
  const cases = [
    ['bad date format',        () => S().setFlow('18-09-2026', 'medium')],
    ['empty date',             () => S().setFlow('', 'medium')],
    ['future date',            () => S().setFlow(D(1), 'medium')],
    ['unknown flow',           () => S().setFlow(D(-1), 'gushing')],
    ['flow null',              () => S().setFlow(D(-1), null)],
    ['note on a flowless day', () => S().setNote(D(-5), 'hi')],
    ['period start on a flowless day', () => S().setPeriodStart(D(-5), true)],
    ['isPeriodStart not boolean', () => S().setPeriodStart(TODAY, 'yes')],
    ['over-long note',         () => S().setNote(TODAY, 'x'.repeat(501))],
    ['non-string note',        () => S().setNote(TODAY, 42)],
    ['clearDay on nothing',    () => S().clearDay(D(-9))],
  ];
  let allRejected = true, storageStable = true;
  for (const [name, fn] of cases) {
    const r = fn();
    if (r.ok !== false || typeof r.error !== 'string') { allRejected = false; console.error(`     (${name} was not rejected)`); }
    if (raw() !== before) { storageStable = false; console.error(`     (${name} mutated storage)`); }
  }
  check('all 11 invalid writes return { ok: false, error }', allRejected);
  check('and none of them touched localStorage', storageStable);
}

console.log('\n-- the calendar-date ceiling (D15) --');
{
  reset();
  // todayStr() is the LOGICAL date. Between midnight and 03:00 it is one day
  // behind the calendar. A user who advances to the calendar day must be accepted.
  check('the calendar date is always accepted', S().setFlow(TODAY, 'light').ok === true);
  check('one day past the calendar date is rejected', S().setFlow(D(1), 'light').ok === false);
  const logical = todayStr();
  check('the logical date is accepted too', S().setFlow(logical, 'light').ok === true);
  check('logical date never exceeds the calendar date', logical <= TODAY, `${logical} vs ${TODAY}`);
}

console.log('\n-- period start and notes --');
{
  reset();
  S().setFlow(TODAY, 'medium');
  check('isPeriodStart true accepted', S().setPeriodStart(TODAY, true).ok === true);
  check('isPeriodStart false accepted', S().setPeriodStart(TODAY, false).ok === true);
  check('isPeriodStart null accepted', S().setPeriodStart(TODAY, null).ok === true);
  check('note accepted', S().setNote(TODAY, 'heavier than usual').ok === true);
  check('note null accepted', S().setNote(TODAY, null).ok === true);
  check('a 500-character note is accepted', S().setNote(TODAY, 'x'.repeat(500)).ok === true);
}

console.log('\n-- soft delete and revival --');
{
  reset();
  S().setFlow(TODAY, 'medium');
  S().clearDay(TODAY);
  check('clearDay sets deletedAt', S().days[0].deletedAt !== null);
  check('the row is not removed', S().days.length === 1);
  check('getLiveDays excludes it', S().getLiveDays().length === 0);
  check('getDay excludes it', S().getDay(TODAY) === null);
  S().setFlow(TODAY, 'light');
  check('re-recording the day revives the row', S().getDay(TODAY)?.flow === 'light');
  check('and still leaves one row', S().days.length === 1);
}

console.log('\n-- tombstoneAll (R21 / D17) --');
{
  reset();
  for (let i = 0; i < 5; i++) S().setFlow(D(-i), 'medium');
  S().clearDay(D(-4));
  const r = S().tombstoneAll();
  check('reports how many it tombstoned', r.tombstoned === 4, String(r.tombstoned));
  check('every row now carries deletedAt', S().days.every(d => d.deletedAt !== null));
  check('no row was removed', S().days.length === 5);
  check('every updatedAt was bumped', S().days.every(d => /T.*Z$/.test(d.updatedAt)));
  check('getLiveDays is empty', S().getLiveDays().length === 0);
}

console.log('\n-- persistence and reload --');
{
  reset();
  S().setFlow(TODAY, 'heavy');
  S().setFlow(D(-1), 'light');
  const stored = JSON.parse(raw());
  check('persists under the days key', Array.isArray(stored.days) && stored.days.length === 2);
  useCycleStore.setState({ days: [] });
  S().reload();
  check('reload re-hydrates from localStorage', S().days.length === 2);
  mem.set('glim-cycle', 'not json at all');
  S().reload();
  check('malformed storage loads as empty rather than throwing', S().days.length === 0);
}

console.log('\n-- validateRow mirrors the server rule set --');
{
  const good = { id: TODAY, date: TODAY, flow: 'medium', isPeriodStart: null,
                 note: null, createdAt: '2026-01-01T00:00:00.000Z',
                 updatedAt: '2026-01-01T00:00:00.000Z', deletedAt: null };
  check('a well-formed row validates', validateRow(good).ok === true);
  check('id !== date is rejected (the silent-sync-failure case)',
    validateRow({ ...good, id: 'something-else' }).ok === false);
  check('unknown flow is rejected', validateRow({ ...good, flow: 'nope' }).ok === false);
  check('bad date shape is rejected', validateRow({ ...good, id: 'x', date: 'x' }).ok === false);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
