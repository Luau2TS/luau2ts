import ts from 'typescript';
import { registerMacro, type MacroArgs } from './index.js';

const { factory } = ts;

// ─── table.* ───────────────────────────────────────────────────────────────

// `table.insert(t, v)` → `t.push(v)`
// `table.insert(t, i, v)` → `t.insert(i - 1, v)`. roblox-ts's Array<T>
//   interface exposes its own `insert(index, value)` method (0-indexed,
//   matching JS conventions), so a positional insert maps cleanly. The
//   `i - 1` shift mirrors what we do for literal numeric indices on
//   read access — the round-trip back to Lua adds the 1 back via
//   roblox-ts's index translation.
registerMacro(
  'table.insert',
  ({ compiledArgs }: MacroArgs) => {
    const [target, second, third] = compiledArgs;
    if (!target) return undefined;
    const asDefined = (e: ts.Expression) =>
      factory.createAsExpression(
        factory.createAsExpression(
          e,
          factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
        ),
        factory.createTypeReferenceNode('defined', undefined),
      );
    // Route the array target through `as unknown as Array<defined>` so
    // an `unknown`-typed receiver (from chained `obj[k]` index access)
    // exposes `.push` / `.insert` without TS2571.
    const asArrayTarget = factory.createParenthesizedExpression(
      factory.createAsExpression(
        factory.createAsExpression(
          target,
          factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
        ),
        factory.createTypeReferenceNode('Array', [
          factory.createTypeReferenceNode('defined', undefined),
        ]),
      ),
    );
    if (third !== undefined) {
      const indexExpr = factory.createBinaryExpression(
        second!,
        factory.createToken(ts.SyntaxKind.MinusToken),
        factory.createNumericLiteral(1),
      );
      return factory.createCallExpression(
        factory.createPropertyAccessExpression(asArrayTarget, factory.createIdentifier('insert')),
        undefined,
        [indexExpr, asDefined(third)],
      );
    }
    if (second === undefined) return undefined;
    return factory.createCallExpression(
      factory.createPropertyAccessExpression(asArrayTarget, factory.createIdentifier('push')),
      undefined,
      [asDefined(second)],
    );
  },
  'rbxts',
);

// `table.remove(t)` → `t.pop()`
// `table.remove(t, i)` → `t.remove(i - 1)`. @rbxts/compiler-types'
// Array<T> exposes `remove(index)` (0-indexed, returns removed
// element); roblox-ts maps it back to Lua's `table.remove(t, i)`.
// We use `remove`, NOT `splice` — the rbxts Array doesn't have
// `splice` and TS would fire TS2339.
registerMacro(
  'table.remove',
  ({ compiledArgs }: MacroArgs) => {
    const [target, idx] = compiledArgs;
    if (!target) return undefined;
    const asArrayTarget = factory.createParenthesizedExpression(
      factory.createAsExpression(
        factory.createAsExpression(
          target,
          factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
        ),
        factory.createTypeReferenceNode('Array', [
          factory.createTypeReferenceNode('defined', undefined),
        ]),
      ),
    );
    if (idx === undefined) {
      return factory.createCallExpression(
        factory.createPropertyAccessExpression(asArrayTarget, factory.createIdentifier('pop')),
        undefined,
        [],
      );
    }
    // Cast the index too — it might be an unknown-typed local.
    const idxNum = factory.createAsExpression(
      factory.createAsExpression(
        idx,
        factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
      ),
      factory.createKeywordTypeNode(ts.SyntaxKind.NumberKeyword),
    );
    const indexExpr = factory.createBinaryExpression(
      idxNum,
      factory.createToken(ts.SyntaxKind.MinusToken),
      factory.createNumericLiteral(1),
    );
    return factory.createCallExpression(
      factory.createPropertyAccessExpression(asArrayTarget, factory.createIdentifier('remove')),
      undefined,
      [indexExpr],
    );
  },
  'rbxts',
);

// `table.concat(t, sep)` → `t.join(sep)`
registerMacro(
  'table.concat',
  ({ compiledArgs }: MacroArgs) => {
    const [target, sep] = compiledArgs;
    if (!target) return undefined;
    return factory.createCallExpression(
      factory.createPropertyAccessExpression(target, factory.createIdentifier('join')),
      undefined,
      sep ? [sep] : [],
    );
  },
  'rbxts',
);

// `table.sort(t, cmp?)` → `t.sort(cmp)`
registerMacro(
  'table.sort',
  ({ compiledArgs }: MacroArgs) => {
    const [target, cmp] = compiledArgs;
    if (!target) return undefined;
    return factory.createCallExpression(
      factory.createPropertyAccessExpression(target, factory.createIdentifier('sort')),
      undefined,
      cmp ? [cmp] : [],
    );
  },
  'rbxts',
);

// `table.find(t, v)` → `t.indexOf(v) + 1` (Lua returns 1-indexed; nil → 0+1 = 1
// would clash, so the conversion is approximate. Use `t.indexOf(v) !== -1`
// idioms in TS instead. We emit `t.indexOf(v) + 1` which gives 0 on miss
// — matching the Lua semantics shape since 0 is falsy in Luau but TRUTHY
// in JS. This divergence is documented; users who rely on the falsy-on-
// miss should rewrite to `t.indexOf(v) !== -1`).
registerMacro(
  'table.find',
  ({ compiledArgs }: MacroArgs) => {
    const [target, value] = compiledArgs;
    if (!target || !value) return undefined;
    // Cast the search value `as unknown as defined` so the call
    // typechecks against `indexOf(this: ReadonlyArray<defined>,
    // searchElement: T)` even when `value` came in as `unknown`.
    const castValue = factory.createAsExpression(
      factory.createAsExpression(
        value,
        factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
      ),
      factory.createTypeReferenceNode('defined', undefined),
    );
    return factory.createBinaryExpression(
      factory.createCallExpression(
        factory.createPropertyAccessExpression(target, factory.createIdentifier('indexOf')),
        undefined,
        [castValue],
      ),
      factory.createToken(ts.SyntaxKind.PlusToken),
      factory.createNumericLiteral(1),
    );
  },
  'rbxts',
);

// `table.create(n, v)` → `new Array(n).fill(v)` (or `new Array(n)` when v is omitted)
registerMacro(
  'table.create',
  ({ compiledArgs }: MacroArgs) => {
    const [n, v] = compiledArgs;
    if (!n) return undefined;
    const arr = factory.createNewExpression(
      factory.createIdentifier('Array'),
      undefined,
      [n],
    );
    if (v === undefined) return arr;
    return factory.createCallExpression(
      factory.createPropertyAccessExpression(arr, factory.createIdentifier('fill')),
      undefined,
      [v],
    );
  },
  'rbxts',
);

// `table.clone(t)` → `[...t]` (shallow)
registerMacro(
  'table.clone',
  ({ compiledArgs }: MacroArgs) => {
    const [target] = compiledArgs;
    if (!target) return undefined;
    return factory.createArrayLiteralExpression(
      [factory.createSpreadElement(target)],
      false,
    );
  },
  'rbxts',
);

// `table.unpack(t)` → `...t`. The spread element only makes sense in a
// call-position context, so emit `[...t]` to give a plain expression we can
// reuse. Users who need actual unpacking write multi-return destructuring.
registerMacro(
  'table.unpack',
  ({ compiledArgs }: MacroArgs) => {
    const [target] = compiledArgs;
    if (!target) return undefined;
    return factory.createArrayLiteralExpression(
      [factory.createSpreadElement(target)],
      false,
    );
  },
  'rbxts',
);

// ─── string.* — keep namespace form in rbxts mode ─────────────────────────
//
// roblox-ts's @rbxts/types declares `string` as a Lua-global namespace
// (lua.d.ts has every method we care about EXCEPT `len`). Letting
// `string.split(s, sep)` survive as-is round-trips back to Lua
// identity AND avoids the imports-from-luau2ts-runtime that earlier
// helper-form macros would route through (stringFormat, stringMatch,
// etc.). For the missing-in-typesignature `string.len`, route to
// the method form `s.size()` instead (declared on String via
// @rbxts/compiler-types).

// `string.len(s)` → `(s as string).size()`. @rbxts/types' `string`
// namespace doesn't expose `.len` (only its method-form lives on the
// String interface, and it's named `size` there). Without this rewrite
// every `string.len(x)` fires TS2339.
registerMacro(
  'string.len',
  ({ compiledArgs }: MacroArgs) => {
    const [target] = compiledArgs;
    if (!target) return undefined;
    return factory.createCallExpression(
      factory.createPropertyAccessExpression(
        factory.createParenthesizedExpression(
          factory.createAsExpression(target, factory.createKeywordTypeNode(ts.SyntaxKind.StringKeyword)),
        ),
        factory.createIdentifier('size'),
      ),
      undefined,
      [],
    );
  },
  'rbxts',
);

// `table.pack(...)` → `[...args]`. Luau returns `{n=N, [1]=v1, ...}`;
// roblox-ts's table namespace doesn't expose `pack` and most use sites
// only consume `t[i]` (we shift to 0-indexed) or `t.n` (the array's
// `.size()`). Emit an array literal — callers that depend on `.n`
// will need to rewrite, callers that just want a captured tuple are
// fine.
registerMacro(
  'table.pack',
  ({ compiledArgs }: MacroArgs) => {
    return factory.createArrayLiteralExpression(compiledArgs, false);
  },
  'rbxts',
);

// ─── math.* — direct JS Math passthrough ──────────────────────────────────
//
// roblox-ts has `math` declared as a typed Lua-global namespace in
// @rbxts/types (lua.d.ts). Keep the lowercase `math.<fn>` form so the
// emit type-checks under roblox-ts AND survives the round-trip back
// to Lua as the identity transform. Using `Math` (the JS global)
// would produce TS2304 ("Cannot find name 'Math'") under rbxts mode.
//
// In native mode the JS global Math is the correct target — the host
// runtime is JS, not Lua.

function emitMathPassthrough(name: string) {
  return ({ ctx, compiledArgs }: MacroArgs) => {
    const mathName = ctx.compatMode === 'rbxts' ? 'math' : 'Math';
    if (mathName === 'math') ctx.useAmbient('math');
    // rbxts mode: cast each arg `as unknown as number` so unknown-
    // typed values (from structural-shape leaves or unannotated
    // params) flow into math's numeric slots without TS2345. The
    // generic compileCall castArgsForCall hook doesn't fire for
    // macro-rewritten calls (macros bypass it), so we apply the
    // cast here. Wrap the inner expression in parens first — `??`
    // and other binary operators bind LOOSER than `as`, so a bare
    // `X ?? 0 as unknown as number` would parse as `X ?? (0 as
    // unknown as number)` and miss the X branch.
    const args = ctx.compatMode === 'rbxts'
      ? compiledArgs.map((a) =>
          factory.createAsExpression(
            factory.createAsExpression(
              ts.isBinaryExpression(a) || ts.isConditionalExpression(a)
                ? factory.createParenthesizedExpression(a)
                : a,
              factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
            ),
            factory.createKeywordTypeNode(ts.SyntaxKind.NumberKeyword),
          ))
      : compiledArgs;
    return factory.createCallExpression(
      factory.createPropertyAccessExpression(
        factory.createIdentifier(mathName),
        factory.createIdentifier(name),
      ),
      undefined,
      args,
    );
  };
}

for (const m of [
  'floor', 'ceil', 'abs', 'sqrt', 'max', 'min',
  'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2',
  'sinh', 'cosh', 'tanh', 'exp', 'log', 'log2', 'log10',
  'sign', 'round', 'random',
]) {
  registerMacro(`math.${m}`, emitMathPassthrough(m), 'rbxts');
}

// `math.huge` and `math.pi` are property accesses, not calls — handled
// separately as expression-level rewrites would need a different hook. Our
// `math` namespace export already exposes them, so they pass through.

// `math.clamp(x, lo, hi)` → `Math.min(Math.max(x, lo), hi)` in native;
// in rbxts mode roblox-ts has a real `math.clamp`, so keep the call.
registerMacro(
  'math.clamp',
  ({ ctx, compiledArgs }: MacroArgs) => {
    const [x, lo, hi] = compiledArgs;
    if (!x || !lo || !hi) return undefined;
    if (ctx.compatMode === 'rbxts') {
      ctx.useAmbient('math');
      return factory.createCallExpression(
        factory.createPropertyAccessExpression(
          factory.createIdentifier('math'),
          factory.createIdentifier('clamp'),
        ),
        undefined,
        [x, lo, hi],
      );
    }
    return factory.createCallExpression(
      factory.createPropertyAccessExpression(
        factory.createIdentifier('Math'),
        factory.createIdentifier('min'),
      ),
      undefined,
      [
        factory.createCallExpression(
          factory.createPropertyAccessExpression(
            factory.createIdentifier('Math'),
            factory.createIdentifier('max'),
          ),
          undefined,
          [x, lo],
        ),
        hi,
      ],
    );
  },
  'rbxts',
);
