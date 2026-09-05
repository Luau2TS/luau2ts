import { getOracle, type ClassOracle } from './oracle/index.js';
import type { FlowFact } from './flow.js';
import type { TypeNode, TypePack } from '../parser/index.js';
import { primitiveFromAnnotation } from './type.js';

function declaredTypeFromAnnotation(t: TypeNode | null | undefined): StaticValueType | undefined {
  const prim = primitiveFromAnnotation(t);
  if (prim) return prim;
  if (!t) return undefined;
  if (t.type === 'TypeGroup') return declaredTypeFromAnnotation(t.groupType);
  if (t.type === 'TypeReference' && !t.prefix && t.parameters.length === 0) {
    if (ARITH_DATATYPES.has(t.name) || t.name === VECTOR_LIB_TYPE) return `datatype:${t.name}`;
  }
  return undefined;
}

/** Element annotation of a Luau array type (`{T}` / `{[number]: T}`);
 *  `undefined` when the annotation isn't array-shaped. */
function annotationArrayElement(t: TypeNode | null | undefined): TypeNode | null | undefined {
  if (!t) return undefined;
  if (t.type === 'TypeGroup') return annotationArrayElement(t.groupType);
  if (t.type === 'TypeTable'
    && t.props.length === 0
    && !!t.indexer
    && t.indexer.indexType.type === 'TypeReference'
    && t.indexer.indexType.name === 'number') {
    return t.indexer.resultType;
  }
  return undefined;
}

export const RUNTIME_MODULE = 'luau2ts/runtime';

/** Static type info for a value. Roblox datatypes use `'datatype:<Name>'`
 *  so arithmetic operators can fast-path to metamethod calls. */
export type StaticValueType =
  | 'number'
  | 'boolean'
  | 'string'
  | 'nil'
  | 'unknown'
  | 'dyn'
  | `datatype:${string}`;

/** Name of the emitted alias for a Luau value with no type information:
 *  `type _LuauValue = number & { [k: string]: _LuauValue }`. Member
 *  reads, indexing, arithmetic and comparisons all type-check on it
 *  directly, and roblox-ts lowers each to the same Lua the Luau had —
 *  so one cast at the binding replaces one per use. roblox-ts rejects
 *  `any` outright, which is why this shape and not `any`. */
export const DYN_VALUE_TYPE = '_LuauValue';
export const DYN_FN_TYPE = '_LuauFn';
/** `(this: _LuauValue, ...args) => _LuauValue` — the `this` parameter is
 *  what makes roblox-ts lower the call with `:`, preserving Luau's
 *  method-call receiver. */
export const DYN_METHOD_TYPE = '_LuauMethod';

/** Roblox datatypes with `__add`/`__sub`/`__mul`/`__div`/`__unm` metamethods
 *  the compiler can fast-path to instance methods. */
export const ARITH_DATATYPES = new Set([
  'Vector3', 'Vector2', 'Vector3int16', 'Vector2int16', 'CFrame',
]);

/** Luau's `vector` library type. @rbxts/types declares it as a nominal
 *  interface with `x`/`y`/`z` and no arithmetic methods, so operators on
 *  it bridge through `number` and cast the result back. */
export const VECTOR_LIB_TYPE = 'vector';

export function isDatatypeStatic(t: StaticValueType): t is `datatype:${string}` {
  return typeof t === 'string' && t.startsWith('datatype:');
}

/** Compatibility mode for emitted TypeScript.
 *
 *  - `native`: imports stdlib helpers from `luau2ts/runtime`.
 *  - `rbxts`:  emits TS compatible with roblox-ts (`new Vector3(...)`,
 *    `@rbxts/services` imports, `new ClassName()` for `Instance.new`, etc).
 */
export type CompatMode = 'native' | 'rbxts';

export interface BindingSnapshot {
  declared: StaticValueType | undefined;
  annotation: TypeNode | undefined;
  array: TypeNode | null | undefined;
  classLocal: string | undefined;
  shapeTyped: boolean;
  dyn: boolean;
}

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

  /** Locals whose emitted TS declaration carries a primitive type TS can
   *  see without help: an explicit Luau annotation (`local n: number`,
   *  `function f(s: string)`), a numeric-for control variable, or the
   *  index slot of an `ipairs` destructure. Distinct from the tracked
   *  StaticValueType, which follows reassignments TS never sees. */
  readonly tsDeclaredTypeLocal = new Map<string, StaticValueType>();

  /** Declared annotation of a binding, kept as the parsed Luau node so
   *  member reads can resolve field types through it (including through
   *  `type` aliases). Only set where an annotation actually exists. */
  readonly tsDeclaredAnnotation = new Map<string, TypeNode>();

  /** Script-level `type X = …` declarations, for resolving annotations
   *  that name an alias. */
  readonly typeAliases = new Map<string, TypeNode>();

  /** Corpus path → that module's `export type` aliases (from the
   *  cross-script index). Lets `Mod.Foo` annotations resolve. */
  moduleTypeAliases: Map<string, Map<string, TypeNode>> = new Map();

  /** Every node reachable from a foreign module's alias bodies, tagged
   *  with that module's corpus path, so an unprefixed reference inside
   *  such a body resolves against its own module rather than ours. */
  private readonly nodeHome = new WeakMap<object, string>();
  private readonly homedModules = new Set<string>();

  private tagHome(node: unknown, home: string): void {
    if (!node || typeof node !== 'object') return;
    if (this.nodeHome.has(node)) return;
    this.nodeHome.set(node, home);
    for (const v of Object.values(node as Record<string, unknown>)) {
      if (Array.isArray(v)) for (const it of v) this.tagHome(it, home);
      else if (v && typeof v === 'object') this.tagHome(v, home);
    }
  }

  /** Alias table a reference should resolve in: the foreign module the
   *  node was loaded from, or this script's. */
  aliasTableFor(node: TypeNode): { table: Map<string, TypeNode>; home: string | null } {
    const home = this.nodeHome.get(node) ?? null;
    if (home) return { table: this.moduleTypeAliases.get(home) ?? new Map(), home };
    return { table: this.typeAliases, home: null };
  }

  /** Aliases of the module behind a require-bound local (`Mod.Foo`). */
  foreignAliases(prefixLocal: string): { table: Map<string, TypeNode>; home: string } | null {
    const home = this.requireLocalPaths.get(prefixLocal);
    if (!home) return null;
    const table = this.moduleTypeAliases.get(home);
    if (!table) return null;
    if (!this.homedModules.has(home)) {
      this.homedModules.add(home);
      for (const body of table.values()) this.tagHome(body, home);
    }
    return { table, home };
  }

  /** Follow alias references to the underlying type — script-local
   *  aliases, `Mod.Foo` into a required module, and unprefixed names
   *  inside a foreign alias body. Bounded so `type T = T` can't spin. */
  resolveAlias(t: TypeNode | null | undefined): TypeNode | null {
    let cur = t ?? null;
    for (let i = 0; i < 8 && cur; i += 1) {
      if (cur.type === 'TypeGroup') { cur = cur.groupType; continue; }
      if (cur.type !== 'TypeReference' || cur.parameters.length > 0) return cur;
      let next: TypeNode | undefined;
      if (cur.prefix) {
        next = this.foreignAliases(cur.prefix)?.table.get(cur.name);
      } else {
        next = this.aliasTableFor(cur).table.get(cur.name);
      }
      if (!next) return cur;
      cur = next;
    }
    return cur;
  }

  /** Declared type of `<binding>.<field>`, when the binding's annotation
   *  resolves to a table type declaring that field. */
  declaredFieldAnnotation(binding: string, field: string): TypeNode | null {
    const resolved = this.resolveAlias(this.tsDeclaredAnnotation.get(binding));
    if (!resolved || resolved.type !== 'TypeTable') return null;
    for (const prop of resolved.props) {
      if (prop.name === field) return prop.propType ?? null;
    }
    // `{ [string]: number }` types every named field too — the emitted
    // index signature is what TS resolves `t.field` against.
    const indexer = resolved.indexer;
    if (indexer && indexer.indexType.type === 'TypeReference' && indexer.indexType.name === 'string') {
      return indexer.resultType;
    }
    return null;
  }

  /** Locals whose emitted TS type is an array (`local t: {number}`,
   *  `function f(list: {Player})`). Runtime-index reads and writes on
   *  these rebase the 1-based Luau index to roblox-ts's 0-based array
   *  access instead of routing through a string-keyed Record bridge. */
  readonly tsArrayTypedLocal = new Map<string, TypeNode | null>();

  /** File-local functions with a single-type return annotation, mapped
   *  to the static view of that type. The annotation is emitted on the
   *  TS declaration, so call results type exactly as declared. */
  readonly userFunctionReturnType = new Map<string, StaticValueType>();

  /** File-local functions' single-type return annotations and per-param
   *  annotations, as parsed nodes. The emitted signature carries them,
   *  so call results and matching arguments are exactly typed. */
  readonly userFunctionReturnAnnotation = new Map<string, TypeNode>();
  readonly userFunctionParamAnnotations = new Map<string, (TypeNode | null)[]>();
  /** Per position: does the emitted signature declare `unknown` (a
   *  `_LuauValue`-rebound param)? Any argument fits such a slot. */
  readonly userFunctionDynParams = new Map<string, boolean[]>();

  /** Declared return packs of the functions currently being compiled,
   *  innermost last. `return X` consults the top so a value TS can't
   *  prove matches the declared type is bridged instead of erroring. */
  readonly returnAnnotationStack: (TypePack | null)[] = [];

  /** Record (or clear) the TS-visible type for a freshly declared
   *  binding. Every declaration site must call this so a later same-named
   *  binding without a usable annotation doesn't inherit stale trust. */
  noteDeclaredType(name: string, annotation: TypeNode | null | undefined): void {
    this.tsDynLocal.delete(name);
    const resolved = this.resolveAlias(annotation);
    this.noteDeclaredTypeKind(name, declaredTypeFromAnnotation(resolved));
    const element = annotationArrayElement(resolved);
    if (element !== undefined) this.tsArrayTypedLocal.set(name, element);
    else this.tsArrayTypedLocal.delete(name);
    if (annotation) this.tsDeclaredAnnotation.set(name, annotation);
    else this.tsDeclaredAnnotation.delete(name);
  }

  /** Declare a binding's TS type without an annotation node (loop
   *  variables, destructure slots). Clears any annotation an outer
   *  same-named binding left behind — the new binding shadows it. */
  noteDeclaredTypeKind(name: string, type: StaticValueType | undefined): void {
    if (type === 'dyn') {
      this.tsDeclaredTypeLocal.delete(name);
      this.tsDynLocal.add(name);
    } else {
      this.tsDynLocal.delete(name);
      if (type && type !== 'unknown' && type !== 'nil') this.tsDeclaredTypeLocal.set(name, type);
      else this.tsDeclaredTypeLocal.delete(name);
    }
    this.tsDeclaredAnnotation.delete(name);
  }

  /** Capture everything the TS-type maps know about `name`, so a
   *  block-scoped binding can be undone when its scope ends. */
  snapshotBinding(name: string): BindingSnapshot {
    return {
      declared: this.tsDeclaredTypeLocal.get(name),
      annotation: this.tsDeclaredAnnotation.get(name),
      array: this.tsArrayTypedLocal.has(name) ? this.tsArrayTypedLocal.get(name) ?? null : undefined,
      classLocal: this.tsTypedClassLocal.get(name),
      shapeTyped: this.tsShapeTypedLocal.has(name),
      dyn: this.tsDynLocal.has(name),
    };
  }

  restoreBinding(name: string, snap: BindingSnapshot): void {
    if (snap.dyn) this.tsDynLocal.add(name);
    else this.tsDynLocal.delete(name);
    if (snap.declared !== undefined) this.tsDeclaredTypeLocal.set(name, snap.declared);
    else this.tsDeclaredTypeLocal.delete(name);
    if (snap.annotation !== undefined) this.tsDeclaredAnnotation.set(name, snap.annotation);
    else this.tsDeclaredAnnotation.delete(name);
    if (snap.array !== undefined) this.tsArrayTypedLocal.set(name, snap.array);
    else this.tsArrayTypedLocal.delete(name);
    if (snap.classLocal !== undefined) this.tsTypedClassLocal.set(name, snap.classLocal);
    else this.tsTypedClassLocal.delete(name);
    if (snap.shapeTyped) this.tsShapeTypedLocal.add(name);
    else this.tsShapeTypedLocal.delete(name);
  }

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

  /** Phase 1 (Architectural Phase 3 finish): per-script synthesized type
   *  for the bare `script` / `workspace` global. compileExpr's dynamic-
   *  root path consults this so the chain casts through the synthesized
   *  shape instead of `_LuauChild`. */
  scriptParentRootTypes: Map<string, unknown> = new Map();

  /** Per-alias-local synthesized type, for `local model = script.Parent`
   *  style alias bindings. compileLocal reads this and casts the init. */
  scriptParentAliasTypes: Map<string, unknown> = new Map();

  /** Pass 2: cross-script require() inference cache. Module path →
   *  inferred return-type text. */
  moduleReturnTypes: Map<string, string> = new Map();

  /** Pass 2 extension: module path → recordMap field names. */
  moduleRecordMapFields: Map<string, string[]> = new Map();

  /** Pass 3: module path → exported-member kind map ('method' for fns
   *  declared as `function M.foo()` or `M.foo = function`, 'property'
   *  for plain assignments, 'recordMap' for `M.foo = {}`). Used to
   *  decide whether a `mod.foo(...)` call needs the structural callable
   *  cast — for 'method' members, the cached return-type already
   *  declares `foo(...args): defined`, so TS sees the call as typed and
   *  the cast is pure noise. */
  moduleExportedMembers: Map<string, Map<string, 'method' | 'property' | 'recordMap'>> = new Map();

  /** Pass 3: per-script set of locals bound to `require(...)` whose
   *  cached return-shape is known. Keyed by local name; value is the
   *  corpus path of the required module so call-site lookups can index
   *  `moduleExportedMembers` directly without re-resolving the require
   *  argument every time. */
  readonly requireBoundLocals = new Map<string, string>();

  /** Pass 5: per-ForInStat → per-var → synthesized TS type node, set
   *  by inferLoopVarShapes. compileForIn consults this to annotate the
   *  destructured loop variable so downstream `.X.Y` access bypasses
   *  the Record routing path. */
  loopVarTypes: Map<unknown, Map<string, unknown>> = new Map();

  /** Pass 2: the script's own corpus path, used as the anchor for
   *  resolving `require(script.Parent.X)` patterns. */
  currentScriptPath = '';

  /** Corpus path → emitted module path (relative to the output root,
   *  POSIX, no extension). Lets qualified type references into a
   *  required module (`Mod.Foo`) become a type-only namespace import. */
  moduleOutPaths: Map<string, string> = new Map();

  /** This script's emitted module path in the same form as
   *  `moduleOutPaths` values; empty when unknown (single-file mode). */
  currentOutPath = '';

  /** Top-level `local X = require(...)` bindings resolved to corpus
   *  paths, regardless of whether a cached return type exists. */
  readonly requireLocalPaths = new Map<string, string>();


  /** Pass 3: function-name → param-name → inferred TS-type-text. Set
   *  by `inferParamBackprop`; consulted by `paramsFromLocals` so a
   *  consistently-typed argument binds a real param annotation. */
  paramBackpropTypes: Map<string, Map<string, string>> = new Map();

  /** Pass 3: function-name → ordered param names. Used by
   *  `castArgsForCall` to map a positional arg to its declared param
   *  name, then look up the backprop type. */
  paramBackpropParamNames: Map<string, string[]> = new Map();

  /** Pass 4: local-name → narrowed Instance subclass. Inferred from
   *  observed member accesses (`light.Color` + `light.Material` ⇒
   *  BasePart). `compileLocal` reads this and casts the init into the
   *  narrowed class so downstream property access skips Record routing. */
  instanceNarrowings: Map<string, string> = new Map();

  /** Pass 2 extension: per-local set of fields that Pass-2 synthesis
   *  typed as `Record<string, defined>` (empty-table-literal init pattern
   *  e.g. `module.Profiles = {}`). Used by bracket-access code to skip
   *  the Record bridge when the chain hits such a field. */
  recordMapFields: Map<string, Set<string>> = new Map();

  /** Set by the backprop pass: locals whose downstream usage proves they are
   *  Instance-shaped. compileLocalStat wraps the init through
   *  `as unknown as Instance` so the local's TS type matches the inferred
   *  class, letting downstream receiver gates skip the Record routing. */
  readonly backpropInstanceLocals = new Set<string>();

  /** Locals/params whose emitted TS declaration already has a synthesized
   *  structural annotation. Dynamic-child fallback should not steal known
   *  fields from these values; their declared shape is the best information
   *  we currently have. */
  readonly tsShapeTypedLocal = new Set<string>();

  /** Subset of `tsShapeTypedLocal` whose emitted annotation came from
   *  this script's own observed-usage shape (compileLocal / function
   *  params), so the shape's leaf evidence describes what TS sees. Loop
   *  variables and class fields synthesize differently and are excluded. */
  readonly tsPass6ShapeLocal = new Set<string>();

  /** Bindings whose emitted TS type is `_LuauValue`. Member chains
   *  rooted in one are `_LuauValue` too and need no bridge. */
  readonly tsDynLocal = new Set<string>();

  /** Call expressions emitted through the `_LuauFn` / `_LuauMethod`
   *  bridge; their result is `_LuauValue`. Recorded at emit time since
   *  the decision lives in the call codegen. */
  readonly dynResultCalls = new WeakSet<object>();

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

  /** User functions with at least one `return nil` / bare `return` path,
   *  meaning their declared class result is actually `Class | undefined`.
   *  Call sites that use the result as a method receiver (`f().Method()`)
   *  prepend `!` so TS doesn't surface TS2532. */
  readonly userFunctionMayReturnNil = new Set<string>();

  /** Set by the pre-pass that detects user functions whose params are all
   *  effectively `unknown` (no annotation, no shape-inferred type, no
   *  primitive constraint from param-infer). Call sites can drop the
   *  `as unknown as Parameters<typeof f>[i]` wrap for these — passing
   *  `unknown` to an `unknown`-typed slot is a no-op. */
  readonly userFunctionUnknownParams = new Set<string>();

  /** Injected by compile/index.ts so macros (in a sibling module) can ask
   *  for an expression's static Luau type without re-importing the
   *  monolithic compileExpr surface. Returns 'unknown' before injection. */
  staticTypeOf: (expr: unknown) => StaticValueType = () => 'unknown';

  /** Like `staticTypeOf`, but only reports a type TS itself will see on
   *  the emitted expression — the signal for skipping a cast. Injected
   *  by compile/index.ts alongside `staticTypeOf`. */
  tsVisibleTypeOf: (expr: unknown) => StaticValueType = () => 'unknown';

  /** Static view of an annotation after alias resolution. Injected. */
  staticTypeOfAnnotation: (t: TypeNode | null | undefined) => StaticValueType = () => 'unknown';

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
