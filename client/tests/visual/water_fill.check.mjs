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

  return {
    present: true,
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
} finally {
  await browser.close();
  await server.stop();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
