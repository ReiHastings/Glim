// -----------------------------------------------------------------------------
// Title:       WaterPanel.jsx
// Project:     Glim
// Author:      Reina Hastings (reinahastings13@gmail.com)
// Created:     2026-03-27
// Last Modified: 2026-03-27
// Purpose:     Water tracking panel rendered inside CompanionPanel when
//              activePanel === 'water'. Shows a circular progress ring with
//              today's bottle count, a +bottle button, and an undo toast (4s).
//              Triggers glim speech bubble messages from water_logged,
//              water_goal_met, and water_streak pools on each log action.
//              Oz pill is tappable to edit bottle size inline.
// Inputs:      useWaterStore (entries, bottleOz, goal, actions + selectors),
//              useMessageStore (setMessage, setShowBubble). No props.
// Outputs:     Panel content div (expected inside CompanionPanel's scroll area)
// -----------------------------------------------------------------------------

import { useState, useRef, useEffect } from 'react';
import { useWaterStore } from '../stores/useWaterStore';
import { useMessageStore } from '../stores/useMessageStore';

// ===== Message pools =====

const MSGS = {
  logged_first: [
    "first one of the day. here we go.",
    "starting strong.",
    "day's first bottle. the journey begins.",
    "bottle 1. a classic.",
  ],
  logged_simple: [
    "got it. {current} of {goal}.",
    "logged.",
    "bottle {current}. noted.",
    "{current} down, {remaining} to go.",
    "another one. {current}/{goal}.",
    "{totalOz} oz and counting.",
    "check.",
  ],
  logged_playful: [
    "glug glug glug.",
    "hydration station. {current}/{goal}.",
    "your cells thank you.",
    "water is just boneless soup.",
    "technically this is a chemistry experiment. you're the beaker.",
    "h two... oh yeah.",
    "splish splash, bottle {current}.",
    "liquid acquired.",
    "fun fact: you are now slightly more water than you were a minute ago.",
    "nice nice nice.",
    "{totalOz} oz. that's like... a small aquarium.",
    "the mitochondria is the powerhouse of the cell and water is the powerhouse of you.",
    "your kidneys just sent me a thank you card.",
    "hydrated and humble.",
    "water: the original zero-calorie drink.",
  ],
  logged_progress: [
    "ooh, {remaining} more and you've got it.",
    "almost there. just {remaining} to go.",
    "you can practically taste the goal. it tastes like water.",
    "{current} of {goal}. the finish line is right there.",
  ],
  logged_absurd: [
    "hydrate or diedrate motherfucker!",
    "you just drank water. in THIS economy.",
    "bold of you to be 60% water and still need more.",
    "imagine being a cactus. couldn't be you.",
    "water bottle goes brrr.",
    "somewhere a fish just felt a disturbance in the force.",
    "you: *drinks water* your organs: *standing ovation*",
    "water is just cloud juice if you think about it.",
    "the ancient romans had aqueducts. you have a bottle. same energy.",
    "congratulations you've unlocked: not being a raisin.",
    "plot twist: the water was inside you all along. literally.",
    "every time you drink water a tiny cell somewhere does a backflip.",
    "you're basically speedrunning hydration at this point.",
    "this water has more personality than most people i've met.",
    "the government doesn't want you to know this but the water in the lake is free.",
  ],
  logged_science: [
    "fun fact: your brain is 75% water. you just topped it off.",
    "water molecules in your body right now are older than the sun. you're drinking ancient stuff.",
    "hot water freezes faster than cold water sometimes. science doesn't know why. anyway, bottle {current}.",
    "the water you just drank might have been dinosaur pee at some point. the water cycle is wild.",
    "your blood is 90% water. you just gave it a raise.",
    "it takes about 5 minutes for water to reach your bloodstream. your cells are placing their orders now.",
    "fun fact: a 2% drop in hydration can cut your focus by 25%. you just bought yourself some brain power.",
    "water is the only natural substance found in all three states on earth. and now also in your stomach.",
    "the average human body contains enough water to fill a 10-gallon fish tank. you're getting there.",
    "each kidney filters about 50 gallons of blood a day. yours just got fresh supply.",
    "cold water absorbs into your body faster than warm water. science tip of the day.",
    "your body makes about 8 cups of saliva a day. it needs the raw materials. you're helping.",
    "there's the same amount of water on earth now as when the planet formed. this bottle is recycled from the jurassic.",
    "dehydration shrinks your brain tissue. you're literally plumping your brain right now.",
    "water carries electrical signals between your neurons. you just charged the battery.",
  ],
  logged_mindful: [
    "did you actually taste that one or just pour it into your face. try tasting the next one.",
    "hot take: water has a flavor and it's different in every room of your house.",
    "mindfulness exercise: the next sip, actually notice the temperature. weird how water can feel round, right?",
    "some water tastes pointy and some water tastes round and if you disagree you're not paying attention.",
    "you ever just... hold the water in your mouth for a sec? it's a whole experience.",
    "rate this bottle's water out of 10. no i'm serious. develop opinions about water.",
    "connoisseurs say this bottle has notes of hydrogen with a subtle oxygen finish.",
    "cold water at 3 AM hits different and science has never adequately explained why.",
  ],
  goal_met: [
    "{goal} of {goal}! goal crushed.",
    "you did it. {totalOz} oz. your body is a well-oiled, well-watered machine.",
    "goal: met. kidneys: thriving. glim: proud.",
    "that's {goal}! officially hydrated.",
    "{totalOz} oz today. you're basically a lake.",
    "ring's full. you're full. everyone's full.",
    "daily water goal: demolished.",
    "{goal} bottles. textbook hydration.",
    "ding ding ding! {goal} of {goal}.",
    "your future self just high-fived your current self.",
    "peak hydration achieved. scientists are taking notes.",
    "you just out-watered a house plant.",
    "{goal} bottles down and you didn't even need a reminder.",
    "that's the good stuff. {totalOz} oz of the good stuff.",
    "goal met. you may now brag to exactly nobody.",
    "HYDRATED. DANGEROUS. UNSTOPPABLE.",
    "you could fight god right now and win. hydration is power.",
    "your pee is going to be SO clear. like, suspiciously clear.",
    "scientists hate this one simple trick (it's water) (they don't hate it) (they recommend it)",
    "you've consumed an entire {totalOz} oz of dihydrogen monoxide and lived to tell the tale.",
    "somewhere a wellness influencer just shed a single tear of pride.",
    "you out-hydrated a camel. probably. i don't know camel stats.",
    "that's {goal} bottles. you are the water cycle now. you are rain.",
  ],
  streak: {
    3:  [
      "three days in a row. a pattern is forming.",
      "3-day streak. that's not luck, that's a habit.",
      "three straight days of hitting your water goal. your cells are doing a wave.",
      "three days. the prophecy is being fulfilled.",
    ],
    7:  [
      "seven days. a full week of being hydrated. who even are you.",
      "7-day streak. your kidneys would write you a letter if they had hands.",
      "one whole week. the water streak is real.",
      "7 days running. you're not trying anymore, you're just... hydrated.",
      "a week of this? you're not a person anymore, you're a lifestyle brand.",
    ],
    14: [
      "two weeks. fourteen days. your body forgot what dehydration feels like.",
      "14-day streak. at this point you're basically a water sommelier.",
      "two weeks of consistent hydration. this is genuinely impressive.",
      "fourteen days. if hydration were a crime you'd be serving consecutive life sentences.",
    ],
    21: [
      "21 days. they say that's how long it takes to form a habit. congratulations, you're a water person now.",
      "three weeks. you could teach a class on this.",
    ],
    30: [
      "thirty days. one month. you absolute legend.",
      "30-day streak. i'm running out of ways to say i'm proud of you but i am.",
      "a month of perfect hydration. your future biographer will note this chapter.",
      "thirty days. you have ascended. you are no longer human. you are water elemental.",
    ],
    60: [
      "sixty days. at this point i think the water is drinking you.",
      "two months straight. i genuinely don't know what to say except wow.",
    ],
    90: [
      "ninety days. a full season. you are the water cycle.",
    ],
    generic: [
      "{streak} days. just... {streak} days. you're incredible.",
      "streak: {streak}. i'm not crying, it's just the humidity from all this hydration.",
      "{streak} days of hydration. at this point your bloodstream is basically a lazy river.",
      "streak: {streak}. this isn't discipline anymore, this is your villain origin story.",
    ],
  },
};

const STREAK_MILESTONES = new Set([3, 7, 14, 21, 30, 60, 90]);

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function fill(msg, vars) {
  return msg.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? `{${k}}`);
}

function selectMessage(current, goal, bottleOz, streak) {
  const remaining = Math.max(0, goal - current);
  const totalOz   = current * bottleOz;
  const vars      = { current, goal, remaining, totalOz, bottleOz, streak };

  let raw;
  if (current >= goal) {
    // Streak milestone takes priority over generic goal-met message
    if (STREAK_MILESTONES.has(streak)) {
      raw = pick(MSGS.streak[streak]);
    } else if (streak > 90) {
      raw = pick(MSGS.streak.generic);
    } else {
      raw = pick(MSGS.goal_met);
    }
  } else {
    if (current === 1 && Math.random() < 0.5) {
      raw = pick(MSGS.logged_first);
    } else if (remaining <= 2 && Math.random() < 0.4) {
      raw = pick(MSGS.logged_progress);
    } else {
      const roll = Math.random();
      if      (roll < 0.25) raw = pick(MSGS.logged_simple);
      else if (roll < 0.50) raw = pick(MSGS.logged_playful);
      else if (roll < 0.65) raw = pick(MSGS.logged_absurd);
      else if (roll < 0.82) raw = pick(MSGS.logged_science);
      else                  raw = pick(MSGS.logged_mindful);
    }
  }

  return fill(raw, vars);
}

// ===== Component =====

// Ring constants (viewBox 0 0 72 72, radius 30)
const RING_R    = 30;
const RING_CIRC = 2 * Math.PI * RING_R; // ~188.5, rounds to 188 in mockup

export default function WaterPanel() {
  const {
    bottleOz, goal,
    logBottle, undoLast, setBottleOz,
    getToday, getStreak, getWeeklyAvg,
  } = useWaterStore();

  const { setMessage, setShowBubble } = useMessageStore();

  const [showUndo,   setShowUndo]   = useState(false);
  const [editingOz,  setEditingOz]  = useState(false);
  const [ozDraft,    setOzDraft]    = useState('');
  const undoTimerRef  = useRef(null);
  const bubbleTimerRef = useRef(null);

  // Derive display state from store
  const current    = getToday();
  const streak     = getStreak();
  const weeklyAvg  = getWeeklyAvg();
  const goalMet    = current >= goal;
  const filled     = Math.min((current / Math.max(goal, 1)) * RING_CIRC, RING_CIRC);

  const accent       = goalMet ? '#4ade80' : '#60a5fa';
  const accentBg     = goalMet ? 'rgba(74,222,128,0.12)'  : 'rgba(96,165,250,0.15)';
  const accentBorder = goalMet ? 'rgba(74,222,128,0.3)'   : 'rgba(96,165,250,0.3)';

  // Clear timers on unmount
  useEffect(() => () => {
    clearTimeout(undoTimerRef.current);
    clearTimeout(bubbleTimerRef.current);
  }, []);

  const handleLog = () => {
    logBottle();
    // current is from last render; compute new values manually
    const newCurrent = current + 1;
    // getStreak() reads from store's get() which reflects the just-applied set()
    const newStreak  = newCurrent >= goal ? getStreak() : streak;
    const msg        = selectMessage(newCurrent, goal, bottleOz, newStreak);

    setMessage(msg);
    setShowBubble(true);
    clearTimeout(bubbleTimerRef.current);
    bubbleTimerRef.current = setTimeout(() => setShowBubble(false), 5000);

    clearTimeout(undoTimerRef.current);
    setShowUndo(true);
    undoTimerRef.current = setTimeout(() => setShowUndo(false), 4000);
  };

  const handleUndo = () => {
    clearTimeout(undoTimerRef.current);
    setShowUndo(false);
    undoLast();
  };

  const commitOz = () => {
    const v = parseInt(ozDraft, 10);
    if (!isNaN(v) && v > 0 && v <= 999) setBottleOz(v);
    setEditingOz(false);
  };

  // ===== Render =====

  const mono = { fontFamily: "'Courier New', monospace" };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', padding: '0 24px 16px' }}>

      {/* Header: label + oz pill */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <span style={{ ...mono, fontSize: 'var(--glim-text-sm)', color: 'rgba(200,210,230,0.35)', letterSpacing: '0.5px' }}>
          water
        </span>

        {editingOz ? (
          <input
            autoFocus
            type="text"
            inputMode="numeric"
            value={ozDraft}
            onChange={e => setOzDraft(e.target.value)}
            onBlur={commitOz}
            onKeyDown={e => {
              if (e.key === 'Enter')  commitOz();
              if (e.key === 'Escape') setEditingOz(false);
            }}
            style={{
              width: 60, textAlign: 'center',
              ...mono, fontSize: 'var(--glim-text-lg)',
              color: accent, background: accentBg,
              border: `1px solid ${accentBorder}`, borderRadius: 8,
              padding: '3px 6px', outline: 'none',
            }}
          />
        ) : (
          <button
            onClick={() => { setOzDraft(String(bottleOz)); setEditingOz(true); }}
            className="glim-tap-down"
            style={{
              // Down-anchored: this pill sits at the top of the panel's
              // clipping container, so a centred overlay is cut off above and
              // the reachable height stops at 37px. zIndex lifts it above the
              // panel header, which otherwise paints over the overlay.
              position: 'relative', zIndex: 1,
              ...mono, fontSize: 'var(--glim-text-sm)', letterSpacing: '0.5px',
              color: accent, background: accentBg,
              border: `1px solid ${accentBorder}`, borderRadius: 8,
              padding: '3px 10px', cursor: 'pointer',
            }}
          >
            {bottleOz} oz
          </button>
        )}
      </div>

      {/* Ring + action area */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 18 }}>

        {/* Progress ring */}
        <svg viewBox="0 0 72 72" width="100" height="100" style={{ overflow: 'visible' }}>
          {/* Track ring */}
          <circle
            cx="36" cy="36" r={RING_R}
            fill="none"
            stroke="rgba(255,255,255,0.07)"
            strokeWidth="3.5"
          />
          {/* Progress ring */}
          <circle
            cx="36" cy="36" r={RING_R}
            fill="none"
            stroke={accent}
            strokeWidth="3.5"
            strokeLinecap="round"
            strokeDasharray={`${filled.toFixed(1)} ${RING_CIRC.toFixed(1)}`}
            transform="rotate(-90 36 36)"
            style={{ transition: 'stroke-dasharray 0.4s ease, stroke 0.4s ease' }}
          />
          {/* Center content */}
          {goalMet ? (
            // Checkmark (path from 24x24 viewBox scaled to fit, centered at 36,36)
            <g transform="translate(24,24)">
              <path
                d="M6 12l4 4 8-8"
                fill="none"
                stroke={accent}
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ transition: 'stroke 0.4s ease' }}
              />
            </g>
          ) : (
            <>
              <text
                x="36" y="33"
                textAnchor="middle"
                dominantBaseline="middle"
                fill="rgba(255,255,255,0.85)"
                style={{ ...mono, fontSize: 'var(--glim-text-xs)', fontWeight: 'bold' }}
              >
                {current}
              </text>
              <line x1="29" y1="36.5" x2="43" y2="36.5" stroke="rgba(255,255,255,0.15)" strokeWidth="0.8" />
              <text
                x="36" y="40"
                textAnchor="middle"
                dominantBaseline="middle"
                fill="rgba(255,255,255,0.3)"
                style={{ ...mono, fontSize: 'var(--glim-text-2xs)' }}
              >
                {goal}
              </text>
            </>
          )}
        </svg>

        {/* + button (always in DOM) */}
        <button
          onClick={handleLog}
          className="glim-tap"
          style={{
            position: 'relative',
            display: 'flex', alignItems: 'center', gap: 6,
            background: accentBg,
            border: `1px solid ${accentBorder}`,
            borderRadius: 12, padding: '8px 20px',
            cursor: 'pointer',
            ...mono, fontSize: 'var(--glim-text-xs)', color: accent,
            transition: 'background 0.3s ease, border-color 0.3s ease, color 0.3s ease',
          }}
        >
          <span style={{ fontSize: 'var(--glim-text-md)', lineHeight: 1, marginRight: 2 }}>+</span>
          bottle
        </button>
      </div>

      {/* Undo toast (own row, appears below button row) */}
      {showUndo && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12,
          background: 'rgba(96,165,250,0.08)',
          border: '1px solid rgba(96,165,250,0.18)',
          borderRadius: 10, padding: '6px 14px',
          marginTop: 6,
        }}>
          <span style={{ ...mono, fontSize: 'var(--glim-text-2xs)', color: 'rgba(200,210,230,0.5)' }}>
            logged 1 bottle
          </span>
          <button
            onClick={handleUndo}
            style={{
              ...mono, fontSize: 'var(--glim-text-2xs)', color: '#60a5fa',
              background: 'none', border: 'none', cursor: 'pointer', padding: 0,
            }}
          >
            undo
          </button>
        </div>
      )}

      {/* Footer: streak | 7-day avg */}
      <div style={{
        display: 'flex', justifyContent: 'space-between',
        ...mono, fontSize: 'var(--glim-text-sm)', letterSpacing: '0.5px',
        color: 'rgba(200,210,230,0.35)',
        paddingTop: 10,
      }}>
        <span>{streak > 0 ? `${streak}d streak` : 'no streak yet'}</span>
        <span>avg {weeklyAvg}/day</span>
      </div>
    </div>
  );
}
