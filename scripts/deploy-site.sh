#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# Title:       deploy-site.sh
# Project:     Glim
# Author:      Reina Hastings (reinahastings13@gmail.com)
# Created:     2026-09-22
# Purpose:     Publishes site/ (the privacy policy and a landing page) to
#              Firebase Hosting on the PRODUCTION project, in the pattern of
#              deploy-rules.sh: repo root, committed content only, the project
#              id printed and passed explicitly, a person at the keyboard. The
#              site exists only on production because it would serve the same
#              text anywhere; there is deliberately no -e flag.
#
#              It refuses to publish a page that still carries the
#              CONTACT_EMAIL_TBD placeholder, and after deploying it fetches
#              every live page and compares it byte for byte with the
#              committed file, so "deployed" means the right pages are live on
#              the right project.
#
# Inputs:      site/            the pages (must be committed and clean)
#              firebase.json    hosting.public must be "site"
#              A logged-in Firebase CLI session (`firebase login`).
# Outputs:     The site live at https://glim-da8c2.web.app/ . Writes no
#              tracked file; describe a site change in the PR that made it.
#
# Usage:       scripts/deploy-site.sh          # deploy, after a typed confirmation
#              scripts/deploy-site.sh -n       # dry run: run every check, deploy nothing
#              scripts/deploy-site.sh -h
# -----------------------------------------------------------------------------

set -euo pipefail

# --- Constants ---------------------------------------------------------------

FIREBASE_TOOLS="firebase-tools@15.30.2"
PROJECT="glim-da8c2"
SITE_DIR="site"
POLICY="privacy.html"
URL="https://${PROJECT}.web.app"
PLACEHOLDER="CONTACT_EMAIL_TBD"

DRY_RUN=0

# --- Usage -------------------------------------------------------------------

usage() {
  cat <<'USAGE'
Publish site/ to Firebase Hosting on glim-da8c2. Run from anywhere in the repo.

  -n   Dry run. Runs every check and prints what would be deployed; deploys nothing.
  -h   Show this message.
USAGE
}

die()  { echo "ERROR: $*" >&2; exit 1; }
step() { printf '\n=== %s ===\n' "$*"; }

while getopts ":nh" opt; do
  case "${opt}" in
    n) DRY_RUN=1 ;;
    h) usage; exit 0 ;;
    \?) echo "ERROR: unknown option -${OPTARG}" >&2; usage >&2; exit 2 ;;
  esac
done

# --- Always work from the repo root ------------------------------------------

command -v git  >/dev/null 2>&1 || die "git not found"
command -v node >/dev/null 2>&1 || die "node not found"
command -v curl >/dev/null 2>&1 || die "curl not found"
cd "$(git rev-parse --show-toplevel)"
[[ -d "${SITE_DIR}" ]] || die "${SITE_DIR}/ not found at the repo root"
[[ -f "${SITE_DIR}/${POLICY}" ]] || die "${SITE_DIR}/${POLICY} not found"

# --- Checks ------------------------------------------------------------------

# A real deploy needs a person at a keyboard. -n changes nothing and may run anywhere.
if [[ "${DRY_RUN}" -eq 0 ]]; then
  [[ -z "${CI:-}" ]] || die "refusing to deploy with CI set. CI never deploys the site."
  [[ -t 0 ]]         || die "refusing to deploy without a terminal on stdin."
fi

# firebase.json must point Hosting at site/, and nothing else.
public="$(node -e 'const c=JSON.parse(require("fs").readFileSync("firebase.json","utf8")); process.stdout.write(String(c.hosting && c.hosting.public))')"
[[ "${public}" == "${SITE_DIR}" ]] || die "firebase.json hosting.public is '${public}', expected '${SITE_DIR}'"

# The placeholder must be gone before the page is public.
if grep -rl "${PLACEHOLDER}" "${SITE_DIR}" >/dev/null 2>&1; then
  grep -rn "${PLACEHOLDER}" "${SITE_DIR}" >&2
  die "${PLACEHOLDER} is still in ${SITE_DIR}/; set the contact address before publishing."
fi

# Deploy what is committed.
dirty="$(git status --porcelain -- "${SITE_DIR}" firebase.json)"
if [[ -n "${dirty}" ]]; then
  echo "${dirty}" >&2
  die "uncommitted changes under ${SITE_DIR}/ or in firebase.json. Commit them first."
fi

head="$(git rev-parse --short HEAD)"
step "Target"
echo "Project id:   ${PROJECT}"
echo "URL:          ${URL}/"
echo "Commit:       ${head} ($(git rev-parse --abbrev-ref HEAD))"
echo "Files:";  ( cd "${SITE_DIR}" && find . -type f ! -name '.*' | sort | sed 's/^/  /' )

if [[ "${DRY_RUN}" -eq 1 ]]; then
  echo ""
  echo "Dry run: every check passed; nothing was deployed."
  exit 0
fi

# --- Confirm and deploy ------------------------------------------------------

echo ""
echo "This publishes the pages above on the production site. Type the project id to continue:"
reply=""
read -r reply || reply=""
[[ "${reply}" == "${PROJECT}" ]] || die "confirmation did not match '${PROJECT}'; nothing was deployed."

step "Deploy"
npx --yes "${FIREBASE_TOOLS}" deploy --only hosting --project "${PROJECT}"

# --- Verify the live page is the committed one --------------------------------

step "Verify"
live="$(mktemp)"
trap 'rm -f "${live}"' EXIT
# Every deployed file, not only the policy: a wrong root page is as public.
while IFS= read -r f; do
  curl -fsSL "${URL}/${f}" -o "${live}" || die "could not fetch ${URL}/${f} after deploying"
  if cmp -s "${live}" "${SITE_DIR}/${f}"; then
    echo "Live ${URL}/${f} is byte-identical to the committed ${SITE_DIR}/${f}."
  else
    die "live ${URL}/${f} differs from the committed file (CDN cache lag? retry in a minute; if it persists, check the project)."
  fi
done < <(cd "${SITE_DIR}" && find . -type f ! -name '.*' | sed 's|^\./||' | sort)

step "Done"
