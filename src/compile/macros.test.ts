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
    const out = await emit('local v = Vector3.new(1, 2, 3)', 'rbxts');
    expect(out).toContain('new Vector3(1, 2, 3)');
    expect(out).toContain('@rbxts/types');
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

  it('Instance.new("Part") → new Part() + types import (rbxts mode)', async () => {
    const out = await emit('local p = Instance.new("Part")', 'rbxts');
    expect(out).toContain('new Part()');
    expect(out).toMatch(/import \{[^}]*Part[^}]*\} from "@rbxts\/types"/);
  });

  it('Instance.new with parent forwards the second arg', async () => {
    const out = await emit('local p = Instance.new("Part", workspace)', 'rbxts');
    expect(out).toContain('new Part(workspace)');
  });

  it('Instance.new with non-literal class name falls through to default emit', async () => {
    const out = await emit('local p = Instance.new(name)', 'rbxts');
    expect(out).toContain('Instance.new(name)');
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

  it('table.insert(t, i, v) → t.splice(i-1, 0, v)', async () => {
    const out = await emit('table.insert(arr, 2, x)', 'rbxts');
    expect(out).toContain('arr.splice(2 - 1, 0, x)');
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

  it('math.floor(x) → Math.floor(x)', async () => {
    const out = await emit('local f = math.floor(x)', 'rbxts');
    expect(out).toContain('Math.floor(x)');
  });

  it('math.clamp(x, lo, hi) → Math.min(Math.max(x, lo), hi)', async () => {
    const out = await emit('local c = math.clamp(x, 0, 1)', 'rbxts');
    expect(out).toContain('Math.min(Math.max(x, 0), 1)');
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
    expect(out).toMatch(/constructor\(x, y\)/);
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
  it('rbxts mode emits a single grouped @rbxts/types import per file', async () => {
    const out = await emit(
      `local v = Vector3.new(1,2,3)
       local c = Color3.fromRGB(255,0,0)
       local p = CFrame.new(0,0,0)`,
      'rbxts',
    );
    const matches = out.match(/from "@rbxts\/types"/g) ?? [];
    expect(matches.length, out).toBe(1);
    // All three named imports should be on that single line.
    expect(out).toMatch(/import \{[^}]*Vector3[^}]*\} from "@rbxts\/types"/);
    expect(out).toMatch(/import \{[^}]*Color3[^}]*\} from "@rbxts\/types"/);
    expect(out).toMatch(/import \{[^}]*CFrame[^}]*\} from "@rbxts\/types"/);
  });
});
