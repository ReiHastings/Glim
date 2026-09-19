// title: tests/perf/harness.jsx
// project: Glim
// author: Reina Hastings
// contact: reinahastings13@gmail.com
// date created: 2026-09-18
//
// purpose:
//   Mount point for the CDP performance and behaviour harness. Renders
//   DesktopPet directly, skipping App.jsx and therefore the Firebase auth gate.
//
//   DELIBERATELY NOT tests/visual/harness.jsx. That one exists to make
//   SCREENSHOTS deterministic, and to get there it disables CSS transitions,
//   stubs cancelAnimationFrame, pins the clock and replaces requestAnimationFrame
//   with a budgeted queue. Every one of those is a mechanism this harness has to
//   observe rather than suppress: transitions ARE the behaviour under test (the
//   creature's 3s glide home, the pupils' 0.1s ease), and rAF is where pointer
//   work is scheduled. The two harnesses answer different questions and neither
//   can do the other's job.
//
//   No StrictMode: double-invoked effects would stack the window listeners and
//   timers this harness counts.
//
// inputs:  none
// outputs: a mounted DesktopPet, plus window.__perf for the driver
// -----------------------------------------------------------------------------

import { createRoot } from 'react-dom/client';
import '../../src/index.css';
import DesktopPet from '../../src/DesktopPet.jsx';
import * as stores from '../../src/stores';

// The draggable wrapper is the only element in the tree carrying touch-action,
// which React serialises into the style attribute. Selecting it by that is
// sturdier than an index path through the layout divs.
const creatureEl = () => document.querySelector('[style*="touch-action"]');

// OwlMoth's SVG, identified by its viewBox. `#root svg` would find Background's
// landscape (viewBox 0 0 3200 400), which was the first version's bug.
const owlSvg = () => document.querySelector('svg[viewBox="0 0 220 240"]');

// The four eye nodes. Identified by POSITION IN BOTH AXES, not by cx alone:
// the body carries decorative spots that also sit near cx 97 and 123 (one at
// cx=128, cy=199 was matched as the right pupil by the first version of this
// function, which made every pupil reading nonsense). The eyes sit at cy 95
// (pupils) and cy 92 (highlights); nothing else in the SVG is near there.
function eyeNodes() {
  const svg = owlSvg();
  if (!svg) return { pupilL: null, pupilR: null, highlightL: null, highlightR: null };
  const circles = [...svg.querySelectorAll('circle')];
  const num = (c, a) => parseFloat(c.getAttribute(a));
  const near = (v, target, tol = 12) => Math.abs(v - target) < tol;
  const pupil = (baseCx) => circles.find(c =>
    near(num(c, 'cx'), baseCx) && near(num(c, 'cy'), 95, 6) && num(c, 'r') > 2.5) ?? null;
  const highlight = (baseCx) => circles.find(c =>
    near(num(c, 'cx'), baseCx, 6) && near(num(c, 'cy'), 92, 4) && num(c, 'r') === 2.5) ?? null;
  return {
    pupilL: pupil(97), pupilR: pupil(123),
    highlightL: highlight(99), highlightR: highlight(125),
  };
}

const read = (el) => el && ({
  cx: parseFloat(el.getAttribute('cx')),
  cy: parseFloat(el.getAttribute('cy')),
});

window.__perf = {
  stores,

  // --- Observation -------------------------------------------------------
  // Reports the STORE and the DOM together. Reading only the DOM makes a
  // mis-sampled run indistinguishable from a real behaviour change, which cost
  // one confusing characterisation run before this was added.
  creature: () => {
    const el = creatureEl();
    if (!el) return null;
    const cs = getComputedStyle(el);
    const c = stores.useCreatureStore.getState();
    return {
      transform:          cs.transform,
      transitionProperty: cs.transitionProperty,
      transitionDuration: cs.transitionDuration,
      inlineTransform:    el.style.transform,
      dragPos:            c.dragPos,
      isDragging:         c.isDragging,
      isReturning:        c.isReturning,
    };
  },

  eyes: () => {
    const n = eyeNodes();
    return {
      pupilL: read(n.pupilL), pupilR: read(n.pupilR),
      highlightL: read(n.highlightL), highlightR: read(n.highlightR),
      pupilTransition: n.pupilL
        ? `${getComputedStyle(n.pupilL).transitionProperty} / ${getComputedStyle(n.pupilL).transitionDuration}`
        : null,
    };
  },

  bubble: () => document.querySelector('#root')?.innerText ?? '',

  // --- Store mutation counting (criterion 2's raw material) ---------------
  // Counts SNAPSHOT changes, which is what a no-selector subscriber (and so a
  // React commit of DesktopPet) sees.
  countStart() {
    this._counts = { creature: 0, message: 0, ui: 0 };
    this._offs = [
      stores.useCreatureStore.subscribe(() => { this._counts.creature++; }),
      stores.useMessageStore.subscribe(() => { this._counts.message++; }),
      stores.useUIStore.subscribe(() => { this._counts.ui++; }),
    ];
    this._snapshot = stores.useCreatureStore.getState();
  },
  countStop() {
    this._offs?.forEach(off => off());
    return {
      ...this._counts,
      creatureIdentityUnchanged: Object.is(this._snapshot, stores.useCreatureStore.getState()),
    };
  },
};

createRoot(document.getElementById('root')).render(<DesktopPet />);
