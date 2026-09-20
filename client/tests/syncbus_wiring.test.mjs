// title: syncbus_wiring.test.mjs
// project: Glim
// author: Reina Hastings
// contact: reinahastings13@gmail.com
// date created: 2026-09-10
//
// purpose:
//   Static-analysis guard for the local-write trigger of the event-triggered
//   sync (2026-09-10). Sync no longer polls, so a store that persists to
//   localStorage WITHOUT announcing it on syncBus is a store whose writes reach
//   Firestore only on tab focus or the 15-minute fallback. This test fails the
//   moment such a store appears. Also asserts the layering: syncBus.js imports
//   nothing from Firebase and no store imports sync.js or firebase.js.
//
// usage:
//   cd client && node tests/syncbus_wiring.test.mjs

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src  = (p) => readFileSync(join(here, '../src', p), 'utf8');

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.error(`  FAIL ${name}`); }
}

// --- syncBus.js: the domain list and the layering ---
const busSrc = src('syncBus.js');
check('syncBus.js imports nothing from firebase', !/from ['"](firebase|\.\/firebase)/.test(busSrc));
check('syncBus.js does not import sync.js', !/from ['"]\.\/sync['"]/.test(busSrc));
const domainBlock = busSrc.slice(busSrc.indexOf('export const DOMAINS'), busSrc.indexOf('});', busSrc.indexOf('export const DOMAINS')));
const DOMAIN_KEYS   = [...domainBlock.matchAll(/^\s+([A-Z_]+):\s+'([a-z-]+)',/gm)].map(m => m[1]);
const DOMAIN_VALUES = [...domainBlock.matchAll(/^\s+([A-Z_]+):\s+'([a-z-]+)',/gm)].map(m => m[2]);
check('DOMAINS lists 15 domains', DOMAIN_VALUES.length === 15);

// --- sync.js records under exactly those strings ---
const syncSrc = src('sync.js');
const recorded = new Set([...syncSrc.matchAll(/recordDomain\('([a-z-]+)'/g)].map(m => m[1]));
// The mutable helper records under a `domain` variable; those five come from
// the wrappers' `domain:` fields.
for (const m of syncSrc.matchAll(/domain:\s+'([a-z-]+)'/g)) recorded.add(m[1]);
check('every DOMAINS value is recorded by some sync function', DOMAIN_VALUES.every(d => recorded.has(d)));
check('sync.js records no domain outside DOMAINS', [...recorded].every(d => DOMAIN_VALUES.includes(d)));
check('sync.js subscribes to local writes via syncBus', /import \{ onLocalWrite \} from '\.\/syncBus'/.test(syncSrc) && /onLocalWrite\(/.test(syncSrc));

// --- Every persisting store announces its writes ---
const storeDir = join(here, '../src/stores');
const stores = readdirSync(storeDir).filter(f => /^use[A-Za-z]+Store\.js$/.test(f));
check('found the store modules', stores.length >= 11);
for (const f of stores) {
  const s = readFileSync(join(storeDir, f), 'utf8');
  const persists = /localStorage\.setItem\(/.test(s);
  if (!persists) { check(`${f}: no localStorage writes, nothing to announce`, true); continue; }
  check(`${f}: imports notifyLocalWrite and DOMAINS from ../syncBus`,
    /import \{ notifyLocalWrite, DOMAINS \} from '\.\.\/syncBus'/.test(s));
  const calls = [...s.matchAll(/notifyLocalWrite\(DOMAINS\.([A-Z_]+)\)/g)].map(m => m[1]);
  check(`${f}: calls notifyLocalWrite with a DOMAINS member`, calls.length >= 1 && calls.every(k => DOMAIN_KEYS.includes(k)));
  check(`${f}: never notifies with a string literal`, !/notifyLocalWrite\(['"]/.test(s));
  check(`${f}: imports neither sync.js nor firebase.js`, !/from '\.\.\/(sync|firebase)'/.test(s));
  // The save function (function save*) must contain the call. The seed and
  // migration writes inside load* functions are deliberately exempt: they run
  // at module load, before startSync, and the startup run pushes them.
  const saveFns = [...s.matchAll(/^function save\w*\([^)]*\) \{[\s\S]*?^\}/gm)].map(m => m[0]);
  if (saveFns.length) {
    check(`${f}: every save function announces the write`, saveFns.every(fn => /notifyLocalWrite\(/.test(fn)));
  } else {
    // pokes persists inline in increment()
    check(`${f}: the inline persist announces the write`, /localStorage\.setItem\([^\n]*\n\s*notifyLocalWrite\(/.test(s));
  }
}

// --- Health step import: the panel must SUBSCRIBE to both stores (spec R11a) ---
//
// Reading health rows through useStepsHealthStore.getState() inside a
// useStepsStore selector would compile and read the right number once, but it
// would not subscribe StepsPanel to health-store changes, so an import would
// land silently and the panel would keep showing the old number until something
// else re-rendered it. The rows must arrive through the hook.
const panelSrc = src('components/StepsPanel.jsx');
check('StepsPanel subscribes to useStepsStore', /useStepsStore\(/.test(panelSrc));
check('StepsPanel subscribes to useStepsHealthStore', /useStepsHealthStore\(/.test(panelSrc));
check('StepsPanel does not read the health store via getState()',
  !/useStepsHealthStore\.getState\(/.test(panelSrc));
check('no store reads another store via getState() either',
  !stores.some(f => /use[A-Za-z]+Store\.getState\(/.test(readFileSync(join(storeDir, f), 'utf8'))));

// The hero-number editor must not prefill a health-sourced number: commitEdit
// fires on blur, so a prefill would let an accidental tap pin the day.
check('StepsPanel prefills the editor only for a manual value',
  /todaySource === 'manual'/.test(panelSrc));

// --- The device health record must never reach the sync bus ---
//
// 'glim-health' records a permission that belongs to ONE PHONE. Syncing it
// would tell the desktop tab that it may import from Health, which it cannot,
// and would claim a consent that device never gave. It lives outside
// src/stores/ so the store scan above does not cover it; assert it directly.
const deviceRecordSrc = src('health/deviceRecord.js');
check('deviceRecord.js does not import the sync bus',
  !/from '\.\.\/syncBus'/.test(deviceRecordSrc));
check('deviceRecord.js never announces a local write',
  !/notifyLocalWrite/.test(deviceRecordSrc));
check('no sync config names the device health key',
  !/'glim-health'/.test(syncSrc));

// --- The import triggers ---
const appSrc = src('App.jsx');
check('the startup import is native-only',
  /Capacitor\.isNativePlatform\(\)/.test(appSrc) && /reason: 'startup'/.test(appSrc));
check('the foreground listener is removed on unmount',
  /appStateChange/.test(appSrc) && /handle\.remove\(\)/.test(appSrc));
check('the panel-open trigger exists', /reason: 'panel'/.test(panelSrc));

// --- The consent flow and the copy rules (Phase 2, step 6) ---
//
// These are prose requirements that no behavioural test can hold: Glim must
// never tell the user they denied Health access, because iOS refuses to tell
// the APP that, so any such claim would be a guess presented as a fact.
const settingsSrc = src('components/settings/StepsSettings.jsx');
check('the toggle is hidden until the platform says health exists',
  /available !== true/.test(settingsSrc) && /isAvailable\(\)/.test(settingsSrc));
check('switching on requests access and then imports',
  /requestAccess\(\)/.test(settingsSrc) && /reason: 'toggle', force: true/.test(settingsSrc));
check('a failed request reverts the toggle and clears askedAt',
  /stepsImport: false, askedAt: null/.test(settingsSrc));
check('switching off deletes nothing',
  !/clearRows|removeItem/.test(settingsSrc));
check('the consent text names the data, the destination, and the no-write promise',
  /daily step counts/.test(settingsSrc) && /your glim account/.test(settingsSrc)
  && /never writes/.test(settingsSrc));

for (const [label, src_] of [['settings', settingsSrc], ['panel', panelSrc]]) {
  check(`${label}: never claims the user denied access`,
    !/you denied|denied access|access denied/i.test(src_));
}
check('the explainer points at the Health app instead of guessing',
  /Data Access/.test(panelSrc));
check('the first-import message is shown once per device',
  /firstImportAnnounced/.test(panelSrc));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
