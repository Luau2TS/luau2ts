---
sidebar_position: 5
title: Using with roblox-ts
---

# Using with `roblox-ts`

The `rbxts` emit mode (default) is designed so that `luau2ts` output drops straight into a [roblox-ts](https://roblox-ts.com) project.

## Project layout

After running:

```bash
luau2ts -p default.project.json -o src/
```

You can build the result with `rbxtsc`:

```bash
npx rbxtsc
```

`rbxtsc` reads the same `default.project.json` to figure out where to emit Luau, and the `.server.ts` / `.client.ts` suffixes preserve the script-kind information.

## Required dependencies

Add these to `package.json` (most are zero-cost type-only packages):

```json
{
  "devDependencies": {
    "@rbxts/types": "^1.0.0",
    "@rbxts/services": "^1.0.0",
    "@rbxts/promise": "^1.0.0",
    "@rbxts/roact": "^1.0.0",
    "roblox-ts": "^3.0.0"
  }
}
```

You only need the `@rbxts/*` packages you actually import. The compiler tracks which ones it emits imports from and you can prune accordingly.

## tsconfig

A minimal `tsconfig.json` for the output:

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "commonjs",
    "moduleResolution": "node",
    "typeRoots": ["node_modules/@rbxts"],
    "strict": false,
    "jsx": "react",
    "jsxFactory": "Roact.createElement"
  },
  "include": ["src/**/*.ts"]
}
```

Tighten `"strict": true` once the migration has settled.

## Limitations

- Metatable-OOP patterns translate to TS classes, but esoteric metamethod uses (`__newindex`, custom `__index` chains) may need hand-tuning.
- `_G` access becomes `_G["key"]` indexing. If you use `_G` heavily, consider declaring a typed global wrapper.
- Coroutine code translates to JS generators / Promises depending on context. Cooperative-yielding patterns survive; preemptive-yielding doesn't (because JS has no equivalent).
