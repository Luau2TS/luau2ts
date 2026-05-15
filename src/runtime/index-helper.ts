// luaIndex(t, k) — table[k] lookup with Lua-correct array indexing.
//
// Lua tables are 1-indexed; JS arrays are 0-indexed. The luau-to-ts
// compiler used to emit an inline conditional that subtracted 1 from
// every runtime numeric key:
//
//   t[(typeof k === "number" ? k - 1 : k)]
//
// That's correct for Lua sequence-style tables compiled to JS arrays
// (where Lua `arr[1]` should hit JS `arr[0]`), but it's catastrophically
// wrong for dictionary-style tables keyed by large numeric values —
// Roblox developer-product IDs (3582943767), asset IDs, gamepass IDs, etc.
// `productCash[3582943767]` ends up as `productCash[3582943766]` → undefined.
//
// This helper picks the right behavior dynamically:
//   • Plain JS array, numeric key in range → subtract 1 (sequence access)
//   • Anything else → pass through (dictionary access, string keys, etc.)

// Return type is `any` (not `unknown`) so chained access like
// `luaIndex(states, name).parent` compiles cleanly. Luau tables don't
// surface their value type at the call site here, and forcing every
// caller through a manual `as` annotation is hostile. Users that want
// stricter typing should hold the result in a typed local and let the
// surrounding annotation refine it.
export function luaIndex(t: unknown, k: unknown): any {
  if (t === null || t === undefined) return undefined;
  if (typeof k === 'number' && Array.isArray(t)) {
    return (t as unknown[])[k - 1];
  }
  return (t as Record<string | number, unknown>)[k as string | number];
}

// Companion to luaIndex for the `t[k] = v` write position. Same arrays-vs-
// dictionaries discrimination — only Lua sequences compiled to JS arrays
// get the 1-index subtraction.
export function luaIndexSet(t: unknown, k: unknown, v: unknown): unknown {
  if (t === null || t === undefined) return v;
  if (typeof k === 'number' && Array.isArray(t)) {
    (t as unknown[])[k - 1] = v;
  } else {
    (t as Record<string | number, unknown>)[k as string | number] = v;
  }
  return v;
}
