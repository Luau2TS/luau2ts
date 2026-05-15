import { describe, expect, it } from 'vitest';
import { patternFind, patternGmatch, patternGsub } from './pattern.js';

describe('pattern', () => {
  describe('character classes', () => {
    it('matches %a / %d / %s / %w', () => {
      expect(patternFind('%a+', 'hello123')?.match).toBe('hello');
      expect(patternFind('%d+', 'abc456def')?.match).toBe('456');
      expect(patternFind('%s+', 'foo  bar')?.match).toBe('  ');
      // Lua's %w is alphanumeric only — does NOT include underscore (unlike PCRE \w).
      expect(patternFind('%w+', '_abc-123_def')?.match).toBe('abc');
    });

    it('matches negated classes %A / %D / %S', () => {
      expect(patternFind('%D+', '12abc34')?.match).toBe('abc');
    });

    it('. matches any character', () => {
      expect(patternFind('a.c', 'aXc')?.match).toBe('aXc');
      expect(patternFind('a.c', 'a.c')?.match).toBe('a.c');
    });
  });

  describe('quantifiers', () => {
    it('* matches 0 or more (greedy)', () => {
      expect(patternFind('a*', 'aaab')?.match).toBe('aaa');
      expect(patternFind('x*', 'abc')?.match).toBe(''); // 0 is fine
    });

    it('+ requires 1 or more', () => {
      expect(patternFind('a+', 'aaab')?.match).toBe('aaa');
      expect(patternFind('x+', 'abc')).toBeNull();
    });

    it('- is lazy 0+', () => {
      const m = patternFind('<.->', '<a><b>');
      expect(m?.match).toBe('<a>');
    });

    it('? matches 0 or 1', () => {
      expect(patternFind('colou?r', 'color')?.match).toBe('color');
      expect(patternFind('colou?r', 'colour')?.match).toBe('colour');
    });
  });

  describe('anchors', () => {
    it('^ anchors to start', () => {
      expect(patternFind('^abc', 'abcdef')?.match).toBe('abc');
      expect(patternFind('^abc', 'xabc')).toBeNull();
    });

    it('$ anchors to end', () => {
      expect(patternFind('xyz$', 'abxyz')?.match).toBe('xyz');
      expect(patternFind('xyz$', 'xyzab')).toBeNull();
    });
  });

  describe('sets', () => {
    it('handles [abc]', () => {
      expect(patternFind('[abc]+', 'xxabaxx')?.match).toBe('aba');
    });

    it('handles negated [^abc]', () => {
      expect(patternFind('[^abc]+', 'aabXYZ')?.match).toBe('XYZ');
    });

    it('handles ranges [a-z]', () => {
      expect(patternFind('[A-Z]+', 'abcDEFghi')?.match).toBe('DEF');
    });

    it('handles class members in sets', () => {
      expect(patternFind('[%d_]+', 'abc_123_xyz')?.match).toBe('_123_');
    });
  });

  describe('captures', () => {
    it('returns captures alongside match', () => {
      const m = patternFind('(%a+) (%a+)', 'hello world');
      expect(m?.captures).toEqual(['hello', 'world']);
    });

    it('position captures with ()', () => {
      const m = patternFind('()foo', 'xxfoo');
      expect(m?.captures).toEqual([3]); // 1-indexed
    });
  });

  describe('balanced matches %b', () => {
    it('matches balanced parens', () => {
      const m = patternFind('%b()', 'pre(a(b)c)post');
      expect(m?.match).toBe('(a(b)c)');
    });
  });

  describe('gsub', () => {
    it('replaces all matches with a string', () => {
      const { result, count } = patternGsub('%d+', 'abc 12 xyz 34', '#');
      expect(result).toBe('abc # xyz #');
      expect(count).toBe(2);
    });

    it('uses %0..%9 in replacement string', () => {
      const { result } = patternGsub('(%a+) (%a+)', 'hello world', '%2 %1');
      expect(result).toBe('world hello');
    });

    it('uses a function replacement', () => {
      const { result } = patternGsub('%d+', 'a1 b2 c3', (m) => `[${m}]`);
      expect(result).toBe('a[1] b[2] c[3]');
    });

    it('honors max replacement count', () => {
      const { result, count } = patternGsub('%d', 'a1b2c3', '#', 2);
      expect(result).toBe('a#b#c3');
      expect(count).toBe(2);
    });
  });

  describe('gmatch', () => {
    it('iterates whole matches when no captures', () => {
      const collected = [...patternGmatch('%d+', 'a 1 b 22 c 333')];
      expect(collected).toEqual(['1', '22', '333']);
    });

    it('iterates captures when present', () => {
      const collected = [...patternGmatch('(%a+)=(%d+)', 'x=1 y=22 z=333')];
      expect(collected).toEqual([
        ['x', '1'],
        ['y', '22'],
        ['z', '333'],
      ]);
    });
  });
});
