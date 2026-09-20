// title: cycle_panel_wiring.test.mjs
// project: Glim
// author: Reina Hastings
// contact: reinahastings13@gmail.com
//
// purpose:
//   The obligation every symptom log carries, wherever it is logged from: the
//   entry's day must stop being a clear day.
//
//   This is the check most likely to be forgotten when a NEW surface starts
//   logging symptoms, which is exactly what the cycle panel is. Failing it does
//   not break the display (readers apply the precedence rule anyway) - it
//   corrupts the STORED record, and only across devices, which is the hardest
//   kind of bug to notice.
//
// usage:
//   cd client && TZ=America/New_York node --import ./tests/register-hooks.mjs tests/cycle_panel_wiring.test.mjs

if (process.env.TZ !== 'America/New_York') {
  console.error('FAIL this test must run under TZ=America/New_York');
  process.exit(1);
}
const mem = new Map();
globalThis.localStorage = {
  getItem: k => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => { mem.set(k, String(v)); },
  removeItem: k => { mem.delete(k); }, clear: () => mem.clear(),
  key: i => [...mem.keys()][i] ?? null, get length() { return mem.size; },
};

const { logSymptomAndClearDay } = await import('../src/utils/logSymptom.js');
const { useSymptomsStore } = await import('../src/stores/useSymptomsStore.js');
const { useSymptomClearDaysStore } = await import('../src/stores/useSymptomClearDaysStore.js');
const { todayStr } = await import('../src/utils/dateUtils.js');

let passed = 0, failed = 0;
const check = (n, c, d) => { if (c) { passed++; console.log(`  ok   ${n}`); }
  else { failed++; console.error(`  FAIL ${n}${d ? '  -> ' + d : ''}`); } };

const S = () => useSymptomsStore.getState();
const CD = () => useSymptomClearDaysStore.getState();
const today = todayStr();
const deps = () => ({
  logMoment: S().logMoment,
  getLogs: () => useSymptomsStore.getState().logs,
  unmarkClear: CD().unmarkClear,
  fallbackDate: today,
});

console.log('\n-- a chip tap does BOTH things --');
{
  mem.clear();
  useSymptomsStore.setState({ logs: [] });
  useSymptomClearDaysStore.setState({ days: [] });

  // markClear REQUIRES the affected-symptom set; a permissive default would let
  // a caller that forgot it mark an affected day clear without a sound.
  const marked = CD().markClear(today, new Set());
  check('the day starts marked clear',
    marked.ok === true && CD().days.some(d => d.id === today && !d.deletedAt),
    JSON.stringify(marked));

  const { id, date } = logSymptomAndClearDay(deps(), 'sym-menstrual-cramps');
  check('a symptom entry was created', S().logs.some(e => e.id === id));
  check('it landed on today', date === today);
  check('and the clear day was unmarked', !CD().days.some(d => d.id === today && !d.deletedAt));
}

console.log('\n-- the unmark is UNCONDITIONAL --');
{
  // The clear-day store must be able to lay a tombstone even where it holds no
  // row: another device may hold a clear mark this one has not pulled, and
  // without a local tombstone that stale row wins the merge.
  mem.clear();
  useSymptomsStore.setState({ logs: [] });
  useSymptomClearDaysStore.setState({ days: [] });
  check('no clear row exists to begin with', CD().days.length === 0);
  logSymptomAndClearDay(deps(), 'sym-menstrual-bloating');
  check('a tombstone was still written', CD().days.length === 1, JSON.stringify(CD().days));
  check('and it is a tombstone, not a live clear mark', CD().days[0].deletedAt !== null);
}

console.log('\n-- it keys on the ENTRY date, not on the fallback --');
{
  mem.clear();
  useSymptomsStore.setState({ logs: [] });
  useSymptomClearDaysStore.setState({ days: [] });
  let unmarked = null;
  logSymptomAndClearDay({
    logMoment: () => 'fabricated-id',
    getLogs: () => [{ id: 'fabricated-id', date: '2026-01-05' }],
    unmarkClear: (d) => { unmarked = d; },
    fallbackDate: today,
  }, 'x');
  check('unmarks the entry’s own date', unmarked === '2026-01-05', String(unmarked));

  let fallbackUsed = null;
  logSymptomAndClearDay({
    logMoment: () => 'missing',
    getLogs: () => [],
    unmarkClear: (d) => { fallbackUsed = d; },
    fallbackDate: today,
  }, 'x');
  check('falls back rather than throwing when the entry is not found',
    fallbackUsed === today);
}

console.log('\n-- both panels use the shared helper, so they cannot drift --');
{
  const { readFileSync } = await import('node:fs');
  const cycle = readFileSync(new URL('../src/components/CyclePanel.jsx', import.meta.url), 'utf8');
  check('CyclePanel routes its chip taps through logSymptomAndClearDay',
    /logSymptomAndClearDay\(/.test(cycle));
  // It passes symptoms.logMoment as a DEPENDENCY, so there should be no bare
  // invocation anywhere in the file: every log goes through the shared helper.
  check('and never invokes logMoment directly',
    (cycle.match(/logMoment\(/g) ?? []).length === 0,
    String((cycle.match(/logMoment\(/g) ?? []).length));
  const symptomsPanel = readFileSync(new URL('../src/components/SymptomsPanel.jsx', import.meta.url), 'utf8');
  check('SymptomsPanel still funnels every log through afterLog',
    !/[^r]\blogMoment\([^)]*\)(?!\s*[,)])/.test(symptomsPanel.replace(/afterLog\(symptoms\.logMoment\([^)]*\)/g, '')));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
