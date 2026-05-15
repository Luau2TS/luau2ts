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
