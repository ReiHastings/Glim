// title: measure.mjs
// project: Glim
// author: Reina Hastings
// contact: reinahastings13@gmail.com
// created: 2026-09-18
//
// purpose:
//   Layout checks that are MEASURED rather than looked at. A screenshot has to
//   be judged by eye, and an eye (model or human) reliably misses a control
//   that is four pixels off-screen or a tap target that is too small. These are
//   the same defects expressed as numbers, so they either pass or name the
//   element.
//
//   HARD FAILURES (exit 1) - these are defects on any screen:
//     - horizontal overflow: the page scrolls sideways
//     - off-canvas text: readable text runs past the viewport edge
//     - undersized tap areas: a tap 22px from the control's centre does not
//       reach it, on a touch viewport
//
//   REPORT ONLY - a number worth seeing, not a rule worth enforcing:
//     - font sizes that come from outside the --glim-text-* scale. Some are
//       deliberate (the 16px iOS zoom guard in index.css is one), so this
//       counts and lists them rather than failing.
//
//   Contrast is deliberately NOT checked here. Doing it properly means
//   resolving the effective background through Glim's layered gradients and
//   translucent panels, and a naive implementation reports confident nonsense.
//
// inputs:
//   --views a,b     views to measure (default: all)
//   --viewport v    phone | desktop  (default: phone)
//
// outputs:
//   one block per view on stdout; exit 0 when every hard check passed, 1 otherwise
//
// usage:
//   cd client && node tests/visual/measure.mjs
//   cd client && node tests/visual/measure.mjs --views steps --viewport desktop

import { ensureServer, launch, openView, watchConsole } from './browser.mjs';
import { VIEW_NAMES, VIEWPORTS } from './views.mjs';

// Apple's Human Interface Guidelines minimum, in CSS px. Applied only on a
// touch viewport: a desktop pointer is precise and the same rule there would
// report noise.
const MIN_TAP = 44;

function usage(msg) {
  if (msg) console.error(`error: ${msg}\n`);
  console.error(`usage: node tests/visual/measure.mjs [options]

  --views a,b     ${VIEW_NAMES.join(', ')} (default: all)
  --viewport v    ${Object.keys(VIEWPORTS).join(' | ')} (default: phone)
  --full          list every problem instead of the first 5 per view
  --self-test     inject one known defect per check and assert each is caught
  -h, --help      this message
`);
  process.exit(msg ? 2 : 0);
}

function parseArgs(argv) {
  const o = { views: VIEW_NAMES, viewport: 'phone', selfTest: false, full: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { const v = argv[++i]; if (v === undefined) usage(`${a} needs a value`); return v; };
    if (a === '-h' || a === '--help') usage();
    else if (a === '--views') {
      o.views = next().split(',').map((s) => s.trim()).filter(Boolean);
      const unknown = o.views.filter((v) => !VIEW_NAMES.includes(v));
      if (unknown.length) usage(`unknown view(s): ${unknown.join(', ')}`);
    } else if (a === '--viewport') {
      o.viewport = next();
      if (!VIEWPORTS[o.viewport]) usage(`unknown viewport '${o.viewport}'`);
    } else if (a === '--full') o.full = true;
    else if (a === '--self-test') o.selfTest = true;
    else usage(`unrecognised argument '${a}'`);
  }
  return o;
}

// Runs in the page. Returns plain data; all judgement happens in Node.
//
// Takes its arguments as ONE destructured array, because page.evaluate passes
// a single argument: `evaluate(collect, [MIN_TAP, isTouch])` against a
// two-parameter signature binds the whole array to the first parameter and
// leaves the second undefined, which silently disabled the tap-target check
// entirely (caught by --self-test, not by any passing run).
function collect([minTap, isTouch]) {
  const describe = (el) => {
    const id = el.id ? `#${el.id}` : '';
    const cls = typeof el.className === 'string' && el.className
      ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}` : '';
    const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 24);
    return `${el.tagName.toLowerCase()}${id}${cls}${text ? ` "${text}"` : ''}`;
  };

  const visible = (el, r) => {
    if (r.width === 0 || r.height === 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
  };

  const vw = document.documentElement.clientWidth;
  const all = [...document.querySelectorAll('body *')];

  // --- Horizontal overflow ---
  const overflow = {
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: vw,
  };

  // --- Off-canvas TEXT ---
  //
  // The first version of this flagged every element past the viewport edge and
  // was useless: it reported 15 items per view, all of them SVG paths inside
  // the creature and decorative background dots, which extend past the edge by
  // design and are clipped by their container. None of them were defects.
  //
  // What is worth reporting is TEXT that runs off the edge, since that is
  // content the user cannot read. So: elements holding their own text node,
  // excluding anything inside an SVG (whose geometry is the drawing's, not the
  // layout's) and anything inside a deliberate horizontal scroller.
  //
  // 1px of tolerance, because sub-pixel layout regularly lands an edge at
  // vw + 0.4.
  const inHorizontalScroller = (el) => {
    for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
      const ox = getComputedStyle(n).overflowX;
      if (ox === 'auto' || ox === 'scroll') return true;
    }
    return false;
  };

  const offCanvas = [];
  for (const el of all) {
    if (el.closest('svg')) continue;
    const hasOwnText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (!hasOwnText) continue;
    const r = el.getBoundingClientRect();
    if (!visible(el, r)) continue;
    if (inHorizontalScroller(el)) continue;
    if (r.right > vw + 1) offCanvas.push({ el: describe(el), right: Math.round(r.right), vw });
    else if (r.left < -1) offCanvas.push({ el: describe(el), left: Math.round(r.left), vw });
  }

  // --- Tap targets ---
  //
  // Measured as EFFECTIVE hit area, not as the element's box. The first
  // version compared getBoundingClientRect against 44px, which is the wrong
  // property: the standard way to fix a small control is to expand its hit
  // area with a transparent overlay, leaving the visible box alone. A box
  // measurement cannot see that fix, so it would keep reporting a control that
  // is now perfectly tappable.
  //
  // Instead, sample the four points 22px from the element's centre (up, down,
  // left, right) and ask the browser what is actually on top there. If the
  // answer is the element or something inside it, a finger landing there hits
  // it. This also catches the failure mode that the overlay approach
  // introduces: two expanded controls whose overlays overlap, where the later
  // one silently steals the other's taps.
  //
  // Edge midpoints rather than corners: a fingertip contact patch is round, so
  // the corners of a square are not the honest test.
  const INTERACTIVE = 'button, a[href], input, select, textarea, [role="button"], [tabindex]';
  const smallTaps = [];
  const occluded = [];
  if (isTouch) {
    const vh = document.documentElement.clientHeight;
    for (const el of document.querySelectorAll(INTERACTIVE)) {
      if (el.matches('input[type="range"]')) continue;  // dragged, not tapped
      const r = el.getBoundingClientRect();
      if (!visible(el, r)) continue;

      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;

      // Reachability first. A control whose own CENTRE resolves to something
      // else is covered by another layer, which is a different problem from
      // being too small, and usually deliberate: Glim keeps the reminder card
      // mounted underneath an open panel, where it is neither visible nor
      // tappable. Counting those as undersized tap targets reported five
      // phantom defects per view. They are counted separately instead.
      const atCentre = document.elementFromPoint(cx, cy);
      if (!atCentre || !(atCentre === el || el.contains(atCentre))) {
        occluded.push(describe(el));
        continue;
      }

      // Then measure how far the hit area actually REACHES from the centre in
      // each direction, and require the two spans to total minTap.
      //
      // Measuring spans rather than probing a fixed 22px offset matters,
      // because the fixed probe silently demanded SYMMETRIC expansion, which a
      // control near the edge of a scroll container can never provide: the
      // water panel's "24 oz" pill sits at the top of a clipping container, so
      // nothing can extend above it, and the only way to satisfy a symmetric
      // probe would have been to make the pill visibly chunkier. An area that
      // is short on one side and long on the other is still 44px of finger
      // room, and is the normal shape for a control near an edge.
      const reach = (dx, dy) => {
        let d = 0;
        for (let k = 1; k <= minTap; k++) {
          const x = cx + dx * k;
          const y = cy + dy * k;
          // Past the screen edge there is nothing to hit and nothing to steal,
          // so the remaining distance counts as available: a control flush
          // against the edge is as reachable as it can be.
          if (x < 0 || y < 0 || x > vw || y > vh) return minTap;
          const hit = document.elementFromPoint(x, y);
          if (!hit || !(hit === el || el.contains(hit))) break;
          d = k;
        }
        return d;
      };

      const up = reach(0, -1), down = reach(0, 1);
      const left = reach(-1, 0), right = reach(1, 0);
      const reachW = left + right + 1;
      const reachH = up + down + 1;

      const missed = [];
      if (reachW < minTap) missed.push(`width ${Math.round(reachW)}`);
      if (reachH < minTap) missed.push(`height ${Math.round(reachH)}`);

      if (missed.length) {
        smallTaps.push({
          el: describe(el), w: Math.round(r.width), h: Math.round(r.height), missed,
        });
      }
    }
  }

  // --- Font-size conformance ---
  // The scale is read from the ROOT at run time, so it is whatever the active
  // media-query block resolved to rather than a list duplicated here.
  const rootStyle = getComputedStyle(document.documentElement);
  const scale = new Set();
  for (const name of Array.from(document.styleSheets).flatMap((sheet) => {
    try { return Array.from(sheet.cssRules); } catch { return []; }
  }).flatMap((rule) => (rule.style ? Array.from(rule.style) : []))
    .filter((n) => n.startsWith('--glim-text'))) {
    const v = rootStyle.getPropertyValue(name).trim();
    if (v) scale.add(v);
  }
  scale.add('16px');  // the deliberate iOS input-zoom guard in index.css

  const offScale = {};
  for (const el of all) {
    const r = el.getBoundingClientRect();
    if (!visible(el, r)) continue;
    // Only elements holding their own text; a wrapper inherits a size it never
    // chose, and counting those buries the real ones.
    const ownText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (!ownText) continue;
    const fs = getComputedStyle(el).fontSize;
    if (!scale.has(fs)) (offScale[fs] ??= []).push(describe(el));
  }

  return { overflow, offCanvas, smallTaps, occluded, offScale, scale: [...scale].sort() };
}

// --- Self-test ----------------------------------------------------------
//
// A check that never fires is indistinguishable from a check that passes. This
// injects one known-bad element per hard check into a real view and asserts
// each is caught, which is the only thing that shows the checks have teeth.

async function selfTest(browser) {
  const page = await openView(browser, { view: 'home', viewport: 'phone' });
  await page.evaluate(() => {
    const add = (style, text) => {
      const el = document.createElement('div');
      el.setAttribute('style', `position:fixed;z-index:9999;color:#fff;${style}`);
      el.textContent = text;
      document.body.appendChild(el);
      return el;
    };
    // (a) text running off the right edge
    add('top:100px;left:calc(100vw - 20px);width:200px;font-size:17px', 'off canvas text');
    // (b) an undersized tap target
    const b = document.createElement('button');
    b.setAttribute('style', 'position:fixed;top:200px;left:10px;width:20px;height:20px');
    b.textContent = 'x';
    document.body.appendChild(b);
    // (c) a font size outside the token scale
    add('top:300px;left:10px;font-size:13.5px', 'off scale text');
  });
  const r = await page.evaluate(collect, [MIN_TAP, true]);
  await page.context().close();

  const cases = [
    ['off-canvas text is caught', r.offCanvas.some((o) => /off canvas text/.test(o.el))],
    ['undersized tap area is caught', r.smallTaps.some((t) => t.w === 20 && t.h === 20)],
    ['off-scale font size is caught', Object.keys(r.offScale).includes('13.5px')],
  ];
  let bad = 0;
  console.log(`resolved token scale: ${r.scale.join(', ')}`);
  for (const [name, ok] of cases) {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}`);
    if (!ok) bad++;
  }
  console.log(`\n${cases.length - bad} of ${cases.length} checks have teeth`);
  return bad;
}

// --- Main ---------------------------------------------------------------

const opts = parseArgs(process.argv.slice(2));
const isTouch = !!VIEWPORTS[opts.viewport].hasTouch;
const server = await ensureServer();
const browser = await launch();
const errors = [];
let failures = 0;

try {
  if (opts.selfTest) {
    failures = await selfTest(browser);
  } else {
  console.log(`measuring ${opts.views.length} view(s) at ${opts.viewport}` +
              `${isTouch ? '' : ' (tap-target check skipped: not a touch viewport)'}`);

  for (const view of opts.views) {
    const page = await openView(browser, { view, viewport: opts.viewport });
    watchConsole(page, view, errors);
    const r = await page.evaluate(collect, [MIN_TAP, isTouch]);
    await page.context().close();

    // How many problems of each kind to print. The default keeps a failing run
    // readable; --full is for working through the list.
    const cap = opts.full ? Infinity : 5;
    const problems = [];
    if (r.overflow.scrollWidth > r.overflow.clientWidth + 1) {
      problems.push(`scrolls sideways: ${r.overflow.scrollWidth}px of content in ${r.overflow.clientWidth}px`);
    }
    for (const o of r.offCanvas.slice(0, cap)) {
      problems.push(`off canvas: ${o.el} ${o.right !== undefined ? `right ${o.right} > ${o.vw}` : `left ${o.left} < 0`}`);
    }
    if (r.offCanvas.length > cap) problems.push(`... and ${r.offCanvas.length - cap} more off canvas`);
    for (const t of r.smallTaps.slice(0, cap)) {
      problems.push(`tap area reaches only ${t.missed.join(', ')} (min ${MIN_TAP}),` +
                    ` box ${t.w}x${t.h}: ${t.el}`);
    }
    if (r.smallTaps.length > cap) problems.push(`... and ${r.smallTaps.length - cap} more small tap targets`);

    if (problems.length) {
      failures++;
      console.log(`\n  FAIL ${view}`);
      for (const p of problems) console.log(`         ${p}`);
    } else {
      console.log(`\n  ok   ${view}`);
    }

    if (r.occluded.length) {
      console.log(`         note: ${r.occluded.length} control(s) covered by another layer,` +
                  ` not size-checked (expected while a panel is open)`);
    }

    const off = Object.entries(r.offScale).sort((a, b) => b[1].length - a[1].length);
    if (off.length) {
      const total = off.reduce((n, [, els]) => n + els.length, 0);
      console.log(`         note: ${total} element(s) sized outside the token scale` +
                  ` [${off.slice(0, 4).map(([fs, els]) => `${fs} x${els.length}`).join(', ')}` +
                  `${off.length > 4 ? ', ...' : ''}]`);
    }
  }
  }
} finally {
  await browser.close();
  await server.stop();
}

if (errors.length) {
  console.error(`\npage errors:`);
  for (const e of errors) console.error(`  ${e}`);
}

if (!opts.selfTest) console.log(`\n${opts.views.length} measured, ${failures} with hard failures`);
process.exit(failures || errors.length ? 1 : 0);
