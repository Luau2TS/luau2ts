---
sidebar_position: 4
title: Lua tuples and multi-return
---

# Lua tuples and multi-return

Luau returns multiple values from a single function (`return a, b, c`). TypeScript represents this as a tuple `[a, b, c]`.

## Returns

```lua
local function divmod(a, b)
  return a // b, a % b
end
```

```ts
function divmod(a, b) {
    return [a / b | 0, a % b];
}
```

## Destructuring

```lua
local q, r = divmod(10, 3)
```

```ts
const [q, r] = divmod(10, 3);
```

## `pcall` and friends

`pcall` returns `[ok, ...values]`:

```lua
local ok, result = pcall(risky, x)
```

```ts
const [ok, result] = pcall(risky, x);
```

## Mixed-tuple-and-scalar issues

When the right-hand side has multiple expressions, only the **last** expression's multi-return is unpacked. Everything before it contributes only its first value. This is a Luau rule and the compiler preserves it:

```lua
local a, b, c = 1, pcall(f)
-- a = 1
-- b = ok (boolean)
-- c = first return of f, or error message
```

```ts
const [, _ok, _r] = [1, ...pcall(f)] as [number, boolean, unknown];
const a = 1;
const [b, c] = [_ok, _r];
```

The compiler picks the simplest equivalent. For one-call-RHS, it uses plain destructuring with a `multiret` wrapper:

```lua
local a, b = pairs(t)
```

```ts
import { multiret } from 'luau2ts/runtime';

const [a, b] = multiret(pairs(t));
```

`multiret` is a no-op if the callee already returned a tuple, and lifts a scalar into `[scalar]` otherwise.
