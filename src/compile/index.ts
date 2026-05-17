import {
  parse,
  type AssignStat,
  type BlockStat,
  type CompoundAssignStat,
  type DeclareFunctionStat,
  type DeclareGlobalStat,
  type Expr,
  type ForInStat,
  type ForStat,
  type FunctionExpr,
  type FunctionStat,
  type GenericType,
  type GenericTypePack,
  type IfStat,
  type Local,
  type LocalFunctionStat,
  type LocalStat,
  type ParseResult,
  type Stat,
  type TableItem,
  type TypeAliasStat,
  type TypeNode,
} from '../parser/index.js';
import ts from 'typescript';
import { format as prettierFormat } from 'prettier';
import { ARITH_DATATYPES, CompileContext, RUNTIME_MODULE, type CompatMode, type StaticValueType } from './context.js';
import { lookupMacro } from './macros/index.js';
// Side-effect imports — populate the macro registry consulted by lookupMacro.
import './macros/datatypes.js';
import './macros/instance.js';
import './macros/stdlib.js';
import './rbxts-runtime.js';
import { detectClasses, compileClassPattern, type ClassPattern } from './class-shape.js';
import { collectLocalNames, collectShapes, shapeToTypeNode } from './shape-infer.js';
import { inferParamPrimitives, inferReturnPrimitive } from './param-infer.js';
import { splitInstanceChains } from './chain-split.js';
import { inferConstLocals } from './const-infer.js';
import { hoistInnerLuaTupleCalls } from './luatuple-hoist.js';
import { inferLocalTypes, type LocalTypeMap } from './local-type-infer.js';
import { runFlowPass, type FlowFact } from './flow.js';
import { inferInstanceLocals } from './backprop-class.js';
import { compileType, compileTypePack, setAliasArities, setTypeCompatMode } from './type.js';
import {
  buildSourceMap,
  inlineSourceMapURL,
  type SourceMap,
  type SourceMapMapping,
} from './sourcemap.js';
import {
  propertyName,
  isRepeatableExpression,
  safeIdentifier,
  throwUnsupported,
  truthify,
  unsupportedExpr,
} from './util.js';

const { factory } = ts;

function flowFactOf(expr: Expr | undefined, ctx: CompileContext): FlowFact | undefined {
  return expr ? ctx.flowFactByExpr?.get(expr) : undefined;
}

function flowFactToStatic(fact: FlowFact | undefined): StaticValueType | undefined {
  if (!fact) return undefined;
  if (fact.kind === 'primitive') return fact.name;
  if (fact.kind === 'datatype') return `datatype:${fact.name}` as StaticValueType;
  return undefined;
}

function flowClassOf(expr: Expr | undefined, ctx: CompileContext): string | undefined {
  const fact = flowFactOf(expr, ctx);
  return fact?.kind === 'class' ? fact.name : undefined;
}

function typeNodeForFlowFact(fact: FlowFact): ts.TypeNode | null {
  switch (fact.kind) {
    case 'class':
      return factory.createTypeReferenceNode(fact.name, undefined);
    case 'primitive':
      return factory.createKeywordTypeNode(
        fact.name === 'number' ? ts.SyntaxKind.NumberKeyword
          : fact.name === 'string' ? ts.SyntaxKind.StringKeyword
          : ts.SyntaxKind.BooleanKeyword,
      );
    case 'array': {
      const element = typeNodeForFlowFact(fact.element)
        ?? factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);
      return factory.createArrayTypeNode(element);
    }
    default:
      return null;
  }
}

const COMMON_INSTANCE_METHODS = new Set([
  'WaitForChild',
  'FindFirstChild',
  'FindFirstChildOfClass',
  'FindFirstChildWhichIsA',
  'FindFirstAncestor',
  'FindFirstAncestorOfClass',
  'FindFirstAncestorWhichIsA',
  'FindFirstDescendant',
  'GetChildren',
  'GetDescendants',
  'GetAttribute',
  'SetAttribute',
  'GetAttributeChangedSignal',
  'IsA',
  'IsDescendantOf',
  'Clone',
  'Destroy',
]);

function oracleHasMember(ctx: CompileContext, className: string, memberName: string): boolean {
  if (ctx.oracle.isA(className, 'Instance') && COMMON_INSTANCE_METHODS.has(memberName)) return true;
  return !!ctx.oracle.propertyType(className, memberName)
    || !!ctx.oracle.methodReturnType(className, memberName, 0);
}

function isLuauChildTypeText(text: string): boolean {
  return text === '_LuauChild' || text.includes('_LuauChild');
}


function exprsStructurallyEqual(a: Expr, b: Expr): boolean {
  if (a.type !== b.type) return false;
  switch (a.type) {
    case 'Local':
      return (a as { name: string }).name === (b as { name: string }).name;
    case 'Global':
      return (a as { name: string }).name === (b as { name: string }).name;
    case 'IndexName':
      return (a as { index: string }).index === (b as { index: string }).index
        && exprsStructurallyEqual(
          (a as { expr: Expr }).expr,
          (b as { expr: Expr }).expr,
        );
    case 'ConstantString':
      return (a as { value: string }).value === (b as { value: string }).value;
    case 'ConstantNumber':
      return (a as { value: number }).value === (b as { value: number }).value;
    default:
      return false;
  }
}

function statementsReferenceSelf(stmts: readonly ts.Statement[]): boolean {
  for (const s of stmts) {
    if (nodeReferencesSelf(s)) return true;
  }
  return false;
}

function nodeReferencesSelf(node: ts.Node): boolean {
  if (ts.isIdentifier(node) && node.text === 'self') return true;
  // Don't recurse into nested function declarations / expressions — their
  // `self` belongs to a different scope.
  if (
    ts.isFunctionDeclaration(node)
    || ts.isFunctionExpression(node)
    || ts.isArrowFunction(node)
    || ts.isMethodDeclaration(node)
  ) {
    return false;
  }
  return ts.forEachChild(node, nodeReferencesSelf) ?? false;
}

function recordCastExpression(expr: ts.Expression): ts.Expression {
  return factory.createParenthesizedExpression(
    factory.createAsExpression(
      factory.createAsExpression(
        expr,
        factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
      ),
      factory.createTypeReferenceNode('Record', [
        factory.createKeywordTypeNode(ts.SyntaxKind.StringKeyword),
        factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
      ]),
    ),
  );
}

function luauChildCastExpression(expr: ts.Expression, ctx: CompileContext): ts.Expression {
  ctx.useLuauChildType();
  return factory.createParenthesizedExpression(
    factory.createAsExpression(
      factory.createAsExpression(
        expr,
        factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
      ),
      factory.createTypeReferenceNode('_LuauChild', undefined),
    ),
  );
}

function unknownCallableTypeNode(): ts.FunctionTypeNode {
  return factory.createFunctionTypeNode(
    undefined,
    [factory.createParameterDeclaration(
      undefined,
      factory.createToken(ts.SyntaxKind.DotDotDotToken),
      'args',
      undefined,
      factory.createArrayTypeNode(factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword)),
    )],
    factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
  );
}

function unknownCallableCastExpression(expr: ts.Expression): ts.Expression {
  return factory.createParenthesizedExpression(
    factory.createAsExpression(
      factory.createAsExpression(
        expr,
        factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
      ),
      unknownCallableTypeNode(),
    ),
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Statements
// ═══════════════════════════════════════════════════════════════════════════

function compileBlock(block: BlockStat | Stat, ctx: CompileContext): ts.Block {
  return ctx.withScope(() => factory.createBlock(compileBlockBody(block, ctx), true));
}

function compileBlockBody(block: BlockStat | Stat, ctx: CompileContext): ts.Statement[] {
  if (block.type !== 'Block') return statementsOf(block, ctx);

  // rbxts: detect metatable-OOP class patterns and replace with TS class decls.
  const classes = ctx.compatMode === 'rbxts' ? detectClasses(block.body) : [];
  if (classes.length === 0) {
    return block.body.flatMap((s) => statementsOf(s, ctx));
  }

  const consumed = new Set<number>();
  const classByLeadIndex = new Map<number, ClassPattern>();
  for (const c of classes) {
    ctx.recordDetectedClass(c.name);
    // Instance methods (op === ':') → record for value-position prototype rewrite.
    // Static methods (op === '.') are accessed statically; skip to avoid TS2576.
    for (const method of c.methods) {
      if (method.name.type === 'IndexName') {
        const isStatic = (method.name as { op?: string }).op === '.';
        if (!isStatic) {
          ctx.recordDetectedClassMethod(c.name, (method.name as { index: string }).index);
        }
      }
    }
    let lead = Infinity;
    for (const idx of c.consumed) {
      if (idx < lead) lead = idx;
      consumed.add(idx);
    }
    classByLeadIndex.set(lead, c);
  }
  const out: ts.Statement[] = [];
  for (let i = 0; i < block.body.length; i++) {
    if (classByLeadIndex.has(i)) {
      out.push(
        compileClassPattern(classByLeadIndex.get(i)!, ctx, compileBlockBody, compileExpr),
      );
      continue;
    }
    if (consumed.has(i)) continue;
    out.push(...statementsOf(block.body[i]!, ctx));
  }
  return out;
}

function statementsOf(stat: Stat, ctx: CompileContext): ts.Statement[] {
  switch (stat.type) {
    case 'Local':
      return compileLocal(stat, ctx);
    case 'LocalFunction':
      return [compileLocalFunction(stat, ctx)];
    case 'Function':
      return [compileFunctionStat(stat, ctx)];
    case 'Expr':
      return [factory.createExpressionStatement(compileExpr(stat.expr, ctx))];
    case 'Return': {
      if (stat.values.length === 0) {
        return [factory.createReturnStatement(undefined)];
      }
      if (stat.values.length === 1) {
        const value = stat.values[0]!;
        const compiled = ctx.compatMode === 'rbxts'
          && value.type === 'Local'
          && ctx.tsLuauChildLocal.has(value.name)
            ? factory.createNonNullExpression(compileExpr(value, ctx))
            : compileExpr(value, ctx);
        return [factory.createReturnStatement(compiled)];
      }
      // Multi-value return: native emits array; rbxts emits `$tuple(...)` macro
      // so roblox-ts round-trips to native `return a, b`.
      const compiled = stat.values.map((v) => compileExpr(v, ctx));
      if (ctx.compatMode === 'rbxts') {
        return [factory.createReturnStatement(
          factory.createCallExpression(
            factory.createIdentifier('$tuple'),
            undefined,
            compiled,
          ),
        )];
      }
      return [factory.createReturnStatement(
        factory.createArrayLiteralExpression(compiled, false),
      )];
    }
    case 'If':
      return [compileIf(stat, ctx)];
    case 'While':
      return [
        factory.createWhileStatement(
          truthify(
            compileExpr(stat.condition, ctx),
            ctx,
            staticTypeOfExpr(stat.condition, ctx),
          ),
          compileBlock(stat.body, ctx),
        ),
      ];
    case 'Repeat':
      return [
        factory.createDoStatement(
          compileBlock(stat.body, ctx),
          factory.createPrefixUnaryExpression(
            ts.SyntaxKind.ExclamationToken,
            truthify(
              compileExpr(stat.condition, ctx),
              ctx,
              staticTypeOfExpr(stat.condition, ctx),
            ),
          ),
        ),
      ];
    case 'For':
      return [compileFor(stat, ctx)];
    case 'ForIn':
      return compileForIn(stat, ctx);
    case 'Break':
      return [factory.createBreakStatement()];
    case 'Continue':
      return [factory.createContinueStatement()];
    case 'Block':
      return [compileBlock(stat, ctx)];
    case 'Assign':
      return compileAssign(stat, ctx);
    case 'CompoundAssign':
      return [compileCompoundAssign(stat, ctx)];
    case 'TypeAlias':
      return [compileTypeAlias(stat)];
    case 'TypeFunction':
      return [];
    case 'DeclareGlobal':
      return [compileDeclareGlobal(stat)];
    case 'DeclareFunction':
      return [compileDeclareFunction(stat)];
    case 'DeclareExternType':
      return [];
    case 'StatError':
      return [throwUnsupported(`luau-to-ts: parse error in statement`)];
    case 'UnknownStat':
    default:
      return [throwUnsupported(`luau-to-ts: unsupported statement '${stat.type}'`)];
  }
}

/** Does `node` contain a free reference to `name` (binding-position-aware)? */
function containsFreeRef(node: ts.Expression, name: string): boolean {
  let found = false;
  const check = (n: ts.Node): void => {
    if (found) return;
    if (ts.isIdentifier(n) && n.text === name) { found = true; return; }
    if (
      ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n)
      || ts.isArrowFunction(n) || ts.isMethodDeclaration(n)
    ) {
      const params = n.parameters;
      if (params.some((p) => ts.isIdentifier(p.name) && p.name.text === name)) return;
    }
    if (ts.isPropertyAccessExpression(n)) { check(n.expression); return; }
    ts.forEachChild(n, check);
  };
  check(node);
  return found;
}

/** True when an expr's class can be resolved via the @rbxts/types oracle
 *  (service global, property of a typed class, oracle method-return). Used
 *  by compileLocal to skip the shape-infer wrap — the oracle resolution is
 *  more honest than a synthesized structural literal. */
/** Resolve the oracle className that an expression evaluates to, when
 *  possible. Used to populate tsTypedClassLocal so write sites can skip
 *  the Record<string, unknown> wrap on properties that exist on the
 *  class. */
function resolveOracleClassOfExpr(expr: Expr, ctx: CompileContext): string | undefined {
  const flowed = flowClassOf(expr, ctx);
  if (flowed) return flowed;
  if (expr.type === 'Global' && ctx.oracle.isService(expr.name)) return expr.name;
  if (expr.type === 'IndexName') {
    if (
      (expr.expr.type === 'Global' || expr.expr.type === 'Local')
      && expr.expr.name === 'Players'
      && expr.index === 'LocalPlayer'
    ) {
      return 'Player';
    }
    if (expr.expr.type === 'Global' && ctx.oracle.isService(expr.expr.name)) {
      const prop = ctx.oracle.propertyType(expr.expr.name, expr.index);
      if (prop?.kind === 'class') return prop.name;
    }
    if (expr.expr.type === 'Local' && ctx.oracle.isService(expr.expr.name)) {
      const prop = ctx.oracle.propertyType(expr.expr.name, expr.index);
      if (prop?.kind === 'class') return prop.name;
    }
  }
  if (expr.type === 'Call') {
    const fn = expr.func;
    if ((fn.type === 'Local' || fn.type === 'Global') && ctx.userFunctionReturnClass.has(fn.name)) {
      return ctx.userFunctionReturnClass.get(fn.name);
    }
    if (
      fn.type === 'IndexName'
      && fn.index === 'GetService'
      && expr.args[0]?.type === 'ConstantString'
    ) {
      const service = (expr.args[0] as { value: string }).value;
      if (ctx.oracle.isService(service)) return service;
    }
    // Instance.new("Class") → Class
    if (
      fn.type === 'IndexName'
      && fn.expr.type === 'Global'
      && fn.expr.name === 'Instance'
      && fn.index === 'new'
      && expr.args[0]?.type === 'ConstantString'
    ) {
      const cls = (expr.args[0] as { value: string }).value;
      if (ctx.oracle.isClass(cls)) return cls;
    }
    // <inst>:WaitForChild/FindFirstChild("Name") → name-table class or Instance
    if (
      fn.type === 'IndexName'
      && (fn.index === 'WaitForChild' || fn.index === 'FindFirstChild')
      && expr.args[0]?.type === 'ConstantString'
    ) {
      const literal = (expr.args[0] as { value: string }).value;
      const named = ctx.oracle.childNameClass(literal);
      if (named) return named;
      return 'Instance';
    }
    // <inst>:FindFirstChildOfClass("X") → X
    if (
      fn.type === 'IndexName'
      && (fn.index === 'FindFirstChildOfClass' || fn.index === 'FindFirstAncestorOfClass'
          || fn.index === 'FindFirstChildWhichIsA' || fn.index === 'FindFirstAncestorWhichIsA')
      && expr.args[0]?.type === 'ConstantString'
    ) {
      const cls = (expr.args[0] as { value: string }).value;
      if (ctx.oracle.isClass(cls)) return cls;
    }
  }
  return undefined;
}

function initIsOracleTyped(expr: Expr, ctx: CompileContext): boolean {
  if (flowClassOf(expr, ctx)) return true;
  if ((expr as unknown as { __nonnull?: boolean }).__nonnull) return true;
  if (expr.type === 'Global') return ctx.oracle.isService(expr.name);
  if (expr.type === 'IndexName') {
    if (expr.expr.type === 'Global' && ctx.oracle.isService(expr.expr.name)) {
      const prop = ctx.oracle.propertyType(expr.expr.name, expr.index);
      if (prop && prop.kind === 'class') return true;
    }
  }
  if (expr.type === 'Call') {
    const fn = expr.func;
    if ((fn.type === 'Local' || fn.type === 'Global') && ctx.userFunctionReturnClass.has(fn.name)) {
      return true;
    }
    if (
      fn.type === 'IndexName'
      && fn.index === 'GetService'
      && expr.args[0]?.type === 'ConstantString'
    ) {
      const service = (expr.args[0] as { value: string }).value;
      if (ctx.oracle.isService(service)) return true;
    }
    // Instance.new("Class") → ClassName (or CreatableInstances[T]); the
    // emitted `new Instance("Class")` is already typed by roblox-ts. Skip
    // the synthesized shape wrap so subsequent `cd.MouseClick.Connect`
    // typechecks against the real class.
    if (
      fn.type === 'IndexName'
      && fn.expr.type === 'Global'
      && fn.expr.name === 'Instance'
      && fn.index === 'new'
    ) {
      return true;
    }
    if (fn.type === 'IndexName') {
      const recv = fn.expr;
      // service:Method(...) / SomeService.X(...)
      if (recv.type === 'Local' || recv.type === 'Global') {
        if (ctx.oracle.isService(recv.name)) return true;
      }
      // game.GetService("Players") and friends — covered by isService
      // check via the receiver. Also recognise `:WaitForChild`,
      // `:FindFirstChild`, etc. which now resolve to specific classes.
      if (INSTANCE_LOOSE_METHODS.has(fn.index)) return true;
    }
  }
  return false;
}

function compileLocal(stat: LocalStat, ctx: CompileContext): ts.Statement[] {
  // Drop `local X = X` — happens when a macro (e.g. GetService) rewrites RHS to match LHS.
  if (stat.vars.length === 1 && stat.values.length === 1) {
    const v = stat.vars[0]!;
    const init = stat.values[0]!;
    const compiledInit = compileExpr(init, ctx);
    if (
      ts.isIdentifier(compiledInit)
      && compiledInit.text === safeIdentifier(v.name)
    ) {
      ctx.suppressLocal(v.name);
      ctx.defineLocal(v.name, typeFromAnnotation(v.annotation, init, ctx));
      if (ctx.compatMode === 'rbxts' && initIsOracleTyped(init, ctx)) {
        ctx.tsTypedClassLocal.set(v.name, resolveOracleClassOfExpr(init, ctx) ?? 'Instance');
      }
      return [];
    }
  }

  // Multi-LHS / single-call → destructuring multi-return.
  if (stat.vars.length > 1 && stat.values.length === 1 && stat.values[0]?.type === 'Call') {
    const savedMR = ctx.preferMultiReturn;
    ctx.preferMultiReturn = true;
    const rawInit = compileExpr(stat.values[0]!, ctx);
    ctx.preferMultiReturn = savedMR;
    // rbxts: cast RHS `as any` — `as [any, any]` fails TS2352 against LuaTuple.
    const init = ctx.compatMode === 'rbxts'
      ? factory.createAsExpression(
          factory.createAsExpression(
            rawInit,
            factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
          ),
          factory.createArrayTypeNode(factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword)),
        )
      : factory.createCallExpression(
          factory.createIdentifier(ctx.use('multiret')),
          undefined,
          [rawInit],
        );
    const anyShadow = stat.vars.some((v) => ctx.hasLocalInCurrentScope(v.name));
    for (const v of stat.vars) ctx.assignLocal(v.name, typeFromAnnotation(v.annotation));
    if (anyShadow) {
      // Same-scope shadow: emit destructuring assignment, not `let` — Luau reuses the binding.
      return [factory.createExpressionStatement(
        factory.createAssignment(
          factory.createArrayLiteralExpression(
            stat.vars.map((v) => factory.createIdentifier(safeIdentifier(v.name))),
          ),
          init,
        ),
      )];
    }
    // Rewrite duplicate binding names (`local _, _, x = …`) to fresh names — JS forbids dup destructure names.
    const seen = new Set<string>();
    const bindingNames = stat.vars.map((v) => {
      let name = safeIdentifier(v.name);
      if (seen.has(name)) {
        name = ctx.freshIdentifier(`${name}_skip`);
      }
      seen.add(name);
      return name;
    });
    return [factory.createVariableStatement(
      undefined,
      factory.createVariableDeclarationList(
        [
          factory.createVariableDeclaration(
            factory.createArrayBindingPattern(
              bindingNames.map((name) =>
                factory.createBindingElement(
                  undefined,
                  undefined,
                  factory.createIdentifier(name),
                  undefined,
                ),
              ),
            ),
            undefined,
            v_typeForLocal(stat.vars),
            init,
          ),
        ],
        stat.isConst ? ts.NodeFlags.Const : ts.NodeFlags.Let,
      ),
    )];
  }

  // rbxts: single-LHS LuaTuple-returning call → emit `const [x] = call()` so
  // the destructure result is properly element-0 typed without a [0] postfix
  // or `as unknown as string` cast.
  if (
    ctx.compatMode === 'rbxts'
    && stat.vars.length === 1
    && stat.values.length === 1
    && stat.values[0]?.type === 'Call'
    && isLuaTupleCall(stat.values[0]!, ctx)
    && !ctx.hasLocalInCurrentScope(stat.vars[0]!.name)
  ) {
    const v = stat.vars[0]!;
    const savedMR = ctx.preferMultiReturn;
    ctx.preferMultiReturn = true;
    const rhs = compileExpr(stat.values[0]!, ctx);
    ctx.preferMultiReturn = savedMR;
    const tupleStatic = staticTypeOfExpr(stat.values[0]!, ctx);
    ctx.defineLocal(v.name, tupleStatic);
    // LuaTuple destructure binds element 0 with the LuaTuple<[T, …]>'s
    // first slot type. Per @rbxts/types, gsub/find/match/gmatch all
    // produce string at slot 0. Mark the bound local so downstream
    // arg sites can skip the `as unknown as Parameters<...>` cast.
    if (
      ctx.constLocals.has(stat)
      && (tupleStatic === 'string' || tupleStatic === 'number' || tupleStatic === 'boolean')
    ) {
      ctx.tsTypedPrimitiveLocal.add(v.name);
    }
    // User-function LuaTuple calls may return `LuaTuple | undefined`
    // (mixed-arity returns). Destructure of undefined fails TS2488 —
    // non-null-assert the call result so the destructure typechecks.
    const callFn = (stat.values[0] as { func?: { type?: string; name?: string } }).func;
    const isUserFn = callFn?.type === 'Global' || callFn?.type === 'Local';
    const rhsForDestructure = isUserFn ? factory.createNonNullExpression(rhs) : rhs;
    const isConst = stat.isConst || ctx.constLocals.has(stat);
    // Track this local as bound via user-function LuaTuple destructure.
    // The function's return type's slot 0 is often a narrow synthesized
    // shape; downstream `.X` access on this local may exceed that shape.
    // The IndexName compile site routes through Record so the access
    // typechecks regardless of which fields the slot annotation captured.
    if (isUserFn) ctx.destructuredLuaTupleLocal.add(v.name);
    return [
      factory.createVariableStatement(
        undefined,
        factory.createVariableDeclarationList(
          [factory.createVariableDeclaration(
            factory.createArrayBindingPattern([
              factory.createBindingElement(undefined, undefined, factory.createIdentifier(safeIdentifier(v.name))),
            ]),
            undefined,
            undefined,
            rhsForDestructure,
          )],
          isConst ? ts.NodeFlags.Const : ts.NodeFlags.Let,
        ),
      ),
    ];
  }

  // Luau allows same-scope re-`local` (shadows). TS `let` can't, so degrade to assignment.
  const newDecls: ts.VariableDeclaration[] = [];
  const reassignments: ts.Statement[] = [];
  // Snapshot which names already existed before this LocalStat — used by the
  // const-emit decision below (the check must NOT run after defineLocal
  // marks the new names as in-scope).
  const preExisting = new Set<string>();
  for (const v of stat.vars) {
    if (ctx.hasLocalInCurrentScope(v.name)) preExisting.add(v.name);
  }
  for (let i = 0; i < stat.vars.length; i += 1) {
    const v = stat.vars[i]!;
    const init = stat.values[i];
    let initExpr = init ? compileExpr(init, ctx) : undefined;
    // Empty `{}` compiles to `[]` by default; swap to `{}` when annotation isn't array-shaped.
    if (
      initExpr
      && init?.type === 'Table'
      && (init as { items?: unknown[] }).items?.length === 0
      && v.annotation
      && !isArrayShapedType(v.annotation)
    ) {
      initExpr = factory.createObjectLiteralExpression([], false);
    }
    const safeName = safeIdentifier(v.name);
    // Pick JS name: Luau's `local X = …X…` binds to the OUTER X.
    // Rename the new local to a fresh JS name when init captures the same name.
    let jsName = safeName;
    if (initExpr && !ctx.hasLocalInCurrentScope(v.name) && containsFreeRef(initExpr, safeName)) {
      jsName = ctx.freshIdentifier(`${safeName}_local`);
      ctx.setLocalJsName(v.name, jsName);
    } else if (ctx.hasLocalInCurrentScope(v.name)) {
      jsName = ctx.getLocalJsName(v.name) ?? safeName;
    } else if (ctx.hasLocalInOuterScope(v.name)) {
      // Cross-block shadow: rename to fresh JS name (avoid TDZ on pre-shadow reads).
      jsName = ctx.freshIdentifier(`${safeName}_local`);
      ctx.setLocalJsName(v.name, jsName);
    }
    if (ctx.hasLocalInCurrentScope(v.name)) {
      if (initExpr) {
        reassignments.push(
          factory.createExpressionStatement(
            factory.createBinaryExpression(
              factory.createIdentifier(jsName),
              factory.createToken(ts.SyntaxKind.EqualsToken),
              initExpr,
            ),
          ),
        );
      }
      ctx.assignLocal(v.name, typeFromAnnotation(v.annotation, init, ctx));
    } else {
      // rbxts: materialize observed structural shape as the annotation;
      // bare `let x` / `let x = nil` fall back to `unknown` so writes don't trip TS7034.
      let typeNode: ts.TypeNode | undefined = v.annotation ? compileType(v.annotation) : undefined;
      const initIsNil = init?.type === 'ConstantNil';
      // Phase 3: per-local TS-type inference. When the entire local's
      // init + reassignment chain agrees on a single primitive (number /
      // string / boolean), emit that annotation so downstream
      // arithmetic and arg-cast sites see the local as that primitive
      // without the per-use `as unknown as T` bridge.
      if (
        !typeNode
        && ctx.compatMode === 'rbxts'
        && stat.vars.length === 1
      ) {
        const inferredPrim = ctx.localTypeMap.perStat.get(stat);
        if (inferredPrim) {
          const initStatic = init ? staticTypeOfExpr(init, ctx) : 'unknown';
          // When init is already TS-inferred as the same primitive,
          // the annotation is redundant — TS infers it from the init.
          // Track the local in tsTypedPrimitiveLocal regardless so
          // downstream cast-skip logic trusts it.
          ctx.tsTypedPrimitiveLocal.add(v.name);
          if (initStatic !== inferredPrim) {
            typeNode = factory.createKeywordTypeNode(
              inferredPrim === 'number' ? ts.SyntaxKind.NumberKeyword
                : inferredPrim === 'string' ? ts.SyntaxKind.StringKeyword
                : ts.SyntaxKind.BooleanKeyword,
            );
            if (initExpr) {
              const inner = (
                ts.isBinaryExpression(initExpr)
                || ts.isConditionalExpression(initExpr)
              )
                ? factory.createParenthesizedExpression(initExpr)
                : initExpr;
              initExpr = factory.createAsExpression(
                factory.createAsExpression(
                  inner,
                  factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
                ),
                typeNode,
              );
            }
          }
        }
      }
      if (!typeNode && ctx.compatMode === 'rbxts') {
        // Skip shape-infer wrap when the init's TS type already resolves
        // to a concrete oracle class — the explicit oracle type beats the
        // synthesized literal. Covers chain-split locals (player from
        // Players.LocalPlayer), service GetService results, etc.
        const initHasOracleType =
          !!init && initIsOracleTyped(init, ctx);
        // Only override TS inference for inits TS would type as `unknown`
        // (identifier reads, index access, nil). Typed inits (Instance.new, ctors) stay inferred.
        const initIsShapelyCandidate =
          !initHasOracleType && (
            !init
            || init.type === 'ConstantNil'
            || init.type === 'Local'
            || init.type === 'Global'
            || init.type === 'IndexName'
            || init.type === 'IndexExpr'
          );
        if (initIsShapelyCandidate) {
          const inferred = ctx.getShape(v.name) as
            | import('./shape-infer.js').Shape
            | undefined;
          const fromShape = inferred ? shapeToTypeNode(inferred) : null;
          if (fromShape) {
            ctx.tsShapeTypedLocal.add(v.name);
            typeNode = fromShape;
            if (initExpr) {
              // Route init through `as unknown as <shape>` — paren-wrap binary/ternary first
              // since `as` binds tighter than `||`/`??`/`&&`.
              const inner = (
                ts.isBinaryExpression(initExpr)
                || ts.isConditionalExpression(initExpr)
              )
                ? factory.createParenthesizedExpression(initExpr)
                : initExpr;
              initExpr = factory.createAsExpression(
                factory.createAsExpression(
                  inner,
                  factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
                ),
                fromShape,
              );
            }
            // No init → `let X!: <shape>`; user's Luau assigns X in a branch TS can't prove.
          } else if (!initExpr || initIsNil) {
            typeNode = factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);
          }
        }
      }
      // Backprop pass marked this local as Instance-typed. Force the
      // emitted TS type by widening the init through `as unknown as Instance`
      // (the init's existing class cast — `as _LuauChild`, `as IntValue`,
      // raw `unknown` from a Call result — wouldn't otherwise satisfy the
      // annotation). Skip when the local already has a structural shape
      // annotation (`tsShapeTypedLocal`) or a primitive annotation.
      if (
        ctx.compatMode === 'rbxts'
        && ctx.backpropInstanceLocals.has(v.name)
        && !ctx.tsShapeTypedLocal.has(v.name)
        && !ctx.tsTypedPrimitiveLocal.has(v.name)
        && initExpr
        && typeNode === undefined
      ) {
        const inner = (
          ts.isBinaryExpression(initExpr)
          || ts.isConditionalExpression(initExpr)
        )
          ? factory.createParenthesizedExpression(initExpr)
          : initExpr;
        initExpr = factory.createAsExpression(
          factory.createAsExpression(
            inner,
            factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
          ),
          factory.createTypeReferenceNode('Instance', undefined),
        );
      }
      // rbxts: shape-typed local without init needs `!` (definite assignment) to avoid TS2454.
      const needsDefiniteAssertion =
        ctx.compatMode === 'rbxts'
        && !initExpr
        && typeNode !== undefined
        && typeNode.kind !== ts.SyntaxKind.UnknownKeyword;
      newDecls.push(
        factory.createVariableDeclaration(
          factory.createIdentifier(jsName),
          needsDefiniteAssertion
            ? factory.createToken(ts.SyntaxKind.ExclamationToken)
            : undefined,
          typeNode,
          initExpr,
        ),
      );
      ctx.defineLocal(v.name, typeFromAnnotation(v.annotation, init, ctx));
      // Track which locals TS will know as a primitive — used by the
      // arg-cast skip logic so `let s = tostring(...); string.reverse(s)`
      // doesn't re-cast `s`. Only safe when the init is a trusted-typed
      // primitive AND the local isn't later reassigned (otherwise TS
      // widens internally).
      if (
        ctx.compatMode === 'rbxts'
        && init
        && ctx.constLocals.has(stat)
        && isTrustedTypedExpr(init, ctx)
      ) {
        const t = staticTypeOfExpr(init, ctx);
        if (t === 'string' || t === 'number' || t === 'boolean') {
          ctx.tsTypedPrimitiveLocal.add(v.name);
        }
      }
      // Class-typed: even when the local is reassigned, the TS-inferred
      // class survives — suppress the reassign shape-cast so the
      // synthesized literal doesn't clash with the declared class.
      if (ctx.compatMode === 'rbxts' && init && initIsOracleTyped(init, ctx)) {
        const className = resolveOracleClassOfExpr(init, ctx) ?? 'Instance';
        ctx.tsTypedClassLocal.set(v.name, className);
        if (
          init.type === 'Call'
          && (init.func.type === 'Local' || init.func.type === 'Global')
          && ctx.userFunctionReturnClass.has(init.func.name)
        ) {
          ctx.tsOptionalClassLocal.add(v.name);
        }
        if (
          init.type === 'Call'
          && !(init as unknown as { __chainIntermediate?: boolean }).__chainIntermediate
        ) {
          const loose = resolveLooseMethodCastType(init, ctx);
          if (loose.kind === 'class' && loose.text.includes('undefined')) {
            ctx.tsOptionalClassLocal.add(v.name);
          }
          if (loose.kind === 'class' && isLuauChildTypeText(loose.text)) {
            ctx.tsLuauChildLocal.add(v.name);
          }
        }
      }
      if (ctx.compatMode === 'rbxts' && init && exprEmitsLuauChild(init, ctx)) {
        ctx.tsLuauChildLocal.add(v.name);
      }
    }
  }
  const out: ts.Statement[] = [];
  if (newDecls.length > 0) {
    // rbxts: a `local x = ...` whose name is never reassigned in its scope
    // emits as `const x = ...`. The Luau-side `local const` (stat.isConst)
    // forces const regardless; otherwise rely on the const-infer pre-pass.
    const allInited = newDecls.every((d) => d.initializer !== undefined);
    const allConst = ctx.compatMode === 'rbxts'
      && allInited
      && ctx.constLocals.has(stat)
      && preExisting.size === 0;
    out.push(factory.createVariableStatement(
      undefined,
      factory.createVariableDeclarationList(
        newDecls,
        stat.isConst || allConst ? ts.NodeFlags.Const : ts.NodeFlags.Let,
      ),
    ));
  }
  out.push(...reassignments);
  return out;
}

function v_typeForLocal(vars: Local[]): ts.TypeNode | undefined {
  // For destructured locals, only emit a tuple type if every var has an
  // annotation. Mixed-annotation cases drop the type to keep noise down.
  if (!vars.every((v) => v.annotation)) return undefined;
  return factory.createTupleTypeNode(vars.map((v) => compileType(v.annotation)));
}

// Every compiled Luau function is emitted `async` so the compiler can
// freely insert `await` for yielding APIs (wait, task.wait, WaitForChild,
// :*Async). Roblox scripts can yield from any nested function — pcall
// callbacks, signal handlers, dropper-tycoon while-loops — so making
// only the script body async wouldn't be enough.
const ASYNC_MOD = [factory.createModifier(ts.SyntaxKind.AsyncKeyword)];

/**
 * Walk a compiled function body looking for an `await` expression. If the
 * body has no awaits, the function doesn't need to be async — and emitting
 * non-async lets call sites that forgot to `await` (i.e. all of them, since
 * Lua doesn't have an explicit await marker) still get the unwrapped value.
 *
 * Skip nested function bodies: an inner `await` inside a closure is the
 * inner closure's concern, not ours.
 */
function bodyContainsAwait(body: ts.Block): boolean {
  return nodeContainsAwait(body);
}

/** True if `node` contains an `await` outside any nested function scope.
 *  Used to gate the `export {};` module marker. */
function nodeContainsTopLevelAwait(node: ts.Node): boolean {
  let found = false;
  function visit(n: ts.Node): void {
    if (found) return;
    if (
      ts.isFunctionDeclaration(n)
      || ts.isFunctionExpression(n)
      || ts.isArrowFunction(n)
      || ts.isMethodDeclaration(n)
      || ts.isConstructorDeclaration(n)
    ) return;
    if (ts.isAwaitExpression(n)) { found = true; return; }
    ts.forEachChild(n, visit);
  }
  visit(node);
  return found;
}

function asyncModIfNeeded(body: ts.Block): readonly ts.Modifier[] | undefined {
  return bodyContainsAwait(body) ? ASYNC_MOD : undefined;
}

/** True if `stat` contains a `return` outside any nested function scope.
 *  Triggers IIFE wrapping for module-scoped early exits (TS1108). */
function containsTopLevelReturn(stat: ts.Statement): boolean {
  let found = false;
  function visit(node: ts.Node): void {
    if (found) return;
    if (
      ts.isFunctionDeclaration(node)
      || ts.isFunctionExpression(node)
      || ts.isArrowFunction(node)
      || ts.isMethodDeclaration(node)
      || ts.isGetAccessorDeclaration(node)
      || ts.isSetAccessorDeclaration(node)
      || ts.isConstructorDeclaration(node)
    ) {
      return;
    }
    if (ts.isReturnStatement(node)) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(stat);
  return found;
}

function maxMultiReturnArity(body: BlockStat | Stat): number | null {
  let max: number | null = null;
  let hasShortReturn = false;
  function walk(stat: Stat | null | undefined): void {
    if (!stat) return;
    if (stat.type === 'Function' || stat.type === 'LocalFunction') return;
    if (stat.type === 'Return') {
      if (stat.values.length > 1) {
        max = Math.max(max ?? 0, stat.values.length);
      } else {
        // 0/1-value return — incompatible with LuaTuple<[…]>; skip widening.
        hasShortReturn = true;
      }
      return;
    }
    if (stat.type === 'Block') {
      for (const s of stat.body) walk(s);
      return;
    }
    if (stat.type === 'If') {
      walk(stat.thenBody);
      walk(stat.elseBody);
      return;
    }
    if (stat.type === 'While' || stat.type === 'Repeat') {
      walk(stat.body);
      return;
    }
    if (stat.type === 'For' || stat.type === 'ForIn') {
      walk(stat.body);
      return;
    }
  }
  walk(body);
  if (hasShortReturn) return null;
  return max;
}

function nodeContainsAwait(node: ts.Node): boolean {
  let found = false;
  function visit(next: ts.Node): void {
    if (found) return;
    if (
      ts.isFunctionDeclaration(next) ||
      ts.isFunctionExpression(next) ||
      ts.isArrowFunction(next) ||
      ts.isMethodDeclaration(next)
    ) {
      // Don't descend — that nested function manages its own async-ness.
      return;
    }
    if (ts.isAwaitExpression(next)) {
      found = true;
      return;
    }
    ts.forEachChild(next, visit);
  }
  visit(node);
  return found;
}

function compileLocalFunction(stat: LocalFunctionStat, ctx: CompileContext): ts.Statement {
  // `local function foo() end` → `async function foo() {}` (when needed)
  // with hoisting parity. Use a function declaration so `foo` is callable
  // before its line in TS.
  const { params, typeParams, returnType, body } = compileFunctionShape(stat.func, ctx);
  // If the name was already declared as a `let` in this scope (e.g. an
  // earlier `local foo = …`), a function declaration would conflict. Emit
  // assignment to the existing binding instead.
  if (ctx.hasLocalInCurrentScope(stat.name.name)) {
    return factory.createExpressionStatement(
      factory.createAssignment(
        factory.createIdentifier(safeIdentifier(stat.name.name)),
        factory.createFunctionExpression(
          asyncModIfNeeded(body),
          undefined,
          undefined,
          typeParams.length > 0 ? typeParams : undefined,
          params,
          returnType,
          body,
        ),
      ),
    );
  }
  ctx.defineLocal(stat.name.name, 'unknown');
  return factory.createFunctionDeclaration(
    asyncModIfNeeded(body),
    undefined,
    factory.createIdentifier(safeIdentifier(stat.name.name)),
    typeParams.length > 0 ? typeParams : undefined,
    params,
    returnType,
    body,
  );
}

function compileFunctionStat(stat: FunctionStat, ctx: CompileContext): ts.Statement {
  // `function name() end` (global) or `function obj.m() end` (member).
  // Lua's name is an expression resolving to where the function gets stored.
  // Parser-recovery ExprError as the name would emit `IIFE() = fn` which is
  // not a valid lvalue — skip the whole statement.
  if (stat.name.type === 'ExprError' || (stat.name as { type?: string }).type === 'UnknownExpr') {
    return factory.createEmptyStatement();
  }
  // `function Obj.method(self, …) end` or `function Obj:method(…)` —
  // the name is a member access, so a `self` first-arg or colon-bound
  // self should fold into `this`. `function bareGlobal(…)` (name is a
  // Global) is not a method even if its first arg happens to be `self`.
  const isMemberDefinition = stat.name.type === 'IndexName' || stat.name.type === 'IndexExpr';
  const fn = compileFunctionExpr(stat.func, ctx, { allowImplicitSelf: isMemberDefinition });
  if (stat.name.type === 'Global') {
    // Same-name local already declared → emit assignment, not redeclaration.
    // Also emit assignment for host-provided globals (`script`/`plugin`) so
    // we don't hoist past the wrapper's binding.
    if (
      ctx.hasLocalInCurrentScope(stat.name.name)
      || HOST_PROVIDED_GLOBALS.has(stat.name.name)
    ) {
      return factory.createExpressionStatement(
        factory.createAssignment(
          factory.createIdentifier(safeIdentifier(stat.name.name)),
          fn,
        ),
      );
    }
    // Register the binding so future declarations of the same name in this
    // scope (e.g. Build to Survive's player-list builder redefining
    // `onClick` per player) emit assignment, not redeclaration.
    ctx.defineLocal(stat.name.name, 'unknown');
    const declShapes = ctx.compatMode === 'rbxts' && stat.func.body
      ? collectShapes(stat.func.body, new Set(stat.func.args.map((a) => a.name)))
      : undefined;
    return factory.createFunctionDeclaration(
      asyncModIfNeeded(fn.body),
      undefined,
      factory.createIdentifier(safeIdentifier(stat.name.name)),
      undefined,
      paramsFromLocals(stat.func.args, ctx, declShapes),
      stat.func.returnAnnotation ? compileTypePack(stat.func.returnAnnotation) : undefined,
      fn.body,
    );
  }
  // Member `obj.x = function ...`. When the impl got forced-async (body
  // contains an `await` via pcall etc.), cast the base through `any` so
  // the sync slot's return type doesn't reject the Promise<T> impl.
  const isAsyncFn =
    ts.isFunctionExpression(fn) && (fn.modifiers ?? []).some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
  if (isAsyncFn && stat.name.type === 'IndexName') {
    return factory.createExpressionStatement(
      factory.createAssignment(
        factory.createPropertyAccessExpression(
          factory.createAsExpression(
            compileExpr(stat.name.expr, ctx),
            factory.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword),
          ),
          factory.createIdentifier(propertyName(stat.name.index)),
        ),
        fn,
      ),
    );
  }
  // Use compileLValue so the rbxts-mode `<simpleRef>.<member> = …`
  // monkey-patch cast fires for `function ProfileService.X() …`
  // style declarations (TS would otherwise fire TS2339 on the
  // member access).
  return factory.createExpressionStatement(
    factory.createAssignment(compileLValue(stat.name, ctx), fn),
  );
}

function compileIf(stat: IfStat, ctx: CompileContext): ts.Statement {
  const condition = truthify(
    compileExpr(stat.condition, ctx),
    ctx,
    staticTypeOfExpr(stat.condition, ctx),
  );
  const thenBranch = compileBlock(stat.thenBody, ctx);
  const elseBranch =
    stat.elseBody === null
      ? undefined
      : stat.elseBody.type === 'If'
        ? compileIf(stat.elseBody as IfStat, ctx)
        : compileBlock(stat.elseBody, ctx);
  return factory.createIfStatement(
    condition,
    thenBranch,
    elseBranch,
  );
}

function compileFor(stat: ForStat, ctx: CompileContext): ts.Statement {
  // Lua: `for i = from, to, step do … end`. step defaults to 1.
  const idName = safeIdentifier(stat.var.name);
  const id = factory.createIdentifier(idName);
  const fromExpr = compileExpr(stat.from, ctx);
  const toExpr = compileExpr(stat.to, ctx);
  const stepExpr = stat.step ? compileExpr(stat.step, ctx) : null;

  const body = ctx.withScope(() => {
    ctx.defineLocal(stat.var.name, 'number');
    const inner = compileBlockBody(stat.body, ctx);
    // Anti-DoS guard: bail on non-finite loop var (Infinity/NaN). Skip in
    // rbxts mode — `Number.isFinite` fires TS2693 against @rbxts/types.
    if (ctx.compatMode === 'rbxts') {
      return factory.createBlock(inner, true);
    }
    const guard = factory.createIfStatement(
      factory.createPrefixUnaryExpression(
        ts.SyntaxKind.ExclamationToken,
        factory.createCallExpression(
          factory.createPropertyAccessExpression(
            factory.createIdentifier('Number'),
            factory.createIdentifier('isFinite'),
          ),
          undefined,
          [id],
        ),
      ),
      factory.createBreakStatement(),
      undefined,
    );
    return factory.createBlock([guard, ...inner], true);
  });

  // Fast path: if `step` is a numeric literal (or absent — Lua default
  // is 1), emit a clean `for (let i = from; i <= to; i += step)`. The
  // step direction is statically known so we don't need the runtime guard.
  // Runtime-expression steps (e.g. `for i = 1, 10, x`) fall through to
  // the slow path since direction can flip per-call.
  const stepLiteral = stepExpr === null ? 1 : literalNumber(stepExpr);
  if (stepLiteral !== null && Number.isFinite(stepLiteral) && stepLiteral > 0) {
    const initializer = factory.createVariableDeclarationList(
      [factory.createVariableDeclaration(id, undefined, undefined, fromExpr)],
      ts.NodeFlags.Let,
    );
    const condition = factory.createBinaryExpression(
      id,
      ts.SyntaxKind.LessThanEqualsToken,
      toExpr,
    );
    const incrementor = stepLiteral === 1
      ? factory.createPostfixUnaryExpression(id, ts.SyntaxKind.PlusPlusToken)
      : factory.createBinaryExpression(
          id,
          ts.SyntaxKind.PlusEqualsToken,
          factory.createNumericLiteral(stepLiteral),
        );
    return factory.createForStatement(initializer, condition, incrementor, body);
  }
  if (stepLiteral !== null && Number.isFinite(stepLiteral) && stepLiteral < 0) {
    const initializer = factory.createVariableDeclarationList(
      [factory.createVariableDeclaration(id, undefined, undefined, fromExpr)],
      ts.NodeFlags.Let,
    );
    const condition = factory.createBinaryExpression(
      id,
      ts.SyntaxKind.GreaterThanEqualsToken,
      toExpr,
    );
    // TS factory rejects negative numeric literals — `i -= |step|` reads
    // cleaner anyway. Special-case the common -1 step into `i--`.
    const incrementor = stepLiteral === -1
      ? factory.createPostfixUnaryExpression(id, ts.SyntaxKind.MinusMinusToken)
      : factory.createBinaryExpression(
          id,
          ts.SyntaxKind.MinusEqualsToken,
          factory.createNumericLiteral(Math.abs(stepLiteral)),
        );
    return factory.createForStatement(initializer, condition, incrementor, body);
  }

  // Slow path: step is a runtime expression (variable, computed). Hoist
  // `to` and `step` and use the conditional guard so the direction can
  // flip without breaking the loop.
  const toLocal = factory.createIdentifier(`__for_${idName}_to`);
  const stepLocal = factory.createIdentifier(`__for_${idName}_step`);
  const stepInit = stepExpr ?? factory.createNumericLiteral(1);
  const initializer = factory.createVariableDeclarationList(
    [
      factory.createVariableDeclaration(id, undefined, undefined, fromExpr),
      factory.createVariableDeclaration(toLocal, undefined, undefined, toExpr),
      factory.createVariableDeclaration(stepLocal, undefined, undefined, stepInit),
    ],
    ts.NodeFlags.Let,
  );
  const condition = factory.createConditionalExpression(
    factory.createBinaryExpression(
      stepLocal,
      ts.SyntaxKind.GreaterThanToken,
      factory.createNumericLiteral(0),
    ),
    factory.createToken(ts.SyntaxKind.QuestionToken),
    factory.createBinaryExpression(id, ts.SyntaxKind.LessThanEqualsToken, toLocal),
    factory.createToken(ts.SyntaxKind.ColonToken),
    factory.createBinaryExpression(id, ts.SyntaxKind.GreaterThanEqualsToken, toLocal),
  );
  const incrementor = factory.createBinaryExpression(id, ts.SyntaxKind.PlusEqualsToken, stepLocal);
  return factory.createForStatement(initializer, condition, incrementor, body);
}

/** Pull a literal numeric value out of a TS expression, or `null` if it
 *  isn't a recognizable number-form. Handles `<n>`, `-<n>`, and `+<n>`. */
function literalNumber(expr: ts.Expression | null): number | null {
  if (!expr) return null;
  if (ts.isNumericLiteral(expr)) return Number(expr.text);
  if (ts.isPrefixUnaryExpression(expr)) {
    if (expr.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(expr.operand)) {
      return -Number(expr.operand.text);
    }
    if (expr.operator === ts.SyntaxKind.PlusToken && ts.isNumericLiteral(expr.operand)) {
      return Number(expr.operand.text);
    }
  }
  return null;
}

function iterableElementFactOf(expr: Expr | null, ctx: CompileContext): FlowFact | null {
  if (!expr) return null;
  const fact = flowFactOf(expr, ctx);
  if (fact?.kind === 'array') return fact.element;
  if (
    expr.type === 'Call'
    && expr.func.type === 'Global'
    && (expr.func.name === 'ipairs' || expr.func.name === 'pairs')
    && expr.args.length === 1
  ) {
    return iterableElementFactOf(expr.args[0]!, ctx);
  }
  if (expr.type === 'Call' && expr.func.type === 'IndexName') {
    const method = expr.func.index;
    if (method === 'GetChildren' || method === 'GetDescendants') {
      return { kind: 'class', name: 'Instance' };
    }
  }
  return null;
}

function loopValueCanUseClass(stat: ForInStat, className: string, ctx: CompileContext): boolean {
  const valueLocal = stat.vars.length >= 2
    ? stat.vars[1]?.name
    : stat.vars[0]?.name;
  if (!valueLocal) return false;
  let safe = true;
  const visitExpr = (expr: Expr | null | undefined): void => {
    if (!safe || !expr) return;
    switch (expr.type) {
      case 'Local':
      case 'Global':
      case 'ConstantNil':
      case 'ConstantBool':
      case 'ConstantNumber':
      case 'ConstantInteger':
      case 'ConstantString':
      case 'Varargs':
        return;
      case 'IndexName':
        if (expr.expr.type === 'Local' && expr.expr.name === valueLocal) {
          if (!oracleHasMember(ctx, className, expr.index)) safe = false;
        }
        visitExpr(expr.expr);
        return;
      case 'IndexExpr':
        if (expr.expr.type === 'Local' && expr.expr.name === valueLocal) {
          safe = false;
          return;
        }
        visitExpr(expr.expr);
        visitExpr(expr.index);
        return;
      case 'Call':
        if (expr.func.type === 'Local' && expr.func.name === valueLocal) {
          safe = false;
          return;
        }
        visitExpr(expr.func);
        for (const arg of expr.args) visitExpr(arg);
        return;
      case 'Binary':
        visitExpr(expr.left);
        visitExpr(expr.right);
        return;
      case 'Unary':
      case 'Group':
      case 'TypeAssertion':
        visitExpr(expr.expr);
        return;
      case 'IfElse':
        visitExpr(expr.condition);
        visitExpr(expr.trueExpr);
        visitExpr(expr.falseExpr);
        return;
      case 'Table':
        for (const item of expr.items) {
          if (item.key) visitExpr(item.key);
          visitExpr(item.value);
        }
        return;
      case 'Function':
        visitStat(expr.body);
        return;
      default:
        return;
    }
  };
  const visitStat = (statNode: Stat | null | undefined): void => {
    if (!safe || !statNode) return;
    switch (statNode.type) {
      case 'Block':
        for (const s of statNode.body) visitStat(s);
        return;
      case 'Expr':
        visitExpr(statNode.expr);
        return;
      case 'Return':
        for (const v of statNode.values) visitExpr(v);
        return;
      case 'Local':
        for (const v of statNode.values) visitExpr(v);
        return;
      case 'Assign':
        for (const v of statNode.vars) visitExpr(v);
        for (const v of statNode.values) visitExpr(v);
        return;
      case 'CompoundAssign':
        visitExpr(statNode.var);
        visitExpr(statNode.value);
        return;
      case 'If':
        visitExpr(statNode.condition);
        visitStat(statNode.thenBody);
        visitStat(statNode.elseBody);
        return;
      case 'While':
      case 'Repeat':
        visitExpr(statNode.condition);
        visitStat(statNode.body);
        return;
      case 'For':
        visitExpr(statNode.from);
        visitExpr(statNode.to);
        if (statNode.step) visitExpr(statNode.step);
        visitStat(statNode.body);
        return;
      case 'ForIn':
        for (const v of statNode.values) visitExpr(v);
        visitStat(statNode.body);
        return;
      case 'Function':
      case 'LocalFunction':
        visitStat(statNode.func.body);
        return;
      default:
        return;
    }
  };
  visitStat(stat.body);
  return safe;
}

function loopValueUsesMemberAccess(stat: ForInStat): boolean {
  const valueLocal = stat.vars.length >= 2
    ? stat.vars[1]?.name
    : stat.vars[0]?.name;
  if (!valueLocal) return false;
  let found = false;
  const visitExpr = (expr: Expr | null | undefined): void => {
    if (found || !expr) return;
    switch (expr.type) {
      case 'IndexName':
      case 'IndexExpr':
        if (expr.expr.type === 'Local' && expr.expr.name === valueLocal) {
          found = true;
          return;
        }
        visitExpr(expr.expr);
        if (expr.type === 'IndexExpr') visitExpr(expr.index);
        return;
      case 'Call':
        if (
          expr.func.type === 'Local'
          && expr.func.name === valueLocal
        ) {
          found = true;
          return;
        }
        visitExpr(expr.func);
        for (const arg of expr.args) visitExpr(arg);
        return;
      case 'Binary':
        visitExpr(expr.left);
        visitExpr(expr.right);
        return;
      case 'Unary':
      case 'Group':
      case 'TypeAssertion':
        visitExpr(expr.expr);
        return;
      case 'IfElse':
        visitExpr(expr.condition);
        visitExpr(expr.trueExpr);
        visitExpr(expr.falseExpr);
        return;
      case 'Table':
        for (const item of expr.items) {
          if (item.key) visitExpr(item.key);
          visitExpr(item.value);
        }
        return;
      case 'Function':
        visitStat(expr.body);
        return;
      default:
        return;
    }
  };
  const visitStat = (statNode: Stat | null | undefined): void => {
    if (found || !statNode) return;
    switch (statNode.type) {
      case 'Block':
        for (const s of statNode.body) visitStat(s);
        return;
      case 'Expr':
        visitExpr(statNode.expr);
        return;
      case 'Return':
        for (const v of statNode.values) visitExpr(v);
        return;
      case 'Local':
        for (const v of statNode.values) visitExpr(v);
        return;
      case 'Assign':
        for (const v of statNode.vars) visitExpr(v);
        for (const v of statNode.values) visitExpr(v);
        return;
      case 'CompoundAssign':
        visitExpr(statNode.var);
        visitExpr(statNode.value);
        return;
      case 'If':
        visitExpr(statNode.condition);
        visitStat(statNode.thenBody);
        visitStat(statNode.elseBody);
        return;
      case 'While':
      case 'Repeat':
        visitExpr(statNode.condition);
        visitStat(statNode.body);
        return;
      case 'For':
        visitExpr(statNode.from);
        visitExpr(statNode.to);
        if (statNode.step) visitExpr(statNode.step);
        visitStat(statNode.body);
        return;
      case 'ForIn':
        for (const v of statNode.values) visitExpr(v);
        visitStat(statNode.body);
        return;
      case 'Function':
      case 'LocalFunction':
        visitStat(statNode.func.body);
        return;
      default:
        return;
    }
  };
  visitStat(stat.body);
  return found;
}

function compileForIn(stat: ForInStat, ctx: CompileContext): ts.Statement[] {
  // Native-only fast path for explicit `ipairs(arr)` / `pairs(t)`. rbxts
  // handles every form below; this avoids the C-style
  // emit (`arr.length`) doesn't survive roblox-ts which uses `.size()`.
  if (
    ctx.compatMode !== 'rbxts'
    && stat.values.length === 1
    && stat.values[0]!.type === 'Call'
  ) {
    const call = stat.values[0] as Extract<Expr, { type: 'Call' }>;
    const callee = call.func;
    if (callee.type === 'Global' && (callee.name === 'ipairs' || callee.name === 'pairs') && call.args.length === 1) {
      const fast = compileForInFastPath(stat, callee.name, call.args[0]!, ctx);
      if (fast) return fast;
    }
  }

  // rbxts: emit `for (const v of value)` (single) or `for (const [i, v] of …)`
  // (multi). Unwrap explicit `ipairs(t)`/`pairs(t)` source calls so we don't
  // double-wrap.
  if (ctx.compatMode === 'rbxts') {
    let iterableSource: Expr | null = null;
    // pairs() preserves dict semantics (key = table key, not array index).
    let userWantsPairs = false;
    if (
      stat.values.length === 1
      && stat.values[0]!.type === 'Call'
      && stat.values[0]!.func.type === 'Global'
      && ((stat.values[0]!.func as { name: string }).name === 'ipairs'
        || (stat.values[0]!.func as { name: string }).name === 'pairs')
      && (stat.values[0]! as { args: Expr[] }).args.length === 1
    ) {
      iterableSource = (stat.values[0]! as { args: Expr[] }).args[0]!;
      userWantsPairs = (stat.values[0]!.func as { name: string }).name === 'pairs';
    }
    const iterableExpr = iterableSource
      ? compileExpr(iterableSource, ctx)
      : stat.values.length === 1
        ? compileExpr(stat.values[0]!, ctx)
        : factory.createArrayLiteralExpression(stat.values.map((v) => compileExpr(v, ctx)));
    const elementFact = !userWantsPairs
      ? iterableElementFactOf(iterableSource ?? (stat.values.length === 1 ? stat.values[0]! : null), ctx)
      : null;
    const canUseClassElement =
      elementFact?.kind === 'class'
      && loopValueCanUseClass(stat, elementFact.name, ctx);
    const useDynamicChildElement =
      !userWantsPairs
      && !canUseClassElement
      && loopValueUsesMemberAccess(stat);
    const seenForIn = new Set<string>();
    const forInNames = stat.vars.map((v, i) => {
      let name = safeIdentifier(v.name);
      if (seenForIn.has(name)) name = ctx.freshIdentifier(`${name}_skip_${i}`);
      seenForIn.add(name);
      return name;
    });
    const bodyStatements = ctx.withScope(() => {
      for (const v of stat.vars) ctx.defineLocal(v.name, 'unknown');
      return compileBlockBody(stat.body, ctx);
    });
    // Cast to `Array<any>` so the destructured element is `any` (not
    // `unknown`, which trips TS18046 on every body access). Route through
    // `unknown` so record-shaped sources don't trip TS2352.
    //
    let elementType: ts.TypeNode;
    if (canUseClassElement && elementFact) {
      elementType = typeNodeForFlowFact(elementFact) ?? factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);
    } else if (useDynamicChildElement) {
      ctx.useLuauChildType();
      elementType = factory.createTypeReferenceNode('_LuauChild', undefined);
    } else {
      elementType = factory.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword);
    }
    const castedIterable = factory.createAsExpression(
      factory.createAsExpression(
        iterableExpr,
        factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
      ),
      factory.createArrayTypeNode(elementType),
    );
    if (stat.vars.length === 1) {
      // `for v in arr do` — single binding, value-only iteration.
      return [
        factory.createForOfStatement(
          undefined,
          factory.createVariableDeclarationList(
            [factory.createVariableDeclaration(
              factory.createIdentifier(forInNames[0]!),
              undefined, undefined, undefined,
            )],
            ts.NodeFlags.Const,
          ),
          castedIterable,
          factory.createBlock(bodyStatements, true),
        ),
      ];
    }
    // Two-binding `for k, v in ...`: ipairs for array iteration, pairs for
    // dict. `pairs(... as any)` widens both destructured slots to `any`.
    const binding = factory.createArrayBindingPattern(
      forInNames.map((name) =>
        factory.createBindingElement(undefined, undefined, factory.createIdentifier(name)),
      ),
    );
    const iteratorFn = userWantsPairs ? 'pairs' : 'ipairs';
    if (userWantsPairs) ctx.useAmbient('pairs');
    const iterCall = factory.createCallExpression(
      factory.createIdentifier(iteratorFn),
      undefined,
      [
        userWantsPairs
          // pairs() expects an object — cast through `any` to
          // tolerate the Luau record-as-array idiom (`{[1]=…, ["k"]=…}`).
          ? factory.createAsExpression(
              iterableSource
                ? compileExpr(iterableSource, ctx)
                : (stat.values.length === 1
                    ? compileExpr(stat.values[0]!, ctx)
                    : factory.createArrayLiteralExpression(stat.values.map((v) => compileExpr(v, ctx)))),
              factory.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword),
            )
          : castedIterable,
      ],
    );
    // Keep the iterable typed as tuple entries. A bare `any` iterable
    // makes roblox-ts assert when lowering the binding pattern.
    const iterableForFor: ts.Expression = userWantsPairs
      ? factory.createAsExpression(
          factory.createAsExpression(
            iterCall,
            factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
          ),
          factory.createArrayTypeNode(factory.createTupleTypeNode([
            factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
            factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
          ])),
        )
      : iterCall;
    return [
      factory.createForOfStatement(
        undefined,
        factory.createVariableDeclarationList(
          [factory.createVariableDeclaration(binding, undefined, undefined, undefined)],
          ts.NodeFlags.Const,
        ),
        iterableForFor,
        factory.createBlock(bodyStatements, true),
      ),
    ];
  }

  const iterTriple = factory.createIdentifier(ctx.freshIdentifier('__iter'));
  const stateName = factory.createIdentifier(ctx.freshIdentifier('__state'));
  const ctrlName = factory.createIdentifier(ctx.freshIdentifier('__ctrl'));

  const rawValuesExpr =
    stat.values.length === 1
      ? compileExpr(stat.values[0]!, ctx)
      : factory.createArrayLiteralExpression(stat.values.map((v) => compileExpr(v, ctx)));

  // genericIter(expr) handles iterator-triple, callable, __iter metatable,
  // or plain table/array (Luau's no-pairs shorthand).
  const valuesExpr = factory.createCallExpression(
    factory.createIdentifier(ctx.use('genericIter')),
    undefined,
    [rawValuesExpr],
  );

  const initStmt = factory.createVariableStatement(
    undefined,
    factory.createVariableDeclarationList(
      [
        factory.createVariableDeclaration(
          factory.createArrayBindingPattern([
            factory.createBindingElement(undefined, undefined, iterTriple),
            factory.createBindingElement(undefined, undefined, stateName),
            factory.createBindingElement(undefined, undefined, ctrlName),
          ]),
          undefined,
          undefined,
          valuesExpr,
        ),
      ],
      ts.NodeFlags.Let,
    ),
  );

  // while (true) { const __step = __iter(__state, __ctrl); if (!__step) break;
  // __ctrl = __step[0]; const [k, v, ...] = __step; body; }
  const stepName = factory.createIdentifier(ctx.freshIdentifier('__step'));
  const stepDecl = factory.createVariableStatement(
    undefined,
    factory.createVariableDeclarationList(
      [
        factory.createVariableDeclaration(
          stepName,
          undefined,
          undefined,
          // Tolerate `for ... in expr` where `expr` evaluates to a single
          // non-iterator value (nil, a plain table, or a closure). Lua would
          // error anyway, but our scripts come from a binary place file we
          // don't fully model, so bail the loop cleanly instead of throwing.
          factory.createConditionalExpression(
            factory.createBinaryExpression(
              factory.createTypeOfExpression(iterTriple),
              factory.createToken(ts.SyntaxKind.EqualsEqualsEqualsToken),
              factory.createStringLiteral('function'),
            ),
            factory.createToken(ts.SyntaxKind.QuestionToken),
            factory.createCallExpression(iterTriple, undefined, [stateName, ctrlName]),
            factory.createToken(ts.SyntaxKind.ColonToken),
            factory.createIdentifier('undefined'),
          ),
        ),
      ],
      ts.NodeFlags.Const,
    ),
  );
  const breakIfDone = factory.createIfStatement(
    factory.createPrefixUnaryExpression(
      ts.SyntaxKind.ExclamationToken,
      factory.createBinaryExpression(
        stepName,
        ts.SyntaxKind.AmpersandAmpersandToken,
        factory.createBinaryExpression(
          factory.createElementAccessExpression(stepName, factory.createNumericLiteral(0)),
          ts.SyntaxKind.ExclamationEqualsEqualsToken,
          factory.createIdentifier('undefined'),
        ),
      ),
    ),
    factory.createBreakStatement(),
  );
  const updateCtrl = factory.createExpressionStatement(
    factory.createAssignment(
      ctrlName,
      factory.createElementAccessExpression(stepName, factory.createNumericLiteral(0)),
    ),
  );
  // Dedup destructure names (Luau allows multiple `_` placeholders; JS
  // forbids duplicates in one destructure) and emit `let` so the loop body
  // can reassign the iteration vars (Black Magic's `for c in gmatch do
  // c = c:gsub(...)` pattern).
  const seenForIn = new Set<string>();
  const forInNames = stat.vars.map((v) => {
    let name = safeIdentifier(v.name);
    if (seenForIn.has(name)) name = ctx.freshIdentifier(`${name}_skip`);
    seenForIn.add(name);
    return name;
  });
  const destructure = factory.createVariableStatement(
    undefined,
    factory.createVariableDeclarationList(
      [
        factory.createVariableDeclaration(
          factory.createArrayBindingPattern(
            forInNames.map((name) =>
              factory.createBindingElement(
                undefined,
                undefined,
                factory.createIdentifier(name),
              ),
            ),
          ),
          undefined,
          undefined,
          stepName,
        ),
      ],
      ts.NodeFlags.Let,
    ),
  );

  const bodyStatements = ctx.withScope(() => {
    for (const v of stat.vars) ctx.defineLocal(v.name, 'unknown');
    return compileBlockBody(stat.body, ctx);
  });

  const loop = factory.createWhileStatement(
    factory.createTrue(),
    factory.createBlock([stepDecl, breakIfDone, updateCtrl, destructure, ...bodyStatements], true),
  );

  // Slow path needs the iterator-triple binding to live alongside the
  // while loop in the same scope; a leading block-scoped `let` plus the
  // while is the right shape, returned as two sibling statements so the
  // emitted file doesn't get a redundant `{ … }` wrapper.
  return [initStmt, loop];
}

/** Fast path for `for k, v in ipairs(arr) do … end` and `for k, v in
 *  pairs(t) do … end` — the two cases that account for ~all real-world
 *  ForIn loops. Returns a TS for-of/for-in statement; null on mismatch
 *  so the caller falls back to the iterator-protocol expansion. */
function compileForInFastPath(
  stat: ForInStat,
  kind: 'ipairs' | 'pairs',
  iterableLuauExpr: Expr,
  ctx: CompileContext,
): ts.Statement[] | null {
  const iterable = compileExpr(iterableLuauExpr, ctx);
  const bodyStatements = ctx.withScope(() => {
    for (const v of stat.vars) ctx.defineLocal(v.name, 'unknown');
    return compileBlockBody(stat.body, ctx);
  });
  const block = factory.createBlock(bodyStatements, true);

  if (kind === 'ipairs') {
    // Do not emit JS `for-of` here. Runtime arrays use Symbol.iterator to
    // expose Luau's iterator triple for generic `for`, so JS `for-of` would
    // visit `[iterFn, state, ctrl]` instead of array values.
    if (stat.vars.length < 1 || stat.vars.length > 2) return null;
    const arrayName = ts.isIdentifier(iterable)
      ? iterable
      : factory.createIdentifier(ctx.freshIdentifier('__ipairs'));
    const indexName = factory.createIdentifier(ctx.freshIdentifier('__i'));
    const loopBody: ts.Statement[] = [];
    const pushConst = (name: string, initializer: ts.Expression): void => {
      if (name === '_') return;
      // `let`, not `const`: Luau permits reassigning the loop variable in
      // the body (e.g. Knit's Promise.all does `value = value:await()`).
      loopBody.push(
        factory.createVariableStatement(
          undefined,
          factory.createVariableDeclarationList(
            [
              factory.createVariableDeclaration(
                factory.createIdentifier(safeIdentifier(name)),
                undefined,
                undefined,
                initializer,
              ),
            ],
            ts.NodeFlags.Let,
          ),
        ),
      );
    };
    if (stat.vars.length === 1) {
      // `for i in ipairs(arr)` receives the 1-based index.
      pushConst(
        stat.vars[0]!.name,
        factory.createBinaryExpression(indexName, ts.SyntaxKind.PlusToken, factory.createNumericLiteral(1)),
      );
    } else {
      const idxVar = stat.vars[0]!;
      const valVar = stat.vars[1]!;
      pushConst(
        idxVar.name,
        factory.createBinaryExpression(indexName, ts.SyntaxKind.PlusToken, factory.createNumericLiteral(1)),
      );
      pushConst(valVar.name, factory.createElementAccessExpression(arrayName, indexName));
    }
    loopBody.push(...bodyStatements);
    const loop = factory.createForStatement(
      factory.createVariableDeclarationList(
        [
          factory.createVariableDeclaration(
            indexName,
            undefined,
            undefined,
            factory.createNumericLiteral(0),
          ),
        ],
        ts.NodeFlags.Let,
      ),
      factory.createBinaryExpression(
        indexName,
        ts.SyntaxKind.LessThanToken,
        factory.createPropertyAccessExpression(arrayName, factory.createIdentifier('length')),
      ),
      factory.createPostfixIncrement(indexName),
      factory.createBlock(loopBody, true),
    );
    if (ts.isIdentifier(iterable)) return [loop];
    const hoist = factory.createVariableStatement(
      undefined,
      factory.createVariableDeclarationList(
        [factory.createVariableDeclaration(arrayName, undefined, undefined, iterable)],
        ts.NodeFlags.Const,
      ),
    );
    return [hoist, loop];
    // `for _, v in ipairs(arr) do …` → `for (const v of arr) { … }`
    // `for i, v in ipairs(arr) do …` → `for (const [i_zero, v] of arr.entries()) { const i = i_zero + 1; … }`
    if (stat.vars.length === 1) {
      const valVar = stat.vars[0]!;
      return [factory.createForOfStatement(
        undefined,
        factory.createVariableDeclarationList(
          [
            factory.createVariableDeclaration(
              factory.createIdentifier(safeIdentifier(valVar.name)),
            ),
          ],
          ts.NodeFlags.Const,
        ),
        iterable,
        block,
      )];
    }
    if (stat.vars.length === 2) {
      const idxVar = stat.vars[0]!;
      const valVar = stat.vars[1]!;
      // If the index var is `_`, omit it entirely — `for (const v of arr)`.
      if (idxVar.name === '_') {
        return [factory.createForOfStatement(
          undefined,
          factory.createVariableDeclarationList(
            [
              factory.createVariableDeclaration(
                factory.createIdentifier(safeIdentifier(valVar.name)),
              ),
            ],
            ts.NodeFlags.Const,
          ),
          iterable,
          block,
        )];
      }
      // Otherwise destructure with .entries() and rebase to 1-indexed via
      // a single prelude `const i = __i + 1` so the user's `i` variable
      // matches Lua semantics.
      const zeroIdx = factory.createIdentifier(`__${safeIdentifier(idxVar.name)}_zero`);
      const userIdx = factory.createIdentifier(safeIdentifier(idxVar.name));
      const prelude = factory.createVariableStatement(
        undefined,
        factory.createVariableDeclarationList(
          [
            factory.createVariableDeclaration(
              userIdx,
              undefined,
              undefined,
              factory.createBinaryExpression(zeroIdx, ts.SyntaxKind.PlusToken, factory.createNumericLiteral(1)),
            ),
          ],
          ts.NodeFlags.Const,
        ),
      );
      return [factory.createForOfStatement(
        undefined,
        factory.createVariableDeclarationList(
          [
            factory.createVariableDeclaration(
              factory.createArrayBindingPattern([
                factory.createBindingElement(undefined, undefined, zeroIdx),
                factory.createBindingElement(
                  undefined,
                  undefined,
                  factory.createIdentifier(safeIdentifier(valVar.name)),
                ),
              ]),
              undefined,
              undefined,
              undefined,
            ),
          ],
          ts.NodeFlags.Const,
        ),
        factory.createCallExpression(
          factory.createPropertyAccessExpression(iterable, factory.createIdentifier('entries')),
          undefined,
          [],
        ),
        factory.createBlock([prelude, ...bodyStatements], true),
      )];
    }
    return null;
  }

  // pairs(t): native uses pairKeys/pairValue helpers (preserves Instance
  // keys); rbxts defers to roblox-ts's typed `pairs` global.
  if (ctx.compatMode === 'rbxts') {
    ctx.useAmbient('pairs');
    const seenP = new Set<string>();
    const pNames = stat.vars.map((v, i) => {
      let n = safeIdentifier(v.name);
      if (seenP.has(n)) n = ctx.freshIdentifier(`${n}_skip_${i}`);
      seenP.add(n);
      return n;
    });
    const binding = stat.vars.length === 1
      ? factory.createIdentifier(pNames[0]!)
      : factory.createArrayBindingPattern(
          pNames.map((n) =>
            factory.createBindingElement(undefined, undefined, factory.createIdentifier(n)),
          ),
        );
    return [
      factory.createForOfStatement(
        undefined,
        factory.createVariableDeclarationList(
          [factory.createVariableDeclaration(binding, undefined, undefined, undefined)],
          ts.NodeFlags.Const,
        ),
        factory.createCallExpression(
          factory.createIdentifier('pairs'),
          undefined,
          [iterable],
        ),
        block,
      ),
    ];
  }
  const pairKeysFn = ctx.use('pairKeys');
  const pairValueFn = ctx.use('pairValue');
  if (stat.vars.length === 1) {
    const keyVar = stat.vars[0]!;
    return [factory.createForOfStatement(
      undefined,
      factory.createVariableDeclarationList(
        [
          factory.createVariableDeclaration(
            factory.createIdentifier(safeIdentifier(keyVar.name)),
          ),
        ],
        ts.NodeFlags.Let,
      ),
      factory.createCallExpression(
        factory.createIdentifier(pairKeysFn),
        undefined,
        [iterable],
      ),
      block,
    )];
  }
  if (stat.vars.length === 2) {
    const keyVar = stat.vars[0]!;
    const valVar = stat.vars[1]!;
    // Hoist the table to a local so pairKeys(t) and pairValue(t, k)
    // reference the same expression. Use a `__t` synthetic name; if
    // `iterable` is already a plain identifier we can skip the hoist.
    const tableName = ts.isIdentifier(iterable)
      ? iterable
      : factory.createIdentifier(ctx.freshIdentifier('__t'));
    const valDecl = factory.createVariableStatement(
      undefined,
      factory.createVariableDeclarationList(
        [
          factory.createVariableDeclaration(
            factory.createIdentifier(safeIdentifier(valVar.name)),
            undefined,
            undefined,
            factory.createCallExpression(
              factory.createIdentifier(pairValueFn),
              undefined,
              [tableName, factory.createIdentifier(safeIdentifier(keyVar.name))],
            ),
          ),
        ],
        ts.NodeFlags.Let,
      ),
    );
    const loop = factory.createForOfStatement(
      undefined,
      factory.createVariableDeclarationList(
        [
          factory.createVariableDeclaration(
            factory.createIdentifier(safeIdentifier(keyVar.name)),
          ),
        ],
        ts.NodeFlags.Let,
      ),
      factory.createCallExpression(
        factory.createIdentifier(pairKeysFn),
        undefined,
        [tableName],
      ),
      factory.createBlock([valDecl, ...bodyStatements], true),
    );
    if (ts.isIdentifier(iterable)) return [loop];
    // Hoist `__t = <iterable>` as a sibling const decl rather than
    // wrapping the loop in a TS block — the visual noise of the extra
    // braces isn't worth the local-scoping gain since `__t` only refs
    // here and inside the loop body anyway.
    const hoist = factory.createVariableStatement(
      undefined,
      factory.createVariableDeclarationList(
        [factory.createVariableDeclaration(tableName, undefined, undefined, iterable)],
        ts.NodeFlags.Const,
      ),
    );
    return [hoist, loop];
  }
  return null;
}

/** Build an assignment statement for one LHS/RHS pair. `IndexExpr` targets
 *  with a non-literal key route through `luaIndexSet(t, k, v)` so we don't
 *  emit `luaIndex(t, k) = v` (which is not a valid TS LHS). Literal numeric
 *  / string keys keep plain bracket-assignment shape. All other lvalues
 *  (locals, globals, dotted property access) compile straight through. */
function buildAssignmentStatement(
  target: Expr,
  valueExpr: ts.Expression,
  ctx: CompileContext,
): ts.Statement {
  if (target.type === 'IndexExpr') {
    const indexExpr = target.index;
    // Literal numeric: `t[1] = v` → `t[0] = v`.
    if (
      (indexExpr.type === 'ConstantNumber' || indexExpr.type === 'ConstantInteger')
      && typeof (indexExpr as { value: number }).value === 'number'
    ) {
      const n = (indexExpr as { value: number }).value - 1;
      const lit = n < 0
        ? factory.createPrefixUnaryExpression(
            ts.SyntaxKind.MinusToken,
            factory.createNumericLiteral(Math.abs(n)),
          )
        : factory.createNumericLiteral(n);
      let recv = compileExpr(target.expr, ctx);
      // rbxts: chained LHS `obj[k][N] = v` — recast inner receiver through
      // Record so the literal-index assignment slot accepts the RHS.
      if (
        ctx.compatMode === 'rbxts'
        && (target.expr.type === 'IndexExpr' || target.expr.type === 'IndexName')
      ) {
        recv = factory.createParenthesizedExpression(
          factory.createAsExpression(
            factory.createAsExpression(
              recv,
              factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
            ),
            factory.createTypeReferenceNode('Record', [
              factory.createUnionTypeNode([
                factory.createKeywordTypeNode(ts.SyntaxKind.StringKeyword),
                factory.createKeywordTypeNode(ts.SyntaxKind.NumberKeyword),
              ]),
              factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
            ]),
          ),
        );
      }
      return factory.createExpressionStatement(
        factory.createAssignment(
          factory.createElementAccessExpression(recv, lit),
          valueExpr,
        ),
      );
    }
    // Literal string: `t["k"] = v` → plain bracket assignment.
    if (indexExpr.type === 'ConstantString') {
      return factory.createExpressionStatement(
        factory.createAssignment(
          factory.createElementAccessExpression(
            compileExpr(target.expr, ctx),
            compileExpr(indexExpr, ctx),
          ),
          valueExpr,
        ),
      );
    }
    // Runtime key: in rbxts mode emit native bracket assignment — roblox-ts
    // preserves variable indices verbatim when compiling TS to Lua, so a
    // Luau `t[k]` round-trips as Lua `t[k]`. In native mode we need the
    // luaIndexSet helper because the JS runtime needs to translate 1-based
    // Luau idioms (and `luaIndex(t, k) = v` isn't a valid TS lvalue).
    if (ctx.compatMode === 'rbxts') {
      // Cast receiver → Record<string, unknown> so the assignment accepts
      // any RHS; cast key through `unknown as string` so Instance/Player
      // keys flow without TS2538.
      const recv = factory.createParenthesizedExpression(
        factory.createAsExpression(
          factory.createAsExpression(
            compileExpr(target.expr, ctx),
            factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
          ),
          factory.createTypeReferenceNode('Record', [
            factory.createKeywordTypeNode(ts.SyntaxKind.StringKeyword),
            factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
          ]),
        ),
      );
      const key = factory.createAsExpression(
        factory.createAsExpression(
          compileExpr(indexExpr, ctx),
          factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
        ),
        factory.createKeywordTypeNode(ts.SyntaxKind.StringKeyword),
      );
      return factory.createExpressionStatement(
        factory.createAssignment(
          factory.createElementAccessExpression(recv, key),
          valueExpr,
        ),
      );
    }
    const luaIndexSetFn = ctx.use('luaIndexSet');
    return factory.createExpressionStatement(
      factory.createCallExpression(
        factory.createIdentifier(luaIndexSetFn),
        undefined,
        [compileExpr(target.expr, ctx), compileExpr(indexExpr, ctx), valueExpr],
      ),
    );
  }
  return factory.createExpressionStatement(
    factory.createAssignment(compileLValue(target, ctx), valueExpr),
  );
}

/** Compile a Luau expression intended as an assignment LHS. Identical
 *  to compileExpr for most shapes, BUT skips the rbxts-mode `as any`
 *  cast on `.Parent` access — TS rejects `x.Parent as any = y` as a
 *  syntactically invalid lvalue. The cast is only needed for read
 *  positions to absorb @rbxts/types' `Instance | undefined` narrowing;
 *  on write the property exists at runtime so plain access works. */
/** Build an IndexName-chain receiver for an assignment LHS, casting
 *  the deepest Local/Global root through `_LuauChild` so each
 *  intermediate dot-access resolves to `_LuauChild` (the recursive
 *  dynamic-child interface) instead of failing against a narrow
 *  declared type like Frame. The OUTERMOST receiver (the one whose
 *  property is being assigned) is then re-cast through Record in the
 *  caller — this helper just builds the readable chain underneath. */
function compileLValueReceiver(expr: Expr, ctx: CompileContext): ts.Expression {
  if (ctx.compatMode !== 'rbxts') return compileExpr(expr, ctx);
  if (expr.type !== 'IndexName') return compileExpr(expr, ctx);
  // Recurse: compile the inner expression. If THAT is itself an
  // IndexName, keep peeling. The leaf (Local/Global) gets cast to
  // `_LuauChild`.
  const inner = expr.expr;
  if (inner.type === 'Local' || inner.type === 'Global') {
    ctx.useLuauChildType();
    const wrapped = factory.createParenthesizedExpression(
      factory.createAsExpression(
        factory.createAsExpression(
          compileExpr(inner, ctx),
          factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
        ),
        factory.createTypeReferenceNode('_LuauChild', undefined),
      ),
    );
    return factory.createPropertyAccessExpression(
      wrapped,
      factory.createIdentifier(propertyName(expr.index)),
    );
  }
  if (inner.type === 'IndexName') {
    return factory.createPropertyAccessExpression(
      compileLValueReceiver(inner, ctx),
      factory.createIdentifier(propertyName(expr.index)),
    );
  }
  return compileExpr(expr, ctx);
}

function compileLValue(target: Expr, ctx: CompileContext): ts.Expression {
  if (target.type === 'IndexName') {
    // rbxts: cast receiver to Record<string, unknown> on monkey-patch
    // writes (`ProfileService.GetProfileStore = fn`). Skip on `self`
    // (class-field writes must hit the class declaration) and on
    // non-identifier property names. Also fires for IndexName chain
    // receivers (`Players.LocalPlayer.Gui.X = …`) where the chain type
    // bottoms out at `_LuauChild` and TS2322s on primitive writes.
    const isSelf =
      (target.expr.type === 'Local' && (target.expr as { name: string }).name === 'self')
      || (target.expr.type === 'Global' && (target.expr as { name: string }).name === 'self');
    const receiverIsChainable =
      target.expr.type === 'Local'
      || target.expr.type === 'Global'
      || target.expr.type === 'IndexName'
      || target.expr.type === 'Call';
    if (
      ctx.compatMode === 'rbxts'
      && !isSelf
      && receiverIsChainable
      && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(target.index)
    ) {
      // Phase 3e: when the receiver is a Local whose class is oracle-
      // known AND the property has an expressible type (class or
      // primitive), drop the Record<string, unknown> wrap entirely.
      // Use `recv!.prop` to absorb the optional case when the local
      // was declared `ClassName | undefined` — the script's pattern
      // assumes the value is present at this point.
      if (
        target.expr.type === 'Local'
        && ctx.tsTypedClassLocal.has(target.expr.name)
        && !ctx.tsLuauChildLocal.has(target.expr.name)
      ) {
        const cls = ctx.tsTypedClassLocal.get(target.expr.name)!;
        const propType = ctx.oracle.propertyType(cls, target.index);
        if (
          propType
          && (propType.kind === 'class'
              || (propType.kind === 'primitive' && propType.name !== 'unknown'))
        ) {
          return factory.createPropertyAccessExpression(
            factory.createNonNullExpression(compileExpr(target.expr, ctx)),
            factory.createIdentifier(propertyName(target.index)),
          );
        }
      }
      // Chain receivers (`a.b.c.Size = X`) route the leaf Local through
      // `_LuauChild` so each intermediate `.X` resolves dynamically.
      const receiverExpr = compileLValueReceiver(target.expr, ctx);
      return factory.createPropertyAccessExpression(
        factory.createParenthesizedExpression(
          factory.createAsExpression(
            factory.createAsExpression(
              receiverExpr,
              factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
            ),
            factory.createTypeReferenceNode('Record', [
              factory.createKeywordTypeNode(ts.SyntaxKind.StringKeyword),
              factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
            ]),
          ),
        ),
        factory.createIdentifier(propertyName(target.index)),
      );
    }
    return factory.createPropertyAccessExpression(
      compileExpr(target.expr, ctx),
      factory.createIdentifier(propertyName(target.index)),
    );
  }
  return compileExpr(target, ctx);
}

/** True for calls whose runtime return is `LuaTuple<...>` per @rbxts/types —
 *  namespace `string.X` (gsub/find/match), method-form `s:X(...)`, bare
 *  `pcall`/`xpcall`, file-local user functions tagged by the pre-scan. */
function isLuaTupleCall(callExpr: Expr, ctx: CompileContext): boolean {
  if (callExpr.type !== 'Call') return false;
  const fn = callExpr.func;
  if (fn.type === 'IndexName') {
    const tupleMethods = new Set(['gsub', 'find', 'match', 'gmatch']);
    if (tupleMethods.has(fn.index)) {
      // namespace form: string.X(...)
      if (fn.expr.type === 'Global' && fn.expr.name === 'string') return true;
      // method form on string receiver
      if (staticTypeOfExpr(fn.expr, ctx) === 'string') return true;
    }
  }
  if (fn.type === 'Global') {
    if (fn.name === 'pcall' || fn.name === 'xpcall') return true;
    if (ctx.luaTupleReturningFunctions.has(fn.name)) return true;
  }
  if (fn.type === 'Local' && ctx.luaTupleReturningFunctions.has(fn.name)) return true;
  return false;
}

/** True when an expression compiles to a value whose TS-side type is
 *  unambiguously `unknown` — bare GetAttribute call results, unannotated
 *  param Locals, or `?: unknown` typed scope variables. Used by the
 *  Phase 3e RHS-cast logic to decide whether a single `as ClassName`
 *  cast is safe vs needing the unknown-bridge. */
function isBareUnknownTyped(expr: Expr, ctx: CompileContext): boolean {
  if (expr.type === 'Call') {
    const fn = expr.func;
    if (fn.type === 'IndexName' && fn.index === 'GetAttribute' && expr.self) return true;
  }
  if (expr.type === 'Local') {
    // Param with `?: unknown` declared (no preInferredParamType entry
    // and no tracked class).
    if (
      !ctx.preInferredParamType.has(expr.name)
      && !ctx.tsTypedPrimitiveLocal.has(expr.name)
      && !ctx.tsTypedClassLocal.has(expr.name)
      && ctx.lookupLocal(expr.name) === 'unknown'
    ) {
      // Could be either a `?: unknown` param OR a shape-inferred local.
      // Be conservative: only return true when we can't see a shape.
      const shape = ctx.getShape(expr.name);
      return !shape;
    }
  }
  return false;
}

function compileAssign(stat: AssignStat, ctx: CompileContext): ts.Statement[] {
  // ExprError on either side means the parser couldn't recover. Skip the
  // whole statement — emitting it as JS would produce "invalid assignment
  // target" since the placeholder IIFE isn't a valid lvalue.
  const containsErr = (node: unknown): boolean => {
    if (!node || typeof node !== 'object') return false;
    const t = (node as { type?: string }).type;
    if (t === 'Error' || t === 'ExprError' || t === 'UnknownExpr') return true;
    for (const v of Object.values(node as Record<string, unknown>)) {
      if (Array.isArray(v)) { if (v.some(containsErr)) return true; }
      else if (v && typeof v === 'object') { if (containsErr(v)) return true; }
    }
    return false;
  };
  if (stat.vars.some(containsErr) || stat.values.some(containsErr)) {
    return [];
  }
  // Single RHS call with multiple LHS → destructuring assignment.
  if (stat.vars.length > 1 && stat.values.length === 1 && stat.values[0]?.type === 'Call') {
    const targets = stat.vars.map((v) => compileExpr(v, ctx));
    // The RHS call genuinely consumes the multi-return tuple; suppress
    // the rbxts-mode single-value auto-extraction (`(string.gsub(...))[0]`).
    const savedMR = ctx.preferMultiReturn;
    ctx.preferMultiReturn = true;
    const rawRhs = compileExpr(stat.values[0]!, ctx);
    ctx.preferMultiReturn = savedMR;
    const assignmentTupleType = factory.createTupleTypeNode(
      stat.vars.map((target) =>
        target.type === 'Local'
          ? factory.createTypeQueryNode(factory.createIdentifier(safeIdentifier(target.name)))
          : factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
      ),
    );
    const valueExpr = ctx.compatMode === 'rbxts'
      ? factory.createAsExpression(
          factory.createAsExpression(
            rawRhs,
            factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
          ),
          assignmentTupleType,
        )
      : factory.createCallExpression(
          factory.createIdentifier(ctx.use('multiret')),
          undefined,
          [rawRhs],
        );
    for (const target of stat.vars) {
      if (target.type === 'Local') ctx.assignLocal(target.name, 'unknown');
    }
    return [
      factory.createExpressionStatement(
        factory.createAssignment(
          factory.createArrayLiteralExpression(targets),
          valueExpr,
        ),
      ),
    ];
  }
  // rbxts: single-LHS, single-RHS, RHS is a LuaTuple-returning call (the
  // `string.gsub` / `string.find` / `string.match` family or pcall) — emit
  // a one-tuple destructure-assign so the [0] postfix + re-cast scaffold
  // collapses. `withCommas = withCommas.gsub("^,", "")` →
  // `[withCommas] = withCommas.gsub("^,", "")`.
  if (
    ctx.compatMode === 'rbxts'
    && stat.vars.length === 1
    && stat.values.length === 1
    && stat.values[0]?.type === 'Call'
    && isLuaTupleCall(stat.values[0]!, ctx)
  ) {
    const target = stat.vars[0]!;
    const compiledTarget = compileExpr(target, ctx);
    const savedMR = ctx.preferMultiReturn;
    ctx.preferMultiReturn = true;
    const rhs = compileExpr(stat.values[0]!, ctx);
    ctx.preferMultiReturn = savedMR;
    if (target.type === 'Local') ctx.assignLocal(target.name, staticTypeOfExpr(stat.values[0]!, ctx));
    return [
      factory.createExpressionStatement(
        factory.createAssignment(
          factory.createArrayLiteralExpression([compiledTarget], false),
          rhs,
        ),
      ),
    ];
  }
  // For the LocalStat single-LHS LuaTuple destructure branch above to
  // also enrol the bound local in `tsTypedPrimitiveLocal`, we tag it
  // when entering that branch. Handled inline below.
  const stmts: ts.Statement[] = [];
  for (let i = 0; i < stat.vars.length; i += 1) {
    const target = stat.vars[i]!;
    const value = stat.values[i];
    if (!value) continue;
    let valueExpr = compileExpr(value, ctx);
    // rbxts Phase 3e: when target is `self.X` (a class field) and the
    // class-shape pass synthesized a field type, cast RHS through that
    // shape so `self._query_pages = call()` (RHS unknown) doesn't fail
    // TS2322. Single `as <shape>` handles unknown→typed.
    if (
      ctx.compatMode === 'rbxts'
      && target.type === 'IndexName'
      && target.expr.type === 'Local'
      && target.expr.name === 'self'
      && ctx.selfFieldShapes
      && ctx.selfFieldShapes.has(target.index)
    ) {
      const fieldShape = ctx.selfFieldShapes.get(target.index) as import('./shape-infer.js').Shape;
      const fieldTypeNode = shapeToTypeNode(fieldShape);
      if (fieldTypeNode) {
        const valStatic = staticTypeOfExpr(value, ctx);
        const innerVE = ts.isBinaryExpression(valueExpr) || ts.isConditionalExpression(valueExpr)
          ? factory.createParenthesizedExpression(valueExpr)
          : valueExpr;
        // unknown overlaps with anything → single `as <shape>` ok.
        // Concrete-mismatched types need the unknown bridge to satisfy TS2352.
        if ((valStatic as StaticValueType) === 'unknown') {
          valueExpr = factory.createAsExpression(innerVE, fieldTypeNode);
        } else {
          valueExpr = factory.createAsExpression(
            factory.createAsExpression(
              innerVE,
              factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
            ),
            fieldTypeNode,
          );
        }
      }
    }
    // rbxts Phase 3e: when target is `localClass.prop` (a known class
    // member) and we'll skip the receiver Record wrap, cast RHS through
    // the property's declared type so TS doesn't fail with TS2322.
    // Single `as PropType` handles unknown→typed without a bridge.
    if (
      ctx.compatMode === 'rbxts'
      && target.type === 'IndexName'
      && target.expr.type === 'Local'
      && ctx.tsTypedClassLocal.has(target.expr.name)
    ) {
      const cls = ctx.tsTypedClassLocal.get(target.expr.name)!;
      const propType = ctx.oracle.propertyType(cls, target.index);
      // Class-typed property: cast RHS to the class. We only emit a
      // single `as ClassName` (no bridge) when RHS's TS-side type is
      // unambiguously assignable — bare `unknown`-typed sources from
      // GetAttribute / param. For locals with synthesized literal
      // shape annotations and other ambiguous sources, route through
      // unknown so TS2352 doesn't fire on non-overlapping types.
      if (propType && propType.kind === 'class') {
        const valIsBareUnknown = isBareUnknownTyped(value, ctx);
        const propTypeNode = factory.createTypeReferenceNode(propType.name, undefined);
        if (valIsBareUnknown) {
          valueExpr = factory.createAsExpression(valueExpr, propTypeNode);
        } else {
          // Disjoint concrete types: route through unknown.
          valueExpr = factory.createAsExpression(
            factory.createAsExpression(
              ts.isBinaryExpression(valueExpr) || ts.isConditionalExpression(valueExpr)
                ? factory.createParenthesizedExpression(valueExpr)
                : valueExpr,
              factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
            ),
            propTypeNode,
          );
        }
      } else if (propType?.kind === 'primitive' && propType.name !== 'unknown') {
        const valStatic = staticTypeOfExpr(value, ctx);
        if (valStatic !== propType.name) {
          const primNode = factory.createKeywordTypeNode(
            propType.name === 'number' ? ts.SyntaxKind.NumberKeyword
              : propType.name === 'string' ? ts.SyntaxKind.StringKeyword
              : ts.SyntaxKind.BooleanKeyword,
          );
          const inner = ts.isBinaryExpression(valueExpr) || ts.isConditionalExpression(valueExpr)
            ? factory.createParenthesizedExpression(valueExpr)
            : valueExpr;
          if ((valStatic as StaticValueType) === 'unknown') {
            valueExpr = factory.createAsExpression(inner, primNode);
          } else {
            valueExpr = factory.createAsExpression(
              factory.createAsExpression(
                inner,
                factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
              ),
              primNode,
            );
          }
        }
      }
      // For non-class non-primitive property types (Enum unions, raw
      // textual types), the cast isn't safely expressible without a
      // bridge — fall back to the receiver-Record cast path.
    }
    // Capture pre-assignment tracked type — the reassign-cast fallback uses
    // it to widen the RHS for primitive-typed locals.
    const targetTrackedType = target.type === 'Local'
      ? ctx.lookupLocal((target as { name: string }).name)
      : 'unknown';
    if (target.type === 'Local') ctx.assignLocal(target.name, staticTypeOfExpr(value, ctx));
    // rbxts: cast RHS through the local's inferred shape so an unknown
    // source still satisfies the declared shape.
    if (ctx.compatMode === 'rbxts' && target.type === 'Local') {
      // Primitive-tracked locals prefer the widened keyword type — the
      // shape from `s:gsub(...)`-style observations would emit a wider
      // `{gsub(...)}` literal that no longer accepts a `string` RHS.
      const isPrimitiveTracked =
        targetTrackedType === 'string'
        || targetTrackedType === 'number'
        || targetTrackedType === 'boolean';
      // Skip the shape-cast wrap when the RHS is already oracle-typed
      // (Instance.new, service property access, navigation method
      // result), OR when the target was originally declared with an
      // oracle-typed init (its TS class survives reassigns).
      const valueIsOracleTyped = initIsOracleTyped(value, ctx);
      const targetIsTypedClass = target.type === 'Local'
        && ctx.tsTypedClassLocal.has((target as { name: string }).name);
      const inferred = (isPrimitiveTracked || valueIsOracleTyped || targetIsTypedClass)
        ? undefined
        : (ctx.getShape((target as { name: string }).name) as
            | import('./shape-infer.js').Shape
            | undefined);
      const fromShape = inferred ? shapeToTypeNode(inferred) : null;
      // Paren-wrap binary/ternary first: `as` binds tighter than `||`/`??`/`&&`.
      const inner = (
        ts.isBinaryExpression(valueExpr)
        || ts.isConditionalExpression(valueExpr)
      )
        ? factory.createParenthesizedExpression(valueExpr)
        : valueExpr;
      if (fromShape) {
        valueExpr = factory.createAsExpression(
          factory.createAsExpression(
            inner,
            factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
          ),
          fromShape,
        );
      } else {
        // Primitive keywords (not `typeof <local>`) — TS's typeof resolves to
        // the literal `false`/`"foo"` for `let x = false`, breaking TS2367.
        const tracked = targetTrackedType;
        const primitiveTypeNode: ts.TypeNode | null =
          tracked === 'string' ? factory.createKeywordTypeNode(ts.SyntaxKind.StringKeyword)
          : tracked === 'number' ? factory.createKeywordTypeNode(ts.SyntaxKind.NumberKeyword)
          : tracked === 'boolean' ? factory.createKeywordTypeNode(ts.SyntaxKind.BooleanKeyword)
          : null;
        if (primitiveTypeNode) {
          // Skip the cast when RHS already has the target's primitive type —
          // `let x: boolean; x = true` doesn't need `true as unknown as boolean`.
          const rhsStatic = staticTypeOfExpr(value, ctx);
          if (rhsStatic === tracked) {
            valueExpr = inner;
          } else {
            valueExpr = factory.createAsExpression(
              factory.createAsExpression(
                inner,
                factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
              ),
              primitiveTypeNode,
            );
          }
        } else {
          // Non-primitive tracked (`unknown`, `datatype:X`) — `typeof <local>`
          // catches array-init and table-init locals, plus `x = nil` resets.
          valueExpr = factory.createAsExpression(
            factory.createAsExpression(
              inner,
              factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
            ),
            factory.createTypeQueryNode(
              factory.createIdentifier(safeIdentifier((target as { name: string }).name)),
            ),
          );
        }
      }
    }
    if (
      ctx.compatMode === 'rbxts'
      && target.type === 'Local'
      && ctx.tsLuauChildLocal.has(target.name)
    ) {
      const inner = (
        ts.isBinaryExpression(valueExpr)
        || ts.isConditionalExpression(valueExpr)
      )
        ? factory.createParenthesizedExpression(valueExpr)
        : valueExpr;
      valueExpr = factory.createAsExpression(
        factory.createAsExpression(
          inner,
          factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
        ),
        factory.createTypeQueryNode(factory.createIdentifier(safeIdentifier(target.name))),
      );
    }
    // Non-literal numeric `tbl[k] = v` routes through luaIndexSet (plain
    // `=` would emit `luaIndex(tbl, k) = v`, not a valid lvalue).
    const writeStmt = buildAssignmentStatement(target, valueExpr, ctx);
    stmts.push(writeStmt);
    // `_G["X"] = v` mirrors to the matching local since our _G is a plain
    // object and a later bare `X(...)` would read the predecl (undefined).
    const tgt = target as { type?: string; expr?: { type?: string; name?: string }; index?: { type?: string; value?: string } };
    if (
      tgt.type === 'IndexExpr'
      && tgt.expr?.type === 'Global'
      && tgt.expr.name === '_G'
      && tgt.index?.type === 'ConstantString'
      && typeof tgt.index.value === 'string'
      && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(tgt.index.value)
    ) {
      stmts.push(
        factory.createExpressionStatement(
          factory.createAssignment(
            factory.createIdentifier(safeIdentifier(tgt.index.value)),
            factory.createElementAccessExpression(
              factory.createIdentifier('_G'),
              factory.createStringLiteral(tgt.index.value),
            ),
          ),
        ),
      );
    }
  }
  return stmts;
}

function compileCompoundAssign(stat: CompoundAssignStat, ctx: CompileContext): ts.Statement {
  const target = compileExpr(stat.var, ctx);
  const value = compileExpr(stat.value, ctx);
  if (stat.var.type === 'Local') {
    const numericOps = new Set(['+', '-', '*', '/', '%', '^', '//']);
    const nextType =
      numericOps.has(stat.op)
      && staticTypeOfExpr(stat.var, ctx) === 'number'
      && staticTypeOfExpr(stat.value, ctx) === 'number'
        ? 'number'
        : 'unknown';
    ctx.assignLocal(stat.var.name, nextType);
  }
  // `t[k] += v` (and friends) with a non-literal numeric key would otherwise
  // emit `luaIndex(t, k) += v`, which is not a valid TS lvalue. Expand to
  // `luaIndexSet(t, k, luaIndex(t, k) <op> v)` so reads + writes both go
  // through the array-vs-dict helper.
  const newValue =
    stat.op === '..'
      ? factory.createCallExpression(
          factory.createIdentifier(ctx.use('luaConcat')),
          undefined,
          [target, value],
        )
      : stat.op === '//'
        ? factory.createCallExpression(
            factory.createIdentifier(ctx.use('luaIdiv')),
            undefined,
            [target, value],
          )
        : compileBinary(stat.op, target, value, ctx);
  if (
    stat.var.type === 'IndexExpr'
    && stat.var.index.type !== 'ConstantNumber'
    && stat.var.index.type !== 'ConstantInteger'
    && stat.var.index.type !== 'ConstantString'
  ) {
    return buildAssignmentStatement(stat.var, newValue, ctx);
  }
  const op = compoundAssignToken(stat.op);
  if (op !== undefined && stat.op !== '..' && stat.op !== '//') {
    // rbxts: expand to `target = target <op> value` so compileBinary's
    // operand widening fires (unknown += unknown would TS18046).
    if (ctx.compatMode === 'rbxts') {
      return factory.createExpressionStatement(
        factory.createAssignment(compileLValue(stat.var, ctx), newValue),
      );
    }
    return factory.createExpressionStatement(factory.createBinaryExpression(target, op, value));
  }
  return factory.createExpressionStatement(factory.createAssignment(target, newValue));
}

function compoundAssignToken(op: string): ts.BinaryOperator | undefined {
  switch (op) {
    case '+':
      return ts.SyntaxKind.PlusEqualsToken;
    case '-':
      return ts.SyntaxKind.MinusEqualsToken;
    case '*':
      return ts.SyntaxKind.AsteriskEqualsToken;
    case '/':
      return ts.SyntaxKind.SlashEqualsToken;
    case '%':
      return ts.SyntaxKind.PercentEqualsToken;
    case '^':
      return ts.SyntaxKind.AsteriskAsteriskEqualsToken;
    default:
      return undefined;
  }
}

function compileTypeAlias(stat: TypeAliasStat): ts.Statement {
  // `type X<T> = ...` → `type X<T> = ...;` and `type X<T...> = ...` →
  // `type X<T extends unknown[] = unknown[]> = ...;`. Both go through
  // buildTypeParams so function declarations / expressions share the
  // same pack-to-tuple mapping.
  const typeParams = buildTypeParams(stat.generics, stat.genericPacks);
  return factory.createTypeAliasDeclaration(
    stat.exported ? [factory.createToken(ts.SyntaxKind.ExportKeyword)] : undefined,
    factory.createIdentifier(stat.name),
    typeParams.length > 0 ? typeParams : undefined,
    compileType(stat.aliasType),
  );
}

function compileDeclareGlobal(stat: DeclareGlobalStat): ts.Statement {
  return factory.createVariableStatement(
    [factory.createToken(ts.SyntaxKind.DeclareKeyword)],
    factory.createVariableDeclarationList(
      [
        factory.createVariableDeclaration(
          factory.createIdentifier(safeIdentifier(stat.name)),
          undefined,
          compileType(stat.declType),
          undefined,
        ),
      ],
      ts.NodeFlags.Const,
    ),
  );
}

function compileDeclareFunction(stat: DeclareFunctionStat): ts.Statement {
  const params = stat.params.types.map((t, i) => {
    const paramName = stat.paramNames[i]?.name ?? `arg${i}`;
    return factory.createParameterDeclaration(
      undefined,
      undefined,
      factory.createIdentifier(safeIdentifier(paramName)),
      undefined,
      compileType(t),
    );
  });
  if (stat.params.tailType || stat.vararg) {
    const tail = stat.params.tailType;
    const restType =
      tail?.type === 'TypePackVariadic'
        ? factory.createArrayTypeNode(compileType(tail.variadicType))
        : factory.createArrayTypeNode(factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword));
    params.push(
      factory.createParameterDeclaration(
        undefined,
        factory.createToken(ts.SyntaxKind.DotDotDotToken),
        factory.createIdentifier('rest'),
        undefined,
        restType,
      ),
    );
  }
  return factory.createFunctionDeclaration(
    [factory.createToken(ts.SyntaxKind.DeclareKeyword)],
    undefined,
    factory.createIdentifier(safeIdentifier(stat.name)),
    undefined,
    params,
    compileTypePack(stat.retTypes),
    undefined,
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Function shapes (used by Function/LocalFunction/FunctionStat)
// ═══════════════════════════════════════════════════════════════════════════

interface CompiledFunction {
  params: ts.ParameterDeclaration[];
  typeParams: ts.TypeParameterDeclaration[];
  returnType: ts.TypeNode | undefined;
  body: ts.Block;
}

/** Turn a Luau function's generic + generic-pack lists into TS type
 *  parameters. Regular generics map 1:1 (`<T>`); type packs become
 *  `<T extends unknown[] = unknown[]>` so usages like `(T...) -> ()` (which
 *  compile to `(...rest: T) => void`) keep a sensible shape. Both helpers
 *  used in alias declarations and function declarations / expressions. */
function buildTypeParams(
  generics: readonly GenericType[],
  genericPacks: readonly GenericTypePack[],
): ts.TypeParameterDeclaration[] {
  const out: ts.TypeParameterDeclaration[] = [];
  for (const g of generics) {
    out.push(
      factory.createTypeParameterDeclaration(
        undefined,
        factory.createIdentifier(g.name),
        undefined,
        g.defaultValue ? compileType(g.defaultValue) : undefined,
      ),
    );
  }
  for (const g of genericPacks) {
    out.push(
      factory.createTypeParameterDeclaration(
        undefined,
        factory.createIdentifier(g.name),
        factory.createArrayTypeNode(factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword)),
        factory.createArrayTypeNode(factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword)),
      ),
    );
  }
  return out;
}

function compileFunctionShape(
  fn: FunctionExpr,
  ctx: CompileContext,
  options: { allowImplicitSelf?: boolean } = {},
): CompiledFunction {
  const params: ts.ParameterDeclaration[] = [];
  // `self` first-arg → `this` only for member-position functions; bare
  // `local function f(self, ...)` keeps `self` as a positional param.
  const implicitSelf = (options.allowImplicitSelf ?? false)
    && fn.self === null
    && fn.args.length > 0
    && (fn.args[0]!.name === 'self' || fn.args[0]!.name === '_');
  const hasSelf = fn.self !== null || implicitSelf;
  if (hasSelf) {
    // `this: any` — setmetatable instance shape doesn't survive translation,
    // and `unknown` would reject every `self.field` access in the body.
    params.push(
      factory.createParameterDeclaration(
        undefined,
        undefined,
        factory.createIdentifier('this'),
        undefined,
        factory.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword),
      ),
    );
  }
  const realArgs = implicitSelf ? fn.args.slice(1) : fn.args;
  // rbxts: pre-scan the body so paramsFromLocals + compileLocal can
  // synthesize structural shapes for unannotated params / locals.
  let paramShapes: Map<string, import('./shape-infer.js').Shape> | undefined;
  let paramPrimitives: Map<string, 'number' | 'string' | 'boolean'> | undefined;
  if (ctx.compatMode === 'rbxts' && fn.body) {
    const trackedNames = new Set<string>(realArgs.map((a) => a.name));
    for (const n of collectLocalNames(fn.body)) trackedNames.add(n);
    paramShapes = collectShapes(fn.body, trackedNames);
    ctx.pushShapeScope(paramShapes as Map<string, unknown>);
    paramPrimitives = inferParamPrimitives(fn);
  }
  // Save & restore the relevant slice of preInferredParamType so a later
  // sibling function's locals with the same name don't pick up stale
  // primitive inferences from this function's param scope.
  const prevPreInferred = new Map<string, 'number' | 'string' | 'boolean' | undefined>();
  if (paramPrimitives) {
    for (const [k, v] of paramPrimitives) {
      prevPreInferred.set(k, ctx.preInferredParamType.get(k));
      ctx.preInferredParamType.set(k, v);
    }
  }
  // Snapshot the TS-typed-local sets so locals declared inside this
  // function (and any nested compileLocal sites) don't leak their
  // names into sibling function scopes — closure shadowing was making
  // `s` (typed string inside format) leak into a Connect callback's
  // unrelated `s` local elsewhere.
  const prevTsPrim = new Set(ctx.tsTypedPrimitiveLocal);
  const prevTsClass = new Set(ctx.tsTypedClassLocal.keys());
  const prevTsOptionalClass = new Set(ctx.tsOptionalClassLocal);
  const prevTsLuauChild = new Set(ctx.tsLuauChildLocal);
  const prevTsShapeTyped = new Set(ctx.tsShapeTypedLocal);
  for (const p of paramsFromLocals(realArgs, ctx, paramShapes, paramPrimitives)) {
    params.push(p);
  }
  if (fn.vararg) {
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
  let returnType = fn.returnAnnotation ? compileTypePack(fn.returnAnnotation) : undefined;
  // rbxts: when no explicit return annotation and body always returns
  // a single value of a known primitive type, emit `: number|string|boolean`
  // so callers and the post-emit checker see a concrete shape rather than
  // the inferred TS type that would otherwise degrade through unknown.
  if (!returnType && ctx.compatMode === 'rbxts' && fn.body) {
    const ret = inferReturnPrimitive(fn, (e) => {
      const t = staticTypeOfExpr(e, ctx);
      if (t === 'string' || t === 'number' || t === 'boolean') return t;
      return 'unknown';
    });
    if (ret) {
      returnType = factory.createKeywordTypeNode(
        ret === 'number' ? ts.SyntaxKind.NumberKeyword
          : ret === 'string' ? ts.SyntaxKind.StringKeyword
          : ts.SyntaxKind.BooleanKeyword,
      );
    }
  }

  // In rbxts mode, scan the function body for any multi-value `return`
  // statement. If we find one, wrap the return annotation as
  // `LuaTuple<[t1, t2, ...]>` so roblox-ts's macro recognizer kicks in
  // and emits native Lua multi-return instead of a wrapped table.
  // (Component types we don't statically know fall back to `unknown`.)
  if (ctx.compatMode === 'rbxts') {
    const tupleArity = maxMultiReturnArity(fn.body);
    if (tupleArity !== null) {
      ctx.useImport('@rbxts/types', 'LuaTuple');
      const componentTypes = Array.from({ length: tupleArity }, () =>
        factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
      );
      returnType = factory.createTypeReferenceNode('LuaTuple', [
        factory.createTupleTypeNode(componentTypes),
      ]);
    }
  }

  const innerStatements = ctx.withScope(() => {
    for (const arg of realArgs) ctx.defineLocal(arg.name, typeFromAnnotation(arg.annotation));
    if (ctx.compatMode === 'rbxts') {
      for (const arg of realArgs) {
        const shape = paramShapes?.get(arg.name);
        if (shape && !shape.empty) ctx.tsShapeTypedLocal.add(arg.name);
      }
    }
    if (fn.vararg) ctx.defineLocal('__varargs', 'unknown');
    if (hasSelf) ctx.defineLocal('self', 'unknown');
    const bodyStatements = compileBlockBody(fn.body, ctx);
    if (hasSelf && statementsReferenceSelf(bodyStatements)) {
      bodyStatements.unshift(
        factory.createVariableStatement(
          undefined,
          factory.createVariableDeclarationList(
            [
              factory.createVariableDeclaration(
                factory.createIdentifier('self'),
                undefined,
                undefined,
                factory.createIdentifier('this'),
              ),
            ],
            ts.NodeFlags.Const,
          ),
        ),
      );
    }
    return bodyStatements;
  });
  const block = factory.createBlock(innerStatements, true);
  // If the body contains `await`, the function will get the `async`
  // modifier from asyncModIfNeeded — wrap the annotated return type in
  // `Promise<...>` so tsc accepts the signature ("the return type of an
  // async function must be the global Promise<T> type"). Skip when no
  // annotation exists (TS infers Promise<T> automatically then).
  let finalReturnType = returnType;
  if (returnType && bodyContainsAwait(block)) {
    finalReturnType = factory.createTypeReferenceNode('Promise', [returnType]);
  }
  if (paramShapes) ctx.popShapeScope();
  // Restore preInferredParamType snapshot.
  for (const [k, v] of prevPreInferred) {
    if (v === undefined) ctx.preInferredParamType.delete(k);
    else ctx.preInferredParamType.set(k, v);
  }
  // Restore TS-typed-local sets — drop entries added inside this function.
  for (const name of ctx.tsTypedPrimitiveLocal) {
    if (!prevTsPrim.has(name)) ctx.tsTypedPrimitiveLocal.delete(name);
  }
  for (const name of Array.from(ctx.tsTypedClassLocal.keys())) {
    if (!prevTsClass.has(name)) ctx.tsTypedClassLocal.delete(name);
  }
  for (const name of Array.from(ctx.tsOptionalClassLocal)) {
    if (!prevTsOptionalClass.has(name)) ctx.tsOptionalClassLocal.delete(name);
  }
  for (const name of Array.from(ctx.tsLuauChildLocal)) {
    if (!prevTsLuauChild.has(name)) ctx.tsLuauChildLocal.delete(name);
  }
  for (const name of Array.from(ctx.tsShapeTypedLocal)) {
    if (!prevTsShapeTyped.has(name)) ctx.tsShapeTypedLocal.delete(name);
  }
  return {
    params,
    typeParams: buildTypeParams(fn.generics, fn.genericPacks),
    returnType: finalReturnType,
    body: block,
  };
}

function paramsFromLocals(
  locals: readonly Local[],
  ctx: CompileContext,
  /** rbxts-mode shape inference: pre-collected shapes for these params
   *  from the function body. When a param's shape isn't empty, the
   *  synthesized type literal becomes the param annotation, replacing
   *  the default `: unknown` and turning TS18046s into typed access. */
  shapes?: Map<string, import('./shape-infer.js').Shape>,
  /** Per-param primitive constraints inferred from body usage
   *  (math/string library applications, arithmetic, concat). Stronger
   *  than `shapes`: if a param shows up only as `math.floor(p)`, the
   *  shape collector sees nothing, but we still know `p: number`. */
  primitives?: Map<string, 'number' | 'string' | 'boolean'>,
): ts.ParameterDeclaration[] {
  const seen = new Set<string>();
  const out: ts.ParameterDeclaration[] = [];
  // Trailing nilable annotations mark `?` (TS requires the marker for
  // positional optionality, even when the type already includes nil).
  const optionalFrom = computeTrailingOptionalStart(locals);
  // rbxts also accepts trailing unannotated params as optional (they're
  // `unknown` regardless).
  let rbxtsOptionalFrom = ctx.compatMode === 'rbxts'
    ? computeTrailingOptionalStartRbxts(locals)
    : locals.length;
  // Shape-typed AND primitive-inferred params are required (body access
  // fails if undefined). TS forbids required-after-optional, so pull the
  // cutoff past them.
  {
    let lastRequired = -1;
    locals.forEach((local, i) => {
      if (local.annotation) return;
      const sh = shapes?.get(local.name);
      const hasPrim = primitives?.has(local.name) ?? false;
      if (hasPrim || (sh && !sh.empty)) lastRequired = i;
    });
    if (lastRequired + 1 > rbxtsOptionalFrom) {
      rbxtsOptionalFrom = lastRequired + 1;
    }
  }
  locals.forEach((local, i) => {
    const base = safeIdentifier(local.name);
    let name = base;
    if (seen.has(name)) name = `_dup_${i}`;
    seen.add(name);
    // Trailing nilable params emit `data: T | null = null` — keeps
    // call-site-optional without `| undefined` widening the in-body type.
    const isOptional = i >= optionalFrom;
    // Native: unannotated params untyped (TS infers).
    // rbxts: annotate as `unknown` (strict mode rejects implicit-any).
    let ty: ts.TypeNode | undefined;
    // Shape-typed params drop the `?` marker — callers must supply.
    let hasInferredShape = false;
    if (local.annotation) {
      ty = compileType(local.annotation);
    } else if (ctx.compatMode === 'rbxts') {
      // Primitive inference (math/string usage) wins — it's an honest
      // constraint, the shape literal is a synthesized guess.
      const prim = primitives?.get(local.name);
      if (prim) {
        ty = factory.createKeywordTypeNode(
          prim === 'number' ? ts.SyntaxKind.NumberKeyword
            : prim === 'string' ? ts.SyntaxKind.StringKeyword
            : ts.SyntaxKind.BooleanKeyword,
        );
        hasInferredShape = true;
      } else {
        const shape = shapes?.get(local.name);
        const fromShape = shape ? shapeToTypeNode(shape) : null;
        if (fromShape) {
          ty = fromShape;
          hasInferredShape = true;
        } else {
          ty = factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);
        }
      }
    }
    // rbxts: missing-arg Luau callers need trailing unannotated params
    // marked `name?` (legacy arity-mismatch tolerance). Annotated params
    // stay required — the annotation is the user's intent signal.
    const rbxtsImplicitOptional =
      ctx.compatMode === 'rbxts' && !local.annotation && i >= rbxtsOptionalFrom;
    // Shape-typed params skip `?` since body access would TS18048 otherwise.
    const useQuestion = rbxtsImplicitOptional && !isOptional && !hasInferredShape;
    // rbxts default = `undefined` (roblox-ts rejects `null` literally).
    out.push(
      factory.createParameterDeclaration(
        undefined,
        undefined,
        factory.createIdentifier(name),
        useQuestion ? factory.createToken(ts.SyntaxKind.QuestionToken) : undefined,
        ty,
        isOptional && !useQuestion
          ? (ctx.compatMode === 'rbxts'
              ? factory.createIdentifier('undefined')
              : factory.createNull())
          : undefined,
      ),
    );
  });
  return out;
}

/** Index of the first trailing parameter whose annotation includes nil
 *  (`T?` or `T | nil`). Returns `locals.length` if none — i.e. no params
 *  should be marked optional. */
function computeTrailingOptionalStart(locals: readonly Local[]): number {
  let firstTrailing = locals.length;
  for (let i = locals.length - 1; i >= 0; i--) {
    if (annotationIsNilable(locals[i]!.annotation)) {
      firstTrailing = i;
    } else {
      break;
    }
  }
  return firstTrailing;
}

/** rbxts-mode variant: a trailing run of UNANNOTATED params (whose type
 *  defaults to `any`) is also positionally optional. Combines with the
 *  nilable-annotation rule so a tail of `(x, y, z: T?)` still produces
 *  three optional params. */
function computeTrailingOptionalStartRbxts(locals: readonly Local[]): number {
  let firstTrailing = locals.length;
  for (let i = locals.length - 1; i >= 0; i--) {
    if (!locals[i]!.annotation || annotationIsNilable(locals[i]!.annotation)) {
      firstTrailing = i;
    } else {
      break;
    }
  }
  return firstTrailing;
}

/** True for Luau type annotations whose TS shape is an array type, so the
 *  compiler knows `{}` for `local x: T = {}` should stay as `[]` (matches
 *  empty-array literal). `{T}` (numeric-indexer-only) is the canonical
 *  Luau array shorthand; everything else is treated as object-shaped. */
function isArrayShapedType(t: TypeNode | null | undefined): boolean {
  if (!t) return false;
  if (t.type === 'TypeTable'
      && t.props.length === 0
      && t.indexer
      && t.indexer.indexType.type === 'TypeReference'
      && t.indexer.indexType.name === 'number') {
    return true;
  }
  if (t.type === 'TypeGroup') return isArrayShapedType(t.groupType);
  return false;
}

function annotationIsNilable(t: TypeNode | null | undefined): boolean {
  if (!t) return false;
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

function compileFunctionExpr(
  fn: FunctionExpr,
  ctx: CompileContext,
  options: { allowImplicitSelf?: boolean } = {},
): ts.FunctionExpression {
  const { params, typeParams, returnType, body } = compileFunctionShape(fn, ctx, options);
  return factory.createFunctionExpression(
    asyncModIfNeeded(body),
    undefined,
    undefined,
    typeParams.length > 0 ? typeParams : undefined,
    params,
    returnType,
    body,
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Expressions
// ═══════════════════════════════════════════════════════════════════════════

function typeFromAnnotation(
  annotation: TypeNode | null | undefined,
  fallbackExpr?: Expr,
  ctx?: CompileContext,
): StaticValueType {
  if (!annotation) return fallbackExpr && ctx ? staticTypeOfExpr(fallbackExpr, ctx) : 'unknown';
  switch (annotation.type) {
    case 'TypeReference':
      if (annotation.prefix === null) {
        if (annotation.name === 'number') return 'number';
        if (annotation.name === 'boolean') return 'boolean';
        if (annotation.name === 'string') return 'string';
        if (ARITH_DATATYPES.has(annotation.name)) {
          return `datatype:${annotation.name}` as StaticValueType;
        }
      }
      return 'unknown';
    case 'TypeSingletonBool':
      return 'boolean';
    case 'TypeSingletonString':
      return 'string';
    case 'TypeGroup':
      return typeFromAnnotation(annotation.groupType, fallbackExpr, ctx);
    default:
      return 'unknown';
  }
}

function staticTypeOfExpr(expr: Expr, ctx: CompileContext): StaticValueType {
  switch (expr.type) {
    case 'ConstantInteger':
    case 'ConstantNumber':
      return 'number';
    case 'Call': {
      const flowed = flowFactToStatic(flowFactOf(expr, ctx));
      if (flowed) return flowed;
      // Constructor calls — `Vector3.new(…)`, `CFrame.new(…)`, etc.
      // narrow the result to the datatype so subsequent arithmetic can
      // fast-path `a + b` to `a.add(b)`.
      const f = expr.func;
      if (f.type === 'IndexName' && f.expr.type === 'Global' && ARITH_DATATYPES.has(f.expr.name)) {
        return `datatype:${f.expr.name}` as StaticValueType;
      }
      // Stdlib coercions.
      if (f.type === 'Global') {
        if (f.name === 'tostring') return 'string';
        if (f.name === 'tonumber') return 'number';
      }
      // math.X (most) returns number.
      if (f.type === 'IndexName' && f.expr.type === 'Global' && f.expr.name === 'math') {
        const MATH_NUMBER_RETURNS = new Set([
          'floor', 'ceil', 'abs', 'sqrt', 'log', 'log10', 'exp', 'sin', 'cos',
          'tan', 'asin', 'acos', 'atan', 'atan2', 'rad', 'deg', 'sign',
          'min', 'max', 'pow', 'clamp', 'random', 'noise', 'round', 'fmod', 'modf',
        ]);
        if (MATH_NUMBER_RETURNS.has(f.index)) return 'number';
      }
      // String-returning string-lib methods (namespace + colon forms).
      // Lets the reassign-cast pick `string` over the wider shape-method literal.
      const STRING_RETURNING = new Set([
        'lower', 'upper', 'reverse', 'sub', 'rep', 'char',
        'format', 'gsub', // gsub tuple's first element is string
      ]);
      // Namespace form: `string.<m>(...)`.
      if (
        f.type === 'IndexName'
        && f.expr.type === 'Global'
        && (f.expr as { name: string }).name === 'string'
        && STRING_RETURNING.has(f.index)
      ) {
        return 'string';
      }
      // Colon-method `<x>:<string-method>(...)` — receiver type not checked.
      if (
        expr.self
        && f.type === 'IndexName'
        && STRING_RETURNING.has(f.index)
      ) {
        return 'string';
      }
      // Datatype method calls (`v:add(w)`, `cf:mul(other)`) preserve the
      // receiver's datatype — keeps chained `(v + w) / 2` on the fast path.
      const ARITH_METHOD_NAMES = new Set(['add', 'sub', 'mul', 'div']);
      if (
        f.type === 'IndexName'
        && ARITH_METHOD_NAMES.has(f.index)
      ) {
        const recvType = staticTypeOfExpr(f.expr, ctx);
        if (typeof recvType === 'string' && recvType.startsWith('datatype:')) {
          return recvType;
        }
      }
      return 'unknown';
    }
    case 'ConstantBool':
      return 'boolean';
    case 'ConstantString':
      return 'string';
    case 'ConstantNil':
      return 'nil';
    case 'Local': {
      const tracked = ctx.lookupLocal(expr.name);
      if (tracked !== 'unknown') return tracked;
      // Param-inferred primitive (math.floor(n) → n: number) wins over shape.
      const preInferred = ctx.preInferredParamType.get(expr.name);
      if (preInferred) return preInferred;
      // Local-type-inferred primitive (annotation emitted at declaration).
      const localPrim = ctx.localTypeMap.byName.get(expr.name);
      if (localPrim) return localPrim;
      // Shape-inferred Vector3 (X/Y/Z) → datatype, so arithmetic dispatches
      // through .add()/.sub() instead of degrading to number.
      if (ctx.compatMode === 'rbxts') {
        const shape = ctx.getShape(expr.name) as
          | { props: Map<string, unknown>; methods: Map<string, unknown> }
          | undefined;
        if (
          shape
          && (shape.props.has('X') || shape.methods.has('X'))
          && (shape.props.has('Y') || shape.methods.has('Y'))
          && (shape.props.has('Z') || shape.methods.has('Z'))
        ) {
          return 'datatype:Vector3';
        }
      }
      return 'unknown';
    }
    case 'Group':
      return staticTypeOfExpr(expr.expr, ctx);
    case 'TypeAssertion':
      return typeFromAnnotation(expr.annotation, expr.expr, ctx);
    case 'Unary':
      if (expr.op === 'not') return 'boolean';
      if (expr.op === '#' || expr.op === '-') {
        // `-vec` returns Vector3 when vec is a datatype. The luaUnm
        // path emits `vec.mul(-1)` (Vector3 has a unary __unm); the
        // result type matches the operand.
        if (expr.op === '-') {
          const t = staticTypeOfExpr(expr.expr, ctx);
          if (typeof t === 'string' && t.startsWith('datatype:')) return t;
        }
        return 'number';
      }
      return 'unknown';
    case 'IndexName': {
      // BasePart properties typed Vector3 in @rbxts/types — Position/Size
      // arithmetic needs the datatype hint to dispatch through `.add()` etc.
      const flowed = flowFactToStatic(flowFactOf(expr, ctx));
      if (flowed) return flowed;
      const VECTOR3_PROPS = new Set([
        'Position', 'Size', 'Velocity', 'Rotation',
        'AssemblyLinearVelocity', 'AssemblyAngularVelocity',
        'RotVelocity', 'Orientation',
      ]);
      if (VECTOR3_PROPS.has(expr.index)) return 'datatype:Vector3' as StaticValueType;
      if (expr.index === 'CFrame') return 'datatype:CFrame' as StaticValueType;
      return 'unknown';
    }
    case 'Binary':
      if (['+', '-', '*', '/', '%', '^', '//'].includes(expr.op)) {
        const lt = staticTypeOfExpr(expr.left, ctx);
        const rt = staticTypeOfExpr(expr.right, ctx);
        if (lt === 'number' && rt === 'number') return 'number';
        // Datatype arithmetic preserves the LEFT operand's datatype.
        if (typeof lt === 'string' && lt.startsWith('datatype:')) return lt;
        return 'unknown';
      }
      if (['==', '~=', '<', '<=', '>', '>='].includes(expr.op)) return 'boolean';
      if (expr.op === '..') {
        const lt = staticTypeOfExpr(expr.left, ctx);
        const rt = staticTypeOfExpr(expr.right, ctx);
        if (lt === 'string' || rt === 'string') return 'string';
      }
      return 'unknown';
    case 'IfElse': {
      const trueType = staticTypeOfExpr(expr.trueExpr, ctx);
      const falseType = staticTypeOfExpr(expr.falseExpr, ctx);
      return trueType === falseType ? trueType : 'unknown';
    }
    default:
      return 'unknown';
  }
}

function isPrimitiveStaticType(type: StaticValueType): boolean {
  return type === 'number' || type === 'boolean' || type === 'string' || type === 'nil';
}

function compileExpr(expr: Expr, ctx: CompileContext): ts.Expression {
  switch (expr.type) {
    case 'ConstantNil':
      // native: `null` (matches `T?` → `T | null` annotations).
      // rbxts: `undefined` (roblox-ts rejects null literally).
      return ctx.compatMode === 'rbxts'
        ? factory.createIdentifier('undefined')
        : factory.createNull();
    case 'ConstantBool':
      return expr.value ? factory.createTrue() : factory.createFalse();
    case 'ConstantInteger':
    case 'ConstantNumber':
      if (Number.isFinite(expr.value)) {
        if (expr.value < 0) {
          return factory.createPrefixUnaryExpression(
            ts.SyntaxKind.MinusToken,
            factory.createNumericLiteral(Math.abs(expr.value)),
          );
        }
        return factory.createNumericLiteral(expr.value);
      }
      if (Number.isNaN(expr.value)) return factory.createIdentifier('NaN');
      return factory.createIdentifier(expr.value > 0 ? 'Infinity' : '-Infinity');
    case 'ConstantString':
      return factory.createStringLiteral(expr.value);
    case 'Local':
      return factory.createIdentifier(ctx.getLocalJsName(expr.name) ?? safeIdentifier(expr.name));
    case 'Global':
      // Register so the emitter either auto-imports from luau2ts/runtime
      // or prepends a `declare const X: any;`. rbxts uses useAmbient for
      // runtime-available names so roblox-ts's @rbxts/types globals win.
      if (!ctx.getLocalJsName(expr.name)) {
        if (RUNTIME_AVAILABLE_GLOBALS.has(expr.name)) {
          if (ctx.compatMode === 'rbxts') {
            ctx.useAmbient(expr.name);
          } else {
            ctx.use(expr.name);
          }
        } else if (AMBIENT_GLOBALS.has(expr.name)) {
          ctx.useAmbient(expr.name);
        }
      }
      // rbxts remappings: `typeof` → `typeOf` (TS keyword collision);
      // `workspace` → `(game.Workspace as any)` (not declared global).
      if (ctx.compatMode === 'rbxts' && !ctx.getLocalJsName(expr.name)) {
        if (expr.name === 'typeof') {
          return factory.createIdentifier('typeOf');
        }
        if (expr.name === 'workspace') {
          return factory.createPropertyAccessExpression(
            factory.createIdentifier('game'),
            factory.createIdentifier('Workspace'),
          );
        }
      }
      return factory.createIdentifier(ctx.getLocalJsName(expr.name) ?? safeIdentifier(expr.name));
    case 'Varargs':
      // Single-value default; call-arg / table-list use compileExprAsArg.
      return factory.createElementAccessExpression(
        factory.createIdentifier('__varargs'),
        factory.createNumericLiteral(0),
      );
    case 'Group':
      return factory.createParenthesizedExpression(compileExpr(expr.expr, ctx));
    case 'Binary':
      return compileBinaryExpr(expr, ctx);
    case 'Unary':
      return compileUnary(expr, ctx);
    case 'Call':
      return compileCall(expr, ctx);
    case 'IndexName': {
      // chain-split marker: `Players.LocalPlayer!` non-null assert at the
      // first binding so downstream method calls don't surface optional.
      const nonNull = (expr as unknown as { __nonnull?: boolean }).__nonnull === true;
      if (nonNull) {
        const inner = factory.createPropertyAccessExpression(
          compileExpr(expr.expr, ctx),
          factory.createIdentifier(propertyName(expr.index)),
        );
        return factory.createNonNullExpression(inner);
      }
      // rbxts: value-position `<DetectedClass>.new` — synthesize a forwarding
      // arrow so bare references (e.g. `{ new = MyClass.new }`) keep the
      // callable-that-constructs shape; roblox-ts doesn't expose `.new` as
      // a property on the TS class.
      if (
        ctx.compatMode === 'rbxts'
        && expr.index === 'new'
        && (expr.expr.type === 'Global' || expr.expr.type === 'Local')
        && ctx.isDetectedClass((expr.expr as { name: string }).name)
      ) {
        const className = (expr.expr as { name: string }).name;
        const argsId = factory.createIdentifier('args');
        return factory.createArrowFunction(
          undefined,
          undefined,
          [factory.createParameterDeclaration(
            undefined,
            factory.createToken(ts.SyntaxKind.DotDotDotToken),
            argsId,
            undefined,
            factory.createArrayTypeNode(factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword)),
          )],
          undefined,
          factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
          // Cast the class to a ctor signature so spread invocation typechecks
          // regardless of the real ctor's declared arity.
          factory.createNewExpression(
            factory.createParenthesizedExpression(
              factory.createAsExpression(
                factory.createIdentifier(className),
                factory.createConstructorTypeNode(
                  undefined,
                  undefined,
                  [factory.createParameterDeclaration(
                    undefined,
                    factory.createToken(ts.SyntaxKind.DotDotDotToken),
                    'args',
                    undefined,
                    factory.createArrayTypeNode(factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword)),
                  )],
                  factory.createTypeReferenceNode(className, undefined),
                ),
              ),
            ),
            undefined,
            [factory.createSpreadElement(argsId)],
          ),
        );
      }
      // rbxts: access on `game`/`workspace`/`script`/`plugin` casts the root
      // to `any` for user-folder access (`game.MyFolder` etc). _LuauChild
      // would be preferred for no-any but its Instance intersection makes
      // `Instance | undefined` slots TS2532.
      if (ctx.compatMode === 'rbxts') {
        // Match both the Luau-AST receiver AND the compiled identifier so
        // macro-rewritten `game:GetService("X")` (now bare `X`) still hits.
        const luauReceiverName =
          expr.expr.type === 'Global' ? (expr.expr as { name: string }).name : null;
        if (luauReceiverName && RBX_DYNAMIC_ROOTS.has(luauReceiverName)) {
          const compiledRoot = compileExpr(expr.expr, ctx);
          if (luauReceiverName === 'game' && expr.index === 'Workspace') {
            return factory.createPropertyAccessExpression(
              compiledRoot,
              factory.createIdentifier(propertyName(expr.index)),
            );
          }
          ctx.useLuauChildType();
          return factory.createPropertyAccessExpression(
            factory.createParenthesizedExpression(
              factory.createAsExpression(
                factory.createAsExpression(
                  compiledRoot,
                  factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
                ),
                factory.createTypeReferenceNode('_LuauChild', undefined),
              ),
            ),
            factory.createIdentifier(propertyName(expr.index)),
          );
        }
        // @rbxts/services receivers route through `_LuauChild` for dynamic-
        // child access without `any`. Services don't have the
        // `.Parent`/FindFirstChild pattern that broke this for game/workspace.
        const compiledReceiver = compileExpr(expr.expr, ctx);
        const compiledIdent =
          ts.isIdentifier(compiledReceiver) ? compiledReceiver.text : null;
        const serviceName =
          (luauReceiverName && (ctx.isRbxService(luauReceiverName) || ctx.oracle.isService(luauReceiverName))) ? luauReceiverName
          : (compiledIdent && (ctx.isRbxService(compiledIdent) || ctx.oracle.isService(compiledIdent))) ? compiledIdent
          : null;
        if (serviceName) {
          if (ctx.oracle.propertyType(serviceName, expr.index)) {
            return factory.createPropertyAccessExpression(
              compiledReceiver,
              factory.createIdentifier(propertyName(expr.index)),
            );
          }
          ctx.useLuauChildType();
          return factory.createPropertyAccessExpression(
            factory.createParenthesizedExpression(
              factory.createAsExpression(
                factory.createAsExpression(
                  compiledReceiver,
                  factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
                ),
                factory.createTypeReferenceNode('_LuauChild', undefined),
              ),
            ),
            factory.createIdentifier(propertyName(expr.index)),
          );
        }
        if (
          expr.expr.type === 'IndexName'
          && expr.expr.expr.type === 'Global'
          && expr.expr.expr.name === 'game'
          && expr.expr.index === 'Workspace'
        ) {
          ctx.useLuauChildType();
          return factory.createPropertyAccessExpression(
            factory.createParenthesizedExpression(
              factory.createAsExpression(
                factory.createAsExpression(
                  compiledReceiver,
                  factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
                ),
                factory.createTypeReferenceNode('_LuauChild', undefined),
              ),
            ),
            factory.createIdentifier(propertyName(expr.index)),
          );
        }
        const receiverClass =
          flowClassOf(expr.expr, ctx)
          ?? (expr.expr.type === 'Local' ? ctx.tsTypedClassLocal.get(expr.expr.name) : undefined)
          ?? resolveOracleClassOfExpr(expr.expr, ctx);
        if (
          receiverClass
          && ctx.oracle.isA(receiverClass, 'Instance')
          && !oracleHasMember(ctx, receiverClass, expr.index)
        ) {
          ctx.useLuauChildType();
          return factory.createPropertyAccessExpression(
            factory.createParenthesizedExpression(
              factory.createAsExpression(
                factory.createAsExpression(
                  compiledReceiver,
                  factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
                ),
                factory.createTypeReferenceNode('_LuauChild', undefined),
              ),
            ),
            factory.createIdentifier(propertyName(expr.index)),
          );
        }
      }
      // rbxts: capture-by-value of an instance method (`local m = Class.method`).
      // roblox-ts forbids both `Class.prototype.method` and bare method-value
      // access. Route through `Record<string, unknown>` so the access is a
      // generic property read (returns `unknown`); the call site adds its
      // own callable cast.
      if (
        ctx.compatMode === 'rbxts'
        && (expr.expr.type === 'Global' || expr.expr.type === 'Local')
        && ctx.isDetectedClassMethod(
            (expr.expr as { name: string }).name,
            expr.index,
          )
      ) {
        return factory.createPropertyAccessExpression(
          recordCastExpression(compileExpr(expr.expr, ctx)),
          factory.createIdentifier(propertyName(expr.index)),
        );
      }
      // rbxts: `obj[k].X` — receiver is unknown from Record cast, so
      // direct `.X` trips TS2571. Recast through Record so `.X` resolves.
      if (
        ctx.compatMode === 'rbxts'
        && expr.expr.type === 'IndexExpr'
      ) {
        return factory.createPropertyAccessExpression(
          factory.createParenthesizedExpression(
            factory.createAsExpression(
              factory.createAsExpression(
                compileExpr(expr.expr, ctx),
                factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
              ),
              factory.createTypeReferenceNode('Record', [
                factory.createKeywordTypeNode(ts.SyntaxKind.StringKeyword),
                factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
              ]),
            ),
          ),
          factory.createIdentifier(propertyName(expr.index)),
        );
      }
      // rbxts Phase 3e: destructure-bound LuaTuple slot-0 locals have
      // narrower TS types than their observed-access pattern. Route
      // reads through Record so `.X` doesn't surface TS2339.
      if (
        ctx.compatMode === 'rbxts'
        && expr.expr.type === 'Local'
        && ctx.destructuredLuaTupleLocal.has((expr.expr as { name: string }).name)
      ) {
        return factory.createPropertyAccessExpression(
          factory.createParenthesizedExpression(
            factory.createAsExpression(
              factory.createAsExpression(
                compileExpr(expr.expr, ctx),
                factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
              ),
              factory.createTypeReferenceNode('Record', [
                factory.createKeywordTypeNode(ts.SyntaxKind.StringKeyword),
                factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
              ]),
            ),
          ),
          factory.createIdentifier(propertyName(expr.index)),
        );
      }
      const rawReceiver = compileExpr(expr.expr, ctx);
      const receiverFact = flowFactOf(expr.expr, ctx);
      const accessReceiver =
        ctx.compatMode === 'rbxts'
        && (
          expr.expr.type === 'Call'
          || (expr.expr.type === 'Local' && ctx.tsOptionalClassLocal.has(expr.expr.name))
          || (receiverFact?.kind === 'class' && receiverFact.nullable)
        )
          ? factory.createNonNullExpression(rawReceiver)
          : rawReceiver;
      const access = factory.createPropertyAccessExpression(
        accessReceiver,
        factory.createIdentifier(propertyName(expr.index)),
      );
      // rbxts mode: `.Parent` access on Instance returns `Instance |
      // undefined` per @rbxts/types. Real Roblox scripts treat parent
      // chains as non-null (runtime errors if a chain link is missing)
      // AND access children whose specific types aren't statically
      // known. Cast to `any` so the result absorbs both — non-null
      // AND wide enough that subsequent property access type-checks.
      if (ctx.compatMode === 'rbxts' && expr.index === 'Parent') {
        // If the receiver is an untyped local whose value is `unknown` (e.g.
        // result of a Record-routed method call), reading `.Parent` directly
        // is a TS error. Route the receiver through `_LuauChild` first.
        const receiverIsUntypedLocal =
          expr.expr.type === 'Local'
          && !ctx.tsTypedClassLocal.has(expr.expr.name)
          && !ctx.tsLuauChildLocal.has(expr.expr.name)
          && !ctx.tsShapeTypedLocal.has(expr.expr.name)
          && !ctx.preInferredParamType.has(expr.expr.name)
          && !flowClassOf(expr.expr, ctx)
          && !resolveOracleClassOfExpr(expr.expr, ctx);
        if (receiverIsUntypedLocal) {
          return factory.createPropertyAccessExpression(
            luauChildCastExpression(accessReceiver, ctx),
            factory.createIdentifier('Parent'),
          );
        }
        ctx.useLuauChildType();
        return factory.createAsExpression(
          factory.createAsExpression(
            access,
            factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
          ),
          factory.createTypeReferenceNode('_LuauChild', undefined),
        );
      }
      if (
        ctx.compatMode === 'rbxts'
        && expr.index === 'Value'
        && exprEmitsLuauChild(expr.expr, ctx)
      ) {
        return factory.createPropertyAccessExpression(
          factory.createParenthesizedExpression(
            factory.createAsExpression(
              factory.createAsExpression(
                compileExpr(expr.expr, ctx),
                factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
              ),
              factory.createTypeReferenceNode('Record', [
                factory.createKeywordTypeNode(ts.SyntaxKind.StringKeyword),
                factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
              ]),
            ),
          ),
          factory.createIdentifier(propertyName(expr.index)),
        );
      }
      // rbxts: when `staticTypeOfExpr` knows the result is a datatype
      // (Vector3 etc) but the receiver's TS-side shape returns `unknown`
      // for the property (typical for shape-synthesized annotations),
      // cast to the datatype so downstream method calls work.
      if (ctx.compatMode === 'rbxts') {
        const st = staticTypeOfExpr(expr, ctx);
        if (typeof st === 'string' && st.startsWith('datatype:')) {
          const dtName = st.slice('datatype:'.length);
          const receiverClass =
            flowClassOf(expr.expr, ctx)
            ?? (expr.expr.type === 'Local' ? ctx.tsTypedClassLocal.get(expr.expr.name) : undefined)
            ?? resolveOracleClassOfExpr(expr.expr, ctx);
          const receiverHasProperty =
            !!receiverClass
            && ctx.oracle.isA(receiverClass, 'Instance')
            && oracleHasMember(ctx, receiverClass, expr.index);
          const valueForCast = receiverHasProperty
            ? access
            : factory.createAsExpression(
                factory.createPropertyAccessExpression(
                  recordCastExpression(accessReceiver),
                  factory.createIdentifier(propertyName(expr.index)),
                ),
                factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
              );
          return factory.createAsExpression(
            valueForCast,
            factory.createTypeReferenceNode(dtName, undefined),
          );
        }
      }
      if (
        ctx.compatMode === 'rbxts'
        && shouldRouteDynamicChildRead(expr, ctx)
      ) {
        if (
          expr.expr.type === 'Local'
          && !ctx.tsTypedClassLocal.has(expr.expr.name)
          && localObservedShapeHasMember(expr.expr, expr.index, ctx)
        ) {
          return factory.createPropertyAccessExpression(
            recordCastExpression(accessReceiver),
            factory.createIdentifier(propertyName(expr.index)),
          );
        }
        return factory.createPropertyAccessExpression(
          luauChildCastExpression(accessReceiver, ctx),
          factory.createIdentifier(propertyName(expr.index)),
        );
      }
      if (
        ctx.compatMode === 'rbxts'
        && expr.expr.type === 'IndexName'
        && !exprEmitsLuauChild(expr.expr, ctx)
        && !flowClassOf(expr.expr, ctx)
        && !resolveOracleClassOfExpr(expr.expr, ctx)
        && rootGlobalName(expr.expr) !== 'Enum'
      ) {
        return factory.createPropertyAccessExpression(
          recordCastExpression(accessReceiver),
          factory.createIdentifier(propertyName(expr.index)),
        );
      }
      return access;
    }
    case 'IndexExpr': {
      // Lua 1-indexed → JS 0-indexed. Numeric literals translate statically;
      // runtime keys go through luaIndex(t, k) which only subtracts 1 when
      // t is an actual Array (preserving large-int dict keys like asset IDs).
      let target = compileExpr(expr.expr, ctx);
      const indexExpr = expr.index;
      const index = compileExpr(indexExpr, ctx);
      // rbxts: `_G` is `interface _G {}` (empty) in @rbxts/types. Route through
      // Record so `_G["X"]` resolves to `unknown` (no-any clean).
      if (
        ctx.compatMode === 'rbxts'
        && expr.expr.type === 'Global'
        && (expr.expr as { name: string }).name === '_G'
      ) {
        target = recordCastExpression(target);
      }
      if (
        (indexExpr.type === 'ConstantNumber' || indexExpr.type === 'ConstantInteger')
        && typeof (indexExpr as { value: number }).value === 'number'
      ) {
        const n = (indexExpr as { value: number }).value - 1;
        const lit = n < 0
          ? factory.createPrefixUnaryExpression(
              ts.SyntaxKind.MinusToken,
              factory.createNumericLiteral(Math.abs(n)),
            )
          : factory.createNumericLiteral(n);
        // rbxts: chained receiver (`obj[k][i]`) is `unknown`; recast
        // through `Record<string|number, unknown>` to avoid TS2571.
        if (
          ctx.compatMode === 'rbxts'
          && (expr.expr.type === 'IndexExpr' || expr.expr.type === 'IndexName')
        ) {
          target = factory.createParenthesizedExpression(
            factory.createAsExpression(
              factory.createAsExpression(
                target,
                factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
              ),
              factory.createTypeReferenceNode('Record', [
                factory.createUnionTypeNode([
                  factory.createKeywordTypeNode(ts.SyntaxKind.StringKeyword),
                  factory.createKeywordTypeNode(ts.SyntaxKind.NumberKeyword),
                ]),
                factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
              ]),
            ),
          );
        }
        return factory.createElementAccessExpression(target, lit);
      }
      if (indexExpr.type === 'ConstantString') {
        return factory.createElementAccessExpression(target, index);
      }
      // Runtime key: rbxts uses native bracket (roblox-ts preserves indices);
      // native mode uses luaIndex helper for 1-indexed handling.
      if (ctx.compatMode === 'rbxts') {
        // Receiver → Record<string, unknown> (not any, no-any rule).
        // Route through `unknown` so typed arrays / records don't TS2352.
        // Index → string so Player/Instance keys don't TS2538.
        const dynamicTarget = factory.createParenthesizedExpression(
          factory.createAsExpression(
            factory.createAsExpression(
              target,
              factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
            ),
            factory.createTypeReferenceNode('Record', [
              factory.createKeywordTypeNode(ts.SyntaxKind.StringKeyword),
              factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
            ]),
          ),
        );
        // Paren-wrap binary/conditional indices first — `as` binds
        // tighter than `??`/`||`/`&&`, so a bare `dir ?? "down" as
        // unknown as string` would only cast the "down" branch and
        // leave the union widened (TS2538: '{}' can't be used as
        // index).
        const innerIndex = (
          ts.isBinaryExpression(index)
          || ts.isConditionalExpression(index)
        )
          ? factory.createParenthesizedExpression(index)
          : index;
        const coercedIndex = factory.createAsExpression(
          factory.createAsExpression(
            innerIndex,
            factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
          ),
          factory.createKeywordTypeNode(ts.SyntaxKind.StringKeyword),
        );
        return factory.createElementAccessExpression(dynamicTarget, coercedIndex);
      }
      const luaIndexFn = ctx.use('luaIndex');
      return factory.createCallExpression(
        factory.createIdentifier(luaIndexFn),
        undefined,
        [target, index],
      );
    }
    case 'Function':
      return compileFunctionExpr(expr, ctx);
    case 'Table':
      return compileTableExpr(expr, ctx);
    case 'TypeAssertion': {
      const targetTy = compileType(expr.annotation);
      if (
        ctx.compatMode === 'rbxts'
        && targetTy.kind === ts.SyntaxKind.AnyKeyword
        && expr.expr.type === 'Table'
        && expr.expr.items.length === 0
      ) {
        return factory.createAsExpression(
          factory.createObjectLiteralExpression([], false),
          factory.createTypeReferenceNode('Record', [
            factory.createKeywordTypeNode(ts.SyntaxKind.StringKeyword),
            factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
          ]),
        );
      }
      // `{} :: SomeImpl` — empty Luau table emits `[]` by default, which
      // TS rejects against non-array targets. Swap to `{}` for those.
      if (
        expr.expr.type === 'Table'
        && expr.expr.items.length === 0
        && !ts.isArrayTypeNode(targetTy)
      ) {
        return factory.createAsExpression(
          factory.createObjectLiteralExpression([], false),
          targetTy,
        );
      }
      const inner = compileExpr(expr.expr, ctx);
      if (
        ctx.compatMode === 'rbxts'
        && (
          exprEmitsLuauChild(expr.expr, ctx)
          || expr.expr.type === 'Call'
          || expr.expr.type === 'IndexName'
        )
      ) {
        return factory.createAsExpression(
          factory.createAsExpression(
            inner,
            factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
          ),
          targetTy,
        );
      }
      return factory.createAsExpression(inner, targetTy);
    }
    case 'IfElse':
      return compileIfElseExpr(expr, ctx);
    case 'InterpString':
      return compileInterpString(expr, ctx);
    case 'Instantiate':
      // f<<T>> — TS doesn't expose generic instantiation values; drop type args.
      return compileExpr(expr.expr, ctx);
    case 'ExprError':
    case 'UnknownExpr':
    default:
      return unsupportedExpr(`luau-to-ts: unsupported expression '${expr.type}'`);
  }
}

function compileUnary(expr: Extract<Expr, { type: 'Unary' }>, ctx: CompileContext): ts.Expression {
  const inner = compileExpr(expr.expr, ctx);
  switch (expr.op) {
    case '-':
      return factory.createPrefixUnaryExpression(ts.SyntaxKind.MinusToken, inner);
    case '#': {
      const innerType = staticTypeOfExpr(expr.expr, ctx);
      if (innerType === 'string') {
        return factory.createPropertyAccessExpression(inner, 'length');
      }
      // rbxts: `(expr as Array<defined>).size()` — roblox-ts's Array.size()
      // lowers to `#expr`. `Array<defined>` is the no-any-clean equivalent of
      // `any[]` for the size-only access pattern.
      if (ctx.compatMode === 'rbxts') {
        return factory.createCallExpression(
          factory.createPropertyAccessExpression(
            factory.createParenthesizedExpression(
              factory.createAsExpression(
                factory.createAsExpression(
                  inner,
                  factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
                ),
                factory.createTypeReferenceNode('Array', [
                  factory.createTypeReferenceNode('defined', undefined),
                ]),
              ),
            ),
            factory.createIdentifier('size'),
          ),
          undefined,
          [],
        );
      }
      // Native mode: use the lualen helper to handle mixed-table semantics.
      const fn = ctx.use('lualen');
      return factory.createCallExpression(factory.createIdentifier(fn), undefined, [inner]);
    }
    case 'not': {
      const innerType = staticTypeOfExpr(expr.expr, ctx);
      if (innerType === 'boolean') {
        return factory.createPrefixUnaryExpression(ts.SyntaxKind.ExclamationToken, inner);
      }
      if (isRepeatableExpression(inner)) {
        return factory.createPrefixUnaryExpression(
          ts.SyntaxKind.ExclamationToken,
          factory.createParenthesizedExpression(truthify(inner, ctx, innerType)),
        );
      }
      // rbxts: emit `!inner` directly — roblox-ts lowers `!` to Lua `not`.
      if (ctx.compatMode === 'rbxts') {
        return factory.createPrefixUnaryExpression(
          ts.SyntaxKind.ExclamationToken,
          factory.createParenthesizedExpression(inner),
        );
      }
      const fn = ctx.use('luaNot');
      return factory.createCallExpression(factory.createIdentifier(fn), undefined, [inner]);
    }
  }
}

function compileBinaryExpr(expr: Extract<Expr, { type: 'Binary' }>, ctx: CompileContext): ts.Expression {
  let leftType = staticTypeOfExpr(expr.left, ctx);
  const rightType = staticTypeOfExpr(expr.right, ctx);
  const left = compileExpr(expr.left, ctx);
  // `cond and value or fallback`: after `and` lowering the LHS can be
  // literal `false`, which `??` won't catch — force boolean so we pick `||`.
  if (
    expr.op === 'or'
    && expr.left.type === 'Binary'
    && (expr.left as { op?: string }).op === 'and'
  ) {
    leftType = 'boolean';
  }
  // `x or {}` fallback: emit `{}` as an OBJECT literal (compileTable defaults
  // to array). For `x = x or {}` cast through `NonNullable<typeof x>` so the
  // assignment narrows `x` out of nullable; fall back to `any` for non-ident.
  let right: ts.Expression;
  if (
    expr.op === 'or'
    && expr.right.type === 'Table'
    && expr.right.items.length === 0
  ) {
    // `x = x or {}` with identifier LHS: cast the fallback to
    // `NonNullable<typeof x>` so the assignment narrows x out of nullable.
    // For Record-routed LHS, the access is already `unknown`; `{} as unknown`
    // keeps the chain clean without tripping roblox-ts no-any. Other
    // non-identifier cases fall back to `any` so downstream `.method()`
    // calls absorb correctly.
    let castType: ts.TypeNode;
    if (ts.isIdentifier(left)) {
      castType = factory.createTypeReferenceNode('NonNullable', [
        factory.createTypeQueryNode(factory.createIdentifier(left.text)),
      ]);
    } else if (ctx.compatMode === 'rbxts') {
      castType = factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);
    } else {
      castType = factory.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword);
    }
    right = factory.createAsExpression(
      factory.createObjectLiteralExpression([], false),
      castType,
    );
  } else if (
    // rbxts: `X and X.prop` where X is an unknown-typed Local — TS
    // narrows X to `{}` in the truthy branch, breaking `X.prop`. Cast
    // the receiver of X.prop through Record so the access doesn't
    // surface TS2339 / TS2571.
    //
    // Skip when the Local has a shape annotation already (the cast
    // would shadow the shape's known properties), or when the Local
    // resolves to a class via the chain-split / oracle path.
    ctx.compatMode === 'rbxts'
    && expr.op === 'and'
    && expr.left.type === 'Local'
    && expr.right.type === 'IndexName'
    && expr.right.expr.type === 'Local'
    && expr.right.expr.name === expr.left.name
    && !ctx.tsTypedClassLocal.has(expr.left.name)
    && !ctx.tsTypedPrimitiveLocal.has(expr.left.name)
    && !ctx.preInferredParamType.has(expr.left.name)
    && ctx.lookupLocal(expr.left.name) === 'unknown'
    && !oracleHasMember(ctx, 'Instance', expr.right.index)
  ) {
    right = factory.createPropertyAccessExpression(
      factory.createParenthesizedExpression(
        factory.createAsExpression(
          factory.createAsExpression(
            compileExpr(expr.right.expr, ctx),
            factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
          ),
          factory.createTypeReferenceNode('Record', [
            factory.createKeywordTypeNode(ts.SyntaxKind.StringKeyword),
            factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
          ]),
        ),
      ),
      factory.createIdentifier(propertyName(expr.right.index)),
    );
  } else if (
    // rbxts: `X.Y and X.Y.Z` — RHS evaluates `X.Y` whose type is `unknown`
    // (Record-routed), then reads `.Z` on unknown, which TS rejects. Cast
    // the RHS receiver (X.Y) through Record so the `.Z` access type-checks.
    ctx.compatMode === 'rbxts'
    && expr.op === 'and'
    && expr.right.type === 'IndexName'
    && exprsStructurallyEqual(expr.left, expr.right.expr)
  ) {
    right = factory.createPropertyAccessExpression(
      recordCastExpression(compileExpr(expr.right.expr, ctx)),
      factory.createIdentifier(propertyName(expr.right.index)),
    );
  } else {
    right = compileExpr(expr.right, ctx);
  }

  if (expr.op === 'and' || expr.op === 'or') {
    return compileLogicalBinary(expr.op, left, right, ctx, leftType);
  }

  if (leftType === 'number' && rightType === 'number') {
    // Direct numeric only when both operands are TS-typed as number too —
    // tracked-number locals that TS sees as `unknown` (let X = …; X = …)
    // still need the `as unknown as number` operand cast, otherwise the
    // `*`/`+` operators fail TS18046 at the binary node.
    const tsKnown =
      ctx.compatMode !== 'rbxts'
      || (isTrustedTypedExpr(expr.left, ctx) && isTrustedTypedExpr(expr.right, ctx));
    if (tsKnown) {
      const directNumeric: Partial<Record<string, ts.BinaryOperator>> = {
        '+': ts.SyntaxKind.PlusToken,
        '-': ts.SyntaxKind.MinusToken,
        '*': ts.SyntaxKind.AsteriskToken,
        '/': ts.SyntaxKind.SlashToken,
        '^': ts.SyntaxKind.AsteriskAsteriskToken,
      };
      const op = directNumeric[expr.op];
      if (op !== undefined) return factory.createBinaryExpression(left, op, right);
      if (expr.op === '//') {
        return factory.createCallExpression(
          factory.createPropertyAccessExpression(factory.createIdentifier('Math'), 'floor'),
          undefined,
          [factory.createBinaryExpression(left, ts.SyntaxKind.SlashToken, right)],
        );
      }
    }
  }

  // Datatype fast-path: LEFT-typed Roblox datatype → `.add/.sub/.mul/.div(rhs)`
  // (the typed overload covers both same-datatype and scalar). Skipped when
  // only the RIGHT is datatype — `2 * v1` can't call `.mul()` on a JS number.
  if (typeof leftType === 'string' && leftType.startsWith('datatype:')) {
    const methodMap: Partial<Record<string, string>> = {
      '+': 'add',
      '-': 'sub',
      '*': 'mul',
      '/': 'div',
    };
    const method = methodMap[expr.op];
    if (method) {
      return factory.createCallExpression(
        factory.createPropertyAccessExpression(left, factory.createIdentifier(method)),
        undefined,
        [right],
      );
    }
  }

  if (
    (expr.op === '==' || expr.op === '~=')
    && isPrimitiveStaticType(leftType)
    && isPrimitiveStaticType(rightType)
  ) {
    return factory.createBinaryExpression(
      left,
      expr.op === '=='
        ? ts.SyntaxKind.EqualsEqualsEqualsToken
        : ts.SyntaxKind.ExclamationEqualsEqualsToken,
      right,
    );
  }

  // `..` concat: when either side is string, JS template literals match Lua
  // semantics (`${x}` calls `.toString()` on non-string operands).
  if (expr.op === '..' && (leftType === 'string' || rightType === 'string')) {
    return buildTemplateLiteral([
      { value: left, type: leftType },
      { value: right, type: rightType },
    ]);
  }

  return compileBinary(expr.op, left, right, ctx, expr.left, expr.right);
}

/** Build a TS template literal from a sequence of string-or-other values.
 *  Each consecutive run of string literals is folded into a single template
 *  span; everything else becomes an interpolation. */
function buildTemplateLiteral(
  parts: { value: ts.Expression; type: StaticValueType }[],
): ts.TemplateLiteral {
  // Flatten nested template literals from prior `..` concatenations so
  // `("a" .. b) .. c` becomes one template instead of nested ones.
  const flat: { value: ts.Expression; type: StaticValueType }[] = [];
  for (const p of parts) {
    if (ts.isTemplateExpression(p.value)) {
      // Decompose: head + spans → [string, expr, string, expr, ..., string].
      flat.push({ value: factory.createStringLiteral(p.value.head.text), type: 'string' });
      for (const span of p.value.templateSpans) {
        flat.push({ value: span.expression, type: 'unknown' });
        flat.push({ value: factory.createStringLiteral(span.literal.text), type: 'string' });
      }
      continue;
    }
    if (ts.isNoSubstitutionTemplateLiteral(p.value)) {
      flat.push({ value: factory.createStringLiteral(p.value.text), type: 'string' });
      continue;
    }
    flat.push(p);
  }

  // Walk: emit head string, then alternating expr/string spans.
  let head = '';
  let i = 0;
  while (i < flat.length && flat[i]!.type === 'string' && ts.isStringLiteral(flat[i]!.value)) {
    head += (flat[i]!.value as ts.StringLiteral).text;
    i++;
  }
  if (i >= flat.length) {
    // Pure literal — return `${head}` as a single string (no template needed),
    // wrapped to keep the return type consistent.
    return factory.createNoSubstitutionTemplateLiteral(head);
  }
  const spans: ts.TemplateSpan[] = [];
  while (i < flat.length) {
    const exprPart = flat[i]!;
    i++;
    let between = '';
    while (i < flat.length && flat[i]!.type === 'string' && ts.isStringLiteral(flat[i]!.value)) {
      between += (flat[i]!.value as ts.StringLiteral).text;
      i++;
    }
    const literal = i >= flat.length
      ? factory.createTemplateTail(between)
      : factory.createTemplateMiddle(between);
    spans.push(factory.createTemplateSpan(exprPart.value, literal));
  }
  return factory.createTemplateExpression(factory.createTemplateHead(head), spans);
}

function compileBinary(
  op: string,
  left: ts.Expression,
  right: ts.Expression,
  ctx: CompileContext,
  leftExpr?: Expr,
  rightExpr?: Expr,
): ts.Expression {
  if (op === 'and' || op === 'or') {
    return compileLogicalBinary(op, left, right, ctx);
  }
  // Arithmetic / concat / and-or / equality route through runtime helpers
  // because JS has no operator overloading: `cf * cf2` on Roblox CFrames
  // must call into our luaMul, which dispatches to .mul()/__mul. The
  // helpers fast-path numeric operands so `1 + 2` stays cheap.
  // Comparison ops on numbers/strings stay direct.
  const helperName: Record<string, string> = {
    '+': 'luaAdd',
    '-': 'luaSub',
    '*': 'luaMul',
    '/': 'luaDiv',
    '%': 'luaMod',
    '^': 'luaPow',
    '//': 'luaIdiv',
    '..': 'luaConcat',
    '==': 'luaEq',
  };
  // In rbxts mode we route every helper-call binary op through a native
  // TS operator instead. roblox-ts compiling back to Lua already
  // dispatches `+`/`*`/`==` on Roblox datatypes via their __add/__mul/__eq
  // metamethods, and emits Lua `..` for template literals — so the helpers
  // are pure middleware that adds runtime imports without changing the
  // final Lua semantics.
  if (ctx.compatMode === 'rbxts') {
    const nativeOp: Partial<Record<string, ts.BinaryOperator>> = {
      '+': ts.SyntaxKind.PlusToken,
      '-': ts.SyntaxKind.MinusToken,
      '*': ts.SyntaxKind.AsteriskToken,
      '/': ts.SyntaxKind.SlashToken,
      '%': ts.SyntaxKind.PercentToken,
      '^': ts.SyntaxKind.AsteriskAsteriskToken,
      '==': ts.SyntaxKind.EqualsEqualsEqualsToken,
      '~=': ts.SyntaxKind.ExclamationEqualsEqualsToken,
    };
    const direct = nativeOp[op];
    if (direct !== undefined) {
      const arithmeticOps = new Set(['+', '-', '*', '/', '%', '^']);
      if (arithmeticOps.has(op)) {
        // PropertyAccess operands (`obj.X / 256`) need the receiver recast
        // through Record first — semantic errors on sub-expressions aren't
        // suppressed by an outer `as` cast.
        const widenAccess = (e: ts.Expression): ts.Expression => {
          if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.name)) {
            return factory.createPropertyAccessExpression(
              factory.createParenthesizedExpression(
                factory.createAsExpression(
                  factory.createAsExpression(
                    e.expression,
                    factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
                  ),
                  factory.createTypeReferenceNode('Record', [
                    factory.createKeywordTypeNode(ts.SyntaxKind.StringKeyword),
                    factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
                  ]),
                ),
              ),
              e.name,
            );
          }
          return e;
        };
        // Cast operands `as unknown as number` (not `as any`, which trips
        // roblox-ts no-any). Vector3 arithmetic uses the .add()/.sub() path
        // earlier; this fallback covers unknown-typed numeric operands.
        const wrap = (e: ts.Expression, srcExpr?: Expr) => {
          if (srcExpr && staticTypeOfExpr(srcExpr, ctx) === 'number') {
            return widenAccess(e);
          }
          return factory.createParenthesizedExpression(
            factory.createAsExpression(
              factory.createAsExpression(
                widenAccess(e),
                factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
              ),
              factory.createKeywordTypeNode(ts.SyntaxKind.NumberKeyword),
            ),
          );
        };
        return factory.createBinaryExpression(wrap(left, leftExpr), direct, wrap(right, rightExpr));
      }
      // `===`/`!==` widen operands `as unknown` to avoid TS2367 when shape
      // inference narrowed one side away from a primitive literal.
      if (op === '==' || op === '~=') {
        const wrapU = (e: ts.Expression) =>
          factory.createParenthesizedExpression(
            factory.createAsExpression(e, factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword)),
          );
        return factory.createBinaryExpression(wrapU(left), direct, wrapU(right));
      }
      return factory.createBinaryExpression(left, direct, right);
    }
    if (op === '//') {
      // `Math.floor(a / b)` — roblox-ts lowers to `math.floor(a / b)`.
      return factory.createCallExpression(
        factory.createPropertyAccessExpression(factory.createIdentifier('Math'), 'floor'),
        undefined,
        [factory.createBinaryExpression(left, ts.SyntaxKind.SlashToken, right)],
      );
    }
    if (op === '..') {
      // Template literal — roblox-ts emits Lua `..` for these, and the
      // interpolant `.toString()` matches Lua's implicit tostring.
      return factory.createTemplateExpression(
        factory.createTemplateHead(''),
        [
          factory.createTemplateSpan(left, factory.createTemplateMiddle('')),
          factory.createTemplateSpan(right, factory.createTemplateTail('')),
        ],
      );
    }
  }
  if (op === '~=') {
    const fn = ctx.use('luaEq');
    return factory.createPrefixUnaryExpression(
      ts.SyntaxKind.ExclamationToken,
      factory.createCallExpression(factory.createIdentifier(fn), undefined, [left, right]),
    );
  }
  if (helperName[op]) {
    const fn = ctx.use(helperName[op]!);
    return factory.createCallExpression(factory.createIdentifier(fn), undefined, [left, right]);
  }

  const direct: Record<string, ts.BinaryOperator> = {
    '<': ts.SyntaxKind.LessThanToken,
    '<=': ts.SyntaxKind.LessThanEqualsToken,
    '>': ts.SyntaxKind.GreaterThanToken,
    '>=': ts.SyntaxKind.GreaterThanEqualsToken,
  };
  const directOp = direct[op];
  if (directOp !== undefined) {
    // rbxts: comparison operands may be `unknown` (shape leaves); cast through
    // a comparable primitive to avoid TS2571 without tripping no-any. Skip
    // the cast when staticTypeOfExpr already knows the operand is `number`.
    if (ctx.compatMode === 'rbxts') {
      const wrap = (e: ts.Expression, srcExpr?: Expr) => {
        if (srcExpr && staticTypeOfExpr(srcExpr, ctx) === 'number') {
          return e;
        }
        return factory.createParenthesizedExpression(
          factory.createAsExpression(
            factory.createAsExpression(
              e,
              factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
            ),
            factory.createKeywordTypeNode(ts.SyntaxKind.NumberKeyword),
          ),
        );
      };
      return factory.createBinaryExpression(wrap(left, leftExpr), directOp, wrap(right, rightExpr));
    }
    return factory.createBinaryExpression(left, directOp, right);
  }

  throw new Error(`luau-to-ts: unhandled binary operator '${op}'`);
}

function compileLogicalBinary(
  op: 'and' | 'or',
  left: ts.Expression,
  right: ts.Expression,
  ctx: CompileContext,
  leftType: StaticValueType = 'unknown',
): ts.Expression {
  // Lua `and`/`or` return the chosen operand, not boolean. When left is
  // statically boolean and side-effect-free, `&&`/`||` match exactly.
  if (leftType === 'boolean' && isRepeatableExpression(left)) {
    return factory.createBinaryExpression(
      left,
      op === 'and' ? ts.SyntaxKind.AmpersandAmpersandToken : ts.SyntaxKind.BarBarToken,
      right,
    );
  }
  // rbxts: native operators. `or` picks `||` for boolean LHS (false-truthy
  // match), `??` otherwise (default-on-nil — the common author intent).
  if (ctx.compatMode === 'rbxts') {
    if (op === 'and') {
      return factory.createBinaryExpression(left, ts.SyntaxKind.AmpersandAmpersandToken, right);
    }
    const orToken = leftType === 'boolean'
      ? ts.SyntaxKind.BarBarToken
      : ts.SyntaxKind.QuestionQuestionToken;
    return factory.createBinaryExpression(left, orToken, right);
  }
  if (isRepeatableExpression(left)) {
    return factory.createConditionalExpression(
      truthify(left, ctx, leftType),
      factory.createToken(ts.SyntaxKind.QuestionToken),
      op === 'and' ? right : left,
      factory.createToken(ts.SyntaxKind.ColonToken),
      op === 'and' ? left : right,
    );
  }
  // Non-repeatable LHS — bind it once via a single-expression arrow IIFE
  // so the truthiness test and the chosen-operand both reference the
  // same evaluation: `(__l => isTruthy(__l) ? right : __l)(left)`.
  const leftId = factory.createIdentifier('__l');
  const needsAsync = nodeContainsAwait(right);
  const choose = factory.createConditionalExpression(
    factory.createCallExpression(
      factory.createIdentifier(ctx.use('isTruthy')),
      undefined,
      [leftId],
    ),
    factory.createToken(ts.SyntaxKind.QuestionToken),
    op === 'and' ? right : leftId,
    factory.createToken(ts.SyntaxKind.ColonToken),
    op === 'and' ? leftId : right,
  );
  const arrow = factory.createArrowFunction(
    needsAsync ? ASYNC_MOD : undefined,
    undefined,
    [factory.createParameterDeclaration(undefined, undefined, leftId)],
    undefined,
    factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
    choose,
  );
  const call = factory.createCallExpression(
    factory.createParenthesizedExpression(arrow),
    undefined,
    [left],
  );
  return needsAsync ? factory.createAwaitExpression(call) : call;
}

// Roblox yielding functions — call sites get wrapped in `await`. `delay` /
// `task.spawn` are NOT here (fire-and-forget). `WaitForChild` is NOT here —
// our runtime is synchronous; awaiting it would force every caller async.
const YIELDING_FREE_FUNCS = new Set(['wait', 'pcall', 'xpcall', 'require']);
const YIELDING_TASK_FUNCS = new Set(['wait']);
const YIELDING_METHODS = new Set([
  'Wait', 'wait',
  'InvokeServer', 'invokeServer', 'InvokeClient', 'invokeClient',
  'LoadAsset', 'loadAsset',
  'LoadAssetVersion', 'LoadAssetWithFormat',
]);

function isYieldingCall(expr: Extract<Expr, { type: 'Call' }>, ctx?: CompileContext): boolean {
  // rbxts targets Lua (via roblox-ts); yields are implicit there.
  if (ctx?.compatMode === 'rbxts') return false;
  // Catches snapshot-locals (`local wait,pcall = wait,pcall`) too.
  if ((expr.func.type === 'Global' || expr.func.type === 'Local') && YIELDING_FREE_FUNCS.has(expr.func.name)) {
    return true;
  }
  if (expr.func.type === 'IndexName' && expr.func.expr.type === 'Global') {
    if (expr.func.expr.name === 'task' && YIELDING_TASK_FUNCS.has(expr.func.index)) return true;
  }
  if (expr.func.type === 'IndexName' && YIELDING_METHODS.has(expr.func.index)) {
    return true;
  }
  // Pre-pass-scanner-discovered user fns: matches direct + member (Server.Init).
  if (ctx && (expr.func.type === 'Local' || expr.func.type === 'Global')) {
    if (ctx.yieldingFunctions.has((expr.func as { name: string }).name)) return true;
  }
  if (ctx && expr.func.type === 'IndexName') {
    if (ctx.yieldingFunctions.has((expr.func as { index: string }).index)) return true;
  }
  // *Async* naming convention — substring match catches both `LoadProfileAsync`
  // and `StandardProfileUpdateAsyncDataStore`. ProfileService and similar Lua
  // libs use the suffix loosely; missing one breaks Promise chains.
  const nameOf =
    expr.func.type === 'IndexName' ? expr.func.index :
    expr.func.type === 'Global' ? expr.func.name :
    expr.func.type === 'Local' ? (expr.func as { name?: string }).name :
    undefined;
  if (nameOf && /Async/.test(nameOf)) return true;
  return false;
}

/** Walk every node in a tree. Calls `visit(node)` for each node-typed object
 *  (anything with a string `.type` property). Used by the yield-inference
 *  pre-pass to find function definitions and call expressions without
 *  enumerating every Luau AST shape by hand. */
function walkLuauNodes(node: unknown, visit: (n: { type: string }) => void): void {
  if (!node || typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;
  if (typeof obj.type === 'string') visit(obj as { type: string });
  for (const key of Object.keys(obj)) {
    if (key === 'loc' || key === 'argLocation') continue;
    const value = obj[key];
    if (Array.isArray(value)) {
      for (const item of value) walkLuauNodes(item, visit);
    } else if (value && typeof value === 'object') {
      walkLuauNodes(value, visit);
    }
  }
}

/** Pre-pass: populate `ctx.yieldingFunctions` with every named function whose
 *  body transitively yields. Fixed-point iteration so a caller picks up its
 *  callee's status across forward references. */
function scanYieldingFunctions(root: BlockStat, ctx: CompileContext): void {
  // 1. Catalog every named function definition reachable from the root.
  const funcBodies = new Map<string, BlockStat>();
  walkLuauNodes(root, (n) => {
    if (n.type === 'LocalFunction') {
      const s = n as unknown as LocalFunctionStat;
      funcBodies.set(s.name.name, s.func.body);
    } else if (n.type === 'Function' && 'func' in n && 'name' in n) {
      // FunctionStat (statement form): distinguish from FunctionExpr by structure.
      const s = n as unknown as { name: Expr; func: { body: BlockStat } };
      if (s.name && (s.name.type === 'Global' || s.name.type === 'Local')) {
        funcBodies.set((s.name as { name: string }).name, s.func.body);
      } else if (s.name && s.name.type === 'IndexName' && 'index' in s.name) {
        // `function Obj.Method()` — catalog by member name so `Obj.Method()`
        // call sites resolve via the IndexName-tail.
        funcBodies.set((s.name as { index: string }).index, s.func.body);
      }
    } else if (n.type === 'Local' && 'vars' in n && 'values' in n) {
      // `local foo = function()` — LocalStat (has vars/values), not the bare
      // Local variable-name node.
      const s = n as unknown as LocalStat;
      for (let i = 0; i < s.vars.length; i += 1) {
        const init = s.values[i];
        if (init && init.type === 'Function' && 'body' in init) {
          funcBodies.set(s.vars[i]!.name, (init as { body: BlockStat }).body);
        }
      }
    } else if (n.type === 'Assign' && 'vars' in n && 'values' in n) {
      // `foo = function()` / `Obj.Init = function()` — global-assignment form.
      const s = n as unknown as { vars: Expr[]; values: Expr[] };
      for (let i = 0; i < s.vars.length; i += 1) {
        const target = s.vars[i];
        const init = s.values[i];
        if (!init || init.type !== 'Function' || !('body' in init)) continue;
        const body = (init as { body: BlockStat }).body;
        if (!target) continue;
        if (target.type === 'Global' || target.type === 'Local') {
          funcBodies.set((target as { name: string }).name, body);
        } else if (target.type === 'IndexName' && 'index' in target) {
          funcBodies.set((target as { index: string }).index, body);
        }
      }
    }
  });

  // Fixed-point: a function yields if its body contains a yielding call.
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, body] of funcBodies) {
      if (ctx.yieldingFunctions.has(name)) continue;
      let bodyYields = false;
      walkLuauNodes(body, (n) => {
        if (bodyYields) return;
        if (n.type === 'Call') {
          if (isYieldingCall(n as Extract<Expr, { type: 'Call' }>, ctx)) {
            bodyYields = true;
          }
        }
      });
      if (bodyYields) {
        ctx.yieldingFunctions.add(name);
        changed = true;
      }
    }
  }
}

function scanUserFunctionReturnClasses(root: BlockStat, ctx: CompileContext): void {
  if (!ctx.flowFactByExpr) return;
  const funcBodies = new Map<string, BlockStat>();
  walkLuauNodes(root, (n) => {
    if (n.type === 'LocalFunction') {
      const s = n as unknown as LocalFunctionStat;
      funcBodies.set(s.name.name, s.func.body);
    } else if (n.type === 'Function' && 'func' in n && 'name' in n) {
      const s = n as unknown as { name: Expr; func: { body: BlockStat } };
      if (s.name && (s.name.type === 'Global' || s.name.type === 'Local')) {
        funcBodies.set((s.name as { name: string }).name, s.func.body);
      }
    } else if (n.type === 'Local' && 'vars' in n && 'values' in n) {
      const s = n as unknown as LocalStat;
      for (let i = 0; i < s.vars.length; i += 1) {
        const init = s.values[i];
        if (init && init.type === 'Function' && 'body' in init) {
          funcBodies.set(s.vars[i]!.name, (init as { body: BlockStat }).body);
        }
      }
    }
  });

  const collectReturns = (stat: Stat | null | undefined, classes: Set<string>, state: { bad: boolean }): void => {
    if (!stat || state.bad) return;
    switch (stat.type) {
      case 'Return': {
        const value = stat.values[0];
        if (!value) return;
        const fact = flowFactOf(value, ctx);
        if (fact?.kind === 'class') {
          classes.add(fact.name);
          return;
        }
        if (value.type === 'ConstantNil') return;
        state.bad = true;
        return;
      }
      case 'Block':
        for (const s of stat.body) collectReturns(s, classes, state);
        return;
      case 'If':
        collectReturns(stat.thenBody, classes, state);
        collectReturns(stat.elseBody, classes, state);
        return;
      case 'While':
      case 'Repeat':
      case 'For':
      case 'ForIn':
        collectReturns(stat.body, classes, state);
        return;
      case 'Function':
      case 'LocalFunction':
        return;
      default:
        return;
    }
  };

  for (const [name, body] of funcBodies) {
    const classes = new Set<string>();
    const state = { bad: false };
    collectReturns(body, classes, state);
    if (!state.bad && classes.size === 1) {
      ctx.userFunctionReturnClass.set(name, [...classes][0]!);
    }
  }
}

/** rbxts: cast each call arg through `Parameters<typeof callee>[i]` so
 *  unknown values flow into the callee's declared params. Only fires for
 *  simple callees TS can `typeof` (Identifier / shallow PropertyAccess).
 *
 *  Phase 3 narrows this: an arg whose static type already matches the
 *  expected slot is emitted bare. Eliminates the `as unknown as
 *  Parameters<typeof string.reverse>[0]` noise that drove most of the
 *  per-corpus `as unknown` count. */
function castArgsForCall(
  callee: ts.Expression,
  args: readonly ts.Expression[],
  ctx: CompileContext,
  luauArgs?: readonly Expr[],
): readonly ts.Expression[] {
  if (ctx.compatMode !== 'rbxts') return args;
  if (!isSimpleCalleeRef(callee)) return args;
  const expectedSlot = expectedSlotTypes(callee);
  return args.map((arg, i) => {
    if (ts.isSpreadElement(arg)) {
      if (
        ts.isIdentifier(callee)
        && ts.isIdentifier(arg.expression)
        && arg.expression.text === '__varargs'
        && !AMBIENT_GLOBALS.has(callee.text)
      ) {
        return factory.createSpreadElement(
          factory.createAsExpression(
            arg.expression,
            factory.createTypeReferenceNode('Parameters', [
              factory.createTypeQueryNode(callee),
            ]),
          ),
        );
      }
      return arg;
    }
    // Skip cast when the arg's Luau static type matches the expected slot
    // AND the source expression is one TS will already type concretely
    // (constants, oracle-typed call results, param-inferred locals). A
    // bare local with `tracked='number'` but no TS annotation still needs
    // the cast — TS doesn't see our internal tracking.
    const expected = expectedSlot?.[i] ?? expectedSlot?.rest;
    if (expected) {
      if (expected === 'any') return arg;
      if (luauArgs?.[i]) {
        const luau = luauArgs[i]!;
        const t = staticTypeOfExpr(luau, ctx);
        const trusted = isTrustedTypedExpr(luau, ctx);
        if (trusted && t === expected) return arg;
        if (trusted && expected === 'number|string' && (t === 'number' || t === 'string')) return arg;
      }
    } else if (
      luauArgs?.[i]
      && isTrustedTypedExpr(luauArgs[i]!, ctx)
      && ts.isIdentifier(callee)
    ) {
      // Bare-identifier callee = user-defined function: declared params
      // emit as `?: unknown` from paramsFromLocals, so passing a
      // trusted-typed arg is safe without the `Parameters<>` wrap.
      // PropertyAccess callees (X.Y) may have typed slots (Players.
      // GetPlayerByUserId expects number) — leave those casts intact.
      return arg;
    }
    if (ts.isParenthesizedExpression(arg) && ts.isAsExpression(arg.expression) && !expected && !ts.isIdentifier(callee)) return arg;
    if (ts.isAsExpression(arg) && !expected && !ts.isIdentifier(callee)) return arg;
    const inner = (
      ts.isArrowFunction(arg)
      || ts.isFunctionExpression(arg)
      || ts.isBinaryExpression(arg)
      || ts.isConditionalExpression(arg)
    )
      ? factory.createParenthesizedExpression(arg)
      : arg;
    return factory.createAsExpression(
      factory.createAsExpression(
        inner,
        factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
      ),
      factory.createIndexedAccessTypeNode(
        factory.createTypeReferenceNode('Parameters', [
          factory.createTypeQueryNode(callee as ts.EntityName),
        ]),
        factory.createLiteralTypeNode(factory.createNumericLiteral(i)),
      ),
    );
  });
}

/** Per-callee expected slot static types. Populated from known stdlib /
 *  globals signatures so castArgsForCall can skip redundant casts when
 *  the arg's static type already matches. The `'any'` slot means the
 *  declared param type is `unknown` — any arg is type-compatible without
 *  a cast. */
type SlotKind = 'string' | 'number' | 'boolean' | 'number|string' | 'instance' | 'any';
type ExpectedSlots = { [i: number]: SlotKind } & { rest?: SlotKind };
function expectedSlotTypes(callee: ts.Expression): ExpectedSlots | undefined {
  let path = '';
  let methodName = '';
  if (ts.isIdentifier(callee)) path = callee.text;
  else if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && ts.isIdentifier(callee.name)) {
    path = `${callee.expression.text}.${callee.name.text}`;
    methodName = callee.name.text;
  } else if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name)) {
    methodName = callee.name.text;
  } else {
    return undefined;
  }
  // Instance navigation methods accept string + optional bool/number at slot 1.
  switch (methodName) {
    case 'WaitForChild':
      return { 0: 'string', 1: 'number' };
    case 'FindFirstChild':
    case 'FindFirstAncestor':
    case 'FindFirstDescendant':
      return { 0: 'string', 1: 'boolean' };
    case 'FindFirstChildOfClass':
    case 'FindFirstAncestorOfClass':
    case 'FindFirstChildWhichIsA':
    case 'FindFirstAncestorWhichIsA':
      return { 0: 'string' };
    case 'GetAttribute':
    case 'SetAttribute':
      return { 0: 'string' };
    case 'GetPlayerFromCharacter':
      return { 0: 'instance' };
    case 'IsA':
      return { 0: 'string' };
  }
  switch (path) {
    case 'tostring': return { 0: 'any', rest: 'any' };
    case 'tonumber': return { 0: 'string' };
    case 'type': return { 0: 'any' };
    case 'typeOf': return { 0: 'any' };
    case 'typeIs': return { 0: 'any', 1: 'string' };
    case 'classIs': return { 0: 'any', 1: 'string' };
    case 'print':
    case 'warn':
    case 'error':
    case 'assert':
      return { 0: 'any', rest: 'any' };
    // Roblox task library — `task.wait(seconds)` is the common
    // pattern; spawn/delay take a callback first and need the cast.
    case 'task.wait':
      return { 0: 'number' };
    // `wait(seconds)` global (deprecated but still common).
    case 'wait':
      return { 0: 'number' };
    // Roblox datatype static factories — all numeric args.
    case 'Color3.fromRGB':
    case 'Color3.fromHSV':
    case 'CFrame.fromEulerAnglesXYZ':
    case 'CFrame.fromEulerAnglesYXZ':
    case 'CFrame.Angles':
    case 'UDim2.fromOffset':
    case 'UDim2.fromScale':
    case 'UDim.fromOffset':
    case 'UDim.fromScale':
    case 'Region3.new':
    case 'NumberRange.new':
    case 'Rect.new':
      return { 0: 'number', 1: 'number', 2: 'number', 3: 'number', rest: 'number' };
    case 'string.reverse':
    case 'string.lower':
    case 'string.upper':
    case 'string.len':
    case 'string.byte':
      return { 0: 'string' };
    case 'string.sub':
    case 'string.rep':
      return { 0: 'string', 1: 'number', 2: 'number' };
    case 'string.find':
    case 'string.match':
    case 'string.gmatch':
      return { 0: 'string', 1: 'string', 2: 'number', 3: 'boolean' };
    case 'string.gsub':
      return { 0: 'string', 1: 'string', 2: 'string', 3: 'number' };
    case 'string.format':
      return { 0: 'string', rest: 'number|string' };
    case 'string.split':
      return { 0: 'string', 1: 'string' };
    case 'math.floor':
    case 'math.ceil':
    case 'math.abs':
    case 'math.sqrt':
    case 'math.log':
    case 'math.exp':
    case 'math.sin':
    case 'math.cos':
    case 'math.tan':
    case 'math.asin':
    case 'math.acos':
    case 'math.atan':
    case 'math.rad':
    case 'math.deg':
    case 'math.sign':
    case 'math.round':
      return { 0: 'number' };
    case 'math.min':
    case 'math.max':
    case 'math.pow':
    case 'math.fmod':
    case 'math.modf':
      return { 0: 'number', 1: 'number', rest: 'number' };
    case 'math.clamp':
    case 'math.atan2':
      return { 0: 'number', 1: 'number', 2: 'number' };
    default:
      return undefined;
  }
}

/** True for Luau exprs that compile to a TS expression TS already types
 *  concretely. Bare reassigned locals are NOT trusted — staticTypeOfExpr
 *  may say `number` because of tracked assignments, but the `let X = …`
 *  declaration leaves TS inferring `unknown`. */
function isTrustedTypedExpr(expr: Expr, ctx: CompileContext): boolean {
  if (expr.type === 'IndexName' || expr.type === 'Call') {
    const flowed = flowFactToStatic(flowFactOf(expr, ctx));
    if (flowed && flowed !== 'unknown') return true;
  }
  switch (expr.type) {
    case 'ConstantString':
    case 'ConstantNumber':
    case 'ConstantInteger':
    case 'ConstantBool':
      return true;
    case 'Group':
      return isTrustedTypedExpr(expr.expr, ctx);
    case 'TypeAssertion':
      return true;
    case 'Local':
      return ctx.preInferredParamType.has(expr.name)
        || ctx.tsTypedPrimitiveLocal.has(expr.name);
    case 'Call': {
      const fn = expr.func;
      if (fn.type === 'Global' && (fn.name === 'tostring' || fn.name === 'tonumber')) return true;
      if (fn.type === 'IndexName' && fn.expr.type === 'Global') {
        const ns = fn.expr.name;
        if (ns === 'math' || ns === 'string') return true;
      }
      // Receiver-method form for string lib (s:gsub etc): the methods
      // we route through namespace form, but for safety treat them as
      // trusted if the receiver is a trusted string.
      if (fn.type === 'IndexName' && expr.self) {
        return isTrustedTypedExpr(fn.expr, ctx);
      }
      return false;
    }
    case 'Binary':
      // Arithmetic on trusted operands → trusted number.
      if (['+', '-', '*', '/', '%', '^', '//'].includes(expr.op)) {
        return isTrustedTypedExpr(expr.left, ctx) && isTrustedTypedExpr(expr.right, ctx);
      }
      if (expr.op === '..') return true;
      return false;
    default:
      return false;
  }
}

/** True for Identifier or PropertyAccess chains TS can `typeof`. Capped at
 *  depth 2 so deeper chains with structurally-unknown intermediates don't
 *  generate `typeof unknown.X` (TS2571). */
function isSimpleCalleeRef(expr: ts.Expression, depth = 0): boolean {
  if (ts.isIdentifier(expr)) return true;
  if (ts.isPropertyAccessExpression(expr) && depth < 1) {
    return isSimpleCalleeRef(expr.expression, depth + 1);
  }
  return false;
}

function compileExprAsArg(a: Expr, ctx: CompileContext): ts.Expression {
  if (a.type === 'Varargs') {
    return factory.createSpreadElement(factory.createIdentifier('__varargs'));
  }
  return compileExpr(a, ctx);
}

function compileCall(expr: Extract<Expr, { type: 'Call' }>, ctx: CompileContext): ts.Expression {
  // Arguments are single-value Luau positions (the last positional one
  // is the only one that could fan out, and even then only at the call
  // site — we don't model that here). Suppress the outer multi-return
  // signal so nested tuple-returning calls auto-extract.
  const savedMR = ctx.preferMultiReturn;
  ctx.preferMultiReturn = false;
  let args = expr.args.map((a) => compileExprAsArg(a, ctx));
  ctx.preferMultiReturn = savedMR;

  if (
    ctx.compatMode === 'rbxts'
    && !expr.self
    && expr.func.type === 'Global'
    && expr.func.name === 'require'
    && args[0]
    && !ts.isSpreadElement(args[0])
  ) {
    args = [
      factory.createAsExpression(
        factory.createAsExpression(
          args[0],
          factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
        ),
        factory.createTypeReferenceNode('ModuleScript', undefined),
      ),
      ...args.slice(1),
    ];
  }

  // rbxts mode: `string.format(fmt, …rest)` typed as `(fmt: string,
  // …Array<number | string>)` per @rbxts/types. After Phase 2, the
  // rest args are often `unknown` (structural-shape leaves), which
  // fires TS2345. Cast each rest arg `as unknown as string | number`
  // so the variadic slot accepts them. Same for `string.gsub`'s
  // repl arg in some shapes — applied uniformly across the string
  // namespace methods that have number-or-string variadic tails.
  if (
    ctx.compatMode === 'rbxts'
    && !expr.self
    && expr.func.type === 'IndexName'
    && expr.func.expr.type === 'Global'
    && (expr.func.expr as { name: string }).name === 'string'
    && (expr.func.index === 'format')
    && args.length > 1
  ) {
    const numStr = factory.createUnionTypeNode([
      factory.createKeywordTypeNode(ts.SyntaxKind.NumberKeyword),
      factory.createKeywordTypeNode(ts.SyntaxKind.StringKeyword),
    ]);
    args = [
      args[0]!,
      ...args.slice(1).map((a) =>
        factory.createAsExpression(
          factory.createAsExpression(
            ts.isBinaryExpression(a) || ts.isConditionalExpression(a)
              ? factory.createParenthesizedExpression(a)
              : a,
            factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
          ),
          numStr,
        ),
      ),
    ];
  }

  // Macro registry — interception point for compatMode='rbxts' rewrites
  // (Vector3.new → new Vector3, Instance.new("Part") → new Part(),
  // game:GetService("X") → imported X singleton, TS.async → async fn, …).
  // Macros may decline (return undefined) and fall through to default emit.
  const macroResult = lookupMacro({ call: expr, compiledArgs: args, ctx });
  if (macroResult !== undefined) {
    if (isYieldingCall(expr, ctx)) return factory.createAwaitExpression(macroResult);
    return macroResult;
  }

  // rbxts: `setmetatable(obj, ClassName)` — drop the call entirely when the
  // second arg is a detected class (the class declaration covers it). For
  // genuine mixin/weak-ref plumbing, cast the second arg to LuaMetatable<object>.
  if (
    ctx.compatMode === 'rbxts'
    && !expr.self
    && expr.func.type === 'Global'
    && (expr.func as { name: string }).name === 'setmetatable'
    && args.length >= 2
  ) {
    const secondArg = expr.args[1];
    const secondIsDetectedClass =
      secondArg
      && (secondArg.type === 'Global' || secondArg.type === 'Local')
      && ctx.isDetectedClass((secondArg as { name: string }).name);
    // setmetatable returns its first arg — pass it through.
    if (secondIsDetectedClass) return args[0]!;
    ctx.useAmbient('setmetatable');
    ctx.useImport('@rbxts/types', 'LuaMetatable');
    const newArgs = [
      args[0]!,
      // Route through `unknown` so TS2352 (no-overlap) stays off when the
      // mt is a synthesized literal with type-mismatched __index/__newindex.
      factory.createAsExpression(
        factory.createAsExpression(
          args[1]!,
          factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
        ),
        factory.createTypeReferenceNode('LuaMetatable', [
          factory.createTypeReferenceNode('object', undefined),
        ]),
      ),
      ...args.slice(2),
    ];
    return factory.createCallExpression(
      factory.createIdentifier('setmetatable'),
      undefined,
      newArgs,
    );
  }

  // Lua string colon-methods (`s:format(...)` etc): native uses runtime
  // helper; rbxts rewrites to namespace form (`string.X(s, ...)`).
  if (
    expr.self
    && expr.func.type === 'IndexName'
    && STRING_LIB_METHODS.has(expr.func.index)
  ) {
    const methodName = expr.func.index;
    const meta = STRING_LIB_METHODS.get(methodName)!;
    if (ctx.compatMode === 'rbxts') {
      ctx.useAmbient('string');
      // format's variadic rest needs `as unknown as string | number`.
      let formattedArgs = args;
      if (methodName === 'format' && args.length >= 1) {
        const numStr = factory.createUnionTypeNode([
          factory.createKeywordTypeNode(ts.SyntaxKind.NumberKeyword),
          factory.createKeywordTypeNode(ts.SyntaxKind.StringKeyword),
        ]);
        formattedArgs = args.map((a) =>
          factory.createAsExpression(
            factory.createAsExpression(
              ts.isBinaryExpression(a) || ts.isConditionalExpression(a)
                ? factory.createParenthesizedExpression(a)
                : a,
              factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
            ),
            numStr,
          ));
      }
      // Colon-method receiver → first arg to `string.<m>(...)`. Cast through
      // `string` so shape-typed receivers flow into the `string` slot.
      const receiverExpr = factory.createAsExpression(
        factory.createAsExpression(
          compileExpr(expr.func.expr, ctx),
          factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
        ),
        factory.createKeywordTypeNode(ts.SyntaxKind.StringKeyword),
      );
      const namespaceCall = factory.createCallExpression(
        factory.createPropertyAccessExpression(
          factory.createIdentifier('string'),
          factory.createIdentifier(methodName),
        ),
        undefined,
        [receiverExpr, ...formattedArgs],
      );
      // gsub/find/byte are LuaTuple<…>; single-value positions extract [0].
      if (meta.tupleFirst && !ctx.preferMultiReturn) {
        return factory.createElementAccessExpression(namespaceCall, 0);
      }
      return namespaceCall;
    }
    const helperCall = factory.createCallExpression(
      factory.createIdentifier(ctx.use(meta.helper)),
      undefined,
      [compileExpr(expr.func.expr, ctx), ...args],
    );
    return meta.tupleFirst
      ? factory.createElementAccessExpression(helperCall, 0)
      : helperCall;
  }

  let call: ts.Expression;
  let methodCallReceiverWasRecordRouted = false;
  if (expr.self && expr.func.type === 'IndexName') {
    // rbxts: `obj[k]:Method()` — receiver is `unknown` from Record cast;
    // also cast the method slot to callable to avoid double TS2571. The
    // same cast applies for known signal methods (`:Connect`/`:Fire`/`:Wait`)
    // where the receiver is a union of incompatible RBXScriptSignal<T>.
    const receiverIsIndexExpr =
      ctx.compatMode === 'rbxts' && expr.func.expr.type === 'IndexExpr';
    const isSignalMethod =
      ctx.compatMode === 'rbxts'
      && SIGNAL_METHODS.has(expr.func.index)
      && (expr.func.expr.type === 'IndexName' || expr.func.expr.type === 'Call');
    const receiverClassForMethod =
      ctx.compatMode === 'rbxts'
        ? flowClassOf(expr.func.expr, ctx)
          ?? (expr.func.expr.type === 'Local' ? ctx.tsTypedClassLocal.get(expr.func.expr.name) : undefined)
          ?? resolveOracleClassOfExpr(expr.func.expr, ctx)
        : undefined;
    const receiverFactForMethod = ctx.compatMode === 'rbxts'
      ? flowFactOf(expr.func.expr, ctx)
      : undefined;
    const receiverEmitsLuauChild =
      ctx.compatMode === 'rbxts'
      && exprEmitsLuauChild(expr.func.expr, ctx);
    const methodMissingOnKnownInstance =
      !!receiverClassForMethod
      && ctx.oracle.isA(receiverClassForMethod, 'Instance')
      && !oracleHasMember(ctx, receiverClassForMethod, expr.func.index);
    const receiverIsObservedShape =
      ctx.compatMode === 'rbxts'
      && expr.func.expr.type === 'Local'
      && !ctx.tsTypedClassLocal.has(expr.func.expr.name)
      && !ctx.tsShapeTypedLocal.has(expr.func.expr.name)
      && !ctx.preInferredParamType.has(expr.func.expr.name)
      && localObservedShapeHasMember(expr.func.expr, expr.func.index, ctx);
    const receiverIsUnknownChain =
      ctx.compatMode === 'rbxts'
      && expr.func.expr.type === 'IndexName'
      && !receiverClassForMethod
      && rootGlobalName(expr.func.expr) !== 'Enum';
    const dynamicInstanceMethod =
      ctx.compatMode === 'rbxts'
      && (expr.func.index === 'GetPivot' || expr.func.index === 'PivotTo');
    const needsReceiverCast =
      receiverIsIndexExpr
      || isSignalMethod
      || methodMissingOnKnownInstance
      || receiverEmitsLuauChild
      || dynamicInstanceMethod
      || receiverIsObservedShape
      || receiverIsUnknownChain;
    const compiledReceiverForMethod =
      ctx.compatMode === 'rbxts'
      && (
        (receiverFactForMethod?.kind === 'class' && receiverFactForMethod.nullable)
        || (expr.func.expr.type === 'Local' && ctx.tsOptionalClassLocal.has(expr.func.expr.name))
      )
        ? factory.createNonNullExpression(compileExpr(expr.func.expr, ctx))
        : compileExpr(expr.func.expr, ctx);
    // Signal-method receiver cast. Default: cast the immediate receiver
    // (Tween.Completed etc, which have the signal as a typed property).
    // When the chain root is a typed Instance whose oracle entry does
    // NOT have the next-level property (e.g. `hum.Died` where `hum` is
    // Instance | undefined and `Died` is a Humanoid signal), route the
    // cast to the chain root so the missing property is absorbed.
    const innerRecv = needsReceiverCast
      ? (signalChainNeedsRootCast(expr.func.expr, ctx)
          ? buildRecordCastReceiver(expr.func.expr, ctx)
          : factory.createParenthesizedExpression(
              factory.createAsExpression(
                  factory.createAsExpression(
                  compiledReceiverForMethod,
                  factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
                ),
                factory.createTypeReferenceNode('Record', [
                  factory.createKeywordTypeNode(ts.SyntaxKind.StringKeyword),
                  factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
                ]),
              ),
            ))
      : compiledReceiverForMethod;
    const emittedMethodName = ctx.compatMode === 'rbxts'
      ? (CFRAME_METHOD_RENAMES.get(expr.func.index) ?? expr.func.index)
      : expr.func.index;
    let calleeAccess: ts.Expression = factory.createPropertyAccessExpression(
      innerRecv,
      factory.createIdentifier(propertyName(emittedMethodName)),
    );
    if (needsReceiverCast) {
      // Cast the unknown-typed method slot through a callable so the
      // call site doesn't re-trip TS2571.
      calleeAccess = unknownCallableCastExpression(calleeAccess);
      methodCallReceiverWasRecordRouted = true;
    }
    call = factory.createCallExpression(calleeAccess, undefined, castArgsForCall(calleeAccess, args, ctx, expr.args));
  } else if (ctx.compatMode === 'rbxts' && expr.func.type === 'IndexExpr') {
    // rbxts: `obj[k](...)` — recast through a call signature so the
    // unknown-typed indexed slot is callable.
    const callable = factory.createParenthesizedExpression(
      factory.createAsExpression(
        factory.createAsExpression(
          compileExpr(expr.func, ctx),
          factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
        ),
        factory.createFunctionTypeNode(
          undefined,
          [factory.createParameterDeclaration(
            undefined,
            factory.createToken(ts.SyntaxKind.DotDotDotToken),
            'args',
            undefined,
            factory.createArrayTypeNode(factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword)),
          )],
          factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
        ),
      ),
    );
    call = factory.createCallExpression(callable, undefined, args);
  } else {
    // rbxts: `string.X(s, ...)` where `s` is statically string → method form
    // `s.X(...)` for the LuaTuple-returning methods (gsub/find/match). Other
    // string-lib calls stay in namespace form — both compile to identical
    // Luau under rbxtsc and the namespace form is closer to the source.
    const STRING_PREFER_METHOD = new Set(['gsub', 'find', 'match', 'gmatch']);
    if (
      ctx.compatMode === 'rbxts'
      && !expr.self
      && expr.func.type === 'IndexName'
      && expr.func.expr.type === 'Global'
      && (expr.func.expr as { name: string }).name === 'string'
      && STRING_PREFER_METHOD.has(expr.func.index)
      && expr.args.length > 0
      && staticTypeOfExpr(expr.args[0]!, ctx) === 'string'
    ) {
      const receiver = compileExpr(expr.args[0]!, ctx);
      const restArgs = args.slice(1);
      const calleeExpr = factory.createPropertyAccessExpression(
        receiver,
        factory.createIdentifier(expr.func.index),
      );
      call = factory.createCallExpression(calleeExpr, undefined, restArgs);
    } else {
      let calleeExpr = compileExpr(expr.func, ctx);
      const calleeRoot = expr.func.type === 'IndexName' ? rootGlobalName(expr.func.expr) : null;
      if (
        ctx.compatMode === 'rbxts'
        && expr.func.type === 'IndexName'
        && (
          exprEmitsLuauChild(expr.func.expr, ctx)
          || (
            expr.func.expr.type === 'Local'
            && !ctx.tsTypedClassLocal.has(expr.func.expr.name)
            && localObservedShapeHasMember(expr.func.expr, expr.func.index, ctx)
          )
        )
        && calleeRoot !== 'string'
        && calleeRoot !== 'math'
        && calleeRoot !== 'table'
        && calleeRoot !== 'task'
        && calleeRoot !== 'Enum'
      ) {
        calleeExpr = unknownCallableCastExpression(calleeExpr);
      }
      call = factory.createCallExpression(calleeExpr, undefined, castArgsForCall(calleeExpr, args, ctx, expr.args));
    }
  }
  // rbxts: cast loose-Instance method results (`Instance | undefined`
  // FindFirstChild/WaitForChild family) so chained `.X.Y` access works.
  // Phase 3b: oracle-resolved type when receiver class is known, else honest
  // `Instance` / `Instance | undefined` fallback. GetAttribute stays unknown.
  // `__chainIntermediate` calls usually skip the post-cast because the next
  // chain link accepts `Instance` naturally. But when the receiver was
  // Record-routed (gui-as-unknown etc.), the call result is `unknown` and
  // the next link can't read the method off it. Force the post-cast in
  // that case so the intermediate becomes a real `_LuauChild`.
  const chainIntermediate = !!(expr as unknown as { __chainIntermediate?: boolean }).__chainIntermediate;
  const skipChainIntermediateCast = chainIntermediate && !methodCallReceiverWasRecordRouted;
  if (
    ctx.compatMode === 'rbxts'
    && expr.self
    && expr.func.type === 'IndexName'
    && INSTANCE_LOOSE_METHODS.has(expr.func.index)
    && !skipChainIntermediateCast
  ) {
    const method = expr.func.index;
    if (method === 'GetAttribute') {
      call = factory.createAsExpression(call, factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword));
    } else {
      const resolved = resolveLooseMethodCastType(expr, ctx);
      if (resolved.kind === 'class') {
        const targetType = factory.createTypeReferenceNode(resolved.text, undefined);
        const sourceNeedsBridge =
          isLuauChildTypeText(resolved.text)
          || exprEmitsLuauChild(expr.func.expr, ctx)
          || (expr.func.expr.type !== 'Local' && expr.func.expr.type !== 'Global');
        call = factory.createAsExpression(
          sourceNeedsBridge
            ? factory.createAsExpression(
                call,
                factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
              )
            : call,
          targetType,
        );
      } else {
        call = factory.createAsExpression(call, factory.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword));
      }
    }
  }
  // rbxts: `require(ModuleScript)` is `unknown` per @rbxts/types — cast to
  // any so `Module.Foo()` works on the result.
  if (
    ctx.compatMode === 'rbxts'
    && expr.func.type === 'Global'
    && expr.func.name === 'require'
  ) {
    ctx.useLuauChildType();
    call = factory.createAsExpression(
      factory.createAsExpression(
        call,
        factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
      ),
      factory.createTypeReferenceNode('_LuauChild', undefined),
    );
  }
  if (
    ctx.compatMode === 'rbxts'
    && expr.self
    && expr.func.type === 'IndexName'
    && expr.func.index === 'GetPivot'
  ) {
    call = factory.createAsExpression(
      factory.createAsExpression(
        call,
        factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
      ),
      factory.createTypeReferenceNode('CFrame', undefined),
    );
  }
  // rbxts: namespace-form `string.X(...)` returning LuaTuple needs `[0]`
  // extract in single-value positions (gsub/find/match/byte).
  if (
    ctx.compatMode === 'rbxts'
    && !ctx.preferMultiReturn
    && !expr.self
    && expr.func.type === 'IndexName'
    && expr.func.expr.type === 'Global'
    && (expr.func.expr as { name: string }).name === 'string'
    && STRING_LIB_METHODS.has(expr.func.index)
    && STRING_LIB_METHODS.get(expr.func.index)!.tupleFirst
  ) {
    call = factory.createElementAccessExpression(call, 0);
  }
  // rbxts: bare `pcall`/`xpcall` return `LuaTuple<[boolean, …]>`; single-
  // value positions want just the success flag → extract `[0]`.
  if (
    ctx.compatMode === 'rbxts'
    && !ctx.preferMultiReturn
    && !expr.self
    && expr.func.type === 'Global'
    && ((expr.func as { name: string }).name === 'pcall'
        || (expr.func as { name: string }).name === 'xpcall')
  ) {
    call = factory.createElementAccessExpression(call, 0);
  }
  // rbxts: file-local LuaTuple-returning fns need `call![0]` in single-value
  // positions. Non-null assert (not `as any`) keeps mixed-return narrowing.
  if (
    ctx.compatMode === 'rbxts'
    && !ctx.preferMultiReturn
    && !expr.self
    && (expr.func.type === 'Global' || expr.func.type === 'Local')
    && ctx.luaTupleReturningFunctions.has((expr.func as { name: string }).name)
  ) {
    call = factory.createElementAccessExpression(
      factory.createNonNullExpression(call),
      0,
    );
  }
  if (isYieldingCall(expr, ctx)) {
    return factory.createAwaitExpression(call);
  }
  return call;
}

/** Roblox globals whose user-folder children @rbxts/types doesn't enumerate;
 *  receiver casts to `any` before child access (`game.MyFolder` etc). */
const RBX_DYNAMIC_ROOTS = new Set(['game', 'workspace', 'script', 'plugin']);

const COMMON_DYNAMIC_CHILD_NAMES = new Set([
  'leaderstats',
  'GamePasses',
  'Buttons',
  'Items',
  'BillboardGui',
  'TextLabel',
  'Dependency',
  'Tycoons',
  'Profiles',
]);

function isLikelyDynamicChildName(name: string, ctx: CompileContext): boolean {
  return COMMON_DYNAMIC_CHILD_NAMES.has(name)
    || /^[A-Z]/.test(name)
    || !!ctx.oracle.childNameClass(name);
}

function localHasPreservedShape(expr: Expr, ctx: CompileContext): boolean {
  return expr.type === 'Local' && ctx.tsShapeTypedLocal.has(expr.name);
}

function localObservedShapeHasMember(expr: Expr, member: string, ctx: CompileContext): boolean {
  if (expr.type !== 'Local') return false;
  const shape = ctx.getShape(expr.name) as
    | { props?: Map<string, unknown>; methods?: Map<string, unknown> }
    | undefined;
  return !!shape && (!!shape.props?.has(member) || !!shape.methods?.has(member));
}

function rootGlobalName(expr: Expr): string | null {
  let cur: Expr = expr;
  while (cur.type === 'IndexName' || cur.type === 'IndexExpr' || cur.type === 'Call') {
    if (cur.type === 'IndexName' || cur.type === 'IndexExpr') {
      cur = cur.expr;
    } else {
      cur = cur.func;
    }
  }
  return cur.type === 'Global' ? cur.name : null;
}

function shouldRouteDynamicChildRead(
  expr: Extract<Expr, { type: 'IndexName' }>,
  ctx: CompileContext,
): boolean {
  // Oracle-class-tracked locals: trust the class. Only route when oracle
  // confirms the class does NOT have the member — otherwise the access
  // typechecks against the declared class and the route is noise.
  if (expr.expr.type === 'Local' && ctx.tsTypedClassLocal.has(expr.expr.name)) {
    const cls = ctx.tsTypedClassLocal.get(expr.expr.name)!;
    if (ctx.oracle.isA(cls, 'Instance') && oracleHasMember(ctx, cls, expr.index)) {
      return false;
    }
  }
  const observedUntypedLocal =
    expr.expr.type === 'Local'
    && !ctx.tsTypedClassLocal.has(expr.expr.name)
    && !localHasPreservedShape(expr.expr, ctx)
    && localObservedShapeHasMember(expr.expr, expr.index, ctx);
  if (observedUntypedLocal) return true;
  if (!isLikelyDynamicChildName(expr.index, ctx)) return false;
  if (rootGlobalName(expr.expr) === 'Enum') return false;
  if (localHasPreservedShape(expr.expr, ctx)) return false;
  const receiverClass =
    flowClassOf(expr.expr, ctx)
    ?? (expr.expr.type === 'Local' ? ctx.tsTypedClassLocal.get(expr.expr.name) : undefined)
    ?? resolveOracleClassOfExpr(expr.expr, ctx);
  if (receiverClass) {
    return ctx.oracle.isA(receiverClass, 'Instance')
      && !oracleHasMember(ctx, receiverClass, expr.index);
  }
  const receiverStatic = staticTypeOfExpr(expr.expr, ctx);
  if (
    receiverStatic === 'number'
    || receiverStatic === 'string'
    || receiverStatic === 'boolean'
    || receiverStatic === 'nil'
    || (typeof receiverStatic === 'string' && receiverStatic.startsWith('datatype:'))
  ) {
    return false;
  }
  return expr.expr.type === 'Call'
    || exprEmitsLuauChild(expr.expr, ctx);
}

function exprMayCompileAsLuauChild(expr: Expr, ctx: CompileContext): boolean {
  switch (expr.type) {
    case 'Global':
      return RBX_DYNAMIC_ROOTS.has(expr.name);
    case 'Local':
      return false;
    case 'IndexName': {
      if (expr.expr.type === 'Global') {
        const root = expr.expr.name;
        if (RBX_DYNAMIC_ROOTS.has(root)) return true;
        if ((ctx.isRbxService(root) || ctx.oracle.isService(root)) && !ctx.oracle.propertyType(root, expr.index)) return true;
      }
      return exprMayCompileAsLuauChild(expr.expr, ctx);
    }
    case 'IndexExpr':
      return exprMayCompileAsLuauChild(expr.expr, ctx);
    case 'Call':
      return exprMayCompileAsLuauChild(expr.func, ctx);
    case 'Group':
    case 'TypeAssertion':
      return exprMayCompileAsLuauChild(expr.expr, ctx);
    default:
      return false;
  }
}

function exprEmitsLuauChild(expr: Expr, ctx: CompileContext): boolean {
  if (exprMayCompileAsLuauChild(expr, ctx)) return true;
  switch (expr.type) {
    case 'Local':
      return ctx.tsLuauChildLocal.has(expr.name);
    case 'Group':
    case 'TypeAssertion':
      return exprEmitsLuauChild(expr.expr, ctx);
    case 'IndexName':
      if (expr.index === 'Parent') return true;
      return exprEmitsLuauChild(expr.expr, ctx);
    case 'Call':
      if (expr.func.type === 'Global' && expr.func.name === 'require') return true;
      if (
        expr.self
        && expr.func.type === 'IndexName'
        && INSTANCE_LOOSE_METHODS.has(expr.func.index)
        && !(expr as unknown as { __chainIntermediate?: boolean }).__chainIntermediate
      ) {
        const resolved = resolveLooseMethodCastType(expr, ctx);
        return resolved.kind === 'class' && isLuauChildTypeText(resolved.text);
      }
      return false;
    case 'Binary':
      if (expr.op === 'and' || expr.op === 'or') {
        return exprEmitsLuauChild(expr.left, ctx) || exprEmitsLuauChild(expr.right, ctx);
      }
      return false;
    default:
      return false;
  }
}

/** RBXScriptSignal / RBXScriptConnection methods. Detected on chained
 *  receivers so we can cast through Record when the declared signal type
 *  is too narrow or unknown. */
/** True if the receiver expression is a property chain whose intermediate
 *  property doesn't exist on the chain root's oracle-known class. Used by
 *  the signal-method emission to decide whether to cast at the root or
 *  the immediate receiver. */
function signalChainNeedsRootCast(expr: Expr, ctx: CompileContext): boolean {
  if (expr.type !== 'IndexName') return false;
  // Find the deepest receiver in a dot-chain.
  const chain: string[] = [];
  let cur: Expr = expr;
  while (cur.type === 'IndexName' && cur.op === '.') {
    chain.unshift(cur.index);
    cur = cur.expr;
  }
  if (chain.length === 0) return false;
  // The deepest receiver must resolve to a known oracle class.
  let rootClass: string | undefined;
  if (cur.type === 'Global' && ctx.oracle.isService(cur.name)) {
    rootClass = cur.name;
  } else if (cur.type === 'Local') {
    if (ctx.tsTypedClassLocal.has(cur.name)) {
      // We know the class is concrete but don't carry the name. Fall
      // back to checking Instance — the most common typed local.
      rootClass = 'Instance';
    }
  }
  if (!rootClass) return false;
  // Walk the chain: at each level, the property must exist on the
  // running class for the OLD intermediate-cast pattern to work. If
  // any level's property is unknown to the oracle, force root cast.
  let runningClass: string | undefined = rootClass;
  for (let i = 0; i < chain.length; i += 1) {
    if (!runningClass) return true;
    const prop = ctx.oracle.propertyType(runningClass, chain[i]!);
    if (!prop) return true;
    runningClass = prop.kind === 'class' ? prop.name : undefined;
  }
  return false;
}

/** Build a Record-cast property chain that re-casts at every level so
 *  intermediate `.X` access on the resulting `unknown` doesn't trip
 *  TS2571. Used when the chain root's oracle class doesn't have the
 *  intermediate property (`inst.Died` where `inst` is Instance and
 *  `Died` is a Humanoid signal). */
function buildRecordCastReceiver(expr: Expr, ctx: CompileContext): ts.Expression {
  const wrapAsRecord = (e: ts.Expression): ts.Expression =>
    factory.createParenthesizedExpression(
      factory.createAsExpression(
        factory.createAsExpression(
          e,
          factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
        ),
        factory.createTypeReferenceNode('Record', [
          factory.createKeywordTypeNode(ts.SyntaxKind.StringKeyword),
          factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
        ]),
      ),
    );
  if (expr.type === 'IndexName') {
    const chain: string[] = [];
    let cur: Expr = expr;
    while (cur.type === 'IndexName' && cur.op === '.') {
      chain.unshift(cur.index);
      cur = cur.expr;
    }
    let acc: ts.Expression = wrapAsRecord(compileExpr(cur, ctx));
    for (let i = 0; i < chain.length; i += 1) {
      acc = factory.createPropertyAccessExpression(acc, factory.createIdentifier(propertyName(chain[i]!)));
      // Re-cast at every level so the next `.X` doesn't surface
      // TS2571 on unknown — including the FINAL level since the
      // caller appends `.Connect` etc.
      acc = wrapAsRecord(acc);
    }
    return acc;
  }
  return wrapAsRecord(compileExpr(expr, ctx));
}

const SIGNAL_METHODS = new Set([
  'Connect', 'ConnectParallel', 'Once', 'Fire', 'Wait',
  'Disconnect',
]);

const CFRAME_METHOD_RENAMES = new Map<string, string>([
  ['toObjectSpace', 'ToObjectSpace'],
  ['toWorldSpace', 'ToWorldSpace'],
]);

function staticReceiverClass(expr: Expr, ctx: CompileContext): string | undefined {
  const flowed = flowClassOf(expr, ctx);
  if (flowed) return flowed;
  // Cheap class inference for `:WaitForChild` / `:FindFirstChild` receivers
  // (the cast site). The flow pass owns deeper inference; this is the
  // fallback used before flow-fact lookup at emit time.
  if (expr.type === 'Global') {
    if (ctx.oracle.isService(expr.name)) return expr.name;
  }
  return undefined;
}

type LooseMethodResolution =
  | { kind: 'class'; text: string }
  | { kind: 'any' };

function resolveLooseMethodCastType(
  callExpr: Extract<Expr, { type: 'Call' }>,
  ctx: CompileContext,
): LooseMethodResolution {
  if (callExpr.func.type !== 'IndexName') return { kind: 'any' };
  const method = callExpr.func.index;
  const receiverClass = staticReceiverClass(callExpr.func.expr, ctx);

  const literalArg = callExpr.args[0]?.type === 'ConstantString'
    ? (callExpr.args[0] as { value: string }).value
    : undefined;
  switch (method) {
    case 'WaitForChild': {
      // Literal arg in name-table → concrete class. Otherwise stay loose so
      // chained method calls on unknown-name children don't surface TS2339.
      const r = ctx.oracle.waitForChildResult(receiverClass, literalArg, callExpr.args.length === 1 ? 1 : 2);
      if (r.type === 'Instance' && (!literalArg || !ctx.oracle.childNameClass(literalArg))) {
        ctx.useLuauChildType();
        return { kind: 'class', text: '_LuauChild' };
      }
      return { kind: 'class', text: r.nullable ? `${r.type} | undefined` : r.type };
    }
    case 'FindFirstChild': {
      const r = ctx.oracle.findFirstChildResult(receiverClass, literalArg);
      if (r.type === 'Instance' && (!literalArg || !ctx.oracle.childNameClass(literalArg))) {
        ctx.useLuauChildType();
        return { kind: 'class', text: '_LuauChild | undefined' };
      }
      return { kind: 'class', text: `${r.type} | undefined` };
    }
    case 'FindFirstChildOfClass':
    case 'FindFirstAncestorOfClass':
    case 'FindFirstChildWhichIsA':
    case 'FindFirstAncestorWhichIsA': {
      if (literalArg && ctx.oracle.isClass(literalArg)) {
        return { kind: 'class', text: `${literalArg} | undefined` };
      }
      ctx.useLuauChildType();
      return { kind: 'class', text: '_LuauChild | undefined' };
    }
    case 'FindFirstAncestor':
    case 'FindFirstDescendant':
      ctx.useLuauChildType();
      return { kind: 'class', text: '_LuauChild | undefined' };
    case 'GetPlayerFromCharacter':
    case 'GetPlayerByUserId':
      return { kind: 'class', text: 'Player' };
    default:
      return { kind: 'any' };
  }
}

const INSTANCE_LOOSE_METHODS = new Set([
  'FindFirstChild',
  'FindFirstChildOfClass',
  'FindFirstChildWhichIsA',
  'FindFirstAncestor',
  'FindFirstAncestorOfClass',
  'FindFirstAncestorWhichIsA',
  'FindFirstDescendant',
  'WaitForChild',
  'GetAttribute',
  // Players service methods that return `Player | undefined` per
  // @rbxts/types. Real scripts that call these inside a Touched/
  // CharacterAdded handler trust that the value isn't nil (they're
  // running because the right entity touched their part); the
  // `as any` cast absorbs the optional so subsequent `.UserId`
  // / `.Name` access typechecks.
  'GetPlayerFromCharacter',
  'GetPlayerByUserId',
]);

function compileTableExpr(
  expr: Extract<Expr, { type: 'Table' }>,
  ctx: CompileContext,
): ts.Expression {
  const allList = expr.items.every((i) => i.kind === 'List');
  const allRecord = expr.items.every((i) => i.kind === 'Record');

  // Empty `{}` is ambiguous (array seed vs. object seed). Emit `{} as any`
  // so both numeric-index and property growth typecheck.
  if (expr.items.length === 0) {
    return factory.createAsExpression(
      factory.createObjectLiteralExpression([], false),
      ctx.compatMode === 'rbxts'
        ? factory.createTypeReferenceNode('Record', [
            factory.createKeywordTypeNode(ts.SyntaxKind.StringKeyword),
            factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
          ])
        : factory.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword),
    );
  }
  if (allList) {
    return factory.createArrayLiteralExpression(
      expr.items.map((i) => compileExprAsArg(i.value, ctx)),
      false,
    );
  }
  // Explicit `{[1] = a, [2] = b, [3] = c}` (TableItemKind: 'General') that
  // is dense and 1-indexed is semantically an array in Lua; emit as JS
  // array so `t[idx - 1]` (our compiler's Lua→JS index conversion) lines
  // up with `arr[0]` for `t[1]`. Without this, the table is an object
  // with string-numeric keys "1"/"2"/... and `t["0"]` returns undefined —
  // which is what blew up Meepcity's FISH_DICTIONARY[FishIndex] lookup
  // for FishIndex=1.
  const allGeneralNumeric = expr.items.length > 0 && expr.items.every((i, idx) => {
    if (i.kind !== 'General' || !i.key) return false;
    const t = (i.key as { type?: string }).type;
    if (t !== 'ConstantNumber' && t !== 'ConstantInteger') return false;
    return (i.key as { value?: number }).value === idx + 1;
  });
  if (allGeneralNumeric) {
    return factory.createArrayLiteralExpression(
      expr.items.map((i) => compileExprAsArg(i.value, ctx)),
      true,
    );
  }
  if (allRecord) {
    return factory.createObjectLiteralExpression(
      expr.items.map((i) => compileTableProp(i, ctx)),
      true,
    );
  }
  // Mixed: emit object literal with numeric keys for List items (1-indexed).
  return factory.createObjectLiteralExpression(
    expr.items.map((i, idx) => {
      if (i.kind === 'List') {
        return factory.createPropertyAssignment(
          factory.createNumericLiteral(idx + 1),
          compileExpr(i.value, ctx),
        );
      }
      return compileTableProp(i, ctx);
    }),
    true,
  );
}

function compileTableProp(item: TableItem, ctx: CompileContext): ts.PropertyAssignment {
  // Function-valued record entries (`{ disconnect = function(_) ... end }`)
  // are conventionally methods — the field is a slot in an instance type
  // like `{ disconnect: (self: Connection) -> () }`. Compile the inner
  // FunctionExpr in method context so the first arg (commonly named
  // `self` or `_` for "ignore me") folds into `this`, matching the
  // emitted impl-type that uses `this:` for `self:` parameters.
  let value =
    item.value.type === 'Function'
      ? compileFunctionExpr(item.value, ctx, { allowImplicitSelf: true })
      : compileExpr(item.value, ctx);
  // rbxts mode: `{ X = nil }` emits `X: undefined`. TS narrows the
  // inferred property type to literal `undefined`, which then breaks
  // every later `obj.X = realValue` write (TS2322: T not assignable
  // to undefined). Widen explicit-nil slots to `unknown` (not `any`)
  // so the metatable-builder idiom (`local self = setmetatable({
  // _field = nil}, …); self._field = …`) keeps working without
  // tripping roblox-ts's no-any rule.
  if (ctx.compatMode === 'rbxts' && item.value.type === 'ConstantNil') {
    value = factory.createAsExpression(
      value,
      factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
    );
  }
  if (item.key === null) {
    return factory.createPropertyAssignment(factory.createIdentifier('_'), value);
  }
  if (item.kind === 'Record' && item.key.type === 'ConstantString') {
    return factory.createPropertyAssignment(propNameFromString(item.key.value), value);
  }
  // Computed key: `{[expr] = value}` → `{[expr]: value}`. TS requires
  // computed keys to be `string | number | symbol | any`. In rbxts mode
  // the key may be an `unknown`-typed local (shape-inferred parameter,
  // index access result) so cast through `unknown as string | number`
  // to satisfy the constraint without leaking `any`.
  let keyExpr = compileExpr(item.key, ctx);
  if (ctx.compatMode === 'rbxts') {
    keyExpr = factory.createAsExpression(
      factory.createAsExpression(
        keyExpr,
        factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
      ),
      factory.createUnionTypeNode([
        factory.createKeywordTypeNode(ts.SyntaxKind.StringKeyword),
        factory.createKeywordTypeNode(ts.SyntaxKind.NumberKeyword),
      ]),
    );
  }
  return factory.createPropertyAssignment(
    factory.createComputedPropertyName(keyExpr),
    value,
  );
}

function propNameFromString(s: string): ts.PropertyName {
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(s)) return factory.createIdentifier(s);
  return factory.createStringLiteral(s);
}

function compileIfElseExpr(
  expr: Extract<Expr, { type: 'IfElse' }>,
  ctx: CompileContext,
): ts.Expression {
  return factory.createConditionalExpression(
    truthify(
      compileExpr(expr.condition, ctx),
      ctx,
      staticTypeOfExpr(expr.condition, ctx),
    ),
    factory.createToken(ts.SyntaxKind.QuestionToken),
    compileExpr(expr.trueExpr, ctx),
    factory.createToken(ts.SyntaxKind.ColonToken),
    compileExpr(expr.falseExpr, ctx),
  );
}

function compileInterpString(
  expr: Extract<Expr, { type: 'InterpString' }>,
  ctx: CompileContext,
): ts.Expression {
  const head = factory.createTemplateHead(expr.strings[0] ?? '');
  const spans: ts.TemplateSpan[] = [];
  for (let i = 0; i < expr.expressions.length; i += 1) {
    const literal = expr.strings[i + 1] ?? '';
    const isLast = i === expr.expressions.length - 1;
    spans.push(
      factory.createTemplateSpan(
        compileExpr(expr.expressions[i]!, ctx),
        isLast ? factory.createTemplateTail(literal) : factory.createTemplateMiddle(literal),
      ),
    );
  }
  return factory.createTemplateExpression(head, spans);
}

// ═══════════════════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════════════════

import pkgJson from '../../package.json' with { type: 'json' };
const COMPILER_VERSION = (pkgJson as { version: string }).version;
const COMPILER_NAME = (pkgJson as { name: string }).name;
// One-line header. The "DO NOT EDIT" warning was redundant — every dev
// looking at the file already knows what `// Compiled by …` means.
const COMPILER_HEADER = `// Compiled by ${COMPILER_NAME} v${COMPILER_VERSION} (do not edit).\n`;

export interface CompileOptions {
  /** Path of the source file. Used in the source map's `sources` field. */
  sourceFile?: string;
  /** Generate a source map mapping each TS statement back to its .luau line. */
  sourceMap?: boolean;
  /** Inline the source map as a base64 data URL appended to the output. */
  inlineSourceMap?: boolean;
  /** Preserve `--` line comments and `--[[ ]]` block comments from the source. */
  preserveComments?: boolean;
  /** Emit-shape compatibility mode.
   *
   *  - `'native'` (default): emit TS that imports stdlib helpers from
   *    `luau2ts/runtime` and pairs with any Roblox runtime that mirrors
   *    Roblox's Luau API surface: `Vector3.new(...)`, `game:GetService(...)`, etc.
   *  - `'rbxts'`: emit TS that mirrors what roblox-ts accepts as input:
   *    `new Vector3(...)`, `import { Workspace } from "@rbxts/services"`,
   *    `new ClassName()` for `Instance.new("ClassName")`, etc.
   */
  compatMode?: CompatMode;
  /** Run Prettier on the emitted TypeScript. Defaults to `true`. Disable
   *  if you want raw TypeScript-printer output (faster, but the output is
   *  4-space indented without canonical spacing around blocks). */
  pretty?: boolean;
  /** Run TypeScript's compiler API on the emitted .ts source (Layer A
   *  post-emit type check). Diagnostics land in `CompileResult.errors`
   *  with `[ts:CODE]` prefix. Uses the bundled `typescript` package,
   *  no extra install. Defaults to `true`; set to `false` to skip
   *  (useful for batch compilation where ~500ms-per-file matters). */
  postEmitCheck?: boolean;
  /** Run Luau.Analysis on the input source via @luau2ts/analyzer
   *  (Layer B pre-emit type check). Diagnostics land in
   *  `CompileResult.errors` with `[luau:CODE]` prefix. Defaults to
   *  `true` when `@luau2ts/analyzer` is available on the resolution
   *  path; otherwise no-ops silently. Set to `false` to skip. */
  preEmitCheck?: boolean;
  /** Explicitly enable both layers, even if `postEmitCheck` /
   *  `preEmitCheck` were set to false individually. */
  typeCheck?: boolean;
}

export interface CompileResult {
  /** Full TypeScript source of the compiled output. */
  source: string;
  /** Helper names the output imports from luau2ts/runtime. */
  helpers: string[];
  /** Parser errors plus Layer-A and Layer-B *error*-severity diagnostics.
   *  Lint-style warnings live in `warnings` so callers that key on
   *  `errors.length === 0` don't conflate "unused local" with a real
   *  type bug. */
  errors: ParseResult['errors'];
  /** Layer-B warnings (LocalUnused, LocalShadow, ImportUnused, etc.).
   *  Same shape as errors; useful for users who want to surface them
   *  but not gate on them. */
  warnings: ParseResult['errors'];
  /** Source map JSON when sourceMap was requested. */
  sourceMap?: SourceMap;
}

export async function compile(
  source: string,
  options: CompileOptions = {},
): Promise<CompileResult> {
  const sourceFileName = options.sourceFile ?? 'input.luau';
  const parsed = await parse(source);
  const ctx = new CompileContext(options.compatMode ?? 'native');
  ctx.staticTypeOf = (expr) => staticTypeOfExpr(expr as Expr, ctx);
  // rbxts mode: split inline `:WaitForChild():WaitForChild()` instance-nav
  // chains into named locals so each link's oracle-resolved class flows
  // cleanly (instead of getting absorbed by a single `as X` at the end).
  if (ctx.compatMode === 'rbxts') {
    splitInstanceChains(parsed);
    hoistInnerLuaTupleCalls(parsed);
  }
  if (ctx.compatMode === 'rbxts' && parsed.root) {
    ctx.constLocals = inferConstLocals(parsed.root) as WeakSet<object>;
    const ltm: LocalTypeMap = inferLocalTypes(parsed.root);
    ctx.localTypeMap = {
      perStat: ltm.perStat as unknown as WeakMap<object, 'number' | 'string' | 'boolean'>,
      byName: ltm.byName,
    };
  }
  // Layer-B lint warnings (LocalUnused, LocalShadow, etc.) collected
  // separately so callers gating on `errors.length === 0` can ignore
  // them. Same shape as the errors array.
  const warnings: ParseResult['errors'] = [];
  // Route the top-level body through compileBlockBody so the class-shape
  // detector (R.9) sees it. Synthesize a Block-shaped wrapper since the
  // root body is a flat statement array.
  const rootBlock: BlockStat | null = parsed.root
    ? {
        type: 'Block',
        body: parsed.root.body,
        hasEnd: true,
        loc: { start: { line: 0, col: 0 }, end: { line: 0, col: 0 } },
      } as BlockStat
    : null;
  if (ctx.compatMode === 'rbxts' && rootBlock) {
    const flow = runFlowPass(rootBlock, ctx);
    ctx.flowFactByExpr = flow.facts;
    ctx.flowFinalLocalFacts = flow.localFinalFacts;
    scanUserFunctionReturnClasses(rootBlock, ctx);
    // Backprop: locals whose downstream usage only consists of Instance
    // members get marked `tsTypedClassLocal = Instance` so receiver gates
    // skip the Record routing and the init is widened via `as unknown as
    // Instance` so the TS type matches the inferred class.
    inferInstanceLocals(rootBlock, ctx);
  }
  if (rootBlock) {
    // Pre-pass: infer which user-defined functions yield. Codegen below
    // uses this set so call sites get `await` even when the helper is a
    // local function rather than a built-in (`waitForChild`, custom event
    // wrappers, anything that internally calls `task.wait`, etc.).
    scanYieldingFunctions(rootBlock, ctx);
  }
  // Pre-scan the AST for `type Foo<T...>` declarations so compileType
  // can rewrite multi-arg references `Foo<a, b, c>` to `Foo<[a, b, c]>`
  // when Foo's generic list includes a type-pack. Without this the args
  // get spread positionally and tsc surfaces "requires between 0 and 1
  // type arguments". Module-scoped state so all compileType call sites
  // see the same arity map for the duration of this compile.
  const aliasArities = new Map<string, { generics: number; hasPack: boolean }>();
  if (parsed.root) {
    const walkAliases = (node: unknown): void => {
      if (!node || typeof node !== 'object') return;
      const n = node as { type?: string; name?: string; generics?: unknown[]; genericPacks?: unknown[] };
      if (n.type === 'TypeAlias' && typeof n.name === 'string') {
        aliasArities.set(n.name, {
          generics: n.generics?.length ?? 0,
          hasPack: (n.genericPacks?.length ?? 0) > 0,
        });
      }
      for (const v of Object.values(node as Record<string, unknown>)) {
        if (Array.isArray(v)) for (const it of v) walkAliases(it);
        else if (v && typeof v === 'object') walkAliases(v);
      }
    };
    walkAliases(parsed.root);
  }
  setAliasArities(aliasArities);
  setTypeCompatMode(ctx.compatMode);

  // rbxts mode pre-scan: walk every top-level function declaration and
  // remember those whose body emits multi-return (any return path with
  // 2+ values, even if other paths return one or zero). compileCall
  // uses this set so calls in single-LHS positions extract `[0]` —
  // matching Luau's "first value only" capture semantics. Destructure
  // sites set preferMultiReturn=true beforehand so the tuple stays
  // intact for that case.
  if (ctx.compatMode === 'rbxts' && parsed.root) {
    const hasAnyMultiReturn = (body: Stat | null | undefined): boolean => {
      if (!body) return false;
      let found = false;
      const walk = (s: Stat | null | undefined): void => {
        if (found || !s) return;
        if (s.type === 'Function' || s.type === 'LocalFunction') return;
        if (s.type === 'Return' && s.values.length > 1) { found = true; return; }
        if (s.type === 'Block') { for (const c of s.body) walk(c); return; }
        if (s.type === 'If') { walk(s.thenBody); walk(s.elseBody); return; }
        if (s.type === 'While' || s.type === 'Repeat') { walk(s.body); return; }
        if (s.type === 'For' || s.type === 'ForIn') { walk(s.body); return; }
      };
      walk(body);
      return found;
    };
    const recordMultiReturnFns = (node: unknown): void => {
      if (!node || typeof node !== 'object') return;
      const n = node as {
        type?: string;
        name?: { type?: string; name?: string };
        func?: { body?: Stat };
        body?: Stat;
      };
      if (
        (n.type === 'LocalFunction' || n.type === 'Function')
        && typeof n.name?.name === 'string'
        && n.func?.body
      ) {
        if (hasAnyMultiReturn(n.func.body)) {
          ctx.luaTupleReturningFunctions.add(n.name.name);
        }
      }
      for (const v of Object.values(node as Record<string, unknown>)) {
        if (Array.isArray(v)) for (const it of v) recordMultiReturnFns(it);
        else if (v && typeof v === 'object') recordMultiReturnFns(v);
      }
    };
    recordMultiReturnFns(parsed.root);
  }

  // Phase 2 (rbxts-only): pre-scan the top-level script body for
  // every local's access pattern so compileLocal can emit
  // structural-type annotations. Top-level scripts often have
  // long-lived locals (`let cashBar = buildBar(...)`) whose body
  // accesses (`cashBar.Bar.Fill`) form the same kind of inference
  // surface as function-level locals.
  let rootShapes: Map<string, import('./shape-infer.js').Shape> | null = null;
  if (ctx.compatMode === 'rbxts' && rootBlock) {
    const rootNames = collectLocalNames(rootBlock);
    rootShapes = collectShapes(rootBlock, rootNames);
    ctx.pushShapeScope(rootShapes as Map<string, unknown>);
  }
  const stmts: ts.Statement[] = rootBlock ? compileBlockBody(rootBlock, ctx) : [];
  if (rootShapes) ctx.popShapeScope();
  // ModuleScript trailing `return X` → `export default X`. Conservative:
  // multi-statement scripts only (single-line `return X` test snippets stay).
  if (stmts.length > 1) {
    const last = stmts[stmts.length - 1]!;
    if (ts.isReturnStatement(last) && last.expression) {
      stmts[stmts.length - 1] = factory.createExportAssignment(
        undefined,
        false,
        last.expression,
      );
      // roblox-ts rejects `export = let`. Flip the matching top-level `let`
      // to `const` when the export expression is an identifier match.
      if (ctx.compatMode === 'rbxts' && ts.isIdentifier(last.expression)) {
        const exportName = last.expression.text;
        for (let i = 0; i < stmts.length; i++) {
          const s = stmts[i];
          if (
            s
            && ts.isVariableStatement(s)
            && (s.declarationList.flags & ts.NodeFlags.Let) !== 0
            && s.declarationList.declarations.some((d) =>
              ts.isIdentifier(d.name) && d.name.text === exportName,
            )
          ) {
            stmts[i] = factory.createVariableStatement(
              s.modifiers,
              factory.createVariableDeclarationList(
                s.declarationList.declarations,
                ts.NodeFlags.Const,
              ),
            );
            break;
          }
        }
      }
    }
  }
  // Luau scripts may early-exit via `if cond then return end`. TS
  // forbids `return` at module scope (TS1108), so wrap every
  // statement after the last function declaration in an async IIFE
  // when ANY non-final return is present. This preserves both Luau's
  // early-exit semantics and the ability to `await` yielding calls
  // in the body.
  if (ctx.compatMode === 'rbxts') {
    const hasNonFinalReturn = (block: ts.Statement[]): boolean => {
      for (let i = 0; i < block.length; i++) {
        const s = block[i]!;
        // Skip the final statement — that's handled by the export-default
        // rewrite above.
        if (i === block.length - 1 && ts.isReturnStatement(s) && s.expression) continue;
        if (containsTopLevelReturn(s)) return true;
      }
      return false;
    };
    if (hasNonFinalReturn(stmts)) {
      // Hoist only the module-level structural declarations (imports,
      // type aliases, exports) — these can't legally appear inside an
      // arrow body. Everything else (functions, classes, vars) gets
      // wrapped in the IIFE so their references to in-scope locals
      // stay resolvable AND `return` is legal again.
      const hoisted: ts.Statement[] = [];
      const inIIFE: ts.Statement[] = [];
      for (const s of stmts) {
        if (
          ts.isImportDeclaration(s)
          || ts.isTypeAliasDeclaration(s)
          || ts.isInterfaceDeclaration(s)
          || ts.isExportAssignment(s)
          || ts.isExportDeclaration(s)
        ) {
          hoisted.push(s);
        } else {
          inIIFE.push(s);
        }
      }
      if (inIIFE.length > 0) {
        const iife = factory.createExpressionStatement(
          factory.createCallExpression(
            factory.createParenthesizedExpression(
              factory.createArrowFunction(
                ASYNC_MOD,
                undefined,
                [],
                undefined,
                factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
                factory.createBlock(inIIFE, true),
              ),
            ),
            undefined,
            [],
          ),
        );
        stmts.length = 0;
        stmts.push(...hoisted, iife);
      }
    }
  }
  const helpers = ctx.importedHelpers();
  // Codegen registers runtime-available names (`setmetatable`, `pcall`, …)
  // via `ctx.use(name)` from compileExpr's Global path, and ambient names
  // via `ctx.useAmbient(name)`. We pick the ambient set up here so we can
  // emit a `declare const X: any;` block before the user statements. This
  // runs AFTER codegen, not before, so statements consumed by the
  // class-shape rewriter (which never go through compileExpr) don't count.
  const ambientGlobalsUsed = ctx.ambientGlobals();

  // Track each top-level Luau stmt → output TS stmt for source maps.
  const stmtToLuauLoc = new WeakMap<ts.Statement, { line: number; col: number }>();
  if (parsed.root) {
    let outIndex = helpers.length > 0 ? 1 : 0;
    for (const luauStmt of parsed.root.body) {
      const out = stmts[outIndex];
      if (out && luauStmt.loc) {
        stmtToLuauLoc.set(out, {
          line: luauStmt.loc.start.line,
          col: luauStmt.loc.start.col,
        });
      }
      outIndex++;
    }
  }

  // Lua creates a global on first assignment: `deb = true` works even if
  // `deb` was never declared. JS strict mode throws. We can't tell if the
  // user *intended* a global vs. forgot a `local`, but we can pre-declare
  // every Global name that gets written to so the script keeps running.
  // Names already supplied by the host (game, workspace, math, table,
  // print, …) are excluded — those come from the script wrapper.
  const implicitGlobals = collectImplicitGlobals(parsed);
  const implicitGlobalDecls: ts.Statement[] = [];
  // The predecl form is `let foo = _G["foo"];`, which references `_G`
  // directly without going through compileExpr — so the ambient-globals
  // walker never sees `_G` and tsc surfaces "Cannot find name". Mark it
  // ambient up-front whenever we emit any predecl.
  // rbxts: unknown globals that match a known Roblox service get a typed
  // `const X = game.GetService("X")` predecl instead of the `_G[...]` form.
  // Downstream uses of the name then route through the @rbxts/types Players
  // (etc.) interface, which the oracle/flow pass can resolve.
  const serviceImplicitGlobals = new Set<string>();
  if (ctx.compatMode === 'rbxts') {
    for (const name of implicitGlobals) {
      if (ctx.oracle.isService(name)) serviceImplicitGlobals.add(name);
    }
  }
  for (const name of serviceImplicitGlobals) {
    implicitGlobals.delete(name);
    implicitGlobalDecls.push(
      factory.createVariableStatement(
        undefined,
        factory.createVariableDeclarationList(
          [factory.createVariableDeclaration(
            factory.createIdentifier(safeIdentifier(name)),
            undefined,
            undefined,
            factory.createCallExpression(
              factory.createPropertyAccessExpression(
                factory.createIdentifier('game'),
                factory.createIdentifier('GetService'),
              ),
              undefined,
              [factory.createStringLiteral(name)],
            ),
          )],
          ts.NodeFlags.Const,
        ),
      ),
    );
  }
  if (implicitGlobals.size > 0) ctx.useAmbient('_G');
  for (const name of implicitGlobals) {
    // Init predecl from `_G[name]` so cross-script globals are visible at
    // script start. rbxts: `_G` is an empty interface in @rbxts/types, so
    // route through Record<string, unknown> for the bracket access. The
    // declared type stays `unknown` so later writes of any type still match.
    const gRead: ts.Expression = ctx.compatMode === 'rbxts'
      ? factory.createElementAccessExpression(
          recordCastExpression(factory.createIdentifier('_G')),
          factory.createStringLiteral(name),
        )
      : factory.createElementAccessExpression(
          factory.createIdentifier('_G'),
          factory.createStringLiteral(name),
        );
    implicitGlobalDecls.push(
      factory.createVariableStatement(
        undefined,
        factory.createVariableDeclarationList(
          [factory.createVariableDeclaration(
            factory.createIdentifier(safeIdentifier(name)),
            undefined,
            ctx.compatMode === 'rbxts'
              ? factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword)
              : undefined,
            gRead,
          )],
          ts.NodeFlags.Let,
        ),
      ),
    );
  }

  const allStatements: ts.Statement[] = [];
  if (helpers.length > 0) allStatements.push(buildRuntimeImport(helpers));
  // Macro-registered extras — `@rbxts/services`, `@rbxts/types`, `@rbxts/promise`,
  // `@rbxts/roact`, etc. Each macro that fired called `ctx.useImport(module, name)`;
  // the bookkeeping is reified into one import declaration per module.
  for (const { module, names } of ctx.extraImportEntries()) {
    // rbxts: @rbxts/types is ambient-only (importing trips TS2306); macros
    // still call useImport for intent tracking but we skip the emit.
    if (ctx.compatMode === 'rbxts' && module === '@rbxts/types') continue;
    allStatements.push(buildNamedImport(module, names));
  }
  // `declare const X: any;` for ambient globals (native mode). Skipped in
  // rbxts since @rbxts/types provides typed globals — `: any` would shadow
  // them and break roblox-ts's for-of iteration analysis.
  if (ctx.compatMode !== 'rbxts' && ambientGlobalsUsed.size > 0) {
    for (const name of [...ambientGlobalsUsed].sort()) {
      allStatements.push(
        factory.createVariableStatement(
          [factory.createToken(ts.SyntaxKind.DeclareKeyword)],
          factory.createVariableDeclarationList(
            [factory.createVariableDeclaration(
              factory.createIdentifier(safeIdentifier(name)),
              undefined,
              factory.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword),
              undefined,
            )],
            ts.NodeFlags.Const,
          ),
        ),
      );
    }
  }
  // rbxts: inject `_LuauChild` (recursive callable+indexable interface)
  // when any service.X dynamic-child access used the cast.
  if (ctx.compatMode === 'rbxts' && ctx.luauChildTypeUsed) {
    allStatements.push(
      factory.createInterfaceDeclaration(
        undefined,
        factory.createIdentifier('_LuauChild'),
        undefined,
        undefined,
        [
          factory.createIndexSignature(
            undefined,
            [factory.createParameterDeclaration(
              undefined,
              undefined,
              factory.createIdentifier('k'),
              undefined,
              factory.createKeywordTypeNode(ts.SyntaxKind.StringKeyword),
            )],
            factory.createTypeReferenceNode('_LuauChild', undefined),
          ),
          factory.createCallSignature(
            undefined,
            [factory.createParameterDeclaration(
              undefined,
              factory.createToken(ts.SyntaxKind.DotDotDotToken),
              factory.createIdentifier('args'),
              undefined,
              factory.createArrayTypeNode(factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword)),
            )],
            factory.createTypeReferenceNode('_LuauChild', undefined),
          ),
        ],
      ),
    );
  }
  allStatements.push(...implicitGlobalDecls);
  allStatements.push(...stmts);

  // Force module shape so top-level `await` is legal. Append `export {};`
  // only when the file actually requires module semantics — top-level
  // await, top-level return, or no other import/export already present
  // alongside top-level await. Otherwise leave it out so the emit is
  // closer to plain script form.
  const alreadyModule = allStatements.some((s) =>
    ts.isImportDeclaration(s)
    || ts.isExportAssignment(s)
    || ts.isExportDeclaration(s)
    || ((ts.canHaveModifiers(s) ? ts.getModifiers(s) : undefined) ?? [])
      .some((m) => m.kind === ts.SyntaxKind.ExportKeyword),
  );
  const hasTopLevelAwait = allStatements.some((s) => nodeContainsTopLevelAwait(s));
  if (!alreadyModule && hasTopLevelAwait) {
    allStatements.push(factory.createExportDeclaration(undefined, false, factory.createNamedExports([]), undefined));
  }

  const sourceFile = factory.updateSourceFile(
    ts.createSourceFile('output.ts', '', ts.ScriptTarget.Latest, false, ts.ScriptKind.TS),
    allStatements,
  );
  const printer = ts.createPrinter({
    newLine: ts.NewLineKind.LineFeed,
    removeComments: false,
  });
  let printed = printer.printFile(sourceFile);
  printed = beautifyOutput(printed);

  // Preserve only the source's leading comment block (file header).
  if (options.preserveComments) {
    const header = extractFileHeaderComments(source);
    if (header) printed = `${header}\n${printed}`;
  }

  printed = `${COMPILER_HEADER}\n${printed}`;

  // Prettier pass — source-map building happens AFTER so generated-line
  // numbers match the final output.
  if (options.pretty !== false) {
    try {
      printed = await prettierFormat(printed, {
        parser: 'typescript',
        semi: true,
        singleQuote: false,
        trailingComma: 'all',
        printWidth: 100,
        arrowParens: 'always',
        endOfLine: 'lf',
      });
    } catch {
      // Prettier parser failure — fall through to the raw printer output.
    }
  }

  // Layer A: post-emit tsc via in-memory CompilerHost (strict:false to
  // accommodate untyped Luau). Default: on for native, off for rbxts
  // (rbxts emit relies on @rbxts/types globals our internal tsc can't see).
  const layerADefault = ctx.compatMode === 'rbxts' ? false : true;
  const runLayerA = options.typeCheck === true
    || (options.postEmitCheck !== false && options.postEmitCheck !== undefined)
    || (options.postEmitCheck === undefined && layerADefault);
  if (runLayerA) {
    const postEmitDiags = runPostEmitCheck(printed, sourceFileName);
    for (const d of postEmitDiags) parsed.errors.push(d);
  }

  // Layer B: pre-emit Luau check via @luau2ts/analyzer (optional peer).
  // Default-on when installed, soft-fails silently otherwise.
  const runLayerB = options.typeCheck === true || options.preEmitCheck === true || options.preEmitCheck !== false;
  if (runLayerB) {
    type AnalyzerDiagnostic = {
      severity: 'error' | 'warning';
      code: string;
      message: string;
      line: number;
      col: number;
      endLine: number;
      endCol: number;
    };
    type AnalyzerMod = {
      analyze: (source: string) => Promise<AnalyzerDiagnostic[]>;
    };
    let analyzerMod: AnalyzerMod | undefined;
    try {
      // Indirect the import path so the TS checker doesn't resolve it
      // at compile time.
      const analyzerPath = '@luau2ts' + '/analyzer';
      analyzerMod = (await import(/* @vite-ignore */ analyzerPath)) as AnalyzerMod;
    } catch {
      // Soft warning only when the user explicitly asked for the check.
      if (options.typeCheck === true || options.preEmitCheck === true) {
        parsed.errors.push({
          loc: { start: { line: 0, col: 0 }, end: { line: 0, col: 0 } },
          message:
            '[luau2ts] preEmitCheck requested but @luau2ts/analyzer is not installed. Install with: pnpm add -D @luau2ts/analyzer',
        });
      }
    }
    if (analyzerMod) {
      const diags = await analyzerMod.analyze(source);
      for (const d of diags) {
        // Demote `UnknownProperty` on Roblox external types to warnings —
        // dynamic-child access (`script.Parent.Drop`) can't be expressed in
        // Luau's `declare class` and would drown out real type errors.
        const isRobloxDynamicAccess =
          d.code === 'UnknownProperty'
          && /not found in (?:external )?type '[A-Z]\w*'/.test(d.message);
        const diag = {
          message: `[luau:${d.code}] ${d.message}`,
          loc: {
            start: { line: d.line, col: d.col },
            end: { line: d.endLine, col: d.endCol },
          },
        };
        if (d.severity === 'warning' || isRobloxDynamicAccess) warnings.push(diag);
        else parsed.errors.push(diag);
      }
    }
  }

  let sourceMap: SourceMap | undefined;
  if (options.sourceMap || options.inlineSourceMap) {
    const mappings: SourceMapMapping[] = [];
    // Skip past the prepended compiler header / source-comment lines.
    const lines = printed.split('\n');
    let cursor = 0;
    while (cursor < lines.length) {
      const ln = lines[cursor]!;
      if (ln.startsWith('//') || ln.startsWith('/*') || ln.trim() === '') {
        cursor++;
        continue;
      }
      break;
    }
    for (const stmt of allStatements) {
      const loc = stmtToLuauLoc.get(stmt);
      if (!loc) continue;
      while (cursor < lines.length && lines[cursor]!.trim() === '') cursor++;
      if (cursor >= lines.length) break;
      mappings.push({
        generatedLine: cursor,
        generatedColumn: 0,
        originalLine: loc.line,
        originalColumn: loc.col,
      });
      cursor++;
    }
    sourceMap = buildSourceMap(`${sourceFileName}.ts`, sourceFileName, source, mappings);
    if (options.inlineSourceMap) {
      printed += `\n${inlineSourceMapURL(sourceMap)}`;
    }
  }

  return {
    source: printed,
    helpers,
    errors: parsed.errors,
    warnings,
    ...(sourceMap ? { sourceMap } : {}),
  };
}

/** Extract the file's leading comment block — every `--` line comment or
 *  `--[[ ]]` block comment that appears before the first non-comment,
 *  non-whitespace character of the source. */
function extractFileHeaderComments(source: string): string {
  const out: string[] = [];
  let i = 0;
  const len = source.length;
  while (i < len) {
    // Skip whitespace.
    while (i < len && /\s/.test(source[i]!)) i++;
    if (i >= len) break;
    if (source[i] !== '-' || source[i + 1] !== '-') break;
    if (source[i + 2] === '[' && source[i + 3] === '[') {
      // Block comment.
      const end = source.indexOf(']]', i + 4);
      if (end < 0) break;
      const block = source.slice(i, end + 2);
      // Convert --[[ ... ]] to /* ... */ for TS.
      out.push(`/* ${block.slice(4, -2).trim()} */`);
      i = end + 2;
    } else {
      // Line comment until newline.
      const end = source.indexOf('\n', i);
      const stop = end < 0 ? len : end;
      out.push(`// ${source.slice(i + 2, stop).trim()}`);
      i = stop;
    }
  }
  return out.join('\n');
}

/** Names the script wrapper provides — never pre-declared by the
 *  compiler since they'd shadow the wrapper's bindings. */
const HOST_PROVIDED_GLOBALS = new Set([
  // Roblox runtime singletons
  'game',
  'workspace',
  'script',
  'plugin',
  'shared',
  // Roblox stdlib functions
  'print',
  'warn',
  'error',
  'assert',
  'pcall',
  'xpcall',
  'select',
  'tostring',
  'tonumber',
  'type',
  'typeof',
  'ipairs',
  'pairs',
  'next',
  'unpack',
  'setmetatable',
  'getmetatable',
  'rawget',
  'rawset',
  'rawequal',
  'rawlen',
  'wait',
  'spawn',
  'delay',
  'defer',
  'tick',
  'time',
  // Uppercase legacy aliases (Wait, Spawn, Delay) and pre-2018 globals
  // (Game, Workspace) provided by the host preamble in cli.ts.
  'Wait',
  'Spawn',
  'Delay',
  'Game',
  'Workspace',
  'LoadLibrary',
  'elapsedTime',
  'ElapsedTime',
  'task',
  'require',
  'newproxy',
  // Lua libraries
  'math',
  'string',
  'table',
  'os',
  'io',
  'coroutine',
  'utf8',
  'bit32',
  'buffer',
  'debug',
  // Roblox datatypes (provided by import)
  'Instance',
  'Vector3',
  'Vector2',
  'CFrame',
  'Color3',
  'UDim',
  'UDim2',
  'BrickColor',
  'Enum',
  'Ray',
  'Region3',
  'Rect',
  'NumberRange',
  'NumberSequence',
  'NumberSequenceKeypoint',
  'ColorSequence',
  'ColorSequenceKeypoint',
  'Faces',
  'Axes',
  'TweenInfo',
  'PhysicalProperties',
  'RaycastParams',
  'OverlapParams',
  'Random',
  'DateTime',
  'Font',
  'Path2DControlPoint',
  // Boolean-y / nil
  'nil',
  '_G',
  '_ENV',
  '_VERSION',
  // Stubbed legacy Lua globals provided by the cli preamble. Without these
  // in the host set the implicit-globals walker emits a `let loadstring;`
  // predecl that shadows the preamble's `const loadstring = …`, so the
  // stub is unreachable inside the script body.
  'loadstring',
  'collectgarbage',
  'ypcall',
]);

/** Names that ship as named exports from `luau2ts/runtime`. When the script
 *  uses one of these as a Global, we auto-add it to the runtime import list
 *  the same way `luaIndex` / `luaIndexSet` / etc. get added by codegen. This
 *  keeps the standalone CLI usable without a host preamble — `setmetatable`,
 *  `pcall`, `error`, etc. resolve to runtime stubs out of the box. */
/** Lua string library methods callable via colon syntax (`s:method(args)`).
 *  Lua's string metatable forwards `s:X(...)` to `string.X(s, ...)`; we
 *  emulate that by routing colon calls to the paired runtime helper.
 *  `tupleFirst: true` means the runtime helper returns a tuple where the
 *  first value is the "main" string return (Lua single-assign takes only
 *  the first value); we wrap such calls in `[0]` so chained colon calls
 *  see the string, not the tuple. Multi-target destructure (`local s, n =
 *  str:gsub(...)`) loses the secondary value — users can call the
 *  namespace form `string.gsub(s, ...)` if they need both. */
const STRING_LIB_METHODS = new Map<string, { helper: string; tupleFirst?: boolean }>([
  ['format', { helper: 'stringFormat' }],
  ['gsub', { helper: 'stringGsub', tupleFirst: true }],
  ['gmatch', { helper: 'stringGmatch' }],
  ['find', { helper: 'stringFind', tupleFirst: true }],
  ['match', { helper: 'stringMatch' }],
  ['sub', { helper: 'stringSub' }],
  ['rep', { helper: 'stringRep' }],
  ['byte', { helper: 'stringByte', tupleFirst: true }],
  ['char', { helper: 'stringChar' }],
  ['len', { helper: 'stringLen' }],
  ['lower', { helper: 'stringLower' }],
  ['upper', { helper: 'stringUpper' }],
  ['reverse', { helper: 'stringReverse' }],
]);

const RUNTIME_AVAILABLE_GLOBALS = new Set([
  'setmetatable',
  'getmetatable',
  'rawget',
  'rawset',
  'rawequal',
  'rawlen',
  'pcall',
  'xpcall',
  'error',
  'assert',
  'tostring',
  'tonumber',
  'select',
  'unpack',
  'ipairs',
  'pairs',
  'next',
  'newproxy',
  // Lua stdlib namespaces (each is a `const X = { ... }` in the runtime).
  'table',
  'os',
  'math',
  'string',
]);

/** Names that aren't in the runtime but are expected at runtime from the
 *  host environment (Roblox, or a user-supplied preamble). When the script
 *  uses one of these, we emit `declare const X: any;` at the top so the TS
 *  type-checker doesn't surface "Cannot find name" errors. Generation of
 *  the actual binding is the host's responsibility. */
const AMBIENT_GLOBALS = new Set([
  'game',
  'workspace',
  'script',
  'plugin',
  'shared',
  'print',
  'warn',
  'task',
  'require',
  'wait',
  'spawn',
  'delay',
  'defer',
  'tick',
  'time',
  'Wait',
  'Spawn',
  'Delay',
  'Game',
  'Workspace',
  'LoadLibrary',
  'elapsedTime',
  'ElapsedTime',
  'ypcall',
  'loadstring',
  'collectgarbage',
  'type',
  'typeof',
  // Lua stdlib namespaces we don't ship runtime impls for. These come
  // from the host preamble or `@rbxts/types` in real projects.
  'coroutine',
  'bit32',
  'buffer',
  'debug',
  'utf8',
  'io',
  // Roblox datatypes — provided by `@rbxts/types` in projects that
  // configure it, or by the host preamble otherwise.
  'Instance',
  'Vector3',
  'Vector2',
  'CFrame',
  'Color3',
  'UDim',
  'UDim2',
  'BrickColor',
  'Enum',
  'Ray',
  'Region3',
  'Rect',
  'NumberRange',
  'NumberSequence',
  'NumberSequenceKeypoint',
  'ColorSequence',
  'ColorSequenceKeypoint',
  'Faces',
  'Axes',
  'TweenInfo',
  'PhysicalProperties',
  'RaycastParams',
  'OverlapParams',
  'Random',
  'DateTime',
  'Font',
  'Path2DControlPoint',
  '_G',
  '_ENV',
  '_VERSION',
]);


function collectImplicitGlobals(parsed: ParseResult): Set<string> {
  const referenced = new Set<string>();
  const declared = new Set<string>();
  if (!parsed.root) return referenced;

  // Predeclare every Global the script touches: Luau reads undeclared as `nil`
  // but JS strict throws ReferenceError. Skip names that already get a JS
  // binding (top-level function / let) to avoid redeclaration collision.
  // Track function depth so inner-scope locals don't shadow top-level globals.
  let fnDepth = 0;
  // Block depth (excluding root) — Lua's block-scoped locals must not
  // suppress outer Global predecls (`if then local X end; print(X)`).
  let blockDepth = 0;
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const n = node as { type?: string };
    if (n.type === 'Global') {
      const name = (n as { name?: string }).name;
      if (typeof name === 'string' && !HOST_PROVIDED_GLOBALS.has(name)) {
        referenced.add(name);
      }
    } else if (n.type === 'IndexExpr') {
      // `_G["X"] = …` synthesizes a mirror assignment `X = _G["X"]` (see
      // compileAssign). Predeclare X so the mirror has something to bind to;
      // otherwise the strict-mode assignment throws ReferenceError.
      const ie = n as { expr?: { type?: string; name?: string }; index?: { type?: string; value?: string } };
      if (
        ie.expr?.type === 'Global'
        && ie.expr.name === '_G'
        && ie.index?.type === 'ConstantString'
        && typeof ie.index.value === 'string'
        && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(ie.index.value)
        && !HOST_PROVIDED_GLOBALS.has(ie.index.value)
      ) {
        referenced.add(ie.index.value);
      }
    } else if (n.type === 'CompoundAssign') {
      const v = (n as { var?: { type?: string; name?: string } }).var;
      if (v && v.type === 'Global' && typeof v.name === 'string') {
        if (!HOST_PROVIDED_GLOBALS.has(v.name)) referenced.add(v.name);
      }
    } else if (n.type === 'Function') {
      // FunctionStat (has `name` Expr) vs FunctionExpr (has `body`). Only the
      // stat form declares a binding name we need to track.
      const stat = n as { name?: { type?: string; name?: string }; func?: unknown };
      if (fnDepth === 0 && blockDepth === 0 && stat.func && stat.name && stat.name.type === 'Global' && typeof stat.name.name === 'string') {
        declared.add(stat.name.name);
      }
    } else if (n.type === 'LocalFunction') {
      const stat = n as { name?: { name?: string } };
      if (fnDepth === 0 && blockDepth === 0 && stat.name && typeof stat.name.name === 'string') declared.add(stat.name.name);
    } else if (n.type === 'Local' && 'vars' in n && 'values' in n) {
      if (fnDepth === 0 && blockDepth === 0) {
        const vars = (n as { vars: { name: string }[] }).vars;
        for (const v of vars) declared.add(v.name);
      }
    }
    // FunctionStat and LocalFunction both type-tag as 'Function' and wrap a
    // FunctionExpr via .func — only the FunctionExpr (.body present, no
    // .func) actually opens a new lexical scope. Incrementing on the outer
    // stat would double-count and break the depth invariant.
    const enterFn =
      n.type === 'Function'
      && (n as { body?: unknown; func?: unknown }).body !== undefined
      && (n as { body?: unknown; func?: unknown }).func === undefined;
    if (enterFn) fnDepth += 1;
    // Inner control-flow blocks (`if`/`for`/`while`/`repeat`/`do`) open a
    // new lexical scope in Lua. Locals declared inside don't bind at the
    // outer scope, so we treat them as not-declared for the purpose of
    // implicit-global predeclaration.
    const enterBlock =
      n.type === 'If' || n.type === 'For' || n.type === 'ForIn'
      || n.type === 'While' || n.type === 'Repeat' || n.type === 'Do';
    if (enterBlock) blockDepth += 1;
    // Recurse into all object values.
    for (const v of Object.values(n as Record<string, unknown>)) {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') walk(v);
    }
    if (enterBlock) blockDepth -= 1;
    if (enterFn) fnDepth -= 1;
  };
  walk(parsed.root);
  for (const name of declared) referenced.delete(name);
  return referenced;
}

/** Post-process the printer output to add blank lines around top-level
 *  blocks. The TS factory printer just newlines between every statement,
 *  which reads as a wall of code for a 600-line file. Prettier doesn't
 *  add blank lines either — that's an opinion the user is supposed to
 *  hold.
 *
 *  Rules, applied only at brace depth 0 so we don't disturb function
 *  bodies:
 *    1. After an `import` group: blank before the first non-import line.
 *    2. After a `declare const X: ...;` group: blank before the next
 *       non-`declare` line.
 *    3. After a multi-line top-level statement (any statement whose body
 *       brace closes back to depth 0): blank before the next statement.
 *    4. Before a `function` or `class` declaration: blank (unless we're
 *       already separated by blank or at file start).
 *
 *  String/template handling is approximate — we only track brace depth
 *  and skip braces that appear inside string literals on the same line.
 *  Multi-line template strings are rare in our emit; if they bite us we
 *  can swap to a real tokenizer. */
function beautifyOutput(source: string): string {
  const lines = source.split('\n');
  const out: string[] = [];
  let depth = 0;
  // prevKind never actually takes 'blank' (we only update on non-blank
  // lines), so omit it from the union.
  let prevKind: 'import' | 'declare-const' | 'class' | 'function' | 'control' | 'simple' | 'start' = 'start';
  let prevWasMultiline = false;
  // Track whether the current statement started multi-line — flipped on
  // when we first open a brace at depth 0, read off when we close back
  // to 0 to decide whether the next top-level statement gets a blank.
  let inMultilineStmt = false;

  function classify(line: string):
    | 'import'
    | 'declare-const'
    | 'class'
    | 'function'
    | 'control'
    | 'simple'
    | 'blank'
  {
    const trimmed = line.trim();
    if (trimmed === '') return 'blank';
    if (trimmed.startsWith('import ')) return 'import';
    if (/^declare\s+(?:const|let|var|function|class|type|namespace|module|global)\b/.test(trimmed))
      return 'declare-const';
    if (/^(?:export\s+)?(?:abstract\s+)?class\b/.test(trimmed)) return 'class';
    if (/^(?:export\s+)?(?:async\s+)?function\b/.test(trimmed)) return 'function';
    if (/^(?:if|for|while|do|switch|try)\b/.test(trimmed)) return 'control';
    return 'simple';
  }

  // Approximate brace-depth tracker that skips runs of characters inside
  // single/double/back quotes on the same line. Returns `[opens, closes]`.
  function braceDelta(line: string): [number, number] {
    let opens = 0, closes = 0;
    let inStr: '"' | "'" | '`' | null = null;
    for (let i = 0; i < line.length; i++) {
      const c = line[i]!;
      if (inStr) {
        if (c === '\\') { i++; continue; }
        if (c === inStr) inStr = null;
        continue;
      }
      if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
      if (c === '/' && line[i + 1] === '/') break; // line comment — ignore rest
      if (c === '{') opens++;
      else if (c === '}') closes++;
    }
    return [opens, closes];
  }

  for (const raw of lines) {
    const trimmed = raw.trim();
    const kind = trimmed === '' ? 'blank' : classify(raw);

    // Decide whether to insert a blank line BEFORE this line.
    if (
      depth === 0
      && kind !== 'blank'
      && prevKind !== 'start'
    ) {
      const isBoundary =
        // 1. import → non-import
        (prevKind === 'import' && kind !== 'import')
        // 2. declare → non-declare
        || (prevKind === 'declare-const' && kind !== 'declare-const')
        // 3. previous statement was multi-line, separate from next
        || prevWasMultiline
        // 4. before a class/function declaration
        || kind === 'class' || kind === 'function';
      if (isBoundary) out.push('');
    }

    out.push(raw);

    // Update tracking based on this line's braces.
    const [opens, closes] = braceDelta(raw);
    if (depth === 0 && opens > 0) inMultilineStmt = true;
    depth = Math.max(0, depth + opens - closes);
    if (kind !== 'blank') {
      prevKind = kind;
      // Statement just ended (we're back to depth 0 after non-blank line).
      // The previous-line tracker for "was the just-finished statement
      // multi-line" needs to fire on the line where depth bottoms out.
      if (depth === 0) {
        prevWasMultiline = inMultilineStmt;
        inMultilineStmt = false;
      } else {
        prevWasMultiline = false;
      }
    }
  }
  return out.join('\n');
}

/** Layer A: post-emit TypeScript type check. Runs the bundled tsc over
 *  the emitted source via an in-memory CompilerHost and returns the
 *  diagnostics in ParseError shape so they line up with everything else
 *  in CompileResult.errors. strict:false because the translation often
 *  produces any-typed positions where the Luau was untyped, and we'd
 *  rather flag real semantic mistakes than drown the user in noise. */
function runPostEmitCheck(
  source: string,
  _sourceName: string,
): { message: string; loc: { start: { line: number; col: number }; end: { line: number; col: number } } }[] {
  // Use a fixed, POSIX-style in-memory filename. The caller's sourceName
  // (which may be a Windows path with backslashes) only matters for the
  // user-facing error report; ts compiler internals normalize paths and
  // a mismatched-backslash filter would drop every diagnostic.
  const fileName = 'luau2ts-postcheck-input.ts';
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const options: ts.CompilerOptions = {
    strict: false,
    noEmit: true,
    target: ts.ScriptTarget.Latest,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    skipLibCheck: true,
    allowJs: false,
    isolatedModules: true,
  };

  // CompilerHost backed by the default host so lib.es*.d.ts files resolve
  // against the bundled typescript install, but our single in-memory
  // source file shadows getSourceFile for its own path.
  const defaultHost = ts.createCompilerHost(options, true);
  const host: ts.CompilerHost = {
    ...defaultHost,
    getSourceFile: (name, languageVersion, onError) => {
      if (name === fileName) return sourceFile;
      return defaultHost.getSourceFile(name, languageVersion, onError);
    },
    writeFile: () => undefined,
    fileExists: (name) => (name === fileName ? true : defaultHost.fileExists(name)),
    readFile: (name) => (name === fileName ? source : defaultHost.readFile(name)),
  };

  const program = ts.createProgram({ rootNames: [fileName], options, host });
  const diagnostics = ts.getPreEmitDiagnostics(program);

  const out: { message: string; loc: { start: { line: number; col: number }; end: { line: number; col: number } } }[] = [];
  for (const d of diagnostics) {
    // Only surface diagnostics that point into OUR source file. lib.*.d.ts
    // errors would just be noise.
    if (!d.file || d.file.fileName !== fileName) continue;
    const start = d.start !== undefined ? sourceFile.getLineAndCharacterOfPosition(d.start) : { line: 0, character: 0 };
    const endPos = d.start !== undefined && d.length !== undefined
      ? sourceFile.getLineAndCharacterOfPosition(d.start + d.length)
      : start;
    const message = ts.flattenDiagnosticMessageText(d.messageText, '\n');
    out.push({
      message: `[ts:${d.code}] ${message}`,
      loc: {
        start: { line: start.line + 1, col: start.character + 1 },
        end: { line: endPos.line + 1, col: endPos.character + 1 },
      },
    });
  }
  return out;
}

function buildRuntimeImport(names: string[]): ts.Statement {
  return buildNamedImport(RUNTIME_MODULE, names);
}

/** Generic `import { ...names } from "<module>"` builder. Used for both the
 *  default runtime helper import and macro-registered extras (`@rbxts/types`,
 *  `@rbxts/services`, etc.). */
function buildNamedImport(module: string, names: string[]): ts.Statement {
  return factory.createImportDeclaration(
    undefined,
    factory.createImportClause(
      false,
      undefined,
      factory.createNamedImports(
        names.map((n) =>
          factory.createImportSpecifier(false, undefined, factory.createIdentifier(n)),
        ),
      ),
    ),
    factory.createStringLiteral(module),
  );
}
