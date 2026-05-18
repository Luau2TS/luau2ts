// Forward flow pass: assigns a FlowFact to expressions the codegen
// cares about (per-local last-assigned type, per-Call resolved class
// receiver). Result is a WeakMap<Expr, FlowFact> on CompileContext.

import type { CompileContext } from './context.js';
import type * as P from '../parser/index.js';

export type FlowFact =
  | { kind: 'class'; name: string; nullable?: boolean }
  | { kind: 'datatype'; name: string }
  | { kind: 'array'; element: FlowFact }
  | { kind: 'primitive'; name: 'number' | 'string' | 'boolean' }
  | { kind: 'unknown' };

interface Env {
  scope: Map<string, FlowFact>;
  parent?: Env;
}

function lookup(env: Env | undefined, name: string): FlowFact | undefined {
  for (let e: Env | undefined = env; e; e = e.parent) {
    const v = e.scope.get(name);
    if (v) return v;
  }
  return undefined;
}

function setInExistingScope(env: Env, name: string, fact: FlowFact): boolean {
  for (let e: Env | undefined = env; e; e = e.parent) {
    if (e.scope.has(name)) {
      e.scope.set(name, fact);
      return true;
    }
  }
  return false;
}

function stringLit(e: P.Expr | undefined): string | undefined {
  if (!e) return undefined;
  if (e.type === 'ConstantString') return e.value;
  if (e.type === 'Group') return stringLit(e.expr);
  return undefined;
}

function oracleTypeToFact(type: ReturnType<CompileContext['oracle']['propertyType']>): FlowFact {
  if (!type) return { kind: 'unknown' };
  if (type.kind === 'class') {
    return type.nullable
      ? { kind: 'class', name: type.name, nullable: true }
      : { kind: 'class', name: type.name };
  }
  if (type.kind === 'primitive' && type.name !== 'unknown') {
    return { kind: 'primitive', name: type.name };
  }
  if (type.kind === 'array') {
    return { kind: 'array', element: oracleTypeToFact(type.element) };
  }
  return { kind: 'unknown' };
}

/** Gap 1: collect local-name → narrowed class FlowFact from a type-guard
 *  conditional. Supported forms:
 *    - `x:IsA("ClassName")`
 *    - `typeof(x) == "Instance"` (narrows to Instance)
 *    - logical-AND chains of the above.
 *  Returns an empty map when the condition isn't a recognized guard. */
function collectTypeGuardNarrowings(expr: P.Expr, ctx: CompileContext): Map<string, FlowFact> {
  const out = new Map<string, FlowFact>();
  const visit = (e: P.Expr): void => {
    switch (e.type) {
      case 'Group':
        visit(e.expr);
        return;
      case 'Binary': {
        // `A and B` → both narrowings apply in the truthy branch.
        if (e.op === 'and') {
          visit(e.left);
          visit(e.right);
        }
        // `typeof(x) == "Class"` form.
        if (e.op === '==') {
          const leftCall = e.left.type === 'Call' ? e.left : null;
          const rightStr = stringLit(e.right);
          if (leftCall && rightStr && leftCall.func.type === 'Global' && leftCall.func.name === 'typeof' && leftCall.args.length === 1) {
            const arg = leftCall.args[0]!;
            if (arg.type === 'Local' && ctx.oracle.isClass(rightStr)) {
              out.set(arg.name, { kind: 'class', name: rightStr });
            }
          }
        }
        return;
      }
      case 'Call': {
        // `x:IsA("ClassName")` pattern: self-call, func is IndexName(x, 'IsA'),
        // arg[0] is a constant string naming a known class.
        if (
          e.self
          && e.func.type === 'IndexName'
          && (e.func.index === 'IsA' || e.func.index === 'IsDescendantOf')
          && e.func.expr.type === 'Local'
          && e.args.length === 1
        ) {
          const className = stringLit(e.args[0]);
          if (e.func.index === 'IsA' && className && ctx.oracle.isClass(className)) {
            out.set(e.func.expr.name, { kind: 'class', name: className });
          }
        }
        return;
      }
      default:
        return;
    }
  };
  visit(expr);
  return out;
}

function expressionFact(
  expr: P.Expr,
  env: Env,
  ctx: CompileContext,
  factMap: WeakMap<object, FlowFact>,
): FlowFact {
  const cached = factMap.get(expr);
  if (cached) return cached;
  const out = computeExpressionFact(expr, env, ctx, factMap);
  factMap.set(expr, out);
  return out;
}

function computeExpressionFact(
  expr: P.Expr,
  env: Env,
  ctx: CompileContext,
  factMap: WeakMap<object, FlowFact>,
): FlowFact {
  switch (expr.type) {
    case 'Group':
      return expressionFact(expr.expr, env, ctx, factMap);
    case 'ConstantString':
      return { kind: 'primitive', name: 'string' };
    case 'ConstantNumber':
    case 'ConstantInteger':
      return { kind: 'primitive', name: 'number' };
    case 'ConstantBool':
      return { kind: 'primitive', name: 'boolean' };
    case 'Global': {
      const name = expr.name;
      if (ctx.oracle.isService(name)) {
        return { kind: 'class', name };
      }
      const local = lookup(env, name);
      if (local) return local;
      return { kind: 'unknown' };
    }
    case 'Local': {
      const local = lookup(env, expr.name);
      if (local) return local;
      return { kind: 'unknown' };
    }
    case 'IndexName': {
      const receiverFact = expressionFact(expr.expr, env, ctx, factMap);
      const prop = expr.index;
      if (receiverFact.kind === 'class') {
        const oracleType = ctx.oracle.propertyType(receiverFact.name, prop);
        if (oracleType) return oracleTypeToFact(oracleType);
      }
      return { kind: 'unknown' };
    }
    case 'Call': {
      return computeCallFact(expr, env, ctx, factMap);
    }
    case 'Binary': {
      const op = expr.op;
      if (op === '..') return { kind: 'primitive', name: 'string' };
      if (op === '+' || op === '-' || op === '*' || op === '/' || op === '%' || op === '^' || op === '//') {
        return { kind: 'primitive', name: 'number' };
      }
      if (op === '==' || op === '~=' || op === '<' || op === '>' || op === '<=' || op === '>=') {
        return { kind: 'primitive', name: 'boolean' };
      }
      if (op === 'and' || op === 'or') {
        return { kind: 'unknown' };
      }
      return { kind: 'unknown' };
    }
    case 'Unary': {
      if (expr.op === 'not') return { kind: 'primitive', name: 'boolean' };
      if (expr.op === '-') return { kind: 'primitive', name: 'number' };
      if (expr.op === '#') return { kind: 'primitive', name: 'number' };
      return { kind: 'unknown' };
    }
    default:
      return { kind: 'unknown' };
  }
}

function computeCallFact(
  call: P.CallExpr,
  env: Env,
  ctx: CompileContext,
  factMap: WeakMap<object, FlowFact>,
): FlowFact {
  const fn = call.func;
  if (fn.type === 'IndexName') {
    const recv = fn.expr;
    const method = fn.index;
    const recvFact = expressionFact(recv, env, ctx, factMap);
    if (method === 'GetService') {
      const name = stringLit(call.args[0]);
      if (name && ctx.oracle.isService(name)) return { kind: 'class', name };
    }
    if (method === 'GetChildren' || method === 'GetDescendants') {
      return { kind: 'array', element: { kind: 'class', name: 'Instance' } };
    }
    if (method === 'WaitForChild' || method === 'FindFirstChild') {
      const literal = stringLit(call.args[0]);
      const named = literal ? ctx.oracle.childNameClass(literal) : undefined;
      if (named) return { kind: 'class', name: named, nullable: method === 'FindFirstChild' };
      if (recvFact.kind !== 'class') {
        return { kind: 'class', name: 'Instance', nullable: method === 'FindFirstChild' };
      }
    }
    if (recvFact.kind === 'class') {
      if (method === 'FindFirstChildOfClass' || method === 'FindFirstAncestorOfClass') {
        const cls = stringLit(call.args[0]);
        if (cls && ctx.oracle.isClass(cls)) return { kind: 'class', name: cls, nullable: true };
        return { kind: 'class', name: 'Instance', nullable: true };
      }
      if (method === 'WaitForChild') {
        const literal = stringLit(call.args[0]);
        const r = ctx.oracle.waitForChildResult(recvFact.name, literal, call.args.length === 1 ? 1 : 2);
        return { kind: 'class', name: r.type, nullable: r.nullable };
      }
      if (method === 'FindFirstChild') {
        const literal = stringLit(call.args[0]);
        const r = ctx.oracle.findFirstChildResult(recvFact.name, literal);
        return { kind: 'class', name: r.type, nullable: r.nullable };
      }
      const ret = ctx.oracle.methodReturnType(recvFact.name, method, call.args.length);
      if (ret) return oracleTypeToFact(ret);
    }
    // string.X single-string-returning helpers.
    if (recv.type === 'Global' && recv.name === 'string') {
      const stringReturning = new Set(['reverse', 'upper', 'lower', 'rep', 'sub', 'format', 'char']);
      if (stringReturning.has(method)) return { kind: 'primitive', name: 'string' };
      const numberReturning = new Set(['len', 'byte']);
      if (numberReturning.has(method)) return { kind: 'primitive', name: 'number' };
    }
    if (recv.type === 'Global' && recv.name === 'math') {
      const numberReturning = new Set(['floor', 'ceil', 'abs', 'sqrt', 'min', 'max', 'pow', 'log', 'exp', 'random', 'randomseed', 'sin', 'cos', 'tan', 'atan', 'atan2', 'asin', 'acos', 'rad', 'deg', 'sign', 'fmod', 'modf', 'clamp', 'huge', 'pi']);
      if (numberReturning.has(method)) return { kind: 'primitive', name: 'number' };
    }
  }
  if (fn.type === 'Global') {
    if (fn.name === 'tostring') return { kind: 'primitive', name: 'string' };
    if (fn.name === 'tonumber') return { kind: 'primitive', name: 'number' };
    if (fn.name === 'type') return { kind: 'primitive', name: 'string' };
  }
  return { kind: 'unknown' };
}

function observeExpression(
  expr: P.Expr | undefined,
  env: Env,
  ctx: CompileContext,
  facts: WeakMap<object, FlowFact>,
): void {
  if (!expr) return;
  expressionFact(expr, env, ctx, facts);
  switch (expr.type) {
    case 'Call':
      observeExpression(expr.func, env, ctx, facts);
      for (const arg of expr.args) observeExpression(arg, env, ctx, facts);
      return;
    case 'IndexName':
      observeExpression(expr.expr, env, ctx, facts);
      return;
    case 'IndexExpr':
      observeExpression(expr.expr, env, ctx, facts);
      observeExpression(expr.index, env, ctx, facts);
      return;
    case 'Binary':
      observeExpression(expr.left, env, ctx, facts);
      observeExpression(expr.right, env, ctx, facts);
      return;
    case 'Unary':
    case 'Group':
    case 'TypeAssertion':
      observeExpression(expr.expr, env, ctx, facts);
      return;
    case 'IfElse':
      observeExpression(expr.condition, env, ctx, facts);
      observeExpression(expr.trueExpr, env, ctx, facts);
      observeExpression(expr.falseExpr, env, ctx, facts);
      return;
    case 'Table':
      for (const item of expr.items) {
        if (item.key) observeExpression(item.key, env, ctx, facts);
        observeExpression(item.value, env, ctx, facts);
      }
      return;
    default:
      return;
  }
}

export interface FlowResult {
  facts: WeakMap<object, FlowFact>;
  localFinalFacts: Map<string, FlowFact>;
}

function visitBlock(
  block: P.BlockStat,
  env: Env,
  ctx: CompileContext,
  facts: WeakMap<object, FlowFact>,
  localFinalFacts: Map<string, FlowFact>,
): void {
  for (const stat of block.body) {
    visitStat(stat, env, ctx, facts, localFinalFacts);
  }
}

function visitStat(
  stat: P.Stat,
  env: Env,
  ctx: CompileContext,
  facts: WeakMap<object, FlowFact>,
  localFinalFacts: Map<string, FlowFact>,
): void {
  switch (stat.type) {
    case 'Local': {
      for (let i = 0; i < stat.vars.length; i += 1) {
        const v = stat.vars[i]!;
        const fact = stat.values[i]
          ? expressionFact(stat.values[i]!, env, ctx, facts)
          : { kind: 'unknown' as const };
        env.scope.set(v.name, fact);
        localFinalFacts.set(v.name, fact);
      }
      for (const value of stat.values) observeExpression(value, env, ctx, facts);
      return;
    }
    case 'LocalFunction': {
      env.scope.set(stat.name.name, { kind: 'unknown' });
      const inner: Env = { scope: new Map(), parent: env };
      // walk through param locals
      for (const local of stat.func.args ?? []) {
        if (local && typeof local === 'object' && 'name' in local) {
          inner.scope.set((local as { name: string }).name, { kind: 'unknown' });
        }
      }
      if (stat.func.body) visitBlock(stat.func.body, inner, ctx, facts, localFinalFacts);
      return;
    }
    case 'Function': {
      const inner: Env = { scope: new Map(), parent: env };
      for (const local of stat.func.args ?? []) {
        if (local && typeof local === 'object' && 'name' in local) {
          inner.scope.set((local as { name: string }).name, { kind: 'unknown' });
        }
      }
      if (stat.func.body) visitBlock(stat.func.body, inner, ctx, facts, localFinalFacts);
      return;
    }
    case 'Assign': {
      for (let i = 0; i < stat.vars.length; i += 1) {
        const target = stat.vars[i]!;
        const fact = stat.values[i]
          ? expressionFact(stat.values[i]!, env, ctx, facts)
          : { kind: 'unknown' as const };
        if (target.type === 'Local') {
          if (!setInExistingScope(env, target.name, fact)) env.scope.set(target.name, fact);
        }
      }
      for (const value of stat.values) observeExpression(value, env, ctx, facts);
      for (const target of stat.vars) observeExpression(target, env, ctx, facts);
      return;
    }
    case 'Expr':
      observeExpression(stat.expr, env, ctx, facts);
      return;
    case 'Return':
      for (const value of stat.values) observeExpression(value, env, ctx, facts);
      return;
    case 'CompoundAssign':
      observeExpression(stat.var, env, ctx, facts);
      observeExpression(stat.value, env, ctx, facts);
      return;
    case 'If': {
      observeExpression(stat.condition, env, ctx, facts);
      // Gap 1: flow-narrow on type guards like `x:IsA("Player")`. The
      // truthy branch knows x is the named class; mirror that as a
      // FlowFact for the inner scope.
      const guardNarrowings = collectTypeGuardNarrowings(stat.condition, ctx);
      if (stat.thenBody.type === 'Block') {
        const inner: Env = { scope: new Map(), parent: env };
        for (const [name, fact] of guardNarrowings) inner.scope.set(name, fact);
        visitBlock(stat.thenBody, inner, ctx, facts, localFinalFacts);
      } else {
        visitStat(stat.thenBody, env, ctx, facts, localFinalFacts);
      }
      if (stat.elseBody) {
        if (stat.elseBody.type === 'Block') {
          const inner: Env = { scope: new Map(), parent: env };
          visitBlock(stat.elseBody, inner, ctx, facts, localFinalFacts);
        } else {
          visitStat(stat.elseBody, env, ctx, facts, localFinalFacts);
        }
      }
      return;
    }
    case 'While':
    case 'Repeat': {
      observeExpression(stat.condition, env, ctx, facts);
      const inner: Env = { scope: new Map(), parent: env };
      if (stat.body.type === 'Block') {
        visitBlock(stat.body, inner, ctx, facts, localFinalFacts);
      } else {
        visitStat(stat.body, inner, ctx, facts, localFinalFacts);
      }
      return;
    }
    case 'For': {
      observeExpression(stat.from, env, ctx, facts);
      observeExpression(stat.to, env, ctx, facts);
      if (stat.step) observeExpression(stat.step, env, ctx, facts);
      const inner: Env = { scope: new Map(), parent: env };
      inner.scope.set(stat.var.name, { kind: 'primitive', name: 'number' });
      if (stat.body.type === 'Block') visitBlock(stat.body, inner, ctx, facts, localFinalFacts);
      else visitStat(stat.body, inner, ctx, facts, localFinalFacts);
      return;
    }
    case 'ForIn': {
      const inner: Env = { scope: new Map(), parent: env };
      let iterableFact: FlowFact = { kind: 'unknown' };
      if (stat.values.length === 1) {
        const value = stat.values[0]!;
        if (
          value.type === 'Call'
          && value.func.type === 'Global'
          && (value.func.name === 'ipairs' || value.func.name === 'pairs')
          && value.args.length === 1
        ) {
          iterableFact = expressionFact(value.args[0]!, env, ctx, facts);
        } else {
          iterableFact = expressionFact(value, env, ctx, facts);
        }
      }
      for (const value of stat.values) observeExpression(value, env, ctx, facts);
      for (let i = 0; i < stat.vars.length; i += 1) {
        const v = stat.vars[i]!;
        if (iterableFact.kind === 'array') {
          inner.scope.set(v.name, stat.vars.length === 1 || i === 1
            ? iterableFact.element
            : { kind: 'primitive', name: 'number' });
        } else {
          inner.scope.set(v.name, { kind: 'unknown' });
        }
      }
      if (stat.body.type === 'Block') visitBlock(stat.body, inner, ctx, facts, localFinalFacts);
      else visitStat(stat.body, inner, ctx, facts, localFinalFacts);
      return;
    }
    case 'Block': {
      const inner: Env = { scope: new Map(), parent: env };
      visitBlock(stat, inner, ctx, facts, localFinalFacts);
      return;
    }
    default:
      return;
  }
}

export function runFlowPass(root: P.BlockStat, ctx: CompileContext): FlowResult {
  const facts = new WeakMap<object, FlowFact>();
  const localFinalFacts = new Map<string, FlowFact>();
  const env: Env = { scope: new Map() };
  visitBlock(root, env, ctx, facts, localFinalFacts);
  return { facts, localFinalFacts };
}
