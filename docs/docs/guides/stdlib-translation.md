---
sidebar_position: 7
title: Standard library translation
---

# Standard library translation

How Lua / Luau stdlib functions translate to TypeScript.

## Error handling

```lua
local ok, err = pcall(function() risky() end)
if not ok then warn(err) end
```

```ts
const [ok, err] = pcall(() => { risky(); });
if (!ok) warn(err);
```

`pcall`, `xpcall`, and `error` are runtime helpers in `native` mode and pass through to the rbxts shims in `rbxts` mode.

## Iteration

```lua
for k, v in pairs(t) do  ... end
for i, v in ipairs(arr) do  ... end
```

```ts
for (let k of pairKeys(t)) { const v = pairValue(t, k); ... }
for (let __i = 0; __i < arr.length; __i++) { const i = __i + 1; const v = arr[__i]; ... }
```

`ipairs` is fully inlined (no helper call). `pairs` uses the `pairKeys` / `pairValue` helpers so Instance-keyed tables work correctly with a host runtime.

## Tables

| Luau | TypeScript |
|---|---|
| `table.insert(t, v)` | `table.insert(t, v)` (helper) |
| `table.remove(t, i)` | `table.remove(t, i)` (helper) |
| `table.concat(t, sep)` | `table.concat(t, sep)` (helper) |
| `#t` | `lualen(t)` |
| `t[k]` (numeric k) | `t[k - 1]` (inlined) or `luaIndex(t, k)` (variable) |

## Strings

| Luau | TypeScript |
|---|---|
| `string.format("%d", n)` | `string.format("%d", n)` (helper) |
| `string.gsub(s, pat, rep)` | `string.gsub(s, pat, rep)` (helper) |
| `string.sub(s, i, j)` | `string.sub(s, i, j)` (helper) |
| `s1 .. s2` | `concat(s1, s2)` (helper) — handles Luau's coercion rules |

## Metatables

```lua
setmetatable(t, { __index = base })
```

```ts
setmetatable(t, { __index: base });
```

`setmetatable` and `getmetatable` are helpers. The metatable is stored on a hidden symbol, not as an enumerable own property.

## Coroutines

`coroutine.create`, `coroutine.resume`, `coroutine.yield`, `coroutine.wrap` map to runtime helpers backed by generators. Note: only cooperative-yielding patterns survive; preemptive yielding doesn't work in JS.

`task.wait`, `task.spawn`, `task.delay`, `task.defer` come from the rbxts `task` service shim. Pair them with `async` / `await`.
