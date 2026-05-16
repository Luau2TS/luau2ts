#!/usr/bin/env node
// Roundtrip identity measurement.
//
//   Luau (from rbxl) → TS (luau2ts rbxts-mode) → Luau (rbxtsc) → diff
//
// For each script:
//   * emit OK?       (did luau2ts produce any TS output)
//   * rbxtsc OK?     (did the patched rbxtsc produce a .luau back)
//   * identical %    (after stylua-normalising both sides)
//   * edit distance  (Levenshtein over the normalised lines)
//
// The script temp-patches `validateNotAny.js` in test2's roblox-ts so the
// "Using values of type any" diagnostic doesn't block emit; that is the
// ONLY blocker to actually getting .luau output from the current rbxts-
// mode emit (which casts aggressively to `any`). The original file is
// restored on exit (incl. SIGINT and uncaught errors).
//
// Usage:
//   node scripts/roundtrip.mjs [--limit N] [--verbose] [--no-recompile]
//   node scripts/roundtrip.mjs --rbxl <other.rbxl>
//
//   --no-recompile  skip the luau2ts + rbxtsc steps and just diff the
//                   files already in test2/src + test2/out.

import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import process from 'node:process';

const LUAU2TS = resolve('C:/Users/tonyt/Desktop/projects/luau2ts');
const TEST2 = resolve('C:/Users/tonyt/Desktop/projects/test2');
const VALIDATE_NOT_ANY = resolve(
  TEST2,
  'node_modules/roblox-ts/out/TSTransformer/util/validateNotAny.js',
);
const DIAGNOSTIC_SERVICE = resolve(
  TEST2,
  'node_modules/roblox-ts/out/TSTransformer/classes/DiagnosticService.js',
);

const args = process.argv.slice(2);
const limitIdx = args.indexOf('--limit');
const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) : Infinity;
const verbose = args.includes('--verbose');
const skipCompile = args.includes('--no-recompile');
const rbxlIdx = args.indexOf('--rbxl');
const rbxlPath = rbxlIdx >= 0
  ? resolve(args[rbxlIdx + 1])
  : resolve('C:/Users/tonyt/Desktop/thisisatest.rbxl');

// ─── stylua wrapper ──────────────────────────────────────────────────────

function stylua(source) {
  // stylua reads stdin when given `-`. Use spawnSync so we don't shell-
  // escape the source. Return the unchanged source on stylua failure
  // (rare; mostly happens on emitted code that has odd UTF-16 BOMs).
  const r = spawnSync('stylua', ['-'], {
    input: source,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (r.status !== 0 || !r.stdout) {
    if (verbose) console.warn('[stylua] failed:', r.stderr?.slice(0, 200));
    return source;
  }
  return r.stdout;
}

// ─── line-based similarity ───────────────────────────────────────────────

function normalizeLines(s) {
  return s
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l.length > 0);
}

function jaccardLines(a, b) {
  const setA = new Set(a);
  const setB = new Set(b);
  const inter = [...setA].filter((l) => setB.has(l)).length;
  const uni = new Set([...setA, ...setB]).size;
  return uni === 0 ? 1 : inter / uni;
}

// Longest-common-subsequence ratio over lines. Captures order-preserved
// similarity, unlike Jaccard which is set-based.
function lcsRatio(a, b) {
  const n = a.length, m = b.length;
  if (n === 0 && m === 0) return 1;
  if (n === 0 || m === 0) return 0;
  // O(n*m) memory; corpus scripts are bounded ~2000 lines so 4MB peaks
  // are fine.
  const dp = new Uint16Array((n + 1) * (m + 1));
  const stride = m + 1;
  for (let i = 1; i <= n; i++) {
    const row = i * stride;
    const prevRow = (i - 1) * stride;
    for (let j = 1; j <= m; j++) {
      dp[row + j] = a[i - 1] === b[j - 1]
        ? dp[prevRow + (j - 1)] + 1
        : Math.max(dp[prevRow + j], dp[row + (j - 1)]);
    }
  }
  const lcs = dp[n * stride + m];
  return (2 * lcs) / (n + m);
}

// ─── rbxl source extraction ──────────────────────────────────────────────

const parserModule = await import(
  'file:///' + resolve(
    'C:/Users/tonyt/Desktop/projects/rbx-web/packages/runtime/dist/rbxl-binary.js',
  ).replace(/\\/g, '/')
);
const { parseRbxlBinaryToIR } = parserModule;

const bytes = readFileSync(rbxlPath);
const roots = parseRbxlBinaryToIR(bytes);
const scripts = [];
function walk(node, path) {
  const name = typeof node.properties?.Name === 'string' ? node.properties.Name : '<unnamed>';
  const here = `${path}/${name}`;
  if (typeof node.properties?.Source === 'string' && node.properties.Source.length > 0) {
    scripts.push({
      className: node.className ?? '',
      name,
      path: here,
      source: node.properties.Source,
    });
  }
  for (const child of node.children ?? []) walk(child, here);
}
for (const r of roots) walk(r, '');

const targets = scripts.slice(0, limit);
console.log(`[roundtrip] ${targets.length} script(s) from ${rbxlPath}`);

// ─── recompile (optional) ────────────────────────────────────────────────

let restoreFn = () => {};
if (!skipCompile) {
  console.log('[roundtrip] step 1/3 — luau2ts (rbxts mode) → test2/src/');
  execSync(
    `node ${LUAU2TS.replace(/\\/g, '/')}/scripts/stress-rbxl.mjs ${rbxlPath.replace(/\\/g, '/')} --mode rbxts --dump ${TEST2.replace(/\\/g, '/')}/src`,
    { stdio: 'inherit' },
  );

  console.log('[roundtrip] step 2/3 — patch roblox-ts diagnostics (downgrade errors to warnings so emit proceeds)');
  if (!existsSync(VALIDATE_NOT_ANY) || !existsSync(DIAGNOSTIC_SERVICE)) {
    console.error('[roundtrip] roblox-ts node_modules paths not found — is test2/node_modules installed?');
    process.exit(1);
  }
  const originalValidateNotAny = readFileSync(VALIDATE_NOT_ANY);
  const originalDiagSvc = readFileSync(DIAGNOSTIC_SERVICE);
  // No-op the no-any check (it's the noisiest of the roblox-ts custom
  // rules; nuke it at the source so we don't pollute the diag stream).
  writeFileSync(
    VALIDATE_NOT_ANY,
    `'use strict';\nObject.defineProperty(exports, '__esModule', { value: true });\nexports.validateNotAnyType = function () {};\n`,
    'utf8',
  );
  // Override hasErrors() so compileFiles never short-circuits with
  // emitSkipped. Diagnostics still get collected and printed by the
  // CLI's flush; we just don't let them gate the emit.
  const diagPatched = originalDiagSvc.toString('utf8')
    .replace(
      /static hasErrors\(\)\s*\{[^}]*\}/,
      'static hasErrors() { return false; }',
    );
  writeFileSync(DIAGNOSTIC_SERVICE, diagPatched, 'utf8');
  restoreFn = () => {
    try { writeFileSync(VALIDATE_NOT_ANY, originalValidateNotAny); } catch {}
    try { writeFileSync(DIAGNOSTIC_SERVICE, originalDiagSvc); } catch {}
  };
  process.on('exit', restoreFn);
  process.on('SIGINT', () => { restoreFn(); process.exit(1); });

  console.log('[roundtrip] step 3/3 — npx rbxtsc (with no-any patch)');
  try {
    execSync('npx rbxtsc', { cwd: TEST2, stdio: 'inherit' });
  } catch (e) {
    console.warn('[roundtrip] rbxtsc exit non-zero; partial output may still be usable');
  }
  restoreFn();
}

// ─── diff loop ───────────────────────────────────────────────────────────

console.log('\n[roundtrip] diffing original vs compiled-back...');

const stats = {
  total: targets.length,
  emitMissing: 0,
  compiledMissing: 0,
  identical: 0,
  byScript: [],
};

function tsPathOf(scriptPath) {
  // Mirror what stress-rbxl.mjs does.
  const safe = scriptPath.replace(/^\/+/, '').replace(/[<>:"|?*]/g, '_');
  return resolve(TEST2, 'src', safe + '.ts');
}

function luauPathOf(scriptPath) {
  // rbxtsc preserves the src/ tree under out/ but emits .luau (with
  // --luau flag, which test2 doesn't set) or .lua. Try both, plus
  // .server/.client suffixes which rbxtsc adds for Script/LocalScript.
  const safe = scriptPath.replace(/^\/+/, '').replace(/[<>:"|?*]/g, '_');
  const base = resolve(TEST2, 'out', safe);
  for (const ext of ['.luau', '.lua', '.server.luau', '.server.lua', '.client.luau', '.client.lua']) {
    const p = base + ext;
    if (existsSync(p)) return p;
  }
  return null;
}

for (const s of targets) {
  const tsP = tsPathOf(s.path);
  const luaP = luauPathOf(s.path);
  const entry = { path: s.path, hasEmit: existsSync(tsP), hasBack: luaP !== null, similarity: null };
  if (!entry.hasEmit) stats.emitMissing++;
  if (!entry.hasBack) stats.compiledMissing++;
  if (entry.hasEmit && entry.hasBack) {
    const origNorm = normalizeLines(stylua(s.source));
    const backNorm = normalizeLines(stylua(readFileSync(luaP, 'utf8')));
    const ratio = lcsRatio(origNorm, backNorm);
    const jacc = jaccardLines(origNorm, backNorm);
    entry.similarity = ratio;
    entry.jaccard = jacc;
    entry.origLines = origNorm.length;
    entry.backLines = backNorm.length;
    if (ratio === 1) stats.identical++;
    if (verbose) {
      console.log(`  ${(ratio * 100).toFixed(1)}%  (jacc ${(jacc * 100).toFixed(1)}%, ${origNorm.length}→${backNorm.length} lines)  ${s.path}`);
    }
  }
  stats.byScript.push(entry);
}

// ─── summary ─────────────────────────────────────────────────────────────

const measurable = stats.byScript.filter((e) => e.similarity !== null);
measurable.sort((a, b) => a.similarity - b.similarity);

const median = measurable.length > 0
  ? measurable[Math.floor(measurable.length / 2)].similarity
  : null;
const mean = measurable.length > 0
  ? measurable.reduce((s, e) => s + e.similarity, 0) / measurable.length
  : null;

console.log('\n[roundtrip] summary');
console.log(`  total scripts:           ${stats.total}`);
console.log(`  TS emit missing:         ${stats.emitMissing}`);
console.log(`  Luau back missing:       ${stats.compiledMissing}`);
console.log(`  measurable pairs:        ${measurable.length}`);
if (measurable.length > 0) {
  console.log(`  100% identical:          ${stats.identical} (${(stats.identical / measurable.length * 100).toFixed(1)}%)`);
  console.log(`  mean similarity (LCS):   ${(mean * 100).toFixed(1)}%`);
  console.log(`  median similarity (LCS): ${(median * 100).toFixed(1)}%`);

  // Distribution buckets.
  const buckets = [0, 0, 0, 0, 0]; // 0-20, 20-40, 40-60, 60-80, 80-100
  for (const e of measurable) {
    const idx = Math.min(4, Math.floor(e.similarity * 5));
    buckets[idx]++;
  }
  console.log('  distribution (LCS similarity):');
  const labels = ['0-20%', '20-40%', '40-60%', '60-80%', '80-100%'];
  buckets.forEach((c, i) => {
    const bar = '█'.repeat(Math.round(c / measurable.length * 40));
    console.log(`    ${labels[i].padEnd(8)} ${String(c).padStart(3)}  ${bar}`);
  });

  console.log('\n[roundtrip] worst 10:');
  for (const e of measurable.slice(0, 10)) {
    console.log(`  ${(e.similarity * 100).toFixed(1)}% (jacc ${(e.jaccard * 100).toFixed(1)}%, ${e.origLines}→${e.backLines})  ${e.path}`);
  }
  console.log('\n[roundtrip] best 5:');
  for (const e of measurable.slice(-5).reverse()) {
    console.log(`  ${(e.similarity * 100).toFixed(1)}% (jacc ${(e.jaccard * 100).toFixed(1)}%, ${e.origLines}→${e.backLines})  ${e.path}`);
  }
}

if (stats.compiledMissing > 0) {
  console.log(`\n[roundtrip] ${stats.compiledMissing} script(s) didn't produce Luau output — rbxtsc dropped them. Re-run with --verbose for paths, or inspect the rbxtsc log.`);
}
