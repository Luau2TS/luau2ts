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

export function luaIndex<T = unknown>(t: unknown, k: unknown): T {
  if (t === null || t === undefined) return undefined as T;
  if (typeof k === 'number' && Array.isArray(t)) {
    return (t as unknown[])[k - 1] as T;
  }
  return (t as Record<string | number, unknown>)[k as string | number] as T;
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
