import { LuaError } from './pcall.js';

const FROZEN = new WeakSet<object>();

function checkFrozen(t: object): void {
  if (FROZEN.has(t)) throw new LuaError('attempt to modify a readonly table');
}

export function tableInsert<T>(t: T[], posOrValue: number | T, maybeValue?: T): void {
  checkFrozen(t);
  if (arguments.length >= 3) {
    const pos = posOrValue as number;
    if (!Number.isInteger(pos) || pos < 1 || pos > t.length + 1) {
      throw new LuaError(`bad argument #2 to 'insert' (position out of bounds)`);
    }
    t.splice(pos - 1, 0, maybeValue as T);
  } else {
    t.push(posOrValue as T);
  }
}

export function tableRemove<T>(t: T[], pos?: number): T | undefined {
  checkFrozen(t);
  if (t.length === 0) return undefined;
  if (pos === undefined) return t.pop();
  if (!Number.isInteger(pos) || pos < 1 || pos > t.length) {
    throw new LuaError(`bad argument #2 to 'remove' (position out of bounds)`);
  }
  const [removed] = t.splice(pos - 1, 1);
  return removed;
}

export function tableConcat(t: unknown[], sep = '', i = 1, j: number = t.length): string {
  if (i < 1 || j > t.length) throw new LuaError(`invalid value (out of range)`);
  const out: string[] = [];
  for (let k = i; k <= j; k += 1) {
    const v = t[k - 1];
    if (typeof v === 'number' || typeof v === 'string') out.push(String(v));
    else throw new LuaError(`invalid value (at index ${k}) in table for 'concat'`);
  }
  return out.join(sep);
}

export function tableSort<T>(t: T[], comp?: (a: T, b: T) => boolean): void {
  checkFrozen(t);
  if (comp) {
    t.sort((a, b) => {
      // Lua comp returns true if a should come before b. JS sort wants
      // negative/zero/positive — translate via two probes for stability.
      if (comp(a, b)) return -1;
      if (comp(b, a)) return 1;
      return 0;
    });
  } else {
    t.sort((a, b) => {
      if (typeof a === 'number' && typeof b === 'number') return a - b;
      const sa = String(a);
      const sb = String(b);
      return sa < sb ? -1 : sa > sb ? 1 : 0;
    });
  }
}

export function tableUnpack<T>(t: T[] | (Record<number, T> & { n?: number }), i = 1, j?: number): T[] {
  if (Array.isArray(t)) {
    return t.slice(i - 1, j);
  }
  // tablePack output is 0-indexed (post compiler-subtract-1 fix), so walk
  // from i-1 to (j ?? n) - 1 inclusive.
  const obj = t as Record<number, T> & { n?: number };
  const last = (j ?? obj.n ?? 0) - 1;
  const out: T[] = [];
  for (let k = i - 1; k <= last; k += 1) out.push(obj[k] as T);
  return out;
}

export function tablePack(...values: unknown[]): { n: number } & Record<number, unknown> {
  // Spread single-array arg — compiler models multi-return as JS array.
  if (values.length === 1 && Array.isArray(values[0])) {
    values = values[0] as unknown[];
  }
  // After the compiler's subtract-1 fix, user code `packed[1]` now reads JS
  // key '0'. Store at 0-indexed keys so access matches; keep n for unpack.
  const out: Record<string | number, unknown> = { n: values.length };
  for (let k = 0; k < values.length; k += 1) out[k] = values[k];
  return out as { n: number } & Record<number, unknown>;
}

export function tableFind<T>(t: T[], value: T, init = 1): number | undefined {
  for (let k = init - 1; k < t.length; k += 1) {
    if (t[k] === value) return k + 1;
  }
  return undefined;
}

export function tableClear(t: unknown[]): void {
  checkFrozen(t);
  t.length = 0;
}

export function tableClone<T>(t: T[]): T[] {
  return [...t];
}

export function tableFreeze<T extends object>(t: T): T {
  FROZEN.add(t);
  Object.freeze(t);
  return t;
}

export function tableIsFrozen(t: object): boolean {
  return FROZEN.has(t) || Object.isFrozen(t);
}

export function tableMove<T>(a1: T[], f: number, e: number, dest: number, a2: T[] = a1): T[] {
  checkFrozen(a2);
  if (e < f) return a2;
  for (let k = 0; k <= e - f; k += 1) {
    a2[dest - 1 + k] = a1[f - 1 + k] as T;
  }
  return a2;
}

export function tableMaxn(t: Record<number, unknown>): number {
  let max = 0;
  for (const k of Object.keys(t)) {
    const n = Number(k);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max;
}
