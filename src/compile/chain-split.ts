// Pre-pass that rewrites inline method-call chains into a sequence of
// `local` declarations so each step gets its own typed binding. Used by
// rbxts-mode Phase 3 so emit can resolve each WaitForChild link's class
// independently and avoid `(x as Y).WaitForChild('Z') as W` chains.
//
// Concretely:
//   local cashValue = Players.LocalPlayer:WaitForChild("leaderstats"):WaitForChild("Cash")
// becomes:
//   local player = Players.LocalPlayer
//   local leaderstats = player:WaitForChild("leaderstats")
//   local cashValue = leaderstats:WaitForChild("Cash")
//
// Only fires when:
//  - rbxts mode
//  - LocalStat has exactly one var and one value
//  - the value's outermost is a 2+ -link Instance-navigation chain
//    (WaitForChild / FindFirstChild / colon-method on .LocalPlayer)
//
// The pre-pass mutates parsed.root.body in place.

import type * as P from '../parser/index.js';

const NAV_METHODS = new Set([
  'WaitForChild', 'FindFirstChild', 'FindFirstChildOfClass',
  'FindFirstChildWhichIsA', 'FindFirstAncestorOfClass',
  'FindFirstAncestorWhichIsA', 'FindFirstAncestor', 'FindFirstDescendant',
]);

function isNavCall(expr: P.Expr): expr is P.CallExpr {
  return expr.type === 'Call'
    && expr.self
    && expr.func.type === 'IndexName'
    && NAV_METHODS.has(expr.func.index);
}

function isLocalPlayerAccess(expr: P.Expr): boolean {
  return expr.type === 'IndexName' && expr.index === 'LocalPlayer';
}

function depth(expr: P.Expr): number {
  if (isNavCall(expr)) {
    return 1 + depth((expr.func as P.IndexNameExpr).expr);
  }
  if (isLocalPlayerAccess(expr)) {
    return 1; // LocalPlayer link counts
  }
  return 0;
}

function literalNameFromCall(call: P.CallExpr): string | undefined {
  const arg = call.args[0];
  if (arg?.type === 'ConstantString') return arg.value;
  return undefined;
}

function camelCase(s: string): string {
  if (!s) return s;
  return s[0]!.toLowerCase() + s.slice(1);
}

function isIdentifierLike(s: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(s);
}

interface NameAllocator {
  fresh(base: string): string;
}

function allocator(reserved: Set<string>): NameAllocator {
  const taken = new Set(reserved);
  return {
    fresh(base) {
      if (!taken.has(base)) {
        taken.add(base);
        return base;
      }
      let i = 2;
      while (taken.has(`${base}${i}`)) i += 1;
      const n = `${base}${i}`;
      taken.add(n);
      return n;
    },
  };
}

interface SplitOutput {
  newLocals: P.LocalStat[];
  finalExpr: P.Expr;
}

function makeLocal(name: string, value: P.Expr): P.LocalStat {
  return {
    type: 'Local',
    vars: [{ name, annotation: null, location: emptyLoc(), nameLocation: emptyLoc() } as unknown as P.LocalStat['vars'][number]],
    values: [value],
    // chain-split locals are synthesized references to interior chain
    // links — never reassigned by definition.
    isConst: true,
    loc: emptyLoc(),
  } as unknown as P.LocalStat;
}

function emptyLoc(): P.Loc {
  return {
    start: { line: 0, col: 0 },
    end: { line: 0, col: 0 },
  } as unknown as P.Loc;
}

function makeLocalRef(name: string): P.Expr {
  return { type: 'Local', name, upvalue: false, loc: emptyLoc() } as unknown as P.Expr;
}

function trySplitNavChain(
  expr: P.Expr,
  bindName: string,
  alloc: NameAllocator,
): SplitOutput | null {
  if (!isNavCall(expr) || depth(expr) < 2) return null;
  // Walk inward, collecting (linkExpr, suggestedName) bottom-up.
  type Link =
    | { fn: 'navCall'; method: string; arg0Literal: string | undefined; rawCall: P.CallExpr }
    | { fn: 'localPlayer'; raw: P.IndexNameExpr };
  const links: Link[] = [];
  let cur: P.Expr = expr;
  while (true) {
    if (isNavCall(cur)) {
      const call = cur;
      const fn = call.func as P.IndexNameExpr;
      links.unshift({ fn: 'navCall', method: fn.index, arg0Literal: literalNameFromCall(call), rawCall: call });
      cur = fn.expr;
    } else if (isLocalPlayerAccess(cur)) {
      links.unshift({ fn: 'localPlayer', raw: cur as P.IndexNameExpr });
      cur = (cur as P.IndexNameExpr).expr;
      break;
    } else {
      break;
    }
  }
  const base = cur;
  // Materialize each link in order. The final link uses bindName.
  const newLocals: P.LocalStat[] = [];
  let prev: P.Expr = base;
  for (let i = 0; i < links.length; i += 1) {
    const link = links[i]!;
    const isLast = i === links.length - 1;
    let linkExpr: P.Expr;
    let suggestedName: string;
    if (link.fn === 'localPlayer') {
      // `.LocalPlayer` access (with `!` non-null assertion synthesized at emit time
      // via a TypeAssertion-on-call wrapper or codegen hint; here we just bind it).
      linkExpr = {
        type: 'IndexName',
        expr: prev,
        index: 'LocalPlayer',
        op: '.',
        loc: emptyLoc(),
      } as unknown as P.Expr;
      // Wrap in marker so emit knows to append `!`.
      linkExpr = wrapLocalPlayerNonNull(linkExpr);
      suggestedName = 'player';
    } else {
      // navCall — rebuild the call with the rewired receiver.
      const newFunc: P.IndexNameExpr = {
        ...(link.rawCall.func as P.IndexNameExpr),
        expr: prev,
      };
      linkExpr = {
        ...link.rawCall,
        func: newFunc,
      } as P.CallExpr;
      // Intermediate chain links: mark so the loose-method cast site at
      // compileCall skips the `as Folder` / `as IntValue` narrowing.
      // The intermediate is used only as a receiver for the next link's
      // navigation method, which accepts Instance anyway.
      if (!isLast) {
        (linkExpr as unknown as { __chainIntermediate?: boolean }).__chainIntermediate = true;
      }
      const argName = link.arg0Literal;
      suggestedName = argName && isIdentifierLike(argName) ? camelCase(argName) : 'child';
    }
    if (isLast) {
      // The original LocalStat consumes this expression — caller substitutes.
      prev = linkExpr;
      break;
    }
    const localName = alloc.fresh(suggestedName);
    newLocals.push(makeLocal(localName, linkExpr));
    prev = makeLocalRef(localName);
  }
  void bindName; // unused for now; bindName is taken by the caller's LocalStat
  return { newLocals, finalExpr: prev };
}

// Sentinel marker for `LocalPlayer!` — wrap as a TypeAssertion-like node so
// codegen knows to emit a non-null `!`. Implemented as an IndexName with a
// magic '__luau2ts_nonnull__' tag inside the parser-shaped record.
function wrapLocalPlayerNonNull(expr: P.Expr): P.Expr {
  (expr as unknown as { __nonnull?: boolean }).__nonnull = true;
  return expr;
}

export function splitInstanceChains(parsed: { root: P.BlockStat | null }): void {
  if (!parsed.root) return;
  const reserved = new Set<string>();
  collectLocalNames(parsed.root, reserved);
  const alloc = allocator(reserved);

  function rewriteBlock(block: P.BlockStat): void {
    const out: P.Stat[] = [];
    for (const stat of block.body) {
      walkStat(stat);
      if (
        stat.type === 'Local'
        && stat.vars.length === 1
        && stat.values.length === 1
      ) {
        const val = stat.values[0]!;
        const split = trySplitNavChain(val, stat.vars[0]!.name, alloc);
        if (split) {
          out.push(...split.newLocals);
          out.push({
            ...stat,
            values: [split.finalExpr],
          });
          continue;
        }
      }
      out.push(stat);
    }
    block.body = out;
  }

  function walkStat(stat: P.Stat): void {
    if (stat.type === 'Block') rewriteBlock(stat);
    if (stat.type === 'If') {
      if (stat.thenBody.type === 'Block') rewriteBlock(stat.thenBody);
      else walkStat(stat.thenBody);
      if (stat.elseBody) {
        if (stat.elseBody.type === 'Block') rewriteBlock(stat.elseBody);
        else walkStat(stat.elseBody);
      }
    }
    if (stat.type === 'While' || stat.type === 'Repeat' || stat.type === 'For' || stat.type === 'ForIn') {
      if (stat.body.type === 'Block') rewriteBlock(stat.body);
      else walkStat(stat.body);
    }
    if (stat.type === 'LocalFunction' || stat.type === 'Function') {
      if (stat.func.body) rewriteBlock(stat.func.body);
    }
  }
  rewriteBlock(parsed.root);
}

function collectLocalNames(block: P.BlockStat, out: Set<string>): void {
  for (const stat of block.body) {
    if (stat.type === 'Local') {
      for (const v of stat.vars) out.add(v.name);
    }
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
