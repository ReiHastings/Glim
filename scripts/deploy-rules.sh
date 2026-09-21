#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# Title:       deploy-rules.sh
# Project:     Glim
# Author:      Reina Hastings (reinahastings13@gmail.com)
# Created:     2026-09-21
# Purpose:     Publishes firestore.rules to a named Firebase project, replacing
#              console pasting. It exists to make the TARGET impossible to get
#              wrong by accident: the alias is resolved to a project id once,
#              printed, and that id (never the alias) is what the CLI receives;
#              production additionally requires typing the project id back.
#              Rules are evaluated against the emulator (`npm test`) on this
#              machine before every deploy, and every deploy is recorded in
#              RULES_DEPLOYS.md, which is tracked in git.
#
#              A CLI deploy REPLACES the live ruleset. The repo file is the
#              whole truth; an edit made only in the Firebase console is lost
#              on the next deploy. The console is read-only by convention.
#
# Inputs:      firestore.rules   the ruleset (must be committed and clean)
#              firebase.json     tells the CLI where the rules file is
#              .firebaserc       alias -> project id (dev, prod)
#              A logged-in Firebase CLI session (`firebase login`) for deploys
#              and for -n. Java 21+ for the pre-deploy test run.
# Outputs:     The ruleset live on the target project(s).
#              RULES_DEPLOYS.md  one appended line per deploy; commit it.
#
# Usage:       scripts/deploy-rules.sh -e both        # the normal path: dev, pause, prod
#              scripts/deploy-rules.sh -e dev         # re-deploy one project
#              scripts/deploy-rules.sh -e prod -n     # dry run: validate against prod, deploy nothing
#              scripts/deploy-rules.sh -s             # status: last logged deploy per alias
#              scripts/deploy-rules.sh -h
# -----------------------------------------------------------------------------

set -euo pipefail

# --- Constants ---------------------------------------------------------------

FIREBASE_TOOLS="firebase-tools@15.30.2"
RULES_FILE="firestore.rules"
CONFIG_FILES=("${RULES_FILE}" "firebase.json" ".firebaserc")
LOG_FILE="RULES_DEPLOYS.md"

TARGET=""
ASSUME_YES=0
DRY_RUN=0
STATUS=0

# --- Usage -------------------------------------------------------------------

usage() {
  cat <<'USAGE'
Publish firestore.rules to a Firebase project. Run from anywhere in the repo.

  -e <alias>  dev, prod, or both (dev first, a pause, then prod)
  -n          Dry run. Resolves and prints the target and asks the Firebase CLI
              to validate the rules against that project. Deploys nothing.
              Needs a logged-in CLI and network access.
  -s          Status. Prints the last logged deploy per alias and whether it
              matches the COMMITTED firestore.rules (HEAD). Offline; changes
              nothing; takes no other options.
  -y          Skip the typed confirmation for prod. Never honoured in CI or
              without a terminal, and rejected together with -e both.
  -h          Show this message.
USAGE
}

die()  { echo "ERROR: $*" >&2; exit 1; }
step() { printf '\n=== %s ===\n' "$*"; }

while getopts ":e:ynsh" opt; do
  case "${opt}" in
    e) TARGET="${OPTARG}" ;;
    y) ASSUME_YES=1 ;;
    n) DRY_RUN=1 ;;
    s) STATUS=1 ;;
    h) usage; exit 0 ;;
    \?) echo "ERROR: unknown option -${OPTARG}" >&2; usage >&2; exit 2 ;;
    :)  echo "ERROR: -${OPTARG} requires an argument" >&2; exit 2 ;;
  esac
done

# --- Always work from the repo root ------------------------------------------
# Every path below is root-relative. Without this, running from client/ makes
# the clean-tree pathspecs match nothing and that check passes vacuously.

command -v git  >/dev/null 2>&1 || die "git not found"
command -v node >/dev/null 2>&1 || die "node not found"
cd "$(git rev-parse --show-toplevel)"
for f in "${CONFIG_FILES[@]}"; do [[ -f "${f}" ]] || die "${f} not found at the repo root"; done

# Resolve an alias to a project id by reading .firebaserc ONCE. The id, not the
# alias, is what gets printed, confirmed and passed to the CLI, so there is a
# single resolution and what you read is what is deployed.
resolve_project() {
  node -e '
    const rc = JSON.parse(require("fs").readFileSync(".firebaserc", "utf8"));
    const id = rc.projects && rc.projects[process.argv[1]];
    if (!id) { console.error(`alias "${process.argv[1]}" is not in .firebaserc`); process.exit(4); }
    process.stdout.write(id);
  ' "$1"
}

# The content the CLI will read (working tree) and the content that is committed.
# A deploy requires a clean tree, so there the two are equal by construction.
blob_hash()      { git hash-object "${RULES_FILE}"; }
committed_hash() { git rev-parse "HEAD:${RULES_FILE}"; }

# --- Status mode -------------------------------------------------------------

if [[ "${STATUS}" -eq 1 ]]; then
  if [[ -n "${TARGET}" || "${DRY_RUN}" -eq 1 || "${ASSUME_YES}" -eq 1 ]]; then
    die "-s takes no other options; it reports both aliases and changes nothing."
  fi
  [[ -f "${LOG_FILE}" ]] || die "${LOG_FILE} not found; nothing has been deployed with this script yet"
  current="$(committed_hash)"
  echo "Committed ${RULES_FILE} blob (HEAD): ${current}"
  if [[ "$(blob_hash)" != "${current}" ]]; then
    echo "NOTE: the working copy of ${RULES_FILE} has uncommitted changes; status compares against HEAD, not the working copy."
  fi
  for alias in dev prod; do
    line="$(grep -E "^\| [0-9T:Z-]+ \| ${alias} \|" "${LOG_FILE}" | tail -1 || true)"
    if [[ -z "${line}" ]]; then
      echo "${alias}: no deploy logged"
    else
      logged="$(echo "${line}" | awk -F'|' '{gsub(/ /,"",$6); print $6}')"
      when="$(echo "${line}" | awk -F'|' '{gsub(/ /,"",$2); print $2}')"
      if [[ "${logged}" == "${current}" ]]; then state="MATCHES the committed file"; else state="DIFFERS from the committed file (deployed blob ${logged})"; fi
      echo "${alias}: last deployed ${when}, ${state}"
    fi
  done
  exit 0
fi

# --- Validate the request ----------------------------------------------------

case "${TARGET}" in
  dev|prod|both) ;;
  "") usage >&2; die "-e is required (dev, prod or both). There is deliberately no default." ;;
  *)  die "unknown target '${TARGET}' (expected dev, prod or both)" ;;
esac

if [[ "${TARGET}" == "both" && "${ASSUME_YES}" -eq 1 && "${DRY_RUN}" -eq 0 ]]; then
  die "-y cannot be combined with -e both: an unattended double deploy is exactly what this script exists to prevent"
fi

# A real deploy needs a person at a keyboard. -y does not override this; -n and
# -s change nothing anywhere and are allowed non-interactively.
if [[ "${DRY_RUN}" -eq 0 ]]; then
  [[ -z "${CI:-}" ]] || die "refusing to deploy with CI set. CI never deploys rules."
  [[ -t 0 ]]         || die "refusing to deploy without a terminal on stdin."
fi

# --- Clean tree --------------------------------------------------------------
# The CLI reads all three files from the working tree. Deploy what is committed.

dirty="$(git status --porcelain -- "${CONFIG_FILES[@]}")"
if [[ -n "${dirty}" ]]; then
  if [[ "${DRY_RUN}" -eq 1 ]]; then
    echo "WARNING: uncommitted changes (allowed for a dry run only):"; echo "${dirty}"
  else
    echo "${dirty}" >&2
    die "uncommitted changes in the files the CLI reads. Commit them first, so the log names a commit that contains what was deployed."
  fi
fi

branch="$(git rev-parse --abbrev-ref HEAD)"
head="$(git rev-parse --short HEAD)"
if [[ "${branch}" != "main" ]]; then
  echo "WARNING: on branch '${branch}', not main. The logged commit may exist only on this machine."
elif ! git merge-base --is-ancestor HEAD origin/main 2>/dev/null; then
  echo "WARNING: HEAD is not on origin/main yet. Push before or soon after deploying."
fi

# --- Evaluate the rules before they go live -----------------------------------

if [[ "${DRY_RUN}" -eq 0 ]]; then
  step "Rules tests (npm test, includes the emulator run)"
  ( cd client && npm test ) || die "tests failed; nothing was deployed."
fi

# --- Deploy one alias --------------------------------------------------------

deploy_one() {
  local alias="$1" project hash reply
  project="$(resolve_project "${alias}")" || die "could not resolve alias '${alias}'"
  hash="$(blob_hash)"

  step "Target: ${alias}"
  echo "Project id:   ${project}"
  echo "Commit:       ${head} (${branch})"
  echo "Rules blob:   ${hash}"

  if [[ "${DRY_RUN}" -eq 1 ]]; then
    echo "Dry run: validating against ${project}; nothing will be deployed."
    npx --yes "${FIREBASE_TOOLS}" deploy --only firestore:rules --project "${project}" --dry-run
    return 0
  fi

  if [[ "${alias}" == "prod" && "${ASSUME_YES}" -eq 0 ]]; then
    echo ""
    echo "This REPLACES the live production ruleset. Type the project id to continue:"
    reply=""
    read -r reply || reply=""
    [[ "${reply}" == "${project}" ]] || die "confirmation did not match '${project}'; nothing was deployed."
  fi

  if [[ -n "${DEPLOY_RULES_FAKE:-}" ]]; then
    # Test seam for exercising this script's control flow. Deploys nothing.
    echo "[DEPLOY_RULES_FAKE] would run: npx --yes ${FIREBASE_TOOLS} deploy --only firestore:rules --project ${project}"
  else
    npx --yes "${FIREBASE_TOOLS}" deploy --only firestore:rules --project "${project}"
  fi

  if [[ ! -f "${LOG_FILE}" ]]; then
    die "${LOG_FILE} is missing; the deploy succeeded but was NOT logged. Restore the file and add the line by hand."
  fi
  if [[ -z "${DEPLOY_RULES_FAKE:-}" ]]; then
    printf '| %s | %s | %s | %s | %s |\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${alias}" "${project}" "${head}" "${hash}" >> "${LOG_FILE}"
    echo "Logged in ${LOG_FILE}. Commit it."
  fi
}

# --- Run ---------------------------------------------------------------------

if [[ "${TARGET}" == "both" ]]; then
  deploy_one dev
  if [[ "${DRY_RUN}" -eq 0 ]]; then
    echo ""
    echo "Dev is deployed. Exercise the dev app now: no permission errors, and a write that survives a reload."
    echo "Press Enter to continue to PRODUCTION, or Ctrl-C to stop here."
    read -r _ || die "no input; stopping before production."
  fi
  deploy_one prod
else
  deploy_one "${TARGET}"
fi

step "Done"
