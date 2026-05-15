import { describe, expect, it } from 'vitest';
import {
  luaAdd,
  luaConcat,
  luaDiv,
  luaEq,
  luaIdiv,
  luaLe,
  luaLt,
  luaMod,
  luaMul,
  luaPow,
  luaSub,
  luaUnm,
} from './arith.js';
import { setmetatable } from './metatable.js';
import { LuaError } from './pcall.js';

describe('arith', () => {
  describe('numeric ops', () => {
    it('add / sub / mul / div / mod / pow / unm', () => {
      expect(luaAdd(1, 2)).toBe(3);
      expect(luaSub(5, 3)).toBe(2);
      expect(luaMul(4, 3)).toBe(12);
      expect(luaDiv(10, 4)).toBe(2.5);
      expect(luaMod(10, 3)).toBe(1);
      expect(luaPow(2, 8)).toBe(256);
      expect(luaUnm(5)).toBe(-5);
    });

    it('idiv is floor division', () => {
      expect(luaIdiv(7, 2)).toBe(3);
      expect(luaIdiv(-7, 2)).toBe(-4);
    });

    it('mod uses Lua semantics (floor modulo)', () => {
      expect(luaMod(-1, 3)).toBe(2);
      expect(luaMod(7, -3)).toBe(-2);
    });

    it('coerces numeric strings', () => {
      expect(luaAdd('5', 3)).toBe(8);
      expect(luaMul('2', '3')).toBe(6);
    });
  });

  describe('concat', () => {
    it('joins strings and numbers', () => {
      expect(luaConcat('hello ', 'world')).toBe('hello world');
      expect(luaConcat('count: ', 5)).toBe('count: 5');
      expect(luaConcat(1, 2)).toBe('12');
    });
  });

  describe('comparison', () => {
    it('lt / le on numbers and strings', () => {
      expect(luaLt(1, 2)).toBe(true);
      expect(luaLt(2, 1)).toBe(false);
      expect(luaLe(1, 1)).toBe(true);
      expect(luaLt('a', 'b')).toBe(true);
      expect(luaLe('b', 'a')).toBe(false);
    });

    it('eq returns true only on raw equality unless __eq is defined', () => {
      const a = setmetatable(
        { x: 1 },
        { __eq: (l: { x: number }, r: { x: number }) => l.x === r.x },
      );
      const b = setmetatable(
        { x: 1 },
        { __eq: (l: { x: number }, r: { x: number }) => l.x === r.x },
      );
      expect(luaEq(a, b)).toBe(true);
      expect(luaEq({}, {})).toBe(false);
    });

    it('throws on incompatible types', () => {
      expect(() => luaLt({}, 1)).toThrow(LuaError);
    });
  });

  describe('metamethod fallback', () => {
    it("__add fires when one operand isn't numeric", () => {
      const v = setmetatable(
        { value: 10 },
        { __add: (a: { value: number }, b: number) => a.value + b },
      );
      expect(luaAdd(v, 5)).toBe(15);
    });

    it('__unm fires for unary minus', () => {
      const v = setmetatable({ value: 7 }, { __unm: (a: { value: number }) => -a.value });
      expect(luaUnm(v)).toBe(-7);
    });

    it('throws on incompatible types without metamethods', () => {
      expect(() => luaAdd({}, 1)).toThrow(LuaError);
    });
  });
});
