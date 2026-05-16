import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const parserMod = await import(pathToFileURL('C:/Users/tonyt/Desktop/projects/rbx-web/packages/runtime/dist/rbxl-binary.js').href);
const { compile } = await import('../dist/index.js');
const bytes = readFileSync('C:/Users/tonyt/Desktop/thisisatest.rbxl');
const roots = parserMod.parseRbxlBinaryToIR(bytes);
const scripts = [];
function walk(n, p) { const name = n.properties?.Name ?? '?'; const here = `${p}/${name}`; if (typeof n.properties?.Source === 'string' && n.properties.Source.length > 0) scripts.push({ path: here, source: n.properties.Source }); for (const c of n.children ?? []) walk(c, here); }
for (const r of roots) walk(r, '');
const buckets = new Map();
for (const s of scripts) {
  const r = await compile(s.source, { sourceFile: s.path, pretty: false });
  for (const e of r.errors ?? []) {
    const m = e.message?.match(/^\[(ts:\d+|luau:[A-Za-z]+)\]\s*([^\n]+)/);
    if (!m) continue;
    const key = `${m[1]} :: ${m[2].slice(0, 80)}`;
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }
}
const sorted = [...buckets.entries()].sort((a, b) => b[1] - a[1]).slice(0, 50);
for (const [k, v] of sorted) console.log(`${String(v).padStart(4)}  ${k}`);
