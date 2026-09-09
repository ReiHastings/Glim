// -----------------------------------------------------------------------------
// Title:       SymptomEditSheet.jsx
// Project:     Glim
// Author:      Reina Hastings (reinahastings13@gmail.com)
// Created:     2026-08-14
// Last Modified: 2026-09-06
// Purpose:     Bottom sheet for enriching a symptom log entry: intensity,
//              duration kind, times, note. The single edit surface for the whole
//              domain - the companion panel opens it now, the Phase 2 focus
//              history opens the same component. Edits live in local draft state
//              and commit as ONE updateEntry on "done" or dismiss, which keeps
//              updatedAt churn (and partial-edit sync states) out of the picture.
//              "end now" and "delete" are the two immediate-commit exceptions.
// Inputs:      props: entry, symptomName, onCommit(fields) -> { ok, error },
//              onDelete(), onLogAgain(), onClose()
// Outputs:     Portal-rendered overlay + sheet (portalled to document.body so it
//              escapes CompanionPanel's transform, which would otherwise become
//              the containing block for a fixed-position child)
// -----------------------------------------------------------------------------

import { useState, useRef } from 'react';
import { createPortal } from 'react-dom';
import { SYMPTOM_COLORS as C, MONO, formatClockTime } from '../utils/symptomTheme';

const KINDS = [
  { key: 'moment',  label: 'just now' },
  { key: 'episode', label: 'ongoing'  },
  { key: 'allDay',  label: 'all day'  },
];

// --- Native datetime-local helpers (v1 picker, per spec 4.4) ---
// datetime-local rather than a time-only input: changing the DATE of an entry is
// an explicitly supported edit (it re-derives the entry's logical day).

function toInputValue(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromInputValue(value) {
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

export default function SymptomEditSheet({ entry, symptomName, onCommit, onDelete, onLogAgain, onClose }) {
  // Draft state. Nothing here reaches the store until commit.
  //
  // DELIBERATELY the raw stored value: neither resolveIntensity nor any other
  // null-policy helper belongs here (see utils/intensity.js). This draft is
  // written straight back through updateEntry on save, so resolving an unrated
  // entry to 0 here would PERSIST that 0 - destroying the "not rated" vs "rated
  // 0" distinction permanently, and propagating the loss to every other device
  // on the next sync. The null policy is an interpretation applied at read time
  // by aggregates, never a value written at edit time.
  const [intensity, setIntensity] = useState(entry.intensity ?? null);
  const [kind,      setKind]      = useState(entry.kind);
  const [startedAt, setStartedAt] = useState(entry.startedAt);
  const [endedAt,   setEndedAt]   = useState(entry.endedAt);
  const [note,      setNote]      = useState(entry.note ?? '');
  const [error,     setError]     = useState(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  // Drag-to-dismiss on the handle, mirroring CompanionPanel's gesture.
  const [dragY, setDragY] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const startYRef = useRef(null);

  const isOngoing = kind === 'episode' && !endedAt;

  // Everything the sheet can change, in one payload. updateEntry applies the
  // kind side effects and the date re-derivation.
  const draftFields = (over = {}) => ({
    kind,
    intensity,
    startedAt,
    endedAt: kind === 'episode' ? endedAt : null,
    note: note.trim() === '' ? null : note,
    ...over,
  });

  const commitAndClose = () => {
    const result = onCommit(draftFields());
    if (result && result.ok === false) {
      setError(result.error);
      return;
    }
    onClose();
  };

  // "end now" is an immediate commit, but it commits the WHOLE draft alongside
  // the end time. Ending in isolation could be rejected: the entry may still be
  // a moment in the store while the draft has already switched to "ongoing".
  const handleEndNow = () => {
    const now    = new Date().toISOString();
    const result = onCommit(draftFields({ kind: 'episode', endedAt: now }));
    if (result && result.ok === false) {
      setError(result.error);
      return;
    }
    setKind('episode');
    setEndedAt(now);
    setError(null);
  };

  const handleDelete = () => {
    onDelete();
    onClose();
  };

  const handleLogAgain = () => {
    onLogAgain();
    onClose();
  };

  // Tapping the selected number clears it (toggle); "clear" does the same.
  const handleIntensityTap = (n) => setIntensity(prev => (prev === n ? null : n));

  const handlePointerDown = (e) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    startYRef.current = e.clientY;
    setIsDragging(true);
  };
  const handlePointerMove = (e) => {
    if (!isDragging || startYRef.current === null) return;
    setDragY(Math.max(0, e.clientY - startYRef.current));
  };
  const handlePointerUp = () => {
    const shouldDismiss = dragY > 80;
    setIsDragging(false);
    setDragY(0);
    startYRef.current = null;
    if (shouldDismiss) commitAndClose();  // drag-down saves, same as "done"
  };

  const label = (text, right) => (
    <div style={{
      ...MONO, fontSize: 'var(--glim-text-2xs)', color: C.textMuted,
      marginBottom: 8, letterSpacing: '0.03em',
      display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
    }}>
      <span>{text}</span>
      {right}
    </div>
  );

  const timeRow = (name, value, onChange, disabled) => (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      padding: '10px 2px', borderBottom: `1px solid ${C.rowBorder}`,
      ...MONO, fontSize: 'var(--glim-text-xs)', color: C.text,
    }}>
      <span>{name}</span>
      <input
        type="datetime-local"
        value={toInputValue(value)}
        disabled={disabled}
        onChange={(e) => {
          const iso = fromInputValue(e.target.value);
          if (iso) { onChange(iso); setError(null); }
        }}
        style={{
          ...MONO, fontSize: 'var(--glim-text-xs)', color: C.accent,
          background: 'none', border: 'none', outline: 'none',
          textAlign: 'right', padding: 0, colorScheme: 'dark',
        }}
      />
    </div>
  );

  return createPortal(
    <div
      onClick={commitAndClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 60,
        background: C.overlay,
        display: 'flex', flexDirection: 'column', justifyContent: 'flex-end',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: C.panelRaised,
          borderRadius: '24px 24px 0 0',
          borderTop: '1px solid rgba(183,157,245,0.2)',
          padding: '12px 20px 26px',
          maxHeight: '92vh', overflowY: 'auto',
          transform: `translateY(${dragY}px)`,
          transition: isDragging ? 'none' : 'transform 200ms ease-out',
        }}
      >
        {/* Drag handle */}
        <div
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          style={{ padding: '2px 0 10px', cursor: 'grab', touchAction: 'none' }}
        >
          <div style={{ width: 40, height: 4, background: '#423d63', borderRadius: 2, margin: '0 auto' }} />
        </div>

        {/* ---- Header ---- */}
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
          margin: '6px 0 16px', gap: 10,
        }}>
          <span style={{ ...MONO, fontSize: 'var(--glim-text-md)', fontWeight: 600, color: C.text }}>
            {symptomName}
          </span>
          <span style={{ ...MONO, fontSize: 'var(--glim-text-2xs)', color: C.textFaint, flexShrink: 0 }}>
            logged {formatClockTime(entry.createdAt)}
          </span>
        </div>

        {/* ---- Intensity ---- */}
        {label('intensity', (
          <button
            onClick={() => setIntensity(null)}
            style={{ ...MONO, fontSize: 'var(--glim-text-2xs)', color: C.textFaint,
              background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
          >
            clear
          </button>
        ))}
        <div style={{ display: 'flex', gap: 5, marginBottom: 18 }}>
          {Array.from({ length: 10 }, (_, i) => i + 1).map(n => {
            const selected = intensity === n;
            const filled   = intensity !== null && n < intensity;
            return (
              <button
                key={n}
                onClick={() => handleIntensityTap(n)}
                style={{
                  ...MONO, fontSize: 'var(--glim-text-2xs)',
                  flex: 1, aspectRatio: '1', maxWidth: 30, padding: 0,
                  borderRadius: '50%',
                  border: `1px solid ${selected || filled ? C.accent : C.dotBorder}`,
                  background: selected ? C.accent : filled ? C.accentFill : 'none',
                  color: selected ? C.onAccent : filled ? C.text : C.textMuted,
                  fontWeight: selected ? 700 : 400,
                  cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}
              >
                {n}
              </button>
            );
          })}
        </div>

        {/* ---- Duration ---- */}
        {label('duration')}
        <div style={{
          display: 'flex', background: C.fieldBg, borderRadius: 14,
          padding: 4, marginBottom: 18,
        }}>
          {KINDS.map(k => (
            <button
              key={k.key}
              onClick={() => { setKind(k.key); setError(null); }}
              style={{
                ...MONO, fontSize: 'var(--glim-text-xs)',
                flex: 1, padding: '9px 0', borderRadius: 10, border: 'none',
                background: kind === k.key ? C.accentSeg : 'none',
                color: kind === k.key ? C.text : C.textMuted,
                fontWeight: kind === k.key ? 600 : 400,
                cursor: 'pointer',
              }}
            >
              {k.label}
            </button>
          ))}
        </div>

        {/* ---- Times ----
            all day hides both rows (the logical day IS the time); just now hides
            the ended row, since a moment has no tracked duration. */}
        {kind !== 'allDay' && (
          <div style={{ marginBottom: 18 }}>
            {timeRow('started', startedAt, setStartedAt, false)}

            {kind === 'episode' && (
              isOngoing ? (
                <div style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  padding: '10px 2px', borderBottom: `1px solid ${C.rowBorder}`,
                  ...MONO, fontSize: 'var(--glim-text-xs)', color: C.text,
                }}>
                  <span>ended</span>
                  <button
                    onClick={handleEndNow}
                    style={{ ...MONO, fontSize: 'var(--glim-text-xs)', color: C.teal,
                      background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
                  >
                    still going · end now
                  </button>
                </div>
              ) : (
                timeRow('ended', endedAt, setEndedAt, false)
              )
            )}
          </div>
        )}

        {/* ---- Note ---- */}
        {label('note')}
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="add a note"
          style={{
            ...MONO, fontSize: 'var(--glim-text-xs)', color: C.text,
            width: '100%', boxSizing: 'border-box', minHeight: 58,
            background: C.fieldBg, border: `1px solid ${C.fieldBorder}`,
            borderRadius: 12, padding: '11px 13px', marginBottom: 20,
            outline: 'none', resize: 'vertical',
          }}
        />

        {/* ---- Validation feedback ---- */}
        {error && (
          <div style={{
            ...MONO, fontSize: 'var(--glim-text-2xs)', color: C.danger, marginBottom: 12,
          }}>
            {error}
          </div>
        )}

        {/* ---- Footer ---- */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
          {confirmingDelete ? (
            <span style={{ ...MONO, fontSize: 'var(--glim-text-xs)', color: C.danger, display: 'flex', gap: 8 }}>
              delete?
              <button onClick={handleDelete}
                style={{ ...MONO, fontSize: 'var(--glim-text-xs)', color: C.danger, background: 'none',
                  border: 'none', cursor: 'pointer', padding: 0, textDecoration: 'underline' }}>
                yes
              </button>
              <button onClick={() => setConfirmingDelete(false)}
                style={{ ...MONO, fontSize: 'var(--glim-text-xs)', color: C.textFaint, background: 'none',
                  border: 'none', cursor: 'pointer', padding: 0, textDecoration: 'underline' }}>
                no
              </button>
            </span>
          ) : (
            <button
              onClick={() => setConfirmingDelete(true)}
              style={{ ...MONO, fontSize: 'var(--glim-text-xs)', color: C.danger, opacity: 0.8,
                background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
            >
              delete
            </button>
          )}

          <div style={{ display: 'flex', gap: 10, flexShrink: 0 }}>
            <button
              onClick={handleLogAgain}
              style={{ ...MONO, fontSize: 'var(--glim-text-xs)', color: C.textMuted,
                background: 'none', border: `1px solid ${C.dotBorder}`, borderRadius: 14,
                padding: '10px 16px', cursor: 'pointer' }}
            >
              {'↻ log again'}
            </button>
            <button
              onClick={commitAndClose}
              style={{ ...MONO, fontSize: 'var(--glim-text-xs)', fontWeight: 600,
                background: C.accent, color: C.onAccent, border: 'none', borderRadius: 14,
                padding: '10px 22px', cursor: 'pointer' }}
            >
              done
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
