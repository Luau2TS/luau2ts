export const RUNTIME_MODULE = 'luau2ts/runtime';

/** What we know about a value at compile time.
 *
 *  Primitives use plain string tags. Roblox datatypes (Vector3, CFrame,
 *  Color3, …) use the `'datatype:<Name>'` form so the compiler can fast-
 *  path arithmetic operators to the underlying instance methods. Anything
 *  we can't narrow falls back to `'unknown'`. */
export type StaticValueType =
  | 'number'
  | 'boolean'
  | 'string'
  | 'nil'
  | 'unknown'
  | `datatype:${string}`;

/** Roblox datatypes that expose `__add`/`__sub`/`__mul`/`__div`/`__unm`
 *  metamethods we can fast-path. The compiler narrows constructor calls
 *  and annotated locals to `'datatype:<Name>'`; arithmetic between two
 *  values of the same datatype emits `a.add(b)` instead of `luaAdd(a, b)`. */
export const ARITH_DATATYPES = new Set([
  'Vector3', 'Vector2', 'Vector3int16', 'Vector2int16', 'CFrame',
]);

/** Compatibility mode for emitted TypeScript.
 *
 *  - `native`: emit TS that imports stdlib helpers from `luau2ts/runtime`.
 *    `Vector3.new(...)`, `game:GetService(...)`, 1-indexed array semantics.
 *  - `rbxts`:  emit TS that mirrors what roblox-ts would accept as input.
 *    `new Vector3(...)`, `import { Workspace } from "@rbxts/services"`,
 *    `new ClassName()` for `Instance.new("ClassName")`, optional 0-indexed
 *    arrays for statically-array-typed expressions.
 */
export type CompatMode = 'native' | 'rbxts';

export class CompileContext {
  private readonly imports = new Set<string>();
  private readonly scopes: Map<string, StaticValueType>[] = [new Map()];
  /** Per-scope Luau-name → JS-name override map. Used when a `local X = expr`
   *  whose `expr` captures the outer `X` forces us to rename the new local
   *  to a fresh name (so the inner reference still binds to the outer). */
  private readonly jsNameOverrides: Map<string, string>[] = [new Map()];
  /** Names of user-defined functions in this file whose bodies transitively
   *  contain a yielding call. Calls to these names are themselves yielding
   *  and the compiler must wrap each call site in `await`. Populated by a
   *  pre-pass over the AST before code emission. */
  readonly yieldingFunctions = new Set<string>();
  private tempCounter = 0;

  /** Reserved-import bookkeeping for module paths other than RUNTIME_MODULE.
   *  Used by the macro registry to collect e.g. `@rbxts/services` symbols so
   *  the emitter can prepend the right imports alongside the runtime helpers. */
  private readonly extraImports = new Map<string, Set<string>>();

  /** Host-environment globals the script touched (game, workspace, task, …).
   *  The emitter prepends a `declare const X: any;` for each so tsc's
   *  type-check stops surfacing "Cannot find name". Distinct from `imports`
   *  because these aren't sourced from `luau2ts/runtime`; the host
   *  environment provides the actual runtime values. */
  private readonly ambientGlobalsUsed = new Set<string>();

  /** Map of type-alias names → number of leading regular generics. Used by
   *  the type-reference compiler so that `Foo<a, b, c>` for a Luau alias
   *  `type Foo<T...>` collapses its args into a tuple (`Foo<[a, b, c]>`)
   *  rather than emitting them as positional TS generics that Foo can't
   *  accept. Populated by a pre-scan pass before codegen. */
  private readonly aliasGenericArities = new Map<string, { generics: number; hasPack: boolean }>();

  /** Names of classes the class-shape detector inferred from
   *  metatable-OOP patterns. Recorded so subsequent `<Class>.new(...)`
   *  calls in the same file are lowered to `new <Class>(...)` rather than
   *  staying as static-method references. */
  private readonly detectedClasses = new Set<string>();

  /** Names locally bound to imported module identifiers — used to suppress
   *  redundant `let X = X` declarations when a macro rewrote the RHS to
   *  the same name as the LHS variable (e.g. `local Workspace =
   *  game:GetService('Workspace')` after the macro fires). The key is the
   *  Luau-level local name; the value is the imported module name (used
   *  for diagnostics). */
  private readonly suppressedLocals = new Set<string>();

  /** Compile-time signal: while truthy, calls that return `LuaTuple<...>`
   *  (string.gsub / find / match / byte under @rbxts/types) should NOT
   *  auto-extract the first element. Set by destructure-assignment and
   *  multi-return-call sites that genuinely consume the tuple. Defaults
   *  to false: single-value Luau positions (`f(string.gsub(...))`,
   *  `local x = string.gsub(...)`) auto-extract so the result types as
   *  the first element instead of as a tuple. */
  preferMultiReturn = false;

  /** rbxts-mode Phase 2: set to true the first time a service /
   *  Instance-root access casts through the `_LuauChild` recursive
   *  type. The emitter prepends an `interface _LuauChild` declaration
   *  once when this is true. */
  private _luauChildTypeUsed = false;
  useLuauChildType(): void { this._luauChildTypeUsed = true; }
  get luauChildTypeUsed(): boolean { return this._luauChildTypeUsed; }

  /** Service names recorded via `@rbxts/services` imports. IndexName
   *  compile uses this to identify root-service references and route
   *  them through the `_LuauChild` cast for dynamic-child access. */
  isRbxService(name: string): boolean {
    for (const { module, names } of this.extraImportEntries()) {
      if (module === '@rbxts/services' && names.includes(name)) return true;
    }
    return false;
  }

  /** Names of file-local functions whose return type is annotated as
   *  `LuaTuple<[…]>` (rbxts mode, uniform multi-return paths). Calls
   *  to these functions in single-LHS positions need a `[0]` extract
   *  so the receiver picks up the first element instead of the whole
   *  tuple — without it `let x = f()` types `x` as `LuaTuple<[…]>`
   *  and every `x.field` access fires TS2339. */
  readonly luaTupleReturningFunctions = new Set<string>();

  /** Phase 2 shape inference: a stack of per-function shape maps.
   *  Pushed by compileFunctionShape on entry, popped on exit. The
   *  top map is consulted by compileLocal/paramsFromLocals to emit
   *  structural type annotations from observed access patterns.
   *  Uses a stack (not a single map) so nested functions get their
   *  own shape scope without inner locals bleeding into the outer
   *  function's shape map. */
  private readonly shapeStack: Map<string, unknown>[] = [];

  pushShapeScope(shapes: Map<string, unknown>): void {
    this.shapeStack.push(shapes);
  }
  popShapeScope(): void {
    this.shapeStack.pop();
  }
  getShape(name: string): unknown {
    for (let i = this.shapeStack.length - 1; i >= 0; i--) {
      const s = this.shapeStack[i]!.get(name);
      if (s) return s;
    }
    return undefined;
  }

  constructor(public readonly compatMode: CompatMode = 'native') {}

  /** Record a named import from `module`. The emitter will write
   *  `import { ...names } from "<module>"` once per module. */
  useImport(module: string, name: string): string {
    let names = this.extraImports.get(module);
    if (!names) {
      names = new Set();
      this.extraImports.set(module, names);
    }
    names.add(name);
    return name;
  }

  /** Returns the recorded extra imports as `{ module, names[] }` tuples,
   *  sorted by module path then by name for deterministic output. */
  extraImportEntries(): { module: string; names: string[] }[] {
    return [...this.extraImports.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([module, names]) => ({ module, names: [...names].sort() }));
  }

  /** Record a name as a TS class detected by the class-shape pass. Lookup
   *  happens at every `<Name>.new(...)` call site so we can lower it to
   *  `new <Name>(...)` instead of leaving it as a static-method call. */
  recordDetectedClass(name: string): void {
    this.detectedClasses.add(name);
  }

  isDetectedClass(name: string): boolean {
    return this.detectedClasses.has(name);
  }

  /** Map class name → set of instance method names. Populated by the
   *  class-shape pass. Used to rewrite value-position
   *  `ClassName.method` reads to `ClassName.prototype.method`
   *  (Luau's "method as function reference" idiom — TS doesn't
   *  expose instance methods statically). */
  private readonly detectedClassMethods = new Map<string, Set<string>>();

  recordDetectedClassMethod(className: string, methodName: string): void {
    let s = this.detectedClassMethods.get(className);
    if (!s) {
      s = new Set();
      this.detectedClassMethods.set(className, s);
    }
    s.add(methodName);
  }

  isDetectedClassMethod(className: string, methodName: string): boolean {
    return this.detectedClassMethods.get(className)?.has(methodName) ?? false;
  }

  /** Mark a local identifier as already bound to an import of the same
   *  name. Subsequent `local <name> = <name>` declarations are dropped to
   *  avoid the redundant shadowing. */
  suppressLocal(name: string): void {
    this.suppressedLocals.add(name);
  }

  isSuppressedLocal(name: string): boolean {
    return this.suppressedLocals.has(name);
  }

  use(helper: string): string {
    this.imports.add(helper);
    return helper;
  }

  importedHelpers(): string[] {
    return [...this.imports].sort();
  }

  /** Record a host-environment global as referenced. Triggers a
   *  `declare const X: any;` preamble at emit time so the TS type-checker
   *  resolves the name without surfacing "Cannot find name". */
  useAmbient(name: string): void {
    this.ambientGlobalsUsed.add(name);
  }

  ambientGlobals(): Set<string> {
    return this.ambientGlobalsUsed;
  }

  recordAliasArity(name: string, generics: number, hasPack: boolean): void {
    this.aliasGenericArities.set(name, { generics, hasPack });
  }

  aliasArity(name: string): { generics: number; hasPack: boolean } | undefined {
    return this.aliasGenericArities.get(name);
  }

  freshIdentifier(prefix: string): string {
    const id = this.tempCounter;
    this.tempCounter += 1;
    return `${prefix}_${id}`;
  }

  withScope<T>(fn: () => T): T {
    this.scopes.push(new Map());
    this.jsNameOverrides.push(new Map());
    try {
      return fn();
    } finally {
      this.scopes.pop();
      this.jsNameOverrides.pop();
    }
  }

  setLocalJsName(name: string, jsName: string): void {
    this.jsNameOverrides[this.jsNameOverrides.length - 1]!.set(name, jsName);
  }

  getLocalJsName(name: string): string | undefined {
    for (let i = this.jsNameOverrides.length - 1; i >= 0; i -= 1) {
      const v = this.jsNameOverrides[i]!.get(name);
      if (v !== undefined) return v;
    }
    return undefined;
  }

  defineLocal(name: string, type: StaticValueType): void {
    this.scopes[this.scopes.length - 1]!.set(name, type);
  }

  hasLocalInCurrentScope(name: string): boolean {
    return this.scopes[this.scopes.length - 1]!.has(name);
  }

  hasLocalInOuterScope(name: string): boolean {
    for (let i = this.scopes.length - 2; i >= 0; i -= 1) {
      if (this.scopes[i]!.has(name)) return true;
    }
    return false;
  }

  assignLocal(name: string, type: StaticValueType): void {
    for (let i = this.scopes.length - 1; i >= 0; i -= 1) {
      const scope = this.scopes[i]!;
      if (scope.has(name)) {
        scope.set(name, type);
        return;
      }
    }
    this.defineLocal(name, type);
  }

  lookupLocal(name: string): StaticValueType {
    for (let i = this.scopes.length - 1; i >= 0; i -= 1) {
      const type = this.scopes[i]!.get(name);
      if (type) return type;
    }
    return 'unknown';
  }
}
