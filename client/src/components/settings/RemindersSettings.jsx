// -----------------------------------------------------------------------------
// Title:       RemindersSettings.jsx
// Project:     Glim
// Author:      Reina Hastings (reinahastings13@gmail.com)
// Created:     2026-04-13
// Last Modified: 2026-09-06
// Purpose:     Reminder interval settings section for the focus-mode settings
//              view. Three sliders (wellness, move, eyes) with amber accent, plus
//              the opt-in end-of-day symptom reminder (off by default). That one
//              is IN-APP ONLY: it prompts when the app is open or foregrounded,
//              never through a system notification.
//              Reads/writes useSettingsStore directly.
// Inputs:      useSettingsStore (intervals + setters)
// Outputs:     Accordion section content (rendered inside SettingsView)
// -----------------------------------------------------------------------------

import { useSettingsStore } from '../../stores/useSettingsStore';

const AMBER = '#fbbf24';
const AMBER_DIM = 'rgba(251, 191, 36, 0.3)';

const sliderThumbStyle = `
  input[type="range"].amber-slider::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 18px; height: 18px; border-radius: 50%;
    background: ${AMBER}; border: none; cursor: pointer;
  }
  input[type="range"].amber-slider::-moz-range-thumb {
    width: 18px; height: 18px; border-radius: 50%;
    background: ${AMBER}; border: none; cursor: pointer;
  }
`;

// `format` exists so the hour selector can read "9pm" instead of "21 min":
// the three interval sliders keep the default.
function Slider({ label, value, min, max, onChange, format = (v) => `${v} min` }) {
  return (
    <div style={{ marginTop: 14 }}>
      <div style={{
        fontSize: 'var(--glim-text-sm)', color: 'rgba(200,210,230,0.5)', marginBottom: 6,
        fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.5px',
      }}>
        {label}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <input
          type="range"
          className="amber-slider"
          min={min}
          max={max}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          onClick={(e) => e.stopPropagation()}
          style={{
            WebkitAppearance: 'none', appearance: 'none',
            flex: 1, height: 4, borderRadius: 2,
            background: 'rgba(100,120,160,0.2)', outline: 'none',
          }}
        />
        <span style={{
          fontSize: 'var(--glim-text-base)', fontWeight: 600, minWidth: 42, textAlign: 'right',
          fontVariantNumeric: 'tabular-nums', color: AMBER,
        }}>
          {format(value)}
        </span>
      </div>
    </div>
  );
}

// Formats an hour-of-day (0-23) as Glim writes clock times elsewhere: lowercase
// meridiem, no leading zero.
function hourLabel(hour) {
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}${hour < 12 ? 'am' : 'pm'}`;
}

function Toggle({ label, checked, onChange }) {
  return (
    <div
      onClick={(e) => { e.stopPropagation(); onChange(!checked); }}
      style={{
        marginTop: 14, display: 'flex', alignItems: 'center', gap: 10,
        cursor: 'pointer',
      }}
    >
      <div style={{
        width: 38, height: 22, borderRadius: 11, flexShrink: 0,
        background: checked ? AMBER_DIM : 'rgba(100,120,160,0.2)',
        border: `1px solid ${checked ? AMBER : 'rgba(100,120,160,0.3)'}`,
        display: 'flex', alignItems: 'center',
        padding: 2, transition: 'background 150ms ease-out',
      }}>
        <div style={{
          width: 16, height: 16, borderRadius: '50%',
          background: checked ? AMBER : 'rgba(200,210,230,0.5)',
          transform: `translateX(${checked ? 16 : 0}px)`,
          transition: 'transform 150ms ease-out',
        }} />
      </div>
      <span style={{
        fontSize: 'var(--glim-text-sm)', color: 'rgba(200,210,230,0.5)',
        fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.5px',
      }}>
        {label}
      </span>
    </div>
  );
}

export function remindersSummary(store) {
  return `wellness ${store.wellnessInterval}m, move ${store.moveInterval}m, eyes ${store.eyesInterval}m`;
}

export const remindersIcon = (
  <div style={{
    width: 32, height: 32, borderRadius: 8,
    background: AMBER_DIM,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontSize: 'var(--glim-text-lg)', flexShrink: 0,
  }}>
    <svg viewBox="0 0 24 24" width={18} height={18} fill="none"
      stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 01-3.46 0" />
    </svg>
  </div>
);

export default function RemindersSettings() {
  const {
    wellnessInterval, moveInterval, eyesInterval,
    setWellnessInterval, setMoveInterval, setEyesInterval,
    symptomReminderEnabled, symptomReminderHour,
    setSymptomReminderEnabled, setSymptomReminderHour,
  } = useSettingsStore();

  return (
    <div style={{ padding: '4px 16px 16px 16px', borderTop: '1px solid rgba(100,120,160,0.12)' }}>
      <style>{sliderThumbStyle}</style>
      <Slider label="wellness check-in" value={wellnessInterval} min={10} max={60} onChange={setWellnessInterval} />
      <Slider label="move reminder" value={moveInterval} min={15} max={90} onChange={setMoveInterval} />
      <Slider label="eye break" value={eyesInterval} min={10} max={60} onChange={setEyesInterval} />

      {/* --- End-of-day symptom check (opt-in, in-app only) --- */}
      <div style={{ marginTop: 18, paddingTop: 14, borderTop: '1px solid rgba(100,120,160,0.12)' }}>
        <Toggle
          label="end-of-day symptom check"
          checked={symptomReminderEnabled}
          onChange={setSymptomReminderEnabled}
        />
        {symptomReminderEnabled && (
          <>
            <Slider
              label="ask after"
              value={symptomReminderHour}
              min={12}
              max={23}
              onChange={setSymptomReminderHour}
              format={hourLabel}
            />
            <div style={{
              marginTop: 6, fontSize: 'var(--glim-text-xs)', color: 'rgba(200,210,230,0.35)',
            }}>
              asks once a day, after {hourLabel(symptomReminderHour)}, only when nothing
              has been logged. shows in the app, not as a system notification.
            </div>
          </>
        )}
      </div>
    </div>
  );
}
