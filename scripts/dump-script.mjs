import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const parserMod = await import(pathToFileURL('C:/Users/tonyt/Desktop/projects/rbx-web/packages/runtime/dist/rbxl-binary.js').href);
const bytes = readFileSync('C:/Users/tonyt/Desktop/thisisatest.rbxl');
const roots = parserMod.parseRbxlBinaryToIR(bytes);
const targetSubstr = process.argv[2];
let found = 0;
function walk(n, p) {
  const name = n.properties?.Name ?? '?';
  const here = `${p}/${name}`;
  if (typeof n.properties?.Source === 'string' && n.properties.Source.length > 0 && here.includes(targetSubstr)) {
    found++;
    console.log(`=== ${here} ===`);
    console.log(n.properties.Source);
    console.log();
  }
  for (const c of n.children ?? []) walk(c, here);
}
for (const r of roots) walk(r, '');
console.error(`(found ${found})`);
