// title: water_fill.check.mjs
// project: Glim
// author: Reina Hastings
// contact: reinahastings13@gmail.com
// created: 2026-09-18
//
// purpose:
//   Behavioural checks for the water panel's background fill, run in the real
//   browser against the real component. The pure fraction is unit-tested in
//   tests/water_fill.test.mjs; this asserts the things only a rendered panel
//   can answer.
//
//   WHY THE EXPECTED VALUES COME FROM THE REGISTRY, not from the store. The
//   obvious check is "fill height equals getToday()/goal", and it is circular:
//   it compares the render against the same number the render used, so a seed
//   that silently loses entries still passes. views.mjs warns that a mis-shaped
//   seed does not error, it just falls back to a default and renders an empty
//   state. So each fill view declares `expect: { current, goal, pct }` and this
//   file asserts BOTH that the store hydrated to the declared count (seed
//   integrity) AND that the rendered geometry matches the declared percentage.
//   Two separate assertions, because they fail for different reasons.
//
//   The seed integrity check is the one that catches the 3 AM boundary: Glim's
//   logical day starts at 03:00 and the harness clock is pinned to 12:00, so a
//   seed reaching more than nine hours back silently loses bottles to
//   yesterday.
//
//   The denominator is the panel MINUS the header inset, because the water
//   fills only the region below the header: a full goal tops out just below the
//   header text rather than submerging it.
//
//   NOT COVERED HERE: the height transition. browser.mjs injects
//   `transition: none !important` before mount, so every observation is of the
//   end state. The rise is verified by hand on device.
//
// inputs:  tests/visual/views.mjs (FILL_VIEWS and their `expect` blocks)
// outputs: one line per check, then a tally; exit 1 on any failure
//
// usage:
//   cd client && node tests/visual/water_fill.check.mjs

import { ensureServer, launch, openView } from './browser.mjs';
import { VIEWS, FILL_VIEWS } from './views.mjs';
import { bubbleCount } from '../../src/utils/waterFill.js';

// The rendered percentage is compared to the declared one within this many
// percentage points. Sub-pixel layout means a 50% fill of an 811px panel does
// not land on exactly 50.000%.
const PCT_TOLERANCE = 0.5;

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.error(`  FAIL ${name}${detail ? ` - ${detail}` : ''}`); }
}

// Everything the page can tell us about the fill, in one round trip.
function probe() {
  const fill = document.querySelector('.glim-water-fill');
  if (!fill) return { present: false };
  const root = fill.parentElement;
  const f = fill.getBoundingClientRect();
  const r = root.getBoundingClientRect();
  const cs = getComputedStyle(fill);

  const byText = (needle) => [...document.querySelectorAll('button')]
    .find((b) => (b.textContent ?? '').trim().toLowerCase().includes(needle));

  const hits = (el) => {
    if (!el) return null;
    const b = el.getBoundingClientRect();
    const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
    return !!hit && (hit === el || el.contains(hit));
  };

  // The water fills only the region BELOW the header, so the denominator is
  // the panel minus that inset, not the panel. Read from the stylesheet rather
  // than hardcoded here: it differs per breakpoint with the type scale.
  const inset = parseFloat(getComputedStyle(fill).getPropertyValue('--glim-water-fill-inset')) || 0;
  const fillable = Math.max(r.height - inset, 0);

  // The surface straddles the fill's top edge, so the PAINTED water reaches
  // one amplitude above it. Everything about the header clearance has to be
  // measured against that, not against the box.
  const amp = parseFloat(getComputedStyle(fill).getPropertyValue('--glim-water-wave-amp')) || 0;
  const surface = fill.querySelector('.glim-water-surface');
  const tracks = [...fill.querySelectorAll('.glim-water-surface-track')];
  const bubbleEls = [...fill.querySelectorAll('.glim-water-bubble')];
  const bubbleBox = fill.querySelector('.glim-water-bubbles');
  const body = fill.querySelector('.glim-water-body');

  // The header row is the first sibling of the fill inside the panel root.
  const header = [...root.children].find((el) => el !== fill);
  const headerBottom = header ? header.getBoundingClientRect().bottom : null;

  // Does anything inside the water intercept a tap? Sampled on a grid rather
  // than at one point, because a single sample can miss a small child.
  let intercepts = 0;
  if (f.height > 2) {
    for (let ix = 1; ix <= 3; ix++) {
      for (let iy = 1; iy <= 3; iy++) {
        const hit = document.elementFromPoint(
          f.left + (f.width * ix) / 4, f.top + (f.height * iy) / 4);
        if (hit && fill.contains(hit)) intercepts++;
      }
    }
  }

  return {
    present: true,
    amp,
    headerBottom,
    paintedTop: f.top - amp,
    hasSurface: !!surface,
    hasBody: !!body,
    trackCount: tracks.length,
    // The loop is seamless only if each track is exactly twice its container,
    // because the animation translates it by half itself.
    trackRatios: tracks.map((t) => (surface.getBoundingClientRect().width > 0
      ? t.getBoundingClientRect().width / surface.getBoundingClientRect().width : 0)),
    bubbleCount: bubbleEls.length,
    bubblesClipped: bubbleBox ? getComputedStyle(bubbleBox).overflow : null,
    fillOverflow: getComputedStyle(fill).overflow,
    intercepts,
    fillH: f.height,
    rootH: r.height,
    inset,
    fillable,
    pct: fillable > 0 ? (f.height / fillable) * 100 : 0,
    pointerEvents: cs.pointerEvents,
    ariaHidden: fill.getAttribute('aria-hidden'),
    storeCurrent: window.__glim.water.getState().getToday(),
    storeGoal: window.__glim.water.getState().goal,
    bottleTappable: hits(byText('bottle')),
  };
}

const server = await ensureServer();
const browser = await launch();
const measured = {};

try {
  for (const view of FILL_VIEWS) {
    const want = VIEWS[view].expect;
    const page = await openView(browser, { view, viewport: 'phone' });
    const got = await page.evaluate(probe);

    console.log(`\n  ${view} (expect ${want.current}/${want.goal}, ${want.pct.toFixed(1)}%)`);

    if (!got.present) {
      check(`${view}: the fill element exists`, false);
      await page.context().close();
      continue;
    }

    // 1. Seed integrity, asserted independently of the geometry.
    check(`${view}: the store hydrated to ${want.current} bottles`,
      got.storeCurrent === want.current,
      `got ${got.storeCurrent}; a seed reaching past 03:00 loses bottles to yesterday`);
    check(`${view}: the goal is ${want.goal}`, got.storeGoal === want.goal, `got ${got.storeGoal}`);

    // 2. Geometry against the DECLARED percentage.
    check(`${view}: the fill is ${want.pct.toFixed(1)}% of the fillable region`,
      Math.abs(got.pct - want.pct) <= PCT_TOLERANCE,
      `got ${got.pct.toFixed(2)}%`);

    // 3. Invariants that must hold whatever the level.
    check(`${view}: the fill never exceeds the fillable region`,
      got.fillH <= got.fillable + 0.5,
      `${got.fillH.toFixed(1)} > ${got.fillable.toFixed(1)}`);
    check(`${view}: the water stops below the header`,
      got.fillH <= got.rootH - got.inset + 0.5,
      `fill ${got.fillH.toFixed(1)} of panel ${got.rootH.toFixed(1)}, inset ${got.inset}`);
    check(`${view}: the inset is a real value read from the stylesheet`, got.inset > 0);
    check(`${view}: the fill is not negative`, got.fillH >= 0);

    // --- the flowing surface -------------------------------------------
    const wantBubbles = bubbleCount(want.pct / 100);

    if (want.pct === 0) {
      // Nothing at all, not transparent things: a transparent element still
      // paints a compositing layer and still shows in a baseline.
      check(`${view}: no surface element with no water`, got.hasSurface === false);
      check(`${view}: no body element with no water`, got.hasBody === false);
      check(`${view}: no bubbles with no water`, got.bubbleCount === 0);
    } else {
      check(`${view}: the surface band exists`, got.hasSurface === true);
      check(`${view}: both wave tracks are present`, got.trackCount === 2);
      check(`${view}: each track is exactly twice its container, so the loop has no seam`,
        got.trackRatios.length === 2 &&
        got.trackRatios.every((r) => Math.abs(r - 2) < 0.01),
        got.trackRatios.map((r) => r.toFixed(3)).join(', '));
      check(`${view}: renders ${wantBubbles} bubble(s) for this level`,
        got.bubbleCount === wantBubbles, `got ${got.bubbleCount}`);
      check(`${view}: bubbles are clipped to the water body`,
        got.bubblesClipped === 'hidden');
    }

    // The fill must NOT clip, or it would cut off the crest it exists to show.
    check(`${view}: the fill does not clip its own crest`, got.fillOverflow === 'visible');

    // The bound the amplitude token has to respect. Measured on the PAINTED
    // water, which is one amplitude above the box every existing check reads.
    check(`${view}: the painted crest stays clear of the header text`,
      got.headerBottom !== null && got.paintedTop >= got.headerBottom,
      `crest at ${got.paintedTop?.toFixed(1)}, header ends ${got.headerBottom?.toFixed(1)}`);

    // measure.mjs cannot catch this: it reports a covered control as a note
    // that never affects its exit code.
    check(`${view}: nothing inside the water intercepts taps`,
      got.intercepts === 0, `${got.intercepts} of 9 sample points hit the fill`);

    // 4. The fill must not intercept taps. measure.mjs cannot catch this: it
    //    reports a covered control as a NOTE that never affects its exit code.
    check(`${view}: the fill does not take pointer events`, got.pointerEvents === 'none');
    check(`${view}: the fill is hidden from assistive tech`, got.ariaHidden === 'true');
    check(`${view}: "+ bottle" is still tappable through the fill`, got.bottleTappable === true);

    measured[view] = got.pct;
    await page.context().close();
  }

  // 5. Cross-view properties.
  console.log('\n  across views');
  const order = ['water-0', 'water-3', 'water-6', 'water-7'].filter((v) => v in measured);
  let monotone = true;
  for (let i = 1; i < order.length; i++) {
    if (measured[order[i]] < measured[order[i - 1]] - PCT_TOLERANCE) monotone = false;
  }
  check('more bottles never render less fill', monotone,
    order.map((v) => `${v}=${measured[v].toFixed(1)}%`).join(' '));

  // The cap, stated as the narrow claim that is actually true. The two views
  // are NOT pixel-identical overall: the footer prints a 7-day average that
  // includes today, so 6 and 7 bottles differ in that text.
  if ('water-6' in measured && 'water-7' in measured) {
    // 'full' now means 'up to the inset', not 'the whole panel'.
    check('7 of 6 fills to exactly the same height as 6 of 6',
      Math.abs(measured['water-7'] - measured['water-6']) <= 0.01,
      `${measured['water-7'].toFixed(2)}% vs ${measured['water-6'].toFixed(2)}%`);
    check('the capped fill fills the whole region below the header',
      Math.abs(measured['water-7'] - 100) <= PCT_TOLERANCE);
  }
  // 6. Reduced motion, asserted as a DECISION rather than as a behaviour we
  //    happen to have. Glim does not suppress the water animation: the app's
  //    creature animates unconditionally, so stopping one panel would make the
  //    support look more complete than it is. The rise transition IS suppressed,
  //    because that rule predates the decision and costs nothing. See the
  //    Decision Register, 2026-09-19.
  console.log('\n  reduced motion');
  for (const pref of ['reduce', 'no-preference']) {
    const page = await openView(browser, { view: 'water-3', viewport: 'phone', reducedMotion: pref });
    const r = await page.evaluate(() => {
      const fill = document.querySelector('.glim-water-fill');
      const track = fill.querySelector('.glim-water-surface-track');
      const bubble = fill.querySelector('.glim-water-bubble');
      return {
        transition: getComputedStyle(fill).transitionProperty,
        trackAnim: getComputedStyle(track).animationName,
        bubbleAnim: getComputedStyle(bubble).animationName,
      };
    });
    await page.context().close();
    check(`${pref}: the wave still animates`, r.trackAnim === 'glim-water-drift', r.trackAnim);
    check(`${pref}: the bubbles still animate`, r.bubbleAnim === 'glim-water-rise', r.bubbleAnim);
    if (pref === 'reduce') {
      check('reduce: the rise transition is suppressed', r.transition === 'none', r.transition);
    }
  }
} finally {
  await browser.close();
  await server.stop();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
