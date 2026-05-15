import ts from 'typescript';
import type {
  AssignStat,
  Expr,
  FunctionStat,
  LocalStat,
  Stat,
} from '../parser/index.js';
import type { CompileContext } from './context.js';

const { factory } = ts;

/** A detected class definition. The compiler will emit a single
 *  `ts.ClassDeclaration` covering every statement in `consumed`; the
 *  caller skips those statements when building its own output. */
export interface ClassPattern {
  /** Class name. */
  name: string;
  /** Optional superclass identifier (from the metatable's `__index`). */
  superclass: string | null;
  /** Indexes (within the parent block's body) of every statement that
   *  contributes to the class — declaration, __index, .new factory,
   *  :constructor, and every :method. The block compiler skips these. */
  consumed: Set<number>;
  /** The .new factory statement (only used to harvest the constructor
   *  body if `:constructor` is missing). */
  ctorFactory: FunctionStat | null;
  /** The :constructor method statement, if any. */
  constructor: FunctionStat | null;
  /** All :method statements, in source order. */
  methods: FunctionStat[];
}

/** Walk a flat list of statements and detect class patterns. Returns the
 *  detected classes plus the union of consumed indexes (so callers can
 *  skip them in the regular pipeline). */
export function detectClasses(stmts: Stat[]): ClassPattern[] {
  const out: ClassPattern[] = [];

  for (let i = 0; i < stmts.length; i++) {
    const candidate = matchClassDeclaration(stmts, i);
    if (!candidate) continue;

    // Walk forward, collecting __index, .new, :constructor, :method
    // statements that belong to this class.
    const pattern: ClassPattern = {
      name: candidate.name,
      superclass: candidate.superclass,
      consumed: new Set([i]),
      ctorFactory: null,
      constructor: null,
      methods: [],
    };

    for (let j = i + 1; j < stmts.length; j++) {
      const s = stmts[j]!;
      if (matchIndexAssignment(s, pattern.name)) {
        pattern.consumed.add(j);
        continue;
      }
      const fnMatch = matchClassFunction(s, pattern.name);
      if (fnMatch) {
        pattern.consumed.add(j);
        if (fnMatch.kind === 'static' && fnMatch.methodName === 'new') {
          pattern.ctorFactory = s as FunctionStat;
        } else if (fnMatch.kind === 'method' && fnMatch.methodName === 'constructor') {
          pattern.constructor = s as FunctionStat;
        } else if (fnMatch.kind === 'method') {
          pattern.methods.push(s as FunctionStat);
        } else {
          // Static non-`new` method — drop into instance methods for now.
          pattern.methods.push(s as FunctionStat);
        }
        continue;
      }
      // Any non-matching statement breaks the class block.
      break;
    }

    // Require at least a `.new` factory or a `:constructor` to be confident
    // we matched a real class — bare `setmetatable({}, …)` blocks aren't
    // necessarily classes.
    if (!pattern.ctorFactory && !pattern.constructor && pattern.methods.length === 0) continue;

    out.push(pattern);
  }
  return out;
}

/** Check whether a statement is `local <Name> = setmetatable({}, <table>)`.
 *  Returns the class name + (optional) superclass identifier read from the
 *  metatable's `__index` field. */
function matchClassDeclaration(stmts: Stat[], i: number): { name: string; superclass: string | null } | null {
  const stat = stmts[i];
  if (!stat || stat.type !== 'Local') return null;
  const ls = stat as LocalStat;
  if (ls.vars.length !== 1 || ls.values.length !== 1) return null;
  const name = ls.vars[0]!.name;
  const value = ls.values[0]!;
  if (value.type !== 'Call') return null;
  const call = value as Extract<Expr, { type: 'Call' }>;
  if (call.func.type !== 'Global' || call.func.name !== 'setmetatable') return null;
  if (call.args.length < 1 || call.args[0]!.type !== 'Table') return null;

  // Optional second argument: a table literal whose `__index` field gives
  // the superclass.
  let superclass: string | null = null;
  if (call.args.length >= 2 && call.args[1]!.type === 'Table') {
    const meta = call.args[1] as Extract<Expr, { type: 'Table' }>;
    for (const item of meta.items) {
      if (item.kind !== 'Record') continue;
      const key = item.key;
      if (!key || key.type !== 'ConstantString') continue;
      if ((key as { value: string }).value !== '__index') continue;
      if (item.value.type === 'Global') superclass = (item.value as { name: string }).name;
      else if (item.value.type === 'Local') superclass = (item.value as { name: string }).name;
    }
  }
  return { name, superclass };
}

/** Match `<Class>.__index = <Class>` (or `= <Superclass>`). */
function matchIndexAssignment(stat: Stat, className: string): boolean {
  if (stat.type !== 'Assign') return false;
  const a = stat as AssignStat;
  if (a.vars.length !== 1) return false;
  const v = a.vars[0]!;
  if (v.type !== 'IndexName') return false;
  if (v.index !== '__index') return false;
  if (v.expr.type !== 'Global' && v.expr.type !== 'Local') return false;
  return (v.expr as { name: string }).name === className;
}

/** Match `function <Class>.method(...)` or `function <Class>:method(...)`. */
function matchClassFunction(
  stat: Stat,
  className: string,
): { kind: 'static' | 'method'; methodName: string } | null {
  if (stat.type !== 'Function') return null;
  const fs = stat as FunctionStat;
  // The name expr is an IndexName with `op` = '.' or ':'. We want the
  // root to be `<className>` and the index to be the method name.
  const nameExpr = fs.name;
  if (nameExpr.type !== 'IndexName') return null;
  if (nameExpr.expr.type !== 'Global' && nameExpr.expr.type !== 'Local') return null;
  if ((nameExpr.expr as { name: string }).name !== className) return null;
  const op = (nameExpr as { op?: string }).op;
  return {
    kind: op === ':' ? 'method' : 'static',
    methodName: nameExpr.index,
  };
}

/** Compile a detected class pattern into a TS `class` declaration. The
 *  returned node replaces the consumed statements in the output. */
export function compileClassPattern(
  pattern: ClassPattern,
  ctx: CompileContext,
  compileBlockBody: (body: Stat, ctx: CompileContext) => ts.Statement[],
  compileExpr: (expr: Expr, ctx: CompileContext) => ts.Expression,
): ts.ClassDeclaration {
  const members: ts.ClassElement[] = [];

  // Constructor — prefer :constructor; fall back to the .new factory body.
  const ctorFn = pattern.constructor ?? pattern.ctorFactory;
  if (ctorFn) {
    const fnExpr = ctorFn.func;
    const params = (fnExpr.args ?? []).map((a) =>
      factory.createParameterDeclaration(undefined, undefined, a.name),
    );
    const body = ctorBody(fnExpr.body, pattern, ctx, compileBlockBody, compileExpr);
    members.push(
      factory.createConstructorDeclaration(undefined, params, factory.createBlock(body, true)),
    );
  }

  // Methods.
  for (const method of pattern.methods) {
    const nameExpr = method.name;
    if (nameExpr.type !== 'IndexName') continue;
    const methodName = nameExpr.index;
    const fnExpr = method.func;
    const params = (fnExpr.args ?? []).map((a) =>
      factory.createParameterDeclaration(undefined, undefined, a.name),
    );
    const isStatic = (nameExpr as { op?: string }).op === '.';
    const modifiers = isStatic
      ? [factory.createModifier(ts.SyntaxKind.StaticKeyword)]
      : undefined;
    // Method bodies have the same `self` → `this` requirement as the
    // constructor. Rewrite once after compileBlockBody so the emitted
    // method reads `return this.x + arg` rather than `return self.x + arg`.
    const rawBody = compileBlockBody(fnExpr.body as Stat, ctx);
    const bodyStmts = rawBody.map((s) => rewriteSelfToThis(s));
    members.push(
      factory.createMethodDeclaration(
        modifiers,
        undefined,
        methodName,
        undefined,
        undefined,
        params,
        undefined,
        factory.createBlock(bodyStmts, true),
      ),
    );
  }

  // Inheritance.
  const heritage = pattern.superclass
    ? [
        factory.createHeritageClause(ts.SyntaxKind.ExtendsKeyword, [
          factory.createExpressionWithTypeArguments(
            factory.createIdentifier(pattern.superclass),
            undefined,
          ),
        ]),
      ]
    : undefined;

  return factory.createClassDeclaration(
    undefined,
    pattern.name,
    undefined,
    heritage,
    members,
  );
}

/** Compile the body of a `:constructor` or `.new` factory. The factory
 *  body typically contains `local self = setmetatable({}, Class)` and
 *  `self:constructor(...)`; we skip those bookkeeping lines and emit the
 *  rest verbatim. The constructor body itself becomes the TS constructor. */
function ctorBody(
  body: Stat,
  pattern: ClassPattern,
  ctx: CompileContext,
  compileBlockBody: (body: Stat, ctx: CompileContext) => ts.Statement[],
  compileExpr: (expr: Expr, ctx: CompileContext) => ts.Expression,
): ts.Statement[] {
  // If `:constructor` exists, use its body. Otherwise, the factory body
  // typically wraps a `self:constructor(...)` call — we inline the
  // factory body instead, keeping the user's actual init statements.
  const stmts = body.type === 'Block' ? body.body : [body];
  const filtered = stmts.filter((s) => !isClassPlumbing(s, pattern));
  let compiled = filtered.flatMap((s) => compileBlockBody(s, ctx));

  // Rewrite `self` → `this` and `Superclass.constructor(this, ...)` →
  // `super(...)` so the synthesized class body uses TS-idiomatic names.
  compiled = compiled.map((s) => rewriteSelfToThis(s));
  if (pattern.superclass) {
    compiled = compiled.map((s) => rewriteSuperCall(s, pattern.superclass!));
  }
  return compiled;
  // `compileExpr` is unused here today but kept in the signature for the
  // future where we'll inline literal field assignments as TS class fields
  // (`x: number = 0` syntax) instead of `this.x = …` constructor stmts.
  void compileExpr;
}

/** Rewrite every `Identifier('self')` reference in a TS statement to
 *  `this`. The class-shape detector copies Luau bodies that bind `self`
 *  via `self = setmetatable({}, Class)`; once we elevate the body into a
 *  TS class, every `self.X` is the synthesized `this.X`. */
function rewriteSelfToThis(stat: ts.Statement): ts.Statement {
  function visit(node: ts.Node): ts.Node {
    if (ts.isIdentifier(node) && node.text === 'self') {
      // Don't rewrite when `self` is the property name of a member
      // access — `obj.self` should stay as `obj.self`.
      // ts.isIdentifier covers both Identifier and the property-name
      // position; we use the parent check at the call site below.
      return factory.createThis();
    }
    return ts.visitEachChild(node, visit, undefined);
  }
  // Wrap so we don't rewrite property *names* (e.g. `obj.self` stays).
  function topLevel(node: ts.Node): ts.Node {
    if (ts.isPropertyAccessExpression(node)) {
      // Recurse only into the `expression` part; leave `name` alone.
      const expr = topLevel(node.expression) as ts.Expression;
      return factory.createPropertyAccessExpression(expr, node.name);
    }
    if (ts.isIdentifier(node) && node.text === 'self') {
      return factory.createThis();
    }
    return ts.visitEachChild(node, topLevel, undefined);
  }
  void visit;
  return topLevel(stat) as ts.Statement;
}

/** Statements that are pure metatable plumbing — `local self = setmetatable(...)`,
 *  `self:constructor(...)`, `return self`. Kept out of the TS constructor body. */
function isClassPlumbing(stat: Stat, pattern: ClassPattern): boolean {
  // `local self = setmetatable({}, Class)` — first line of .new factory.
  if (stat.type === 'Local') {
    const ls = stat as LocalStat;
    if (ls.vars.length === 1 && ls.vars[0]!.name === 'self' && ls.values.length === 1) {
      const v = ls.values[0]!;
      if (v.type === 'Call' && v.func.type === 'Global' && v.func.name === 'setmetatable') {
        return true;
      }
    }
  }
  // `self:constructor(...)` call — second line of .new factory.
  if (stat.type === 'Expr') {
    const e = (stat as { expr: Expr }).expr;
    if (e.type === 'Call' && e.func.type === 'IndexName') {
      const f = e.func as { expr: Expr; index: string };
      if (
        f.index === 'constructor'
        && f.expr.type === 'Local'
        && (f.expr as { name: string }).name === 'self'
      ) return true;
    }
  }
  // `return self` — last line of .new factory.
  if (stat.type === 'Return') {
    const r = stat as { values: Expr[] };
    if (r.values.length === 1) {
      const v = r.values[0]!;
      if (v.type === 'Local' && (v as { name: string }).name === 'self') return true;
    }
  }
  void pattern;
  return false;
}

/** Best-effort: rewrite any `Superclass.constructor(this, ...)` call in a
 *  TS statement to `super(...)`. */
function rewriteSuperCall(stat: ts.Statement, superclass: string): ts.Statement {
  function visit(node: ts.Node): ts.Node {
    if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression)
      && node.expression.expression.text === superclass
      && ts.isIdentifier(node.expression.name)
      && node.expression.name.text === 'constructor'
    ) {
      // Drop the first arg if it's `this` / `self` — both forms appear
      // depending on whether the self→this rewrite ran first (which
      // produces a ts.ThisExpression node, not an identifier).
      const args = node.arguments.slice();
      if (args.length > 0) {
        const first = args[0]!;
        const isThisLike =
          first.kind === ts.SyntaxKind.ThisKeyword
          || (ts.isIdentifier(first) && (first.text === 'this' || first.text === 'self'));
        if (isThisLike) args.shift();
      }
      return factory.createCallExpression(factory.createSuper(), undefined, args);
    }
    return ts.visitEachChild(node, visit, undefined);
  }
  return visit(stat) as ts.Statement;
}
