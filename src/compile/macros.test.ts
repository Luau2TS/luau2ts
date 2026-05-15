// Per-macro emit assertions. Compiles a one-line snippet in both `native`
// (default) and `rbxts` modes and checks the output shape.

import { describe, expect, it } from 'vitest';
import { compile } from './index.js';

async function emit(src: string, compatMode: 'native' | 'rbxts' = 'native'): Promise<string> {
  // Test the AST-level emission only. pretty:false skips Prettier so
  // quoting and indentation assertions stay stable. postEmitCheck:false
  // skips Layer A (the TypeScript type check) which would blow Vitest's
  // 5s timeout on loops of small compiles. Both paths have their own
  // dedicated tests.
  const r = await compile(src, { compatMode, pretty: false, postEmitCheck: false });
  return r.source;
}

describe('macros — datatype constructors (R.2)', () => {
  it("native mode keeps `Vector3.new(x,y,z)` as a static call", async () => {
    const out = await emit('local v = Vector3.new(1, 2, 3)');
    expect(out).toContain('Vector3.new(1, 2, 3)');
    expect(out).not.toContain('new Vector3(');
  });

  it("rbxts mode rewrites `Vector3.new(x,y,z)` as `new Vector3(x,y,z)`", async () => {
    // Vector3 is a globally-declared class in @rbxts/types (no exports —
    // the module isn't importable). We DON'T emit `import { Vector3 }
    // from "@rbxts/types"` in rbxts mode; the bare `new Vector3(...)`
    // resolves via the ambient declaration.
    const out = await emit('local v = Vector3.new(1, 2, 3)', 'rbxts');
    expect(out).toContain('new Vector3(1, 2, 3)');
    expect(out).not.toContain('@rbxts/types');
  });

  it('rbxts mode rewrites every datatype constructor', async () => {
    const types = [
      'Vector3', 'Vector2', 'CFrame', 'Color3', 'UDim', 'UDim2',
      'NumberRange', 'NumberSequence', 'TweenInfo', 'Ray', 'Rect',
      'Region3', 'BrickColor', 'Random', 'DateTime',
    ];
    for (const t of types) {
      const out = await emit(`local x = ${t}.new()`, 'rbxts');
      expect(out, `${t}.new should be rewritten`).toContain(`new ${t}(`);
    }
  });

  it('rbxts mode keeps static factories as static calls', async () => {
    const cases: [string, string][] = [
      ['CFrame.Angles(1, 2, 3)', 'CFrame.Angles(1, 2, 3)'],
      ['CFrame.fromEulerAnglesXYZ(0, 0, 0)', 'CFrame.fromEulerAnglesXYZ(0, 0, 0)'],
      ['CFrame.lookAt(a, b)', 'CFrame.lookAt(a, b)'],
      ['Color3.fromRGB(255, 0, 0)', 'Color3.fromRGB(255, 0, 0)'],
      ['Color3.fromHSV(0.5, 0.5, 0.5)', 'Color3.fromHSV(0.5, 0.5, 0.5)'],
      ['Color3.fromHex("#ff0000")', 'Color3.fromHex("#ff0000")'],
      ['UDim2.fromScale(0.5, 0.5)', 'UDim2.fromScale(0.5, 0.5)'],
      ['UDim2.fromOffset(10, 10)', 'UDim2.fromOffset(10, 10)'],
      ['DateTime.now()', 'DateTime.now()'],
    ];
    for (const [src, expected] of cases) {
      const out = await emit(`local x = ${src}`, 'rbxts');
      expect(out, src).toContain(expected);
      expect(out, src).not.toContain('new CFrame.');
    }
  });

  it('Instance.new("Part") keeps the `new Instance("Part")` form in rbxts mode', async () => {
    // @rbxts/types declares Roblox subclass names (Part, ClickDetector,
    // Tool, …) as INTERFACES, not classes — `new Part(...)` fires
    // TS2693 ("only refers to a type"). roblox-ts has special handling
    // for `new Instance("ClassName")` that resolves the constructor and
    // types the result as the subclass. So we keep the source's shape.
    const out = await emit('local p = Instance.new("Part")', 'rbxts');
    expect(out).toContain('new Instance("Part")');
    expect(out).not.toContain('@rbxts/types');
  });

  it('Instance.new with parent forwards the second arg', async () => {
    const out = await emit('local p = Instance.new("Part", workspace)', 'rbxts');
    expect(out).toMatch(/new Instance\("Part", workspace[^)]*\)/);
  });

  it('Instance.new with non-literal class name forwards the call', async () => {
    const out = await emit('local p = Instance.new(name)', 'rbxts');
    expect(out).toContain('new Instance(name)');
  });

  it('game:GetService("Workspace") → Workspace + services import', async () => {
    const out = await emit('local ws = game:GetService("Workspace")', 'rbxts');
    expect(out).toContain('let ws = Workspace');
    expect(out).toMatch(/import \{[^}]*Workspace[^}]*\} from "@rbxts\/services"/);
  });

  it('multiple game:GetService calls dedupe into one services import', async () => {
    const out = await emit(
      `local ws = game:GetService("Workspace")
       local ps = game:GetService("Players")
       local rs = game:GetService("RunService")`,
      'rbxts',
    );
    const matches = out.match(/from "@rbxts\/services"/g) ?? [];
    expect(matches.length).toBe(1);
    // Names are emitted alphabetically for deterministic output.
    expect(out).toMatch(/import \{[^}]*Players[^}]*RunService[^}]*Workspace[^}]*\} from "@rbxts\/services"/);
  });

});

describe('macros — RuntimeLib.lua recognizer (R.8)', () => {
  it('TS.async wraps as async closure', async () => {
    const out = await emit('local f = TS.async(handler)');
    expect(out).toMatch(/async \(\.\.\.args\)\s*=>\s*handler\(\.\.\.args\)/);
  });

  it('TS.await emits await', async () => {
    const out = await emit('local v = TS.await(p)');
    expect(out).toContain('await p');
  });

  it('TS.try emits Promise chain', async () => {
    const out = await emit('local v = TS.try(tryFn, catchFn, finallyFn)');
    expect(out).toContain('Promise.resolve()');
    expect(out).toContain('.then(tryFn)');
    expect(out).toContain('.catch(catchFn)');
    expect(out).toContain('.finally(finallyFn)');
  });

  it('TS.instanceof emits instanceof operator', async () => {
    const out = await emit('local v = TS.instanceof(x, T)');
    expect(out).toContain('x instanceof T');
  });

  it('TS.import emits dynamic import', async () => {
    const out = await emit('local m = TS.import(loader, "./mod")');
    expect(out).toMatch(/await import\("\.\/mod"\)/);
  });

  it('TS.Object_assign emits Object.assign', async () => {
    const out = await emit('local merged = TS.Object_assign(a, b, c)');
    expect(out).toContain('Object.assign(a, b, c)');
  });

  it('TS.bit_band / bor / bxor emit bitwise ops with >>> 0 coercion', async () => {
    const band = await emit('local v = TS.bit_band(a, b)');
    expect(band).toMatch(/\(a & b\) >>> 0/);
    const bor = await emit('local v = TS.bit_bor(a, b)');
    expect(bor).toMatch(/\(a \| b\) >>> 0/);
    const bxor = await emit('local v = TS.bit_bxor(a, b)');
    expect(bxor).toMatch(/\(a \^ b\) >>> 0/);
  });

  it('TS.bit_bnot emits unary tilde', async () => {
    const out = await emit('local v = TS.bit_bnot(x)');
    // TS printer may drop the inner parens around `~x` since it's already
    // an atomic prefix expression; accept both `(~x) >>> 0` and `(~x >>> 0)`.
    expect(out).toMatch(/~x\s*\)?\s*>>> 0/);
  });

  it('TS.string_split → method call', async () => {
    const out = await emit('local parts = TS.string_split(s, ",")');
    expect(out).toContain('s.split(",")');
  });

  it('TS.array_push → method call', async () => {
    const out = await emit('local n = TS.array_push(arr, v)');
    expect(out).toContain('arr.push(v)');
  });

  it('TS.round → Math.round', async () => {
    const out = await emit('local r = TS.round(x)');
    expect(out).toContain('Math.round(x)');
  });

  it('all TS.* macros fire in native mode (always-fire)', async () => {
    // Confirm at least a representative async macro fires regardless of mode.
    const native = await emit('local v = TS.await(p)', 'native');
    expect(native).toContain('await p');
  });
});

describe('macros — stdlib calls (R.10, rbxts mode only)', () => {
  it('table.insert(t, v) → t.push(v)', async () => {
    const out = await emit('table.insert(arr, x)', 'rbxts');
    expect(out).toContain('arr.push(x)');
  });

  it('table.insert(t, i, v) → t.insert(i - 1, v)', async () => {
    // roblox-ts's Array<T> exposes `insert(index, value)` (0-indexed,
    // matching JS conventions). We emit that instead of going through
    // `table` (which doesn't even expose `.insert` in @rbxts/types) or
    // through `.splice` (also missing on Array<T>).
    const out = await emit('table.insert(arr, 2, x)', 'rbxts');
    expect(out).toContain('arr.insert(2 - 1, x)');
    expect(out).not.toContain('table.insert');
    expect(out).not.toContain('.splice(');
  });

  it('table.remove(t) → t.pop()', async () => {
    const out = await emit('local v = table.remove(arr)', 'rbxts');
    expect(out).toContain('arr.pop()');
  });

  it('table.remove(t, i) → t.splice(i-1, 1)[0]', async () => {
    const out = await emit('local v = table.remove(arr, 1)', 'rbxts');
    expect(out).toMatch(/arr\.splice\(1 - 1, 1\)\[0\]/);
  });

  it('table.concat(t, sep) → t.join(sep)', async () => {
    const out = await emit('local s = table.concat(arr, ",")', 'rbxts');
    expect(out).toContain('arr.join(",")');
  });

  it('table.create(n, v) → new Array(n).fill(v)', async () => {
    const out = await emit('local a = table.create(5, 0)', 'rbxts');
    expect(out).toContain('new Array(5).fill(0)');
  });

  it('table.clone(t) → [...t]', async () => {
    const out = await emit('local b = table.clone(arr)', 'rbxts');
    expect(out).toMatch(/\[\.\.\.arr\]/);
  });

  it('string.upper(s) → s.toUpperCase()', async () => {
    const out = await emit('local u = string.upper(name)', 'rbxts');
    expect(out).toContain('name.toUpperCase()');
  });

  it('string.split(s, sep) → s.split(sep)', async () => {
    const out = await emit('local parts = string.split(s, ",")', 'rbxts');
    expect(out).toContain('s.split(",")');
  });

  it('math.floor(x) keeps lowercase `math.floor` (roblox-ts has it as a Lua global)', async () => {
    // Previously rewrote to JS-side `Math.floor`, but @rbxts/types
    // declares `math` (lowercase) as a typed Lua-global namespace.
    // `Math.floor` would surface TS2304 "Cannot find name 'Math'" in
    // roblox-ts strict mode. Keeping `math.floor` round-trips back to
    // Lua as the identity transform.
    const out = await emit('local f = math.floor(x)', 'rbxts');
    expect(out).toContain('math.floor(x)');
    expect(out).not.toContain('Math.floor(');
  });

  it('math.clamp(x, lo, hi) keeps the real math.clamp call', async () => {
    // roblox-ts has a real `math.clamp` (Roblox Luau extension over
    // standard Lua); use it directly instead of decomposing into
    // min/max.
    const out = await emit('local c = math.clamp(x, 0, 1)', 'rbxts');
    expect(out).toContain('math.clamp(x, 0, 1)');
  });

  it('native mode keeps stdlib calls as namespace calls', async () => {
    const out = await emit('table.insert(arr, x)');
    expect(out).toContain('table.insert(arr, x)');
    expect(out).not.toContain('arr.push');
  });
});

describe('array indexing model (R.12)', () => {
  // Both native and rbxts modes emit 0-indexed TS; the -1 offset is applied
  // during compileExpr's IndexExpr case. This is the correct shape for
  // roblox-ts roundtrip — its `addOneIfArrayType` then re-adds +1 when
  // emitting Luau, so `arr[1]` (Luau) → `arr[0]` (TS) → `arr[1]` (Luau′).

  it('1-indexed Lua literal maps to 0-indexed TS in native mode', async () => {
    const out = await emit('local x = arr[1]', 'native');
    expect(out).toContain('arr[0]');
  });

  it('1-indexed Lua literal maps to 0-indexed TS in rbxts mode (roundtrip-safe)', async () => {
    const out = await emit('local x = arr[1]', 'rbxts');
    expect(out).toContain('arr[0]');
  });

  it('record access (string key) is left as-is in both modes', async () => {
    for (const mode of ['native', 'rbxts'] as const) {
      const out = await emit('local x = t["key"]', mode);
      expect(out).toContain('t["key"]');
    }
  });

  it('variable index dispatches through the luaIndex runtime helper', async () => {
    const out = await emit('local x = arr[i]', 'native');
    expect(out).toContain('luaIndex(arr, i)');
    expect(out).toContain('luau2ts/runtime');
  });
});

describe('macros — Roact recognition (R.11, rbxts mode only)', () => {
  it('Roact.createElement triggers @rbxts/roact import', async () => {
    const out = await emit('local el = Roact.createElement("Frame", {})', 'rbxts');
    expect(out).toContain('Roact.createElement("Frame"');
    expect(out).toMatch(/import \{[^}]*Roact[^}]*\} from "@rbxts\/roact"/);
  });

  it('Roact.mount triggers the same import', async () => {
    const out = await emit('Roact.mount(el, parent)', 'rbxts');
    expect(out).toMatch(/import \{[^}]*Roact[^}]*\} from "@rbxts\/roact"/);
  });

  it('native mode keeps Roact calls but skips the @rbxts/roact import', async () => {
    const out = await emit('local el = Roact.createElement("Frame", {})');
    expect(out).toContain('Roact.createElement("Frame"');
    expect(out).not.toContain('@rbxts/roact');
  });
});

describe('class-shape recognition (R.9, rbxts mode only)', () => {
  it('detects roblox-ts metatable class pattern → TS class', async () => {
    const src = `
      local Class = setmetatable({}, {})
      Class.__index = Class
      function Class.new(x, y)
          local self = setmetatable({}, Class)
          self:constructor(x, y)
          return self
      end
      function Class:constructor(x, y)
          self.x = x
          self.y = y
      end
      function Class:getX()
          return self.x
      end
    `;
    const out = await emit(src, 'rbxts');
    expect(out).toMatch(/class Class \{/);
    // Constructor params get explicit `: any` annotations when the
    // source had none. roblox-ts strict mode rejects implicit-any
    // (TS7006); `unknown` would satisfy that but then trip TS18046 on
    // body accesses (`this.x = x` with x: unknown). `any` is the
    // pragmatic default — roblox-ts's "any banned" rule only fires
    // in narrow contexts, not at param positions.
    expect(out).toMatch(/constructor\(x: any, y: any\)/);
    expect(out).toContain('getX()');
    // The metatable plumbing should be gone.
    expect(out).not.toContain('setmetatable');
  });

  it('detects inheritance via __index = Superclass', async () => {
    const src = `
      local Sub = setmetatable({}, { __index = Super })
      Sub.__index = Sub
      function Sub.new()
          local self = setmetatable({}, Sub)
          self:constructor()
          return self
      end
      function Sub:constructor()
          Super.constructor(self)
      end
    `;
    const out = await emit(src, 'rbxts');
    expect(out).toMatch(/class Sub extends Super/);
    expect(out).toContain('super()');
  });

  it('native mode keeps the metatable emit untouched', async () => {
    const src = `
      local Class = setmetatable({}, {})
      Class.__index = Class
      function Class.new()
          return setmetatable({}, Class)
      end
    `;
    const out = await emit(src, 'native');
    expect(out).toContain('setmetatable');
    expect(out).not.toContain('class Class');
  });
});

describe('macros — re-export grouping', () => {
  it('rbxts mode does NOT emit an `@rbxts/types` import (globals only)', async () => {
    // @rbxts/types declares Roblox classes as TypeScript-side ambient
    // globals — the package has no named exports. Importing from it
    // surfaces TS2306 "File '...roblox.d.ts' is not a module" under
    // roblox-ts strict mode. The bare class identifiers
    // (`new Vector3()`, etc.) resolve via the ambient declarations.
    const out = await emit(
      `local v = Vector3.new(1,2,3)
       local c = Color3.fromRGB(255,0,0)
       local p = CFrame.new(0,0,0)`,
      'rbxts',
    );
    expect(out).not.toContain('@rbxts/types');
    expect(out).toContain('new Vector3(1, 2, 3)');
    expect(out).toContain('Color3.fromRGB(255, 0, 0)');
    expect(out).toContain('new CFrame(0, 0, 0)');
  });
});

describe('rbxts mode roundtrip-readiness (R.14)', () => {
  // These tests guard the rbxts-mode emit against regressing on the
  // strict-mode rules roblox-ts enforces: no `null`, no `any`, no `self`
  // identifier, no `static new` collisions, no `luau2ts/runtime` imports.
  // Each behavior is also covered by macros.test.ts at a finer grain; the
  // cluster here exists so a single broken assumption surfaces clearly
  // instead of getting buried in the macro-level tests.

  it('rbxts mode lowers `nil` literals to `undefined` (not `null`)', async () => {
    // roblox-ts rejects `null` outright ("null is not supported — use
    // undefined"). The native-mode null mapping (matched against
    // `T | null` annotations) is wrong for the rbxts target.
    const out = await emit('local x = nil', 'rbxts');
    expect(out).toContain('let x = undefined');
    expect(out).not.toContain('let x = null');
  });

  it('rbxts mode lowers `T?` annotations to `T | undefined`', async () => {
    const out = await emit('local function f(name: string?) end', 'rbxts');
    expect(out).toMatch(/name: string \| undefined/);
    expect(out).not.toMatch(/name: string \| null/);
  });

  it('rbxts mode defaults optional params to `= undefined`', async () => {
    const out = await emit('local function f(a: string, b: string?) end', 'rbxts');
    expect(out).toMatch(/b: string \| undefined = undefined/);
    expect(out).not.toMatch(/= null/);
  });

  it('rbxts mode defaults unannotated method params to `: any`', async () => {
    const out = await emit(
      `local C = setmetatable({}, {__index = nil})
       function C.new(x, y) local self = setmetatable({}, C); self.x = x; self.y = y; return self end
       function C:get() return self.x end`,
      'rbxts',
    );
    // Class constructor + method params default to `any` so roblox-ts's
    // strict mode doesn't trip on implicit-any (TS7006). `unknown` would
    // satisfy TS7006 but then trigger TS18046 on every property access
    // in the body. roblox-ts's own "any banned" check only fires in
    // narrow contexts (not method param positions).
    expect(out).toMatch(/constructor\(x: any, y: any\)/);
  });

  it('rbxts mode does NOT synthesize a `static new(...)` forwarder', async () => {
    // roblox-ts reserves `new` as a class member name (it auto-generates
    // the Lua-side `Class.new()` factory from `new Class()` TS calls), so
    // an explicit `static new(...)` collides with "Cannot use class field
    // reserved for compiler internal usage."
    const out = await emit(
      `local C = setmetatable({}, {__index = nil})
       function C.new() local self = setmetatable({}, C); return self end
       function C:m() end`,
      'rbxts',
    );
    expect(out).toContain('class C');
    expect(out).not.toMatch(/static new\(/);
  });

  it('rbxts mode rewrites value-position `<Class>.new` to an arrow forwarder', async () => {
    // `return { new = MyClass.new }` is a non-call reference that the
    // <Class>.new macro doesn't touch (it fires on call sites only).
    // Synthesize a forwarder arrow so the property's value-shape
    // (a callable that constructs) is preserved.
    const out = await emit(
      `local C = setmetatable({}, {__index = nil})
       function C.new() local self = setmetatable({}, C); return self end
       function C:m() end
       return { new = C.new }`,
      'rbxts',
    );
    expect(out).toMatch(/new: \(\.\.\.args: unknown\[\]\) =>/);
    expect(out).toMatch(/new \(C as new \(/);
  });

  it('rbxts mode emits `for (const v of arr)` for single-binding iteration', async () => {
    // roblox-ts compiles `for-of` on arrays to Lua ipairs-style. Single-
    // binding source maps to value-only TS iteration (no destructure).
    // The iterable is cast to `any[]` so the destructured element type
    // is `any` rather than `unknown` — `unknown` would trip TS18046 on
    // every property access in the loop body.
    const out = await emit(
      `local function f(xs: { number }) for _, x in xs do print(x) end end`,
      'rbxts',
    );
    expect(out).toMatch(/for \(const \[_, x\] of ipairs\(xs as any\[\]\)\)/);
  });

  it('rbxts mode skips the `declare const X: any;` preamble', async () => {
    // The preamble keeps our internal --check-ts happy in native mode,
    // but in rbxts mode it shadows @rbxts/types' typed globals with
    // `any`, which (a) is itself a roblox-ts error and (b) breaks
    // roblox-ts's for-of iteration analysis (it needs the real typed
    // pairs/ipairs return).
    const out = await emit('error("nope")', 'rbxts');
    expect(out).not.toMatch(/declare const error:/);
    // The bare reference still survives — roblox-ts resolves it via
    // @rbxts/types at compile time.
    expect(out).toContain('error("nope"');
  });

  it('rbxts mode emits no `luau2ts/runtime` imports', async () => {
    // Mixed bag of operations that all routed through helpers in
    // native mode (isTruthy, luaAdd, luaIndex, genericIter, multiret,
    // luaNot, luaEq, error, pcall, setmetatable, …). In rbxts mode
    // every one of them collapses to a native TS operator / global, so
    // the import line should be entirely absent.
    const out = await emit(
      `local t = {}
       local k = "foo"
       t[k] = 42
       if t[k] then
         t[k] = t[k] + 1
       end
       for k, v in t do print(k, v) end
       return t`,
      'rbxts',
    );
    expect(out).not.toContain("from 'luau2ts/runtime'");
    expect(out).not.toContain('from "luau2ts/runtime"');
  });

  it('rbxts mode collapses `x = x or default` to `x ?? default`', async () => {
    // The IIFE-with-isTruthy form we use in native mode is unnecessary
    // in rbxts — TS's `??` short-circuits naturally, and roblox-ts
    // re-derives Lua-truthy semantics when compiling back.
    const out = await emit('local function f(x: string?) return x or "default" end', 'rbxts');
    expect(out).toMatch(/return x \?\? "default"/);
    expect(out).not.toContain('isTruthy');
  });

  it('rbxts mode emits a class field per setmetatable init key', async () => {
    // Fields harvested from the `.new` factory's setmetatable init get
    // declared at the class top (so `this.x` resolves) AND assigned in
    // the constructor body (so the init expression can reference the
    // ctor's params).
    const out = await emit(
      `local C = setmetatable({}, {__index = nil})
       function C.new(name: string) local self = setmetatable({ name = name, count = 0 }, C); return self end
       function C:m() return self.name end`,
      'rbxts',
    );
    expect(out).toMatch(/name: any;/);
    expect(out).toMatch(/count: any;/);
    expect(out).toMatch(/this\.name = name/);
    expect(out).toMatch(/this\.count = 0/);
  });
});
