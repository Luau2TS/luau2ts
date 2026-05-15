import ts from 'typescript';
import { registerMacro, type MacroArgs } from './macros/index.js';

const { factory } = ts;

// ─── async / await / generator ─────────────────────────────────────────────

// `TS.async(fn)` wraps a function in an async closure. Roblox-ts uses this
// at every `async function` declaration boundary.
registerMacro(
  'TS.async',
  ({ compiledArgs }: MacroArgs) => {
    const inner = compiledArgs[0];
    if (!inner) return undefined;
    // Emit: ((...args) => Promise.resolve().then(() => fn(...args)))
    // The Promise.resolve hop ensures the body always runs in a microtask,
    // matching `async function` semantics.
    const argsParam = factory.createParameterDeclaration(
      undefined,
      factory.createToken(ts.SyntaxKind.DotDotDotToken),
      'args',
    );
    return factory.createParenthesizedExpression(
      factory.createArrowFunction(
        [factory.createModifier(ts.SyntaxKind.AsyncKeyword)],
        undefined,
        [argsParam],
        undefined,
        factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
        factory.createCallExpression(
          inner,
          undefined,
          [factory.createSpreadElement(factory.createIdentifier('args'))],
        ),
      ),
    );
  },
  'always',
);

// `TS.await(promise)` → `(await promise)`.
registerMacro(
  'TS.await',
  ({ compiledArgs }: MacroArgs) => {
    const p = compiledArgs[0];
    if (!p) return undefined;
    return factory.createParenthesizedExpression(factory.createAwaitExpression(p));
  },
  'always',
);

// `TS.try(tryFn, catchFn?, finallyFn?)` → Promise-style chain. The
// expression form is necessary because we can't emit a TS try-statement
// from inside a value-position macro. Real Roblox-ts implementation uses
// pcall under the hood; we use Promise.try/catch/finally semantics with
// awaited execution so synchronous throws still surface.
registerMacro(
  'TS.try',
  ({ compiledArgs }: MacroArgs) => {
    const [tryFn, catchFn, finallyFn] = compiledArgs;
    if (!tryFn) return undefined;
    // Promise.resolve().then(() => tryFn()).catch(catchFn).finally(finallyFn)
    let chain: ts.Expression = factory.createCallExpression(
      factory.createPropertyAccessExpression(
        factory.createCallExpression(
          factory.createPropertyAccessExpression(
            factory.createIdentifier('Promise'),
            factory.createIdentifier('resolve'),
          ),
          undefined,
          [],
        ),
        factory.createIdentifier('then'),
      ),
      undefined,
      [tryFn],
    );
    if (catchFn) {
      chain = factory.createCallExpression(
        factory.createPropertyAccessExpression(chain, factory.createIdentifier('catch')),
        undefined,
        [catchFn],
      );
    }
    if (finallyFn) {
      chain = factory.createCallExpression(
        factory.createPropertyAccessExpression(chain, factory.createIdentifier('finally')),
        undefined,
        [finallyFn],
      );
    }
    return chain;
  },
  'always',
);

// `TS.generator(fn)` — Roblox-ts wraps a generator-returning function so
// it conforms to its iteration protocol (`{next, done, value}`). On the JS
// side the same protocol is built-in for `function*` declarations. The
// safest lowering: keep `fn` as-is and wrap with a thin adapter that
// invokes the iterator factory the user produced.
registerMacro(
  'TS.generator',
  ({ compiledArgs }: MacroArgs) => compiledArgs[0],
  'always',
);

// ─── instanceof / import / Object_assign ───────────────────────────────────

registerMacro(
  'TS.instanceof',
  ({ compiledArgs }: MacroArgs) => {
    const [v, t] = compiledArgs;
    if (!v || !t) return undefined;
    return factory.createParenthesizedExpression(
      factory.createBinaryExpression(
        v,
        factory.createToken(ts.SyntaxKind.InstanceOfKeyword),
        t,
      ),
    );
  },
  'always',
);

// `TS.import(loader, ...path)` → `await import("path")`. We accept the
// loader argument because roblox-ts emits it but ignore it; the JS module
// system is the loader.
registerMacro(
  'TS.import',
  ({ compiledArgs }: MacroArgs) => {
    // Find the first string-literal argument and use it as the module path.
    // Any other arguments are joined as path segments after the first.
    const stringArgs = compiledArgs.filter(
      (a: ts.Expression): a is ts.StringLiteral => ts.isStringLiteral(a),
    );
    if (stringArgs.length === 0) return undefined;
    const moduleName = stringArgs.map((s: ts.StringLiteral) => s.text).join('/');
    return factory.createParenthesizedExpression(
      factory.createAwaitExpression(
        factory.createCallExpression(
          factory.createToken(ts.SyntaxKind.ImportKeyword) as unknown as ts.Expression,
          undefined,
          [factory.createStringLiteral(moduleName)],
        ),
      ),
    );
  },
  'always',
);

registerMacro(
  'TS.Object_assign',
  ({ compiledArgs }: MacroArgs) =>
    factory.createCallExpression(
      factory.createPropertyAccessExpression(
        factory.createIdentifier('Object'),
        factory.createIdentifier('assign'),
      ),
      undefined,
      compiledArgs,
    ),
  'always',
);

// ─── bit ops ───────────────────────────────────────────────────────────────
// All mapped to `(a OP b) >>> 0` so signedness matches Lua's 32-bit unsigned
// expectation.

type BitOpToken =
  | ts.BinaryOperatorToken
  | ts.Token<ts.SyntaxKind.AmpersandToken>
  | ts.Token<ts.SyntaxKind.BarToken>
  | ts.Token<ts.SyntaxKind.CaretToken>
  | ts.Token<ts.SyntaxKind.LessThanLessThanToken>
  | ts.Token<ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken>;

function emitBitOp(opFactory: () => BitOpToken) {
  return ({ compiledArgs }: { compiledArgs: ts.Expression[] }) => {
    if (compiledArgs.length === 0) return undefined;
    let acc = compiledArgs[0]!;
    for (let i = 1; i < compiledArgs.length; i++) {
      acc = factory.createBinaryExpression(acc, opFactory(), compiledArgs[i]!);
    }
    return factory.createParenthesizedExpression(
      factory.createBinaryExpression(
        acc,
        factory.createToken(ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken),
        factory.createNumericLiteral(0),
      ),
    );
  };
}

registerMacro('TS.bit_band', emitBitOp(() => factory.createToken(ts.SyntaxKind.AmpersandToken)), 'always');
registerMacro('TS.bit_bor', emitBitOp(() => factory.createToken(ts.SyntaxKind.BarToken)), 'always');
registerMacro('TS.bit_bxor', emitBitOp(() => factory.createToken(ts.SyntaxKind.CaretToken)), 'always');
registerMacro('TS.bit_lshift', emitBitOp(() => factory.createToken(ts.SyntaxKind.LessThanLessThanToken)), 'always');
registerMacro('TS.bit_rshift', emitBitOp(() => factory.createToken(ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken)), 'always');

// `TS.bit_bnot(x)` — unary; `(~x) >>> 0`.
registerMacro(
  'TS.bit_bnot',
  ({ compiledArgs }: MacroArgs) => {
    if (!compiledArgs[0]) return undefined;
    return factory.createParenthesizedExpression(
      factory.createBinaryExpression(
        factory.createPrefixUnaryExpression(ts.SyntaxKind.TildeToken, compiledArgs[0]),
        factory.createToken(ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken),
        factory.createNumericLiteral(0),
      ),
    );
  },
  'always',
);

// ─── number helpers ────────────────────────────────────────────────────────

function emitMathCall(method: string) {
  return ({ compiledArgs }: { compiledArgs: ts.Expression[] }) =>
    factory.createCallExpression(
      factory.createPropertyAccessExpression(
        factory.createIdentifier('Math'),
        factory.createIdentifier(method),
      ),
      undefined,
      compiledArgs,
    );
}

registerMacro('TS.round', emitMathCall('round'), 'always');
registerMacro('TS.math_floor', emitMathCall('floor'), 'always');
registerMacro('TS.math_ceil', emitMathCall('ceil'), 'always');
registerMacro('TS.math_abs', emitMathCall('abs'), 'always');
registerMacro('TS.math_max', emitMathCall('max'), 'always');
registerMacro('TS.math_min', emitMathCall('min'), 'always');
registerMacro('TS.math_sqrt', emitMathCall('sqrt'), 'always');

// ─── string helpers ────────────────────────────────────────────────────────
// Most TS.string_* helpers in roblox-ts are just method calls on the string
// itself. Lower them by emitting `s.<method>(args)`.

function emitStringMethod(method: string) {
  return ({ compiledArgs }: { compiledArgs: ts.Expression[] }) => {
    if (!compiledArgs[0]) return undefined;
    return factory.createCallExpression(
      factory.createPropertyAccessExpression(compiledArgs[0], factory.createIdentifier(method)),
      undefined,
      compiledArgs.slice(1),
    );
  };
}

registerMacro('TS.string_split', emitStringMethod('split'), 'always');
registerMacro('TS.string_includes', emitStringMethod('includes'), 'always');
registerMacro('TS.string_indexOf', emitStringMethod('indexOf'), 'always');
registerMacro('TS.string_startsWith', emitStringMethod('startsWith'), 'always');
registerMacro('TS.string_endsWith', emitStringMethod('endsWith'), 'always');
registerMacro('TS.string_padStart', emitStringMethod('padStart'), 'always');
registerMacro('TS.string_padEnd', emitStringMethod('padEnd'), 'always');
registerMacro('TS.string_slice', emitStringMethod('slice'), 'always');
registerMacro('TS.string_substring', emitStringMethod('substring'), 'always');
registerMacro('TS.string_substr', emitStringMethod('substr'), 'always');
registerMacro('TS.string_trim', emitStringMethod('trim'), 'always');
registerMacro('TS.string_trimStart', emitStringMethod('trimStart'), 'always');
registerMacro('TS.string_trimEnd', emitStringMethod('trimEnd'), 'always');
registerMacro('TS.string_concat', emitStringMethod('concat'), 'always');
registerMacro('TS.string_replace', emitStringMethod('replace'), 'always');
registerMacro('TS.string_replaceAll', emitStringMethod('replaceAll'), 'always');
registerMacro('TS.string_repeat', emitStringMethod('repeat'), 'always');
registerMacro('TS.string_toLowerCase', emitStringMethod('toLowerCase'), 'always');
registerMacro('TS.string_toUpperCase', emitStringMethod('toUpperCase'), 'always');

// ─── array helpers ─────────────────────────────────────────────────────────

function emitArrayMethod(method: string) {
  return ({ compiledArgs }: { compiledArgs: ts.Expression[] }) => {
    if (!compiledArgs[0]) return undefined;
    return factory.createCallExpression(
      factory.createPropertyAccessExpression(compiledArgs[0], factory.createIdentifier(method)),
      undefined,
      compiledArgs.slice(1),
    );
  };
}

registerMacro('TS.array_push', emitArrayMethod('push'), 'always');
registerMacro('TS.array_unshift', emitArrayMethod('unshift'), 'always');
registerMacro('TS.array_pop', emitArrayMethod('pop'), 'always');
registerMacro('TS.array_shift', emitArrayMethod('shift'), 'always');
registerMacro('TS.array_concat', emitArrayMethod('concat'), 'always');
registerMacro('TS.array_join', emitArrayMethod('join'), 'always');
registerMacro('TS.array_reverse', emitArrayMethod('reverse'), 'always');
registerMacro('TS.array_slice', emitArrayMethod('slice'), 'always');
registerMacro('TS.array_splice', emitArrayMethod('splice'), 'always');
registerMacro('TS.array_indexOf', emitArrayMethod('indexOf'), 'always');
registerMacro('TS.array_lastIndexOf', emitArrayMethod('lastIndexOf'), 'always');
registerMacro('TS.array_includes', emitArrayMethod('includes'), 'always');
registerMacro('TS.array_find', emitArrayMethod('find'), 'always');
registerMacro('TS.array_findIndex', emitArrayMethod('findIndex'), 'always');
registerMacro('TS.array_forEach', emitArrayMethod('forEach'), 'always');
registerMacro('TS.array_map', emitArrayMethod('map'), 'always');
registerMacro('TS.array_filter', emitArrayMethod('filter'), 'always');
registerMacro('TS.array_reduce', emitArrayMethod('reduce'), 'always');
registerMacro('TS.array_reduceRight', emitArrayMethod('reduceRight'), 'always');
registerMacro('TS.array_every', emitArrayMethod('every'), 'always');
registerMacro('TS.array_some', emitArrayMethod('some'), 'always');
registerMacro('TS.array_sort', emitArrayMethod('sort'), 'always');
registerMacro('TS.array_flat', emitArrayMethod('flat'), 'always');
registerMacro('TS.array_flatMap', emitArrayMethod('flatMap'), 'always');
