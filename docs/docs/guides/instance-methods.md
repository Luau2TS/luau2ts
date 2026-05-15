---
sidebar_position: 3
title: Instance methods
---

# Instance methods

How instance access, services, and method calls translate.

## `game:GetService`

```lua
local Workspace = game:GetService("Workspace")
local Players = game:GetService("Players")
```

In `rbxts` mode:

```ts
import { Workspace, Players } from '@rbxts/services';
```

The macro replaces the call with the imported identifier and adds the corresponding import to the file.

## `Instance.new`

```lua
local part = Instance.new("Part", workspace)
```

In `rbxts` mode:

```ts
import { Part } from '@rbxts/types';

const part = new Part(workspace);
```

## Method calls

Luau distinguishes `:` (method, implicit `self`) from `.` (regular call). TypeScript doesn't, so both compile to the same dot-call form:

```lua
inst:FindFirstChild("X")  -- method
inst.FindFirstChild("X")   -- regular access, no self
```

```ts
inst.FindFirstChild("X");
```

The compiler resolves the difference by looking up `FindFirstChild` in the Roblox API metadata: methods get the receiver passed implicitly by the runtime; regular access stays as-is.

## Property access

`inst.Name`, `inst.Parent`, `inst.CFrame` — these compile to identical TS property access. No translation needed.

## `WaitForChild`

```lua
local part = workspace:WaitForChild("MyPart")
```

```ts
const part = await workspace.WaitForChild("MyPart");
```

The compiler infers that `WaitForChild` yields and inserts `await`. Calls to user-defined functions that transitively yield also get `await` — the compiler runs a pre-pass over the AST to find them.
