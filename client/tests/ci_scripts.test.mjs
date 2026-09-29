// title: ci_scripts.test.mjs
// project: Glim
// author: Reina Hastings
// contact: reinahastings13@gmail.com
// created: 2026-09-24
//
// purpose:
//   Harness for the two Xcode Cloud scripts, client/ios/App/ci_scripts/
//   ci_post_clone.sh and ci_post_xcodebuild.sh (spec: docs/plan_stage2b_xcode_cloud.md
//   4.2, 4.3, 7). Builds a fixture repository shaped like Glim and runs each
//   script under bash with the seam CI_SCRIPTS_ROOT + CI_SCRIPTS_FAKE, under
//   which npm ci and the sync are replaced by commands the harness supplies
//   and the Node download is pointed at a local file:// distribution holding
//   a fake tarball and SHASUMS256.txt. Every case runs with a PATH that has
//   NO node at all, because Xcode Cloud has none until the script installs
//   it: both scripts must parse the changelog and write What to Test without
//   Node, and the harness proves it. Everything else runs for real: mode
//   selection, the number assertions, the plist decode and its PlistBuddy
//   checks, the env writer, the stray-file rule, the clean-tree check, the
//   bundle check, the archive checks against a fabricated .xcarchive, and the
//   What to Test writer. The cloud is macOS and uses PlistBuddy and plutil, so
//   this row is darwin-only like release_preflight.
//
// usage:
//   cd client && node tests/ci_scripts.test.mjs
//   platform: darwin

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, statSync, createWriteStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import os from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const POST_CLONE = join(here, '../ios/App/ci_scripts/ci_post_clone.sh');
const POST_BUILD = join(here, '../ios/App/ci_scripts/ci_post_xcodebuild.sh');
const PB = '/usr/libexec/PlistBuddy';
if (process.platform !== 'darwin' || !existsSync(PB)) { console.error('needs macOS (PlistBuddy); the manifest row is platform: darwin'); process.exit(1); }

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.error(`  FAIL ${name}${detail ? `\n       ${detail.replace(/\n/g, '\n       ')}` : ''}`); }
}

// --- Fixture -----------------------------------------------------------------

const tmp = mkdtempSync(join(os.tmpdir(), 'glim-ci-'));
const F = join(tmp, 'repo');
const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', ...opts });
const git = (...args) => { const r = sh('git', args, { cwd: F }); if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
const gitDir = dirname(sh('which', ['git']).stdout.trim());
// A PATH with no node: system dirs plus wherever git lives. The scripts must not need Node.
const NO_NODE_PATH = [...new Set([gitDir, '/usr/bin', '/bin', '/usr/sbin', '/sbin'])].join(':');
const PBX = join(F, 'client/ios/App/App.xcodeproj/project.pbxproj');
const CHANGELOG = join(F, 'CHANGELOG.md');
const BUNDLE = join(F, 'client/ios/App/App/public');
const NODE_VERSION = /NODE_VERSION="([0-9.]+)"/.exec(readFileSync(POST_CLONE, 'utf8'))[1];
const pbx = (version, build) => `\t\t\t\tCURRENT_PROJECT_VERSION = ${build};\n\t\t\t\tMARKETING_VERSION = ${version};\n\t\t\t\tCURRENT_PROJECT_VERSION = ${build};\n\t\t\t\tMARKETING_VERSION = ${version};\n`;
const CLEAN_CHANGELOG = '# Changelog\n\n## [Unreleased]\n\n- build script fixes\n\n## [1.0.0] - 2026-09-22\n\nThe first release.\n\n### Added\n- A thing with a curly quote ’ and an accent é.\n\n- build 4: the first cloud build\n- build 3: old build\n';
const plistFile = (project, bundle) => { const p = join(tmp, `gs-${project}.plist`); rmSync(p, { force: true }); sh(PB, ['-c', `Add :PROJECT_ID string ${project}`, '-c', `Add :BUNDLE_ID string ${bundle}`, '-c', 'Add :API_KEY string AIzaSecretLookingKey123', p]); return p; };
const b64 = (file, wrap = false) => { const s = readFileSync(file).toString('base64'); return wrap ? s.replace(/(.{64})/g, '$1\n') : s; };
const PROD_B64 = b64(plistFile('glim-da8c2', 'com.reihastings.glim'));
const DEV_B64 = b64(plistFile('glim-dev', 'com.reihastings.glim.dev'));

function buildFixture() {
  mkdirSync(dirname(PBX), { recursive: true });
  mkdirSync(join(F, 'client/ios/App/App'), { recursive: true });
  mkdirSync(join(F, 'client/ios/App/CapApp-SPM'), { recursive: true });
  mkdirSync(join(F, 'client/ios/App/App.xcodeproj/project.xcworkspace/xcshareddata/swiftpm'), { recursive: true });
  writeFileSync(join(F, 'client/ios/App/App/Info.plist'), '<plist/>\n');
  writeFileSync(PBX, pbx('1.0.0', 4));
  writeFileSync(CHANGELOG, CLEAN_CHANGELOG);
  writeFileSync(join(F, 'client/.nvmrc'), `${NODE_VERSION.split('.')[0]}\n`);
  writeFileSync(join(F, 'client/ios/App/CapApp-SPM/Package.swift'), '// generated\nlet x = 1\n');
  writeFileSync(join(F, 'client/ios/App/App.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved'), '{ "pins" : [ { "identity" : "facebook-ios-sdk" }, { "identity" : "firebase-ios-sdk" } ] }\n');
  writeFileSync(join(F, '.gitignore'), 'client/.env.local\nclient/.env.*.local\nclient/ios/App/App/public\nclient/ios/App/App/GoogleService-Info.plist\n');
  sh('git', ['init', '-q', '-b', 'main'], { cwd: F });
  git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'test');
  git('add', '-A'); git('commit', '-qm', 'fixture');
}
// A local Node "distribution": a tarball whose bin/node is a shell stub reporting a version, plus SHASUMS256.txt.
function makeDist(version, { badSum = false } = {}) {
  const arch = os.arch() === 'arm64' ? 'arm64' : 'x64';
  const dir = join(tmp, `dist-${version}${badSum ? '-bad' : ''}`); rmSync(dir, { recursive: true, force: true });
  const name = `node-v${NODE_VERSION}-darwin-${arch}`;
  mkdirSync(join(dir, name, 'bin'), { recursive: true });
  writeFileSync(join(dir, name, 'bin/node'), `#!/bin/bash\necho v${version}\n`, { mode: 0o755 });
  writeFileSync(join(dir, name, 'bin/npm'), '#!/bin/bash\necho 10.0.0\n', { mode: 0o755 });
  sh('tar', ['-czf', `${name}.tar.gz`, name], { cwd: dir });
  const sum = badSum ? '0'.repeat(64) : sh('shasum', ['-a', '256', `${name}.tar.gz`], { cwd: dir }).stdout.split(' ')[0];
  writeFileSync(join(dir, 'SHASUMS256.txt'), `${sum}  ${name}.tar.gz\n${'1'.repeat(64)}  node-v${NODE_VERSION}-linux-x64.tar.gz\n`);
  return `file://${dir}`;
}
const DIST_OK = makeDist(NODE_VERSION);
const DIST_WRONG = makeDist('22.0.0');
const DIST_BADSUM = makeDist(NODE_VERSION, { badSum: true });
const ENV = { VITE_FIREBASE_API_KEY: 'AIzaKey', VITE_FIREBASE_AUTH_DOMAIN: 'glim-da8c2.firebaseapp.com', VITE_FIREBASE_PROJECT_ID: 'glim-da8c2', VITE_FIREBASE_STORAGE_BUCKET: 'glim-da8c2.appspot.com', VITE_FIREBASE_MESSAGING_SENDER_ID: '123', VITE_FIREBASE_APP_ID: '1:123:web:abc' };
const SYNC_OK = `mkdir -p ios/App/App/public && printf '<html>glim-da8c2 glim-device-id</html>' > ios/App/App/public/index.html`;
const SYNC_DEV = `mkdir -p ios/App/App/public && printf '<html>glim-da8c2 glim-dev glim-device-id</html>' > ios/App/App/public/index.html`;
const SYNC_DIRTY = `${SYNC_OK} && echo changed >> ios/App/CapApp-SPM/Package.swift`;

function runClone({ tag = 'v1.0.0-b4', build = '4', env = {}, plist = PROD_B64, sync = SYNC_OK, dist = null, cloud = false, seam = true, root = F, path = NO_NODE_PATH } = {}) {
  const e = { PATH: path, HOME: process.env.HOME, TMPDIR: tmp, CI_WORKSPACE_PATH: join(tmp, 'ws'), ...ENV };
  if (tag !== null) e.CI_TAG = tag;
  if (build !== null) e.CI_BUILD_NUMBER = build;
  e.CI_PRIMARY_REPOSITORY_PATH = root;
  if (seam) { e.CI_SCRIPTS_ROOT = root; e.CI_SCRIPTS_FAKE = '1'; }
  if (sync !== null) e.CI_SCRIPTS_SYNC_CMD = sync;
  if (dist !== null) e.CI_SCRIPTS_NODE_DIST = dist;
  if (plist !== null) e.GLIM_GOOGLE_SERVICE_PLIST_B64 = plist;
  if (cloud) e.CI_XCODE_CLOUD = 'TRUE';
  for (const [k, v] of Object.entries(env)) { if (v === null) delete e[k]; else e[k] = v; }
  const r = sh('bash', [POST_CLONE], { env: e, cwd: dirname(POST_CLONE) });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}
const clean = () => git('status', '--porcelain') === '';
const rd = (p) => (existsSync(p) ? readFileSync(p) : Buffer.alloc(0));
const reset = () => { git('checkout', '-q', '--', '.'); for (const p of ['client/.env.local', 'client/ios/App/App/GoogleService-Info.plist', 'client/.env.native']) rmSync(join(F, p), { force: true }); for (const d of [BUNDLE, join(F, 'client/ios/App/TestFlight'), join(tmp, 'ws')]) rmSync(d, { recursive: true, force: true }); };
const fourLines = (out) => /tag v[0-9.]+-b[0-9]+: version/.test(out) && /CI_BUILD_NUMBER:/.test(out) && /project\.pbxproj: MARKETING_VERSION/.test(out) && /CHANGELOG\.md: newest section/.test(out);

try {
  buildFixture();

  // --- post-clone: happy path and seam --------------------------------------
  let r = runClone();
  check('p01 release mode, no node on PATH, everything agreeing: passes, tree clean, plist and env written', r.status === 0 && /ok: tag, project file, changelog and CI_BUILD_NUMBER all say 1.0.0 build 4/.test(r.out) && clean() && existsSync(join(F, 'client/.env.local')) && existsSync(join(F, 'client/ios/App/App/GoogleService-Info.plist')), r.out);
  const env1 = rd(join(F, 'client/.env.local')).toString('utf8'); const plist1 = rd(join(F, 'client/ios/App/App/GoogleService-Info.plist'));
  check('p02 .env.local has exactly six lines in fixed order and the log shows only the project id', env1.split('\n').filter(Boolean).length === 6 && env1.startsWith('VITE_FIREBASE_API_KEY=') && r.out.includes('VITE_FIREBASE_PROJECT_ID=glim-da8c2') && !r.out.includes('AIzaKey') && !r.out.includes('AIzaSecretLookingKey123'), r.out);
  check('p03 the pin list is printed', /facebook-ios-sdk/.test(r.out) && /firebase-ios-sdk/.test(r.out));
  r = runClone();
  check('p04 second run: identical .env.local and plist bytes, tree still clean', r.status === 0 && rd(join(F, 'client/.env.local')).toString('utf8') === env1 && Buffer.compare(rd(join(F, 'client/ios/App/App/GoogleService-Info.plist')), plist1) === 0 && clean());
  reset();
  r = runClone({ env: { VITE_FIREBASE_API_KEY: 'k=v with space #hash' } });
  check('p05 an env value with =, space and # round-trips', r.status === 0 && rd(join(F, 'client/.env.local')).toString('utf8').includes('VITE_FIREBASE_API_KEY=k=v with space #hash\n'), r.out); reset();
  r = runClone({ cloud: true });
  check('p06 seam variables with CI_XCODE_CLOUD=TRUE are refused first, naming the variable', r.status !== 0 && /CI_SCRIPTS_ROOT is set on Xcode Cloud/.test(r.out) && !/=== Numbers/.test(r.out), r.out);
  r = runClone({ seam: false, env: { CI_SCRIPTS_FAKE: '1' } });
  check('p07 CI_SCRIPTS_FAKE without CI_SCRIPTS_ROOT is refused', r.status !== 0 && /without CI_SCRIPTS_ROOT/.test(r.out), r.out);
  r = runClone({ seam: false, env: { CI_SCRIPTS_ROOT: F } });
  check('p08 CI_SCRIPTS_ROOT without CI_SCRIPTS_FAKE is refused', r.status !== 0 && /without CI_SCRIPTS_FAKE/.test(r.out), r.out);

  // --- post-clone: modes ------------------------------------------------------
  r = runClone({ tag: null });
  check('p09 CI_TAG unset: one-line explanation, no unbound-variable trace', r.status !== 0 && /runs only from a tag/.test(r.out) && !/unbound variable/.test(r.out), r.out);
  r = runClone({ tag: 'release-1' });
  check('p10 a tag matching neither pattern is refused', r.status !== 0 && /neither vX\.Y\.Z-bN nor cloudtest-N/.test(r.out), r.out);
  r = runClone({ tag: 'cloudtest-1', build: '1' });
  check('p11 cloudtest-1 enters check mode, skips the numbers, runs the rest', r.status === 0 && /mode check/.test(r.out) && /Numbers: skipped/.test(r.out) && /ok: bundle names/.test(r.out), r.out); reset();
  for (const bad of ['v1.0.0', '1.0.0-b4', 'v1.0.0-b04', 'v1.0.0-b4x']) {
    r = runClone({ tag: bad });
    check(`p12 malformed tag ${bad} is refused`, r.status !== 0 && /neither vX\.Y\.Z-bN/.test(r.out), r.out);
  }

  // --- post-clone: number agreement (the same grammar as release-preflight.sh) --
  const numberCase = (name, { tag = 'v1.0.0-b4', build = '4', pbxText = null, changelog = null, word }) => {
    if (pbxText !== null) writeFileSync(PBX, pbxText); if (changelog !== null) writeFileSync(CHANGELOG, changelog);
    if (pbxText !== null || changelog !== null) git('commit', '-qam', name);
    const res = runClone({ tag, build });
    check(name, res.status !== 0 && res.out.includes(word) && fourLines(res.out), res.out);
    if (pbxText !== null || changelog !== null) git('reset', '-q', '--hard', 'HEAD~1');
    reset();
  };
  numberCase('n01 tag version differs from MARKETING_VERSION', { tag: 'v1.0.1-b4', word: 'MARKETING_VERSION must be 1.0.1' });
  numberCase('n02 tag build differs from CURRENT_PROJECT_VERSION', { tag: 'v1.0.0-b5', build: '5', word: 'CURRENT_PROJECT_VERSION must be 5' });
  numberCase('n03 CI_BUILD_NUMBER differs from the tag', { build: '5', word: 'build number is 5 but the tag says 4' });
  numberCase('n04 only one MARKETING_VERSION line', { pbxText: pbx('1.0.0', 4).replace(/\t\t\t\tMARKETING_VERSION = 1.0.0;\n$/, ''), word: 'exactly 2 configurations' });
  numberCase('n05 newest changelog section is another version', { changelog: CLEAN_CHANGELOG.replace('## [1.0.0]', '## [0.9.0]'), word: 'newest versioned section is [0.9.0]' });
  numberCase('n06 first build line under an older section', { changelog: '# C\n\n## [1.0.0] - x\n\nnothing\n\n## [0.9.0] - y\n\n- build 4: old\n', word: "first '- build N:' line" });
  numberCase('n07 changelog build differs from the tag', { changelog: CLEAN_CHANGELOG.replace('- build 4:', '- build 6:'), word: "line is '6'" });
  numberCase('n08 build number appears twice', { changelog: CLEAN_CHANGELOG + '\n## [0.9.0] - z\n\n- build 4: reused\n', word: 'appears 2 times' });
  numberCase('n09 build number not the maximum', { changelog: CLEAN_CHANGELOG + '\n## [0.9.0] - z\n\n- build 9: later\n', word: 'not greater than every other build line (max 9)' });
  numberCase('n10 no build line at all', { changelog: CLEAN_CHANGELOG.replace(/- build [0-9]+:.*\n/g, ''), word: "line is '-'" });
  numberCase('n11 build lines in ascending order (older first)', { changelog: CLEAN_CHANGELOG.replace('- build 4: the first cloud build\n- build 3: old build\n', '- build 3: old build\n- build 4: the first cloud build\n'), word: "line is '3'" });
  r = runClone({ build: null });
  check('n12 CI_BUILD_NUMBER unset in release mode is refused', r.status !== 0 && /CI_BUILD_NUMBER is not set/.test(r.out), r.out);
  // Grammar property: the fixtures preflight's own harness treats as PASS must pass here too.
  writeFileSync(CHANGELOG, CLEAN_CHANGELOG.replace('- build script fixes', '- build script fixes\n- builder notes')); git('commit', '-qam', 'unreleased bullets');
  r = runClone();
  check('n13 [Unreleased] bullets that start with "build" but are not "- build N:" are ignored, as preflight ignores them', r.status === 0, r.out);
  git('reset', '-q', '--hard', 'HEAD~1'); reset();

  // --- post-clone: plist, node, env, sync, bundle -----------------------------
  r = runClone({ plist: b64(plistFile('glim-da8c2', 'com.reihastings.glim'), true) });
  check('q01 line-wrapped base64 decodes and passes', r.status === 0 && /PROJECT_ID glim-da8c2/.test(r.out), r.out); reset();
  r = runClone({ plist: DEV_B64 });
  check('q02 a dev plist is refused by PROJECT_ID', r.status !== 0 && /PROJECT_ID 'glim-dev'/.test(r.out), r.out); reset();
  r = runClone({ plist: '' });
  check('q03 an empty plist variable is refused before writing', r.status !== 0 && /GLIM_GOOGLE_SERVICE_PLIST_B64 is empty/.test(r.out) && !existsSync(join(F, 'client/ios/App/App/GoogleService-Info.plist')), r.out);
  r = runClone({ plist: 'not base64!!' });
  check('q04 invalid base64 is refused', r.status !== 0 && /not valid base64|PROJECT_ID ''/.test(r.out), r.out); reset();
  writeFileSync(join(F, 'client/.nvmrc'), '24\n'); git('commit', '-qam', 'nvmrc');
  r = runClone();
  check('q05 .nvmrc major differing from the script pin fails before any install', r.status !== 0 && /does not match client\/.nvmrc \(24\)/.test(r.out) && !/node dist:/.test(r.out), r.out);
  git('reset', '-q', '--hard', 'HEAD~1'); reset();
  rmSync(join(F, 'client/.nvmrc')); git('commit', '-qam', 'no nvmrc');
  r = runClone();
  check('q05b a missing .nvmrc is a one-line refusal', r.status !== 0 && /client\/.nvmrc not found/.test(r.out) && !/No such file/.test(r.out), r.out);
  git('reset', '-q', '--hard', 'HEAD~1'); reset();
  r = runClone({ dist: DIST_OK });
  const archWord = os.arch() === 'arm64' ? 'darwin-arm64.tar.gz' : 'darwin-x64.tar.gz';
  check(`q06 the local distribution installs: URL ends in ${archWord}, checksum verified, node -v asserted`, r.status === 0 && r.out.includes(`node-v${NODE_VERSION}-${archWord}`) && new RegExp(`node: v${NODE_VERSION.replace(/\./g, '\\.')}`).test(r.out) && /: OK/.test(r.out), r.out); reset();
  r = runClone({ dist: DIST_WRONG });
  check('q07 a tarball whose node reports another version fails', r.status !== 0 && /node -v is 'v22\.0\.0', expected/.test(r.out), r.out); reset();
  r = runClone({ dist: DIST_BADSUM });
  check('q08 a checksum mismatch fails before unpacking', r.status !== 0 && /checksum mismatch/.test(r.out), r.out); reset();
  r = runClone({ dist: 'file:///nonexistent' });
  check('q09 an unreachable distribution fails at the download', r.status !== 0 && /download of .* failed/.test(r.out), r.out); reset();
  r = runClone({ env: { VITE_FIREBASE_APP_ID: '' } });
  check('q10 an empty env variable is refused before writing', r.status !== 0 && /VITE_FIREBASE_APP_ID is empty/.test(r.out) && !existsSync(join(F, 'client/.env.local')), r.out); reset();
  r = runClone({ env: { VITE_FIREBASE_PROJECT_ID: 'glim-dev' } });
  check('q11 a dev project id in the variables is refused', r.status !== 0 && /VITE_FIREBASE_PROJECT_ID is 'glim-dev'/.test(r.out), r.out); reset();
  writeFileSync(join(F, 'client/.env.native'), 'x\n'); git('add', '-A'); git('commit', '-qm', 'stray');
  r = runClone();
  check('q12 a committed client/.env.native fails the stray-file rule', r.status !== 0 && /client\/.env.native exists/.test(r.out), r.out);
  git('reset', '-q', '--hard', 'HEAD~1'); reset();
  r = runClone({ sync: SYNC_DIRTY });
  check('q13 a sync that changes a tracked file fails printing the diff', r.status !== 0 && /modified tracked files/.test(r.out) && /Package\.swift/.test(r.out) && /\+changed/.test(r.out), r.out); reset();
  writeFileSync(join(F, 'client/ios/App/CapApp-SPM/Package.swift'), '// pre-dirty\n');
  r = runClone();
  check('q14 a tree already dirty before the install is refused (porcelain must be empty before and after)', r.status !== 0 && /already modified before the install/.test(r.out), r.out); reset();
  r = runClone({ sync: SYNC_DEV });
  check('q15 a bundle naming glim-dev fails the bundle check', r.status !== 0 && /name the dev project/.test(r.out), r.out); reset();
  r = runClone({ sync: null });
  check('q16 no bundle at all (sync skipped) fails the bundle check', r.status !== 0 && /index\.html missing/.test(r.out), r.out); reset();
  r = runClone({ sync: 'false' });
  check('q17 a failing sync fails the build', r.status !== 0 && /sync \(hook\) failed/.test(r.out), r.out); reset();
  r = runClone({ root: tmp });
  check('q18 a root without client/ is refused', r.status !== 0 && /has no client\/ directory/.test(r.out), r.out);

  // --- post-xcodebuild ---------------------------------------------------------
  const ARCHIVE = join(tmp, 'App.xcarchive');
  const APP = join(ARCHIVE, 'Products/Applications/App.app');
  const buildArchive = ({ version = '1.0.0', build = '4', enc = ['bool', 'false'], bundle = '<html>glim-da8c2 glim-device-id</html>', manifest = true, plist = 'glim-da8c2', frameworks = ['Capacitor.framework', 'Cordova.framework'], extras = [], bundleId = 'com.reihastings.glim' } = {}) => {
    rmSync(ARCHIVE, { recursive: true, force: true }); mkdirSync(APP, { recursive: true });
    if (frameworks !== null) { mkdirSync(join(APP, 'Frameworks')); for (const fw of frameworks) mkdirSync(join(APP, 'Frameworks', fw)); for (const x of extras) writeFileSync(join(APP, 'Frameworks', x), ''); }
    if (bundle !== null) { mkdirSync(join(APP, 'public')); writeFileSync(join(APP, 'public/index.html'), bundle); }
    if (plist !== null) sh(PB, ['-c', `Add :PROJECT_ID string ${plist}`, join(APP, 'GoogleService-Info.plist')]);
    if (manifest) writeFileSync(join(APP, 'PrivacyInfo.xcprivacy'), '');
    sh(PB, ['-c', `Add :CFBundleShortVersionString string ${version}`, '-c', `Add :CFBundleVersion string ${build}`, '-c', `Add :CFBundleIdentifier string ${bundleId}`, ...(enc ? ['-c', `Add :ITSAppUsesNonExemptEncryption ${enc[0]} ${enc[1]}`] : []), join(APP, 'Info.plist')]);
  };
  function runBuild({ tag = 'v1.0.0-b4', exit = '0', archive = ARCHIVE, cloud = false, env = {} } = {}) {
    const e = { PATH: NO_NODE_PATH, HOME: process.env.HOME, TMPDIR: tmp, CI_SCRIPTS_ROOT: F, CI_SCRIPTS_FAKE: '1', CI_PRIMARY_REPOSITORY_PATH: F, CI_XCODEBUILD_EXIT_CODE: exit };
    if (tag !== null) e.CI_TAG = tag; if (archive !== null) e.CI_ARCHIVE_PATH = archive; if (cloud) e.CI_XCODE_CLOUD = 'TRUE';
    for (const [k, v] of Object.entries(env)) { if (v === null) delete e[k]; else e[k] = v; }
    const r = sh('bash', [POST_BUILD], { env: e, cwd: dirname(POST_BUILD) });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  }
  const aFails = (res, code, ...words) => res.status !== 0 && res.out.split('\n').some((l) => l.startsWith(`FAIL ${code} `) && words.every((w) => l.includes(w)));
  const WTT = join(F, 'client/ios/App/TestFlight/WhatToTest.en-US.txt');
  buildArchive();
  r = runBuild();
  check('x01 a good archive, no node on PATH: passes A2 to A8 and writes What to Test', r.status === 0 && /^PASS/m.test(r.out) && ['A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8'].every((c) => r.out.includes(`ok   ${c} `)) && existsSync(WTT), r.out);
  const wtt = rd(WTT).toString('utf8');
  check('x02 What to Test: build line first, then the section body, valid UTF-8, no other build lines', wtt.startsWith('Build 4: the first cloud build\n\nThe first release.') && wtt.includes('curly quote ’') && !wtt.includes('build 3') && Buffer.from(wtt, 'utf8').toString('utf8') === wtt, wtt);
  r = runBuild();
  check('x03 What to Test is idempotent', r.status === 0 && rd(WTT).toString('utf8') === wtt);
  r = runBuild({ env: { CHANGELOG: join(tmp, 'other.md') } });
  check('x03b an ambient CHANGELOG variable is ignored', r.status === 0 && rd(WTT).toString('utf8') === wtt, r.out);
  r = runBuild({ exit: '65' });
  check('x04 a failed xcodebuild: one line, exit 0, nothing inspected', r.status === 0 && /archive failed \(xcodebuild exit 65\)/.test(r.out) && !/A2/.test(r.out), r.out);
  r = runBuild({ archive: null });
  check('x05 release mode with CI_ARCHIVE_PATH unset fails', r.status !== 0 && /CI_ARCHIVE_PATH is not set/.test(r.out), r.out);
  r = runBuild({ archive: null, tag: 'cloudtest-1' });
  check('x05b check mode with CI_ARCHIVE_PATH unset records the fact and exits 0', r.status === 0 && /deployment preparation None/.test(r.out), r.out);
  r = runBuild({ archive: null, tag: 'cloudtest-fail-1' });
  check('x05c cloudtest-fail-1 with CI_ARCHIVE_PATH unset still fails', r.status !== 0, r.out);
  writeFileSync(join(tmp, 'App.ipa'), 'PK');
  r = runBuild({ archive: join(tmp, 'App.ipa') });
  check('x06 an .ipa file passed as the archive fails (no App.app inside)', r.status !== 0 && /is CI_ARCHIVE_PATH an \.xcarchive/.test(r.out), r.out);
  r = runBuild({ cloud: true });
  check('x07 seam refused on the cloud', r.status !== 0 && /refused here/.test(r.out), r.out);
  rmSync(join(F, 'client/ios/App/TestFlight'), { recursive: true, force: true });
  r = runBuild({ tag: 'cloudtest-1' });
  check('x08 check mode skips A2 only and writes a prefixed What to Test from the newest section', r.status === 0 && /skip A2/.test(r.out) && r.out.includes('ok   A8 ') && rd(WTT).toString('utf8').startsWith('[cloudtest] Build 4: the first cloud build'), r.out);
  r = runBuild({ tag: 'cloudtest-fail-1' });
  check('x09 cloudtest-fail-1 plants an A8 failure and exits non-zero', aFails(r, 'A8', 'planted failure'), r.out);
  const defects = [
    ['x10 wrong build', { build: '5' }, 'A2', "build '5'"],
    ['x11 wrong bundle id', { bundleId: 'com.other' }, 'A3', 'com.other'],
    ['x12 export key as string NO', { enc: ['string', 'NO'] }, 'A4', "'NO'"],
    ['x12b export key as the string "false"', { enc: ['string', 'false'] }, 'A4', "type 'string'"],
    ['x13 export key absent', { enc: null }, 'A4', 'absent'],
    ['x14 dev id in the bundle', { bundle: '<html>glim-dev glim-da8c2</html>' }, 'A5', 'dev in 1'],
    ['x15 bundle missing', { bundle: null }, 'A5', 'missing'],
    ['x16 dev Google plist', { plist: 'glim-dev' }, 'A6', "'glim-dev'"],
    ['x17 privacy manifest missing', { manifest: false }, 'A7', 'PrivacyInfo'],
    ['x18 extra framework', { frameworks: ['Capacitor.framework', 'Cordova.framework', 'FBSDKCoreKit.framework'] }, 'A8', 'FBSDKCoreKit.framework'],
    ['x18b a stray dylib under Frameworks', { extras: ['libEvil.dylib'] }, 'A8', 'libEvil.dylib'],
    ['x18c Capacitor.framework missing', { frameworks: ['Cordova.framework'] }, 'A8', 'Capacitor.framework is missing'],
    ['x19 no Frameworks directory', { frameworks: null }, 'A8', 'does not exist'],
  ];
  for (const [name, opts, code, word] of defects) { buildArchive(opts); r = runBuild(); check(`${name} fails ${code}`, aFails(r, code, word), r.out); }
  const longBody = '## [1.0.0] - x\n\n' + ('é'.repeat(2100)) + '\n\n- build 4: long\n';
  writeFileSync(CHANGELOG, '# C\n\n' + longBody); git('commit', '-qam', 'long');
  buildArchive(); r = runBuild();
  const cut = rd(WTT);
  check('x20 What to Test over 4000 bytes is cut to at most 4000 and stays valid UTF-8', r.status === 0 && cut.length <= 4000 && cut.length > 3900 && sh('iconv', ['-f', 'UTF-8', '-t', 'UTF-8', WTT]).status === 0 && !cut.toString('utf8').includes('�'), `len=${cut.length} status=${r.status} iconv=${sh('iconv', ['-f', 'UTF-8', '-t', 'UTF-8', WTT]).status} fffd=${cut.toString('utf8').includes('\uFFFD')}\n${r.out.slice(-400)}`);
  git('reset', '-q', '--hard', 'HEAD~1'); reset();

  // --- mode flags in git -------------------------------------------------------
  const repoRoot = join(here, '../..');
  const modes = sh('git', ['ls-files', '-s', 'client/ios/App/ci_scripts/'], { cwd: repoRoot }).stdout.split('\n').filter(Boolean);
  const onDisk = [POST_CLONE, POST_BUILD].every((f) => (statSync(f).mode & 0o111) !== 0 && readFileSync(f, 'utf8').startsWith('#!/bin/bash\n'));
  check('g01 both scripts are tracked as mode 100755 with a bash shebang', onDisk && modes.length === 2 && modes.every((l) => l.startsWith('100755')), modes.join('\n'));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\nci_scripts: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
