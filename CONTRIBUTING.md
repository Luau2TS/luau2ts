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

### First-time setup (one off)

Before the very first publish, configure a trusted publisher on npm for `luau2ts`. This lets the release workflow upload without a long-lived `NPM_TOKEN`.

1. Log in at https://www.npmjs.com.
2. Open https://www.npmjs.com/settings/`<your-username>`/trusted-publishers (or **Account → Trusted Publishers**).
3. Click **Add publisher** and fill in:
   - Publisher: **GitHub Actions**
   - Organization / user: `luau2ts`
   - Repository: `luau2ts`
   - Workflow filename: `release.yml`
   - Environment name: `npm`
4. Save. The publisher is now bound to `luau2ts/luau2ts` and the `release.yml` workflow can publish without a token.

For coverage badges, register the repo at https://app.codecov.io/gh/luau2ts/luau2ts. Public repos work without a token, but adding `CODECOV_TOKEN` to repo secrets bumps reliability.

### Cutting a release

1. Open PRs against `main` and label each one: `feature`, `fix`, `breaking`, `docs`, or `chore`.
2. Release-drafter (`.github/workflows/release-drafter.yml`) auto-collects the merged titles into a *draft* GitHub release whose tag is computed from the labels (breaking → major, feature → minor, others → patch).
3. Bump `version` in `package.json` and add the new section in `CHANGELOG.md`. Commit and merge.
4. On https://github.com/luau2ts/luau2ts/releases, edit the draft release: confirm the tag, add a one-line summary if needed, and click **Publish release**.
5. Publishing the release creates the tag `vX.Y.Z`, which triggers `release.yml`. It builds, tests, and runs `npm publish --provenance --access public` via OIDC.

You can also publish manually from the CLI by triggering the workflow at https://github.com/luau2ts/luau2ts/actions/workflows/release.yml with **Run workflow** and supplying the tag input.

### Verifying a published release

```bash
npm view luau2ts version           # should match the tag
npm install -g luau2ts             # global install
luau2ts --version                  # round-trip check
```

The shields.io badges in the README pick up the new version automatically on next browser cache flush (usually a few minutes).

## Labels

Used by release-drafter and Dependabot:
- `feature`, `fix`, `breaking`, `docs`, `chore`, `dependencies`
- `skip-changelog` to exclude a PR from release notes
