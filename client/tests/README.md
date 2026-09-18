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

# Firestore rules structure: one rule per data path, mutable collections gated,
# steps-health field validation present (STATIC only - there is no emulator, so
# the rules are never evaluated here; the behavioral gate is the deploy plus the
# manual device/console checks in the Phase 2 handoff spec)
node tests/firestore_rules.test.mjs

# Health step import, precedence: manual beats imported, a typed zero is a real
# statement, the clear marker hands a day back to health, and imported days
# count toward streaks and the weekly average for a user who never types
node --import ./tests/register-hooks.mjs tests/steps_precedence.test.mjs

# Health step import, date arithmetic: the eight-day window across both DST
# transitions, folding hourly buckets into Glim's 3 AM day, the clamp, and the
# metamorphic properties of the fold.
#
# THE TZ PREFIX IS REQUIRED, not decoration: toLogicalDateStr resolves through
# host-local time, so on a UTC host every DST assertion passes vacuously. The
# pin cannot be set inside the file (ESM evaluates imports first), so the test
# asserts the timezone as its first check and exits non-zero without it.
TZ=America/New_York node --import ./tests/register-hooks.mjs tests/steps_health_fold.test.mjs

# Symptom diary Phase 1.5: intensity null policy, categories as entities and the
# legacy migration, clear-day records, and the settings round trip
node --import ./tests/register-hooks.mjs tests/symptoms_phase15.test.mjs

# In-flight run guard: real startSync/stopSync/syncAll/flushSync against the
# mock with one awaited call held open; a run that outlives its session must
# write nothing (R1-R8)
node --import ./tests/register-sync-mocks.mjs tests/sync_stale_run.test.mjs

# Static: every sync function captures and checks the run-generation counter
node --import ./tests/register-hooks.mjs tests/sync_generation_guard.test.mjs

# Event-triggered scheduler (2026-09-10): idle runs push nothing, local writes
# and the remote signal document schedule debounced runs, own signal ignored,
# double startSync leaves one listener, flushSync waits for a run in flight
node --import ./tests/register-sync-mocks.mjs tests/sync_scheduler.test.mjs

# Cursor-bounded pulls and the per-row push record (2026-09-13): legacy pull and
# backfill, cursor advance and the two-minute query-side overlap, persist order,
# seeding, no echo (with clock skew), the E6 race and its failed re-push retry,
# record merge under a concurrent flush, account switch during a push loop, the
# dev helpers, the hidden-tab fallback skip, and the whole-account steady state
node --import ./tests/register-sync-mocks.mjs tests/cursor_pulls.test.mjs

# Static: every persisting store announces its write on syncBus with a DOMAINS
# member; syncBus imports nothing from Firebase; no store imports sync/firebase
node tests/syncbus_wiring.test.mjs
```

## Files

- `flushsync_scope.test.mjs` - locks the CRITICAL invariant that
  `flushWriteOnce()` (the tab-hide push, named `flushSync` until 2026-09-10)
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
  skipped rather than fatal; (Y15) a journal soft-delete now propagates to a
  device that already holds the entry, which `syncJournal` never did before the
  water pull branch was ported on 2026-09-08; and (Y16) a clear-day mark that
  has not yet synced loses to the tombstone the log laid on the other device.
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
  refused while any symptom is present on the day (open or closed episode, or a
  moment), soft-deleted when a symptom is logged, tombstoned when no row exists
  locally so an unsynced mark cannot outlive the log (D4), and unmarked on the
  entry's RESULTING date when an edit moves it (D3); and
  the `useSettingsStore` enumerated-fields gotcha, where a field added to only
  `loadSettings` or only `saveSettings` is silently dropped on every write; and
  the end-of-day reminder's decisions (`utils/symptomReminder.js`): the gate's
  truth table, the moot check, and the load-bearing rule that a refused "yes"
  never stamps the day, with static guards that `DesktopPet` routes every
  answer through the decision function and writes the stamp in one place.
- `sync_stale_run.test.mjs` - acceptance test for the run-generation guard
  (Decision Register 2026-09-10). Uses only the public API, so it is indifferent
  to how the guard is implemented. Holds one awaited mock call open, ends the
  session, releases, and asserts no `localSet`, no `notify`, no `setDoc`:
  stale mutable run (R1), the live-B variant where B's next sync must not push
  A's rows (R1b), the live control (R2), a stale write-once run (R3), a stop
  between two pushes of one run (R4: the dispatched write lands, the next does
  not), singletons via the doc-read gate (R5), two overlapping live runs are
  not discarded (R6), `flushSync` with its first push held across an account
  switch (R7, the code-review finding), and same-user re-sign-in (R8).
- `sync_generation_guard.test.mjs` - static presence test: every `async
  function sync*`, `pushEntries` and `flushWriteOnce` in `sync.js` has
  `const gen = generation` as its first statement and at least one
  `stale(gen, ...)`; `startSync`/`stopSync` bump; the exempt `syncAll` holds no
  write and the five one-line wrappers really delegate. Deliberately not a
  per-await count (satisfiable by a misplaced guard); placement is covered by
  `sync_stale_run` and by the `staleSkips() === 0` checks at the end of
  `sync_scenarios` and `symptoms_sync`. Since 2026-09-10 also asserts the
  scheduler's `flushSync` is write-free (it only waits and delegates to
  `runSync`) and that `touchSignal` checks the run generation before writing;
  since 2026-09-12 that neither `touchSignal` nor `watchSignal` references
  `Date` and that the signal is written with `serverTimestamp()`.
- `sync_scheduler.test.mjs` - behavioural tests for the event-triggered
  scheduler (2026-09-10) against the mock: P0, the Part 2.0 precondition, an
  idle steady-state run reports `docsPushed: 0` on all 13 domains and performs
  no Firestore write, signal document included (with `>=` singleton pushes two
  open devices would wake each other forever); P0n negative control (a real
  poke pushes once, touches the signal once, and the next idle run is silent);
  L1 a burst of local writes collapses to one debounced run; S1-S3 a foreign
  signal schedules a run, the device's own does not, the baseline snapshot does
  not; R1-R2 double `startSync` leaves one listener, one subscription and six
  handles, an account switch moves the listener, `stopSync` drains all; F1-F2
  `flushSync` waits for a held run and requests during a run coalesce into one
  follow-up; C1 an account switch mid-run. Uses `__test.setTimings` (20 ms
  debounce) and the mock's `onSnapshot` / `__listenerCount`. Since 2026-09-12
  the signal's `at` is server-assigned: S4 stubs the `Date` CONSTRUCTOR 5 min
  ahead (not just `Date.now`, which `new Date()` ignores), sets the mock server
  clock to real time, pushes, and asserts a foreign server-stamped signal wakes
  this device exactly once (negative control, a client string stamp, verified
  red by hand); S5 re-delivery schedules nothing; S6 the own optimistic echo
  (pending, `at` null) schedules nothing; S6b attach while a write is in
  flight, so the FIRST snapshot is pending: it must not become the baseline
  and must not schedule (the only sequence that gives the pending check its
  own teeth, since an own echo is also caught by the device-id check; code
  review 2026-09-12); P0n asserts the stored stamp through `__signalStamp`,
  since `__get` returns the `{ __ts }` storage form. S1 and S2 write their
  signals with `serverTimestamp()` like the code does.
- `syncbus_wiring.test.mjs` - static guard for the local-write trigger: a
  store that persists without `notifyLocalWrite` reaches Firestore only on
  focus or the 15-minute fallback, so every persisting store must import
  `syncBus`, announce with a `DOMAINS` member inside its save function, and
  never with a literal; `syncBus.js` imports nothing from Firebase; no store
  imports `sync.js` or `firebase.js`; `sync.js` records under exactly the
  `DOMAINS` strings.

- `register-hooks.mjs` / `resolve-extensionless.mjs` - test-only Node ESM resolve
  hook that appends `.js` to extensionless relative imports so the source modules
  can be imported unchanged. Not application code.
- `register-sync-mocks.mjs` / `resolve-sync-mocks.mjs` / `mocks/` - test-only
  resolve hook that additionally aliases `firebase/firestore` and `./firebase` to
  in-memory mocks, so the real sync code runs with a fake backend. The Firestore
  mock exposes `__setWriteHook(fn)`, called as `fn(path, prev, next)` before
  every `setDoc` lands, so a test can observe each write or make one fail by
  throwing; and three gates, `__setReadGate` (`getDocs`), `__setDocReadGate`
  (`getDoc`) and `__setWriteGate` (`setDoc`), each called with the path and
  awaited when it returns a promise, so a test can hold a call open mid-run.
  `__clearHooks()` resets all four. Since 2026-09-10 it also implements
  single-document `onSnapshot` (baseline snapshot on a microtask, re-delivery
  after every `setDoc` to the path, and `__listenerCount(path)`. Since 2026-09-12: `serverTimestamp()`
  resolved at commit against a mock server clock that starts at REAL time
  (captured once at load, so a `Date` stub cannot move it; a fixed far-future
  clock would make every skew test vacuous) and advances 1 ms per stamp;
  `MockTimestamp` with the SDK's zero-padded `valueOf`; an optimistic PENDING
  echo built synchronously in `setDoc` (sentinels read as null,
  `hasPendingWrites` true) delivered to every listener before the acknowledged
  snapshot; `__setServerClock`, `__serverClock`, `__signalStamp(path)`,
  `__redeliver(path)`, and `__setInitialPending(path)` (one-shot: the next
  `onSnapshot` on that path delivers a pending snapshot with stamps nulled
  before the acknowledged one, modelling attach-while-writing). Not
  application code.

`/verify` reports WARNING for the missing runner-based suite until vitest is adopted.
