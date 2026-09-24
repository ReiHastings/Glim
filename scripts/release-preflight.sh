#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# Title:       release-preflight.sh
# Project:     Glim
# Author:      Reina Hastings (reinahastings13@gmail.com)
# Created:     2026-09-21
# Purpose:     The gate in front of a TestFlight upload. Glim is a web bundle
#              inside a native shell, and Xcode archives whatever bundle is on
#              disk, so the mistakes this script refuses are the quiet ones: a
#              stale bundle, dev credentials left behind by ios-dev.sh, a
#              version that disagrees with the changelog, a build number that
#              was already spent, rules that are ahead of what is live, CI not
#              green on the commit being shipped.
#
#              -v runs the ten checks of docs/plan_stage2_release.md 4.4 and
#              records what it blessed (version, build, commit, a digest of the
#              synced bundle) in client/.release-preflight.json, gitignored.
#              -a compares an .xcarchive against that record, so the archive
#              that is about to be uploaded is provably the one -v checked and
#              not one made after an ios-dev.sh run in between, and checks
#              that only the expected frameworks are embedded.
#
# Inputs:      client/ios/App/App.xcodeproj/project.pbxproj (version, build)
#              CHANGELOG.md (newest versioned section and its build lines)
#              client/.env.local, client/ios/App/App/GoogleService-Info.plist
#              client/ios/App/App/public (the synced web bundle; -v rebuilds it)
#              RULES_DEPLOYS.md via scripts/deploy-rules.sh -s
#              gh (GitHub CLI, logged in) for the CI verdict
#              An .xcarchive path, for -a
# Outputs:     One ok/FAIL line per check and a PASS/FAIL summary.
#              client/.release-preflight.json (gitignored) on a passing -v run.
#              Side effects: git fetch origin; npm run sync:ios (gitignored output).
#
# Usage:       scripts/release-preflight.sh -v 1.0.0          # before tagging, and again after
#              scripts/release-preflight.sh -v 1.0.0 -n       # report only, exit 0 regardless
#              scripts/release-preflight.sh -a ~/Library/Developer/Xcode/Archives/<date>/App.xcarchive
#              scripts/release-preflight.sh -h
#
# Test seam:   RELEASE_PREFLIGHT_ROOT=<fixture repo> and RELEASE_PREFLIGHT_FAKE=1
#              must be set TOGETHER (either alone is refused, so a stale export
#              can neither point a release at a fixture nor skip the sync on the
#              real repo). Under the seam, check 8 runs RELEASE_PREFLIGHT_SYNC_CMD
#              in place of `npm run sync:ios` if it is set, else skips the sync.
#              Everything else runs for real, so the self-test supplies a stub
#              gh on PATH and a stub scripts/deploy-rules.sh in the fixture.
# -----------------------------------------------------------------------------

set -euo pipefail

# --- Constants ---------------------------------------------------------------

PBXPROJ="client/ios/App/App.xcodeproj/project.pbxproj"
CHANGELOG="CHANGELOG.md"
ENV_FILE="client/.env.local"
GOOGLE_PLIST="client/ios/App/App/GoogleService-Info.plist"
BUNDLE_DIR="client/ios/App/App/public"
RECORD="client/.release-preflight.json"
RULES_LOG="RULES_DEPLOYS.md"
PROD_PROJECT="glim-da8c2"
BUNDLE_ID="com.reihastings.glim"
# Every dynamic framework the archive may embed. Anything else (the Facebook
# SDK turned up here on 2026-09-23 through a stale Xcode package cache) fails.
ALLOWED_FRAMEWORKS="Capacitor.framework Cordova.framework"
WORKFLOW="CI"
SCHEMA=1
PB="/usr/libexec/PlistBuddy"
# glim-device-id (a localStorage key) contains "glim-dev"; the dev project id
# is never followed by a letter, so match glim-dev not followed by i.
DEV_ID_RE='glim-dev([^i]|$)'
SEMVER_RE='^[0-9]+\.[0-9]+\.[0-9]+$'

VERSION=""
ARCHIVE=""
REPORT_ONLY=0
FAILURES=0

# --- Usage -------------------------------------------------------------------

usage() {
  cat <<'USAGE'
Release preflight for Glim. Run from anywhere in the repo.

  -v <X.Y.Z>   Check the tree, CI, rules, version, build number, tag,
               credentials and the synced bundle for releasing this version.
               Rebuilds the bundle (npm run sync:ios). Records a passing run in
               client/.release-preflight.json for -a.
  -n           With -v: report only. Every check runs and prints; exit 0 regardless.
  -a <path>    Archive mode: compare an .xcarchive against the last passing -v
               record (version, build, bundle digest, credentials, plist keys).
  -h           Show this message.
USAGE
}

die()  { echo "ERROR: $*" >&2; exit 1; }
ok()   { printf 'ok   %2s  %s\n' "$1" "$2"; }
fail() { printf 'FAIL %2s  %s: %s\n' "$1" "$2" "$3"; FAILURES=$((FAILURES + 1)); }

while getopts ":v:a:nh" opt; do
  case "${opt}" in
    v) VERSION="${OPTARG}" ;;
    a) ARCHIVE="${OPTARG}" ;;
    n) REPORT_ONLY=1 ;;
    h) usage; exit 0 ;;
    \?) echo "ERROR: unknown option -${OPTARG}" >&2; usage >&2; exit 2 ;;
    :)  echo "ERROR: -${OPTARG} requires an argument" >&2; exit 2 ;;
  esac
done

if [[ -n "${VERSION}" && -n "${ARCHIVE}" ]]; then die "-v and -a are separate modes; give one."; fi
if [[ -z "${VERSION}" && -z "${ARCHIVE}" ]]; then usage >&2; die "one of -v or -a is required."; fi
if [[ -n "${ARCHIVE}" && "${REPORT_ONLY}" -eq 1 ]]; then die "-n applies to -v only."; fi

# --- Root --------------------------------------------------------------------
# The env var is honoured only under the test seam, so a stale export in a
# shell can never point a real release at a fixture.

command -v git  >/dev/null 2>&1 || die "git not found"
command -v node >/dev/null 2>&1 || die "node not found"
if [[ -n "${RELEASE_PREFLIGHT_FAKE:-}" && -z "${RELEASE_PREFLIGHT_ROOT:-}" ]]; then
  die "RELEASE_PREFLIGHT_FAKE is set without RELEASE_PREFLIGHT_ROOT; refusing to skip the sync on a real repo."
fi
if [[ -n "${RELEASE_PREFLIGHT_ROOT:-}" ]]; then
  [[ -n "${RELEASE_PREFLIGHT_FAKE:-}" ]] || die "RELEASE_PREFLIGHT_ROOT is set without RELEASE_PREFLIGHT_FAKE; refusing."
  cd "${RELEASE_PREFLIGHT_ROOT}" 2>/dev/null || die "RELEASE_PREFLIGHT_ROOT '${RELEASE_PREFLIGHT_ROOT}' is not a directory"
  git rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "RELEASE_PREFLIGHT_ROOT '${RELEASE_PREFLIGHT_ROOT}' is not a git work tree"
  cd "$(git rev-parse --show-toplevel)"
else
  cd "$(git rev-parse --show-toplevel)"
fi
echo "root: $(pwd)"

# --- Helpers -----------------------------------------------------------------

# Digest of a bundle directory: every regular file except .DS_Store, as a
# sorted list of "sha256  ./relative/path", hashed once more. LC_ALL=C pins the
# sort so two machines agree.
bundle_digest() {
  ( cd "$1" && LC_ALL=C find . -type f ! -name .DS_Store | LC_ALL=C sort | while IFS= read -r f; do shasum -a 256 "$f"; done | shasum -a 256 | cut -d' ' -f1 )
}

# The four version lines in project.pbxproj. Prints the distinct values and
# the count, e.g. "1.0.0 2".
pbx_values() {
  # grep exits 1 on no match; under pipefail that would abort the script, so
  # zero matches must flow through as empty output for check 4 to report.
  { grep -E "^[[:space:]]*$1 = " "${PBXPROJ}" || true; } | sed -E "s/.*= (.*);/\1/" | sort | uniq -c | awk '{print $2, $1}'
}

plist_get() { "${PB}" -c "Print :$2" "$1" 2>/dev/null || true; }

# --- Archive mode ------------------------------------------------------------

if [[ -n "${ARCHIVE}" ]]; then
  [[ -x "${PB}" ]] || die "${PB} not found; archive mode needs macOS"
  APP="${ARCHIVE}/Products/Applications/App.app"
  [[ -d "${APP}" ]] || die "no App.app under '${ARCHIVE}/Products/Applications'; is that an .xcarchive?"
  [[ -f "${RECORD}" ]] || die "${RECORD} not found; run -v first."

  rec_schema="$(node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); process.stdout.write(String(r.schema))' "${RECORD}")"
  [[ "${rec_schema}" == "${SCHEMA}" ]] || die "${RECORD} has schema ${rec_schema}; this script writes ${SCHEMA}. Re-run -v."
  read -r rec_version rec_build rec_head rec_digest < <(node -e '
    const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    process.stdout.write([r.version, r.build, r.head, r.digest].join(" "));' "${RECORD}") || true

  head_now="$(git rev-parse HEAD)"
  if [[ "${head_now}" == "${rec_head}" && -z "$(git status --porcelain)" ]]; then ok A1 "HEAD and tree match the -v record (${rec_head:0:7})"
  else fail A1 "record" "HEAD moved or the tree is dirty since -v ran; run -v again"; fi

  info="${APP}/Info.plist"
  v="$(plist_get "${info}" CFBundleShortVersionString)"; b="$(plist_get "${info}" CFBundleVersion)"
  if [[ "${v}" == "${rec_version}" && "${b}" == "${rec_build}" ]]; then ok A2 "archive is ${v} (${b}), as recorded"
  else fail A2 "version" "archive is '${v}' build '${b}', record says ${rec_version} build ${rec_build}"; fi

  id="$(plist_get "${info}" CFBundleIdentifier)"
  if [[ "${id}" == "${BUNDLE_ID}" ]]; then ok A3 "bundle id ${id}"; else fail A3 "bundle id" "archive has '${id}', expected ${BUNDLE_ID}"; fi

  enc="$(plist_get "${info}" ITSAppUsesNonExemptEncryption)"
  if [[ "${enc}" == "false" ]]; then ok A4 "ITSAppUsesNonExemptEncryption is false"
  else fail A4 "export compliance" "ITSAppUsesNonExemptEncryption is '${enc:-absent}', expected Boolean false"; fi

  if [[ -d "${APP}/public" ]]; then
    d="$(bundle_digest "${APP}/public")"
    if [[ "${d}" == "${rec_digest}" ]]; then ok A5 "bundle digest matches the -v record"
    else fail A5 "bundle" "the archive's web bundle differs from the one -v blessed (was something synced or ios-dev.sh run in between?)"; fi
  else fail A5 "bundle" "no public/ folder inside App.app"; fi

  gp="$(plist_get "${APP}/GoogleService-Info.plist" PROJECT_ID)"
  if [[ "${gp}" == "${PROD_PROJECT}" ]]; then ok A6 "GoogleService-Info.plist is ${gp}"; else fail A6 "credentials" "archive's GoogleService-Info.plist PROJECT_ID is '${gp:-absent}', expected ${PROD_PROJECT}"; fi

  if [[ -f "${APP}/PrivacyInfo.xcprivacy" ]]; then ok A7 "PrivacyInfo.xcprivacy present"; else fail A7 "privacy manifest" "App.app has no PrivacyInfo.xcprivacy (is it in Copy Bundle Resources?)"; fi

  # Embedded frameworks: an allowlist, because a stale package cache can link
  # an SDK the project no longer declares, and nothing else in the archive says so.
  extra=""
  for fw in "${APP}"/Frameworks/*.framework; do
    [[ -e "${fw}" ]] || continue
    name="$(basename "${fw}")"
    case " ${ALLOWED_FRAMEWORKS} " in *" ${name} "*) ;; *) extra="${extra}${name} ";; esac
  done
  if [[ -z "${extra}" ]]; then ok A8 "embedded frameworks are only: ${ALLOWED_FRAMEWORKS}"
  else fail A8 "frameworks" "unexpected embedded framework(s): ${extra}(stale Xcode package cache? File > Packages > Reset Package Caches, or archive with xcodebuild)"; fi

  echo ""
  if [[ "${FAILURES}" -eq 0 ]]; then echo "PASS: archive matches the -v record; distribute it."; exit 0
  else echo "FAIL: ${FAILURES} check(s) failed; do not upload this archive."; exit 1; fi
fi

# --- Version mode ------------------------------------------------------------

[[ "${VERSION}" =~ ${SEMVER_RE} ]] || die "-v '${VERSION}' is not X.Y.Z"
for f in "${PBXPROJ}" "${CHANGELOG}" "${ENV_FILE}" "${GOOGLE_PLIST}"; do [[ -f "${f}" ]] || die "${f} not found (is this the Glim repo?)"; done

# 1. Branch and tree. Note: this does not catch an ios-dev.sh -n tree; the
#    Google plist is gitignored and the dev URL scheme is committed. Checks 7,
#    8 and 9 are the guards for that.
branch="$(git rev-parse --abbrev-ref HEAD)"
git fetch origin --quiet 2>/dev/null || die "git fetch origin failed; a release needs the remote"
dirty="$(git status --porcelain)"
if [[ "${branch}" != "main" ]]; then fail 1 "branch" "on '${branch}', releases come from main"
elif [[ -n "${dirty}" ]]; then fail 1 "tree" "uncommitted changes:"$'\n'"${dirty}"
elif [[ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]]; then fail 1 "sync" "HEAD is not origin/main; pull or push first"
else ok 1 "on main, clean, HEAD == origin/main"; fi
head_sha="$(git rev-parse HEAD)"

# 2. CI on HEAD. The workflow also runs on pull_request; after a fast-forward
#    merge the same sha has both runs, so ask for push events only and judge
#    the newest CI row.
if ! command -v gh >/dev/null 2>&1; then fail 2 "ci" "gh (GitHub CLI) not found; brew install gh, then gh auth login"
elif ! gh auth status >/dev/null 2>&1; then fail 2 "ci" "gh is not logged in; gh auth login"
else
  runs="$(gh run list --branch main --commit "${head_sha}" --workflow "${WORKFLOW}" --event push --json workflowName,status,conclusion,createdAt 2>/dev/null || echo '[]')"
  verdict="$(node -e '
    // Newest by createdAt, not by position: gh lists newest first today, but
    // the script should not depend on that.
    const rows = JSON.parse(process.argv[1]).filter((r) => r.workflowName === process.argv[2])
      .sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")));
    if (rows.length === 0) { process.stdout.write("none"); process.exit(0); }
    const r = rows[0];
    process.stdout.write(r.status !== "completed" ? "running" : String(r.conclusion));' "${runs}" "${WORKFLOW}")"
  case "${verdict}" in
    success)   ok 2 "CI green on ${head_sha:0:7}" ;;
    none)      fail 2 "ci" "no ${WORKFLOW} run for ${head_sha:0:7} yet (pushed moments ago?); wait for it" ;;
    running)   fail 2 "ci" "${WORKFLOW} is still running on ${head_sha:0:7}; wait for it" ;;
    cancelled) fail 2 "ci" "${WORKFLOW} was cancelled on ${head_sha:0:7} (a newer push?); re-run it" ;;
    *)         fail 2 "ci" "${WORKFLOW} concluded '${verdict}' on ${head_sha:0:7}" ;;
  esac
fi

# 3. Rules in step with both projects.
if [[ ! -f "${RULES_LOG}" ]]; then fail 3 "rules" "${RULES_LOG} not found; rules have never been deployed by script"
elif [[ ! -x scripts/deploy-rules.sh ]]; then fail 3 "rules" "scripts/deploy-rules.sh not found or not executable"
else
  status_out="$(scripts/deploy-rules.sh -s 2>&1 || true)"
  bad=""
  for alias in dev prod; do
    line="$(echo "${status_out}" | grep -E "^${alias}:" || true)"
    if ! echo "${line}" | grep -q "MATCHES"; then bad="${bad}${line:-${alias}: no status line}; "; fi
  done
  if [[ -z "${bad}" ]]; then ok 3 "live rules match the committed firestore.rules on dev and prod"
  else fail 3 "rules" "${bad}a release must not ship while the committed rules are ahead of what is live (a tightening PR is merged only when it can be deployed; see RELEASING.md)"; fi
fi

# 4. Version agreement: pbxproj (both configurations), changelog, -v.
mv_line="$(pbx_values MARKETING_VERSION)"; mv_val="${mv_line%% *}"; mv_n="${mv_line##* }"
cpv_line="$(pbx_values CURRENT_PROJECT_VERSION)"; cpv_val="${cpv_line%% *}"; cpv_n="${cpv_line##* }"
read -r cl_version cl_build < <(node -e '
  // First "## [x]" heading in file order, skipping [Unreleased], and the first
  // "- build N:" line in the whole file; report which section that line is under.
  const lines = require("fs").readFileSync(process.argv[1], "utf8").split("\n");
  let newest = null, section = null, buildSection = null, build = null;
  for (const l of lines) {
    const h = /^## \[(.+?)\]/.exec(l);
    if (h) { section = h[1]; if (!newest && h[1] !== "Unreleased") newest = h[1]; continue; }
    const b = /^- build ([0-9]+):/.exec(l);
    if (b && build === null) { build = b[1]; buildSection = section; }
  }
  process.stdout.write(`${newest ?? "-"} ${build === null ? "-" : (buildSection === newest ? build : "misplaced:" + build)}`);' "${CHANGELOG}") || true   # read returns 1 at EOF without a newline
if [[ "$(echo "${mv_line}" | wc -l | tr -d ' ')" != "1" || "${mv_n}" != "2" || "${mv_val}" != "${VERSION}" ]]; then
  fail 4 "version" "project.pbxproj MARKETING_VERSION is '${mv_line}' (want ${VERSION} in exactly 2 configurations)"
elif [[ "$(echo "${cpv_line}" | wc -l | tr -d ' ')" != "1" || "${cpv_n}" != "2" ]]; then
  fail 4 "version" "project.pbxproj CURRENT_PROJECT_VERSION is '${cpv_line}' (want one value in exactly 2 configurations)"
elif [[ "${cl_version}" != "${VERSION}" ]]; then
  fail 4 "changelog" "newest versioned section in ${CHANGELOG} is [${cl_version}], releasing ${VERSION}"
elif [[ "${cl_build}" == "-" ]]; then
  fail 4 "changelog" "no '- build N:' line in ${CHANGELOG}"
elif [[ "${cl_build}" == misplaced:* ]]; then
  fail 4 "changelog" "the first '- build ${cl_build#misplaced:}:' line is not under [${VERSION}]"
elif [[ "${cl_build}" != "${cpv_val}" ]]; then
  fail 4 "changelog" "${CHANGELOG} says build ${cl_build}, project.pbxproj says ${cpv_val}"
else ok 4 "version ${VERSION} build ${cpv_val} agree across pbxproj (x2) and ${CHANGELOG}"; fi
build="${cpv_val}"

# 5. Build number appears exactly once and is strictly greater than every
#    other build line. A count, not a filter: filtering the current number out
#    would hide a reused one.
all_builds="$({ grep -E '^- build [0-9]+:' "${CHANGELOG}" || true; } | sed -E 's/^- build ([0-9]+):.*/\1/')"
same_n="$(echo "${all_builds}" | { grep -cx "${build}" || true; })"
max_other="$(echo "${all_builds}" | { grep -vx "${build}" || true; } | sort -n | tail -1)"
if ! [[ "${build}" =~ ^[0-9]+$ ]]; then fail 5 "build number" "build '${build}' is not an integer"
elif [[ "${same_n}" -ne 1 ]]; then fail 5 "build number" "build ${build} appears ${same_n} times in ${CHANGELOG}; a build number is used exactly once and never resets"
elif [[ -n "${max_other}" && "${build}" -le "${max_other}" ]]; then fail 5 "build number" "build ${build} must be greater than every other build line in ${CHANGELOG} (max ${max_other}); the number never resets"
else ok 5 "build ${build} is used once and is greater than every earlier build${max_other:+ (max ${max_other})}"; fi

# 6. Tag: absent is fine (created after the first run); present must be on
#    HEAD locally and at the same commit on origin. Any other version's tag with
#    this build number means the number is spent.
tag="v${VERSION}-b${build}"
spent="$(git tag -l 'v*' | grep -E "^v[0-9]+\.[0-9]+\.[0-9]+-b${build}$" | grep -vx "${tag}" || true)"
if [[ -n "${spent}" ]]; then fail 6 "tag" "build ${build} is already used by tag ${spent}"
elif ! git rev-parse -q --verify "refs/tags/${tag}" >/dev/null; then ok 6 "tag ${tag} not created yet (note: create it after this run passes)"
else
  local_c="$(git rev-list -n 1 "${tag}")"
  # Peeled (^{}) gives the commit behind an annotated tag; a lightweight tag
  # has no peeled line, so fall back to the tag ref itself.
  remote_c="$(git ls-remote --tags origin "refs/tags/${tag}^{}" | cut -f1)"
  [[ -n "${remote_c}" ]] || remote_c="$(git ls-remote --tags origin "refs/tags/${tag}" | cut -f1)"
  if [[ "${local_c}" != "${head_sha}" ]]; then fail 6 "tag" "${tag} points at ${local_c:0:7}, HEAD is ${head_sha:0:7}; a pushed tag is never moved, so this needs a new build number"
  elif [[ -z "${remote_c}" ]]; then fail 6 "tag" "${tag} exists locally but not on origin; git push origin ${tag}"
  elif [[ "${remote_c}" != "${local_c}" ]]; then fail 6 "tag" "${tag} is at ${remote_c:0:7} on origin and ${local_c:0:7} here"
  else ok 6 "tag ${tag} on HEAD, locally and on origin"; fi
fi

# 7. Credentials: env file, no higher-priority native env files, Google plist.
env_lines="$({ grep -E '^VITE_FIREBASE_PROJECT_ID=' "${ENV_FILE}" || true; })"
env_n="$(echo "${env_lines}" | { grep -c . || true; })"
env_id="$(echo "${env_lines}" | tail -1 | cut -d= -f2-)"   # Vite: last definition wins
stray="$(ls client/.env.native client/.env.native.local 2>/dev/null || true)"
gp="$(plist_get "${GOOGLE_PLIST}" PROJECT_ID)"; gb="$(plist_get "${GOOGLE_PLIST}" BUNDLE_ID)"
if [[ "${env_n}" -ne 1 ]]; then fail 7 "credentials" "${ENV_FILE} defines VITE_FIREBASE_PROJECT_ID ${env_n} times; exactly once, please"
elif [[ "${env_id}" != "${PROD_PROJECT}" ]]; then fail 7 "credentials" "${ENV_FILE} has VITE_FIREBASE_PROJECT_ID='${env_id}', expected ${PROD_PROJECT}"
elif [[ -n "${stray}" ]]; then fail 7 "credentials" "$(echo "${stray}" | tr '\n' ' ')exists and Vite would load it above .env.local in --mode native; remove or review it"
elif [[ "${gp}" != "${PROD_PROJECT}" || "${gb}" != "${BUNDLE_ID}" ]]; then fail 7 "credentials" "${GOOGLE_PLIST} is PROJECT_ID='${gp}' BUNDLE_ID='${gb}' (ios-dev.sh -n leaves dev state; restore the production plist)"
else ok 7 "production credentials in ${ENV_FILE} and ${GOOGLE_PLIST}"; fi

# 8. Sync the bundle from this commit (skipped under the test seam), and the
#    tree must still be clean afterwards.
before="$(git status --porcelain)"
sync_cmd="cd client && npm run sync:ios"
if [[ -n "${RELEASE_PREFLIGHT_FAKE:-}" ]]; then sync_cmd="${RELEASE_PREFLIGHT_SYNC_CMD:-}"; fi
if [[ -z "${sync_cmd}" ]]; then ok 8 "sync skipped (RELEASE_PREFLIGHT_FAKE)"
elif ( eval "${sync_cmd}" ) >/dev/null 2>&1; then
  # Report only what the sync changed, not what was already dirty (check 1 covers that).
  changed="$(comm -13 <(echo "${before}" | sort) <(git status --porcelain | sort))"
  if [[ -z "${changed}" ]]; then ok 8 "bundle rebuilt from the working tree (npm run sync:ios); no tracked file changed"
  else fail 8 "sync" "npm run sync:ios modified tracked files:"$'\n'"${changed}"; fi
else fail 8 "sync" "npm run sync:ios failed; run it by hand to see why"; fi

# 9. The bundle names production and not dev.
if [[ ! -f "${BUNDLE_DIR}/index.html" ]]; then fail 9 "bundle" "${BUNDLE_DIR}/index.html missing; npm run sync:ios"
else
  # grep exits 1 on no match; under pipefail that would abort the script.
  prod_hits="$({ grep -rl "${PROD_PROJECT}" "${BUNDLE_DIR}" || true; } | wc -l | tr -d ' ')"
  dev_hits="$({ grep -rlE "${DEV_ID_RE}" "${BUNDLE_DIR}" || true; } | wc -l | tr -d ' ')"
  if [[ "${prod_hits}" -eq 0 ]]; then fail 9 "bundle" "no file under ${BUNDLE_DIR} names ${PROD_PROJECT}"
  elif [[ "${dev_hits}" -ne 0 ]]; then fail 9 "bundle" "${dev_hits} file(s) under ${BUNDLE_DIR} name the dev project; this bundle must not ship"
  else ok 9 "bundle names ${PROD_PROJECT} and not glim-dev"; fi
fi

# 10. Record and summarise.
echo ""
echo "version: ${VERSION}   build: ${build}   HEAD: ${head_sha:0:7}   tag: ${tag}"
if [[ "${FAILURES}" -eq 0 ]]; then
  digest="$(bundle_digest "${BUNDLE_DIR}")"
  node -e '
    const [out, version, build, head, tag, digest] = process.argv.slice(1);
    require("fs").writeFileSync(out, JSON.stringify({ schema: 1, version, build, head, tag, digest, at: new Date().toISOString() }, null, 2) + "\n");' \
    "${RECORD}" "${VERSION}" "${build}" "${head_sha}" "${tag}" "${digest}"
  echo "bundle digest: ${digest:0:16}...  recorded in ${RECORD}"
  echo "PASS"
  exit 0
fi
echo "FAIL: ${FAILURES} check(s) failed"
[[ "${REPORT_ONLY}" -eq 1 ]] && exit 0
exit 1
