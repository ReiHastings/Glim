// title: release_preflight.test.mjs
// project: Glim
// author: Reina Hastings
// contact: reinahastings13@gmail.com
// created: 2026-09-21
//
// purpose:
//   Self-test for scripts/release-preflight.sh, the gate in front of a
//   TestFlight upload (spec: docs/plan_stage2_release.md 4.4 and 7). Builds a
//   throwaway git repository shaped like Glim (project.pbxproj version lines,
//   CHANGELOG.md, env file, Google plist, a fake synced bundle, a bare origin),
//   a stub `gh` first on PATH and a stub scripts/deploy-rules.sh inside the
//   fixture (the script calls that one by path, so PATH would not reach it),
//   then runs the script under RELEASE_PREFLIGHT_ROOT + RELEASE_PREFLIGHT_FAKE
//   (which skips only the sync step) and asserts each check passes on the
//   clean fixture and fails, with its own message, on each planted defect.
//   Archive mode (-a) is exercised against a fabricated .xcarchive layout.
//
//   Darwin only: the script reads plists with /usr/libexec/PlistBuddy. On the
//   Linux CI runner the manifest row is reported SKIP by run-all.mjs. This
//   file therefore runs under `npm test` on the Mac, which is also what
//   scripts/deploy-rules.sh runs before a deploy; the stub deploy-rules.sh in
//   the fixture is what keeps that from recursing.
//
// usage:
//   cd client && node tests/release_preflight.test.mjs
//   platform: darwin

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync, appendFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import os from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, '../../scripts/release-preflight.sh');
const PB = '/usr/libexec/PlistBuddy';

if (process.platform !== 'darwin' || !existsSync(PB)) {
  console.error('this test needs macOS (PlistBuddy); the manifest row is platform: darwin');
  process.exit(1);
}

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.error(`  FAIL ${name}${detail ? `\n       ${detail.replace(/\n/g, '\n       ')}` : ''}`); }
}

// --- Fixture -----------------------------------------------------------------

const tmp = mkdtempSync(join(os.tmpdir(), 'glim-preflight-'));
const F = join(tmp, 'repo');
const ORIGIN = join(tmp, 'origin.git');
const BIN = join(tmp, 'bin');
const PBX = join(F, 'client/ios/App/App.xcodeproj/project.pbxproj');
const BUNDLE = join(F, 'client/ios/App/App/public');
const GPLIST = join(F, 'client/ios/App/App/GoogleService-Info.plist');
const CHANGELOG = join(F, 'CHANGELOG.md');
const RECORD = join(F, 'client/.release-preflight.json');

const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', ...opts });
const git = (...args) => { const r = sh('git', args, { cwd: F }); if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
const pbx = (version, build) => `\t\t\t\tCURRENT_PROJECT_VERSION = ${build};\n\t\t\t\tMARKETING_VERSION = ${version};\n\t\t\t\tCURRENT_PROJECT_VERSION = ${build};\n\t\t\t\tMARKETING_VERSION = ${version};\n`;
const CLEAN_CHANGELOG = '# Changelog\n\n## [Unreleased]\n\n- build script fixes\n\n## [1.0.0] - 2026-09-22\n\n- build 1: first TestFlight build\n';
const CLEAN_BUNDLE = '<html>glim-da8c2 glim-device-id</html>';
const plistAdd = (file, entries) => sh(PB, entries.flatMap(([k, t, v]) => ['-c', `Add :${k} ${t} ${v}`]).concat([file]));

function buildFixture() {
  mkdirSync(dirname(PBX), { recursive: true });
  mkdirSync(BUNDLE, { recursive: true });
  mkdirSync(join(F, 'scripts'));
  mkdirSync(BIN);
  writeFileSync(PBX, pbx('1.0.0', 1));
  writeFileSync(CHANGELOG, CLEAN_CHANGELOG);
  writeFileSync(join(F, 'client/.env.local'), 'VITE_FIREBASE_PROJECT_ID=glim-da8c2\n');
  plistAdd(GPLIST, [['PROJECT_ID', 'string', 'glim-da8c2'], ['BUNDLE_ID', 'string', 'com.reihastings.glim']]);
  writeFileSync(join(BUNDLE, 'index.html'), CLEAN_BUNDLE);
  writeFileSync(join(F, 'RULES_DEPLOYS.md'), '| log |\n');
  // Stub: prints whatever file FX_RULES_STATUS names (canned -s output).
  writeFileSync(join(F, 'scripts/deploy-rules.sh'), '#!/usr/bin/env bash\ncat "${FX_RULES_STATUS:-/dev/null}"\n', { mode: 0o755 });
  writeFileSync(join(F, '.gitignore'), 'client/.env.local\nclient/ios/App/App/public\nclient/ios/App/App/GoogleService-Info.plist\nclient/.release-preflight.json\n');
  // Stub gh: `gh auth status` succeeds; `gh run list` prints FX_GH_JSON.
  writeFileSync(join(BIN, 'gh'), '#!/usr/bin/env bash\nif [[ "$1" == auth ]]; then exit 0; fi\ncat "${FX_GH_JSON:-/dev/null}"\n', { mode: 0o755 });
  sh('git', ['init', '-q', '-b', 'main'], { cwd: F });
  git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'test');
  git('add', '-A'); git('commit', '-qm', 'one');
  sh('git', ['init', '-q', '--bare', ORIGIN]);
  git('remote', 'add', 'origin', ORIGIN); git('push', '-q', '-u', 'origin', 'main');
}

const canned = {};
function cannedFile(name, content) { const p = join(tmp, name); writeFileSync(p, content); canned[name] = p; return p; }
cannedFile('rules-ok.txt', 'dev: last deployed X, MATCHES the committed file\nprod: last deployed X, MATCHES the committed file\n');
cannedFile('rules-differ.txt', 'dev: last deployed X, MATCHES the committed file\nprod: last deployed X, DIFFERS from the committed file (deployed blob abc)\n');
cannedFile('rules-nolog.txt', 'dev: no deploy logged\nprod: last deployed X, MATCHES the committed file\n');
const ghJson = (rows) => JSON.stringify(rows);
cannedFile('gh-ok.json', ghJson([{ workflowName: 'CI', status: 'completed', conclusion: 'success' }]));
cannedFile('gh-none.json', '[]');
cannedFile('gh-running.json', ghJson([{ workflowName: 'CI', status: 'in_progress', conclusion: null }]));
cannedFile('gh-cancelled.json', ghJson([{ workflowName: 'CI', status: 'completed', conclusion: 'cancelled' }]));
cannedFile('gh-failure.json', ghJson([{ workflowName: 'CI', status: 'completed', conclusion: 'failure' }]));
cannedFile('gh-other.json', ghJson([{ workflowName: 'Other', status: 'completed', conclusion: 'success' }]));
// Two runs for one sha. The array order is deliberately OLDEST first, so the
// script must be sorting by createdAt rather than trusting position.
cannedFile('gh-two-ok.json', ghJson([{ workflowName: 'CI', status: 'completed', conclusion: 'cancelled', createdAt: '2026-09-22T10:00:00Z' }, { workflowName: 'CI', status: 'completed', conclusion: 'success', createdAt: '2026-09-22T10:05:00Z' }]));
cannedFile('gh-two-bad.json', ghJson([{ workflowName: 'CI', status: 'completed', conclusion: 'success', createdAt: '2026-09-22T10:00:00Z' }, { workflowName: 'CI', status: 'completed', conclusion: 'failure', createdAt: '2026-09-22T10:05:00Z' }]));

// Run the script. Returns { status, out } with stdout and stderr joined.
function run(args, { gh = 'gh-ok.json', rules = 'rules-ok.txt', env = {}, path = true, root = F, fake = '1' } = {}) {
  const e = { ...process.env, FX_GH_JSON: canned[gh], FX_RULES_STATUS: canned[rules], ...env };
  // path: true puts the stub gh first; false gives a minimal PATH with no gh at
  // all (node, then the system dirs; the real gh lives under Homebrew).
  e.PATH = path ? `${BIN}:${process.env.PATH}` : `${dirname(process.execPath)}:/usr/bin:/bin`;
  if (root !== null) e.RELEASE_PREFLIGHT_ROOT = root; else delete e.RELEASE_PREFLIGHT_ROOT;
  if (fake !== null) e.RELEASE_PREFLIGHT_FAKE = fake; else delete e.RELEASE_PREFLIGHT_FAKE;
  const r = sh('bash', [SCRIPT, ...args], { env: e, cwd: F });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}
const failsOn = (r, n, ...words) => r.status !== 0 && r.out.split('\n').some((l) => l.startsWith(`FAIL ${String(n).padStart(2)} `) && words.every((w) => l.includes(w)));
const okOn = (r, n) => r.out.split('\n').some((l) => l.startsWith(`ok   ${String(n).padStart(2)} `));
const clean = () => git('status', '--porcelain') === '';

try {
  buildFixture();

  // --- -v: clean fixture, idempotence, seams ---------------------------------
  let r = run(['-v', '1.0.0']);
  check('v01 clean fixture passes every check and PASS', r.status === 0 && /\nPASS\n/.test(r.out) && [1, 2, 3, 4, 5, 6, 7, 8, 9].every((n) => okOn(r, n)), r.out);
  check('v02 a passing run writes the record (schema 1, version, build, digest)', existsSync(RECORD) && (() => { const j = JSON.parse(readFileSync(RECORD, 'utf8')); return j.schema === 1 && j.version === '1.0.0' && j.build === '1' && /^[0-9a-f]{64}$/.test(j.digest); })());
  const first = r.out;
  r = run(['-v', '1.0.0']);
  check('v03 two consecutive runs give identical output and leave the tree clean', r.out.replace(/HEAD: [0-9a-f]+/, '') === first.replace(/HEAD: [0-9a-f]+/, '') && clean(), r.out);
  r = run(['-v', '1.0.0', '-n']);
  check('v04 -n on a clean run: exit 0, same check lines', r.status === 0 && [1, 2, 3, 4, 5, 6, 7, 8, 9].every((n) => okOn(r, n)));
  r = run(['-v', '1.0.0'], { root: F, fake: null });
  check('v05 RELEASE_PREFLIGHT_ROOT without RELEASE_PREFLIGHT_FAKE dies before any check', r.status !== 0 && /without RELEASE_PREFLIGHT_FAKE/.test(r.out) && !/^ok/m.test(r.out), r.out);
  r = run(['-v', '1.0.0'], { root: BIN });
  check('v06 RELEASE_PREFLIGHT_ROOT that is not a git work tree dies before any check', r.status !== 0 && /not a git work tree/.test(r.out) && !/^ok/m.test(r.out), r.out);
  r = run(['-v', '1.0.0'], { root: null, fake: '1' });
  check('v06b RELEASE_PREFLIGHT_FAKE without RELEASE_PREFLIGHT_ROOT dies before any check (the seam is two-way)', r.status !== 0 && /without RELEASE_PREFLIGHT_ROOT/.test(r.out) && !/^ok/m.test(r.out), r.out);
  r = run(['-v', '1.0']);
  check('v07 -v that is not X.Y.Z is refused', r.status !== 0 && /not X\.Y\.Z/.test(r.out));
  const fromClient = sh('bash', [SCRIPT, '-v', '1.0.0'], { encoding: 'utf8', cwd: join(F, 'client'), env: { ...process.env, PATH: `${BIN}:${process.env.PATH}`, FX_GH_JSON: canned['gh-ok.json'], FX_RULES_STATUS: canned['rules-ok.txt'], RELEASE_PREFLIGHT_ROOT: F, RELEASE_PREFLIGHT_FAKE: '1' } });
  check('v08 run from client/ behaves the same (repo-root cd)', fromClient.status === 0 && /\nPASS\n/.test(fromClient.stdout), fromClient.stdout + fromClient.stderr);

  // --- check 1: branch, tree, sync -------------------------------------------
  appendFileSync(CHANGELOG, 'x\n');
  r = run(['-v', '1.0.0', '-n']);
  check('c1a dirty tree fails check 1 and -n still exits 0', r.status === 0 && /^FAIL  1  tree/m.test(r.out), r.out);
  git('checkout', '-q', 'CHANGELOG.md');
  git('switch', '-qc', 'feature');
  r = run(['-v', '1.0.0']);
  check('c1b not on main fails check 1', failsOn(r, 1, 'branch'), r.out);
  git('switch', '-q', 'main');
  writeFileSync(join(F, 'extra.txt'), 'x\n'); git('add', 'extra.txt'); git('commit', '-qm', 'local only');
  r = run(['-v', '1.0.0']);
  check('c1c HEAD ahead of origin/main fails check 1', failsOn(r, 1, 'origin/main'), r.out);
  git('reset', '-q', '--hard', 'origin/main');

  // --- check 2: CI verdicts --------------------------------------------------
  for (const [file, word] of [['gh-none.json', 'no CI run'], ['gh-running.json', 'still running'], ['gh-cancelled.json', 'cancelled'], ['gh-failure.json', "'failure'"], ['gh-other.json', 'no CI run'], ['gh-two-bad.json', "'failure'"]]) {
    r = run(['-v', '1.0.0'], { gh: file });
    check(`c2 ${file} fails check 2 with "${word}"`, failsOn(r, 2, word), r.out);
  }
  r = run(['-v', '1.0.0'], { gh: 'gh-two-ok.json' });
  check('c2 two rows, newest (by createdAt, listed second) success: passes check 2', r.status === 0 && okOn(r, 2), r.out);
  r = run(['-v', '1.0.0'], { path: false });
  check('c2 gh absent fails check 2 (never skips)', failsOn(r, 2, 'not found'), r.out);
  writeFileSync(join(BIN, 'gh'), '#!/usr/bin/env bash\nexit 1\n', { mode: 0o755 });
  r = run(['-v', '1.0.0']);
  check('c2 gh not logged in fails check 2', failsOn(r, 2, 'not logged in'), r.out);
  writeFileSync(join(BIN, 'gh'), '#!/usr/bin/env bash\nif [[ "$1" == auth ]]; then exit 0; fi\ncat "${FX_GH_JSON:-/dev/null}"\n', { mode: 0o755 });

  // --- check 3: rules --------------------------------------------------------
  r = run(['-v', '1.0.0'], { rules: 'rules-differ.txt' });
  check('c3a one alias DIFFERS fails check 3 with the tightening rule', failsOn(r, 3, 'DIFFERS', 'tightening'), r.out);
  r = run(['-v', '1.0.0'], { rules: 'rules-nolog.txt' });
  check('c3b one alias with no deploy logged fails check 3', failsOn(r, 3, 'no deploy logged'), r.out);
  rmSync(join(F, 'RULES_DEPLOYS.md'));
  r = run(['-v', '1.0.0']);
  check('c3c RULES_DEPLOYS.md absent fails check 3 with the preflight message', failsOn(r, 3, 'RULES_DEPLOYS.md not found'), r.out);
  git('checkout', '-q', 'RULES_DEPLOYS.md');

  // --- checks 4 and 5: version, changelog, build number ----------------------
  r = run(['-v', '1.0.1']);
  check('c4a MARKETING_VERSION not equal to -v fails check 4', failsOn(r, 4, 'MARKETING_VERSION'), r.out);
  const commitPbx = (content) => { writeFileSync(PBX, content); git('commit', '-qam', 'pbx'); git('push', '-q'); };
  const restore = () => { git('reset', '-q', '--hard', 'origin/main~1'); git('push', '-qf'); };
  commitPbx(pbx('1.0.0', 1).replace(/\t\t\t\tMARKETING_VERSION = 1.0.0;\n$/, ''));
  r = run(['-v', '1.0.0']);
  check('c4b only one MARKETING_VERSION line fails check 4', failsOn(r, 4, 'exactly 2'), r.out); restore();
  commitPbx('\t\t\t\tSOMETHING_ELSE = 1;\n');
  r = run(['-v', '1.0.0', '-n']);
  check('c4g zero version lines in project.pbxproj: check 4 FAILs, later checks still print, -n exits 0', r.status === 0 && /^FAIL  4 /m.test(r.out) && okOn(r, 7) && okOn(r, 9), r.out); restore();
  const commitChangelog = (content) => { writeFileSync(CHANGELOG, content); git('commit', '-qam', 'cl'); git('push', '-q'); };
  commitChangelog(CLEAN_CHANGELOG.replace('## [1.0.0]', '## [0.9.0]'));
  r = run(['-v', '1.0.0']);
  check('c4c newest versioned section is another version fails check 4', failsOn(r, 4, '[0.9.0]'), r.out); restore();
  commitChangelog('# Changelog\n\n## [1.0.0] - 2026-09-22\n\nnothing yet\n\n## [0.9.0] - 2026-01-01\n\n- build 1: old\n');
  r = run(['-v', '1.0.0']);
  check('c4d first build line under an older section fails check 4', failsOn(r, 4, 'not under [1.0.0]'), r.out); restore();
  commitChangelog(CLEAN_CHANGELOG.replace('- build 1:', '- build 2:'));
  r = run(['-v', '1.0.0']);
  check('c4e changelog build differs from CURRENT_PROJECT_VERSION fails check 4', failsOn(r, 4, 'says build 2'), r.out); restore();
  commitChangelog(CLEAN_CHANGELOG.replace('- build 1:', ''));
  r = run(['-v', '1.0.0']);
  check('c4f no build line at all fails check 4', failsOn(r, 4, "no '- build N:'"), r.out); restore();
  commitChangelog(CLEAN_CHANGELOG + '\n## [0.9.0] - 2026-01-01\n\n- build 3: old\n');
  r = run(['-v', '1.0.0']);
  check('c5a build not the maximum fails check 5', failsOn(r, 5, 'max 3'), r.out); restore();
  commitChangelog(CLEAN_CHANGELOG + '\n## [0.9.0] - 2026-01-01\n\n- build 1: reused\n');
  r = run(['-v', '1.0.0']);
  check('c5c a build number that already appears in an older section fails check 5', failsOn(r, 5, 'appears 2 times'), r.out); restore();
  commitChangelog(CLEAN_CHANGELOG.replace('- build script fixes', '- build script fixes\n- builder notes'));
  r = run(['-v', '1.0.0']);
  check('c5b [Unreleased] bullets that start with "build" but are not "- build N:" are ignored', r.status === 0 && okOn(r, 4) && okOn(r, 5), r.out); restore();

  // --- check 6: tags ---------------------------------------------------------
  git('tag', '-a', 'v1.0.0-b1', '-m', 'b1');
  r = run(['-v', '1.0.0']);
  check('c6a tag on HEAD but not on origin fails check 6', failsOn(r, 6, 'not on origin'), r.out);
  git('push', '-q', 'origin', 'v1.0.0-b1');
  r = run(['-v', '1.0.0']);
  check('c6b tag on HEAD, locally and on origin: passes', r.status === 0 && okOn(r, 6), r.out);
  writeFileSync(join(F, 'extra.txt'), 'y\n'); git('add', 'extra.txt'); git('commit', '-qm', 'moved on'); git('push', '-q');
  r = run(['-v', '1.0.0']);
  check('c6c tag behind HEAD fails check 6 (a pushed tag is never moved)', failsOn(r, 6, 'never moved'), r.out);
  git('reset', '-q', '--hard', 'HEAD~1'); git('push', '-qf');
  git('tag', '-d', 'v1.0.0-b1'); git('tag', 'v1.0.0-b1', 'HEAD'); // local lightweight at HEAD; origin still has the annotated one at HEAD too
  git('push', '-q', '--delete', 'origin', 'v1.0.0-b1'); git('push', '-q', 'origin', 'v1.0.0-b1');
  git('tag', '-d', 'v1.0.0-b1'); writeFileSync(join(F, 'extra.txt'), 'z\n'); git('add', 'extra.txt'); git('commit', '-qm', 'other'); git('tag', 'v1.0.0-b1'); git('reset', '-q', '--hard', 'origin/main');
  r = run(['-v', '1.0.0']);
  check('c6d tag at different commits locally and on origin fails check 6', failsOn(r, 6), r.out);
  git('tag', '-d', 'v1.0.0-b1'); git('push', '-q', '--delete', 'origin', 'v1.0.0-b1');
  git('tag', 'v1.0.0-b11');
  r = run(['-v', '1.0.0']);
  check('c6e v1.0.0-b11 does not count as spending build 1 (anchored)', r.status === 0 && okOn(r, 6), r.out);
  git('tag', '-d', 'v1.0.0-b11');
  git('tag', 'v0.9.0-b1');
  r = run(['-v', '1.0.0']);
  check('c6f another version\'s tag with the same build number fails check 6', failsOn(r, 6, 'already used'), r.out);
  git('tag', '-d', 'v0.9.0-b1');

  // --- check 7: credentials --------------------------------------------------
  writeFileSync(join(F, 'client/.env.local'), 'VITE_FIREBASE_PROJECT_ID=glim-dev\n');
  r = run(['-v', '1.0.0']);
  check('c7a .env.local naming glim-dev fails check 7', failsOn(r, 7, "'glim-dev'"), r.out);
  writeFileSync(join(F, 'client/.env.local'), 'VITE_FIREBASE_PROJECT_ID=glim-da8c2\nVITE_FIREBASE_PROJECT_ID=glim-dev\n');
  r = run(['-v', '1.0.0']);
  check('c7d a duplicated VITE_FIREBASE_PROJECT_ID fails check 7 (Vite would take the last one)', failsOn(r, 7, '2 times'), r.out);
  writeFileSync(join(F, 'client/.env.local'), 'VITE_FIREBASE_PROJECT_ID=glim-da8c2\n');
  writeFileSync(join(F, 'client/.env.native.local'), 'x\n');
  r = run(['-v', '1.0.0']);
  check('c7b a stray .env.native.local fails check 7', failsOn(r, 7, '.env.native.local'), r.out);
  rmSync(join(F, 'client/.env.native.local'));
  sh(PB, ['-c', 'Set :PROJECT_ID glim-dev', GPLIST]);
  r = run(['-v', '1.0.0']);
  check('c7c GoogleService-Info.plist naming glim-dev fails check 7 and names ios-dev.sh', failsOn(r, 7, 'glim-dev', 'ios-dev.sh'), r.out);
  sh(PB, ['-c', 'Set :PROJECT_ID glim-da8c2', GPLIST]);

  // --- check 8: sync branches, through the seam's command hook ---------------
  r = run(['-v', '1.0.0'], { env: { RELEASE_PREFLIGHT_SYNC_CMD: 'true' } });
  check('c8a a sync that changes nothing passes check 8', r.status === 0 && okOn(r, 8), r.out);
  r = run(['-v', '1.0.0'], { env: { RELEASE_PREFLIGHT_SYNC_CMD: 'echo x >> CHANGELOG.md' } });
  check('c8b a sync that modifies a tracked file fails check 8 naming only that file', failsOn(r, 8, 'modified tracked files') && / M CHANGELOG\.md/.test(r.out) && !/RULES_DEPLOYS/.test(r.out.split('FAIL  8')[1] ?? ''), r.out);
  git('checkout', '-q', 'CHANGELOG.md');
  appendFileSync(join(F, 'RULES_DEPLOYS.md'), 'already dirty\n');
  r = run(['-v', '1.0.0', '-n'], { env: { RELEASE_PREFLIGHT_SYNC_CMD: 'echo x >> CHANGELOG.md' } });
  check('c8c on an already-dirty tree, check 8 names only what the sync changed', /^FAIL  8 /m.test(r.out) && / M CHANGELOG\.md/.test(r.out.split('FAIL  8')[1]) && !/RULES_DEPLOYS/.test(r.out.split('FAIL  8')[1]), r.out);
  git('checkout', '-q', 'CHANGELOG.md', 'RULES_DEPLOYS.md');
  r = run(['-v', '1.0.0'], { env: { RELEASE_PREFLIGHT_SYNC_CMD: 'false' } });
  check('c8d a failing sync fails check 8 with the by-hand hint', failsOn(r, 8, 'run it by hand'), r.out);

  // --- check 9: bundle -------------------------------------------------------
  writeFileSync(join(BUNDLE, 'index.html'), '<html>glim-da8c2</html><script>glim-dev</script>');
  r = run(['-v', '1.0.0']);
  check('c9a bundle naming glim-dev fails check 9', failsOn(r, 9, 'dev project'), r.out);
  writeFileSync(join(BUNDLE, 'index.html'), '<html>nothing here</html>');
  r = run(['-v', '1.0.0']);
  check('c9b bundle without the production id fails check 9', failsOn(r, 9, 'names glim-da8c2'), r.out);
  writeFileSync(join(BUNDLE, 'index.html'), '<html>glim-da8c2 glim-device-id</html>');
  r = run(['-v', '1.0.0']);
  check('c9c glim-device-id alone passes check 9 (the substring trap)', r.status === 0 && okOn(r, 9), r.out);
  rmSync(join(BUNDLE, 'index.html'));
  r = run(['-v', '1.0.0']);
  check('c9d missing index.html fails check 9', failsOn(r, 9, 'missing'), r.out);
  writeFileSync(join(BUNDLE, 'index.html'), CLEAN_BUNDLE);

  // --- -a: archive mode ------------------------------------------------------
  r = run(['-v', '1.0.0']);
  check('a00 record refreshed on a clean pass', r.status === 0);
  const ARCHIVE = join(tmp, 'App.xcarchive');
  const APP = join(ARCHIVE, 'Products/Applications/App.app');
  const buildArchive = ({ version = '1.0.0', build = '1', enc = ['bool', 'false'], bundle = true, manifest = true, plist = 'glim-da8c2' } = {}) => {
    rmSync(ARCHIVE, { recursive: true, force: true });
    mkdirSync(APP, { recursive: true });
    if (bundle) cpSync(BUNDLE, join(APP, 'public'), { recursive: true });
    plistAdd(join(APP, 'GoogleService-Info.plist'), [['PROJECT_ID', 'string', plist]]);
    if (manifest) writeFileSync(join(APP, 'PrivacyInfo.xcprivacy'), '');
    plistAdd(join(APP, 'Info.plist'), [['CFBundleShortVersionString', 'string', version], ['CFBundleVersion', 'string', build], ['CFBundleIdentifier', 'string', 'com.reihastings.glim'], ...(enc ? [['ITSAppUsesNonExemptEncryption', enc[0], enc[1]]] : [])]);
  };
  const aFails = (res, code, ...words) => res.status !== 0 && res.out.split('\n').some((l) => l.startsWith(`FAIL ${code} `) && words.every((w) => l.includes(w)));
  buildArchive();
  r = run(['-a', ARCHIVE]);
  check('a01 matching archive passes every A check', r.status === 0 && /^PASS/m.test(r.out) && ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7'].every((c) => r.out.includes(`ok   ${c} `)), r.out);
  appendFileSync(join(APP, 'public/index.html'), ' ');
  r = run(['-a', ARCHIVE]);
  check('a02 one byte changed in the archive bundle fails A5', aFails(r, 'A5', 'differs'), r.out);
  buildArchive(); writeFileSync(join(APP, 'public/.DS_Store'), 'x');
  r = run(['-a', ARCHIVE]);
  check('a03 an extra .DS_Store in the archive only still passes A5', r.status === 0 && r.out.includes('ok   A5 '), r.out);
  buildArchive({ build: '2' });
  r = run(['-a', ARCHIVE]);
  check('a04 archive build differs from the record fails A2', aFails(r, 'A2', "build '2'"), r.out);
  buildArchive({ enc: ['string', 'NO'] });
  r = run(['-a', ARCHIVE]);
  check('a05 ITSAppUsesNonExemptEncryption as the string NO fails A4', aFails(r, 'A4', "'NO'"), r.out);
  buildArchive({ enc: null });
  r = run(['-a', ARCHIVE]);
  check('a06 ITSAppUsesNonExemptEncryption absent fails A4', aFails(r, 'A4', 'absent'), r.out);
  buildArchive({ plist: 'glim-dev' });
  r = run(['-a', ARCHIVE]);
  check('a07 archive GoogleService-Info.plist naming glim-dev fails A6', aFails(r, 'A6', "'glim-dev'"), r.out);
  buildArchive({ manifest: false });
  r = run(['-a', ARCHIVE]);
  check('a08 missing PrivacyInfo.xcprivacy fails A7', aFails(r, 'A7', 'PrivacyInfo'), r.out);
  buildArchive();
  writeFileSync(join(F, 'extra.txt'), 'w\n'); git('add', 'extra.txt'); git('commit', '-qm', 'moved');
  r = run(['-a', ARCHIVE]);
  check('a09 HEAD moved since the record fails A1', aFails(r, 'A1', 'HEAD moved'), r.out);
  git('reset', '-q', '--hard', 'origin/main');
  const rec = JSON.parse(readFileSync(RECORD, 'utf8')); writeFileSync(RECORD, JSON.stringify({ ...rec, schema: 2 }));
  r = run(['-a', ARCHIVE]);
  check('a10 a record with an unknown schema is refused', r.status !== 0 && /schema 2/.test(r.out), r.out);
  rmSync(RECORD);
  r = run(['-a', ARCHIVE]);
  check('a11 no record: refused with "run -v first"', r.status !== 0 && /run -v first/.test(r.out), r.out);
  r = run(['-a', join(tmp, 'nowhere.xcarchive')]);
  check('a12 a path that is not an archive is refused', r.status !== 0 && /is that an \.xcarchive/.test(r.out), r.out);
  r = run(['-a', ARCHIVE, '-v', '1.0.0']);
  check('a13 -a and -v together are refused', r.status !== 0 && /separate modes/.test(r.out), r.out);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\nrelease_preflight: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
