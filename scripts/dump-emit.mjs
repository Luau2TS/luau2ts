import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const parserMod = await import(pathToFileURL('C:/Users/tonyt/Desktop/projects/rbx-web/packages/runtime/dist/rbxl-binary.js').href);
const { compile } = await import('../dist/index.js');
const bytes = readFileSync('C:/Users/tonyt/Desktop/thisisatest.rbxl');
const roots = parserMod.parseRbxlBinaryToIR(bytes);
const targetSubstr = process.argv[2];
function walk(n, p) { const name = n.properties?.Name ?? '?'; const here = `${p}/${name}`; if (typeof n.properties?.Source === 'string' && n.properties.Source.length > 0 && here.includes(targetSubstr)) { compile(n.properties.Source, { sourceFile: here, pretty: false }).then(r => { console.log(`=== ${here} ===`); console.log(r.source); }); return; } for (const c of n.children ?? []) walk(c, here); }
for (const r of roots) walk(r, '');
