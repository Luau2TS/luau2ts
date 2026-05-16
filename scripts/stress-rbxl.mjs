#!/usr/bin/env node
// Stress-test the compiler against every Luau script inside an rbxl file.
// Reuses rbx-web's binary place parser (the standalone luau2ts repo has no
// rbxl parser of its own; rbx-web's lives in @rbx-web/runtime).
//
// Reports per-script:
//   - parse errors (count)
//   - TS layer A errors (count)
//   - Luau layer B errors (count)
// Aggregates totals and lists worst offenders so we can see which inputs
// the compiler chokes on.
//
// Usage: node scripts/stress-rbxl.mjs <path-to-rbxl> [--limit N] [--verbose]

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import process from 'node:process';

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('usage: stress-rbxl.mjs <path-to-rbxl> [--limit N] [--verbose] [--mode native|rbxts]');
  process.exit(1);
}

const rbxlPath = resolve(args[0]);
const verbose = args.includes('--verbose');
const limitIdx = args.indexOf('--limit');
const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) : Infinity;
const modeIdx = args.indexOf('--mode');
const compatMode = modeIdx >= 0 ? args[modeIdx + 1] : 'native';
const dumpIdx = args.indexOf('--dump');
const dumpDir = dumpIdx >= 0 ? resolve(args[dumpIdx + 1]) : null;

// Pull rbx-web's parser through its workspace path. We import the source
// TS file via tsx isn't available here, so use the built dist.
const parserModule = await import(
  'file:///' + resolve(
    'C:/Users/tonyt/Desktop/projects/rbx-web/packages/runtime/dist/rbxl-binary.js'
  ).replace(/\\/g, '/')
);
const { parseRbxlBinaryToIR } = parserModule;

const { compile } = await import('../dist/index.js');

const bytes = readFileSync(rbxlPath);
console.log(`[stress] parsing ${rbxlPath} (${bytes.length} bytes)`);
const roots = parseRbxlBinaryToIR(bytes);
console.log(`[stress] ${roots.length} top-level instance(s)`);

// Walk the instance tree collecting every Source-carrying instance.
const scripts = [];
function walk(node, path) {
  const className = node.className ?? '';
  const name = typeof node.properties?.Name === 'string' ? node.properties.Name : '<unnamed>';
  const here = `${path}/${name}`;
  if (typeof node.properties?.Source === 'string' && node.properties.Source.length > 0) {
    scripts.push({ className, name, path: here, source: node.properties.Source });
  }
  for (const child of node.children ?? []) walk(child, here);
}
for (const root of roots) walk(root, '');

console.log(`[stress] found ${scripts.length} scripts with source`);
const targets = scripts.slice(0, limit);
console.log(`[stress] compiling ${targets.length} (limit=${Number.isFinite(limit) ? limit : 'all'})\n`);

const stats = {
  ok: 0,
  parse: 0,
  ts: 0,
  luau: 0,
  threw: 0,
  byScript: [],
};

const t0 = Date.now();
for (const s of targets) {
  let result;
  try {
    result = await compile(s.source, { sourceFile: s.path, pretty: false, compatMode });
    if (dumpDir && result.source) {
      // Mirror the script's instance path under dumpDir/. Trim the
      // leading slash so the resolve doesn't escape dumpDir on Windows.
      const safe = s.path.replace(/^\/+/, '').replace(/[<>:"|?*]/g, '_');
      const out = resolve(dumpDir, safe + '.ts');
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, result.source);
    }
  } catch (e) {
    stats.threw++;
    stats.byScript.push({ path: s.path, parse: 0, ts: 0, luau: 0, threw: true, error: e.message });
    if (verbose) console.error(`THREW ${s.path}: ${e.message}`);
    continue;
  }
  let parseErr = 0, tsErr = 0, luauErr = 0;
  for (const e of result.errors ?? []) {
    if (e.message?.startsWith('[ts:')) tsErr++;
    else if (e.message?.startsWith('[luau:')) luauErr++;
    else parseErr++;
  }
  stats.parse += parseErr;
  stats.ts += tsErr;
  stats.luau += luauErr;
  if (parseErr === 0 && tsErr === 0 && luauErr === 0) stats.ok++;
  stats.byScript.push({ path: s.path, parse: parseErr, ts: tsErr, luau: luauErr, threw: false });
  if (verbose && (parseErr + tsErr + luauErr > 0)) {
    console.log(`${s.path}: parse=${parseErr} ts=${tsErr} luau=${luauErr}`);
  }
}
const elapsed = Date.now() - t0;

console.log('\n[stress] summary');
console.log(`  scripts compiled: ${targets.length}`);
console.log(`  clean (no errors): ${stats.ok}`);
console.log(`  threw exceptions: ${stats.threw}`);
console.log(`  total parse errors: ${stats.parse}`);
console.log(`  total TS errors:    ${stats.ts}`);
console.log(`  total Luau errors:  ${stats.luau}`);
console.log(`  elapsed: ${(elapsed / 1000).toFixed(2)}s`);

console.log('\n[stress] worst by TS error count:');
stats.byScript
  .filter((s) => s.ts > 0 || s.threw)
  .sort((a, b) => (b.threw ? 1000 : b.ts) - (a.threw ? 1000 : a.ts))
  .slice(0, 10)
  .forEach((s) => {
    const tag = s.threw ? 'THREW' : `ts=${s.ts}`;
    console.log(`  ${tag} parse=${s.parse} luau=${s.luau} :: ${s.path}`);
  });
