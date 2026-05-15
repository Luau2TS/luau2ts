---
sidebar_position: 6
title: Migrating from Luau
---

# Migrating an existing Luau codebase

A pragmatic playbook for moving a real Roblox place from `.luau` to `.ts`.

## Phase 1: One-shot compile

```bash
luau2ts -p default.project.json -o src/ --mode rbxts
```

Commit the result. Don't delete the `.luau` source yet — keep it as reference.

## Phase 2: Get it building

You'll hit TS errors. Common categories and fixes:

- **`any` everywhere.** Set `"strict": false` and `"noImplicitAny": false` in `tsconfig.json`. Tighten later.
- **Missing `@rbxts/*` packages.** Install whatever the imports name.
- **Coroutine code.** Hand-translate to Promises or generators. `task.wait(n)` → `await task.wait(n)` if `task` is the rbxts service shim.
- **Metatable OOP.** The class-shape detector handles most patterns, but unusual ones (multi-inheritance via `__index` chains) need a manual rewrite.

Goal of Phase 2: `rbxtsc` compiles the project successfully, even if every variable is `any`.

## Phase 3: Test in Studio

Build to Luau (`rbxtsc`), sync with Rojo, run the place. Find behavioural regressions:

- Integer-vs-float math differences (Luau has separate int/float, TS has only float).
- Truthy/falsy mismatches (`0` and `""` are truthy in Luau, falsy in TS). The `truthy()` helper handles this when the compiler couldn't prove statically.
- Iteration order. Luau `pairs` over an array-table yields integer keys in order; TS `Object.keys` doesn't. `pairKeys` handles this.

Source maps (compile with `--sourcemap`) let you set breakpoints in the original `.luau`.

## Phase 4: Re-tighten types

File by file, add explicit types and switch back to strict:

1. Pick a small module.
2. Annotate parameters and return types.
3. Replace `any` with the right `@rbxts/types` import.
4. Set `"strict": true` per-file using a `// @ts-strict` directive (or upgrade the whole tsconfig once everything's annotated).

## Phase 5: Retire the source

When the TS version is the source of truth, delete the `.luau` files (or keep them in a `legacy/` directory for archaeology). Switch CI to build only from TS.

## What not to do

- Don't try to land Phase 1 + Phase 2 + strict typing in one PR. Take it in phases.
- Don't fight the formatter. Run Prettier or Biome on the compiler output and let it own style.
- Don't manually edit the `.luau` and re-compile — the round-trip is lossy. After Phase 1, the TS is the source of truth.
