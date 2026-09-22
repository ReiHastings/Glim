// title: privacy_agreement.test.mjs
// project: Glim
// author: Reina Hastings
// contact: reinahastings13@gmail.com
// created: 2026-09-22
//
// purpose:
//   One list, three places (docs/plan_stage2_release.md 4.2): the data types
//   Glim declares in its Apple privacy manifest must be the same set the
//   privacy policy page describes, and later the App Privacy answers in App
//   Store Connect. This test pins the first two to each other, so a type added
//   to one file and not the other fails CI rather than being noticed by a
//   reviewer. It also checks the manifest's fixed claims (no tracking, no
//   required-reason APIs, every type linked and for App Functionality only).
//   Negative controls run the same comparator on mutated copies, in both
//   directions, and an order-shuffled pair must still agree.
//
//   Plain regex parsing, no plist library, so it runs on the Linux CI runner.
//
// usage:
//   cd client && node tests/privacy_agreement.test.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const MANIFEST = join(here, '../ios/App/App/PrivacyInfo.xcprivacy');
const POLICY = join(here, '../../site/privacy.html');

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.error(`  FAIL ${name}${detail ? `: ${detail}` : ''}`); }
}

// --- Parsers -----------------------------------------------------------------

// Each collected type is a <dict> with the type string under the
// NSPrivacyCollectedDataType key. Returns the short names, e.g. "Health".
export function manifestTypes(xml) {
  return [...xml.matchAll(/<key>NSPrivacyCollectedDataType<\/key>\s*<string>NSPrivacyCollectedDataType(\w+)<\/string>/g)].map((m) => m[1]);
}
// Each described type is an <li data-type="X"> in the policy.
export function policyTypes(html) {
  return [...html.matchAll(/<li\s+data-type="(\w+)"/g)].map((m) => m[1]);
}
const asSet = (a) => new Set(a);
const sameSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));
const diff = (a, b) => [...a].filter((x) => !b.has(x));

// Agreement verdict for a (manifest, policy) pair: null if they agree, else a
// message naming what is missing where.
export function disagreement(xml, html) {
  const m = manifestTypes(xml), p = policyTypes(html);
  if (new Set(m).size !== m.length) return `manifest lists a type twice: ${m.join(', ')}`;
  if (new Set(p).size !== p.length) return `policy lists a type twice: ${p.join(', ')}`;
  const ms = asSet(m), ps = asSet(p);
  if (sameSet(ms, ps)) return null;
  return `only in manifest: [${diff(ms, ps)}]; only in policy: [${diff(ps, ms)}]`;
}

// --- The real files ----------------------------------------------------------

const xml = readFileSync(MANIFEST, 'utf8');
const html = readFileSync(POLICY, 'utf8');
const m = manifestTypes(xml), p = policyTypes(html);

check('1 the manifest declares at least one collected data type', m.length > 0, `found ${m.length}`);
check('2 the policy describes at least one data type', p.length > 0, `found ${p.length}`);
check('3 manifest and policy name the same set of data types', disagreement(xml, html) === null, disagreement(xml, html) ?? '');

// Fixed claims in the manifest, each of which the policy asserts in prose.
// One <dict> per collected type, taken from inside the NSPrivacyCollectedDataTypes
// array only, so a future NSPrivacyAccessedAPITypes entry is not miscounted.
const collectedArray = /<key>NSPrivacyCollectedDataTypes<\/key>\s*<array>([\s\S]*?)<\/array>\s*<\/dict>\s*<\/plist>/.exec(xml)?.[1] ?? '';
const dicts = collectedArray.split('<dict>').slice(1);
check('4 NSPrivacyTracking is false', /<key>NSPrivacyTracking<\/key>\s*<false\/>/.test(xml));
check('5 NSPrivacyAccessedAPITypes is empty (Glim calls no required-reason API itself)', /<key>NSPrivacyAccessedAPITypes<\/key>\s*<array\/>/.test(xml));
check('6 every collected type is linked to the user', dicts.length === m.length && dicts.every((d) => /<key>NSPrivacyCollectedDataTypeLinked<\/key>\s*<true\/>/.test(d)), `${dicts.length} dicts, ${m.length} types`);
check('7 no collected type is used for tracking', dicts.every((d) => /<key>NSPrivacyCollectedDataTypeTracking<\/key>\s*<false\/>/.test(d)));
check('8 every collected type has exactly the purpose App Functionality', dicts.every((d) => [...d.matchAll(/<string>NSPrivacyCollectedDataTypePurpose(\w+)<\/string>/g)].map((x) => x[1]).join() === 'AppFunctionality'));
check('9 the policy names the step count specifically (Guideline 5.1.3(i))', /step count/i.test(html));
check('10 the policy states Health data is never used for advertising, marketing or data mining', /advertising, marketing, or data mining/i.test(html));
check('11 the policy states nothing is stored in iCloud (Guideline 5.1.3(ii))', /iCloud/.test(html));
check('12 the policy explains deletion and names a turnaround', /delete your account/i.test(html) && /within \d+ days/i.test(html));

// --- Negative controls (mutated copies, both directions, plus order) ----------

const dropManifest = (type) => xml.replace(new RegExp(`<dict>(?:(?!<\\/dict>)[\\s\\S])*?NSPrivacyCollectedDataType${type}<\\/string>[\\s\\S]*?<\\/dict>\\s*`), '');
const dropPolicy = (type) => html.replace(new RegExp(`\\s*<li\\s+data-type="${type}"[\\s\\S]*?<\\/li>`), '');
const addPolicy = (type) => html.replace('</ul>', `  <li data-type="${type}">extra</li>\n</ul>`);
const addManifest = (type) => xml.replace('<key>NSPrivacyCollectedDataTypes</key>\n\t<array>', `<key>NSPrivacyCollectedDataTypes</key>\n\t<array>\n\t\t<dict>\n\t\t\t<key>NSPrivacyCollectedDataType</key>\n\t\t\t<string>NSPrivacyCollectedDataType${type}</string>\n\t\t</dict>`);

const first = m[0];
check('N1 removing a type from the manifest only is detected', manifestTypes(dropManifest(first)).length === m.length - 1 && /only in policy: \[.*\]/.test(disagreement(dropManifest(first), html) ?? '') && (disagreement(dropManifest(first), html) ?? '').includes(first));
check('N2 removing a type from the policy only is detected', policyTypes(dropPolicy(first)).length === p.length - 1 && (disagreement(xml, dropPolicy(first)) ?? '').includes(`only in manifest: [${first}]`));
check('N3 adding a type to the policy only is detected', (disagreement(xml, addPolicy('PreciseLocation')) ?? '').includes('only in policy: [PreciseLocation]'));
check('N4 adding a type to the manifest only is detected', (disagreement(addManifest('PreciseLocation'), html) ?? '').includes('only in manifest: [PreciseLocation]'));
check('N5 a duplicated policy entry is detected', /twice/.test(disagreement(xml, addPolicy(first)) ?? ''));
// Order invariance: reverse the policy's list items; the sets still agree.
const items = [...html.matchAll(/^\s*<li\s+data-type="\w+".*$/gm)].map((x) => x[0]);
const reversed = items.reduce((h, li, i) => h.replace(li, `__ITEM_${i}__`), html);
const shuffled = items.reduce((h, li, i) => h.replace(`__ITEM_${i}__`, items[items.length - 1 - i]), reversed);
const withApi = xml.replace('<key>NSPrivacyAccessedAPITypes</key>\n\t<array/>', '<key>NSPrivacyAccessedAPITypes</key>\n\t<array>\n\t\t<dict>\n\t\t\t<key>NSPrivacyAccessedAPIType</key>\n\t\t\t<string>NSPrivacyAccessedAPICategoryFileTimestamp</string>\n\t\t</dict>\n\t</array>');
const apiDicts = (/<key>NSPrivacyCollectedDataTypes<\/key>\s*<array>([\s\S]*?)<\/array>\s*<\/dict>\s*<\/plist>/.exec(withApi)?.[1] ?? '').split('<dict>').slice(1);
check('N7 an NSPrivacyAccessedAPITypes entry does not change the collected-type dict count', withApi !== xml && apiDicts.length === m.length && disagreement(withApi, html) === null);
check('N6 reordering the policy list does not change the verdict', policyTypes(shuffled).join() === [...p].reverse().join() && disagreement(xml, shuffled) === null);

console.log(`\nprivacy_agreement: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
