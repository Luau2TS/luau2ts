// Cross-script call-site collector. For each parsed script in the
// corpus, walks the AST collecting `<requireBoundLocal>.<member>(args)`
// call patterns. The aggregated set lets the index promote members
// observed as callable in any consuming script — fixing the
// `M.X = signal.new()` pattern where the local analysis sees a
// property but downstream code treats it as a method.
//
// Same shape as param-backprop's per-module call walk, lifted to cross-
// script scope. Conservative on what counts as a "require-bound local":
// only direct `local M = require(...)` bindings, not reassigned or
// passed-through identifiers — false positives here would promote a
// property to a method that then crashes at runtime, which is worse
// than leaving the cast in place.

import type { BlockStat, Expr, Stat } from '../../parser/index.js';
import { resolveRequirePath } from '../require-infer.js';

export interface CrossScriptCallSite {
  calleeCorpusPath: string;
  memberName: string;
  /** Number of args at the call site. Currently unused by promotion
   *  logic, kept here so a future Pass C (arg-type intersection) can
   *  align positional args without re-walking. */
  argCount: number;
}

/** Walk a parsed module body, gather every member call against a
 *  require-bound local, and resolve the callee module's corpus path. */
export function collectCrossScriptCallSites(
  root: BlockStat,
  currentScriptPath: string,
): CrossScriptCallSite[] {
  const requireBound = new Map<string, string>();
  collectRequireBoundLocals(root, currentScriptPath, requireBound);
  if (requireBound.size === 0) return [];

  const out: CrossScriptCallSite[] = [];
  walkExpr(root as unknown as Expr, (e) => {
    if (e.type !== 'Call') return;
    const fn = e.func;
    if (fn.type !== 'IndexName' || fn.expr.type !== 'Local') return;
    const path = requireBound.get(fn.expr.name);
    if (!path) return;
    out.push({
      calleeCorpusPath: path,
      memberName: fn.index,
      argCount: e.args.length,
    });
  });
  return out;
}

/** Scan top-level locals and resolve every `local X = require(...)`
 *  binding. Stays at top-level — nested-scope rebindings would shadow
 *  but we'd lose the corpus-path key. Most modules bind their requires
 *  at top level so this catches the common case. */
function collectRequireBoundLocals(
  root: BlockStat,
  currentScriptPath: string,
  out: Map<string, string>,
): void {
  for (const stat of root.body) {
    if (stat.type !== 'Local') continue;
    const ls = stat as { vars: { name: string }[]; values: Expr[] };
    for (let i = 0; i < ls.vars.length; i++) {
      const init = ls.values[i];
      if (!init || init.type !== 'Call') continue;
      const call = init as Extract<Expr, { type: 'Call' }>;
      if (call.func.type !== 'Global' || (call.func as { name: string }).name !== 'require') continue;
      const arg = call.args[0];
      if (!arg) continue;
      const path = resolveRequirePath(arg, currentScriptPath);
      if (!path) continue;
      out.set(ls.vars[i]!.name, path);
    }
  }
}

/** Reuses the same opportunistic recursion shape as param-backprop:
 *  every property of the expression that looks expression-like gets
 *  visited. Cheap and correct for our purposes — we only care about
 *  Call nodes, and missing one would just lose a promotion opportunity,
 *  never produce a false promotion. */
function walkExpr(node: unknown, visit: (e: Expr) => void): void {
  if (!node || typeof node !== 'object') return;
  const t = (node as { type?: string }).type;
  if (typeof t === 'string') visit(node as Expr);
  for (const v of Object.values(node as Record<string, unknown>)) {
    if (Array.isArray(v)) for (const it of v) walkExpr(it, visit);
    else if (v && typeof v === 'object') walkExpr(v, visit);
  }
}

/** Group call sites by (callee corpus path → set of member names).
 *  Drives the property→method promotion in build-index. */
export function buildPromotionMap(
  sites: readonly CrossScriptCallSite[],
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const s of sites) {
    let set = out.get(s.calleeCorpusPath);
    if (!set) {
      set = new Set();
      out.set(s.calleeCorpusPath, set);
    }
    set.add(s.memberName);
  }
  return out;
}

/** A *Stat is allowed as the parser type. The walker treats Stat and
 *  Expr uniformly via the structural visit. */
export type RootBody = BlockStat | Stat;
