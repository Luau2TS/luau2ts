// Backward inference of Instance class for untyped locals.
//
// Walks the body and collects, per-local, the set of methods/properties
// accessed on it (`x:Method()` and `x.Prop`). When the access pattern is
// uniquely consistent with `Instance` (Instance navigation methods are
// called on `x`), we mark `x` as Instance-typed so downstream emit drops
// the Record-routed access.
//
// Conservative on purpose: we never *narrow* below Instance. Locals that
// observe class-specific properties (`x.Position`, `x.Material`) still
// fall back to Instance — narrowing further requires more careful
// disambiguation (multiple BaseParts share Position). The goal is just
// to remove the spurious `as Record<string, unknown>` wraps when the
// local is plainly an Instance.

import type * as P from '../parser/index.js';
import type { CompileContext } from './context.js';

// Methods that strongly imply Instance. Listed verbatim so this doesn't
// drift if oracle data changes.
const INSTANCE_METHOD_SIGNATURE = new Set([
  'WaitForChild', 'FindFirstChild', 'FindFirstChildOfClass',
  'FindFirstChildWhichIsA', 'FindFirstAncestor', 'FindFirstAncestorOfClass',
  'FindFirstAncestorWhichIsA', 'FindFirstDescendant',
  'GetChildren', 'GetDescendants', 'GetFullName',
  'IsA', 'IsDescendantOf', 'Clone', 'Destroy',
  'GetAttribute', 'SetAttribute', 'GetAttributeChangedSignal',
  'GetPropertyChangedSignal', 'AddTag', 'HasTag', 'RemoveTag', 'GetTags',
]);

interface Acc {
  methodsCalled: Set<string>;
  propsRead: Set<string>;
}

const NAME_TABLE_PRESERVED = new Set([
  // Names mapped to specific classes in the oracle name-table — the init's
  // post-cast resolves to that class, not `_LuauChild`. (Mirrors the
  // CONVENTIONAL_CHILDREN names so backprop knows which inits are safe.)
  'leaderstats', 'Humanoid', 'Cash', 'Kills',
]);

function initLooksLuauChild(init: P.Expr | undefined): boolean {
  if (!init) return false;
  // `.Parent` access always emits `_LuauChild`.
  if (init.type === 'IndexName' && init.index === 'Parent') return true;
  // `obj:FindFirstChild("name")` / `obj:WaitForChild("name")` with name
  // not in the oracle's name-table → `_LuauChild | undefined`.
  if (
    init.type === 'Call'
    && init.self
    && init.func.type === 'IndexName'
    && (init.func.index === 'FindFirstChild' || init.func.index === 'WaitForChild')
  ) {
    const arg0 = init.args[0];
    const literal = arg0 && arg0.type === 'ConstantString'
      ? (arg0 as { value: string }).value
      : undefined;
    // Conservatively assume `_LuauChild` unless the name is one we know
    // the oracle resolves to a specific class.
    if (!literal) return true;
    return !NAME_TABLE_PRESERVED.has(literal);
  }
  // `require(...)` returns `_LuauChild`.
  if (
    init.type === 'Call'
    && init.func.type === 'Global'
    && init.func.name === 'require'
  ) {
    return true;
  }
  return false;
}

function makeAcc(): Acc {
  return { methodsCalled: new Set(), propsRead: new Set() };
}

export function inferInstanceLocals(
  root: P.BlockStat | null,
  ctx: CompileContext,
): void {
  if (!root) return;
  const perLocal = new Map<string, Acc>();
  const localDecls = new Set<string>();
  const initOf = new Map<string, P.Expr | undefined>();
  const destructured = new Set<string>();

  function getAcc(name: string): Acc {
    let a = perLocal.get(name);
    if (!a) {
      a = makeAcc();
      perLocal.set(name, a);
    }
    return a;
  }

  function visitExpr(expr: P.Expr): void {
    switch (expr.type) {
      case 'Call': {
        if (
          expr.self
          && expr.func.type === 'IndexName'
          && expr.func.expr.type === 'Local'
        ) {
          getAcc(expr.func.expr.name).methodsCalled.add(expr.func.index);
          // Don't recurse into expr.func — `gui:Method()` is a method
          // call, not a separate property read of `gui.Method`.
          for (const a of expr.args) visitExpr(a);
          return;
        }
        visitExpr(expr.func);
        for (const a of expr.args) visitExpr(a);
        return;
      }
      case 'IndexName': {
        if (expr.expr.type === 'Local') {
          getAcc(expr.expr.name).propsRead.add(expr.index);
        }
        visitExpr(expr.expr);
        return;
      }
      case 'IndexExpr':
        visitExpr(expr.expr);
        visitExpr(expr.index);
        return;
      case 'Binary':
        visitExpr(expr.left);
        visitExpr(expr.right);
        return;
      case 'Unary':
        visitExpr(expr.expr);
        return;
      case 'Group':
      case 'TypeAssertion':
        visitExpr(expr.expr);
        return;
      case 'Function':
        if (expr.body) visitBlock(expr.body);
        return;
      case 'IfElse':
        visitExpr(expr.condition);
        visitExpr(expr.trueExpr);
        visitExpr(expr.falseExpr);
        return;
      case 'Table':
        for (const item of expr.items) {
          visitExpr(item.value);
          if ('key' in item && item.key) visitExpr(item.key as P.Expr);
        }
        return;
      default:
        return;
    }
  }

  function visitStat(stat: P.Stat): void {
    switch (stat.type) {
      case 'Local':
        for (let i = 0; i < stat.vars.length; i += 1) {
          const v = stat.vars[i]!;
          localDecls.add(v.name);
          // Single-var Local: track the init for the `initLooksLuauChild`
          // safety check. Multi-var (destructured) Locals are unsafe to
          // backprop — the init's TS type is `unknown[]` and the
          // destructured slot stays `unknown` regardless of usage.
          if (stat.vars.length === 1) {
            initOf.set(v.name, stat.values[i]);
          } else {
            destructured.add(v.name);
          }
        }
        for (const val of stat.values) visitExpr(val);
        return;
      case 'Assign':
        for (const t of stat.vars) visitExpr(t);
        for (const v of stat.values) visitExpr(v);
        return;
      case 'Expr':
        visitExpr(stat.expr);
        return;
      case 'If':
        visitExpr(stat.condition);
        if (stat.thenBody.type === 'Block') visitBlock(stat.thenBody);
        else visitStat(stat.thenBody);
        if (stat.elseBody) {
          if (stat.elseBody.type === 'Block') visitBlock(stat.elseBody);
          else visitStat(stat.elseBody);
        }
        return;
      case 'While':
      case 'Repeat':
        visitExpr(stat.condition);
        if (stat.body.type === 'Block') visitBlock(stat.body);
        else visitStat(stat.body);
        return;
      case 'For':
        visitExpr(stat.from);
        visitExpr(stat.to);
        if (stat.step) visitExpr(stat.step);
        if (stat.body.type === 'Block') visitBlock(stat.body);
        else visitStat(stat.body);
        return;
      case 'ForIn':
        for (const v of stat.values) visitExpr(v);
        if (stat.body.type === 'Block') visitBlock(stat.body);
        else visitStat(stat.body);
        return;
      case 'Return':
        for (const v of stat.values) visitExpr(v);
        return;
      case 'LocalFunction':
        localDecls.add(stat.name.name);
        if (stat.func.body) visitBlock(stat.func.body);
        return;
      case 'Function':
        if (stat.func.body) visitBlock(stat.func.body);
        return;
      case 'Block':
        visitBlock(stat);
        return;
      default:
        return;
    }
  }

  function visitBlock(block: P.BlockStat): void {
    for (const s of block.body) visitStat(s);
  }

  visitBlock(root);

  for (const name of localDecls) {
    if (ctx.tsTypedClassLocal.has(name)) continue;
    if (ctx.tsShapeTypedLocal.has(name)) continue;
    if (ctx.tsTypedPrimitiveLocal.has(name)) continue;
    // Skip destructured locals — their TS type is `unknown` from the
    // tuple slot, and overriding with `Instance` would surface assign
    // and method-result mismatches downstream.
    if (destructured.has(name)) continue;
    // Skip locals whose init emits as `_LuauChild` for the same reason.
    if (initLooksLuauChild(initOf.get(name))) continue;
    const acc = perLocal.get(name);
    if (!acc) continue;
    let hasInstanceMethod = false;
    for (const m of acc.methodsCalled) {
      if (INSTANCE_METHOD_SIGNATURE.has(m)) {
        hasInstanceMethod = true;
        break;
      }
    }
    if (!hasInstanceMethod) continue;
    // All observed properties/methods must be valid on Instance (or any
    // class extending it). Anything missing (e.g. `x.customField`) means
    // it's NOT just an Instance.
    let allOnInstance = true;
    for (const m of acc.methodsCalled) {
      if (INSTANCE_METHOD_SIGNATURE.has(m)) continue;
      if (!ctx.oracle.methodReturnType('Instance', m, 0)
          && !ctx.oracle.propertyType('Instance', m)) {
        allOnInstance = false;
        break;
      }
    }
    if (!allOnInstance) continue;
    for (const p of acc.propsRead) {
      if (!ctx.oracle.propertyType('Instance', p)) {
        allOnInstance = false;
        break;
      }
    }
    if (allOnInstance) {
      // Cost-benefit: marking a local as Instance forces `as unknown as Instance`
      // wrap on the init (+2 `as unknown` chars). Each downstream Record-routed
      // method/property access skipped saves ~3-4 `as unknown` chars. So we
      // only win when downstream usage is ≥ 2 sites. Conservative: require at
      // least 2 distinct member observations to back-prop.
      const totalAccesses = acc.methodsCalled.size + acc.propsRead.size;
      if (totalAccesses < 2) continue;
      ctx.tsTypedClassLocal.set(name, 'Instance');
      ctx.backpropInstanceLocals.add(name);
    }
  }
}
