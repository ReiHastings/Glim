// -----------------------------------------------------------------------------
// Title:       useSymptomsStore.js
// Project:     Glim
// Author:      Reina Hastings (reinahastings13@gmail.com)
// Created:     2026-08-14
// Last Modified: 2026-09-06
// Purpose:     Zustand store for the symptom diary event log. Persists to
//              localStorage under key 'glim-symptoms'. One entry schema for all
//              logs with a three-way `kind` discriminator (moment | episode |
//              allDay) so every consumer iterates a single list. Entries are
//              fully mutable after creation (all fields except id/createdAt);
//              every successful edit bumps updatedAt, which drives the
//              last-write-wins sync.
// Inputs:      None (reads localStorage on import)
// Outputs:     Zustand store hook exported as useSymptomsStore
// -----------------------------------------------------------------------------

import { create } from 'zustand';
import { notifyLocalWrite, DOMAINS } from '../syncBus';
import { todayStr, toLogicalDateStr, logicalDayStart } from '../utils/dateUtils';

const STORAGE_KEY = 'glim-symptoms';

// Tolerance for clock skew / a user picking "now" a moment before submitting.
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

// --- Persistence helpers ---

function genId() {
  try { return crypto.randomUUID(); } catch { return String(Date.now()) + Math.random(); }
}

function loadSymptoms() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return { logs: [] };
}

function saveSymptoms(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ logs: state.logs }));
    notifyLocalWrite(DOMAINS.SYMPTOMS);
  } catch { /* ignore */ }
}

// --- Validation (spec 3.3) ---
//
// Returns an error string, or null when the candidate entry is valid. Runs on
// the MERGED entry inside updateEntry, so a partial edit is checked against the
// state it would produce, not against the fields alone.

function validateEntry(e) {
  const started = new Date(e.startedAt);
  if (isNaN(started.getTime())) return 'invalid start time';

  if (started.getTime() > Date.now() + FUTURE_TOLERANCE_MS) {
    return 'start time is in the future';
  }

  if (e.endedAt !== null && e.endedAt !== undefined) {
    if (e.kind !== 'episode') return 'only ongoing entries can have an end time';
    const ended = new Date(e.endedAt);
    if (isNaN(ended.getTime())) return 'invalid end time';
    if (ended.getTime() <= started.getTime()) return 'end time must be after the start time';
  }

  if (e.intensity !== null && e.intensity !== undefined) {
    if (!Number.isInteger(e.intensity) || e.intensity < 1 || e.intensity > 10) {
      return 'intensity must be a whole number from 1 to 10';
    }
  }

  return null;
}

// --- Span helpers ---

// The [start, end] logical-date span an entry occupies. Moments and all-day
// entries occupy their own day only. An open episode runs up to now, so its span
// grows every day it stays open - callers MUST clamp it to their query range
// before expanding it day by day (see getAffectedDays).
function entrySpan(e) {
  const startDate = e.date;
  if (e.kind !== 'episode') return [startDate, startDate];
  const endTs = e.endedAt ? new Date(e.endedAt) : new Date();
  return [startDate, toLogicalDateStr(endTs)];
}

// Monday-anchored week start for a logical date string, as a date string.
// Week labels in trends read "mar 2, mar 9, ..." - Mondays.
function weekStartStr(dateString) {
  const d = logicalDayStart(dateString);
  const dow = (d.getDay() + 6) % 7;  // 0 = Monday
  d.setDate(d.getDate() - dow);
  return toLogicalDateStr(d);
}

function addDaysStr(dateString, days) {
  const d = logicalDayStart(dateString);
  d.setDate(d.getDate() + days);
  return toLogicalDateStr(d);
}

// Filters shared by getEntriesByDay and the day-level selectors.
// symptomIds: array of ids to keep, or null/undefined for all. CATEGORY filtering
// is resolved to symptomIds by the caller - this store never reads the library
// store (stores never import each other; the panel orchestrates).
function matchesFilters(e, filters) {
  const ids = filters?.symptomIds;
  if (Array.isArray(ids) && !ids.includes(e.symptomId)) return false;
  return true;
}

// --- Store ---

const initial = loadSymptoms();

export const useSymptomsStore = create((set, get) => ({
  logs: initial.logs ?? [],

  // ============ Actions ============

  // One-tap log from the companion chip grid. Deliberately minimal: no
  // intensity, no note, no form. Returns the new entry id so the caller can
  // undo exactly this entry (not "the latest", which a sync pull could displace).
  logMoment: (symptomId) => {
    const now = new Date();
    const iso = now.toISOString();
    const entry = {
      id:         genId(),
      symptomId,
      kind:       'moment',
      intensity:  null,
      note:       null,
      startedAt:  iso,
      endedAt:    null,
      createdAt:  iso,
      updatedAt:  iso,
      date:       toLogicalDateStr(now),
      deletedAt:  null,
    };
    set(state => {
      const next = { ...state, logs: [...state.logs, entry] };
      saveSymptoms(next);
      return next;
    });
    return entry.id;
  },

  // Merges fields into an entry. THE date FIELD IS RE-DERIVED HERE whenever
  // startedAt changes - doing it in the UI instead would silently mis-group the
  // entry in history, trends and the export. Validation rejects the whole edit.
  // Returns { ok: true, entry } or { ok: false, error } for inline display.
  updateEntry: (id, fields) => {
    const entry = get().logs.find(e => e.id === id);
    if (!entry) return { ok: false, error: 'entry not found' };

    const next = { ...entry, ...fields };

    // Step 1: an explicit startedAt change re-derives the logical date.
    if (fields.startedAt !== undefined && fields.startedAt !== entry.startedAt) {
      const started = new Date(fields.startedAt);
      if (isNaN(started.getTime())) return { ok: false, error: 'invalid start time' };
      next.date = toLogicalDateStr(started);
    }

    // Step 2: kind side effects (spec 3.1), applied against the date from step 1.
    if (fields.kind !== undefined && fields.kind !== entry.kind) {
      if (next.kind === 'moment') {
        next.endedAt = null;
      } else if (next.kind === 'allDay') {
        next.startedAt = logicalDayStart(next.date).toISOString();
        next.endedAt   = null;
      }
      // 'episode': times untouched.
    }

    const error = validateEntry(next);
    if (error) return { ok: false, error };

    next.updatedAt = new Date().toISOString();

    set(state => {
      const updated = { ...state, logs: state.logs.map(e => (e.id === id ? next : e)) };
      saveSymptoms(updated);
      return updated;
    });
    return { ok: true, entry: next };
  },

  // Closes an open episode. Sugar over updateEntry, guarded so it cannot
  // resurrect an end time on a moment or re-close a closed episode.
  endEpisode: (id) => {
    const entry = get().logs.find(e => e.id === id);
    if (!entry) return { ok: false, error: 'entry not found' };
    if (entry.kind !== 'episode' || entry.endedAt !== null) {
      return { ok: false, error: 'not an ongoing episode' };
    }
    return get().updateEntry(id, { endedAt: new Date().toISOString() });
  },

  // Copies symptom, intensity and note into a fresh entry stamped now.
  // Kind rule: allDay copies as allDay (the multi-day flare case); moments and
  // episodes copy as moments, because copying a closed episode's duration would
  // fabricate unlogged hours and copying "ongoing" would silently open state.
  // Returns the new entry id, or null if the source is gone.
  logAgain: (id) => {
    const source = get().logs.find(e => e.id === id);
    if (!source) return null;

    const now  = new Date();
    const iso  = now.toISOString();
    const date = toLogicalDateStr(now);
    const kind = source.kind === 'allDay' ? 'allDay' : 'moment';

    const entry = {
      id:        genId(),
      symptomId: source.symptomId,
      kind,
      intensity: source.intensity ?? null,
      note:      source.note ?? null,
      startedAt: kind === 'allDay' ? logicalDayStart(date).toISOString() : iso,
      endedAt:   null,
      createdAt: iso,
      updatedAt: iso,
      date,
      deletedAt: null,
    };

    set(state => {
      const next = { ...state, logs: [...state.logs, entry] };
      saveSymptoms(next);
      return next;
    });
    return entry.id;
  },

  // Soft delete. Hard deletion would let a sync pull re-introduce the entry.
  softDelete: (id) => {
    const now = new Date().toISOString();
    set(state => {
      const next = {
        ...state,
        logs: state.logs.map(e => (e.id === id ? { ...e, deletedAt: now, updatedAt: now } : e)),
      };
      saveSymptoms(next);
      return next;
    });
  },

  // Re-reads localStorage into Zustand state. Called by sync.js after remote pull.
  reload: () => {
    const data = loadSymptoms();
    set({ logs: data.logs ?? [] });
  },

  // ============ Selectors ============
  // All exclude soft-deleted entries. Entry counts include unrated entries;
  // how a null intensity is interpreted in an aggregate is decided in exactly one
  // place, utils/intensity.js, never here.

  // Today's entries plus any still-open episode from an earlier day: an ongoing
  // entry is "today" until it is closed. The panel renders the start date in the
  // meta line for those, so a midnight-spanning episode reads honestly.
  getTodayEntries: () => {
    const today = todayStr();
    return get().logs
      .filter(e => !e.deletedAt)
      .filter(e => e.date === today || (e.kind === 'episode' && e.endedAt === null))
      .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
  },

  getOpenEpisodes: () =>
    get().logs.filter(e => !e.deletedAt && e.kind === 'episode' && e.endedAt === null),

  // Day-grouped history. rangeStart/rangeEnd are inclusive logical date strings;
  // null means unbounded. Days with no entries are ABSENT from the result - no
  // zero-count rows, per the governing constraint.
  // Returns [{ date, entries }] newest day first, entries newest first within a day.
  getEntriesByDay: (rangeStart = null, rangeEnd = null, filters = null) => {
    const inRange = (d) =>
      (rangeStart === null || d >= rangeStart) && (rangeEnd === null || d <= rangeEnd);

    const kept = get().logs.filter(
      e => !e.deletedAt && inRange(e.date) && matchesFilters(e, filters)
    );

    const byDate = new Map();
    for (const e of kept) {
      if (!byDate.has(e.date)) byDate.set(e.date, []);
      byDate.get(e.date).push(e);
    }

    return [...byDate.entries()]
      .sort((a, b) => (a[0] < b[0] ? 1 : -1))
      .map(([date, entries]) => ({
        date,
        entries: entries.sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt)),
      }));
  },

  // ---- Day-level presence (the counting primitive) ----
  //
  // The unit of analysis is "was this symptom present on this day?", NOT "how
  // many entries were logged". Entries are not comparable units: a moment is an
  // instant, an episode a duration, an all-day entry a whole day. Counting
  // entries per week also counted one multi-week episode once in EVERY week it
  // touched, so a single long flare read as a rising trend. Every weekly or
  // range figure in the app derives from these selectors, so no second counting
  // rule exists to disagree with them.
  //
  // Expansion: moment/allDay -> {their own day}; episode -> every logical day
  // from its start through its end (or through today while open).
  //
  // rangeStart/rangeEnd are inclusive logical date strings; null is unbounded.
  // CLAMPING IS LOAD-BEARING: an episode left open for a year spans a year of
  // days, so each span is intersected with the requested range BEFORE it is
  // walked. Without that, one open episode makes this loop unbounded in the
  // size of the user's history rather than the size of the query.
  //
  // Returns Map<dateString, Set<symptomId>>. Days with nothing present are
  // absent from the map (no zero rows), matching getEntriesByDay.
  getAffectedDays: (rangeStart = null, rangeEnd = null, filters = null) => {
    const byDate = new Map();

    for (const e of get().logs) {
      if (e.deletedAt || !matchesFilters(e, filters)) continue;

      let [from, to] = entrySpan(e);
      if (rangeStart !== null && from < rangeStart) from = rangeStart;
      if (rangeEnd   !== null && to   > rangeEnd)   to   = rangeEnd;
      if (from > to) continue;  // span lies entirely outside the range

      for (let d = from; d <= to; d = addDaysStr(d, 1)) {
        if (!byDate.has(d)) byDate.set(d, new Set());
        byDate.get(d).add(e.symptomId);
      }
    }

    return byDate;
  },

  // Distinct symptoms present per day, oldest day first, empty days omitted.
  // Returns [{ date, count }].
  getDailyCounts: (rangeStart = null, rangeEnd = null, filters = null) => {
    return [...get().getAffectedDays(rangeStart, rangeEnd, filters).entries()]
      .map(([date, ids]) => ({ date, count: ids.size }))
      .sort((a, b) => (a.date < b.date ? -1 : 1));
  },

  // Weekly rollup for trends, oldest week first, covering the last rangeWeeks
  // Monday-anchored weeks including the current one. DERIVED from the day map
  // above rather than from its own counting rule, which is what keeps the weekly
  // and daily views from ever disagreeing.
  // Returns [{ weekStart, daysAffected, daysInWeek }] - read as "5 of 7 days".
  getWeeklyAffectedDays: (rangeWeeks = 8, filters = null) => {
    const currentWeek = weekStartStr(todayStr());
    const firstWeek   = addDaysStr(currentWeek, -7 * (rangeWeeks - 1));
    const lastDay     = addDaysStr(currentWeek, 6);

    const affected = get().getAffectedDays(firstWeek, lastDay, filters);

    const weeks = [];
    for (let i = rangeWeeks - 1; i >= 0; i--) {
      const weekStart = addDaysStr(currentWeek, -7 * i);
      let daysAffected = 0;
      for (let d = 0; d < 7; d++) {
        if (affected.has(addDaysStr(weekStart, d))) daysAffected++;
      }
      weeks.push({ weekStart, daysAffected, daysInWeek: 7 });
    }
    return weeks;
  },
}));
