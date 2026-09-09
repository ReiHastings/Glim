// -----------------------------------------------------------------------------
// Title:       SymptomEntryRow.jsx
// Project:     Glim
// Author:      Reina Hastings (reinahastings13@gmail.com)
// Created:     2026-08-14
// Last Modified: 2026-09-06
// Purpose:     One symptom log entry as a tappable row. Shared component: the
//              companion panel's today list uses it now, and the Phase 2 focus
//              history renders the identical row. Deliberately shows NO elapsed
//              time for ongoing episodes - a soft pulsing dot marks the state
//              instead, per the symptom diary's governing constraint.
// Inputs:      props: entry (log entry), symptomName (resolved by the caller
//              through symptomId, so renames propagate), onOpen, onEnd, onAgain
// Outputs:     Row element; calls back on row tap / end / log-again
// -----------------------------------------------------------------------------

import {
  SYMPTOM_COLORS as C, MONO, WARM_INTENSITY_THRESHOLD,
  formatClockTime, formatSpan, formatShortDate,
} from '../utils/symptomTheme';
import { todayStr } from '../utils/dateUtils';
import { hasRecordedIntensity } from '../utils/intensity';

// The time column: all-day entries name themselves, everything else shows onset.
function timeLabel(entry) {
  return entry.kind === 'allDay' ? 'all day' : formatClockTime(entry.startedAt);
}

// Meta line parts, in order. An ongoing entry carries its intensity here (so it
// gets no pill); an ongoing entry that started on an earlier day names that day
// rather than counting the hours since.
function metaParts(entry) {
  const parts = [];
  const isOngoing = entry.kind === 'episode' && !entry.endedAt;

  if (isOngoing) {
    parts.push('ongoing');
    if (entry.date !== todayStr()) parts.push(`since ${formatShortDate(entry.date)}`);
    if (hasRecordedIntensity(entry)) parts.push(`${entry.intensity}/10`);
  } else if (entry.kind === 'episode' && entry.endedAt) {
    parts.push(formatSpan(entry.startedAt, entry.endedAt));
  }

  if (entry.note) parts.push(`"${entry.note}"`);
  return parts;
}

export default function SymptomEntryRow({ entry, symptomName, onOpen, onEnd, onAgain }) {
  const isOngoing = entry.kind === 'episode' && !entry.endedAt;
  const meta      = metaParts(entry).join(' · ');

  // Ongoing rows carry intensity in the meta line, so they never also show a pill.
  // Display surface: hasRecordedIntensity ONLY. Never resolveIntensity - an
  // unrated entry must show no pill, not a "0/10" invented by the aggregate policy.
  const showPill = !isOngoing && hasRecordedIntensity(entry);
  const warm     = showPill && entry.intensity >= WARM_INTENSITY_THRESHOLD;

  const stop = (fn) => (e) => { e.stopPropagation(); fn(); };

  return (
    <div
      onClick={onOpen}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } }}
      style={{
        display: 'flex', alignItems: 'center', gap: 10,
        background: C.rowBg, borderRadius: 14,
        padding: '11px 12px', marginBottom: 8,
        cursor: 'pointer',
      }}
    >
      {/* Ongoing marker, or a spacer so every row's columns line up */}
      {isOngoing ? (
        <span
          className="glim-ongoing-dot"
          style={{ width: 7, height: 7, borderRadius: '50%', background: C.teal, flexShrink: 0 }}
        />
      ) : (
        <span style={{ width: 7, flexShrink: 0 }} />
      )}

      <span style={{
        ...MONO, fontSize: 'var(--glim-text-2xs)', color: C.textFaint,
        width: 52, flexShrink: 0,
      }}>
        {timeLabel(entry)}
      </span>

      <span style={{ ...MONO, fontSize: 'var(--glim-text-sm)', color: C.text, flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {symptomName}
        </span>
        {meta && (
          <span style={{
            display: 'block', marginTop: 2,
            fontSize: 'var(--glim-text-2xs)', color: C.textMuted,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {meta}
          </span>
        )}
      </span>

      {showPill && (
        <span style={{
          ...MONO, fontSize: 'var(--glim-text-2xs)',
          background: warm ? C.pillWarm : C.pillBg,
          color:      warm ? C.pillWarmText : C.textMuted,
          borderRadius: 10, padding: '3px 8px', flexShrink: 0,
        }}>
          {entry.intensity}/10
        </span>
      )}

      {isOngoing ? (
        // Closing an episode must not also open the sheet.
        <button
          onClick={stop(onEnd)}
          style={{
            ...MONO, fontSize: 'var(--glim-text-2xs)', color: C.teal,
            background: 'none', border: `1px solid ${C.tealBorder}`,
            borderRadius: 10, padding: '4px 10px', cursor: 'pointer', flexShrink: 0,
          }}
        >
          end
        </button>
      ) : (
        // Log again: the multi-day flare workhorse. Ongoing rows deliberately
        // omit it (it would collide with "end"); theirs lives in the edit sheet.
        <button
          onClick={stop(onAgain)}
          aria-label={`log ${symptomName} again`}
          style={{
            ...MONO, fontSize: 'var(--glim-text-xs)', color: C.textFaint,
            width: 28, height: 28, borderRadius: '50%',
            background: 'none', border: '1px solid transparent',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: 'pointer', flexShrink: 0, padding: 0,
          }}
        >
          {'↻'}
        </button>
      )}
    </div>
  );
}
