// -----------------------------------------------------------------------------
// Title:       symptomTheme.js
// Project:     Glim
// Author:      Reina Hastings (reinahastings13@gmail.com)
// Created:     2026-08-14
// Last Modified: 2026-09-06
// Purpose:     Shared palette and display formatters for the symptom diary
//              surfaces (companion panel, entry row, edit sheet, and the Phase 2
//              focus views). Colours are the literal values from the approved
//              mockup, held static like every other panel's palette; type uses
//              the app's monospace face and --glim-text-* scale.
// Inputs:      none (pure constants and formatters)
// Outputs:     SYMPTOM_COLORS, MONO, formatClockTime, formatSpan,
//              formatShortDate
// Usage:       import { SYMPTOM_COLORS as C, formatClockTime } from '../utils/symptomTheme';
// -----------------------------------------------------------------------------

// --- Palette ---
// From the approved mockup (evening-state reference). Static values, matching
// how WaterPanel and NutritionPanel hold their own palettes.

export const SYMPTOM_COLORS = {
  panelRaised:  '#262240',
  rowBg:        '#232038',
  chipBg:       'rgba(167,139,250,0.10)',
  chipBorder:   'rgba(167,139,250,0.32)',
  accent:       '#b79df5',
  accentDim:    'rgba(183,157,245,0.5)',
  accentFill:   'rgba(183,157,245,0.22)',
  accentSeg:    'rgba(183,157,245,0.2)',
  onAccent:     '#171226',
  teal:         '#6ee7d0',
  tealBorder:   'rgba(110,231,208,0.35)',
  text:         '#e9e6f5',
  textMuted:    '#9b96b8',
  textFaint:    '#6c6789',
  pillBg:       '#2d2947',
  pillWarm:     '#43304e',
  pillWarmText: '#d9b8c4',
  danger:       '#d98a9c',
  hairline:     '#2e2a48',
  fieldBg:      '#1b1830',
  fieldBorder:  '#322d52',
  rowBorder:    '#2b2745',
  dotBorder:    '#3a3558',
  overlay:      'rgba(8,7,15,0.55)',
};

// Intensity at or above this reads with a warm tint. Deliberately muted: high
// intensity is marked, never alarmed about.
export const WARM_INTENSITY_THRESHOLD = 7;

export const MONO = { fontFamily: "'Courier New', monospace" };

// --- Formatters ---

// "2:10 pm" - lowercase meridiem, matching Glim's voice.
export function formatClockTime(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (isNaN(d.getTime())) return '';
  return d
    .toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    .toLowerCase();
}

// "3:40 pm - 8:20 pm" for a closed episode.
export function formatSpan(startedAt, endedAt) {
  return `${formatClockTime(startedAt)} - ${formatClockTime(endedAt)}`;
}

// "apr 22" from a logical date string, for an ongoing entry that started on an
// earlier day.
export function formatShortDate(dateString) {
  const [y, m, d] = String(dateString).split('-').map(Number);
  return new Date(y, m - 1, d)
    .toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    .toLowerCase();
}
