// title: symptoms_phase15.test.mjs
// project: Glim
// author: Reina Hastings
// contact: reinahastings13@gmail.com
//
// purpose:
//   Standalone invariant tests (no framework) for the symptom diary Phase 1.5
//   work items that live below the UI. Drives the REAL stores over a minimal
//   localStorage shim, plus two static checks where the invariant is a property
//   of the source rather than of a value.
//
//     W2 - the null-intensity policy, both branches, and the load-bearing
//          round trip: an unrated entry opened in the edit sheet and saved
//          untouched must still be null, not 0.
//     W5 - categories as entities: fixed seed ids stable across
//          re-initialisation, an idempotent legacy migration, rename
//          propagation, and archived/unknown resolving to "uncategorized".
//     W6 - clear days: refused while the day has any symptom present (open OR
//          closed episode, or a moment), cleared by a log, retroactive
//          marking, and one row per day by construction.
//     D3 - an EDIT that moves an entry onto a clear day unmarks that day
//          (static guard on the panel's commit path, plus the store rule).
//     D4 - unmarkClear lays a TOMBSTONE when no row exists locally and bumps
//          updatedAt on every call, so a clear-day mark that has not synced
//          yet loses the merge to the log.
//     W7 - the enumerated-fields gotcha: the two new settings survive a
//          save/load round trip.
//     D2 - the end-of-day reminder's decisions (utils/symptomReminder.js): the
//          gate's truth table, the moot check, and the load-bearing rule that
//          a REFUSED "yes" never stamps the day. Plus static guards that
//          DesktopPet routes every answer through resolveClearDayAnswer and
//          writes the stamp in exactly one place.
//
// inputs:  none (seeds its own localStorage)
// outputs: per-check pass/fail lines; exits non-zero if any check fails
//
// usage:
//   cd client && node --import ./tests/register-hooks.mjs tests/symptoms_phase15.test.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// --- Minimal localStorage shim, before any store import (hence dynamic imports) ---
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => { mem.set(k, String(v)); },
  removeItem: (k) => { mem.delete(k); },
  clear: () => mem.clear(),
  key: (i) => [...mem.keys()][i] ?? null,
  get length() { return mem.size; },
};

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.error(`  FAIL ${name}`); }
}

const here = dirname(fileURLToPath(import.meta.url));
// Two store calls in one millisecond share a stamp; used where a test needs a
// strictly-later timestamp.
const tick = (ms = 5) => new Promise(res => setTimeout(res, ms));
const read = (rel) => readFileSync(join(here, rel), 'utf8');

const intensity = await import('../src/utils/intensity.js');
const { hasRecordedIntensity, resolveIntensity, meanIntensity, INTENSITY_NULL_POLICY } = intensity;

const { useSymptomsStore }           = await import('../src/stores/useSymptomsStore.js');
const { useSymptomsLibraryStore }    = await import('../src/stores/useSymptomsLibraryStore.js');
const { useSymptomsCategoriesStore } = await import('../src/stores/useSymptomsCategoriesStore.js');
const { useSymptomClearDaysStore }   = await import('../src/stores/useSymptomClearDaysStore.js');
const { useSettingsStore }           = await import('../src/stores/useSettingsStore.js');
const { todayStr, toLogicalDateStr, logicalDayStart } = await import('../src/utils/dateUtils.js');
const { SEED_CATEGORIES }            = await import('../src/utils/symptomCategories.js');

const logs = () => useSymptomsStore.getState();
const lib  = () => useSymptomsLibraryStore.getState();
const cats = () => useSymptomsCategoriesStore.getState();
const days = () => useSymptomClearDaysStore.getState();

function shiftDays(dateString, n) {
  const [y, m, d] = dateString.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + n);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

// =============================================================================
//  W2 - intensity null policy
// =============================================================================

check('W2: the shipped policy is "zero"', INTENSITY_NULL_POLICY === 'zero');

check('W2: hasRecordedIntensity is true only for an actual number',
  hasRecordedIntensity({ intensity: 7 }) === true &&
  hasRecordedIntensity({ intensity: 0 }) === true &&
  hasRecordedIntensity({ intensity: null }) === false &&
  hasRecordedIntensity({}) === false);

check('W2: resolveIntensity under "zero" reads an unrated entry as 0',
  resolveIntensity({ intensity: null }, 'zero') === 0 &&
  resolveIntensity({ intensity: 6 }, 'zero') === 6);

check('W2: resolveIntensity under "exclude" reads an unrated entry as null',
  resolveIntensity({ intensity: null }, 'exclude') === null &&
  resolveIntensity({ intensity: 6 }, 'exclude') === 6);

const mixed = [{ intensity: 8 }, { intensity: null }, { intensity: 4 }];
const zeroMean = meanIntensity(mixed, 'zero');
check('W2: meanIntensity under "zero" counts the unrated entry as 0',
  zeroMean.mean === 4 && zeroMean.covered === 2 && zeroMean.total === 3);

const exclMean = meanIntensity(mixed, 'exclude');
check('W2: meanIntensity under "exclude" drops the unrated entry',
  exclMean.mean === 6 && exclMean.covered === 2 && exclMean.total === 3);

// Coverage is not decoration: under 'zero' a wholly unrated day reads as a mean
// of 0, indistinguishable from a genuinely mild day unless covered/total is
// shown with it.
const noneRated = meanIntensity([{ intensity: null }, { intensity: null }], 'zero');
check('W2: an all-unrated set reports mean 0 with covered 0 of 2',
  noneRated.mean === 0 && noneRated.covered === 0 && noneRated.total === 2);
check('W2: an empty set reports a null mean, never 0',
  meanIntensity([]).mean === null);

// --- The load-bearing round trip ---------------------------------------------
// Log an unrated moment, open it in the edit sheet, save without touching
// anything. Reproduces the sheet's draft exactly: it seeds from the RAW stored
// value and commits the whole draft through updateEntry.
mem.clear();
logs().reload();
const unratedId = logs().logMoment('sym-a');
const opened    = logs().logs.find(e => e.id === unratedId);

const draftIntensity = opened.intensity ?? null;        // SymptomEditSheet useState seed
const draftFields = {                                    // SymptomEditSheet draftFields()
  kind:      opened.kind,
  intensity: draftIntensity,
  startedAt: opened.startedAt,
  endedAt:   opened.kind === 'episode' ? opened.endedAt : null,
  note:      (opened.note ?? '').trim() === '' ? null : opened.note,
};
const saved = logs().updateEntry(unratedId, draftFields);
check('W2: an untouched save of an unrated entry succeeds', saved.ok === true);
check('W2: an untouched save leaves intensity NULL, never 0',
  logs().logs.find(e => e.id === unratedId).intensity === null);

logs().reload();
check('W2: the null survives the localStorage round trip',
  logs().logs.find(e => e.id === unratedId).intensity === null);

// Static guards: the sheet is the one surface that must use the raw value. If it
// ever resolves, the 0 is written back and the distinction is gone permanently,
// including on every other device after sync.
const sheetSrc = read('../src/components/SymptomEditSheet.jsx');
check('W2: the edit sheet seeds its draft from the raw stored value',
  sheetSrc.includes('useState(entry.intensity ?? null)'));
check('W2: the edit sheet imports no null-policy helper',
  !/^import .*utils\/intensity/m.test(sheetSrc));

const rowSrc = read('../src/components/SymptomEntryRow.jsx');
check('W2: the entry row imports hasRecordedIntensity and nothing else',
  /^import \{ hasRecordedIntensity \} from '\.\.\/utils\/intensity';$/m.test(rowSrc));
check('W2: the entry row has no inline null/undefined intensity checks left',
  !/intensity !== null/.test(rowSrc));

// =============================================================================
//  W5 - categories as first-class entities
// =============================================================================

mem.clear();
cats().reload();

const seedIds = SEED_CATEGORIES.map(c => c.id).join();
check('W5: the four categories seed on a blank store',
  cats().getActiveCategories().map(c => c.id).join() === seedIds);
check('W5: seed ids are the FIXED strings, never a uuid',
  seedIds === 'cat-pain,cat-digestive,cat-fatigue,cat-other');

// Stability across re-initialisation is what makes the ids safe to sync: if each
// device minted its own uuid for "pain", the id-keyed merge would union them into
// duplicate categories that could never be reconciled.
const firstStamps = cats().items.map(c => `${c.id}:${c.createdAt}:${c.updatedAt}`).join();
cats().reload();
cats().reload();
check('W5: seed ids and stamps are identical across re-initialisation',
  cats().items.map(c => `${c.id}:${c.createdAt}:${c.updatedAt}`).join() === firstStamps);
check('W5: re-initialisation does not duplicate the seeds',
  cats().items.length === SEED_CATEGORIES.length);
check('W5: seed stamps are in the past, so any real edit wins the merge',
  cats().items.every(c => new Date(c.updatedAt) < new Date()));

// Rename propagates for free: items hold the id, the name is resolved at render.
cats().updateCategory('cat-pain', { name: 'aches' });
check('W5: a rename propagates to everything resolving by id',
  cats().getCategoryName('cat-pain') === 'aches');
check('W5: a rename bumps updatedAt so it survives the sync merge',
  new Date(cats().getCategory('cat-pain').updatedAt) > new Date('2026-01-01T00:00:00.001Z'));

// Archive keeps the row resolvable but stops it labelling anything.
cats().archive('cat-fatigue');
check('W5: an archived category leaves the active list',
  !cats().getActiveCategories().some(c => c.id === 'cat-fatigue'));
check('W5: an archived category is still resolvable by id',
  cats().getCategory('cat-fatigue')?.name === 'fatigue');
check('W5: an archived category READS as uncategorized',
  cats().getCategoryName('cat-fatigue') === 'uncategorized');
check('W5: an unknown category reads as uncategorized',
  cats().getCategoryName('cat-nope') === 'uncategorized');
cats().unarchive('cat-fatigue');
check('W5: unarchive restores the name', cats().getCategoryName('cat-fatigue') === 'fatigue');

// Archiving is a soft delete, so a seed archived by the user must NOT be
// resurrected by the next load's seeding pass.
cats().archive('cat-other');
cats().reload();
check('W5: seeding does not resurrect an archived seed category',
  !!cats().getCategory('cat-other').deletedAt &&
  cats().items.filter(c => c.id === 'cat-other').length === 1);

const userCatId = cats().addCategory('vestibular');
check('W5: a user category gets a generated id, not a seed id',
  !!userCatId && !userCatId.startsWith('cat-') &&
  cats().getCategoryName(userCatId) === 'vestibular');

// --- Legacy migration --------------------------------------------------------
// Phase 1 data may already exist in Firestore from development, so the migration
// must run over real legacy rows, not a clean slate.
mem.clear();
localStorage.setItem('glim-symptoms-library', JSON.stringify({
  items: [
    { id: 'l1', name: 'migraine',  category: 'pain',        createdAt: '2026-08-14T10:00:00.000Z', updatedAt: '2026-08-14T10:00:00.000Z', deletedAt: null },
    { id: 'l2', name: 'nausea',    category: 'digestive',   createdAt: '2026-08-14T11:00:00.000Z', updatedAt: '2026-08-14T11:00:00.000Z', deletedAt: null },
    { id: 'l3', name: 'odd one',   category: 'not-a-thing', createdAt: '2026-08-14T12:00:00.000Z', updatedAt: '2026-08-14T12:00:00.000Z', deletedAt: null },
    { id: 'l4', name: 'no field',                           createdAt: '2026-08-14T13:00:00.000Z', updatedAt: '2026-08-14T13:00:00.000Z', deletedAt: null },
  ],
}));
lib().reload();

check('W5: migration maps every legacy category string to its seed id',
  lib().getItem('l1').categoryId === 'cat-pain' &&
  lib().getItem('l2').categoryId === 'cat-digestive');
check('W5: migration falls back to the "other" seed for an unknown or absent value',
  lib().getItem('l3').categoryId === 'cat-other' &&
  lib().getItem('l4').categoryId === 'cat-other');
check('W5: migration removes the legacy category field',
  lib().items.every(i => i.category === undefined));
check('W5: migration does NOT bump updatedAt (a schema fix is not a user edit)',
  lib().getItem('l1').updatedAt === '2026-08-14T10:00:00.000Z');
check('W5: migration writes back to localStorage',
  JSON.parse(localStorage.getItem('glim-symptoms-library')).items[0].categoryId === 'cat-pain');

// Idempotence: the migration runs on EVERY load, so a second pass must be a
// no-op. Anything else is a convergence loop that never settles across devices.
const afterFirst = localStorage.getItem('glim-symptoms-library');
lib().reload();
lib().reload();
check('W5: migration is idempotent (a second pass changes nothing)',
  localStorage.getItem('glim-symptoms-library') === afterFirst);

// A renamed category must show through an item migrated from a legacy string.
cats().reload();
cats().updateCategory('cat-pain', { name: 'head stuff' });
check('W5: a rename reaches a migrated legacy item',
  cats().getCategoryName(lib().getItem('l1').categoryId) === 'head stuff');
cats().archive('cat-pain');
check('W5: archiving the category makes a historical item read as uncategorized',
  cats().getCategoryName(lib().getItem('l1').categoryId) === 'uncategorized');

// =============================================================================
//  W6 - clear days
// =============================================================================

mem.clear();
logs().reload();
days().reload();

const today = todayStr();

check('W6: a fresh day has no clear-day record', days().isClear(today) === false);

// Rule 1: refused while an episode is open. "Nothing today" and "this is still
// going" are contradictory claims about the same day.
// Started an hour ago, so endEpisode's "end must be after start" check has a
// real interval to work with rather than two stamps in the same millisecond.
const epId = logs().logMoment('sym-a');
logs().updateEntry(epId, {
  kind: 'episode',
  startedAt: new Date(Date.now() - 3600 * 1000).toISOString(),
});
const openEpisodes = logs().getOpenEpisodes();
check('W6: the fixture really has an open episode', openEpisodes.length === 1);
const affectedToday = () => logs().getAffectedDays(today, today).get(today) ?? new Set();

const refused = days().markClear(today, affectedToday());
check('W6: a clear day is REFUSED while a symptom is present today',
  refused.ok === false && /logged/.test(refused.error));
check('W6: the refusal writes nothing', days().isClear(today) === false);

// Closing the episode does NOT remove the objection: the episode still spans
// today. Only deleting it does. (The old open-episode check let a clear day
// land inside a CLOSED multi-day flare; the affected-days check does not.)
const closed = logs().endEpisode(epId);
check('W6: the episode really closed', closed.ok === true);
check('W6: a CLOSED episode spanning today still refuses a clear day',
  days().markClear(today, affectedToday()).ok === false);
logs().softDelete(epId);
const allowed = days().markClear(today, affectedToday());
check('W6: with no symptom present, the clear day is allowed', allowed.ok === true);
check('W6: the record id IS the logical date string', allowed.day.id === today);
check('W6: the record carries status "none"', allowed.day.status === 'none');
check('W6: isClear reflects it', days().isClear(today) === true);

// Rule 2: logging a symptom and a clear day are mutually exclusive; the log wins.
days().unmarkClear(today);
check('W6: unmark is a SOFT delete, so a sync pull cannot revive it',
  days().isClear(today) === false &&
  days().days.filter(d => d.id === today).length === 1 &&
  !!days().days.find(d => d.id === today).deletedAt);

// Re-marking revives the same row: the id is the date, so one row per day holds
// by construction and the record stays idempotent under last-write-wins.
days().markClear(today, new Set());
check('W6: re-marking revives the SAME row rather than adding a second',
  days().isClear(today) === true &&
  days().days.filter(d => d.id === today).length === 1);

// Rule 3: retroactive marking is allowed, so gaps can be filled in later.
const gapDay = shiftDays(today, -4);
check('W6: a past day can be marked retroactively',
  days().markClear(gapDay, new Set()).ok === true && days().isClear(gapDay) === true);
check('W6: getClearDays returns the range oldest first',
  days().getClearDays(shiftDays(today, -7), today).join() === [gapDay, today].join());
check('W6: getClearDays respects the range bounds',
  days().getClearDays(shiftDays(today, -2), today).join() === today);
check('W6: a malformed date is refused',
  days().markClear('not-a-date', new Set()).ok === false);
check('W6: markClear accepts an array as the affected set too',
  days().markClear(shiftDays(today, -6), ['sym-x']).ok === false &&
  days().markClear(shiftDays(today, -6), []).ok === true);
// The affected set is REQUIRED. A permissive default let a caller that forgot
// it, or passed the whole Map by mistake, mark an affected day clear silently.
check('W6: markClear with no affected set is refused, not allowed',
  days().markClear(shiftDays(today, -7)).ok === false &&
  /required/.test(days().markClear(shiftDays(today, -7)).error));
check('W6: markClear with the wrong type (a Map) is refused',
  days().markClear(shiftDays(today, -7), new Map([[shiftDays(today, -7), new Set(['x'])]])).ok === false);

// An open episode that started BEFORE the day still covers it (its span runs to
// now), so a retroactive clear day inside that span is refused too.
mem.clear();
logs().reload();
days().reload();
const oldEp = logs().logMoment('sym-b');
logs().updateEntry(oldEp, {
  kind: 'episode',
  startedAt: new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString(),
});
const affectedOn = (d) => logs().getAffectedDays(d, d).get(d) ?? new Set();
check('W6: a day inside an OPEN episode span is refused retroactively',
  days().markClear(shiftDays(today, -2), affectedOn(shiftDays(today, -2))).ok === false);
check('W6: a day BEFORE the open episode started is still allowed',
  days().markClear(shiftDays(today, -9), affectedOn(shiftDays(today, -9))).ok === true);

// --- D4: unmarkClear always writes ------------------------------------------
mem.clear();
days().reload();
const dNone = shiftDays(today, -3);
check('D4: precondition - no row for the day', days().days.some(d => d.id === dNone) === false);
days().unmarkClear(dNone);
const tomb = days().days.find(d => d.id === dNone);
check('D4: unmarking a day with NO local row lays a tombstone',
  !!tomb && !!tomb.deletedAt && tomb.status === 'none' && tomb.updatedAt === tomb.deletedAt);
check('D4: the tombstone is not a clear day', days().isClear(dNone) === false);
const firstStamp = tomb.updatedAt;
await tick();
days().unmarkClear(dNone);
const tomb2 = days().days.find(d => d.id === dNone);
check('D4: unmarking again bumps updatedAt (so the newest "not clear" claim wins the merge)',
  tomb2.updatedAt > firstStamp && days().days.filter(d => d.id === dNone).length === 1);
check('D4: unmarking again does not move the original deletedAt',
  tomb2.deletedAt === tomb.deletedAt);
check('D4: a later markClear revives the tombstone row, not a second row',
  days().markClear(dNone, new Set()).ok === true && days().isClear(dNone) === true &&
  days().days.filter(d => d.id === dNone).length === 1);

// --- D3: the edit path --------------------------------------------------------
// The store side: an entry moved onto a clear day, followed by the panel's
// unmark on the RESULTING date, leaves the day not clear.
mem.clear();
logs().reload();
days().reload();
const dClear = shiftDays(today, -5);
check('D3: precondition - past day marked clear', days().markClear(dClear, new Set()).ok === true);
const moved = logs().logMoment('sym-a');
const edit  = logs().updateEntry(moved, { startedAt: logicalDayStart(dClear).toISOString() });
check('D3: updateEntry re-derives the date onto the clear day', edit.ok === true && edit.entry.date === dClear);
check('D3: at this point the store still says the day is clear (the contradiction)',
  days().isClear(dClear) === true);
days().unmarkClear(edit.entry.date);
check('D3: unmarking the RESULTING date resolves it', days().isClear(dClear) === false);

// The panel is what wires the rule; assert it statically, since a store test
// cannot reach a component.
const panelSrc = read('../src/components/SymptomsPanel.jsx');
check('D3: afterLog unmarks the LOGGED entry\'s date, unconditionally',
  /^\s*clearDays\.unmarkClear\(loggedDate\);/m.test(panelSrc) && !/if \([^)]*\)\s*clearDays\.unmarkClear\(loggedDate\)/.test(panelSrc));
check('D3: the edit sheet commit unmarks the RESULTING date',
  /const e = result\.entry;\s*clearDays\.unmarkClear\(e\.date\);/.test(panelSrc) &&
  /onCommit=\{\(fields\) => handleCommit\(editingEntry\.id, fields\)\}/.test(panelSrc));
check('W6: the panel passes the day\'s affected set into markClear (no cross-store import)',
  /markClear\(today, affectedToday\)/.test(panelSrc));
check('D3/D4: the panel applies the read-side precedence (entries beat a clear row)',
  /isClear\(today\) && !presentToday/.test(panelSrc));
check('D3/D4: the reminder card passes the affected set too',
  /markClear\(today, affected\)/.test(read('../src/DesktopPet.jsx')));

// =============================================================================
//  W7 - settings round trip (the enumerated-fields gotcha)
// =============================================================================

mem.clear();
useSettingsStore.getState().reload();

check('W7: the reminder defaults to off at 9pm',
  useSettingsStore.getState().symptomReminderEnabled === false &&
  useSettingsStore.getState().symptomReminderHour === 21);

useSettingsStore.getState().setSymptomReminderEnabled(true);
useSettingsStore.getState().setSymptomReminderHour(19);

const written = JSON.parse(localStorage.getItem('glim-settings'));
check('W7: both new fields are actually WRITTEN to localStorage',
  written.symptomReminderEnabled === true && written.symptomReminderHour === 19);

// The gotcha: loadSettings and saveSettings each enumerate fields, so a field
// added to only one is silently dropped on the next write and never syncs.
useSettingsStore.getState().reload();
check('W7: both new fields survive the load half of the round trip',
  useSettingsStore.getState().symptomReminderEnabled === true &&
  useSettingsStore.getState().symptomReminderHour === 19);

// A write to an UNRELATED setting must not drop them - the exact failure the
// enumeration causes.
useSettingsStore.getState().setWellnessInterval(35);
const after = JSON.parse(localStorage.getItem('glim-settings'));
check('W7: an unrelated setting write does not drop the new fields',
  after.symptomReminderEnabled === true && after.symptomReminderHour === 19 &&
  after.wellnessInterval === 35);

const R = await import('../src/utils/symptomReminder.js');

// --- D3 (span): an edit that turns an entry into an episode reaching back over
//     a clear day must unmark that day, not only the start day ---------------
mem.clear();
logs().reload();
days().reload();
const spanClear = shiftDays(today, -2);           // will be inside the span, not its start
const spanStart = shiftDays(today, -3);
check('D3 span: precondition - the middle day is clear', days().markClear(spanClear, new Set()).ok === true);
const spanId = logs().logMoment('sym-c');
const spanEdit = logs().updateEntry(spanId, {
  kind: 'episode',
  startedAt: logicalDayStart(spanStart).toISOString(),
  endedAt:   logicalDayStart(today).toISOString(),
});
check('D3 span: the episode now spans the clear day',
  spanEdit.ok === true && logs().getAffectedDays(spanClear, spanClear).has(spanClear));
// What handleCommit does with that result:
days().unmarkClear(spanEdit.entry.date);
const spanEnd = toLogicalDateStr(new Date(spanEdit.entry.endedAt));
for (const d of days().getClearDays(spanEdit.entry.date, spanEnd)) days().unmarkClear(d);
check('D3 span: the clear day inside the span is unmarked', days().isClear(spanClear) === false);
check('D3 span: the panel commit walks getClearDays over the span',
  /getClearDays\(spanStart, spanEnd\)/.test(panelSrc) && /for \(const d of clearDays\.getClearDays/.test(panelSrc));

// --- The two notions of "today" -----------------------------------------------
// A closed episode that started on an earlier logical day and ended today is
// PRESENT today (getAffectedDays; markClear refuses) but absent from the today
// LIST (getTodayEntries shows today's entries plus OPEN episodes). Everything
// that decides whether a clear day is possible must use the first notion, or
// the reminder card opens on a day whose only answer is refused.
mem.clear();
logs().reload();
days().reload();
const yday = shiftDays(today, -1);
const ranOver = logs().logMoment('sym-d');
const ro = logs().updateEntry(ranOver, {
  kind: 'episode',
  startedAt: new Date(logicalDayStart(yday).getTime() + 20 * 3600 * 1000).toISOString(),  // 23:00 wall, logical yesterday
  endedAt:   new Date(logicalDayStart(today).getTime() + 2 * 3600 * 1000).toISOString(),  // 05:00 wall, logical today
});
check('D3/D2: fixture - closed episode started yesterday, ended today',
  ro.ok === true && ro.entry.date === yday && ro.entry.endedAt !== null);
check('D3/D2: it is absent from the today LIST', logs().getTodayEntries().length === 0);
const presentSet = logs().getAffectedDays(today, today).get(today) ?? new Set();
check('D3/D2: but PRESENT today', presentSet.size === 1);
check('D3/D2: markClear refuses it', days().markClear(today, presentSet).ok === false);
check('D3/D2: the reminder gate stays CLOSED for it (keys on presence, not the list)',
  R.shouldPromptForClearDay({ enabled: true, hourNow: 23, reminderHour: 21, stampedDate: null,
                              today, presentCount: presentSet.size, isClearToday: false }) === false);
check('D3/D2: DesktopPet feeds presentCount from getAffectedDays, not getTodayEntries',
  (read('../src/DesktopPet.jsx').match(/presentCount:\s*useSymptomsStore\.getState\(\)\.getAffectedDays\(today, today\)\.get\(today\)\?\.size \?\? 0/g) || []).length === 2 &&
  !/getTodayEntries\(\)\.length/.test(read('../src/DesktopPet.jsx')));
check('D3/D2: the panel gates the control and heading on presentToday',
  /disabled=\{!isClearToday && presentToday\}/.test(panelSrc) &&
  /const isClearToday = clearDays\.isClear\(today\) && !presentToday;/.test(panelSrc) &&
  /an earlier episode ran into today/.test(panelSrc));
check('D3/D2: the card no longer hard-codes "end it first?"',
  !/end it first/.test(read('../src/components/SymptomDayPrompt.jsx')));

// =============================================================================
//  D2 - end-of-day reminder decisions
// =============================================================================

const gateBase = {
  enabled: true, hourNow: 21, reminderHour: 21, stampedDate: null,
  today: '2026-09-08', presentCount: 0, isClearToday: false,
};
const gate = (over) => R.shouldPromptForClearDay({ ...gateBase, ...over });

check('D2: gate opens when enabled, past the hour, unstamped, and the day has no record',
  gate({}) === true);
check('D2: gate closed when the setting is off',           gate({ enabled: false }) === false);
check('D2: gate closed once stamped today',                 gate({ stampedDate: '2026-09-08' }) === false);
check('D2: a stamp from an earlier day does not suppress',  gate({ stampedDate: '2026-09-07' }) === true);
check('D2: gate closed before the configured hour',         gate({ hourNow: 20 }) === false);
check('D2: gate opens exactly at the configured hour',      gate({ hourNow: 21, reminderHour: 21 }) === true);
check('D2: gate closed when today already has an entry',    gate({ presentCount: 1 }) === false);
check('D2: gate closed when today is already a clear day',  gate({ isClearToday: true }) === false);

check('D2: dayHasRecord is false for an empty, unmarked day',
  R.dayHasRecord({ presentCount: 0, isClearToday: false }) === false);
check('D2: dayHasRecord is true for an entry OR a clear-day row',
  R.dayHasRecord({ presentCount: 1, isClearToday: false }) === true &&
  R.dayHasRecord({ presentCount: 0, isClearToday: true }) === true);

// The load-bearing rule.
const refusedAnswer = R.resolveClearDayAnswer('yes', { ok: false, error: 'an episode is still going' });
check('D2: a REFUSED yes does NOT stamp the day',             refusedAnswer.stamp === false);
check('D2: a refused yes keeps the card open',                refusedAnswer.close === false);
check('D2: a refused yes carries the reason for display',     /still going/.test(refusedAnswer.error));

const acceptedAnswer = R.resolveClearDayAnswer('yes', { ok: true, day: { id: '2026-09-08' } });
check('D2: a successful yes closes and stamps, no error',
  acceptedAnswer.close === true && acceptedAnswer.stamp === true && acceptedAnswer.error === null);
const declinedAnswer = R.resolveClearDayAnswer('not-now');
check('D2: not-now closes and stamps (declining must suppress for the day)',
  declinedAnswer.close === true && declinedAnswer.stamp === true && declinedAnswer.error === null);
check('D2: a yes with no result is treated as refused - never stamp on unknown',
  R.resolveClearDayAnswer('yes').stamp === false && R.resolveClearDayAnswer('yes', undefined).close === false);
check('D2: an unknown answer fails loudly',
  (() => { try { R.resolveClearDayAnswer('maybe'); return false; } catch { return true; } })());

// Static guards on the caller. The stamp must be written in exactly one place,
// and every answer path must pass through the decision function.
const pet = read('../src/DesktopPet.jsx');
const ccStart = pet.indexOf('const confirmClearDay = useCallback(');
const ccBody  = pet.slice(ccStart, pet.indexOf('}, [', ccStart));
check('D2: confirmClearDay routes through resolveClearDayAnswer',
  ccStart !== -1 && ccBody.includes("resolveClearDayAnswer('yes', described)"));
check('D2: confirmClearDay never writes the stamp itself',
  !ccBody.includes('setItem(') && !/[sS]tamp/.test(ccBody.replace(/\/\/[^\n]*/g, '')));
// No helper other than applyDayPromptOutcome may exist whose name mentions the
// stamp, and inside it the write must be gated on the decision's `stamp` flag.
check('D2: the stamp write is gated on outcome.stamp inside applyDayPromptOutcome',
  /if \(outcome\.stamp\) \{\s*try \{ localStorage\.setItem\(REMINDER_STAMP_KEY, todayStr\(\)\); \}/.test(pet));
check('D2: no other stamp-writing helper is declared',
  (pet.match(/const (?!read)\w*[sS]tamp\w*\s*=/g) || []).length === 0);   // readStamp is a reader
const ddStart = pet.indexOf('const dismissDayPrompt = useCallback(');
const ddBody  = pet.slice(ddStart, pet.indexOf('}, [', ddStart));
check('D2: dismiss routes through resolveClearDayAnswer too',
  ddStart !== -1 && ddBody.includes("resolveClearDayAnswer('not-now')"));
check('D2: the stamp key is written in exactly one place in DesktopPet',
  (pet.match(/localStorage\.setItem\(REMINDER_STAMP_KEY/g) || []).length === 1 &&
  !pet.includes("setItem('glim-symptom-reminder-prompted'"));
const mootStart = pet.indexOf('const moot = dayHasRecord(');
const mootBody  = pet.slice(mootStart, pet.indexOf('}, [', mootStart));
check('D2: the moot-dismiss effect exists and does not stamp',
  mootStart !== -1 && mootBody.includes('setShowDayPrompt(false)') && !mootBody.includes('stamp') && !mootBody.includes('setItem('));
check('D2: the card receives the refusal reason',
  /<SymptomDayPrompt[^>]*error=\{dayPromptError\}/.test(pet) &&
  read('../src/components/SymptomDayPrompt.jsx').includes('error = null'));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
