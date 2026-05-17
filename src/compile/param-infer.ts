// Function param + return primitive inference. Walks a FunctionExpr body
// and observes how each named parameter is used, producing the strongest
// concrete primitive constraint we can support (`number`, `string`,
// `boolean`). Used by paramsFromLocals when the user did not annotate
// the param and structural-shape inference would otherwise pick `unknown`.

import type * as P from '../parser/index.js';

export type Primitive = 'number' | 'string' | 'boolean';
export type ParamFact = Primitive | 'unknown';

// math.X functions whose first arg must be number.
const MATH_NUMBER_FNS = new Set([
  'floor', 'ceil', 'abs', 'sqrt', 'log', 'log10', 'exp',
  'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2',
  'rad', 'deg', 'sign', 'modf', 'fmod', 'pow', 'min', 'max',
  'clamp', 'huge', 'round',
]);
// string.X functions whose first arg is string.
const STRING_FNS = new Set([
  'len', 'lower', 'upper', 'reverse', 'sub', 'rep', 'find',
  'match', 'gmatch', 'gsub', 'format', 'byte', 'split',
]);

function constrain(curr: ParamFact, next: ParamFact): ParamFact {
  if (curr === 'unknown') return next;
  if (next === 'unknown') return curr;
  if (curr === next) return curr;
  return 'unknown';
}

function walkExpr(
  expr: P.Expr,
  params: Map<string, ParamFact>,
  ctx: { observe(name: string, t: ParamFact): void },
): void {
  switch (expr.type) {
    case 'Local': {
      // Bare use — no constraint.
      return;
    }
    case 'Call': {
      const fn = expr.func;
      // tonumber(x) → x: string
      if (fn.type === 'Global' && fn.name === 'tonumber') {
        for (const a of expr.args) observeArgAs(a, 'string', ctx);
      }
      // tostring(x) → no info
      // math.X(...) — args all number except `random(min,max)`/`pow(a,b)` (still number)
      if (fn.type === 'IndexName' && fn.expr.type === 'Global' && fn.expr.name === 'math' && MATH_NUMBER_FNS.has(fn.index)) {
        for (const a of expr.args) observeArgAs(a, 'number', ctx);
      }
      // string.X(s, ...) → s: string
      if (fn.type === 'IndexName' && fn.expr.type === 'Global' && fn.expr.name === 'string' && STRING_FNS.has(fn.index)) {
        const first = expr.args[0];
        if (first) observeArgAs(first, 'string', ctx);
      }
      // string:method on receiver — receiver is string.
      if (expr.self && fn.type === 'IndexName' && STRING_FNS.has(fn.index)) {
        observeArgAs(fn.expr, 'string', ctx);
      }
      // Recurse.
      walkExpr(fn, params, ctx);
      for (const a of expr.args) walkExpr(a, params, ctx);
      return;
    }
    case 'Binary': {
      if (expr.op === '..') {
        observeArgAs(expr.left, 'string', ctx);
        observeArgAs(expr.right, 'string', ctx);
      } else if (['+', '-', '*', '/', '%', '^', '//'].includes(expr.op)) {
        observeArgAs(expr.left, 'number', ctx);
        observeArgAs(expr.right, 'number', ctx);
      } else if (expr.op === '==' || expr.op === '~=') {
        // No type constraint from equality.
      }
      walkExpr(expr.left, params, ctx);
      walkExpr(expr.right, params, ctx);
      return;
    }
    case 'Unary': {
      if (expr.op === '-') observeArgAs(expr.expr, 'number', ctx);
      if (expr.op === '#') {
        // # can apply to strings or arrays; no clean constraint.
      }
      walkExpr(expr.expr, params, ctx);
      return;
    }
    case 'IndexName':
      walkExpr(expr.expr, params, ctx);
      return;
    case 'IndexExpr':
      walkExpr(expr.expr, params, ctx);
      walkExpr(expr.index, params, ctx);
      return;
    case 'Group':
      walkExpr(expr.expr, params, ctx);
      return;
    case 'Table': {
      for (const item of expr.items) {
        if (item.key) walkExpr(item.key, params, ctx);
        if (item.value) walkExpr(item.value, params, ctx);
      }
      return;
    }
    case 'IfElse': {
      walkExpr(expr.condition, params, ctx);
      walkExpr(expr.trueExpr, params, ctx);
      walkExpr(expr.falseExpr, params, ctx);
      return;
    }
    case 'InterpString': {
      for (const e of expr.expressions) walkExpr(e, params, ctx);
      return;
    }
    case 'Function':
      walkBlock(expr.body, params, ctx);
      return;
    default:
      return;
  }
}

function observeArgAs(
  arg: P.Expr,
  t: ParamFact,
  ctx: { observe(name: string, t: ParamFact): void },
): void {
  if (arg.type === 'Local') ctx.observe(arg.name, t);
  if (arg.type === 'Group') observeArgAs(arg.expr, t, ctx);
}

function walkStat(
  stat: P.Stat,
  params: Map<string, ParamFact>,
  ctx: { observe(name: string, t: ParamFact): void },
): void {
  switch (stat.type) {
    case 'Block':
      walkBlock(stat, params, ctx);
      return;
    case 'Expr':
      walkExpr(stat.expr, params, ctx);
      return;
    case 'Local':
      for (const v of stat.values) walkExpr(v, params, ctx);
      return;
    case 'Assign':
      for (const v of stat.values) walkExpr(v, params, ctx);
      for (const t of stat.vars) walkExpr(t, params, ctx);
      return;
    case 'CompoundAssign':
      walkExpr(stat.var, params, ctx);
      walkExpr(stat.value, params, ctx);
      return;
    case 'Return':
      for (const v of stat.values) walkExpr(v, params, ctx);
      return;
    case 'If':
      walkExpr(stat.condition, params, ctx);
      walkStat(stat.thenBody, params, ctx);
      if (stat.elseBody) walkStat(stat.elseBody, params, ctx);
      return;
    case 'While':
    case 'Repeat':
      walkExpr(stat.condition, params, ctx);
      walkStat(stat.body, params, ctx);
      return;
    case 'For':
      walkExpr(stat.from, params, ctx);
      walkExpr(stat.to, params, ctx);
      if (stat.step) walkExpr(stat.step, params, ctx);
      walkStat(stat.body, params, ctx);
      return;
    case 'ForIn':
      for (const v of stat.values) walkExpr(v, params, ctx);
      walkStat(stat.body, params, ctx);
      return;
    case 'LocalFunction':
      walkBlock(stat.func.body, params, ctx);
      return;
    case 'Function':
      walkBlock(stat.func.body, params, ctx);
      return;
    default:
      return;
  }
}

function walkBlock(
  block: P.BlockStat,
  params: Map<string, ParamFact>,
  ctx: { observe(name: string, t: ParamFact): void },
): void {
  for (const s of block.body) walkStat(s, params, ctx);
}

export function inferParamPrimitives(fn: P.FunctionExpr): Map<string, Primitive> {
  const params = new Map<string, ParamFact>();
  for (const p of fn.args) params.set(p.name, 'unknown');
  const observe = (name: string, t: ParamFact): void => {
    if (!params.has(name)) return;
    params.set(name, constrain(params.get(name)!, t));
  };
  walkBlock(fn.body, params, { observe });
  const out = new Map<string, Primitive>();
  for (const [k, v] of params) {
    if (v !== 'unknown') out.set(k, v);
  }
  return out;
}

/** Infer the return primitive of a function: intersect the static type of
 *  every `return X` expression. Returns undefined if any path is unknown. */
export function inferReturnPrimitive(
  fn: P.FunctionExpr,
  staticTypeOf: (e: P.Expr) => 'number' | 'string' | 'boolean' | 'unknown',
): Primitive | undefined {
  const returns: ParamFact[] = [];
  function walk(stat: P.Stat): void {
    switch (stat.type) {
      case 'Return':
        if (stat.values.length === 1) {
          returns.push(staticTypeOf(stat.values[0]!));
        } else if (stat.values.length === 0) {
          returns.push('unknown');
        } else {
          returns.push('unknown');
        }
        return;
      case 'Block':
        for (const s of stat.body) walk(s);
        return;
      case 'If':
        walk(stat.thenBody);
        if (stat.elseBody) walk(stat.elseBody);
        return;
      case 'While':
      case 'Repeat':
      case 'For':
      case 'ForIn':
        walk(stat.body);
        return;
      case 'LocalFunction':
      case 'Function':
        // Nested functions have their own returns.
        return;
      default:
        return;
    }
  }
  for (const s of fn.body.body) walk(s);
  if (returns.length === 0) return undefined;
  const first = returns[0];
  if (first === 'unknown') return undefined;
  for (const r of returns.slice(1)) {
    if (r !== first) return undefined;
  }
  return first;
}
