// title: tests/perf/characterise.mjs
// project: Glim
// author: Reina Hastings
// contact: reinahastings13@gmail.com
// date created: 2026-09-18
//
// purpose:
//   Characterises the creature's CURRENT pointer behaviour in real Chrome, so
//   that the fix-2 acceptance criteria can be written against what the app does
//   rather than against what its comments claim it does. Three plan reviews
//   found behaviour claims sourced from comments; this script replaces them
//   with observations.
//
//   Reports, it does not assert. It is the instrument, not the gate.
//
// inputs:  a built harness in client/dist-perf (npx vite build --config vite.config.perf.js)
// outputs: one JSON line per characterisation, plus a human-readable summary
//
// usage:
//   cd client
//   npx vite build --config vite.config.perf.js
//   node tests/perf/characterise.mjs
// -----------------------------------------------------------------------------

import { launchChrome, newPage, serve, sleep, movePath } from './cdp.mjs';

const PORT_HTTP = 8100, PORT_CDP = 9340;
const W = 1280, H = 800;
const CENTRE = { x: W / 2, y: H / 2 - 60 };   // over the creature
const PROFILE = '/tmp/glim-perf-chrome';

const say = (label, value) => console.log(`\n### ${label}\n${JSON.stringify(value, null, 1)}`);

const server = await serve('dist-perf', PORT_HTTP);
const chrome = await launchChrome(PROFILE, PORT_CDP);
let cdp;
try {
  cdp = await newPage(PORT_CDP, `http://127.0.0.1:${PORT_HTTP}/tests/perf/harness.html`);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride',
    { width: W, height: H, deviceScaleFactor: 2, mobile: false });
  await cdp.send('Page.bringToFront');

  for (let i = 0; i < 100; i++) {
    if (await cdp.eval(`!!window.__perf && !!window.__perf.creature()`)) break;
    await sleep(100);
  }
  await sleep(1200);   // let the entry animation settle

  const press   = (p) => cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed',  x: p.x, y: p.y, button: 'left', buttons: 1, clickCount: 1 });
  const release = (p) => cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', buttons: 0, clickCount: 1 });

  // =============================================================================
  //  1. Drag release: does the creature glide home over 3s, and with what
  //     transition on the element at the moment the transform changes?
  // =============================================================================
  {
    await press(CENTRE);
    await movePath(cdp, Array.from({ length: 20 }, (_, i) => ({ x: CENTRE.x + 5 * (i + 1), y: CENTRE.y })), 60, 1);
    const during = await cdp.eval('window.__perf.creature()');
    await release({ x: CENTRE.x + 100, y: CENTRE.y });
    const t0 = Date.now();
    const samples = [];
    for (const t of [0, 100, 500, 1500, 3400]) {
      const wait = t0 + t - Date.now();
      if (wait > 0) await sleep(wait);
      samples.push({ t, atMs: Date.now() - t0, ...(await cdp.eval('window.__perf.creature()')) });
    }
    say('1. drag release', { during, samples });
    await sleep(500);
  }

  // =============================================================================
  //  2. Pointer cancel: glide or snap? This is the contract the plan asserted
  //     from a code comment and a reviewer disputed from the CSS spec.
  // =============================================================================
  {
    await press(CENTRE);
    await movePath(cdp, Array.from({ length: 20 }, (_, i) => ({ x: CENTRE.x + 5 * (i + 1), y: CENTRE.y })), 60, 1);
    const beforeCancel = await cdp.eval('window.__perf.creature()');
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: CENTRE.x + 100, y: CENTRE.y, buttons: 1 });
    // A real pointercancel: dispatched into the page, since CDP has no direct verb.
    await cdp.eval(`(() => {
      const el = document.querySelector('[style*="touch-action"]');
      el.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: 1 }));
      window.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: 1 }));
    })()`);
    const t0 = Date.now();
    const samples = [];
    for (const t of [0, 60, 300, 1500]) {
      const wait = t0 + t - Date.now();
      if (wait > 0) await sleep(wait);
      samples.push({ t, atMs: Date.now() - t0, ...(await cdp.eval('window.__perf.creature()')) });
    }
    say('2. pointercancel', { beforeCancel, samples });
    await release(CENTRE);
    await sleep(500);
  }

  // =============================================================================
  //  3. Purr then click: does the click following a purr get swallowed by the
  //     `if (isPurring) return` guard? This is the timing a ref conversion would
  //     change.
  // =============================================================================
  {
    await cdp.eval('window.__perf._msgs = []; window.__perf.stores.useMessageStore.subscribe(s => window.__perf._msgs.push(s.message))');
    await press(CENTRE);
    await sleep(700);                                   // past the 500ms purr hold
    const duringHold = await cdp.eval('({ purring: window.__perf.stores.useCreatureStore.getState().isPurring, text: window.__perf.bubble().slice(0, 60) })');
    await release(CENTRE);
    await sleep(50);
    const afterRelease = await cdp.eval('({ purring: window.__perf.stores.useCreatureStore.getState().isPurring, msgs: window.__perf._msgs.slice(-3) })');
    say('3. purr then click', { duringHold, afterRelease });
    await sleep(500);
  }

  // =============================================================================
  //  4. Pupil remount: what are the eye nodes doing, does a purr suppress eye
  //     tracking, and what transition do the pupils carry?
  // =============================================================================
  {
    await movePath(cdp, [{ x: CENTRE.x + 200, y: CENTRE.y + 100 }], 60);
    await sleep(300);
    const tracking = await cdp.eval('window.__perf.eyes()');

    // Eye tracking during a purr: the plan claimed purring suppresses it.
    await cdp.eval('window.__perf.stores.useCreatureStore.getState().setIsPurring(true)');
    await sleep(100);
    const duringPurrNodes = await cdp.eval('window.__perf.eyes()');
    await movePath(cdp, [{ x: CENTRE.x - 200, y: CENTRE.y - 100 }], 60);
    await sleep(150);
    await cdp.eval('window.__perf.stores.useCreatureStore.getState().setIsPurring(false)');
    await sleep(150);
    const afterPurr = await cdp.eval('window.__perf.eyes()');

    // Blink remount: unmounts and remounts the pupils.
    await cdp.eval('window.__perf.stores.useCreatureStore.getState().setIsBlinking(true)');
    await sleep(80);
    const duringBlink = await cdp.eval('window.__perf.eyes()');
    await cdp.eval('window.__perf.stores.useCreatureStore.getState().setIsBlinking(false)');
    await sleep(120);
    const afterBlink = await cdp.eval('window.__perf.eyes()');

    say('4. eyes', { tracking, duringPurrNodes, afterPurr, duringBlink, afterBlink });
  }

  // =============================================================================
  //  5. Timer commit noise: how many store snapshot changes happen with NO input
  //     at all? Criterion 2's "zero commits" has to live with this.
  // =============================================================================
  {
    await cdp.eval('window.__perf.countStart()');
    await sleep(4000);
    const idle = await cdp.eval('window.__perf.countStop()');

    await cdp.eval('window.__perf.countStart()');
    await movePath(cdp, Array.from({ length: 180 }, (_, i) => ({
      x: Math.round(W / 2 + Math.sin(i / 8) * 200), y: Math.round(H / 2 + Math.cos(i / 6) * 120),
    })), 60);
    const moving = await cdp.eval('window.__perf.countStop()');
    say('5. store snapshot changes', { idleSixSeconds: idle, threeSecondsOfPointerMoves: moving });
  }

} finally {
  cdp?.close();
  chrome.kill();
  server.close();
}
