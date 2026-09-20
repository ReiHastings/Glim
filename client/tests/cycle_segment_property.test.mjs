// title: cycle_segment_property.test.mjs
// project: Glim
// author: Reina Hastings
// contact: reinahastings13@gmail.com
//
// purpose:
//   THE specification for cycle segmentation. Fixture tests pin the cases
//   somebody thought of; this pins the ones nobody did. Three successive drafts
//   of the segmentation rules written in prose read as complete and were not -
//   each left an input class unclassified or two rules contradicting each other.
//   Properties that hold over randomly generated histories are what actually
//   closed them.
//
//   Properties asserted over every generated history:
//     P1 every effective bleeding day belongs to exactly one cycle
//     P2 no two DERIVED starts within REFRACTORY_DAYS (forced starts may be closer)
//     P3 cycles strictly ascending and non-overlapping
//     P4 cycleLength === daysBetweenStr(start, nextStart)
//     P5 1 <= periodLength <= cycleLength for every complete cycle
//     P6 order invariance: shuffling the rows changes nothing
//     P7 translation invariance: +N days shifts every output date by exactly N
//     P8 adding a redundant quiet row changes nothing
//
// inputs:  none (deterministic PRNG, seed below)
// outputs: per-property pass/fail; exits non-zero if any property fails
//
// usage:
//   cd client && TZ=America/New_York node --import ./tests/register-hooks.mjs tests/cycle_segment_property.test.mjs

if (process.env.TZ !== 'America/New_York') {
  console.error('FAIL this test must run under TZ=America/New_York (see tests/README.md)');
  process.exit(1);
}

const { segmentCycles } = await import('../src/cycle/segment.js');
const { addDaysStr, daysBetweenStr } = await import('../src/utils/dateUtils.js');
const { REFRACTORY_DAYS, BLEEDING_FLOWS } = await import('../src/cycle/constants.js');

const SEED = 20260918, TRIALS = 4000;
function mulberry32(a) {
  return function () { a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const rnd = mulberry32(SEED);
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const BASE = '2026-01-15';

// Generates deliberately nasty histories: overlapping runs, stray single days,
// long continuous bleeds, forced and excluded days, quiet gaps of every length.
function randomHistory() {
  const span = 40 + Math.floor(rnd() * 160);
  const rows = [];
  let d = 0;
  while (d < span) {
    const r = rnd();
    if (r < 0.45) {                                   // a bleeding run
      const len = 1 + Math.floor(rnd() * 6);
      for (let k = 0; k < len && d < span; k++, d++) {
        const row = { date: addDaysStr(BASE, d), flow: pick(BLEEDING_FLOWS), isPeriodStart: null };
        if (rnd() < 0.05) row.isPeriodStart = true;
        else if (rnd() < 0.05) row.isPeriodStart = false;
        rows.push(row);
      }
    } else if (r < 0.60) {                            // spotting
      const len = 1 + Math.floor(rnd() * 5);
      for (let k = 0; k < len && d < span; k++, d++)
        rows.push({ date: addDaysStr(BASE, d), flow: 'spotting', isPeriodStart: null });
    } else if (r < 0.70) {                            // explicit 'none'
      rows.push({ date: addDaysStr(BASE, d), flow: 'none', isPeriodStart: null }); d++;
    } else {                                          // no row at all
      d += 1 + Math.floor(rnd() * 12);
    }
  }
  // `today` is sometimes set BEHIND the last row, reproducing the 01:30 case
  // where R4a lets the user log the calendar date (= todayStr() + 1).
  const todayOffset = rnd() < 0.2 ? span - 1 - Math.floor(rnd() * 3) : span + 2;
  return { rows: rows.map(r => ({ ...r, id: r.date, updatedAt: '2026-01-01T00:00:00.000Z' })),
           today: addDaysStr(BASE, Math.max(0, todayOffset)) };
}

const isBleed = f => BLEEDING_FLOWS.includes(f);
const effectiveBleedDays = (rows) =>
  rows.filter(r => isBleed(r.flow) && r.isPeriodStart !== false).map(r => r.date);

let failures = [];
const fail = (p, msg) => { if (failures.length < 12) failures.push(`${p}: ${msg}`); };

for (let t = 0; t < TRIALS; t++) {
  const { rows, today } = randomHistory();
  let cycles;
  try { cycles = segmentCycles(rows, today, addDaysStr(BASE, 400)); }
  catch (e) { fail('P0', `threw: ${e.message}`); continue; }

  const bleedDays = effectiveBleedDays(rows);

  // P1 every effective bleeding day in exactly one cycle
  for (const day of bleedDays) {
    const containing = cycles.filter(c => c.startDate <= day && day <= c.endDate);
    if (containing.length !== 1) fail('P1', `${day} in ${containing.length} cycles`);
  }

  // P2 derived starts are > REFRACTORY_DAYS apart
  const forcedDates = new Set(rows.filter(r => r.isPeriodStart === true).map(r => r.date));
  for (let i = 1; i < cycles.length; i++) {
    const a = cycles[i - 1], b = cycles[i];
    if (forcedDates.has(b.startDate)) continue;
    const gap = daysBetweenStr(a.startDate, b.startDate);
    if (gap <= REFRACTORY_DAYS) fail('P2', `derived starts ${a.startDate} -> ${b.startDate} gap ${gap}`);
  }

  // P3 ascending, non-overlapping
  for (let i = 1; i < cycles.length; i++) {
    if (!(cycles[i - 1].startDate < cycles[i].startDate)) fail('P3', 'not ascending');
    if (!(cycles[i - 1].endDate < cycles[i].startDate)) fail('P3', 'overlap');
  }

  // P4 / P5 arithmetic
  for (let i = 0; i < cycles.length; i++) {
    const c = cycles[i];
    if (c.isComplete) {
      const expect = daysBetweenStr(c.startDate, cycles[i + 1].startDate);
      if (c.cycleLength !== expect) fail('P4', `${c.cycleLength} !== ${expect}`);
      if (!(c.periodLength >= 1 && c.periodLength <= c.cycleLength))
        fail('P5', `periodLength ${c.periodLength} vs cycleLength ${c.cycleLength}`);
    } else {
      if (c.cycleLength !== null) fail('P4', 'incomplete cycle has a length');
      if (c.periodLength < 1) fail('P5', `periodLength ${c.periodLength}`);
    }
  }

  // P6 order invariance
  const shuffled = [...rows];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1)); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  if (JSON.stringify(segmentCycles(shuffled, today, addDaysStr(BASE, 400))) !== JSON.stringify(cycles))
    fail('P6', 'shuffling rows changed the result');

  // P7 translation invariance
  const N = 1 + Math.floor(rnd() * 200);
  const shifted = rows.map(r => ({ ...r, date: addDaysStr(r.date, N), id: addDaysStr(r.date, N) }));
  const shiftedCycles = segmentCycles(shifted, addDaysStr(today, N), addDaysStr(BASE, 400 + N));
  if (shiftedCycles.length !== cycles.length) fail('P7', 'cycle count changed under translation');
  else for (let i = 0; i < cycles.length; i++) {
    if (shiftedCycles[i].startDate !== addDaysStr(cycles[i].startDate, N))
      fail('P7', `start ${cycles[i].startDate} +${N} !== ${shiftedCycles[i].startDate}`);
    if (shiftedCycles[i].cycleLength !== cycles[i].cycleLength) fail('P7', 'length changed');
    if (JSON.stringify(shiftedCycles[i].flags) !== JSON.stringify(cycles[i].flags))
      fail('P7', 'flags changed');
  }

  // P8 a redundant quiet row on a day with no row changes nothing
  const used = new Set(rows.map(r => r.date));
  let extra = null;
  for (let k = 0; k < 400; k++) {
    const cand = addDaysStr(BASE, Math.floor(rnd() * 200));
    if (!used.has(cand) && cand <= today) { extra = cand; break; }
  }
  if (extra) {
    const withNone = [...rows, { id: extra, date: extra, flow: 'none', isPeriodStart: null,
                                 updatedAt: '2026-01-01T00:00:00.000Z' }];
    if (JSON.stringify(segmentCycles(withNone, today, addDaysStr(BASE, 400))) !== JSON.stringify(cycles))
      fail('P8', `adding flow:'none' on ${extra} changed the result`);
  }
}

console.log(`ran ${TRIALS} random histories`);
if (failures.length === 0) {
  console.log('  ok   P1-P8 all hold');
  process.exit(0);
} else {
  console.error(`  FAIL ${failures.length} property violation(s), first few:`);
  for (const f of failures) console.error('   - ' + f);
  process.exit(1);
}
