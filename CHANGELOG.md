# Changelog

All notable changes to Glim, the iOS app. Format follows
[Keep a Changelog](https://keepachangelog.com); versions follow
[Semantic Versioning](https://semver.org).

Machine-read by `scripts/release-preflight.sh`, so two lines have a fixed
shape: a version heading is `## [X.Y.Z] - YYYY-MM-DD` (newest first, and
`[Unreleased]` above them all), and each upload is a bullet `- build N: ...`
directly under its version. The build number never resets, across versions
and across the move to Xcode Cloud. A build's outcome (smoke test, review,
expiry) is written on its line when the next build is prepared. Tags are
`vX.Y.Z-bN`, one per upload.

## [Unreleased]

## [1.0.0] - 2026-09-22

The first TestFlight release: the owl-moth companion with water, steps (from
Apple Health), nutrition, journal, symptom and cycle tracking, Google
sign-in, offline-first storage with Firestore sync.

### Added
- An app privacy manifest (`PrivacyInfo.xcprivacy`) and the export-compliance
  key in `Info.plist`; both ship in this build.
- The release process around the app, not in it: `scripts/release-preflight.sh`,
  `RELEASING.md`, the privacy policy at https://glim-da8c2.web.app/privacy.html
  and `scripts/deploy-site.sh`.

### Changed
- The Facebook SDK is no longer linked (a plugin default pulled it in; nothing
  used it).

- build 1: first TestFlight upload, internal group.
