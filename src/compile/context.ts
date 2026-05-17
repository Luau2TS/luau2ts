import { getOracle, type ClassOracle } from './oracle/index.js';
import type { FlowFact } from './flow.js';

export const RUNTIME_MODULE = 'luau2ts/runtime';

/** Static type info for a value. Roblox datatypes use `'datatype:<Name>'`
 *  so arithmetic operators can fast-path to metamethod calls. */
export type StaticValueType =
  | 'number'
  | 'boolean'
  | 'string'
  | 'nil'
  | 'unknown'
  | `datatype:${string}`;

/** Roblox datatypes with `__add`/`__sub`/`__mul`/`__div`/`__unm` metamethods
 *  the compiler can fast-path to instance methods. */
export const ARITH_DATATYPES = new Set([
  'Vector3', 'Vector2', 'Vector3int16', 'Vector2int16', 'CFrame',
]);

/** Compatibility mode for emitted TypeScript.
 *
 *  - `native`: imports stdlib helpers from `luau2ts/runtime`.
 *  - `rbxts`:  emits TS compatible with roblox-ts (`new Vector3(...)`,
 *    `@rbxts/services` imports, `new ClassName()` for `Instance.new`, etc).
 */
export type CompatMode = 'native' | 'rbxts';

export class CompileContext {
  private readonly imports = new Set<string>();
  private readonly scopes: Map<string, StaticValueType>[] = [new Map()];
  private readonly jsNameOverrides: Map<string, string>[] = [new Map()];
  /** Names of user-defined functions whose bodies transitively yield. Call
   *  sites to these must be wrapped in `await`. Populated by a pre-pass. */
  readonly yieldingFunctions = new Set<string>();
  private tempCounter = 0;

  private readonly extraImports = new Map<string, Set<string>>();

  private readonly ambientGlobalsUsed = new Set<string>();

  private readonly aliasGenericArities = new Map<string, { generics: number; hasPack: boolean }>();

  private readonly detectedClasses = new Set<string>();

  private readonly suppressedLocals = new Set<string>();

  /** While truthy, calls returning `LuaTuple<...>` should not auto-extract
   *  the first element. Set by destructure / multi-return call sites. */
  preferMultiReturn = false;

  private _luauChildTypeUsed = false;
  useLuauChildType(): void { this._luauChildTypeUsed = true; }
  get luauChildTypeUsed(): boolean { return this._luauChildTypeUsed; }

  isRbxService(name: string): boolean {
    for (const { module, names } of this.extraImportEntries()) {
      if (module === '@rbxts/services' && names.includes(name)) return true;
    }
    return false;
  }

  /** Names of file-local functions returning `LuaTuple<[…]>`. Single-LHS
   *  call sites need a `[0]` extract or downstream property access fails. */
  readonly luaTupleReturningFunctions = new Set<string>();

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

  readonly oracle: ClassOracle = getOracle();

  /** Per-local flow facts produced by the forward pass in flow.ts.
   *  null means flow pass hasn't run yet for this compile. */
  flowFactByExpr: WeakMap<object, FlowFact> | null = null;
  flowFinalLocalFacts: Map<string, FlowFact> | null = null;

  /** Param primitive type inferred by param-infer.ts at function-shape time,
   *  consulted by staticTypeOfExpr so `n` in `function f(n)` propagates as
   *  number when the body does `math.floor(n)`. Keyed by local name; outer
   *  shadowing is governed by the static scopes mechanism in defineLocal. */
  readonly preInferredParamType = new Map<string, 'number' | 'string' | 'boolean'>();

  /** Locals whose TS-inferred type is known to match their tracked
   *  primitive type — typically `let s = tostring(...)` where TS infers
   *  `s: string` from tostring's @rbxts/types return type. Castless arg
   *  emit relies on this: a Local with a tracked primitive that *also*
   *  has TS narrowing is safe to pass into a same-typed slot. */
  readonly tsTypedPrimitiveLocal = new Set<string>();

  /** Locals whose init resolved to a concrete Roblox class via the oracle
   *  — `local x = Instance.new(...)`, `:WaitForChild(...)`,
   *  `:FindFirstChildOfClass(...)`. Maps the local name to the resolved
   *  className (or `Instance` when only the base class is known). Used to
   *  (a) suppress reassignment shape-cast wraps that would conflict with
   *  the local's TS-inferred class type, and (b) skip the Record<string,
   *  unknown> wrap on property writes whose name is an oracle-declared
   *  property of the resolved class. */
  readonly tsTypedClassLocal = new Map<string, string>();

  /** Class-typed locals whose initializer may be nil in @rbxts/types
   *  (`FindFirstChild`, helper functions with nil fallthrough). Member
   *  reads/method calls use `!` at the access site to match Luau's
   *  runtime-error semantics without making non-null WaitForChild chains
   *  noisy. */
  readonly tsOptionalClassLocal = new Set<string>();

  /** Locals whose initializer was emitted as `_LuauChild`, the dynamic
   *  child-access fallback used for unknown Instance children. Downstream
   *  casts from these locals to concrete classes need an `unknown` bridge
   *  because `_LuauChild` is callable/indexed and does not structurally
   *  overlap with Roblox class interfaces. */
  readonly tsLuauChildLocal = new Set<string>();

  /** Locals/params whose emitted TS declaration already has a synthesized
   *  structural annotation. Dynamic-child fallback should not steal known
   *  fields from these values; their declared shape is the best information
   *  we currently have. */
  readonly tsShapeTypedLocal = new Set<string>();

  /** Class-method-body context: a map of `self.X` field name → its
   *  synthesized field shape (TypeNode). Populated by class-shape's
   *  method-body compile loop so `self.X = Y` writes in compileAssign
   *  can cast RHS through the declared field type — fixes the
   *  `Type 'unknown' is not assignable to type '{ … }'` errors that
   *  the Record-cast skip would otherwise leave behind. */
  selfFieldShapes: Map<string, unknown> | null = null;

  /** Locals bound via user-function LuaTuple destructure
   *  (`const [x] = userFn()`). The function's slot-0 type annotation
   *  is often narrower than `x`'s observed access pattern, so reads on
   *  `x.Y` need to route through Record to absorb shape mismatches. */
  readonly destructuredLuaTupleLocal = new Set<string>();

  /** File-local function return classes inferred from their return
   *  expressions after the flow pass. This is intentionally narrow:
   *  it only records functions whose observed return values are all the
   *  same Roblox class (possibly with nil fallthrough). */
  readonly userFunctionReturnClass = new Map<string, string>();

  /** Injected by compile/index.ts so macros (in a sibling module) can ask
   *  for an expression's static Luau type without re-importing the
   *  monolithic compileExpr surface. Returns 'unknown' before injection. */
  staticTypeOf: (expr: unknown) => StaticValueType = () => 'unknown';

  /** LocalStats whose vars are never reassigned in their scope. Populated
   *  by inferConstLocals at compile setup and consulted by compileLocal so
   *  unreassigned bindings emit `const` instead of `let`. */
  constLocals: WeakSet<object> = new WeakSet();

  /** Per-local primitive type inferred by local-type-infer.ts (from
   *  init + reassignments). Lets compileLocal emit `: number` annotation
   *  on the declaration so downstream arithmetic / arg-cast sites can
   *  trust the local without re-casting per use. */
  localTypeMap: { perStat: WeakMap<object, 'number' | 'string' | 'boolean'>; byName: Map<string, 'number' | 'string' | 'boolean'> } = {
    perStat: new WeakMap(),
    byName: new Map(),
  };

  constructor(public readonly compatMode: CompatMode = 'native') {}

  /** Record a named import from `module`. */
  useImport(module: string, name: string): string {
    let names = this.extraImports.get(module);
    if (!names) {
      names = new Set();
      this.extraImports.set(module, names);
    }
    names.add(name);
    return name;
  }

  extraImportEntries(): { module: string; names: string[] }[] {
    return [...this.extraImports.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([module, names]) => ({ module, names: [...names].sort() }));
  }

  recordDetectedClass(name: string): void {
    this.detectedClasses.add(name);
  }

  isDetectedClass(name: string): boolean {
    return this.detectedClasses.has(name);
  }

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
