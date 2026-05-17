// Pre-pass: hoist LuaTuple-returning calls out of single-value-consuming
// positions. The user typically wants their result destructured, not
// implicitly extracted via [0] in the middle of a nested call.
//
//   local withCommas = string.reverse(string.gsub(reversed, ...))
// becomes:
//   local reversed1 = string.gsub(reversed, ...)
//   local withCommas = string.reverse(reversed1)
//
// At codegen, compileLocal then emits `const [reversed1] = ...` because
// `string.gsub` returns LuaTuple — the destructure replaces the [0] postfix.

import type * as P from '../parser/index.js';

const LUATUPLE_METHODS = new Set(['gsub', 'find', 'match', 'gmatch']);

function isLuaTupleStringCall(call: P.CallExpr): boolean {
  const fn = call.func;
  if (fn.type !== 'IndexName') return false;
  if (!LUATUPLE_METHODS.has(fn.index)) return false;
  // namespace form `string.X(...)`
  if (fn.expr.type === 'Global' && fn.expr.name === 'string') return true;
  return false;
}

function emptyLoc(): P.Loc {
  return { start: { line: 0, col: 0 }, end: { line: 0, col: 0 } } as unknown as P.Loc;
}

function makeLocal(name: string, value: P.Expr): P.LocalStat {
  return {
    type: 'Local',
    vars: [{ name, annotation: null, location: emptyLoc(), nameLocation: emptyLoc() } as unknown as P.LocalStat['vars'][number]],
    values: [value],
    isConst: true,
    loc: emptyLoc(),
  } as unknown as P.LocalStat;
}

function localRef(name: string): P.Expr {
  return { type: 'Local', name, upvalue: false, loc: emptyLoc() } as unknown as P.Expr;
}

interface Allocator { fresh(base: string): string }
function alloc(reserved: Set<string>): Allocator {
  const taken = new Set(reserved);
  return {
    fresh(base) {
      if (!taken.has(base)) { taken.add(base); return base; }
      let i = 2;
      while (taken.has(`${base}${i}`)) i += 1;
      const n = `${base}${i}`;
      taken.add(n);
      return n;
    },
  };
}

// Naming: `string.reverse(s).gsub(...)` → derive from the receiver's
// method. For now, `string.gsub(string.reverse(s), ...)` namespace form
// is what we see in source, so derive from the inner call's method:
// `reverse` → `reversed`.
function derivedName(call: P.CallExpr): string {
  const arg0 = call.args[0];
  if (arg0?.type === 'Call' && arg0.func.type === 'IndexName') {
    const method = arg0.func.index;
    const pastForms: Record<string, string> = {
      reverse: 'reversed', upper: 'upper', lower: 'lower',
      sub: 'sub', rep: 'rep', format: 'formatted',
    };
    if (pastForms[method]) return pastForms[method]!;
    return method;
  }
  return 'tuple';
}

// Walk an expression looking for LuaTuple-returning calls that are *not*
// the outermost call. Collect them in pre-order (innermost first) for
// hoisting.
type ReplaceSlot = { parent: P.Expr; key: string | number };
function findHoistable(
  root: P.Expr,
  out: { call: P.CallExpr; slot: ReplaceSlot }[],
): void {
  // Walk the root expression. If `root` itself is a LuaTuple call, don't
  // hoist it (it's the outer expression). Recurse into children — any
  // LuaTuple call found there gets hoisted.
  function walk(parent: P.Expr | null, key: string | number, expr: P.Expr): void {
    // Don't hoist when this IS the outermost call (parent === null).
    if (parent && expr.type === 'Call' && isLuaTupleStringCall(expr)) {
      out.push({ call: expr, slot: { parent, key } });
      // continue into args of the hoisted call (rare: nested LuaTuple)
    }
    // Recurse into substructure.
    switch (expr.type) {
      case 'Call': {
        // walk the callee
        walk(expr, 'func', expr.func);
        // and each arg
        for (let i = 0; i < expr.args.length; i += 1) {
          walk(expr, i, expr.args[i]!);
        }
        return;
      }
      case 'IndexName':
        walk(expr, 'expr', expr.expr);
        return;
      case 'IndexExpr':
        walk(expr, 'expr', expr.expr);
        walk(expr, 'index', expr.index);
        return;
      case 'Group':
        walk(expr, 'expr', expr.expr);
        return;
      case 'Binary':
        walk(expr, 'left', expr.left);
        walk(expr, 'right', expr.right);
        return;
      case 'Unary':
        walk(expr, 'expr', expr.expr);
        return;
      default:
        return;
    }
  }
  walk(null, '', root);
}

function setSlot(slot: ReplaceSlot, value: P.Expr): void {
  const parent = slot.parent as unknown as Record<string, unknown> & { args?: P.Expr[] };
  if (typeof slot.key === 'number') {
    parent.args![slot.key] = value;
  } else {
    parent[slot.key as string] = value;
  }
}

function processInitsForHoist(
  init: P.Expr,
  alloc: Allocator,
): { newLocals: P.LocalStat[]; finalInit: P.Expr } {
  // Only hoist LuaTuple calls that are STRICTLY INSIDE another call/expr.
  // If the init itself is a LuaTuple call, leave it for the LocalStat
  // destructure path.
  const hoistable: { call: P.CallExpr; slot: ReplaceSlot }[] = [];
  findHoistable(init, hoistable);
  const newLocals: P.LocalStat[] = [];
  for (const { call, slot } of hoistable) {
    const name = alloc.fresh(derivedName(call));
    // Make a deep-ish reference: keep the call's identity, replace its
    // position with a Local ref.
    const ref = localRef(name);
    setSlot(slot, ref);
    newLocals.push(makeLocal(name, call));
  }
  return { newLocals, finalInit: init };
}

function visitBlock(block: P.BlockStat, alloc: Allocator): void {
  const out: P.Stat[] = [];
  for (const stat of block.body) {
    walkStat(stat, alloc);
    if (
      stat.type === 'Local'
      && stat.vars.length === 1
      && stat.values.length === 1
      && stat.values[0]
    ) {
      const init = stat.values[0]!;
      // If the LocalStat's value is itself a LuaTuple call, the codegen
      // will destructure it — don't hoist further. But still hoist any
      // inner LuaTuple calls inside that outer call.
      const { newLocals } = processInitsForHoist(init, alloc);
      out.push(...newLocals);
    } else if (
      stat.type === 'Assign'
      && stat.values.length >= 1
    ) {
      for (const value of stat.values) {
        const { newLocals } = processInitsForHoist(value, alloc);
        out.push(...newLocals);
      }
    } else if (stat.type === 'Return') {
      for (const value of stat.values) {
        const { newLocals } = processInitsForHoist(value, alloc);
        out.push(...newLocals);
      }
    }
    out.push(stat);
  }
  block.body = out;
}

function walkStat(stat: P.Stat, alloc: Allocator): void {
  if (stat.type === 'Block') visitBlock(stat, alloc);
  if (stat.type === 'If') {
    if (stat.thenBody.type === 'Block') visitBlock(stat.thenBody, alloc);
    else walkStat(stat.thenBody, alloc);
    if (stat.elseBody) {
      if (stat.elseBody.type === 'Block') visitBlock(stat.elseBody, alloc);
      else walkStat(stat.elseBody, alloc);
    }
  }
  if (stat.type === 'While' || stat.type === 'Repeat' || stat.type === 'For' || stat.type === 'ForIn') {
    if (stat.body.type === 'Block') visitBlock(stat.body, alloc);
    else walkStat(stat.body, alloc);
  }
  if ((stat.type === 'LocalFunction' || stat.type === 'Function') && stat.func.body) {
    visitBlock(stat.func.body, alloc);
  }
}

function collectLocalNames(block: P.BlockStat, out: Set<string>): void {
  for (const stat of block.body) {
    if (stat.type === 'Local') for (const v of stat.vars) out.add(v.name);
    if (stat.type === 'LocalFunction') out.add(stat.name.name);
    if (stat.type === 'Block') collectLocalNames(stat, out);
    if (stat.type === 'If') {
      if (stat.thenBody.type === 'Block') collectLocalNames(stat.thenBody, out);
      if (stat.elseBody && stat.elseBody.type === 'Block') collectLocalNames(stat.elseBody, out);
    }
    if (stat.type === 'While' || stat.type === 'Repeat' || stat.type === 'For' || stat.type === 'ForIn') {
      if (stat.body.type === 'Block') collectLocalNames(stat.body, out);
    }
    if ((stat.type === 'LocalFunction' || stat.type === 'Function') && stat.func.body) {
      collectLocalNames(stat.func.body, out);
    }
  }
}

export function hoistInnerLuaTupleCalls(parsed: { root: P.BlockStat | null }): void {
  if (!parsed.root) return;
  const reserved = new Set<string>();
  collectLocalNames(parsed.root, reserved);
  visitBlock(parsed.root, alloc(reserved));
}
