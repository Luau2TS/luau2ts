import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const parserMod = await import(pathToFileURL('C:/Users/tonyt/Desktop/projects/rbx-web/packages/runtime/dist/rbxl-binary.js').href);
const { compile } = await import('../dist/index.js');
const bytes = readFileSync('C:/Users/tonyt/Desktop/thisisatest.rbxl');
const roots = parserMod.parseRbxlBinaryToIR(bytes);
const scripts = [];
function walk(n, p) { const name = n.properties?.Name ?? '?'; const here = `${p}/${name}`; if (typeof n.properties?.Source === 'string' && n.properties.Source.length > 0) scripts.push({ path: here, source: n.properties.Source }); for (const c of n.children ?? []) walk(c, here); }
for (const r of roots) walk(r, '');
const targetRegex = process.argv[2] ?? 'unknown.*not assignable.*number';
const re = new RegExp(targetRegex);
let limit = Number(process.argv[3] ?? 5);
outer: for (const s of scripts) {
  const r = await compile(s.source, { sourceFile: s.path, pretty: false });
  for (const e of r.errors ?? []) {
    if (re.test(e.message ?? '')) {
      const lineNum = e.loc?.start?.line ?? 0;
      const sourceLines = s.source.split('\n');
      const ctx = sourceLines.slice(Math.max(0, lineNum - 2), lineNum + 1).join('\n');
      console.log(`${s.path}:${lineNum}:`);
      console.log(`  err: ${e.message}`);
      console.log(`  src: ${ctx.replace(/\n/g, '\n       ')}`);
      console.log();
      if (--limit <= 0) break outer;
    }
  }
}
