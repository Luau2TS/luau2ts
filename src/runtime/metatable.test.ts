import { describe, expect, it } from 'vitest';
import { getmetatable, rawequal, rawget, rawlen, rawset, setmetatable } from './metatable.js';

describe('metatable', () => {
  it('falls back to __index table on missed lookup', () => {
    const proto = {
      greet() {
        return 'hi';
      },
    };
    const obj = setmetatable({}, { __index: proto }) as { greet?: () => string };
    expect(obj.greet?.()).toBe('hi');
  });

  it('falls back to __index function on missed lookup', () => {
    const obj = setmetatable<Record<string, unknown>>(
      {},
      { __index: (_t: object, k: PropertyKey) => `default-${String(k)}` },
    );
    expect(obj.foo).toBe('default-foo');
  });

  it('routes assignments to __newindex when key is missing', () => {
    const writes: [string, unknown][] = [];
    const obj = setmetatable<Record<string, unknown>>(
      {},
      {
        __newindex: (_t: object, k: PropertyKey, v: unknown) => {
          writes.push([String(k), v]);
        },
      },
    );
    obj.foo = 1;
    expect(writes).toEqual([['foo', 1]]);
  });

  it('uses regular set when key is already present', () => {
    const target: Record<string, unknown> = { foo: 'orig' };
    const writes: unknown[] = [];
    const obj = setmetatable(target, {
      __newindex: (_t: object, _k: PropertyKey, v: unknown) => {
        writes.push(v);
      },
    }) as { foo?: unknown };
    obj.foo = 'updated';
    expect(target.foo).toBe('updated');
    expect(writes).toEqual([]);
  });

  it('getmetatable returns the metatable, or __metatable if set', () => {
    const mt = { __index: {} };
    const obj = setmetatable({}, mt);
    expect(getmetatable(obj)).toBe(mt);

    const protectedMt = { __index: {}, __metatable: 'locked' };
    const obj2 = setmetatable({}, protectedMt);
    expect(getmetatable(obj2)).toBe('locked');
  });

  it('setmetatable(t, null) clears the metatable', () => {
    const obj = setmetatable<Record<string, unknown>>({}, { __index: { foo: 'hi' } });
    expect(obj.foo).toBe('hi');
    setmetatable(obj, null);
    expect(obj.foo).toBeUndefined();
  });

  it('rawget / rawset bypass metamethods', () => {
    const target: Record<string, unknown> = {};
    const writes: unknown[] = [];
    const obj = setmetatable(target, {
      __index: () => 'via-index',
      __newindex: (_t: object, _k: PropertyKey, v: unknown) => writes.push(v),
    });
    expect(rawget(obj, 'foo')).toBeUndefined();
    rawset(obj, 'foo', 1);
    expect(target.foo).toBe(1);
    expect(writes).toEqual([]);
  });

  it('rawequal / rawlen ignore metatables', () => {
    const t1 = setmetatable({}, { __eq: () => true });
    const t2 = setmetatable({}, { __eq: () => true });
    expect(rawequal(t1, t2)).toBe(false);
    expect(rawequal(t1, t1)).toBe(true);
    expect(rawlen([1, 2, 3])).toBe(3);
    expect(rawlen('hello')).toBe(5);
  });
});
