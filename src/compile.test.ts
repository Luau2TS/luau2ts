import { describe, expect, it } from 'vitest';
import { compile as _compile, type CompileOptions } from './compile/index.js';

// Test wrapper: defaults to pretty: false (so assertions don't fight
// Prettier's formatting decisions) and postEmitCheck: false (because
// Layer A adds ~500ms per call, blowing past Vitest's 5s timeout on
// any test that compiles in a loop). The Prettier and Layer A paths
// are exercised by their own dedicated tests. Individual tests can
// re-enable either by passing `{ pretty: true }` or
// `{ postEmitCheck: true }` explicitly.
const compile = (source: string, options?: CompileOptions) =>
  _compile(source, { pretty: false, postEmitCheck: false, ...(options ?? {}) });

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

describe('compile — top-level', () => {
  it('emits a runtime import only when helpers are needed', async () => {
    const noHelpers = await compile('local x = 1');
    expect(noHelpers.source).not.toContain('luau2ts/runtime');
    expect(noHelpers.helpers).toEqual([]);

    const withHelpers = await compile('local x = #t');
    expect(withHelpers.source).toContain('luau2ts/runtime');
    expect(withHelpers.helpers).toContain('lualen');
  });

  it('preserves variable names', async () => {
    const r = await compile('local myVariable = 42');
    expect(r.source).toContain('let myVariable = 42');
  });

  it('escapes JS-reserved variable names', async () => {
    const r = await compile('local class = 1\nlocal yield = 2');
    expect(r.source).toContain('class_');
    expect(r.source).toContain('yield_');
  });

  it('returns parse errors without throwing', async () => {
    const r = await compile('local = ');
    expect(r.errors.length).toBeGreaterThan(0);
    expect(typeof r.source).toBe('string');
  });
});

describe('compile — statements', () => {
  it('local declarations with multiple vars and values', async () => {
    const r = await compile('local a, b, c = 1, 2, 3');
    expect(norm(r.source)).toContain('let a = 1, b = 2, c = 3');
  });

  it('local with no initializer', async () => {
    const r = await compile('local x');
    expect(norm(r.source)).toContain('let x;');
  });

  it('expression statement', async () => {
    const r = await compile('print("hi")');
    expect(norm(r.source)).toContain('print("hi");');
  });

  it('multi-value return: native mode emits JS array', async () => {
    const r = await compile('local function pair() return "abc", 123 end');
    expect(r.source).toContain('return ["abc", 123];');
    expect(r.source).not.toContain('$tuple');
    expect(r.source).not.toContain('LuaTuple');
  });

  it('multi-value return: rbxts mode emits $tuple + LuaTuple annotation', async () => {
    const r = await compile('local function pair() return "abc", 123 end', {
      compatMode: 'rbxts',
    });
    expect(r.source).toContain('$tuple("abc", 123)');
    expect(r.source).toContain('LuaTuple');
    // @rbxts/types is a globals-only package — `LuaTuple` is declared
    // ambiently, not exported. Don't emit an import (would trip TS2306
    // "is not a module" under roblox-ts strict mode).
    expect(r.source).not.toContain('@rbxts/types');
  });

  it('multi-value return: mixed-arity functions drop the LuaTuple annotation', async () => {
    // When some branches return multiple values and others return one
    // (or zero), there's no single LuaTuple<[…]> that fits every
    // path — the short-return branch fails TS2322 ("undefined not
    // assignable to LuaTuple<[unknown, unknown]>"). Skip the
    // annotation and let TS infer; the multi-return $tuple call
    // still surfaces so roblox-ts macros it back to Lua multi-return.
    const r = await compile(
      `local function f(x)
         if x then return 1, 2 end
         return 0
       end`,
      { compatMode: 'rbxts' },
    );
    expect(r.source).toContain('$tuple(1, 2)');
    expect(r.source).not.toMatch(/LuaTuple</);
  });

  it('multi-value return: uniform multi-return keeps the LuaTuple annotation', async () => {
    // Every branch returns the same arity → safe to widen the return
    // type to LuaTuple<[…]> so roblox-ts's recognizer emits real Lua
    // multi-return instead of a wrapped table.
    const r = await compile(
      `local function f(x)
         if x then return 1, 2 end
         return 3, 4
       end`,
      { compatMode: 'rbxts' },
    );
    expect(r.source).toContain('$tuple(1, 2)');
    expect(r.source).toContain('$tuple(3, 4)');
    expect(r.source).toMatch(/LuaTuple<\[\s*unknown\s*,\s*unknown\s*\]>/);
  });

  it('single-value return: rbxts mode leaves the return alone', async () => {
    const r = await compile('local function f() return 42 end', { compatMode: 'rbxts' });
    expect(r.source).toContain('return 42;');
    expect(r.source).not.toContain('$tuple');
    expect(r.source).not.toContain('LuaTuple');
  });

  it('return statements', async () => {
    expect(norm((await compile('return')).source)).toContain('return;');
    expect(norm((await compile('return 1')).source)).toContain('return 1;');
    expect(norm((await compile('return 1, 2')).source)).toContain('return [1, 2];');
  });

  it('assignment + compound assignment', async () => {
    const a = await compile('x = 5');
    expect(norm(a.source)).toContain('x = 5;');
    const b = await compile('x += 1');
    expect(norm(b.source)).toContain('x += 1;');
    const c = await compile('s ..= "hi"');
    expect(c.source).toContain('luaConcat');
  });

  it('table[k] = v with non-literal key routes through luaIndexSet', async () => {
    // `luaIndex(t, k) = v` is not a valid TS lvalue; the compiler must
    // pair the read-side luaIndex with a luaIndexSet helper for writes.
    const r = await compile(`
      local t = {}
      local k = "foo"
      t[k] = 42
    `);
    expect(r.source).toContain('luaIndexSet(t, k, 42)');
    expect(r.source).not.toMatch(/luaIndex\([^)]*\)\s*=/);
    expect(r.helpers).toContain('luaIndexSet');
  });

  it('table[k] += v with non-literal key expands to luaIndexSet + luaIndex', async () => {
    const r = await compile(`
      local t = {}
      local k = "foo"
      t[k] += 1
    `);
    expect(r.source).toContain('luaIndexSet(t, k,');
    expect(r.source).toContain('luaIndex(t, k)');
    expect(r.source).not.toMatch(/luaIndex\([^)]*\)\s*\+=/);
  });

  it('table[literal] = v stays as plain bracket assignment', async () => {
    const r = await compile(`
      local t = {}
      t[1] = "a"
      t["k"] = "b"
    `);
    expect(r.source).toContain('t[0] = "a"');
    expect(r.source).toContain('t["k"] = "b"');
    expect(r.source).not.toContain('luaIndexSet');
  });

  it('if / elseif / else', async () => {
    const r = await compile('if a then x = 1 elseif b then x = 2 else x = 3 end');
    const out = r.source;
    // Conditions on unknown-typed expressions route through `isTruthy()`
    // — shorter than the inline 6-clause fallback we used previously.
    expect(out).toContain('isTruthy(a)');
    expect(out).toContain('isTruthy(b)');
    expect(out).toContain('if (');
    expect(out).toContain('else if');
    expect(out).toContain('else');
    expect(r.helpers).toContain('isTruthy');
  });

  it('compiles if conditions before branch bodies can narrow locals', async () => {
    const r = await compile(`
      local minP
      if not minP then
        minP = Vector3.new(0, 0, 0)
      else
        minP = Vector3.new(minP.X, minP.Y, minP.Z)
      end
    `);
    expect(r.source).toContain('isTruthy(minP)');
    expect(r.source).not.toContain('if (!(true))');
  });

  it('while loop with break/continue', async () => {
    const r = await compile('while x do break end');
    expect(r.source).toContain('while (isTruthy(x))');
    expect(r.source).toContain('break;');

    const r2 = await compile('while x do continue end');
    expect(r2.source).toContain('continue;');
  });

  it('repeat/until inverts condition (do-while equivalent)', async () => {
    const r = await compile('repeat x = 1 until done');
    expect(r.source).toContain('do {');
    expect(r.source).toContain('} while (!isTruthy(done))');
  });
});

describe('compile — expressions', () => {
  it('every literal kind', async () => {
    expect((await compile('return nil')).source).toContain('return null;');
    expect((await compile('return true')).source).toContain('return true;');
    expect((await compile('return false')).source).toContain('return false;');
    expect((await compile('return 42')).source).toContain('return 42;');
    expect((await compile('return 3.14')).source).toContain('return 3.14;');
    expect((await compile('return "hi"')).source).toContain('return "hi";');
    expect((await compile('return -5')).source).toContain('return -5;');
  });

  it('binary arithmetic routes through helpers (so Vector3/CFrame ops work)', async () => {
    const r = await compile('return a + b * c - d / e % f');
    // Helpers are required because JS has no operator overloading on
    // objects; luaAdd / luaMul / etc. fast-path numeric operands but
    // dispatch to .add/.mul/__add/__mul on Roblox-style objects.
    expect(r.helpers).toEqual(
      expect.arrayContaining(['luaAdd', 'luaMul', 'luaSub', 'luaDiv', 'luaMod']),
    );
  });

  it('arithmetic on statically-typed datatypes routes through methods', async () => {
    // `Vector3.new(...)` narrows the result to datatype:Vector3, so the
    // subsequent `+` skips the `luaAdd` indirection and emits `.add(…)`.
    const r = await compile(`
      local v1 = Vector3.new(1, 2, 3)
      local v2 = Vector3.new(4, 5, 6)
      local sum = v1 + v2
      local scaled = v1 * 2
    `);
    expect(r.source).toContain('v1.add(v2)');
    expect(r.source).toContain('v1.mul(2)');
    expect(r.helpers ?? []).not.toContain('luaAdd');
    expect(r.helpers ?? []).not.toContain('luaMul');
  });

  it('annotated Vector3 parameter narrows for arithmetic', async () => {
    const r = await compile(`
      local function add(a: Vector3, b: Vector3) return a + b end
    `);
    expect(r.source).toContain('a.add(b)');
    expect(r.helpers ?? []).not.toContain('luaAdd');
  });

  it('mixed datatype + unknown still uses helper (safe fallback)', async () => {
    const r = await compile('return a + Vector3.new(0, 1, 0)');
    // Left is unknown, so we keep luaAdd to dispatch via the right's __add.
    expect(r.helpers).toContain('luaAdd');
  });

  it('comparison operators', async () => {
    const r = await compile('return a == b, a ~= b, a < b, a <= b');
    // == routes through luaEq (handles __eq metamethod); < and <= stay direct
    expect(r.helpers).toContain('luaEq');
    expect(r.source).toContain('!luaEq(a, b)'); // ~= is !luaEq
    expect(r.source).toContain('a < b');
    expect(r.source).toContain('a <= b');
  });

  it('and/or/not route through Lua-truthiness helpers', async () => {
    const r = await compile('return a and b or not c');
    expect(r.helpers).toContain('isTruthy');
    expect(r.helpers).not.toEqual(expect.arrayContaining(['luaAnd', 'luaOr', 'luaNot']));
  });

  it('string concat (..) — both literal sides fold to template literal', async () => {
    const r = await compile('return "a" .. "b"');
    // Beautified emit: when at least one side is statically string, fold
    // to a TS template literal; no luaConcat helper needed.
    expect(r.source).toContain('`ab`');
    expect(r.helpers ?? []).not.toContain('luaConcat');
  });

  it('string concat (..) — mixed string + unknown produces template literal', async () => {
    const r = await compile('return "hello, " .. name');
    expect(r.source).toContain('`hello, ${name}`');
    expect(r.helpers ?? []).not.toContain('luaConcat');
  });

  it('string concat (..) — both unknown sides keep luaConcat helper', async () => {
    const r = await compile('return a .. b');
    expect(r.helpers).toContain('luaConcat');
  });

  it('floor division (//) uses luaIdiv', async () => {
    const r = await compile('return a // b');
    expect(r.helpers).toContain('luaIdiv');
  });

  it('length (#) uses lualen', async () => {
    const r = await compile('return #t');
    expect(r.helpers).toContain('lualen');
  });

  it('unary minus emits direct -x', async () => {
    const r = await compile('return -a');
    expect(r.source).toContain('return -a;');
  });

  it('property access via dot and bracket', async () => {
    expect((await compile('return t.k')).source).toContain('t.k');
    expect((await compile('return t["a key"]')).source).toContain('t["a key"]');
  });

  it('regular calls and method calls (`obj:m(arg)`)', async () => {
    expect((await compile('return f(1, 2)')).source).toContain('f(1, 2)');
    expect((await compile('return t:m(1)')).source).toContain('t.m(1)');
  });

  it('parenthesized groups preserved', async () => {
    const r = await compile('return (a + b) * c');
    // Arithmetic now routes through helpers — the group structure shows
    // up as nested calls.
    expect(r.source).toContain('luaMul((luaAdd(a, b)), c)');
  });
});

describe('compile — functions', () => {
  it('non-yielding functions skip the async modifier', async () => {
    // `pure(x)` body has no awaits → emit a sync function.
    const pureSrc = await compile('local function pure(x) return x * 2 end');
    expect(pureSrc.source).not.toContain('async function pure');
    expect(pureSrc.source).toContain('function pure');

    // Calling `task.wait` is a yielding call → keep the async modifier.
    const yieldSrc = await compile('local function withWait() task.wait(1) end');
    expect(yieldSrc.source).toContain('async function withWait');
  });

  it('local function declaration', async () => {
    const r = await compile('local function add(a, b) return a + b end');
    expect(norm(r.source)).toContain('function add(a, b)');
    expect(r.source).toContain('return luaAdd(a, b)');
  });

  it('global function declaration', async () => {
    const r = await compile('function greet(name) return "hi " .. name end');
    expect(norm(r.source)).toContain('function greet(name)');
  });

  it('member function (`function obj.m(args) end`)', async () => {
    // No yielding calls inside; emitted as plain (non-async) function.
    const r = await compile('function obj.fn(x) return x end');
    expect(r.source).toContain('obj.fn = function');
    expect(r.source).not.toContain('async function');
  });

  it('member function with yielding call → async', async () => {
    const r = await compile('function obj.fn() wait(1) end');
    // Async member assignments cast the base through `any` so a typed
    // impl-type slot (`fn: () -> ()`) doesn't reject the `Promise<void>`
    // return. The right-hand side is still emitted as `async function`.
    expect(norm(r.source)).toMatch(/\(obj as any\)\.fn = async function/);
  });

  it('assignment with yielding function rhs propagates await to call sites', async () => {
    // Old Roblox Animate scripts declare `waitForChild` as a plain global
    // assignment with a function expression rhs (not `function name() end`).
    // The scanYieldingFunctions pre-pass must catalog these so call sites
    // get `await` — otherwise `Humanoid = waitForChild(...)` binds a Promise
    // and `Humanoid.Died.connect(...)` blows up with "Cannot read properties
    // of undefined (reading 'connect')".
    const r = await compile(
      'waitForChild = function(p, n) return p.ChildAdded:wait() end\n' +
      'local h = waitForChild(figure, "Humanoid")\n',
    );
    expect(r.source).toContain('waitForChild = async function');
    expect(r.source).toContain('await waitForChild(figure');
  });

  it('method with self bound to this', async () => {
    const r = await compile('function t:greet(name) return name end');
    // The self-binding line is generated inside the method body.
    expect(r.source).toContain('const self = this');
  });

  it('anonymous function expression', async () => {
    const r = await compile('local f = function(x) return x * 2 end');
    // No yielding calls — async modifier omitted.
    expect(r.source).toContain('let f = function');
    expect(r.source).not.toContain('async function');
    expect(r.source).toContain('return luaMul(x, 2)');
  });

  it('typed parameters and return', async () => {
    const r = await compile('local function add(a: number, b: number): number return a + b end');
    expect(r.source).toContain('a: number');
    expect(r.source).toContain('b: number');
    expect(r.source).toContain('): number');
  });

  it('vararg functions become rest parameters', async () => {
    const r = await compile('local function f(...) return ... end');
    expect(r.source).toContain('...__varargs');
  });
});

describe('compile — tables', () => {
  it('list-only emits an array literal', async () => {
    const r = await compile('local t = {1, 2, 3}');
    expect(r.source).toContain('let t = [1, 2, 3]');
  });

  it('record-only emits an object literal with identifier keys', async () => {
    const r = await compile('local t = {name = "x", count = 5}');
    expect(r.source).toContain('name: "x"');
    expect(r.source).toContain('count: 5');
  });

  it('mixed list+record emits an object with 1-indexed numeric keys', async () => {
    const r = await compile('local t = {1, 2, foo = "bar"}');
    expect(r.source).toContain('1: 1');
    expect(r.source).toContain('2: 2');
    expect(r.source).toContain('foo: "bar"');
  });

  it('general (computed) keys with [expr] = value', async () => {
    const r = await compile('local t = {["a key"] = 1}');
    expect(r.source).toContain('["a key"]: 1');
  });
});

describe('compile — for loops', () => {
  // Beautified emit: numeric `for` loops with constant-positive step
  // become idiomatic `for (let i = 1; i <= N; i++)` instead of the
  // hoisted-bounds-with-runtime-direction-check expansion. Negative-step
  // and runtime-step variants still use the slower expansion.

  it('numeric for loop with default step → i++', async () => {
    const r = await compile('for i = 1, 10 do print(i) end');
    expect(r.source).toContain('for (let i = 1; i <= 10; i++)');
    expect(r.source).not.toContain('__for_i_to');
  });

  it('numeric for with literal positive step → i += step', async () => {
    const r = await compile('for i = 1, 10, 2 do end');
    expect(r.source).toContain('for (let i = 1; i <= 10; i += 2)');
    expect(r.source).not.toContain('__for_i_step');
  });

  it('numeric for with literal negative step → i-- / i -= step', async () => {
    const r1 = await compile('for i = 10, 1, -1 do end');
    expect(r1.source).toContain('for (let i = 10; i >= 1; i--)');
    const r2 = await compile('for i = 10, 0, -2 do end');
    expect(r2.source).toContain('for (let i = 10; i >= 0; i -= 2)');
  });

  it('numeric for with runtime step keeps the iterator-protocol expansion', async () => {
    const r = await compile('for i = 1, 10, x do end');
    // x is a runtime expression — direction unknown statically — so we
    // fall back to the hoisted-bounds form.
    expect(r.source).toContain('__for_i_to');
    expect(r.source).toContain('__for_i_step');
  });

  it('for _, v in ipairs(arr) → indexed array loop', async () => {
    const r = await compile('for _, v in ipairs(arr) do print(v) end');
    expect(r.source).toMatch(/for \(let __i_\d+ = 0; __i_\d+ < arr\.length; __i_\d+\+\+\)/);
    expect(r.source).toMatch(/let v = arr\[__i_\d+\]/);
    expect(r.source).not.toContain('__iter');
  });

  it('for i, v in ipairs(arr) → indexed array loop with 1-indexed prelude', async () => {
    const r = await compile('for i, v in ipairs(arr) do print(i, v) end');
    expect(r.source).toMatch(/for \(let __i_\d+ = 0; __i_\d+ < arr\.length; __i_\d+\+\+\)/);
    expect(r.source).toMatch(/let i = __i_\d+ \+ 1/);
    expect(r.source).toMatch(/let v = arr\[__i_\d+\]/);
  });

  it('for k in pairs(t) → for (let k of pairKeys(t))', async () => {
    const r = await compile('for k in pairs(t) do print(k) end');
    expect(r.source).toContain('for (let k of pairKeys(t))');
  });

  it('for k, v in pairs(t) → pairKeys + pairValue lookup', async () => {
    const r = await compile('for k, v in pairs(t) do print(k, v) end');
    expect(r.source).toContain('for (let k of pairKeys(t))');
    expect(r.source).toContain('pairValue(t, k)');
  });

  it('pairs hoist temps are unique for non-identifier tables', async () => {
    const r = await compile(`
      for k, v in pairs(getA()) do print(k, v) end
      for k, v in pairs(getB()) do print(k, v) end
    `);
    const hoists = [...r.source.matchAll(/const (__t_\d+) = get[AB]\(\)/g)];
    expect(hoists).toHaveLength(2);
    expect(hoists[0]![1]).not.toBe(hoists[1]![1]);
  });

  it('non-pairs/ipairs iterator falls back to the protocol expansion', async () => {
    const r = await compile('for k, v in customIter do print(k, v) end');
    expect(r.source).toMatch(/let \[__iter_\d+, __state_\d+, __ctrl_\d+\]/);
    expect(r.source).toContain('while (true)');
    expect(r.source).toMatch(/let \[k, v\] = __step_\d+/);
  });

  it('slow generic iterator temps are unique across sibling loops', async () => {
    const r = await compile(`
      for k, v in customIter do print(k, v) end
      for k, v in otherIter do print(k, v) end
    `);
    const iterDeclarations = [...r.source.matchAll(/let \[(__iter_\d+), (__state_\d+), (__ctrl_\d+)\]/g)];
    expect(iterDeclarations).toHaveLength(2);
    expect(iterDeclarations[0]![1]).not.toBe(iterDeclarations[1]![1]);
    expect(iterDeclarations[0]![2]).not.toBe(iterDeclarations[1]![2]);
    expect(iterDeclarations[0]![3]).not.toBe(iterDeclarations[1]![3]);
  });
});

describe('compile — types', () => {
  it('local with type annotation emits TS type', async () => {
    const r = await compile('local x: number = 1');
    expect(r.source).toContain('let x: number = 1');
  });

  it('typed locals with generic refs', async () => {
    const r = await compile('local x: { [string]: number } = {}');
    expect(r.source).toContain('[key: string]: number');
  });

  it('union, intersection, optional', async () => {
    const r = await compile(
      'local a: number | string = 1\nlocal b: A & B = nil\nlocal c: string? = nil',
    );
    expect(r.source).toContain('number | string');
    expect(r.source).toContain('A & B');
    // string? in Luau desugars to string | nil
    expect(r.source).toContain('string | null');
  });

  it('typeof reference', async () => {
    const r = await compile('local t: typeof(x) = nil');
    expect(r.source).toContain('typeof x');
  });

  it('singleton string and bool types', async () => {
    const r = await compile('local k: "literal" | true = nil');
    expect(r.source).toContain('"literal" | true');
  });
});

describe('compile — type aliases & declares', () => {
  it('type alias with generics', async () => {
    const r = await compile('type Box<T> = { value: T }');
    expect(r.source).toContain('type Box<T>');
    expect(r.source).toContain('value: T');
  });

  it('type alias with generic type pack', async () => {
    // `type Foo<T...> = ...` declared the alias without the generic param,
    // then `Foo<T...>` references collapsed to `Foo<unknown>` — declaration
    // vs. reference mismatched and tsc surfaced "Type 'Foo' is not generic".
    const r = await compile(`
      type Sig<T...> = {
        fire: (Sig<T...>, T...) -> (),
      }
    `);
    // Declaration carries the pack-as-tuple generic.
    expect(r.source).toMatch(/type Sig<T extends unknown\[\] = unknown\[\]>/);
    // Self-reference `Sig<T...>` uses the same name, NOT `Sig<unknown>`.
    expect(r.source).toContain('Sig<T>');
    expect(r.source).not.toContain('Sig<unknown>');
  });

  it('type alias generic-pack reference with multiple positional args is grouped as a tuple', async () => {
    // `Signal<a, b, c>` against `type Signal<T...>` means T... = (a, b, c).
    // Without grouping it emits `Signal<a, b, c>` (three TS generics) and
    // tsc flags "requires between 0 and 1 type arguments".
    const r = await compile(`
      type Signal<T...> = (T...) -> ()
      type X = Signal<string, number>
    `);
    expect(norm(r.source)).toContain('type X = Signal<[ string, number ]>');
  });

  it('typeof(setmetatable(body :: B, meta :: M)) intersects body and meta', async () => {
    // Luau's canonical "instance type" idiom — without this it collapses
    // to `unknown` and every `self.field` cascades.
    const r = await compile(`
      type Inst = typeof(setmetatable({} :: { x: number }, {} :: { add: (Inst) -> () }))
    `);
    expect(r.source).toMatch(/x: number/);
    expect(r.source).toMatch(/add:/);
  });

  it('mapped type emitted for union-literal indexer', async () => {
    // `{ [LogLevel]: number }` with `type LogLevel = "a" | "b"` can't
    // become a plain TS index signature `[key: LogLevel]: number` (1337
    // rejects literal-union keys). Emit `{ [K in LogLevel]: number }`.
    const r = await compile(`
      type LogLevel = "trace" | "info"
      type Order = { [LogLevel]: number }
    `);
    expect(r.source).toContain('[K in LogLevel]: number');
  });

  it('{T} (Luau array shorthand) emits as T[] not numeric index signature', async () => {
    const r = await compile('type Names = { string }');
    expect(r.source).toContain('type Names = string[]');
    expect(r.source).not.toMatch(/\[key: number\]: string/);
  });

  it('trailing nilable params become call-site-optional via `= null` default', async () => {
    const r = await compile(`
      local function f(a: string, b: string?, c: number?) end
    `);
    // Previously emitted `b?: string | null` (which widens in-body to
    // `string | null | undefined` and conflicts with `T | null`-typed
    // receivers). Now emits `b: string | null = null` — same call-site
    // optionality, but in-body type stays the declared `T | null`.
    expect(r.source).toMatch(/b: string \| null = null/);
    expect(r.source).toMatch(/c: number \| null = null/);
    expect(r.source).toMatch(/a: string,/);
    expect(r.source).not.toMatch(/b\?:/);
  });

  it('async function with return annotation wraps return type in Promise', async () => {
    const r = await compile(`
      local function f(): number
        task.wait(1)
        return 1
      end
    `);
    // task.wait is yielding → body uses await → return type must be Promise<T>.
    expect(r.source).toMatch(/Promise<number>/);
  });

  it('module-trailing return becomes export default', async () => {
    const r = await compile(`
      local M = { x = 1 }
      return M
    `);
    expect(r.source).toContain('export default M');
    // The trailing top-level `return` is gone.
    expect(r.source).not.toMatch(/return M;?\s*$/);
  });

  it('runtime globals (setmetatable, table, os, pcall, error) auto-import', async () => {
    const r = await compile(`
      local function f()
        local t = setmetatable({}, {})
        table.insert(t, 1)
        pcall(error, "oops")
        return os.time()
      end
    `);
    expect(r.helpers).toContain('setmetatable');
    expect(r.helpers).toContain('table');
    expect(r.helpers).toContain('pcall');
    expect(r.helpers).toContain('error');
    expect(r.helpers).toContain('os');
  });

  it('ambient globals (task, game, workspace) become `declare const`', async () => {
    const r = await compile(`
      task.spawn(function() print(workspace.Name) end)
    `);
    expect(r.source).toContain('declare const task: any');
    expect(r.source).toContain('declare const workspace: any');
    expect(r.source).toContain('declare const print: any');
  });

  it('exported type alias', async () => {
    const r = await compile('export type Foo = number');
    expect(r.source).toContain('export type Foo = number');
  });

  it('declare global', async () => {
    const r = await compile('declare game: any');
    expect(r.source).toContain('declare const game: any');
  });

  it('declare function', async () => {
    const r = await compile('declare function require(p: string): any');
    expect(r.source).toContain('declare function require');
    expect(r.source).toContain('p: string');
  });
});

describe('compile — multi-return destructuring', () => {
  it('local with multiple LHS and single Call RHS destructures', async () => {
    const r = await compile('local a, b = pairs(t)');
    expect(r.source).toContain('let [a, b] = multiret(pairs(t))');
  });

  it('assign with multiple LHS and single Call RHS destructures', async () => {
    const r = await compile('a, b = pairs(t)');
    expect(r.source).toContain('[a, b] = multiret(pairs(t))');
  });

  it('local with paired RHS does NOT destructure', async () => {
    const r = await compile('local a, b = 1, 2');
    expect(r.source).toContain('let a = 1, b = 2');
  });
});

describe('compile — expressions: type assertion / if-else / interp string', () => {
  it('type assertion `x :: T` becomes `(x as T)`', async () => {
    const r = await compile('local x = y :: string');
    expect(r.source).toContain('y as string');
  });

  it('if-else expression becomes a ternary', async () => {
    const r = await compile('local x = if a then 1 else 2');
    expect(r.source).toContain('isTruthy(a)');
    expect(r.source).toContain('? 1 : 2');
  });

  it('interpolated string emits a TS template literal', async () => {
    const r = await compile('local s = `hi {name}`');
    expect(r.source).toContain('`hi ${name}`');
  });
});

describe('compile — runtime semantics', () => {
  it('Lua nil maps to JS null', async () => {
    // Lower `nil` to `null` (not `undefined`) so it composes cleanly with
    // every nilable type annotation: `T?` already compiles to `T | null`.
    const r = await compile('local x = nil');
    expect(r.source).toContain('let x = null');
  });

  it('Lua truthiness wraps conditional expressions, not the value itself', async () => {
    // `local x = a and b` — luaAnd returns the value, NOT a boolean.
    // The conditional uses isTruthy() to wrap the test, but the chosen
    // branch is the original operand value (no implicit cast to bool).
    const r = await compile('local x = a and b');
    expect(r.source).toContain('let x = isTruthy(a)');
    expect(r.source).toContain('? b : a;');
    expect(r.source).not.toContain('luaAnd(a, b)');
    // `if a then` — isTruthy *is* called on the condition for control flow.
    const r2 = await compile('if a then x = 1 end');
    expect(r2.source).toContain('isTruthy(a)');
  });

  it('logical operators short-circuit awaited right-hand sides lazily', async () => {
    const r = await compile('local x = a and wait(1)');
    expect(r.source).toContain('let x = isTruthy(a)');
    expect(r.source).toContain('? await wait(1) : a;');
  });
});

describe('compile — header / sourcemap / comments', () => {
  it('always prepends a single-line "Compiled by" header', async () => {
    const r = await compile('local x = 1');
    expect(r.source).toMatch(/^\/\/ Compiled by luau2ts v[\d.]+ \(do not edit\)\./);
  });

  it('pretty-prints output via Prettier by default', async () => {
    // Compile through the un-wrapped function so Prettier runs.
    const r = await _compile('local function greet(name)\n  print("hi " .. name)\nend\ngreet("world")');
    // Prettier flips double-quoted string literals to single-quote (per .prettierrc).
    expect(r.source).toContain("greet('world')");
    // Prettier uses 2-space indents, the TS factory printer uses 4.
    expect(r.source).toMatch(/\n {2}print\(/);
    expect(r.source).not.toMatch(/\n {4}print\(/);
    // Pretty: false skips Prettier and we get the factory printer output back.
    const raw = await _compile('local function greet(name) print("hi " .. name) end\ngreet("world")', { pretty: false });
    expect(raw.source).toContain('greet("world")');
    expect(raw.source).toMatch(/\n {4}print\(/);
  });

  it('preserves the source file header comments when requested', async () => {
    const r = await compile('-- Top of file\n-- Authored by tony\nlocal x = 1', {
      preserveComments: true,
    });
    expect(r.source).toContain('// Top of file');
    expect(r.source).toContain('// Authored by tony');
  });

  it('emits a v3 source map when requested', async () => {
    const r = await compile('local x = 1\nlocal y = 2', { sourceMap: true });
    expect(r.sourceMap).toBeDefined();
    expect(r.sourceMap!.version).toBe(3);
    expect(r.sourceMap!.sources).toEqual(['input.luau']);
    expect(r.sourceMap!.mappings.length).toBeGreaterThan(0);
  });

  it('inlines the source map when inlineSourceMap is set', async () => {
    const r = await compile('local x = 1', { inlineSourceMap: true });
    expect(r.source).toContain('//# sourceMappingURL=data:application/json;base64,');
  });
});

describe('compile — type checking', () => {
  it('postEmitCheck flags a TypeScript type error in the emitted source', async () => {
    // Untyped helpers are stripped from the call so we exercise the
    // narrowing path: a typed `number` local can't take a string literal.
    const r = await _compile('local x: number = "hi"', { postEmitCheck: true });
    const tsErrors = r.errors.filter((e) => e.message.includes('[ts:'));
    expect(tsErrors.length).toBeGreaterThan(0);
    expect(tsErrors[0]!.message).toContain('not assignable');
    expect(tsErrors[0]!.loc.start.line).toBeGreaterThan(0);
  });

  it('postEmitCheck is silent on clean code', async () => {
    const r = await _compile('local x: number = 1\nlocal y: string = "ok"', {
      postEmitCheck: true,
    });
    const tsErrors = r.errors.filter((e) => e.message.includes('[ts:'));
    expect(tsErrors).toEqual([]);
  });

  it('postEmitCheck is default-on (TS errors surface without any flag)', async () => {
    // _compile is the un-wrapped compile from the module, so it sees
    // the real defaults (postEmitCheck = true unless overridden).
    const r = await _compile('local x: number = "hi"', { pretty: false });
    const tsErrors = r.errors.filter((e) => e.message.includes('[ts:'));
    expect(tsErrors.length).toBeGreaterThan(0);
  });

  it('postEmitCheck: false disables the check', async () => {
    const r = await _compile('local x: number = "hi"', { pretty: false, postEmitCheck: false });
    const tsErrors = r.errors.filter((e) => e.message.includes('[ts:'));
    expect(tsErrors).toEqual([]);
  });

  it('preEmitCheck surfaces Luau-side type errors via @luau2ts/analyzer', async () => {
    const r = await _compile('local x: number = "hi"', { pretty: false, preEmitCheck: true, postEmitCheck: false });
    const luauErrors = r.errors.filter((e) => e.message.includes('[luau:'));
    expect(luauErrors.length).toBeGreaterThan(0);
    expect(luauErrors[0]!.message).toMatch(/TypeMismatch|number|string/);
  });

  it('typeCheck runs both layers and tags diagnostics with their source', async () => {
    const r = await _compile('local x: number = "hi"', { pretty: false, typeCheck: true });
    const tsErrors = r.errors.filter((e) => e.message.includes('[ts:'));
    const luauErrors = r.errors.filter((e) => e.message.includes('[luau:'));
    expect(tsErrors.length).toBeGreaterThan(0);
    expect(luauErrors.length).toBeGreaterThan(0);
  });

  it('dynamic Instance child access routes to warnings, not errors', async () => {
    // Real Roblox scripts access runtime-resolved children — the
    // analyzer correctly flags `instance.SomeRuntimeChild` as
    // UnknownProperty because it can't statically know that child
    // exists. We demote those diagnostics to warnings so
    // `errors.length === 0` doesn't break for scripts that use
    // perfectly-normal Roblox idioms.
    const r = await _compile(
      `local function f(p: Instance) return p.SomeRuntimeChild end`,
      { pretty: false, preEmitCheck: true, postEmitCheck: false },
    );
    const blocking = r.errors.filter((e) =>
      e.message.includes('UnknownProperty') && e.message.includes('Instance'),
    );
    expect(blocking).toEqual([]);
    // The diagnostics still surface — just on the warnings side.
    const warned = r.warnings.filter((w) =>
      w.message.includes('UnknownProperty') && w.message.includes('Instance'),
    );
    expect(warned.length).toBeGreaterThan(0);
  });

  it('lint-style warnings (LocalUnused, etc.) route to warnings', async () => {
    // Layer-B severity:'warning' diagnostics go to result.warnings.
    // Without this split, lint warnings inflate errors.length and look
    // identical to real type bugs.
    const r = await _compile(
      'local UnusedVariable = 42\n',
      { pretty: false, preEmitCheck: true, postEmitCheck: false },
    );
    const lintBlocking = r.errors.filter((e) =>
      e.message.includes('Unused') || e.message.includes('LocalUnused'),
    );
    expect(lintBlocking).toEqual([]);
  });
});
