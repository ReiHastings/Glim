// title: browser.mjs
// project: Glim
// author: Reina Hastings
// contact: reinahastings13@gmail.com
// created: 2026-09-18
//
// purpose:
//   Shared driver for the visual harness. Owns the Vite dev server, the
//   browser, and everything done to a page to make a screenshot reproducible.
//   capture.mjs, sweep.mjs and measure.mjs all go through openView() so they
//   cannot drift apart on how a view is reached.
//
//   The four things done to make a run repeatable, and why each is needed:
//
//   1. THE CLOCK IS PINNED (setFixedTime + a fixed timezone). Every count,
//      streak and weekly average in Glim is computed against "today", so on an
//      unpinned clock an unchanged app produces a different screenshot
//      tomorrow. The timezone is pinned too because toLogicalDateStr resolves
//      through local time and Glim's day starts at 3 AM, so the host's zone
//      would otherwise decide which day an entry falls in.
//
//   2. Math.random IS SEEDED. pickRandom (src/utils.js) drives the speech
//      bubble, the journal prompt and the ambient bug placement, so an
//      unseeded run changes the rendered text on every load. Seeding rather
//      than masking is deliberate: masking hides the element but still lets
//      its text change, and the text length is exactly what the layout is
//      being judged on.
//
//   3. CSS ANIMATION IS FROZEN AT t=0, via a style element injected by an init
//      script, i.e. before React mounts. Pausing after mount would freeze each
//      animation wherever it happened to be, which is not reproducible.
//
//   4. TOKEN OVERRIDES GO THROUGH setProperty ON THE ROOT ELEMENT, never an
//      injected `:root { ... }` rule. index.css redeclares every token inside
//      @media (max-width: 599px), and that block would beat an injected rule
//      at phone width: the override would appear to do nothing. An inline
//      style on the root element beats both stylesheet rules regardless of
//      media query. See tests/token_parity.test.mjs for the same seam.
//
//   5. requestAnimationFrame IS DRIVEN, NOT OBSERVED. The creature's idle
//      wander, its antennae and the ambient bugs animate through rAF, which
//      neither the pinned clock nor the CSS freeze stops: measured drift
//      between two runs of an UNCHANGED app was 0.3-0.6% of pixels, all of it
//      around the creature, which is enough to mark every view as changed and
//      make the diff useless. So rAF is replaced with a fixed timestep
//      (FRAME_MS) and a fixed budget (MAX_FRAMES): the animation advances the
//      same number of frames every run, lands in the same pose, and then
//      stops. A frame is counted only when a callback is actually waiting, so
//      the budget is spent on animation rather than on an idle page.
//
//   WHAT THIS HARNESS IS NOT. Chromium at a phone viewport is not the
//   Capacitor shell. env(safe-area-inset-*) resolves to zero here even with
//   viewport-fit=cover, so notch and home-indicator spacing is NOT being
//   tested, and iOS renders text with different metrics. Treat a pass here as
//   evidence about layout and structure, and confirm spacing on the device.
//
// inputs:  tests/visual/views.mjs (the registry), a running or spawnable dev server
// outputs: openView() -> a Playwright page ready to screenshot
//
// usage:   imported; not run directly

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { FIXED_NOW, TIMEZONE, VIEWPORTS, VIEWS } from './views.mjs';

const PORT = 5173;
export const BASE_URL = `http://localhost:${PORT}/Glim`;
const HARNESS_URL = `${BASE_URL}/tests/visual/harness.html`;

// How long to let React finish rendering a revealed panel. The CSS transition
// is frozen and rAF is budgeted, so this covers only render work.
const SETTLE_MS = 250;

// The rAF budget. 90 frames is past the creature's entry animation and well
// into its idle loop, which is the state the app spends its life in.
const FRAME_MS = 1000 / 60;
const MAX_FRAMES = 90;
// The run ends early when the app stops asking for frames, which is the state
// worth screenshotting. Counted in idle pump iterations rather than elapsed
// time, because Date.now() is pinned by setFixedTime and would never advance.
//
// SETTLED_PUMPS is only consulted once at least one frame has been spent.
// Applying it before the app has mounted would declare a page settled while
// React was still starting up. Before the first frame, PREROLL_PUMPS is the
// hang guard instead.
const SETTLED_PUMPS = 60;
const PREROLL_PUMPS = 2000;

// --- Dev server ---------------------------------------------------------

async function serverIsUp() {
  try {
    // 3s, not 1s: a dev server that is merely busy (compiling after an edit,
    // or serving another run) would otherwise look absent, and ensureServer
    // would spawn a duplicate vite on a second port.
    const res = await fetch(HARNESS_URL, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch { return false; }
}

// Reuses a dev server you already have running (the common case while
// tweaking), and only spawns one if there is none. A spawned server is stopped
// on exit; a reused one is left alone.
export async function ensureServer() {
  if (await serverIsUp()) return { stop: async () => {}, reused: true };

  const proc = spawn('npm', ['run', 'dev'], {
    cwd: new URL('../..', import.meta.url).pathname,
    stdio: 'ignore',
    detached: false,
  });

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 300));
    if (await serverIsUp()) return { stop: async () => { proc.kill(); }, reused: false };
  }
  proc.kill();
  throw new Error(`dev server did not come up at ${HARNESS_URL} within 30s`);
}

// --- Browser ------------------------------------------------------------

export async function launch() {
  return chromium.launch();
}

/**
 * Open one registered view, seeded, settled and ready to screenshot.
 *
 * @param {import('playwright').Browser} browser
 * @param {object} opts
 * @param {string} opts.view      a key of VIEWS
 * @param {string} [opts.viewport] a key of VIEWPORTS (default 'phone')
 * @param {Object<string,string>} [opts.tokens] --glim-* overrides, e.g.
 *        { '--glim-text-hero': '52px' }, applied inline on the root element
 * @returns {Promise<import('playwright').Page>} caller closes the page
 */
export async function openView(browser, { view, viewport = 'phone', tokens = null }) {
  const spec = VIEWS[view];
  if (!spec) throw new Error(`unknown view '${view}'; known: ${Object.keys(VIEWS).join(', ')}`);
  const vp = VIEWPORTS[viewport];
  if (!vp) throw new Error(`unknown viewport '${viewport}'; known: ${Object.keys(VIEWPORTS).join(', ')}`);

  // width/height are NOT newContext options; they must be nested under
  // `viewport`. Spreading them flat silently leaves the default 1280x720,
  // which renders the desktop layout while the run claims to be a phone.
  const { width, height, ...deviceOpts } = vp;
  const context = await browser.newContext({
    viewport: { width, height },
    ...deviceOpts,
    timezoneId: TIMEZONE,
    colorScheme: 'dark',
    reducedMotion: 'reduce',
  });
  await context.clock.setFixedTime(new Date(FIXED_NOW));

  const page = await context.newPage();

  // Everything below runs before any app module is evaluated.
  // Each step is wrapped so that one failing cannot silently skip the rest.
  // That is not hypothetical: document.documentElement is NULL when an init
  // script runs, so the freeze block below threw, and because it sat above the
  // rAF pump the pump was never installed. Both failures were invisible - the
  // page still loaded and still screenshotted.
  await page.addInitScript(({ seed, fixedNow, frameMs, maxFrames, settledPumps, prerollPumps }) => {
    const step = (name, fn) => {
      try { fn(); } catch (e) {
        (window.__glimHarnessErrors ??= []).push(`${name}: ${e}`);
      }
    };

    // (2) Seeded Math.random. mulberry32: small, and its sequence does not
    // depend on the host engine's PRNG implementation.
    step('random', () => {
      let s = 0x9e3779b9;
      Math.random = () => {
        s |= 0; s = (s + 0x6d2b79f5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    });

    // (5) Deterministic rAF: fixed timestep, fixed budget, then stop.
    // Installed before anything that can throw, since every later readiness
    // signal depends on it.
    step('raf', () => {
      const queue = [];
      let frame = 0;
      let idle = 0;
      window.__glimFramesDone = false;
      window.__glimFramesSpent = 0;
      window.requestAnimationFrame = (cb) => queue.push(cb);
      window.cancelAnimationFrame = () => {};

      const drain = (t) => {
        const due = queue.splice(0, queue.length);
        for (const cb of due) { try { cb(t); } catch { /* the app's problem */ } }
      };

      const pump = () => {
        if (!window.__glimFramesDone) {
          // A frame is spent only when something is waiting for one, so the
          // budget is not burned before React has mounted its loops.
          if (frame < maxFrames && queue.length) {
            frame++;
            idle = 0;
            drain(frame * frameMs);
          } else {
            idle++;
          }
          window.__glimFramesSpent = frame;
          // Done when the budget is spent, when the app has settled (no frame
          // requested for a while, having animated at least once), or when
          // nothing ever asked for a frame at all.
          const settled = frame > 0 && idle > settledPumps;
          const neverStarted = frame === 0 && idle > prerollPumps;
          if (frame >= maxFrames || settled || neverStarted) window.__glimFramesDone = true;
          setTimeout(pump, 0);
          return;
        }

        // Past the budget the queue is still drained, but always with the SAME
        // timestamp, so a loop computing a delta sees zero and nothing moves.
        //
        // The pump must never stop. Playwright's screenshot waits internally
        // for requestAnimationFrame to settle, so a pump that returned here
        // left that wait pending forever and the screenshot timed out. That is
        // also what produced the one unexplained capture failure earlier: it
        // only bit when a view finished its budget before the screenshot.
        drain(maxFrames * frameMs);
        setTimeout(pump, 16);
      };
      setTimeout(pump, 0);
    });

    // The seed. Written before the stores' module-level load() calls run, so
    // they hydrate from it directly and no reload is needed.
    step('seed', () => {
      localStorage.clear();
      for (const [key, value] of Object.entries(seed)) {
        localStorage.setItem(key, JSON.stringify(value));
      }
      // A uid matching nothing real; App.jsx is not mounted, but the stores'
      // account-switch guard reads this key.
      localStorage.setItem('glim-last-uid', 'visual-harness');
    });

    // (3) Freeze CSS animation at t=0. documentElement does not exist yet when
    // this script runs, so the injection retries until the parser creates it -
    // still long before any app stylesheet loads, which is what "at t=0"
    // requires.
    step('freeze', () => {
      const inject = () => {
        if (!document.documentElement) { setTimeout(inject, 0); return; }
        const style = document.createElement('style');
        style.textContent = `
          *, *::before, *::after {
            animation-play-state: paused !important;
            animation-delay: 0s !important;
            transition: none !important;
            caret-color: transparent !important;
          }`;
        document.documentElement.appendChild(style);
        window.__glimFrozen = true;
      };
      inject();
    });

    window.__glimFixedNow = fixedNow;
  }, { seed: spec.seed ?? {}, fixedNow: FIXED_NOW,
       frameMs: FRAME_MS, maxFrames: MAX_FRAMES,
       settledPumps: SETTLED_PUMPS, prerollPumps: PREROLL_PUMPS });

  await page.goto(HARNESS_URL, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__glim?.ready === true, null, { timeout: 15_000 });

  // (4) Token overrides, inline on the root element.
  if (tokens) {
    await page.evaluate((t) => {
      for (const [name, value] of Object.entries(t)) {
        document.documentElement.style.setProperty(name, value);
      }
    }, tokens);
  }

  // Reveal the surface by setting store state directly. Clicking through the
  // nav is slower and, on a selector that silently matches nothing, would
  // screenshot the home view while claiming to be the steps panel.
  if (spec.ui && Object.keys(spec.ui).length) {
    await page.evaluate((ui) => {
      const set = window.__glim.ui.setState;
      set(ui);
    }, spec.ui);
  }

  await page.waitForTimeout(SETTLE_MS);

  // Let the rAF budget run out, so every run screenshots the same frame.
  await page.waitForFunction(() => window.__glimFramesDone === true,
    null, { timeout: 20_000 });

  // A view that never spent its budget is a view whose animation state is not
  // pinned; say so rather than let it look like a clean capture.
  const state = await page.evaluate(() => ({
    spent: window.__glimFramesSpent ?? 0,
    frozen: window.__glimFrozen === true,
    errors: window.__glimHarnessErrors ?? [],
  }));
  // These are harness failures, not app failures, and each one silently
  // invalidates a determinism guarantee the screenshots are trusted for.
  if (state.errors.length) {
    throw new Error(`harness init failed for '${view}': ${state.errors.join('; ')}`);
  }
  if (!state.frozen) throw new Error(`CSS animation was not frozen for '${view}'`);
  // state.spent below MAX_FRAMES is not a problem: it means the app stopped
  // asking for frames, i.e. its animation settled on its own, which is exactly
  // the state worth screenshotting. It is returned for callers that want it.
  return Object.assign(page, { __framesSpent: state.spent });
}

/**
 * Open a view and screenshot it, retrying once on a timeout.
 *
 * The dev server is shared and long-lived, so anything that edits a source file
 * mid-run (another editor, another agent, a rebuild) makes Vite push an HMR
 * update into the page. Playwright's screenshot waits for the page to stop
 * changing and can time out while that is happening. Observed as intermittent
 * "page.screenshot: Timeout 30000ms exceeded" on unrelated views while source
 * files were being edited elsewhere.
 *
 * Disabling the HMR client is NOT the fix: @vitejs/plugin-react's refresh
 * preamble depends on it, so stubbing it stops the app mounting at all.
 *
 * ONE retry, not a loop. A transient rebuild resolves on a second attempt; a
 * page that genuinely never settles should fail the run rather than be retried
 * until it happens to pass.
 *
 * @returns {Promise<Buffer>} the PNG
 */
export async function captureView(browser, opts, { onError } = {}) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    let page;
    try {
      page = await openView(browser, opts);
      if (onError) watchConsole(page, opts.view, onError);
      return await page.screenshot();
    } catch (e) {
      if (attempt === 2 || !/Timeout/.test(String(e))) throw e;
      console.log(`  note: ${opts.view} timed out, retrying once ` +
                  `(the dev server was probably rebuilding)`);
    } finally {
      await page?.context().close();
    }
  }
}

// Console errors are worth surfacing: a panel that throws renders nothing, and
// an empty screenshot otherwise looks like a layout problem.
export function watchConsole(page, label, sink) {
  page.on('console', (m) => { if (m.type() === 'error') sink.push(`[${label}] ${m.text()}`); });
  page.on('pageerror', (e) => sink.push(`[${label}] ${e.message}`));
}
