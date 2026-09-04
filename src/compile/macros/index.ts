import ts from 'typescript';
import type { Expr } from '../../parser/index.js';
import type { CompatMode, CompileContext } from '../context.js';

const { factory } = ts;

/** Arguments handed to a macro. The macro is responsible for compiling its
 *  arguments via `compileExpr` (we pass it in to avoid a circular import). */
export interface MacroArgs {
  /** The original Luau call expression. */
  call: Extract<Expr, { type: 'Call' }>;
  /** Already-compiled TS expressions for each Luau argument, in order.
   *  Equivalent to `call.args.map(a => compileExpr(a, ctx))` so most macros
   *  can use them directly without re-walking the argument tree. */
  compiledArgs: ts.Expression[];
  /** Compile-time context — for `useImport`, `compatMode`, helper tracking. */
  ctx: CompileContext;
}

/** A macro returns the replacement TS expression, or `undefined` to decline. */
export type MacroFn = (args: MacroArgs) => ts.Expression | undefined;

/** When the macro is allowed to fire. */
export type MacroMode = 'always' | CompatMode;

interface MacroEntry {
  fn: MacroFn;
  mode: MacroMode;
}

const registry = new Map<string, MacroEntry>();

/** Register a macro by its dotted call shape. e.g. `'Vector3.new'`,
 *  `'Instance.new'`, `'game.GetService'`, `'TS.async'`. */
export function registerMacro(key: string, fn: MacroFn, mode: MacroMode = 'rbxts'): void {
  registry.set(key, { fn, mode });
}

/** Convenience: a constructor macro that always emits `new <Type>(...args)`.
 *  Mode defaults to 'rbxts'. When `numericArgs` is true, each compiled
 *  arg is cast `as unknown as number` so callers passing `unknown`-
 *  typed values (typical Phase-2 leaves: `frame.X.Scale`, etc.) flow
 *  into the numeric slots without TS2345. The roundtrip back to Lua
 *  drops the cast — Lua's runtime accepts whatever's there. */
export function registerConstructorMacro(
  key: string,
  typeName: string,
  mode: MacroMode = 'rbxts',
  numericArgs = false,
): void {
  registerMacro(
    key,
    ({ call, ctx, compiledArgs }) => {
      ctx.useImport('@rbxts/types', typeName);
      const args = numericArgs
        ? compiledArgs.map((a, i) => {
            const luauArg = call.args[i];
            // Skip cast when the source arg is already a numeric
            // primitive in TS's view — Constant literals, math.X calls,
            // arithmetic on trusted operands, param-inferred number
            // locals, etc.
            if (luauArg && ctx.tsVisibleTypeOf(luauArg) === 'number') return a;
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
      return factory.createNewExpression(
        factory.createIdentifier(typeName),
        undefined,
        args,
      );
    },
    mode,
  );
}


/** Look up the call shape and return a fired macro's TS expression, or
 *  `undefined` if no macro matched the current `compatMode`. */
export function lookupMacro(args: MacroArgs): ts.Expression | undefined {
  const key = callKey(args.call);
  if (!key) return undefined;

  // Built-in: `<DetectedClass>.new(...)` → `new <DetectedClass>(...)`.
  // Detected classes come from the class-shape pass (R.9); a class that
  // was synthesized into a TS `class` declaration uses TS instantiation
  // syntax at every call site instead of the Lua-style `.new` factory.
  if (key.endsWith('.new')) {
    const className = key.slice(0, -'.new'.length);
    if (args.ctx.isDetectedClass(className)) {
      return factory.createNewExpression(
        factory.createIdentifier(className),
        undefined,
        args.compiledArgs,
      );
    }
  }

  const entry = registry.get(key);
  if (!entry) return undefined;
  if (entry.mode !== 'always' && entry.mode !== args.ctx.compatMode) return undefined;
  return entry.fn(args);
}

/** Compute the dotted key for a call expression's callee. Returns
 *  `undefined` if the shape isn't recognizable (e.g. a method call on a
 *  computed expression). */
function callKey(call: Extract<Expr, { type: 'Call' }>): string | undefined {
  const func = call.func;
  // Bare global: `tonumber(x)` → 'tonumber'
  if (func.type === 'Global') return func.name;
  // Member access: `Object.member` or `Object:member` → 'Object.member'.
  if (func.type === 'IndexName') {
    const parts: string[] = [func.index];
    let cur: Expr = func.expr;
    while (cur.type === 'IndexName') {
      parts.unshift(cur.index);
      cur = cur.expr;
    }
    if (cur.type === 'Global') {
      parts.unshift(cur.name);
      return parts.join('.');
    }
    if (cur.type === 'Local') {
      parts.unshift(cur.name);
      return parts.join('.');
    }
  }
  return undefined;
}

/** Internal: clear the registry. Test-only. */
export function _clearMacrosForTesting(): void {
  registry.clear();
}
