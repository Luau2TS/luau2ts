---
sidebar_position: 8
title: Source maps and debugging
---

# Source maps and debugging

Emit a source map so you can debug the original `.luau` source from the compiled `.ts`.

## Generate

```bash
luau2ts foo.luau -o foo.ts --sourcemap
```

Produces `foo.ts` and `foo.ts.map`. A `//# sourceMappingURL=foo.ts.map` comment is appended to the `.ts`.

For directory or Rojo project mode:

```bash
luau2ts -p default.project.json -o out/ --sourcemap
```

Every `.ts` gets a paired `.ts.map`.

## Library API

```ts
import { compile } from 'luau2ts';

const result = await compile(source, {
  sourceFile: 'src/foo.luau',
  sourceMap: true,
});

console.log(result.source);     // includes //# sourceMappingURL comment if inlineSourceMap is true
console.log(result.sourceMap);  // standard source-map-v3 JSON
```

Set `sourceFile` to the on-disk path so debuggers can resolve it.

## What's mapped

Each emitted TS statement maps back to the `(line, column)` of its corresponding Luau statement. Expressions inside a statement share their parent statement's mapping (sub-statement granularity is on the roadmap).

The header comment (`// Compiled by luau2ts ...`) is unmapped.

## Inline source maps

For pipelines that can't easily ship a separate `.map` file (e.g. stdout to a downstream tool that doesn't read maps), use `inlineSourceMap: true` in the library API. The map is base64-encoded into the trailing comment.

The CLI doesn't expose `--inline-sourcemap` yet; use the library if you need it.

## Limitations

- `--sourcemap` with stdout output is a no-op (warning printed). Use `-o`.
- Source maps target the *compiled* TypeScript. When that TS is further compiled (e.g. by `roblox-ts` or `tsc`), the resulting Luau / JS won't have a map back to the original Luau unless you concatenate the maps yourself.
