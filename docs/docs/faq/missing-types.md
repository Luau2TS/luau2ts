---
sidebar_position: 2
title: Handling untyped Luau
---

# Handling untyped Luau

If your `.luau` source has no type annotations (no `--!strict`, no `local x: number`), the compiler still emits valid TypeScript — but the output is full of `any` and may not type-check under a strict `tsconfig`.

## What gets `any`

- Top-level globals (`local x = _G.something`) are typed as `any`.
- Anonymous tables (`{ foo = 1 }`) are typed as inline object literals — usually fine.
- Untyped function parameters become `any`.

## Options

1. **Annotate the Luau source.** The compiler picks up `--!strict` and individual `local x: number` annotations and propagates them through.

2. **Loosen the output `tsconfig`.** Set `"noImplicitAny": false` and `"strict": false` on the emitted code. This is the right call for a one-time migration: get the project compiling, then incrementally re-tighten the settings as you add annotations.

3. **Hand-edit after compile.** The output is normal TypeScript — `git add` it and edit. Source maps make this safe.

## Recommendation

For a real migration: start with `--mode rbxts` and a loose tsconfig, get the project building, then tighten settings file by file. Don't try to land a strict tsconfig in the same PR as the initial compile.
