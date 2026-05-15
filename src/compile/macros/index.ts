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
 *  Mode defaults to 'rbxts'. */
export function registerConstructorMacro(
  key: string,
  typeName: string,
  mode: MacroMode = 'rbxts',
): void {
  registerMacro(
    key,
    ({ ctx, compiledArgs }) => {
      ctx.useImport('@rbxts/types', typeName);
      return factory.createNewExpression(
        factory.createIdentifier(typeName),
        undefined,
        compiledArgs,
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
