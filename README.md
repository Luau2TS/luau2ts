<div align="center">
  <img src="static/img/logo.png" alt="luau2ts" width="200" />

  # luau2ts

  **A Luau-to-TypeScript compiler for Roblox.**

  [![CI](https://github.com/luau2ts/luau2ts/actions/workflows/test.yml/badge.svg)](https://github.com/luau2ts/luau2ts/actions/workflows/test.yml)
  [![codecov](https://codecov.io/gh/luau2ts/luau2ts/branch/main/graph/badge.svg)](https://codecov.io/gh/luau2ts/luau2ts)
  [![npm](https://img.shields.io/npm/v/luau2ts.svg)](https://www.npmjs.com/package/luau2ts)
  [![downloads](https://img.shields.io/npm/dm/luau2ts.svg)](https://www.npmjs.com/package/luau2ts)
  [![license](https://img.shields.io/npm/l/luau2ts.svg)](./LICENSE)
  [![node](https://img.shields.io/node/v/luau2ts.svg)](https://www.npmjs.com/package/luau2ts)
</div>

## Why?

[`roblox-ts`](https://roblox-ts.com) compiles TypeScript to Luau so Roblox developers can write strongly-typed game code in TS.

`luau2ts` is the mirror: it compiles **Luau to TypeScript**. Use it to migrate an existing Luau codebase to TypeScript, to keep two parallel runtimes in sync, or to run authored Luau through TS-native tooling. Output is idiomatic, readable TS, with optional 1:1 line-mapped source maps and a roblox-ts-compatible emit mode.

Directory and Rojo-project modes also emit `.d.ts` declaration files alongside each compiled `.ts`, capturing the inferred shape of each module's exports.

## Install

```bash
npm install -g luau2ts
```

Or as a project dependency:

```bash
npm install --save-dev luau2ts
```

## Quick start

Compile a single file:

```bash
luau2ts foo.luau                 # → stdout
luau2ts foo.luau -o foo.ts       # → foo.ts
```

Compile every `.luau` and `.lua` file in a directory tree:

```bash
luau2ts src/ -o out/
```

Walk a Rojo project file and emit a parallel TypeScript tree:

```bash
luau2ts -p default.project.json -o out/
```

Use it as a library:

```ts
import { compile } from 'luau2ts';

const result = await compile(`
  local function greet(name)
    print("Hello, " .. name)
  end
`);

console.log(result.source);
// // Compiled by luau2ts v0.1.0 (do not edit).
// function greet(name) {
//   print(`Hello, ${name}`);
// }
```

## Compatibility

`luau2ts` ships two emit modes. Switch with `--mode <name>` or `compatMode` in the library API.

| Mode | What it emits | Pairs with |
|---|---|---|
| `rbxts` (default) | TS that mirrors what [roblox-ts](https://roblox-ts.com) accepts as input: `new Vector3(...)`, `import { Workspace } from '@rbxts/services'`, 0-indexed arrays for statically-typed arrays. | [`@rbxts/types`](https://www.npmjs.com/package/@rbxts/types), [`@rbxts/services`](https://www.npmjs.com/package/@rbxts/services), [`@rbxts/promise`](https://www.npmjs.com/package/@rbxts/promise), the `roblox-ts` build pipeline. |
| `native` | TS that imports stdlib helpers from `luau2ts/runtime` (`luaIndex`, `lualen`, `pairKeys`, `multiret`, ...) and uses Roblox's native API surface (`Vector3.new(...)`, `game:GetService(...)`, 1-indexed arrays). | A host runtime that mirrors Roblox's Luau API surface. |


## Docs

Full guide and API reference at **[luau2ts.com](https://luau2ts.com)**.

Highlights:
- [Quick start](https://luau2ts.com/docs/quick-start)
- [Setup guide](https://luau2ts.com/docs/setup-guide)
- [CLI usage](https://luau2ts.com/docs/usage)
- [Rojo project conversion](https://luau2ts.com/docs/guides/rojo-project-conversion)
- [Using with roblox-ts](https://luau2ts.com/docs/guides/using-with-roblox-ts)

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for build / test / release workflow.

## License

[MIT](./LICENSE) © Tony Bolivar
