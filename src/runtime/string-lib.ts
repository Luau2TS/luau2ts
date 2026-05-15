import { LuaError } from './pcall.js';
import { patternFind, patternGmatch, patternGsub } from './pattern.js';

// ─── Position helpers ───────────────────────────────────────────────────────

/** Translate a Lua 1-indexed position (with negative wrap-from-end) to a JS 0-indexed clamp. */
function toIndex(pos: number, len: number, isStart: boolean): number {
  if (pos === 0) return 0;
  if (pos < 0) pos = len + pos + 1;
  if (pos < 1) pos = 1;
  if (pos > len) pos = len + (isStart ? 1 : 0);
  return pos - 1;
}

// ─── Basic string ops ───────────────────────────────────────────────────────

export function stringLen(s: any): number {
  return new TextEncoder().encode(s).length;
}

export function stringUpper(s: any): string {
  return s.toUpperCase();
}

export function stringLower(s: any): string {
  return s.toLowerCase();
}

export function stringSub(s: any, i: number, j: number = -1): string {
  const len = s.length;
  const start = toIndex(i, len, true);
  const end = toIndex(j, len, false) + 1;
  if (start >= end) return '';
  return s.slice(start, end);
}

export function stringRep(s: any, n: number, sep?: string): string {
  if (n <= 0) return '';
  if (!sep) return s.repeat(n);
  return new Array<string>(n).fill(s).join(sep);
}

export function stringReverse(s: any): string {
  return [...s].reverse().join('');
}

export function stringByte(s: any, i = 1, j: number = i): number[] {
  const len = s.length;
  const start = toIndex(i, len, true);
  const end = toIndex(j, len, false);
  const out: number[] = [];
  for (let k = start; k <= end && k < len; k += 1) out.push(s.charCodeAt(k));
  return out;
}

export function stringChar(...codes: number[]): string {
  return String.fromCharCode(...codes);
}

// ─── Pattern functions ──────────────────────────────────────────────────────

/**
 * Lua's `string.find`. Returns [start, end, ...captures] (1-indexed) or
 * undefined on no match. With `plain=true`, treats `pattern` as a literal
 * substring (no Lua pattern interpretation).
 */
export function stringFind(
  s: any,
  pattern: any,
  init = 1,
  plain = false,
): [number, number, ...(string | number)[]] | undefined {
  const startIdx = toIndex(init, s.length, true);
  if (plain) {
    const idx = s.indexOf(pattern, startIdx);
    if (idx === -1) return undefined;
    return [idx + 1, idx + pattern.length];
  }
  const m = patternFind(pattern, s, startIdx);
  if (!m) return undefined;
  return [m.start + 1, m.end, ...m.captures];
}

/**
 * Lua's `string.match`. Returns the first capture (or whole match if no
 * captures), undefined if no match.
 */
export function stringMatch(
  s: any,
  pattern: any,
  init = 1,
): string | number | (string | number)[] | undefined {
  const startIdx = toIndex(init, s.length, true);
  const m = patternFind(pattern, s, startIdx);
  if (!m) return undefined;
  if (m.captures.length === 0) return m.match;
  if (m.captures.length === 1) return m.captures[0];
  return m.captures;
}

/** Lua's `string.gmatch`. Iterate captures (or whole match) per occurrence. */
export function stringGmatch(
  s: any,
  pattern: any,
): () => string | (string | number)[] | undefined {
  const it = patternGmatch(pattern, s);
  return () => {
    const r = it.next();
    return r.done ? undefined : r.value;
  };
}

/**
 * Lua's `string.gsub`. Returns [resultString, replacementCount].
 */
export function stringGsub(
  s: any,
  pattern: any,
  repl:
    | string
    | ((match: string, ...captures: (string | number)[]) => string)
    | Record<string, string>,
  n?: number,
): [string, number] {
  const { result, count } = patternGsub(pattern, s, repl, n);
  return [result, count];
}

// ─── string.format ──────────────────────────────────────────────────────────

/**
 * Lua's `string.format`. Supports printf-style %d/%i/%u, %f/%g/%e, %s, %q,
 * %x/%X, %o, %c, %%. Width, precision, and flags (- + 0 #) are honored.
 */
export function stringFormat(fmt: any, ...args: unknown[]): string {
  let out = '';
  let argIdx = 0;
  let i = 0;
  while (i < fmt.length) {
    const ch = fmt[i]!;
    if (ch !== '%') {
      out += ch;
      i += 1;
      continue;
    }
    // Parse [flags][width][.precision][specifier]
    let spec = '';
    i += 1;
    // Flags
    while (i < fmt.length && '-+ 0#'.includes(fmt[i]!)) {
      spec += fmt[i]!;
      i += 1;
    }
    // Width
    while (i < fmt.length && fmt[i]! >= '0' && fmt[i]! <= '9') {
      spec += fmt[i]!;
      i += 1;
    }
    // Precision
    if (fmt[i] === '.') {
      spec += '.';
      i += 1;
      while (i < fmt.length && fmt[i]! >= '0' && fmt[i]! <= '9') {
        spec += fmt[i]!;
        i += 1;
      }
    }
    const verb = fmt[i];
    if (verb === undefined) throw new LuaError(`invalid format string '${fmt}'`);
    i += 1;
    if (verb === '%') {
      out += '%';
      continue;
    }
    const arg = args[argIdx++];
    out += formatOne(spec, verb, arg);
  }
  return out;
}

function formatOne(spec: string, verb: string, arg: unknown): string {
  switch (verb) {
    case 'd':
    case 'i':
      return formatNumeric(spec, Math.trunc(Number(arg)), 10);
    case 'u':
      return formatNumeric(spec, Math.abs(Math.trunc(Number(arg))), 10);
    case 'x':
      return formatNumeric(spec, Math.trunc(Number(arg)), 16);
    case 'X':
      return formatNumeric(spec, Math.trunc(Number(arg)), 16).toUpperCase();
    case 'o':
      return formatNumeric(spec, Math.trunc(Number(arg)), 8);
    case 'c':
      return String.fromCharCode(Math.trunc(Number(arg)));
    case 'f':
    case 'F':
      return formatFloat(spec, Number(arg), 'f');
    case 'e':
      return formatFloat(spec, Number(arg), 'e');
    case 'E':
      return formatFloat(spec, Number(arg), 'e').toUpperCase();
    case 'g':
      return formatFloat(spec, Number(arg), 'g');
    case 'G':
      return formatFloat(spec, Number(arg), 'g').toUpperCase();
    case 's': {
      const s = String(arg ?? '');
      return applyWidthPrecision(spec, s, /*isString*/ true);
    }
    case 'q':
      return luaQuote(String(arg ?? ''));
    default:
      throw new LuaError(`invalid conversion '%${verb}' in format`);
  }
}

interface ParsedSpec {
  leftAlign: boolean;
  zeroPad: boolean;
  showSign: boolean;
  spacePad: boolean;
  alt: boolean;
  width: number;
  precision: number;
}

function parseSpec(spec: string): ParsedSpec {
  let i = 0;
  let leftAlign = false;
  let zeroPad = false;
  let showSign = false;
  let spacePad = false;
  let alt = false;
  while (i < spec.length && '-+ 0#'.includes(spec[i]!)) {
    if (spec[i] === '-') leftAlign = true;
    if (spec[i] === '+') showSign = true;
    if (spec[i] === ' ') spacePad = true;
    if (spec[i] === '0') zeroPad = true;
    if (spec[i] === '#') alt = true;
    i += 1;
  }
  let width = 0;
  while (i < spec.length && spec[i]! >= '0' && spec[i]! <= '9') {
    width = width * 10 + (spec[i]!.charCodeAt(0) - 48);
    i += 1;
  }
  let precision = -1;
  if (spec[i] === '.') {
    i += 1;
    precision = 0;
    while (i < spec.length && spec[i]! >= '0' && spec[i]! <= '9') {
      precision = precision * 10 + (spec[i]!.charCodeAt(0) - 48);
      i += 1;
    }
  }
  return { leftAlign, zeroPad, showSign, spacePad, alt, width, precision };
}

function formatNumeric(spec: string, n: number, base: number): string {
  const ps = parseSpec(spec);
  let body = Math.abs(n).toString(base);
  if (ps.precision >= 0) body = body.padStart(ps.precision, '0');
  if (base === 16 && ps.alt && n !== 0) body = `0x${body}`;
  if (base === 8 && ps.alt && body[0] !== '0') body = `0${body}`;
  let sign = '';
  if (n < 0) sign = '-';
  else if (ps.showSign) sign = '+';
  else if (ps.spacePad) sign = ' ';
  return padField(ps, sign + body);
}

function formatFloat(spec: string, n: number, kind: 'f' | 'e' | 'g'): string {
  const ps = parseSpec(spec);
  const prec = ps.precision >= 0 ? ps.precision : 6;
  let body: string;
  if (kind === 'f') body = Math.abs(n).toFixed(prec);
  else if (kind === 'e') body = Math.abs(n).toExponential(prec);
  else body = Math.abs(n).toPrecision(prec || 1);
  let sign = '';
  if (n < 0) sign = '-';
  else if (ps.showSign) sign = '+';
  else if (ps.spacePad) sign = ' ';
  return padField(ps, sign + body);
}

function applyWidthPrecision(spec: string, s: string, isString: boolean): string {
  const ps = parseSpec(spec);
  if (isString && ps.precision >= 0 && ps.precision < s.length) {
    s = s.slice(0, ps.precision);
  }
  return padField(ps, s);
}

function padField(ps: ParsedSpec, s: string): string {
  if (s.length >= ps.width) return s;
  const padCh = ps.zeroPad && !ps.leftAlign ? '0' : ' ';
  return ps.leftAlign ? s.padEnd(ps.width, ' ') : s.padStart(ps.width, padCh);
}

function luaQuote(s: string): string {
  let out = '"';
  for (const c of s) {
    if (c === '"') out += '\\"';
    else if (c === '\\') out += '\\\\';
    else if (c === '\n') out += '\\n';
    else if (c === '\r') out += '\\r';
    else if (c === '\0') out += '\\0';
    else out += c;
  }
  return `${out}"`;
}
