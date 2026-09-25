#!/bin/bash
# -----------------------------------------------------------------------------
# Title:       ci_post_xcodebuild.sh
# Project:     Glim
# Author:      Reina Hastings (reinahastings13@gmail.com)
# Created:     2026-09-24
# Purpose:     Xcode Cloud runs this after the archive action
#              (docs/plan_stage2b_xcode_cloud.md 4.3). Two jobs:
#                1. The archive checks that scripts/release-preflight.sh -a
#                   made on the laptop (A2 to A8), against the .xcarchive:
#                   version and build, bundle id, the export-compliance key,
#                   the production Google plist, the privacy manifest, the
#                   web bundle, and an allowlist of embedded frameworks.
#                2. TestFlight's "What to Test" text, written from
#                   CHANGELOG.md into TestFlight/WhatToTest.en-US.txt beside
#                   the project, where Xcode Cloud picks it up.
#              If xcodebuild itself failed, this script says so in one line
#              and exits 0, so the compiler error is never masked.
#
# Inputs:      CI_XCODEBUILD_EXIT_CODE, CI_ARCHIVE_PATH, CI_TAG,
#              CI_PRIMARY_REPOSITORY_PATH (Xcode Cloud sets these)
# Outputs:     <project dir>/TestFlight/WhatToTest.en-US.txt; a non-zero exit
#              fails the build.
#
# Usage:       Not run by hand. Local harness: client/tests/ci_scripts.test.mjs,
#              through the same seam as ci_post_clone.sh (CI_SCRIPTS_ROOT and
#              CI_SCRIPTS_FAKE together), refused when CI_XCODE_CLOUD is TRUE.
#              A tag cloudtest-fail-N makes the framework check fail on
#              purpose, so the throwaway workflow can show what a failing
#              post-xcodebuild script does to the build's status.
# -----------------------------------------------------------------------------

set -euo pipefail

# --- Constants ---------------------------------------------------------------

PROD_PROJECT="glim-da8c2"
BUNDLE_ID="com.reihastings.glim"
DEV_ID_RE='glim-dev([^i]|$)'
ALLOWED_FRAMEWORKS="Capacitor.framework Cordova.framework"
RELEASE_TAG_RE='^v([0-9]+\.[0-9]+\.[0-9]+)-b(0|[1-9][0-9]*)$'
CHECK_TAG_RE='^cloudtest-(fail-)?[0-9]+$'
WHAT_TO_TEST_MAX=4000            # App Store Connect's limit is 4000 characters; bytes is at most that
PB="/usr/libexec/PlistBuddy"
FAILURES=0

die()  { echo "ERROR: $*" >&2; exit 1; }
step() { printf '\n=== %s ===\n' "$*"; }
ok()   { printf 'ok   %s  %s\n' "$1" "$2"; }
fail() { printf 'FAIL %s  %s: %s\n' "$1" "$2" "$3"; FAILURES=$((FAILURES + 1)); }
# PlistBuddy prints its errors on stdout, so print only on success.
plist_get() { local v; v="$("${PB}" -c "Print :$2" "$1" 2>/dev/null)" || v=""; printf '%s' "${v}"; }

# --- Refusals ----------------------------------------------------------------

if [[ "${CI_XCODE_CLOUD:-}" == "TRUE" ]]; then
  for v in CI_SCRIPTS_ROOT CI_SCRIPTS_FAKE CI_SCRIPTS_NODE_CMD CI_SCRIPTS_INSTALL_CMD CI_SCRIPTS_SYNC_CMD; do
    [[ -z "${!v:-}" ]] || die "${v} is set on Xcode Cloud; the test seam is refused here."
  done
fi
if [[ -n "${CI_SCRIPTS_FAKE:-}" && -z "${CI_SCRIPTS_ROOT:-}" ]]; then die "CI_SCRIPTS_FAKE without CI_SCRIPTS_ROOT; refusing."; fi
if [[ -n "${CI_SCRIPTS_ROOT:-}" && -z "${CI_SCRIPTS_FAKE:-}" ]]; then die "CI_SCRIPTS_ROOT without CI_SCRIPTS_FAKE; refusing."; fi

# --- Gate on the archive's own result ----------------------------------------

if [[ "${CI_XCODEBUILD_EXIT_CODE:-0}" != "0" ]]; then
  echo "archive failed (xcodebuild exit ${CI_XCODEBUILD_EXIT_CODE}); see the xcodebuild step. Nothing to inspect."
  exit 0
fi
[[ -n "${CI_TAG:-}" ]] || die "CI_TAG is not set; this workflow runs only from a tag"
MODE=""; TAG_VERSION=""; TAG_BUILD=""; PLANTED_FAILURE=""
if [[ "${CI_TAG}" =~ ${RELEASE_TAG_RE} ]]; then MODE="release"; TAG_VERSION="${BASH_REMATCH[1]}"; TAG_BUILD="${BASH_REMATCH[2]}"
elif [[ "${CI_TAG}" =~ ${CHECK_TAG_RE} ]]; then MODE="check"; [[ -n "${BASH_REMATCH[1]}" ]] && PLANTED_FAILURE=1
else die "tag '${CI_TAG}' is neither vX.Y.Z-bN nor cloudtest-N"; fi

ROOT="${CI_SCRIPTS_ROOT:-${CI_PRIMARY_REPOSITORY_PATH:-}}"
[[ -n "${ROOT}" && -d "${ROOT}/client" ]] || die "CI_PRIMARY_REPOSITORY_PATH does not point at the Glim repository"
cd "${ROOT}"
[[ -x "${PB}" ]] || die "${PB} not found; this script runs on macOS"
[[ -n "${CI_ARCHIVE_PATH:-}" ]] || die "CI_ARCHIVE_PATH is not set although xcodebuild succeeded (deployment preparation None?). Nothing to inspect; record this in the spec."
APP="${CI_ARCHIVE_PATH}/Products/Applications/App.app"
[[ -d "${APP}" ]] || die "no App.app under '${CI_ARCHIVE_PATH}/Products/Applications'; is CI_ARCHIVE_PATH an .xcarchive?"
step "ci_post_xcodebuild: mode ${MODE}, tag ${CI_TAG}, archive ${CI_ARCHIVE_PATH}"

# --- The archive checks (A2 to A8) -------------------------------------------

info="${APP}/Info.plist"
v="$(plist_get "${info}" CFBundleShortVersionString)"; b="$(plist_get "${info}" CFBundleVersion)"
if [[ "${MODE}" == "release" ]]; then
  if [[ "${v}" == "${TAG_VERSION}" && "${b}" == "${TAG_BUILD}" ]]; then ok A2 "archive is ${v} (${b}), as the tag says"
  else fail A2 "version" "archive is '${v}' build '${b}', tag says ${TAG_VERSION} build ${TAG_BUILD}"; fi
else echo "skip A2  version check (check mode; archive is ${v} (${b}))"; fi

id="$(plist_get "${info}" CFBundleIdentifier)"
if [[ "${id}" == "${BUNDLE_ID}" ]]; then ok A3 "bundle id ${id}"; else fail A3 "bundle id" "'${id}', expected ${BUNDLE_ID}"; fi

enc="$(plist_get "${info}" ITSAppUsesNonExemptEncryption)"
if [[ "${enc}" == "false" ]]; then ok A4 "ITSAppUsesNonExemptEncryption is false"; else fail A4 "export compliance" "ITSAppUsesNonExemptEncryption is '${enc:-absent}', expected Boolean false"; fi

if [[ -f "${APP}/public/index.html" ]]; then
  prod_hits="$({ grep -rl "${PROD_PROJECT}" "${APP}/public" || true; } | wc -l | tr -d ' ')"
  dev_hits="$({ grep -rlE "${DEV_ID_RE}" "${APP}/public" || true; } | wc -l | tr -d ' ')"
  if [[ "${prod_hits}" -gt 0 && "${dev_hits}" -eq 0 ]]; then ok A5 "web bundle present, names ${PROD_PROJECT} and not glim-dev"
  else fail A5 "bundle" "public/ names production in ${prod_hits} file(s) and dev in ${dev_hits}"; fi
else fail A5 "bundle" "App.app/public/index.html is missing"; fi

gp="$(plist_get "${APP}/GoogleService-Info.plist" PROJECT_ID)"
if [[ "${gp}" == "${PROD_PROJECT}" ]]; then ok A6 "GoogleService-Info.plist is ${gp}"; else fail A6 "credentials" "GoogleService-Info.plist PROJECT_ID is '${gp:-absent}', expected ${PROD_PROJECT}"; fi

if [[ -f "${APP}/PrivacyInfo.xcprivacy" ]]; then ok A7 "PrivacyInfo.xcprivacy present"; else fail A7 "privacy manifest" "App.app has no PrivacyInfo.xcprivacy"; fi

if [[ -d "${APP}/Frameworks" ]]; then
  extra=""
  for fw in "${APP}"/Frameworks/*.framework; do
    [[ -e "${fw}" ]] || continue
    name="$(basename "${fw}")"
    case " ${ALLOWED_FRAMEWORKS} " in *" ${name} "*) ;; *) extra="${extra}${name} ";; esac
  done
  if [[ -n "${PLANTED_FAILURE}" ]]; then fail A8 "frameworks" "planted failure (tag ${CI_TAG}): learning what a failing post-xcodebuild script does"
  elif [[ -z "${extra}" ]]; then ok A8 "embedded frameworks are only: ${ALLOWED_FRAMEWORKS}"
  else fail A8 "frameworks" "unexpected embedded framework(s): ${extra}"; fi
else fail A8 "frameworks" "App.app/Frameworks does not exist; a check that cannot see its subject is not a pass"; fi

# --- What to Test ------------------------------------------------------------

if [[ "${MODE}" == "release" ]]; then
  step "What to Test"
  tf_dir="client/ios/App/TestFlight"
  mkdir -p "${tf_dir}"
  node -e '
    // The build line for this build first, then its version section body.
    const [file, version, build, max] = process.argv.slice(1);
    const lines = require("fs").readFileSync(file, "utf8").split("\n");
    let section = null, body = [], buildLine = null;
    for (const l of lines) {
      const h = /^## \[(.+?)\]/.exec(l);
      if (h) { section = h[1]; continue; }
      if (section !== version) continue;
      const b = /^- build ([0-9]+):\s*(.*)$/.exec(l);
      if (b) { if (b[1] === build) buildLine = b[2]; continue; }
      body.push(l);
    }
    if (buildLine === null) { console.error(`no "- build ${build}:" line under [${version}]`); process.exit(1); }
    let text = `Build ${build}: ${buildLine}\n\n${body.join("\n").trim()}\n`;
    const buf = Buffer.from(text, "utf8");
    // Cut at the byte limit, then drop any partial trailing UTF-8 sequence.
    text = buf.length > Number(max) ? buf.subarray(0, Number(max)).toString("utf8").replace(/�+$/, "") : text;
    process.stdout.write(text);' "${CHANGELOG:-CHANGELOG.md}" "${TAG_VERSION}" "${TAG_BUILD}" "${WHAT_TO_TEST_MAX}" > "${tf_dir}/WhatToTest.en-US.txt" || die "could not write What to Test from CHANGELOG.md"
  bytes="$(wc -c < "${tf_dir}/WhatToTest.en-US.txt" | tr -d ' ')"
  [[ "${bytes}" -gt 0 && "${bytes}" -le "${WHAT_TO_TEST_MAX}" ]] || die "WhatToTest.en-US.txt is ${bytes} bytes"
  iconv -f UTF-8 -t UTF-8 "${tf_dir}/WhatToTest.en-US.txt" >/dev/null 2>&1 || die "WhatToTest.en-US.txt is not valid UTF-8"
  echo "ok: ${tf_dir}/WhatToTest.en-US.txt, ${bytes} bytes:"; sed 's/^/  | /' "${tf_dir}/WhatToTest.en-US.txt"
else
  step "What to Test: skipped (check mode)"
fi

echo ""
if [[ "${FAILURES}" -eq 0 ]]; then echo "PASS: archive checks A2 to A8"; exit 0; fi
echo "FAIL: ${FAILURES} archive check(s) failed"; exit 1
