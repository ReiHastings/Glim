// title: steps_index_equivalence.test.mjs
// project: Glim
// author: Reina Hastings
// contact: reinahastings13@gmail.com
// date created: 2026-09-18
//
// purpose:
//   The equivalence ORACLE for the steps-derivation performance change
//   (docs/plan_steps_derivation_cost.md, acceptance criteria 2 and 6). Written
//   BEFORE the change, against current code, so that it is known to pass with
//   today's implementation and can therefore be trusted afterwards.
//
//   Criterion 2 - a frozen snapshot of today's pure derivation functions is kept
//   in this file as the oracle. Every date in a 180-day window must resolve
//   IDENTICALLY through the oracle and through the live module, at several
//   pinned instants including both DST transition days. getStreak and
//   getWeeklyAvg are additionally compared at instants OUTSIDE the 00:00-03:00
//   window, where the planned anchor change (plan 3.2) must not alter them.
//   The 00:00-03:00 divergence is deliberate and belongs to criterion 5; it is
//   reported here for information and asserted in steps_day_rollover.test.mjs.
//
//   Criterion 6 - invariants over the index plan 3.1 introduced: equivalence
//   between resolveDayCount and resolveDayFromIndex(buildDayIndex(...)) for every
//   date, bounded index sizes, logical-date keys, permutation invariance, streak
//   monotonicity and degenerate inputs. The pend() helper below remains for the
//   next person who writes checks against an API that does not exist yet; every
//   check in this file is live.
//
//   Also pins getDaySummary - the selector StepsPanel actually reads - against
//   the four individually tested selectors, at every pinned instant. Nothing
//   connected them until a code review mutated getDaySummary and the suite
//   stayed green.
//
// inputs:  none (seeds its own localStorage, stubs the Date constructor)
// outputs: per-check pass/fail lines; exits non-zero if any check fails
//
// usage:
//   cd client
//   TZ=America/New_York node --import ./tests/register-hooks.mjs tests/steps_index_equivalence.test.mjs

// --- Timezone guard (hard). The DST instants in Criterion 2 prove nothing
//     under any other zone; the warning that used to be printed there is
//     kept, but the run now fails up front instead of passing vacuously. ---
if (process.env.TZ !== 'America/New_York') {
  console.error('FAIL this test must run under TZ=America/New_York (see tests/README.md)');
  process.exit(1);
}

// --- localStorage shim. Must exist before the stores are imported, so the
//     imports below are dynamic rather than hoisted. ---
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => { mem.set(k, String(v)); },
  removeItem: (k) => { mem.delete(k); },
  clear: () => mem.clear(),
  key: (i) => [...mem.keys()][i] ?? null,
  get length() { return mem.size; },
};

let passed = 0, failed = 0, pending = 0;
function check(name, cond) {
  if (cond) { passed++; console.log(`  ok      ${name}`); }
  else { failed++; console.error(`  FAIL    ${name}`); }
}
// A check that cannot run until the planned change lands. Announced, not failed.
function pend(name, reason) {
  pending++; console.log(`  pending ${name}  (${reason})`);
}

const storeMod = await import('../src/stores/useStepsStore.js');
const {
  useStepsStore, resolveDayCount, manualCountForDate, countForDate, TIERS,
} = storeMod;
const { toLogicalDateStr, logicalDayStart } = await import('../src/utils/dateUtils.js');

const steps = () => useStepsStore.getState();

// =============================================================================
//  The oracle: a FROZEN copy of the derivation functions as they stand before
//  the change. Do not "fix" these to match the new implementation - that is the
//  whole point of them. The one intentional difference after plan 3.2 lands is
//  oracleLogicalDaysBack's anchor, which is exercised by criterion 5.
// =============================================================================

function oracleStampMs(v) {
  const t = v ? new Date(v).getTime() : 0;
  return Number.isNaN(t) ? 0 : t;
}

function oracleDateStr(timestamp) {
  return toLogicalDateStr(new Date(timestamp));
}

function oracleManualCountForDate(entries, dateString) {
  const dayEntries = (entries ?? []).filter(e => oracleDateStr(e.timestamp) === dateString);
  if (dayEntries.length === 0) return null;
  const latest = dayEntries.reduce((a, e) => (e.timestamp >= a.timestamp ? e : a));
  return latest.count ?? null;
}

function oracleResolveDayCount(entries, healthRows, dateString) {
  const manual = oracleManualCountForDate(entries, dateString);
  if (manual !== null) return { count: manual, source: 'manual' };
  const rows = (healthRows ?? []).filter(r => r?.date === dateString);
  if (rows.length === 0) return { count: 0, source: null };
  const best = rows.reduce((a, b) => (oracleStampMs(b.updatedAt) > oracleStampMs(a.updatedAt) ? b : a));
  return { count: best.steps, source: best.source };
}

function oracleCountForDate(entries, dateString, healthRows = []) {
  return oracleResolveDayCount(entries, healthRows, dateString).count;
}

// The CURRENT anchor: calendar date, not logical date. Reproduced exactly.
function oracleLogicalDaysBack(n) {
  const anchor = new Date();
  anchor.setHours(12, 0, 0, 0);
  const out = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(anchor);
    d.setDate(d.getDate() - i);
    out.push(toLogicalDateStr(d));
  }
  return out;
}

function oracleComputeStreak(entries, healthRows = []) {
  let streak = 0;
  for (const dStr of oracleLogicalDaysBack(365)) {
    if (oracleCountForDate(entries, dStr, healthRows) >= TIERS[0]) streak++;
    else break;
  }
  return streak;
}

function oracleComputeWeeklyAvg(entries, healthRows = []) {
  let total = 0;
  for (const dStr of oracleLogicalDaysBack(7)) total += oracleCountForDate(entries, dStr, healthRows);
  return Math.round((total / 7) * 10) / 10;
}

// =============================================================================
//  Clock control
// =============================================================================

const RealDate = Date;

// Stubs the Date CONSTRUCTOR, not just Date.now: `new Date()` does not consult
// Date.now, and only stubbing the latter would make every assertion here
// vacuous. Same lesson as sync_scheduler.test.mjs S4 (tests/README.md).
function withClock(instantMs, fn) {
  globalThis.Date = class extends RealDate {
    constructor(...a) { if (a.length === 0) super(instantMs); else super(...a); }
    static now() { return instantMs; }
  };
  try { return fn(); } finally { globalThis.Date = RealDate; }
}

const localInstant = (y, m, d, h, min) => new RealDate(y, m - 1, d, h, min, 0, 0).getTime();

// The logical-day window ending at `now`, oldest last. This is the CORRECT
// (post-3.2) semantics, used to build fixtures so they are keyed to real days.
function logicalWindow(n, nowMs) {
  const anchor = logicalDayStart(toLogicalDateStr(new RealDate(nowMs)));
  anchor.setHours(12, 0, 0, 0);
  const out = [];
  for (let i = 0; i < n; i++) {
    const d = new RealDate(anchor);
    d.setDate(d.getDate() - i);
    out.push(toLogicalDateStr(d));
  }
  return out;
}

// =============================================================================
//  Fixture
// =============================================================================

const WINDOW_DAYS = 180;

// A manual entry on a logical date, at 09:00 of that logical day.
function entryOn(dateString, count, offsetMs = 0) {
  const t = logicalDayStart(dateString).getTime() + 9 * 3_600_000 + offsetMs;
  return { id: t, timestamp: t, count };
}

function rowOn(dateString, stepsCount, updatedAt, source = 'healthkit') {
  return { id: `${source}:${dateString}`, source, date: dateString, steps: stepsCount, updatedAt };
}

// A mixed fixture: some days manual only, some imported only, some both (so the
// precedence rule is exercised), some days with two health rows, some empty.
function buildFixture(nowMs) {
  const days = logicalWindow(WINDOW_DAYS, nowMs);
  const entries = [], rows = [];
  days.forEach((d, i) => {
    if (i % 3 === 0) entries.push(entryOn(d, 4000 + (i % 7) * 500));
    if (i % 4 === 0) entries.push(entryOn(d, 6000 + (i % 5) * 300, 1000));   // later same day
    if (i % 2 === 0) rows.push(rowOn(d, 7000 + (i % 9) * 200, `2026-01-01T0${i % 10}:00:00.000Z`));
    if (i % 11 === 0) {
      rows.push(rowOn(d, 8000, `2026-01-02T0${i % 10}:00:00.000Z`, 'health_connect'));
    }
    if (i % 17 === 0) entries.push(entryOn(d, null, 2000));                   // clear marker
  });
  return { days, entries, rows };
}

function seedStore(entries) {
  localStorage.setItem('glim-steps', JSON.stringify({ entries, goal: 10000 }));
  steps().reload();
}

const sameResult = (a, b) => a.count === b.count && a.source === b.source;

// =============================================================================
//  Criterion 2: exact-output equivalence, clock-pinned
// =============================================================================

const INSTANTS = [
  { label: 'ordinary day, 12:00',            ms: localInstant(2026, 6, 15, 12, 0), inWindow: false },
  { label: 'ordinary day, 01:30 (in 0-3am)', ms: localInstant(2026, 6, 15,  1, 30), inWindow: true  },
  { label: 'ordinary day, 23:59',            ms: localInstant(2026, 6, 15, 23, 59), inWindow: false },
  { label: 'DST spring forward, 12:00',      ms: localInstant(2026, 3,  8, 12, 0), inWindow: false },
  { label: 'DST spring forward, 01:30',      ms: localInstant(2026, 3,  8,  1, 30), inWindow: true  },
  { label: 'DST fall back, 12:00',           ms: localInstant(2026, 11, 1, 12, 0), inWindow: false },
  { label: 'DST fall back, 01:30',           ms: localInstant(2026, 11, 1,  1, 30), inWindow: true  },
];

console.log(`\n=== Criterion 2: exact-output equivalence (TZ=${process.env.TZ}) ===`);

for (const inst of INSTANTS) {
  withClock(inst.ms, () => {
    const { days, entries, rows } = buildFixture(inst.ms);
    seedStore(entries);

    // Per-date resolution must be identical, everywhere, at every instant.
    let mismatches = 0, firstBad = null;
    for (const d of days) {
      const o = oracleResolveDayCount(entries, rows, d);
      const l = resolveDayCount(entries, rows, d);
      if (!sameResult(o, l)) { mismatches++; firstBad ??= { d, o, l }; }
      if (oracleCountForDate(entries, d, rows) !== countForDate(entries, d, rows)) {
        mismatches++; firstBad ??= { d, note: 'countForDate' };
      }
      if (oracleManualCountForDate(entries, d) !== manualCountForDate(entries, d)) {
        mismatches++; firstBad ??= { d, note: 'manualCountForDate' };
      }
    }
    check(`${inst.label}: all ${days.length} dates resolve identically` +
          (mismatches ? ` [first: ${JSON.stringify(firstBad)}]` : ''), mismatches === 0);

    // Streak and weekly average: equality is required only OUTSIDE 00:00-03:00.
    // Inside that window plan 3.2 deliberately changes them (criterion 5).
    const oStreak = oracleComputeStreak(entries, rows);
    const lStreak = steps().getStreak(rows);
    const oAvg    = oracleComputeWeeklyAvg(entries, rows);
    const lAvg    = steps().getWeeklyAvg(rows);

    // getDaySummary is what the PANEL reads; the four selectors above are what
    // the tests cover. Nothing tied them together until a code review mutated
    // getDaySummary to return streak: 0 and the whole suite stayed green.
    const summary = steps().getDaySummary(rows);
    check(`${inst.label}: getDaySummary agrees with the four selectors`,
      summary.todayCount  === steps().getTodayCount(rows) &&
      summary.todaySource === steps().getTodaySource(rows) &&
      summary.streak      === lStreak &&
      summary.weeklyAvg   === lAvg);

    if (inst.inWindow) {
      console.log(`  info    ${inst.label}: oracle streak ${oStreak} / live ${lStreak}, ` +
                  `oracle avg ${oAvg} / live ${lAvg} ` +
                  `(divergence here is criterion 5's business, see steps_day_rollover)`);
    } else {
      check(`${inst.label}: getStreak matches the oracle`,   oStreak === lStreak);
      check(`${inst.label}: getWeeklyAvg matches the oracle`, oAvg === lAvg);
    }
  });
}

// =============================================================================
//  Criterion 6: index equivalence and invariants
// =============================================================================

console.log('\n=== Criterion 6: index equivalence and invariants ===');

const buildDayIndex       = storeMod.buildDayIndex;
const resolveDayFromIndex = storeMod.resolveDayFromIndex;
const hasIndexApi = typeof buildDayIndex === 'function' && typeof resolveDayFromIndex === 'function';

if (!hasIndexApi) {
  pend('resolveDayCount equals resolveDayFromIndex(buildDayIndex(...)) for every date',
       'buildDayIndex / resolveDayFromIndex not exported yet - plan 3.1');
  pend('index sizes are bounded by the input arrays, keys are logical dates',
       'buildDayIndex not exported yet - plan 3.1');
  pend('permutation invariance across both arrays through one shared index',
       'buildDayIndex not exported yet - plan 3.1');
} else {
  withClock(localInstant(2026, 6, 15, 12, 0), () => {
    const { days, entries, rows } = buildFixture(localInstant(2026, 6, 15, 12, 0));
    const index = buildDayIndex(entries, rows);

    let bad = 0, firstBad = null;
    for (const d of days) {
      const o = resolveDayCount(entries, rows, d);
      const viaIndex = resolveDayFromIndex(index, d);
      if (!sameResult(o, viaIndex)) { bad++; firstBad ??= { d, o, viaIndex }; }
    }
    check('resolveDayCount equals resolveDayFromIndex(buildDayIndex(...)) for every date' +
          (bad ? ` [first: ${JSON.stringify(firstBad)}]` : ''), bad === 0);

    const dateShape = /^\d{4}-\d{2}-\d{2}$/;
    check('index sizes are bounded by the input arrays',
      index.manual.size <= entries.length && index.health.size <= rows.length);
    check('every index key is a logical date string',
      [...index.manual.keys()].every(k => dateShape.test(k)) &&
      [...index.health.keys()].every(k => dateShape.test(k)));

    // Permutation invariance for DISTINCT stamps, both arrays at once, many
    // dates against one shared index.
    const shuffle = (a) => { const c = [...a]; for (let i = c.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1)); [c[i], c[j]] = [c[j], c[i]]; } return c; };
    const shuffled = buildDayIndex(shuffle(entries), shuffle(rows));
    let permBad = 0;
    for (const d of days) {
      if (!sameResult(resolveDayFromIndex(index, d), resolveDayFromIndex(shuffled, d))) permBad++;
    }
    check('permutation invariance across both arrays through one shared index', permBad === 0);
  });
}

// --- Invariants that do not depend on the new API ---------------------------

withClock(localInstant(2026, 6, 15, 12, 0), () => {
  const now = localInstant(2026, 6, 15, 12, 0);
  const days = logicalWindow(10, now);

  // Streak monotonicity: adding a manual entry at or above tier 1 to a day that
  // already clears tier 1 must not change the streak.
  const rows = days.map(d => rowOn(d, 6000, '2026-01-01T12:00:00.000Z'));
  seedStore([]);
  const before = steps().getStreak(rows);
  const extra  = [entryOn(days[1], TIERS[0] + 1000, 5000)];
  seedStore(extra);
  const after = steps().getStreak(rows);
  check(`streak monotonicity: adding a tier-clearing entry does not change it (${before} -> ${after})`,
    before === after);

  // Degenerate inputs.
  seedStore([]);
  check('manualCountForDate([], D) is null',        manualCountForDate([], days[0]) === null);
  check('manualCountForDate(null, D) is null',      manualCountForDate(null, days[0]) === null);
  const empty = resolveDayCount([], [], days[0]);
  check('resolveDayCount([], [], D) is {0, null}',  empty.count === 0 && empty.source === null);
  const oneRow = resolveDayCount([], [rowOn(days[0], 5000, '2026-01-01T12:00:00.000Z')], days[0]);
  check('resolveDayCount with one row reads it',    oneRow.count === 5000 && oneRow.source === 'healthkit');
  const oneEntry = resolveDayCount([entryOn(days[0], 3000)], [], days[0]);
  check('resolveDayCount with one entry reads it',  oneEntry.count === 3000 && oneEntry.source === 'manual');
  check('countForDate with neither source is 0',    countForDate([], days[0], []) === 0);
});

// =============================================================================

console.log(`\n${passed} passed, ${failed} failed, ${pending} pending`);
if (pending) {
  console.log('Pending checks activate automatically once plan 3.1 exports the index API.');
}
process.exit(failed ? 1 : 0);
