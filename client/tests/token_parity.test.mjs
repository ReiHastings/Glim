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

// Tokens that are deliberately not lengths, and so are exempt from the px and
// monotonicity comparisons below.
//
// An EXPLICIT LIST, not a blanket "skip anything that is not px". The blanket
// version is the obvious implementation and it is wrong: it would silently
// retire the comparison for any token that later acquired a unit typo, such as
// `--glim-text-md: 1rem`, which is precisely the drift this test exists to
// catch. Every entry here is asserted to exist, so the list cannot rot into a
// set of names that no longer mean anything.
const NON_PX_TOKENS = [
  '--glim-water-fill-alpha',   // an alpha channel; unitless by definition
];

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

// --- The monotonicity convention ----------------------------------------
// Only px values are comparable. A token whose pair is not a plain px value is
// reported rather than skipped, UNLESS it is named in NON_PX_TOKENS: a silent
// skip would let a unit change retire the comparison without anyone noticing,
// which is why the exemption is a list that is itself checked rather than a
// property of the value.
const px = (v) => (/^-?\d+(\.\d+)?px$/.test(v) ? parseFloat(v) : null);

const shared = [...base.keys()].filter((k) => mobile.has(k)).sort();

// The exemption list must describe reality, or it is a place for dead names to
// accumulate and for a real token to hide behind a typo'd entry.
const staleExempt = NON_PX_TOKENS.filter((k) => !base.has(k) || !mobile.has(k));
check('every exempt token actually exists in both blocks' +
      (staleExempt.length ? ` (stale: ${staleExempt.join(', ')})` : ''),
  staleExempt.length === 0);

const measured = shared.filter((k) => !NON_PX_TOKENS.includes(k));
check(`the exemption list does not swallow the whole token set ` +
      `(${measured.length} of ${shared.length} tokens still compared)`,
  measured.length >= MIN_TOKENS);

const notComparable = measured.filter((k) => px(base.get(k)) === null || px(mobile.get(k)) === null);
check('every non-exempt shared token holds a plain px value on both sides' +
      (notComparable.length ? ` (not comparable: ${notComparable.join(', ')})` : ''),
  notComparable.length === 0);

const inverted = measured
  .filter((k) => px(base.get(k)) !== null && px(mobile.get(k)) !== null)
  .filter((k) => px(mobile.get(k)) > px(base.get(k)))
  .map((k) => `${k} (${mobile.get(k)} > ${base.get(k)})`);
check('no mobile value exceeds its desktop counterpart' +
      (inverted.length ? ` (inverted: ${inverted.join(', ')})` : ''),
  inverted.length === 0);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
