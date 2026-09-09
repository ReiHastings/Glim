# Glim tests

Framework-free invariant tests, run directly with Node. There is still no test
runner (vitest is the intended eventual harness, likely introduced with the
reaction system); until then, tests are standalone `.mjs` scripts that exit
non-zero on failure. The absence of a broader suite is tracked in
`glim_qc_validation.Rmd` Section 5.4.

## Running

From `client/`:

```bash
# Static-analysis guard (no imports): flushSync scope + flush-on-hide wiring
node tests/flushsync_scope.test.mjs

# Behavioral: drives the real useWaterStore (needs the resolve hook so bare Node
# can follow Vite-style extensionless imports in the source)
node --import ./tests/register-hooks.mjs tests/water_softdelete.test.mjs

# Sync scenarios: drives the real syncWater merge code against an in-memory
# Firestore mock (multi-device undo propagation, account-switch config safety)
node --import ./tests/register-sync-mocks.mjs tests/sync_scenarios.test.mjs

# Symptom diary stores: pure store logic (copy semantics, date re-derivation,
# weekly counting, validation, null intensity)
node --import ./tests/register-hooks.mjs tests/symptoms_store.test.mjs

# Mutable-domain sync: real syncSymptoms / syncSymptomsLibrary / categories /
# clear-days / nutrition-library merge code against the Firestore mock (edit
# propagation, concurrent-edit resolution, archiving, fixed-seed-id
# convergence, and the D1 regression: a stale offline edit must not clobber a
# newer remote copy, no push may lower a remote updatedAt, failed pushes retry)
node --import ./tests/register-sync-mocks.mjs tests/symptoms_sync.test.mjs

# Firestore rules structure: one rule per data path, mutable collections gated
node tests/firestore_rules.test.mjs

# Symptom diary Phase 1.5: intensity null policy, categories as entities and the
# legacy migration, clear-day records, and the settings round trip
node --import ./tests/register-hooks.mjs tests/symptoms_phase15.test.mjs
```

## Files

- `flushsync_scope.test.mjs` - locks the CRITICAL invariant that `flushSync()`
  pushes ONLY the four WRITE-ONCE entry logs (journal, water, steps, nutrition)
  and never a mutable id-keyed domain, a last-write-wins config doc, or the
  pokes counter. Being id-keyed is not what makes a blind push safe; write-once
  is: a stale push of a mutable row overwrites the newer remote copy, updatedAt
  included, and the devices diverge permanently. Also asserts the mutable-domain
  sync (`syncUpdatedAtCollection`) pulls BEFORE it pushes and uses no watermark,
  that every mutable domain delegates to that one implementation, that sign-out
  awaits `syncAll` rather than `flushSync`, the flush-on-tab-hide wiring, and
  the W1 UID-change guard: `App.jsx` must
  re-hydrate through `reloadAllStores()` and carry no hardcoded per-store reload
  list, since such a list has twice silently missed a new domain and left the
  previous user's rows to be pushed under the new uid. Pure static analysis of
  `src/sync.js`, `src/App.jsx` and `src/stores/index.js`; no imports.
- `water_softdelete.test.mjs` - drives the real `useWaterStore` over a
  localStorage shim: soft-delete round-trip, `getToday` selector arithmetic,
  distinct entry ids, no entry loss on undo, and the epoch `configUpdatedAt`
  default that prevents a cleared store from clobbering a returning user's config.
- `sync_scenarios.test.mjs` - drives the real `syncWater` (via the `__test` seam
  in `sync.js`) against an in-memory Firestore mock to simulate the sync-layer
  smoke tests deterministically: an undone bottle does not reappear after a pull,
  an undo propagates cross-device, and a returning user's config survives an
  account switch (M1). The real browser/auth/eviction paths still need a manual pass.
- `symptoms_store.test.mjs` - drives the real `useSymptomsStore` and
  `useSymptomsLibraryStore`: the `logAgain` copy table, the kind side effects,
  validation rejection, and every edge case in the symptom spec's section 6 that
  lives below the UI. The load-bearing one is date re-derivation when `startedAt`
  is edited across a day boundary: forgetting it silently mis-groups an entry in
  history, trends and the doctor export, with no visible error. Section 11 now
  covers W4 day-level presence counting (`getAffectedDays` / `getDailyCounts` /
  `getWeeklyAffectedDays`) in place of the removed entries-per-week rule.
- `symptoms_sync.test.mjs` - drives the real mutable-domain sync against the
  Firestore mock: an EDIT (not just a creation) propagating cross-device, two
  concurrent offline edits resolving wholesale to the newer `updatedAt` with no
  field-level merge (spec edge case 7), soft-delete propagation, library
  rename/archive propagation, fixed-seed-id convergence for categories, and the
  date-keyed clear-day document. Y8-Y15 lock the 2026-09-06 sync fix and its follow-ups: a device
  reconnecting with an OLDER unpushed edit must not overwrite a NEWER remote
  copy and both devices must converge to byte-identical documents (verified to
  FAIL against the previous push-then-pull ordering); no push may lower a
  remote `updatedAt` on any of the five mutable domains, observed at the mock's
  write hook; a push that fails once is retried on the next sync, which the
  old watermark gate never did; retired meta keys are pruned; a malformed
  `updatedAt` on one side loses to the well-formed side rather than freezing the
  row; a write-once re-push (`flushSync` then `syncNutritionLogs`) never clears
  a soft-delete recorded in between; a null element in a local array is
  skipped rather than fatal; and (Y15) a journal soft-delete now propagates to a
  device that already holds the entry, which `syncJournal` never did before the
  water pull branch was ported on 2026-09-08.
- `firestore_rules.test.mjs` - static-structure test for `firestore.rules`.
  Locks the property that made the first draft of the monotonicity backstop a
  no-op: Firestore grants a request if ANY matching allow is true, so a
  recursive `{document=**}` ownership rule under `/users` alongside the
  per-collection rule granted every write the specific rule denied. Asserts one
  rule per data path, the five mutable collections gated on create/update (not
  delete), and `>=`. The emulator run remains the deploy gate.
- `symptoms_phase15.test.mjs` - the Phase 1.5 decisions that live below the UI:
  the intensity null policy under BOTH policy values plus the round trip proving
  an untouched save of an unrated entry stays `null` (writing back a `0` would
  destroy the "not rated" vs "rated 0" distinction permanently, on every device);
  categories as entities, with fixed seed ids stable across re-initialisation and
  an idempotent legacy `category` -> `categoryId` migration; clear-day records,
  refused while an episode is open and soft-deleted when a symptom is logged; and
  the `useSettingsStore` enumerated-fields gotcha, where a field added to only
  `loadSettings` or only `saveSettings` is silently dropped on every write.

- `register-hooks.mjs` / `resolve-extensionless.mjs` - test-only Node ESM resolve
  hook that appends `.js` to extensionless relative imports so the source modules
  can be imported unchanged. Not application code.
- `register-sync-mocks.mjs` / `resolve-sync-mocks.mjs` / `mocks/` - test-only
  resolve hook that additionally aliases `firebase/firestore` and `./firebase` to
  in-memory mocks, so the real sync code runs with a fake backend. The Firestore
  mock exposes `__setWriteHook(fn)`, called as `fn(path, prev, next)` before
  every `setDoc` lands, so a test can observe each write or make one fail by
  throwing. Not application code.

`/verify` reports WARNING for the missing runner-based suite until vitest is adopted.
