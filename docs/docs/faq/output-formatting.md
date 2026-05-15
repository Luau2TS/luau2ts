---
sidebar_position: 3
title: Formatting the emitted TypeScript
---

# Formatting the emitted TypeScript

`luau2ts` uses TypeScript's own factory API to build the output AST, then prints it with the default TS printer. That printer prioritises correctness over style: it uses tabs/4-space indents inconsistent with most JS codebases, picks `let` over `const` more often than human authors would, and emits long lines without wrapping.

This is intentional. We don't try to win the formatting fight — that's what [Prettier](https://prettier.io) and [Biome](https://biomejs.dev) are for.

## Recommended pipeline

```bash
luau2ts src/ -o out/
pnpm exec prettier --write out/
```

Or with Biome:

```bash
luau2ts src/ -o out/
pnpm exec biome format --write out/
```

Either tool handles the output cleanly. Both preserve the `// Compiled by luau2ts` header.

## Why not format internally?

Two reasons:

1. **Your project already has style rules.** Forcing tabs vs spaces or single vs double quotes inside `luau2ts` would conflict with whatever your team has agreed on.
2. **Prettier/Biome do this better.** They handle line-wrapping, trailing commas, import ordering, and edge cases far better than a hand-rolled printer would.

If you need a fully-formatted single-file output for a quick test, pipe through Prettier:

```bash
luau2ts foo.luau | pnpm exec prettier --parser typescript
```
