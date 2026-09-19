// title: capture.mjs
// project: Glim
// author: Reina Hastings
// contact: reinahastings13@gmail.com
// created: 2026-09-18
//
// purpose:
//   Screenshot every registered view (tests/visual/views.mjs) and, when a
//   baseline exists, report how much each one changed. This is the regression
//   half of the workflow: a tweak to a shared token fixes one panel and
//   silently breaks another, and the diff is what names the panel you did not
//   think to look at.
//
//   The diff is computed in the browser with a canvas rather than through an
//   image library, so the harness needs no dependency beyond Playwright.
//
//   THRESHOLD. A view is reported CHANGED when more than DIFF_THRESHOLD of its
//   pixels differ by more than CHANNEL_TOLERANCE. Both are deliberately small
//   but non-zero: the creature is animated by requestAnimationFrame, which the
//   pinned clock does not stop, so a handful of pixels around it move between
//   runs even with no code change (see browser.mjs).
//
// inputs:
//   --views a,b     comma-separated view names (default: all in the registry)
//   --viewport v    phone | desktop | both           (default: phone)
//   --out DIR       where to write                   (default: shots/current)
//   --accept        after capturing, replace the baseline with this run
//   --no-diff       capture only, skip the comparison
//
// outputs:
//   PNGs at <out>/<viewport>/<view>.png, a per-view diff line on stdout, and
//   diff overlays at <out>/<viewport>/<view>.diff.png for changed views.
//   Exit code 0 when nothing changed or no baseline exists, 1 when a view
//   changed or a page logged an error.
//
// usage:
//   cd client && node tests/visual/capture.mjs
//   cd client && node tests/visual/capture.mjs --views water,steps --viewport both
//   cd client && node tests/visual/capture.mjs --accept        # bless this run

import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, cpSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureServer, launch, captureView } from './browser.mjs';
import { VIEW_NAMES, VIEWS, VIEWPORTS } from './views.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const BASELINE_DIR = join(here, 'shots', 'baseline');

const DIFF_THRESHOLD = 0.002;   // 0.2% of pixels
const CHANNEL_TOLERANCE = 12;   // 0-255 per channel

// --- Arguments ----------------------------------------------------------

function usage(msg) {
  if (msg) console.error(`error: ${msg}\n`);
  console.error(`usage: node tests/visual/capture.mjs [options]

  --views a,b      views to capture (default: all)
                   known: ${VIEW_NAMES.join(', ')}
  --viewport v     ${Object.keys(VIEWPORTS).join(' | ')} | both (default: phone)
  --out DIR        output directory (default: tests/visual/shots/current)
  --accept         replace the baseline with this run
  --no-diff        skip the baseline comparison
  -h, --help       this message
`);
  process.exit(msg ? 2 : 0);
}

function parseArgs(argv) {
  const opts = { views: VIEW_NAMES, viewports: ['phone'], out: join(here, 'shots', 'current'),
                 accept: false, diff: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { const v = argv[++i]; if (v === undefined) usage(`${a} needs a value`); return v; };
    if (a === '-h' || a === '--help') usage();
    else if (a === '--views') {
      opts.views = next().split(',').map((s) => s.trim()).filter(Boolean);
      const unknown = opts.views.filter((v) => !VIEW_NAMES.includes(v));
      if (unknown.length) usage(`unknown view(s): ${unknown.join(', ')}`);
    }
    else if (a === '--viewport') {
      const v = next();
      if (v === 'both') opts.viewports = Object.keys(VIEWPORTS);
      else if (VIEWPORTS[v]) opts.viewports = [v];
      else usage(`unknown viewport '${v}'`);
    }
    else if (a === '--out') opts.out = next();
    else if (a === '--accept') opts.accept = true;
    else if (a === '--no-diff') opts.diff = false;
    else usage(`unrecognised argument '${a}'`);
  }
  return opts;
}

// --- Pixel diff (in-browser, canvas) ------------------------------------

async function diffPng(page, aBuf, bBuf) {
  return page.evaluate(async ({ a, b, tol }) => {
    const load = (dataUrl) => new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = rej;
      img.src = dataUrl;
    });
    const [ia, ib] = await Promise.all([load(a), load(b)]);
    if (ia.width !== ib.width || ia.height !== ib.height) {
      return { sizeMismatch: true, a: [ia.width, ia.height], b: [ib.width, ib.height] };
    }
    const ctx = (img) => {
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      const x = c.getContext('2d', { willReadFrequently: true });
      x.drawImage(img, 0, 0);
      return { canvas: c, ctx: x, data: x.getImageData(0, 0, c.width, c.height) };
    };
    const A = ctx(ia), B = ctx(ib);
    const out = B.ctx.createImageData(B.data.width, B.data.height);
    let changed = 0;
    for (let i = 0; i < A.data.data.length; i += 4) {
      const d = Math.max(
        Math.abs(A.data.data[i]     - B.data.data[i]),
        Math.abs(A.data.data[i + 1] - B.data.data[i + 1]),
        Math.abs(A.data.data[i + 2] - B.data.data[i + 2]),
      );
      const hit = d > tol;
      if (hit) changed++;
      // Changed pixels in red over a dimmed copy of the new shot, so the
      // overlay is readable rather than a field of noise.
      out.data[i]     = hit ? 255 : B.data.data[i] * 0.35;
      out.data[i + 1] = hit ? 0   : B.data.data[i + 1] * 0.35;
      out.data[i + 2] = hit ? 0   : B.data.data[i + 2] * 0.35;
      out.data[i + 3] = 255;
    }
    B.ctx.putImageData(out, 0, 0);
    const total = A.data.data.length / 4;
    return { sizeMismatch: false, changed, total, pct: changed / total, overlay: B.canvas.toDataURL('image/png') };
  }, { a: `data:image/png;base64,${aBuf.toString('base64')}`,
       b: `data:image/png;base64,${bBuf.toString('base64')}`,
       tol: CHANNEL_TOLERANCE });
}

// --- Main ---------------------------------------------------------------

const opts = parseArgs(process.argv.slice(2));
const server = await ensureServer();
const browser = await launch();
const errors = [];
let changedCount = 0;
let comparedCount = 0;

// A blank page used only as the canvas host for diffing.
const diffPage = await (await browser.newContext()).newPage();

try {
  for (const viewport of opts.viewports) {
    const outDir = join(opts.out, viewport);
    mkdirSync(outDir, { recursive: true });
    console.log(`\n${viewport} (${VIEWPORTS[viewport].width}x${VIEWPORTS[viewport].height})`);

    for (const view of opts.views) {
      const buf = await captureView(browser, { view, viewport }, { onError: errors });

      const file = join(outDir, `${view}.png`);
      writeFileSync(file, buf);

      const basefile = join(BASELINE_DIR, viewport, `${view}.png`);
      if (!opts.diff || !existsSync(basefile)) {
        console.log(`  ---- ${view.padEnd(10)} captured${opts.diff ? ' (no baseline)' : ''}`);
        continue;
      }

      comparedCount++;
      const d = await diffPng(diffPage, readFileSync(basefile), buf);
      if (d.sizeMismatch) {
        changedCount++;
        console.log(`  SIZE ${view.padEnd(10)} baseline ${d.a.join('x')} vs now ${d.b.join('x')}`);
        continue;
      }
      const pct = (d.pct * 100).toFixed(3);
      if (d.pct > DIFF_THRESHOLD) {
        changedCount++;
        const overlay = Buffer.from(d.overlay.split(',')[1], 'base64');
        writeFileSync(join(outDir, `${view}.diff.png`), overlay);
        console.log(`  DIFF ${view.padEnd(10)} ${pct}% of pixels -> ${view}.diff.png`);
      } else {
        rmSync(join(outDir, `${view}.diff.png`), { force: true });
        console.log(`  ok   ${view.padEnd(10)} ${pct}%`);
      }
    }
  }

  if (opts.accept) {
    for (const viewport of opts.viewports) {
      const dest = join(BASELINE_DIR, viewport);
      mkdirSync(dest, { recursive: true });
      for (const view of opts.views) {
        cpSync(join(opts.out, viewport, `${view}.png`), join(dest, `${view}.png`));
      }
    }
    console.log(`\nbaseline updated for: ${opts.views.join(', ')}`);
  }
} finally {
  await browser.close();
  await server.stop();
}

if (errors.length) {
  console.error(`\npage errors (a panel that throws renders nothing, which looks like a layout bug):`);
  for (const e of errors) console.error(`  ${e}`);
}

console.log(`\n${opts.views.length * opts.viewports.length} captured, ${comparedCount} compared, ${changedCount} changed`);
process.exit(changedCount || errors.length ? 1 : 0);
