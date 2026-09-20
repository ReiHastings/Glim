// -----------------------------------------------------------------------------
// Title:       DateWheel.jsx
// Project:     Glim
// Author:      Reina Hastings (reihastings@gmail.com)
// Created:     2026-09-19
// Purpose:     A wheel (drum / spinner) date picker: three scrolling columns for
//              day, month and year, with the centred value selected. The pattern
//              iOS uses for dates.
//
//              Built on CSS scroll-snap rather than pointer maths. The browser
//              already does momentum, rubber-banding and snapping natively, and
//              a hand-rolled drag handler loses all three - and loses the mouse
//              wheel and the keyboard with them.
//
//              SELECTION IS "WHATEVER IS CENTRED". A scroll listener reads the
//              nearest snap position and reports it, debounced to the settle so
//              a flick does not fire thirty updates. That means the value is
//              always what the user can SEE in the highlight band, which is the
//              property that makes a wheel feel trustworthy.
//
//              The date arithmetic lives in utils/dateWheel.js, not here, so
//              leap years and "scroll to february while the day is 31" are
//              testable without a renderer.
//
// Inputs:      value    - 'YYYY-MM-DD', the currently selected date
//              maxDate  - 'YYYY-MM-DD', inclusive upper bound
//              minDate  - 'YYYY-MM-DD', optional inclusive lower bound
//              onChange - (dateStr) => void, fired once per settle
//              onClose  - () => void
// Outputs:     default export DateWheel
// Usage:       {picking && <DateWheel value={entryDate} maxDate={calendarTodayStr()}
//                onChange={setEntryDate} onClose={() => setPicking(false)} />}
// -----------------------------------------------------------------------------

import { useRef, useEffect, useCallback } from 'react';
import { partsOf, clampParts, wheelOptions, MONTH_LABELS } from '../utils/dateWheel';
import { SYMPTOM_COLORS as C, MONO } from '../utils/symptomTheme';

const ITEM_H = 34;      // px per row; also the scroll-snap interval
const VISIBLE = 5;      // rows shown, must be odd so one sits centred
const PAD = ((VISIBLE - 1) / 2) * ITEM_H;

// One scrolling column. Spacers above and below let the first and last real
// values reach the centre band; without them you could never select january.
function Column({ items, selected, onSettle, label }) {
  const ref = useRef(null);
  const settleRef = useRef(null);
  const suppress = useRef(false);

  // Scroll the selected value into the centre whenever it changes from OUTSIDE
  // (a clamp, or the other columns moving the date). `suppress` stops that
  // programmatic scroll being read back as a user selection, which would fight
  // the clamp and leave the wheel oscillating.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const idx = items.findIndex(i => i.value === selected);
    if (idx < 0) return;
    const target = idx * ITEM_H;
    if (Math.abs(el.scrollTop - target) < 1) return;
    suppress.current = true;
    el.scrollTo({ top: target, behavior: 'auto' });
    const t = setTimeout(() => { suppress.current = false; }, 60);
    return () => clearTimeout(t);
  }, [selected, items]);

  const handleScroll = useCallback(() => {
    if (suppress.current) return;
    clearTimeout(settleRef.current);
    // Debounced to the settle: a flick fires scroll continuously, and committing
    // on every frame would write thirty dates and re-clamp under the finger.
    settleRef.current = setTimeout(() => {
      const el = ref.current;
      if (!el) return;
      const idx = Math.round(el.scrollTop / ITEM_H);
      const item = items[Math.max(0, Math.min(items.length - 1, idx))];
      if (item && item.value !== selected) onSettle(item.value);
    }, 90);
  }, [items, selected, onSettle]);

  useEffect(() => () => clearTimeout(settleRef.current), []);

  return (
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ ...MONO, fontSize: 'var(--glim-text-2xs)', color: C.textFaint,
        textAlign: 'center', marginBottom: 4 }}>{label}</div>
      <div
        ref={ref}
        onScroll={handleScroll}
        style={{
          height: VISIBLE * ITEM_H,
          overflowY: 'auto',
          scrollSnapType: 'y mandatory',
          scrollbarWidth: 'none',
          msOverflowStyle: 'none',
          WebkitOverflowScrolling: 'touch',
        }}
      >
        <div style={{ height: PAD }} />
        {items.map(item => (
          <div
            key={item.value}
            onClick={() => onSettle(item.value)}
            style={{
              ...MONO,
              height: ITEM_H,
              lineHeight: `${ITEM_H}px`,
              scrollSnapAlign: 'center',
              textAlign: 'center',
              cursor: 'pointer',
              fontSize: 'var(--glim-text-sm)',
              color: item.value === selected ? C.text : C.textFaint,
              opacity: item.value === selected ? 1 : 0.55,
              transition: 'color 120ms ease-out, opacity 120ms ease-out',
            }}
          >
            {item.label}
          </div>
        ))}
        <div style={{ height: PAD }} />
      </div>
    </div>
  );
}

export default function DateWheel({ value, maxDate, minDate = null, onChange, onClose }) {
  const parts = partsOf(value);
  const maxYear = partsOf(maxDate).year;
  // Three years back is plenty for a cycle log and keeps the year column short
  // enough to reach by flicking rather than scrolling forever.
  const minYear = minDate ? partsOf(minDate).year : maxYear - 3;
  const opts = wheelOptions(parts, { minYear, maxYear });

  // Every change goes through clampParts, so an impossible combination (31 feb)
  // or a future date is corrected to something real before it leaves the wheel.
  const commit = (patch) => {
    onChange(clampParts({ ...parts, ...patch }, maxDate, minDate));
  };

  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ position: 'relative', display: 'flex', gap: 6, alignItems: 'flex-end' }}>
        {/* The highlight band. Sits behind the columns and marks which row is
            selected, so "what is centred" is visible rather than implied. */}
        <div
          aria-hidden
          style={{
            position: 'absolute', left: 0, right: 0,
            top: 20 + PAD, height: ITEM_H,
            background: C.accentSeg, borderRadius: 8, pointerEvents: 'none',
          }}
        />
        <Column
          label="day"
          items={opts.days.map(d => ({ value: d, label: String(d) }))}
          selected={parts.day}
          onSettle={(day) => commit({ day })}
        />
        <Column
          label="month"
          items={opts.months.map(m => ({ value: m.value, label: m.label }))}
          selected={parts.month}
          onSettle={(month) => commit({ month })}
        />
        <Column
          label="year"
          items={opts.years.map(y => ({ value: y, label: String(y) }))}
          selected={parts.year}
          onSettle={(year) => commit({ year })}
        />
      </div>

      <div style={{ display: 'flex', justifyContent: 'center', marginTop: 8 }}>
        <button
          onClick={onClose}
          style={{ ...MONO, fontSize: 'var(--glim-text-xs)', color: C.text,
            background: C.chipBg, border: `1px solid ${C.chipBorder}`,
            borderRadius: 10, padding: '7px 16px', cursor: 'pointer' }}
        >
          done
        </button>
      </div>
    </div>
  );
}

export { MONTH_LABELS };
