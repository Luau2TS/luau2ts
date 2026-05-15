---
sidebar_position: 4
title: CLI usage
---

# CLI usage

```
luau2ts <file.luau>                    Compile one file. Writes to stdout.
luau2ts <file.luau> -o <file.ts>       Compile one file. Writes to a file.
luau2ts <dir/> -o <out/>               Compile every .luau/.lua under <dir/>.
                                        Mirrors the input tree into <out/>.
luau2ts -p <default.project.json> -o <out/>
                                        Walk a Rojo project file, compile every
                                        script it references, and emit a
                                        roblox-ts-shaped tree.
```

## Flags

### `-o, --output <path>`
Output target. For single-file input, a file path (or omit for stdout). For directory or Rojo project input, an output directory (required).

### `-p, --project <path>`
Path to a Rojo `*.project.json` file, or a directory containing `default.project.json`. Mutually exclusive with a positional input.

### `--mode <name>`
Emit compatibility mode. One of:

- `rbxts` *(default)* — emits TS that imports from `@rbxts/types`, `@rbxts/services`, etc. Pairs with [roblox-ts](https://roblox-ts.com).
- `native` — emits TS that imports stdlib helpers from `luau2ts/runtime`. Pairs with a host runtime that mirrors Roblox's Luau API surface.

See [Custom emit modes](./guides/custom-emit-modes) for details.

### `--sourcemap`
Emit a `.ts.map` next to each `.ts`. The map points each emitted TS statement back to the line and column of the original `.luau` source.

When the output is `stdout`, `--sourcemap` is a no-op (a warning is printed). To get a source map you must use `-o`.

### `-h, --help`
Show this help text.

### `-v, --version`
Print the installed `luau2ts` version.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success. |
| 1 | Compilation errors (parse errors, IO failures). |
| 2 | Invalid command-line arguments. |

Parse errors are written to stderr in `path:line:col: message` format and the compiled output is still emitted (so you can inspect partial output even on failure).
