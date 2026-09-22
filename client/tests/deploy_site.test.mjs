// title: deploy_site.test.mjs
// project: Glim
// author: Reina Hastings
// contact: reinahastings13@gmail.com
// created: 2026-09-22
//
// purpose:
//   Pins the refusal paths of scripts/deploy-site.sh, the script that publishes
//   site/ to Firebase Hosting on production (docs/plan_stage2_release.md 4.5
//   and 7). Each case builds a throwaway git repository holding a site/ and a
//   firebase.json, runs the script there, and asserts it stops with the stated
//   message: the CONTACT_EMAIL_TBD placeholder, uncommitted site files, a
//   firebase.json that does not point Hosting at site/, CI set, and no terminal
//   on stdin. The happy dry run must pass and list the files. Nothing here can
//   reach the deploy step: every non-dry-run case is refused before it, and
//   the test never types the project id. Cross-platform (bash, git, node).
//
// usage:
//   cd client && node tests/deploy_site.test.mjs

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import os from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, '../../scripts/deploy-site.sh');

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.error(`  FAIL ${name}${detail ? `\n       ${detail.replace(/\n/g, '\n       ')}` : ''}`); }
}

const tmp = mkdtempSync(join(os.tmpdir(), 'glim-site-'));
const F = join(tmp, 'repo');
const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', ...opts });
const git = (...args) => { const r = sh('git', args, { cwd: F }); if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
const FIREBASE_OK = JSON.stringify({ firestore: { rules: 'firestore.rules' }, hosting: { public: 'site', ignore: ['**/.*'] } }, null, 2) + '\n';
const POLICY_OK = '<html><body><p>Contact: someone@example.com</p></body></html>\n';

function fixture() {
  mkdirSync(join(F, 'site'), { recursive: true });
  writeFileSync(join(F, 'firebase.json'), FIREBASE_OK);
  writeFileSync(join(F, 'site/privacy.html'), POLICY_OK);
  writeFileSync(join(F, 'site/index.html'), '<html>index</html>\n');
  sh('git', ['init', '-q', '-b', 'main'], { cwd: F });
  git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'test');
  git('add', '-A'); git('commit', '-qm', 'site');
}
// stdin is a pipe here, never a terminal, which is what the no-tty case relies on.
function run(args, env = {}) {
  const e = { ...process.env };
  delete e.CI;                      // the harness may set it; each case decides
  Object.assign(e, env);
  const r = sh('bash', [SCRIPT, ...args], { cwd: F, env: e, input: '' });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

try {
  fixture();

  let r = run(['-n']);
  check('1 clean committed site: dry run passes and lists both files', r.status === 0 && /Dry run: every check passed/.test(r.out) && /privacy\.html/.test(r.out) && /index\.html/.test(r.out) && /glim-da8c2/.test(r.out), r.out);

  writeFileSync(join(F, 'site/privacy.html'), POLICY_OK.replace('someone@example.com', 'CONTACT_EMAIL_TBD'));
  git('commit', '-qam', 'placeholder');
  r = run(['-n']);
  check('2 the placeholder is refused, and the offending line is printed', r.status !== 0 && /CONTACT_EMAIL_TBD is still in site/.test(r.out) && /privacy\.html:1:/.test(r.out), r.out);
  writeFileSync(join(F, 'site/privacy.html'), POLICY_OK); git('commit', '-qam', 'restore');

  writeFileSync(join(F, 'site/index.html'), '<html>edited</html>\n');
  r = run(['-n']);
  check('3 an uncommitted site file is refused', r.status !== 0 && /uncommitted changes under site/.test(r.out) && / M site\/index\.html/.test(r.out), r.out);
  git('checkout', '-q', 'site/index.html');

  writeFileSync(join(F, 'firebase.json'), FIREBASE_OK.replace('"public": "site"', '"public": "dist"'));
  git('commit', '-qam', 'wrong public');
  r = run(['-n']);
  check('4 firebase.json hosting.public not "site" is refused', r.status !== 0 && /hosting\.public is 'dist'/.test(r.out), r.out);
  writeFileSync(join(F, 'firebase.json'), FIREBASE_OK); git('commit', '-qam', 'restore');

  r = run([], { CI: '1' });
  check('5 a real run with CI set is refused before any deploy', r.status !== 0 && /refusing to deploy with CI set/.test(r.out) && !/=== Deploy ===/.test(r.out), r.out);
  r = run([]);
  check('6 a real run without a terminal on stdin is refused before any deploy', r.status !== 0 && /without a terminal on stdin/.test(r.out) && !/=== Deploy ===/.test(r.out), r.out);
  r = run(['-n'], { CI: '1' });
  check('7 a dry run is allowed with CI set (it changes nothing)', r.status === 0 && /Dry run/.test(r.out), r.out);
  r = run(['-x']);
  check('8 an unknown option is refused with usage', r.status === 2 && /unknown option/.test(r.out) && /Publish site/.test(r.out), r.out);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\ndeploy_site: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
