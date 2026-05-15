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
    if (third !== undefined) {
      const indexExpr = factory.createBinaryExpression(
        second!,
        factory.createToken(ts.SyntaxKind.MinusToken),
        factory.createNumericLiteral(1),
      );
      return factory.createCallExpression(
        factory.createPropertyAccessExpression(target, factory.createIdentifier('insert')),
        undefined,
        [indexExpr, third],
      );
    }
    if (second === undefined) return undefined;
    return factory.createCallExpression(
      factory.createPropertyAccessExpression(target, factory.createIdentifier('push')),
      undefined,
      [second],
    );
  },
  'rbxts',
);

// `table.remove(t)` → `t.pop()`
// `table.remove(t, i)` → `t.splice(i-1, 1)[0]`
registerMacro(
  'table.remove',
  ({ compiledArgs }: MacroArgs) => {
    const [target, idx] = compiledArgs;
    if (!target) return undefined;
    if (idx === undefined) {
      return factory.createCallExpression(
        factory.createPropertyAccessExpression(target, factory.createIdentifier('pop')),
        undefined,
        [],
      );
    }
    const indexExpr = factory.createBinaryExpression(
      idx,
      factory.createToken(ts.SyntaxKind.MinusToken),
      factory.createNumericLiteral(1),
    );
    return factory.createElementAccessExpression(
      factory.createCallExpression(
        factory.createPropertyAccessExpression(target, factory.createIdentifier('splice')),
        undefined,
        [indexExpr, factory.createNumericLiteral(1)],
      ),
      factory.createNumericLiteral(0),
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
    return factory.createBinaryExpression(
      factory.createCallExpression(
        factory.createPropertyAccessExpression(target, factory.createIdentifier('indexOf')),
        undefined,
        [value],
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

// ─── string.* method-form rewrites ─────────────────────────────────────────

// `string.split(s, sep)` → `s.split(sep)`
// `string.upper(s)` → `s.toUpperCase()`
// `string.lower(s)` → `s.toLowerCase()`
// `string.reverse(s)` → `[...s].reverse().join('')`
// `string.len(s)` → `s.length`
// `string.rep(s, n)` → `s.repeat(n)`

function emitStringMethod(method: string, argsAfterTarget = 0) {
  return ({ compiledArgs }: MacroArgs) => {
    const [target, ...rest] = compiledArgs;
    if (!target) return undefined;
    return factory.createCallExpression(
      factory.createPropertyAccessExpression(target, factory.createIdentifier(method)),
      undefined,
      rest.slice(0, argsAfterTarget),
    );
  };
}

registerMacro('string.split', emitStringMethod('split', 1), 'rbxts');
registerMacro('string.upper', emitStringMethod('toUpperCase', 0), 'rbxts');
registerMacro('string.lower', emitStringMethod('toLowerCase', 0), 'rbxts');
registerMacro('string.rep', emitStringMethod('repeat', 1), 'rbxts');

registerMacro(
  'string.len',
  ({ compiledArgs }: MacroArgs) => {
    if (!compiledArgs[0]) return undefined;
    return factory.createPropertyAccessExpression(
      compiledArgs[0],
      factory.createIdentifier('length'),
    );
  },
  'rbxts',
);

registerMacro(
  'string.reverse',
  ({ compiledArgs }: MacroArgs) => {
    const [target] = compiledArgs;
    if (!target) return undefined;
    // [...s].reverse().join('')
    return factory.createCallExpression(
      factory.createPropertyAccessExpression(
        factory.createCallExpression(
          factory.createPropertyAccessExpression(
            factory.createArrayLiteralExpression(
              [factory.createSpreadElement(target)],
              false,
            ),
            factory.createIdentifier('reverse'),
          ),
          undefined,
          [],
        ),
        factory.createIdentifier('join'),
      ),
      undefined,
      [factory.createStringLiteral('')],
    );
  },
  'rbxts',
);

// ─── math.* — direct JS Math passthrough ──────────────────────────────────

function emitMathPassthrough(name: string) {
  return ({ compiledArgs }: MacroArgs) =>
    factory.createCallExpression(
      factory.createPropertyAccessExpression(
        factory.createIdentifier('Math'),
        factory.createIdentifier(name),
      ),
      undefined,
      compiledArgs,
    );
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

// `math.clamp(x, lo, hi)` → `Math.min(Math.max(x, lo), hi)`
registerMacro(
  'math.clamp',
  ({ compiledArgs }: MacroArgs) => {
    const [x, lo, hi] = compiledArgs;
    if (!x || !lo || !hi) return undefined;
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
