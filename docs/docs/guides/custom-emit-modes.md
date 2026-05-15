---
sidebar_position: 9
title: Custom emit modes
---

# Custom emit modes

`luau2ts` ships two emit modes. The right choice depends on what you'll do with the output.

## `--mode rbxts` (CLI default)

Emits TypeScript that drops into a [roblox-ts](https://roblox-ts.com) project.

- `Instance.new("Part")` → `new Part(parent)`, with `import { Part } from '@rbxts/types'`.
- `game:GetService("Workspace")` → `Workspace`, with `import { Workspace } from '@rbxts/services'`.
- Arrays statically known to be array-typed use 0-indexed access.
- Stdlib calls (`pcall`, `setmetatable`, `string.format`) stay as-is; resolved by the rbxts shim packages.

Use when:
- You're migrating to roblox-ts and will run the output through `rbxtsc`.
- You want type-safe Roblox API access via `@rbxts/types`.

## `--mode native` (library default)

Emits TypeScript that imports stdlib helpers from `luau2ts/runtime`.

- `Instance.new("Part")` → `Instance.new("Part", parent)` (unchanged).
- `game:GetService("Workspace")` → `game.GetService("Workspace")` (unchanged).
- Arrays are 1-indexed; numeric indexing routes through `luaIndex(t, k)`.
- Stdlib functions (`pcall`, `pairs`, `ipairs`, `setmetatable`) become helpers from `luau2ts/runtime`.

Use when:
- You have a custom host runtime that mirrors Roblox's Luau API surface.
- You want decoupling from the rbxts ecosystem (avoid pulling in `@rbxts/types`).
- You're embedding the output in a non-Roblox environment that emulates Luau semantics.

## Choosing in code

```ts
import { compile } from 'luau2ts';

const result = await compile(source, { compatMode: 'rbxts' });
```

## Mixing

You can't mix modes within a single project: the emitted `.ts` files in `rbxts` mode reference `@rbxts/*` packages, while `native` mode files reference `luau2ts/runtime`. Pick one per project and stick with it.

If you're partway through a migration and need both, compile to two separate output directories and pick which one to ship.
