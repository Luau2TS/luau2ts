---
sidebar_position: 2
title: Datatype mapping
---

# Datatype mapping

How Roblox datatypes are translated. See also [Macros](../api/macros) for the full table.

## Constructors

| Luau | `rbxts` mode | `native` mode |
|---|---|---|
| `Vector3.new(1, 2, 3)` | `new Vector3(1, 2, 3)` | `Vector3.new(1, 2, 3)` |
| `Vector2.new(x, y)` | `new Vector2(x, y)` | `Vector2.new(x, y)` |
| `CFrame.new(pos)` | `new CFrame(pos)` | `CFrame.new(pos)` |
| `CFrame.Angles(rx, ry, rz)` | `CFrame.Angles(rx, ry, rz)` | `CFrame.Angles(rx, ry, rz)` |
| `Color3.new(r, g, b)` | `new Color3(r, g, b)` | `Color3.new(r, g, b)` |
| `Color3.fromRGB(r, g, b)` | `Color3.fromRGB(r, g, b)` | `Color3.fromRGB(r, g, b)` |
| `UDim2.new(sx, ox, sy, oy)` | `new UDim2(sx, ox, sy, oy)` | `UDim2.new(sx, ox, sy, oy)` |
| `Region3.new(min, max)` | `new Region3(min, max)` | `Region3.new(min, max)` |

## Arithmetic fast-path

When the compiler can statically narrow both operands to the same datatype, it lowers arithmetic operators to method calls:

```lua
-- Luau
local sum = vecA + vecB
local scaled = vecA * 0.5
```

```ts
// TypeScript (both modes)
const sum = vecA.add(vecB);
const scaled = vecA.mul(0.5);
```

The fast-path covers `Vector3`, `Vector2`, `Vector3int16`, `Vector2int16`, and `CFrame`.

When operand types are unknown, the compiler falls back to a runtime helper (`luaAdd`, `luaSub`, ...) that dispatches by `typeof`.

## Imports (rbxts mode only)

`Instance.new("Part")` triggers `import { Part } from '@rbxts/types'`. The compiler tracks every datatype name used and emits a single deduplicated import line per source file.
