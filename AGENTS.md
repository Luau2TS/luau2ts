# AGENTS.md

This file provides guidance to AI coding agents working with code in this repository.

PR policy: AI-generated PRs are welcome and will be reviewed and accepted if the diff is clean, tested, and follows the conventions below. Tag the PR with `ai-authored` so reviewers can apply the right scrutiny.

See also `../luau2ts.com/` for the docs site and playground that consume this package.

## Project Overview

`luau2ts` is a Luau-to-TypeScript compiler. It reads Luau source (the Roblox dialect of Lua) and emits TypeScript, optionally targeting the [`roblox-ts`](https://roblox-ts.com) ecosystem so the output drops back into a Roblox build via `rbxtsc`. The package ships as a CLI (`luau2ts`) and as a library (`compile(source, options)`), and also produces `.d.ts` declaration files alongside compiled output for migration use cases.

The repo is a pnpm workspace with one optional sub-package (`@luau2ts/analyzer`, a WASM build of the official Luau analyzer used for the optional `--check-luau` pass).

## Development Commands

### Building
```bash
pnpm build                                 # Build the root compiler (runs prebuild then `tsc -b`)
pnpm --filter @luau2ts/analyzer build      # Build the analyzer WASM (one-time, slow)
```

`prebuild` runs two code generators:
- `scripts/build-oracle.mjs` vendors `@rbxts/types` data into `src/compile/oracle/data.generated.ts`.
- `scripts/build-api-macros.mjs` generates api-data, exclusions, stdlib-slots, datatype-slots.

If you touch the generators or `@rbxts/types`, rerun `pnpm build` to refresh `data.generated.ts`.

### Tests
```bash
pnpm test                                  # Run the vitest suite (~295 tests)
pnpm test:watch                            # Watch mode
pnpm typecheck                             # tsc --noEmit
```

The suite is in `src/compile.test.ts` plus a few smaller files. Most tests are golden-file: a Luau snippet in, a TS string expected out. The test runner snapshots exact emit (including helper imports), so a change in cast emission or pretty-printing forces test updates.

### Stress harness
```bash
node scripts/stress-rbxl.mjs <path-to-rbxl> [--mode rbxts|native] [--dump <outDir>] [--limit N] [--verbose]
```

Compiles every script inside an `.rbxl` Roblox place file. Reports parse / TS / Luau errors per script, lists worst offenders, and optionally dumps the compiled `.ts` tree (and `.d.ts` sidecar) to `<outDir>` for inspection with `rbxtsc` or hand-written TS consumers. The canonical stress corpus is `C:/Users/tonyt/Desktop/thisisatest.rbxl` (127 scripts). The harness uses the sibling repo `rbx-web`'s rbxl binary parser.

### Roundtrip
The end-to-end smoke test lives in the sibling `test2/` directory (`pnpm link`ed to this repo):
```bash
cd ../test2
node roundtrip.mjs [<fixture.luau>]        # Simple.luau by default
node roundtrip-corpus.mjs                  # Roundtrip every dumped corpus script
```

`roundtrip.mjs` runs Luau through luau2ts, then through roblox-ts (`rbxtsc --type package`) back to Lua, then StyLua-formats both ends so a diff highlights real semantic differences. Exit 0 means clean.

### Canary
```bash
node scripts/canary.mjs                    # One specific Luau snippet, prints the emitted TS
```

A hand-curated input that exercises chain-of-method-calls, multi-return, and string-interpolation patterns. Used as a fast eye-check after compiler changes.

## Architecture Overview

### Project Structure
- `src/parser/`: Luau parser (WASM-backed by the official Luau parser, see `wasm/`).
- `src/compile/`: the compiler itself, around 9000 lines of TypeScript in `index.ts` plus several pre-passes.
- `src/compile/oracle/`: vendored `@rbxts/types` lookup tables: class hierarchy, method/property signatures, conventional child-name resolution.
- `src/compile/macros/`: per-namespace API macros (`math`, `string`, `table`, `Instance`, datatype ctors).
- `src/compile/cross-script/`: corpus-aware analysis. Builds a per-module index, emits `.d.ts` files, collects cross-script call sites for function-param backprop.
- `src/cli/`: CLI entry (`bin.ts`), arg parser (`args.ts`), output modes (`modes.ts`).
- `src/rojo/`: Rojo project-file walker. Resolves `default.project.json` to a flat script list with Roblox instance paths.
- `src/runtime/`: helper functions imported by `native` mode emit (`luaIndex`, `lualen`, `pairKeys`, `multiret`, `truthy`, etc).
- `packages/analyzer/`: optional WASM build of the official Luau analyzer for `--check-luau`.
- `scripts/`: build-time generators, stress harness, canary.
- `test2/` (sibling): roundtrip fixture and end-to-end stage.

### Key Entry Points
- `src/compile/index.ts:compile(source, options)` is the library entry. Parses, runs pre-passes, emits TS source string plus errors.
- `src/cli/bin.ts` is the CLI entry, dispatches to one of three modes.
- `src/cli/modes.ts` defines `compileFileMode`, `compileDirMode`, `compileProjectMode` for single file, directory tree, and Rojo project respectively.

### Compile Pipeline
A call to `compile(source, options)` walks this sequence (rbxts mode shown; native mode skips some passes):

1. **Parse**: Luau AST via the WASM parser.
2. **Pre-passes** (rbxts only):
   - `rewriteGameServices` rewrites `game:GetService("X")` to bare `X` access (adds `@rbxts/services` import).
   - `splitInstanceChains` splits inline `:WaitForChild():WaitForChild()` chains into typed intermediate locals.
   - `hoistInnerLuaTupleCalls` hoists nested `LuaTuple`-returning calls into fresh locals so codegen can destructure cleanly.
   - `inferConstLocals` marks `local` declarations that are never reassigned for `const` emit.
3. **Type-inference passes** (rbxts only):
   - `flow.ts:runFlowPass`: forward flow pass producing `FlowFact`s per expression (class / datatype / primitive / unknown).
   - `param-infer.ts:inferParamPrimitives`: per-function param primitive observation.
   - `script-parent-infer.ts:inferScriptParentShapes` (Pass 1): synthesizes structural types for `script` / `workspace` / service-root chains.
   - `param-backprop.ts:inferParamBackprop` (Pass 3): same-script function param backprop. Intersects call-site arg types.
   - `instance-narrow.ts:inferInstanceNarrowings` (Pass 4): narrows `Instance`-typed locals to subclasses based on observed members.
   - `loop-var-infer.ts:inferLoopVarShapes` (Pass 5): per-`for ... in ...` synthesized shapes for loop variables.
4. **Codegen**: `compileBlockBody` walks the AST emitting TypeScript via the `typescript` package's factory API.
5. **Post-emit** (optional): TypeScript Layer-A check via `--check-ts`, Luau analyzer Layer-B check via `--check-luau`.

### Cross-script Analysis
The `src/compile/cross-script/` module runs before per-script compile when invoked via `compileDirMode` or `compileProjectMode` (and from the stress harness):
- `build-index.ts` parses every corpus script, runs `analyzeModuleReturn` on each ModuleScript, and builds a `CorpusIndex` keyed by Roblox instance path.
- `call-sites.ts` walks each parsed script to find `<require-bound-local>.<member>(args)` patterns, then promotes properties to methods when observed callable across scripts.
- `dts-emit.ts` renders the structured `ModuleIndexEntry` to a `.d.ts` file.
- Per-script `compile()` calls receive `moduleReturnTypes`, `moduleRecordMapFields`, and `moduleExportedMembers` from the index so `require(X)` emit can replace the `_LuauChild` fallback with the cached return type.

### Key Patterns

**`CompileContext`** (`src/compile/context.ts`) carries per-script state: scopes, oracle handle, flow facts, shape inferences, cross-script index handles. Reset per `compile()` call.

**Oracle** (`src/compile/oracle/index.ts`) is the single source of truth for the `@rbxts/types` API surface. Read-only singleton with `oracle.propertyType(className, name)`, `oracle.methodReturnType(...)`, `oracle.isA(child, parent)`.

**Two emit modes** drive the rest of the compiler:
- `rbxts` (default in the CLI) emits TS that targets `roblox-ts`: `new Vector3(...)`, `import { Workspace } from "@rbxts/services"`, 0-indexed arrays, `defined` instead of `unknown` for narrowed slots.
- `native` (default in the library) emits TS that imports stdlib helpers from `luau2ts/runtime`, uses 1-indexed arrays, and calls Roblox's native API surface (`Vector3.new(...)`, `game:GetService(...)`).

The compiler keeps both paths live in the same source. Most divergences sit behind `if (ctx.compatMode === 'rbxts')` guards.

**Anti-landmines** the codebase enforces:
- Synthesized types never contain bare `unknown` as a field type. Fallback is `defined`, never `unknown`.
- Don't narrow callback params used in `.Connect(handler)` positions. That breaks contravariance against `RBXScriptSignal` slots.
- Textual substitution of `unknown` for any other token is forbidden. Caught and reverted across multiple prior sessions.
- Wrong types are worse than `defined`. When inference can't prove a shape, fall back. Never guess.

### `.d.ts` Generation
Directory and Rojo-project modes emit `.d.ts` declaration files into a sidecar `out/.types/` tree mirroring the source layout. Synthesis lives in `src/compile/require-infer.ts:analyzeModuleReturn`:
- Method signatures from `function M.foo(...)` declarations, with primitive params inferred via `inferParamPrimitives`.
- Property initializer types: primitives, datatype ctors (`Color3.fromRGB(...)`, `Vector3.new(...)`, etc), list-style array-of-records, dict-of-records.
- Signal detection: `M.X = Instance.new("BindableEvent").Event` becomes `X: RBXScriptSignal`.
- Function aliases: `M.X = M.Y` inherits `Y`'s signature.
- `recordMap` patterns: `M.Profiles = {}` followed by `M.Profiles[k] = v` becomes `Profiles: Record<string, defined | undefined>`.

See [docs/guides/dts-generation.md](https://luau2ts.com/docs/guides/dts-generation) for the full surface.

## Development Workflow

### Branches
- `main` is production. Releases tag from here.
- Feature branches PR against `main`.
- No `dev` branch.

### Release
Releases run via `.github/workflows/release.yml`, triggered manually with a version input:
```bash
gh workflow run release.yml -f version=0.3.0
```
The workflow handles `npm version`, `pnpm publish`, push, tag, and GitHub release creation in one shot. `NPM_TOKEN` must be set as a repo secret. Do not pre-bump `package.json` locally; the workflow's `npm version` does the bump.

### Configuration
No runtime config. CLI flags only. The library's `CompileOptions` is documented at [luau2ts.com/docs/api/compile-options](https://luau2ts.com/docs/api/compile-options).

### Code Conventions
- **TypeScript 5.5+** with strict mode and `exactOptionalPropertyTypes: true`.
- **No `any` in compiler internals.** Use `unknown` and narrow, or use the typed AST shapes from `src/parser/types.ts`.
- **Prettier** for `.ts` formatting. Output emit also runs through Prettier when `pretty: true` (default).
- **No comments that explain WHAT the code does.** Comments explain WHY: a hidden constraint, a workaround for a specific bug, a non-obvious invariant.
- **Defer to existing patterns** before adding new abstractions. Three similar lines is better than a premature helper.

### Naming Conventions
- Pre-pass modules: `<pass>-infer.ts` or `<pass>.ts` (e.g., `flow.ts`, `param-backprop.ts`, `loop-var-infer.ts`).
- Compiler entry points: `compile<Thing>` (e.g., `compileExpr`, `compileLocal`, `compileCall`).
- Helpers describing TS-side state: `ts<Thing>Local` (`tsTypedClassLocal`, `tsShapeTypedLocal`, `tsLuauChildLocal`).
- Oracle queries: `oracle.<verb><Noun>` (`isA`, `isClass`, `propertyType`, `methodReturnType`, `childNameClass`).

### Testing
- **vitest** with golden-file assertions on emit output.
- Tests live in `src/compile.test.ts` plus smaller per-feature files.
- Goal: every behavior change has a corresponding test added or updated. Avoid hand-modifying golden assertions to make tests pass when the behavior change is wrong. About 80% of the time the test was right and the change is the bug.

## Common Gotchas

- **Compile is async.** `compile()` returns a Promise because the WASM parser load is async on first call.
- **Two test corpora.** `pnpm test` (vitest, ~295 hand-curated tests) is the regression gate. The stress harness against the rbxl corpus measures real-world breadth. A change that breaks 0/295 unit tests but spikes the stress corpus's TS-error count is still a regression.
- **rbxtsc baseline.** The dumped corpus's `pnpm exec rbxtsc` exit count in `test2/` is the integration metric. Baseline is currently 0 errors (was 2, fixed in the v0.3.0 cycle). Any compiler change that increases this is a regression.
- **`as unknown` cast count** is the secondary metric. Lower is better. Track via `grep -ro "as unknown" --include="*.ts" | wc -l` on the dumped corpus.
- **Don't pre-bump `package.json`.** The release workflow does its own `npm version` bump. Local `package.json` lags behind npm latest between releases. This is normal.
- **rbxts mode is opinionated about typings.** `defined`, `RBXScriptSignal`, `Instance`, `Player`, etc come from `@rbxts/types`. The compiler's emit assumes these exist in the consumer's `typeRoots`. Library consumers in non-roblox-ts projects need `skipLibCheck: true` to avoid drilling into `@rbxts/types`'s internals.
- **The `cross-script` pass is corpus-aware.** `compile()` for a single file does not benefit from cross-module type recovery. Use the CLI's directory or Rojo modes, or pre-populate `options.moduleReturnTypes` / `moduleExportedMembers` from your own pre-pass.
- **Coroutines don't roundtrip.** Luau cooperative-yielding patterns survive when targeting `roblox-ts` (which translates `task.wait` etc. via its own runtime), but preemptive yielding has no JS equivalent.

## Adding a New Feature

### New compile-time pass
1. Create `src/compile/<name>-infer.ts` with a pure function over the parsed AST that returns a map / set of facts.
2. Wire it into `compile()` in `src/compile/index.ts` between the existing pre-passes. Order matters: flow, then param-infer, then instance-narrow, then loop-var-infer, etc.
3. Add the facts to `CompileContext` in `src/compile/context.ts` if downstream passes need to consume them.
4. Add a test in `src/compile.test.ts` exercising the pass's specific behavior.
5. Run the stress harness to confirm no regression in the corpus.

### New macro
1. Add a file under `src/compile/macros/` named after the namespace (`<namespace>.ts`) or extend an existing one.
2. Register it in `src/compile/macros/index.ts` if a new namespace.
3. Macros expose a `compileFoo(callExpr, ctx): ts.Expression | null` function returning the rewrite or `null` to fall through.
4. The macro receives the compile context, can consult the oracle, and emits via `typescript`'s factory API.
5. Add tests and run the stress harness.

### New `.d.ts` synthesis rule
1. Extend `src/compile/require-infer.ts:analyzeModuleReturn` or `staticTypeOfModuleInit` with the new pattern.
2. Anti-landmine: never emit bare `unknown` as a field type. Fall back to `defined` when the pattern doesn't match.
3. Add a test in `src/compile.test.ts` that round-trips a Luau snippet and asserts the emitted `.d.ts` shape.
4. Update `docs/guides/dts-generation.md` in `../luau2ts.com/` if the new pattern affects the user-visible surface.

## File Organization

Important files for landing changes:
- `src/compile/index.ts` is the compile entry plus the bulk of codegen.
- `src/compile/context.ts` is the per-compile state container.
- `src/compile/oracle/index.ts` is the `@rbxts/types` API surface lookup.
- `src/compile/oracle/data.generated.ts` is generated. Do not hand-edit.
- `src/compile/macros/` holds per-namespace API rewrites.
- `src/compile/cross-script/` holds the corpus-aware index and `.d.ts` emission.
- `src/compile.test.ts` holds the vitest golden-file tests.
- `src/cli/modes.ts` holds CLI dispatch.
- `scripts/build-oracle.mjs` regenerates `oracle/data.generated.ts`.
- `scripts/stress-rbxl.mjs` is the stress harness against an rbxl place file.
- `notes/` holds session notes from prior compiler work; useful for archaeology.
- `CHANGELOG.md` has per-version entries. The release workflow extracts the matching section into the GitHub release body.

When making a change, expect to touch a pass file (`src/compile/<name>-infer.ts`), a small slice of `src/compile/index.ts` to wire the pass in, a test, and sometimes a docs page in the sibling `luau2ts.com/` repo.
