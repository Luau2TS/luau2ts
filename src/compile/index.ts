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
  type TypePack,
  type TypeNode,
} from '../parser/index.js';
import ts from 'typescript';
import { format as prettierFormat } from 'prettier';
import { ARITH_DATATYPES, CompileContext, DYN_FN_TYPE, DYN_METHOD_TYPE, DYN_VALUE_TYPE, RUNTIME_MODULE, VECTOR_LIB_TYPE, isDatatypeStatic, type CompatMode, type StaticValueType } from './context.js';
import { lookupMacro } from './macros/index.js';
// Side-effect imports — populate the macro registry consulted by lookupMacro.
import './macros/datatypes.js';
import './macros/instance.js';
import './macros/stdlib.js';
import './rbxts-runtime.js';
import { detectClasses, compileClassPattern, type ClassPattern } from './class-shape.js';
import { collectLocalNames, collectShapes, intersectionTargetDeclaresName, intersectionTypeName, leafPrimitive, shapeToTypeNode } from './shape-infer.js';
import { inferScriptParentShapes } from './script-parent-infer.js';
import { inferLoopVarShapes } from './loop-var-infer.js';
import { resolveRequirePath } from './require-infer.js';
import { inferParamBackprop } from './param-backprop.js';
import { inferInstanceNarrowings } from './instance-narrow.js';
import { inferParamPrimitives, inferReturnPrimitive } from './param-infer.js';
import { splitInstanceChains } from './chain-split.js';
import { inferConstLocals } from './const-infer.js';
import { hoistInnerLuaTupleCalls } from './luatuple-hoist.js';
import { inferLocalTypes, type LocalTypeMap } from './local-type-infer.js';
import { runFlowPass, type FlowFact } from './flow.js';
import { inferInstanceLocals } from './backprop-class.js';
import { rewriteGameServices } from './service-rewrite.js';
import {
  lookupClassMethod as apiLookupClassMethod,
  lookupClassProperty as apiLookupClassProperty,
  lookupClassEvent as apiLookupClassEvent,
  isInstanceClass as apiIsInstanceClass,
} from './macros/generated/dispatch.js';
import { STDLIB_SLOTS } from './macros/generated/stdlib-slots.js';
import { DATATYPE_SLOTS } from './macros/generated/datatype-slots.js';
import { compileType, compileTypePack, setAliasArities, setAliasBodies, setTypeCompatMode, setTypePrefixResolver } from './type.js';
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
  // The oracle models Roblox datatypes as classes (`CFrame.LookVector`
  // → class Vector3); surface those as datatypes so arithmetic can
  // dispatch to `.add()` instead of bridging through number.
  if (fact.kind === 'class' && !fact.nullable && ARITH_DATATYPES.has(fact.name)) {
    return `datatype:${fact.name}` as StaticValueType;
  }
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
  if (
    !!ctx.oracle.propertyType(className, memberName)
    || !!ctx.oracle.methodReturnType(className, memberName, 0)
  ) {
    return true;
  }
  // Fall back to API-Dump.json: it covers a wider surface than @rbxts/types
  // (undocumented APIs, recently-added classes that haven't been reflected
  // into the .d.ts yet). Walk the extends chain through api-data.
  return apiClassHasMember(className, memberName);
}

function apiClassHasMember(className: string, memberName: string): boolean {
  return !!apiLookupClassProperty(className, memberName)
    || !!apiLookupClassMethod(className, memberName)
    || apiLookupClassEvent(className, memberName);
}

function isLuauChildTypeText(text: string): boolean {
  return text === '_LuauChild' || text.includes('_LuauChild');
}

/** True when `expr` is an IndexName chain whose deepest receiver is a
 *  dynamic root (`script`/`workspace`) we synthesized a Pass-1 shape for.
 *  Used to suppress extra `as _LuauChild` casts inside the chain — the
 *  synth-type cast at the root already types the whole chain. */
function chainRootedInSynthesizedDynamic(expr: Expr, ctx: CompileContext): boolean {
  let cur: Expr = expr;
  while (cur.type === 'IndexName') cur = cur.expr;
  if (cur.type !== 'Global') return false;
  return ctx.scriptParentRootTypes.has(cur.name);
}

/** Pass 3: return the param name at the given positional index for a
 *  user function whose params were cataloged by `inferParamBackprop`. */
function paramNameFromCallee(name: string, index: number, ctx: CompileContext): string | undefined {
  const names = ctx.paramBackpropParamNames.get(name);
  return names ? names[index] : undefined;
}

/** Pass 3: true when `expr`'s static type matches a backprop-bound
 *  type. Used to skip the redundant `as Parameters<typeof callee>[i]`
 *  cast — TS accepts the assignment directly when the arg's TS-visible
 *  type is compatible with the param's declared class/datatype. */
function argIsCompatibleWithBoundType(expr: Expr, boundType: string, ctx: CompileContext): boolean {
  // Match arg's static class against the bound type. Handles
  // Instance-subclass downcast: bound `Instance` accepts any
  // Instance-rooted class.
  const isInstanceBound = boundType === 'Instance';
  switch (expr.type) {
    case 'Group':
    case 'TypeAssertion':
      return argIsCompatibleWithBoundType(expr.expr, boundType, ctx);
    case 'Global': {
      if (ctx.oracle.isService(expr.name)) {
        return boundType === expr.name
          || (isInstanceBound && ctx.oracle.isA(expr.name, 'Instance'));
      }
      return false;
    }
    case 'Local': {
      const cls = ctx.tsTypedClassLocal.get(expr.name);
      if (!cls) return false;
      return boundType === cls
        || (isInstanceBound && ctx.oracle.isA(cls, 'Instance'));
    }
    case 'Call':
    case 'IndexName': {
      const cls = resolveOracleClassOfExpr(expr, ctx);
      if (!cls) {
        // Pass 1 chains: `script.Parent[.X...]` evaluates to a synth
        // type that intersects with Instance. So Instance-bound params
        // accept these directly.
        if (isInstanceBound && chainRootedInSynthesizedDynamic(expr, ctx)) {
          return true;
        }
        return false;
      }
      return boundType === cls
        || (isInstanceBound && ctx.oracle.isA(cls, 'Instance'));
    }
    default:
      return false;
  }
}

/** True when a shape's discriminators trigger the intersection with a
 *  real class (Player, Instance, Vector3). Mirrors shape-infer's
 *  intersection-table without re-importing it. */
const SHAPE_INTERSECTION_DISCRIMINATORS = new Set([
  // Instance navigation methods
  'FindFirstChild', 'WaitForChild', 'Parent', 'GetChildren', 'GetDescendants',
  'IsA', 'Destroy', 'Clone', 'GetFullName', 'AddTag', 'HasTag',
  // Player discriminators
  'UserId', 'AccountAge', 'Character', 'Team',
  // Vector3 discriminators
  'X', 'Y', 'Z',
]);
function shapeHasClassIntersection(shape: { props?: Map<string, unknown>; methods?: Map<string, unknown> } | undefined): boolean {
  if (!shape) return false;
  if (shape.props) {
    for (const k of shape.props.keys()) {
      if (SHAPE_INTERSECTION_DISCRIMINATORS.has(k)) return true;
    }
  }
  if (shape.methods) {
    for (const k of shape.methods.keys()) {
      if (SHAPE_INTERSECTION_DISCRIMINATORS.has(k)) return true;
    }
  }
  return false;
}

/** Walk an IndexName chain to its root Local (if any). Used by
 *  shape-typed skip checks. */
function chainRootLocal(expr: Expr): string | null {
  let cur: Expr = expr;
  while (cur.type === 'IndexName' && cur.op === '.') cur = cur.expr;
  return cur.type === 'Local' ? (cur as { name: string }).name : null;
}

/** Pass 2: try to resolve a `require(X)` argument to a corpus module
 *  path and look up its inferred return-type text. */
function resolveRequireReturnType(arg: Expr | undefined, ctx: CompileContext): string | null {
  if (!arg || ctx.compatMode !== 'rbxts') return null;
  if (ctx.moduleReturnTypes.size === 0 || !ctx.currentScriptPath) return null;
  const path = resolveRequirePath(arg, ctx.currentScriptPath);
  if (!path) return null;
  return ctx.moduleReturnTypes.get(path) ?? null;
}

/** Parse a TS type-text string into a TypeNode. Used for Pass 2's
 *  cached require return types — the cache stores stringified types so
 *  it can cross compile() invocations cleanly. */
function parseTypeText(text: string): ts.TypeNode {
  // Wrap in a `type _T = ...` so the TS parser sees a type position.
  const sf = ts.createSourceFile('_t.ts', `type _T = ${text};`, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const alias = sf.statements[0];
  if (alias && ts.isTypeAliasDeclaration(alias)) return alias.type;
  return factory.createTypeReferenceNode('defined', undefined);
}

/** True when a signal-method receiver is a typed Event property on a
 *  known class — e.g. `clickDetector.MouseClick` where ClickDetector
 *  declares MouseClick as a Roblox Event. In that case Connect/Fire/Wait
 *  resolve via the @rbxts/types signal type and the Record-routing
 *  receiver cast is pure noise. */
function signalReceiverIsTypedEvent(recv: Expr, ctx: CompileContext): boolean {
  if (recv.type !== 'IndexName') return false;
  // Prefer the emit-consistent class (tsTypedClassLocal) over the more
  // optimistic flow-class. flowClassOf for `local hum = WaitForChild("Humanoid", 5)`
  // returns 'Humanoid' but the emitted type is `Instance | undefined`, so
  // trusting flow misclassifies `hum.Died` as a typed event. Same caveat
  // for Gap 1's IsA-narrowed flowClass: the compiler internalizes the
  // narrowing but the emitted TS type is still the unnarrowed _LuauChild
  // — skip the flow source unless the receiver wouldn't emit as
  // _LuauChild.
  // Only consult flowClassOf when the receiver's emit-time type is also
  // a class — Gap 1's IsA narrowing puts an Instance subclass in
  // flowFactByExpr but the emitted TS type is whatever the local was
  // originally declared as (often `_LuauChild`). Skipping the cast based
  // on flow alone would leave TS rejecting `.Connect` on `unknown`.
  // `resolveOracleClassOfExpr` internally consults flowClassOf too, so
  // gate the result against the same emit-class check.
  const ownerClass = (() => {
    if (recv.expr.type === 'Local') {
      const tracked = ctx.tsTypedClassLocal.get(recv.expr.name);
      if (tracked) return tracked;
      return undefined;
    }
    return resolveOracleClassOfExpr(recv.expr, ctx);
  })();
  if (!ownerClass) return false;
  if (!apiLookupClassEvent(ownerClass, recv.index)) return false;
  // api-data says it's an event, but @rbxts/types may not expose it as a
  // typed RBXScriptSignal (e.g. `Instance.Changed` is `unknown` in
  // @rbxts/types). Without an RBXScriptSignal-typed slot, dropping the
  // Record routing leaves a TS2571 (`.Connect` on `unknown`). Require the
  // oracle to confirm the property type before skipping the cast.
  const prop = ctx.oracle.propertyType(ownerClass, recv.index);
  return prop?.kind === 'raw' && prop.text.startsWith('RBXScriptSignal');
}

/** True when the type text names an Instance-rooted class (or
 *  `<Class> | undefined` variant). Used to elide the `as unknown` bridge
 *  between an Instance-returning call and a SubClass narrowing — TS
 *  accepts the downcast directly. */
function isInstanceSubclassText(text: string): boolean {
  if (!text) return false;
  const base = text.replace(/\s*\|\s*undefined\s*$/, '');
  if (!/^[A-Z][\w]*$/.test(base)) return false;
  return apiIsInstanceClass(base);
}

function assertExpression(expr: ts.Expression, type: ts.TypeNode): ts.AsExpression {
  const inner = (
    ts.isBinaryExpression(expr)
    || ts.isConditionalExpression(expr)
    || ts.isArrowFunction(expr)
    || ts.isFunctionExpression(expr)
  )
    ? factory.createParenthesizedExpression(expr)
    : expr;
  // Bridge through `unknown` so casts between unrelated types don't trip
  // TS2352. The duplicate `as unknown` is harmless and keeps every call
  // site safe without the caller having to reason about overlap.
  return factory.createAsExpression(
    factory.createAsExpression(
      inner,
      factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
    ),
    type,
  );
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

/** `i` → `i - 1`, folding `i + 1` / `i - 1` literals so `t[i + 1]` emits
 *  `t[i]` rather than `t[i + 1 - 1]`. */
function zeroBasedIndex(index: ts.Expression): ts.Expression {
  if (
    ts.isBinaryExpression(index)
    && ts.isNumericLiteral(index.right)
    && (index.operatorToken.kind === ts.SyntaxKind.PlusToken
      || index.operatorToken.kind === ts.SyntaxKind.MinusToken)
  ) {
    const k = Number(index.right.text) * (index.operatorToken.kind === ts.SyntaxKind.PlusToken ? 1 : -1);
    const shifted = k - 1;
    if (shifted === 0) return index.left;
    return factory.createBinaryExpression(
      index.left,
      shifted > 0 ? ts.SyntaxKind.PlusToken : ts.SyntaxKind.MinusToken,
      factory.createNumericLiteral(Math.abs(shifted)),
    );
  }
  const inner = ts.isBinaryExpression(index) || ts.isConditionalExpression(index)
    ? factory.createParenthesizedExpression(index)
    : index;
  return factory.createBinaryExpression(inner, ts.SyntaxKind.MinusToken, factory.createNumericLiteral(1));
}

function dynTypeNode(): ts.TypeNode {
  return factory.createTypeReferenceNode(DYN_VALUE_TYPE, undefined);
}

/** Bridge a value into a `_LuauValue` slot. A number is a constituent
 *  of the intersection, so a single `as` suffices; anything else goes
 *  through `unknown`. A value TS already sees as `_LuauValue` passes. */
function dynCoerce(expr: ts.Expression, source: Expr | undefined, ctx: CompileContext): ts.Expression {
  const seen = source ? tsVisibleType(source, ctx) : 'unknown';
  if (seen === 'dyn') return expr;
  const inner = ts.isBinaryExpression(expr) || ts.isConditionalExpression(expr)
    || ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)
    ? factory.createParenthesizedExpression(expr)
    : expr;
  if (seen === 'number' || ts.isNumericLiteral(expr)) return factory.createAsExpression(inner, dynTypeNode());
  return assertExpression(expr, dynTypeNode());
}

/** True when TS sees the emitted expression as `_LuauValue`: a dyn
 *  binding, a member chain or index rooted in one (unless the read was
 *  narrowed to a datatype), or a call through the `_LuauFn` bridge. */
function isDynExpr(expr: Expr, ctx: CompileContext): boolean {
  if (ctx.compatMode !== 'rbxts') return false;
  switch (expr.type) {
    case 'Local':
      return ctx.tsDynLocal.has(expr.name);
    case 'Group':
      return isDynExpr(expr.expr, ctx);
    case 'TypeAssertion':
      return compileType(expr.annotation).kind === ts.SyntaxKind.UnknownKeyword && isDynExpr(expr.expr, ctx);
    case 'IndexName':
      if (isDatatypeStatic(staticTypeOfExpr(expr, ctx))) return false;
      if (shapeLeafIsDyn(expr, ctx)) return true;
      if (expr.index === 'Parent' || expr.index === 'Value') return false;
      return isDynExpr(expr.expr, ctx);
    case 'IndexExpr':
      return isDynExpr(expr.expr, ctx);
    case 'Call':
      return ctx.dynResultCalls.has(expr) || (!expr.self && isDynExpr(expr.func, ctx));
    case 'Binary':
      return ['+', '-', '*', '/', '%', '^'].includes(expr.op)
        && !isDatatypeStatic(staticTypeOfExpr(expr.left, ctx))
        && (isDynExpr(expr.left, ctx) || isDynExpr(expr.right, ctx));
    default:
      return false;
  }
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

function unknownCallableTypeNode(selfCall = false): ts.TypeNode {
  // The result of a call TS can't type is a Luau value like any other:
  // `_LuauValue`, so chained reads and arithmetic on it need no bridge.
  // A `:` call takes the `this`-typed alias: roblox-ts emits `:` from the
  // signature's `this` parameter, which is what preserves the receiver.
  return factory.createTypeReferenceNode(selfCall ? DYN_METHOD_TYPE : DYN_FN_TYPE, undefined);
}

function unknownCallableCastExpression(expr: ts.Expression, selfCall = false): ts.Expression {
  return factory.createParenthesizedExpression(
    assertExpression(
      expr,
      unknownCallableTypeNode(selfCall),
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
        let compiled = ctx.compatMode === 'rbxts'
          && value.type === 'Local'
          && ctx.tsLuauChildLocal.has(value.name)
            ? factory.createNonNullExpression(compileExpr(value, ctx))
            : compileExpr(value, ctx);
        if (ctx.compatMode === 'rbxts') {
          const declared = declaredSingleReturnType(ctx);
          if (declared && !returnValueFitsDeclared(value, declared, ctx)) {
            compiled = assertExpression(compiled, compileType(declared));
          }
        }
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
const ROBLOX_DATATYPES = new Set([
  'Vector3', 'Vector2', 'Vector3int16', 'Vector2int16',
  'CFrame', 'Color3', 'BrickColor',
  'UDim', 'UDim2',
  'NumberRange', 'NumberSequence', 'NumberSequenceKeypoint',
  'ColorSequence', 'ColorSequenceKeypoint',
  'Region3', 'Region3int16', 'Rect', 'Ray',
  'RaycastParams', 'OverlapParams',
  'TweenInfo', 'Random', 'DateTime',
  'Faces', 'Axes', 'PhysicalProperties',
  'Path2DControlPoint', 'FloatCurveKey', 'RotationCurveKey',
  'CatalogSearchParams', 'Font',
]);

const DATATYPE_STATIC_FACTORIES = new Set([
  'fromRGB', 'fromHSV', 'fromHex',
  'fromScale', 'fromOffset',
  'Angles', 'fromAxisAngle', 'fromEulerAnglesXYZ', 'fromEulerAnglesYXZ',
  'fromOrientation', 'fromMatrix', 'fromRotationBetweenVectors',
  'lookAt', 'lookAlong', 'identity',
  'fromName', 'fromEnum', 'fromId',
  'fromIsoDate', 'fromUnixTimestamp', 'fromUnixTimestampMillis',
  'fromUniversalTime', 'fromLocalTime', 'now',
  'fromCFrame', 'fromPosition',
  'zero', 'one', 'xAxis', 'yAxis', 'zAxis',
  'FromAxis', 'FromNormalId',
  'Random', 'palette',
  'White', 'Gray', 'DarkGray', 'Black', 'Red', 'Yellow', 'Green', 'Blue',
]);

/** Resolve the oracle className that an expression evaluates to, when
 *  possible. Used to populate tsTypedClassLocal so write sites can skip
 *  the Record<string, unknown> wrap on properties that exist on the
 *  class. */
/** Strip a `:: any` assertion in rbxts mode, where it compiles to
 *  nothing. The value's real type is whatever the inner expression
 *  produces, and every typing decision should see through to it. */
function throughAnyAssertion(expr: Expr, ctx: CompileContext): Expr {
  if (
    ctx.compatMode === 'rbxts'
    && expr.type === 'TypeAssertion'
    && compileType(expr.annotation).kind === ts.SyntaxKind.UnknownKeyword
  ) {
    return throughAnyAssertion(expr.expr, ctx);
  }
  return expr;
}

function resolveOracleClassOfExpr(rawExpr: Expr, ctx: CompileContext): string | undefined {
  const expr = throughAnyAssertion(rawExpr, ctx);
  const flowed = flowClassOf(expr, ctx);
  if (flowed) return flowed;
  if (expr.type === 'Global' && ctx.oracle.isService(expr.name)) return expr.name;
  if (expr.type === 'Local') {
    const tracked = ctx.tsTypedClassLocal.get(expr.name);
    if (tracked) return tracked;
    if (ctx.oracle.isService(expr.name)) return expr.name;
  }
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
    // Datatype constructor `<Type>.new(...)` → <Type> (Vector3, Color3,
    // UDim2, BrickColor, etc.). The macro emits `new <Type>(...)` already
    // typed as the class; the call result IS that class.
    if (
      fn.type === 'IndexName'
      && fn.expr.type === 'Global'
      && fn.index === 'new'
      && ROBLOX_DATATYPES.has((fn.expr as { name: string }).name)
    ) {
      return (fn.expr as { name: string }).name;
    }
    // Datatype static factory `<Type>.fromX(...)` → <Type>. The macros
    // for these return the typed value.
    if (
      fn.type === 'IndexName'
      && fn.expr.type === 'Global'
      && ROBLOX_DATATYPES.has((fn.expr as { name: string }).name)
      && DATATYPE_STATIC_FACTORIES.has(fn.index)
    ) {
      return (fn.expr as { name: string }).name;
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
    // <Service>.Method(...) / <Service>:Method(...) → return type from oracle
    // when it's a class. Picks up TweenService.Create → Tween, etc.
    if (fn.type === 'IndexName') {
      const recv = fn.expr;
      const recvClass =
        (recv.type === 'Global' || recv.type === 'Local')
          ? (ctx.oracle.isService(recv.name) ? recv.name : ctx.tsTypedClassLocal.get(recv.name))
          : undefined;
      if (recvClass) {
        const ret = ctx.oracle.methodReturnType(recvClass, fn.index, expr.args.length);
        if (ret?.kind === 'class') return ret.name;
      }
    }
  }
  return undefined;
}

function initIsOracleTyped(rawExpr: Expr, ctx: CompileContext): boolean {
  const expr = throughAnyAssertion(rawExpr, ctx);
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
      ctx.noteDeclaredType(v.name, v.annotation);
      // `local c = zeroControls()` / `local mut = s.mut`: TS infers the
      // init's declared type for the binding, so track it as if it had
      // been written on the local.
      if (!v.annotation && init && ctx.compatMode === 'rbxts') {
        const inherited = declaredAnnotationOfExpr(init, ctx);
        if (inherited) bindDeclaredAnnotation(v.name, inherited, ctx);
      }
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
    // @rbxts/types declares the tuple for oracle methods (`GetComponents`,
    // `WorldToViewportPoint`) and the string library; destructuring those
    // directly keeps every slot typed. Anything else bridges through
    // `unknown[]` — `as [unknown, unknown]` fails TS2352 against LuaTuple.
    const tupleSlots = ctx.compatMode === 'rbxts' ? oracleTupleSlots(stat.values[0]!, ctx) : null;
    const init = ctx.compatMode === 'rbxts'
      ? tupleSlots
        ? rawInit
        : assertExpression(rawInit, factory.createArrayTypeNode(dynTypeNode()))
      : factory.createCallExpression(
          factory.createIdentifier(ctx.use('multiret')),
          undefined,
          [rawInit],
        );
    const anyShadow = stat.vars.some((v) => ctx.hasLocalInCurrentScope(v.name));
    stat.vars.forEach((v, i) => {
      const slot = tupleSlots?.[i];
      ctx.assignLocal(v.name, v.annotation ? typeFromAnnotation(v.annotation) : slot?.staticType ?? 'unknown');
      ctx.noteDeclaredType(v.name, v.annotation);
      if (!v.annotation && slot) {
        if (slot.staticType !== 'unknown') ctx.noteDeclaredTypeKind(v.name, slot.staticType);
        if (slot.className) ctx.tsTypedClassLocal.set(v.name, slot.className);
        else ctx.tsTypedClassLocal.delete(v.name);
      } else if (!v.annotation && ctx.compatMode === 'rbxts') {
        ctx.noteDeclaredTypeKind(v.name, 'dyn');
      }
    });
    if (anyShadow) {
      // Same-scope shadow: emit destructuring assignment, not `let` — Luau reuses the binding.
      // Names not yet declared in this scope (`local _, x = f()` after an
      // earlier `local _`) still need their own `let`.
      const fresh = stat.vars.filter((v) => !ctx.hasLocalInCurrentScope(v.name));
      const decls: ts.Statement[] = fresh.length > 0
        ? [factory.createVariableStatement(
            undefined,
            factory.createVariableDeclarationList(
              [...new Set(fresh.map((v) => safeIdentifier(v.name)))].map((n) =>
                factory.createVariableDeclaration(factory.createIdentifier(n), undefined, undefined, undefined),
              ),
              ts.NodeFlags.Let,
            ),
          )]
        : [];
      return [...decls, factory.createExpressionStatement(
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
    // Empty `{}` is ambiguous (array seed vs. object seed). compileTableExpr
    // emits the conservative `{} as Record<string, unknown>` cast that
    // accepts either growth direction. When the local carries an explicit
    // annotation, narrow to the right empty literal so downstream method
    // dispatch (Array push/pop on array-typed locals; property writes on
    // object-typed locals) typechecks naturally.
    if (
      initExpr
      && init?.type === 'Table'
      && (init as { items?: unknown[] }).items?.length === 0
      && v.annotation
    ) {
      initExpr = isArrayShapedType(v.annotation)
        ? factory.createArrayLiteralExpression([], false)
        : factory.createObjectLiteralExpression([], false);
    }
    // Pass 4: wrap init with narrowed-class cast so the local's TS type
    // matches Pass-4's tsTypedClassLocal narrowing. Only applies when
    // the existing init type is `Instance` or a supertype of the
    // narrowing — never widen a more-specific oracle resolution
    // (`Instance.new("Part", ...)` already returns Part — don't widen
    // to BasePart).
    if (
      ctx.compatMode === 'rbxts'
      && initExpr
      && init
      && initIsOracleTyped(init, ctx)
      && !v.annotation
    ) {
      const narrowed = ctx.instanceNarrowings.get(v.name);
      if (narrowed) {
        // Look at the existing resolved class. Skip the wrap when the
        // init already resolves to a class that's more-specific-or-equal
        // to the narrowing target.
        let existingClass: string | undefined;
        if (
          init.type === 'Call'
          && init.func.type === 'IndexName'
          && INSTANCE_LOOSE_METHODS.has(init.func.index)
        ) {
          const loose = resolveLooseMethodCastType(init, ctx);
          if (loose.kind === 'class') {
            existingClass = loose.text.replace(/\s*\|\s*undefined\s*$/, '');
          }
        }
        if (!existingClass) existingClass = resolveOracleClassOfExpr(init, ctx);
        const shouldWrap =
          !existingClass
          || existingClass === 'Instance'
          || (existingClass !== narrowed && ctx.oracle.isA(narrowed, existingClass));
        if (shouldWrap) {
          initExpr = factory.createAsExpression(
            factory.createAsExpression(
              initExpr,
              factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
            ),
            factory.createTypeReferenceNode(narrowed, undefined),
          );
        }
      }
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
      ctx.noteDeclaredType(v.name, v.annotation);
    } else {
      // rbxts: materialize observed structural shape as the annotation;
      // bare `let x` / `let x = nil` fall back to `unknown` so writes don't trip TS7034.
      let typeNode: ts.TypeNode | undefined = v.annotation ? compileType(v.annotation) : undefined;
      // `local x: any` carries no type; let the untyped path handle it.
      if (typeNode && typeNode.kind === ts.SyntaxKind.UnknownKeyword && ctx.compatMode === 'rbxts') typeNode = undefined;
      let declaredDyn = false;
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
              initExpr = !init || tsVisibleType(init, ctx) === 'unknown'
                ? factory.createAsExpression(inner, typeNode)
                : assertExpression(inner, typeNode);
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
        // Calls without oracle resolution also produce `unknown` TS-side —
        // a synthesized shape annotation surfaces the local's downstream
        // member access for free.
        // Pass 3: don't shape-narrow when the init is a require with a
        // cached return type. The require's own `as unknown as <cached>`
        // already provides the full module shape (including cross-script
        // promotions); narrowing to observed members only adds a second
        // `as unknown as <subset>` cast for no benefit, and the subset
        // misses any methods the consumer hasn't called yet.
        const initIsCachedRequire =
          !!init
          && init.type === 'Call'
          && init.func.type === 'Global'
          && init.func.name === 'require'
          && !!resolveRequireReturnType(init.args[0], ctx);
        // Empty-or-dict table inits (`local t = {}`, `local t = {k=v}`)
        // qualify too: the observed-shape collector has full visibility
        // into how the table is used after init, and synthesizing a
        // declared type means downstream bracket / property access
        // skips the Record bridge.
        const initIsEmptyOrDictTable =
          !!init
          && init.type === 'Table'
          && (init as { items: { key: Expr | null }[] }).items
            .every((it) => !it.key || it.key.type === 'ConstantString');
        // Inits TS already types concretely (datatype factories, `vector`
        // library results, trusted primitives) must not be re-annotated
        // with an observed shape — `const v: { x: unknown } = vector.create(...)`
        // throws away the real type and forces casts on every use.
        const initIsTsTyped =
          !!init && (
            (isTrustedTypedExpr(init, ctx) && staticTypeOfExpr(init, ctx) !== 'unknown')
            || !!declaredAnnotationOfExpr(init, ctx)
          );
        const initIsShapelyCandidate =
          !initHasOracleType && !initIsCachedRequire && !initIsTsTyped && (
            !init
            || init.type === 'ConstantNil'
            || init.type === 'Local'
            || init.type === 'Global'
            || init.type === 'IndexName'
            || init.type === 'IndexExpr'
            || (init.type === 'Call' && !resolveOracleClassOfExpr(init, ctx))
            || initIsEmptyOrDictTable
          );
        if (initIsShapelyCandidate) {
          const inferred = ctx.getShape(v.name) as
            | import('./shape-infer.js').Shape
            | undefined;
          // A shape that pins a Roblox class (`& Instance`, `& Player`,
          // Vector3) keeps the typed API surface. Anything else is a
          // Luau value with no type information: declare `_LuauValue`
          // once and let every read, index and arithmetic go direct.
          const classShape = !!inferred && !inferred.empty && !!intersectionTypeName(inferred);
          // A `_LuauChild` init (dynamic Instance child, uncached require)
          // keeps its callable/indexable alias — `_LuauValue` would lose
          // the call signature those values rely on.
          const keepChild = !!init && !initIsNil && exprEmitsLuauChild(init, ctx);
          const useDyn = !classShape && !keepChild
            && !ctx.backpropInstanceLocals.has(v.name)
            && !ctx.instanceNarrowings.has(v.name);
          const fromShape = inferred && !useDyn ? shapeToTypeNode(inferred) : null;
          if (useDyn) {
            const initSeen = init && !initIsNil ? tsVisibleType(init, ctx) : 'unknown';
            if (initExpr && !initIsNil && initSeen === 'dyn') {
              // TS infers `_LuauValue` from the init itself.
            } else if (init && init.type === 'Table' && init.items.length === 0) {
              typeNode = dynTypeNode();
              initExpr = factory.createAsExpression(factory.createObjectLiteralExpression([], false), dynTypeNode());
            } else {
              typeNode = dynTypeNode();
              if (initExpr && !initIsNil) initExpr = dynCoerce(initExpr, init, ctx);
              else initExpr = undefined;
            }
            declaredDyn = true;
          } else if (!fromShape) {
            if (!initExpr || initIsNil) typeNode = factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);
          } else {
            ctx.tsShapeTypedLocal.add(v.name);
            ctx.tsPass6ShapeLocal.add(v.name);
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
        initExpr = assertExpression(inner, factory.createTypeReferenceNode('Instance', undefined));
      }
      // Annotated Instance-class local: the annotation is the TS type.
      // Register the class for the member-access gates and bridge inits
      // TS types wider than it (`WaitForChild` → Instance) or as unknown.
      const annotatedClass = oracleClassOfAnnotation(v.annotation, ctx);
      if (ctx.compatMode === 'rbxts' && annotatedClass) {
        ctx.tsTypedClassLocal.set(v.name, annotatedClass.name);
        if (annotatedClass.nullable) ctx.tsOptionalClassLocal.add(v.name);
        else ctx.tsOptionalClassLocal.delete(v.name);
        ctx.tsLuauChildLocal.delete(v.name);
        if (initExpr && init && !initIsNil && typeNode && !initFitsAnnotatedClass(init, annotatedClass.name, ctx)) {
          const alreadyCast =
            ts.isAsExpression(initExpr)
            && ts.isTypeReferenceNode(initExpr.type)
            && ts.isIdentifier(initExpr.type.typeName)
            && initExpr.type.typeName.text === annotatedClass.name;
          if (!alreadyCast) initExpr = assertExpression(initExpr, typeNode);
        }
      }
      // rbxts: shape-typed local without init needs `!` (definite assignment) to avoid TS2454.
      const needsDefiniteAssertion =
        ctx.compatMode === 'rbxts'
        && !initExpr
        && typeNode !== undefined
        && typeNode.kind !== ts.SyntaxKind.UnknownKeyword
        && !(v.annotation && annotationIsNilable(v.annotation));
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
      ctx.noteDeclaredType(v.name, v.annotation);
      const emittedDyn = !!typeNode && ts.isTypeReferenceNode(typeNode)
        && ts.isIdentifier(typeNode.typeName) && typeNode.typeName.text === DYN_VALUE_TYPE;
      if (declaredDyn && (emittedDyn || !typeNode)) ctx.noteDeclaredTypeKind(v.name, 'dyn');
      // `const n = q.count * 2`: TS infers `number` for the binding from
      // the init regardless of const-ness; record it so later uses and
      // writes of `n` see a primitive.
      if (!v.annotation && !declaredDyn && init && !typeNode && ctx.compatMode === 'rbxts') {
        const seen = tsVisibleType(init, ctx);
        if (seen === 'number' || seen === 'string' || seen === 'boolean' || seen === 'dyn' || isDatatypeStatic(seen)) {
          ctx.noteDeclaredTypeKind(v.name, seen);
        }
      }
      // `local c = zeroControls()` / `local mut = s.mut`: TS infers the
      // init's declared type for the binding, so track it as if it had
      // been written on the local.
      if (!v.annotation && !declaredDyn && init && ctx.compatMode === 'rbxts') {
        const inherited = declaredAnnotationOfExpr(init, ctx);
        if (inherited) bindDeclaredAnnotation(v.name, inherited, ctx);
      }
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
      // Datatype inits (`Vector3.new`, `vector.create`, trusted member
      // reads) keep their inferred TS type through reassignment too —
      // TS widens `let` bindings only to the init's own type.
      // Skipped when local-type inference already emitted a primitive
      // annotation for this binding — that annotation is what TS sees,
      // and claiming a datatype here would dispatch `.add()`/`.mul()`
      // against a `number`-typed declaration.
      if (
        ctx.compatMode === 'rbxts'
        && init
        && !v.annotation
        && !ctx.tsTypedPrimitiveLocal.has(v.name)
        && isTrustedTypedExpr(init, ctx)
      ) {
        const t = staticTypeOfExpr(init, ctx);
        if (isDatatypeStatic(t)) ctx.noteDeclaredTypeKind(v.name, t);
      }
      // Class-typed: even when the local is reassigned, the TS-inferred
      // class survives — suppress the reassign shape-cast so the
      // synthesized literal doesn't clash with the declared class.
      if (ctx.compatMode === 'rbxts' && init && initIsOracleTyped(init, ctx)) {
        // For loose-Instance method Calls, the EMITTED type is what
        // resolveLooseMethodCastType returns (e.g. `Instance | undefined`
        // for 2-arg WaitForChild) — not the optimistic name-resolved class.
        // Use the emit's class so downstream signal-event checks don't see
        // `Humanoid.Died` when TS sees `hum: Instance`.
        let className: string | undefined;
        if (
          init.type === 'Call'
          && init.func.type === 'IndexName'
          && INSTANCE_LOOSE_METHODS.has(init.func.index)
        ) {
          const loose = resolveLooseMethodCastType(init, ctx);
          if (loose.kind === 'class' && !isLuauChildTypeText(loose.text)) {
            className = loose.text.replace(/\s*\|\s*undefined\s*$/, '');
          }
        }
        if (!className) {
          className = resolveOracleClassOfExpr(init, ctx) ?? 'Instance';
        }
        // Pass 4: prefer the narrowed subclass when observed member
        // accesses fit a single Instance subclass.
        const narrowed = ctx.instanceNarrowings.get(v.name);
        if (narrowed) {
          // Only narrow if the original is Instance or a supertype of
          // the narrowed class — avoid widening from FindFirstChildOfClass-
          // resolved specific classes.
          if (className === 'Instance' || ctx.oracle.isA(narrowed, className)) {
            className = narrowed;
          }
        }
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
      // Pass 2: require() with cached return shape — track as shape-typed
      // so downstream `.X` access skips Record routing (the synth
      // structural type covers each field).
      if (
        ctx.compatMode === 'rbxts'
        && init
        && init.type === 'Call'
        && init.func.type === 'Global'
        && init.func.name === 'require'
        && resolveRequireReturnType(init.args[0], ctx)
      ) {
        ctx.tsShapeTypedLocal.add(v.name);
        // Register recordMap fields for this local so bracket access on
        // `<localName>.<recordMapField>` skips the Record bridge.
        const path = resolveRequirePath(init.args[0]!, ctx.currentScriptPath);
        if (path) {
          ctx.requireBoundLocals.set(v.name, path);
          const fields = ctx.moduleRecordMapFields.get(path);
          if (fields && fields.length > 0) {
            ctx.recordMapFields.set(v.name, new Set(fields));
          }
        }
      }
      if (
        ctx.compatMode === 'rbxts'
        && init
        && exprEmitsLuauChild(init, ctx)
        && !initIsOracleTyped(init, ctx)
        // Track only locals whose init expression *itself* gets emitted as
        // `_LuauChild` — require() calls and dynamic-root chains. Binary
        // expressions like `hit && hit.Parent` propagate through
        // `exprEmitsLuauChild` but the actual emit is `hit && X` with no
        // `as _LuauChild` cast, so the local's TS type isn't `_LuauChild`
        // and downstream method-call gates can't trust the tracker.
        && initEmitsLuauChildDirectly(init, ctx)
      ) {
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
  const { params, typeParams, returnType, body } = compileFunctionShape(
    stat.func,
    ctx,
    { enclosingName: stat.name.name },
  );
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
      // Reuse the parameters the expression compile produced: the body
      // was compiled against them (rebound `_LuauValue` params included),
      // and a second inference here could disagree.
      ts.isFunctionExpression(fn) || ts.isArrowFunction(fn)
        ? fn.parameters
        : paramsFromLocals(stat.func.args, ctx, declShapes, undefined, stat.name.name),
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
  // rbxts: an `unknown`-typed bound (`for i = 1, n` with untyped `n`)
  // leaves `i` itself `unknown` and trips TS2365 on the `<=` guard.
  // Bridge each bound to number unless TS already sees it as one.
  const numberBound = (luau: Expr): ts.Expression => {
    const compiled = compileExpr(luau, ctx);
    if (ctx.compatMode !== 'rbxts' || tsSeesNumber(luau, ctx)) return compiled;
    return factory.createParenthesizedExpression(
      assertExpression(compiled, factory.createKeywordTypeNode(ts.SyntaxKind.NumberKeyword)),
    );
  };
  const fromExpr = numberBound(stat.from);
  const toExpr = numberBound(stat.to);
  const stepExpr = stat.step ? numberBound(stat.step) : null;

  const prevBinding = ctx.snapshotBinding(stat.var.name);
  const body = ctx.withScope(() => {
    ctx.defineLocal(stat.var.name, 'number');
    ctx.noteDeclaredTypeKind(stat.var.name, 'number');
    const inner = compileBlockBody(stat.body, ctx);
    ctx.restoreBinding(stat.var.name, prevBinding);
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
      case 'If': {
        // Gap 1: `if x:IsA("Class") then …` narrows x to Class inside
        // the body via TS's predicate. Skip the unsafe-member check on
        // the then-body AND on the post-AND condition tail when the
        // guard names a known class.
        const narrowed = isaGuardClassFor(statNode.condition, valueLocal, ctx);
        if (narrowed) {
          // Skip both condition AND then-body — TS narrows x throughout.
        } else {
          visitExpr(statNode.condition);
          visitStat(statNode.thenBody);
        }
        visitStat(statNode.elseBody);
        return;
      }
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

/** Return the class name `x:IsA("Y")` narrows `x` to, or null if the
 *  condition isn't an IsA guard on the named local. Recurses into
 *  `and`-chains so `x:IsA("Y") and other_check` still narrows. */
function isaGuardClassFor(cond: Expr, localName: string, ctx: CompileContext): string | null {
  if (cond.type === 'Group') return isaGuardClassFor(cond.expr, localName, ctx);
  if (cond.type === 'Binary' && cond.op === 'and') {
    return isaGuardClassFor(cond.left, localName, ctx)
      ?? isaGuardClassFor(cond.right, localName, ctx);
  }
  if (cond.type === 'Call'
      && cond.self
      && cond.func.type === 'IndexName'
      && cond.func.index === 'IsA'
      && cond.func.expr.type === 'Local'
      && cond.func.expr.name === localName
      && cond.args.length === 1
      && cond.args[0]?.type === 'ConstantString') {
    const className = (cond.args[0] as { value: string }).value;
    if (ctx.oracle.isClass(className)) return className;
  }
  return null;
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
    // Iterating an annotated array (`for _, c in ipairs(cars)` with
    // `cars: {Car}`): the element type is declared, so the value var
    // carries it and the iterable needs no cast at all.
    const declaredElement = (() => {
      if (userWantsPairs) return null;
      const iter = iterableSource ?? (stat.values.length === 1 ? stat.values[0]! : null);
      if (!iter) return null;
      const ann = declaredAnnotationOfExpr(iter, ctx);
      const table = ann ? ctx.resolveAlias(ann) : null;
      if (!table || table.type !== 'TypeTable' || table.props.length > 0 || !table.indexer) return null;
      if (table.indexer.indexType.type !== 'TypeReference' || table.indexer.indexType.name !== 'number') return null;
      return table.indexer.resultType;
    })();
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
    // Pass 5: per-var synthesized shape annotations. Apply only when
    // the iterable wasn't already class-narrowed (`canUseClassElement`)
    // — the oracle-class beats our synthesized shape every time.
    const loopVarTypeMap = !canUseClassElement
      ? (ctx.loopVarTypes.get(stat as unknown) as Map<string, ts.TypeNode> | undefined)
      : undefined;
    const prevBindings = stat.vars.map((v) => ctx.snapshotBinding(v.name));
    const bodyStatements = ctx.withScope(() => {
      stat.vars.forEach((v, i) => {
        // `for i, v in ipairs(t)` — @rbxts/types declares the ipairs
        // index slot as `number`, so TS sees `i: number` directly.
        const isIpairsIndex = !userWantsPairs && stat.vars.length >= 2 && i === 0;
        const isValueSlot = stat.vars.length === 1 ? i === 0 : i === 1;
        if (declaredElement && isValueSlot) {
          ctx.defineLocal(v.name, typeFromAnnotation(ctx.resolveAlias(declaredElement)));
          bindDeclaredAnnotation(v.name, declaredElement, ctx);
          return;
        }
        ctx.defineLocal(v.name, isIpairsIndex ? 'number' : 'unknown');
        // Untyped slots destructure as `_LuauValue` (see tupleSlot /
        // elementType below) unless Pass 5 synthesized a class or shape.
        const pass5 = loopVarTypeMap?.get(v.name);
        const dynSlot = !isIpairsIndex && !pass5 && !(canUseClassElement && isValueSlot);
        ctx.noteDeclaredTypeKind(v.name, isIpairsIndex ? 'number' : dynSlot ? 'dyn' : undefined);
      });
      // When the iterable's element resolves to a class, the value-binding
      // (second var for two-binding `for k, v in ipairs(arr)`, first var
      // for single-binding) emits as that class in TS. Mirror that into
      // tsTypedClassLocal so method-call gates (`receiverClassForMethod`,
      // `signalReceiverIsTypedEvent`) see the same class TS sees — without
      // this, `c:IsA("BasePart")` Record-routes despite `c: Instance`.
      if (canUseClassElement && elementFact?.kind === 'class') {
        const valueVar = stat.vars.length === 1 ? stat.vars[0]! : stat.vars[1];
        if (valueVar) ctx.tsTypedClassLocal.set(valueVar.name, elementFact.name);
      }
      // Mark Pass-5 typed vars as shape-typed so downstream member-access
      // gates skip the Record routing path.
      const trackedShapeVars: string[] = [];
      if (loopVarTypeMap) {
        for (const v of stat.vars) {
          const synth = loopVarTypeMap.get(v.name);
          // A synthesized `unknown` is no shape at all — marking the var
          // shape-typed would let bracket access skip the Record bridge
          // and surface TS18046 on the destructured binding.
          if (synth && synth.kind !== ts.SyntaxKind.UnknownKeyword) {
            ctx.tsShapeTypedLocal.add(v.name);
            trackedShapeVars.push(v.name);
          }
        }
      }
      const compiled = compileBlockBody(stat.body, ctx);
      for (const n of trackedShapeVars) ctx.tsShapeTypedLocal.delete(n);
      stat.vars.forEach((v, i) => ctx.restoreBinding(v.name, prevBindings[i]!));
      return compiled;
    });
    // Cast to `Array<any>` so the destructured element is `any` (not
    // `unknown`, which trips TS18046 on every body access). Route through
    // `unknown` so record-shaped sources don't trip TS2352.
    //
    let elementType: ts.TypeNode;
    if (declaredElement) {
      elementType = compileType(declaredElement);
    } else if (canUseClassElement && elementFact) {
      elementType = typeNodeForFlowFact(elementFact) ?? factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);
    } else if (useDynamicChildElement) {
      ctx.useLuauChildType();
      elementType = factory.createTypeReferenceNode('_LuauChild', undefined);
    } else {
      elementType = dynTypeNode();
    }
    const castedIterable = declaredElement
      ? iterableExpr
      : assertExpression(iterableExpr, factory.createArrayTypeNode(elementType));
    if (stat.vars.length === 1) {
      // `for v in arr do` — single binding, value-only iteration.
      // Pass 5: when we have a synthesized type for this var, annotate
      // the destructure variable directly. TS narrows the binding to
      // the named type and downstream `.X.Y` access skips Record
      // routing without changing the iterable's element type.
      const singleVarName = stat.vars[0]!.name;
      const singleVarType = loopVarTypeMap?.get(singleVarName);
      return [
        factory.createForOfStatement(
          undefined,
          factory.createVariableDeclarationList(
            [factory.createVariableDeclaration(
              factory.createIdentifier(forInNames[0]!),
              undefined,
              singleVarType,
              undefined,
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
          ? (() => {
              const src = iterableSource ?? (stat.values.length === 1 ? stat.values[0]! : null);
              const compiledSrc = src
                ? compileExpr(src, ctx)
                : factory.createArrayLiteralExpression(stat.values.map((v) => compileExpr(v, ctx)));
              // `pairs()` wants an object; a `_LuauValue` source already
              // is one, anything else bridges through `_LuauValue`.
              return src && isDynExpr(src, ctx) ? compiledSrc : assertExpression(compiledSrc, dynTypeNode());
            })()
          : castedIterable,
      ],
    );
    // Pass 5: replace the matching tuple slots with the loop-var's
    // synthesized type so the destructure binding picks them up
    // directly. For ipairs the first slot is the numeric index; for
    // pairs the first slot is the key (string or arbitrary), so it
    // stays `unknown` unless Pass 5 synthesized a type for it.
    const tupleSlot = (i: number): ts.TypeNode => {
      const v = stat.vars[i];
      if (declaredElement && i === 1) return compileType(declaredElement);
      const text = v ? loopVarTypeMap?.get(v.name) : undefined;
      if (text) return text;
      if (i === 0 && !userWantsPairs) {
        return factory.createKeywordTypeNode(ts.SyntaxKind.NumberKeyword);
      }
      return dynTypeNode();
    };
    // Keep the iterable typed as tuple entries. A bare `any` iterable
    // makes roblox-ts assert when lowering the binding pattern. On the
    // ipairs path, we need the tuple cast too when Pass 5 contributes a
    // var type — otherwise the destructure pulls the element type from
    // the upstream `Array<_LuauChild>` and `tsShapeTypedLocal` would
    // mislead downstream gates into skipping Record routing without an
    // actual narrowed type.
    const needsTupleCast = userWantsPairs || (loopVarTypeMap && loopVarTypeMap.size > 0);
    const iterableForFor: ts.Expression = needsTupleCast
      ? assertExpression(
          iterCall,
          factory.createArrayTypeNode(factory.createTupleTypeNode([
            tupleSlot(0),
            tupleSlot(1),
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
  /** The Luau expression `valueExpr` was compiled from, when the caller
   *  has it. Lets the declared-slot bridges below skip a cast the
   *  emitted value already satisfies. */
  valueSource?: Expr,
): ts.Statement {
  const valueSeenAs = (): StaticValueType =>
    valueSource ? tsVisibleType(valueSource, ctx) : 'unknown';
  // `_LuauValue` slots — a dyn local, or a member / index of one — take
  // the value directly once it is bridged to `_LuauValue`.
  if (ctx.compatMode === 'rbxts') {
    const dynTarget =
      (target.type === 'Local' && ctx.tsDynLocal.has(target.name))
      || ((target.type === 'IndexName' || target.type === 'IndexExpr') && isDynExpr(target.expr, ctx))
      || (target.type === 'IndexName' && shapeLeafIsDyn(target, ctx));
    if (dynTarget) {
      const rhs = dynCoerce(valueExpr, valueSource, ctx);
      if (target.type === 'IndexExpr') {
        const keyLuau = target.index;
        const compiledKey = compileExpr(keyLuau, ctx);
        const keySeen = tsVisibleType(keyLuau, ctx);
        const key = keySeen === 'string' || keySeen === 'number' || keySeen === 'dyn'
          || keyLuau.type === 'ConstantString' || keyLuau.type === 'ConstantNumber' || keyLuau.type === 'ConstantInteger'
          ? compiledKey
          : assertExpression(compiledKey, factory.createKeywordTypeNode(ts.SyntaxKind.StringKeyword));
        return factory.createExpressionStatement(
          factory.createAssignment(factory.createElementAccessExpression(compileExpr(target.expr, ctx), key), rhs),
        );
      }
      if (target.type === 'IndexName') {
        return factory.createExpressionStatement(
          factory.createAssignment(
            factory.createPropertyAccessExpression(compileExpr(target.expr, ctx), factory.createIdentifier(propertyName(target.index))),
            rhs,
          ),
        );
      }
      return factory.createExpressionStatement(
        factory.createAssignment(factory.createIdentifier(ctx.getLocalJsName(target.name) ?? safeIdentifier(target.name)), rhs),
      );
    }
  }
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
      if (ctx.compatMode === 'rbxts' && target.expr.type === 'Local' && ctx.tsArrayTypedLocal.has(target.expr.name)) {
        const element = ctx.tsArrayTypedLocal.get(target.expr.name) ?? null;
        const elementStatic = typeFromAnnotation(ctx.resolveAlias(element));
        const rhsMatches = elementStatic !== 'unknown'
          && (valueSeenAs() === elementStatic || isTsExpressionOfStatic(valueExpr, elementStatic));
        return factory.createExpressionStatement(
          factory.createAssignment(
            factory.createElementAccessExpression(recv, lit),
            rhsMatches ? valueExpr : assertExpression(valueExpr, compileType(element)),
          ),
        );
      }
      // rbxts: chained LHS `obj[k][N] = v` — recast inner receiver through
      // Record so the literal-index assignment slot accepts the RHS.
      if (
        ctx.compatMode === 'rbxts'
        && (target.expr.type === 'IndexExpr' || target.expr.type === 'IndexName')
      ) {
        recv = factory.createParenthesizedExpression(
          assertExpression(
            recv,
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
      // The recordMap-field skip is not applied in the write path because
      // Pass 2's `Record<string, defined | undefined>` value type can't
      // accept an `unknown`-typed RHS (e.g. pcall destructured profile).
      // Pass 6: when target is a Local whose synthesized shape already
      // carries `[k: string]: unknown` (observed bracket access), the
      // declared type accepts the bracket assignment directly.
      if (target.expr.type === 'Local' && ctx.tsArrayTypedLocal.has(target.expr.name) && tsSeesNumber(indexExpr, ctx)) {
        const element = ctx.tsArrayTypedLocal.get(target.expr.name) ?? null;
        const elementStatic = typeFromAnnotation(ctx.resolveAlias(element));
        const rhsMatches = elementStatic !== 'unknown'
          && (valueSeenAs() === elementStatic || isTsExpressionOfStatic(valueExpr, elementStatic));
        // `t[i] = nil` clears the slot; roblox-ts lowers `undefined` to
        // `nil`, so the element cast only keeps TS quiet about it.
        const rhs = rhsMatches ? valueExpr : assertExpression(valueExpr, compileType(element));
        return factory.createExpressionStatement(
          factory.createAssignment(
            factory.createElementAccessExpression(
              compileExpr(target.expr, ctx),
              zeroBasedIndex(compileExpr(indexExpr, ctx)),
            ),
            rhs,
          ),
        );
      }
      const targetAlreadyIndexed = localShapeHasStringIndexSig(target.expr, ctx);
      const recv = targetAlreadyIndexed
        ? compileExpr(target.expr, ctx)
        : factory.createParenthesizedExpression(
            assertExpression(
              compileExpr(target.expr, ctx),
              factory.createTypeReferenceNode('Record', [
                factory.createKeywordTypeNode(ts.SyntaxKind.StringKeyword),
                factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
              ]),
            ),
          );
      const key = assertExpression(compileExpr(indexExpr, ctx), factory.createKeywordTypeNode(ts.SyntaxKind.StringKeyword));
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
  if (
    ctx.compatMode === 'rbxts'
    && target.type === 'IndexName'
  ) {
    const field = declaredAnnotationOfExpr(target, ctx);
    const want = field ? typeFromAnnotation(ctx.resolveAlias(field)) : 'unknown';
    if (field && want !== 'unknown' && valueSeenAs() !== want && !isTsExpressionOfStatic(valueExpr, want)) {
      return factory.createExpressionStatement(
        factory.createAssignment(compileLValue(target, ctx), assertExpression(valueExpr, compileType(field))),
      );
    }
  }
  return factory.createExpressionStatement(
    factory.createAssignment(compileLValue(target, ctx), valueExpr),
  );
}

/** True when the emitted expression is self-evidently of `want` — a
 *  literal, or an `as <want>` cast we just produced. Keeps the
 *  declared-field write path from stacking a redundant bridge. */
function isTsExpressionOfStatic(expr: ts.Expression, want: StaticValueType): boolean {
  let cur = expr;
  while (ts.isParenthesizedExpression(cur)) cur = cur.expression;
  if (ts.isAsExpression(cur)) {
    const t = cur.type;
    if (want === 'number' && t.kind === ts.SyntaxKind.NumberKeyword) return true;
    if (want === 'string' && t.kind === ts.SyntaxKind.StringKeyword) return true;
    if (want === 'boolean' && t.kind === ts.SyntaxKind.BooleanKeyword) return true;
    if (isDatatypeStatic(want) && ts.isTypeReferenceNode(t) && ts.isIdentifier(t.typeName)) {
      return t.typeName.text === want.slice('datatype:'.length);
    }
    return false;
  }
  if (want === 'number') return ts.isNumericLiteral(cur);
  if (want === 'string') return ts.isStringLiteral(cur) || ts.isTemplateExpression(cur);
  if (want === 'boolean') return cur.kind === ts.SyntaxKind.TrueKeyword || cur.kind === ts.SyntaxKind.FalseKeyword;
  return false;
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
    // Pass 1: synthesized dynamic-root cast wins over `_LuauChild`.
    if (inner.type === 'Global' && ctx.scriptParentRootTypes.has(inner.name)) {
      const synthType = ctx.scriptParentRootTypes.get(inner.name) as ts.TypeNode;
      const wrapped = factory.createParenthesizedExpression(
        factory.createAsExpression(compileExpr(inner, ctx), synthType),
      );
      return factory.createPropertyAccessExpression(
        wrapped,
        factory.createIdentifier(propertyName(expr.index)),
      );
    }
    // Shape-typed local: the local's declared annotation already exposes
    // the accessed member, so skip the `_LuauChild` bridge.
    if (inner.type === 'Local' && ctx.tsShapeTypedLocal.has(inner.name)) {
      return factory.createPropertyAccessExpression(
        compileExpr(inner, ctx),
        factory.createIdentifier(propertyName(expr.index)),
      );
    }
    // Gap 3: `self` (→ `this`) in class methods is typed as the class.
    // Class fields are resolved via the class declaration; skip the
    // `_LuauChild` bridge. Gating on ctx.selfFieldShapes (set by
    // class-shape's method compile loop) ensures we only fire inside
    // recognized class method bodies.
    if (inner.type === 'Local' && inner.name === 'self' && ctx.selfFieldShapes) {
      return factory.createPropertyAccessExpression(
        compileExpr(inner, ctx),
        factory.createIdentifier(propertyName(expr.index)),
      );
    }
    ctx.useLuauChildType();
    const wrapped = factory.createParenthesizedExpression(
      assertExpression(
        compileExpr(inner, ctx),
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
      || target.expr.type === 'IndexExpr'
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
      if (declaredAnnotationOfExpr(target, ctx)) {
        return factory.createPropertyAccessExpression(
          compileExpr(target.expr, ctx),
          factory.createIdentifier(propertyName(target.index)),
        );
      }
      if (
        target.expr.type === 'Local'
        && ctx.tsTypedClassLocal.has(target.expr.name)
        && !ctx.tsLuauChildLocal.has(target.expr.name)
      ) {
        const cls = ctx.tsTypedClassLocal.get(target.expr.name)!;
        const propType = ctx.oracle.propertyType(cls, target.index);
        const isSimpleRaw =
          propType?.kind === 'raw'
          && /^[A-Z][\w.]*(?:<[^()=]+>)?$/.test(propType.text);
        if (
          propType
          && (propType.kind === 'class'
              || isSimpleRaw
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
      // Pass 1: when the chain is rooted in a synthesized dynamic root,
      // the structural typing covers the assignment slot (assigned leaves
      // are typed `defined` so any RHS satisfies the slot).
      if (chainRootedInSynthesizedDynamic(target.expr, ctx)) {
        return factory.createPropertyAccessExpression(
          receiverExpr,
          factory.createIdentifier(propertyName(target.index)),
        );
      }
      // Shape-typed Local target whose field shape is leaf (empty) —
      // shapeToTypeNode emits the field as `unknown` which accepts any
      // RHS. Plain `.X = Y` typechecks without the Record bridge.
      // Skip when the field has a nested shape (Disconnect/Connect etc.)
      // since those narrower types may reject undefined/unknown writes.
      // Also skip when the local's shape intersects with a real class
      // (e.g. `{ Team: unknown } & Player`) — the intersection narrows
      // the field to the class's declared type, which may reject the
      // RHS. Handles both `local.X = Y` and `local.A.B...X = Y` by
      // walking the IndexName chain to its Local root.
      {
        let rootLocal: { name: string } | null = null;
        const path: string[] = [target.index];
        let cur: Expr = target.expr;
        while (cur.type === 'IndexName' && cur.op === '.') {
          path.unshift(cur.index);
          cur = cur.expr;
        }
        if (cur.type === 'Local') rootLocal = cur as { name: string };
        if (
          rootLocal
          && ctx.tsShapeTypedLocal.has(rootLocal.name)
          && !ctx.tsTypedClassLocal.has(rootLocal.name)
        ) {
          let curShape = ctx.getShape(rootLocal.name) as
            | { props?: Map<string, { empty?: boolean; props?: Map<string, unknown>; methods?: Map<string, unknown> }> }
            | undefined;
          const rootIntersects = shapeHasClassIntersection(curShape);
          let leafEmpty = false;
          let intermediateOk = true;
          for (let i = 0; i < path.length && curShape; i++) {
            const fname = path[i]!;
            const next = curShape.props?.get(fname);
            if (!next) { intermediateOk = false; break; }
            if (i === path.length - 1) {
              leafEmpty = !!next.empty;
            } else {
              if (shapeHasClassIntersection(next as { props?: Map<string, unknown>; methods?: Map<string, unknown> })) {
                intermediateOk = false; break;
              }
            }
            curShape = next as typeof curShape;
          }
          if (leafEmpty && intermediateOk && !rootIntersects) {
            return factory.createPropertyAccessExpression(
              receiverExpr,
              factory.createIdentifier(propertyName(target.index)),
            );
          }
        }
      }
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
      ? assertExpression(rawRhs, assignmentTupleType)
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
        const propTypeNode = factory.createTypeReferenceNode(propType.name, undefined);
        // Skip the cast when RHS's resolved class matches the prop's
        // declared class — `lbl.Size = new UDim2(...)` doesn't need
        // `... as unknown as UDim2` because `new UDim2(...)` already
        // returns UDim2. The constructor / static-factory macros emit
        // the value already typed as the class. Also skip when RHS's
        // class is a subtype of the prop class (TS handles the downcast):
        // `panel.Parent = script` is fine without `script as Instance`.
        const rhsClass = resolveOracleClassOfExpr(value, ctx);
        // Static type can be a `datatype:Vector3` etc — match against
        // the prop's class name to avoid double-casting when compileExpr
        // already emitted the same type cast on the chain.
        const rhsStatic = staticTypeOfExpr(value, ctx);
        const rhsDatatypeMatch = typeof rhsStatic === 'string'
          && rhsStatic === `datatype:${propType.name}`;
        if (
          rhsDatatypeMatch
          || (rhsClass && (rhsClass === propType.name || ctx.oracle.isA(rhsClass, propType.name)))
        ) {
          // valueExpr stays as the constructor result — TS sees it as
          // the declared class.
        } else if (isBareUnknownTyped(value, ctx)) {
          // RHS is `unknown`-typed (param, GetAttribute, etc.); single
          // narrowing cast suffices, no bridge needed.
          valueExpr = factory.createAsExpression(valueExpr, propTypeNode);
        } else {
          valueExpr = assertExpression(valueExpr, propTypeNode);
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
          valueExpr = assertExpression(inner, primNode);
        }
      } else if (
        propType?.kind === 'raw'
        && /^[A-Z][\w.]*(?:<[^()=]+>)?$/.test(propType.text)
      ) {
        // Raw types that look like a simple TypeReference (Enum.Material,
        // AttributeValue, etc) — bridge through `unknown` to satisfy TS.
        // Skip the cast when RHS already names the same enum (e.g. RHS is
        // `Enum.Material.Neon`, prop is `Enum.Material` — TS accepts the
        // assignment directly).
        const rawRoot = propType.text.split('.')[0];
        const rhsIsSameEnum =
          value.type === 'IndexName'
          && rawRoot === 'Enum'
          && extractEnumRoot(value) === propType.text;
        if (!rhsIsSameEnum) {
          const inner = ts.isBinaryExpression(valueExpr) || ts.isConditionalExpression(valueExpr)
            ? factory.createParenthesizedExpression(valueExpr)
            : valueExpr;
          valueExpr = assertExpression(inner, factory.createTypeReferenceNode(propType.text, undefined));
        }
      }
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
            valueExpr = assertExpression(inner, primitiveTypeNode);
          }
        } else {
          // Non-primitive tracked (`unknown`, `datatype:X`) — `typeof <local>`
          // catches array-init and table-init locals, plus `x = nil` resets.
          // Skip the cast when RHS's resolved class matches the local's
          // tracked class AND the local isn't tracked as optional — TS
          // rejects `Instance | undefined` → `Instance` without the
          // bridge even if the class name agrees.
          const localCls = target.type === 'Local'
            ? ctx.tsTypedClassLocal.get(target.name)
            : undefined;
          const localIsOptional = target.type === 'Local'
            && ctx.tsOptionalClassLocal.has(target.name);
          const rhsCls = resolveOracleClassOfExpr(value, ctx);
          const rhsFact = flowFactOf(value, ctx);
          const rhsNullable =
            (rhsFact?.kind === 'class' && !!rhsFact.nullable)
            || (
              value.type === 'Call'
              && (value.func.type === 'Local' || value.func.type === 'Global')
              && ctx.userFunctionMayReturnNil.has((value.func as { name: string }).name)
            );
          // Skip when RHS class IS the local's class, OR RHS is a
          // subclass of the local's tracked class (Folder ⊂ Instance,
          // Player ⊂ Instance, BasePart ⊂ Instance, …). Without this,
          // a `let f: Instance | undefined; if (!f) f = Instance.new("Folder") end`
          // pattern emits `f = ... as typeof f`, widening the
          // narrower-subclass RHS back to `Instance | undefined` and
          // defeating TS's exit-narrowing on the if-branch — so the
          // function's return type stays `Instance | undefined` even
          // though the runtime guarantees non-undefined.
          const rhsIsSubclass = !!localCls
            && !!rhsCls
            && rhsCls !== localCls
            && ctx.oracle.isClass(rhsCls)
            && ctx.oracle.isClass(localCls)
            && ctx.oracle.isA(rhsCls, localCls);
          if (
            localCls && rhsCls
            && (rhsCls === localCls || rhsIsSubclass)
            && (localIsOptional || !rhsNullable)
          ) {
            valueExpr = inner;
          } else {
            valueExpr = assertExpression(
              inner,
              factory.createTypeQueryNode(
                factory.createIdentifier(safeIdentifier((target as { name: string }).name)),
              ),
            );
          }
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
      // Skip the second-pass typeof cast when valueExpr is already an
      // AsExpression — the inner pass put the right type on it.
      if (ts.isAsExpression(valueExpr)) {
        // No-op: the first-pass cast already converged.
      } else {
        valueExpr = assertExpression(
          inner,
          factory.createTypeQueryNode(factory.createIdentifier(safeIdentifier(target.name))),
        );
      }
    }
    // Non-literal numeric `tbl[k] = v` routes through luaIndexSet (plain
    // `=` would emit `luaIndex(tbl, k) = v`, not a valid lvalue).
    const writeStmt = buildAssignmentStatement(target, valueExpr, ctx, stat.values[i]);
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
        : compileBinary(stat.op, target, value, ctx, stat.var, stat.value);
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
  options: { allowImplicitSelf?: boolean; enclosingName?: string } = {},
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
  const prevDeclaredPrim = new Map(ctx.tsDeclaredTypeLocal);
  const prevDeclaredAnnotation = new Map(ctx.tsDeclaredAnnotation);
  const prevArrayTyped = new Map(ctx.tsArrayTypedLocal);
  const prevTsClass = new Set(ctx.tsTypedClassLocal.keys());
  const prevTsOptionalClass = new Set(ctx.tsOptionalClassLocal);
  const prevTsLuauChild = new Set(ctx.tsLuauChildLocal);
  const prevTsShapeTyped = new Set(ctx.tsShapeTypedLocal);
  const prevPass6Shape = new Set(ctx.tsPass6ShapeLocal);
  const prevDyn = new Set(ctx.tsDynLocal);
  // Pass 3: register backprop-typed params in `tsTypedClassLocal` so
  // downstream macros / receiver gates (Instance.new parent skip etc.)
  // see them as Instance/etc.
  const backpropMap = options.enclosingName
    ? ctx.paramBackpropTypes.get(options.enclosingName)
    : undefined;
  if (backpropMap) {
    for (const arg of realArgs) {
      const bound = backpropMap.get(arg.name);
      if (!bound) continue;
      // Only register known oracle classes (Instance, Player, etc.) —
      // datatype names like Vector3 aren't tsTypedClassLocal-shaped.
      if (ctx.oracle.isClass(bound) || bound === 'Instance') {
        ctx.tsTypedClassLocal.set(arg.name, bound);
      }
    }
  }
  for (const p of paramsFromLocals(realArgs, ctx, paramShapes, paramPrimitives, options.enclosingName)) {
    params.push(p);
  }
  const dynParams = new Set(lastDynParams);
  // A number constraint on a rebound param is no longer what TS sees.
  for (const n of dynParams) ctx.preInferredParamType.delete(n);
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
      const declaredPack = fn.returnAnnotation;
      const declaredTypes =
        declaredPack && declaredPack.type === 'TypePackExplicit'
          && !declaredPack.typeList.tailType
          && declaredPack.typeList.types.length === tupleArity
          ? declaredPack.typeList.types
          : null;
      // Undeclared components stay `unknown`: a literal `return "a", 1`
      // must satisfy them, and `_LuauValue` would reject it. The
      // destructuring side bridges to `_LuauValue` once.
      const componentTypes = Array.from({ length: tupleArity }, (_, i) =>
        declaredTypes ? compileType(declaredTypes[i]) : factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
      );
      returnType = factory.createTypeReferenceNode('LuaTuple', [
        factory.createTupleTypeNode(componentTypes),
      ]);
    }
  }

  ctx.returnAnnotationStack.push(fn.returnAnnotation);
  const innerStatements = ctx.withScope(() => {
    for (const arg of realArgs) {
      ctx.defineLocal(arg.name, typeFromAnnotation(arg.annotation));
      ctx.noteDeclaredType(arg.name, arg.annotation);
      const annotatedClass = oracleClassOfAnnotation(arg.annotation, ctx);
      if (ctx.compatMode === 'rbxts' && annotatedClass) {
        ctx.tsTypedClassLocal.set(arg.name, annotatedClass.name);
        if (annotatedClass.nullable) ctx.tsOptionalClassLocal.add(arg.name);
        else ctx.tsOptionalClassLocal.delete(arg.name);
      }
    }
    if (ctx.compatMode === 'rbxts') {
      for (const arg of realArgs) {
        const shape = paramShapes?.get(arg.name);
        // `p: any` compiles to `p: unknown` — no declared members to
        // preserve, so member reads must keep the Record bridge.
        const annotatedUnknown =
          !!arg.annotation && compileType(arg.annotation).kind === ts.SyntaxKind.UnknownKeyword;
        if (shape && !shape.empty && !annotatedUnknown && !dynParams.has(arg.name)) {
          ctx.tsShapeTypedLocal.add(arg.name);
          if (!arg.annotation && !ctx.preInferredParamType.has(arg.name)) ctx.tsPass6ShapeLocal.add(arg.name);
          else ctx.tsPass6ShapeLocal.delete(arg.name);
        } else {
          ctx.tsShapeTypedLocal.delete(arg.name);
          ctx.tsPass6ShapeLocal.delete(arg.name);
        }
      }
      for (const n of dynParams) ctx.noteDeclaredTypeKind(n, 'dyn');
    }
    if (fn.vararg) ctx.defineLocal('__varargs', 'unknown');
    if (hasSelf) ctx.defineLocal('self', 'unknown');
    const bodyStatements = [
      ...dynParamPrologue(realArgs.filter((a) => dynParams.has(a.name)).map((a) => a.name)),
      ...compileBlockBody(fn.body, ctx),
    ];
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
  ctx.returnAnnotationStack.pop();
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
  ctx.tsDeclaredTypeLocal.clear();
  for (const [k, v] of prevDeclaredPrim) ctx.tsDeclaredTypeLocal.set(k, v);
  ctx.tsDeclaredAnnotation.clear();
  for (const [k, v] of prevDeclaredAnnotation) ctx.tsDeclaredAnnotation.set(k, v);
  ctx.tsArrayTypedLocal.clear();
  for (const [k, v] of prevArrayTyped) ctx.tsArrayTypedLocal.set(k, v);
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
  for (const name of Array.from(ctx.tsPass6ShapeLocal)) {
    if (!prevPass6Shape.has(name)) ctx.tsPass6ShapeLocal.delete(name);
  }
  for (const name of Array.from(ctx.tsDynLocal)) {
    if (!prevDyn.has(name)) ctx.tsDynLocal.delete(name);
  }
  return {
    params,
    typeParams: buildTypeParams(fn.generics, fn.genericPacks),
    returnType: finalReturnType,
    body: block,
  };
}

/** Luau names of the params the most recent paramsFromLocals call
 *  rebound as `_LuauValue` (declared `<name>_?: unknown`, rebound in the
 *  body prologue). Read by the function compiler right after the call. */
let lastDynParams: string[] = [];

/** True when an unannotated param carries no type TS could use: no
 *  backprop class, no string/boolean usage constraint, no shape that
 *  pins a Roblox class. A number constraint is deliberately not enough
 *  — `p - q` is just as likely vector math, and `_LuauValue` covers
 *  both. Such a param is declared `unknown` (so any argument fits) and
 *  rebound as `_LuauValue` at the top of the body. */
function paramIsDyn(
  local: { name: string; annotation: TypeNode | null },
  shapes: Map<string, import('./shape-infer.js').Shape> | undefined,
  primitives: Map<string, 'number' | 'string' | 'boolean'> | undefined,
  backprop: Map<string, string> | undefined,
  ctx: CompileContext,
): boolean {
  if (ctx.compatMode !== 'rbxts') return false;
  // `p: any` compiles to `unknown` — no more information than no
  // annotation at all, so it takes the same rebinding.
  if (local.annotation && compileType(local.annotation).kind !== ts.SyntaxKind.UnknownKeyword) return false;
  if (backprop?.get(local.name)) return false;
  const prim = primitives?.get(local.name);
  if (prim === 'string' || prim === 'boolean') return false;
  const shape = shapes?.get(local.name);
  if (shape && !shape.empty && intersectionTypeName(shape)) return false;
  return true;
}

/** `let p = p_ as unknown as _LuauValue;` for each rebound param. */
function dynParamPrologue(names: readonly string[]): ts.Statement[] {
  return names.map((name) => {
    const js = safeIdentifier(name);
    return factory.createVariableStatement(
      undefined,
      factory.createVariableDeclarationList(
        [factory.createVariableDeclaration(
          factory.createIdentifier(js),
          undefined,
          undefined,
          // `unknown` converts to any type with a single `as`.
          factory.createAsExpression(factory.createIdentifier(`${js}_`), dynTypeNode()),
        )],
        ts.NodeFlags.Let,
      ),
    );
  });
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
  /** Pass 3 (param backprop): the enclosing function's name, used to
   *  consult `ctx.paramBackpropTypes` for call-site-derived param types.
   *  Wins over `shapes` when present — the call-site observation is
   *  stronger evidence than the body's shape inference. */
  enclosingFunctionName?: string,
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
  const backpropForDyn = enclosingFunctionName
    ? ctx.paramBackpropTypes.get(enclosingFunctionName)
    : undefined;
  const dynNames = new Set(
    locals.filter((l) => paramIsDyn(l, shapes, primitives, backpropForDyn, ctx)).map((l) => l.name),
  );
  lastDynParams = [...dynNames];
  {
    let lastRequired = -1;
    locals.forEach((local, i) => {
      if (local.annotation || dynNames.has(local.name)) return;
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
    if (dynNames.has(local.name)) {
      // Declared `<name>_?: unknown` so every caller's argument fits;
      // the body prologue rebinds `<name>` as `_LuauValue`.
      name = `${name}_`;
      ty = factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);
    } else if (local.annotation) {
      ty = compileType(local.annotation);
    } else if (ctx.compatMode === 'rbxts') {
      // Pass 3 (call-site backprop): if every call site passes a
      // consistent class/datatype for this param position, bind that
      // class directly. Strongest evidence — wins over primitive/shape.
      const backpropMap = enclosingFunctionName
        ? ctx.paramBackpropTypes.get(enclosingFunctionName)
        : undefined;
      const backpropClass = backpropMap?.get(local.name);
      if (backpropClass) {
        ty = factory.createTypeReferenceNode(backpropClass, undefined);
        if (i < rbxtsOptionalFrom) hasInferredShape = true;
      } else {
        // Primitive inference (math/string usage) wins next — it's an
        // honest constraint, the shape literal is a synthesized guess.
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

/** The enclosing function's declared single return type, when it names
 *  something the static view can compare against (primitive, datatype,
 *  Instance class). */
function declaredSingleReturnType(ctx: CompileContext): TypeNode | null {
  const pack = ctx.returnAnnotationStack[ctx.returnAnnotationStack.length - 1];
  if (!pack || pack.type !== 'TypePackExplicit') return null;
  if (pack.typeList.types.length !== 1 || pack.typeList.tailType) return null;
  const t = pack.typeList.types[0]!;
  if (typeFromAnnotation(t) !== 'unknown' || oracleClassOfAnnotation(t, ctx)) return t;
  return null;
}

/** True when TS already sees `value` as the declared return type, so no
 *  bridge is needed on the `return`. */
function returnValueFitsDeclared(value: Expr, declared: TypeNode, ctx: CompileContext): boolean {
  const cls = oracleClassOfAnnotation(declared, ctx);
  if (cls) {
    if (value.type === 'ConstantNil') return cls.nullable;
    return initFitsAnnotatedClass(value, cls.name, ctx);
  }
  const want = typeFromAnnotation(declared);
  if (want === 'unknown') return true;
  if (value.type === 'ConstantNil') return false;
  return isTrustedTypedExpr(value, ctx) && staticTypeOfExpr(value, ctx) === want;
}

/** Register everything the TS-type gates need to know about a binding
 *  whose emitted declaration carries `annotation` — written on the
 *  binding, inherited from its init, or the element of an iterated
 *  array. Class annotations feed the member-access and `!` gates. */
function bindDeclaredAnnotation(name: string, annotation: TypeNode | null | undefined, ctx: CompileContext): void {
  ctx.noteDeclaredType(name, annotation);
  if (ctx.compatMode !== 'rbxts') return;
  const cls = annotation ? oracleClassOfAnnotation(annotation, ctx) : null;
  if (cls) {
    ctx.tsTypedClassLocal.set(name, cls.name);
    if (cls.nullable) ctx.tsOptionalClassLocal.add(name);
    else ctx.tsOptionalClassLocal.delete(name);
    ctx.tsLuauChildLocal.delete(name);
  }
}

/** Oracle Instance class named by an annotation (`Frame`, `Frame?`,
 *  `Frame | nil`), or null. */
function oracleClassOfAnnotation(
  t: TypeNode | null | undefined,
  ctx: CompileContext,
): { name: string; nullable: boolean } | null {
  if (!t) return null;
  switch (t.type) {
    case 'TypeGroup':
      return oracleClassOfAnnotation(t.groupType, ctx);
    case 'TypeReference':
      if (t.prefix || t.parameters.length > 0) return null;
      if (ctx.oracle.isClass(t.name) && ctx.oracle.isA(t.name, 'Instance')) {
        return { name: t.name, nullable: false };
      }
      return null;
    case 'TypeUnion': {
      const nonNil = t.types.filter((m) => !(m.type === 'TypeReference' && m.name === 'nil') && m.type !== 'TypeOptional');
      if (nonNil.length !== 1 || nonNil.length === t.types.length) return null;
      const inner = oracleClassOfAnnotation(nonNil[0], ctx);
      return inner ? { name: inner.name, nullable: true } : null;
    }
    default:
      return null;
  }
}

/** True when TS already types `init` as `className` or a subclass, so
 *  an annotated local needs no bridge cast. Loose navigation methods
 *  (`WaitForChild`, `FindFirstChild`) emit as `Instance` regardless of
 *  what the name table suggests. */
function initFitsAnnotatedClass(init: Expr, className: string, ctx: CompileContext): boolean {
  if (init.type === 'Group') return initFitsAnnotatedClass(init.expr, className, ctx);
  if (init.type === 'TypeAssertion') {
    const asserted = oracleClassOfAnnotation(init.annotation, ctx);
    return !!asserted && ctx.oracle.isA(asserted.name, className);
  }
  if (init.type === 'Local') {
    const cls = ctx.tsTypedClassLocal.get(init.name);
    return !!cls && ctx.oracle.isA(cls, className) && !ctx.tsLuauChildLocal.has(init.name);
  }
  if (init.type === 'Call' && init.self && init.func.type === 'IndexName' && INSTANCE_LOOSE_METHODS.has(init.func.index)) {
    const loose = resolveLooseMethodCastType(init, ctx);
    return loose.kind === 'class' && loose.text === className;
  }
  if (exprEmitsLuauChild(init, ctx)) return false;
  const cls = resolveOracleClassOfExpr(init, ctx);
  return !!cls && ctx.oracle.isA(cls, className);
}

function typeFromAnnotation(
  annotation: TypeNode | null | undefined,
  fallbackExpr?: Expr,
  ctx?: CompileContext,
): StaticValueType {
  if (!annotation) return fallbackExpr && ctx ? staticTypeOfExpr(fallbackExpr, ctx) : 'unknown';
  switch (annotation.type) {
    case 'TypeReference':
      if (annotation.prefix === null) {
        if (annotation.name === 'any' && fallbackExpr && ctx) return staticTypeOfExpr(fallbackExpr, ctx);
        if (annotation.name === 'number') return 'number';
        if (annotation.name === 'boolean') return 'boolean';
        if (annotation.name === 'string') return 'string';
        if (ARITH_DATATYPES.has(annotation.name) || annotation.name === VECTOR_LIB_TYPE) {
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

/** What type TS sees post-emit, ignoring our tracked reassign types.
 *  Different from `staticTypeOfExpr` for Locals that have been
 *  reassigned: tracked says the latest assigned type, but TS sees the
 *  declared annotation type (or `unknown` if none).
 *
 *  Used by cast-skip predicates so we don't drop a needed cast when the
 *  tracked type happens to match the expected slot but the TS-side
 *  declared type does not. */
/** True when `expr`'s TS-visible type is a class that extends `Instance`.
 *  Used by the arg-cast skip logic so `new Instance("Part", Workspace)`
 *  doesn't emit a redundant `as unknown as Instance` on the Workspace arg. */
function argIsInstanceTyped(expr: Expr, ctx: CompileContext): boolean {
  if (ctx.compatMode !== 'rbxts') return false;
  switch (expr.type) {
    case 'Group':
    case 'TypeAssertion':
      return argIsInstanceTyped(expr.expr, ctx);
    case 'Global':
      return ctx.oracle.isService(expr.name);
    case 'Local': {
      const cls = ctx.tsTypedClassLocal.get(expr.name);
      return !!cls && ctx.oracle.isA(cls, 'Instance');
    }
    case 'Call':
    case 'IndexName': {
      const cls = resolveOracleClassOfExpr(expr, ctx);
      return !!cls && ctx.oracle.isA(cls, 'Instance');
    }
    default:
      return false;
  }
}

/** Extracts the enum type from a chain like `Enum.Material.Neon` →
 *  `Enum.Material`. Returns undefined when the chain isn't enum-shaped. */
function extractEnumRoot(expr: Expr): string | undefined {
  if (expr.type !== 'IndexName') return undefined;
  if (expr.expr.type === 'IndexName' && expr.expr.expr.type === 'Global' && expr.expr.expr.name === 'Enum') {
    return `Enum.${expr.expr.index}`;
  }
  return undefined;
}

function tsVisibleType(expr: Expr, ctx: CompileContext): StaticValueType {
  if (isDynExpr(expr, ctx)) return 'dyn';
  switch (expr.type) {
    case 'ConstantInteger':
    case 'ConstantNumber':
      return 'number';
    case 'ConstantString':
      return 'string';
    case 'ConstantBool':
      return 'boolean';
    case 'ConstantNil':
      return 'nil';
    case 'Local': {
      // Param-inferred primitive — paramsFromLocals emits this as the
      // declared annotation, so TS sees the primitive.
      const preInferred = ctx.preInferredParamType.get(expr.name);
      if (preInferred) return preInferred;
      const declared = ctx.tsDeclaredTypeLocal.get(expr.name);
      if (declared) return declared;
      // Local-type-inferred primitive — same: annotation is emitted.
      if (ctx.tsTypedPrimitiveLocal.has(expr.name)) {
        const localPrim = ctx.localTypeMap.byName.get(expr.name);
        if (localPrim) return localPrim;
      }
      return 'unknown';
    }
    case 'Group':
    case 'TypeAssertion':
      return tsVisibleType(expr.expr, ctx);
    case 'Call': {
      // Call results: rely on staticTypeOfExpr's Call handling, which
      // doesn't read tracked state — it walks oracle / macro paths.
      return staticTypeOfExpr(expr, ctx);
    }
    case 'Binary': {
      // Arithmetic results: rely on the same logic as staticTypeOfExpr.
      return staticTypeOfExpr(expr, ctx);
    }
    case 'Unary':
      if (expr.op === 'not') return 'boolean';
      if (expr.op === '#') return 'number';
      if (expr.op === '-') return staticTypeOfExpr(expr, ctx);
      return 'unknown';
    case 'IndexName':
    case 'IndexExpr':
    case 'IfElse':
      // Member reads on TS-typed receivers (oracle classes, datatypes,
      // annotated arrays) and branch-agreeing conditionals type exactly
      // as the static view.
      return isTrustedTypedExpr(expr, ctx) ? staticTypeOfExpr(expr, ctx) : 'unknown';
    default:
      return 'unknown';
  }
}

const VECTOR_LIB_NUMBER_FNS = new Set(['magnitude', 'dot', 'angle']);
const VECTOR_LIB_VECTOR_FNS = new Set([
  'create', 'normalize', 'cross', 'floor', 'ceil', 'abs', 'sign', 'clamp', 'max', 'min',
]);
const VECTOR_LIB_COMPONENTS = new Set(['x', 'y', 'z']);

/** True when TS will type the emitted expression as `number` without a
 *  cast. Locals go through the TS-visible view (declared / inferred
 *  annotation), never the tracked reassignment type — `let x: unknown;
 *  x = tick(); x - 1` tracks as number but TS still sees `unknown`. */
function tsSeesNumber(expr: Expr, ctx: CompileContext): boolean {
  switch (expr.type) {
    case 'Group':
      return tsSeesNumber(expr.expr, ctx);
    case 'TypeAssertion':
      return typeFromAnnotation(expr.annotation) === 'number' || tsSeesNumber(expr.expr, ctx);
    case 'ConstantNumber':
    case 'ConstantInteger':
      return true;
    default: {
      // The static view alone can name a datatype receiver TS only
      // sees as a synthesized shape (`{ X: unknown }`); a member read
      // counts as number only when the receiver is trusted too.
      // `_LuauValue` intersects number, so arithmetic accepts it.
      const seen = tsVisibleType(expr, ctx);
      return seen === 'number' || seen === 'dyn';
    }
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
      if (f.type === 'IndexName' && f.expr.type === 'Global' && f.expr.name === VECTOR_LIB_TYPE) {
        if (VECTOR_LIB_NUMBER_FNS.has(f.index)) return 'number';
        if (VECTOR_LIB_VECTOR_FNS.has(f.index)) return `datatype:${VECTOR_LIB_TYPE}`;
      }
      // Stdlib coercions.
      if (f.type === 'Global') {
        if (f.name === 'tostring') return 'string';
        if (f.name === 'tonumber') return 'number';
      }
      if ((f.type === 'Local' || f.type === 'Global') && !expr.self) {
        const declared = ctx.userFunctionReturnType.get(f.name);
        if (declared) return declared;
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
      // os.X (clock/time/difftime) and bare `tick()` return number.
      if (f.type === 'IndexName' && f.expr.type === 'Global' && f.expr.name === 'os'
          && (f.index === 'clock' || f.index === 'time' || f.index === 'difftime')) {
        return 'number';
      }
      if (f.type === 'Global' && f.name === 'tick') return 'number';
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
    case 'IndexExpr': {
      if (expr.expr.type === 'Local' && ctx.tsArrayTypedLocal.has(expr.expr.name) && tsSeesNumber(expr.index, ctx)) {
        return typeFromAnnotation(ctx.tsArrayTypedLocal.get(expr.expr.name));
      }
      return 'unknown';
    }
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
      if (expr.expr.type === 'Global' && expr.expr.name === VECTOR_LIB_TYPE) {
        if (expr.index === 'zero' || expr.index === 'one') return `datatype:${VECTOR_LIB_TYPE}`;
        return 'unknown';
      }
      const receiverStatic = staticTypeOfExpr(expr.expr, ctx);
      if (isDatatypeStatic(receiverStatic)) {
        const dt = receiverStatic.slice('datatype:'.length);
        if (dt === VECTOR_LIB_TYPE) {
          return VECTOR_LIB_COMPONENTS.has(expr.index) ? 'number' : 'unknown';
        }
        const prop = ctx.oracle.propertyType(dt, expr.index);
        if (prop?.kind === 'primitive' && prop.name !== 'unknown') return prop.name;
        if (prop?.kind === 'class' && !prop.nullable && ARITH_DATATYPES.has(prop.name)) {
          return `datatype:${prop.name}` as StaticValueType;
        }
        return 'unknown';
      }
      // Field of a binding whose annotation (possibly via a `type`
      // alias) declares a table shape: the declared field type is
      // exactly what TS sees.
      {
        const field = declaredAnnotationOfExpr(expr, ctx);
        if (field) return typeFromAnnotation(ctx.resolveAlias(field));
        const leaf = shapeLeafType(expr, ctx);
        if (leaf) return leaf;
      }
      if (expr.expr.type === 'Local') {
        // Member of a require-bound module whose cached return shape
        // types it (`RLConst.MAX_SPEED: number`).
        const fromModule = moduleMemberStaticType(expr.expr.name, expr.index, ctx);
        if (fromModule) return fromModule;
      }
      // Receiver whose class is known: the oracle's declared property
      // type is authoritative, and the name-based datatype heuristics
      // below must not override it (`GuiObject.Position` is UDim2,
      // `GuiObject.Rotation` is number).
      const knownReceiverClass =
        flowClassOf(expr.expr, ctx)
        ?? (expr.expr.type === 'Local' ? ctx.tsTypedClassLocal.get(expr.expr.name) : undefined)
        ?? resolveOracleClassOfExpr(expr.expr, ctx)
        ?? undefined;
      if (knownReceiverClass && ctx.oracle.isClass(knownReceiverClass)) {
        const prop = ctx.oracle.propertyType(knownReceiverClass, expr.index);
        if (prop?.kind === 'primitive' && prop.name !== 'unknown') return prop.name;
        if (prop?.kind === 'class' && !prop.nullable && ARITH_DATATYPES.has(prop.name)) {
          return `datatype:${prop.name}` as StaticValueType;
        }
        if (prop) return 'unknown';
      }
      const VECTOR3_PROPS = new Set([
        'Position', 'Size', 'Velocity',
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
        // `vector` arithmetic bridges through number and casts back.
        if (ctx.compatMode === 'rbxts' && ['+', '-', '*', '/'].includes(expr.op)
          && (lt === `datatype:${VECTOR_LIB_TYPE}` || rt === `datatype:${VECTOR_LIB_TYPE}`)) {
          return `datatype:${VECTOR_LIB_TYPE}`;
        }
        // Datatype arithmetic preserves the LEFT operand's datatype.
        if (typeof lt === 'string' && lt.startsWith('datatype:')) return lt;
        // rbxts mode: compileBinary casts unknown operands to `number` at
        // emit time, so the TS-typed result of `<number> op <unknown>` is
        // `number`. Mirror that here so downstream reassign/return casts
        // can skip the outer `as unknown as number` wrap.
        if (ctx.compatMode === 'rbxts') return 'number';
        return 'unknown';
      }
      if (['==', '~=', '<', '<=', '>', '>='].includes(expr.op)) return 'boolean';
      if (expr.op === 'and' || expr.op === 'or') {
        // `a == b or c == d` — both operands boolean ⇒ the result is
        // boolean. Matters for `or` lowering: a boolean LHS must pick
        // `||` (a `false` LHS falls through) rather than `??`.
        const lt = staticTypeOfExpr(expr.left, ctx);
        const rt = staticTypeOfExpr(expr.right, ctx);
        if (lt === 'boolean' && rt === 'boolean') return 'boolean';
        return 'unknown';
      }
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
          // Pass 1: when the synthesizer produced a structural type for
          // this root, cast through it instead of `_LuauChild`.
          const synthType = ctx.scriptParentRootTypes.get(luauReceiverName) as ts.TypeNode | undefined;
          if (synthType) {
            return factory.createPropertyAccessExpression(
              factory.createParenthesizedExpression(
                factory.createAsExpression(compiledRoot, synthType),
              ),
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
          // Pass 1: synthesized service shape — cast through it instead of
          // `_LuauChild`. The structural type covers chain accesses.
          const serviceSynthType = ctx.scriptParentRootTypes.get(serviceName) as ts.TypeNode | undefined;
          if (serviceSynthType) {
            return factory.createPropertyAccessExpression(
              factory.createParenthesizedExpression(
                factory.createAsExpression(compiledReceiver, serviceSynthType),
              ),
              factory.createIdentifier(propertyName(expr.index)),
            );
          }
          ctx.useLuauChildType();
          return factory.createPropertyAccessExpression(
            factory.createParenthesizedExpression(
              assertExpression(
                compiledReceiver,
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
              assertExpression(
                compiledReceiver,
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
              assertExpression(
                compiledReceiver,
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
      // A `_LuauValue` element (`dyn.list[k]`) or an annotated array
      // element already carries a type.
      if (
        ctx.compatMode === 'rbxts'
        && expr.expr.type === 'IndexExpr'
        && !isDynExpr(expr.expr, ctx)
        && !declaredAnnotationOfExpr(expr.expr, ctx)
        && !(expr.expr.expr.type === 'Local' && ctx.tsArrayTypedLocal.has(expr.expr.expr.name))
      ) {
        return factory.createPropertyAccessExpression(
          factory.createParenthesizedExpression(
            assertExpression(
              compileExpr(expr.expr, ctx),
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
            assertExpression(
              compileExpr(expr.expr, ctx),
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
      // `_LuauValue` receivers index to `_LuauValue`; only a read the
      // static view narrows to a datatype still takes the cast below.
      if (
        ctx.compatMode === 'rbxts'
        && isDynExpr(expr.expr, ctx)
        && !isDatatypeStatic(staticTypeOfExpr(expr, ctx))
      ) {
        return access;
      }
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
        // Same for member reads that compile to `unknown` (Record-routed
        // `entry.model`): `.Parent` on `unknown` is TS2571.
        const receiverIsUntypedMember =
          (expr.expr.type === 'IndexName' || expr.expr.type === 'IndexExpr')
          && !exprEmitsLuauChild(expr.expr, ctx)
          && !flowClassOf(expr.expr, ctx)
          && !resolveOracleClassOfExpr(expr.expr, ctx)
          && !chainRootedInSynthesizedDynamic(expr.expr, ctx)
          && !(chainRootLocal(expr.expr) !== null && ctx.tsShapeTypedLocal.has(chainRootLocal(expr.expr)!));
        if (receiverIsUntypedLocal || receiverIsUntypedMember) {
          return factory.createPropertyAccessExpression(
            luauChildCastExpression(accessReceiver, ctx),
            factory.createIdentifier('Parent'),
          );
        }
        // Pass 1: when the chain is rooted in a dynamic root we synthesized
        // a shape for, the structural type already provides typing for the
        // `.Parent` access — no `as _LuauChild` cast needed.
        if (chainRootedInSynthesizedDynamic(expr, ctx)) {
          return access;
        }
        ctx.useLuauChildType();
        return assertExpression(access, factory.createTypeReferenceNode('_LuauChild', undefined));
      }
      if (
        ctx.compatMode === 'rbxts'
        && expr.index === 'Value'
        && exprEmitsLuauChild(expr.expr, ctx)
      ) {
        return factory.createPropertyAccessExpression(
          factory.createParenthesizedExpression(
            assertExpression(
              compileExpr(expr.expr, ctx),
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
          const receiverStaticType = staticTypeOfExpr(expr.expr, ctx);
          const receiverDatatypeName = isDatatypeStatic(receiverStaticType)
            ? receiverStaticType.slice('datatype:'.length)
            : null;
          const receiverIsTsDatatype =
            !!receiverDatatypeName
            && isTrustedTypedExpr(expr.expr, ctx)
            && (receiverDatatypeName === VECTOR_LIB_TYPE
              ? VECTOR_LIB_COMPONENTS.has(expr.index)
              : !!ctx.oracle.propertyType(receiverDatatypeName, expr.index));
          const receiverHasProperty =
            receiverIsTsDatatype
            || (!!receiverClass
              && ctx.oracle.isA(receiverClass, 'Instance')
              && oracleHasMember(ctx, receiverClass, expr.index));
          // Pass 1: chains rooted in a synthesized dynamic root carry the
          // datatype directly (e.g. `script.Parent.CFrame` resolves to
          // `CFrame` per ROBLOX_PROPERTY_TYPES). Use direct access only
          // when the datatype actually declares the accessed property —
          // some scripts use deprecated lowercase aliases (lookVector)
          // that aren't in @rbxts/types and still need the Record bridge.
          const receiverIsSynthDynamicRoot =
            expr.expr.type === 'IndexName'
            && chainRootedInSynthesizedDynamic(expr.expr, ctx)
            && !!ctx.oracle.propertyType(dtName, expr.index);
          // LuauChild-emitting receivers already accept any prop access
          // (the alias's index sig returns `_LuauChild`). Skip the
          // Record bridge and go straight to `as unknown as <Datatype>`.
          const receiverIsLuauChild = exprEmitsLuauChild(expr.expr, ctx);
          // Pass 6: a shape-typed Local whose synthesized annotation
          // declares this property (typically as `unknown`) lets TS read
          // `.X` directly — the `as unknown` bridge isn't needed because
          // the source is already `unknown`-shaped at the slot.
          const receiverIsShapeTypedWithProp =
            expr.expr.type === 'Local'
            && ctx.tsShapeTypedLocal.has(expr.expr.name)
            && localObservedShapeHasMember(expr.expr, expr.index, ctx);
          const valueForCast = receiverHasProperty || receiverIsSynthDynamicRoot
            ? access
            : receiverIsLuauChild || receiverIsShapeTypedWithProp
              ? factory.createAsExpression(
                  access,
                  factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
                )
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
        // Pass 1: chains rooted in a synthesized dynamic root already
        // have full structural typing — emit direct access.
        if (chainRootedInSynthesizedDynamic(expr, ctx)) {
          return access;
        }
        if (
          expr.expr.type === 'Local'
          && !ctx.tsTypedClassLocal.has(expr.expr.name)
          // LuauChild-tracked locals keep the LuauChild route — Record
          // gives `unknown` from the index sig, breaking downstream method
          // calls (TS2571). _LuauChild's call/index signatures handle this.
          && !ctx.tsLuauChildLocal.has(expr.expr.name)
          // Gap 3: `self.X` inside a class method resolves via the class
          // declaration — no Record bridge.
          && !(expr.expr.name === 'self' && ctx.selfFieldShapes)
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
        // Skip when the chain root is a shape-typed Local — the shape
        // annotation covers each chain link's type, no Record bridge
        // needed. Pass 6: previously required `!tsTypedClassLocal.has`
        // to avoid clobbering oracle-class typing, but the Pass-6
        // shapely-candidate path now produces an `& Instance`
        // intersection that *is* the oracle class plus the observed
        // shape — trust it.
        const rootLocal = chainRootLocal(expr.expr);
        if (rootLocal && ctx.tsShapeTypedLocal.has(rootLocal)) {
          return access;
        }
        if (declaredAnnotationOfExpr(expr, ctx)) return access;
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
        // A `_LuauValue` receiver indexes to `_LuauValue` as-is.
        if (
          ctx.compatMode === 'rbxts'
          && (expr.expr.type === 'IndexExpr' || expr.expr.type === 'IndexName')
          && !isDynExpr(expr.expr, ctx)
          && !declaredAnnotationOfExpr(expr.expr, ctx)
        ) {
          target = factory.createParenthesizedExpression(
            assertExpression(
              target,
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
        // `_LuauValue` target: its string index signature takes string
        // and number keys; only a key TS can't type needs the bridge.
        if (isDynExpr(expr.expr, ctx)) {
          const keySeen = tsVisibleType(indexExpr, ctx);
          const key = keySeen === 'string' || keySeen === 'number' || keySeen === 'dyn'
            ? index
            : assertExpression(index, factory.createKeywordTypeNode(ts.SyntaxKind.StringKeyword));
          return factory.createElementAccessExpression(target, key);
        }
        // Array-typed local (`t: T[]`) with a number index: roblox-ts
        // rebases array element access by +1, so emit the 0-based form.
        if (expr.expr.type === 'Local' && ctx.tsArrayTypedLocal.has(expr.expr.name) && tsSeesNumber(indexExpr, ctx)) {
          return factory.createElementAccessExpression(target, zeroBasedIndex(index));
        }
        // Receiver → Record<string, unknown> (not any, no-any rule).
        // Route through `unknown` so typed arrays / records don't TS2352.
        // Index → string so Player/Instance keys don't TS2538.
        // Skip the Record wrap when the target already emits as
        // `_LuauChild` — that alias's `[k: string]: _LuauChild` signature
        // accepts the bracket access directly, and the cast would replace
        // the `_LuauChild` result with `unknown`, breaking downstream
        // method calls.
        // Also skip when the target chain is `<local>.<recordMapField>` —
        // Pass 2 typed that field as `Record<string, defined>` directly,
        // so bracket access typechecks without the bridge.
        const targetEmitsLuauChild = exprEmitsLuauChild(expr.expr, ctx);
        const targetIsRecordMapField =
          expr.expr.type === 'IndexName'
          && expr.expr.expr.type === 'Local'
          && ctx.recordMapFields.get(expr.expr.expr.name)?.has(expr.expr.index);
        const targetHasStringIndex = localShapeHasStringIndexSig(expr.expr, ctx);
        const dynamicTarget = (targetEmitsLuauChild || targetIsRecordMapField || targetHasStringIndex)
          ? factory.createParenthesizedExpression(target)
          : factory.createParenthesizedExpression(
              assertExpression(
                target,
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
        const coercedIndex = assertExpression(innerIndex, factory.createKeywordTypeNode(ts.SyntaxKind.StringKeyword));
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
      // `x :: any` says "trust me"; emitting `as unknown` would instead
      // erase whatever TS already knew about `x` (a `_LuauChild` require,
      // a typed local) and break every downstream use.
      if (ctx.compatMode === 'rbxts' && targetTy.kind === ts.SyntaxKind.UnknownKeyword) {
        return inner;
      }
      if (
        ctx.compatMode === 'rbxts'
        && (
          exprEmitsLuauChild(expr.expr, ctx)
          || expr.expr.type === 'Call'
          || expr.expr.type === 'IndexName'
          || tsVisibleType(expr.expr, ctx) !== 'unknown'
        )
      ) {
        return assertExpression(inner, targetTy);
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
    case '-': {
      if (ctx.compatMode !== 'rbxts' || tsSeesNumber(expr.expr, ctx)) {
        return factory.createPrefixUnaryExpression(ts.SyntaxKind.MinusToken, inner);
      }
      const operandType = staticTypeOfExpr(expr.expr, ctx);
      if (operandType === `datatype:${VECTOR_LIB_TYPE}`) {
        return assertExpression(
          factory.createPrefixUnaryExpression(
            ts.SyntaxKind.MinusToken,
            factory.createParenthesizedExpression(
              assertExpression(inner, factory.createKeywordTypeNode(ts.SyntaxKind.NumberKeyword)),
            ),
          ),
          factory.createTypeReferenceNode(VECTOR_LIB_TYPE, undefined),
        );
      }
      if (isDatatypeStatic(operandType) && isTrustedTypedExpr(expr.expr, ctx)) {
        // Vector3 / Vector2 / CFrame declare `.mul(number)`; `-v` is `v * -1`.
        return factory.createCallExpression(
          factory.createPropertyAccessExpression(
            isRepeatableExpression(inner) ? inner : factory.createParenthesizedExpression(inner),
            factory.createIdentifier('mul'),
          ),
          undefined,
          [factory.createPrefixUnaryExpression(ts.SyntaxKind.MinusToken, factory.createNumericLiteral(1))],
        );
      }
      // Unknown-typed operand: TS rejects unary minus on `unknown`
      // (TS2571 / TS18046); bridge to number like binary arithmetic.
      return factory.createPrefixUnaryExpression(
        ts.SyntaxKind.MinusToken,
        factory.createParenthesizedExpression(
          assertExpression(inner, factory.createKeywordTypeNode(ts.SyntaxKind.NumberKeyword)),
        ),
      );
    }
    case '#': {
      const innerType = staticTypeOfExpr(expr.expr, ctx);
      if (innerType === 'string') {
        // @rbxts/types strings expose `.size()`, not `.length`.
        if (ctx.compatMode === 'rbxts') {
          return factory.createCallExpression(
            factory.createPropertyAccessExpression(inner, factory.createIdentifier('size')),
            undefined,
            [],
          );
        }
        return factory.createPropertyAccessExpression(inner, 'length');
      }
      // rbxts: `(expr as Array<defined>).size()` — roblox-ts's Array.size()
      // lowers to `#expr`. `Array<defined>` is the no-any-clean equivalent of
      // `any[]` for the size-only access pattern.
      if (ctx.compatMode === 'rbxts') {
        return factory.createCallExpression(
          factory.createPropertyAccessExpression(
            factory.createParenthesizedExpression(
              assertExpression(
                inner,
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
      if (op !== undefined) {
        const direct = factory.createBinaryExpression(left, op, right);
        // A `_LuauValue` operand keeps the value type (see compileBinary).
        if (ctx.compatMode === 'rbxts' && (isDynExpr(expr.left, ctx) || isDynExpr(expr.right, ctx))) {
          return factory.createParenthesizedExpression(
            factory.createAsExpression(factory.createParenthesizedExpression(direct), dynTypeNode()),
          );
        }
        return direct;
      }
      if (expr.op === '//') {
        return factory.createCallExpression(
          factory.createPropertyAccessExpression(factory.createIdentifier('Math'), 'floor'),
          undefined,
          [factory.createBinaryExpression(left, ts.SyntaxKind.SlashToken, right)],
        );
      }
    }
  }

  // `vector` has no arithmetic methods in @rbxts/types. Bridge both
  // operands through number (roblox-ts still emits the native operator,
  // which Luau's vector metamethods handle) and cast the result back.
  if (
    ctx.compatMode === 'rbxts'
    && ['+', '-', '*', '/'].includes(expr.op)
    && (leftType === `datatype:${VECTOR_LIB_TYPE}` || rightType === `datatype:${VECTOR_LIB_TYPE}`)
  ) {
    const bridged = compileBinary(expr.op, left, right, ctx, expr.left, expr.right);
    return assertExpression(bridged, factory.createTypeReferenceNode(VECTOR_LIB_TYPE, undefined));
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
      // The static view may know the datatype while TS sees `unknown`
      // (Record-routed member, untyped local); bridge the receiver so
      // `.add()` resolves instead of surfacing TS2571.
      const dtName = leftType.slice('datatype:'.length);
      const receiver = ctx.compatMode !== 'rbxts' || isTrustedTypedExpr(expr.left, ctx)
        ? left
        : factory.createParenthesizedExpression(
            assertExpression(left, factory.createTypeReferenceNode(dtName, undefined)),
          );
      // `.mul(unknown)` fails TS2345; bridge an untyped RHS to the
      // datatype the static view names, else to number.
      let operand = right;
      if (ctx.compatMode === 'rbxts' && !isTrustedTypedExpr(expr.right, ctx)) {
        operand = assertExpression(
          right,
          isDatatypeStatic(rightType)
            ? factory.createTypeReferenceNode(rightType.slice('datatype:'.length), undefined)
            : factory.createKeywordTypeNode(ts.SyntaxKind.NumberKeyword),
        );
      }
      return factory.createCallExpression(
        factory.createPropertyAccessExpression(receiver, factory.createIdentifier(method)),
        undefined,
        [operand],
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
            // Gap 3: `self.X` inside a class method resolves via the
            // class declaration — no Record bridge.
            if (
              ctx.selfFieldShapes
              && ts.isIdentifier(e.expression)
              && e.expression.text === 'self'
            ) {
              return e;
            }
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
        // A member read whose receiver TS already types (declared
        // datatype / class / shape, synthesized dynamic root, trusted
        // static view) resolves on its own; the Record recast would only
        // erase that type.
        const receiverTsTyped = (src: Expr): boolean => {
          if (src.type === 'Group' || src.type === 'TypeAssertion') return receiverTsTyped(src.expr);
          if (src.type !== 'IndexName') return true;
          if (isTrustedTypedExpr(src, ctx)) return true;
          if (isDynExpr(src.expr, ctx)) return true;
          if (chainRootedInSynthesizedDynamic(src, ctx)) return true;
          if (src.expr.type === 'Local') {
            const n = src.expr.name;
            return ctx.tsShapeTypedLocal.has(n)
              || ctx.tsTypedClassLocal.has(n)
              || ctx.tsDeclaredTypeLocal.has(n)
              || (n === 'self' && !!ctx.selfFieldShapes);
          }
          return false;
        };
        const wrap = (e: ts.Expression, srcExpr?: Expr) => {
          const widened = srcExpr && receiverTsTyped(srcExpr) ? e : widenAccess(e);
          if (srcExpr && tsSeesNumber(srcExpr, ctx)) {
            return widened;
          }
          return factory.createParenthesizedExpression(
            factory.createAsExpression(
              factory.createAsExpression(
                widened,
                factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
              ),
              factory.createKeywordTypeNode(ts.SyntaxKind.NumberKeyword),
            ),
          );
        };
        const arith = factory.createBinaryExpression(wrap(left, leftExpr), direct, wrap(right, rightExpr));
        // `a - b` on `_LuauValue` operands may be a vector at runtime;
        // TS types the operator result `number`, so restore the value
        // type (a single `as`: number is a constituent of it).
        if ((leftExpr && isDynExpr(leftExpr, ctx)) || (rightExpr && isDynExpr(rightExpr, ctx))) {
          // Parenthesized: a bare `x as _LuauValue < y` parses as a type
          // argument list.
          return factory.createParenthesizedExpression(
            factory.createAsExpression(factory.createParenthesizedExpression(arith), dynTypeNode()),
          );
        }
        return arith;
      }
      // `===`/`!==` widen operands `as unknown` to avoid TS2367 when shape
      // inference narrowed one side away from a primitive literal. TS
      // never raises it against `undefined`, so `x == nil` compares
      // directly — which also lets TS narrow a nilable `x` afterwards.
      // Operands TS sees as the same primitive or datatype compare
      // directly too.
      if (op === '==' || op === '~=') {
        const comparesNil = leftExpr?.type === 'ConstantNil' || rightExpr?.type === 'ConstantNil';
        const lv = leftExpr ? tsVisibleType(leftExpr, ctx) : 'unknown';
        const rv = rightExpr ? tsVisibleType(rightExpr, ctx) : 'unknown';
        const sameConcrete = lv !== 'unknown' && lv !== 'nil' && lv === rv;
        if (comparesNil || sameConcrete) {
          return factory.createBinaryExpression(left, direct, right);
        }
        // `unknown` is comparable to every type, so widening one operand
        // is enough; widen the non-literal side so a literal stays legible.
        const wrapU = (e: ts.Expression) =>
          factory.createParenthesizedExpression(
            factory.createAsExpression(e, factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword)),
          );
        const rightIsLiteral = !!rightExpr && (rightExpr.type === 'ConstantString' || rightExpr.type === 'ConstantNumber'
          || rightExpr.type === 'ConstantInteger' || rightExpr.type === 'ConstantBool');
        return rightIsLiteral
          ? factory.createBinaryExpression(wrapU(left), direct, right)
          : factory.createBinaryExpression(left, direct, wrapU(right));
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
        if (srcExpr && tsSeesNumber(srcExpr, ctx)) {
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
/** Collect local-variable initializers that are chains rooted in a
 *  dynamic root (`script`/`workspace`). Used by `inferScriptParentShapes`
 *  to fold alias accesses into the root's synthesized shape. */
function collectDynamicAliasInits(root: BlockStat, out: Map<string, Expr>): void {
  const isDynamicRootChain = (e: Expr): boolean => {
    let cur: Expr = e;
    while (cur.type === 'IndexName' && cur.op === '.') cur = cur.expr;
    return cur.type === 'Global' && (cur.name === 'script' || cur.name === 'workspace');
  };
  walkLuauNodes(root, (n) => {
    if (n.type === 'Local' && 'vars' in n && 'values' in n) {
      const s = n as unknown as LocalStat;
      for (let i = 0; i < s.vars.length; i += 1) {
        const v = s.vars[i]!;
        const init = s.values[i];
        if (init && isDynamicRootChain(init)) out.set(v.name, init);
      }
    }
  });
}

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

/** Collect `local function f(): T` / `function f(): T` return annotations
 *  (single-type packs only) so call sites see the declared type. */
function scanUserFunctionReturnTypes(root: BlockStat, ctx: CompileContext): void {
  const note = (name: string, fn: { returnAnnotation: TypePack | null; args?: { name: string; annotation: TypeNode | null }[]; body?: BlockStat }): void => {
    if (fn.args) ctx.userFunctionParamAnnotations.set(name, fn.args.map((a) => a.annotation));
    if (fn.args && fn.body && ctx.compatMode === 'rbxts') {
      // Which positions the emitted signature declares `unknown` (rebound
      // as `_LuauValue` inside): any argument fits those, so call sites
      // skip the `Parameters<typeof f>[i]` wrap. Mirrors `paramIsDyn`
      // without call-site backprop, whose class-typed params only ever
      // receive class-typed arguments anyway.
      const argNames = new Set(fn.args.map((a) => a.name));
      for (const n of collectLocalNames(fn.body)) argNames.add(n);
      const shapes = collectShapes(fn.body, argNames);
      const prims = inferParamPrimitives({ args: fn.args, body: fn.body } as unknown as Parameters<typeof inferParamPrimitives>[0]);
      ctx.userFunctionDynParams.set(name, fn.args.map((a) => paramIsDyn(a, shapes, prims, undefined, ctx)));
    }
    const pack = fn.returnAnnotation;
    if (!pack || pack.type !== 'TypePackExplicit') return;
    if (pack.typeList.types.length !== 1 || pack.typeList.tailType) return;
    const single = pack.typeList.types[0]!;
    const t = typeFromAnnotation(ctx.resolveAlias(single));
    if (t !== 'unknown' && t !== 'nil') ctx.userFunctionReturnType.set(name, t);
    if (compileType(single).kind !== ts.SyntaxKind.UnknownKeyword) {
      ctx.userFunctionReturnAnnotation.set(name, single);
    }
  };
  walkLuauNodes(root, (n) => {
    if (n.type === 'LocalFunction') {
      const s = n as unknown as LocalFunctionStat;
      note(s.name.name, s.func);
    } else if (n.type === 'Function' && 'func' in n && 'name' in n) {
      const s = n as unknown as { name: Expr; func: { returnAnnotation: TypePack | null; args: { name: string; annotation: TypeNode | null }[]; body: BlockStat } };
      if (s.name && (s.name.type === 'Global' || s.name.type === 'Local')) {
        note((s.name as { name: string }).name, s.func);
      }
    }
  });
}

/** Per-slot types of a call whose @rbxts/types return is
 *  `LuaTuple<[…]>`: oracle-typed methods on a receiver TS sees as that
 *  class, and namespace-form string-library calls. Null when the tuple
 *  isn't declared, so callers fall back to the `unknown[]` bridge. */
function oracleTupleSlots(
  call: Expr,
  ctx: CompileContext,
): { staticType: StaticValueType; className?: string }[] | null {
  if (call.type !== 'Call' || call.func.type !== 'IndexName') return null;
  const fn = call.func;
  if (!call.self && fn.expr.type === 'Global' && fn.expr.name === 'string') {
    if (fn.index === 'find') return [{ staticType: 'number' }, { staticType: 'number' }, { staticType: 'string' }];
    if (fn.index === 'gsub') return [{ staticType: 'string' }, { staticType: 'number' }];
    if (fn.index === 'match') return [{ staticType: 'string' }, { staticType: 'string' }, { staticType: 'string' }];
    return null;
  }
  if (!call.self) return null;
  const recvClass = tsVisibleClassOfExpr(fn.expr, ctx);
  if (!recvClass) return null;
  const ret = ctx.oracle.methodReturnType(recvClass, fn.index, call.args.length);
  if (!ret || ret.kind !== 'raw') return null;
  const m = /^LuaTuple<\[(.*)\]>$/s.exec(ret.text.trim());
  if (!m) return null;
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of m[1]!) {
    if (ch === '<' || ch === '[' || ch === '(') depth += 1;
    if (ch === '>' || ch === ']' || ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts.map((text) => {
    if (text === 'number' || text === 'string' || text === 'boolean') return { staticType: text };
    if (ARITH_DATATYPES.has(text)) return { staticType: `datatype:${text}` as StaticValueType };
    if (ctx.oracle.isClass(text) && ctx.oracle.isA(text, 'Instance')) return { staticType: 'unknown', className: text };
    return { staticType: 'unknown' };
  });
}

/** Class TS itself sees for a receiver: a class-typed local, a service
 *  global, or an oracle-resolved chain/call — never a flow-only guess. */
function tsVisibleClassOfExpr(expr: Expr, ctx: CompileContext): string | undefined {
  if (expr.type === 'Local') {
    const cls = ctx.tsTypedClassLocal.get(expr.name);
    if (cls && !ctx.tsLuauChildLocal.has(expr.name)) return cls;
    // Datatype-annotated bindings (`pose: CFrame`) aren't Instances, so
    // they never enter tsTypedClassLocal — but the oracle still knows
    // their methods.
    const declared = ctx.tsDeclaredTypeLocal.get(expr.name);
    return isDatatypeStatic(declared ?? 'unknown') ? declared!.slice('datatype:'.length) : undefined;
  }
  if (expr.type === 'Global' && ctx.oracle.isService(expr.name)) return expr.name;
  if (expr.type === 'Group' || expr.type === 'TypeAssertion') return tsVisibleClassOfExpr(expr.expr, ctx);
  if (exprEmitsLuauChild(expr, ctx)) return undefined;
  const cls = resolveOracleClassOfExpr(expr, ctx);
  if (cls && ctx.oracle.isClass(cls)) return cls;
  const st = staticTypeOfExpr(expr, ctx);
  if (isDatatypeStatic(st) && isTrustedTypedExpr(expr, ctx)) return st.slice('datatype:'.length);
  return undefined;
}

/** True when TS sees a concrete type on the emitted argument: a declared
 *  annotation (as long as it doesn't compile to `unknown`), a trusted
 *  primitive/datatype view, or a function literal. */
function argIsTsTyped(arg: Expr, ctx: CompileContext): boolean {
  if (arg.type === 'Group') return argIsTsTyped(arg.expr, ctx);
  if (arg.type === 'Function') return true;
  // Arithmetic on bridged operands types as `number` only because the
  // bridge said so; the value may be a vector at runtime. Trust the
  // result only when every operand is itself TS-typed.
  if (arg.type === 'Binary' && ['+', '-', '*', '/', '%', '^', '//'].includes(arg.op)) {
    return argIsTsTyped(arg.left, ctx) && argIsTsTyped(arg.right, ctx);
  }
  if (arg.type === 'Unary' && arg.op === '-') return argIsTsTyped(arg.expr, ctx);
  const ann = declaredAnnotationOfExpr(arg, ctx);
  if (ann && compileType(ann).kind !== ts.SyntaxKind.UnknownKeyword) return true;
  const seen = tsVisibleType(arg, ctx);
  // `_LuauValue` fits number-ish slots (handled by the expected-slot
  // path) but not string / Instance / datatype ones — keep the wrap.
  return seen !== 'unknown' && seen !== 'nil' && seen !== 'dyn';
}

/** Primitive a synthesized shape declares for a member chain rooted in
 *  a shape-typed local (or `self` inside a class body): the emitted
 *  annotation carries it, so TS sees exactly this. */
function shapeLeafType(expr: Extract<Expr, { type: 'IndexName' }>, ctx: CompileContext): StaticValueType | undefined {
  const path: string[] = [expr.index];
  let cur: Expr = expr.expr;
  while (cur.type === 'IndexName') { path.unshift(cur.index); cur = cur.expr; }
  if (cur.type !== 'Local') return undefined;
  type S = import('./shape-infer.js').Shape;
  let shape: S | undefined;
  if (cur.name === 'self' && ctx.selfFieldShapes) {
    const first = path.shift()!;
    shape = ctx.selfFieldShapes.get(first) as S | undefined;
  } else {
    if (!ctx.tsPass6ShapeLocal.has(cur.name)) return undefined;
    shape = ctx.getShape(cur.name) as S | undefined;
  }
  if (shape && path.length > 0) {
    const target = intersectionTypeName(shape);
    if (target && intersectionTargetDeclaresName(target, path[0]!)) return undefined;
  }
  for (const seg of path) {
    if (!shape || shape.methods.has(seg)) return undefined;
    shape = shape.props.get(seg);
  }
  if (!shape) return undefined;
  const prim = leafPrimitive(shape);
  return prim ?? undefined;
}

/** True when a member chain rooted in a Pass-6 shape-typed local (or
 *  `self` inside a class body) lands on a leaf the synthesized
 *  annotation declares as `_LuauValue`. */
function shapeLeafIsDyn(expr: Extract<Expr, { type: 'IndexName' }>, ctx: CompileContext): boolean {
  const path: string[] = [expr.index];
  let cur: Expr = expr.expr;
  while (cur.type === 'IndexName') { path.unshift(cur.index); cur = cur.expr; }
  if (cur.type !== 'Local') return false;
  type S = import('./shape-infer.js').Shape;
  let shape: S | undefined;
  if (cur.name === 'self' && ctx.selfFieldShapes) {
    const first = path.shift()!;
    shape = ctx.selfFieldShapes.get(first) as S | undefined;
  } else {
    if (!ctx.tsPass6ShapeLocal.has(cur.name)) return false;
    shape = ctx.getShape(cur.name) as S | undefined;
  }
  // `{ … } & Instance` shapes hand the class's own members to the class.
  if (shape && path.length > 0) {
    const target = intersectionTypeName(shape);
    if (target && intersectionTargetDeclaresName(target, path[0]!)) return false;
  }
  for (const seg of path) {
    if (!shape || shape.methods.has(seg)) return false;
    shape = shape.props.get(seg);
  }
  return !!shape && shape.empty && !leafPrimitive(shape);
}

/** True when the argument's declared annotation prints to the same TS
 *  type as the callee's declared parameter annotation, or when TS sees
 *  the argument as the primitive/datatype the parameter declares. */
function argMatchesDeclaredParam(arg: Expr, fnName: string, index: number, ctx: CompileContext): boolean {
  const paramAnn = ctx.userFunctionParamAnnotations.get(fnName)?.[index];
  if (!paramAnn) return false;
  const argAnn = declaredAnnotationOfExpr(arg, ctx);
  if (argAnn && annotationText(argAnn) === annotationText(paramAnn)) return true;
  const want = typeFromAnnotation(ctx.resolveAlias(paramAnn));
  return want !== 'unknown' && tsVisibleType(arg, ctx) === want;
}

/** The annotation TS sees for an expression, as the parsed Luau node:
 *  a declared binding, a field of one (through table types and
 *  aliases, foreign or local), a `::` assertion, or a call to a
 *  file-local function with a declared return type. Null when TS's
 *  view of the expression is not pinned by an annotation. */
function declaredAnnotationOfExpr(expr: Expr, ctx: CompileContext): TypeNode | null {
  switch (expr.type) {
    case 'Local':
      return ctx.tsDeclaredAnnotation.get(expr.name) ?? null;
    case 'Group':
      return declaredAnnotationOfExpr(expr.expr, ctx);
    case 'TypeAssertion':
      if (ctx.compatMode === 'rbxts' && compileType(expr.annotation).kind === ts.SyntaxKind.UnknownKeyword) {
        return declaredAnnotationOfExpr(expr.expr, ctx);
      }
      return expr.annotation;
    case 'IndexName': {
      const parent = declaredAnnotationOfExpr(expr.expr, ctx);
      if (!parent) return null;
      const table = ctx.resolveAlias(parent);
      if (!table || table.type !== 'TypeTable') return null;
      for (const prop of table.props) {
        if (prop.name === expr.index) return prop.propType ?? null;
      }
      const indexer = table.indexer;
      if (indexer && indexer.indexType.type === 'TypeReference' && indexer.indexType.name === 'string') {
        return indexer.resultType;
      }
      return null;
    }
    case 'Call': {
      const f = expr.func;
      if (!expr.self && (f.type === 'Local' || f.type === 'Global')) {
        return ctx.userFunctionReturnAnnotation.get(f.name) ?? null;
      }
      return null;
    }
    default:
      return null;
  }
}

const typeTextPrinter = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
const typeTextFile = ts.createSourceFile('_t.ts', '', ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
function annotationText(t: TypeNode): string {
  return typeTextPrinter.printNode(ts.EmitHint.Unspecified, compileType(t), typeTextFile);
}

const moduleShapeCache = new WeakMap<CompileContext, Map<string, ts.TypeNode | null>>();

/** Static view of `<requireLocal>.<member>` from the module's cached
 *  return shape: the emitted `as unknown as { member: number; … }` cast
 *  is what TS resolves the read against. */
function moduleMemberStaticType(local: string, member: string, ctx: CompileContext): StaticValueType | undefined {
  const path = ctx.requireBoundLocals.get(local);
  if (!path) return undefined;
  let cache = moduleShapeCache.get(ctx);
  if (!cache) { cache = new Map(); moduleShapeCache.set(ctx, cache); }
  let shape = cache.get(path);
  if (shape === undefined) {
    const text = ctx.moduleReturnTypes.get(path);
    shape = text ? parseTypeText(text) : null;
    cache.set(path, shape);
  }
  if (!shape || !ts.isTypeLiteralNode(shape)) return undefined;
  for (const m of shape.members) {
    if (!ts.isPropertySignature(m) || !m.type || !ts.isIdentifier(m.name) || m.name.text !== member) continue;
    switch (m.type.kind) {
      case ts.SyntaxKind.NumberKeyword: return 'number';
      case ts.SyntaxKind.StringKeyword: return 'string';
      case ts.SyntaxKind.BooleanKeyword: return 'boolean';
      default:
        if (ts.isTypeReferenceNode(m.type) && ts.isIdentifier(m.type.typeName) && ARITH_DATATYPES.has(m.type.typeName.text)) {
          return `datatype:${m.type.typeName.text}` as StaticValueType;
        }
        return undefined;
    }
  }
  return undefined;
}

/** Top-level `local X = require(<path>)` → corpus path, for qualified
 *  type references (`X.Foo`). Independent of the cached return-type
 *  index so type imports work even when the module's value shape is
 *  unknown. */
function scanRequireLocalPaths(root: BlockStat, ctx: CompileContext): void {
  for (const stat of root.body) {
    if (stat.type !== 'Local') continue;
    stat.vars.forEach((v, i) => {
      const init = stat.values[i];
      if (!init || init.type !== 'Call' || init.func.type !== 'Global' || init.func.name !== 'require') return;
      const arg = init.args[0];
      if (!arg) return;
      const path = resolveRequirePath(arg, ctx.currentScriptPath);
      if (path) ctx.requireLocalPaths.set(v.name, path);
    });
  }
}

function scanUserFunctionAllUnknownParams(root: BlockStat, ctx: CompileContext): void {
  const userFunctions = new Map<string, { args: { name: string; annotation: unknown }[]; body: BlockStat }>();
  walkLuauNodes(root, (n) => {
    if (n.type === 'LocalFunction') {
      const s = n as unknown as LocalFunctionStat;
      userFunctions.set(s.name.name, { args: s.func.args as { name: string; annotation: unknown }[], body: s.func.body });
    } else if (n.type === 'Function' && 'func' in n && 'name' in n) {
      const s = n as unknown as { name: Expr; func: { args: { name: string; annotation: unknown }[]; body: BlockStat } };
      if (s.name && (s.name.type === 'Global' || s.name.type === 'Local')) {
        userFunctions.set((s.name as { name: string }).name, { args: s.func.args, body: s.func.body });
      }
    } else if (n.type === 'Local' && 'vars' in n && 'values' in n) {
      const s = n as unknown as LocalStat;
      for (let i = 0; i < s.vars.length; i += 1) {
        const init = s.values[i];
        if (init && init.type === 'Function' && 'args' in init && 'body' in init) {
          const fn = init as unknown as { args: { name: string; annotation: unknown }[]; body: BlockStat };
          userFunctions.set(s.vars[i]!.name, { args: fn.args, body: fn.body });
        }
      }
    }
  });
  for (const [name, fn] of userFunctions) {
    if (fn.args.length === 0) {
      ctx.userFunctionUnknownParams.add(name);
      continue;
    }
    // Any explicit annotation disqualifies the all-unknown shortcut.
    if (fn.args.some((a) => a.annotation)) continue;
    // Param-infer: if any param picks up a primitive constraint, the
    // emitted declaration uses that primitive type — the cast bridge is
    // load-bearing then.
    const primitives = inferParamPrimitives({
      args: fn.args as unknown,
      body: fn.body,
    } as unknown as Parameters<typeof inferParamPrimitives>[0]);
    if (primitives.size > 0) continue;
    // Shape-infer: same story for structural shapes.
    const trackedNames = new Set<string>(fn.args.map((a) => a.name));
    for (const n of collectLocalNames(fn.body)) trackedNames.add(n);
    const shapes = collectShapes(fn.body, trackedNames);
    let anyShape = false;
    for (const arg of fn.args) {
      const s = shapes.get(arg.name) as { empty?: boolean } | undefined;
      if (s && !s.empty) {
        anyShape = true;
        break;
      }
    }
    if (anyShape) continue;
    ctx.userFunctionUnknownParams.add(name);
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

  const collectReturns = (stat: Stat | null | undefined, classes: Set<string>, state: { bad: boolean; mayBeNil: boolean }): void => {
    if (!stat || state.bad) return;
    switch (stat.type) {
      case 'Return': {
        const value = stat.values[0];
        if (!value) {
          state.mayBeNil = true;
          return;
        }
        const fact = flowFactOf(value, ctx);
        if (fact?.kind === 'class') {
          classes.add(fact.name);
          if (fact.nullable) state.mayBeNil = true;
          return;
        }
        if (value.type === 'ConstantNil') {
          state.mayBeNil = true;
          return;
        }
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
    const state = { bad: false, mayBeNil: false };
    collectReturns(body, classes, state);
    if (!state.bad && classes.size === 1) {
      ctx.userFunctionReturnClass.set(name, [...classes][0]!);
      if (state.mayBeNil) ctx.userFunctionMayReturnNil.add(name);
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
  luauCallee?: Expr,
): readonly ts.Expression[] {
  if (ctx.compatMode !== 'rbxts') return args;
  // Pass 3: when the callee is a known-method on a require-bound local,
  // the cached return-shape declares its signature as `(...args:
  // unknown[]) => defined`. Every arg fits the `unknown` rest slot
  // without a cast — wrapping with `Parameters<typeof mod.fn>[i]` is
  // pure text noise. Skip the cast entirely for this call.
  if (
    luauCallee
    && luauCallee.type === 'IndexName'
    && isRequireBoundKnownMethod(luauCallee.expr, luauCallee.index, ctx)
  ) {
    return args;
  }
  const expectedSlot = expectedSlotTypes(callee);
  // The Parameters<typeof callee>[i] fallback needs `typeof callee` to
  // resolve — that requires a simple identifier / shallow property
  // access chain. When the callee is a call-result receiver (e.g.
  // `toolsFolder().FindFirstChild`), `typeof` would fail. Bail unless
  // we have an explicit slot kind (string / number / etc.) we can
  // emit directly without consulting `typeof callee`.
  if (!isSimpleCalleeRef(callee) && !expectedSlot) return args;
  // (api-data class-method dispatch via expectedSlotTypesForClassMethod is
  //  intentionally disabled here: the hand-coded `expectedSlotTypes` is
  //  the safer signal — its slots match what the Lua-side tracking maps
  //  to. Falling back to api-data widens the skip-cast set and surfaces
  //  TS2345 when a reassigned Local's tracked type diverges from its TS
  //  declared type. Class-method dispatch happens elsewhere.)
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
        // Use TS-visible type (not tracked reassign type) so we don't
        // skip a cast that TS would actually need. `targetUserId =
        // tonumber(targetUserId)` tracks as `number` but TS-visible
        // type stays `unknown`/`string` — the cast must still apply.
        const tsT = tsVisibleType(luau, ctx);
        if (tsT === expected) return arg;
        if (tsT === 'dyn' && (expected === 'number' || expected === 'number|string')) return arg;
        if (expected === 'vector' && tsT === `datatype:${VECTOR_LIB_TYPE}`) return arg;
        if (expected === 'number|string' && (tsT === 'number' || tsT === 'string')) return arg;
        // Instance-slot acceptance for class-typed expressions. TS will
        // already see these as Instance subclasses, so the redundant
        // `as unknown as Instance` cast just adds noise.
        if (expected === 'instance' && argIsInstanceTyped(luau, ctx)) return arg;
      }
    } else if (
      luauArgs?.[i]
      && ts.isIdentifier(callee)
      && argMatchesDeclaredParam(luauArgs[i]!, callee.text, i, ctx)
    ) {
      // The argument's own annotation is the parameter's annotation:
      // TS checks them directly, and a mismatch would be a real error
      // the bridge was hiding.
      return arg;
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
    } else if (
      ts.isIdentifier(callee)
      && ctx.userFunctionUnknownParams.has(callee.text)
    ) {
      // Callee's declared params are all `?: unknown`. Passing any value
      // (including untyped locals) is a type-safe no-op — `X as unknown
      // as unknown` is equivalent to `X`. Skip the wrap entirely.
      return arg;
    }
    // Pass 3: callee has a backprop-typed param at this position and the
    // arg's source type is compatible. The function emits the typed
    // annotation, so the arg goes through TS structural assignment without
    // the `Parameters<typeof callee>[i]` indirection.
    if (
      ts.isIdentifier(callee)
      && luauArgs?.[i]
      && ctx.paramBackpropTypes.has(callee.text)
    ) {
      const map = ctx.paramBackpropTypes.get(callee.text)!;
      // paramsFromLocals walks `realArgs` (which mirrors `luauArgs`),
      // so positional index alignment holds.
      const paramName = paramNameFromCallee(callee.text, i, ctx);
      const boundType = paramName ? map.get(paramName) : undefined;
      if (boundType && argIsCompatibleWithBoundType(luauArgs[i]!, boundType, ctx)) {
        return arg;
      }
    }
    // A user function's `<name>_?: unknown` slot takes any argument.
    if (ts.isIdentifier(callee) && ctx.userFunctionDynParams.get(callee.text)?.[i]) return arg;
    // An argument TS already types — an annotated binding, a member
    // read through a declared table, a datatype/primitive expression,
    // or a function literal — is checked against the real parameter.
    // The wrap would only hide a genuine mismatch.
    if (luauArgs?.[i] && argIsTsTyped(luauArgs[i]!, ctx)) return arg;
    if (ts.isParenthesizedExpression(arg) && ts.isAsExpression(arg.expression) && !expected && !ts.isIdentifier(callee)) return arg;
    if (ts.isAsExpression(arg) && !expected && !ts.isIdentifier(callee)) return arg;
    // No expected slot kind + complex callee: the Parameters<typeof
    // callee>[i] fallback needs `typeof callee` to resolve. For
    // call-result / element-access callees that emit a typeof for it
    // would be syntactically broken; leave the arg untouched.
    if (!expected && !isSimpleCalleeRef(callee)) return arg;
    const inner = (
      ts.isArrowFunction(arg)
      || ts.isFunctionExpression(arg)
      || ts.isBinaryExpression(arg)
      || ts.isConditionalExpression(arg)
    )
      ? factory.createParenthesizedExpression(arg)
      : arg;
    // When the slot kind is one we can name directly (primitive or Instance),
    // emit `as unknown as <kind>` — shorter and faster to type-check than the
    // generic `Parameters<typeof callee>[i]` indexed access.
    const directType = slotKindToTypeNode(expected);
    if (directType) {
      return factory.createAsExpression(
        factory.createAsExpression(
          inner,
          factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
        ),
        directType,
      );
    }
    return factory.createAsExpression(
      factory.createAsExpression(
        inner,
        factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
      ),
      factory.createIndexedAccessTypeNode(
        factory.createTypeReferenceNode('Parameters', [calleeTypeQuery(callee)]),
        factory.createLiteralTypeNode(factory.createNumericLiteral(i)),
      ),
    );
  });
}

/** `typeof callee` for the Parameters<> wrap. A `recv!.method` callee
 *  can't be written as a type query (`!` isn't allowed there), so it
 *  becomes `NonNullable<typeof recv>["method"]`. */
function calleeTypeQuery(callee: ts.Expression): ts.TypeNode {
  let cur: ts.Expression = callee;
  while (ts.isParenthesizedExpression(cur)) cur = cur.expression;
  if (
    ts.isPropertyAccessExpression(cur)
    && ts.isIdentifier(cur.name)
    && ts.isNonNullExpression(cur.expression)
  ) {
    return factory.createIndexedAccessTypeNode(
      factory.createTypeReferenceNode('NonNullable', [
        factory.createTypeQueryNode(calleeAsEntityName(cur.expression.expression)),
      ]),
      factory.createLiteralTypeNode(factory.createStringLiteral(cur.name.text)),
    );
  }
  return factory.createTypeQueryNode(calleeAsEntityName(callee));
}

function slotKindToTypeNode(kind: SlotKind | undefined): ts.TypeNode | undefined {
  switch (kind) {
    case 'string': return factory.createKeywordTypeNode(ts.SyntaxKind.StringKeyword);
    case 'number': return factory.createKeywordTypeNode(ts.SyntaxKind.NumberKeyword);
    case 'boolean': return factory.createKeywordTypeNode(ts.SyntaxKind.BooleanKeyword);
    case 'number|string': return factory.createUnionTypeNode([
      factory.createKeywordTypeNode(ts.SyntaxKind.NumberKeyword),
      factory.createKeywordTypeNode(ts.SyntaxKind.StringKeyword),
    ]);
    case 'instance': return factory.createTypeReferenceNode('Instance', undefined);
    case 'vector': return factory.createTypeReferenceNode(VECTOR_LIB_TYPE, undefined);
    default: return undefined;
  }
}

/** Build a TS `EntityName` for `typeof <callee>` queries. NonNullExpression
 *  (`x!.method`) is stripped — the `!` is purely a runtime hint that the
 *  reference itself produces. */
function calleeAsEntityName(expr: ts.Expression): ts.EntityName {
  if (ts.isIdentifier(expr)) return expr;
  if (ts.isNonNullExpression(expr)) return calleeAsEntityName(expr.expression);
  if (ts.isParenthesizedExpression(expr)) return calleeAsEntityName(expr.expression);
  if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.name)) {
    return factory.createQualifiedName(
      calleeAsEntityName(expr.expression),
      factory.createIdentifier(expr.name.text),
    );
  }
  // Fallback: stringify the expression's leading identifier. Should be
  // unreachable because callers gate via isSimpleCalleeRef.
  return factory.createIdentifier('unknown');
}

/** Per-callee expected slot static types. Populated from known stdlib /
 *  globals signatures so castArgsForCall can skip redundant casts when
 *  the arg's static type already matches. The `'any'` slot means the
 *  declared param type is `unknown` — any arg is type-compatible without
 *  a cast. */
type SlotKind = 'string' | 'number' | 'boolean' | 'number|string' | 'instance' | 'vector' | 'any';
type ExpectedSlots = { [i: number]: SlotKind } & { rest?: SlotKind };

function expectedSlotTypes(callee: ts.Expression): ExpectedSlots | undefined {
  // Peel off NonNullExpression / Parenthesized wrappers — the method name
  // is what matters for slot lookup. `folder!.FindFirstChild` and
  // `folder.FindFirstChild` both want the FindFirstChild slot table.
  let unwrapped: ts.Expression = callee;
  while (ts.isNonNullExpression(unwrapped) || ts.isParenthesizedExpression(unwrapped)) {
    unwrapped = unwrapped.expression;
  }
  let path = '';
  let methodName = '';
  if (ts.isIdentifier(unwrapped)) path = unwrapped.text;
  else if (ts.isPropertyAccessExpression(unwrapped) && ts.isIdentifier(unwrapped.expression) && ts.isIdentifier(unwrapped.name)) {
    path = `${unwrapped.expression.text}.${unwrapped.name.text}`;
    methodName = unwrapped.name.text;
  } else if (ts.isPropertyAccessExpression(unwrapped) && ts.isIdentifier(unwrapped.name)) {
    methodName = unwrapped.name.text;
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
    case 'require':
      // The require-call site pre-wraps the arg as ModuleScript before
      // castArgsForCall runs (see compileCall line ~5380); 'any' here
      // suppresses the redundant `as Parameters<typeof require>[0]`
      // wrap that would otherwise stack on top.
      return { 0: 'any' };
    // Roblox task library — `task.wait(seconds)` is the common
    // pattern; spawn/delay take a callback first and need the cast.
    case 'task.wait':
      return { 0: 'number' };
    // `wait(seconds)` global (deprecated but still common).
    case 'wait':
      return { 0: 'number' };
    // task.spawn/defer/delay/pcall/xpcall: passing an unknown-typed callback
    // (a bare local whose value happens to be a function) makes TS unable
    // to pick between the (callback, ...args) and (thread, ...args)
    // overloads. The Parameters<> cast disambiguates. Don't blanket-skip.
    // Leave these as fall-through.
    // Debris.AddItem(Instance, number) — common helper, both args
    // typed.
    case 'Debris.AddItem':
      return { 0: 'instance', 1: 'number' };
    // TweenService.Create(Instance, TweenInfo, dict). Arg 0 benefits
    // from the Instance-slot skip when receiver is typed. Arg 2 (dict)
    // must keep its `Parameters<>` wrap — TS validates the dict against
    // `Partial<ExtractMembers<T0, Tweenable>>` and rejects `Size` etc.
    // when T0 isn't narrowed to BasePart (Instance has no such member).
    case 'TweenService.Create':
      return { 0: 'instance' };
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
    case 'vector.create':
      return { 0: 'number', 1: 'number', 2: 'number' };
    case 'vector.magnitude':
    case 'vector.normalize':
    case 'vector.floor':
    case 'vector.ceil':
    case 'vector.abs':
    case 'vector.sign':
      return { 0: 'vector' };
    case 'vector.cross':
    case 'vector.dot':
    case 'vector.angle':
    case 'vector.clamp':
      return { 0: 'vector', 1: 'vector', 2: 'vector' };
    case 'vector.max':
    case 'vector.min':
      return { 0: 'vector', rest: 'vector' };
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
  }
  // Fall back to generated stdlib / datatype slot tables. These mirror
  // every signature in @rbxts/types and are reproducible from
  // node_modules/@rbxts/types via scripts/build-api-macros.mjs.
  const generated = STDLIB_SLOTS[path] ?? DATATYPE_SLOTS[path];
  if (generated) {
    const out: ExpectedSlots = { ...generated.slots };
    if (generated.rest) (out as { rest: SlotKind }).rest = generated.rest as SlotKind;
    return out;
  }
  return undefined;
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
  if (expr.type === 'IndexName') {
    if (declaredAnnotationOfExpr(expr, ctx)) return staticTypeOfExpr(expr, ctx) !== 'unknown';
    if (shapeLeafType(expr, ctx)) return true;
    // Oracle property of a receiver TS types as that class (`item.Name`
    // on `item: Instance`): declared by @rbxts/types.
    if (expr.expr.type === 'Local') {
      const cls = ctx.tsTypedClassLocal.get(expr.expr.name);
      if (cls && !ctx.tsLuauChildLocal.has(expr.expr.name) && oracleHasMember(ctx, cls, expr.index)) {
        return staticTypeOfExpr(expr, ctx) !== 'unknown';
      }
    }
    if (expr.expr.type === 'Local' && moduleMemberStaticType(expr.expr.name, expr.index, ctx)) return true;
  }
  if (expr.type === 'IndexName') {
    // Member of a TS-typed datatype receiver (`v.x` on `vector`,
    // `cf.Position` on a trusted CFrame): @rbxts/types declares the
    // property, so the read types exactly as the static view.
    const recv = staticTypeOfExpr(expr.expr, ctx);
    if (isDatatypeStatic(recv) && isTrustedTypedExpr(expr.expr, ctx)) {
      return staticTypeOfExpr(expr, ctx) !== 'unknown';
    }
  }
  switch (expr.type) {
    case 'ConstantString':
    case 'ConstantNumber':
    case 'ConstantInteger':
    case 'ConstantBool':
      return true;
    case 'Group':
      return isTrustedTypedExpr(expr.expr, ctx);
    case 'Unary':
      // `#x` and `not x` always emit as number / boolean; `-x` keeps the
      // operand's type, and its emit bridges an untyped operand itself.
      return expr.op !== '-' || staticTypeOfExpr(expr, ctx) !== 'unknown';
    case 'TypeAssertion':
      if (ctx.compatMode === 'rbxts' && compileType(expr.annotation).kind === ts.SyntaxKind.UnknownKeyword) {
        return isTrustedTypedExpr(expr.expr, ctx);
      }
      return true;
    case 'Local':
      return ctx.preInferredParamType.has(expr.name)
        || ctx.tsTypedPrimitiveLocal.has(expr.name)
        || ctx.tsDeclaredTypeLocal.has(expr.name);
    case 'IndexExpr':
      return expr.expr.type === 'Local'
        && ctx.tsArrayTypedLocal.has(expr.expr.name)
        && tsSeesNumber(expr.index, ctx)
        && staticTypeOfExpr(expr, ctx) !== 'unknown';
    case 'Call': {
      const fn = expr.func;
      if (fn.type === 'Global' && (fn.name === 'tostring' || fn.name === 'tonumber')) return true;
      if ((fn.type === 'Local' || fn.type === 'Global') && !expr.self
        && (ctx.userFunctionReturnType.has(fn.name) || ctx.userFunctionReturnAnnotation.has(fn.name))) {
        return true;
      }
      if (fn.type === 'IndexName' && fn.expr.type === 'Global') {
        const ns = fn.expr.name;
        if (ns === 'math' || ns === 'string') return true;
        // Datatype factories / `vector` library — @rbxts/types declares
        // every one of these with a concrete return type.
        if (ARITH_DATATYPES.has(ns) || ns === VECTOR_LIB_TYPE) {
          return staticTypeOfExpr(expr, ctx) !== 'unknown';
        }
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
      // Arithmetic on trusted operands → trusted number. In rbxts mode
      // compileBinary casts unknown operands to `number` at emit time, so
      // when at least one operand is statically `number`, the TS-emitted
      // expression types as `number` regardless of the other side's
      // static type.
      if (['+', '-', '*', '/', '%', '^', '//'].includes(expr.op)) {
        if (isTrustedTypedExpr(expr.left, ctx) && isTrustedTypedExpr(expr.right, ctx)) {
          return true;
        }
        if (ctx.compatMode === 'rbxts') {
          // Every non-datatype operand gets the `as unknown as number`
          // bridge at emit time, so the TS-typed result is `number`
          // whenever the LHS doesn't dispatch to `.add()`/`.sub()`; the
          // `vector` bridge casts its result back explicitly.
          const st = staticTypeOfExpr(expr, ctx);
          if (st === 'number' || st === `datatype:${VECTOR_LIB_TYPE}`) return true;
          return isTrustedTypedExpr(expr.left, ctx);
        }
        return false;
      }
      if (expr.op === '..') return true;
      return false;
    case 'IfElse': {
      const t = staticTypeOfExpr(expr, ctx);
      return t !== 'unknown'
        && isTrustedTypedExpr(expr.trueExpr, ctx)
        && isTrustedTypedExpr(expr.falseExpr, ctx);
    }
    default:
      return false;
  }
}

/** True for Identifier or PropertyAccess chains TS can `typeof`. Capped at
 *  depth 2 so deeper chains with structurally-unknown intermediates don't
 *  generate `typeof unknown.X` (TS2571). */
function isSimpleCalleeRef(expr: ts.Expression, depth = 0): boolean {
  if (ts.isIdentifier(expr)) return true;
  if (ts.isNonNullExpression(expr)) return isSimpleCalleeRef(expr.expression, depth);
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
    // ModuleScript extends Instance; an arg already typed `as Instance`
    // (typical chain: WaitForChild result, script.Parent navigation)
    // can downcast directly without the `as unknown` bridge.
    const arg0 = args[0];
    const innerIsInstance =
      ts.isAsExpression(arg0)
      && ts.isTypeReferenceNode(arg0.type)
      && ts.isIdentifier(arg0.type.typeName)
      && arg0.type.typeName.text === 'Instance';
    args = [
      innerIsInstance
        ? factory.createAsExpression(
            arg0,
            factory.createTypeReferenceNode('ModuleScript', undefined),
          )
        : factory.createAsExpression(
            factory.createAsExpression(
              arg0,
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
    // Signal-method receiver cast fires for `.Connect`/`.Fire`/`.Wait` on
    // chained receivers (`obj.Signal:Connect(...)`). But when the chain
    // root resolves to a class whose member `<index>` is declared as an
    // Event in api-data, the receiver IS a typed RBXScriptSignal — no
    // cast needed.
    const recvEmitsLuauChildForGate =
      ctx.compatMode === 'rbxts'
      && exprEmitsLuauChild(expr.func.expr, ctx);
    const isSignalMethod =
      ctx.compatMode === 'rbxts'
      && SIGNAL_METHODS.has(expr.func.index)
      && (expr.func.expr.type === 'IndexName' || expr.func.expr.type === 'Call')
      && !signalReceiverIsTypedEvent(expr.func.expr, ctx)
      // `_LuauChild`'s call signature (`(...args: unknown[]): _LuauChild`)
      // accepts any signal-method call directly — the Record cast is
      // redundant when the receiver already emits as `_LuauChild`.
      && !recvEmitsLuauChildForGate;
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
      // tsLuauChildLocal locals are now tracked only when the init's
      // emission directly types the local as `_LuauChild` — those accept
      // any method via the call signature.
      && !ctx.tsLuauChildLocal.has(expr.func.expr.name)
      && !ctx.preInferredParamType.has(expr.func.expr.name)
      && localObservedShapeHasMember(expr.func.expr, expr.func.index, ctx);
    // LuauChild bypasses Record routing only for methods whose call result
    // is consumed directly (no `as <SpecificType>` post-cast that would
    // reject `_LuauChild`). GetAttribute applies a post-cast to
    // AttributeValue — keep its routing so the call result is `unknown`,
    // bridgeable to AttributeValue.
    const luauChildBypassesUnknownChain =
      recvEmitsLuauChildForGate
      && expr.func.index !== 'GetAttribute';
    const receiverIsUnknownChain =
      ctx.compatMode === 'rbxts'
      && expr.func.expr.type === 'IndexName'
      && !receiverClassForMethod
      && !signalReceiverIsTypedEvent(expr.func.expr, ctx)
      && !luauChildBypassesUnknownChain
      // Pass 1: chains rooted in a synthesized dynamic root carry full
      // structural typing — every leg already resolves cleanly.
      && !chainRootedInSynthesizedDynamic(expr.func.expr, ctx)
      && rootGlobalName(expr.func.expr) !== 'Enum';
    const dynamicInstanceMethod =
      ctx.compatMode === 'rbxts'
      && (expr.func.index === 'GetPivot' || expr.func.index === 'PivotTo');
    // `_LuauChild` is callable + indexable, so direct `x.Method(...)`
    // type-checks (returns `_LuauChild`). Route only when the method
    // is *not* an Instance navigation method — those have specific
    // post-cast result types (`Instance | undefined`, etc.) that the
    // direct path on `_LuauChild` doesn't surface correctly. Skip the
    // routing in the LuauChild-receiver case.
    // _LuauChild's `(...args: unknown[]): _LuauChild` call signature
    // accepts any method invocation directly — the Record detour is only
    // necessary for methods whose call result feeds a downstream
    // type-specific post-cast that `_LuauChild` can't satisfy.
    // GetAttribute → AttributeValue, GetPivot → CFrame need explicit
    // bridges. INSTANCE_LOOSE_METHODS already bridge through `unknown`
    // in their post-cast code (sourceNeedsBridge fires when receiver
    // emits LuauChild), so they can also skip routing.
    const luauChildPostCastNeedsBridge =
      expr.func.index === 'GetPivot';
    const skipLuauChildRouting =
      receiverEmitsLuauChild
      && !luauChildPostCastNeedsBridge;
    const needsReceiverCast =
      receiverIsIndexExpr
      || isSignalMethod
      || methodMissingOnKnownInstance
      || (receiverEmitsLuauChild && !skipLuauChildRouting)
      || dynamicInstanceMethod
      || receiverIsObservedShape
      || receiverIsUnknownChain;
    // Detect receivers whose TS type is `Class | undefined`: nullable flow
    // fact, optional-tracked local, or a Call to a user function whose
    // declared return is an Instance class (the function body might still
    // return nil through paths flow can't narrow — TS otherwise rejects
    // `f().Method(...)` with TS2532).
    const recv = expr.func.expr;
    const receiverIsCallToOptionalUserFn =
      recv.type === 'Call'
      && (recv.func.type === 'Local' || recv.func.type === 'Global')
      && (
        ctx.userFunctionMayReturnNil.has((recv.func as { name: string }).name)
        || ctx.userFunctionReturnClass.has((recv.func as { name: string }).name)
      );
    const compiledReceiverForMethod =
      ctx.compatMode === 'rbxts'
      && (
        (receiverFactForMethod?.kind === 'class' && receiverFactForMethod.nullable)
        || (recv.type === 'Local' && ctx.tsOptionalClassLocal.has(recv.name))
        || receiverIsCallToOptionalUserFn
      )
        ? factory.createNonNullExpression(compileExpr(recv, ctx))
        : compileExpr(recv, ctx);
    // Signal-method receiver cast. Default: cast the immediate receiver
    // (Tween.Completed etc, which have the signal as a typed property).
    // When the chain root is a typed Instance whose oracle entry does
    // NOT have the next-level property (e.g. `hum.Died` where `hum` is
    // Instance | undefined and `Died` is a Humanoid signal), route the
    // cast to the chain root so the missing property is absorbed.
    const receiverIsDyn = isDynExpr(recv, ctx);
    const innerRecv = needsReceiverCast && !receiverIsDyn
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
    if (needsReceiverCast || receiverIsDyn) {
      // Cast the unknown-typed method slot through a callable so the
      // call site doesn't re-trip TS2571. A `_LuauValue` member is
      // readable but not callable, so it takes the same bridge.
      calleeAccess = unknownCallableCastExpression(calleeAccess, true);
      ctx.dynResultCalls.add(expr);
      methodCallReceiverWasRecordRouted = true;
    }
    call = factory.createCallExpression(
      calleeAccess,
      undefined,
      castArgsForCall(calleeAccess, args, ctx, expr.args, expr.func),
    );
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
      if (ctx.compatMode === 'rbxts' && isDynExpr(expr.func, ctx)) {
        calleeExpr = unknownCallableCastExpression(calleeExpr);
        ctx.dynResultCalls.add(expr);
      } else if (
        ctx.compatMode === 'rbxts'
        && expr.func.type === 'IndexName'
        && !isRequireBoundKnownMethod(expr.func.expr, expr.func.index, ctx)
        && (
          exprEmitsLuauChild(expr.func.expr, ctx)
          || (
            expr.func.expr.type === 'Local'
            && !ctx.tsTypedClassLocal.has(expr.func.expr.name)
            // Pass 6: shape-typed locals already declare the called
            // member via the synthesized annotation (whether as a method
            // signature in the shape or via the `& Instance` intersection
            // when the member is an Instance API like GetAttribute). The
            // structural callable cast adds pure text noise on these.
            && !ctx.tsShapeTypedLocal.has(expr.func.expr.name)
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
        ctx.dynResultCalls.add(expr);
      }
      call = factory.createCallExpression(calleeExpr, undefined, castArgsForCall(calleeExpr, args, ctx, expr.args, expr.func));
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
      // @rbxts/types declares Instance.GetAttribute → AttributeValue, the
      // union of every possible attribute primitive. Emitting `as unknown`
      // wasted information and forced every downstream use through a
      // second cast; route the call result to the oracle-declared type.
      // LuauChild-typed receiver call results are _LuauChild — bridge
      // through unknown so the AttributeValue cast doesn't trip TS2352.
      const receiverIsLuauChildForCast = exprEmitsLuauChild(expr.func.expr, ctx);
      call = factory.createAsExpression(
        receiverIsLuauChildForCast
          ? factory.createAsExpression(call, factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword))
          : call,
        factory.createTypeReferenceNode('AttributeValue', undefined),
      );
    } else {
      const resolved = resolveLooseMethodCastType(expr, ctx);
      if (resolved.kind === 'class') {
        const targetType = factory.createTypeReferenceNode(resolved.text, undefined);
        // When the call returns Instance (or `Instance | undefined`) and
        // the target is an Instance subclass, the cast `Instance as SubClass`
        // is a valid downcast in TS — no `as unknown` bridge needed.
        // Bridge only when target is `_LuauChild` (forbidden alias) or
        // when the receiver itself returns _LuauChild.
        const targetIsInstanceSubclass = isInstanceSubclassText(resolved.text);
        const sourceNeedsBridge =
          isLuauChildTypeText(resolved.text)
          || exprEmitsLuauChild(expr.func.expr, ctx)
          || !targetIsInstanceSubclass;
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
    // Pass 2: try the corpus require-type cache first. If the require
    // argument resolves to a known module path, use its inferred return
    // shape instead of the `_LuauChild` fallback.
    const cachedTypeText = resolveRequireReturnType(expr.args[0], ctx);
    if (cachedTypeText) {
      call = factory.createAsExpression(
        factory.createAsExpression(
          call,
          factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
        ),
        // Parse the cached type text into a TS type node via a parsed
        // source file. The strings come from our own analyzer so they
        // always parse.
        parseTypeText(cachedTypeText),
      );
    } else {
      ctx.useLuauChildType();
      call = factory.createAsExpression(
        factory.createAsExpression(
          call,
          factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
        ),
        factory.createTypeReferenceNode('_LuauChild', undefined),
      );
    }
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

/** Pass 6: true when `expr` is a shape-typed Local whose synthesized
 *  shape carries a string-keyed index signature (from observed bracket
 *  access in the script). The local's declared TS type already accepts
 *  `t[k]` directly, so the runtime-key bracket-access Record bridges
 *  in compileExpr's IndexExpr path AND in buildAssignmentStatement's
 *  rbxts write path are pure noise — both can skip.
 *
 *  Excludes array-shaped locals (`{push, pop, ...}` observed methods)
 *  because shapeToTypeNode renders those as `Array<defined>` with a
 *  numeric index signature; a string-key bracket access on `Array<T>`
 *  trips TS7015 under noImplicitAny. */
const ARRAY_SHAPE_METHODS = new Set([
  'push', 'pop', 'shift', 'unshift', 'insert', 'remove',
  'indexOf', 'lastIndexOf', 'join', 'concat', 'find',
  'forEach', 'map', 'filter', 'reduce',
]);
function localShapeHasStringIndexSig(expr: Expr, ctx: CompileContext): boolean {
  if (expr.type !== 'Local') return false;
  if (!ctx.tsShapeTypedLocal.has(expr.name)) return false;
  const shape = ctx.getShape(expr.name) as
    | { indexed?: boolean; methods?: Map<string, unknown> }
    | undefined;
  if (!shape?.indexed) return false;
  if (shape.methods) {
    for (const m of shape.methods.keys()) {
      if (ARRAY_SHAPE_METHODS.has(m)) return false;
    }
  }
  return true;
}

/** Pass 3: true when `expr` is a Local bound to `require(...)` AND
 *  `member` is recorded as a 'method' in the corpus index's exported
 *  members for that module. The require result is cast to a structural
 *  type that already declares `member(...args): defined`, so TS sees
 *  `mod.member(...)` as callable — emitting the structural
 *  `unknownCallableCastExpression` or the per-arg
 *  `Parameters<typeof mod.member>[i]` wraps adds pure text noise. */
function isRequireBoundKnownMethod(expr: Expr, member: string, ctx: CompileContext): boolean {
  if (expr.type !== 'Local') return false;
  const path = ctx.requireBoundLocals.get(expr.name);
  if (!path) return false;
  const members = ctx.moduleExportedMembers.get(path);
  return members?.get(member) === 'method';
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
  // Locals TS already types (annotated datatypes, trusted datatype
  // inits) resolve members through @rbxts/types — no bridge.
  if (expr.expr.type === 'Local' && isDatatypeStatic(ctx.tsDeclaredTypeLocal.get(expr.expr.name) ?? 'unknown')) {
    return false;
  }
  // Declared table shape: the annotation names the field, so the read
  // resolves against it directly.
  if (declaredAnnotationOfExpr(expr, ctx)) return false;
  if (isDynExpr(expr.expr, ctx)) return false;
  // Component of a trusted datatype receiver (`v.x` on vector,
  // `cf.Position` on CFrame): @rbxts/types declares it.
  {
    const recv = staticTypeOfExpr(expr.expr, ctx);
    if (isDatatypeStatic(recv) && isTrustedTypedExpr(expr.expr, ctx)) {
      const dt = recv.slice('datatype:'.length);
      if (dt === VECTOR_LIB_TYPE ? VECTOR_LIB_COMPONENTS.has(expr.index) : !!ctx.oracle.propertyType(dt, expr.index)) {
        return false;
      }
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
      // A Call that resolves to a known class (services, Instance.new,
      // datatype factories, oracle method returns) emits as a typed value,
      // not _LuauChild. Bail before the chain-root heuristic mislabels it.
      if (ctx.compatMode === 'rbxts' && resolveOracleClassOfExpr(expr, ctx)) return false;
      return exprMayCompileAsLuauChild(expr.func, ctx);
    case 'Group':
    case 'TypeAssertion':
      return exprMayCompileAsLuauChild(expr.expr, ctx);
    default:
      return false;
  }
}

/** True when the init expression's emission directly produces a value
 *  typed `_LuauChild` (require() call, dynamic-root chain, navigation
 *  method whose oracle result is `_LuauChild`). Excludes Binary
 *  expressions and other forms that propagate `exprEmitsLuauChild`
 *  internally but emit as a union without the explicit `as _LuauChild`
 *  cast. Used to keep `tsLuauChildLocal` consistent with TS-side types. */
function initEmitsLuauChildDirectly(expr: Expr, ctx: CompileContext): boolean {
  switch (expr.type) {
    case 'Group':
    case 'TypeAssertion':
      return initEmitsLuauChildDirectly(expr.expr, ctx);
    case 'Local':
      return ctx.tsLuauChildLocal.has(expr.name);
    case 'IndexName':
      // `.Parent`/etc. emit with explicit `as _LuauChild`.
      if (expr.index === 'Parent') return true;
      return initEmitsLuauChildDirectly(expr.expr, ctx);
    case 'Call':
      if (expr.func.type === 'Global' && expr.func.name === 'require') {
        // Pass 2: when the require resolves via the corpus cache, the
        // post-cast is the structural return type (not `_LuauChild`).
        if (resolveRequireReturnType(expr.args[0], ctx)) return false;
        return true;
      }
      if (
        expr.self
        && expr.func.type === 'IndexName'
        && INSTANCE_LOOSE_METHODS.has(expr.func.index)
      ) {
        const resolved = resolveLooseMethodCastType(expr, ctx);
        return resolved.kind === 'class' && isLuauChildTypeText(resolved.text);
      }
      return exprMayCompileAsLuauChild(expr, ctx);
    default:
      return exprMayCompileAsLuauChild(expr, ctx);
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
      if (expr.func.type === 'Global' && expr.func.name === 'require') {
        // Pass 2: require resolved through the corpus cache — structural
        // type, not _LuauChild.
        if (resolveRequireReturnType(expr.args[0], ctx)) return false;
        return true;
      }
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
      // Honest @rbxts/types fallback: `Instance` (1-arg) / `Instance |
      // undefined` (2-arg). Concrete class only when the literal arg is
      // in the oracle name-table.
      const r = ctx.oracle.waitForChildResult(receiverClass, literalArg, callExpr.args.length === 1 ? 1 : 2);
      return { kind: 'class', text: r.nullable ? `${r.type} | undefined` : r.type };
    }
    case 'FindFirstChild': {
      const r = ctx.oracle.findFirstChildResult(receiverClass, literalArg);
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
    // Lua tolerates `{ a = 1, a = 2 }` (last write wins); TS rejects the
    // duplicate (TS1117). Keep only the final occurrence of each key.
    const lastIndexByKey = new Map<string, number>();
    expr.items.forEach((i, idx) => {
      if (i.key && i.key.type === 'ConstantString') lastIndexByKey.set(i.key.value, idx);
    });
    const deduped = expr.items.filter((i, idx) =>
      !(i.key && i.key.type === 'ConstantString') || lastIndexByKey.get(i.key.value) === idx,
    );
    return factory.createObjectLiteralExpression(
      deduped.map((i) => compileTableProp(i, ctx)),
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
const COMPILER_HEADER = `// Compiled by ${COMPILER_NAME} v${COMPILER_VERSION}.\n`;

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
  /** Pass 2 (Architectural Phase 3 finish): cross-script require()
   *  inference. Map of corpus module path → inferred return-type text.
   *  At `require(X)` emit time, the path argument is resolved against
   *  the current script's path; if a cached return type exists, it
   *  replaces the `_LuauChild` fallback. Built by the CLI/stress driver
   *  via a pre-pass over the corpus. */
  moduleReturnTypes?: Map<string, string>;
  /** Pass 2 extension: module path → field names typed as
   *  `Record<string, defined>` (empty-table init pattern). Consumer
   *  scripts skip the bracket-access Record bridge when chaining into
   *  one of these fields. */
  moduleRecordMapFields?: Map<string, string[]>;
  /** Pass 3: per-module exported-member kind map. Keyed by corpus
   *  path; value is `memberName → 'method' | 'property' | 'recordMap'`.
   *  Same data analyzeModuleReturn produced as a TypeNode, kept in
   *  structured form so per-script compile() can skip the structural
   *  callable cast on calls to known-method members of require-bound
   *  locals. */
  moduleExportedMembers?: Map<string, Map<string, 'method' | 'property' | 'recordMap'>>;
  /** Corpus path → that module's `export type` aliases, from the
   *  cross-script index. Consumers referencing `Mod.Foo` inline the
   *  alias as a local type declaration and resolve fields through it. */
  moduleTypeAliases?: Map<string, Map<string, TypeNode>>;
  /** Corpus path for this script (Roblox instance path or filesystem
   *  path-sans-extension), used as the lookup key for cross-script
   *  `require()` resolution. Distinct from `sourceFile`, which feeds the
   *  source map's `sources` field — they're conflated only when this
   *  option is absent, in which case `sourceFile` is used for both. */
  corpusPath?: string;
  /** Corpus path → emitted module path relative to the output root
   *  (POSIX, no extension). With `outPath`, lets qualified type
   *  references into required modules (`Mod.Foo`) emit as type-only
   *  namespace imports instead of dangling namespace names. */
  moduleOutPaths?: Map<string, string>;
  /** This script's emitted module path, same form as `moduleOutPaths`. */
  outPath?: string;
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
  ctx.tsVisibleTypeOf = (expr) => tsVisibleType(expr as Expr, ctx);
  ctx.staticTypeOfAnnotation = (t) => typeFromAnnotation(ctx.resolveAlias(t));
  if (options.moduleReturnTypes) ctx.moduleReturnTypes = options.moduleReturnTypes;
  if (options.moduleRecordMapFields) ctx.moduleRecordMapFields = options.moduleRecordMapFields;
  if (options.moduleExportedMembers) ctx.moduleExportedMembers = options.moduleExportedMembers;
  if (options.moduleTypeAliases) ctx.moduleTypeAliases = options.moduleTypeAliases;
  ctx.currentScriptPath = options.corpusPath ?? options.sourceFile ?? '';
  if (options.moduleOutPaths) ctx.moduleOutPaths = options.moduleOutPaths;
  ctx.currentOutPath = options.outPath ?? '';
  // rbxts mode: split inline `:WaitForChild():WaitForChild()` instance-nav
  // chains into named locals so each link's oracle-resolved class flows
  // cleanly (instead of getting absorbed by a single `as X` at the end).
  // Pre-pass: rewrite `game.<service>:Method(...)` to bare `<service>` access.
  // Adds the services to a set that flows into the implicit-globals path so
  // each gets a `const X = game.GetService("X")` predecl. roblox-ts forbids
  // direct property access on game/workspace for services.
  const serviceRewrite = ctx.compatMode === 'rbxts'
    ? rewriteGameServices(parsed, ctx.oracle)
    : { servicesUsed: new Set<string>() };
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
    scanUserFunctionAllUnknownParams(rootBlock, ctx);
    scanUserFunctionReturnTypes(rootBlock, ctx);
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
    walkLuauNodes(parsed.root, (n) => {
      if (n.type === 'TypeAlias') {
        const alias = n as unknown as TypeAliasStat;
        if (alias.generics.length === 0 && alias.genericPacks.length === 0) {
          ctx.typeAliases.set(alias.name, alias.aliasType);
        }
      }
    });
  }
  setAliasArities(aliasArities);
  setAliasBodies(ctx.typeAliases);
  setTypeCompatMode(ctx.compatMode);
  if (parsed.root) scanRequireLocalPaths(parsed.root, ctx);
  // `Mod.Foo` names an alias exported by a required module. A module
  // emitting `export = value` cannot also export types, so instead of
  // importing, the alias body is inlined here as `type Mod__Foo = …`.
  // Bare references inside that body to Mod's other aliases hoist the
  // same way, so a whole alias graph carries over.
  const foreignAliasDecls = new Map<string, ts.Statement>();
  const foreignAliasQueue: { local: string; prefix: string; name: string; body: TypeNode }[] = [];
  setTypePrefixResolver((prefix, name, node) => {
    let home: { table: Map<string, TypeNode>; home: string } | null = null;
    let prefixLocal = prefix;
    if (prefix) {
      home = ctx.foreignAliases(prefix);
    } else {
      const scope = ctx.aliasTableFor(node);
      if (!scope.home) return undefined;
      home = { table: scope.table, home: scope.home };
      for (const [local, path] of ctx.requireLocalPaths) {
        if (path === scope.home) { prefixLocal = local; break; }
      }
      if (!prefixLocal) return undefined;
    }
    const body = home?.table.get(name);
    if (!body || !prefixLocal) return undefined;
    const local = `${safeIdentifier(prefixLocal)}__${name}`;
    if (!foreignAliasDecls.has(local)) {
      foreignAliasDecls.set(local, factory.createEmptyStatement());
      foreignAliasQueue.push({ local, prefix: prefixLocal, name, body });
    }
    return local;
  });

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
  // Pass 1 (Architectural Phase 3 finish): per-script class-shape
  // inference for dynamic roots (`script`, `workspace`). Synthesizes a
  // structural type from observed accesses and stashes the result so
  // compileExpr / compileLocal can cast through the synthesized shape
  // instead of routing chains through `_LuauChild`.
  let scriptParentDecls: ts.Statement[] = [];
  if (ctx.compatMode === 'rbxts' && rootBlock) {
    const aliasInits = new Map<string, Expr>();
    collectDynamicAliasInits(rootBlock, aliasInits);
    const inf = inferScriptParentShapes(rootBlock, ctx.oracle, aliasInits);
    ctx.scriptParentRootTypes = inf.rootTypes as Map<string, unknown>;
    ctx.scriptParentAliasTypes = inf.aliasTypes as Map<string, unknown>;
    scriptParentDecls = inf.declarations;
  }
  // Pass 3: same-script function param backprop. Bind concrete TS types
  // for params whose call sites all pass arguments of a consistent
  // class/datatype. `paramsFromLocals` consults the result.
  if (ctx.compatMode === 'rbxts' && rootBlock) {
    const bp = inferParamBackprop(rootBlock, ctx.oracle);
    ctx.paramBackpropTypes = bp.types;
    ctx.paramBackpropParamNames = bp.paramNames;
  }
  // Pass 4: narrow Instance-typed locals to specific subclasses (BasePart,
  // GuiButton, etc.) when observed member access fits a single class.
  if (ctx.compatMode === 'rbxts' && rootBlock) {
    const allLocals = new Set<string>();
    walkLuauNodes(rootBlock, (n) => {
      if (n.type === 'Local' && 'vars' in n) {
        for (const v of (n as unknown as LocalStat).vars) allLocals.add(v.name);
      } else if (n.type === 'ForIn' && 'vars' in n) {
        // Include for-loop bindings (`for k, v of iterable do … end`).
        for (const v of (n as unknown as { vars: { name: string }[] }).vars) {
          allLocals.add(v.name);
        }
      }
    });
    ctx.instanceNarrowings = inferInstanceNarrowings(rootBlock, allLocals, ctx.oracle);
  }
  // Pass 5: loop-var shape inference. For each `for ... in ...` stat,
  // walk its body to collect each loop variable's observed access
  // pattern, synthesize a TS type so downstream member access bypasses
  // the Record routing path. Same `defined`/`Instance` fallback rules
  // as Pass 1.
  let loopVarDecls: ts.Statement[] = [];
  if (ctx.compatMode === 'rbxts' && rootBlock) {
    const lv = inferLoopVarShapes(rootBlock, ctx.oracle);
    ctx.loopVarTypes = lv.byStat as Map<unknown, Map<string, unknown>>;
    loopVarDecls = lv.declarations;
  }
  const stmts: ts.Statement[] = rootBlock ? compileBlockBody(rootBlock, ctx) : [];
  if (rootShapes) ctx.popShapeScope();
  // ModuleScript trailing `return X` → `export = X`. roblox-ts rejects a
  // module-scope `return` outright (TS1108), so rbxts mode always rewrites;
  // native mode keeps single-line `return X` snippets as-is.
  if (stmts.length > 1 || ctx.compatMode === 'rbxts') {
    const last = stmts[stmts.length - 1];
    if (last && ts.isReturnStatement(last) && last.expression) {
      // rbxts: `export = X` is the ModuleScript contract — roblox-ts
      // lowers it to `return X`, matching the Luau the module came
      // from. `export default X` would lower to `return { default = X }`
      // and break every consumer's `require(M).member` access.
      stmts[stmts.length - 1] = factory.createExportAssignment(
        undefined,
        ctx.compatMode === 'rbxts',
        last.expression,
      );
      // TS forbids an export assignment beside any other exported
      // element, and Luau's `export type` has no TS equivalent under
      // `export =` (a module can export a value or a namespace of
      // types, not both). Runtime shape wins: the aliases stay
      // file-local. Cross-module references to them don't resolve —
      // see the `export type` note in the README.
      if (ctx.compatMode === 'rbxts') {
        for (let i = 0; i < stmts.length; i++) {
          const s = stmts[i];
          if (
            s
            && ts.isTypeAliasDeclaration(s)
            && s.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
          ) {
            stmts[i] = factory.updateTypeAliasDeclaration(
              s,
              s.modifiers.filter((m) => m.kind !== ts.SyntaxKind.ExportKeyword),
              s.name,
              s.typeParameters,
              s.type,
            );
          }
        }
      }
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
    // Services discovered via the `game.<service>` rewrite pre-pass.
    for (const name of serviceRewrite.servicesUsed) {
      serviceImplicitGlobals.add(name);
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
    if (ctx.compatMode === 'rbxts') ctx.tsDynLocal.add(name);
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
              ? dynTypeNode()
              : undefined,
            ctx.compatMode === 'rbxts' ? factory.createAsExpression(gRead, dynTypeNode()) : gRead,
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
  setTypePrefixResolver(null);
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
  // Pass 1: type aliases for synthesized script/workspace shapes.
  allStatements.push(...scriptParentDecls);
  // Each hoisted body may reference further foreign aliases; keep
  // draining until the graph closes.
  while (foreignAliasQueue.length > 0) {
    const item = foreignAliasQueue.shift()!;
    foreignAliasDecls.set(item.local, factory.createTypeAliasDeclaration(
      undefined,
      factory.createIdentifier(item.local),
      undefined,
      compileType(item.body),
    ));
  }
  allStatements.push(...[...foreignAliasDecls.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([, s]) => s)
    .filter((s) => !ts.isEmptyStatement(s)));
  allStatements.push(...loopVarDecls);
  allStatements.push(...stmts);
  if (ctx.compatMode === 'rbxts' && statementsReference(allStatements, [DYN_VALUE_TYPE, DYN_FN_TYPE, DYN_METHOD_TYPE])) {
    const dynDecls: ts.Statement[] = [
      factory.createTypeAliasDeclaration(
        undefined,
        factory.createIdentifier(DYN_VALUE_TYPE),
        undefined,
        factory.createIntersectionTypeNode([
          factory.createKeywordTypeNode(ts.SyntaxKind.NumberKeyword),
          factory.createTypeLiteralNode([
            factory.createIndexSignature(
              undefined,
              [factory.createParameterDeclaration(
                undefined,
                undefined,
                factory.createIdentifier('k'),
                undefined,
                factory.createKeywordTypeNode(ts.SyntaxKind.StringKeyword),
              )],
              dynTypeNode(),
            ),
          ]),
        ]),
      ),
      factory.createTypeAliasDeclaration(
        undefined,
        factory.createIdentifier(DYN_FN_TYPE),
        undefined,
        factory.createFunctionTypeNode(
          undefined,
          [factory.createParameterDeclaration(
            undefined,
            factory.createToken(ts.SyntaxKind.DotDotDotToken),
            'args',
            undefined,
            factory.createArrayTypeNode(factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword)),
          )],
          dynTypeNode(),
        ),
      ),
      factory.createTypeAliasDeclaration(
        undefined,
        factory.createIdentifier(DYN_METHOD_TYPE),
        undefined,
        factory.createFunctionTypeNode(
          undefined,
          [
            // `this: unknown`: any receiver TS knows (or doesn't) qualifies;
            // the parameter's presence alone is what roblox-ts keys `:` on.
            factory.createParameterDeclaration(undefined, undefined, 'this', undefined, factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword)),
            factory.createParameterDeclaration(
              undefined,
              factory.createToken(ts.SyntaxKind.DotDotDotToken),
              'args',
              undefined,
              factory.createArrayTypeNode(factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword)),
            ),
          ],
          dynTypeNode(),
        ),
      ),
    ];
    // After imports, before everything else.
    let at = 0;
    while (at < allStatements.length && ts.isImportDeclaration(allStatements[at]!)) at += 1;
    allStatements.splice(at, 0, ...dynDecls);
  }

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
  'vector',
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
  'vector',
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

/** True when any statement references one of `names` as a type. */
function statementsReference(stmts: readonly ts.Statement[], names: readonly string[]): boolean {
  const wanted = new Set(names);
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName) && wanted.has(node.typeName.text)) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  for (const s of stmts) { visit(s); if (found) break; }
  return found;
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
