import { describe, expect, it } from 'vitest';
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

describe('string-lib basic ops', () => {
  it('len / upper / lower / reverse', () => {
    expect(stringLen('hello')).toBe(5);
    expect(stringUpper('Hello')).toBe('HELLO');
    expect(stringLower('Hello')).toBe('hello');
    expect(stringReverse('abc')).toBe('cba');
  });

  it('sub with positive and negative indices', () => {
    expect(stringSub('hello', 2, 4)).toBe('ell');
    expect(stringSub('hello', 2)).toBe('ello');
    expect(stringSub('hello', -3)).toBe('llo');
    expect(stringSub('hello', -3, -2)).toBe('ll');
  });

  it('rep with optional separator', () => {
    expect(stringRep('ab', 3)).toBe('ababab');
    expect(stringRep('ab', 3, '-')).toBe('ab-ab-ab');
    expect(stringRep('x', 0)).toBe('');
  });

  it('byte / char round-trip', () => {
    expect(stringByte('abc', 1, 3)).toEqual([97, 98, 99]);
    expect(stringChar(72, 105)).toBe('Hi');
  });
});

describe('string-lib pattern functions', () => {
  it('find returns 1-indexed positions', () => {
    expect(stringFind('hello world', 'world')).toEqual([7, 11]);
    expect(stringFind('hello', 'X')).toBeUndefined();
  });

  it('find with plain=true treats pattern as literal', () => {
    expect(stringFind('a.b.c', '.', 1, true)).toEqual([2, 2]);
    // Pattern mode would treat . as any-char.
    expect(stringFind('abc', '.', 1, false)).toEqual([1, 1]);
  });

  it('match returns first capture (or whole match)', () => {
    expect(stringMatch('hello 123 world', '%d+')).toBe('123');
    expect(stringMatch('foo=42', '(%a+)=(%d+)')).toEqual(['foo', '42']);
    expect(stringMatch('x', 'y')).toBeUndefined();
  });

  it('gmatch yields successive matches', () => {
    const next = stringGmatch('a 1 b 2 c 3', '%d+');
    expect(next()).toBe('1');
    expect(next()).toBe('2');
    expect(next()).toBe('3');
    expect(next()).toBeUndefined();
  });

  it('gsub returns [result, count]', () => {
    expect(stringGsub('hello world', '%a+', 'X')).toEqual(['X X', 2]);
  });
});

describe('string-lib format', () => {
  it('handles %d / %i / %f', () => {
    expect(stringFormat('%d', 42)).toBe('42');
    expect(stringFormat('%i', 42)).toBe('42');
    expect(stringFormat('%f', 3.14)).toBe('3.140000');
    expect(stringFormat('%.2f', 3.14159)).toBe('3.14');
  });

  it('handles width and padding', () => {
    expect(stringFormat('%5d', 42)).toBe('   42');
    expect(stringFormat('%-5d|', 42)).toBe('42   |');
    expect(stringFormat('%05d', 42)).toBe('00042');
  });

  it('handles %s with width', () => {
    expect(stringFormat('%s', 'hi')).toBe('hi');
    expect(stringFormat('%10s', 'hi')).toBe('        hi');
    expect(stringFormat('%-10s|', 'hi')).toBe('hi        |');
  });

  it('handles %x / %X / %o', () => {
    expect(stringFormat('%x', 255)).toBe('ff');
    expect(stringFormat('%X', 255)).toBe('FF');
    expect(stringFormat('%o', 8)).toBe('10');
    expect(stringFormat('%#x', 255)).toBe('0xff');
  });

  it('handles %c / %% / %q', () => {
    expect(stringFormat('%c', 65)).toBe('A');
    expect(stringFormat('100%%')).toBe('100%');
    expect(stringFormat('%q', 'a "quoted" string')).toBe('"a \\"quoted\\" string"');
  });

  it('honors signs', () => {
    expect(stringFormat('%+d', 5)).toBe('+5');
    expect(stringFormat('%+d', -5)).toBe('-5');
    expect(stringFormat('% d', 5)).toBe(' 5');
  });
});
