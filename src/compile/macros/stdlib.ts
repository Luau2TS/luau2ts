import ts from 'typescript';
import { registerMacro, type MacroArgs } from './index.js';
import type { Expr } from '../../parser/index.js';
import type { CompileContext } from '../context.js';

const { factory } = ts;

/** True for Luau exprs that compile to a TS expression already typed as
 *  `number`. Used by the math.X macros to skip the `as unknown as number`
 *  arg cast in cases where the cast would be a no-op. Conservative: a
 *  bare reassigned local is not trusted even if `ctx.staticTypeOf` says
 *  number — TS doesn't carry the tracked type into the `let` declaration. */
function argIsTrustedNumber(expr: Expr, ctx: CompileContext): boolean {
  if (expr.type === 'ConstantNumber' || expr.type === 'ConstantInteger') return true;
  if (expr.type === 'Group') return argIsTrustedNumber(expr.expr, ctx);
  if (expr.type !== 'Local' && ctx.staticTypeOf(expr) === 'number') return true;
  if (expr.type === 'TypeAssertion') {
    const ann = expr.annotation;
    if (ann.type === 'TypeReference' && ann.name === 'number') return true;
  }
  if (expr.type === 'Call') {
    const fn = expr.func;
    if (fn.type === 'Global' && fn.name === 'tonumber') return true;
    if (
      fn.type === 'IndexName'
      && fn.expr.type === 'Global'
      && fn.expr.name === 'math'
    ) return true;
  }
  if (expr.type === 'Local') {
    // Function param whose primitive was inferred as number — those emit
    // with a `: number` annotation, so TS sees them as number. Or an
    // un-reassigned local that TS already knows as number.
    return ctx.preInferredParamType.get(expr.name) === 'number'
      || ctx.tsTypedPrimitiveLocal.has(expr.name);
  }
  // Arithmetic on trusted operands stays trusted-number.
  if (expr.type === 'Binary' && ['+', '-', '*', '/', '%', '^', '//'].includes(expr.op)) {
    return argIsTrustedNumber(expr.left, ctx) && argIsTrustedNumber(expr.right, ctx);
  }
  if (expr.type === 'Unary' && expr.op === '-') {
    return argIsTrustedNumber(expr.expr, ctx);
  }
  return false;
}

// ─── table.* ───────────────────────────────────────────────────────────────

// `table.insert(t, v)` → `t.push(v)`; `table.insert(t, i, v)` → `t.insert(i - 1, v)`.
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
    // Cast through `as unknown as Array<defined>` so unknown-typed receivers expose `.push`/`.insert`.
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

// `table.remove(t)` → `t.pop()`; `table.remove(t, i)` → `t.remove(i - 1)`.
// rbxts Array uses `remove`, not `splice` (which doesn't exist on the type).
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

// `table.concat(t, sep)` → `(t as unknown as Array<defined>).join(sep)`.
// Bare `t.join(...)` fails when t is Record-typed (`local t = {}`).
registerMacro(
  'table.concat',
  ({ compiledArgs }: MacroArgs) => {
    const [target, sep] = compiledArgs;
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
    return factory.createCallExpression(
      factory.createPropertyAccessExpression(asArrayTarget, factory.createIdentifier('join')),
      undefined,
      sep ? [sep] : [],
    );
  },
  'rbxts',
);

// `table.sort(t, cmp?)` → `(t as unknown as Array<defined>).sort(cmp)`.
// Cast target so `.sort` resolves (Record-typed locals don't have it);
// cast cmp's signature to the Array's `(a: defined, b: defined) =>
// boolean` shape so user callbacks with synthesized-shape params don't
// trip TS2345.
registerMacro(
  'table.sort',
  ({ compiledArgs }: MacroArgs) => {
    const [target, cmp] = compiledArgs;
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
    const castedCmp = cmp
      ? factory.createAsExpression(
          factory.createAsExpression(
            cmp,
            factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
          ),
          factory.createFunctionTypeNode(
            undefined,
            [
              factory.createParameterDeclaration(
                undefined, undefined, 'a', undefined,
                factory.createTypeReferenceNode('defined', undefined),
              ),
              factory.createParameterDeclaration(
                undefined, undefined, 'b', undefined,
                factory.createTypeReferenceNode('defined', undefined),
              ),
            ],
            factory.createKeywordTypeNode(ts.SyntaxKind.BooleanKeyword),
          ),
        )
      : undefined;
    return factory.createCallExpression(
      factory.createPropertyAccessExpression(asArrayTarget, factory.createIdentifier('sort')),
      undefined,
      castedCmp ? [castedCmp] : [],
    );
  },
  'rbxts',
);

// `table.find(t, v)` → `t.indexOf(v) + 1`. Miss returns 0 (truthy in JS,
// falsy in Lua — divergence; use `t.indexOf(v) !== -1` for falsy-on-miss).
registerMacro(
  'table.find',
  ({ compiledArgs }: MacroArgs) => {
    const [target, value] = compiledArgs;
    if (!target || !value) return undefined;
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

// `table.unpack(t)` → `[...t]` (spread needs a call context; emit array form).
// Target cast to `Array<defined>` so unknown-typed receivers iterate.
registerMacro(
  'table.unpack',
  ({ compiledArgs }: MacroArgs) => {
    const [target] = compiledArgs;
    if (!target) return undefined;
    const asArray = factory.createAsExpression(
      factory.createAsExpression(
        target,
        factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
      ),
      factory.createTypeReferenceNode('Array', [
        factory.createTypeReferenceNode('defined', undefined),
      ]),
    );
    return factory.createArrayLiteralExpression(
      [factory.createSpreadElement(asArray)],
      false,
    );
  },
  'rbxts',
);

// ─── string.* ─────────────────────────────────────────────────────────────
// rbxts mode keeps the namespace form (`string.foo`) — round-trips clean
// to Lua. Only `string.len` needs rewriting since @rbxts/types' string
// namespace doesn't expose it; route to the method form `s.size()`.
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

// `table.pack(...)` → `[...args]`. Callers depending on `.n` must rewrite.
registerMacro(
  'table.pack',
  ({ compiledArgs }: MacroArgs) => {
    return factory.createArrayLiteralExpression(compiledArgs, false);
  },
  'rbxts',
);

// ─── math.* ───────────────────────────────────────────────────────────────
// rbxts: keep `math.<fn>` (typed as Lua namespace). native: emit `Math.<fn>`.
function emitMathPassthrough(name: string) {
  return ({ ctx, call, compiledArgs }: MacroArgs) => {
    const mathName = ctx.compatMode === 'rbxts' ? 'math' : 'Math';
    if (mathName === 'math') ctx.useAmbient('math');
    // rbxts: cast args `as unknown as number` — macros bypass the generic
    // compileCall castArgsForCall hook. Skip only when the Luau arg is a
    // numeric Constant, a math.X call result, a tonumber call, or a
    // param whose primitive was inferred as `number` (because those emit
    // with concrete TS number typing already).
    const args = ctx.compatMode === 'rbxts'
      ? compiledArgs.map((a, i) => {
          const luauArg = call.args[i];
          if (luauArg && argIsTrustedNumber(luauArg, ctx)) return a;
          return factory.createAsExpression(
            factory.createAsExpression(
              ts.isBinaryExpression(a) || ts.isConditionalExpression(a)
                ? factory.createParenthesizedExpression(a)
                : a,
              factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
            ),
            factory.createKeywordTypeNode(ts.SyntaxKind.NumberKeyword),
          );
        })
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

// `math.clamp(x, lo, hi)` → rbxts: real `math.clamp`; native: nested min/max.
registerMacro(
  'math.clamp',
  ({ ctx, compiledArgs }: MacroArgs) => {
    const [x, lo, hi] = compiledArgs;
    if (!x || !lo || !hi) return undefined;
    if (ctx.compatMode === 'rbxts') {
      ctx.useAmbient('math');
      const num = (a: ts.Expression) =>
        factory.createAsExpression(
          factory.createAsExpression(
            ts.isBinaryExpression(a) || ts.isConditionalExpression(a)
              ? factory.createParenthesizedExpression(a)
              : a,
            factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
          ),
          factory.createKeywordTypeNode(ts.SyntaxKind.NumberKeyword),
        );
      return factory.createCallExpression(
        factory.createPropertyAccessExpression(
          factory.createIdentifier('math'),
          factory.createIdentifier('clamp'),
        ),
        undefined,
        [num(x), num(lo), num(hi)],
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
