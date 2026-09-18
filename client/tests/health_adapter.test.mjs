// title: health_adapter.test.mjs
// project: Glim
// author: Reina Hastings
// contact: reinahastings13@gmail.com
//
// purpose:
//   Invariant tests for the health adapter seam (src/health/adapter.js and
//   nullAdapter.js). The plugin-backed adapter is exercised on a device only;
//   what CAN be tested off-device is the part that protects every other
//   platform: that a non-native platform gets the null adapter, that the null
//   adapter answers without throwing, and - the load-bearing one - that
//   importing the adapter never pulls the health plugin into the module graph.
//
//   That last check is why the plugin import is dynamic. A static import would
//   put @capgo/capacitor-health in the web bundle and in this harness.
//
// inputs:  none (stubs @capacitor/core through the resolve hook's alias map)
// outputs: per-check pass/fail lines; exits non-zero if any check fails
//
// usage:
//   cd client && node --import ./tests/register-hooks.mjs tests/health_adapter.test.mjs

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.error(`  FAIL ${name}`); }
}

// --- The null adapter, which imports nothing at all ---
console.log('\n--- nullAdapter ---');
const { nullAdapter } = await import('../src/health/nullAdapter.js');

check('source is null', nullAdapter.source === null);
check('isAvailable resolves false', (await nullAdapter.isAvailable()) === false);
check('hasBeenAsked resolves false', (await nullAdapter.hasBeenAsked()) === false);
check('readHourlySteps resolves to an empty list',
  Array.isArray(await nullAdapter.readHourlySteps(new Date(), new Date()))
  && (await nullAdapter.readHourlySteps(new Date(), new Date())).length === 0);

// requestAccess must RESOLVE, not reject: callers above the adapter are
// platform-blind and must not need a try/catch for the web case.
let rejected = false;
try { await nullAdapter.requestAccess(); } catch { rejected = true; }
check('requestAccess resolves rather than rejecting', !rejected);

check('the contract has exactly the five documented members',
  JSON.stringify(Object.keys(nullAdapter).sort())
    === JSON.stringify(['hasBeenAsked', 'isAvailable', 'readHourlySteps', 'requestAccess', 'source']));

// --- The plugin must not be in the graph ---
//
// Asserted on the SOURCE rather than by importing adapter.js, which would need a
// @capacitor/core stub: the point is the shape of the import, and a static one
// would be visible here.
console.log('\n--- the plugin import is dynamic (web bundles and Node stay clean) ---');
const { readFileSync, readdirSync } = await import('node:fs');
const { fileURLToPath } = await import('node:url');
const { dirname, join } = await import('node:path');
const here = dirname(fileURLToPath(import.meta.url));
const healthDir = join(here, '../src/health');

const adapterSrc = readFileSync(join(healthDir, 'adapter.js'), 'utf8');
check('adapter.js does not import the health plugin statically',
  !/^import .*@capgo\/capacitor-health/m.test(adapterSrc));
check('adapter.js reaches the plugin adapter through a dynamic import',
  /await import\('\.\/pluginAdapter'\)/.test(adapterSrc));
check('adapter.js selects on Capacitor.getPlatform()',
  /Capacitor\.getPlatform\(\)/.test(adapterSrc));
check('nullAdapter.js imports nothing',
  !/^import /m.test(readFileSync(join(healthDir, 'nullAdapter.js'), 'utf8')));

// Only ONE file may name the plugin, anywhere in src/.
const srcDir = join(here, '../src');
function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
}
// Matches an actual import of the package, static or dynamic, not a mention of
// it in a comment (adapter.js explains the boundary in prose, deliberately).
const IMPORTS_PLUGIN = /(?:from|import\()\s*['"]@capgo\/capacitor-health['"]/;
const importers = walk(srcDir).filter(p => /\.(js|jsx)$/.test(p))
  .filter(p => IMPORTS_PLUGIN.test(readFileSync(p, 'utf8')));
check('exactly one file in src/ imports the health plugin',
  importers.length === 1 && importers[0].endsWith('pluginAdapter.js'));

// --- The plugin adapter's own shape, without loading it ---
console.log('\n--- pluginAdapter source invariants ---');
const pluginSrc = readFileSync(join(healthDir, 'pluginAdapter.js'), 'utf8');
check('reads totals via queryAggregated', /Health\.queryAggregated\(/.test(pluginSrc));
check('NEVER calls readSamples (that would double-count iPhone + Watch)',
  !/Health\.readSamples\(/.test(pluginSrc));
check('asks for hourly buckets', /bucket:\s*'hour'/.test(pluginSrc));
check('sums them', /aggregation:\s*'sum'/.test(pluginSrc));
check('requests READ access only, never write',
  /requestAuthorization\(\{ read: \[STEPS\] \}\)/.test(pluginSrc) && !/write:/.test(pluginSrc));
check('hasBeenAsked reads readAuthorized (the real result shape at 8.7.0)',
  /readAuthorized/.test(pluginSrc) && !/res\?\.authorized/.test(pluginSrc));
check('the "asked is not granted" caveat is documented where it can be seen',
  /NOT "ACCESS WAS GRANTED/i.test(pluginSrc));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
