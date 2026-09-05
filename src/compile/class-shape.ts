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
import { DYN_VALUE_TYPE, type CompileContext } from './context.js';
import { collectLocalNames, collectShapes, intersectionTypeName, mergeShape, shapeToTypeNode } from './shape-infer.js';
import { inferParamPrimitives, type Primitive as ParamPrimitive } from './param-infer.js';
import { compileType } from './type.js';
import { safeIdentifier } from './util.js';

const { factory } = ts;

/** A detected class definition — compiled into one `ts.ClassDeclaration`. */
export interface ClassPattern {
  name: string;
  superclass: string | null;
  /** Indexes of statements in the parent block that contribute to the class. */
  consumed: Set<number>;
  ctorFactory: FunctionStat | null;
  constructor: FunctionStat | null;
  methods: FunctionStat[];
  /** True if a `type <Name>` alias was found and consumed. */
  consumedTypeAlias: boolean;
  /** True if the consumed type alias was `export`ed. */
  exported: boolean;
  generics: GenericType[];
  genericPacks: GenericTypePack[];
}

/** Detect class patterns in a flat statement list. */
export function detectClasses(stmts: Stat[]): ClassPattern[] {
  const out: ClassPattern[] = [];

  for (let i = 0; i < stmts.length; i++) {
    const candidate = matchClassDeclaration(stmts, i);
    if (!candidate) continue;

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
      // Sibling class — stop. Interleaved helpers/locals are skipped via the no-op path below.
      if (j !== i && matchClassDeclaration(stmts, j)) break;

      const idxMatch = matchIndexAssignment(s, pattern.name);
      if (idxMatch) {
        pattern.consumed.add(j);
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
        } else {
          // Static non-`new` methods also land here (treated as instance methods).
          pattern.methods.push(s as FunctionStat);
        }
        continue;
      }
    }

    // Require ctor/method evidence — bare `setmetatable({}, …)` isn't a class.
    if (!pattern.ctorFactory && !pattern.constructor && pattern.methods.length === 0) continue;

    // Consume a same-named `type` alias (TS errors on class+alias merge).
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
      if (pattern.generics.length === 0 && pattern.genericPacks.length === 0) {
        pattern.generics = ta.generics ?? [];
        pattern.genericPacks = ta.genericPacks ?? [];
      }
    }

    out.push(pattern);
  }
  return out;
}

/** Match `local <Name> = setmetatable({}, <meta>)` or `local <Name> = {} :: T`. */
function matchClassDeclaration(stmts: Stat[], i: number): { name: string; superclass: string | null } | null {
  const stat = stmts[i];
  if (!stat || stat.type !== 'Local') return null;
  const ls = stat as LocalStat;
  if (ls.vars.length !== 1 || ls.values.length !== 1) return null;
  const name = ls.vars[0]!.name;
  const value = ls.values[0]!;

  // Pattern A: `local <Name> = setmetatable({}, {__index = Super})`.
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

  // Pattern B: `local <Name> = {} :: T` (impl-table idiom).
  // Methods attach via `function <Name>:foo`; superclass via separate `<Name>.__index = Super`.
  const inner = value.type === 'TypeAssertion'
    ? (value as { expr: Expr }).expr
    : value;
  if (inner.type === 'Table' && (inner as { items: unknown[] }).items.length === 0) {
    return { name, superclass: null };
  }
  return null;
}

/** Match `<Class>.__index = <Class|Super>`. Returns the RHS identifier name. */
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

/** Compile a detected class pattern into a TS `class` declaration. */
export function compileClassPattern(
  pattern: ClassPattern,
  ctx: CompileContext,
  compileBlockBody: (body: Stat, ctx: CompileContext) => ts.Statement[],
  compileExpr: (expr: Expr, ctx: CompileContext) => ts.Expression,
): ts.ClassDeclaration {
  const members: ts.ClassElement[] = [];

  // Harvest fields + initializers from `.new`'s setmetatable init.
  // Inits run in the ctor body (not as field initializers) since the ctor
  // params share names with the field initializer expressions.
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

  // Aggregate `self.X` access across ctor + methods to declare lazy-assigned
  // fields as typed properties (the index-sig fallback fires roblox-ts no-any).
  // Lifted out of the rbxts-only block so the methods loop can expose the
  // shape map to compileAssign via ctx.selfFieldShapes.
  let aggregatedSelfShape: import('./shape-infer.js').Shape | null = null;
  if (ctx.compatMode === 'rbxts') {
    aggregatedSelfShape = (() => {
      let aggregated: import('./shape-infer.js').Shape | null = null;
      const merge = (body: Stat | null | undefined): void => {
        if (!body) return;
        const m = collectShapes(body, new Set(['self']));
        const s = m.get('self');
        if (!s || s.empty) return;
        if (!aggregated) {
          aggregated = s;
          return;
        }
        mergeShape(aggregated, s);
      };
      if (pattern.ctorFactory) merge(pattern.ctorFactory.func.body);
      if (pattern.constructor) merge(pattern.constructor.func.body);
      for (const method of pattern.methods) merge(method.func.body);
      return aggregated;
    })();
    if (aggregatedSelfShape) {
      // Skip method names to avoid TS2300 duplicate identifier on field declarations.
      const methodNames = new Set<string>();
      for (const method of pattern.methods) {
        const mn = method.name;
        if (mn.type === 'IndexName') methodNames.add(mn.index);
      }
      for (const [name, childShape] of (aggregatedSelfShape as import('./shape-infer.js').Shape).props) {
        if (fieldNames.has(name)) continue;
        if (methodNames.has(name)) continue;
        // `constructor` is reserved on TS class bodies — it always
        // denotes the constructor method, never a field. The Luau OO
        // pattern uses `self:constructor(name)` as a method call inside
        // the `.new` factory; the method itself is parked in
        // `pattern.constructor` and emitted as the JS class ctor below.
        // Without this skip, the synthesized-self-field loop sees
        // `constructor` as an observed prop and emits a colliding
        // `constructor!: unknown` field declaration.
        if (name === 'constructor') continue;
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
        fieldNames.add(name);
        const fieldType = shapeToTypeNode(childShape)
          ?? factory.createTypeReferenceNode(DYN_VALUE_TYPE, undefined);
        members.push(
          factory.createPropertyDeclaration(
            undefined,
            factory.createIdentifier(name),
            // `!` definite-assignment: TS can't see method-body writes that initialize the field.
            factory.createToken(ts.SyntaxKind.ExclamationToken),
            fieldType,
            undefined,
          ),
        );
      }
    }
  }

  // Constructor — prefer :constructor; fall back to the .new factory body.
  const ctorFn = pattern.constructor ?? pattern.ctorFactory;
  if (ctorFn) {
    const fnExpr = ctorFn.func;
    const ctorArgs = (fnExpr.args ?? []);
    let ctorOptionalFrom = ctx.compatMode === 'rbxts'
      ? trailingMissingStart(ctorArgs)
      : ctorArgs.length;
    let ctorShapes: Map<string, import('./shape-infer.js').Shape> | null = null;
    if (ctx.compatMode === 'rbxts' && fnExpr.body) {
      const trackedNames = new Set<string>(ctorArgs.map((a) => a.name));
      for (const n of collectLocalNames(fnExpr.body)) trackedNames.add(n);
      ctorShapes = collectShapes(fnExpr.body, trackedNames);
    }
    // Shape-typed params are required — push optionalFrom past them (TS1016).
    if (ctorShapes) {
      let lastShapeRequired = -1;
      ctorArgs.forEach((a, i) => {
        if (a.annotation) return;
        const sh = ctorShapes.get(a.name);
        if (sh && !sh.empty) lastShapeRequired = i;
      });
      if (lastShapeRequired + 1 > ctorOptionalFrom) {
        ctorOptionalFrom = lastShapeRequired + 1;
      }
    }
    const ctorDyn = new Set(
      ctorArgs.filter((a) => methodParamIsDyn(a, ctorShapes?.get(a.name), null, ctx)).map((a) => a.name),
    );
    const params = ctorArgs.map((a, idx) =>
      paramDecl(a, idx >= ctorOptionalFrom, ctorShapes?.get(a.name) ?? null, null, ctorDyn.has(a.name)),
    );
    if (ctorShapes) ctx.pushShapeScope(ctorShapes as Map<string, unknown>);
    for (const n of ctorDyn) ctx.noteDeclaredTypeKind(n, 'dyn');
    const body = ctorBody(fnExpr.body, pattern, ctx, compileBlockBody, compileExpr);
    for (const n of ctorDyn) ctx.tsDynLocal.delete(n);
    if (ctorShapes) ctx.popShapeScope();
    members.push(
      factory.createConstructorDeclaration(
        undefined,
        params,
        factory.createBlock([...fieldInitStmts, ...dynPrologue([...ctorDyn]), ...body], true),
      ),
    );
  }

  // native mode: emit `static new(...)` forwarder for value-position `<Class>.new` references.
  // rbxts skips — roblox-ts reserves `.new` and auto-generates the factory.
  if (ctx.compatMode !== 'rbxts' && pattern.ctorFactory && !members.some((m) =>
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
            // Cast to `any` before `new` so the spread works regardless of ctor arity (TS2556).
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
    // `function M.step(self, ...)` is the dot-syntax spelling of a method:
    // the explicit `self` param folds into `this`, not a static slot.
    const explicitSelf =
      (nameExpr as { op?: string }).op === '.' && fnExpr.args?.[0]?.name === 'self';
    const fnArgs = explicitSelf ? (fnExpr.args ?? []).slice(1) : (fnExpr.args ?? []);
    let optionalFrom = ctx.compatMode === 'rbxts'
      ? trailingMissingStart(fnArgs)
      : fnArgs.length;
    let methodShapes: Map<string, import('./shape-infer.js').Shape> | null = null;
    if (ctx.compatMode === 'rbxts' && fnExpr.body) {
      const trackedNames = new Set<string>(fnArgs.map((a) => a.name));
      for (const n of collectLocalNames(fnExpr.body)) trackedNames.add(n);
      methodShapes = collectShapes(fnExpr.body, trackedNames);
    }
    const paramPrimitivesEarly = ctx.compatMode === 'rbxts' && fnExpr.body
      ? inferParamPrimitives(fnExpr as unknown as Parameters<typeof inferParamPrimitives>[0])
      : new Map<string, ParamPrimitive>();
    const methodDyn = new Set(
      fnArgs
        .filter((a) => methodParamIsDyn(a, methodShapes?.get(a.name), paramPrimitivesEarly.get(a.name) ?? null, ctx))
        .map((a) => a.name),
    );
    if (methodShapes) {
      let lastShapeRequired = -1;
      fnArgs.forEach((a, i) => {
        if (a.annotation || methodDyn.has(a.name)) return;
        const sh = methodShapes.get(a.name);
        if (sh && !sh.empty) lastShapeRequired = i;
      });
      if (lastShapeRequired + 1 > optionalFrom) {
        optionalFrom = lastShapeRequired + 1;
      }
    }
    const paramPrimitives = ctx.compatMode === 'rbxts' && fnExpr.body
      ? inferParamPrimitives(fnExpr as unknown as Parameters<typeof inferParamPrimitives>[0])
      : new Map<string, ParamPrimitive>();
    // A param with an inferred primitive can't be `?: unknown` (its declared
    // type is `number`/`string`/`boolean`); push optionalFrom past it so
    // earlier params don't trigger `A required parameter cannot follow an
    // optional parameter`.
    if (paramPrimitives.size > 0) {
      let lastPrimitiveRequired = -1;
      fnArgs.forEach((a, i) => {
        if (a.annotation || methodDyn.has(a.name)) return;
        if (paramPrimitives.has(a.name)) lastPrimitiveRequired = i;
      });
      if (lastPrimitiveRequired + 1 > optionalFrom) {
        optionalFrom = lastPrimitiveRequired + 1;
      }
    }
    const params = fnArgs.map((a, idx) =>
      paramDecl(
        a,
        idx >= optionalFrom,
        methodShapes?.get(a.name) ?? null,
        paramPrimitives.get(a.name) ?? null,
        methodDyn.has(a.name),
      ),
    );
    for (const n of methodDyn) ctx.preInferredParamType.delete(n);
    // Make the inferred primitives visible inside the body so call sites
    // can drop the redundant `as unknown as <prim>` arg casts.
    const prevPreInferred = new Map<string, ParamPrimitive | undefined>();
    for (const [k, v] of paramPrimitives) {
      prevPreInferred.set(k, ctx.preInferredParamType.get(k));
      ctx.preInferredParamType.set(k, v);
    }
    // Variadic `:method(...)` → `...__varargs: unknown[]`.
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
    const isStatic = (nameExpr as { op?: string }).op === '.' && !explicitSelf;
    // Each method gets its own withScope so locals don't bleed between sibling methods.
    if (methodShapes) ctx.pushShapeScope(methodShapes as Map<string, unknown>);
    // Expose the class's self-shape so compileAssign for `self.X = Y`
    // can cast RHS through the field's declared type.
    const prevSelfFieldShapes = ctx.selfFieldShapes;
    if (aggregatedSelfShape) {
      ctx.selfFieldShapes = (aggregatedSelfShape as import('./shape-infer.js').Shape).props as unknown as Map<string, unknown>;
    }
    // Pass 6: mark shape-typed params as `tsShapeTypedLocal` for the
    // duration of the body compile so downstream Record-routing /
    // callable-cast gates see them as having declared structural types
    // (mirrors compileFunctionShape's same-named logic — class methods
    // were the gap). Scope-restored after the body.
    const trackedShapeParams: string[] = [];
    if (methodShapes && ctx.compatMode === 'rbxts') {
      for (const a of fnArgs) {
        const sh = methodShapes.get(a.name);
        const annotatedUnknown = !!a.annotation && compileType(a.annotation).kind === ts.SyntaxKind.UnknownKeyword;
        if (sh && !sh.empty && !annotatedUnknown && !methodDyn.has(a.name) && !ctx.tsShapeTypedLocal.has(a.name)) {
          ctx.tsShapeTypedLocal.add(a.name);
          trackedShapeParams.push(a.name);
        }
      }
    }
    ctx.returnAnnotationStack.push(fnExpr.returnAnnotation);
    const rawBody = ctx.withScope(() => {
      for (const a of fnExpr.args ?? []) {
        ctx.defineLocal(a.name, 'unknown');
        ctx.noteDeclaredType(a.name, a.annotation);
      }
      for (const n of methodDyn) ctx.noteDeclaredTypeKind(n, 'dyn');
      const compiled = compileBlockBody(fnExpr.body as Stat, ctx);
      for (const n of methodDyn) ctx.tsDynLocal.delete(n);
      return [...dynPrologue(fnArgs.filter((a) => methodDyn.has(a.name)).map((a) => a.name)), ...compiled];
    });
    ctx.returnAnnotationStack.pop();
    for (const n of trackedShapeParams) ctx.tsShapeTypedLocal.delete(n);
    ctx.selfFieldShapes = prevSelfFieldShapes;
    if (methodShapes) ctx.popShapeScope();
    // Restore preInferredParamType snapshot.
    for (const [k, v] of prevPreInferred) {
      if (v === undefined) ctx.preInferredParamType.delete(k);
      else ctx.preInferredParamType.set(k, v);
    }
    const bodyStmts = rawBody
      .map((s) => rewriteSelfToThis(s))
      .filter((s) => !isSelfThisBinding(s));
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
  // Type packs (`<T...>`) become `<T extends unknown[] = unknown[]>`.
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

/** Compile a `:constructor` or `.new` factory body. Skips the
 *  `local self = setmetatable(...)` / `self:constructor(...)` plumbing. */
function ctorBody(
  body: Stat,
  pattern: ClassPattern,
  ctx: CompileContext,
  compileBlockBody: (body: Stat, ctx: CompileContext) => ts.Statement[],
  compileExpr: (expr: Expr, ctx: CompileContext) => ts.Expression,
): ts.Statement[] {
  const stmts = body.type === 'Block' ? body.body : [body];
  const filtered = stmts.filter((s) => !isClassPlumbing(s, pattern));
  let compiled = filtered.flatMap((s) => compileBlockBody(s, ctx));

  compiled = compiled.map((s) => rewriteSelfToThis(s));
  if (pattern.superclass) {
    compiled = compiled.map((s) => rewriteSuperCall(s, pattern.superclass!));
  }
  return compiled;
  void compileExpr;
}

/** Rewrite `self` → `this`. Nested function expressions/declarations
 *  become arrow functions so `this` inherits lexically (matches Luau closure semantics). */
function rewriteSelfToThis(stat: ts.Statement): ts.Statement {
  function topLevel(node: ts.Node): ts.Node {
    // Don't rewrite the `name` of property access — `obj.self` keeps `self` as the name.
    if (ts.isPropertyAccessExpression(node)) {
      const expr = topLevel(node.expression) as ts.Expression;
      return factory.createPropertyAccessExpression(expr, node.name);
    }
    // Don't rewrite binding names — would produce invalid `const this = this`.
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
    // Nested `function () {}` → arrow `() => {}` so `this` binds lexically.
    if (ts.isFunctionExpression(node)) {
      const newBody = topLevel(node.body) as ts.Block;
      const params = node.parameters.filter((p) =>
        !(ts.isIdentifier(p.name) && p.name.text === 'this'),
      );
      const isAsync = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
      return factory.createArrowFunction(
        isAsync ? [factory.createModifier(ts.SyntaxKind.AsyncKeyword)] : undefined,
        node.typeParameters,
        params,
        node.type,
        factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
        newBody,
      );
    }
    // Nested `function f() {}` decl → `const f = () => {}` (Luau locals don't hoist).
    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      const newBody = topLevel(node.body) as ts.Block;
      const params = node.parameters.filter((p) =>
        !(ts.isIdentifier(p.name) && p.name.text === 'this'),
      );
      const isAsync = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
      const arrow = factory.createArrowFunction(
        isAsync ? [factory.createModifier(ts.SyntaxKind.AsyncKeyword)] : undefined,
        node.typeParameters,
        params,
        node.type,
        factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
        newBody,
      );
      return factory.createVariableStatement(
        undefined,
        factory.createVariableDeclarationList(
          [factory.createVariableDeclaration(node.name, undefined, undefined, arrow)],
          ts.NodeFlags.Const,
        ),
      );
    }
    if (ts.isIdentifier(node) && node.text === 'self') {
      return factory.createThis();
    }
    return ts.visitEachChild(node, topLevel, undefined);
  }
  return topLevel(stat) as ts.Statement;
}

/** Build a parameter decl. Uses annotation, falls back to shape-inferred type, else `unknown`. */
/** Same rule as the function compiler's `paramIsDyn`: an unannotated
 *  param with no string/boolean constraint and no class-pinning shape
 *  is declared `unknown` and rebound as `_LuauValue` in the body. */
function methodParamIsDyn(
  a: { name: string; annotation?: import('../parser/index.js').TypeNode | null },
  shape: import('./shape-infer.js').Shape | null | undefined,
  prim: ParamPrimitive | null | undefined,
  ctx: CompileContext,
): boolean {
  if (ctx.compatMode !== 'rbxts') return false;
  if (a.annotation && compileType(a.annotation).kind !== ts.SyntaxKind.UnknownKeyword) return false;
  if (prim === 'string' || prim === 'boolean') return false;
  if (shape && !shape.empty && intersectionTypeName(shape)) return false;
  return true;
}

function dynPrologue(names: readonly string[]): ts.Statement[] {
  return names.map((name) => {
    const js = safeIdentifier(name);
    return factory.createVariableStatement(
      undefined,
      factory.createVariableDeclarationList(
        [factory.createVariableDeclaration(
          factory.createIdentifier(js),
          undefined,
          undefined,
          factory.createAsExpression(
            factory.createIdentifier(`${js}_`),
            factory.createTypeReferenceNode(DYN_VALUE_TYPE, undefined),
          ),
        )],
        ts.NodeFlags.Let,
      ),
    );
  });
}

function paramDecl(
  a: { name: string; annotation?: import('../parser/index.js').TypeNode | null },
  isTrailingUnannotated = false,
  shape?: import('./shape-infer.js').Shape | null,
  paramPrimitive?: ParamPrimitive | null,
  dyn = false,
): ts.ParameterDeclaration {
  let ty: ts.TypeNode;
  let hasInferredShape = false;
  if (dyn) {
    const question = isTrailingUnannotated ? factory.createToken(ts.SyntaxKind.QuestionToken) : undefined;
    return factory.createParameterDeclaration(
      undefined,
      undefined,
      `${safeIdentifier(a.name)}_`,
      question,
      factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
    );
  }
  if (a.annotation) {
    ty = compileType(a.annotation);
  } else if (paramPrimitive) {
    ty = factory.createKeywordTypeNode(
      paramPrimitive === 'number' ? ts.SyntaxKind.NumberKeyword
        : paramPrimitive === 'string' ? ts.SyntaxKind.StringKeyword
        : ts.SyntaxKind.BooleanKeyword,
    );
    hasInferredShape = true;
  } else if (shape) {
    const fromShape = shapeToTypeNode(shape);
    if (fromShape) {
      ty = fromShape;
      hasInferredShape = true;
    } else {
      ty = factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);
    }
  } else {
    ty = factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);
  }
  // Trailing unannotated params → `?` (Luau missing-arg → nil semantics).
  // Inferred shapes skip `?` since the body assumes existence.
  const question = isTrailingUnannotated && !a.annotation && !hasInferredShape
    ? factory.createToken(ts.SyntaxKind.QuestionToken)
    : undefined;
  return factory.createParameterDeclaration(undefined, undefined, safeIdentifier(a.name), question, ty);
}

/** Params whose runtime type admits missing (unannotated or nilable). */
function paramAllowsMissing(
  a: { name: string; annotation?: import('../parser/index.js').TypeNode | null },
): boolean {
  const t = a.annotation;
  if (!t) return true;
  if (t.type === 'TypeOptional') return true;
  if (t.type === 'TypeUnion') {
    return t.types.some((u) =>
      u.type === 'TypeOptional'
      || (u.type === 'TypeReference' && u.name === 'nil')
      || (u.type === 'TypeReference' && u.name === 'undefined'),
    );
  }
  return false;
}

/** First index of the trailing run of missing-admitting params. */
function trailingMissingStart(
  args: readonly { name: string; annotation?: import('../parser/index.js').TypeNode | null }[],
): number {
  let firstTrailing = args.length;
  for (let i = args.length - 1; i >= 0; i--) {
    if (paramAllowsMissing(args[i]!)) {
      firstTrailing = i;
    } else {
      break;
    }
  }
  return firstTrailing;
}

/** Find `local self = setmetatable({fields...}, Class)` and return the init table. */
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

/** True if `stat` contains an `await` (not counting nested function scopes). */
function statementContainsAwait(stat: ts.Statement): boolean {
  let found = false;
  function visit(node: ts.Node): void {
    if (found) return;
    // Don't cross function boundaries.
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

/** True for `const self = this;` — dead code after the self→this rewrite. */
function isSelfThisBinding(stat: ts.Statement): boolean {
  if (!ts.isVariableStatement(stat)) return false;
  const decls = stat.declarationList.declarations;
  if (decls.length !== 1) return false;
  const d = decls[0]!;
  if (!ts.isIdentifier(d.name) || d.name.text !== 'self') return false;
  return d.initializer?.kind === ts.SyntaxKind.ThisKeyword;
}

/** Skipped from the TS ctor body: `local self = setmetatable(...)`,
 *  `self:constructor(...)`, `return self`. */
function isClassPlumbing(stat: Stat, pattern: ClassPattern): boolean {
  if (stat.type === 'Local') {
    const ls = stat as LocalStat;
    if (ls.vars.length === 1 && ls.vars[0]!.name === 'self' && ls.values.length === 1) {
      const v = ls.values[0]!;
      if (v.type === 'Call' && v.func.type === 'Global' && v.func.name === 'setmetatable') {
        return true;
      }
    }
  }
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

/** Rewrite `Superclass.constructor(this, ...)` → `super(...)`. */
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
      // Drop a leading `this`/`self` arg, looking through `as` cast chains.
      const args = node.arguments.slice();
      const unwrap = (e: ts.Expression): ts.Expression => {
        if (ts.isParenthesizedExpression(e)) return unwrap(e.expression);
        if (ts.isAsExpression(e)) return unwrap(e.expression);
        return e;
      };
      if (args.length > 0) {
        const first = unwrap(args[0]!);
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
