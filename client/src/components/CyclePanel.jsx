// -----------------------------------------------------------------------------
// Title:       CyclePanel.jsx
// Project:     Glim - cycle tracking Phase 1
// Author:      Reina Hastings (reihastings@gmail.com)
// Created:     2026-09-18
// Purpose:     The cycle panel: flow entry, the derived prediction, a menstrual
//              symptom chip grid, and recent cycles with their symptoms placed
//              on cycle days.
//
//              THIS PANEL ORCHESTRATES. Stores never import each other in this
//              codebase, so the join between the flow log (useCycleStore) and
//              the symptom log (useSymptomsStore) happens here, at read time,
//              through the pure functions in src/cycle/. Nothing derived is
//              stored.
//
//              THREE THINGS THAT LOOK OPTIONAL AND ARE NOT:
//              1. Every chip tap must unmark the clear day, exactly as
//                 SymptomsPanel.afterLog does. Skipping it leaves a stale
//                 clear-day row that can win the cross-device merge.
//              2. The prediction is rendered per `display`, never as a bare
//                 date. A band wider than WIDE_WIDTH is replaced by the plain
//                 list of recent lengths, because a band that wide answers
//                 nothing.
//              3. Ovulation and the fertile window are computed by predict()
//                 and NEVER rendered. Presenting a fertile window for avoiding
//                 pregnancy makes an app a regulated medical device, and the
//                 luteal phase is not the constant that estimate assumes.
//
// Inputs:      none (reads the stores directly)
// Outputs:     default export CyclePanel
// Usage:       <CyclePanel /> from CompanionPanel's panel switch
// -----------------------------------------------------------------------------

import { useState, useMemo, useRef, useEffect } from 'react';
import {
  useCycleStore, useSymptomsStore, useSymptomsLibraryStore,
  useSymptomsCategoriesStore, useSymptomClearDaysStore,
} from '../stores';
import { segmentCycles } from '../cycle/segment';
import { predict } from '../cycle/predict';
import { cycleDayFor, groupByCycleDay } from '../cycle/phase';
import { planEnable } from '../cycle/enable';
import { readCycleRecord, writeCycleRecord } from '../cycle/deviceRecord';
import { MENSTRUAL_CATEGORY_ID } from '../utils/symptomCategories';
import { collidingIds, itemsCollidingWith } from '../utils/symptomNames';
import { logSymptomAndClearDay } from '../utils/logSymptom';
import { todayStr, calendarTodayStr, daysBetweenStr } from '../utils/dateUtils';
import { SYMPTOM_COLORS as C, MONO, formatShortDate } from '../utils/symptomTheme';
import DateWheel from './DateWheel';

const FLOW_CHOICES = [
  { value: 'none',     label: 'nothing' },
  { value: 'spotting', label: 'spotting' },
  { value: 'light',    label: 'light' },
  { value: 'medium',   label: 'medium' },
  { value: 'heavy',    label: 'heavy' },
];

const box = { ...MONO, fontSize: 'var(--glim-text-sm)', color: C.text };

export default function CyclePanel() {
  const cycleStore  = useCycleStore();
  const symptoms    = useSymptomsStore();
  const library     = useSymptomsLibraryStore();
  const categories  = useSymptomsCategoriesStore();
  const clearDays   = useSymptomClearDaysStore();

  const [device, setDevice] = useState(() => readCycleRecord());
  const [enablePlan, setEnablePlan] = useState(null);
  // The date the flow entry will write. Shown ALWAYS and editable (R4a).
  // Defaults to the LOGICAL date, consistent with every other tracker; between
  // midnight and DAY_BOUNDARY_HOUR that is yesterday's calendar date, and the
  // user may advance it. The store's ceiling is the CALENDAR date precisely so
  // that edit is accepted.
  const [entryDate, setEntryDate] = useState(() => todayStr());
  const [error, setError] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [expanded, setExpanded] = useState(null);
  // The date is TAPPED to change, not stepped. A stepper is fine for "yesterday"
  // and hopeless for backfilling a period three weeks ago.
  const [picking, setPicking] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [dupWarning, setDupWarning] = useState(null);
  const addRef = useRef(null);
  useEffect(() => { if (adding) addRef.current?.focus(); }, [adding]);

  const today = todayStr();

  // ---- Derivation. Recomputed from the log on every render; nothing cached in
  //      a store, because a backfilled period changes the answer. ----
  const liveDays = cycleStore.days.filter(d => !d.deletedAt);
  const cycles = useMemo(
    () => segmentCycles(liveDays, today, calendarTodayStr()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [JSON.stringify(liveDays), today]);
  const p = useMemo(() => predict(cycles, today), [cycles, today]);

  const menstrualItems = library.getActiveItems()
    .filter(i => i.categoryId === MENSTRUAL_CATEGORY_ID);
  const clashing = collidingIds(library.getActiveItems());

  // ---- Enable ----

  const beginEnable = () => {
    setEnablePlan(planEnable(library.getActiveItems()));
  };

  const finishEnable = (skipIds = []) => {
    const plan = enablePlan ?? planEnable(library.getActiveItems());
    categories.ensureCategory(plan.category);
    for (const row of plan.toCreate) {
      if (skipIds.includes(row.id)) continue;
      library.ensureItem(row);
    }
    setDevice(writeCycleRecord({
      enabled: true, setupDone: true, enabledAt: new Date().toISOString(),
    }));
    setEnablePlan(null);
  };

  // ---- Writes ----

  const setFlow = (value) => {
    const res = cycleStore.setFlow(entryDate, value);
    setError(res.ok ? null : res.error);
  };

  const markStart = (value) => {
    const res = cycleStore.setPeriodStart(entryDate, value);
    setError(res.ok ? null : res.error);
  };

  // Every symptom write funnels through here, so the clear-day obligation holds
  // in one place. Keyed on the ENTRY's date read fresh from the store, not on
  // "today", and unmarked unconditionally so the store can lay a tombstone even
  // where it holds no row. This mirrors SymptomsPanel.afterLog exactly; the two
  // must not drift.
  const logSymptom = (item) => logSymptomAndClearDay({
    logMoment:    symptoms.logMoment,
    getLogs:      () => useSymptomsStore.getState().logs,
    unmarkClear:  clearDays.unmarkClear,
    fallbackDate: today,
  }, item.id).id;

  // Adds a symptom straight into the menstrual category. No category picker
  // here, unlike SymptomsPanel: anything added from this panel is by definition
  // one the user wants against their cycle. A name that already exists elsewhere
  // is allowed - that is the point of per-category attribution - but it warns
  // once first, so the duplicate is a choice rather than an accident.
  const addSymptom = () => {
    const name = newName.trim();
    if (!name) return;
    const clash = itemsCollidingWith(name, library.getActiveItems());
    if (clash.length > 0 && dupWarning !== name) {
      setDupWarning(name);
      return;
    }
    const id = library.addItem(name, MENSTRUAL_CATEGORY_ID);
    logSymptom({ id });
    setNewName(''); setAdding(false); setDupWarning(null);
  };

  const deleteCycleData = () => {
    // Tombstones, never hard deletes: the sync layer propagates deletion by
    // writing deletedAt, never by a document's absence, so a hard delete would
    // leave every other device holding the full history indefinitely.
    cycleStore.tombstoneAll();
    const menstrualIds = new Set(library.items
      .filter(i => i.categoryId === MENSTRUAL_CATEGORY_ID).map(i => i.id));
    for (const entry of symptoms.logs) {
      if (!entry.deletedAt && menstrualIds.has(entry.symptomId)) symptoms.softDelete(entry.id);
    }
    setConfirmDelete(false);
  };

  // ---- Enable gate ----

  if (!device.enabled) {
    return (
      <div style={{ ...box, padding: '4px 0', textAlign: 'center' }}>
        <div style={{ fontSize: 'var(--glim-text-base)', fontWeight: 600, marginBottom: 10 }}>
          cycle
        </div>
        <p style={{ color: C.textMuted, lineHeight: 1.5, marginBottom: 14 }}>
          track your period and see how your symptoms line up with it. this stays on
          this device until you turn it on, and you can delete all of it later in one tap.
        </p>

        {enablePlan?.collisions?.length > 0 && (
          <div style={{ background: C.pillWarm, color: C.pillWarmText, borderRadius: 10,
            padding: '10px 12px', marginBottom: 12, lineHeight: 1.45,
            fontSize: 'var(--glim-text-xs)' }}>
            {enablePlan.collisions.map(c => (
              <div key={c.starter.id}>
                you already track "{c.existing[0].name}" under{' '}
                {categories.getCategoryName(c.existing[0].categoryId)}. adding a menstrual
                one lets you tell period-related days apart - or skip it and use the one
                you have.
              </div>
            ))}
          </div>
        )}

        {!enablePlan ? (
          <button onClick={beginEnable} style={btn(true)}>turn on cycle tracking</button>
        ) : (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
            <button onClick={() => finishEnable([])} style={btn(true)}>
              add {enablePlan.toCreate.length} starter symptoms
            </button>
            <button
              onClick={() => finishEnable(enablePlan.collisions.map(c => c.starter.id))}
              style={btn(false)}
            >
              skip the duplicates
            </button>
          </div>
        )}
      </div>
    );
  }

  // ---- Panel ----

  const dayRow = cycleStore.getDay(entryDate);
  const cycleDayToday = cycleDayFor(today, cycles);

  return (
    <div style={{ ...box, display: 'flex', flexDirection: 'column', gap: 16,
      paddingBottom: 8, textAlign: 'center' }}>

      {/* ---- Where you are ---- */}
      <div>
        <div style={{ fontSize: 'var(--glim-text-base)', fontWeight: 600, marginBottom: 6 }}>
          {cycleDayToday ? `cycle day ${cycleDayToday}` : 'cycle'}
        </div>
        <Prediction p={p} today={today} />
      </div>

      {/* ---- Flow entry. The date is ALWAYS visible and editable (R4a). ---- */}
      <div>
        {/* The date is always SHOWN and always editable. Tapping it opens the
            wheel; it is never a hidden default, because between midnight and
            DAY_BOUNDARY_HOUR "today" means the previous calendar day and the
            user has to be able to see and correct that. */}
        <button
          onClick={() => setPicking(!picking)}
          style={{ ...MONO, fontSize: 'var(--glim-text-sm)', color: C.text,
            background: picking ? C.accentSeg : 'transparent',
            border: `1px solid ${picking ? C.accent : C.chipBorder}`,
            borderRadius: 10, padding: '7px 14px', cursor: 'pointer',
            marginBottom: 8 }}
        >
          {entryDate === today ? 'today' : formatShortDate(entryDate)}
          <span style={{ color: C.textFaint, marginLeft: 6 }}>{picking ? '\u25b4' : '\u25be'}</span>
        </button>

        {picking && (
          <DateWheel
            value={entryDate}
            maxDate={calendarTodayStr()}
            onChange={setEntryDate}
            onClose={() => setPicking(false)}
          />
        )}

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, justifyContent: 'center' }}>
          {FLOW_CHOICES.map(f => (
            <button key={f.value} onClick={() => setFlow(f.value)}
              style={chip(dayRow?.flow === f.value)}>
              {f.label}
            </button>
          ))}
        </div>

        {dayRow && (
          <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap',
            justifyContent: 'center' }}>
            <button onClick={() => markStart(dayRow.isPeriodStart === true ? null : true)}
              style={chip(dayRow.isPeriodStart === true)}>
              this is day 1
            </button>
            <button onClick={() => markStart(dayRow.isPeriodStart === false ? null : false)}
              style={chip(dayRow.isPeriodStart === false)}>
              not my period
            </button>
            <button onClick={() => cycleStore.clearDay(entryDate)} style={chip(false)}>
              clear
            </button>
          </div>
        )}

        {error && (
          <div style={{ color: C.danger, fontSize: 'var(--glim-text-xs)', marginTop: 8 }}>
            {error}
          </div>
        )}
      </div>

      {/* ---- Menstrual symptoms. Ordinary symptom entries, same domain. ---- */}
      {menstrualItems.length > 0 && (
        <div>
          <Label>how you're feeling</Label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, justifyContent: 'center' }}>
            {menstrualItems.map(item => (
              <button key={item.id} onClick={() => logSymptom(item)} style={chip(false)}>
                {item.name}
                {clashing.has(item.id) && (
                  <span style={{ display: 'block', marginTop: 3, color: C.textFaint,
                    fontSize: 'var(--glim-text-xs)', lineHeight: 1 }}>
                    {categories.getCategoryName(item.categoryId)}
                  </span>
                )}
              </button>
            ))}
            {!adding && (
              <button onClick={() => setAdding(true)}
                style={{ ...chip(false), borderStyle: 'dashed', color: C.textFaint }}>
                + add
              </button>
            )}
          </div>

          {adding && (
            <div style={{ marginTop: 8 }}>
              <input
                ref={addRef}
                value={newName}
                onChange={(e) => { setNewName(e.target.value); setDupWarning(null); }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') addSymptom();
                  if (e.key === 'Escape') { setAdding(false); setNewName(''); setDupWarning(null); }
                }}
                placeholder="what is it called?"
                style={{ ...MONO, fontSize: 'var(--glim-text-xs)', color: C.text,
                  width: '100%', boxSizing: 'border-box', height: 34, textAlign: 'center',
                  background: C.rowBg, border: `1px solid ${C.chipBorder}`,
                  borderRadius: 10, padding: '0 12px', outline: 'none' }}
              />
              {dupWarning && (
                <div style={{ color: C.pillWarmText, background: C.pillWarm, borderRadius: 8,
                  padding: '7px 10px', marginTop: 6, fontSize: 'var(--glim-text-xs)',
                  lineHeight: 1.4 }}>
                  you already track "{dupWarning}" elsewhere. add again to keep a separate
                  menstrual one - both will show their category so you can tell them apart.
                </div>
              )}
              <div style={{ display: 'flex', gap: 6, marginTop: 6, justifyContent: 'center' }}>
                <button onClick={addSymptom} style={btn(true)}>
                  {dupWarning ? 'add anyway' : 'add'}
                </button>
                <button onClick={() => { setAdding(false); setNewName(''); setDupWarning(null); }}
                  style={btn(false)}>cancel</button>
              </div>
            </div>
          )}

          <div style={{ color: C.textFaint, fontSize: 'var(--glim-text-xs)', marginTop: 6 }}>
            these go in your symptom diary too
          </div>
        </div>
      )}

      {/* ---- Recent cycles, with symptoms placed on cycle days ---- */}
      {cycles.length > 0 && (
        <div>
          <Label>recent cycles</Label>
          {[...cycles].reverse().slice(0, 6).map(c => {
            const open = expanded === c.startDate;
            const symptomsThisCycle = groupByCycleDay(
              symptoms.logs.filter(e => !e.deletedAt), c);
            return (
              <div key={c.startDate} style={{ borderTop: `1px solid ${C.chipBorder}`, padding: '8px 0' }}>
                <button onClick={() => setExpanded(open ? null : c.startDate)}
                  style={{ ...MONO, background: 'none', border: 'none', color: C.text,
                    padding: 0, cursor: 'pointer', textAlign: 'center', width: '100%',
                    fontSize: 'var(--glim-text-sm)' }}>
                  {formatShortDate(c.startDate)}
                  {' - '}
                  {c.isComplete ? `${c.cycleLength} days` : 'in progress'}
                  {c.flags.length > 0 && (
                    <span style={{ color: C.textFaint }}>  {c.flags.join(' ')}</span>
                  )}
                </button>
                {open && (
                  <div style={{ marginTop: 6, fontSize: 'var(--glim-text-xs)', color: C.textMuted }}>
                    <div>period lasted {c.periodLength} day{c.periodLength === 1 ? '' : 's'}</div>
                    {Object.keys(symptomsThisCycle).sort((a, b) => a - b).map(day => (
                      <div key={day} style={{ marginTop: 2 }}>
                        day {day}: {[...new Set(symptomsThisCycle[day]
                          .map(e => library.getItem(e.symptomId)?.name ?? '?'))].join(', ')}
                      </div>
                    ))}
                    {Object.keys(symptomsThisCycle).length === 0 && (
                      <div style={{ marginTop: 2 }}>no symptoms logged</div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ---- Scoped delete ---- */}
      <div style={{ borderTop: `1px solid ${C.chipBorder}`, paddingTop: 10 }}>
        {!confirmDelete ? (
          <button onClick={() => setConfirmDelete(true)}
            style={{ ...MONO, background: 'none', border: 'none', color: C.textFaint,
              padding: 0, cursor: 'pointer', fontSize: 'var(--glim-text-xs)' }}>
            delete cycle data
          </button>
        ) : (
          <div style={{ fontSize: 'var(--glim-text-xs)', lineHeight: 1.5 }}>
            {/* States the RULE, not the intent. Under the category model, a
                symptom re-filed out of menstrual survives and one moved in is
                removed, so "deletes your cycle data" would be a promise the
                code does not keep. */}
            <div style={{ color: C.textMuted, marginBottom: 8 }}>
              this removes your flow log and any symptom currently filed under menstrual,
              on this device and in your account. symptoms you moved to another category
              will stay.
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
              <button onClick={deleteCycleData} style={btn(true)}>delete it</button>
              <button onClick={() => setConfirmDelete(false)} style={btn(false)}>keep it</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ---- Prediction rendering ----------------------------------------------------
//
// Rendered per `display`, never as a bare date, and never as a band the
// measurement says is meaningless:
//   'none'   nothing to predict from yet, or the cycle is so overdue that the
//            in-progress assumption has failed
//   'range'  the window is wider than WIDE_WIDTH; show the recent lengths as
//            plain fact instead of drawing a band that answers nothing
//   'window' the band, with copy driven by `quality`
function Prediction({ p, today }) {
  if (p.display === 'none') {
    return <Muted>{p.nextStart
      ? "it's been a while - log a period when it comes and this picks back up"
      : 'log a period and glim will start working out your pattern'}</Muted>;
  }

  if (p.overdueBy > 0) {
    return (
      <Muted>
        {p.overdueBy} day{p.overdueBy === 1 ? '' : 's'} later than usual.
        {p.quality === 'variable' ? ' your cycles vary a fair bit, so this happens.' : ''}
      </Muted>
    );
  }

  if (p.display === 'range') {
    return (
      <Muted>
        your recent cycles were {p.recentLengths.join(', ')} days - too different to
        point at a date yet.
      </Muted>
    );
  }

  const [lo, hi] = p.nextWindow;
  const away = daysBetweenStr(today, lo);
  return (
    <div>
      <div style={{ color: C.text, fontSize: 'var(--glim-text-sm)' }}>
        next period around {formatShortDate(lo)} to {formatShortDate(hi)}
        {away > 0 ? ` (${away} days away)` : ''}
      </div>
      <Muted>{QUALITY_COPY[p.quality]}</Muted>
    </div>
  );
}

const QUALITY_COPY = {
  population: 'this is an average, not your pattern yet - it will get closer as you log',
  'few-cycles': 'based on only a few cycles, so expect it to shift',
  variable: 'your cycles vary a fair bit, so this window is wide and may stay that way',
  steady: 'your cycles have been fairly steady',
};

// ---- Small presentational helpers -------------------------------------------

const Label = ({ children }) => (
  <div style={{ ...MONO, fontSize: 'var(--glim-text-xs)', color: C.textFaint,
    marginBottom: 6, textTransform: 'lowercase' }}>{children}</div>
);

const Muted = ({ children }) => (
  <div style={{ ...MONO, fontSize: 'var(--glim-text-xs)', color: C.textMuted,
    lineHeight: 1.45, marginTop: 4 }}>{children}</div>
);

const chip = (active) => ({
  ...MONO, fontSize: 'var(--glim-text-sm)',
  color: active ? C.onAccent : C.text,
  background: active ? C.accent : C.chipBg,
  border: `1px solid ${active ? C.accent : C.chipBorder}`,
  borderRadius: 18, padding: '8px 14px', cursor: 'pointer',
  lineHeight: 1, touchAction: 'manipulation',
});

const btn = (primary) => ({
  ...MONO, fontSize: 'var(--glim-text-sm)',
  color: primary ? C.onAccent : C.text,
  background: primary ? C.accent : 'transparent',
  border: `1px solid ${primary ? C.accent : C.chipBorder}`,
  borderRadius: 10, padding: '8px 14px', cursor: 'pointer',
});

