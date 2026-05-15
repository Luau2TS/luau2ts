const SPECIALS = '().%+-*?[]^$';

export interface PatternMatch {
  /** Start index (0-based) in the input string. */
  start: number;
  /** End index (exclusive). */
  end: number;
  /** The whole match (substring [start, end)). */
  match: string;
  /** Captures, in order. Strings for `(pat)`, numbers for `()` position captures. */
  captures: (string | number)[];
}

interface Pattern {
  source: string;
  anchorStart: boolean;
  anchorEnd: boolean;
  /** Pattern minus leading ^ and trailing $. */
  body: string;
}

function classMatches(ch: string, cls: string): boolean {
  const c = ch.charCodeAt(0);
  const isLower = c >= 97 && c <= 122;
  const isUpper = c >= 65 && c <= 90;
  const isDigit = c >= 48 && c <= 57;
  const isAlpha = isLower || isUpper;
  const isAlnum = isAlpha || isDigit;
  const isHex = isDigit || (c >= 97 && c <= 102) || (c >= 65 && c <= 70);
  const isSpace = c === 32 || (c >= 9 && c <= 13);
  const isCtrl = c < 32 || c === 127;
  const isPunct = !isAlnum && !isSpace && !isCtrl && c >= 32;
  switch (cls) {
    case 'a':
      return isAlpha;
    case 'A':
      return !isAlpha;
    case 'd':
      return isDigit;
    case 'D':
      return !isDigit;
    case 's':
      return isSpace;
    case 'S':
      return !isSpace;
    case 'w':
      return isAlnum;
    case 'W':
      return !isAlnum;
    case 'l':
      return isLower;
    case 'L':
      return !isLower;
    case 'u':
      return isUpper;
    case 'U':
      return !isUpper;
    case 'p':
      return isPunct;
    case 'P':
      return !isPunct;
    case 'c':
      return isCtrl;
    case 'C':
      return !isCtrl;
    case 'x':
      return isHex;
    case 'X':
      return !isHex;
    default:
      return cls === ch;
  }
}

/**
 * Check if a single character matches a pattern atom starting at `p`.
 * Returns [matched, atom-length] — atom-length is how many pattern chars
 * to skip past after matching this atom.
 */
function matchClass(s: string, sIdx: number, p: string, pIdx: number): [boolean, number] {
  if (sIdx >= s.length) return [false, 0];
  const ch = s[sIdx]!;
  const pc = p[pIdx];
  if (pc === '.') return [true, 1];
  if (pc === '%') {
    const next = p[pIdx + 1];
    if (next === undefined) return [false, 1];
    return [classMatches(ch, next), 2];
  }
  if (pc === '[') {
    return matchSet(s, sIdx, p, pIdx);
  }
  return [pc === ch, 1];
}

function matchSet(s: string, sIdx: number, p: string, pIdx: number): [boolean, number] {
  // Find end of [...] — handle ] being literal at start, escaped chars
  let i = pIdx + 1;
  let negate = false;
  if (p[i] === '^') {
    negate = true;
    i += 1;
  }
  // Skip first char if it's ]
  if (p[i] === ']') i += 1;
  while (i < p.length && p[i] !== ']') {
    if (p[i] === '%') i += 2;
    else i += 1;
  }
  const setEnd = i; // index of closing ]
  const setLen = setEnd - pIdx + 1;
  if (sIdx >= s.length) return [false, setLen];
  const ch = s[sIdx]!;

  // Walk the set contents
  let cur = pIdx + 1;
  if (negate) cur += 1;
  let matched = false;
  while (cur < setEnd) {
    if (p[cur] === '%' && cur + 1 < setEnd) {
      if (classMatches(ch, p[cur + 1]!)) matched = true;
      cur += 2;
    } else if (cur + 2 < setEnd && p[cur + 1] === '-') {
      // Range like a-z
      const a = p[cur]!.charCodeAt(0);
      const b = p[cur + 2]!.charCodeAt(0);
      const c = ch.charCodeAt(0);
      if (c >= Math.min(a, b) && c <= Math.max(a, b)) matched = true;
      cur += 3;
    } else {
      if (p[cur] === ch) matched = true;
      cur += 1;
    }
  }
  return [matched !== negate, setLen];
}

interface MatchState {
  s: string;
  p: string;
  captureStarts: number[];
  captureEnds: number[];
  /** True for `()` position captures (no end). */
  capturePositions: boolean[];
}

function matchPattern(state: MatchState, sIdx: number, pIdx: number): number | null {
  if (pIdx >= state.p.length) return sIdx;

  const p = state.p;
  const pc = p[pIdx];

  // Captures
  if (pc === '(') {
    if (p[pIdx + 1] === ')') {
      // Position capture
      state.captureStarts.push(sIdx);
      state.captureEnds.push(sIdx);
      state.capturePositions.push(true);
      const result = matchPattern(state, sIdx, pIdx + 2);
      if (result === null) {
        state.captureStarts.pop();
        state.captureEnds.pop();
        state.capturePositions.pop();
      }
      return result;
    }
    state.captureStarts.push(sIdx);
    state.captureEnds.push(-1);
    state.capturePositions.push(false);
    const result = matchPattern(state, sIdx, pIdx + 1);
    if (result === null) {
      state.captureStarts.pop();
      state.captureEnds.pop();
      state.capturePositions.pop();
    }
    return result;
  }
  if (pc === ')') {
    // Close most recent unclosed capture
    for (let i = state.captureStarts.length - 1; i >= 0; i -= 1) {
      if (state.captureEnds[i] === -1) {
        state.captureEnds[i] = sIdx;
        const result = matchPattern(state, sIdx, pIdx + 1);
        if (result === null) state.captureEnds[i] = -1;
        return result;
      }
    }
    return null;
  }

  // End anchor
  if (pc === '$' && pIdx === p.length - 1) {
    return sIdx === state.s.length ? sIdx : null;
  }

  // Balanced %b<x><y>
  if (pc === '%' && p[pIdx + 1] === 'b') {
    const open = p[pIdx + 2];
    const close = p[pIdx + 3];
    if (open === undefined || close === undefined) return null;
    if (state.s[sIdx] !== open) return null;
    let depth = 1;
    let i = sIdx + 1;
    while (i < state.s.length) {
      if (state.s[i] === open) depth += 1;
      else if (state.s[i] === close) {
        depth -= 1;
        if (depth === 0) return matchPattern(state, i + 1, pIdx + 4);
      }
      i += 1;
    }
    return null;
  }

  // Back-reference %1..%9
  if (pc === '%' && p[pIdx + 1] && /[1-9]/.test(p[pIdx + 1]!)) {
    const idx = parseInt(p[pIdx + 1]!, 10) - 1;
    const start = state.captureStarts[idx];
    const end = state.captureEnds[idx];
    if (start === undefined || end === undefined || end < 0) return null;
    const captured = state.s.slice(start, end);
    if (state.s.slice(sIdx, sIdx + captured.length) !== captured) return null;
    return matchPattern(state, sIdx + captured.length, pIdx + 2);
  }

  // Single-atom pattern with quantifier
  const [match, atomLen] = matchClass(state.s, sIdx, p, pIdx);
  const next = p[pIdx + atomLen];

  if (next === '*') {
    // Greedy 0+
    let count = 0;
    while (matchClass(state.s, sIdx + count, p, pIdx)[0]) count += 1;
    while (count >= 0) {
      const r = matchPattern(state, sIdx + count, pIdx + atomLen + 1);
      if (r !== null) return r;
      count -= 1;
    }
    return null;
  }
  if (next === '+') {
    if (!match) return null;
    let count = 1;
    while (matchClass(state.s, sIdx + count, p, pIdx)[0]) count += 1;
    while (count >= 1) {
      const r = matchPattern(state, sIdx + count, pIdx + atomLen + 1);
      if (r !== null) return r;
      count -= 1;
    }
    return null;
  }
  if (next === '-') {
    // Lazy 0+
    let count = 0;
    while (true) {
      const r = matchPattern(state, sIdx + count, pIdx + atomLen + 1);
      if (r !== null) return r;
      if (!matchClass(state.s, sIdx + count, p, pIdx)[0]) return null;
      count += 1;
    }
  }
  if (next === '?') {
    if (match) {
      const r = matchPattern(state, sIdx + 1, pIdx + atomLen + 1);
      if (r !== null) return r;
    }
    return matchPattern(state, sIdx, pIdx + atomLen + 1);
  }

  if (!match) return null;
  return matchPattern(state, sIdx + 1, pIdx + atomLen);
}

function compile(pattern: string): Pattern {
  let body = pattern;
  let anchorStart = false;
  let anchorEnd = false;
  if (body.startsWith('^')) {
    anchorStart = true;
    body = body.slice(1);
  }
  if (body.endsWith('$') && !body.endsWith('%$')) {
    anchorEnd = true;
    body = body.slice(0, -1);
  }
  return { source: pattern, anchorStart, anchorEnd, body };
}

/** Find a pattern in a string, starting at `init`. Returns null if no match. */
export function patternFind(pattern: string, s: string, init = 0): PatternMatch | null {
  const compiled = compile(pattern);
  const fullPattern = compiled.body + (compiled.anchorEnd ? '$' : '');

  const tryAt = (idx: number): PatternMatch | null => {
    const state: MatchState = {
      s,
      p: fullPattern,
      captureStarts: [],
      captureEnds: [],
      capturePositions: [],
    };
    const end = matchPattern(state, idx, 0);
    if (end === null) return null;
    const captures: (string | number)[] = [];
    for (let i = 0; i < state.captureStarts.length; i += 1) {
      if (state.capturePositions[i]) {
        captures.push(state.captureStarts[i]! + 1); // 1-indexed for Lua
      } else {
        captures.push(s.slice(state.captureStarts[i], state.captureEnds[i]));
      }
    }
    return { start: idx, end, match: s.slice(idx, end), captures };
  };

  if (compiled.anchorStart) return tryAt(init);
  for (let i = init; i <= s.length; i += 1) {
    const m = tryAt(i);
    if (m) return m;
  }
  return null;
}

/** Replace pattern matches with `repl`. */
export function patternGsub(
  pattern: string,
  s: string,
  repl:
    | string
    | ((match: string, ...captures: (string | number)[]) => string)
    | Record<string, string>,
  maxReplacements?: number,
): { result: string; count: number } {
  const out: string[] = [];
  let idx = 0;
  let count = 0;
  while (idx <= s.length) {
    if (maxReplacements !== undefined && count >= maxReplacements) break;
    const m = patternFind(pattern, s, idx);
    if (!m) break;
    out.push(s.slice(idx, m.start));
    let replacement: string;
    if (typeof repl === 'function') {
      const args = m.captures.length > 0 ? m.captures : [m.match];
      replacement = String(repl(m.match, ...m.captures) ?? args[0]);
    } else if (typeof repl === 'object') {
      const key = m.captures.length > 0 ? String(m.captures[0]) : m.match;
      replacement = String(repl[key] ?? m.match);
    } else {
      // String with %0 for whole match, %1..%9 for captures
      replacement = repl.replace(/%(\d|%)/g, (_, d) => {
        if (d === '%') return '%';
        const i = parseInt(d, 10);
        if (i === 0) return m.match;
        return String(m.captures[i - 1] ?? '');
      });
    }
    out.push(replacement);
    if (m.end === m.start) {
      // Zero-length match — emit current char and advance, else infinite loop.
      if (idx < s.length) out.push(s[idx]!);
      idx += 1;
    } else {
      idx = m.end;
    }
    count += 1;
  }
  out.push(s.slice(idx));
  return { result: out.join(''), count };
}

/** Iterate over all matches. */
export function* patternGmatch(
  pattern: string,
  s: string,
): Generator<string | (string | number)[], void, undefined> {
  let idx = 0;
  while (idx <= s.length) {
    const m = patternFind(pattern, s, idx);
    if (!m) break;
    if (m.captures.length > 0) yield m.captures;
    else yield m.match;
    idx = m.end === m.start ? m.start + 1 : m.end;
  }
}

// Re-export specials for testing / escaping
export const PATTERN_SPECIALS = SPECIALS;
