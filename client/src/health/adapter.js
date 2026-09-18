// -----------------------------------------------------------------------------
// Title:       adapter.js
// Project:     Glim
// Author:      Reina Hastings (reinahastings13@gmail.com)
// Created:     2026-09-17
// Last Modified: 2026-09-17
// Purpose:     Picks the health adapter for the platform Glim is running on and
//              defines the contract every adapter satisfies. This is the seam
//              that keeps the rest of Glim platform-blind: the import service
//              and the UI talk only to this shape, never to a plugin.
//
//              The contract:
//                {
//                  source,                     // 'healthkit' | 'health_connect' | null
//                  isAvailable(),              // Promise<boolean>
//                  requestAccess(),            // Promise<void>, shows the OS prompt
//                  hasBeenAsked(),             // Promise<boolean>, PROMPT SHOWN, not granted
//                  readHourlySteps(from, to),  // Promise<[{ start, end, steps }]>
//                }
// Inputs:      None (reads Capacitor.getPlatform())
// Outputs:     getHealthAdapter() -> Promise<adapter>
//
// Usage example:
//   const adapter = await getHealthAdapter();
//   if (await adapter.isAvailable()) { ... }
// -----------------------------------------------------------------------------

import { Capacitor } from '@capacitor/core';
import { nullAdapter } from './nullAdapter';

// The plugin-backed adapter is loaded with a DYNAMIC import, on native only.
// A static import would pull @capgo/capacitor-health into the web bundle (dead
// weight for every PWA user) and into the Node test harness, where the plugin's
// module graph has no reason to load cleanly. Nothing above this file knows the
// plugin exists.
let cached = null;

export async function getHealthAdapter() {
  if (cached) return cached;

  const platform = Capacitor.getPlatform();
  const source =
    platform === 'ios'     ? 'healthkit' :
    platform === 'android' ? 'health_connect' :
    null;

  if (source === null) {
    cached = nullAdapter;
    return cached;
  }

  try {
    const { makePluginAdapter } = await import('./pluginAdapter');
    cached = makePluginAdapter(source);
  } catch (e) {
    // A native build whose plugin failed to load is a broken build, but it must
    // not take the whole app down: steps keep working manually.
    console.warn('[glim health] health plugin unavailable, falling back to the null adapter:', e);
    cached = nullAdapter;
  }
  return cached;
}

// Test seam only. The adapter is cached because Capacitor.getPlatform() and the
// dynamic import are both fixed for the life of the app.
export function __resetHealthAdapterCache() {
  cached = null;
}
