#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# Title:       ios-dev.sh
# Project:     Glim
# Author:      Reina Hastings (reinahastings13@gmail.com)
# Created:     2026-09-19
# Purpose:     Builds and installs the side-by-side iOS DEV app
#              (com.reihastings.glim.dev) without disturbing the production app
#              (com.reihastings.glim) already on the device. The two are
#              separate iOS applications: separate icons, separate data
#              containers, separate HealthKit authorisations, separate Firebase
#              projects. Nothing this script does touches the production app or
#              production data.
#
#              Everything that differs between the two builds is applied as a
#              command-line build-setting override, so project.pbxproj is never
#              modified and the production build path is exactly as it was.
#
# Inputs:      client/.env.nativedev.local
#                  glim-dev Firebase web credentials (gitignored).
#              client/ios/App/App/GoogleService-Info-dev.plist
#                  glim-dev iOS app config, downloaded from the Firebase
#                  console after registering an iOS app with bundle id
#                  com.reihastings.glim.dev (gitignored).
#              client/ios/App/App/GoogleService-Info-prod.plist
#                  the production copy, used to restore state on exit
#                  (gitignored).
#              A connected, trusted iPhone with Developer Mode enabled.
#
# Outputs:     The dev app installed on the connected device.
#              ~/Library/Developer/Xcode/DerivedData/glim-ios-dev/
#                  derived data for dev builds only; outside the repo on
#                  purpose (see DERIVED below). Safe to delete.
#              On exit the working tree is restored to production state:
#              the production GoogleService-Info.plist is put back and the
#              production web bundle is rebuilt and re-synced, so a subsequent
#              Xcode Run or Archive ships production. Skip with -n.
#
# Usage:       cd client
#              ./scripts/ios-dev.sh -l                 # list connected devices
#              ./scripts/ios-dev.sh                    # build + install
#              ./scripts/ios-dev.sh -d 00008120-XXXX   # target one device
#              ./scripts/ios-dev.sh -b                 # build only, no install
#              ./scripts/ios-dev.sh -n                 # skip the prod restore
# -----------------------------------------------------------------------------

set -euo pipefail

# --- Constants ---------------------------------------------------------------

DEV_BUNDLE_ID="com.reihastings.glim.dev"
DEV_APPICON="AppIcon-Dev"
SCHEME="App"
CONFIGURATION="Debug"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLIENT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
IOS_DIR="${CLIENT_DIR}/ios"
PROJECT="${IOS_DIR}/App/App.xcodeproj"
APP_DIR="${IOS_DIR}/App/App"
# Derived data MUST live outside the repo. /Users/reina/Documents is an
# iCloud Drive file-provider domain (Desktop & Documents sync), and the sync
# daemon stamps com.apple.FinderInfo and com.apple.fileprovider.fpfs#P onto
# directories it manages. codesign refuses to sign a bundle carrying those
# ("resource fork, Finder information, or similar detritus not allowed"), so a
# derived-data path inside the project fails every time, at the final CodeSign
# step, after several minutes of compiling. Xcode's own default DerivedData is
# outside Documents, which is why GUI builds have never hit this.
DERIVED="${HOME}/Library/Developer/Xcode/DerivedData/glim-ios-dev"

PLIST_LIVE="${APP_DIR}/GoogleService-Info.plist"
PLIST_DEV="${APP_DIR}/GoogleService-Info-dev.plist"
PLIST_PROD="${APP_DIR}/GoogleService-Info-prod.plist"
INFO_PLIST="${APP_DIR}/Info.plist"
PB="/usr/libexec/PlistBuddy"

DEVICE_ID=""
BUILD_ONLY=0
RESTORE=1
LIST_ONLY=0

# --- Usage -------------------------------------------------------------------

usage() {
  cat <<'USAGE'
Build and install the Glim DEV app (com.reihastings.glim.dev) side by side with
the production app. Run from the client/ directory.

  -d <device>  Target device UDID or name. Default: the only connected device.
  -l           List connected devices and exit.
  -b           Build only; do not install.
  -n           Do not restore production state on exit. Use only if the very
               next thing you do is another dev build. NEVER archive after -n
               without running `npm run sync:ios` first: the bundle would carry
               glim-dev credentials.
  -h           Show this message.
USAGE
}

while getopts ":d:lbnh" opt; do
  case "${opt}" in
    d) DEVICE_ID="${OPTARG}" ;;
    l) LIST_ONLY=1 ;;
    b) BUILD_ONLY=1 ;;
    n) RESTORE=0 ;;
    h) usage; exit 0 ;;
    \?) echo "ERROR: unknown option -${OPTARG}" >&2; usage >&2; exit 2 ;;
    :)  echo "ERROR: -${OPTARG} requires an argument" >&2; exit 2 ;;
  esac
done

die() { echo "ERROR: $*" >&2; exit 1; }
step() { printf '\n=== %s ===\n' "$*"; }

# --- List devices and exit ---------------------------------------------------

if [[ "${LIST_ONLY}" -eq 1 ]]; then
  xcrun devicectl list devices
  exit 0
fi

# --- Preflight ---------------------------------------------------------------
# Every one of these is a condition that would otherwise fail deep inside a
# build, or worse, succeed and produce an app pointing at the wrong project.

step "Preflight"

command -v xcodebuild >/dev/null 2>&1 || die "xcodebuild not found. Install Xcode command line tools."
[[ -x "${PB}" ]] || die "PlistBuddy not found at ${PB}"
[[ -d "${PROJECT}" ]] || die "Xcode project not found at ${PROJECT}"
[[ -d "${APP_DIR}/Assets.xcassets/${DEV_APPICON}.appiconset" ]] \
  || die "Dev app icon '${DEV_APPICON}' is missing from Assets.xcassets."

[[ -f "${CLIENT_DIR}/.env.nativedev.local" ]] \
  || die ".env.nativedev.local is missing. The dev app would be built with production credentials."

[[ -f "${PLIST_DEV}" ]] || die "$(cat <<EOF
${PLIST_DEV} is missing.

Register an iOS app in the glim-dev Firebase console with bundle id
${DEV_BUNDLE_ID}, download GoogleService-Info.plist, and save it
as GoogleService-Info-dev.plist in ${APP_DIR}.
EOF
)"

# Keep a pristine production copy the first time we run, so the restore at the
# end has something to put back.
if [[ ! -f "${PLIST_PROD}" ]]; then
  [[ -f "${PLIST_LIVE}" ]] || die "Neither ${PLIST_PROD} nor ${PLIST_LIVE} exists; cannot establish a production baseline."
  cp "${PLIST_LIVE}" "${PLIST_PROD}"
  echo "Saved production baseline -> $(basename "${PLIST_PROD}")"
fi

# Guard against the dev plist being a copy of the production one, which would
# quietly build a 'dev' app that writes to live user data.
dev_project="$("${PB}" -c 'Print :PROJECT_ID' "${PLIST_DEV}" 2>/dev/null || true)"
prod_project="$("${PB}" -c 'Print :PROJECT_ID' "${PLIST_PROD}" 2>/dev/null || true)"
[[ -n "${dev_project}" ]] || die "Could not read PROJECT_ID from ${PLIST_DEV}"
[[ "${dev_project}" != "${prod_project}" ]] \
  || die "${PLIST_DEV} has PROJECT_ID '${dev_project}', the same as production. Download the glim-dev one."

dev_bundle="$("${PB}" -c 'Print :BUNDLE_ID' "${PLIST_DEV}" 2>/dev/null || true)"
[[ "${dev_bundle}" == "${DEV_BUNDLE_ID}" ]] \
  || die "${PLIST_DEV} is registered to bundle id '${dev_bundle}', expected '${DEV_BUNDLE_ID}'."

echo "Dev Firebase project: ${dev_project}"
echo "Prod Firebase project: ${prod_project:-unknown}"

# --- Register the dev Google sign-in URL scheme ------------------------------
# Native Google sign-in redirects back to REVERSED_CLIENT_ID://. The production
# scheme is already in Info.plist; the dev app needs its own. Both can be
# registered at once, and iOS routes each to whichever app claims it, so this
# is an idempotent add rather than a swap. Info.plist is tracked, so this is
# the one source change the dev build needs, and it is made once.

step "URL scheme"

dev_scheme="$("${PB}" -c 'Print :REVERSED_CLIENT_ID' "${PLIST_DEV}" 2>/dev/null || true)"
[[ -n "${dev_scheme}" ]] || die "No REVERSED_CLIENT_ID in ${PLIST_DEV}"

if "${PB}" -c 'Print :CFBundleURLTypes:0:CFBundleURLSchemes' "${INFO_PLIST}" | grep -qF "${dev_scheme}"; then
  echo "Already registered: ${dev_scheme}"
else
  "${PB}" -c "Add :CFBundleURLTypes:0:CFBundleURLSchemes: string ${dev_scheme}" "${INFO_PLIST}"
  echo "Added to Info.plist: ${dev_scheme}"
  echo "NOTE: Info.plist is tracked by git. Commit this change."
fi

# --- Restore production state on exit ----------------------------------------
# Registered before anything is swapped. Without it, an interrupted run leaves
# the tree holding dev credentials and dev web assets, and the next Xcode
# Archive would ship them.

restore_production() {
  local status=$?
  if [[ "${RESTORE}" -eq 1 ]]; then
    step "Restoring production state"
    cp "${PLIST_PROD}" "${PLIST_LIVE}"
    ( cd "${CLIENT_DIR}" && npm run sync:ios >/dev/null 2>&1 ) \
      && echo "Production plist and web bundle restored." \
      || echo "WARNING: production restore FAILED. Run 'npm run sync:ios' before archiving." >&2
  else
    echo ""
    echo "WARNING: -n given, tree still holds DEV state."
    echo "         Run 'npm run sync:ios' before any Xcode Run or Archive."
  fi
  exit "${status}"
}
trap restore_production EXIT

# --- Build the web bundle against glim-dev -----------------------------------

step "Web bundle (mode nativedev)"
cp "${PLIST_DEV}" "${PLIST_LIVE}"
( cd "${CLIENT_DIR}" && npm run sync:ios:dev )

# --- Strip extended attributes -----------------------------------------------
# codesign refuses to sign a bundle containing files that carry extended
# attributes, with "resource fork, Finder information, or similar detritus not
# allowed". A GoogleService-Info.plist downloaded through a browser arrives
# with com.apple.quarantine and com.apple.provenance, `cp` preserves them, and
# `cap sync` copies the file straight into the bundle. Same for anything else
# dragged in through Finder or a download.
#
# Cleared after the sync, so it also covers whatever cap sync just copied into
# App/public. Removing these attributes has no effect other than to let the
# signature be computed; the files' contents are untouched.

step "Clearing extended attributes"
xattr -cr "${APP_DIR}"
echo "Cleared on ${APP_DIR}"

# --- Build the app -----------------------------------------------------------
# The three overrides are the whole of the difference from a production build.
# -allowProvisioningUpdates lets automatic signing create the App ID for the new
# bundle id on first run, including its HealthKit entitlement.

step "Xcode build (${DEV_BUNDLE_ID})"

build_args=(
  -project "${PROJECT}"
  -scheme "${SCHEME}"
  -configuration "${CONFIGURATION}"
  -derivedDataPath "${DERIVED}"
  -allowProvisioningUpdates
  PRODUCT_BUNDLE_IDENTIFIER="${DEV_BUNDLE_ID}"
  ASSETCATALOG_COMPILER_APPICON_NAME="${DEV_APPICON}"
)

if [[ -n "${DEVICE_ID}" ]]; then
  build_args+=(-destination "id=${DEVICE_ID}")
else
  build_args+=(-destination "generic/platform=iOS")
fi

xcodebuild "${build_args[@]}" build

APP_PATH="${DERIVED}/Build/Products/${CONFIGURATION}-iphoneos/App.app"
[[ -d "${APP_PATH}" ]] || die "Build reported success but ${APP_PATH} does not exist."

built_id="$("${PB}" -c 'Print :CFBundleIdentifier' "${APP_PATH}/Info.plist")"
[[ "${built_id}" == "${DEV_BUNDLE_ID}" ]] \
  || die "Built app has bundle id '${built_id}', expected '${DEV_BUNDLE_ID}'. Refusing to install."
echo "Built: ${APP_PATH} (${built_id})"

if [[ "${BUILD_ONLY}" -eq 1 ]]; then
  step "Done (build only)"
  exit 0
fi

# --- Install -----------------------------------------------------------------

step "Install"

if [[ -z "${DEVICE_ID}" ]]; then
  DEVICE_ID="$(xcrun devicectl list devices 2>/dev/null \
    | awk '/connected/ {print $(NF-1)}' | head -1)"
  [[ -n "${DEVICE_ID}" ]] \
    || die "No connected device found. Plug the iPhone in, or pass -d <udid>. Use -l to list."
  echo "Device: ${DEVICE_ID}"
fi

xcrun devicectl device install app --device "${DEVICE_ID}" "${APP_PATH}"

step "Done"
echo "The dev app (amber corner wedge) is installed alongside the production app."
echo "It signs in to ${dev_project} and shares no data with the production app."
