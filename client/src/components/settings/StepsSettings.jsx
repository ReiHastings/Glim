// -----------------------------------------------------------------------------
// Title:       StepsSettings.jsx
// Project:     Glim
// Author:      Reina Hastings (reinahastings13@gmail.com)
// Created:     2026-04-13
// Last Modified: 2026-04-13
// Purpose:     Steps tracker settings section. Single daily goal input with
//              auto-derived tier preview bar (25%/50%/75%/100%, first three
//              rounded to nearest 100), plus the health-import toggle on
//              devices that have a health platform (Phase 2).
//
//              THE TOGGLE IS THE CONSENT. The iOS permission sheet is shown
//              only when the user switches it on, with the consent text on
//              screen above it, which is what Apple's guidance and review
//              outcomes favour over a prompt at first launch. The toggle is
//              device-local (see health/deviceRecord.js) and hidden entirely
//              where no health data exists, so the PWA and desktop tab never
//              see it.
// Inputs:      useStepsStore (goal, setGoal), the health adapter, the device
//              health record
// Outputs:     Accordion section content (rendered inside SettingsView)
// -----------------------------------------------------------------------------

import { useState, useEffect } from 'react';
import { useStepsStore, computeTiers } from '../../stores/useStepsStore';
import { getHealthAdapter } from '../../health/adapter';
import { readDeviceRecord, writeDeviceRecord } from '../../health/deviceRecord';
import { importSteps } from '../../health/stepsImport';

const TEAL = '#5eead4';
const TEAL_DIM = 'rgba(94, 234, 212, 0.3)';

const inputBase = {
  width: 90, padding: '8px 10px',
  background: 'rgba(15,20,35,0.6)',
  border: '1px solid rgba(100,120,160,0.2)',
  borderRadius: 8, color: 'rgba(200,210,230,0.9)',
  fontSize: 'var(--glim-text-lg)', fontWeight: 600, textAlign: 'center',
  outline: 'none', fontVariantNumeric: 'tabular-nums',
  transition: 'border-color 0.15s',
};

export function stepsSummary(store) {
  return `goal: ${store.goal.toLocaleString()}/day`;
}

export const stepsIcon = (
  <div style={{
    width: 32, height: 32, borderRadius: 8,
    background: TEAL_DIM,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    flexShrink: 0,
  }}>
    <svg viewBox="0 0 24 24" width={18} height={18} fill={TEAL} stroke="none" style={{ display: 'block' }}>
      <path d="M6,17 Q5.5,19.5 8.5,19.5 Q10.5,19.5 11.2,18.3 Q11.5,17.7 12,17 Q12.5,17.7 12.8,18.3 Q13.5,19.5 15.5,19.5 Q18.5,19.5 18,17 Q18,15 16.5,12.5 Q15,10 12,9.5 Q9,10 7.5,12.5 Q6,15 6,17Z" />
      <ellipse cx="6.0" cy="7.5" rx="2.2" ry="2.7" transform="rotate(22 6.0 7.5)" />
      <ellipse cx="18.0" cy="7.5" rx="2.2" ry="2.7" transform="rotate(-22 18.0 7.5)" />
      <ellipse cx="9.8" cy="4.5" rx="2.0" ry="2.6" transform="rotate(10 9.8 4.5)" />
      <ellipse cx="14.2" cy="4.5" rx="2.0" ry="2.6" transform="rotate(-10 14.2 4.5)" />
    </svg>
  </div>
);

// --- Health import toggle -----------------------------------------------------

function HealthImportToggle() {
  // null = still asking the platform. The row stays hidden until the answer is
  // known, so a device with no health data never flashes a toggle it cannot
  // honour.
  const [available, setAvailable] = useState(null);
  const [on, setOn] = useState(() => readDeviceRecord().stepsImport);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const adapter = await getHealthAdapter();
        const ok = await adapter.isAvailable();
        if (alive) setAvailable(ok);
      } catch {
        if (alive) setAvailable(false);
      }
    })();
    return () => { alive = false; };
  }, []);

  if (available !== true) return null;

  const turnOn = async () => {
    setBusy(true);
    setFailed(false);
    setOn(true);
    writeDeviceRecord({ stepsImport: true });
    try {
      const adapter = await getHealthAdapter();
      // Shows the iOS sheet. Resolves when it is dismissed, whether or not
      // anything was granted: iOS never tells an app that a read was denied.
      await adapter.requestAccess();
      writeDeviceRecord({ askedAt: new Date().toISOString() });
    } catch (e) {
      // The request itself failed, so the prompt was never shown. Revert to off
      // rather than leaving the toggle on with nothing arriving and no
      // explanation: askedAt stays null, which keeps the panel's empty-state
      // copy (which means "asked, but quiet") from appearing wrongly.
      console.warn('[glim health] requestAccess failed:', e);
      writeDeviceRecord({ stepsImport: false, askedAt: null });
      setOn(false);
      setFailed(true);
      setBusy(false);
      return;
    }
    // force: the interval floor would otherwise swallow this first read, and
    // the user is watching the panel for a number right now.
    await importSteps({ reason: 'toggle', force: true }).catch(e =>
      console.warn('[glim health] first import failed:', e));
    setBusy(false);
  };

  const turnOff = () => {
    // Deletes nothing. Imported rows are historical facts and stay visible;
    // the platform permission cannot be revoked from inside the app either.
    writeDeviceRecord({ stepsImport: false });
    setOn(false);
    setFailed(false);
  };

  return (
    <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid rgba(100,120,160,0.12)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div style={{
          fontSize: 'var(--glim-text-sm)', color: 'rgba(200,210,230,0.5)',
          fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.5px',
        }}>
          import steps from health
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label="import steps from health"
          disabled={busy}
          onClick={(e) => { e.stopPropagation(); if (!busy) (on ? turnOff() : turnOn()); }}
          style={{
            width: 44, height: 24, flexShrink: 0, padding: 2,
            borderRadius: 12, cursor: busy ? 'default' : 'pointer',
            background: on ? 'rgba(94,234,212,0.35)' : 'rgba(15,20,35,0.6)',
            border: `1px solid ${on ? 'rgba(94,234,212,0.5)' : 'rgba(100,120,160,0.2)'}`,
            opacity: busy ? 0.6 : 1,
            transition: 'background 0.15s, border-color 0.15s',
          }}
        >
          <div style={{
            width: 18, height: 18, borderRadius: '50%',
            background: on ? TEAL : 'rgba(200,210,230,0.4)',
            transform: `translateX(${on ? 20 : 0}px)`,
            transition: 'transform 0.15s, background 0.15s',
          }} />
        </button>
      </div>

      {/* Consent text. Names what is read, where it goes, what is never read,
          and that Glim never writes back - the four things Apple's guideline
          5.1.3 and plain honesty both ask for. */}
      <div style={{
        marginTop: 8, fontSize: 'var(--glim-text-xs)',
        color: 'rgba(200,210,230,0.45)', lineHeight: 1.5,
      }}>
        glim reads your daily step counts from health, and nothing else. they go to
        your glim account so your other devices can see them. glim never writes
        anything back to health.
      </div>

      {failed && (
        <div style={{
          marginTop: 8, fontSize: 'var(--glim-text-xs)',
          color: 'rgba(251,146,60,0.8)', lineHeight: 1.5,
        }}>
          couldn&apos;t ask health for access just now. try the switch again?
        </div>
      )}
    </div>
  );
}

export default function StepsSettings() {
  const { goal, setGoal } = useStepsStore();
  const tiers = computeTiers(goal);

  // Tier bar segment opacities: 25%, 40%, 60%, 85%
  const segmentOpacities = [0.25, 0.40, 0.60, 0.85];

  return (
    <div style={{ padding: '4px 16px 16px 16px', borderTop: '1px solid rgba(100,120,160,0.12)' }}>
      {/* Daily goal input */}
      <div style={{ marginTop: 10 }}>
        <div style={{
          fontSize: 'var(--glim-text-sm)', color: 'rgba(200,210,230,0.5)', marginBottom: 6,
          fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.5px',
        }}>
          daily goal
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <input
            type="number"
            value={goal}
            min={1000}
            max={50000}
            step={500}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => {
              const v = parseInt(e.target.value);
              if (v >= 100 && v <= 50000) setGoal(v);
            }}
            onFocus={(e) => { e.target.style.borderColor = 'rgba(94,234,212,0.4)'; }}
            onBlur={(e) => { e.target.style.borderColor = 'rgba(100,120,160,0.2)'; }}
            style={inputBase}
          />
          <span style={{ fontSize: 'var(--glim-text-base)', color: 'rgba(200,210,230,0.5)' }}>steps</span>
        </div>
      </div>

      {/* Tier preview */}
      <div style={{
        marginTop: 10, padding: '10px 12px',
        background: 'rgba(15,20,35,0.4)',
        borderRadius: 8, border: '1px solid rgba(100,120,160,0.12)',
      }}>
        <div style={{
          fontSize: 'var(--glim-text-xs)', color: 'rgba(200,210,230,0.35)',
          textTransform: 'uppercase', letterSpacing: '0.5px',
          marginBottom: 8, fontWeight: 500,
        }}>
          auto-generated milestones
        </div>
        {/* Bar */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 2, height: 8, marginBottom: 6 }}>
          {segmentOpacities.map((opacity, i) => (
            <div key={i} style={{
              flex: 1, height: '100%', borderRadius: 2,
              background: `rgba(94, 234, 212, ${opacity})`,
              transition: 'background 0.3s',
            }} />
          ))}
        </div>
        {/* Labels */}
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          {tiers.map((t, i) => (
            <span key={i} style={{
              fontSize: 'var(--glim-text-2xs)', color: 'rgba(200,210,230,0.35)',
              fontVariantNumeric: 'tabular-nums',
            }}>
              {t.toLocaleString()}
            </span>
          ))}
        </div>
      </div>

      <HealthImportToggle />
    </div>
  );
}
