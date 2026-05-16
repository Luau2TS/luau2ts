// Compile every script in the rbxl, then for each TS-error message,
// dump the script path, the source loc range, and a window of EMITTED
// TS around the reported line so I can see what the compiler actually
// wrote.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const parserMod = await import(pathToFileURL('C:/Users/tonyt/Desktop/projects/rbx-web/packages/runtime/dist/rbxl-binary.js').href);
const { compile } = await import('../dist/index.js');
const bytes = readFileSync('C:/Users/tonyt/Desktop/thisisatest.rbxl');
const roots = parserMod.parseRbxlBinaryToIR(bytes);
const scripts = [];
function walk(n, p) { const name = n.properties?.Name ?? '?'; const here = `${p}/${name}`; if (typeof n.properties?.Source === 'string' && n.properties.Source.length > 0) scripts.push({ path: here, source: n.properties.Source }); for (const c of n.children ?? []) walk(c, here); }
for (const r of roots) walk(r, '');
const filterRe = new RegExp(process.argv[2] ?? '.', 'i');
let limit = Number(process.argv[3] ?? 20);
outer: for (const s of scripts) {
  const r = await compile(s.source, { sourceFile: s.path, pretty: false, compatMode: 'rbxts' });
  const emit = r.source ?? '';
  const emitLines = emit.split('\n');
  for (const e of r.errors ?? []) {
    const msg = e.message ?? '';
    if (!filterRe.test(msg)) continue;
    const ln = e.loc?.start?.line ?? 0;
    const ctx = emitLines.slice(Math.max(0, ln - 3), ln + 1).join('\n');
    console.log(`${s.path}  emit:${ln}  ${msg}`);
    console.log(ctx.replace(/^/gm, '    '));
    console.log();
    if (--limit <= 0) break outer;
  }
}
