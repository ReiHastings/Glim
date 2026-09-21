# Firestore rules deploy log

One line per deploy, appended by `scripts/deploy-rules.sh`. This file is the record of which
version of `firestore.rules` is live in each Firebase project; commit it after every deploy.
`scripts/deploy-rules.sh -s` reads it. The "rules blob" is `git hash-object firestore.rules`,
which identifies the exact content deployed.

Before 2026-09-21 rules were pasted into the Firebase console by hand. Both projects were
confirmed to carry the repo's ruleset on 2026-09-19.

| when (UTC) | alias | project | commit | rules blob |
|---|---|---|---|---|
| 2026-09-21T18:47:01Z | dev | glim-dev | 0da2c39 | c2d970a34e0c7e3448a4a052ff1b6c9354ba7554 |
| 2026-09-21T18:47:13Z | prod | glim-da8c2 | 0da2c39 | c2d970a34e0c7e3448a4a052ff1b6c9354ba7554 |
| 2026-09-21T19:16:06Z | dev | glim-dev | 8443241 | 96bacce301b759ba3425b8d385c6b5de097f273a |
| 2026-09-21T19:16:28Z | prod | glim-da8c2 | 8443241 | 96bacce301b759ba3425b8d385c6b5de097f273a |
