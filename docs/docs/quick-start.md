---
sidebar_position: 2
title: Quick start
---

# Quick start

## Install

```bash
npm install -g luau2ts
```

You need Node 18 or newer.

## Compile a single file

```bash
luau2ts hello.luau
```

Given `hello.luau`:

```lua
local function greet(name)
  print("Hello, " .. name)
end

greet("world")
```

You get:

```ts
// Compiled by luau2ts v0.1.0 — do not edit.

function greet(name) {
    print(`Hello, ${name}`);
}
greet("world");
```

Write the output to a file with `-o`:

```bash
luau2ts hello.luau -o hello.ts
```

## Compile a directory

```bash
luau2ts src/ -o out/
```

Walks every `.luau`, `.lua`, `.server.luau`, and `.client.luau` under `src/` and mirrors the tree into `out/`, preserving the `.server` / `.client` suffix on the `.ts` output.

## Compile a Rojo project

```bash
luau2ts -p default.project.json -o out/
```

Reads `default.project.json`, walks every `$path` directory, and emits one `.ts` per discovered Luau script.

## Library use

```ts
import { compile } from 'luau2ts';

const result = await compile('local x = 1 + 2');
console.log(result.source);
```

## Next

- [Setup guide](./setup-guide) for a fuller walkthrough.
- [CLI usage](./usage) for every flag.
