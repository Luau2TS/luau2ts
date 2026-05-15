---
sidebar_position: 2
title: CompileResult
---

# `CompileResult`

Return value of `compile(source, options?)`.

```ts
interface CompileResult {
  source: string;
  helpers: string[];
  errors: ParseError[];
  sourceMap?: SourceMap;
}
```

## Fields

### `source`
Full TypeScript source of the compiled output, including the leading `// Compiled by luau2ts vX.Y.Z` header and any runtime-helper import statements.

### `helpers`
Names of stdlib helpers the output imports from `luau2ts/runtime`. Useful for tree-shaking analyses or for verifying which runtime functions are needed.

Example:

```ts
const r = await compile('local x = #t');
console.log(r.helpers);
// ['lualen']
```

### `errors`
Parser errors discovered during compilation. The compiler still returns the compiled output even when errors are present, so partial input still produces partial output. Each error has `line`, `col`, and `message` fields.

If `errors.length > 0`, you should consider the output unsafe to ship.

### `sourceMap`
Present only when `sourceMap: true` was passed in `CompileOptions`. Standard source-map-v3 JSON shape — feed it directly to any source-map-aware tooling.
