// -----------------------------------------------------------------------------
// Title:       StepsPanel.jsx
// Project:     Glim
// Author:      Reina Hastings (reinahastings13@gmail.com)
// Created:     2026-03-30
// Last Modified: 2026-03-30
// Purpose:     Companion mode panel for step tracking. Tappable hero number
//              opens the native numeric keyboard (pre-filled with current count).
//              Replace-style: submitting a new count creates a new entry; the
//              latest entry for the day is always the displayed count. Horizontal
//              tier progress bar with markers at 2.5k / 5k / 7.5k / 10k.
//              "Next milestone" pill updates live. Footer shows streak and
//              7-day average. Glim reacts on tier crossings, first-ever milestone
//              days, streak milestones, and regular log events.
// Inputs:      Reads from useStepsStore, useMessageStore. No props required.
// Outputs:     Steps panel content (rendered inside CompanionPanel)
// -----------------------------------------------------------------------------

import { useState, useRef, useEffect, useMemo } from 'react';
import {
  useStepsStore, TIERS, manualCountForDate, dateStr,
  buildDayIndex, resolveDayFromIndex, resolveDayCount,
} from '../stores/useStepsStore';
import { useClockStore } from '../stores/useClockStore';
import { useStepsHealthStore, rowsForDate } from '../stores/useStepsHealthStore';
import { importSteps } from '../health/stepsImport';
import { readDeviceRecord, writeDeviceRecord } from '../health/deviceRecord';
import { todayStr } from '../utils/dateUtils';
import { useMessageStore } from '../stores/useMessageStore';

// =============================================================================
//  Message pools
// =============================================================================

const MSG = {
  logged_low: [
    'early days. every step counts. literally.',
    '{count}. a journey of 10,000 steps begins with... {count}.',
    'slow start and that\'s fine. the steps aren\'t going anywhere.',
  ],

  logged_delta: [
    '{gained} steps since you last checked in. busy legs.',
    '+{gained}. you\'ve been moving.',
    '{gained} new steps. where\'d you go?',
    'oh nice, {gained} more since last time.',
    '{gained} steps happened while i wasn\'t looking.',
    'you snuck in {gained} steps. respect.',
  ],

  logged_simple: [
    'logged. {count} steps today.',
    '{count}. noted.',
    'step count updated.',
    '{count} and counting.',
  ],

  logged_playful: [
    'your feet are putting in work today.',
    'step step step step step step step.',
    'that\'s {count} tiny floor kisses from your shoes.',
    'fun fact: you\'ve taken approximately {count} decisions to not sit down.',
    'legs: engaged. steps: logged. glim: proud.',
    'you\'re walking. you\'re logging. you\'re thriving.',
    '{count}. that\'s a lot of times to pick up and put down a foot.',
  ],

  logged_absurd: [
    'every step you take, every move you make, i\'ll be... counting.',
    'the floor has been thoroughly stepped on today.',
    'you vs. a t-rex in a step contest. you\'re winning. they have tiny arms AND tiny steps.',
    'scientists estimate that\'s roughly {count} steps. (i\'m the scientist. i just read the number you typed.)',
    'your ancestors walked thousands of miles to find food. you walked to the fridge. equally valid.',
    'if each step was one grain of rice you\'d have... a weird amount of rice.',
    '{count} steps. somewhere a hamster on a wheel just felt outclassed.',
    'your shoes just unlocked a new achievement.',
    'the earth rotates at 1,000 mph. you\'re adding to that. probably.',
    'you\'re not walking. you\'re aggressively relocating.',
    '{count} steps. that\'s {count} times gravity tried to stop you and failed.',
    'hot take: walking is just controlled falling and you\'re incredible at it.',
    'the ground didn\'t ask for this but here you are. stepping on it. repeatedly.',
    'you\'ve taken {count} steps and not one of them was backwards. (probably.)',
    'walking: the original open-world game. no DLC required.',
    'your pedometer is like \'this person WALKS walks.\'',
    'at this rate you\'re going to walk your shoes into retirement.',
    'i can\'t walk. i live on a screen. so i\'m living vicariously through you. keep going.',
    '{count}. that\'s more steps than a recipe for making sourdough.',
    'bold of you to just... move around. with your legs. in this economy.',
    'you are a bipedal locomotion machine and i am in awe.',
    'the inventor of stairs would be so proud of you right now.',
  ],

  logged_science: [
    'the average person takes about 2,000 steps per mile. you\'re at {count}. do the math. or don\'t. i won\'t judge.',
    'walking increases blood flow to your brain by about 15%. your neurons are loving this.',
    'each step uses about 200 muscles. at {count} steps, that\'s... a lot of tiny muscle parties.',
    'walking upright is genuinely one of the weirdest things humans do. you\'re so good at it though.',
    'your body burns about 0.04 calories per step. {count} steps = i\'m not doing that math but it\'s some calories.',
  ],

  // The first time this device imports a step count from the health platform.
  // Shown once per device, then never again (a flag in the device record).
  health_first: [
    'oh. your phone already counts these. {count} today. i\'ll stop asking you to type.',
    '{count} steps and you didn\'t have to tell me. we\'ve reached the future.',
    'health says {count} today. i\'m choosing to believe it.',
  ],

  // Tier reached - keyed by tier index (0-3)
  tier_reached: {
    0: [
      '2,500! first milestone down.',
      'quarter of the way to the big one. 2,500.',
      'tier 1 unlocked. your feet are officially warmed up.',
      '2,500 steps. you\'re in the game now.',
      '2,500 steps. your feet just filed for overtime.',
    ],
    1: [
      '5,000! halfway to 10k. your legs know what they\'re doing.',
      '5k steps. that\'s roughly 2.5 miles. casually.',
      'halfway point. 5,000. the second half is just a victory lap.',
      'tier 2. 5,000. the steps are stepping.',
      '5k! if steps were dollars you\'d have... well, 5,000 dollars. that\'s a lot of dollars.',
      '5,000 steps. you just out-walked a penguin\'s daily commute. probably.',
    ],
    2: [
      '7,500! three quarters of the way. you can see the finish line.',
      'tier 3. this is where casual walkers become legends.',
      '7,500. at this point you\'re not walking, you\'re on a mission.',
      'three tiers down. one to go. your shoes are nervous.',
      '7,500. your legs are in the zone. the step zone. i just made that up.',
      'three quarters. if this were a pizza you\'d have eaten three slices. of steps. the metaphor is falling apart but you\'re doing great.',
    ],
    3: [
      'TEN THOUSAND. you did it. all tiers. the whole thing.',
      '10k! you just hit the number that every health article talks about!',
      'four tiers. ten thousand steps. one absolute champion.',
      '10,000. somewhere a pedometer just shed a proud tear.',
      'all tiers cleared. you are now legally allowed to sit down.',
      '10k steps. your feet filed a formal complaint but they\'re secretly proud.',
      '10,000! quick, someone get this person a trophy and a foot bath.',
      'all tiers cleared. your shoes would like to file a formal complaint but they can\'t because they\'re shoes.',
    ],
    generic: [
      '{tierValue} steps! tier {tier} reached.',
      'you just crossed {tierValue}. that\'s a milestone and you earned it.',
    ],
  },

  // First-ever milestone days - keyed by step threshold
  milestone: {
    5000: [
      'wait. this is your first time hitting 5,000 in a day? that\'s a big deal. i\'m remembering this.',
      'FIRST 5K DAY. this one goes in the record books. (i\'m the record books.)',
      'FIRST 5K DAY. hold on let me tell everyone. *turns to empty void* THEY DID IT.',
    ],
    10000: [
      'your first ever 10,000-step day. i genuinely don\'t have enough exclamation points for this.',
      'FIRST 10K DAY. i wish i had confetti. imagine confetti.',
      '10,000 in one day for the first time. this is your super bowl. your world cup. your... step cup.',
      'FIRST 10K DAY. you just did something millions of people talk about and never do.',
    ],
    15000: [
      '15,000 in a single day?? that\'s never happened before. you\'re making history. personal history. the best kind.',
      'FIRST 15K. where did you even walk? did you circumnavigate something?',
      '15k in a day?? who are you. what happened. did someone chase you.',
    ],
    20000: [
      'twenty thousand steps. in one day. for the first time ever. i need to sit down. (i can\'t. i don\'t have legs.)',
      'FIRST 20K DAY. you walked a 20k. that\'s a thing you did today.',
      '20k. TWENTY THOUSAND. that\'s not walking, that\'s a pilgrimage.',
      'first 20k day. your legs have left the chat. they\'ll be back. they\'re just... processing.',
    ],
  },

  // Streaks - keyed by milestone length
  streak: {
    3: [
      'three days in a row hitting at least 2,500. the legs are on a roll.',
      '3-day step streak. your shoes are developing a routine.',
      'three days straight. your couch is starting to worry.',
    ],
    7: [
      'one full week of hitting your step milestone every day.',
      '7-day streak. you\'ve walked every single day this week. that\'s not nothing.',
      'a week of walking. your body is officially in the habit zone.',
      '7-day streak. you walked every day for a week. the sidewalk has a crush on you.',
      'a full week. your shoes are writing a memoir.',
    ],
    14: [
      'two weeks. fourteen consecutive days of moving your legs on purpose. genuinely impressive.',
      '14-day step streak. you\'re not even thinking about it anymore, are you? it\'s just... what you do now.',
      '14 days. your legs have formed a union and their only demand is: more walking.',
    ],
    21: [
      '21 days. the habit is locked in. you\'re a walker now. it\'s part of your identity.',
    ],
    30: [
      'thirty days of hitting your step milestone. a full month. you absolute machine.',
      '30-day streak. your shoes need a raise.',
      '30-day streak. you\'ve taken more steps this month than most furniture takes in a lifetime.',
    ],
    60: [
      'sixty days. two months. your legs don\'t even remember what \'skip a day\' means.',
      'sixty days. at this point your legs are applying for their own zip code.',
    ],
    90: [
      'ninety consecutive days. a full season of walking. there\'s nothing i can say that does this justice.',
      'ninety days. you\'ve been walking consistently for an entire season. the ground knows your name.',
    ],
    generic: [
      '{streak}-day step streak. you keep showing up and i keep being impressed.',
      'streak: {streak} days. at this point your feet have their own workout playlist.',
      '{streak} days. your legs just updated their linkedin: \'professional walker.\'',
      'streak: {streak}. i\'m starting to think you don\'t even own a car. (you probably do. but still.)',
    ],
  },
};

const STREAK_MILESTONES = new Set([3, 7, 14, 21, 30, 60, 90]);
const STEP_MILESTONES   = [5000, 10000, 15000, 20000];

// =============================================================================
//  Message helpers
// =============================================================================

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function fill(template, vars) {
  return template.replace(/\{(\w+)\}/g, (_, k) => {
    const v = vars[k];
    return v !== undefined ? String(v) : `{${k}}`;
  });
}

// `prev` is the RESOLVED count the user was just looking at (health-inclusive),
// not the manual-only value. That is what the milestone and tier branches below
// have always meant by "previous": was the DAY below this threshold before this
// edit. Passing the manual-only value here would re-announce a milestone the day
// crossed hours ago by import, and would be null on an import-only day, which
// coerces to 0 in every comparison.
function selectMessage(count, prev, entries, healthRows, today, tiers, newStreak) {
  const gained = count - prev;
  const vars   = { count: count.toLocaleString(), prev: prev.toLocaleString(), gained: gained.toLocaleString(), streak: newStreak };

  // --- Priority 1: first-ever milestone day ---
  for (const m of STEP_MILESTONES) {
    if (count >= m && prev < m) {
      // Check if any previous day (not today) has ever reached this threshold.
      // Imported days count: the union of days the user typed and days health
      // supplied, or a milestone first reached on an import-only day would be
      // announced twice.
      const prevDays = new Set([
        ...entries.map(e => dateStr(e.timestamp)),
        ...healthRows.map(r => r.date),
      ]);
      prevDays.delete(today);
      // ONE index for the whole scan. countForDate per day would rebuild it per
      // day, which is the quadratic shape this file was just cured of; it only
      // runs on a milestone crossing, but the cost grows with history.
      const index = buildDayIndex(entries, healthRows);
      const everReached = [...prevDays].some(d => resolveDayFromIndex(index, d).count >= m);
      if (!everReached) {
        const pool = MSG.milestone[m];
        return fill(pick(pool), vars);
      }
    }
  }

  // --- Priority 2: tier crossed (highest tier first) ---
  for (let i = tiers.length - 1; i >= 0; i--) {
    if (prev < tiers[i] && count >= tiers[i]) {
      const pool = MSG.tier_reached[i] ?? MSG.tier_reached.generic;
      const tierVars = { ...vars, tier: i + 1, tierValue: tiers[i].toLocaleString() };
      return fill(pick(pool), tierVars);
    }
  }

  // --- Priority 3: streak milestone ---
  if (STREAK_MILESTONES.has(newStreak)) {
    const pool = MSG.streak[newStreak] ?? MSG.streak.generic;
    return fill(pick(pool), vars);
  }

  // --- Priority 4: regular logged message ---
  if (count < 1000) {
    return fill(pick(MSG.logged_low), vars);
  }
  if (gained > 0) {
    // The delta pool renders "+{gained}", so it is only reachable when the count
    // ROSE. That matters now that `prev` can come from health: correcting a
    // health number downward (the phone stayed home) gives a negative gained and
    // must fall through to the pools below, never render "+-3000".
    const all = [...MSG.logged_delta, ...MSG.logged_simple, ...MSG.logged_playful, ...MSG.logged_absurd, ...MSG.logged_science];
    return fill(pick(all), vars);
  }
  const all = [...MSG.logged_simple, ...MSG.logged_playful, ...MSG.logged_absurd, ...MSG.logged_science];
  return fill(pick(all), vars);
}

// =============================================================================
//  Tier bar helper
// =============================================================================

const TEAL_RAMP  = ['rgba(94,234,212,0.25)', 'rgba(94,234,212,0.40)', 'rgba(94,234,212,0.60)', '#5eead4'];
const GREEN_RAMP = ['rgba(74,222,128,0.25)', 'rgba(74,222,128,0.40)', 'rgba(74,222,128,0.60)', '#4ade80'];

// Returns filled segments to render inside the tier bar track.
// Each segment has { pct (% of total bar width), color, isLast }.
function computeSegments(count, tiers) {
  const allCleared = count >= tiers[tiers.length - 1];
  const ramp = allCleared ? GREEN_RAMP : TEAL_RAMP;
  const segments = [];

  for (let i = 0; i < tiers.length; i++) {
    const tierStart = i === 0 ? 0 : tiers[i - 1];
    const tierEnd   = tiers[i];

    if (count >= tierEnd) {
      segments.push({ pct: 25, color: ramp[i] });
    } else if (count > tierStart) {
      const pct = ((count - tierStart) / (tierEnd - tierStart)) * 25;
      segments.push({ pct, color: ramp[i] });
      break; // remaining tiers are empty
    } else {
      break;
    }
  }
  return segments;
}

// Format large step numbers (e.g. 7100 -> "7,100")
function fmt(n) {
  return n.toLocaleString();
}

// Format weekly avg (keep one decimal if < 1000, otherwise round)
function fmtAvg(n) {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

// =============================================================================
//  Component
// =============================================================================

export default function StepsPanel() {
  // getStreak is read on its own as well as through getDaySummary: handleLog
  // needs the streak AFTER its write, which the memo cannot supply.
  const {
    entries, logSteps, clearManualForToday, getStreak, getDaySummary,
  } = useStepsStore();
  // BOTH stores are subscribed deliberately (handoff spec R11a): pulling health
  // rows out of the health store imperatively, inside a useStepsStore selector,
  // would read the right number once but would NOT subscribe this component to
  // health-store changes, so an import would land silently and the panel would
  // keep showing the old number until something else re-rendered it. A static
  // test asserts both hooks are called here.
  const healthRows = useStepsHealthStore(s => s.rows);
  const logicalDay = useClockStore(s => s.logicalDay);
  const { setMessage, setShowBubble } = useMessageStore();

  // The four derived values, from ONE day index, recomputed only when something
  // they depend on changes. Before this they were four unmemoized calls in the
  // render body, each rebuilding its own scan: with the panel open that cost
  // 142 ms of main thread PER POINTER-MOVE EVENT on a phone-class CPU
  // (docs/plan_steps_derivation_cost.md section 2).
  //
  // `logicalDay` is a dependency because the summary reads todayStr() inside,
  // which no dependency array can see. Without it the panel would keep showing
  // yesterday's numbers after the 03:00 boundary, and openEditor below would
  // prefill from them. It changes once a day; see useClockStore.js.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- getDaySummary is a stable store action
  const { todayCount, todaySource, streak, weeklyAvg } =
    useMemo(() => getDaySummary(healthRows), [entries, healthRows, logicalDay]);

  const allCleared = todayCount >= TIERS[TIERS.length - 1];
  const heroColor  = allCleared
    ? '#4ade80'
    : todayCount > 0
      ? '#5eead4'
      : 'rgba(94,234,212,0.3)';

  // --- Tier bar ---
  const segments = computeSegments(todayCount, TIERS);

  // --- Next milestone pill ---
  let pillText, pillColor, pillBg;
  if (allCleared) {
    pillText  = 'all tiers cleared!';
    pillColor = 'rgba(74,222,128,0.7)';
    pillBg    = 'rgba(74,222,128,0.08)';
  } else if (todayCount === 0) {
    pillText  = `first milestone: ${fmt(TIERS[0])}`;
    pillColor = 'rgba(94,234,212,0.4)';
    pillBg    = 'rgba(94,234,212,0.04)';
  } else {
    const nextTier = TIERS.find(t => t > todayCount) ?? TIERS[TIERS.length - 1];
    const remaining = nextTier - todayCount;
    pillText  = `next: ${fmt(nextTier)} (${fmt(remaining)} to go)`;
    pillColor = 'rgba(94,234,212,0.6)';
    pillBg    = 'rgba(94,234,212,0.06)';
  }

  // --- Input editing ---
  const [editing, setEditing] = useState(false);
  const [inputVal, setInputVal] = useState('');
  const inputRef    = useRef(null);
  const bubbleTimer = useRef(null);

  useEffect(() => {
    return () => clearTimeout(bubbleTimer.current);
  }, []);

  // --- Health-import UI state ---
  //
  // The device record is plain localStorage, not a store, so nothing re-renders
  // when it changes. Re-read it whenever health rows change: the import that
  // just wrote a row is also what may have just set emptySince or firstImportAt.
  // Derived during render, not in an effect: an effect calling setState here
  // would mean an extra render pass on every import for a value that is just a
  // localStorage read. `healthRows` is the cache key rather than an input - the
  // import that writes a row is the same one that may have set emptySince or
  // firstImportAt, so the record is worth re-reading exactly when rows change.
  // healthRows is the cache key rather than an input, which is why the rule
  // below is silenced: re-read the record exactly when an import has run.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const deviceRecord = useMemo(() => readDeviceRecord(), [healthRows]);
  const [showExplainer, setShowExplainer] = useState(false);

  // --- Health step import, panel-open trigger ---
  //
  // CompanionPanel renders this component conditionally and returns null when no
  // panel is open, so StepsPanel genuinely unmounts on close: a mount effect is
  // a correct once-per-open hook. Opening the steps panel is the moment the user
  // is most likely to be looking at the number, so it is worth a fresh read.
  //
  // No cleanup to do: importSteps owns its own in-flight guard, and its result
  // reaches the panel through the store rather than through component state, so
  // a resolve after unmount sets nothing on a dead component. Under React
  // StrictMode the effect fires twice in dev; the in-flight guard absorbs it.
  useEffect(() => {
    importSteps({ reason: 'panel' }).catch(e =>
      console.warn('[glim health] panel import failed:', e));
  }, []);

  // --- First successful import on this device: Glim says something, once ---
  //
  // Gated on a flag in the device record rather than on component state, so it
  // survives a remount and cannot repeat. The import service sets firstImportAt;
  // the panel is what notices, because it owns the message bubble's timer (the
  // service has no component to hang one on).
  useEffect(() => {
    if (!deviceRecord.firstImportAt || deviceRecord.firstImportAnnounced) return;
    if (todayCount <= 0) return;
    // Writes the flag without re-reading it into state: the memo above is not
    // invalidated by this write, so the effect's deps do not change and it
    // cannot fire twice. A later import re-reads the record and sees the flag.
    writeDeviceRecord({ firstImportAnnounced: true });
    clearTimeout(bubbleTimer.current);
    setMessage(fill(pick(MSG.health_first), { count: fmt(todayCount) }));
    setShowBubble(true);
    bubbleTimer.current = setTimeout(() => setShowBubble(false), 5000);
  }, [deviceRecord, todayCount, setMessage, setShowBubble]);

  const openEditor = () => {
    // Prefilled ONLY when today's number is the user's own. commitEdit fires on
    // blur, so prefilling a health-sourced number would mean that tapping the
    // hero number to look at it and then tapping away silently pins the day to
    // whatever health said at that moment, after which the day stops updating.
    // An empty input parses to NaN and logs nothing, so an accidental open stays
    // a no-op while a deliberate pin costs one deliberate act: typing it.
    //
    // RE-DERIVED rather than read from the memo above. The memo is keyed on the
    // logical day, which is ticked from an interval and from the resume paths;
    // between the boundary passing and the next tick, the memo still holds
    // YESTERDAY's count and source. Prefilling from that would let a tap and a
    // tap away commit yesterday's number as today's manual entry, which then
    // beats the health import for the whole day - exactly the failure the rest
    // of this comment exists to prevent, arriving by a different route.
    const { count: freshCount, source: freshSource } =
      resolveDayCount(entries, healthRows, todayStr());
    const prefill = freshSource === 'manual' && freshCount > 0;
    setInputVal(prefill ? String(freshCount) : '');
    setEditing(true);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const commitEdit = () => {
    setEditing(false);
    const n = parseInt(inputVal, 10);
    if (!isNaN(n) && n >= 0) {
      handleLog(n);
    }
  };

  const cancelEdit = () => {
    setEditing(false);
    setInputVal('');
  };

  // --- Log handler ---
  const handleLog = (count) => {
    // TWO different "previous" values, deliberately (handoff spec R11b):
    //
    // The no-op guard uses the MANUAL value, so typing the number health
    // currently reports still creates a deliberate pin for the day. Guarding on
    // the resolved count would make that impossible and let the number keep
    // moving under the user.
    const manualPrev = manualCountForDate(entries, todayStr());
    if (count === manualPrev) return; // repeat of a typed value: no entry, no message

    // The message uses the RESOLVED count - the number the user was looking at.
    // Re-derived for the same reason as openEditor: across an unticked day
    // boundary the memo holds yesterday's count, which would make the "+gained"
    // message compare today's entry against yesterday's total.
    const today = todayStr();
    const prev = resolveDayCount(entries, healthRows, today).count;
    logSteps(count);

    // Compute streak after the new entry (entries not yet updated in closure,
    // but the replace-style count for today is `count` since it's the latest).
    // Always re-derived, never read from the memo: across an unticked day
    // boundary the memoized streak is yesterday's. The conditional that used to
    // avoid this call existed because the call was expensive; it is now under a
    // millisecond (docs/plan_steps_derivation_cost.md section 10).
    const newStreak = getStreak(healthRows);

    const msg = selectMessage(count, prev, entries, healthRows, today, TIERS, newStreak);
    clearTimeout(bubbleTimer.current);
    setMessage(msg);
    setShowBubble(true);
    bubbleTimer.current = setTimeout(() => setShowBubble(false), 5000);
  };

  const mono = { fontFamily: "'Courier New', monospace" };

  // --- Health-aware subtitle -------------------------------------------------
  //
  // Today's imported total, or null when health has nothing for today. Needed
  // separately from todayCount because a manual entry hides the health row, and
  // the subtitle names both numbers when they disagree.
  const healthToday = (() => {
    const rows = rowsForDate(healthRows, todayStr());
    if (rows.length === 0) return null;
    return rows.reduce((a, b) => (String(b.updatedAt) > String(a.updatedAt) ? b : a)).steps;
  })();

  // The empty state means: this device imports, the prompt has been shown, and
  // health has returned nothing across the whole window. It is deliberately NOT
  // shown for a day that simply has no row yet (an import that has not run).
  const showEmptyHint = todaySource === null && deviceRecord.stepsImport && !!deviceRecord.emptySince;

  const subtitle =
    todaySource === 'manual' && healthToday !== null
      ? `your number - health says ${fmt(healthToday)}`
      : todaySource === 'manual' || (todaySource === null && todayCount > 0)
        ? 'steps today - tap to update'
        : todaySource !== null
          ? 'steps today from health - tap to override'
          : showEmptyHint
            ? "health isn't sending anything yet"
            : 'tap to log your steps';

  return (
    <div style={{ padding: '0 16px 16px', ...mono }}>

      {/* ===== HERO NUMBER ===== */}
      <div
        onClick={openEditor}
        style={{ textAlign: 'center', marginBottom: 10, cursor: 'pointer', position: 'relative' }}
      >
        {editing ? (
          <input
            ref={inputRef}
            type="number"
            inputMode="numeric"
            pattern="[0-9]*"
            value={inputVal}
            onChange={e => setInputVal(e.target.value)}
            onBlur={commitEdit}
            onKeyDown={e => {
              if (e.key === 'Enter')  commitEdit();
              if (e.key === 'Escape') cancelEdit();
            }}
            style={{
              fontSize: 'var(--glim-text-hero)',
              fontWeight: 600,
              color: heroColor,
              background: 'transparent',
              border: 'none',
              borderBottom: `1px solid ${heroColor}`,
              outline: 'none',
              textAlign: 'center',
              width: '100%',
              ...mono,
            }}
          />
        ) : (
          <div style={{ fontSize: 'var(--glim-text-hero)', fontWeight: 600, color: heroColor, lineHeight: 1 }}>
            {fmt(todayCount)}
          </div>
        )}
        <div style={{ fontSize: 'var(--glim-text-sm)', color: 'rgba(200,210,230,0.4)', marginTop: 3 }}>
          {subtitle}
        </div>
        {/* "use health's number" drops the manual entry for today and lets the
            imported row show again. Shown wherever a health row exists for
            today, the desktop tab included: the row's presence is a fact about
            the data, not a claim about this device's permissions. */}
        {todaySource === 'manual' && healthToday !== null && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); clearManualForToday(); }}
            style={{
              marginTop: 4, padding: 0, background: 'none', border: 'none',
              color: 'rgba(94,234,212,0.7)', fontSize: 'var(--glim-text-xs)',
              cursor: 'pointer', textDecoration: 'underline', ...mono,
            }}
          >
            use health&apos;s number
          </button>
        )}
        {showEmptyHint && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setShowExplainer(v => !v); }}
            style={{
              marginTop: 4, padding: 0, background: 'none', border: 'none',
              color: 'rgba(200,210,230,0.35)', fontSize: 'var(--glim-text-xs)',
              cursor: 'pointer', textDecoration: 'underline', ...mono,
            }}
          >
            why?
          </button>
        )}
      </div>

      {/* The explainer must never blame the user for a refusal. iOS deliberately
          hides a refused read from the app, so Glim genuinely cannot tell that
          apart from a phone that has counted nothing. It says what it observes
          and where to look, and a static test enforces the wording. */}
      {showEmptyHint && showExplainer && (
        <div style={{
          margin: '0 0 10px', padding: '8px 10px',
          background: 'rgba(15,20,35,0.4)', borderRadius: 8,
          border: '1px solid rgba(100,120,160,0.12)',
          fontSize: 'var(--glim-text-xs)', color: 'rgba(200,210,230,0.45)', lineHeight: 1.5,
        }}>
          health isn&apos;t sending me any steps. that can mean access is off, or your
          phone just hasn&apos;t counted any yet. if you meant to share, it&apos;s under
          Settings &gt; Health &gt; Data Access &amp; Devices &gt; Glim. i&apos;ll keep checking quietly.
        </div>
      )}

      {/* ===== TIER BAR ===== */}
      <div style={{ position: 'relative', height: 8, background: 'rgba(255,255,255,0.06)', borderRadius: 4, margin: '0 2px 2px' }}>
        <div style={{ position: 'absolute', left: 0, top: 0, height: 8, borderRadius: 4, overflow: 'hidden', display: 'flex', width: '100%' }}>
          {segments.map((seg, i) => (
            <div key={i} style={{
              width: `${seg.pct}%`,
              height: '100%',
              background: seg.color,
              borderRadius: i === segments.length - 1 && seg.pct < 25 ? '0 4px 4px 0' : 0,
              flexShrink: 0,
            }} />
          ))}
        </div>
      </div>

      {/* ===== TIER LABELS ===== */}
      <div style={{ display: 'flex', justifyContent: 'space-between', padding: '0 2px', marginBottom: 10 }}>
        <span style={{ fontSize: 'var(--glim-text-xs)', color: 'rgba(200,210,230,0.2)' }}>0</span>
        {TIERS.map((t, i) => {
          const completed = todayCount >= t;
          const label     = t >= 1000 ? `${t / 1000}k` : String(t);
          const color     = completed
            ? (allCleared ? 'rgba(74,222,128,0.5)' : 'rgba(94,234,212,0.5)')
            : 'rgba(200,210,230,0.25)';
          return (
            <span key={i} style={{ fontSize: 'var(--glim-text-xs)', color }}>{label}</span>
          );
        })}
      </div>

      {/* ===== NEXT MILESTONE PILL ===== */}
      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 10 }}>
        <div style={{ fontSize: 'var(--glim-text-sm)', color: pillColor, background: pillBg, padding: '3px 10px', borderRadius: 7 }}>
          {pillText}
        </div>
      </div>

      {/* ===== FOOTER ===== */}
      <div style={{ display: 'flex', justifyContent: 'space-between', padding: '0 2px', fontSize: 'var(--glim-text-sm)', color: 'rgba(200,210,230,0.35)' }}>
        <span>streak: {streak} {streak === 1 ? 'day' : 'days'}</span>
        <span>avg: {fmtAvg(weeklyAvg)} this week</span>
      </div>

    </div>
  );
}
