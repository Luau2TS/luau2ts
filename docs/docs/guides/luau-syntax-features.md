---
sidebar_position: 10
title: Luau syntax features
---

# Luau syntax features

Luau extends Lua with type annotations, generalized iteration, string interpolation, and several smaller features. `luau2ts` handles each one.

## Type annotations

```lua
local x: number = 1
local function f(a: string, b: number): boolean
  return #a > b
end
```

```ts
const x: number = 1;
function f(a: string, b: number): boolean {
    return lualen(a) > b;
}
```

Compound types (`{[string]: number}`, `(string, number) -> boolean`, `T?`) translate to their TypeScript equivalents.

## Type aliases

```lua
type Vec3 = { x: number, y: number, z: number }
type Result<T> = { ok: true, value: T } | { ok: false, error: string }
```

```ts
type Vec3 = { x: number; y: number; z: number };
type Result<T> = { ok: true; value: T } | { ok: false; error: string };
```

Generic type parameters, intersection types (`&`), and union types (`|`) all work.

## Type assertions

```lua
local x = (something :: number)
```

```ts
const x = (something as number);
```

## `--!strict` / `--!nonstrict`

These directives at the top of a Luau file are dropped from the output — they're Luau-side type-checker hints with no TypeScript equivalent. The TS-side `strict` setting in `tsconfig.json` is what controls strict typing post-compilation.

## String interpolation

```lua
local greeting = `Hello, {name}!`
```

```ts
const greeting = `Hello, ${name}!`;
```

Luau backticks become JS template literals. `{expr}` substitutions become `${expr}`.

## Generalized iteration

```lua
for k, v in t do end
```

When `t` is statically typable as an array, lowers to a fast indexed loop. Otherwise it goes through `genericIter(t)` which lifts the value into the standard iter / state / control triple.

## Continue

```lua
for i = 1, 10 do
  if i % 2 == 0 then continue end
  print(i)
end
```

```ts
for (let i = 1; i <= 10; i++) {
    if (i % 2 === 0) continue;
    print(i);
}
```

## Compound assignment

```lua
counter += 1
buffer ..= "more"
```

```ts
counter += 1;
buffer = concat(buffer, "more");
```

The `..=` form expands because TypeScript doesn't have a string-concat compound operator.

## What's not supported

- `goto` / `::label::` — Luau has no goto, but some hand-written Lua 5.1 code might. Not yet supported.
- Lua-style escape characters that Luau itself rejects (`\G`, `\K` etc. in old Roblox scripts) — the parser normalises these to bare characters during a pre-pass, so they compile without error.
