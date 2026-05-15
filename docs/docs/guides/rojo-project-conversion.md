---
sidebar_position: 1
title: Rojo project conversion
---

# Rojo project conversion

Use `-p` to walk a Rojo project file and compile every script it references in one command.

## How it works

`luau2ts -p default.project.json -o out/` does:

1. Reads `default.project.json`.
2. Recursively walks the `tree` property.
3. For each `$path` entry, resolves the directory (or single file) on disk.
4. Inside each directory, classifies files by Rojo's naming convention:
   - `Name.luau` → ModuleScript named `Name`
   - `Name.server.luau` → Script named `Name`
   - `Name.client.luau` → LocalScript named `Name`
   - `init.luau` → the containing folder *itself* is a ModuleScript
   - `init.server.luau` / `init.client.luau` → folder is a Script / LocalScript
5. Compiles every discovered `.luau` / `.lua` and writes the `.ts` counterpart under `out/`, preserving the directory structure relative to the project file.

## File-suffix preservation

The output keeps the Rojo suffix. `Main.server.luau` → `Main.server.ts`. This is the same convention `roblox-ts` uses, so a downstream `roblox-ts` build picks up the script kind correctly.

## Nested children

A node with children but no `$path` becomes a Folder. Children are written under a subdirectory named after the node:

```json
{
  "tree": {
    "$className": "DataModel",
    "ReplicatedStorage": {
      "Modules": { "$path": "src/modules" }
    }
  }
}
```

Emits to `out/Modules/...`.

## What's not supported (yet)

- `.json` / `.csv` / `.txt` "model files" (data-only Instances). These don't produce TypeScript — they're skipped silently. Add them to your TS code as plain JSON imports if you need them.
- `.rbxm` / `.rbxmx` model bundles. Out of scope; these are binary Roblox formats.
- Live file watching (`luau2ts -p ... --watch`). Coming in 0.2.
