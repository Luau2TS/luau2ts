# Contributing to luau2ts

## Setup

```bash
git clone https://github.com/luau2ts/luau2ts
cd luau2ts
pnpm install
pnpm build
pnpm test
```

You need Node 18+ and pnpm 10+.

## Running the CLI locally

After `pnpm build`:

```bash
node dist/cli/bin.js path/to/file.luau
```

For local testing without a global install, `pnpm link --global` will register the in-tree `luau2ts` binary.

## Tests

All tests live next to the source they cover (`src/**/*.test.ts`) and run via vitest:

```bash
pnpm test            # one-shot
pnpm test:watch      # re-run on change
pnpm test --coverage # with coverage (uploaded to Codecov by CI)
```

When you change the compiler's emit, run the test suite and update any assertion that drifts. Don't `it.skip` failing tests; update them to reflect intentional new behaviour.

## Rebuilding the Luau WASM parser

`src/parser/wasm/luau-parser.wasm` is built from the official [luau-lang/luau](https://github.com/luau-lang/luau) parser via Emscripten. The build script lives at `scripts/build-wasm.sh`. You only need to rerun this when bumping the Luau parser version.

## Releasing

1. Open a PR; label it `fix`, `feature`, `breaking`, or `docs`.
2. Release-drafter auto-collects merged PR titles into a draft GitHub release.
3. When ready, publish the draft release with a tag like `v0.2.0`.
4. The `release.yml` workflow runs on the tag push, builds, tests, and publishes to npm with provenance.

npm publishing uses [OIDC trusted publishing](https://docs.npmjs.com/trusted-publishers); there is no long-lived `NPM_TOKEN`. Before the first release, configure trusted publishing in the package's settings on npmjs.com.

## Labels

Used by release-drafter and Dependabot:
- `feature`, `fix`, `breaking`, `docs`, `chore`, `dependencies`
- `skip-changelog` to exclude a PR from release notes
