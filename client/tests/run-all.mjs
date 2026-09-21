#!/usr/bin/env node
// title: run-all.mjs
// project: Glim
// author: Reina Hastings
// contact: reinahastings13@gmail.com
// created: 2026-09-20
//
// purpose:
//   Runs every standalone test under tests/ with the --import hook and TZ
//   pin each one needs, so `npm test` and CI execute the same matrix a human
//   would by following tests/README.md. Spec: docs/plan_stage0_ci.md.
//
//   The MANIFEST below is a list of RUNS (one file may appear under several
//   zones). Before anything executes, pre-flight checks run against the real
//   manifest and fail the whole run on any mismatch:
//     coverage  - every tests/*.test.mjs on disk has a row, every row's file exists
//     duplicates - no two rows are identical
//     fidelity  - each file's header `usage:` block agrees with its rows (hook, zones)
//   Fast rows run in parallel; rows marked slow run afterwards, one at a time,
//   so the CPU-bound calibration test never starves the timer-sensitive tests.
//
// inputs:  tests/*.test.mjs (each exits non-zero on failure)
// outputs: one line per run, full output of every failure, a summary line;
//          exit 0 iff pre-flight passed, no run failed, and at least one ran
//
// usage:
//   cd client
//   node tests/run-all.mjs               # everything (npm run test:all)
//   node tests/run-all.mjs --fast        # skip slow rows (npm test)
//   node tests/run-all.mjs --only cycle  # rows whose file name contains "cycle"
//   node tests/run-all.mjs --serial      # concurrency 1, live ordering
//   node tests/run-all.mjs --self-test   # prove the runner's own checks fire

import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { readdir, readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

// --- Constants ---------------------------------------------------------------

const NY = 'America/New_York';
const HOOKS = {
  none: null,
  hooks: './tests/register-hooks.mjs',
  'sync-mocks': './tests/register-sync-mocks.mjs',
};
const TIMEOUT_MS = { normal: 120_000, slow: 600_000 };
// After the child EXITS, how long to wait for its output streams to close
// before giving up on them. A descendant that inherited the pipes can hold
// them open indefinitely; the row must not wait on that.
const DRAIN_GRACE_MS = 1_000;
const CLIENT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// --- Manifest ----------------------------------------------------------------
// Every row carries an explicit tz. Rows whose documentation names no zone get
// NY, which is what they have always run under locally; on CI the host is UTC
// and no test has ever been exercised there.

const row = (file, hook, tz = NY, slow = false) => ({ file, hook, tz, slow });

export const MANIFEST = [
  // Hooked, TZ-pinned (documented)
  row('cycle_calibration.test.mjs', 'hooks', NY, true),
  row('cycle_panel_wiring.test.mjs', 'hooks'),
  row('cycle_phase.test.mjs', 'hooks'),
  row('cycle_predict.test.mjs', 'hooks'),
  row('cycle_segment.test.mjs', 'hooks'),
  row('cycle_segment_property.test.mjs', 'hooks'),
  row('cycle_store.test.mjs', 'hooks'),
  row('steps_day_rollover.test.mjs', 'hooks'),
  row('steps_health_fold.test.mjs', 'hooks'),
  row('steps_index_equivalence.test.mjs', 'hooks'),
  row('steps_precedence.test.mjs', 'hooks'),
  // cycle_dates: all four zones (README: mutation-verified, UTC is the vacuity control)
  row('cycle_dates.test.mjs', 'hooks', 'America/New_York'),
  row('cycle_dates.test.mjs', 'hooks', 'Australia/Lord_Howe'),
  row('cycle_dates.test.mjs', 'hooks', 'America/Santiago'),
  row('cycle_dates.test.mjs', 'hooks', 'UTC'),
  // Hooked, no documented zone
  row('cycle_enable.test.mjs', 'hooks'),
  row('date_wheel.test.mjs', 'hooks'),
  row('health_adapter.test.mjs', 'hooks'),
  row('steps_import.test.mjs', 'hooks'),
  row('symptoms_phase15.test.mjs', 'hooks'),
  row('symptoms_store.test.mjs', 'hooks'),
  row('sync_generation_guard.test.mjs', 'hooks'),
  row('water_softdelete.test.mjs', 'hooks'),
  row('water_fill.test.mjs', 'hooks'),   // pure arithmetic, but its header names the hook
  // Sync mocks
  row('cursor_pulls.test.mjs', 'sync-mocks'),
  row('symptoms_sync.test.mjs', 'sync-mocks'),
  row('sync_scenarios.test.mjs', 'sync-mocks'),
  row('sync_scheduler.test.mjs', 'sync-mocks'),
  row('sync_stale_run.test.mjs', 'sync-mocks'),
  // Bare node (static checks)
  row('firestore_rules.test.mjs', 'none'),
  row('flushsync_scope.test.mjs', 'none'),
  row('syncbus_wiring.test.mjs', 'none'),
  row('token_parity.test.mjs', 'none'),
];

// --- Pre-flight: coverage, duplicates, fidelity -----------------------------

const USAGE_RE = /(?:TZ=(\S+)\s+)?node\s+(?:--import\s+(\S+)\s+)?tests\/(\S+\.test\.mjs)/g;

function hookOfImport(importPath) {
  if (!importPath) return 'none';
  for (const [name, p] of Object.entries(HOOKS)) if (p && importPath.endsWith(p.slice(2))) return name;
  return `unknown(${importPath})`;
}

// Returns the text of the header's `usage:` block: the comment lines that
// follow a line starting `// usage`, up to the first line that is not a
// comment with content. Backslash line continuations are joined, so a command
// wrapped over two lines reads as one. Null if there is no such block.
function usageBlock(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^\/\/\s*usage\b/i.test(l));
  if (start < 0) return null;
  const body = [];
  for (let i = start + 1; i < lines.length; i++) {
    const m = /^\/\/(.*)$/.exec(lines[i]);
    if (!m || m[1].trim() === '') break;
    body.push(m[1]);
  }
  return body.join('\n').replace(/\\\n\s*/g, ' ');
}

// What the file's own usage block declares: the hooks and zones named in its
// commands. An absent TZ on a command is recorded as null ("no pin declared").
async function declaredUsage(root, file) {
  const text = await readFile(path.join(root, 'tests', file), 'utf8');
  const block = usageBlock(text);
  const hooks = new Set(), zones = new Set();
  if (block === null) return { hooks, zones, commands: 0 };
  let commands = 0;
  for (const m of block.matchAll(USAGE_RE)) {
    if (m[3] !== file) continue;
    commands++;
    hooks.add(hookOfImport(m[2]));
    zones.add(m[1] ?? null);
  }
  return { hooks, zones, commands };
}

export async function preflight(root, manifest) {
  const problems = [];
  const onDisk = (await readdir(path.join(root, 'tests'))).filter((f) => f.endsWith('.test.mjs'));
  const inManifest = new Set(manifest.map((r) => r.file));

  // Step 1: coverage, both directions, and known hooks.
  for (const f of onDisk) if (!inManifest.has(f)) problems.push(`coverage: ${f} exists but has no manifest row`);
  for (const f of inManifest) if (!onDisk.includes(f)) problems.push(`coverage: manifest row for ${f} but the file does not exist`);
  for (const r of manifest) if (!(r.hook in HOOKS)) problems.push(`manifest: ${r.file} names unknown hook '${r.hook}'`);

  // Step 2: no duplicate rows.
  const seen = new Set();
  for (const r of manifest) {
    const key = `${r.file}|${r.hook}|${r.tz}`;
    if (seen.has(key)) problems.push(`duplicate: ${r.file} under ${r.tz} with hook ${r.hook} is listed twice`);
    seen.add(key);
  }

  // Step 3: fidelity against each file's own usage block.
  for (const f of inManifest) {
    if (!onDisk.includes(f)) continue;
    const rows = manifest.filter((r) => r.file === f);
    const { hooks, zones, commands } = await declaredUsage(root, f);
    if (commands === 0) { problems.push(`fidelity: ${f} has no parsable command in its header usage block`); continue; }
    const rowHooks = new Set(rows.map((r) => r.hook));
    if (hooks.size !== 1 || rowHooks.size !== 1 || [...hooks][0] !== [...rowHooks][0]) {
      problems.push(`fidelity: ${f} header says hook ${[...hooks].join('|')}, manifest says ${[...rowHooks].join('|')}`);
    }
    const declared = [...zones].filter(Boolean);
    const rowZones = new Set(rows.map((r) => r.tz));
    if (declared.length > 0) {
      // Header pins zones: the manifest must run exactly that set, once each.
      const want = new Set(declared);
      const same = want.size === rowZones.size && [...want].every((z) => rowZones.has(z));
      if (!same) problems.push(`fidelity: ${f} header pins [${[...want]}], manifest runs [${[...rowZones]}]`);
    } else if (!(rowZones.size === 1 && rowZones.has(NY))) {
      // Header pins nothing: the manifest must use the single default.
      problems.push(`fidelity: ${f} header pins no zone, so the manifest must run it once under ${NY}; it runs [${[...rowZones]}]`);
    }
  }
  return problems;
}

// --- Execution ---------------------------------------------------------------

function label(r) { return `${r.file.replace('.test.mjs', '')} [${r.tz}]`; }

// Resolves when the child has EXITED and its output has either closed or been
// given DRAIN_GRACE_MS to close. Waiting on 'close' alone can hang forever if a
// descendant inherited the pipes, so exit is the primary signal. The streams
// are destroyed on settle so a lingering descendant cannot keep the runner's
// event loop alive either.
export function runRow(r, { root, timeoutMs, drainGraceMs = DRAIN_GRACE_MS }) {
  return new Promise((resolve) => {
    const args = [];
    if (HOOKS[r.hook]) args.push('--import', HOOKS[r.hook]);
    args.push(`tests/${r.file}`);
    const started = Date.now();
    const chunks = [];
    const child = spawn(process.execPath, args, {
      cwd: root,
      env: { ...process.env, TZ: r.tz },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let exited = false, timedOut = false, settled = false, grace = null;
    const settle = (code, signal, extra = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (grace) clearTimeout(grace);
      child.stdout.destroy();
      child.stderr.destroy();
      const status = timedOut ? 'TIMEOUT' : code === 0 ? 'PASS' : 'FAIL';
      resolve({ row: r, status, code, signal, ms: Date.now() - started, output: Buffer.concat(chunks).toString('utf8') + extra });
    };
    const timer = setTimeout(() => {
      if (exited) return;            // finished in time; only the drain is pending
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (c) => chunks.push(c));
    child.stderr.on('data', (c) => chunks.push(c));
    child.on('exit', (code, signal) => {
      exited = true;
      grace = setTimeout(() => settle(code, signal, '\n[runner] output streams still open after exit; a descendant may be holding them\n'), drainGraceMs);
    });
    child.on('close', (code, signal) => settle(code, signal));
    child.on('error', (err) => settle(null, null, String(err)));
  });
}

async function pool(rows, concurrency, fn) {
  const results = [];
  let next = 0;
  async function worker() {
    while (next < rows.length) { const i = next++; results[i] = await fn(rows[i]); }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, worker));
  return results;
}

export async function runAll(root, manifest, opts = {}) {
  const { fast = false, only = null, serial = false, log = console.log, timeouts = TIMEOUT_MS } = opts;
  const problems = await preflight(root, manifest);
  if (problems.length) {
    for (const p of problems) log(`PRE-FLIGHT ${p}`);
    return { ok: false, problems, results: [], skipped: 0 };
  }
  let selected = manifest;
  if (only) selected = selected.filter((r) => r.file.includes(only));
  const notSelected = manifest.length - selected.length;
  const skipped = fast ? selected.filter((r) => r.slow).length : 0;
  if (fast) selected = selected.filter((r) => !r.slow);
  if (selected.length === 0) {
    log(`no runs selected${only ? ` for --only ${only}` : ''}`);
    return { ok: false, problems: ['empty selection'], results: [], skipped };
  }
  const concurrency = serial ? 1 : Math.min(os.cpus().length, 4);
  const report = (res) => log(`${res.status.padEnd(7)} ${(res.ms / 1000).toFixed(1).padStart(6)}s  ${label(res.row)}`);
  const run = async (r) => {
    const res = await runRow(r, { root, timeoutMs: r.slow ? timeouts.slow : timeouts.normal });
    report(res);
    return res;
  };
  // Phase 1: fast rows in parallel. Phase 2: slow rows, one at a time.
  const fastRows = selected.filter((r) => !r.slow), slowRows = selected.filter((r) => r.slow);
  const results = [...(await pool(fastRows, concurrency, run)), ...(await pool(slowRows, 1, run))];
  const failures = results.filter((r) => r.status !== 'PASS');
  for (const f of failures) {
    log(`\n--- ${f.status} ${label(f.row)} (exit ${f.code}${f.signal ? `, signal ${f.signal}` : ''}) ---`);
    log(f.output.trimEnd());
  }
  // Summary identity: everything in the manifest is accounted for exactly once.
  const accounted = results.length + skipped + notSelected;
  if (accounted !== manifest.length) {
    log(`RUNNER BUG: ${results.length} ran + ${skipped} skipped + ${notSelected} not selected = ${accounted}, manifest has ${manifest.length}`);
    return { ok: false, problems: ['summary identity'], results, skipped };
  }
  log(`\n${manifest.length} runs: ${results.length - failures.length} passed, ${failures.length} failed, ${skipped} skipped` +
      (only ? ` (${notSelected} not selected)` : ''));
  return { ok: failures.length === 0, problems: [], results, skipped };
}

// --- Self-test ---------------------------------------------------------------
// Each check plants one known defect in a throwaway tree and asserts the runner
// reports it. Uses the same preflight/runAll code path as a real run.

async function selfTest() {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'glim-runner-'));
  const testsDir = path.join(tmp, 'tests');
  await mkdir(testsDir);
  const write = (name, body) => writeFile(path.join(testsDir, name), body);
  const clear = async () => { for (const f of await readdir(testsDir)) await rm(path.join(testsDir, f)); };
  const header = (name, { hook = '', zones = [null] } = {}) =>
    '// usage:\n' + zones.map((z) => `//   cd client && ${z ? `TZ=${z} ` : ''}node ${hook}tests/${name}\n`).join('');
  const HOOKED = '--import ./tests/register-hooks.mjs ';
  let passed = 0, failed = 0;
  const check = (name, cond, detail = '') => {
    if (cond) { passed++; console.log(`  ok   ${name}`); }
    else { failed++; console.error(`  FAIL ${name}${detail ? `: ${detail}` : ''}`); }
  };
  const quiet = () => { const lines = []; return { log: (l) => lines.push(String(l)), lines }; };
  const has = (q, ...words) => q.lines.some((l) => words.every((w) => l.includes(w)));

  try {
    // 1. Failure propagates.
    await write('bad.test.mjs', header('bad.test.mjs') + 'console.log("about to fail"); process.exit(1);\n');
    let q = quiet();
    let r = await runAll(tmp, [row('bad.test.mjs', 'none')], { log: q.log });
    check('1 failing script fails the run and is named', !r.ok && has(q, 'FAIL', 'bad'));

    // 2. Coverage fires, both directions.
    await write('orphan.test.mjs', header('orphan.test.mjs') + 'process.exit(0);\n');
    q = quiet();
    r = await runAll(tmp, [row('bad.test.mjs', 'none')], { log: q.log });
    check('2a file with no row fails pre-flight, nothing runs', !r.ok && r.results.length === 0 && has(q, 'coverage', 'orphan'));
    await rm(path.join(testsDir, 'orphan.test.mjs'));
    q = quiet();
    r = await runAll(tmp, [row('bad.test.mjs', 'none'), row('ghost.test.mjs', 'none')], { log: q.log });
    check('2b row with no file fails pre-flight', !r.ok && r.results.length === 0 && has(q, 'coverage', 'ghost', 'does not exist'));

    // 3. Fidelity fires: hook, single zone, zone set, unparsable header.
    await write('mismatch.test.mjs', header('mismatch.test.mjs', { hook: HOOKED }) + 'process.exit(0);\n');
    q = quiet();
    r = await runAll(tmp, [row('bad.test.mjs', 'none'), row('mismatch.test.mjs', 'none')], { log: q.log });
    check('3a header/manifest hook mismatch fails pre-flight', !r.ok && r.results.length === 0 && has(q, 'fidelity', 'mismatch', 'hooks'));
    await rm(path.join(testsDir, 'mismatch.test.mjs'));
    await write('zone.test.mjs', header('zone.test.mjs', { zones: ['UTC'] }) + 'process.exit(0);\n');
    q = quiet();
    r = await runAll(tmp, [row('bad.test.mjs', 'none'), row('zone.test.mjs', 'none', NY)], { log: q.log });
    check('3b header pins UTC, manifest runs NY: fails pre-flight', !r.ok && r.results.length === 0 && has(q, 'fidelity', 'zone', 'UTC', NY));
    await rm(path.join(testsDir, 'zone.test.mjs'));
    await write('multi.test.mjs', header('multi.test.mjs', { zones: ['UTC', 'America/Santiago'] }) + 'process.exit(0);\n');
    q = quiet();
    r = await runAll(tmp, [row('bad.test.mjs', 'none'), row('multi.test.mjs', 'none', 'UTC')], { log: q.log });
    check('3c header pins two zones, manifest runs one: fails pre-flight', !r.ok && r.results.length === 0 && has(q, 'fidelity', 'multi', 'Santiago'));
    q = quiet();
    r = await runAll(tmp, [row('bad.test.mjs', 'none'), row('multi.test.mjs', 'none', 'UTC'), row('multi.test.mjs', 'none', 'America/Santiago'), row('multi.test.mjs', 'none', 'America/Santiago')], { log: q.log });
    check('3d a duplicate row fails pre-flight', !r.ok && r.results.length === 0 && has(q, 'duplicate', 'multi'));
    await rm(path.join(testsDir, 'multi.test.mjs'));
    await write('noheader.test.mjs', '// purpose: nothing\nprocess.exit(0);\n');
    q = quiet();
    r = await runAll(tmp, [row('bad.test.mjs', 'none'), row('noheader.test.mjs', 'none')], { log: q.log });
    check('3e no usage block fails pre-flight and says so', !r.ok && r.results.length === 0 && has(q, 'fidelity', 'noheader', 'no parsable command'));
    await rm(path.join(testsDir, 'noheader.test.mjs'));
    await write('wrapped.test.mjs',
      '// usage:\n//   cd client && TZ=UTC node --import ./tests/register-hooks.mjs \\\n//     tests/wrapped.test.mjs\n//\n// more: node tests/wrapped.test.mjs (not part of the usage block)\nprocess.exit(0);\n');
    const wrapped = await preflight(tmp, [row('bad.test.mjs', 'none'), row('wrapped.test.mjs', 'hooks', 'UTC')]);
    check('3f a backslash-wrapped usage line parses; text after the block is ignored', wrapped.length === 0, wrapped.join('; '));
    await rm(path.join(testsDir, 'wrapped.test.mjs'));

    // 4. TZ and the hook reach the child.
    await write('tz.test.mjs', header('tz.test.mjs', { zones: ['Australia/Lord_Howe'] }) + 'console.log("TZ=" + process.env.TZ);\n');
    const res = await runRow(row('tz.test.mjs', 'none', 'Australia/Lord_Howe'), { root: tmp, timeoutMs: 10_000 });
    check('4a TZ from the row reaches the child', res.status === 'PASS' && res.output.includes('TZ=Australia/Lord_Howe'), res.output);
    await mkdir(path.join(testsDir), { recursive: true });
    await writeFile(path.join(testsDir, 'register-hooks.mjs'), 'globalThis.__hooked = true;\n');
    await write('hook.test.mjs', header('hook.test.mjs', { hook: HOOKED }) + 'process.exit(globalThis.__hooked ? 0 : 1);\n');
    const hk = await runRow(row('hook.test.mjs', 'hooks'), { root: tmp, timeoutMs: 10_000 });
    check('4b the --import hook from the row reaches the child', hk.status === 'PASS', hk.output);
    await rm(path.join(testsDir, 'register-hooks.mjs'));

    // 5. Output integrity: >64 KB then a final stderr line then exit(1).
    await write('big.test.mjs', header('big.test.mjs') +
      'for (let i = 0; i < 2000; i++) process.stdout.write("x".repeat(63) + "\\n");\nconsole.error("LAST LINE");\nprocess.exit(1);\n');
    const big = await runRow(row('big.test.mjs', 'none'), { root: tmp, timeoutMs: 10_000 });
    check('5 captured output is complete (>64 KB, ends with the final line)',
      big.status === 'FAIL' && big.output.length > 64 * 1024 && big.output.trimEnd().endsWith('LAST LINE'),
      `status=${big.status} len=${big.output.length}`);

    // 6. Non-hang, three ways.
    await write('hang.test.mjs', header('hang.test.mjs') + 'setInterval(() => {}, 1000);\n');
    let t0 = Date.now();
    const hang = await runRow(row('hang.test.mjs', 'none'), { root: tmp, timeoutMs: 2_000 });
    check('6a hung child is killed and reported TIMEOUT within 5 s', hang.status === 'TIMEOUT' && Date.now() - t0 < 5_000);
    await write('grandchild.test.mjs', header('grandchild.test.mjs') +
      'import { spawn } from "node:child_process";\n' +
      'spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "inherit", "inherit"], detached: true }).unref();\n' +
      'console.log("parent done"); process.exit(0);\n');
    t0 = Date.now();
    const gc = await runRow(row('grandchild.test.mjs', 'none'), { root: tmp, timeoutMs: 10_000, drainGraceMs: 500 });
    check('6b a child that leaves a descendant on the pipes still settles (exit + drain grace)',
      gc.status === 'PASS' && Date.now() - t0 < 5_000 && gc.output.includes('parent done') && gc.output.includes('still open'),
      `status=${gc.status} ms=${Date.now() - t0}`);
    await write('slowdrain.test.mjs', header('slowdrain.test.mjs') + 'process.stdout.write("x".repeat(200000)); process.exit(0);\n');
    const sd = await runRow(row('slowdrain.test.mjs', 'none'), { root: tmp, timeoutMs: 3_000 });
    check('6c a clean exit(0) is never labelled TIMEOUT by a pending drain', sd.status === 'PASS' && sd.code === 0);

    // 7. Signal death is a FAIL with the signal reported.
    await write('sig.test.mjs', header('sig.test.mjs') + 'process.kill(process.pid, "SIGTERM"); setInterval(() => {}, 1000);\n');
    const sig = await runRow(row('sig.test.mjs', 'none'), { root: tmp, timeoutMs: 5_000 });
    check('7 signal death is FAIL with code null and the signal named', sig.status === 'FAIL' && sig.code === null && sig.signal === 'SIGTERM');

    // 8. Selection semantics on a clean tree with one covered file.
    await clear();
    await write('ok.test.mjs', header('ok.test.mjs') + 'process.exit(0);\n');
    q = quiet();
    r = await runAll(tmp, [row('ok.test.mjs', 'none')], { only: 'nonexistent', log: q.log });
    check('8a --only matching nothing fails', !r.ok && r.problems.includes('empty selection'));
    q = quiet();
    r = await runAll(tmp, [row('ok.test.mjs', 'none', NY, true)], { fast: true, log: q.log });
    check('8b --fast skips slow rows and reports them skipped', !r.ok && r.skipped === 1 && r.results.length === 0);
    q = quiet();
    r = await runAll(tmp, [row('ok.test.mjs', 'none', NY, true)], { log: q.log });
    check('8c the same slow row runs without --fast', r.ok && r.results.length === 1 && has(q, '1 runs: 1 passed'));

    // 9. Serial and parallel agree on a mixed tree.
    await write('bad.test.mjs', header('bad.test.mjs') + 'process.exit(1);\n');
    await write('ok2.test.mjs', header('ok2.test.mjs') + 'process.exit(0);\n');
    const mixed = [row('ok.test.mjs', 'none'), row('bad.test.mjs', 'none'), row('ok2.test.mjs', 'none')];
    const key = (res) => res.results.map((x) => `${x.row.file}:${x.status}`).sort().join(',');
    const par = await runAll(tmp, mixed, { log: () => {} });
    const ser = await runAll(tmp, mixed, { serial: true, log: () => {} });
    check('9 serial and parallel runs agree', key(par) === key(ser) && !par.ok && par.results.length === 3, `${key(par)} vs ${key(ser)}`);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  console.log(`\nself-test: ${passed} passed, ${failed} failed`);
  return failed === 0;
}

// --- CLI ---------------------------------------------------------------------

function usage() {
  console.log('usage: node tests/run-all.mjs [--fast] [--only <substring>] [--serial] [--self-test]');
}

async function main(argv) {
  const opts = { fast: false, only: null, serial: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--fast') opts.fast = true;
    else if (a === '--serial') opts.serial = true;
    else if (a === '--only') {
      opts.only = argv[++i];
      if (!opts.only || opts.only.startsWith('--')) { console.error('--only needs a substring'); usage(); return 2; }
    }
    else if (a === '--self-test') return (await selfTest()) ? 0 : 1;
    else if (a === '--help' || a === '-h') { usage(); return 0; }
    else { console.error(`unknown argument: ${a}`); usage(); return 2; }
  }
  const { ok } = await runAll(CLIENT_DIR, MANIFEST, opts);
  return ok ? 0 : 1;
}

// realpath on both sides so a symlinked script path still runs main.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
