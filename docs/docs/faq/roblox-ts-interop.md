---
sidebar_position: 4
title: Running alongside roblox-ts
---

# Running alongside `roblox-ts`

The short answer: yes, they coexist, and `luau2ts` is designed for it.

## Pipeline direction

```
   Luau  ───── luau2ts ─────→  TypeScript
                                    │
                                    │  roblox-ts
                                    ▼
                                  Luau
```

The round-trip is lossy in the sense that comments, exact formatting, and some Luau-specific source patterns don't survive. But the *semantics* match: `luau2ts` and `roblox-ts` agree on `Vector3`, `Instance.new`, `pcall`, iteration, multi-return, and so on.

## Common setups

**Setup A: Migrate gradually.** Run `luau2ts` once on the whole project. Commit the generated TypeScript. From then on, edit only the TS, and build with `roblox-ts` (`rbxtsc`). The `.luau` files become reference-only.

**Setup B: Maintain both.** Keep authoring in Luau for one team and TypeScript for another. Generate TS from Luau on a CI step, expose the result as a `@your-org/types-from-luau` package.

**Setup C: Compile-time fork.** Use `luau2ts --mode native` to emit TS that runs against `luau2ts/runtime` directly, decoupling from the roblox-ts ecosystem entirely. Useful for non-Roblox targets that mimic the Luau API.

## roblox-ts-specific notes

`luau2ts --mode rbxts` (the default) emits imports from `@rbxts/types`, `@rbxts/services`, `@rbxts/promise`, and `@rbxts/roact`. Make sure these packages are listed in your project's `package.json` so `roblox-ts` picks them up.
