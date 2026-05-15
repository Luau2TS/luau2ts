import createLuauParserModule, { type EmModule } from './wasm/luau-parser.mjs';
import type { ParseResult } from './types.js';

export * from './types.js';

let modulePromise: Promise<EmModule> | null = null;

function loadModule(): Promise<EmModule> {
  modulePromise ??= createLuauParserModule();
  return modulePromise;
}

/** Strip the experimental Luau native-integer suffix `i` from numeric
 *  literals (e.g. `123i` → `123`). Released Luau parsers gate this on an
 *  FFlag; our prebuilt WASM rejects it as "Malformed number". JavaScript
 *  numbers don't distinguish int from float, so the runtime semantics are
 *  unchanged once stripped. We rewrite outside string and comment regions
 *  to avoid clobbering identifiers that happen to end in a digit-then-i. */
function stripNativeIntegerSuffix(source: string): string {
  let out = '';
  let i = 0;
  const n = source.length;
  while (i < n) {
    const ch = source[i]!;
    // Single-line comment `-- ...`
    if (ch === '-' && source[i + 1] === '-') {
      // Detect long bracket level for block comment `--[==[ ... ]==]`
      if (source[i + 2] === '[') {
        let j = i + 3;
        let level = 0;
        while (source[j] === '=') { level++; j++; }
        if (source[j] === '[') {
          // Long-bracket comment.
          const close = ']' + '='.repeat(level) + ']';
          const end = source.indexOf(close, j + 1);
          const stop = end < 0 ? n : end + close.length;
          out += source.slice(i, stop);
          i = stop;
          continue;
        }
      }
      const eol = source.indexOf('\n', i);
      const stop = eol < 0 ? n : eol;
      out += source.slice(i, stop);
      i = stop;
      continue;
    }
    // Long-bracket string `[=*[ ... ]=*]`
    if (ch === '[') {
      let j = i + 1;
      let level = 0;
      while (source[j] === '=') { level++; j++; }
      if (source[j] === '[') {
        const close = ']' + '='.repeat(level) + ']';
        const end = source.indexOf(close, j + 1);
        const stop = end < 0 ? n : end + close.length;
        out += source.slice(i, stop);
        i = stop;
        continue;
      }
    }
    // Short string literals `"..."` / `'...'`
    if (ch === '"' || ch === "'") {
      const quote = ch;
      let j = i + 1;
      while (j < n) {
        const c = source[j]!;
        if (c === '\\') { j += 2; continue; }
        if (c === quote || c === '\n') { j++; break; }
        j++;
      }
      out += source.slice(i, j);
      i = j;
      continue;
    }
    // Backtick interpolated string — `...{expr}...`. Recurse on `expr`s
    // by simply scanning until matching backtick respecting brace depth.
    if (ch === '`') {
      let j = i + 1;
      let depth = 0;
      while (j < n) {
        const c = source[j]!;
        if (c === '\\') { j += 2; continue; }
        if (depth === 0 && c === '`') { j++; break; }
        if (c === '{') depth++;
        else if (c === '}') depth--;
        j++;
      }
      out += source.slice(i, j);
      i = j;
      continue;
    }
    // Numeric literal followed by `i` suffix. Match Luau-style numbers
    // (decimal, hex, binary), then drop a trailing `i` if it's not part
    // of a longer identifier.
    const numMatch = /^(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)/.exec(source.slice(i));
    if (numMatch && /[a-zA-Z_]/.test(source[Math.max(0, i - 1)] ?? '') === false) {
      const lit = numMatch[0];
      const after = source[i + lit.length];
      if (after === 'i' && !/[a-zA-Z0-9_]/.test(source[i + lit.length + 1] ?? '')) {
        out += lit;
        i += lit.length + 1;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

// Old Roblox scripts often contain backslash escapes that modern Luau rejects
// as invalid (e.g. `"rbxasset://textures\GunCursor.png"` — `\G` is not a
// recognized escape). The legacy parser silently dropped the backslash.
// Replace `\<unrecognized>` inside short string literals with just the
// character so these scripts continue to parse. Long-bracket strings don't
// process escapes at all, so they're left alone.
function normalizeStringEscapes(source: string): string {
  const VALID = /[abfnrtvxzu\\"'\r\n0-9]/;
  let out = '';
  let i = 0;
  const n = source.length;
  while (i < n) {
    const ch = source[i]!;
    if (ch === '-' && source[i + 1] === '-') {
      const eol = source.indexOf('\n', i);
      const stop = eol < 0 ? n : eol;
      out += source.slice(i, stop);
      i = stop;
      continue;
    }
    if (ch === '[') {
      let j = i + 1;
      while (source[j] === '=') j++;
      if (source[j] === '[') {
        const level = j - i - 1;
        const close = ']' + '='.repeat(level) + ']';
        const end = source.indexOf(close, j + 1);
        const stop = end < 0 ? n : end + close.length;
        out += source.slice(i, stop);
        i = stop;
        continue;
      }
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      out += ch;
      i++;
      while (i < n) {
        const c = source[i]!;
        if (c === '\\') {
          const nx = source[i + 1] ?? '';
          if (VALID.test(nx)) {
            out += c + nx;
            i += 2;
          } else {
            out += nx;
            i += 2;
          }
          continue;
        }
        if (c === quote || c === '\n') {
          out += c;
          i++;
          break;
        }
        out += c;
        i++;
      }
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

export async function parse(source: string): Promise<ParseResult> {
  const m = await loadModule();
  source = stripNativeIntegerSuffix(source);
  source = normalizeStringEscapes(source);
  const bytes = new TextEncoder().encode(source);
  const ptr = m._malloc(bytes.length);
  if (!ptr) {
    throw new Error('luau-parser: malloc failed');
  }
  let resultPtr = 0;
  try {
    m.HEAPU8.set(bytes, ptr);
    resultPtr = m._luau_parse(ptr, bytes.length);
    if (!resultPtr) {
      throw new Error('luau-parser: parse returned null');
    }
    const json = m.UTF8ToString(resultPtr);
    // The WASM glue serializes numbers via std::ostream, which emits `inf`,
    // `-inf`, `nan`, `-nan` for non-finite floats — none of which are valid
    // JSON. Substitute IEEE 754-equivalent literals so JSON.parse succeeds
    // (1e9999 overflows to Infinity in JS; null is the closest stand-in for
    // NaN since JSON has no distinct NaN literal).
    const sanitized = json
      .replace(/:\s*-inf\b/g, ':-1e9999')
      .replace(/:\s*inf\b/g, ':1e9999')
      .replace(/:\s*-?nan\b/g, ':null');
    return JSON.parse(sanitized) as ParseResult;
  } finally {
    if (resultPtr) m._luau_free(resultPtr);
    m._free(ptr);
  }
}
