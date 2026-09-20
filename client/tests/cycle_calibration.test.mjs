// title: cycle_calibration.test.mjs
// project: Glim
// author: Reina Hastings
// contact: reinahastings13@gmail.com
//
// purpose:
//   Measures the Stage 1 prediction window END TO END: generates flow rows from
//   known true cycle lengths, runs the REAL segmentCycles then the REAL predict,
//   and asks how often the true next period lands inside the window the user
//   would have been shown.
//
//   Supersedes docs/cycle_tracking_feature/interval_calibration.mjs, which had
//   three defects this file exists to avoid:
//     1. its suppression gate was unreachable code (`null` last in the loop), so
//        the decision it justified was printed, never enforced;
//     2. it re-implemented the estimator, so the calibrated and shipped
//        constructions could drift apart silently;
//     3. it fed the estimator raw generator draws, while the app feeds it
//        outlier-filtered cycle lengths derived from flow rows, so its numbers
//        were an upper bound presented as the shipped figure.
//
//   Generators are constrained to the domain the app accepts, (REFRACTORY_DAYS,
//   MAX_CYCLE], because cells built from lengths predict() would reject cannot
//   describe anything a user will see.
//
// inputs:  none (deterministic PRNG, SEED below)
// outputs: per-part tables, then PASS/FAIL per gate; exits non-zero on failure
//
// usage:
//   cd client && TZ=America/New_York node --import ./tests/register-hooks.mjs tests/cycle_calibration.test.mjs

if (process.env.TZ !== 'America/New_York') {
  console.error('FAIL this test must run under TZ=America/New_York (see tests/README.md)');
  process.exit(1);
}

const { segmentCycles } = await import('../src/cycle/segment.js');
const { predict, median } = await import('../src/cycle/predict.js');
const { addDaysStr } = await import('../src/utils/dateUtils.js');
const { REFRACTORY_DAYS, MAX_CYCLE } = await import('../src/cycle/constants.js');

// --- Generator -------------------------------------------------------------
// mulberry32 + Acklam inverse-normal CDF. Inverse-CDF rather than Box-Muller:
// Box-Muller on consecutive linear-congruential draws truncates both tails
// (Neave 1973, JRSS-C 22(1):92), and truncated tails inflate coverage, which is
// the one quantity this file exists to measure.
const SEED = 20260918;
const TRIALS = 1500;   // end-to-end trials are ~50x the cost of estimator-only
                       // ones; 1500 gives a Monte Carlo SE of about 0.011 on a
                       // coverage of 0.8, which is fine against a 0.70 gate.

function mulberry32(a) {
  return function () { a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function ppnd(p) {
  const a=[-3.969683028665376e+01,2.209460984245205e+02,-2.759285104469687e+02,
           1.383577518672690e+02,-3.066479806614716e+01,2.506628277459239e+00];
  const b=[-5.447609879822406e+01,1.615858368580409e+02,-1.556989798598866e+02,
           6.680131188771972e+01,-1.328068155288572e+01];
  const c=[-7.784894002430293e-03,-3.223964580411365e-01,-2.400758277161838e+00,
           -2.549732539343734e+00,4.374664141464968e+00,2.938163982698783e+00];
  const d=[7.784695709041462e-03,3.224671290700398e-01,2.445134137142996e+00,
           3.754408661907416e+00];
  const pl=0.02425; let q,r;
  if(p<pl){q=Math.sqrt(-2*Math.log(p));
    return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5])/((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);}
  if(p<=1-pl){q=p-0.5;r=q*q;
    return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q/(((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1);}
  q=Math.sqrt(-2*Math.log(1-p));
  return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5])/((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
}

// Both generators are CLAMPED TO THE ACCEPTED DOMAIN by rejection, not by a hard
// floor. A floor piles a point mass on the boundary and makes low-side misses
// nearly impossible, which flatters coverage at high variability.
const inDomain = (L) => L > REFRACTORY_DAYS && L <= MAX_CYCLE;
function rejectionDraw(draw) {
  for (let i = 0; i < 200; i++) { const L = draw(); if (inDomain(L)) return L; }
  return 29;
}
const mkNormal = function mkNormal(rnd, sd) { return () =>
  rejectionDraw(() => Math.round(29 + sd * ppnd(rnd()))); };
// Shifted log-normal with matched mean and sd: right-skewed, as real cycle
// length distributions are (Huang et al.; Apple Women's Health Study 2023).
const mkLogNorm = function mkLogNorm(rnd, sd) {
  const shift = REFRACTORY_DAYS, m = 29 - shift, v = sd * sd;
  const mu = Math.log(m * m / Math.sqrt(v + m * m));
  const sig = Math.sqrt(Math.log(1 + v / (m * m)));
  return () => rejectionDraw(() => Math.round(shift + Math.exp(mu + sig * ppnd(rnd()))));
};

// --- Flow-row synthesis ----------------------------------------------------
// The app never sees cycle lengths. It sees flow rows and derives everything,
// so the measurement starts where the app starts.
const BASE = '2026-01-05';
function buildRows(lengths, rnd, { skipRate = 0, blipRate = 0 } = {}) {
  const rows = [];
  let day = 0;
  const trueStarts = [];
  for (const L of lengths) {
    trueStarts.push(day);
    const skipped = rnd() < skipRate;
    if (!skipped) {
      const periodLen = 3 + Math.floor(rnd() * 3);   // 3-5 bleeding days
      for (let k = 0; k < periodLen; k++) {
        rows.push({ id: addDaysStr(BASE, day + k), date: addDaysStr(BASE, day + k),
                    flow: k === 0 ? 'medium' : (rnd() < 0.5 ? 'medium' : 'light'),
                    isPeriodStart: null, updatedAt: '2026-01-01T00:00:00.000Z' });
      }
    }
    if (rnd() < blipRate) {                          // a stray mid-cycle light day
      const at = day + 8 + Math.floor(rnd() * Math.max(1, L - 14));
      rows.push({ id: addDaysStr(BASE, at), date: addDaysStr(BASE, at), flow: 'light',
                  isPeriodStart: null, updatedAt: '2026-01-01T00:00:00.000Z' });
    }
    day += L;
  }
  return { rows, lastTrueStart: trueStarts[trueStarts.length - 1], nextTrueDay: day };
}

// One end-to-end trial: build a history, segment it, predict, compare the window
// against the true next start.
function trial(mk, sd, nCycles, rnd, opts = {}) {
  const gen = mk(rnd, sd);
  const lengths = Array.from({ length: nCycles }, gen);
  const { rows, nextTrueDay } = buildRows(lengths, rnd, opts);
  if (rows.length === 0) return null;
  const today = rows[rows.length - 1].date;
  const cycles = segmentCycles(rows, today);
  if (cycles.length === 0) return null;
  const p = predict(cycles, today);
  if (!p.nextWindow) return { p, hit: null };
  const truth = addDaysStr(BASE, nextTrueDay);
  return {
    p, truth,
    hit: truth >= p.nextWindow[0] && truth <= p.nextWindow[1],
    low: truth < p.nextWindow[0],
    high: truth > p.nextWindow[1],
  };
}

// Memoised: Parts B, C, D and E ask for the same cells repeatedly, and each one
// segments thousands of synthetic histories. Without this the run takes minutes.
const CELL_CACHE = new Map();
function cell(mk, sd, nCycles, opts = {}, widthGate = null) {
  const key = `${mk.name}|${sd}|${nCycles}|${JSON.stringify(opts)}|${widthGate}`;
  if (CELL_CACHE.has(key)) return CELL_CACHE.get(key);
  const out = computeCell(mk, sd, nCycles, opts, widthGate);
  CELL_CACHE.set(key, out);
  return out;
}

function computeCell(mk, sd, nCycles, opts = {}, widthGate = null) {
  const rnd = mulberry32(SEED);
  let hit = 0, low = 0, high = 0, shown = 0, suppressed = 0, personal = 0;
  const widths = [], errs = [];
  for (let t = 0; t < TRIALS; t++) {
    const r = trial(mk, sd, nCycles, rnd, opts);
    if (!r || r.hit === null) continue;
    if (widthGate !== null && r.p.windowWidth > widthGate) { suppressed++; continue; }
    shown++; widths.push(r.p.windowWidth); errs.push(Math.abs(r.p.estLength - 29));
    if (r.p.basis === 'personal') personal++;
    if (r.hit) hit++; else if (r.low) low++; else high++;
  }
  const denom = shown || 1;
  return { cov: hit / denom, low: low / denom, high: high / denom,
           w: widths.length ? median(widths) : null,
           medErr: errs.length ? median(errs) : null,
           personalShare: personal / denom,
           sup: suppressed / (shown + suppressed || 1), shown };
}

const NS = [2, 3, 4, 6, 9, 13];   // cycles logged; n-1 complete cycles feed the estimate
const SDS = [2, 4, 7, 11];
const GENS = [['gaussian ', mkNormal], ['lognormal', mkLogNorm]];
const failures = [];

// =============================== Part A =====================================
console.log('=== Part A: instrument sanity ===');
{
  const rnd = mulberry32(SEED), N = 400_000, bins = new Array(20).fill(0);
  let s = 0;
  for (let i = 0; i < N; i++) { const u = rnd(); bins[Math.min(19, Math.floor(u * 20))]++; s += u; }
  const chi = bins.reduce((acc, b) => acc + (b - N / 20) ** 2 / (N / 20), 0);
  console.log(`  uniform mean ${(s / N).toFixed(5)} (0.5)   chi-square(19) ${chi.toFixed(1)} (fail > 43)`);
  if (chi > 43) failures.push('A: generator failed chi-square');
  const r2 = mulberry32(7); let tail = 0, M = 300_000;
  for (let i = 0; i < M; i++) if (Math.abs(ppnd(r2())) > 2.5758) tail++;
  console.log(`  P(|z| > 2.576) ${(tail / M).toFixed(5)} (0.01) - the tail an LCG+Box-Muller pair truncates`);
  if (Math.abs(tail / M - 0.01) > 0.002) failures.push('A: normal tails mis-calibrated');
}

// =============================== Part B =====================================
// TIERED GATE, and the tiers are a statement about reality, not a way to make
// the numbers pass. Bull et al. put the between-woman sd of cycle length near 5
// days; within-woman variability is smaller still. sd 2-7 spans regular to
// genuinely irregular. sd 11 is a deliberate stress case past that range
// (PCOS-like), kept because it is where the design should fail visibly rather
// than quietly, and gated lower so a regression there is still caught.
const gateFor = (sd) => (sd <= 7 ? 0.68 : 0.55);
console.log('\n=== Part B: END-TO-END coverage per (sd, cycles logged). Nominal 90%.');
console.log('    Gate: every cell >= 0.68 for sd <= 7, >= 0.55 for the sd 11 stress case ===');
for (const [gname, mk] of GENS) {
  console.log(`  -- ${gname} --      ` + NS.map(n => `n=${String(n).padStart(2)}`).join('     '));
  for (const sd of SDS) {
    const cells = NS.map(n => {
      const r = cell(mk, sd, n);
      if (r.cov < gateFor(sd))
        failures.push(`B: ${gname.trim()} sd=${sd} n=${n} coverage ${r.cov.toFixed(2)} < ${gateFor(sd)}`);
      return `${r.cov.toFixed(2)}/${String(r.w).padStart(2)}d`;
    });
    console.log(`     sd=${String(sd).padStart(2)}          ` + cells.join('  '));
  }
}

// =============================== Part C =====================================
console.log('\n=== Part C: per-side miss rates (low|high). Gate: neither side > 0.20 ===');
for (const [gname, mk] of GENS) {
  console.log(`  -- ${gname} --`);
  for (const sd of SDS) {
    console.log(`     sd=${String(sd).padStart(2)}  ` + NS.map(n => {
      const r = cell(mk, sd, n);
      const sideGate = sd <= 7 ? 0.20 : 0.25;
      if (r.low > sideGate || r.high > sideGate)
        failures.push(`C: ${gname.trim()} sd=${sd} n=${n} miss ${r.low.toFixed(2)}|${r.high.toFixed(2)} > ${sideGate}`);
      return `${r.low.toFixed(2)}|${r.high.toFixed(2)}`;
    }).join('  '));
  }
}

// =============================== Part D =====================================
// The measurement behind "never suppress". THE `null` RUN GOES FIRST: in the
// superseded script it was last, so the baseline was undefined when the three
// real gates were tested and no failure could ever be raised.
console.log('\n=== Part D: does suppressing wide windows help? Gate: every gate must REDUCE coverage ===');
console.log('  width gate    ' + SDS.map(sd => `sd${String(sd).padStart(2)}`).join('   ') + '   | suppressed at sd11');
let baseline = null;
for (const gate of [null, 28, 21, 14]) {
  const row = SDS.map(sd => {
    let hit = 0, shown = 0;
    for (const n of NS) { const r = cell(mkNormal, sd, n, {}, gate); hit += r.cov * r.shown; shown += r.shown; }
    return shown ? hit / shown : 0;
  });
  const sup = median(NS.map(n => cell(mkNormal, 11, n, {}, gate).sup));
  console.log(`  ${String(gate ?? 'none').padStart(9)}    ` + row.map(v => v.toFixed(2)).join('  ') +
              `   |  ${(sup * 100).toFixed(0)}%`);
  if (gate === null) baseline = row;
  else if (row[3] >= baseline[3])
    failures.push(`D: gate ${gate} did not reduce coverage at sd11 (${row[3].toFixed(2)} vs ${baseline[3].toFixed(2)})`);
}

// =============================== Part E =====================================
console.log('\n=== Part E: robustness. Gate: median |estLength - 29| <= 2d (n<5) / <= 1d (n>=5) ===');
{
  console.log('  clean histories, sd 4:');
  console.log('     ' + NS.map(n => {
    const r = cell(mkNormal, 4, n);
    const gate = n < 5 ? 2 : 1;
    if (r.medErr > gate) failures.push(`E: sd=4 n=${n} median error ${r.medErr} > ${gate}`);
    return `n=${String(n).padStart(2)}: ${r.medErr}d`;
  }).join('  '));

  // Skipped logs now flow through segmentCycles, so R8g's SYMMETRIC exclusion
  // (possible-skip AND possible-split) is exercised. The superseded script
  // implemented only the long side, so the split rule had no measurement at all.
  console.log('  with skipped period logs (rows omitted entirely):');
  for (const rate of [0, 0.1, 0.2]) {
    const r = cell(mkNormal, 4, 13, { skipRate: rate });
    const line = `     skipRate ${rate.toFixed(2)} -> median |est-29| ${r.medErr}d, coverage ${r.cov.toFixed(2)}`;
    console.log(line);
    if (r.medErr > 2) failures.push(`E: skipRate ${rate} median error ${r.medErr} > 2`);
  }
  console.log('  with stray mid-cycle bleeds (the c1 shape):');
  for (const rate of [0, 0.15, 0.3]) {
    const r = cell(mkNormal, 4, 13, { blipRate: rate });
    console.log(`     blipRate ${rate.toFixed(2)} -> median |est-29| ${r.medErr}d, coverage ${r.cov.toFixed(2)}`);
    if (r.medErr > 2) failures.push(`E: blipRate ${rate} median error ${r.medErr} > 2`);
  }
}

// =============================== Part F =====================================
// The population branch, reached by anyone with fewer than two usable cycles.
// It was asserted and never measured; POP_SPREAD is a guess, so its coverage is
// reported rather than gated, and D11 must not claim it as measured.
console.log('\n=== Part F: the population branch (R9c), REPORTED not gated ===');
for (const sd of SDS) {
  const r = cell(mkNormal, sd, 2);
  console.log(`     sd=${String(sd).padStart(2)}  coverage ${r.cov.toFixed(2)}  width ${r.w}d  ` +
              `personal-basis share ${(r.personalShare * 100).toFixed(0)}%`);
}

// =============================== Part G =====================================
// D14 draws a date band only when windowWidth <= WIDE_WIDTH and shows past
// lengths otherwise. From the user's side that IS a selection, so the coverage
// of the DRAWN bands is a different and more honest number than Part B's. It is
// reported, not gated: Part D already establishes that selecting on width costs
// coverage, and D14 accepts that cost deliberately in exchange for never
// drawing a band too wide to mean anything.
console.log('\n=== Part G: WIDE_WIDTH sweep. Coverage of DRAWN bands / share shown a plain list ===');
{
  const { WIDE_WIDTH } = await import('../src/cycle/constants.js');
  console.log('    threshold |    sd2     |    sd4     |    sd7     |    sd11');
  for (const W of [14, 16, 18, 21, 24, 28, null]) {
    const cells = SDS.map(sd => {
      let hit = 0, shown = 0, total = 0;
      for (const n of NS) {
        const all = cell(mkNormal, sd, n);
        const drawn = W === null ? all : cell(mkNormal, sd, n, {}, W);
        hit += drawn.cov * drawn.shown; shown += drawn.shown; total += all.shown;
      }
      return `${(shown ? hit / shown : 0).toFixed(2)}/${String(total ? Math.round((1 - shown / total) * 100) : 0).padStart(2)}%`;
    });
    const mark = W === WIDE_WIDTH ? ' <- WIDE_WIDTH' : '';
    console.log(`    ${String(W ?? 'none').padStart(9)} | ${cells.join(' | ')}${mark}`);
  }
  console.log('    NOTE: coverage of drawn bands RISES with the threshold. Narrowing it does not');
  console.log('    buy trustworthiness - it selects the over-confident windows, exactly as Part D');
  console.log('    shows for suppression. WIDE_WIDTH is justified by ACTIONABILITY, not accuracy.');
}

// =============================== Verdict ====================================
console.log('\n=== Acceptance gates ===');
if (failures.length === 0) { console.log('  ALL PASS'); process.exit(0); }
console.log('  FAILURES:');
for (const f of failures) console.log('   - ' + f);
process.exit(1);
