# Contributing to luau2ts

Thanks for your interest in contributing!

## Getting set up

```bash
git clone https://github.com/luau2ts/luau2ts
cd luau2ts
pnpm install
pnpm build
pnpm test
```

You need Node 18+ and pnpm 10+.

## Running the CLI locally

```bash
node dist/cli/bin.js path/to/file.luau
```

Or `pnpm link --global` to register the `luau2ts` binary system-wide against your in-tree build.

## Tests

```bash
pnpm test            # one-shot
pnpm test:watch      # re-run on change
```

When you change the compiler's emit, run the suite and update any drifted assertions. Don't `it.skip` failing tests; update them to reflect intentional new behaviour.

## Rebuilding the Luau WASM parser

`src/parser/wasm/luau-parser.wasm` is built from [luau-lang/luau](https://github.com/luau-lang/luau) via Emscripten. Build script: `scripts/build-wasm.sh`. Only rerun when bumping the parser.
