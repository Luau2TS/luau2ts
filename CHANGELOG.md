# Changelog

All notable changes to `luau2ts` are documented here. Format adheres loosely to [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org).

## [Unreleased]

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
