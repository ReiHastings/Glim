# Releasing Glim to TestFlight

The human half of the release process. The script half is
`scripts/release-preflight.sh`. Run every release the same way, in this order;
if a step has to be improvised, add it here in the same pull request.
Design and reasoning: `docs/plan_stage2_release.md` (local notes, not in the
repo). Spec Section 4.3 is the source of this list.

Words used below: a **build** is one upload to App Store Connect, numbered by
`CURRENT_PROJECT_VERSION`, which only ever goes up and never resets. A
**version** (`MARKETING_VERSION`, `X.Y.Z`) is what testers see and is held
across several builds; a new version sends the next external build back
through Beta App Review, so bump it when a set of changes deserves a name, not
per upload. Every upload gets a **tag** `vX.Y.Z-bN` on the exact commit
archived. A pushed tag is never moved or deleted.

## 0. Why the process has this shape

Four facts explain every step below; the long version, with a worked
example, is in `docs/glim_environment.Rmd` Section 2.

- **Xcode does not run Vite.** The archive contains whatever
  `client/ios/App/App/public/` holds on disk, however old. Preflight `-v`
  rebuilds it from `HEAD` and fingerprints it; nothing may sync afterwards.
- **The archive is made later than the check.** On the cloud this gap does
  not exist: Apple clones the tagged commit and `ci_post_clone.sh` builds the
  bundle from it, with the same checks `-v` makes. On the manual fallback,
  `-a` fingerprints the bundle inside the archive and compares it with
  `-v`'s receipt.
- **Friends run old builds for weeks.** Rules go live before the client that
  needs them, and a tightening waits until the old client is gone.
- **A new version means a Beta App Review; a new build of the same version
  usually does not.** Hold the version across a testing cycle; the build
  number is the counter that always moves.

The dev app (`ios-dev.sh`, amber icon, `glim-dev`) is where a feature is
tried before it is merged. It never goes through TestFlight, and its only
part in this file is the residue it can leave in the tree, which preflight
checks 7 and 9 catch on this Mac and which a clean clone never has.

## 1. Decide what ships

0. Read **Next Build Number** in App Store Connect (Xcode Cloud > Settings >
   Build Number). That is N for this release. Xcode Cloud numbers its builds
   from that counter; the project file and the changelog must say the same
   number, and the cloud refuses the build if they do not. A failed cloud
   build consumes a counter value, so read it again before every retry.
1. If this is a new version: in `CHANGELOG.md`, turn `[Unreleased]` into
   `## [X.Y.Z] - YYYY-MM-DD` and start a fresh `[Unreleased]` above it; in
   Xcode, Targets > App > General > Identity, set **Version**.
2. Always: set **Build** to N (never reuse a number, even after a failed
   upload), and add `- build N: <what it is>` as the **first** build
   line under the version heading (newest first; preflight reads the first
   build line in the file as the current build). Write the previous build's outcome (smoke test, review result,
   expired) on its own line now.
3. If `site/` changed since the last tag: `scripts/deploy-site.sh` before this
   PR is merged, so the live policy never lags the manifest. This publishes
   committed but not yet merged content on purpose; the script prints the
   branch so that is visible. If the data types changed, the table in
   Section 9 changes too.
4. Commit on a branch, open the PR, wait for CI, merge. Ordinary approval.

## 2. Rules ordering, if `firestore.rules` changed since the last tag

Live users run old builds for weeks (installs are self-paced and builds live
90 days). A rules change and the client that depends on it cannot land
together (`docs/glim_environment.Rmd` Section 5, step 4):

1. The rules version that is valid for **both** old and new clients must
   already be live on both projects: `scripts/deploy-rules.sh -e both`, logged
   in `RULES_DEPLOYS.md`.
2. Only then upload the client that depends on it.
3. **A tightening PR is not merged until it can be deployed**, which means
   until the external group has moved off the old client. Until then it waits
   as an open PR. If it is merged early, preflight check 3 blocks every release
   in between; that is the check doing its job, and the fix is to deploy or
   revert, never to skip the check.

## 3. Preflight

```
scripts/release-preflight.sh -v X.Y.Z
```

Must print `PASS`. It rebuilds the web bundle from `HEAD` itself, which is
worth the ninety seconds even though the cloud rebuilds from scratch: a
`.env.local` or `ios-dev.sh` problem on this Mac shows up here, before a
counter value is spent. Every `FAIL` line names its fix. `-n` runs the same
checks without failing, for a look.

## 4. Tag, which starts the build

```
git tag -a vX.Y.Z-bN -m "Glim X.Y.Z build N"
git push origin vX.Y.Z-bN
scripts/release-preflight.sh -v X.Y.Z      # again; it now verifies the tag
```

The push is the trigger. Xcode Cloud's "Release" workflow starts within a
minute or two on any tag beginning with `v`; nothing else starts it, and a
merge to `main` never does. Progress: Xcode's Report navigator > Cloud tab,
or App Store Connect > Xcode Cloud > Builds.

## 5. Wait

About three minutes. On Apple's machine, `ci_post_clone.sh` installs Node,
writes the production plist and `.env.local` from the workflow's variables,
runs `npm ci` and the sync, and refuses the build if the tag, the project
file, the changelog and the counter disagree, if the sync changed a tracked
file, or if the bundle names the dev project. Xcode archives. Then
`ci_post_xcodebuild.sh` runs the archive checks (version and build, bundle
id, export key, web bundle, Google plist, privacy manifest, embedded
frameworks) and writes What to Test from the changelog.

- **Green:** the build appears in TestFlight under the Reina group with its
  What to Test text. Continue at Section 6.
- **Red:** open the build, Logs, and read the first `ERROR:` or `FAIL` line;
  the scripts say what to fix. The counter value is spent and the cloud
  refuses manual rebuilds, so a retry, even for an Apple-side flake, is a
  full cycle: read the counter again (Section 1 step 0), bump the project
  and changelog, commit, PR, CI, preflight, new tag. Budget twenty minutes
  plus CI. Never move a tag.

## 5b. Manual fallback, for the day Xcode Cloud is down

The pre-cloud path still works and `-a` still exists for it:

1. If any Swift package changed since the last archive: File > Packages >
   Reset Package Caches, wait, then Product > Clean Build Folder (a clean
   alone does not touch package state). If the GUI will not build, the
   terminal is equivalent:
   ```
   cd client/ios/App && xcodebuild archive -project App.xcodeproj -scheme App \
     -configuration Release -destination 'generic/platform=iOS' \
     -archivePath ~/Library/Developer/Xcode/Archives/$(date +%F)/Glim-X.Y.Z-bN.xcarchive \
     -derivedDataPath ~/Library/Developer/Xcode/DerivedData/glim-archive -allowProvisioningUpdates
   ```
2. Destination Any iOS Device (arm64), Product > Archive.
3. ```
   scripts/release-preflight.sh -a "$(ls -td ~/Library/Developer/Xcode/Archives/*/*.xcarchive | head -1)"
   ```
   must print `PASS` (archive names contain an invisible narrow space, so a
   pasted path does not resolve; this picks the newest).
4. Organizer > Distribute App > **App Store Connect** (not "TestFlight
   Internal Only", which can never reach the external group) > Upload. Untick
   "Manage Version and Build Number" if the dialog offers it, and upload each
   archive once.
5. This Mac's Xcode is not the cloud's Xcode, so the binary differs in
   toolchain; the framework allowlist in `-a` is the check that covers both.
6. **Afterwards, set Next Build Number in App Store Connect to at least N+1**
   and note it on the changelog line. The cloud counter does not know about a
   manual upload; without this, the next cloud build reuses a number and App
   Store Connect rejects it.

## 6. Internal group

1. In App Store Connect > TestFlight, the build appears under the internal
   group "Reina" (the Release workflow's post-action puts it there; for a
   manual upload, the group's automatic distribution does). Install it from
   the TestFlight app on the phone.
2. Smoke test against production: sign in with Google; existing data is
   visible; one write of each kind (water, a food, a journal entry, a symptom)
   survives a force-quit and reopen; the Health step import runs.
3. First build of a new version only: answer the export compliance question
   if App Store Connect still asks (with the `Info.plist` key it should not),
   and check the processing email for an `ITMS-91053` notice. Either goes on
   the changelog line and, for `ITMS-91053`, the named API category gets a
   reason added to `PrivacyInfo.xcprivacy` for the next build.

## 7. External group

1. Assign the build to "Friends and family" and write its **What to Test**
   text. This is per build and testers see it; a stale copy-paste is the
   easiest thing to get wrong at three uploads a week.
2. First time only, fill Test Information: beta description, feedback email,
   privacy policy URL `https://glim-da8c2.web.app/privacy.html`, **Sign-in
   required** with the review Google account's email and password, and notes
   saying the app reads step counts from Apple Health with permission and
   works without it. Then submit for Beta App Review.
3. The first build of each new version may be reviewed again (hours to a day
   or two). Later builds of the same version usually go straight out.
4. Testers are invited by email, not public link; they install TestFlight
   once, accept, and sign in with their own Google account.

## 8. Expiry and bad builds

- Every build expires 90 days after upload. Any build older than 75 days with
  no successor is a reason to release, feature or not.
- A build found broken after distribution: in App Store Connect, TestFlight >
  the build > **Expire**. New installs stop and testers are told. Note it on
  the changelog line and ship the next build. Rules are never loosened to
  accommodate a bad client.

## 9. Data types: one list, three places

This table, `client/ios/App/App/PrivacyInfo.xcprivacy`, and the `<li
data-type>` items in `site/privacy.html` must agree
(`client/tests/privacy_agreement.test.mjs` checks the files), and so must the
App Privacy answers in App Store Connect when the app goes to the store.

| Apple data type | What in Glim | Linked | Purpose |
|---|---|---|---|
| Health | steps read from Apple Health; water, nutrition, symptom and cycle entries the user types | yes | App Functionality |
| Other User Content | journal entries | yes | App Functionality |
| Email Address | from Google sign-in | yes | App Functionality |
| Name | from Google sign-in | yes | App Functionality |
| User ID | the Firebase uid | yes | App Functionality |

Steps are Health rather than Fitness because they come from the HealthKit
API, which Apple's Health definition names, and Glim frames them as daily
wellness rather than exercise. Nothing is used for tracking.

## 10. Account deletion requests

The promise in the policy is fourteen days. In the Firebase console for
`glim-da8c2`:

1. Authentication > Users: find the account by email, delete it.
2. Firestore > `users/{uid}`: delete the document **and its subcollections**
   (the console offers this on the document's menu; a plain document delete
   leaves the subcollections behind).
3. Reply to confirm. The copy in the tester's own phone is theirs to remove by
   deleting the app; the policy says so.

## Running the release tests by hand

`npm test` runs the preflight self-test on a Mac (it needs PlistBuddy); on the
Linux CI runner that row is reported `SKIP (darwin only)` and counted
separately. `npm test -- --only release_preflight` on Linux therefore selects
nothing and exits non-zero, which is the runner's normal "nothing selected"
rule, not a failure of the test.

## What the cloud does not do

Reading the counter, assigning a build to the external group and rewriting
its What to Test if the generated text is not right, the Beta App Review
submission, expiring bad builds, and raising the counter after a manual
upload are all by hand. The workflow's seven environment variables (the six
`VITE_FIREBASE_*` values and the production Google plist as base64) are
entered in App Store Connect, not in the repo; when the repo goes private,
committing the plist and dropping that variable is a one-line change in
`ci_post_clone.sh`.
