# Glim visual harness

Screenshot-driven workflow for layout and aesthetic work: render the real app
in a headless browser, compare candidate values side by side, and measure the
layout facts that are unreliable to judge by eye.

Nothing here writes to `src/`. Token experiments are applied at runtime, so a
value only reaches `index.css` once you have chosen it.

## Running

From `client/`:

```bash
# Screenshot every view and diff against the blessed baseline
npm run visual

# Only some views, and both viewports
node tests/visual/capture.mjs --views water,steps --viewport both

# Bless the current output as the new baseline (do this after you accept a change)
npm run visual:accept

# Compare five values of one token, side by side, in one image
node tests/visual/sweep.mjs --view steps --token --glim-text-hero \
  --values 32px,36px,40px,44px,48px

# Measured layout checks (overflow, tap targets, token conformance)
npm run visual:measure

# Water panel background fill: seed integrity, fill geometry, the cap, and
# that the fill does not intercept taps
node tests/visual/water_fill.check.mjs

# Prove those checks still fire
node tests/visual/measure.mjs --self-test
```

Each script takes `--help`.

A dev server is reused if one is already running on 5173, and started and
stopped automatically otherwise.

## The loop this is for

1. `sweep.mjs` to compare candidate values for a token. Pick one by looking at
   one image instead of rebuilding N times.
2. Edit `src/index.css` with the chosen value, in BOTH token blocks
   (`node tests/token_parity.test.mjs` catches it if you edit only one).
3. `npm run visual` to see which other views moved. A shared token usually
   moves more than the panel you were working on; the diff names them.
4. `npm run visual:measure` for the facts a screenshot hides.
5. `npm run visual:accept` once the new look is what you want.

## Files

- `harness.html` / `harness.jsx` - a dev-only entry point that mounts
  `DesktopPet` directly. `App.jsx` gates the app behind Firebase Auth, but
  `DesktopPet` imports neither Firebase nor `sync.js`, so rendering it directly
  needs no credentials, no emulator and no network.
- `views.mjs` - the registry. One entry per surface: its localStorage seed and
  the `useUIStore` state that reveals it. Adding a surface is one entry here.
- `browser.mjs` - the shared driver, and the only file that decides how a view
  is reached. Holds the five things done to make a run reproducible (pinned
  clock and timezone, seeded `Math.random`, frozen CSS animation, budgeted
  `requestAnimationFrame`, inline token overrides), each documented with the
  failure it prevents.
- `capture.mjs` - screenshots and baseline diffing. The diff is computed in a
  canvas, so no image library is needed.
- `sweep.mjs` - one view, many token values, one labelled contact sheet.
- `measure.mjs` - the checks that are measured rather than looked at, plus
  `--self-test`.
- `water_fill.check.mjs` - behavioural checks for the water panel's background
  fill, in a real browser. Reads the expected values from each view's `expect`
  block in `views.mjs`, never from the store: asserting the fill against
  `getToday()` would compare the render to the same number the render used, so
  a seed that silently loses bottles would still pass. Seed integrity and fill
  geometry are asserted SEPARATELY, because they fail for different reasons.
  Also covers the cap (7 of 6 fills to the same height as 6 of 6, which is the
  narrow claim that is true; the two views are not pixel-identical because the
  footer's 7-day average includes today), and that the fill takes no pointer
  events, which `measure.mjs` cannot catch because it reports a covered control
  as a note that never affects its exit code. Since the flowing surface landed
  it also covers the wave and the bubbles: the surface band exists, each wave
  track is exactly twice its container (the animation translates by half, so
  anything else puts a seam in the loop), the bubble count matches
  `bubbleCount()` for the level, bubbles are clipped to the water body, the fill
  does NOT clip its own crest, the painted crest stays clear of the header text,
  and nothing inside the water intercepts taps on a 3x3 grid. Verified red
  against seven mutations: the cap removed, a seed spaced past the 3 AM
  boundary, the fill clipping its crest, the amplitude raised past the header
  clearance, a track that is no longer two wavelengths, a surface rendered at
  zero water, and the fill taking pointer events.
- `shots/baseline/` - the blessed reference images, phone and desktop.
  Committed.
- `shots/current/`, `shots/sweeps/` - run output. Not committed.

## Determinism

Two runs of an unchanged app produce byte-comparable screenshots: measured at
**0.000% of pixels differing** across all eight views. That is what makes the
baseline diff meaningful, and it took more than freezing CSS:

- The clock and timezone are pinned, because every count, streak and weekly
  average is computed against "today".
- `Math.random` is seeded, because `pickRandom` chooses the speech-bubble
  message and the journal prompt on every load.
- `requestAnimationFrame` is replaced with a fixed timestep and a fixed frame
  budget. Before this, the creature's idle animation alone moved 0.3-0.6% of
  pixels between identical runs, which marked five of eight views as changed
  on every run. Once the budget is spent the queue is still drained, always
  with the same timestamp: Playwright's screenshot waits internally for a
  frame, so a pump that simply stopped left that wait pending and the
  screenshot timed out.

## Tap areas

`measure.mjs` measures the area a finger can actually reach, not the size of
the element's box. The difference matters because the normal way to fix a small
control is to expand its hit area with a transparent overlay and leave the
drawing alone. A box measurement cannot see that fix and would keep reporting a
control that is now perfectly tappable.

So the check walks outward from the control's centre in each direction, asking
the browser what is on top, and requires the reachable spans to total 44px. It
measures spans rather than probing a fixed 22px offset because the fixed probe
silently demanded SYMMETRIC expansion, which a control at the edge of a scroll
container can never provide.

Two consequences worth knowing:

- A control covered by another layer is reported separately, not as an
  undersized target. Glim keeps the reminder card mounted underneath an open
  panel, where it is neither visible nor tappable; counting those as defects
  produced five phantom findings per view.
- Two expanded controls whose overlays overlap are caught automatically, since
  the later one in paint order answers the hit test. This is a real hazard: the
  nutrition rows had a 35px pitch, so four stacked 44px areas would have
  stolen each other's taps. The pitch is now 44.

The overlays come from `.glim-tap` in `src/index.css`, with `.glim-tap-down`
and `.glim-tap-up` for controls clipped at the top or bottom of a container.
`<input>` cannot carry one, because replaced elements render no pseudo-elements;
size those with `min-height`.

## Fill-level views and the 3 AM boundary

`water-0`, `water-3`, `water-6` and `water-7` seed an exact number of bottles
logged today, and each declares what it expects in an `expect` block.

The constraint to know when adding more: Glim's logical day starts at 03:00 and
the harness clock is pinned to 12:00, so only NINE hours of "today" exist. The
seeds space entries one hour apart starting one hour ago, which fits up to nine
bottles. A tenth would silently fall into yesterday, `countToday` would stop
seeing it, the panel would render a shorter fill, and nothing would error. That
is exactly why the expected count is declared rather than derived, and it is
one of the two mutations `water_fill.check.mjs` was verified against.

## Motion, and why screenshots are not the evidence for it

The freeze injects `animation-play-state: paused` AND `animation-delay: 0s`
before mount. The second matters more than it looks: negative delays are how you
stagger bubbles and phase-offset a parallax wave, and the harness removes them.
So anything that must be distinguishable in a screenshot has to be
distinguishable with every animation sitting at its first frame.

That shaped the implementation rather than the other way round:

- The back wave carries a phase offset baked into its PATH, so the two layers
  are different curves even when both tracks are frozen at `translateX(0)`.
  Without it the parallax layer would be invisible in every baseline.
- Each bubble has a static resting depth, so five frozen bubbles are five
  distinguishable marks rather than one.
- The bubble rise keyframes deliberately do not set `opacity` at 0%, so a frozen
  bubble inherits its own opacity of 1. Fading in from 0 would have made the
  bubbles invisible in every baseline they exist to protect.

The motion itself is a device check, as is the fill's rise transition, since
`transition: none` is injected too.

`reducedMotion` is an option on `openView`, defaulting to `'reduce'`, which is
what every committed baseline was captured under. Changing that default
re-blesses all of them, so it is its own change rather than a side effect of a
feature. Glim deliberately does not suppress the water animation; see the
Decision Register, 2026-09-19, and the note in `src/index.css`.

## What this does NOT test

Chromium at a phone viewport is not the Capacitor shell:

- `env(safe-area-inset-*)` resolves to zero here even with `viewport-fit=cover`,
  so notch and home-indicator spacing is not covered. Confirm on device.
- iOS renders text with different metrics, so exact glyph positions will differ.
- CSS transitions. The freeze injects `transition: none !important` before
  mount, so every screenshot is of the end state. The water fill's rise is
  verified by hand on device, not here.

Treat a pass here as evidence about layout and structure, and keep the device
check for spacing and type.
