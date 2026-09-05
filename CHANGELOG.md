# Changelog

All notable changes to `luau2ts` are documented here. Format adheres loosely to [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org).

## [Unreleased]

### Fixed
- **ModuleScript exports.** `rbxts` mode emitted `export default X`, which roblox-ts lowers to `return { default = X }` — every consumer's `require(M).member` read resolved to `nil` at runtime. Modules now emit `export = X`, which lowers to `return X`. Luau `export type` aliases in such a module lose their `export` keyword, because TypeScript forbids an export assignment beside any other exported element.
- Duplicate record keys (`{ a = 1, a = 2 }`, legal in Lua) no longer emit a duplicate TS property (TS1117); the last write wins, matching Lua.
- Parameters named with a TS reserved word (`new`, `class`) are escaped in class methods.
- A `table.sort` comparator written inline is parenthesized before its cast, fixing a syntax error.
- `vector` is recognized as a Luau stdlib global, so scripts using it no longer emit a `_G` shim.
- `function C.m(self, ...)` is compiled as a method rather than a static, so `self` binds to `this`.
- Tables keyed by an object (`{ [Player]: V }`) emit a string index signature instead of an invalid mapped type.

### Changed
- **Type fidelity in `rbxts` emit.** The compiler now tracks what TypeScript itself sees for a binding, separately from its own inferred type, and skips the `as unknown as T` bridge wherever the emitted declaration already carries the type. Sources of truth added: explicit Luau annotations on locals, parameters and returns; `type` aliases (including field lookups and string indexers through them); the `vector` stdlib; `LuaTuple` destructuring of oracle-typed methods; and `x :: any`, which is now a no-op rather than an `unknown` bridge that erased what TS knew.
- Annotated arrays (`t: {T}`) index 0-based so roblox-ts rebases them back to Lua's 1-based access, instead of routing through a string-keyed `Record`.
- An explicit parameter annotation now beats body-usage primitive inference, which could contradict it.
- Loop variables no longer inherit a same-named outer binding's annotation.
- `export type` aliases of required modules resolve: `Mod.Foo` is inlined as a local `type Mod__Foo` (with the sibling aliases its body needs), and fields read through it are typed. Directory and Rojo modes feed the alias tables through the corpus index.
- Declared annotations propagate: `local c = zeroControls()` inherits the function's declared return type, `local m = s.mut` inherits the field's declared type, and `for _, x in ipairs(list)` over an annotated array types `x` and drops the `any[]` cast.
- Arguments TypeScript already types (annotated bindings, declared fields, function literals, trusted primitives/datatypes) skip the `Parameters<typeof …>` wrap for every callee, so a genuine mismatch surfaces instead of being hidden.
- `x == nil` compares directly (TypeScript never raises no-overlap against `undefined`), which also lets it narrow nilable annotations; other equalities widen only one operand.
- Synthesized shape leaves used only where a number or string can go (`x % 2`, `x + 1`, `math.floor(x)`, `string.upper(x)`) are declared as that primitive instead of `unknown`.

Measured on a 350-script Roblox place: TypeScript errors in the emitted tree fell from 4381 to 1031, `as unknown` casts from 34.8k to 22.9k, `Record<string, unknown>` bridges from 6824 to 4893, and `Parameters<typeof …>` wraps from 6490 to 2110. Three scripts that previously emitted unparseable TypeScript now compile.

Known limit: roblox-ts rejects any use of an `any`-typed value ("Using values of type `any` is not supported"), so a Luau value with no type information in the source can only be represented as `unknown` and bridged at each typed use. The remaining casts sit almost entirely on such values.

## [0.1.0]

First public release.

### Added
- `compile(source, options?)` library API. Parses Luau via a WASM-built parser and emits readable, idiomatic TypeScript.
- Two emit modes: `rbxts` (default in the CLI; targets the `@rbxts/*` ecosystem) and `native` (default in the library; imports stdlib helpers from `luau2ts/runtime`).
- Prettier-formatted output by default (2-space, single-quote, trailing-commas, 100-column). Disable with `pretty: false`.
- Source-map (v3) emission. Use `sourceMap: true` for an external `.map`, `inlineSourceMap: true` for a base64 inline.
- Optional preservation of the source's leading comment block via `preserveComments: true`.
- `luau2ts` CLI. Modes: single-file, directory tree, Rojo project (`-p default.project.json`). Flags: `--mode`, `--sourcemap`, `-o`, `-h`, `-v`.
- `luau2ts/runtime` subpath export: stdlib helpers (`luaIndex`, `lualen`, `pairKeys`, `multiret`, etc.) used by the `native` emit mode.
- `luau2ts/rojo` subpath export: read-only Rojo project walker (`loadProject`, `classifyFile`).
- Roblox API + Roact macros baked in: `Vector3.new`, `CFrame.Angles`, `Instance.new`, `game:GetService`, `Roact.createElement`, `pcall`, `pairs` / `ipairs`, `setmetatable`, plus the per-datatype arithmetic fast-path.
- 100% Luau conformance (53 / 53 upstream tests pass). 256 unit tests across the compiler, parser, runtime helpers, and CLI.

[Unreleased]: https://github.com/luau2ts/luau2ts/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/luau2ts/luau2ts/releases/tag/v0.1.0
