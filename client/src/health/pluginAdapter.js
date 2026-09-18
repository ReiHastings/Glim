// -----------------------------------------------------------------------------
// Title:       pluginAdapter.js
// Project:     Glim
// Author:      Reina Hastings (reinahastings13@gmail.com)
// Created:     2026-09-17
// Last Modified: 2026-09-17
// Purpose:     The health adapter backed by @capgo/capacitor-health, serving
//              both HealthKit (iOS) and Health Connect (Android, Phase 4).
//
//              THE ONLY MODULE IN GLIM THAT IMPORTS THE HEALTH PLUGIN, and it
//              is reached only through the dynamic import in adapter.js on a
//              native platform. Everything above the adapter is platform-blind,
//              and web builds and Node tests never evaluate this file.
//
//              API shape verified against the INSTALLED plugin 8.7.0
//              (dist/esm/definitions.d.ts and ios/Sources/HealthPlugin/
//              Health.swift), not the README, which was wrong about the
//              authorization result shape.
// Inputs:      A source tag ('healthkit' | 'health_connect') and Date ranges.
// Outputs:     makePluginAdapter(source) -> adapter object (see adapter.js)
//
// Usage example:
//   const adapter = makePluginAdapter('healthkit');
//   const buckets = await adapter.readHourlySteps(from, to);
// -----------------------------------------------------------------------------

import { Health } from '@capgo/capacitor-health';

// The plugin's literal for step counts (HealthDataType union in definitions.d.ts).
const STEPS = 'steps';

export function makePluginAdapter(source) {
  return {
    source,

    async isAvailable() {
      try {
        const res = await Health.isAvailable();
        return res?.available === true;
      } catch (e) {
        // A throwing availability check means the native side is not usable,
        // which is the same outcome for callers as "not available".
        console.warn('[glim health] isAvailable failed:', e);
        return false;
      }
    },

    // Shows the platform permission sheet. Resolves when the sheet is
    // dismissed, WHETHER OR NOT the user granted anything: iOS deliberately
    // hides a denied read from the app (see hasBeenAsked).
    //
    // Only `read` is passed. The plugin then calls HealthKit's
    // requestAuthorization with an EMPTY share set, so Glim never asks for
    // write access and the "app may write to Health" line never appears on
    // the sheet.
    async requestAccess() {
      await Health.requestAuthorization({ read: [STEPS] });
    },

    // TRUE MEANS "THE PROMPT HAS BEEN SHOWN", NOT "ACCESS WAS GRANTED."
    //
    // iOS refuses to tell an app that a read was denied, because knowing would
    // itself leak health information (an app could infer a condition from the
    // refusal). HealthKit only reports whether it still NEEDS to ask, and the
    // plugin maps that to readAuthorized/readDenied: `.unnecessary` (already
    // asked) becomes authorized, and `.shouldRequest`, `.unknown`, and any
    // error become denied.
    //
    // So a denied read is indistinguishable from an empty Health database. No
    // code above this adapter may treat a true here as permission, and Glim's
    // copy must never tell the user they denied access - only that nothing is
    // arriving, and where to look.
    async hasBeenAsked() {
      try {
        const res = await Health.checkAuthorization({ read: [STEPS] });
        return Array.isArray(res?.readAuthorized) && res.readAuthorized.includes(STEPS);
      } catch (e) {
        console.warn('[glim health] checkAuthorization failed:', e);
        return false;
      }
    },

    // Hourly step totals in [from, to). Buckets are aligned to local midnight by
    // the platform, NOT to `from`; folding them into Glim's 3 AM day is
    // health/fold.js's job.
    //
    // queryAggregated, never readSamples: HealthKit de-duplicates overlapping
    // samples from the iPhone and the Watch only when asked for a STATISTIC.
    // Summing raw samples would double-count every step taken while wearing
    // both. The plugin's aggregation runs HKStatisticsCollectionQuery with
    // cumulativeSum, which is the de-duplicated figure the Health app shows.
    //
    // An hour with no steps yields NO bucket at all (verified in the plugin's
    // Swift: a sample is appended only when sumQuantity() is non-nil). The fold
    // relies on that to tell "health has nothing for this day" apart from
    // "health says zero".
    async readHourlySteps(from, to) {
      const res = await Health.queryAggregated({
        dataType:    STEPS,
        startDate:   from.toISOString(),   // inclusive
        endDate:     to.toISOString(),     // EXCLUSIVE, per the plugin's definitions
        bucket:      'hour',
        aggregation: 'sum',
      });

      const samples = Array.isArray(res?.samples) ? res.samples : [];
      return samples.map(s => ({
        start: new Date(s.startDate),
        end:   new Date(s.endDate),
        steps: s.value,
      }));
    },
  };
}
