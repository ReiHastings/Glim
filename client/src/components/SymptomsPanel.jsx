// -----------------------------------------------------------------------------
// Title:       SymptomsPanel.jsx
// Project:     Glim
// Author:      Reina Hastings (reinahastings13@gmail.com)
// Created:     2026-08-14
// Last Modified: 2026-09-09
// Purpose:     Symptom diary companion panel. Renders inside CompanionPanel when
//              activePanel === 'symptoms'. A one-tap chip grid over today's
//              entries: tapping a chip logs a moment instantly (no form, no
//              confirmation); LONG-PRESSING a chip logs it AND opens the edit
//              sheet on the new entry. The entry is always written before any
//              rating UI appears - nothing blocks the log.
//
//              Orchestrates FOUR stores, because stores never import each other:
//              the log store supplies the recency the library sorts chips by and
//              the open episodes the clear-day guard needs; the categories store
//              resolves category names for the add flow.
//
//              Deliberately quiet: no elapsed timers, no nudges to log, and a
//              neutral empty state. Glim's reactions are SIGNALLED through
//              useUIStore.pendingReaction and rate-limited in DesktopPet.
// Inputs:      useSymptomsStore, useSymptomsLibraryStore,
//              useSymptomsCategoriesStore, useSymptomClearDaysStore, useUIStore.
//              No props.
// Outputs:     Panel content div (height 100%, manages its own scroll split)
// -----------------------------------------------------------------------------

import { useState, useRef, useEffect } from 'react';
import { useSymptomsStore } from '../stores/useSymptomsStore';
import { useSymptomsLibraryStore } from '../stores/useSymptomsLibraryStore';
import { useSymptomsCategoriesStore } from '../stores/useSymptomsCategoriesStore';
import { useSymptomClearDaysStore } from '../stores/useSymptomClearDaysStore';
import { useUIStore } from '../stores/useUIStore';
import SymptomEntryRow from './SymptomEntryRow';
import SymptomEditSheet from './SymptomEditSheet';
import { SYMPTOM_COLORS as C, MONO } from '../utils/symptomTheme';
import { DEFAULT_CATEGORY_ID } from '../utils/symptomCategories';
import { todayStr, toLogicalDateStr } from '../utils/dateUtils';

const UNDO_MS = 4000;

// Long-press threshold. Long enough not to fire on a normal tap, short enough
// that the sheet does not feel stuck.
const LONG_PRESS_MS = 450;

// The toast row's reserved height. The row is INLINE, so rendering it
// conditionally would shift everything below it in and out of place every time a
// log is made - the exact fault of commit 985f838, where the water panel's
// conditional undo row pulled the "+bottle" button out from under the user's
// finger during the undo window. The row is therefore always in the layout and
// only its contents are conditional.
const TOAST_ROW_HEIGHT = 30;

// ===== Inline "add a symptom" row =====
// Shared shape with the Phase 2 library tab's add row; the difference there is
// that adding from the library does NOT also log an entry.

function AddSymptomRow({ categories, onSave, onCancel }) {
  const [name, setName] = useState('');
  const [categoryId, setCategoryId] = useState(
    categories[0]?.id ?? DEFAULT_CATEGORY_ID
  );
  const inputRef = useRef(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const save = () => {
    const trimmed = name.trim();
    if (trimmed) onSave(trimmed, categoryId);
  };

  return (
    <div style={{ marginBottom: 16 }}>
      <input
        ref={inputRef}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') save();
          if (e.key === 'Escape') onCancel();
        }}
        placeholder="what is it called?"
        style={{
          ...MONO, fontSize: 'var(--glim-text-xs)', color: C.text,
          width: '100%', boxSizing: 'border-box', height: 36,
          background: C.fieldBg, border: `1px solid ${C.fieldBorder}`,
          borderRadius: 12, padding: '0 12px', outline: 'none', marginBottom: 8,
        }}
      />
      {/* Existing categories are shown as tappable chips and nothing else offers
          a free-text category here: user-defined categories proliferate fast if
          the add flow invites retyping instead of picking. Creating one is a
          deliberate act in the category manager, not a side effect of adding a
          symptom. */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
        {categories.map(cat => (
          <button
            key={cat.id}
            onClick={() => setCategoryId(cat.id)}
            style={{
              ...MONO, fontSize: 'var(--glim-text-2xs)',
              background: categoryId === cat.id ? C.accentSeg : 'none',
              color:      categoryId === cat.id ? C.text : C.textMuted,
              border: `1px solid ${categoryId === cat.id ? C.chipBorder : C.fieldBorder}`,
              borderRadius: 10, padding: '5px 10px', cursor: 'pointer',
            }}
          >
            {cat.name}
          </button>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          onClick={save}
          style={{
            ...MONO, fontSize: 'var(--glim-text-2xs)', fontWeight: 600,
            background: C.accent, color: C.onAccent, border: 'none',
            borderRadius: 12, padding: '7px 14px', cursor: 'pointer',
          }}
        >
          save
        </button>
        <button
          onClick={onCancel}
          style={{
            ...MONO, fontSize: 'var(--glim-text-2xs)', color: C.textFaint,
            background: 'none', border: `1px solid ${C.fieldBorder}`,
            borderRadius: 12, padding: '7px 14px', cursor: 'pointer',
          }}
        >
          cancel
        </button>
      </div>
    </div>
  );
}

// ===== Main component =====

export default function SymptomsPanel() {
  const symptoms   = useSymptomsStore();
  const library    = useSymptomsLibraryStore();
  const categories = useSymptomsCategoriesStore();
  const clearDays  = useSymptomClearDaysStore();
  const setPendingReaction = useUIStore(s => s.setPendingReaction);

  // toast: { message, entryId, rated } - `rated` flips the row from offering a
  // rating to acknowledging one.
  const [toast,     setToast]     = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [adding,    setAdding]    = useState(false);
  const [pressedId, setPressedId] = useState(null);
  const [clearError, setClearError] = useState(null);

  const undoTimerRef = useRef(null);
  const longPressRef = useRef(null);
  const longPressedRef = useRef(false);

  useEffect(() => () => {
    clearTimeout(undoTimerRef.current);
    clearTimeout(longPressRef.current);
  }, []);

  // ---- Derived data ----

  const today        = todayStr();
  const todayEntries = symptoms.getTodayEntries();
  const openEpisodes = symptoms.getOpenEpisodes();

  // The symptoms present on a day, as the clear-days store needs them. Uses the
  // W4 day-level primitive, so a closed episode that spanned the day counts, not
  // only an open one.
  const affectedOn    = (date) => symptoms.getAffectedDays(date, date).get(date) ?? new Set();
  const affectedToday = affectedOn(today);

  // "Present today" is the affected-days notion, NOT todayEntries.length. They
  // differ for a closed episode that started on an earlier logical day and
  // ended today: it is present (markClear refuses) but not in the today list
  // (which shows today's entries plus OPEN episodes only). Everything that
  // decides whether a clear day is possible keys on this, so the heading, the
  // control and the refusal can never contradict each other.
  const presentToday = affectedToday.size > 0;

  // PRECEDENCE (see the clear-days store header): a day with any entry is never
  // shown as clear, whatever the store holds. Two devices can disagree offline
  // and last-write-wins resolves by timestamp, so the rule is applied on read
  // as well as on write.
  const isClearToday = clearDays.isClear(today) && !presentToday;

  // Cross-store composition: the panel derives per-symptom recency from the log
  // and hands it to the library selector. The library store never reads the log
  // store itself (mirrors how NutritionPanel composes its two stores).
  const recencyById = {};
  for (const e of symptoms.logs) {
    if (e.deletedAt) continue;
    if (!recencyById[e.symptomId] || e.startedAt > recencyById[e.symptomId]) {
      recencyById[e.symptomId] = e.startedAt;
    }
  }
  const chips           = library.getActiveItems(recencyById);
  const activeCategories = categories.getActiveCategories();

  const nameFor = (symptomId) => library.getItem(symptomId)?.name ?? 'unknown symptom';

  const editingEntry = editingId ? symptoms.logs.find(e => e.id === editingId) : null;

  // ---- Undo toast ----
  // Undo targets the id returned by the action, never "the latest entry": a sync
  // pull can interleave a newer entry between the log and the undo tap.
  //
  // KNOWN LIMITATION, accepted: this replaces the toast wholesale, so a burst of
  // rapid logs drops the earlier rating opportunities. Long-press, and tapping
  // the row in the today list, both remain available for retroactive rating.
  // A toast queue is explicitly not wanted.

  const showUndo = (message, entryId) => {
    clearTimeout(undoTimerRef.current);
    setToast({ message, entryId, rated: null });
    undoTimerRef.current = setTimeout(() => setToast(null), UNDO_MS);
  };

  // Any interaction with the toast row cancels the auto-dismiss: 4 seconds is
  // ample to notice a mistake but far too short to choose a number from 1 to 10.
  const holdToast = () => clearTimeout(undoTimerRef.current);

  const handleUndo = () => {
    if (toast?.entryId) symptoms.softDelete(toast.entryId);
    clearTimeout(undoTimerRef.current);
    setToast(null);
  };

  const handleToastRate = (n) => {
    if (!toast?.entryId) return;
    clearTimeout(undoTimerRef.current);
    symptoms.updateEntry(toast.entryId, { intensity: n });
    setToast(t => (t ? { ...t, rated: n } : t));
  };

  // ---- Logging ----

  // Every path that writes an entry funnels through here, so the two invariants
  // that must hold on EVERY log hold in exactly one place: the entry's day stops
  // being a clear day, and Glim is told something happened. Keyed on the ENTRY'S
  // date (read fresh from the store, since the render snapshot predates the
  // write), not on "today", and unmarked unconditionally so the store can lay a
  // tombstone even when it holds no row (D4).
  const afterLog = (entryId, label) => {
    const loggedDate = useSymptomsStore.getState().logs.find(e => e.id === entryId)?.date ?? today;
    clearDays.unmarkClear(loggedDate);
    setClearError(null);
    setPendingReaction('symptom-logged');
    showUndo(`logged ${label}`, entryId);
    return entryId;
  };

  // The edit sheet's commit. updateEntry re-derives `date` when startedAt moves,
  // so the entry may now sit on a different day than it did - including a past
  // day the user had marked clear (D3). The same rule as afterLog, keyed on the
  // RESULTING date.
  // The start day is tombstoned unconditionally (the D4 rule). The REST of an
  // episode's span is handled by unmarking any clear row this device already
  // knows about inside it: an episode left open for months spans hundreds of
  // days, and tombstoning every one on every edit would be unbounded, whereas
  // known clear rows are few. A clear row for a span day that is still in
  // flight from another device is caught by the read-side precedence instead.
  const handleCommit = (entryId, fields) => {
    const result = symptoms.updateEntry(entryId, fields);
    if (result.ok) {
      const e = result.entry;
      clearDays.unmarkClear(e.date);
      if (e.kind === 'episode') {
        const spanStart = e.date;
        const spanEnd   = e.endedAt ? toLogicalDateStr(new Date(e.endedAt)) : today;
        for (const d of clearDays.getClearDays(spanStart, spanEnd)) clearDays.unmarkClear(d);
      }
    }
    return result;
  };

  // ---- Handlers ----

  const handleChipTap = (item) => {
    // A long press already logged and opened the sheet; the click that follows
    // the pointer release must not log a second entry.
    if (longPressedRef.current) { longPressedRef.current = false; return; }
    afterLog(symptoms.logMoment(item.id), item.name);
  };

  // Long-press: log FIRST, then open the sheet on the entry that now exists.
  // The order is the point - the log is never gated behind the detail UI.
  const handleChipPressStart = (item) => {
    setPressedId(item.id);
    longPressedRef.current = false;
    clearTimeout(longPressRef.current);
    longPressRef.current = setTimeout(() => {
      longPressedRef.current = true;
      setPressedId(null);
      const id = afterLog(symptoms.logMoment(item.id), item.name);
      setEditingId(id);
    }, LONG_PRESS_MS);
  };

  const handleChipPressEnd = () => {
    clearTimeout(longPressRef.current);
    setPressedId(null);
  };

  const handleAddSave = (name, categoryId) => {
    // Saving from the grid defines the symptom AND logs it: someone mid-flare
    // adding "jaw pain" wants it recorded, not merely defined.
    const itemId = library.addItem(name, categoryId);
    setAdding(false);
    afterLog(symptoms.logMoment(itemId), name);
  };

  const handleAgain = (entry) => {
    const id = symptoms.logAgain(entry.id);
    if (id) afterLog(id, nameFor(entry.symptomId));
  };

  const handleEnd = (entry) => {
    const result = symptoms.endEpisode(entry.id);
    if (result?.ok) setPendingReaction('episode-ended');
  };

  // ---- Clear day ----
  // Refused when any symptom is present today: "nothing today" and "a symptom
  // was logged today" are contradictory claims about the same day, so the user
  // is pointed at what is logged instead of being silently overruled. The
  // control is disabled while today has entries, so this path is normally
  // reached only by a race.

  const handleClearDay = () => {
    if (isClearToday) {
      clearDays.unmarkClear(today);
      setClearError(null);
      return;
    }
    const result = clearDays.markClear(today, affectedToday);
    if (!result.ok) {
      const open = openEpisodes.find(e => affectedToday.has(e.symptomId));
      setClearError(open
        ? `${nameFor(open.symptomId)} is still going. end it first?`
        : `${nameFor([...affectedToday][0])} was present today.`);
      return;
    }
    setClearError(null);
    setPendingReaction('clear-day');
  };

  // ---- Render ----

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', padding: '0 18px' }}>

      {/* ---- Title ---- */}
      {/* Phase 2 adds a right-aligned "open full view >" link here. */}
      <div style={{ ...MONO, fontSize: 'var(--glim-text-base)', fontWeight: 600,
        color: C.text, marginBottom: 12, flexShrink: 0 }}>
        symptoms
      </div>

      {/* ---- Chip grid (fixed; the list below is what scrolls) ---- */}
      <div style={{ flexShrink: 0 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: adding ? 8 : 16 }}>
          {chips.map(item => (
            <button
              key={item.id}
              onClick={() => handleChipTap(item)}
              onPointerDown={() => handleChipPressStart(item)}
              onPointerUp={handleChipPressEnd}
              onPointerLeave={handleChipPressEnd}
              onPointerCancel={handleChipPressEnd}
              onContextMenu={(e) => e.preventDefault()}
              style={{
                ...MONO, fontSize: 'var(--glim-text-sm)', color: C.text,
                background: C.chipBg, border: `1px solid ${C.chipBorder}`,
                borderRadius: 18, padding: '9px 15px', cursor: 'pointer',
                lineHeight: 1, touchAction: 'manipulation',
                transform: pressedId === item.id ? 'scale(0.96)' : 'scale(1)',
                transition: 'transform 120ms ease-out',
              }}
            >
              {item.name}
            </button>
          ))}

          {!adding && (
            <button
              onClick={() => setAdding(true)}
              className="glim-tap"
              style={{
                position: 'relative',
                ...MONO, fontSize: 'var(--glim-text-sm)', color: C.textFaint,
                background: 'transparent', border: `1px dashed ${C.chipBorder}`,
                borderRadius: 18, padding: '9px 15px', cursor: 'pointer', lineHeight: 1,
              }}
            >
              + add
            </button>
          )}
        </div>

        {adding && (
          <AddSymptomRow
            categories={activeCategories}
            onSave={handleAddSave}
            onCancel={() => setAdding(false)}
          />
        )}

        {/* ---- Undo / rate toast ----
            Height is RESERVED whether or not the toast is showing, so nothing
            below moves when a log is made (see TOAST_ROW_HEIGHT). */}
        <div
          onPointerDown={holdToast}
          style={{
            height: TOAST_ROW_HEIGHT, marginBottom: 12,
            display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8,
          }}
        >
          {toast && (
            <>
              <span style={{ ...MONO, fontSize: 'var(--glim-text-2xs)', color: C.textMuted,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {toast.rated === null ? toast.message : `${toast.message} · ${toast.rated}/10`}
              </span>

              {/* Rating is OFFERED here, never required: the entry is already
                  saved. Once a number is chosen the row stops offering and just
                  acknowledges, so it cannot be re-rated by a stray tap. */}
              {toast.rated === null && (
                <div style={{ display: 'flex', gap: 2, flexShrink: 0 }}>
                  {Array.from({ length: 10 }, (_, i) => i + 1).map(n => (
                    <button
                      key={n}
                      onClick={() => handleToastRate(n)}
                      aria-label={`rate ${n} out of 10`}
                      style={{
                        ...MONO, fontSize: 'var(--glim-text-2xs)', color: C.textMuted,
                        width: 20, height: 20, padding: 0, borderRadius: '50%',
                        background: 'none', border: `1px solid ${C.dotBorder}`,
                        cursor: 'pointer', flexShrink: 0,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                      }}
                    >
                      {n}
                    </button>
                  ))}
                </div>
              )}

              <button
                onClick={handleUndo}
                style={{
                  ...MONO, fontSize: 'var(--glim-text-2xs)', color: C.textMuted,
                  background: 'none', border: `1px solid ${C.fieldBorder}`,
                  borderRadius: 10, padding: '3px 10px', cursor: 'pointer', flexShrink: 0,
                }}
              >
                undo
              </button>
            </>
          )}
        </div>

        {/* ---- Today divider ---- */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8,
          ...MONO, fontSize: 'var(--glim-text-2xs)', color: C.textFaint, letterSpacing: '0.04em',
        }}>
          <span style={{ flex: 1, height: 1, background: C.hairline }} />
          today
          <span style={{ flex: 1, height: 1, background: C.hairline }} />
        </div>
      </div>

      {/* ---- Today list ---- */}
      <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
        {todayEntries.length === 0 ? (
          // Neutral by design: a statement of fact, never a prompt to log.
          <div style={{ ...MONO, fontSize: 'var(--glim-text-xs)', color: C.textFaint,
            textAlign: 'center', padding: '22px 0' }}>
            {isClearToday ? 'marked as a clear day'
              : presentToday ? 'an earlier episode ran into today'
              : 'no symptoms logged today'}
          </div>
        ) : (
          todayEntries.map(entry => (
            <SymptomEntryRow
              key={entry.id}
              entry={entry}
              symptomName={nameFor(entry.symptomId)}
              onOpen={() => setEditingId(entry.id)}
              onEnd={() => handleEnd(entry)}
              onAgain={() => handleAgain(entry)}
            />
          ))
        )}
      </div>

      {/* ---- Clear-day control ----
          One tap. Recording a day as clear is what makes "absence of data" and
          "absence of symptoms" distinguishable, and therefore what makes any
          proportion-of-days-affected figure mean anything at all. */}
      <div style={{ flexShrink: 0, paddingTop: 10 }}>
        {clearError && (
          <div style={{ ...MONO, fontSize: 'var(--glim-text-2xs)', color: C.danger,
            marginBottom: 6, textAlign: 'center' }}>
            {clearError}
          </div>
        )}
        {/* Disabled, not hidden, while today has entries: the row keeps its
            height so nothing below shifts, and the label states the fact. */}
        <button
          onClick={handleClearDay}
          disabled={!isClearToday && presentToday}
          className="glim-tap"
          style={{
            position: 'relative',
            ...MONO, fontSize: 'var(--glim-text-2xs)', width: '100%',
            color: isClearToday ? C.teal : C.textFaint,
            background: 'none',
            border: `1px solid ${isClearToday ? C.tealBorder : C.fieldBorder}`,
            // 13px, not 9px: this button sits directly above the nav bar, so an
            // expanded tap overlay would reach into it and steal nav taps. Real
            // height is the only way to reach 44px here. Costs 8px of panel.
            borderRadius: 12, padding: '13px 0',
            cursor: (!isClearToday && presentToday) ? 'default' : 'pointer',
            opacity: (!isClearToday && presentToday) ? 0.5 : 1,
          }}
        >
          {isClearToday ? 'clear day · tap to undo'
            : presentToday ? 'symptoms present today'
            : 'nothing today'}
        </button>
      </div>

      {/* ---- Shared edit sheet ---- */}
      {editingEntry && (
        <SymptomEditSheet
          entry={editingEntry}
          symptomName={nameFor(editingEntry.symptomId)}
          onCommit={(fields) => handleCommit(editingEntry.id, fields)}
          onDelete={() => symptoms.softDelete(editingEntry.id)}
          onLogAgain={() => handleAgain(editingEntry)}
          onClose={() => setEditingId(null)}
        />
      )}
    </div>
  );
}
