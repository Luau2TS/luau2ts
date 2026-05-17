// Per-local TS-type inference. Walks every LocalStat and AssignStat in
// the source, decides the "natural" TS type for each local by looking at
// the init expression and reassignments. Emits a WeakMap<LocalStat,
// primitive> + Map<localName, primitive> for codegen + the
// arg-cast-skip / arithmetic-widening gates.
//
// The point is to annotate `let X: number = ...` so downstream `X + 1`
// arithmetic and `string.X(s, ..., X, ...)` arg-cast sites can drop the
// `as unknown as number` operand wraps. Without this, TS sees X as the
// inferred init type (typically `unknown` from non-trivial calls) and
// every use needs the cast bridge.

import type * as P from '../parser/index.js';

export type LocalKind = 'number' | 'string' | 'boolean';

const STRING_RETURNING_LIB = new Set([
  'lower', 'upper', 'reverse', 'sub', 'rep', 'char', 'format',
]);
const NUMBER_RETURNING_MATH = new Set([
  'floor', 'ceil', 'abs', 'sqrt', 'log', 'log10', 'exp',
  'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2',
  'rad', 'deg', 'sign', 'min', 'max', 'pow',
  'clamp', 'random', 'noise', 'round', 'fmod', 'modf',
]);

/** Static type of a Luau expression, conservative — only returns a
 *  primitive when we're confident TS will see it as that primitive too. */
function exprType(expr: P.Expr): LocalKind | 'unknown' {
  switch (expr.type) {
    case 'ConstantString':
      return 'string';
    case 'ConstantNumber':
    case 'ConstantInteger':
      return 'number';
    case 'ConstantBool':
      return 'boolean';
    case 'Group':
      return exprType(expr.expr);
    case 'TypeAssertion': {
      const ann = expr.annotation;
      if (ann.type === 'TypeReference') {
        if (ann.name === 'string') return 'string';
        if (ann.name === 'number') return 'number';
        if (ann.name === 'boolean') return 'boolean';
      }
      return 'unknown';
    }
    case 'Binary': {
      const op = expr.op;
      if (op === '..') return 'string';
      if (['+', '-', '*', '/', '%', '^', '//'].includes(op)) {
        const lt = exprType(expr.left);
        const rt = exprType(expr.right);
        if (lt === 'number' && rt === 'number') return 'number';
        return 'unknown';
      }
      if (['==', '~=', '<', '>', '<=', '>='].includes(op)) return 'boolean';
      if (op === 'and' || op === 'or') {
        const lt = exprType(expr.left);
        const rt = exprType(expr.right);
        return lt === rt ? lt : 'unknown';
      }
      return 'unknown';
    }
    case 'Unary':
      if (expr.op === 'not') return 'boolean';
      if (expr.op === '#' || expr.op === '-') return 'number';
      return 'unknown';
    case 'Call': {
      const fn = expr.func;
      if (fn.type === 'Global') {
        if (fn.name === 'tostring' || fn.name === 'type' || fn.name === 'typeOf') return 'string';
        if (fn.name === 'tonumber') return 'number';
      }
      if (fn.type === 'IndexName' && fn.expr.type === 'Global') {
        const ns = fn.expr.name;
        if (ns === 'math' && NUMBER_RETURNING_MATH.has(fn.index)) return 'number';
        if (ns === 'string' && STRING_RETURNING_LIB.has(fn.index)) return 'string';
        // `os.clock`/`os.time`/`tick` return number per @rbxts/types.
        if (ns === 'os' && (fn.index === 'clock' || fn.index === 'time' || fn.index === 'difftime')) {
          return 'number';
        }
      }
      // Bare globals: `tick()` returns number.
      if (fn.type === 'Global' && fn.name === 'tick') return 'number';
      // Method-form string lib on a (presumed) string-typed receiver.
      if (fn.type === 'IndexName' && expr.self) {
        if (STRING_RETURNING_LIB.has(fn.index)) return 'string';
        if (fn.index === 'len' || fn.index === 'byte') return 'number';
      }
      return 'unknown';
    }
    case 'IfElse': {
      const t = exprType(expr.trueExpr);
      const f = exprType(expr.falseExpr);
      return t === f ? t : 'unknown';
    }
    case 'InterpString':
      return 'string';
    default:
      return 'unknown';
  }
}

interface ScopeInfo {
  /** Locals declared in this scope. Multi-var LocalStats skipped. */
  declared: Map<string, { types: Set<LocalKind | 'unknown'>; stat: P.LocalStat | null }>;
  parent?: ScopeInfo;
}

interface Sink {
  perStat: WeakMap<P.LocalStat, LocalKind>;
  byName: Map<string, LocalKind>;
}

function lookupDeclared(
  env: ScopeInfo | undefined,
  name: string,
): { types: Set<LocalKind | 'unknown'>; stat: P.LocalStat | null } | undefined {
  for (let e: ScopeInfo | undefined = env; e; e = e.parent) {
    const v = e.declared.get(name);
    if (v) return v;
  }
  return undefined;
}

function walkExpr(expr: P.Expr, scope: ScopeInfo, sink: Sink): void {
  if (!expr) return;
  switch (expr.type) {
    case 'Function': {
      const inner: ScopeInfo = { declared: new Map(), parent: scope };
      for (const arg of expr.args) {
        inner.declared.set(arg.name, { types: new Set(['unknown']), stat: null });
      }
      if (expr.body) visitBlock(expr.body, inner, sink);
      finalize(inner, sink);
      return;
    }
    case 'Call':
      walkExpr(expr.func, scope, sink);
      for (const a of expr.args) walkExpr(a, scope, sink);
      return;
    case 'IndexName':
      walkExpr(expr.expr, scope, sink);
      return;
    case 'IndexExpr':
      walkExpr(expr.expr, scope, sink);
      walkExpr(expr.index, scope, sink);
      return;
    case 'Group':
      walkExpr(expr.expr, scope, sink);
      return;
    case 'Binary':
      walkExpr(expr.left, scope, sink);
      walkExpr(expr.right, scope, sink);
      return;
    case 'Unary':
      walkExpr(expr.expr, scope, sink);
      return;
    case 'IfElse':
      walkExpr(expr.condition, scope, sink);
      walkExpr(expr.trueExpr, scope, sink);
      walkExpr(expr.falseExpr, scope, sink);
      return;
    case 'Table':
      for (const item of expr.items) {
        if (item.key) walkExpr(item.key, scope, sink);
        if (item.value) walkExpr(item.value, scope, sink);
      }
      return;
    case 'InterpString':
      for (const e of expr.expressions) walkExpr(e, scope, sink);
      return;
    case 'TypeAssertion':
      walkExpr(expr.expr, scope, sink);
      return;
    default:
      return;
  }
}

function visitBlock(block: P.BlockStat, scope: ScopeInfo, sink: Sink): void {
  for (const stat of block.body) walkStat(stat, scope, sink);
}

function walkStat(stat: P.Stat, scope: ScopeInfo, sink: Sink): void {
  switch (stat.type) {
    case 'Local': {
      for (const v of stat.values) walkExpr(v, scope, sink);
      // Single-var LocalStats: register so finalize can emit annotation.
      if (stat.vars.length === 1) {
        const v = stat.vars[0]!;
        const init = stat.values[0];
        const t = init ? exprType(init) : 'unknown';
        const slot = scope.declared.get(v.name);
        if (slot) slot.types.add(t);
        else scope.declared.set(v.name, { types: new Set([t]), stat });
      } else {
        // Multi-var: skip for now (LuaTuple destructures).
        for (const v of stat.vars) {
          scope.declared.set(v.name, { types: new Set(['unknown']), stat: null });
        }
      }
      return;
    }
    case 'Assign': {
      for (let i = 0; i < stat.vars.length; i += 1) {
        const target = stat.vars[i]!;
        const value = stat.values[i];
        walkExpr(target, scope, sink);
        if (value) walkExpr(value, scope, sink);
        if (target.type === 'Local' && value) {
          const t = exprType(value);
          const slot = lookupDeclared(scope, target.name);
          if (slot) slot.types.add(t);
        }
      }
      return;
    }
    case 'CompoundAssign': {
      walkExpr(stat.var, scope, sink);
      walkExpr(stat.value, scope, sink);
      if (stat.var.type === 'Local') {
        const slot = lookupDeclared(scope, stat.var.name);
        if (slot) slot.types.add('number');
      }
      return;
    }
    case 'Expr':
      walkExpr(stat.expr, scope, sink);
      return;
    case 'Return':
      for (const v of stat.values) walkExpr(v, scope, sink);
      return;
    case 'If': {
      walkExpr(stat.condition, scope, sink);
      if (stat.thenBody.type === 'Block') visitBlock(stat.thenBody, scope, sink);
      else walkStat(stat.thenBody, scope, sink);
      if (stat.elseBody) {
        if (stat.elseBody.type === 'Block') visitBlock(stat.elseBody, scope, sink);
        else walkStat(stat.elseBody, scope, sink);
      }
      return;
    }
    case 'While':
    case 'Repeat': {
      walkExpr(stat.condition, scope, sink);
      if (stat.body.type === 'Block') visitBlock(stat.body, scope, sink);
      else walkStat(stat.body, scope, sink);
      return;
    }
    case 'For': {
      walkExpr(stat.from, scope, sink);
      walkExpr(stat.to, scope, sink);
      if (stat.step) walkExpr(stat.step, scope, sink);
      const inner: ScopeInfo = { declared: new Map(), parent: scope };
      inner.declared.set(stat.var.name, { types: new Set(['number']), stat: null });
      if (stat.body.type === 'Block') visitBlock(stat.body, inner, sink);
      else walkStat(stat.body, inner, sink);
      finalize(inner, sink);
      return;
    }
    case 'ForIn': {
      for (const v of stat.values) walkExpr(v, scope, sink);
      const inner: ScopeInfo = { declared: new Map(), parent: scope };
      for (const v of stat.vars) {
        inner.declared.set(v.name, { types: new Set(['unknown']), stat: null });
      }
      if (stat.body.type === 'Block') visitBlock(stat.body, inner, sink);
      else walkStat(stat.body, inner, sink);
      finalize(inner, sink);
      return;
    }
    case 'LocalFunction':
    case 'Function': {
      const inner: ScopeInfo = { declared: new Map(), parent: scope };
      for (const arg of stat.func.args) {
        inner.declared.set(arg.name, { types: new Set(['unknown']), stat: null });
      }
      if (stat.func.body) visitBlock(stat.func.body, inner, sink);
      finalize(inner, sink);
      return;
    }
    case 'Block': {
      const inner: ScopeInfo = { declared: new Map(), parent: scope };
      visitBlock(stat, inner, sink);
      finalize(inner, sink);
      return;
    }
    default:
      return;
  }
}

export interface LocalTypeMap {
  /** Per-LocalStat: the inferred primitive when ALL observations agree
   *  on a single primitive. */
  perStat: WeakMap<P.LocalStat, LocalKind>;
  /** Per-name: same primitive, for quick byName lookup in
   *  isTrustedTypedExpr / arithmetic-widening gates. */
  byName: Map<string, LocalKind>;
}

export function inferLocalTypes(root: P.BlockStat): LocalTypeMap {
  const sink: Sink = {
    perStat: new WeakMap<P.LocalStat, LocalKind>(),
    byName: new Map<string, LocalKind>(),
  };
  const rootScope: ScopeInfo = { declared: new Map() };
  visitBlock(root, rootScope, sink);
  finalize(rootScope, sink);
  return sink;
}

function finalize(scope: ScopeInfo, sink: Sink): void {
  for (const [name, slot] of scope.declared) {
    if (!slot.stat) continue;
    const concrete = pickConcrete(slot.types);
    if (concrete) {
      sink.perStat.set(slot.stat, concrete);
      sink.byName.set(name, concrete);
    }
  }
}

function pickConcrete(set: Set<LocalKind | 'unknown'>): LocalKind | undefined {
  set.delete('unknown');
  if (set.size !== 1) return undefined;
  return [...set][0]! as LocalKind;
}
