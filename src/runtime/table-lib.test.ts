import { describe, expect, it } from 'vitest';
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
import { LuaError } from './pcall.js';

describe('table-lib', () => {
  describe('insert / remove', () => {
    it('inserts at end without position', () => {
      const t: number[] = [1, 2, 3];
      tableInsert(t, 4);
      expect(t).toEqual([1, 2, 3, 4]);
    });

    it('inserts at given 1-indexed position, shifting later elements', () => {
      const t: number[] = [1, 2, 4];
      tableInsert(t, 3, 3);
      expect(t).toEqual([1, 2, 3, 4]);
    });

    it('inserts at the head with pos=1', () => {
      const t: number[] = [2, 3];
      tableInsert(t, 1, 1);
      expect(t).toEqual([1, 2, 3]);
    });

    it('removes from end without position', () => {
      const t: number[] = [1, 2, 3];
      expect(tableRemove(t)).toBe(3);
      expect(t).toEqual([1, 2]);
    });

    it('removes at given position', () => {
      const t: number[] = [1, 2, 3];
      expect(tableRemove(t, 2)).toBe(2);
      expect(t).toEqual([1, 3]);
    });
  });

  describe('concat', () => {
    it('joins with default separator', () => {
      expect(tableConcat([1, 2, 3])).toBe('123');
    });
    it('honors sep, i, j', () => {
      expect(tableConcat(['a', 'b', 'c', 'd'], '-', 2, 3)).toBe('b-c');
    });
    it('throws on non-stringifiable values', () => {
      expect(() => tableConcat([{}] as unknown[])).toThrow(LuaError);
    });
  });

  describe('sort', () => {
    it('sorts numbers ascending by default', () => {
      const t = [3, 1, 4, 1, 5, 9, 2, 6];
      tableSort(t);
      expect(t).toEqual([1, 1, 2, 3, 4, 5, 6, 9]);
    });

    it('uses Lua-style boolean comparator (a-before-b)', () => {
      const t = [3, 1, 2];
      tableSort(t, (a, b) => a > b);
      expect(t).toEqual([3, 2, 1]);
    });
  });

  describe('unpack / pack', () => {
    it('unpack slices to array', () => {
      expect(tableUnpack([1, 2, 3, 4], 2, 3)).toEqual([2, 3]);
    });
    it('pack stores compiler-facing zero-indexed values + n', () => {
      const p = tablePack(1, 2, 3);
      expect(p.n).toBe(3);
      expect(p[0]).toBe(1);
      expect(p[2]).toBe(3);
    });
  });

  describe('find / clone / clear / move / maxn', () => {
    it('find returns 1-indexed position', () => {
      expect(tableFind(['a', 'b', 'c'], 'b')).toBe(2);
      expect(tableFind(['a', 'b', 'c'], 'z')).toBeUndefined();
    });
    it('clone shallow-copies', () => {
      const a = [1, 2, 3];
      const b = tableClone(a);
      expect(b).toEqual(a);
      expect(b).not.toBe(a);
    });
    it('clear empties in place', () => {
      const a = [1, 2, 3];
      tableClear(a);
      expect(a).toEqual([]);
    });
    it('move copies a slice into a destination', () => {
      const a = [1, 2, 3, 4, 5];
      const dest = [10, 20, 30, 40, 50];
      tableMove(a, 2, 4, 1, dest);
      expect(dest).toEqual([2, 3, 4, 40, 50]);
    });
    it('maxn finds largest numeric key', () => {
      expect(tableMaxn({ 1: 'a', 5: 'b', 10: 'c' })).toBe(10);
    });
  });

  describe('freeze', () => {
    it('makes table readonly', () => {
      const t = tableFreeze([1, 2]);
      expect(tableIsFrozen(t)).toBe(true);
      expect(() => tableInsert(t, 3)).toThrow(LuaError);
      expect(() => tableSort(t)).toThrow(LuaError);
    });
  });
});
