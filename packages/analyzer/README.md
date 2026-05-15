# `@luau2ts/analyzer`

Luau's official type checker (`Luau.Analysis`) compiled to WebAssembly. Optional companion to [`luau2ts`](https://www.npmjs.com/package/luau2ts) that surfaces input-side type errors before translation.

## Install

```bash
pnpm add -D @luau2ts/analyzer
# or
npm install --save-dev @luau2ts/analyzer
```

`luau2ts` lists this as an `optionalDependency`. Once installed, the compiler's `preEmitCheck` (default-on) starts running.

## Usage

```ts
import { analyze } from '@luau2ts/analyzer';

const diagnostics = await analyze('local x: number = "hi"');
for (const d of diagnostics) {
  console.log(`${d.line}:${d.col} [${d.code}] ${d.message}`);
}
// 1:6 [TypeMismatch] Type 'string' could not be converted into 'number'
```

`Diagnostic` shape:

```ts
interface Diagnostic {
  severity: 'error' | 'warning';
  code: string;        // 'TypeMismatch', 'UnknownSymbol', etc.
  message: string;
  line: number;        // 1-indexed
  col: number;
  endLine: number;
  endCol: number;
}
```

Lint warnings (`LocalShadow`, `UnusedFunction`, etc.) come through with `severity: 'warning'`. Real type errors with `severity: 'error'`.

## What's inside

A `~5 MB` WASM artifact built from the official [`luau-lang/luau`](https://github.com/luau-lang/luau) Analysis library, plus a small TypeScript wrapper. The build chain (Emscripten + a few hundred lines of C++ glue) lives in `build/`; the WASM artifact is committed so consumers don't need a toolchain.

## License

[MIT](./LICENSE)
