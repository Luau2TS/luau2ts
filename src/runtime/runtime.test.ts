import { describe, expect, it } from 'vitest';
import {
  assert,
  error,
  ipairs,
  isTruthy,
  luaAnd,
  luaNot,
  luaOr,
  LuaError,
  lualen,
  pairKeys,
  pairValue,
  pairs,
  pcall,
  tonumber,
  tostring,
  xpcall,
} from './index.js';

describe('truthy', () => {
  it('treats only false/nil as falsy', () => {
    expect(isTruthy(0)).toBe(true);
    expect(isTruthy('')).toBe(true);
    expect(isTruthy(NaN)).toBe(true);
    expect(isTruthy({ __isNull: true })).toBe(false);
    expect(isTruthy(false)).toBe(false);
    expect(isTruthy(null)).toBe(false);
    expect(isTruthy(undefined)).toBe(false);
  });

  it('luaAnd returns first falsy or last value', () => {
    expect(luaAnd(1, 2)).toBe(2);
    expect(luaAnd(false, 2)).toBe(false);
    expect(luaAnd(null, 'x')).toBe(null);
    expect(luaAnd(0, '')).toBe('');
  });

  it('luaOr returns first truthy or last value', () => {
    expect(luaOr(1, 2)).toBe(1);
    expect(luaOr(false, 2)).toBe(2);
    expect(luaOr(null, 'x')).toBe('x');
    expect(luaOr(false, undefined)).toBe(undefined);
  });

  it('luaNot inverts Lua truthiness', () => {
    expect(luaNot(0)).toBe(false);
    expect(luaNot(false)).toBe(true);
    expect(luaNot(null)).toBe(true);
  });
});

describe('lualen', () => {
  it('measures arrays by length', () => {
    expect(lualen([1, 2, 3])).toBe(3);
    expect(lualen([])).toBe(0);
  });

  it('measures strings by UTF-8 byte length', () => {
    expect(lualen('hello')).toBe(5);
    expect(lualen('')).toBe(0);
    expect(lualen('é')).toBe(2); // 2 bytes in UTF-8
  });

  it('returns 0 for plain string-keyed objects', () => {
    expect(lualen({ a: 1, b: 2 })).toBe(0);
  });

  it('throws on non-iterable values', () => {
    expect(() => lualen(42)).toThrow(TypeError);
    expect(() => lualen(true)).toThrow(TypeError);
  });
});

describe('pcall / xpcall / error / assert', () => {
  it('returns [true, value] when fn succeeds', () => {
    const result = pcall(() => 42);
    expect(result).toEqual([true, 42]);
  });

  it('returns [false, message] on thrown error', () => {
    const result = pcall(() => {
      error('oh no');
    });
    expect(result).toEqual([false, 'oh no']);
  });

  it('handles async functions', async () => {
    const ok = await pcall(async () => 'async ok');
    expect(ok).toEqual([true, 'async ok']);
    const err = await pcall(async () => {
      throw new Error('boom');
    });
    expect(err).toEqual([false, 'boom']);
  });

  it('xpcall transforms the error message', () => {
    const result = xpcall(
      () => error('raw'),
      (msg) => `handled: ${msg}`,
    );
    expect(result).toEqual([false, 'handled: raw']);
  });

  it('error throws LuaError', () => {
    expect(() => error('msg')).toThrow(LuaError);
  });

  it('assert returns the value when truthy', () => {
    expect(assert(123, 'nope')).toBe(123);
  });

  it('assert throws when falsy', () => {
    expect(() => assert(false, 'nope')).toThrow('nope');
    expect(() => assert(null)).toThrow('assertion failed!');
  });
});

describe('iterators', () => {
  it('ipairs walks 1..n until first nil', () => {
    const collected: [number, string][] = [];
    const [iter, state, init] = ipairs(['a', 'b', 'c']);
    let i: number | null = init;
    while (true) {
      const next = iter(state, i!);
      if (!next) break;
      collected.push([next[0], next[1]]);
      i = next[0];
    }
    expect(collected).toEqual([
      [1, 'a'],
      [2, 'b'],
      [3, 'c'],
    ]);
  });

  it('pairs walks every key/value of a plain object', () => {
    const collected: [PropertyKey, unknown][] = [];
    const [iter, state, init] = pairs({ x: 1, y: 2, z: 3 });
    let prev: PropertyKey | null = init;
    while (true) {
      const next = iter(state, prev as keyof typeof state);
      if (!next) break;
      collected.push([next[0], next[1]]);
      prev = next[0];
    }
    expect(collected).toEqual([
      ['x', 1],
      ['y', 2],
      ['z', 3],
    ]);
  });

  it('pairKeys uses deterministic string-key order for dictionary tables', () => {
    expect(pairKeys({ sword: 1, slingshot: 2 })).toEqual(['slingshot', 'sword']);
  });

  it('pairValue maps Lua-style array indices back to JS array offsets', () => {
    const arr = ['first', 'second'];
    expect(pairKeys(arr)).toEqual([1, 2]);
    expect(pairValue(arr, 1)).toBe('first');
    expect(pairValue(arr, 2)).toBe('second');
  });
});

describe('tostring / tonumber', () => {
  it('formats primitives the Lua way', () => {
    expect(tostring(null)).toBe('nil');
    expect(tostring(undefined)).toBe('nil');
    expect(tostring(true)).toBe('true');
    expect(tostring(false)).toBe('false');
    expect(tostring(42)).toBe('42');
    expect(tostring(3.14)).toBe('3.14');
    expect(tostring('hi')).toBe('hi');
    expect(tostring(NaN)).toBe('nan');
    expect(tostring(Infinity)).toBe('inf');
    expect(tostring(-Infinity)).toBe('-inf');
  });

  it('uses __tostring metamethod when present', () => {
    const obj = {
      __tostring() {
        return 'custom!';
      },
    };
    expect(tostring(obj)).toBe('custom!');
  });

  it('prints Roblox Instance UID keys as the current Name', () => {
    const inst = {
      Name: 'Before',
      toString() {
        return '\x011';
      },
    };

    expect(tostring(inst)).toBe('Before');
    inst.Name = 'After';
    expect(tostring(inst)).toBe('After');
  });

  it('formats functions and tables with addresses', () => {
    const fn = () => 1;
    const tbl: number[] = [1, 2];
    expect(tostring(fn)).toMatch(/^function: 0x[0-9a-f]+$/);
    expect(tostring(tbl)).toMatch(/^table: 0x[0-9a-f]+$/);
    // Addresses are stable per object
    expect(tostring(fn)).toBe(tostring(fn));
  });

  it('parses decimal / hex / inf via tonumber', () => {
    expect(tonumber('42')).toBe(42);
    expect(tonumber('3.14')).toBe(3.14);
    expect(tonumber('0xff')).toBe(255);
    expect(tonumber('  17  ')).toBe(17);
    expect(tonumber('not a number')).toBeUndefined();
    expect(tonumber('')).toBeUndefined();
  });

  it('respects custom base', () => {
    expect(tonumber('ff', 16)).toBe(255);
    expect(tonumber('101', 2)).toBe(5);
    expect(tonumber('zz', 36)).toBe(35 * 36 + 35);
  });

  it('returns existing numbers as-is', () => {
    expect(tonumber(42)).toBe(42);
    expect(tonumber(NaN)).toBeUndefined();
    expect(tonumber(Infinity)).toBeUndefined();
  });
});
