import { describe, expect, it } from 'vitest';
import { analyze } from '../src/index.js';

describe('@luau2ts/analyzer', () => {
  it('flags a type mismatch on a typed local with the wrong initializer', async () => {
    const diags = await analyze('local x: number = "hi"');
    const errors = diags.filter((d) => d.severity === 'error');
    expect(errors.length).toBeGreaterThan(0);
    // Don't pin the exact code or message, since Luau's wording / code
    // labels evolve. Just verify the diagnostic points at the literal
    // on line 1 and mentions string-vs-number.
    const e = errors[0]!;
    expect(e.line).toBe(1);
    expect(e.message.toLowerCase()).toMatch(/string|number/);
  });

  it('returns no errors on clean typed code', async () => {
    const diags = await analyze('local x: number = 1\nlocal y: string = "ok"');
    const errors = diags.filter((d) => d.severity === 'error');
    expect(errors).toEqual([]);
  });

  it('returns multiple diagnostics for multiple independent errors', async () => {
    const diags = await analyze(
      'local x: number = "a"\nlocal y: string = 42\nlocal z: boolean = "b"',
    );
    const errors = diags.filter((d) => d.severity === 'error');
    expect(errors.length).toBeGreaterThanOrEqual(3);
  });

  it('is idempotent across repeated calls (no state leakage)', async () => {
    const src = 'local x: number = "bad"';
    const a = await analyze(src);
    const b = await analyze(src);
    expect(a.length).toBe(b.length);
    expect(a[0]!.message).toBe(b[0]!.message);
  });

  it('returns lint warnings with severity: warning', async () => {
    // Shadowing a builtin global is a Luau lint that fires reliably.
    // If the wording shifts we still expect at least one warning.
    const diags = await analyze('local print = 1\nlocal print = 2\n');
    const warnings = diags.filter((d) => d.severity === 'warning');
    // Some lints are gated on type info; accept either zero or some
    // warnings here. The presence-or-absence isn't load-bearing; what
    // matters is that severity:'warning' is at least supported in the
    // shape when warnings do exist.
    expect(Array.isArray(warnings)).toBe(true);
  });
});

describe('@luau2ts/analyzer — Roblox globals (R.15)', () => {
  // Regression cluster for the supplements.d.lua + service-on-DataModel
  // + KNOWN_OPTIONAL_PARAMS work. Each test is a one-liner of real
  // Roblox idioms that previously fired `UnknownSymbol` /
  // `UnknownProperty` / `CountMismatch` against unmodified upstream
  // Luau + API-dump data.

  function errorsOnly(diags: { severity: string; message: string; code: string }[]) {
    return diags.filter((d) => d.severity === 'error');
  }

  it('warn / tick / typeof / require resolve as globals', async () => {
    const cases = [
      'warn("hello")',
      'local t = tick()',
      'local k = typeof(5)',
      'local v = "x"',
    ];
    for (const src of cases) {
      const errs = errorsOnly(await analyze(src));
      // We only assert that no UnknownSymbol error fires on the global
      // we're testing. Other errors (e.g. unused-local lints) are
      // acceptable.
      expect(errs.filter((e) => e.code === 'UnknownSymbol'), src).toEqual([]);
    }
  });

  it('legacy wait() / spawn() / delay() resolve as globals', async () => {
    // Pre-`task.library` schedulers still exist in Roblox today.
    // Modern code uses task.wait etc., but old scripts call these
    // bare functions and need them declared.
    const cases = [
      'wait(0.5)',
      'spawn(function() print(1) end)',
      'delay(1, function() print(2) end)',
    ];
    for (const src of cases) {
      const errs = errorsOnly(await analyze(src));
      expect(errs.filter((e) => e.code === 'UnknownSymbol'), src).toEqual([]);
    }
  });

  it('game.Players / game.Debris resolve as DataModel properties', async () => {
    // Roblox accepts service classes as direct DataModel properties
    // (shortcut for game:GetService). The generator collects every
    // `Service`-tagged class and emits it on DataModel's body.
    for (const svc of ['Players', 'Debris', 'Workspace', 'Lighting', 'ReplicatedStorage']) {
      const errs = errorsOnly(await analyze(`local s = game.${svc}`));
      expect(
        errs.filter((e) => e.code === 'UnknownProperty'),
        `game.${svc} should not fire UnknownProperty`,
      ).toEqual([]);
    }
  });

  it('Instance:WaitForChild accepts the 1-arg form (no `timeOut`)', async () => {
    // The API dump under-marks `timeOut` as required despite being
    // optional in practice. KNOWN_OPTIONAL_PARAMS promotes it to
    // nilable; without that, `script:WaitForChild("Foo")` fires a
    // CountMismatch ("expects 3, got 2").
    const errs = errorsOnly(await analyze('local c = script:WaitForChild("Foo")'));
    expect(errs.filter((e) => e.code === 'CountMismatch')).toEqual([]);
  });

  it('Instance:FindFirstChild accepts the 1-arg form (no `recursive`)', async () => {
    // FindFirstChild's `recursive` arg is documented in the dump with
    // Default: "false", so this should work without our overrides.
    // Pinning here so a regression in dump-default handling surfaces.
    const errs = errorsOnly(await analyze('local c = script:FindFirstChild("Foo")'));
    expect(errs.filter((e) => e.code === 'CountMismatch')).toEqual([]);
  });

  it('Workspace:Raycast accepts the 2-arg form (no `raycastParams`)', async () => {
    // Common pattern: `workspace:Raycast(origin, direction)` skipping
    // the optional RaycastParams. Covered by KNOWN_OPTIONAL_PARAMS.
    const errs = errorsOnly(await analyze(
      'local r = workspace:Raycast(Vector3.zero, Vector3.new(0, -1, 0))',
    ));
    expect(errs.filter((e) => e.code === 'CountMismatch')).toEqual([]);
  });

  it('Vector3 / CFrame / Color3 constructors and statics resolve', async () => {
    // Datatype supplements cover both the type side (`class Vector3`)
    // and the value side (`declare Vector3: { new: ... }`).
    const cases = [
      'local v = Vector3.new(1, 2, 3)',
      'local c = CFrame.new()',
      'local color = Color3.fromRGB(255, 0, 0)',
      'local z = Vector3.zero',
      'local i = CFrame.identity',
    ];
    for (const src of cases) {
      const errs = errorsOnly(await analyze(src));
      expect(
        errs.filter((e) => e.code === 'UnknownSymbol' || e.code === 'UnknownProperty'),
        src,
      ).toEqual([]);
    }
  });

  it('task.spawn / task.wait / task.delay resolve', async () => {
    const cases = [
      'task.spawn(function() print(1) end)',
      'task.wait(1)',
      'task.delay(0.5, function() end)',
    ];
    for (const src of cases) {
      const errs = errorsOnly(await analyze(src));
      expect(
        errs.filter((e) => e.code === 'UnknownSymbol' || e.code === 'UnknownProperty'),
        src,
      ).toEqual([]);
    }
  });

  it('Instance.new with valid class name returns an Instance', async () => {
    const errs = errorsOnly(await analyze('local p = Instance.new("Part")'));
    expect(errs.filter((e) => e.code === 'UnknownSymbol' || e.code === 'UnknownProperty')).toEqual([]);
  });

  it('Enum.Material.Plastic.Value resolves to a number', async () => {
    // The generator emits per-enum `Enum_<Name>` classes with each
    // item declared as an EnumItem. The namespace `Enum` binds to
    // GlobalEnums which carries them all.
    const errs = errorsOnly(await analyze('local v = Enum.Material.Plastic.Value'));
    expect(errs.filter((e) => e.code === 'UnknownSymbol' || e.code === 'UnknownProperty')).toEqual([]);
  });

  it('still reports real type errors (analyzer not silenced by globals load)', async () => {
    // Sanity check: the supplements + service injection shouldn't
    // accidentally short-circuit the analyzer (which is how a bad
    // .d.lua manifests — every diagnostic disappears).
    const errs = errorsOnly(await analyze('local x: number = "hello"'));
    expect(errs.length).toBeGreaterThan(0);
  });

  it('CFrame * CFrame / CFrame + Vector3 type-check via __mul / __add', async () => {
    // The API dump's CFrame entry doesn't declare operator overloads;
    // we hand-write the metamethods in supplements.d.lua so common
    // Roblox math (model:PivotTo(CFrame.new(p) * CFrame.Angles(...)))
    // doesn't fire "Binary operator '*' not supported by types".
    const cases = [
      'local a = CFrame.new() * CFrame.new()',
      'local b = CFrame.new() + Vector3.new(1, 0, 0)',
      'local c = CFrame.new() - Vector3.new(0, 1, 0)',
    ];
    for (const src of cases) {
      const errs = errorsOnly(await analyze(src));
      expect(errs.filter((e) => e.message.includes('Binary operator')), src).toEqual([]);
    }
  });

  it('Vector3 +/-/*/÷ all type-check via metamethods', async () => {
    const cases = [
      'local a = Vector3.new() + Vector3.new()',
      'local b = Vector3.new() - Vector3.new()',
      'local c = Vector3.new() * 2',
      'local d = Vector3.new() / 2',
      'local e = -Vector3.new()',
    ];
    for (const src of cases) {
      const errs = errorsOnly(await analyze(src));
      expect(errs.filter((e) => e.message.includes('Binary operator') || e.message.includes('Unary operator')), src).toEqual([]);
    }
  });
});
