type KeyReifier = (rawKey: unknown) => unknown;
const identityReifier: KeyReifier = (k) => k;
let keyReifier: KeyReifier = identityReifier;
export function registerKeyReifier(fn: KeyReifier): void {
  keyReifier = fn;
}
// Side-channel: a host runtime (e.g. a Roblox runtime that supports
// Instance-keyed tables) installs the reifier via globalThis on its own
// load. Read it through getKeyReifier so the value is picked up the
// moment a runtime registers, not at module load.
const g = globalThis as unknown as { __rbxKeyReifier?: KeyReifier };
function getKeyReifier(): KeyReifier {
  if (keyReifier === identityReifier && typeof g.__rbxKeyReifier === 'function') {
    keyReifier = g.__rbxKeyReifier;
  }
  return keyReifier;
}
//
// Lua's loop syntax `for k, v in pairs(t) do … end` desugars to a stateful
// iterator with three values: the iterator function, the table, and the
// previous key. We expose the same shape so the compiler can mechanically
// translate `for k, v in pairs(t) do` → equivalent JS using these.

export type IpairsState<T> = readonly [
  iterFn: (state: readonly T[], i: number) => [number, T] | undefined,
  state: readonly T[],
  initial: number,
];

export type PairsState<T> = readonly [
  iterFn: (state: T, prev: keyof T | null) => [keyof T, T[keyof T]] | undefined,
  state: T,
  initial: null,
];

export function ipairs<T>(t: readonly T[] | null | undefined): IpairsState<T> {
  return [ipairsIter, (t ?? []) as readonly T[], 0];
}

function ipairsIter<T>(state: readonly T[] | null | undefined, i: number): [number, T] | undefined {
  if (state == null) return undefined;
  const next = i + 1;
  // 1-indexed: state[next - 1] is Lua index `next`.
  const value = state[next - 1];
  if (value === undefined || value === null) return undefined;
  return [next, value];
}

export function pairs<T extends object>(t: T | null | undefined): PairsState<T> {
  return [pairsIter as PairsState<T>[0], (t ?? ({} as T)) as T, null];
}

// Lua's `next(t, k)` — returns the key/value pair following `k` (or the first
// pair when `k` is nil), or nil when there is no successor. The dominant idiom
// in Lua libraries is `next(t) == nil` to test emptiness; we support both
// shapes. Returned as a JS array so destructuring `[k, v] = next(t)` works.
export function next<T extends object>(
  t: T | null | undefined,
  k: keyof T | null = null,
): [keyof T, T[keyof T]] | undefined {
  return pairsIter(t, k);
}

function pairsIter<T extends object>(
  state: T | null | undefined,
  prev: keyof T | null,
): [keyof T, T[keyof T]] | undefined {
  if (state == null) return undefined;
  // pairs() iterates every key — numeric AND string. JS arrays can carry
  // string-keyed properties (Lua scripts that index a table with an
  // Instance hit this path), so we have to consult Object.keys plus the
  // numeric array length. Without the array slice, an `offsets[part] = X`
  // pattern on an array-backed Lua table iterates zero times.
  const keys = orderedRawPairKeys(state);
  let idx = 0;
  if (prev !== null) {
    // For Instance-keyed tables, prev is the reified value (e.g. an
    // Instance) but `keys` is the raw string list. Convert prev to its
    // string form for comparison.
    const prevStr = typeof prev === 'object' && prev !== null ? String(prev) : prev;
    idx = keys.findIndex((k) => k === prevStr) + 1;
  }
  while (idx < keys.length) {
    const rawKey = keys[idx]!;
    const lookupKey = Array.isArray(state) && typeof rawKey === 'number' ? rawKey - 1 : rawKey;
    const value = (state as Record<string | number, unknown>)[lookupKey] as T[keyof T];
    if (value !== undefined && value !== null) {
      return [getKeyReifier()(rawKey) as keyof T, value];
    }
    idx += 1;
  }
  return undefined;
}

function orderedRawPairKeys(state: object): (string | number)[] {
  const numericStringKeys = Object.keys(state)
    .filter((k) => /^\d+$/.test(k))
    .map((k) => Number(k))
    .sort((a, b) => a - b);
  const stringKeys = Object.keys(state).filter((k) => !/^\d+$/.test(k)).sort();
  if (!Array.isArray(state)) return [...numericStringKeys, ...stringKeys];
  const numericKeys = (state as unknown[]).map((_, i) => i + 1);
  return [...numericKeys, ...stringKeys];
}

/** Generic-for protocol adapter. Luau lets you write
 *  `for k, v in expr do … end` where `expr` can be any of:
 *    - an iterator triple `(iterFn, state, initialCtrl)` returned by
 *      `pairs(t)` / `ipairs(t)` / custom iterator constructors,
 *    - a callable that mimics the iterator function directly,
 *    - a table with an `__iter` metamethod,
 *    - a plain array (Luau extension — common in Roblox code like
 *      `for _, x in CollectionService:GetTagged("Tag") do`),
 *    - a plain dictionary (Luau extension; same as `pairs(t)`).
 *
 *  The compiler used to emit a raw `[__iter, __state, __ctrl] = expr`
 *  destructure that only worked for the triple form. Arrays and bare
 *  tables silently iterated zero times because the first element
 *  wasn't a function. This adapter normalizes every shape to a real
 *  triple. */
export function genericIter(value: unknown): readonly [
  (state: unknown, ctrl: unknown) => unknown,
  unknown,
  unknown,
] {
  if (value == null) {
    return [emptyIter, null, null];
  }
  if (typeof value === 'function') {
    return [value as (s: unknown, c: unknown) => unknown, null, null];
  }
  if (Array.isArray(value)) {
    const [maybeIter, maybeState, maybeCtrl] = value;
    if (typeof maybeIter === 'function') {
      // Already a triple: pairs(t) / ipairs(t) / custom iterator.
      return [
        maybeIter as (s: unknown, c: unknown) => unknown,
        maybeState ?? null,
        maybeCtrl ?? null,
      ];
    }
    // Plain JS array. Iterate as ipairs would.
    return [ipairsIter as unknown as (s: unknown, c: unknown) => unknown, value, 0];
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown> & { __iter?: () => unknown };
    if (typeof obj.__iter === 'function') {
      const triple = obj.__iter();
      if (Array.isArray(triple) && typeof triple[0] === 'function') {
        return [
          triple[0] as (s: unknown, c: unknown) => unknown,
          triple[1] ?? null,
          triple[2] ?? null,
        ];
      }
    }
    return [pairsIter as unknown as (s: unknown, c: unknown) => unknown, value, null];
  }
  return [emptyIter, null, null];
}

function emptyIter(): undefined {
  return undefined;
}

/** Multi-return adapter for `local a, b = f()` where `f` returns a single
 *  value (not a tuple). Luau pads missing returns with nil; JS destructuring
 *  on a non-iterable throws. Wrap the call result so destructuring works:
 *  `[a, b] = multiret(f())` → `a = result`, `b = undefined` when `f` returns
 *  a non-array, and stays a no-op when `f` already returns an array tuple. */
export function multiret(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [v];
}

/** Drop-in replacement for `Object.keys(t)` for the compiler's inlined
 *  `for k in pairs(t)` form. Returns the original Instance object as the
 *  key when the table was indexed with one, via the global key reifier
 *  a host Roblox runtime installs. Without this, Instance-keyed
 *  Lua tables collapse on shared Name (two parts named "Handle" share
 *  the same string key) AND iteration yields the string key, so
 *  `part.CFrame = ...` fails with "Cannot create property on string".
 *
 *  Falls back to the raw string for primitive keys and for the slow
 *  path before the runtime has loaded. */
export function pairKeys(t: unknown): unknown[] {
  if (t == null || typeof t !== 'object') return [];
  const reifier = getKeyReifier();
  const out: unknown[] = [];
  // Mixed arrays: include numeric indices first (Lua 1-based), then
  // string-keyed properties. Array.isArray + Object.keys may overlap,
  // so check the raw key for digit-only and emit the numeric form.
  for (const k of orderedRawPairKeys(t)) {
    if (typeof k === 'number') {
      out.push(k);
    } else {
      out.push(reifier(k));
    }
  }
  return out;
}

/** Companion lookup: `t[k]` where k may be a reified Instance. We use
 *  String(k) to recover the original property key. For numeric keys the
 *  compiler emits `t[k-1]` directly, so we only handle the reified case. */
export function pairValue(t: unknown, k: unknown): unknown {
  if (t == null || typeof t !== 'object') return undefined;
  const key = typeof k === 'object' && k !== null ? String(k) : (k as string | number);
  if (Array.isArray(t) && typeof key === 'number') {
    return (t as unknown[])[key - 1];
  }
  return (t as Record<string | number, unknown>)[key as string | number];
}
