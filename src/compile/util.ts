import ts from 'typescript';
import type { CompileContext } from './context.js';

const { factory } = ts;

const TS_RESERVED = new Set([
  'await',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'function',
  'if',
  'import',
  'in',
  'instanceof',
  'new',
  'null',
  'return',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'typeof',
  'var',
  'void',
  'while',
  'with',
  'yield',
  'let',
  'implements',
  'interface',
  'package',
  'private',
  'protected',
  'public',
  'static',
  'as',
  // TS type-name keywords. We deliberately do NOT escape `string`,
  // `number`, `boolean`, `object` — they shadow the Lua stdlib globals
  // (`string.format`, `math.floor`, `table.insert`) the script wrapper
  // injects, and the JS engine accepts them as variable names anyway.
  'symbol',
  'unknown',
  'never',
  // Strict-mode reserved words. Bare `const arguments = ...` and
  // `const eval = ...` are rejected in ES modules even though
  // they're not classic TS keywords. Lua treats both as ordinary
  // identifiers, so Vigilant-style `for _, arguments in ipairs(...)`
  // breaks without escaping.
  'arguments',
  'eval',
]);


/** Map a Luau identifier to a JS-safe one (suffixing reserved words). */
export function safeIdentifier(name: string): string {
  if (TS_RESERVED.has(name)) return `${name}_`;
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) return '_invalid_';
  return name;
}

/**
 * Property-access name. JS allows reserved words as property names in
 * dot notation (`obj.new`, `obj.delete`, `obj.class`) — only the
 * identifier position needs escaping. Use this for IndexName / record
 * keys / static class members.
 *
 * Parse-error recovery can hand us names with `%`, spaces, hyphens etc. —
 * those would emit invalid JS when wrapped in `createIdentifier`. Replace
 * such names with a safe placeholder so the file still compiles; the
 * surrounding script will already have thrown a parse-error stub.
 */
export function propertyName(name: string): string {
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) return '_invalid_';
  return name;
}

/** Wrap an expression in `isTruthy(…)` for Lua-faithful conditional evaluation. */
function isUndefinedIdentifier(expr: ts.Expression): boolean {
  return ts.isIdentifier(expr) && expr.text === 'undefined';
}

export function isRepeatableExpression(expr: ts.Expression): boolean {
  return (
    ts.isIdentifier(expr)
    || expr.kind === ts.SyntaxKind.ThisKeyword
    || ts.isNumericLiteral(expr)
    || ts.isStringLiteral(expr)
    || expr.kind === ts.SyntaxKind.TrueKeyword
    || expr.kind === ts.SyntaxKind.FalseKeyword
  );
}

/** Wrap a TS expression in a Lua-faithful truthiness check.
 *
 *  Optional `staticType` hint short-circuits the wrapper when the runtime
 *  shape of the value is narrow enough:
 *    - `'boolean'`   → return `expr` directly (already truthy-shaped).
 *    - `'number'` / `'string'` → always truthy in Lua (only nil/false are
 *      falsy). Return `true` literal when the expression is side-effect-
 *      free; otherwise fall through.
 *    - `'nil'`       → always falsy. Return `false`.
 *
 *  For everything else, route through the runtime `isTruthy()` helper.
 *  We previously inlined the check (`x !== false && x !== null && …`) for
 *  repeatable expressions, but the inline form bloats output by ~6× per
 *  use site for no measurable runtime win — `isTruthy()` is one indirect
 *  call into a 4-line function the engine inlines on the hot path. */
export function truthify(
  expr: ts.Expression,
  ctx: CompileContext,
  staticType: import('./context.js').StaticValueType | undefined = undefined,
): ts.Expression {
  if (staticType === 'boolean') return expr;
  if (staticType === 'nil') return factory.createFalse();
  // number, string, and Roblox datatypes (Vector3, CFrame, …) are never
  // nil and never the literal `false` in Lua, so Lua truthiness is always
  // `true`. Side-effect-free expressions fold to a boolean literal.
  const isAlwaysTruthy =
    staticType === 'number'
    || staticType === 'string'
    || (typeof staticType === 'string' && staticType.startsWith('datatype:'));
  if (isAlwaysTruthy && isRepeatableExpression(expr)) {
    return factory.createTrue();
  }
  // Quick literal folds — match `inlineTruthy`'s special cases without
  // emitting the 6-clause inline check.
  if (expr.kind === ts.SyntaxKind.TrueKeyword) return factory.createTrue();
  if (expr.kind === ts.SyntaxKind.FalseKeyword || isUndefinedIdentifier(expr)) {
    return factory.createFalse();
  }
  if (ts.isNumericLiteral(expr) || ts.isStringLiteral(expr)) return factory.createTrue();

  const fn = ctx.use('isTruthy');
  return factory.createCallExpression(factory.createIdentifier(fn), undefined, [expr]);
}

/** `throw new Error(message)` — used for unsupported AST nodes. */
export function throwUnsupported(message: string): ts.Statement {
  return factory.createThrowStatement(
    factory.createNewExpression(factory.createIdentifier('Error'), undefined, [
      factory.createStringLiteral(message),
    ]),
  );
}

/** As an expression: `(() => { throw new Error(message) })()`. */
export function unsupportedExpr(message: string): ts.Expression {
  return factory.createCallExpression(
    factory.createParenthesizedExpression(
      factory.createArrowFunction(
        undefined,
        undefined,
        [],
        undefined,
        factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
        factory.createBlock([throwUnsupported(message)], true),
      ),
    ),
    undefined,
    [],
  );
}
