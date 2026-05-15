---
sidebar_position: 3
title: Runtime helpers
---

# Runtime helpers (`luau2ts/runtime`)

The `native` emit mode injects imports from `luau2ts/runtime` for stdlib semantics that don't map 1:1 to JavaScript. These helpers are exposed via the package's `./runtime` subpath export so consumers of the compiled output can resolve them at runtime.

```ts
import { lualen, luaIndex, pairKeys } from 'luau2ts/runtime';
```

## What's there

| Helper | Replaces | Notes |
|---|---|---|
| `lualen(v)` | `#v` | Length operator that respects Luau's array semantics. |
| `luaIndex(t, k)` | `t[k]` for unknown-typed `k` | 1-indexed when `k` is numeric, raw when it's a string. |
| `pairKeys(t)` | `pairs(t)` keys | Yields raw keys, with Instance-keyed table support via the global key reifier. |
| `pairValue(t, k)` | `t[k]` after `pairs` | Reifier-aware value lookup. |
| `genericIter(it)` | Generic-for iterator triple | Lifts a callable / table into the standard iter/state/control triple. |
| `multiret(v)` | Multi-return destructuring | Wraps a single-value return into a tuple so `[a, b] = f()` works. |
| `truthy(v)` | Luau boolean truthiness | Treats `0` and `''` as truthy (unlike JS). |
| `concat(a, b)` | `..` operator | String concat with Luau's coercion rules. |
| `tostring(v)`, `tonumber(v)` | Lua stdlib | Round-trippable conversions. |
| `pcall`, `xpcall`, `error` | Lua error handling | Returns `[ok, ...]` tuples. |
| `setmetatable`, `getmetatable` | Metatables | Stored on a hidden symbol. |

The full set is exported from the package's `./runtime` entry point. Run `node -e "console.log(Object.keys(require('luau2ts/runtime')))"` to print the live list.

## Tree-shaking

Each emitted file imports only the helpers it actually needs. The `helpers` field on `CompileResult` lists them.

## Host-runtime hooks

`pairKeys` / `pairValue` consult an optional global key reifier:

```ts
(globalThis as any).__rbxKeyReifier = (rawKey) => { /* ... */ };
```

A host Roblox runtime that supports Instance-keyed tables can install this hook so that iteration over a table keyed by Instances returns the original Instance objects (rather than their stringified names).
