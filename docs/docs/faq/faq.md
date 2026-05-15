---
sidebar_position: 1
title: FAQ
slug: /faq
---

# Frequently asked questions

A growing list of common questions. PRs welcome.

- [Handling untyped Luau](/docs/faq/missing-types)
- [Formatting the emitted TypeScript](/docs/faq/output-formatting)
- [Running alongside roblox-ts](/docs/faq/roblox-ts-interop)

## Quick answers

**Q: Does `luau2ts` need Rojo installed?**
A: No. `luau2ts` reads `default.project.json` directly; the Rojo binary is only needed if you also want to sync the Luau source into Roblox Studio.

**Q: Can I run `luau2ts` and `roblox-ts` on the same project?**
A: Yes. They go in opposite directions: `roblox-ts` compiles TS → Luau, `luau2ts` compiles Luau → TS. They can coexist in a build pipeline, although in practice you usually pick one direction as the source of truth and treat the other as generated.

**Q: What Luau features are supported?**
A: All upstream Luau conformance tests pass (53/53). Generics, type aliases, exact tables, type assertions, string-interpolation backtick literals, generalized iteration, `--!strict`, `--!nonstrict` are all supported.

**Q: Does it emit JSX for Roact components?**
A: No. The shape of `Roact.createElement(component, props, children)` is preserved verbatim. JSX is a roblox-ts-side feature.
