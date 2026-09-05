// Cross-script analysis types and entry points. The corpus index is
// built once per CLI invocation and threaded into each compile() call
// so per-script work can consult cross-script facts (module return
// shapes, exported function signatures, parent-class resolution).
//
// Phase 1 wires the existing analyzeModuleReturn pass (in
// `../require-infer.ts`) into the CLI's compileDirMode and
// compileProjectMode; previously only the stress harness pre-populated
// these maps. Phase 2 adds .d.ts emission as a durable artifact.
// Phases 3-4 extend the index with fn-signature intersection and
// parent-class plumbing — placeholder fields are kept here so the
// callers can refer to the full shape from day one.

export { buildCorpusIndex, deriveCompileMaps, type CorpusScript } from './build-index.js';
import type { TypeNode } from '../../parser/index.js';
export { renderDts } from './dts-emit.js';

export interface CorpusIndex {
  /** Keyed by corpus path. The path form depends on the driver: Roblox
   *  instance path (e.g. `/ReplicatedStorage/Modules/Foo`) for the stress
   *  harness and Rojo project mode; filesystem path with the .luau/.lua
   *  extension stripped for plain directory mode. Per-script compile()
   *  is fed the same form as `corpusPath`, so `script.Parent.X`
   *  resolution stays internally consistent. */
  modules: Map<string, ModuleIndexEntry>;
}

export interface ModuleIndexEntry {
  /** TS type text from analyzeModuleReturn, or null if no usable
   *  return statement was found. */
  returnTypeText: string | null;
  /** Script-level `export type X = …` declarations (non-generic), as
   *  parsed Luau nodes. Consumers referencing `Mod.X` inline the alias
   *  as a local type declaration and resolve field types through it. */
  exportedTypes: Map<string, TypeNode>;
  /** Field names typed as Record<string, defined | undefined> (empty-table
   *  init pattern). Consulted by per-script compile to skip the Record
   *  bridge on `mod.<field>[k]` access. */
  recordMapFields: string[];
  /** Structured exported-member kind map. The same data
   *  analyzeModuleReturn built the printed type from, kept here so
   *  per-script compile() can ask "is `M.foo` a method?" — used to skip
   *  the structural `as unknown as (...args) => unknown` callable cast
   *  when calling a known method on a require-bound local. */
  exportedMembers: Map<string, 'method' | 'property' | 'recordMap'>;
  /** Phase 3 placeholder: per-exported-function signature. Populated by
   *  fn-signature collection + cross-script intersection. */
  exportedFns: Map<string, FnSignature>;
  /** Phase 4 placeholder: the Roblox class of `script.Parent` for this
   *  module, when resolvable from the Rojo tree or rbxl IR. Consumed by
   *  per-script script-parent-infer to start chains from the resolved
   *  class instead of LuaSourceContainer. */
  parentClass: string | null;
}

export interface FnSignature {
  params: { name: string; typeText: string }[];
  returnText: string;
  /** Param names used in callback positions (`.Connect(arg)`,
   *  `:Once(arg)`, etc.). Cross-script param-backprop must not narrow
   *  these — narrowing breaks contravariance against signal-handler
   *  types. */
  contravariantParams: Set<string>;
}

export interface CallSite {
  callerPath: string;
  calleePath: string;
  exportedFnName: string;
  /** Static types of each positional arg at the call site, as observed
   *  by param-backprop's staticTypeOf. null means "couldn't determine". */
  argStaticTypes: (string | null)[];
}
