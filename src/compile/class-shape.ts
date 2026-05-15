import ts from 'typescript';
import type {
  AssignStat,
  Expr,
  FunctionStat,
  GenericType,
  GenericTypePack,
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
  /** True if a `type <Name>` (or `export type <Name>`) alias matching
   *  the class name was found and consumed. The class emit drops the
   *  alias so TS doesn't error on the merged declaration. */
  consumedTypeAlias: boolean;
  /** True if the consumed type alias was `export`ed. The class emit
   *  picks up the same modifier so the public type stays exported. */
  exported: boolean;
  /** Generic type parameters and generic-packs harvested from the
   *  consumed type alias. The class declaration carries them so
   *  references like `Signal<T...>` elsewhere still resolve. */
  generics: GenericType[];
  genericPacks: GenericTypePack[];
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
      consumedTypeAlias: false,
      exported: false,
      generics: [],
      genericPacks: [],
    };

    for (let j = i + 1; j < stmts.length; j++) {
      const s = stmts[j]!;
      // Stop if we hit another class declaration — that's a sibling, not
      // a continuation of this one. Real Luau modules interleave class
      // methods with free helper functions and top-level locals; we keep
      // scanning past those so a `local emit = …` between methods
      // doesn't truncate the class.
      if (j !== i && matchClassDeclaration(stmts, j)) break;

      const idxMatch = matchIndexAssignment(s, pattern.name);
      if (idxMatch) {
        pattern.consumed.add(j);
        // `<Name>.__index = <Other>` (Other != Name) marks the superclass.
        // Self-assigning (`__index = <Name>`) is just prototype bookkeeping.
        if (idxMatch.rhsName && idxMatch.rhsName !== pattern.name && !pattern.superclass) {
          pattern.superclass = idxMatch.rhsName;
        }
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
      // Non-matching statement — leave it in place and keep scanning.
    }

    // Require at least a `.new` factory or a `:constructor` to be confident
    // we matched a real class — bare `setmetatable({}, …)` blocks aren't
    // necessarily classes.
    if (!pattern.ctorFactory && !pattern.constructor && pattern.methods.length === 0) continue;

    // Scan the whole block for a `type <Name>` (or `export type <Name>`)
    // alias matching the class. TS errors on a `class Signal` declared
    // next to a `type Signal = ...` alias (merged-declaration visibility
    // mismatch). Consume the alias and inherit its `export` modifier.
    for (let k = 0; k < stmts.length; k++) {
      const s = stmts[k];
      if (!s || s.type !== 'TypeAlias') continue;
      const ta = s as {
        name: string;
        exported: boolean;
        generics?: GenericType[];
        genericPacks?: GenericTypePack[];
      };
      if (ta.name !== pattern.name) continue;
      pattern.consumed.add(k);
      pattern.consumedTypeAlias = true;
      if (ta.exported) pattern.exported = true;
      // First matching alias wins for the generic shape — multiple aliases
      // with the same name is a Luau error already, so we don't merge.
      if (pattern.generics.length === 0 && pattern.genericPacks.length === 0) {
        pattern.generics = ta.generics ?? [];
        pattern.genericPacks = ta.genericPacks ?? [];
      }
    }

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

  // Pattern A — `local <Name> = setmetatable({}, {__index = Super})`.
  // The classic Luau OOP idiom; superclass falls out of the metatable.
  if (value.type === 'Call') {
    const call = value as Extract<Expr, { type: 'Call' }>;
    if (call.func.type !== 'Global' || call.func.name !== 'setmetatable') return null;
    if (call.args.length < 1 || call.args[0]!.type !== 'Table') return null;
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

  // Pattern B — `local <Name> = {} :: <ImplType>` or plain `local <Name> = {}`.
  // The "impl-table" idiom: the class table starts empty (often annotated
  // with its method-bearing impl type), methods get attached via
  // `function <Name>:foo() ... end`, and the actual setmetatable lives
  // inside `<Name>.new`. Superclass — if any — is recovered later from a
  // separate `<Name>.__index = <Super>` assignment.
  const inner = value.type === 'TypeAssertion'
    ? (value as { expr: Expr }).expr
    : value;
  if (inner.type === 'Table' && (inner as { items: unknown[] }).items.length === 0) {
    return { name, superclass: null };
  }
  return null;
}

/** Match `<Class>.__index = <Class>` (or `= <Superclass>`). Returns the
 *  RHS identifier name if it's a Global/Local reference, so callers can
 *  detect superclass-via-`__index` assignments. Returns null if the
 *  statement doesn't match the shape. */
function matchIndexAssignment(stat: Stat, className: string): { rhsName: string | null } | null {
  if (stat.type !== 'Assign') return null;
  const a = stat as AssignStat;
  if (a.vars.length !== 1 || a.values.length !== 1) return null;
  const v = a.vars[0]!;
  if (v.type !== 'IndexName') return null;
  if (v.index !== '__index') return null;
  if (v.expr.type !== 'Global' && v.expr.type !== 'Local') return null;
  if ((v.expr as { name: string }).name !== className) return null;
  const rhs = a.values[0]!;
  const rhsName = (rhs.type === 'Global' || rhs.type === 'Local')
    ? (rhs as { name: string }).name
    : null;
  return { rhsName };
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

  // Field declarations + initializers from the `.new` factory's
  // setmetatable init. Source patterns like
  //     local self = setmetatable({ name = name or "X", _y = 0 }, Class)
  // become class fields plus `this.name = name ?? "X"`-style assignments
  // at the start of the constructor body. We can't emit them as class-
  // body initializers (`name = name ?? "X"`) because field initializers
  // run in class-body scope where the constructor's `name` parameter
  // isn't visible — the bare `name` would self-reference the field. So
  // declare the field unannotated/uninitialized here, and emit the
  // assignment inside the constructor below.
  const fieldNames = new Set<string>();
  const fieldInitStmts: ts.Statement[] = [];
  if (pattern.ctorFactory) {
    const init = findSetmetatableInit(pattern.ctorFactory.func.body, pattern.name);
    if (init) {
      for (const item of init.items) {
        if (item.kind !== 'Record') continue;
        const key = item.key;
        if (!key || key.type !== 'ConstantString') continue;
        const fieldName = (key as { value: string }).value;
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(fieldName)) continue;
        if (fieldNames.has(fieldName)) continue;
        fieldNames.add(fieldName);
        members.push(
          factory.createPropertyDeclaration(
            undefined,
            factory.createIdentifier(fieldName),
            undefined,
            factory.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword),
            undefined,
          ),
        );
        let initializer: ts.Expression;
        try {
          initializer = compileExpr(item.value, ctx);
        } catch {
          initializer = factory.createIdentifier('undefined');
        }
        fieldInitStmts.push(
          factory.createExpressionStatement(
            factory.createAssignment(
              factory.createPropertyAccessExpression(
                factory.createThis(),
                factory.createIdentifier(fieldName),
              ),
              initializer,
            ),
          ),
        );
      }
    }
  }

  // Constructor — prefer :constructor; fall back to the .new factory body.
  const ctorFn = pattern.constructor ?? pattern.ctorFactory;
  if (ctorFn) {
    const fnExpr = ctorFn.func;
    const params = (fnExpr.args ?? []).map((a) =>
      factory.createParameterDeclaration(undefined, undefined, a.name),
    );
    const body = ctorBody(fnExpr.body, pattern, ctx, compileBlockBody, compileExpr);
    // Prepend the harvested field-init statements so constructor params
    // are in scope when their values flow into `this.X`.
    members.push(
      factory.createConstructorDeclaration(
        undefined,
        params,
        factory.createBlock([...fieldInitStmts, ...body], true),
      ),
    );
  }

  // Backward-compat: keep the `<Class>.new(...)` call (and value-position
  // `<Class>.new` reference) working by emitting a `static new(...)`
  // method that forwards to the real constructor. The `Class.new` macro
  // rewrites *call* sites to `new Class(...)`; this static handles the
  // bare-reference case (e.g. `export default { new: Class.new }`) and
  // older code that hasn't been ported.
  if (pattern.ctorFactory && !members.some((m) =>
    ts.isMethodDeclaration(m)
      && m.modifiers?.some((mod) => mod.kind === ts.SyntaxKind.StaticKeyword)
      && ts.isIdentifier(m.name) && m.name.text === 'new',
  )) {
    const argsId = factory.createIdentifier('args');
    members.push(
      factory.createMethodDeclaration(
        [factory.createModifier(ts.SyntaxKind.StaticKeyword)],
        undefined,
        'new',
        undefined,
        undefined,
        [factory.createParameterDeclaration(
          undefined,
          factory.createToken(ts.SyntaxKind.DotDotDotToken),
          argsId,
          undefined,
          factory.createArrayTypeNode(factory.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword)),
        )],
        undefined,
        factory.createBlock(
          [factory.createReturnStatement(
            // Cast the class to `any` before `new` so the spread succeeds
            // regardless of the constructor's static arity. Plain
            // `new Class(...args)` fails when Class's ctor takes 0
            // params (TS2556: spread requires tuple type or rest param
            // on the callee).
            factory.createNewExpression(
              factory.createParenthesizedExpression(
                factory.createAsExpression(
                  factory.createIdentifier(pattern.name),
                  factory.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword),
                ),
              ),
              undefined,
              [factory.createSpreadElement(argsId)],
            ),
          )],
          true,
        ),
      ),
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
    // Variadic `function obj:method(...)` carries a `vararg` flag on the
    // FunctionExpr; surface it as a `...__varargs: unknown[]` rest param
    // so body uses of `__varargs[…]` resolve. compileFunctionShape does
    // the same for top-level functions.
    if ((fnExpr as { vararg?: boolean }).vararg) {
      params.push(
        factory.createParameterDeclaration(
          undefined,
          factory.createToken(ts.SyntaxKind.DotDotDotToken),
          factory.createIdentifier('__varargs'),
          undefined,
          factory.createArrayTypeNode(factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword)),
        ),
      );
    }
    const isStatic = (nameExpr as { op?: string }).op === '.';
    // Method bodies have the same `self` → `this` requirement as the
    // constructor. Rewrite once after compileBlockBody so the emitted
    // method reads `return this.x + arg` rather than `return self.x + arg`.
    // Also drop the `const self = this;` plumbing we emit for colon-
    // methods (it binds the captured `self` local; inside a TS class the
    // body refers to `this` directly so the rebind is dead code).
    //
    // Wrap in withScope so each method's locals (e.g. `let record = ...`
    // declared in both addState and addTransition) don't collide via
    // ctx.hasLocalInCurrentScope() and degrade to assignment-without-let
    // form in subsequent methods.
    const rawBody = ctx.withScope(() => {
      for (const a of fnExpr.args ?? []) ctx.defineLocal(a.name, 'unknown');
      return compileBlockBody(fnExpr.body as Stat, ctx);
    });
    const bodyStmts = rawBody
      .map((s) => rewriteSelfToThis(s))
      .filter((s) => !isSelfThisBinding(s));
    // Mark the method `async` when its body uses `await`. compileBlockBody
    // already inserts the awaits for yielding calls (pcall, wait, etc.);
    // without the modifier TS flags every one of them.
    const methodModifiers: ts.ModifierLike[] = [];
    if (isStatic) methodModifiers.push(factory.createModifier(ts.SyntaxKind.StaticKeyword));
    if (bodyStmts.some((s) => statementContainsAwait(s))) {
      methodModifiers.push(factory.createModifier(ts.SyntaxKind.AsyncKeyword));
    }
    members.push(
      factory.createMethodDeclaration(
        methodModifiers.length > 0 ? methodModifiers : undefined,
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

  const modifiers = pattern.exported
    ? [factory.createModifier(ts.SyntaxKind.ExportKeyword)]
    : undefined;
  // Generic params: harvested from the consumed type alias. Type packs
  // (`<T...>`) become `<T extends unknown[] = unknown[]>` so tuple-style
  // references still resolve.
  const typeParams: ts.TypeParameterDeclaration[] = [];
  for (const g of pattern.generics) {
    typeParams.push(
      factory.createTypeParameterDeclaration(undefined, factory.createIdentifier(g.name)),
    );
  }
  for (const g of pattern.genericPacks) {
    typeParams.push(
      factory.createTypeParameterDeclaration(
        undefined,
        factory.createIdentifier(g.name),
        factory.createArrayTypeNode(factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword)),
        factory.createArrayTypeNode(factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword)),
      ),
    );
  }
  return factory.createClassDeclaration(
    modifiers,
    pattern.name,
    typeParams.length > 0 ? typeParams : undefined,
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
  function topLevel(node: ts.Node): ts.Node {
    // Property access — only recurse into the `expression`, never rewrite
    // the `name` (so `obj.self` keeps `self` as the property name).
    if (ts.isPropertyAccessExpression(node)) {
      const expr = topLevel(node.expression) as ts.Expression;
      return factory.createPropertyAccessExpression(expr, node.name);
    }
    // Variable / binding / parameter — only recurse into the initializer
    // and type, never rewrite the `name`. Without this guard a
    // `const self = this` inside a nested closure becomes
    // `const this = this` which is invalid TS.
    if (ts.isVariableDeclaration(node)) {
      return factory.createVariableDeclaration(
        node.name,
        node.exclamationToken,
        node.type,
        node.initializer ? (topLevel(node.initializer) as ts.Expression) : undefined,
      );
    }
    if (ts.isBindingElement(node)) {
      return factory.createBindingElement(
        node.dotDotDotToken,
        node.propertyName,
        node.name,
        node.initializer ? (topLevel(node.initializer) as ts.Expression) : undefined,
      );
    }
    if (ts.isParameter(node)) {
      return factory.createParameterDeclaration(
        node.modifiers,
        node.dotDotDotToken,
        node.name,
        node.questionToken,
        node.type,
        node.initializer ? (topLevel(node.initializer) as ts.Expression) : undefined,
      );
    }
    if (ts.isIdentifier(node) && node.text === 'self') {
      return factory.createThis();
    }
    return ts.visitEachChild(node, topLevel, undefined);
  }
  return topLevel(stat) as ts.Statement;
}

/** Walk the `.new` factory body looking for the canonical
 *      local self = setmetatable({ field1 = val1, ... }, Class)
 *  pattern. Returns the init table (the first arg to setmetatable) so
 *  callers can harvest its fields onto the synthesized class declaration.
 *  Returns null if the factory doesn't follow this shape. */
function findSetmetatableInit(
  body: Stat,
  className: string,
): Extract<Expr, { type: 'Table' }> | null {
  const stmts = body.type === 'Block' ? body.body : [body];
  for (const s of stmts) {
    if (s.type !== 'Local') continue;
    const ls = s as LocalStat;
    if (ls.vars.length !== 1 || ls.values.length !== 1) continue;
    if (ls.vars[0]!.name !== 'self') continue;
    const v = ls.values[0]!;
    if (v.type !== 'Call') continue;
    const call = v as Extract<Expr, { type: 'Call' }>;
    if (call.func.type !== 'Global' || call.func.name !== 'setmetatable') continue;
    if (call.args.length < 1 || call.args[0]!.type !== 'Table') continue;
    // The second arg points back at the class (e.g. `Class`); not strictly
    // required to match, but skipping unrelated setmetatable shapes keeps
    // false positives low.
    if (call.args.length >= 2) {
      const meta = call.args[1]!;
      if (meta.type === 'Global' || meta.type === 'Local') {
        const metaName = (meta as { name: string }).name;
        if (metaName !== className) continue;
      }
    }
    return call.args[0] as Extract<Expr, { type: 'Table' }>;
  }
  return null;
}

/** True if a TS statement contains an `await` expression anywhere in
 *  its subtree (excluding nested function declarations, which have their
 *  own async scope). Used to decide whether a class method needs an
 *  `async` modifier. */
function statementContainsAwait(stat: ts.Statement): boolean {
  let found = false;
  function visit(node: ts.Node): void {
    if (found) return;
    // Don't cross function boundaries — a nested `async function` has
    // its own awaits that don't make the OUTER method async.
    if (
      ts.isFunctionExpression(node)
      || ts.isArrowFunction(node)
      || ts.isMethodDeclaration(node)
      || ts.isFunctionDeclaration(node)
    ) return;
    if (node.kind === ts.SyntaxKind.AwaitExpression) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(stat);
  return found;
}

/** True for a `const self = this;` (or `let`/`var`) declaration — the
 *  plumbing line our colon-method emit produces to bind a `self` local
 *  inside a function taking `this: any`. Inside a TS class body the rebind
 *  is dead code (callers already reference `this` directly), so we drop
 *  it after the self → this rewrite. */
function isSelfThisBinding(stat: ts.Statement): boolean {
  if (!ts.isVariableStatement(stat)) return false;
  const decls = stat.declarationList.declarations;
  if (decls.length !== 1) return false;
  const d = decls[0]!;
  if (!ts.isIdentifier(d.name) || d.name.text !== 'self') return false;
  return d.initializer?.kind === ts.SyntaxKind.ThisKeyword;
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
