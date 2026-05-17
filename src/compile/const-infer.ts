// Pre-pass: identify Luau `local x = ...` declarations whose target is
// never reassigned in its enclosing scope. Those can emit as `const` in
// TS; the rest stay `let`. Output is a WeakSet<LocalStat>.
//
// "Reassign" = direct `x = …` (AssignStat with `x` in vars) or compound
// assign (`x += y`). Property-write `x.foo = bar` does NOT count.

import type * as P from '../parser/index.js';

interface ScopeInfo {
  declared: Map<string, P.LocalStat>;
  reassigned: Set<string>;
}

function visitBlockBuildScope(block: P.BlockStat, scope: ScopeInfo, results: WeakSet<P.LocalStat>): void {
  // First, walk all statements of this block (linear) into the scope.
  for (const stat of block.body) {
    walkStat(stat, scope, results);
  }
}

function newScope(): ScopeInfo {
  return { declared: new Map(), reassigned: new Set() };
}

function finalize(scope: ScopeInfo, results: WeakSet<P.LocalStat>): void {
  for (const [name, stat] of scope.declared) {
    if (!scope.reassigned.has(name)) results.add(stat);
  }
}

function walkExpr(expr: P.Expr, scope: ScopeInfo, results: WeakSet<P.LocalStat>): void {
  if (!expr) return;
  switch (expr.type) {
    case 'Function': {
      // Inline function expression (e.g. `Connect(function() … end)`).
      // Open a fresh inner scope. Any reassignments inside that touch
      // names NOT declared in the inner scope are closure mutations of
      // outer locals and propagate up.
      const inner = newScope();
      if (expr.body) visitBlockBuildScope(expr.body, inner, results);
      for (const r of inner.reassigned) {
        if (!inner.declared.has(r)) scope.reassigned.add(r);
      }
      finalize(inner, results);
      return;
    }
    case 'Call':
      walkExpr(expr.func, scope, results);
      for (const a of expr.args) walkExpr(a, scope, results);
      return;
    case 'IndexName':
      walkExpr(expr.expr, scope, results);
      return;
    case 'IndexExpr':
      walkExpr(expr.expr, scope, results);
      walkExpr(expr.index, scope, results);
      return;
    case 'Group':
      walkExpr(expr.expr, scope, results);
      return;
    case 'Binary':
      walkExpr(expr.left, scope, results);
      walkExpr(expr.right, scope, results);
      return;
    case 'Unary':
      walkExpr(expr.expr, scope, results);
      return;
    case 'IfElse':
      walkExpr(expr.condition, scope, results);
      walkExpr(expr.trueExpr, scope, results);
      walkExpr(expr.falseExpr, scope, results);
      return;
    case 'Table':
      for (const item of expr.items) {
        if (item.key) walkExpr(item.key, scope, results);
        if (item.value) walkExpr(item.value, scope, results);
      }
      return;
    case 'InterpString':
      for (const e of expr.expressions) walkExpr(e, scope, results);
      return;
    case 'TypeAssertion':
      walkExpr(expr.expr, scope, results);
      return;
    default:
      return;
  }
}

function walkStat(stat: P.Stat, scope: ScopeInfo, results: WeakSet<P.LocalStat>): void {
  switch (stat.type) {
    case 'Local': {
      // Multi-decl: only mark the entire LocalStat const if none of its
      // vars are reassigned within the scope.
      for (const v of stat.vars) {
        // If a same-name local was already declared earlier in the scope,
        // this re-declares (shadows). Mark previous as not-const (it can
        // still get the const status separately based on its own reassign).
        scope.declared.set(v.name, stat);
      }
      for (const val of stat.values) walkExpr(val, scope, results);
      return;
    }
    case 'Expr':
      walkExpr(stat.expr, scope, results);
      return;
    case 'Return':
      for (const v of stat.values) walkExpr(v, scope, results);
      return;
    case 'Assign': {
      for (const target of stat.vars) {
        if (target.type === 'Local') {
          scope.reassigned.add(target.name);
        }
        walkExpr(target, scope, results);
      }
      for (const v of stat.values) walkExpr(v, scope, results);
      return;
    }
    case 'CompoundAssign': {
      if (stat.var.type === 'Local') scope.reassigned.add(stat.var.name);
      walkExpr(stat.var, scope, results);
      walkExpr(stat.value, scope, results);
      return;
    }
    case 'If': {
      walkExpr(stat.condition, scope, results);
      // Inner branches: walk with same scope (Luau shares scope across if).
      // But locals declared INSIDE a branch don't leak — they're new
      // sub-scopes that may finalize independently. Simpler heuristic: a
      // branch is a new sub-scope.
      const innerThen = newScope();
      if (stat.thenBody.type === 'Block') visitBlockBuildScope(stat.thenBody, innerThen, results);
      else walkStat(stat.thenBody, innerThen, results);
      // Propagate reassignments to enclosing scope.
      for (const r of innerThen.reassigned) {
        if (!innerThen.declared.has(r)) scope.reassigned.add(r);
      }
      finalize(innerThen, results);
      if (stat.elseBody) {
        const innerElse = newScope();
        if (stat.elseBody.type === 'Block') visitBlockBuildScope(stat.elseBody, innerElse, results);
        else walkStat(stat.elseBody, innerElse, results);
        for (const r of innerElse.reassigned) {
          if (!innerElse.declared.has(r)) scope.reassigned.add(r);
        }
        finalize(innerElse, results);
      }
      return;
    }
    case 'While':
    case 'Repeat': {
      walkExpr(stat.condition, scope, results);
      const inner = newScope();
      if (stat.body.type === 'Block') visitBlockBuildScope(stat.body, inner, results);
      else walkStat(stat.body, inner, results);
      for (const r of inner.reassigned) {
        if (!inner.declared.has(r)) scope.reassigned.add(r);
      }
      finalize(inner, results);
      return;
    }
    case 'For': {
      walkExpr(stat.from, scope, results);
      walkExpr(stat.to, scope, results);
      if (stat.step) walkExpr(stat.step, scope, results);
      const inner = newScope();
      if (stat.body.type === 'Block') visitBlockBuildScope(stat.body, inner, results);
      else walkStat(stat.body, inner, results);
      for (const r of inner.reassigned) {
        if (!inner.declared.has(r)) scope.reassigned.add(r);
      }
      finalize(inner, results);
      return;
    }
    case 'ForIn': {
      for (const v of stat.values) walkExpr(v, scope, results);
      const inner = newScope();
      if (stat.body.type === 'Block') visitBlockBuildScope(stat.body, inner, results);
      else walkStat(stat.body, inner, results);
      for (const r of inner.reassigned) {
        if (!inner.declared.has(r)) scope.reassigned.add(r);
      }
      finalize(inner, results);
      return;
    }
    case 'Block': {
      const inner = newScope();
      visitBlockBuildScope(stat, inner, results);
      for (const r of inner.reassigned) {
        if (!inner.declared.has(r)) scope.reassigned.add(r);
      }
      finalize(inner, results);
      return;
    }
    case 'LocalFunction': {
      // Local function name itself: bound by `local function`. It's a
      // single binding, never reassigned (Luau doesn't allow `f = …` to
      // mutate the function-form local from this scope's perspective).
      // Function body opens a fresh scope. Any assignments inside the
      // body to names NOT declared inside propagate up — those are
      // closure-captured mutations of outer locals.
      const inner = newScope();
      if (stat.func.body) visitBlockBuildScope(stat.func.body, inner, results);
      for (const r of inner.reassigned) {
        if (!inner.declared.has(r)) scope.reassigned.add(r);
      }
      finalize(inner, results);
      return;
    }
    case 'Function': {
      const inner = newScope();
      if (stat.func.body) visitBlockBuildScope(stat.func.body, inner, results);
      for (const r of inner.reassigned) {
        if (!inner.declared.has(r)) scope.reassigned.add(r);
      }
      finalize(inner, results);
      return;
    }
    default:
      return;
  }
}

/** Mark every Luau LocalStat that's never reassigned in its enclosing
 *  scope. Pre-pass run once per compile, before codegen. */
export function inferConstLocals(root: P.BlockStat): WeakSet<P.LocalStat> {
  const out = new WeakSet<P.LocalStat>();
  const scope = newScope();
  visitBlockBuildScope(root, scope, out);
  finalize(scope, out);
  return out;
}
