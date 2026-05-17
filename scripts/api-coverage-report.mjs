#!/usr/bin/env node
// Coverage report against API-Dump.json. Walks every entry and confirms
// it lives in api-data.ts or exclusions.json. Anything else is a gap.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

const dump = JSON.parse(
  readFileSync(resolve(repoRoot, 'src/compile/macros/generated/cache/api-dump.json'), 'utf8'),
);
const exclusions = JSON.parse(
  readFileSync(resolve(repoRoot, 'src/compile/macros/generated/exclusions.json'), 'utf8'),
);
const excludedSet = new Set(
  exclusions.entries.map((e) => `${e.class}.${e.member}`),
);

const apiDataSrc = readFileSync(
  resolve(repoRoot, 'src/compile/macros/generated/api-data.ts'),
  'utf8',
);

// Quick string-presence check rather than re-parsing the generated TS.
// Each API member name appears verbatim as a JSON object key.
function memberIsInApiData(className, memberName) {
  // Form `"<memberName>"` followed by `:` inside class block — easy
  // false-positive: another class has the same name. For a coverage
  // overview that's acceptable; the goal is to surface entries
  // categorically missing.
  const key = `"${memberName}"`;
  return apiDataSrc.includes(key);
}

const tally = {
  classProperties: { total: 0, covered: 0, excluded: 0, missing: 0 },
  classMethods: { total: 0, covered: 0, excluded: 0, missing: 0 },
  classEvents: { total: 0, covered: 0, excluded: 0, missing: 0 },
  classCallbacks: { total: 0, covered: 0, excluded: 0, missing: 0 },
  enums: { total: 0, covered: 0 },
};

const missing = [];
for (const cls of dump.Classes) {
  for (const m of cls.Members ?? []) {
    const bucketKey =
      m.MemberType === 'Property' ? 'classProperties'
      : m.MemberType === 'Function' ? 'classMethods'
      : m.MemberType === 'Event' ? 'classEvents'
      : m.MemberType === 'Callback' ? 'classCallbacks'
      : null;
    if (!bucketKey) continue;
    const bucket = tally[bucketKey];
    bucket.total += 1;
    const id = `${cls.Name}.${m.Name}`;
    if (excludedSet.has(id)) {
      bucket.excluded += 1;
      continue;
    }
    if (memberIsInApiData(cls.Name, m.Name)) {
      bucket.covered += 1;
    } else {
      bucket.missing += 1;
      missing.push({ class: cls.Name, member: m.Name, kind: m.MemberType });
    }
  }
}

for (const e of dump.Enums) {
  tally.enums.total += 1;
  if (apiDataSrc.includes(`"${e.Name}":`)) tally.enums.covered += 1;
}

const totalEntries =
  tally.classProperties.total
  + tally.classMethods.total
  + tally.classEvents.total
  + tally.classCallbacks.total
  + tally.enums.total;
const totalCovered =
  tally.classProperties.covered
  + tally.classMethods.covered
  + tally.classEvents.covered
  + tally.classCallbacks.covered
  + tally.enums.covered;
const totalExcluded =
  tally.classProperties.excluded
  + tally.classMethods.excluded
  + tally.classEvents.excluded
  + tally.classCallbacks.excluded;
const totalMissing =
  tally.classProperties.missing
  + tally.classMethods.missing
  + tally.classEvents.missing
  + tally.classCallbacks.missing;

console.log(`API-Dump.json coverage report`);
console.log(`Total API entries: ${totalEntries}`);
console.log(`  covered:  ${totalCovered} (${((totalCovered / totalEntries) * 100).toFixed(1)}%)`);
console.log(`  excluded: ${totalExcluded} (${((totalExcluded / totalEntries) * 100).toFixed(1)}%)`);
console.log(`  missing:  ${totalMissing} (${((totalMissing / totalEntries) * 100).toFixed(1)}%)`);
console.log(``);
console.log(`By category:`);
for (const [k, v] of Object.entries(tally)) {
  if (k === 'enums') {
    console.log(`  ${k.padEnd(20)} total=${v.total}  covered=${v.covered}`);
  } else {
    console.log(`  ${k.padEnd(20)} total=${v.total}  covered=${v.covered}  excluded=${v.excluded}  missing=${v.missing}`);
  }
}
if (missing.length > 0) {
  console.log(`\nFirst 20 missing entries:`);
  for (const m of missing.slice(0, 20)) {
    console.log(`  ${m.kind.padEnd(10)} ${m.class}.${m.member}`);
  }
}
