// Pass 3 of the Phase 3-finish architecture: same-script function
// parameter back-propagation. For each user-defined function with
// untyped params, walk same-script call sites, intersect the static
// type of each argument across all sites, and bind a consistent type
// as the param annotation. Cross-script call-site collection is out
// of scope per the Pass 3 spec — analysis stays per-module.
//
// The result lives in a `Map<funcName, Map<paramName, typeText>>` that
// `paramsFromLocals` consults when emitting parameter declarations.
// Conservative defaults (per the goal): a param with inconsistent or
// unresolved arg types stays untyped; only consistent class/datatype
// observations bind.

import type { BlockStat, Expr, Stat } from '../parser/index.js';
import type { ClassOracle } from './oracle/index.js';

/** Per-function, per-param inferred TS type text. */
export type ParamBackpropResult = Map<string, Map<string, string>>;

export interface ParamBackpropOutput {
  readonly types: ParamBackpropResult;
  readonly paramNames: Map<string, string[]>;
}

/** Walk `root` to find user-defined functions and their call sites in
 *  the same module. Bind a param's TS type when every call site agrees
 *  on a class/datatype for that argument position. Iterates to fixed
 *  point so types propagate through call chains
 *  (`API.X(player) → evaluate(player) → tryAwardBadge(player)`). */
export function inferParamBackprop(
  root: BlockStat,
  oracle: ClassOracle,
): ParamBackpropOutput {
  // 1. Catalog all user functions in the script.
  const funcs = new Map<string, { params: string[] }>();
  walk(root, (s) => {
    if (s.type === 'LocalFunction') {
      const lf = s as { name: { name: string }; func: { args: { name: string }[] } };
      funcs.set(lf.name.name, { params: lf.func.args.map((a) => a.name) });
    } else if (s.type === 'Function') {
      const fs = s as { name: Expr; func: { args: { name: string }[] } };
      if (fs.name.type === 'Local' || fs.name.type === 'Global') {
        funcs.set((fs.name as { name: string }).name, { params: fs.func.args.map((a) => a.name) });
      }
    } else if (s.type === 'Local') {
      const ls = s as { vars: { name: string }[]; values: Expr[] };
      for (let i = 0; i < ls.vars.length; i++) {
        const init = ls.values[i];
        if (init && init.type === 'Function') {
          funcs.set(ls.vars[i]!.name, { params: (init as { args: { name: string }[] }).args.map((a) => a.name) });
        }
      }
    }
  });

  const paramNamesOut = new Map<string, string[]>();
  for (const [n, { params }] of funcs) paramNamesOut.set(n, [...params]);
  if (funcs.size === 0) return { types: new Map(), paramNames: paramNamesOut };

  // 2. Per param position per function, accumulate observed types.
  //    `null` = saw inconsistent observations, give up on this param.
  const obs = new Map<string, (string | null | undefined)[]>();
  for (const [name, { params }] of funcs) {
    obs.set(name, params.map(() => undefined));
  }

  const intersect = (a: string | null | undefined, b: string | null): string | null => {
    if (a === undefined) return b;
    if (a === null) return null;
    if (b === null) return null;
    if (a === b) return a;
    return null;
  };

  // 3. Walk all call sites.
  walk(root, (s) => {
    walkExpr(s as unknown as Expr, (e) => {
      if (e.type !== 'Call') return;
      const fn = e.func;
      const fnName = fn.type === 'Local' || fn.type === 'Global'
        ? (fn as { name: string }).name
        : null;
      if (!fnName) return;
      const info = funcs.get(fnName);
      if (!info) return;
      const slots = obs.get(fnName)!;
      for (let i = 0; i < info.params.length; i++) {
        const arg = e.args[i];
        if (!arg) continue;
        const t = staticTypeOf(arg, oracle);
        slots[i] = intersect(slots[i], t);
      }
    });
  });
  const bound = new Map<string, Map<string, string>>();
  for (const [name, slots] of obs) {
    const info = funcs.get(name)!;
    const m = new Map<string, string>();
    for (let i = 0; i < info.params.length; i++) {
      const t = slots[i];
      if (t && t !== 'unknown') m.set(info.params[i]!, t);
    }
    bound.set(name, m);
  }

  // 4. Final result: use the post-fixed-point `bound` map directly.
  const out: ParamBackpropResult = new Map();
  for (const [name, m] of bound) {
    if (m.size > 0) out.set(name, m);
  }
  return { types: out, paramNames: paramNamesOut };
}

/** Conservative static-type oracle for a single arg expression at a
 *  call site. Returns the TS type-text string, or `null` for unresolvable.
 *  Never returns `unknown` — the caller treats null as "skip this site". */
function staticTypeOf(expr: Expr, oracle: ClassOracle): string | null {
  switch (expr.type) {
    case 'ConstantInteger':
    case 'ConstantNumber':
      return 'number';
    case 'ConstantString':
      return 'string';
    case 'ConstantBool':
      return 'boolean';
    case 'Group':
    case 'TypeAssertion':
      return staticTypeOf((expr as { expr: Expr }).expr, oracle);
    case 'Global': {
      if (expr.name === 'script' || expr.name === 'workspace') return 'Instance';
      if (oracle.isService(expr.name)) return 'Instance';
      return null;
    }
    case 'IndexName': {
      // Chain rooted in a dynamic root → Instance (Pass 1's synth types
      // intersect with Instance at every level).
      let cur: Expr = expr;
      while (cur.type === 'IndexName' && cur.op === '.') cur = cur.expr;
      if (cur.type === 'Global'
          && (cur.name === 'script' || cur.name === 'workspace' || oracle.isService(cur.name))) {
        return 'Instance';
      }
      return null;
    }
    case 'Call': {
      const c = expr as Extract<Expr, { type: 'Call' }>;
      const fn = c.func;
      // Instance.new("X") → X if X is a known class.
      if (
        fn.type === 'IndexName'
        && fn.expr.type === 'Global'
        && fn.expr.name === 'Instance'
        && fn.index === 'new'
        && c.args[0]?.type === 'ConstantString'
      ) {
        const cls = (c.args[0] as { value: string }).value;
        if (oracle.isClass(cls)) return cls;
      }
      // <Datatype>.new(...) → Datatype.
      if (
        fn.type === 'IndexName'
        && fn.expr.type === 'Global'
        && fn.index === 'new'
        && /^(Vector3|Vector2|CFrame|Color3|UDim|UDim2|BrickColor|Region3|TweenInfo|NumberRange|NumberSequence|ColorSequence|Rect|Ray|RaycastParams|OverlapParams|Random|DateTime|Faces|Axes)$/
          .test((fn.expr as { name: string }).name)
      ) {
        return (fn.expr as { name: string }).name;
      }
      // <Datatype>.fromRGB(...) etc. → Datatype.
      if (
        fn.type === 'IndexName'
        && fn.expr.type === 'Global'
        && /^from/.test(fn.index)
        && /^(Color3|CFrame|Vector3|UDim2|UDim|BrickColor)$/
          .test((fn.expr as { name: string }).name)
      ) {
        return (fn.expr as { name: string }).name;
      }
      return null;
    }
    default:
      return null;
  }
}

/** Statement walker that ignores function bodies (call sites inside
 *  nested functions belong to those functions' analysis, not the outer
 *  one). */
function walk(stat: Stat | null | undefined, visit: (s: Stat) => void): void {
  if (!stat) return;
  visit(stat);
  switch (stat.type) {
    case 'Block': {
      const b = stat as { body: Stat[] };
      for (const c of b.body) walk(c, visit);
      return;
    }
    case 'If': {
      const i = stat as { thenBody: Stat; elseBody: Stat | null };
      walk(i.thenBody, visit);
      walk(i.elseBody, visit);
      return;
    }
    case 'While':
    case 'Repeat':
    case 'For':
    case 'ForIn':
      walk((stat as { body: Stat }).body, visit);
      return;
    default:
      return;
  }
}

/** Recursive expr walker. Recurses into all sub-expressions. */
function walkExpr(node: unknown, visit: (e: Expr) => void): void {
  if (!node || typeof node !== 'object') return;
  const t = (node as { type?: string }).type;
  if (typeof t === 'string') {
    visit(node as Expr);
  }
  for (const v of Object.values(node as Record<string, unknown>)) {
    if (Array.isArray(v)) for (const it of v) walkExpr(it, visit);
    else if (v && typeof v === 'object') walkExpr(v, visit);
  }
}
