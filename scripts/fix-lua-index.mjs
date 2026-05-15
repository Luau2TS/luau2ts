#!/usr/bin/env node
// One-shot migration: replace the broken inline `-1` index transform
// emitted by older luau-to-ts versions with a `luaIndex(t, k)` helper
// call. See packages/luau-to-ts/src/runtime/index-helper.ts for the
// reason this matters (developer-product / asset-id dictionary lookups
// silently returned undefined under the old transform).
//
// Usage: node fix-lua-index.mjs <dir-or-file> [...more]
//
// Idempotent: a second run after the fix is applied is a no-op.

import { readFileSync, writeFileSync, statSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('usage: fix-lua-index.mjs <ts-file-or-dir> [more...]');
  process.exit(1);
}

let total = 0;
let touched = 0;
for (const arg of args) {
  walk(resolve(arg));
}
console.log(`\n[fix-lua-index] scanned ${total} files, modified ${touched}.`);

function walk(p) {
  const s = statSync(p);
  if (s.isDirectory()) {
    for (const entry of readdirSync(p)) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      walk(join(p, entry));
    }
    return;
  }
  if (!p.endsWith('.ts')) return;
  total++;
  fixFile(p);
}

function fixFile(path) {
  const original = readFileSync(path, 'utf8');
  // Run rewrite up to 8 passes. Each pass handles patterns whose receiver
  // contains no nested unmigrated pattern (i.e. inside-out). Stabilizes
  // when no more progress is possible.
  let current = original;
  for (let pass = 0; pass < 8; pass++) {
    const next = rewrite(current);
    if (next === current) break;
    current = next;
  }
  if (current === original) return;
  writeFileSync(path, current);
  touched++;
  console.log(`[fix-lua-index] patched ${path}`);
}

// Find every occurrence of `[(typeof X === "number" ? X - 1 : X)]` and
// replace `RECEIVER[(typeof X === "number" ? X - 1 : X)]` with
// `luaIndex(RECEIVER, X)`. RECEIVER is captured by walking backward over a
// balanced expression (member chains, function calls, bracket accesses).
function rewrite(src) {
  const innerRe = /\[\(typeof ([\w$.]+) === "number" \? \1 - 1 : \1\)\]/g;
  let out = '';
  let cursor = 0;
  let m;
  let helpersUsed = new Set();
  while ((m = innerRe.exec(src)) !== null) {
    const keyExpr = m[1];
    const matchStart = m.index;
    const matchEnd = matchStart + m[0].length;
    // If a previous write rewrite already consumed past this position
    // (RHS swallowed up to the next `;`), skip — that text is gone.
    if (matchStart < cursor) continue;
    const receiverStart = findReceiverStart(src, matchStart);
    if (receiverStart < 0) continue;
    const receiver = src.slice(receiverStart, matchStart);
    if (!receiver.trim()) continue;
    // Skip chained accesses like `A[k1][k2] = v` — the receiver still
    // contains an inline `[(typeof ...)]` that would interact badly with
    // a second pass of this rewriter. These are uncommon in the patterns
    // we care about (developer-product / asset-id dictionary lookups are
    // single-level); leaving them as-is preserves existing behavior.
    if (/\[\(typeof /.test(receiver)) continue;

    // Detect assignment target: `... =` (but not `==` or `===`) follows
    // the bracket access. Allowed: simple `=`, `+=`, `-=`, `*=`, `/=`,
    // `..=`, `%=`. Walk forward past whitespace.
    const assignment = detectAssignment(src, matchEnd);

    out += src.slice(cursor, receiverStart);
    if (assignment) {
      // For compound assignments, expand to plain `=` form, e.g.
      //   t[k] += v  →  luaIndexSet(t, k, luaIndex(t, k) + v)
      // Plain `=` is the common case and the simpler shape.
      const rhsParse = parseAssignmentRhs(src, assignment.opEnd);
      if (!rhsParse) continue;
      const rhs = rhsParse.expr;
      const after = rhsParse.end;
      let value;
      if (assignment.op === '=') {
        value = rhs;
      } else {
        const binop = assignment.op.replace('=', '');
        value = `luaIndex(${receiver}, ${keyExpr}) ${binop} (${rhs})`;
        helpersUsed.add('luaIndex');
      }
      out += `luaIndexSet(${receiver}, ${keyExpr}, ${value})`;
      helpersUsed.add('luaIndexSet');
      cursor = after;
    } else {
      out += `luaIndex(${receiver}, ${keyExpr})`;
      helpersUsed.add('luaIndex');
      cursor = matchEnd;
    }
  }
  if (helpersUsed.size === 0) return src;
  out += src.slice(cursor);
  for (const h of helpersUsed) out = ensureImport(out, h);
  return out;
}

// Inspect what follows the closing `]` to see if this is an assignment.
// Returns `{ op, opEnd }` where opEnd is the position after the operator,
// or null if not an assignment.
function detectAssignment(src, after) {
  let i = after;
  while (i < src.length && /\s/.test(src[i])) i++;
  if (i >= src.length) return null;
  // Single `=` not `==` not `===`. Compound ops end in `=` too.
  // Check for two-char ops first: `+=`, `-=`, `*=`, `/=`, `%=`.
  const two = src.slice(i, i + 2);
  if (['+=', '-=', '*=', '/=', '%='].includes(two)) {
    return { op: two, opEnd: i + 2 };
  }
  if (src[i] === '=' && src[i + 1] !== '=' && src[i - 1] !== '!') {
    return { op: '=', opEnd: i + 1 };
  }
  return null;
}

// Read a balanced RHS expression starting at `start`. Stops at the first
// top-level `;` or newline that ends a statement. Returns { expr, end }.
function parseAssignmentRhs(src, start) {
  let i = start;
  while (i < src.length && /\s/.test(src[i])) i++;
  const exprStart = i;
  let depthRound = 0, depthSquare = 0, depthCurly = 0;
  let inStr = null;
  for (; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      if (c === '\\') { i++; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === '(') depthRound++;
    else if (c === ')') depthRound--;
    else if (c === '[') depthSquare++;
    else if (c === ']') depthSquare--;
    else if (c === '{') depthCurly++;
    else if (c === '}') depthCurly--;
    else if (c === ';' && depthRound === 0 && depthSquare === 0 && depthCurly === 0) {
      return { expr: src.slice(exprStart, i).trim(), end: i };
    }
    if (depthRound < 0 || depthSquare < 0 || depthCurly < 0) {
      return { expr: src.slice(exprStart, i).trim(), end: i };
    }
  }
  return null;
}

// Walk backward from `bracketAt` (the position of `[`) to the start of the
// receiver expression. Skips balanced parens/brackets and member-access
// chains (identifiers, dots, optional chaining). Returns -1 if it can't
// find a clean start.
function findReceiverStart(src, bracketAt) {
  let i = bracketAt - 1;
  // Walk through the receiver expression character-by-character, going
  // backward. Allowed tokens: identifiers, `.`, `?.`, balanced `(...)`,
  // balanced `[...]`. Stop when we hit something that can't be part of a
  // receiver expression (whitespace, operators, statement boundaries).
  let lastValid = bracketAt;
  while (i >= 0) {
    const c = src[i];
    if (c === ')') {
      const open = findMatchingOpen(src, i, '(', ')');
      if (open < 0) return -1;
      i = open - 1;
      lastValid = open;
      continue;
    }
    if (c === ']') {
      const open = findMatchingOpen(src, i, '[', ']');
      if (open < 0) return -1;
      i = open - 1;
      lastValid = open;
      continue;
    }
    if (/[\w$.]/.test(c)) {
      lastValid = i;
      i--;
      continue;
    }
    if (c === '?' && src[i + 1] === '.') {
      // optional chaining `?.` — counted with the dot
      lastValid = i;
      i--;
      continue;
    }
    break;
  }
  return lastValid;
}

function findMatchingOpen(src, closeAt, open, close) {
  let depth = 1;
  for (let j = closeAt - 1; j >= 0; j--) {
    const c = src[j];
    if (c === close) depth++;
    else if (c === open) {
      depth--;
      if (depth === 0) return j;
    }
  }
  return -1;
}

// Ensure the named symbol is part of the import line for
// `luau2ts/runtime` in `src`. If the import line exists and
// the symbol is missing, insert it (sorted-ish — between `lualen` and
// `next` if those are present, otherwise at the end of the imported names).
function ensureImport(src, symbol) {
  const importRe = /import\s*\{\s*([^}]*)\s*\}\s*from\s*['"]@rbx-web\/luau-to-ts\/runtime['"];?/;
  const m = importRe.exec(src);
  if (!m) {
    // No existing import — add one at the top.
    const insertion = `import { ${symbol} } from 'luau2ts/runtime';\n`;
    return insertion + src;
  }
  const names = m[1].split(',').map((s) => s.trim()).filter(Boolean);
  if (names.includes(symbol)) return src;
  names.push(symbol);
  names.sort();
  const updated = `import { ${names.join(', ')} } from 'luau2ts/runtime';`;
  return src.replace(importRe, updated);
}
