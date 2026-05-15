---
sidebar_position: 1
title: CompileOptions
---

# `CompileOptions`

Second argument to `compile(source, options?)`.

```ts
interface CompileOptions {
  sourceFile?: string;
  sourceMap?: boolean;
  inlineSourceMap?: boolean;
  preserveComments?: boolean;
  compatMode?: 'native' | 'rbxts';
}
```

## Fields

### `sourceFile`
Used in the source map's `sources` field. Defaults to `'input.luau'`. Set this to the on-disk path so debuggers can resolve it.

### `sourceMap`
When `true`, the returned `CompileResult` includes a `sourceMap` property mapping each emitted TS statement back to the original `.luau` line/column.

### `inlineSourceMap`
When `true`, the source map is appended to the output as a base64 `data:` URL comment. Useful for stdout pipelines that can't ship a separate `.ts.map` file.

### `preserveComments`
When `true`, `--` line comments and `--[[ ]]` block comments from the source are preserved in the output.

### `compatMode`
Output flavour:

- `'native'` *(default in the library)* — imports stdlib helpers from `luau2ts/runtime`.
- `'rbxts'` *(default in the CLI)* — emits TS compatible with [roblox-ts](https://roblox-ts.com)'s shim packages.

See [Custom emit modes](../guides/custom-emit-modes) for the difference.

## Note on defaults

The CLI defaults `compatMode` to `'rbxts'`. The library `compile()` function defaults to `'native'`. This mismatch is deliberate: most CLI users want roblox-ts compatibility out of the box, while library embedders typically know which target they want.
