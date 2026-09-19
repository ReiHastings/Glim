// title: sweep.mjs
// project: Glim
// author: Reina Hastings
// contact: reinahastings13@gmail.com
// created: 2026-09-18
//
// purpose:
//   Render one view at several values of a design token and stitch the results
//   into a single labelled contact sheet. This is the part of the workflow that
//   replaces "change a number, rebuild, look, change it again": you compare six
//   candidates in one image and pick, and only the chosen value is ever written
//   to index.css.
//
//   Nothing is written to src/. Values are applied as inline custom properties
//   on the root element at runtime (see browser.mjs (4) for why an injected
//   :root rule would silently lose to the media-query block at phone width).
//
//   The sheet is assembled in the browser from the captured PNGs, so the
//   harness needs no image library.
//
// inputs:
//   --view NAME       a view from tests/visual/views.mjs   (required)
//   --token NAME      the custom property to sweep         (required)
//   --values a,b,c    values to try                        (required)
//   --viewport v      phone | desktop                      (default: phone)
//   --out FILE        output png  (default: shots/sweeps/<view>-<token>.png)
//
// outputs:
//   one PNG contact sheet, one panel per value, each labelled with its value.
//   Exit 0 on success, 2 on a usage error.
//
// usage:
//   cd client && node tests/visual/sweep.mjs \
//     --view steps --token --glim-text-hero --values 32px,36px,40px,44px,48px
//
//   cd client && node tests/visual/sweep.mjs \
//     --view nutrition --token --glim-nutrition-label-w --values 44px,52px,60px,68px

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureServer, launch, openView } from './browser.mjs';
import { VIEW_NAMES, VIEWPORTS } from './views.mjs';

const here = dirname(fileURLToPath(import.meta.url));

function usage(msg) {
  if (msg) console.error(`error: ${msg}\n`);
  console.error(`usage: node tests/visual/sweep.mjs --view NAME --token NAME --values a,b,c [options]

  --view NAME      ${VIEW_NAMES.join(', ')}
  --token NAME     custom property, e.g. --glim-text-hero
  --values a,b,c   comma-separated values, e.g. 36px,40px,44px
  --viewport v     ${Object.keys(VIEWPORTS).join(' | ')} (default: phone)
  --out FILE       output path (default: tests/visual/shots/sweeps/<view>-<token>.png)
  -h, --help       this message

example:
  node tests/visual/sweep.mjs --view steps --token --glim-text-hero \\
    --values 32px,36px,40px,44px,48px
`);
  process.exit(msg ? 2 : 0);
}

function parseArgs(argv) {
  const o = { view: null, token: null, values: null, viewport: 'phone', out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { const v = argv[++i]; if (v === undefined) usage(`${a} needs a value`); return v; };
    if (a === '-h' || a === '--help') usage();
    else if (a === '--view') o.view = next();
    else if (a === '--token') o.token = next();
    else if (a === '--values') o.values = next().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--viewport') o.viewport = next();
    else if (a === '--out') o.out = next();
    else usage(`unrecognised argument '${a}'`);
  }
  if (!o.view) usage('--view is required');
  if (!VIEW_NAMES.includes(o.view)) usage(`unknown view '${o.view}'`);
  if (!o.token) usage('--token is required');
  if (!o.token.startsWith('--')) usage(`token must be a custom property, e.g. --glim-text-hero (got '${o.token}')`);
  if (!o.values?.length) usage('--values is required');
  if (!VIEWPORTS[o.viewport]) usage(`unknown viewport '${o.viewport}'`);
  o.out ??= join(here, 'shots', 'sweeps', `${o.view}-${o.token.replace(/^--/, '')}.png`);
  return o;
}

// --- Contact sheet ------------------------------------------------------
// Assembled as an HTML page and screenshotted, so no image library is needed.
// Panels are laid out in a single row: comparing a type scale is a horizontal
// judgement, and wrapping to a second row breaks it.

async function buildSheet(page, { panels, title, panelWidth }) {
  const html = `<!doctype html><meta charset="utf-8">
<style>
  :root { color-scheme: dark; }
  body { margin: 0; background: #14141c; color: #e8e8f0;
         font: 14px ui-monospace, SFMono-Regular, Menlo, monospace; }
  h1 { font-size: 15px; font-weight: 500; margin: 20px 24px 4px; color: #b9b9c8; }
  .sub { margin: 0 24px 18px; color: #7a7a8c; font-size: 12px; }
  .row { display: flex; gap: 20px; padding: 0 24px 24px; align-items: flex-start; }
  figure { margin: 0; }
  img { display: block; width: ${panelWidth}px; height: auto;
        border: 1px solid #2c2c3a; border-radius: 10px; }
  figcaption { margin-top: 8px; text-align: center; color: #e8e8f0; font-size: 13px; }
</style>
<h1>${title}</h1>
<div class="sub">each panel is the same view and the same seed; only the token differs</div>
<div class="row">
${panels.map((p) => `<figure><img src="${p.dataUrl}"><figcaption>${p.label}</figcaption></figure>`).join('\n')}
</div>`;

  await page.setContent(html, { waitUntil: 'load' });
  // Size the viewport to the assembled content so the screenshot is the sheet
  // itself rather than a window onto it. Measured from the content's own
  // bounding box, not scrollWidth/scrollHeight: those never report less than
  // the viewport, so a short sheet would be padded with a band of empty
  // background down to the default 720px.
  const box = await page.evaluate(() => {
    const row = document.querySelector('.row');
    const last = row.lastElementChild.getBoundingClientRect();
    return {
      w: Math.ceil(last.right + 24),
      h: Math.ceil(last.bottom + 24),
    };
  });
  await page.setViewportSize({ width: box.w, height: box.h });
  return page.screenshot();
}

// --- Main ---------------------------------------------------------------

const opts = parseArgs(process.argv.slice(2));
const server = await ensureServer();
const browser = await launch();

try {
  const panels = [];
  for (const value of opts.values) {
    process.stdout.write(`  ${opts.token}: ${value} ... `);
    const page = await openView(browser, {
      view: opts.view,
      viewport: opts.viewport,
      tokens: { [opts.token]: value },
    });
    const buf = await page.screenshot();
    await page.context().close();
    panels.push({ label: value, dataUrl: `data:image/png;base64,${buf.toString('base64')}` });
    console.log('captured');
  }

  const sheetPage = await (await browser.newContext({ deviceScaleFactor: 2 })).newPage();
  const sheet = await buildSheet(sheetPage, {
    panels,
    title: `${opts.view} / ${opts.token} / ${opts.viewport}`,
    // Half the CSS width, so five phone panels fit a readable sheet. The source
    // images are 3x, so they stay sharp at this size.
    panelWidth: Math.round(VIEWPORTS[opts.viewport].width / 2),
  });

  mkdirSync(dirname(opts.out), { recursive: true });
  writeFileSync(opts.out, sheet);
  console.log(`\nsheet: ${opts.out}`);
} finally {
  await browser.close();
  await server.stop();
}
