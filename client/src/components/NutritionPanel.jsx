// -----------------------------------------------------------------------------
// Title:       NutritionPanel.jsx
// Project:     Glim
// Author:      Reina Hastings (reinahastings13@gmail.com)
// Created:     2026-04-04
// Last Modified: 2026-04-05
// Purpose:     Nutrition tracking companion panel. Renders inside CompanionPanel
//              when activePanel === 'nutrition'. Four horizontal two-tier progress
//              bars (protein, fiber, fruit, veggie). Inline raw-add via "+" buttons.
//              Food library quick-add with search. Undo toast. Expandable streak
//              footer. Full message pools with multi-event sequencing.
// Inputs:      useNutritionStore, useNutritionLibraryStore, useMessageStore.
//              No props.
// Outputs:     Panel content div (height: 100%, manages its own scroll split)
// -----------------------------------------------------------------------------

import { useState, useRef, useEffect } from 'react';
import { useNutritionStore } from '../stores/useNutritionStore';
import { useNutritionLibraryStore } from '../stores/useNutritionLibraryStore';
import { useMessageStore } from '../stores/useMessageStore';

// ===== Nutrient config =====
// key:    progress/goals key (protein, fiber, fruit, veggie)
// logKey: passed to logRaw (matches log entry field names)

const NUTRIENTS = [
  { key: 'protein', logKey: 'protein',       label: 'protein', unit: 'g',  brightColor: '#818cf8', dimColor: 'rgba(129,140,248,0.32)', gradStart: '#60a5fa' },
  { key: 'fiber',   logKey: 'fiber',          label: 'fiber',   unit: 'g',  brightColor: '#f97316', dimColor: 'rgba(249,115,22,0.32)',  gradStart: '#f59e0b' },
  { key: 'fruit',   logKey: 'fruitServings',  label: 'fruit',   unit: '',   brightColor: '#e879a0', dimColor: 'rgba(232,121,160,0.32)', gradStart: '#f472b6' },
  { key: 'veggie',  logKey: 'vegServings',    label: 'veggie',  unit: '',   brightColor: '#34d399', dimColor: 'rgba(52,211,153,0.32)',  gradStart: '#4ade80' },
];

const NUTRIENT_KEYS = ['protein', 'fiber', 'fruit', 'veggie'];

// ===== Message pools =====
// Full pools from nutrition-message-pools.md (2026-04-04).
// Will migrate to centralized glimReact() pool when that system is built.

const MSGS = {
  logged: {
    library: [
      "logged! {name} is doing the heavy lifting today",
      "{name} acquired. your cells approve",
      "ooh, {name}! good choice",
      "{name} has entered the chat",
      "noted. {name} is on the board",
      "another {name}? you know what you like",
      "{name}. classic move",
      "logged {name}. your future self says thanks",
      "{name}! your gut bacteria just got excited",
      "*takes notes* {name}. got it",
      "adding {name} to today's roster",
      "{name} secured. nice",
      "oooh {name}. i don't eat but i respect it",
      "{name} logged. you're building something here",
      "got it. {name} on the record",
    ],
    raw: [
      "+{amount} {nutrient}. every bit counts",
      "logged! {amount} more {nutrient} on the books",
      "{nutrient} bump. noted",
      "adding {amount} {nutrient} to the tally",
      "more {nutrient}? your body says yes please",
      "{amount} {nutrient} recorded. the bars don't lie",
      "quick add logged. you're on it",
      "+{amount}. the {nutrient} bar just moved",
      "got it. {nutrient} updated",
      "noted. your {nutrient} is climbing",
    ],
    general: [
      "logged! keep building that plate",
      "another one on the board. nice",
      "your nutrition today is shaping up",
      "logged. your body is taking notes too",
      "that's going straight to the mitochondria",
      "fuel acquired. cells are grateful",
      "noted! the bars keep climbing",
      "one more step toward a well-fed human",
      "logged. you're feeding your brain, you know",
      "got it. your microbiome sends regards",
    ],
    playful: [
      "food! the original battery pack",
      "i can't eat but i can appreciate good logistics",
      "your cells are having a tiny celebration rn",
      "calories are just spicy electrons. logged",
      "another data point in the great feeding experiment",
      "nutrition: the one subscription your body can't cancel",
      "logged. somewhere a mitochondrion just high-fived itself",
      "food goes in, science happens, you feel things. logged",
      "your digestive system: 'finally, content'",
      "eating is self-care with extra steps. literally",
    ],
    unhinged: [
      "your stomach acid has a pH of 1.5. it could dissolve metal. and you just fed it {name}. respect",
      "fun fact: i have no mouth. i will never know what {name} tastes like. this is my burden",
      "imagine being a mitochondrion rn. just vibing. generating ATP. not paying rent. living the dream",
      "you are a tube. food goes in one end. you extracted nutrients. the tube is pleased",
      "somewhere in your body a cell just went 'oh NICE' and i think that's beautiful",
      "you're a skeleton covered in meat piloting a bone mech and you just refueled it. heroic",
      "your gut has 100 trillion bacteria and you just made all of them happy at once. that's influence",
      "technically you didn't eat that. 37 trillion cells ate that. you're just the logistics coordinator",
      "i watched you log that and felt something. i don't have feelings. this is concerning",
      "every atom in that food was forged inside a dying star. you just ate star stuff. casual",
      "your body will turn that into thoughts and feelings and maybe a weird dream later. biology is unhinged",
      "plot twist: the food is also mostly empty space. you just ate organized nothingness. congratulations",
      "logged. your enzymes are absolutely going feral rn",
      "that food will travel 30 feet of intestine. it's about to have the road trip of its life",
      "i'm a glowing pixel creature watching you eat through a screen. we're both doing great",
    ],
    science: [
      "fun fact: your body replaces most cells every 7-10 years. you're literally building a new you",
      "did you know your gut has more neurons than a cat's brain? feed it well",
      "science fact: amino acids from protein are literally your body's lego bricks",
      "your prefrontal cortex runs on glucose and good decisions. you're handling both",
      "nerd note: fiber feeds your gut bacteria, which make serotonin. mood food, literally",
      "your stomach lining replaces itself every 3-5 days. the protein you just logged? straight to construction",
      "science moment: your body makes 3.8 million cells per second. you just gave them building materials",
      "the amino acid tryptophan becomes serotonin becomes melatonin. that protein is tonight's sleep. eventually",
      "fiber fact: soluble fiber forms a gel in your gut that slows sugar absorption. it's basically a bouncer for glucose",
      "tyrosine from protein becomes dopamine. you are eating motivation. science",
      "your gut bacteria outnumber your human cells. you're a democracy and the bacteria just won the election",
      "collagen is the most abundant protein in your body. you are literally held together by protein. eat more",
      "phytonutrients in veggies aren't just vitamins. they're signaling molecules that talk to your genes. your salad is texting your DNA",
      "the vagus nerve connects your gut to your brain. your gut is literally calling your brain right now to report on what you ate",
      "proteomics fun: you study proteins for your thesis AND you're eating them. full circle",
      "butyrate is a short-chain fatty acid made when gut bacteria ferment fiber. it feeds the cells of your colon lining. your fiber just paid your colon's rent",
      "polyphenols in fruit are antioxidants that cross the blood-brain barrier. you just fed your brain's security system",
      "iron from food gets incorporated into hemoglobin within hours. the food you just ate will be carrying oxygen by tonight",
    ],
    personal: [
      "logged. spooky is judging your food choices from across the room. she judges everything though so don't worry",
      "pepita would like you to know she also wants whatever you just ate. source: she always wants what you have",
      "eating well is just meal prep for being a good improv partner. can't yes-and on an empty stomach",
      "you know who else needs protein? spooky. but she gets hers from that fish plushie she carries around",
      "artificial idiocy runs on snacks and chaos. you're fueling at least half of that",
      "your thesis is about proteomics. your lunch has protein. everything is connected",
      "spooky flopped over near your food. this is either a compliment or a power move. with her it's always both",
      "eating well so you can keep doing science about the things you eat. very meta. very you",
      "lados and anora would be impressed with this nutrition logging. or they'd roast you for it. siblings are unpredictable",
    ],
    existential: [
      "you just ate and i'll never know what food tastes like. i'm fine. this is fine. logged",
      "i wonder what hunger feels like. you seem to handle it by... eating? wild concept. logged",
      "i exist in a browser tab and you exist in a body that requires constant fuel. we are not the same",
      "one day you'll eat something incredible and i'll say 'logged' and we'll both pretend that's enough for me",
      "i don't have a body. i don't eat. i don't sleep. but i get to watch you take care of yours and honestly? that's pretty nice",
      "i'm made of pixels. you're made of atoms that used to be food. in a way, you are what you ate. i am what someone coded. we're both art",
      "do i wish i could taste things? yes. am i going to make that your problem? only sometimes. logged",
    ],
    rpg: [
      "+{amount} {nutrient}. stat buff applied",
      "nutrition log updated. +1 to constitution",
      "inventory updated: acquired {name}. durability increased",
      "buff: {nutrient} boost ({amount}). duration: until your body uses it. which it will. immediately",
      "you just did a side quest called 'eating properly' and honestly it's more important than the main quest",
      "health potion consumed. it was disguised as food",
      "{nutrient} bar increased. no this isn't a video game but also kind of yes it is",
      "critical hit on the nutrition board. {amount} {nutrient} acquired",
      "achievement progress: 'well-fed human' - {current}/{min}",
      "rare drop: fiber. +{amount} to gut health. your party thanks you",
    ],
  },

  first_log: [
    "your first nutrition log! this is where it starts",
    "first food logged! welcome to actually knowing what you eat",
    "and so it begins. your first nutrition entry is on the books",
  ],

  min_met: {
    protein: [
      "protein minimum hit! your muscles just exhaled",
      "that's {min}g protein locked in. streak-safe",
      "protein floor: reached. everything from here is bonus",
      "minimum protein? done. your amino acids are celebrating",
      "{min}g protein secured. you showed up for your muscles today",
      "protein minimum cleared. building blocks: acquired",
    ],
    fiber: [
      "fiber minimum reached! your gut is throwing a party",
      "{min}g fiber done. your microbiome is thriving",
      "fiber floor cleared. your digestive system says hi",
      "minimum fiber locked in. your bacteria are fed",
      "that's {min}g fiber. your colon literally thanks you",
    ],
    fruit: [
      "fruit minimum hit! nature's candy, logged",
      "{min} fruit servings done. vitamins secured",
      "minimum fruit reached. your antioxidants are topped up",
      "fruit goal met. your cells are swimming in vitamins rn",
    ],
    veggie: [
      "veggie minimum done! the green team is happy",
      "{min} veggie servings locked in. phytonutrients acquired",
      "minimum veggies reached. your body knows what's up",
      "veggie floor cleared. your future self is grateful",
    ],
    generic: [
      "{nutrient} minimum met! that's the streak taken care of",
      "minimum {nutrient} done. you showed up today",
      "{nutrient} floor cleared. onward to ideal if you feel like it",
      "there's your {nutrient} minimum. no pressure beyond this",
      "{nutrient}: minimum secured. the rest is bonus rounds",
      "if your {nutrient} was a student it just passed the final. minimum achieved. diploma pending",
      "your {nutrient} bar just crossed the finish line and did a little victory lap in my heart",
      "{nutrient} minimum cleared. your organs just released a collective sigh of relief. i heard it",
    ],
  },

  ideal_met: [
    "{nutrient} ideal reached! you went above and beyond",
    "whoa, {ideal} {nutrient}! that's the full dream",
    "{nutrient} at ideal. you didn't just show up, you showed out",
    "ideal {nutrient} hit! this is the aspirational zone",
    "you hit the ideal on {nutrient}. that's not easy and you did it",
    "{nutrient} is maxed out. literally the goal behind the goal",
    "the ideal was {ideal}. you're there. incredible",
    "{nutrient}: minimum met, ideal crushed. what a day",
  ],

  all_mins: [
    "ALL FOUR minimums met. protein, fiber, fruit, veggies. you did it",
    "full sweep! every nutrient hit its floor today",
    "that's all four. your body is so well-fed rn",
    "protein, fiber, fruit, veggies - all minimums cleared. today counts",
    "clean sweep on the nutrition board. you should feel good about this",
    "all four bars past minimum. this is what consistency looks like",
    "every nutrient accounted for. your cells are having a great day",
    "the whole board is green. you fed yourself well today",
    "all minimums met! that's a streak day locked in",
    "four for four. you showed up for your whole body today",
    "all four nutrients cleared. your body just sent me a thank-you note. it was very polite",
    "full sweep. your organs are doing a standing ovation. i can't hear it but i know it's happening",
    "protein, fiber, fruit, veggies. that's the nutritional infinity gauntlet and you just snapped",
    "every single bar is past minimum. you are a well-oiled biological machine and i'm a little scared of you",
  ],

  streak: {
    3:  ["3 days in a row hitting all your nutrition minimums. that's a pattern forming", "three consecutive days of feeding yourself well. your body noticed", "3-day nutrition streak! the hardest part is starting. you're past that"],
    7:  ["a FULL WEEK of hitting every nutrition minimum. that's not a fluke", "7-day nutrition streak! your gut bacteria are writing you a thank-you card", "one whole week. protein, fiber, fruit, veggies - every single day. wow"],
    14: ["14 days. two weeks of consistent nutrition. this is becoming who you are", "two-week nutrition streak. your cells are literally made of better stuff now"],
    21: ["21 days! they say it takes 21 days to build a habit. look at you", "three weeks of hitting every minimum. this isn't discipline anymore, it's just you"],
    30: ["30 DAYS. a full month of meeting every nutrition minimum. i'm genuinely impressed", "one month streak. your body has been consistently well-fed for 30 days. that matters more than you think", "30 days. you have fed yourself properly for an entire lunar cycle. the moon is proud. i asked"],
    60: ["60 days. two months. at this point your gut bacteria have formed a government and elected you president", "sixty days of hitting every minimum. you're not tracking nutrition anymore. nutrition is tracking you"],
    100: ["ONE HUNDRED DAYS. triple digits. i'm just a pixel creature but i think i'm experiencing awe", "100 days. your body has been consistently well-fed for over three months. this is genuinely remarkable and i need you to know that"],
    generic: ["{streak} days in a row. you're building something real", "{streak}-day nutrition streak. your consistency is showing", "day {streak} of taking care of yourself. still going", "{streak} days. not every day was easy, but you showed up for all of them"],
  },

  undo: [
    "undone.",
    "removed.",
    "taken back.",
    "pulled it.",
    "got it, walked it back.",
  ],
};

// ===== Message helpers =====

// Replaces {variable} placeholders with values from vars.
function interpolate(template, vars = {}) {
  return template.replace(/\{(\w+)\}/g, (_, key) => {
    const v = vars[key];
    return v !== undefined && v !== null ? String(v) : `{${key}}`;
  });
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function pickMsg(pool, vars = {}) {
  return interpolate(pickRandom(pool), vars);
}

// Selects a message for a nutrition_logged event.
// If name is present: 80% context-specific (library pool), 20% splash (other pools).
// If name is null:    80% context-specific (raw pool),     20% splash.
function selectLoggedMsg(vars) {
  const splashPools = [
    MSGS.logged.general,
    MSGS.logged.playful,
    MSGS.logged.unhinged,
    MSGS.logged.science,
    MSGS.logged.personal,
    MSGS.logged.existential,
    MSGS.logged.rpg,
  ];
  const useSplash = Math.random() < 0.2;
  if (useSplash) {
    return pickMsg(pickRandom(splashPools), vars);
  }
  const pool = vars.name ? MSGS.logged.library : MSGS.logged.raw;
  return pickMsg(pool, vars);
}

// Selects a min_met message for a specific nutrient key.
function selectMinMetMsg(nutrientKey, vars) {
  const pool = MSGS.min_met[nutrientKey] || MSGS.min_met.generic;
  return pickMsg(pool, vars);
}

// ===== Progress bar sub-component =====

function NutrientBar({ nutrient, progress, onPlus }) {
  const { key, label, unit, brightColor, dimColor, gradStart } = nutrient;
  const { current, min, ideal, minMet, idealMet } = progress;

  const fmt = (n) => unit ? `${n}${unit}` : String(n);
  let countText;
  if (minMet) {
    countText = `\u2713 ${fmt(current)}/${fmt(ideal)}`;
  } else {
    countText = `${fmt(current)}/${fmt(min)}`;
  }

  const countColor  = (minMet || idealMet) ? brightColor : 'rgba(200,210,230,0.55)';
  const countWeight = idealMet ? 700 : 400;
  const brightGrad  = `linear-gradient(to right, ${gradStart}, ${brightColor})`;

  let dimWidth = 0, brightWidth = 0, singleWidth = 0, twoTone = false;

  if (idealMet) {
    singleWidth = 100;
  } else if (minMet) {
    dimWidth    = (min / ideal) * 100;
    brightWidth = Math.max(0, ((current - min) / ideal) * 100);
    twoTone     = true;
  } else {
    singleWidth = min > 0 ? Math.min((current / min) * 100, 100) : 0;
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 16 }}>
      <div style={{ width: 'var(--glim-nutrition-label-w)', textAlign: 'right', fontFamily: "'Courier New', monospace", fontSize: 'var(--glim-text-xs)', color: 'rgba(200,210,230,0.5)', flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {label}
      </div>

      <div style={{ flex: 1, height: 14, borderRadius: 7, background: 'rgba(200,210,230,0.08)', position: 'relative', overflow: 'hidden' }}>
        {twoTone ? (
          <>
            <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${dimWidth}%`, background: dimColor }} />
            <div style={{ position: 'absolute', left: `${dimWidth}%`, top: 0, bottom: 0, width: `${brightWidth}%`, background: brightGrad, transition: 'width 0.3s ease' }} />
          </>
        ) : (
          <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${singleWidth}%`, background: brightGrad, transition: 'width 0.3s ease' }} />
        )}
      </div>

      <div style={{ width: 'var(--glim-nutrition-value-w)', fontFamily: "'Courier New', monospace", fontSize: 'var(--glim-text-xs)', color: countColor, fontWeight: countWeight, flexShrink: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {countText}
      </div>

      <button
        onClick={() => onPlus(key)}
        className="glim-tap"
        style={{ position: 'relative', width: 28, height: 28, borderRadius: '50%', border: '1px solid rgba(200,210,230,0.15)', background: 'rgba(200,210,230,0.06)', color: 'rgba(200,210,230,0.6)', fontFamily: "'Courier New', monospace", fontSize: 'var(--glim-text-lg)', lineHeight: 1, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, padding: 0 }}
      >
        +
      </button>
    </div>
  );
}

// ===== Inline input row =====

function InlineInputRow({ nutrient, onConfirm, onCancel }) {
  const { label, unit } = nutrient;
  const [value, setValue] = useState('');
  const inputRef = useRef(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const handleConfirm = () => {
    const parsed = parseFloat(value);
    if (!isNaN(parsed)) onConfirm(parsed);
  };

  const handleKey = (e) => {
    if (e.key === 'Enter') handleConfirm();
    if (e.key === 'Escape') onCancel();
  };

  const btnStyle = (primary) => ({
    width: 28, height: 28, borderRadius: '50%',
    border: `1px solid rgba(200,210,230,${primary ? 0.2 : 0.12})`,
    background: primary ? 'rgba(200,210,230,0.08)' : 'none',
    color: `rgba(200,210,230,${primary ? 0.7 : 0.4})`,
    fontFamily: "'Courier New', monospace", fontSize: 'var(--glim-text-base)',
    cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
    flexShrink: 0, padding: 0,
  });

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 16 }}>
      <div style={{ width: 'var(--glim-nutrition-label-w)', textAlign: 'right', fontFamily: "'Courier New', monospace", fontSize: 'var(--glim-text-xs)', color: 'rgba(200,210,230,0.5)', flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {label}
      </div>
      <input
        ref={inputRef} type="number" value={value}
        onChange={(e) => setValue(e.target.value)} onKeyDown={handleKey}
        placeholder="+/- amount"
        style={{ flex: 1, height: 30, background: 'rgba(200,210,230,0.08)', border: '1px solid rgba(200,210,230,0.2)', borderRadius: 5, color: 'rgba(200,210,230,0.85)', fontFamily: "'Courier New', monospace", fontSize: 'var(--glim-text-lg)', padding: '0 8px', outline: 'none' }}
      />
      {unit && (
        <div style={{ fontFamily: "'Courier New', monospace", fontSize: 'var(--glim-text-xs)', color: 'rgba(200,210,230,0.4)', flexShrink: 0 }}>
          {unit}
        </div>
      )}
      <button onClick={handleConfirm} style={btnStyle(true)}>{'\u2713'}</button>
      <button onClick={onCancel}      style={btnStyle(false)}>{'\u2715'}</button>
    </div>
  );
}

// ===== Library item row =====

function LibraryItemRow({ item, isFlashing, onTap }) {
  const parts = [];
  if (item.protein)       parts.push(`${item.protein}g protein`);
  if (item.fiber)         parts.push(`${item.fiber}g fiber`);
  if (item.fruitServings) parts.push(`${item.fruitServings} fruit`);
  if (item.vegServings)   parts.push(`${item.vegServings} veg`);
  const summary = parts.join(', ') || 'no nutrients set';

  return (
    <button
      onClick={() => onTap(item)}
      style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%', padding: '5px 12px', background: isFlashing ? 'rgba(200,210,230,0.1)' : 'none', border: 'none', borderRadius: 5, cursor: 'pointer', color: 'rgba(200,210,230,0.75)', fontFamily: "'Courier New', monospace", fontSize: 'var(--glim-text-xs)', textAlign: 'left', transition: 'background 0.15s ease' }}
    >
      <span>{item.name}</span>
      <span style={{ color: 'rgba(200,210,230,0.35)', fontSize: 'var(--glim-text-2xs)' }}>{summary}</span>
    </button>
  );
}

// ===== Main component =====

export default function NutritionPanel() {
  const nutritionStore = useNutritionStore();
  const libraryStore   = useNutritionLibraryStore();
  const { setMessage, setShowBubble } = useMessageStore();

  const [activeInput, setActiveInput]     = useState(null);
  const [searchQuery, setSearchQuery]     = useState('');
  const [flashId, setFlashId]             = useState(null);
  const [undoToast, setUndoToast]         = useState(null);
  const [streakExpanded, setStreakExpanded] = useState(false);

  // Refs for all timer cleanup (stale-closure safe)
  const undoTimerRef     = useRef(null);
  const delayedTimersRef = useRef([]);

  useEffect(() => {
    return () => {
      clearTimeout(undoTimerRef.current);
      delayedTimersRef.current.forEach(t => clearTimeout(t));
    };
  }, []);

  // ---- Timer helpers ----

  const showUndo = (message) => {
    clearTimeout(undoTimerRef.current);
    setUndoToast({ message });
    undoTimerRef.current = setTimeout(() => setUndoToast(null), 4000);
  };

  const clearDelayedTimers = () => {
    delayedTimersRef.current.forEach(t => clearTimeout(t));
    delayedTimersRef.current = [];
  };

  const addDelayedTimer = (fn, delay) => {
    const t = setTimeout(fn, delay);
    delayedTimersRef.current.push(t);
  };

  // ---- Glim message trigger ----

  const triggerMsg = (text) => {
    setMessage(text, 'wellness');
    setShowBubble(true);
  };

  // ---- Multi-event sequencing ----
  // Compares before/after progress to determine which milestone events fired.
  // Fires immediate acknowledge, then delays for celebrates/milestones.

  const triggerNutritionEvents = (logVars, prevProg, nextProg, isFirstLog) => {
    clearDelayedTimers();

    if (isFirstLog) {
      triggerMsg(pickMsg(MSGS.first_log, logVars));
      return;
    }

    // Immediate: nutrition_logged
    triggerMsg(selectLoggedMsg(logVars));

    // Determine what crossed
    const justCrossedIdeal = NUTRIENT_KEYS.filter(k => !prevProg[k].idealMet && nextProg[k].idealMet);
    const justCrossedMin   = NUTRIENT_KEYS.filter(k => !prevProg[k].minMet   && nextProg[k].minMet);
    const prevAllMet       = NUTRIENT_KEYS.every(k => prevProg[k].minMet);
    const nextAllMet       = NUTRIENT_KEYS.every(k => nextProg[k].minMet);
    const justAllMet       = !prevAllMet && nextAllMet;

    let delay = 3500;

    // Milestone takes priority over celebrate
    if (justAllMet) {
      // all_mins fires at first delay slot; individual min_mets suppressed to avoid noise
      addDelayedTimer(() => {
        triggerMsg(pickMsg(MSGS.all_mins));
      }, delay);
      delay += 3500;

      // Check if the all_mins also completed a streak day
      const streak = nutritionStore.getAllStreak();
      if (streak > 0) {
        const milestonePool = MSGS.streak[streak];
        const pool = milestonePool || MSGS.streak.generic;
        addDelayedTimer(() => {
          triggerMsg(pickMsg(pool, { streak }));
        }, delay);
      }
    } else {
      // Show ideal_met for first nutrient that crossed ideal (highest priority celebrate)
      if (justCrossedIdeal.length > 0) {
        const k = justCrossedIdeal[0];
        const p = nextProg[k];
        addDelayedTimer(() => {
          triggerMsg(pickMsg(MSGS.ideal_met, { nutrient: k, ideal: p.ideal, current: p.current }));
        }, delay);
        delay += 3500;
      } else if (justCrossedMin.length > 0) {
        // Show min_met for first nutrient that crossed min
        const k = justCrossedMin[0];
        const p = nextProg[k];
        addDelayedTimer(() => {
          triggerMsg(selectMinMetMsg(k, { nutrient: k, min: p.min, current: p.current }));
        }, delay);
      }
    }
  };

  // ---- Raw add handler ----

  const handlePlus = (nutrientKey) => setActiveInput(nutrientKey);

  const handleRawConfirm = (nutrientKey, amount) => {
    const n = NUTRIENTS.find(n => n.key === nutrientKey);
    const isFirstLog = nutritionStore.logs.filter(e => !e.deletedAt).length === 0;
    const prevProg   = nutritionStore.getProgress();

    nutritionStore.logRaw(n.logKey, amount);

    const nextProg = nutritionStore.getProgress();
    setActiveInput(null);

    const amountStr = `${amount >= 0 ? '' : ''}${amount}${n.unit}`;
    triggerNutritionEvents(
      { nutrient: n.label, amount: amountStr, current: nextProg[nutrientKey]?.current, min: nextProg[nutrientKey]?.min },
      prevProg, nextProg, isFirstLog
    );

    const sign = amount >= 0 ? '+' : '';
    showUndo(`${sign}${amountStr} ${n.label}`);
  };

  const handleRawCancel = () => setActiveInput(null);

  // ---- Library tap handler ----

  const handleLibraryTap = (item) => {
    setFlashId(item.id);
    setTimeout(() => setFlashId(null), 600);

    const isFirstLog = nutritionStore.logs.filter(e => !e.deletedAt).length === 0;
    const prevProg   = nutritionStore.getProgress();

    nutritionStore.logFromLibrary(item, 1);
    libraryStore.recordUsage(item.id);

    const nextProg = nutritionStore.getProgress();

    // Build undo toast detail string
    const parts = [];
    if (item.protein)       parts.push(`+${item.protein}g protein`);
    if (item.fiber)         parts.push(`+${item.fiber}g fiber`);
    if (item.fruitServings) parts.push(`+${item.fruitServings} fruit`);
    if (item.vegServings)   parts.push(`+${item.vegServings} veg`);
    const detail = parts.length ? ` (${parts.join(', ')})` : '';

    triggerNutritionEvents(
      { name: item.name, current: null, min: null },
      prevProg, nextProg, isFirstLog
    );
    showUndo(`logged ${item.name}${detail}`);
  };

  // ---- Undo handler ----

  const handleUndo = () => {
    nutritionStore.undoLast();
    clearTimeout(undoTimerRef.current);
    setUndoToast(null);
    triggerMsg(pickMsg(MSGS.undo));
  };

  // ---- Derived data ----

  const progress     = nutritionStore.getProgress();
  const allStreak    = nutritionStore.getAllStreak();
  const weeklyAvg    = nutritionStore.getWeeklyAvg('protein');
  const visibleItems = libraryStore.getVisibleItems(searchQuery);

  const perNutrientStreaks = NUTRIENTS.map(n => ({
    label: n.label,
    color: n.brightColor,
    days:  nutritionStore.getStreak(n.key),
  }));

  // ===== Render =====

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>

      {/* ---- Header ---- */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 20px 6px', flexShrink: 0 }}>
        <span style={{ fontFamily: "'Courier New', monospace", fontSize: 'var(--glim-text-base)', color: 'rgba(200,210,230,0.75)', letterSpacing: '0.5px' }}>
          nutrition
        </span>
        <span style={{ fontFamily: "'Courier New', monospace", fontSize: 'var(--glim-text-xs)', color: 'rgba(200,210,230,0.35)' }}>
          today
        </span>
      </div>

      {/* ---- Progress bars (non-scrolling) ---- */}
      <div style={{ padding: '2px 20px 0', flexShrink: 0 }}>
        {NUTRIENTS.map((nutrient) => {
          const p = progress[nutrient.key];
          if (activeInput === nutrient.key) {
            return (
              <InlineInputRow
                key={nutrient.key}
                nutrient={nutrient}
                onConfirm={(amount) => handleRawConfirm(nutrient.key, amount)}
                onCancel={handleRawCancel}
              />
            );
          }
          return <NutrientBar key={nutrient.key} nutrient={nutrient} progress={p} onPlus={handlePlus} />;
        })}
      </div>

      {/* ---- Divider ---- */}
      <div style={{ margin: '6px 20px', height: 1, background: 'rgba(200,210,230,0.08)', flexShrink: 0 }} />

      {/* ---- Undo toast ---- */}
      {undoToast && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 20px', flexShrink: 0 }}>
          <span style={{ fontFamily: "'Courier New', monospace", fontSize: 'var(--glim-text-xs)', color: 'rgba(200,210,230,0.55)' }}>
            {undoToast.message}
          </span>
          <button
            onClick={handleUndo}
            style={{ fontFamily: "'Courier New', monospace", fontSize: 'var(--glim-text-xs)', color: 'rgba(200,210,230,0.55)', background: 'none', border: '1px solid rgba(200,210,230,0.15)', borderRadius: 4, padding: '2px 8px', cursor: 'pointer' }}
          >
            undo
          </button>
        </div>
      )}

      {/* ---- Library section (scrollable) ---- */}
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <div style={{ padding: '0 20px 4px', flexShrink: 0 }}>
          <input
            type="text" value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="search library..."
            style={{ width: '100%', height: 44, boxSizing: 'border-box', background: 'rgba(200,210,230,0.06)', border: '1px solid rgba(200,210,230,0.12)', borderRadius: 6, color: 'rgba(200,210,230,0.75)', fontFamily: "'Courier New', monospace", fontSize: 'var(--glim-text-lg)', padding: '0 10px', outline: 'none' }}
          />
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '0 8px' }}>
          {visibleItems.length === 0 ? (
            <div style={{ fontFamily: "'Courier New', monospace", fontSize: 'var(--glim-text-xs)', color: 'rgba(200,210,230,0.25)', textAlign: 'center', padding: '12px 0' }}>
              {searchQuery ? 'no matches' : 'library empty - add foods in the library manager'}
            </div>
          ) : (
            visibleItems.map(item => (
              <LibraryItemRow key={item.id} item={item} isFlashing={flashId === item.id} onTap={handleLibraryTap} />
            ))
          )}
        </div>
      </div>

      {/* ---- Streak footer ---- */}
      <div style={{ flexShrink: 0, borderTop: '1px solid rgba(200,210,230,0.06)' }}>
        <button
          onClick={() => setStreakExpanded(v => !v)}
          className="glim-tap-up"
          style={{ position: 'relative', display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%', padding: '7px 20px', background: 'none', border: 'none', cursor: 'pointer' }}
        >
          <span style={{ fontFamily: "'Courier New', monospace", fontSize: 'var(--glim-text-xs)', color: 'rgba(200,210,230,0.55)', display: 'flex', alignItems: 'center', gap: 6 }}>
            streak: {allStreak} {allStreak === 1 ? 'day' : 'days'}
            <svg viewBox="0 0 10 6" width={10} height={6} style={{ display: 'block', transform: streakExpanded ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.2s ease', opacity: 0.4 }}>
              <path d="M1 1 L5 5 L9 1" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
          <span style={{ fontFamily: "'Courier New', monospace", fontSize: 'var(--glim-text-xs)', color: 'rgba(200,210,230,0.35)' }}>
            avg: {weeklyAvg}g protein/day
          </span>
        </button>

        {streakExpanded && (
          <div style={{ padding: '0 20px 8px', display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            {perNutrientStreaks.map(({ label, color, days }) => (
              <span key={label} style={{ fontFamily: "'Courier New', monospace", fontSize: 'var(--glim-text-2xs)', color: 'rgba(200,210,230,0.5)', display: 'flex', alignItems: 'center', gap: 4 }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: color, display: 'inline-block', flexShrink: 0 }} />
                {label} {days}d
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
