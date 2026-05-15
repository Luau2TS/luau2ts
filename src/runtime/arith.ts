import { error, LuaError } from './pcall.js';
import { getMetamethod } from './metatable.js';

function toNumber(v: unknown): number | undefined {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isNaN(n) ? undefined : n;
  }
  return undefined;
}

type BinMeta =
  | '__add'
  | '__sub'
  | '__mul'
  | '__div'
  | '__idiv'
  | '__mod'
  | '__pow'
  | '__concat'
  | '__eq'
  | '__lt'
  | '__le';

// Operations that are commutative — for these we try the second operand
// as the receiver if the first doesn't provide the fluent method. Lets
// `2 * vec3` route to `vec3.mul(2)`.
const COMMUTATIVE: Partial<Record<BinMeta, true>> = {
  __add: true,
  __mul: true,
  __eq: true,
};

function callBinMetamethod(meta: BinMeta, opLabel: string, a: unknown, b: unknown): unknown {
  // First try a direct fluent method (.add/.sub/.mul/.div etc.) on either
  // operand — this is what Roblox's Vector3 / CFrame / Color3 expose.
  // For commutative ops we also try b's method if a doesn't have one.
  const fluent = FLUENT_METHOD[meta];
  if (fluent) {
    const fluentA = (a as Record<string, unknown> | null)?.[fluent];
    if (typeof fluentA === 'function') {
      return (fluentA as (x: unknown) => unknown).call(a, b);
    }
    if (COMMUTATIVE[meta]) {
      const fluentB = (b as Record<string, unknown> | null)?.[fluent];
      if (typeof fluentB === 'function') {
        return (fluentB as (x: unknown) => unknown).call(b, a);
      }
    }
  }
  const mm = getMetamethod(a, meta) ?? getMetamethod(b, meta);
  if (typeof mm === 'function') {
    return (mm as (x: unknown, y: unknown) => unknown)(a, b);
  }
  // One operand is null/undefined — common in real places where a
  // FindFirstChild lookup didn't resolve. Logging once and returning the
  // other operand keeps the script alive instead of taking down the page
  // on what was probably a missing-instance issue elsewhere.
  if (a == null || b == null) {
    return a ?? b ?? 0;
  }
  return error(`attempt to perform arithmetic (${opLabel}) on incompatible values`);
}

const FLUENT_METHOD: Partial<Record<BinMeta, string>> = {
  __add: 'add',
  __sub: 'sub',
  __mul: 'mul',
  __div: 'div',
  __concat: 'concat',
  __eq: 'eq',
  __lt: 'lt',
  __le: 'le',
};

function binNumeric(
  meta: BinMeta,
  opLabel: string,
  a: unknown,
  b: unknown,
  fn: (x: number, y: number) => number,
): number | unknown {
  const an = toNumber(a);
  const bn = toNumber(b);
  if (an !== undefined && bn !== undefined) return fn(an, bn);
  return callBinMetamethod(meta, opLabel, a, b);
}

export function luaAdd(a: unknown, b: unknown): number | unknown {
  return binNumeric('__add', 'add', a, b, (x, y) => x + y);
}
export function luaSub(a: unknown, b: unknown): number | unknown {
  return binNumeric('__sub', 'sub', a, b, (x, y) => x - y);
}
export function luaMul(a: unknown, b: unknown): number | unknown {
  return binNumeric('__mul', 'mul', a, b, (x, y) => x * y);
}
export function luaDiv(a: unknown, b: unknown): number | unknown {
  return binNumeric('__div', 'div', a, b, (x, y) => x / y);
}
export function luaIdiv(a: unknown, b: unknown): number | unknown {
  return binNumeric('__idiv', 'idiv', a, b, (x, y) => Math.floor(x / y));
}
export function luaMod(a: unknown, b: unknown): number | unknown {
  // Lua's % is floor modulo: ((a % b) + b) % b. JS's % is truncated.
  return binNumeric('__mod', 'mod', a, b, (x, y) => x - Math.floor(x / y) * y);
}
export function luaPow(a: unknown, b: unknown): number | unknown {
  return binNumeric('__pow', 'pow', a, b, (x, y) => x ** y);
}

export function luaUnm(a: unknown): number | unknown {
  if (typeof a === 'number') return -a;
  const an = toNumber(a);
  if (an !== undefined) return -an;
  const mm = getMetamethod(a, '__unm');
  if (typeof mm === 'function') return (mm as (x: unknown) => unknown)(a);
  return error('attempt to perform arithmetic (unm) on incompatible value');
}

export function luaConcat(a: unknown, b: unknown): string | unknown {
  const ok = (v: unknown): v is string | number => typeof v === 'string' || typeof v === 'number';
  if (ok(a) && ok(b)) return `${a}${b}`;
  return callBinMetamethod('__concat', 'concat', a, b);
}

// ─── Comparison helpers ─────────────────────────────────────────────────────

export function luaEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  // Lua maps JS null and undefined to nil; nil == nil is true, but JS
  // `null === undefined` is false. Without this, a `FindFirstChild` result
  // (null on miss) compared to `nil` via `x == nil` reads false, leaving
  // scripts to dereference the miss.
  if (a == null && b == null) return true;
  if (Number.isNaN(a as number) || Number.isNaN(b as number)) return false;
  // Lua only consults __eq when types match and both are tables/userdata.
  const sameType = typeof a === typeof b && a !== null && b !== null && typeof a === 'object';
  if (sameType) {
    const mm = getMetamethod(a, '__eq') ?? getMetamethod(b, '__eq');
    if (typeof mm === 'function') return Boolean((mm as (x: unknown, y: unknown) => unknown)(a, b));
  }
  return false;
}

export function luaLt(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' && typeof b === 'number') return a < b;
  if (typeof a === 'string' && typeof b === 'string') return a < b;
  const mm = getMetamethod(a, '__lt') ?? getMetamethod(b, '__lt');
  if (typeof mm === 'function') return Boolean((mm as (x: unknown, y: unknown) => unknown)(a, b));
  throw new LuaError('attempt to compare incompatible values');
}

export function luaLe(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' && typeof b === 'number') return a <= b;
  if (typeof a === 'string' && typeof b === 'string') return a <= b;
  const mmLe = getMetamethod(a, '__le') ?? getMetamethod(b, '__le');
  if (typeof mmLe === 'function')
    return Boolean((mmLe as (x: unknown, y: unknown) => unknown)(a, b));
  // Fall back to !(b < a) with __lt
  const mmLt = getMetamethod(a, '__lt') ?? getMetamethod(b, '__lt');
  if (typeof mmLt === 'function')
    return !Boolean((mmLt as (x: unknown, y: unknown) => unknown)(b, a));
  throw new LuaError('attempt to compare incompatible values');
}
