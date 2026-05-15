import {
  stringByte,
  stringChar,
  stringFind,
  stringFormat,
  stringGmatch,
  stringGsub,
  stringLen,
  stringLower,
  stringMatch,
  stringRep,
  stringReverse,
  stringSub,
  stringUpper,
} from './string-lib.js';
import {
  tableClear,
  tableClone,
  tableConcat,
  tableFind,
  tableFreeze,
  tableInsert,
  tableIsFrozen,
  tableMaxn,
  tableMove,
  tablePack,
  tableRemove,
  tableSort,
  tableUnpack,
} from './table-lib.js';

// ─── string ─────────────────────────────────────────────────────────────────
// Lua's `string` library. `string.split` is Roblox-specific (Luau extension).

function stringSplit(s: string, sep: string = ','): string[] {
  if (sep.length === 0) return [...s];
  return s.split(sep);
}

export const string = {
  byte: stringByte,
  char: stringChar,
  find: stringFind,
  format: stringFormat,
  gmatch: stringGmatch,
  gsub: stringGsub,
  len: stringLen,
  lower: stringLower,
  match: stringMatch,
  rep: stringRep,
  reverse: stringReverse,
  sub: stringSub,
  upper: stringUpper,
  split: stringSplit,
  // Lua 5.3+ pack/unpack are rarely used in Roblox scripts; expose minimal
  // pass-through that returns the inputs verbatim. Real implementation would
  // need Lua's binary-format mini-language.
  pack: (..._args: unknown[]): string => '',
  unpack: (..._args: unknown[]): unknown[] => [],
  packsize: (_fmt: string): number => 0,
} as const;

// ─── table ──────────────────────────────────────────────────────────────────
// Note: `unpack` is also exported as a global below.

export const table = {
  insert: tableInsert,
  remove: tableRemove,
  concat: tableConcat,
  sort: tableSort,
  unpack: tableUnpack,
  pack: tablePack,
  find: tableFind,
  clear: tableClear,
  clone: tableClone,
  freeze: tableFreeze,
  isfrozen: tableIsFrozen,
  move: tableMove,
  maxn: tableMaxn,
  // Luau-extension: table.create(n, v) → array of n copies of v.
  create<T>(count: number, value?: T): T[] {
    const out: T[] = new Array(count);
    if (value !== undefined) for (let i = 0; i < count; i++) out[i] = value;
    return out;
  },
  // Roblox `table.foreach` / `foreachi` are deprecated in newer Luau.
  foreach<T>(t: Record<string, T>, fn: (k: string, v: T) => void): void {
    for (const k of Object.keys(t)) fn(k, t[k]!);
  },
  foreachi<T>(t: T[], fn: (i: number, v: T) => void): void {
    for (let i = 0; i < t.length; i++) fn(i + 1, t[i]!);
  },
  getn<T>(t: T[]): number {
    return t.length;
  },
} as const;

// ─── math ───────────────────────────────────────────────────────────────────
// Wraps JS Math + Lua-specific extras. `math.random` defaults to JS
// Math.random — scripts that depend on determinism should swap via
// `math.randomseed` to a seeded generator (we keep an LCG as fallback).

let _mathRandomState: number | null = null;

function lcgNext(): number {
  // Same LCG MMIX uses; deterministic when seeded.
  _mathRandomState = ((_mathRandomState! * 6364136223846793005) + 1442695040888963407) >>> 0;
  return _mathRandomState / 0x100000000;
}

function _mathRandomNumber(): number {
  if (_mathRandomState !== null) return lcgNext();
  // eslint-disable-next-line no-restricted-globals
  return Math.random();
}

function _mathRandom(m?: number, n?: number): number {
  const r = _mathRandomNumber();
  if (m === undefined) return r;
  if (n === undefined) return Math.floor(r * Math.floor(m)) + 1;
  return Math.floor(r * (Math.floor(n) - Math.floor(m) + 1)) + Math.floor(m);
}

function _mathRandomSeed(seed: number = 0): void {
  _mathRandomState = (seed | 0) >>> 0;
  // Burn one round so seed=0 doesn't return 0.
  lcgNext();
}

export const math = {
  abs: Math.abs,
  acos: Math.acos,
  asin: Math.asin,
  atan: Math.atan,
  atan2: Math.atan2, // Lua 5.1 alias; Lua 5.3 folded into atan.
  ceil: Math.ceil,
  clamp(x: number, lo: number, hi: number): number {
    return Math.min(Math.max(x, lo), hi);
  },
  cos: Math.cos,
  cosh: Math.cosh,
  deg(x: number): number { return x * (180 / Math.PI); },
  exp: Math.exp,
  floor: Math.floor,
  fmod(x: number, y: number): number { return x - Math.floor(x / y) * y; },
  frexp(x: number): [number, number] {
    if (x === 0) return [0, 0];
    const e = Math.floor(Math.log2(Math.abs(x))) + 1;
    const m = x / Math.pow(2, e);
    return [m, e];
  },
  huge: Infinity,
  ldexp(m: number, e: number): number { return m * Math.pow(2, e); },
  log(x: number, base?: number): number {
    if (base === undefined) return Math.log(x);
    return Math.log(x) / Math.log(base);
  },
  log10(x: number): number { return Math.log10(x); },
  max: Math.max,
  min: Math.min,
  modf(x: number): [number, number] {
    const intPart = x < 0 ? Math.ceil(x) : Math.floor(x);
    return [intPart, x - intPart];
  },
  noise(x: number = 0, y: number = 0, z: number = 0): number {
    // Roblox uses Perlin noise; this is a simple value-noise stand-in
    // returning a deterministic function in [-0.5, 0.5]. Real noise lives
    // in `simplex-noise` if scripts need it.
    const n = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453;
    return (n - Math.floor(n)) - 0.5;
  },
  pi: Math.PI,
  pow(x: number, y: number): number { return Math.pow(x, y); },
  rad(x: number): number { return x * (Math.PI / 180); },
  random: _mathRandom,
  randomseed: _mathRandomSeed,
  round(x: number): number { return Math.round(x); },
  sign(x: number): number { return Math.sign(x); },
  sin: Math.sin,
  sinh: Math.sinh,
  sqrt: Math.sqrt,
  tan: Math.tan,
  tanh: Math.tanh,
  // Luau extensions
  map(x: number, inMin: number, inMax: number, outMin: number, outMax: number): number {
    return outMin + ((x - inMin) / (inMax - inMin)) * (outMax - outMin);
  },
  lerp(a: number, b: number, t: number): number {
    return a + (b - a) * t;
  },
} as const;

// ─── os ─────────────────────────────────────────────────────────────────────
// Browser mode has no real `os` — we fake the time-related calls using the
// underlying Date object. Determinism note: scripts that read `os.time()`
// and use the result for state see different values across runs. Use
// `time()` (simulatedTime) for deterministic behavior.

function _osTime(t?: { year?: number; month?: number; day?: number; hour?: number; min?: number; sec?: number }): number {
  if (!t) return Math.floor(Date.now() / 1000);
  const d = new Date(t.year ?? 1970, (t.month ?? 1) - 1, t.day ?? 1, t.hour ?? 12, t.min ?? 0, t.sec ?? 0);
  return Math.floor(d.getTime() / 1000);
}

function _osDate(format: string = '%c', t?: number): string | Record<string, unknown> {
  const d = t !== undefined ? new Date(t * 1000) : new Date();
  const utc = format.startsWith('!');
  const f = utc ? format.slice(1) : format;
  const get = (kind: 'h' | 'm' | 's' | 'D' | 'M' | 'Y' | 'd' | 'wd'): number => {
    switch (kind) {
      case 'h': return utc ? d.getUTCHours() : d.getHours();
      case 'm': return utc ? d.getUTCMinutes() : d.getMinutes();
      case 's': return utc ? d.getUTCSeconds() : d.getSeconds();
      case 'D': return utc ? d.getUTCDate() : d.getDate();
      case 'M': return (utc ? d.getUTCMonth() : d.getMonth()) + 1;
      case 'Y': return utc ? d.getUTCFullYear() : d.getFullYear();
      case 'd': return Math.ceil(((+d) - +new Date(d.getFullYear(), 0, 0)) / 86400000);
      case 'wd': return utc ? d.getUTCDay() : d.getDay();
    }
  };
  if (f === '*t' || f === '!*t') {
    return {
      year: get('Y'), month: get('M'), day: get('D'),
      hour: get('h'), min: get('m'), sec: get('s'),
      wday: get('wd') + 1, yday: get('d'), isdst: false,
    };
  }
  const pad = (n: number, w = 2): string => String(n).padStart(w, '0');
  return f.replace(/%./g, (m) => {
    switch (m) {
      case '%Y': return String(get('Y'));
      case '%m': return pad(get('M'));
      case '%d': return pad(get('D'));
      case '%H': return pad(get('h'));
      case '%M': return pad(get('m'));
      case '%S': return pad(get('s'));
      case '%j': return pad(get('d'), 3);
      case '%w': return String(get('wd'));
      case '%c': return d.toString();
      case '%x': return `${pad(get('M'))}/${pad(get('D'))}/${pad(get('Y'))}`;
      case '%X': return `${pad(get('h'))}:${pad(get('m'))}:${pad(get('s'))}`;
      case '%%': return '%';
      default: return m;
    }
  });
}

export const os = {
  time: _osTime,
  date: _osDate,
  difftime(t2: number, t1: number): number { return t2 - t1; },
  clock(): number {
    // CPU time in seconds. Browser mode → wall-clock since process start.
    if (typeof performance !== 'undefined') return performance.now() / 1000;
    return Date.now() / 1000;
  },
  getenv(_name: string): string | null { return null; },
} as const;

// ─── bit32 ──────────────────────────────────────────────────────────────────
// 32-bit unsigned integer bitwise ops (Lua 5.2). All operands are coerced
// via `>>> 0` to match Lua's wraparound behavior.

function _u32(x: number): number { return x >>> 0; }

export const bit32 = {
  band(...args: number[]): number {
    let acc = 0xffffffff;
    for (const a of args) acc &= _u32(a);
    return acc >>> 0;
  },
  bor(...args: number[]): number {
    let acc = 0;
    for (const a of args) acc |= _u32(a);
    return acc >>> 0;
  },
  bxor(...args: number[]): number {
    let acc = 0;
    for (const a of args) acc ^= _u32(a);
    return acc >>> 0;
  },
  bnot(x: number): number { return (~_u32(x)) >>> 0; },
  lshift(x: number, n: number): number { return (_u32(x) << (n & 31)) >>> 0; },
  rshift(x: number, n: number): number { return (_u32(x) >>> (n & 31)) >>> 0; },
  arshift(x: number, n: number): number { return (_u32(x) >> (n & 31)) >>> 0; },
  btest(...args: number[]): boolean {
    let acc = 0xffffffff;
    for (const a of args) acc &= _u32(a);
    return acc !== 0;
  },
  extract(n: number, field: number, width: number = 1): number {
    const mask = ((1 << width) - 1) >>> 0;
    return ((_u32(n) >>> field) & mask) >>> 0;
  },
  replace(n: number, v: number, field: number, width: number = 1): number {
    const mask = (((1 << width) - 1) << field) >>> 0;
    return ((_u32(n) & ~mask) | ((v << field) & mask)) >>> 0;
  },
  lrotate(n: number, i: number): number {
    const k = ((i % 32) + 32) % 32;
    return (((_u32(n) << k) | (_u32(n) >>> (32 - k))) >>> 0);
  },
  rrotate(n: number, i: number): number {
    const k = ((i % 32) + 32) % 32;
    return (((_u32(n) >>> k) | (_u32(n) << (32 - k))) >>> 0);
  },
  countlz(n: number): number {
    return Math.clz32(_u32(n));
  },
  countrz(n: number): number {
    const x = _u32(n);
    if (x === 0) return 32;
    return 31 - Math.clz32(x & -x);
  },
} as const;

// ─── utf8 ───────────────────────────────────────────────────────────────────
// Lua's utf8 library. Codepoint indices are 1-based.

export const utf8 = {
  charpattern: '[\0-\x7F\xC2-\xFD][\x80-\xBF]*',
  char(...codes: number[]): string {
    return String.fromCodePoint(...codes);
  },
  codepoint(s: string, i: number = 1, j: number = i): number[] {
    const out: number[] = [];
    let pos = 0;
    let charIdx = 1;
    for (const ch of s) {
      if (charIdx >= i && charIdx <= j) out.push(ch.codePointAt(0)!);
      pos += ch.length;
      charIdx += 1;
      if (charIdx > j) break;
    }
    return out;
  },
  *codes(s: string): Generator<[number, number]> {
    let i = 1;
    let bytePos = 1;
    for (const ch of s) {
      yield [bytePos, ch.codePointAt(0)!];
      bytePos += new TextEncoder().encode(ch).length;
      i += 1;
    }
  },
  len(s: string, _i: number = 1, _j: number = -1): number {
    let n = 0;
    for (const _ of s) n++;
    return n;
  },
  offset(_s: string, _n: number, _i?: number): number | undefined {
    // Roblox/Luau spec returns the byte position of the n-th character.
    // We approximate by walking the string; full byte arithmetic would need
    // TextEncoder per-char.
    let bytePos = 1;
    let count = 0;
    for (const ch of _s) {
      if (count === (_n - 1)) return bytePos;
      bytePos += new TextEncoder().encode(ch).length;
      count++;
    }
    return undefined;
  },
} as const;

// ─── buffer ─────────────────────────────────────────────────────────────────
// Luau's `buffer` library: dense fixed-size byte arrays. Backed by Uint8Array
// + a DataView for unaligned reads/writes. All offsets are 0-based.

export interface LuaBuffer {
  __isLuaBuffer: true;
  bytes: Uint8Array;
  view: DataView;
}

function _isBuf(b: unknown): b is LuaBuffer {
  return !!b && typeof b === 'object' && (b as { __isLuaBuffer?: boolean }).__isLuaBuffer === true;
}

export const buffer = {
  create(size: number): LuaBuffer {
    const ab = new ArrayBuffer(size | 0);
    return { __isLuaBuffer: true, bytes: new Uint8Array(ab), view: new DataView(ab) };
  },
  fromstring(s: string): LuaBuffer {
    const bytes = new TextEncoder().encode(s);
    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    return { __isLuaBuffer: true, bytes: new Uint8Array(ab), view: new DataView(ab) };
  },
  tostring(b: LuaBuffer): string {
    if (!_isBuf(b)) throw new TypeError('buffer.tostring: not a buffer');
    return new TextDecoder().decode(b.bytes);
  },
  len(b: LuaBuffer): number {
    return _isBuf(b) ? b.bytes.length : 0;
  },
  copy(dst: LuaBuffer, dstOff: number, src: LuaBuffer, srcOff: number = 0, count?: number): void {
    if (!_isBuf(dst) || !_isBuf(src)) return;
    const n = count ?? src.bytes.length - srcOff;
    dst.bytes.set(src.bytes.subarray(srcOff, srcOff + n), dstOff);
  },
  fill(b: LuaBuffer, off: number, value: number, count?: number): void {
    if (!_isBuf(b)) return;
    const end = count !== undefined ? off + count : b.bytes.length;
    b.bytes.fill(value & 0xff, off, end);
  },
  readi8(b: LuaBuffer, off: number): number { return b.view.getInt8(off); },
  readu8(b: LuaBuffer, off: number): number { return b.view.getUint8(off); },
  readi16(b: LuaBuffer, off: number): number { return b.view.getInt16(off, true); },
  readu16(b: LuaBuffer, off: number): number { return b.view.getUint16(off, true); },
  readi32(b: LuaBuffer, off: number): number { return b.view.getInt32(off, true); },
  readu32(b: LuaBuffer, off: number): number { return b.view.getUint32(off, true); },
  readf32(b: LuaBuffer, off: number): number { return b.view.getFloat32(off, true); },
  readf64(b: LuaBuffer, off: number): number { return b.view.getFloat64(off, true); },
  writei8(b: LuaBuffer, off: number, v: number): void { b.view.setInt8(off, v); },
  writeu8(b: LuaBuffer, off: number, v: number): void { b.view.setUint8(off, v); },
  writei16(b: LuaBuffer, off: number, v: number): void { b.view.setInt16(off, v, true); },
  writeu16(b: LuaBuffer, off: number, v: number): void { b.view.setUint16(off, v, true); },
  writei32(b: LuaBuffer, off: number, v: number): void { b.view.setInt32(off, v, true); },
  writeu32(b: LuaBuffer, off: number, v: number): void { b.view.setUint32(off, v, true); },
  writef32(b: LuaBuffer, off: number, v: number): void { b.view.setFloat32(off, v, true); },
  writef64(b: LuaBuffer, off: number, v: number): void { b.view.setFloat64(off, v, true); },
  readstring(b: LuaBuffer, off: number, count: number): string {
    return new TextDecoder().decode(b.bytes.subarray(off, off + count));
  },
  writestring(b: LuaBuffer, off: number, s: string, count?: number): void {
    const bytes = new TextEncoder().encode(s);
    const n = count ?? bytes.length;
    b.bytes.set(bytes.subarray(0, n), off);
  },
} as const;

// ─── debug ──────────────────────────────────────────────────────────────────
// Browser mode has no Luau VM, so the introspection calls are best-effort.

export const debug = {
  traceback(message?: string, _level?: number): string {
    const e = new Error(message ?? '');
    return e.stack ?? message ?? '';
  },
  getinfo(_target: unknown, _what?: string): Record<string, unknown> {
    return { source: '', short_src: '', currentline: -1, what: 'Lua', name: '', namewhat: '' };
  },
  profilebegin(_label: string): void {},
  profileend(): void {},
  setmemorycategory(_category: string): void {},
  resetmemorycategory(): void {},
  info(..._args: unknown[]): unknown[] {
    // Luau-extension shape: returns table for the matched stack frame.
    return [];
  },
} as const;

// ─── Language helpers ───────────────────────────────────────────────────────

/** Lua's `type(v)` — returns the basic Lua type name (string/number/boolean/
 *  function/table/nil/userdata/thread). */
export function luaType(v: unknown): string {
  if (v === null || v === undefined) return 'nil';
  if (typeof v === 'function') return 'function';
  if (typeof v === 'boolean') return 'boolean';
  if (typeof v === 'number') return 'number';
  if (typeof v === 'string') return 'string';
  if (Array.isArray(v)) return 'table';
  if (typeof v === 'object') {
    const obj = v as { __isCoroutine?: boolean; __isLuaBuffer?: boolean };
    if (obj.__isCoroutine) return 'thread';
    if (obj.__isLuaBuffer) return 'buffer';
    return 'table';
  }
  return 'userdata';
}

/** Roblox's `typeof(v)` — returns the Roblox-specific class name for
 *  Vector3, CFrame, EnumItem, Instance, etc.; falls back to `type()` for
 *  primitives. */
export function luaTypeof(v: unknown): string {
  if (v === null || v === undefined) return 'nil';
  if (typeof v === 'function') return 'function';
  if (typeof v === 'boolean') return 'boolean';
  if (typeof v === 'number') return 'number';
  if (typeof v === 'string') return 'string';
  if (typeof v === 'object') {
    const obj = v as { ClassName?: unknown; IsA?: unknown; constructor?: { name?: string } };
    // Instance subclasses report their root class as "Instance".
    if (typeof obj.ClassName === 'string' && typeof obj.IsA === 'function') {
      return 'Instance';
    }
    const ctor = obj.constructor?.name;
    if (typeof ctor === 'string' && ctor !== 'Object' && ctor !== 'Array') return ctor;
    if (Array.isArray(v)) return 'table';
    return 'table';
  }
  return 'userdata';
}

/** Lua's `select(i, ...)` — `select('#', ...)` returns count; `select(n, ...)`
 *  returns `args[n], args[n+1], …`. */
export function select(i: number | '#', ...args: unknown[]): unknown {
  if (i === '#') return args.length;
  if (typeof i !== 'number') throw new TypeError('select: bad selector');
  const idx = i < 0 ? args.length + i : i - 1;
  if (idx < 0) throw new RangeError('select: index out of range');
  return args.slice(idx);
}

/** Lua's `unpack(t, i, j)` — alias for `table.unpack`. */
export function unpack<T>(t: T[], i: number = 1, j?: number): T[] {
  return tableUnpack(t, i, j);
}

/** Lua's `newproxy([metatable])` — creates an empty userdata with optional
 *  metatable. We approximate with a frozen empty object whose metatable is
 *  set via setmetatable elsewhere. The boolean variant adds a basic mt. */
export function newproxy(addMetatable: boolean = false): object {
  const proxy = Object.create(null);
  if (addMetatable) {
    Object.defineProperty(proxy, '__metatable', { value: {}, configurable: true, writable: true });
  }
  return proxy;
}

/** Roblox global tables — `_G` is shared between all scripts. */
export const _G: Record<string, unknown> = {};
/** Per-script environment — Luau scripts read it as themselves. We expose
 *  the same shared object as `_G` since we don't model per-script envs. */
export const _ENV: Record<string, unknown> = _G;
/** Lua version string. Roblox runs Luau, which forks 5.1; report that. */
export const _VERSION = 'Luau';
