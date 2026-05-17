// Pre-pass: rewrite `game.<service>` accesses to bare `<service>` references
// so the service auto-import can pick them up and the emitted TS doesn't
// trip roblox-ts's "Property does not exist on type 'DataModel'" rule.
//
// `game.Debris:AddItem(part, 5)` → (after this pass) `Debris:AddItem(part, 5)`
// with `Debris` added to the implicit-globals set so the compiler emits
// `const Debris = game.GetService("Debris")` at the top.
//
// Mutates the parsed AST in place.

import type * as P from '../parser/index.js';
import type { ClassOracle } from './oracle/index.js';

export interface ServiceRewriteResult {
  /** Services discovered via `game.X` patterns. Caller merges these into
   *  the implicit-globals set so the existing service-import logic fires. */
  servicesUsed: Set<string>;
}

export function rewriteGameServices(
  parsed: { root: P.BlockStat | null },
  oracle: ClassOracle,
): ServiceRewriteResult {
  const servicesUsed = new Set<string>();
  if (!parsed.root) return { servicesUsed };

  function rewriteExpr(expr: P.Expr): P.Expr {
    if (expr.type === 'IndexName'
        && expr.expr.type === 'Global'
        && (expr.expr as { name: string }).name === 'game'
        && oracle.isService(expr.index)) {
      servicesUsed.add(expr.index);
      // Replace `game.<Service>` with a bare Global reference to <Service>.
      // The auto-import code adds `const <Service> = game.GetService(...)`.
      return {
        type: 'Global',
        name: expr.index,
        loc: expr.loc,
      } as unknown as P.Expr;
    }
    // Recurse into children. Mutate in place to preserve identity for
    // other pre-passes that hold references.
    walkExpr(expr);
    return expr;
  }

  function walkExpr(expr: P.Expr): void {
    switch (expr.type) {
      case 'Call':
        (expr as { func: P.Expr }).func = rewriteExpr((expr as { func: P.Expr }).func);
        for (let i = 0; i < expr.args.length; i += 1) {
          expr.args[i] = rewriteExpr(expr.args[i]!);
        }
        return;
      case 'IndexName':
        (expr as { expr: P.Expr }).expr = rewriteExpr((expr as { expr: P.Expr }).expr);
        return;
      case 'IndexExpr':
        (expr as { expr: P.Expr }).expr = rewriteExpr((expr as { expr: P.Expr }).expr);
        (expr as { index: P.Expr }).index = rewriteExpr((expr as { index: P.Expr }).index);
        return;
      case 'Binary':
        (expr as { left: P.Expr }).left = rewriteExpr((expr as { left: P.Expr }).left);
        (expr as { right: P.Expr }).right = rewriteExpr((expr as { right: P.Expr }).right);
        return;
      case 'Unary':
      case 'Group':
      case 'TypeAssertion':
        (expr as { expr: P.Expr }).expr = rewriteExpr((expr as { expr: P.Expr }).expr);
        return;
      case 'IfElse':
        (expr as { condition: P.Expr }).condition = rewriteExpr((expr as { condition: P.Expr }).condition);
        (expr as { trueExpr: P.Expr }).trueExpr = rewriteExpr((expr as { trueExpr: P.Expr }).trueExpr);
        (expr as { falseExpr: P.Expr }).falseExpr = rewriteExpr((expr as { falseExpr: P.Expr }).falseExpr);
        return;
      case 'Table':
        for (const item of expr.items) {
          if ('key' in item && item.key) item.key = rewriteExpr(item.key as P.Expr);
          item.value = rewriteExpr(item.value);
        }
        return;
      case 'Function':
        if ((expr as { body: P.BlockStat | null }).body) {
          walkBlock((expr as { body: P.BlockStat }).body);
        }
        return;
      case 'InterpString':
        if ('expressions' in expr) {
          for (let i = 0; i < (expr as { expressions: P.Expr[] }).expressions.length; i += 1) {
            (expr as { expressions: P.Expr[] }).expressions[i] = rewriteExpr(
              (expr as { expressions: P.Expr[] }).expressions[i]!,
            );
          }
        }
        return;
      default:
        return;
    }
  }

  function walkStat(stat: P.Stat): void {
    switch (stat.type) {
      case 'Local':
        for (let i = 0; i < stat.values.length; i += 1) {
          stat.values[i] = rewriteExpr(stat.values[i]!);
        }
        return;
      case 'Assign':
        for (let i = 0; i < stat.vars.length; i += 1) {
          stat.vars[i] = rewriteExpr(stat.vars[i]!);
        }
        for (let i = 0; i < stat.values.length; i += 1) {
          stat.values[i] = rewriteExpr(stat.values[i]!);
        }
        return;
      case 'CompoundAssign':
        (stat as { var: P.Expr }).var = rewriteExpr((stat as { var: P.Expr }).var);
        (stat as { value: P.Expr }).value = rewriteExpr((stat as { value: P.Expr }).value);
        return;
      case 'Expr':
        (stat as { expr: P.Expr }).expr = rewriteExpr((stat as { expr: P.Expr }).expr);
        return;
      case 'Return':
        for (let i = 0; i < stat.values.length; i += 1) {
          stat.values[i] = rewriteExpr(stat.values[i]!);
        }
        return;
      case 'If':
        (stat as { condition: P.Expr }).condition = rewriteExpr((stat as { condition: P.Expr }).condition);
        walkStat(stat.thenBody);
        if (stat.elseBody) walkStat(stat.elseBody);
        return;
      case 'While':
      case 'Repeat':
        (stat as { condition: P.Expr }).condition = rewriteExpr((stat as { condition: P.Expr }).condition);
        walkStat(stat.body);
        return;
      case 'For':
        (stat as { from: P.Expr }).from = rewriteExpr((stat as { from: P.Expr }).from);
        (stat as { to: P.Expr }).to = rewriteExpr((stat as { to: P.Expr }).to);
        if (stat.step) (stat as { step: P.Expr }).step = rewriteExpr((stat as { step: P.Expr }).step);
        walkStat(stat.body);
        return;
      case 'ForIn':
        for (let i = 0; i < stat.values.length; i += 1) {
          stat.values[i] = rewriteExpr(stat.values[i]!);
        }
        walkStat(stat.body);
        return;
      case 'LocalFunction':
      case 'Function':
        if (stat.func.body) walkBlock(stat.func.body);
        return;
      case 'Block':
        walkBlock(stat);
        return;
      default:
        return;
    }
  }

  function walkBlock(block: P.BlockStat): void {
    for (const s of block.body) walkStat(s);
  }

  walkBlock(parsed.root);
  return { servicesUsed };
}
