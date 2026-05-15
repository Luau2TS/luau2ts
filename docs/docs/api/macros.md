---
sidebar_position: 4
title: Macros
---

# Macros

Macros are call-site rewriters: when the compiler sees a specific Luau call shape, it emits idiomatic TypeScript instead of a generic helper invocation. They are mode-aware (`rbxts` mode emits roblox-ts-style output, `native` mode emits runtime-helper style).

## Roblox datatypes

| Luau | rbxts mode | native mode |
|---|---|---|
| `Vector3.new(1, 2, 3)` | `new Vector3(1, 2, 3)` | `Vector3.new(1, 2, 3)` |
| `CFrame.new(p)` | `new CFrame(p)` | `CFrame.new(p)` |
| `Color3.fromRGB(r, g, b)` | `Color3.fromRGB(r, g, b)` | `Color3.fromRGB(r, g, b)` |
| `Vector3 + Vector3` | `a.add(b)` | `a.add(b)` |
| `Vector3 - Vector3` | `a.sub(b)` | `a.sub(b)` |
| `Vector3 * scalar` | `a.mul(scalar)` | `a.mul(scalar)` |

The arith fast-path covers `Vector3`, `Vector2`, `Vector3int16`, `Vector2int16`, and `CFrame`.

## Instance methods (rbxts mode)

| Luau | TypeScript |
|---|---|
| `Instance.new("Part", parent)` | `new Part(parent)` (with `import { Part } from '@rbxts/types'`) |
| `game:GetService("Workspace")` | `Workspace` (with `import { Workspace } from '@rbxts/services'`) |
| `inst:FindFirstChild("X")` | `inst.FindFirstChild("X")` (method-call lowering) |

## Standard library

| Luau | TypeScript |
|---|---|
| `pcall(f, ...)` | `pcall(f, ...)` (returns `[ok, ...]`) |
| `ipairs(arr)` | Indexed `for (let i = 0; i < arr.length; i++)` loop |
| `pairs(t)` | `for (let k of pairKeys(t))` |
| `setmetatable(t, mt)` | `setmetatable(t, mt)` (metatable helper) |
| `string.format(...)` | `string.format(...)` |
| `table.insert(t, v)` | `table.insert(t, v)` |

## Roact (rbxts mode)

`Roact.createElement(component, props, children)` triggers `import { Roact } from '@rbxts/roact'` and lowers to `Roact.createElement(...)`. JSX is not produced — the call shape is preserved verbatim.

## Adding macros

The macro registry is in `src/compile/macros/`. Each macro registers via `registerMacro(callShape, transform, mode?)` where `mode` is one of `'native'`, `'rbxts'`, or omitted (applies to both).
