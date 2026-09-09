// title: symptoms_store.test.mjs
// project: Glim
// author: Reina Hastings
// contact: reinahastings13@gmail.com
//
// purpose:
//   Standalone invariant tests (no framework) for the symptom diary stores.
//   Drives the REAL useSymptomsStore / useSymptomsLibraryStore via dynamic import
//   over a minimal localStorage shim. Covers the spec's pure-logic surface and
//   every edge case in checklist section 6 that lives below the UI: date
//   re-derivation on a startedAt edit, logAgain copy semantics, kind side
//   effects, validation rejection, open episodes spanning midnight, DAY-LEVEL
//   presence counting (W4), null-intensity handling, and undo-by-id.
//
// inputs:  none (seeds its own localStorage)
// outputs: per-check pass/fail lines; exits non-zero if any check fails
//
// usage:
//   cd client && node --import ./tests/register-hooks.mjs tests/symptoms_store.test.mjs

// --- Minimal localStorage shim (Node has none). Must exist before the stores are
//     imported, so the imports are dynamic (below) rather than static/hoisted. ---
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => { mem.set(k, String(v)); },
  removeItem: (k) => { mem.delete(k); },
  clear: () => mem.clear(),
  key: (i) => [...mem.keys()][i] ?? null,
  get length() { return mem.size; },
};

// --- Tiny assert harness ---
let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.error(`  FAIL ${name}`); }
}

// Timestamps are millisecond-resolution ISO strings, so back-to-back store calls
// in a test can land in the SAME millisecond and make an ordering or
// strictly-after assertion ambiguous. Real user actions never do. Used only
// where a test needs two distinguishable timestamps.
const tick = (ms = 5) => new Promise(res => setTimeout(res, ms));

const { useSymptomsStore }        = await import('../src/stores/useSymptomsStore.js');
const { useSymptomsLibraryStore } = await import('../src/stores/useSymptomsLibraryStore.js');
const { todayStr, toLogicalDateStr, logicalDayStart } = await import('../src/utils/dateUtils.js');

const state = () => useSymptomsStore.getState();
const lib   = () => useSymptomsLibraryStore.getState();

// --- Seeding helpers ---------------------------------------------------------

function reset() {
  localStorage.removeItem('glim-symptoms');
  localStorage.removeItem('glim-symptoms-library');
  state().reload();
  lib().reload();
}

// A Date `daysAgo` LOGICAL days back at hour:minute.
//
// Anchored on logicalDayStart(todayStr()), not on `new Date()`. Between midnight
// and DAY_BOUNDARY_HOUR the calendar date is already one ahead of the logical
// day, so building from the wall-clock date put every "today" fixture on
// tomorrow and made six assertions here fail for three hours a night.
function atLocal(daysAgo, hour, minute = 0) {
  const d = logicalDayStart(todayStr());
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hour, minute, 0, 0);
  return d;
}

// Builds a well-formed entry; `date` is always derived from startedAt.
let seedCounter = 0;
function mk(over = {}) {
  const startedAt = over.startedAt ?? new Date().toISOString();
  return {
    id:        over.id ?? `seed-${++seedCounter}`,
    symptomId: 'sym-a',
    kind:      'moment',
    intensity: null,
    note:      null,
    endedAt:   null,
    createdAt: startedAt,
    updatedAt: startedAt,
    deletedAt: null,
    ...over,
    startedAt,
    date:      over.date ?? toLogicalDateStr(new Date(startedAt)),
  };
}

function seed(entries) {
  localStorage.setItem('glim-symptoms', JSON.stringify({ logs: entries }));
  state().reload();
}

// Monday-anchored week start, recomputed here independently of the store so the
// counting assertions below are not tautological with the store's bucketing.
function mondayOf(dateString) {
  const d = logicalDayStart(dateString);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return toLogicalDateStr(d);
}
function shiftDays(dateString, days) {
  const d = logicalDayStart(dateString);
  d.setDate(d.getDate() + days);
  return toLogicalDateStr(d);
}

// =============================================================================
//  1. logMoment shape
// =============================================================================

reset();
const m1 = state().logMoment('sym-a');
const e1 = state().logs.find(e => e.id === m1);
check('logMoment returns the new entry id', typeof m1 === 'string' && !!e1);
check('logMoment creates a moment with null intensity and note',
  e1.kind === 'moment' && e1.intensity === null && e1.note === null && e1.endedAt === null);
check('logMoment derives date from startedAt', e1.date === todayStr());
check('logMoment stamps createdAt === updatedAt', e1.createdAt === e1.updatedAt);
const m2 = state().logMoment('sym-a');
check('two logs get distinct ids', m1 !== m2);

// =============================================================================
//  2. Validation (spec 3.3) - each rejection leaves the entry untouched
// =============================================================================

reset();
const v = state().logMoment('sym-a');
const before = { ...state().logs.find(e => e.id === v) };

let r = state().updateEntry(v, { intensity: 0 });
check('rejects intensity below 1', r.ok === false && !!r.error);
r = state().updateEntry(v, { intensity: 11 });
check('rejects intensity above 10', r.ok === false);
r = state().updateEntry(v, { intensity: 6.5 });
check('rejects non-integer intensity', r.ok === false);
r = state().updateEntry(v, { endedAt: new Date().toISOString() });
check('rejects endedAt on a moment (kind is not episode)', r.ok === false);
r = state().updateEntry(v, { startedAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() });
check('rejects a startedAt an hour in the future', r.ok === false);
r = state().updateEntry(v, { startedAt: new Date(Date.now() + 60 * 1000).toISOString() });
check('accepts a startedAt one minute ahead (5 min tolerance)', r.ok === true);

const after = state().logs.find(e => e.id === v);
check('a rejected edit does not mutate the entry',
  after.intensity === before.intensity && after.endedAt === before.endedAt);

r = state().updateEntry(v, { intensity: 7 });
check('accepts integer intensity in range', r.ok === true && state().logs.find(e => e.id === v).intensity === 7);
r = state().updateEntry(v, { intensity: null });
check('accepts clearing intensity to null', r.ok === true && state().logs.find(e => e.id === v).intensity === null);

// endedAt ordering, on a real episode
reset();
const ep = state().logMoment('sym-a');
state().updateEntry(ep, { kind: 'episode', startedAt: atLocal(0, 0, 0) > new Date() ? atLocal(1, 12).toISOString() : atLocal(0, 0, 1).toISOString() });
const epStart = state().logs.find(e => e.id === ep).startedAt;
r = state().updateEntry(ep, { endedAt: epStart });
check('rejects endedAt equal to startedAt', r.ok === false);
r = state().updateEntry(ep, { endedAt: new Date(new Date(epStart).getTime() - 1000).toISOString() });
check('rejects endedAt before startedAt', r.ok === false);
r = state().updateEntry(ep, { endedAt: new Date(new Date(epStart).getTime() + 1000).toISOString() });
check('accepts endedAt after startedAt', r.ok === true);

// =============================================================================
//  3. updatedAt bump
// =============================================================================

reset();
const u = state().logMoment('sym-a');
const u0 = state().logs.find(e => e.id === u).updatedAt;
await new Promise(res => setTimeout(res, 5));
state().updateEntry(u, { note: 'worse when i woke up' });
const uEntry = state().logs.find(e => e.id === u);
check('a successful edit bumps updatedAt', new Date(uEntry.updatedAt) > new Date(u0));
check('a successful edit leaves createdAt alone', uEntry.createdAt === u0);

// =============================================================================
//  4. EDGE CASE 2 - editing startedAt re-derives date (the silent-bug case)
// =============================================================================

reset();
const d1 = state().logMoment('sym-a');
const threeDaysAgoNoon = atLocal(3, 12);
state().updateEntry(d1, { startedAt: threeDaysAgoNoon.toISOString() });
check('E2: editing startedAt re-derives date',
  state().logs.find(e => e.id === d1).date === toLogicalDateStr(threeDaysAgoNoon));
check('E2: the re-derived date is no longer today',
  state().logs.find(e => e.id === d1).date !== todayStr());

// Crossing the DAY_BOUNDARY_HOUR: 01:30 belongs to the PREVIOUS logical day.
const earlyAm = atLocal(3, 1, 30);
state().updateEntry(d1, { startedAt: earlyAm.toISOString() });
const earlyAmDate = state().logs.find(e => e.id === d1).date;
check('E2: a 01:30 startedAt lands on the previous logical day (DAY_BOUNDARY_HOUR)',
  earlyAmDate === toLogicalDateStr(earlyAm) && earlyAmDate < earlyAm.toLocaleDateString('en-CA'));

// It regroups in history under the new date, not the old one.
const days = state().getEntriesByDay();
check('E2: the entry regroups in history under its new date',
  days.length === 1 && days[0].date === earlyAmDate && days[0].entries[0].id === d1);

// =============================================================================
//  5. kind side effects (spec 3.1)
// =============================================================================

// episode -> moment clears endedAt
reset();
const k1 = state().logMoment('sym-a');
state().updateEntry(k1, { startedAt: atLocal(1, 10).toISOString(), kind: 'episode' });
state().updateEntry(k1, { endedAt: atLocal(1, 14).toISOString() });
check('closed episode has an endedAt', !!state().logs.find(e => e.id === k1).endedAt);
state().updateEntry(k1, { kind: 'moment' });
check('switching to moment clears endedAt', state().logs.find(e => e.id === k1).endedAt === null);

// -> allDay anchors startedAt to the logical day start and clears endedAt
reset();
const k2 = state().logMoment('sym-a');
state().updateEntry(k2, { startedAt: atLocal(2, 15).toISOString(), kind: 'episode' });
state().updateEntry(k2, { endedAt: atLocal(2, 18).toISOString() });
const dateBefore = state().logs.find(e => e.id === k2).date;
state().updateEntry(k2, { kind: 'allDay' });
const k2e = state().logs.find(e => e.id === k2);
check('E5: allDay anchors startedAt to the LOGICAL day start, not midnight',
  k2e.startedAt === logicalDayStart(dateBefore).toISOString());
check('E5: allDay startedAt round-trips to the same logical date',
  toLogicalDateStr(new Date(k2e.startedAt)) === dateBefore && k2e.date === dateBefore);
check('allDay clears endedAt', k2e.endedAt === null);

// -> episode leaves times untouched
reset();
const k3 = state().logMoment('sym-a');
const k3Start = state().logs.find(e => e.id === k3).startedAt;
state().updateEntry(k3, { kind: 'episode' });
const k3e = state().logs.find(e => e.id === k3);
check('switching to episode leaves times untouched',
  k3e.startedAt === k3Start && k3e.endedAt === null);

// =============================================================================
//  6. endEpisode
// =============================================================================

reset();
const g1 = state().logMoment('sym-a');
check('endEpisode refuses a moment', state().endEpisode(g1).ok === false);
state().updateEntry(g1, { kind: 'episode' });
await tick();  // so "now" is strictly after startedAt
check('endEpisode closes an open episode', state().endEpisode(g1).ok === true);
check('endEpisode set an endedAt', !!state().logs.find(e => e.id === g1).endedAt);
check('endEpisode refuses an already-closed episode', state().endEpisode(g1).ok === false);
check('endEpisode refuses an unknown id', state().endEpisode('nope').ok === false);

// =============================================================================
//  7. logAgain copy semantics (spec 3.1 copy table)
// =============================================================================

// closed episode -> moment, note/intensity copied, times reset
reset();
seed([mk({
  id: 'src-ep', kind: 'episode', intensity: 8, note: 'aura first',
  startedAt: atLocal(3, 15, 40).toISOString(), endedAt: atLocal(3, 20, 20).toISOString(),
})]);
const c1 = state().logAgain('src-ep');
const c1e = state().logs.find(e => e.id === c1);
check('logAgain returns a fresh id', c1 && c1 !== 'src-ep');
check('logAgain: an episode copies as a moment', c1e.kind === 'moment');
check('logAgain copies symptomId, intensity and note',
  c1e.symptomId === 'sym-a' && c1e.intensity === 8 && c1e.note === 'aura first');
check('logAgain resets endedAt and deletedAt', c1e.endedAt === null && c1e.deletedAt === null);
check('logAgain stamps today', c1e.date === todayStr() && c1e.createdAt === c1e.updatedAt);
check('logAgain leaves the source entry untouched',
  state().logs.find(e => e.id === 'src-ep').kind === 'episode');

// allDay -> allDay, anchored to today's logical day start
reset();
seed([mk({ id: 'src-ad', kind: 'allDay', intensity: 7, note: 'eased up by evening',
  startedAt: logicalDayStart(shiftDays(todayStr(), -1)).toISOString() })]);
const c2 = state().logAgain('src-ad');
const c2e = state().logs.find(e => e.id === c2);
check('logAgain: allDay copies as allDay', c2e.kind === 'allDay');
check('logAgain: an allDay copy starts at today\'s logical day start',
  c2e.startedAt === logicalDayStart(todayStr()).toISOString() && c2e.date === todayStr());

// moment -> moment; a null intensity stays null
reset();
seed([mk({ id: 'src-mo', intensity: null, note: null, startedAt: atLocal(1, 9).toISOString() })]);
const c3 = state().logAgain('src-mo');
const c3e = state().logs.find(e => e.id === c3);
check('logAgain: a moment copies as a moment with null intensity preserved',
  c3e.kind === 'moment' && c3e.intensity === null && c3e.note === null);
check('logAgain on an unknown id returns null', state().logAgain('nope') === null);

// EDGE CASE 4: log-again on an entry whose symptom is archived
reset();
const archivedId = lib().addItem('wrist pain', 'pain');
lib().archive(archivedId);
seed([mk({ id: 'src-arch', symptomId: archivedId, startedAt: atLocal(2, 11).toISOString() })]);
const c4 = state().logAgain('src-arch');
check('E4: logAgain works on an archived symptom', !!c4 &&
  state().logs.find(e => e.id === c4).symptomId === archivedId);
check('E4: logAgain does not unarchive the symptom', !!lib().getItem(archivedId).deletedAt);
check('E4: the archived symptom stays out of the chip grid',
  !lib().getActiveItems().some(i => i.id === archivedId));
check('E4: the archived symptom still resolves by id for history rendering',
  lib().getItem(archivedId).name === 'wrist pain');

// =============================================================================
//  8. softDelete / EDGE CASE 6 - undo by id, never "the latest"
// =============================================================================

reset();
const s1 = state().logMoment('sym-a');
const s2 = state().logMoment('sym-b');
// A sync pull interleaves a newer entry; undo must still target s1.
seed([...state().logs, mk({ id: 'remote', symptomId: 'sym-c' })]);
state().softDelete(s1);
check('E6: softDelete removes exactly the entry with the given id',
  !!state().logs.find(e => e.id === s1).deletedAt &&
  !state().logs.find(e => e.id === s2).deletedAt &&
  !state().logs.find(e => e.id === 'remote').deletedAt);
check('softDelete retains the row (no hard delete)', state().logs.length === 3);
check('softDelete bumps updatedAt for sync propagation',
  state().logs.find(e => e.id === s1).updatedAt === state().logs.find(e => e.id === s1).deletedAt);
check('soft-deleted entries leave getTodayEntries',
  !state().getTodayEntries().some(e => e.id === s1));
check('soft-deleted entries leave getEntriesByDay',
  !state().getEntriesByDay().some(g => g.entries.some(e => e.id === s1)));

// =============================================================================
//  9. EDGE CASE 1 - open episode spanning midnight
// =============================================================================

reset();
const twoDaysAgo = atLocal(2, 22, 0);
seed([
  mk({ id: 'open-old', kind: 'episode', startedAt: twoDaysAgo.toISOString(), endedAt: null }),
  mk({ id: 'closed-old', kind: 'episode', startedAt: atLocal(2, 8).toISOString(),
       endedAt: atLocal(2, 9).toISOString() }),
  mk({ id: 'moment-old', startedAt: atLocal(2, 10).toISOString() }),
]);
const todayList = state().getTodayEntries();
check('E1: an open episode from an earlier day still appears in today\'s list',
  todayList.some(e => e.id === 'open-old'));
check('E1: a closed episode from an earlier day does NOT appear in today\'s list',
  !todayList.some(e => e.id === 'closed-old') && !todayList.some(e => e.id === 'moment-old'));
check('E1: the open episode keeps its onset date',
  state().logs.find(e => e.id === 'open-old').date === toLogicalDateStr(twoDaysAgo));
check('E1: getOpenEpisodes finds it', state().getOpenEpisodes().map(e => e.id).join() === 'open-old');

// today list ordering is newest first
reset();
seed([
  mk({ id: 'early', startedAt: atLocal(0, 8, 15).toISOString() }),
  mk({ id: 'late',  startedAt: atLocal(0, 9, 40).toISOString() }),
]);
check('today list is sorted by startedAt descending',
  state().getTodayEntries().map(e => e.id).join() === 'late,early');

// =============================================================================
//  10. getEntriesByDay - grouping, absent empty days, filters, range
// =============================================================================

reset();
const dToday = todayStr();
const dMinus1 = shiftDays(dToday, -1);
const dMinus3 = shiftDays(dToday, -3);
seed([
  mk({ id: 'a', symptomId: 'sym-a', startedAt: atLocal(0, 8).toISOString() }),
  mk({ id: 'b', symptomId: 'sym-b', startedAt: atLocal(0, 14).toISOString() }),
  mk({ id: 'c', symptomId: 'sym-a', startedAt: atLocal(1, 9).toISOString() }),
  mk({ id: 'd', symptomId: 'sym-b', startedAt: atLocal(3, 9).toISOString() }),
]);
const grouped = state().getEntriesByDay();
check('history groups by day, newest day first',
  grouped.map(g => g.date).join() === [dToday, dMinus1, dMinus3].join());
check('history omits days with no entries entirely (no zero-count rows)',
  !grouped.some(g => g.date === shiftDays(dToday, -2)) && grouped.length === 3);
check('entries within a day are newest first', grouped[0].entries.map(e => e.id).join() === 'b,a');

const filtered = state().getEntriesByDay(null, null, { symptomIds: ['sym-a'] });
check('history filters by symptomIds',
  filtered.flatMap(g => g.entries).map(e => e.id).join() === 'a,c');
const ranged = state().getEntriesByDay(dMinus1, dToday);
check('history respects an inclusive date range',
  ranged.map(g => g.date).join() === [dToday, dMinus1].join());

// =============================================================================
//  11. W4 - DAY-LEVEL presence counting (replaces entries-per-week)
//
//  The primitive is "was this symptom present on this day?". The rule it
//  replaced counted ENTRIES per week, which counted one multi-week episode once
//  in EVERY week it touched, so a single long flare read as a rising trend.
// =============================================================================

const thisMonday = mondayOf(todayStr());

// An episode from the start of week W-2 to the last day of week W-1: 14 days.
reset();
seed([mk({
  id: 'multi', kind: 'episode',
  startedAt: logicalDayStart(shiftDays(thisMonday, -14)).toISOString(),
  endedAt:   logicalDayStart(shiftDays(thisMonday, -1)).toISOString(),
})]);

let affected = state().getAffectedDays(shiftDays(thisMonday, -49), shiftDays(thisMonday, 6));
check('W4: an episode expands to EVERY day of its span',
  affected.size === 14 &&
  affected.has(shiftDays(thisMonday, -14)) && affected.has(shiftDays(thisMonday, -1)) &&
  !affected.has(shiftDays(thisMonday, -15)) && !affected.has(thisMonday));

// The load-bearing assertion: each day is contributed ONCE, not once per week.
let counts = state().getDailyCounts(shiftDays(thisMonday, -49), shiftDays(thisMonday, 6));
check('W4: a multi-week episode contributes each day exactly once',
  counts.length === 14 && counts.every(c => c.count === 1));
check('W4: daily counts are oldest first',
  counts[0].date === shiftDays(thisMonday, -14) &&
  counts[13].date === shiftDays(thisMonday, -1));

// Derived weekly view: 7 of 7 days in each of the two weeks, 0 elsewhere.
let weeks = state().getWeeklyAffectedDays(8);
check('W4: the weekly view DERIVES from days, reading 7 of 7 for a full week',
  weeks.length === 8 &&
  weeks[5].weekStart === shiftDays(thisMonday, -14) && weeks[5].daysAffected === 7 &&
  weeks[6].daysAffected === 7 && weeks[7].daysAffected === 0 &&
  weeks.every(w => w.daysInWeek === 7));

// A partial week reads as a fraction, which entry counting could never express.
reset();
seed([mk({
  id: 'part', kind: 'episode',
  startedAt: logicalDayStart(shiftDays(thisMonday, -7)).toISOString(),
  endedAt:   logicalDayStart(shiftDays(thisMonday, -5)).toISOString(),
})]);
weeks = state().getWeeklyAffectedDays(8);
check('W4: a 3-day episode reads as 3 of 7 days, not as one "count"',
  weeks[6].daysAffected === 3);

// --- Open-episode clamping ---------------------------------------------------
// An episode left open a year spans a year of days. Expansion MUST be clamped to
// the requested range, or the loop grows with the user's history rather than
// with the query.
reset();
seed([mk({
  id: 'open-long', kind: 'episode',
  startedAt: logicalDayStart(shiftDays(todayStr(), -400)).toISOString(), endedAt: null,
})]);
const windowStart = shiftDays(todayStr(), -6);
affected = state().getAffectedDays(windowStart, todayStr());
check('W4: an open episode is CLAMPED to the requested range',
  affected.size === 7 && affected.has(windowStart) && affected.has(todayStr()));
check('W4: clamping does not drop days inside the range',
  state().getDailyCounts(windowStart, todayStr()).length === 7);

// Unbounded end still stops at today: an open episode runs "up to now", never
// into the future.
const unbounded = state().getAffectedDays(null, null);
check('W4: an unbounded query stops an open episode at today',
  unbounded.has(todayStr()) && !unbounded.has(shiftDays(todayStr(), 1)));

// A span entirely outside the range contributes nothing.
check('W4: a span outside the range contributes no days',
  state().getAffectedDays(shiftDays(todayStr(), 1), shiftDays(todayStr(), 7)).size === 0);

// --- Presence, not entry volume ----------------------------------------------
// Three logs of the same symptom on one day are ONE affected day for that
// symptom; a second symptom raises the day's count to 2.
reset();
seed([
  mk({ id: 'd1', symptomId: 'sym-a', startedAt: atLocal(0, 10).toISOString() }),
  mk({ id: 'd2', symptomId: 'sym-a', startedAt: atLocal(0, 11).toISOString() }),
  mk({ id: 'd3', symptomId: 'sym-a', startedAt: atLocal(0, 12).toISOString() }),
  mk({ id: 'd4', symptomId: 'sym-b', kind: 'allDay',
       startedAt: logicalDayStart(todayStr()).toISOString() }),
  mk({ id: 'd5', symptomId: 'sym-c', startedAt: atLocal(0, 13).toISOString(),
       deletedAt: new Date().toISOString() }),
]);
affected = state().getAffectedDays(todayStr(), todayStr());
check('W4: repeated logs of one symptom are ONE affected day for it',
  affected.get(todayStr()).size === 2);
check('W4: the day count is DISTINCT symptoms present',
  state().getDailyCounts(todayStr(), todayStr())[0].count === 2);
check('W4: soft-deleted entries contribute no days',
  !affected.get(todayStr()).has('sym-c'));
check('W4: the symptom filter applies',
  state().getDailyCounts(todayStr(), todayStr(), { symptomIds: ['sym-b'] })[0].count === 1);
check('W4: days with nothing present are absent (no zero rows)',
  state().getDailyCounts(shiftDays(todayStr(), -3), todayStr()).length === 1);
check('W4: getWeeklyCounts is gone (one counting rule only)',
  typeof state().getWeeklyCounts === 'undefined');

// =============================================================================
//  12. Library store
// =============================================================================

reset();
const libA = lib().addItem('tension headache', 'cat-pain');
await tick();
const libB = lib().addItem('nausea', 'cat-digestive');
await tick();
const libC = lib().addItem('brain fog');
check('addItem returns an id and stores the name as typed',
  !!libA && lib().getItem(libA).name === 'tension headache');
check('W5: addItem stores a categoryId, not a category string',
  lib().getItem(libA).categoryId === 'cat-pain' &&
  lib().getItem(libA).category === undefined);
// No membership check here by design: categories are user-defined entities and
// this store has no list to validate against (and may not read one). An
// unresolvable id renders as "uncategorized" at the category store.
check('W5: addItem defaults to the "other" seed when no category is given',
  lib().getItem(libC).categoryId === 'cat-other');

// Recency ordering is driven by log data passed in by the panel, never a
// cross-store import.
const recency = {
  [libB]: atLocal(0, 12).toISOString(),
  [libA]: atLocal(2, 12).toISOString(),
};
check('getActiveItems orders by recency of use, unused last',
  lib().getActiveItems(recency).map(i => i.id).join() === [libB, libA, libC].join());
check('getActiveItems with no recency data falls back to newest-created first',
  lib().getActiveItems().map(i => i.id).join() === [libC, libB, libA].join());

lib().updateItem(libA, { name: 'migraine' });
check('E9: renaming an item propagates to anything resolving by id',
  lib().getItem(libA).name === 'migraine');
lib().archive(libB);
check('archive removes the item from the active grid',
  !lib().getActiveItems().some(i => i.id === libB));
check('archive keeps the item resolvable and listed as archived',
  lib().getItem(libB).name === 'nausea' && lib().getArchivedItems().map(i => i.id).join() === libB);
lib().unarchive(libB);
check('unarchive restores the item to the grid',
  lib().getActiveItems().some(i => i.id === libB) && lib().getItem(libB).deletedAt === null);

// =============================================================================
//  13. EDGE CASE 8 - null intensity never renders as "null/10" upstream
// =============================================================================

reset();
seed([
  mk({ id: 'n1', intensity: null, startedAt: atLocal(0, 8).toISOString() }),
  mk({ id: 'n2', intensity: 4,    startedAt: atLocal(0, 9).toISOString() }),
]);
const todays = state().getTodayEntries();
check('E8: entry counts include null-intensity entries', todays.length === 2);
const rated = todays.filter(e => e.intensity !== null).map(e => e.intensity);
check('E8: intensity aggregates skip nulls', rated.length === 1 && rated[0] === 4);

// --- Persistence round-trip --------------------------------------------------

reset();
const p1 = state().logMoment('sym-a');
state().updateEntry(p1, { intensity: 5, note: 'still here' });
state().reload();
const p1e = state().logs.find(e => e.id === p1);
check('edits survive a reload (localStorage round-trip)',
  p1e.intensity === 5 && p1e.note === 'still here');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
