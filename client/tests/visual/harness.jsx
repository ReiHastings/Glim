// title: harness.jsx
// project: Glim
// author: Reina Hastings
// contact: reinahastings13@gmail.com
// created: 2026-09-18
//
// purpose:
//   Dev-only mount point for the visual harness. Renders DesktopPet directly,
//   skipping App.jsx and therefore the Firebase auth gate: DesktopPet imports
//   no Firebase and no sync module, so nothing here touches the network or a
//   real account. This is why the harness needs no test credentials and no
//   emulator.
//
//   Differences from src/main.jsx, all deliberate:
//     - No StrictMode. StrictMode double-invokes effects, and several of
//       Glim's creature effects schedule timers on mount; a screenshot taken
//       across a double mount is not reproducible.
//     - No service worker registration. A SW would cache the harness bundle
//       and serve a stale page after an edit, which in a tweak-and-look loop
//       looks exactly like "my change did nothing".
//
//   Exposes window.__glim so the Playwright driver can drive views through the
//   real stores instead of clicking through the UI. Clicking is slower and, on
//   a missed selector, silently screenshots the wrong panel.
//
// inputs:  none (loaded by tests/visual/harness.html via the Vite dev server)
// outputs: a mounted DesktopPet, and window.__glim for the driver
//
// usage:
//   npm run dev, then open http://localhost:5173/Glim/tests/visual/harness.html
//   (normally driven by tests/visual/capture.mjs rather than opened by hand)

import { createRoot } from 'react-dom/client';
import '../../src/index.css';
import DesktopPet from '../../src/DesktopPet.jsx';
import { useUIStore } from '../../src/stores/useUIStore';
import { useWaterStore } from '../../src/stores/useWaterStore';
import { reloadAllStores } from '../../src/stores';

// The driver seeds localStorage BEFORE the page loads, so the stores hydrate
// from the seed on their first read and no reload is needed for the common
// case. reloadAllStores is exposed anyway for re-seeding within one page.
window.__glim = {
  ui: useUIStore,
  // Exposed so the fill checker can read the count the store ACTUALLY holds
  // after hydrating from the seed, rather than inferring it from the rendered
  // pixels. A seed that silently loses entries is the failure this catches.
  water: useWaterStore,
  reloadAllStores,
  // Set last, and read by the driver as the readiness signal: a driver that
  // proceeds on DOMContentLoaded alone can screenshot before React has painted.
  ready: false,
};

createRoot(document.getElementById('root')).render(<DesktopPet />);

// One frame after mount, so `ready` implies the first paint has happened.
requestAnimationFrame(() => requestAnimationFrame(() => { window.__glim.ready = true; }));
