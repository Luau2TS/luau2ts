---
sidebar_position: 1
slug: /
title: Introduction
---

# luau2ts

**A Luau-to-TypeScript compiler for Roblox.**

[`roblox-ts`](https://roblox-ts.com) compiles TypeScript to Luau. `luau2ts` compiles the other direction: it takes Luau (or Lua) source code and emits idiomatic, readable TypeScript.

## Why?

There are three real use cases:

1. **Migrate an existing Luau codebase to TypeScript.** You have a place with hand-written `.luau` scripts, and you want type safety, IDE refactoring, and the broader TS toolchain. Run `luau2ts` once on the whole project, hand-tune the output, ship in TS from then on.

2. **Round-trip with `roblox-ts`.** A single Luau source can compile through `luau2ts` to TS, and back through `roblox-ts` to Luau. The two compilers are intentionally compatible at the TS layer.

3. **Run authored Luau through TS-native tooling.** Type-check, lint, test, and debug Luau game logic using the same TypeScript tooling you use for everything else.

## What you get

- A small CLI (`luau2ts`) that compiles a single file, a directory tree, or a Rojo project.
- A library API (`import { compile } from 'luau2ts'`) for embedding the compiler in build pipelines.
- A `--mode rbxts` emit that drops straight into a roblox-ts project.
- A `--mode native` emit that imports stdlib helpers from `luau2ts/runtime`.
- 100% Luau conformance against the upstream test suite.
- Source maps that point each emitted TS statement back to the original `.luau` line.

## Next

- [Quick start](./quick-start) — install and compile your first file.
- [Setup guide](./setup-guide) — longer walkthrough including Rojo project mode.
- [CLI usage](./usage) — full flag reference.
