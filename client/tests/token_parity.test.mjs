// title: token_parity.test.mjs
// project: Glim
// author: Reina Hastings
// contact: reinahastings13@gmail.com
// created: 2026-09-18
//
// purpose:
//   Static-analysis invariant test (no framework, no imports) for the two
//   parallel --glim-* custom-property blocks in src/index.css.
//
//   index.css declares every design token twice: once in the base :root block
//   (desktop, and any viewport 600px and wider) and once again inside
//   @media (max-width: 599px), which is the block that governs the phone and
//   therefore the Capacitor iOS build. Nothing in CSS links a token's two
//   definitions except that they are spelled the same way, so the two lists
//   can drift apart silently:
//
//     - A token added to only the base block does not error. The phone simply
//       inherits the desktop value, which reads as deliberate. This is the
//       failure this test exists to catch.
//     - A token renamed in one block leaves the other defining a property
//       nothing reads.
//     - A token removed from the base block but left in the media query
//       applies on the phone and vanishes on desktop.
//
//   It also locks the convention that every mobile value is smaller than or
//   equal to its desktop counterpart. That rule is currently held only in the
//   author's head; a desktop-only tuning pass can invert a pair without
//   anything complaining.
//
//   VACUITY GUARDS. A parser that silently matches nothing would pass every
//   assertion below, so the test first asserts that it found both blocks, that
//   the base block holds at least MIN_TOKENS declarations, and that the number
//   of --glim-* declarations it accounted for equals the number in the file.
//   The last one is what notices a third block being added later: this test's
//   whole model is that there are exactly two, and it must fail rather than
//   quietly ignore a new one.
//
// inputs:
//   src/index.css (read as text; never parsed by a CSS engine)
//
// outputs:
//   stdout: one line per check, then a pass/fail tally
//   exit code: 0 all passed, 1 otherwise
//
// usage:
//   cd client && node tests/token_parity.test.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, '../src/index.css'), 'utf8');

// The base block is expected to hold the full token set. Well below the 15
// present on 2026-09-18, so ordinary pruning does not trip it, but high enough
// that a parser returning a handful of stray matches fails here.
const MIN_TOKENS = 10;

// What KIND of value each token holds. Anything not named here is a length and
// must be plain px on both sides.
//
// A declared kind, not an exemption list. The obvious implementation is a list
// of "tokens to skip", and it is weaker in a way that matters: a skip says only
// "do not check this", so a length token accidentally written `8` instead of
// `8px` is one careless list addition away from never being checked again.
// Declaring the kind means every token is checked against something, and the
// only way to lose coverage is to lie about what a token is.
const TOKEN_KINDS = {
  '--glim-water-fill-alpha':      'unitless',  // an alpha channel
  '--glim-water-wave-period':      'time',
  '--glim-water-wave-period-back': 'time',
  '--glim-water-bubble-rise':      'time',
  '--glim-water-bubble-wobble':    'time',
};

const KIND_PATTERNS = {
  px:       /^-?\d+(\.\d+)?px$/,
  time:     /^\d+(\.\d+)?m?s$/,
  unitless: /^-?\d+(\.\d+)?$/,
};

const kindOf = (token) => TOKEN_KINDS[token] ?? 'px';

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.error(`  FAIL ${name}`); }
}

// --- Block extraction ---------------------------------------------------
// Brace matching from the opening { of a rule, so a nested block (the :root
// inside the media query) is bounded correctly rather than by the first }.
function blockAt(text, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') { depth--; if (depth === 0) return text.slice(openIdx + 1, i); }
  }
  return null;
}

// Base :root: the first one in the file, which is the desktop default.
const baseOpen = css.indexOf('{', css.indexOf(':root'));
const baseBlock = baseOpen === -1 ? null : blockAt(css, baseOpen);

// Mobile :root: the one nested inside @media (max-width: 599px). Matched on
// the media condition rather than on position, so reordering the file or
// adding an unrelated media query above it does not silently pick the wrong
// block.
const MEDIA = '@media (max-width: 599px)';
const mediaIdx = css.indexOf(MEDIA);
const mobileRootIdx = mediaIdx === -1 ? -1 : css.indexOf(':root', mediaIdx);
const mobileOpen = mobileRootIdx === -1 ? -1 : css.indexOf('{', mobileRootIdx);
const mobileBlock = mobileOpen === -1 ? null : blockAt(css, mobileOpen);

check('the base :root block was found', baseBlock !== null);
check(`the ${MEDIA} block was found`, mediaIdx !== -1);
check('a :root block was found inside the media query', mobileBlock !== null);

if (baseBlock === null || mobileBlock === null) {
  console.error('\nBlock extraction failed; the remaining checks would be vacuous.');
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(1);
}

// --- Declaration parsing ------------------------------------------------
// Values are taken up to the semicolon, so a trailing comment on the same
// line (several tokens carry one) is not swallowed into the value.
function tokensIn(block) {
  const out = new Map();
  const re = /(--glim-[\w-]+)\s*:\s*([^;]+);/g;
  let m;
  while ((m = re.exec(block)) !== null) out.set(m[1], m[2].trim());
  return out;
}

const base = tokensIn(baseBlock);
const mobile = tokensIn(mobileBlock);

check(`the base block declares at least ${MIN_TOKENS} tokens (found ${base.size})`,
  base.size >= MIN_TOKENS);

// The model is "exactly two blocks". Count every --glim-* declaration in the
// file (a declaration, not a var() reference, so the comment on line 55 and
// all consuming rules are excluded) and require the two blocks to account for
// all of them.
const declaredInFile = (css.match(/--glim-[\w-]+\s*:/g) || []).length;
check(`the two blocks account for every --glim-* declaration in the file ` +
      `(${base.size} + ${mobile.size} = ${declaredInFile})`,
  base.size + mobile.size === declaredInFile);

// --- The parity invariant -----------------------------------------------
const onlyBase = [...base.keys()].filter((k) => !mobile.has(k)).sort();
const onlyMobile = [...mobile.keys()].filter((k) => !base.has(k)).sort();

check('every base token is redeclared in the media query' +
      (onlyBase.length ? ` (missing: ${onlyBase.join(', ')})` : ''),
  onlyBase.length === 0);
check('every media-query token exists in the base block' +
      (onlyMobile.length ? ` (orphaned: ${onlyMobile.join(', ')})` : ''),
  onlyMobile.length === 0);

// --- Kinds and the monotonicity convention -------------------------------
// Each token is checked against the kind it declares (lengths by default), and
// only lengths are then compared for size. Checking against a declared kind
// rather than skipping non-px values is what keeps a unit typo detectable.
const px = (v) => (KIND_PATTERNS.px.test(v) ? parseFloat(v) : null);

const shared = [...base.keys()].filter((k) => mobile.has(k)).sort();

// A declared kind must describe a token that exists, or the map becomes a place
// for dead names to accumulate.
const staleKinds = Object.keys(TOKEN_KINDS).filter((k) => !base.has(k) || !mobile.has(k));
check('every token with a declared kind exists in both blocks' +
      (staleKinds.length ? ` (stale: ${staleKinds.join(', ')})` : ''),
  staleKinds.length === 0);

// Every shared token is checked against its kind, on BOTH sides. This is what
// catches a length written without its unit, which no skip-list version could.
const wrongKind = shared.filter((k) => {
  const re = KIND_PATTERNS[kindOf(k)];
  return !re.test(base.get(k)) || !re.test(mobile.get(k));
});
check('every shared token matches its declared kind on both sides' +
      (wrongKind.length
        ? ` (mismatched: ${wrongKind.map((k) => `${k} is not ${kindOf(k)}`).join(', ')})`
        : ''),
  wrongKind.length === 0);

// Only lengths can be compared for size, so only lengths carry the
// monotonicity rule. Guarded so a map that quietly relabelled everything as
// 'time' could not retire the comparison.
const measured = shared.filter((k) => kindOf(k) === 'px');
check(`the kind map leaves a real set of lengths to compare ` +
      `(${measured.length} of ${shared.length} tokens)`,
  measured.length >= MIN_TOKENS);

const inverted = measured
  .filter((k) => px(base.get(k)) !== null && px(mobile.get(k)) !== null)
  .filter((k) => px(mobile.get(k)) > px(base.get(k)))
  .map((k) => `${k} (${mobile.get(k)} > ${base.get(k)})`);
check('no mobile value exceeds its desktop counterpart' +
      (inverted.length ? ` (inverted: ${inverted.join(', ')})` : ''),
  inverted.length === 0);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
