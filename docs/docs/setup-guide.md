---
sidebar_position: 3
title: Setup guide
---

# Setup guide

A longer walkthrough than [Quick start](./quick-start), covering a real Rojo project from scratch.

## Prerequisites

- **Node 18+** (Node 20 or 22 recommended).
- **pnpm**, **npm**, or **yarn** — any of them works.
- **Rojo 7+** is *optional*: only needed if you also want to sync the original Luau into Roblox Studio. `luau2ts` reads `default.project.json` directly without needing Rojo installed.

## Install

```bash
npm install -g luau2ts
```

Or as a project dependency:

```bash
npm install --save-dev luau2ts
```

## Project layout

A typical Rojo project looks like this:

```
my-place/
├── default.project.json
├── src/
│   ├── shared/
│   │   ├── Util.luau
│   │   └── Constants.luau
│   ├── server/
│   │   └── Main.server.luau
│   └── client/
│       └── Main.client.luau
└── package.json
```

`default.project.json`:

```json
{
  "name": "my-place",
  "tree": {
    "$className": "DataModel",
    "ReplicatedStorage": {
      "Shared": { "$path": "src/shared" }
    },
    "ServerScriptService": {
      "Main": { "$path": "src/server" }
    },
    "StarterPlayer": {
      "StarterPlayerScripts": {
        "Client": { "$path": "src/client" }
      }
    }
  }
}
```

## Compile

```bash
luau2ts -p default.project.json -o out/
```

After this runs, `out/` mirrors the source tree:

```
out/
├── shared/Util.ts
├── shared/Constants.ts
├── server/Main.server.ts
└── client/Main.client.ts
```

The `.server.luau` / `.client.luau` suffixes are preserved as `.server.ts` / `.client.ts` so a downstream tool (like `roblox-ts`) can still recover the script kind.

## Pick an emit mode

Default mode is `rbxts`, which targets the [roblox-ts](https://roblox-ts.com) ecosystem. To produce output that runs against `luau2ts/runtime` instead, add `--mode native`:

```bash
luau2ts -p default.project.json -o out/ --mode native
```

See [Custom emit modes](./guides/custom-emit-modes) for when to use each.

## Next

- [CLI usage](./usage) for every flag.
- [Using with roblox-ts](./guides/using-with-roblox-ts) to fold the output back into a roblox-ts build.
