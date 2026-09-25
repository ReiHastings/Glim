#!/bin/bash
# -----------------------------------------------------------------------------
# Title:       ci_post_clone.sh
# Project:     Glim
# Author:      Reina Hastings (reinahastings13@gmail.com)
# Created:     2026-09-24
# Purpose:     Xcode Cloud runs this right after cloning the tagged commit and
#              BEFORE it resolves Swift packages (docs/plan_stage2b_xcode_cloud.md
#              2.2, 4.2). A clean clone lacks four things this Mac's tree has:
#              Node and node_modules (the plugins' Swift packages live under
#              node_modules), client/.env.local, the production
#              GoogleService-Info.plist (gitignored), and the synced web bundle.
#              This script supplies them, and refuses the build early whenever
#              the tag, the project file, the changelog and Xcode Cloud's build
#              counter do not name the same build.
#
#              Two modes, chosen by the tag and never by a variable:
#                release  vX.Y.Z-bN     all steps
#                check    cloudtest-N   skips the number assertions (step 1);
#                                       used only by the throwaway workflow,
#                                       which has no post-action
#
# Inputs:      CI_TAG, CI_BUILD_NUMBER, CI_PRIMARY_REPOSITORY_PATH,
#              CI_WORKSPACE_PATH, CI_XCODE_CLOUD (Xcode Cloud sets these)
#              GLIM_GOOGLE_SERVICE_PLIST_B64 and the six VITE_FIREBASE_*
#              values, as secret workflow environment variables
# Outputs:     client/ios/App/App/GoogleService-Info.plist, client/.env.local,
#              client/node_modules, client/ios/App/App/public (the bundle),
#              Node under $CI_WORKSPACE_PATH/node; a non-zero exit fails the build.
#
# Usage:       Not run by hand. Xcode Cloud runs it from client/ios/App/ci_scripts.
#              Local harness: client/tests/ci_scripts.test.mjs, through the seam
#              below, which is refused outright when CI_XCODE_CLOUD is TRUE.
#
# Test seam:   CI_SCRIPTS_ROOT=<fixture repo> and CI_SCRIPTS_FAKE=1 (both, or
#              neither). Under the seam, CI_SCRIPTS_NODE_CMD, CI_SCRIPTS_INSTALL_CMD
#              and CI_SCRIPTS_SYNC_CMD replace the Node download, npm ci and
#              npm run sync:ios; an unset hook skips that step.
# -----------------------------------------------------------------------------

set -euo pipefail

# --- Constants ---------------------------------------------------------------

NODE_VERSION="22.23.3"           # exact; bump by hand. Major must match client/.nvmrc.
NODE_DIST="https://nodejs.org/dist"
PROD_PROJECT="glim-da8c2"
BUNDLE_ID="com.reihastings.glim"
DEV_ID_RE='glim-dev([^i]|$)'     # glim-device-id contains glim-dev; the id is never followed by a letter
RELEASE_TAG_RE='^v([0-9]+\.[0-9]+\.[0-9]+)-b(0|[1-9][0-9]*)$'
CHECK_TAG_RE='^cloudtest-(fail-)?[0-9]+$'
PB="/usr/libexec/PlistBuddy"
ENV_KEYS=(VITE_FIREBASE_API_KEY VITE_FIREBASE_AUTH_DOMAIN VITE_FIREBASE_PROJECT_ID VITE_FIREBASE_STORAGE_BUCKET VITE_FIREBASE_MESSAGING_SENDER_ID VITE_FIREBASE_APP_ID)

die()  { echo "ERROR: $*" >&2; exit 1; }
step() { printf '\n=== %s ===\n' "$*"; }

# --- Step 0: refuse what must not run ----------------------------------------

# The test seam is for a laptop. On the cloud any trace of it fails the build,
# before anything else, so a stray workflow variable can never skip a step.
if [[ "${CI_XCODE_CLOUD:-}" == "TRUE" ]]; then
  for v in CI_SCRIPTS_ROOT CI_SCRIPTS_FAKE CI_SCRIPTS_NODE_CMD CI_SCRIPTS_INSTALL_CMD CI_SCRIPTS_SYNC_CMD; do
    [[ -z "${!v:-}" ]] || die "${v} is set on Xcode Cloud; the test seam is refused here. Remove it from the workflow."
  done
fi
if [[ -n "${CI_SCRIPTS_FAKE:-}" && -z "${CI_SCRIPTS_ROOT:-}" ]]; then die "CI_SCRIPTS_FAKE without CI_SCRIPTS_ROOT; refusing."; fi
if [[ -n "${CI_SCRIPTS_ROOT:-}" && -z "${CI_SCRIPTS_FAKE:-}" ]]; then die "CI_SCRIPTS_ROOT without CI_SCRIPTS_FAKE; refusing."; fi
FAKE="${CI_SCRIPTS_FAKE:-}"

if [[ -z "${CI_TAG:-}" ]]; then
  die "this workflow runs only from a tag (vX.Y.Z-bN, or cloudtest-N for the check workflow); a manual rebuild has none. Push a new tag to retry."
fi
MODE=""
if [[ "${CI_TAG}" =~ ${RELEASE_TAG_RE} ]]; then
  MODE="release"; TAG_VERSION="${BASH_REMATCH[1]}"; TAG_BUILD="${BASH_REMATCH[2]}"
elif [[ "${CI_TAG}" =~ ${CHECK_TAG_RE} ]]; then
  MODE="check"; TAG_VERSION=""; TAG_BUILD=""
else
  die "tag '${CI_TAG}' is neither vX.Y.Z-bN nor cloudtest-N; nothing to build."
fi

ROOT="${CI_SCRIPTS_ROOT:-${CI_PRIMARY_REPOSITORY_PATH:-}}"
[[ -n "${ROOT}" ]] || die "CI_PRIMARY_REPOSITORY_PATH is not set"
[[ -d "${ROOT}/client" ]] || die "'${ROOT}' has no client/ directory; is this the Glim repository?"
cd "${ROOT}"
PBXPROJ="client/ios/App/App.xcodeproj/project.pbxproj"
CHANGELOG="CHANGELOG.md"
GOOGLE_PLIST="client/ios/App/App/GoogleService-Info.plist"
BUNDLE_DIR="client/ios/App/App/public"
step "ci_post_clone: mode ${MODE}, tag ${CI_TAG}, build number ${CI_BUILD_NUMBER:-unset}, root ${ROOT}"

# --- Step 1: the numbers agree (release mode) --------------------------------
# The same grammar scripts/release-preflight.sh applies on the laptop. Here it
# is what keeps the project file, the changelog, the tag and Apple's counter
# as one number; the counter is read before the release (RELEASING.md 1.0).

pbx_values() {
  { grep -E "^[[:space:]]*$1 = " "${PBXPROJ}" || true; } | sed -E "s/.*= (.*);/\1/" | sort | uniq -c | awk '{print $2, $1}'
}

if [[ "${MODE}" == "release" ]]; then
  step "Numbers"
  [[ -n "${CI_BUILD_NUMBER:-}" ]] || die "CI_BUILD_NUMBER is not set"
  mv_line="$(pbx_values MARKETING_VERSION)"; cpv_line="$(pbx_values CURRENT_PROJECT_VERSION)"
  read -r cl_version cl_build < <(node -e '
    const lines = require("fs").readFileSync(process.argv[1], "utf8").split("\n");
    let newest = null, section = null, buildSection = null, build = null;
    for (const l of lines) {
      const h = /^## \[(.+?)\]/.exec(l);
      if (h) { section = h[1]; if (!newest && h[1] !== "Unreleased") newest = h[1]; continue; }
      const b = /^- build ([0-9]+):/.exec(l);
      if (b && build === null) { build = b[1]; buildSection = section; }
    }
    process.stdout.write(`${newest ?? "-"} ${build === null ? "-" : (buildSection === newest ? build : "misplaced:" + build)}`);' "${CHANGELOG}") || true
  all_builds="$({ grep -E '^- build [0-9]+:' "${CHANGELOG}" || true; } | sed -E 's/^- build ([0-9]+):.*/\1/')"
  same_n="$(echo "${all_builds}" | { grep -cx "${TAG_BUILD}" || true; })"
  max_other="$(echo "${all_builds}" | { grep -vx "${TAG_BUILD}" || true; } | sort -n | tail -1)"
  echo "tag ${CI_TAG}: version ${TAG_VERSION}, build ${TAG_BUILD}"
  echo "CI_BUILD_NUMBER: ${CI_BUILD_NUMBER}"
  echo "project.pbxproj: MARKETING_VERSION '${mv_line}', CURRENT_PROJECT_VERSION '${cpv_line}' (value count)"
  echo "CHANGELOG.md: newest section ${cl_version}, first build line ${cl_build}"
  [[ "${mv_line}" == "${TAG_VERSION} 2" ]]   || die "MARKETING_VERSION must be ${TAG_VERSION} in exactly 2 configurations; it is '${mv_line}'"
  [[ "${cpv_line}" == "${TAG_BUILD} 2" ]]    || die "CURRENT_PROJECT_VERSION must be ${TAG_BUILD} in exactly 2 configurations; it is '${cpv_line}'"
  [[ "${CI_BUILD_NUMBER}" == "${TAG_BUILD}" ]] || die "Xcode Cloud's build number is ${CI_BUILD_NUMBER} but the tag says ${TAG_BUILD}; read Next Build Number in App Store Connect before tagging (RELEASING.md 1.0)"
  [[ "${cl_version}" == "${TAG_VERSION}" ]]  || die "CHANGELOG.md's newest versioned section is [${cl_version}], the tag says ${TAG_VERSION}"
  [[ "${cl_build}" == "${TAG_BUILD}" ]]      || die "CHANGELOG.md's first '- build N:' line is '${cl_build}', the tag says ${TAG_BUILD} (it must be under [${TAG_VERSION}])"
  [[ "${same_n}" == "1" ]]                   || die "build ${TAG_BUILD} appears ${same_n} times in CHANGELOG.md; a build number is used exactly once"
  if [[ -n "${max_other}" && "${TAG_BUILD}" -le "${max_other}" ]]; then die "build ${TAG_BUILD} is not greater than every other build line (max ${max_other}); the number never resets. Was a manual upload made without raising Next Build Number?"; fi
  echo "ok: tag, project file, changelog and CI_BUILD_NUMBER all say ${TAG_VERSION} build ${TAG_BUILD}"
else
  step "Numbers: skipped (check mode)"
fi

# --- Step 2: the production Google plist -------------------------------------

step "GoogleService-Info.plist"
[[ -x "${PB}" ]] || die "${PB} not found; this script runs on macOS"
[[ -n "${GLIM_GOOGLE_SERVICE_PLIST_B64:-}" ]] || die "GLIM_GOOGLE_SERVICE_PLIST_B64 is empty; add it to the workflow as a secret variable (base64 of GoogleService-Info-prod.plist)"
printf '%s' "${GLIM_GOOGLE_SERVICE_PLIST_B64}" | tr -d '[:space:]' | base64 --decode > "${GOOGLE_PLIST}" || die "GLIM_GOOGLE_SERVICE_PLIST_B64 is not valid base64"
# PlistBuddy prints its errors on stdout, so capture only on success.
gp="$("${PB}" -c 'Print :PROJECT_ID' "${GOOGLE_PLIST}" 2>/dev/null)" || gp=""
gb="$("${PB}" -c 'Print :BUNDLE_ID' "${GOOGLE_PLIST}" 2>/dev/null)" || gb=""
[[ "${gp}" == "${PROD_PROJECT}" ]] || die "decoded plist has PROJECT_ID '${gp}', expected ${PROD_PROJECT}"
[[ "${gb}" == "${BUNDLE_ID}" ]]    || die "decoded plist has BUNDLE_ID '${gb}', expected ${BUNDLE_ID}"
echo "ok: ${GOOGLE_PLIST} written, $(wc -c < "${GOOGLE_PLIST}" | tr -d ' ') bytes, PROJECT_ID ${gp}"

# --- Step 3: Node from nodejs.org --------------------------------------------
# Not Homebrew: the cloud image may be Intel with no bottles (spec Section 3),
# and a checksummed tarball is the same on every machine.

step "Node ${NODE_VERSION}"
want_major="$(tr -d '[:space:]' < client/.nvmrc)"
[[ "${NODE_VERSION%%.*}" == "${want_major}" ]] || die "NODE_VERSION ${NODE_VERSION} in this script does not match client/.nvmrc (${want_major}); change one to match the other"
if [[ -n "${FAKE}" ]]; then
  if [[ -n "${CI_SCRIPTS_NODE_CMD:-}" ]]; then ( eval "${CI_SCRIPTS_NODE_CMD}" ) || die "node hook failed"; else echo "node install skipped (seam)"; fi
else
  arch="$(uname -m)"; case "${arch}" in x86_64) narch=x64 ;; arm64) narch=arm64 ;; *) die "unexpected architecture ${arch}" ;; esac
  tarball="node-v${NODE_VERSION}-darwin-${narch}.tar.gz"
  work="${CI_WORKSPACE_PATH:-${TMPDIR:-/tmp}}/node"
  mkdir -p "${work}" && cd "${work}"
  curl -fsSL --max-time 300 -o "${tarball}" "${NODE_DIST}/v${NODE_VERSION}/${tarball}" || die "download of ${tarball} failed"
  curl -fsSL --max-time 60 -o SHASUMS256.txt "${NODE_DIST}/v${NODE_VERSION}/SHASUMS256.txt" || die "download of SHASUMS256.txt failed"
  grep " ${tarball}\$" SHASUMS256.txt | shasum -a 256 -c - || die "checksum mismatch for ${tarball}"
  tar -xzf "${tarball}"
  export PATH="${work}/node-v${NODE_VERSION}-darwin-${narch}/bin:${PATH}"
  cd "${ROOT}"
fi
have="$(node -v 2>/dev/null || true)"
if [[ -z "${FAKE}" || -n "${CI_SCRIPTS_NODE_CMD:-}" ]]; then
  [[ "${have}" == "v${NODE_VERSION}" ]] || die "node -v is '${have}', expected v${NODE_VERSION}"
fi
echo "uname -m: $(uname -m)   node: ${have}   npm: $(npm -v 2>/dev/null || echo unavailable)"

# --- Step 4: client/.env.local from the six variables ------------------------

step ".env.local"
for f in client/.env.native client/.env.native.local; do
  [[ ! -e "${f}" ]] || die "${f} exists in the clone; Vite would load it above .env.local in --mode native. Remove it."
done
for k in "${ENV_KEYS[@]}"; do [[ -n "${!k:-}" ]] || die "${k} is empty; add it to the workflow as a secret variable"; done
: > client/.env.local
for k in "${ENV_KEYS[@]}"; do printf '%s=%s\n' "${k}" "${!k}" >> client/.env.local; done
echo "ok: client/.env.local written, $(wc -l < client/.env.local | tr -d ' ') lines, VITE_FIREBASE_PROJECT_ID=${VITE_FIREBASE_PROJECT_ID}"
[[ "${VITE_FIREBASE_PROJECT_ID}" == "${PROD_PROJECT}" ]] || die "VITE_FIREBASE_PROJECT_ID is '${VITE_FIREBASE_PROJECT_ID}', expected ${PROD_PROJECT}"

# --- Step 5: install and sync ------------------------------------------------

step "npm ci and sync"
before="$(git status --porcelain)"
if [[ -n "${FAKE}" ]]; then
  if [[ -n "${CI_SCRIPTS_INSTALL_CMD:-}" ]]; then ( cd client && eval "${CI_SCRIPTS_INSTALL_CMD}" ) || die "npm ci (hook) failed"; else echo "npm ci skipped (seam)"; fi
  if [[ -n "${CI_SCRIPTS_SYNC_CMD:-}" ]]; then ( cd client && eval "${CI_SCRIPTS_SYNC_CMD}" ) || die "sync (hook) failed"; else echo "sync skipped (seam)"; fi
else
  ( cd client && npm ci --fetch-timeout=120000 ) || die "npm ci failed"
  ( cd client && npm run sync:ios ) || die "npm run sync:ios failed"
fi

# --- Step 6: nothing tracked changed -----------------------------------------
# cap sync regenerates CapApp-SPM/Package.swift. Xcode Cloud reads
# Package.resolved as is, so a manifest that differs from the committed one
# would be resolved against a lock file for a different graph.

step "Clean tree"
changed="$(comm -13 <(echo "${before}" | sort) <(git status --porcelain | sort))"
if [[ -n "${changed}" ]]; then
  echo "${changed}"; git --no-pager diff; die "the sync modified tracked files (above); the generator's output differs from what is committed"
fi
echo "ok: no tracked file changed"

# --- Step 7: the bundle names production -------------------------------------

step "Bundle"
[[ -f "${BUNDLE_DIR}/index.html" ]] || die "${BUNDLE_DIR}/index.html missing after the sync"
prod_hits="$({ grep -rl "${PROD_PROJECT}" "${BUNDLE_DIR}" || true; } | wc -l | tr -d ' ')"
dev_hits="$({ grep -rlE "${DEV_ID_RE}" "${BUNDLE_DIR}" || true; } | wc -l | tr -d ' ')"
[[ "${prod_hits}" -gt 0 ]] || die "no file under ${BUNDLE_DIR} names ${PROD_PROJECT}"
[[ "${dev_hits}" -eq 0 ]]  || die "${dev_hits} file(s) under ${BUNDLE_DIR} name the dev project"
echo "ok: bundle names ${PROD_PROJECT} and not glim-dev"

# --- Step 8: what Xcode will resolve against ---------------------------------

step "Package.resolved pins"
{ grep -oE '"identity" : "[^"]+"' client/ios/App/App.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved || true; } | sed -E 's/.*: "(.*)"/  \1/'
step "ci_post_clone done"
