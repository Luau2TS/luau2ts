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
// Side-effect imports — each module's top-level `registerMacro` calls
// populate the global registry consulted by `lookupMacro` above.
import './macros/datatypes.js';
import './macros/instance.js';
import './macros/stdlib.js';
import './rbxts-runtime.js';
import { detectClasses, compileClassPattern, type ClassPattern } from './class-shape.js';
import { collectLocalNames, collectShapes, shapeToTypeNode } from './shape-infer.js';
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

// ═══════════════════════════════════════════════════════════════════════════
// Statements
// ═══════════════════════════════════════════════════════════════════════════

function compileBlock(block: BlockStat | Stat, ctx: CompileContext): ts.Block {
  return ctx.withScope(() => factory.createBlock(compileBlockBody(block, ctx), true));
}

function compileBlockBody(block: BlockStat | Stat, ctx: CompileContext): ts.Statement[] {
  if (block.type !== 'Block') return statementsOf(block, ctx);

  // — class-shape recognition. In rbxts compat mode, walk the
  // block body once to detect roblox-ts's metatable-OOP class emit pattern
  // and replace each detected group with a synthesized TS class
  // declaration. The constituent statements are dropped from the output.
  const classes = ctx.compatMode === 'rbxts' ? detectClasses(block.body) : [];
  if (classes.length === 0) {
    return block.body.flatMap((s) => statementsOf(s, ctx));
  }

  const consumed = new Set<number>();
  const classByLeadIndex = new Map<number, ClassPattern>();
  for (const c of classes) {
    // Register the class name with the context so subsequent
    // `<Class>.new(...)` calls in the same file are rewritten to
    // `new <Class>(...)` by the macro registry.
    ctx.recordDetectedClass(c.name);
    // Register each INSTANCE method's name so IndexName compile can
    // rewrite value-position `ClassName.method` reads to
    // `ClassName.prototype.method`. Skip static methods (op === '.')
    // — those are accessible statically and the prototype rewrite
    // would fire TS2576 ("did you mean to access the static
    // member?"). Colon-defined methods (op === ':') are always
    // instance.
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
        return [factory.createReturnStatement(compileExpr(stat.values[0]!, ctx))];
      }
      // Multi-value return. In native mode we emit a JS array, which is
      // what `[a, b] = f()` destructure expects on the consumer side.
      // In rbxts mode we emit roblox-ts's `$tuple(...)` macro instead, so
      // re-feeding the output through roblox-ts produces native Luau
      // multi-return (`return a, b`) rather than a Lua table (`return {a, b}`).
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
      // Luau type functions evaluate at type-check time — emit nothing.
      return [];
    case 'DeclareGlobal':
      return [compileDeclareGlobal(stat)];
    case 'DeclareFunction':
      return [compileDeclareFunction(stat)];
    case 'DeclareExternType':
      // Declare-extern-types are .d.ts-style class declarations; we drop
      // them in JS output for now.
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

function compileLocal(stat: LocalStat, ctx: CompileContext): ts.Statement[] {
  // Beautification: drop `local X = <expr>` when <expr> is exactly the
  // identifier `X`. This happens when a macro rewrites the RHS to the
  // same name as the LHS — e.g. `local Workspace = game:GetService("Workspace")`
  // becomes `let Workspace = Workspace` after the GetService macro fires,
  // shadowing the import. Suppressing the local lets the import stay
  // visible to subsequent uses.
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
      return [];
    }
  }

  // Single RHS call with multiple LHS targets → destructuring (multi-return).
  // In rbxts mode the function's return is already wrapped as LuaTuple<[…]>,
  // which roblox-ts destructures natively (`let [a, b] = f()` ⇄ Lua
  // `local a, b = f()`). Drop the multiret wrap so the output stays clean.
  if (stat.vars.length > 1 && stat.values.length === 1 && stat.values[0]?.type === 'Call') {
    // The RHS call genuinely consumes the multi-return tuple; suppress
    // the rbxts-mode single-value auto-extraction.
    const savedMR = ctx.preferMultiReturn;
    ctx.preferMultiReturn = true;
    const rawInit = compileExpr(stat.values[0]!, ctx);
    ctx.preferMultiReturn = savedMR;
    // In rbxts mode cast the RHS to `any` so the destructured locals
    // each pick up `any` instead of the LuaTuple's typed components
    // (`unknown` triggers TS18046 on every property access; nullable
    // slot types trigger TS18047). A tuple cast `as [any, any]` would
    // require type-overlap with the source — TS rejects that against
    // LuaTuple discriminated unions (TS2352). Single `as any` is the
    // safest widening.
    const init = ctx.compatMode === 'rbxts'
      ? factory.createAsExpression(
          rawInit,
          factory.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword),
        )
      : factory.createCallExpression(
          factory.createIdentifier(ctx.use('multiret')),
          undefined,
          [rawInit],
        );
    const anyShadow = stat.vars.some((v) => ctx.hasLocalInCurrentScope(v.name));
    for (const v of stat.vars) ctx.assignLocal(v.name, typeFromAnnotation(v.annotation));
    if (anyShadow) {
      // Any var already in scope means `let [a, b] = …` would TS-error on the
      // shadowed name. Emit bare destructuring assignment instead — Luau
      // semantics for `local x, y = f()` when x or y already exist is "reuse
      // the in-scope binding" in this same scope.
      return [factory.createExpressionStatement(
        factory.createAssignment(
          factory.createArrayLiteralExpression(
            stat.vars.map((v) => factory.createIdentifier(safeIdentifier(v.name))),
          ),
          init,
        ),
      )];
    }
    // Luau lets you write `local _, _, _, xx, ...` with duplicate `_` to
    // discard values. JS forbids duplicate names in one destructure, so
    // rewrite duplicates (including the standard `_` placeholder) to fresh
    // names like `_skip_0`. Single `_` keeps its original name.
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

  // Luau lets you write `local X = ...` after a previous `local X = ...` in
  // the same block; the second declaration shadows the first. TS `let`
  // can't redeclare in the same scope, so a same-scope shadow becomes an
  // assignment to the existing binding. (Cross-block shadow stays a real
  // `let` since `withScope` opens a fresh JS block scope.)
  const newDecls: ts.VariableDeclaration[] = [];
  const reassignments: ts.Statement[] = [];
  for (let i = 0; i < stat.vars.length; i += 1) {
    const v = stat.vars[i]!;
    const init = stat.values[i];
    let initExpr = init ? compileExpr(init, ctx) : undefined;
    // `local x: { [string]: T } = {}` — the empty Luau table compiles to
    // `[]` by default (array literal), which tsc rejects against any
    // non-array annotation. Swap to `{}` when the annotation is clearly
    // not an array shape. Same rationale as the TypeAssertion swap; this
    // covers the `local x: Foo = {}` case the assertion path can't see.
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
    // Pick the JS name for the new binding.
    //
    // Luau: in `local X = expr`, free references to `X` inside `expr` bind to
    // the OUTER `X`. JS `let X = function () { X() }` infinite-recurses because
    // the inner `X` is the new local (TDZ-shadowed at parse time, then the new
    // local at runtime). To stay faithful we rename the new local to a fresh
    // JS name when init captures the same name; the inner reference then
    // resolves to the still-unshadowed outer binding. Future Luau-side reads
    // of `X` in this scope go through `ctx.getLocalJsName` and pick up the
    // fresh name.
    let jsName = safeName;
    if (initExpr && !ctx.hasLocalInCurrentScope(v.name) && containsFreeRef(initExpr, safeName)) {
      jsName = ctx.freshIdentifier(`${safeName}_local`);
      ctx.setLocalJsName(v.name, jsName);
    } else if (ctx.hasLocalInCurrentScope(v.name)) {
      jsName = ctx.getLocalJsName(v.name) ?? safeName;
    } else if (ctx.hasLocalInOuterScope(v.name)) {
      // Cross-block shadow: outer scope already binds `X`, and Luau lets
      // earlier statements in this block read the outer value before this
      // `local X = ...` line introduces the inner one. JS `let` hoists the
      // inner binding to the top of the block, so those earlier reads
      // hit TDZ. Rename the inner to a fresh JS name; reads up to this
      // point resolve to the outer, reads after this line go through the
      // jsNameOverride to the new name.
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
      // Phase 1 of the rbxts cleanup: don't broadly annotate locals as
      // `: any`. Earlier we widened `let x` / `let x = nil` / `let x
      // = {}` to `: any` to absorb Luau's "everything is a runtime
      // table" semantics, but that propagates `any` into every
      // downstream usage and trips roblox-ts's no-any rule N times.
      //
      // Phase 2 (rbxts-only): if the surrounding function body
      // exposes a non-empty access shape for this local (e.g. `let
      // origSize = button.Size; origSize.X.Scale; origSize.Y.Offset`),
      // materialize the shape as a structural type annotation so
      // downstream chained access typechecks without TS18046. The
      // initializer is also cast `as unknown as Shape` so the
      // annotation accepts even an `unknown`-typed RHS (the common
      // case when the source is a leaf in another variable's shape).
      //
      // The narrow fallbacks if no shape applies:
      //   • `let x;` (no init AND no annotation) — annotate as
      //     `unknown` so subsequent writes don't fail TS7034.
      //   • `let x = nil` — same, annotate as `unknown` so TS
      //     doesn't narrow to literal `undefined`.
      //   • table-init / other: leave bare and let TS infer.
      let typeNode: ts.TypeNode | undefined = v.annotation ? compileType(v.annotation) : undefined;
      const initIsNil = init?.type === 'ConstantNil';
      if (!typeNode && ctx.compatMode === 'rbxts') {
        // Phase 2 shape inference for locals: only apply when the
        // initializer is one that TS would otherwise infer as
        // `unknown` — bare identifier reads, property accesses, or
        // missing/nil init. For initializers that produce a
        // properly-typed value (Instance.new(…), function calls,
        // table literals, constructors), let TS infer from the init
        // — the inferred type is almost always better than what our
        // structural shape would synthesize.
        const initIsShapelyCandidate =
          !init
          || init.type === 'ConstantNil'
          || init.type === 'Local'
          || init.type === 'Global'
          || init.type === 'IndexName'
          || init.type === 'IndexExpr';
        if (initIsShapelyCandidate) {
          const inferred = ctx.getShape(v.name) as
            | import('./shape-infer.js').Shape
            | undefined;
          const fromShape = inferred ? shapeToTypeNode(inferred) : null;
          if (fromShape) {
            typeNode = fromShape;
            if (initExpr) {
              // Route the initializer through `as unknown as <shape>`
              // so even an `unknown` RHS satisfies the annotation.
              initExpr = factory.createAsExpression(
                factory.createAsExpression(
                  initExpr,
                  factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
                ),
                fromShape,
              );
            }
            // No initializer: emit `let X!: <shape>` (definite-
            // assignment assertion). The user's Luau code assigns
            // X later in a loop / branch that TS can't statically
            // prove — `!` tells TS to trust us. Reads before
            // assignment will still crash at runtime; that's
            // identical to the Luau original.
          } else if (!initExpr || initIsNil) {
            typeNode = factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);
          }
        }
      }
      // rbxts mode: a shape-typed local without an initializer needs
      // a `!` (definite-assignment assertion) so TS doesn't fire
      // TS2454 on later reads. The user's Luau code assigns the
      // variable in a loop or branch we can't statically prove.
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
    }
  }
  const out: ts.Statement[] = [];
  if (newDecls.length > 0) {
    out.push(factory.createVariableStatement(
      undefined,
      factory.createVariableDeclarationList(
        newDecls,
        stat.isConst ? ts.NodeFlags.Const : ts.NodeFlags.Let,
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

function asyncModIfNeeded(body: ts.Block): readonly ts.Modifier[] | undefined {
  return bodyContainsAwait(body) ? ASYNC_MOD : undefined;
}

/** Walk a Luau function body looking for multi-value `return` statements.
 *  Returns the largest number of values across any return; null if every
 *  return has 0 or 1 value. Skips nested functions since each one's
 *  return shape is its own concern. */
/** True if the given TS statement contains a `return` outside any
 *  nested function/arrow/method scope. Used to detect top-level
 *  early-exit patterns that need to be wrapped in an IIFE for
 *  TS to accept (TS1108 fires on bare module-scoped `return`). */
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
        // 0 or 1-value return — incompatible with a LuaTuple<[…]>
        // annotation. Track so callers can decide to skip the
        // multi-return widening entirely.
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
    // Other statement kinds (Local, Assign, Expr, etc.) can't contain a
    // direct return, so we don't need to descend into them.
  }
  walk(body);
  // Mixed-arity functions can't be typed as `LuaTuple<[…]>` because the
  // single-return paths would each need wrapping. Drop the widening.
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
    // A previously declared local with the same name (e.g. `local scrollUp`
    // then later `function scrollUp(args)`) makes the JS function-declaration
    // form a redeclaration conflict. Emit assignment instead. Same for names
    // the script wrapper provides as parameters (`script`, `plugin`, ...):
    // `function script(s) {...}` would hoist past the wrapper's binding,
    // breaking every earlier `script.Method()` call in the body (Lua's
    // dynamic-global lookup matches the assignment's *position*; JS's
    // lexical hoisting would not).
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
  // Member: `obj.x = function ...` — use the parsed name as an lvalue.
  // When the implementation got forced-async (body contains `await` because
  // it calls into a yieldable Luau API like pcall) AND the slot lives on
  // a typed object, the assignment will trip on a return-type mismatch:
  // the user's impl-type says `(...) -> T` but the function evaluates to
  // `Promise<T>`. Cast the base through `any` so the slot's sync return
  // type doesn't reject the async impl. Property access on reads is
  // unaffected — readers still see the typed slot.
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
    // Anti-exploit scripts use `for i=-math.huge, math.huge, 1 do …` to lock
    // up Roblox. Without a guard the same loop hangs every browser tab. Bail
    // out as soon as the loop variable is non-finite — Infinity/NaN bounds
    // could never make forward progress anyway.
    //
    // In rbxts mode `Number` (the JS global) is only a TYPE under
    // @rbxts/types — `Number.isFinite` fires TS2693. Roblox's runtime
    // is the Lua VM so the browser-DoS scenario doesn't apply; skip the
    // guard entirely. (If we need it later we'd encode it via `i === i`
    // + math.abs(i) < math.huge.)
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

function compileForIn(stat: ForInStat, ctx: CompileContext): ts.Statement[] {
  // Lua: `for k, v in pairs(t) do … end`. Lua's iteration triple is
  // (iter_fn, state, init_value)
  // The full iterator protocol desugars to a while loop calling iter_fn
  // (see slow path below). For the two overwhelmingly common cases — a
  // single-call RHS of `ipairs(arr)` or `pairs(t)` — we emit the much
  // shorter TS-native equivalents instead.

  // Fast path for explicit `ipairs(arr)` / `pairs(t)` — native-only.
  // rbxts mode handles every for-in form below (`for-of` for arrays,
  // `ipairs(arr)` global for two-binding); the fast path's C-style
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

  // rbxts mode: emit `for (const v of value) { … }` (single var) or
  // `for (const [i, v] of (value as ReadonlyArray<defined>).entries()) { … }`
  // (multi var). roblox-ts compiles both forms to Lua ipairs-style
  // iteration and preserves the element type, so the body's `v` keeps
  // whatever element type the source array carried — important because
  // roblox-ts rejects operations on `any` / `unknown`.
  //
  // Dict iteration via pairs() would be more faithful for table-style
  // sources, but pairs() over an `any`-typed iterable crashes rbxtsc,
  // and pairs() over a properly-typed object yields keys that include
  // method names. Array iteration is the more common Luau pattern AND
  // the one roblox-ts is happiest with — accept the trade-off; users
  // who really want dict iteration can write the for-of explicitly.
  if (ctx.compatMode === 'rbxts') {
    // Source forms like `for _, v in ipairs(arr) do` already call
    // ipairs(); our emit below also wraps in ipairs() so we'd produce
    // `ipairs(ipairs(arr))`. Unwrap the explicit call so the wrap
    // doesn't double up. Same for pairs() (used in dict iteration).
    let iterableSource: Expr | null = null;
    // True when the user explicitly wrote `pairs(t)` — preserves the
    // dict-iteration semantics (key = table key, not array index) by
    // routing through @rbxts/types' pairs() declaration below instead
    // of the default ipairs() wrap.
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
    // Cast the iterable to `Array<any>` so the destructured value type
    // is `any` (not `unknown`). Without the cast, ipairs(any) infers
    // the element type as `unknown`, which then fails every body
    // access with TS18046 ("X is of type 'unknown'"). Same trick as
    // for-of method-result casts: roblox-ts accepts `any` in this
    // position, real Roblox runtime doesn't care.
    //
    // The direct cast `expr as any[]` is rejected by TS when the
    // source's static type doesn't overlap with `any[]` — e.g. a
    // record-shaped table `{ a: number; b: number }`. Route through
    // `unknown` first to widen unconditionally.
    const castedIterable = factory.createAsExpression(
      factory.createAsExpression(
        iterableExpr,
        factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
      ),
      factory.createArrayTypeNode(factory.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword)),
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
    // Two-binding `for k, v in arr do`:
    //   • Default / user-wrote-ipairs: use ipairs() — array iteration,
    //     k = 1-based index (typed `number`), v = element.
    //   • User-wrote-pairs: use pairs() — dict iteration, k = table key
    //     (could be any type), v = value. Wrapping in `pairs(... as any)`
    //     widens both slots so the destructured locals get `any`.
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
    // pairs(x as any) types its key as `string | number | symbol`
    // (`keyof any`); ipairs(x as any[]) types its key as `number`.
    // Cast the iterator-call result to `any` for pairs() so the
    // destructured key picks up `any` and `key.X` access typechecks
    // under Luau-style dynamic key usage.
    const iterableForFor: ts.Expression = userWantsPairs
      ? factory.createAsExpression(iterCall, factory.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword))
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

  // Wrap in `genericIter(expr)` so generic-for works regardless of
  // whether the RHS is an iterator triple, a callable, a metatable
  // with `__iter`, or a plain table/array (Luau's no-pairs shorthand).
  // The raw destructure used to break silently on arrays — Roblox code
  // like `for _, x in CollectionService:GetTagged("Tag") do` would
  // iterate zero times, leaving derived state (tycoon button labels,
  // tag-bound systems) at their defaults.
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

  // pairs — iterates every (key, value) pair on a record/object.
  // `for k, v in pairs(t) do …` → `for (const k of pairKeys(t)) { const v = pairValue(t, k); … }`
  // `for k in pairs(t) do …` → `for (const k of pairKeys(t)) { … }`
  // Uses the runtime helper instead of `Object.keys` so Instance-keyed
  // tables (e.g. `offsets[part] = x`) yield the actual Instance back as
  // the key rather than its `.toString()` string artifact. The runtime
  // installs a key reifier; without it pairKeys behaves identically to
  // Object.keys (with proper numeric-index handling).
  //
  // rbxts mode skips the helpers entirely: roblox-ts has a global `pairs`
  // in @rbxts/types that returns the standard Lua (k, v) iterator, so we
  // just defer to it via `for (const [k, v] of pairs(t)) { … }`.
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
      return factory.createExpressionStatement(
        factory.createAssignment(
          factory.createElementAccessExpression(compileExpr(target.expr, ctx), lit),
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
      // Cast the receiver to `Record<string, unknown>` so the assignment
      // accepts the RHS regardless of the receiver's declared shape AND
      // the key is treated as a `string` slot (not narrowed to the
      // receiver's known prop names). Routing the key through
      // `unknown as string` covers Instance/Player/unknown-typed keys
      // without triggering TS2538. roblox-ts's no-any rule isn't
      // tripped because we widened via `Record` and `string`, not
      // `any`. Round-trip back to Lua is identity (`t[k] = v`).
      const recv = factory.createParenthesizedExpression(
        factory.createAsExpression(
          compileExpr(target.expr, ctx),
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
function compileLValue(target: Expr, ctx: CompileContext): ts.Expression {
  if (target.type === 'IndexName') {
    // Phase 2: when target is `<simpleRef>.<name>` in rbxts mode,
    // cast the receiver to `Record<string, unknown>` so writes to
    // ANY property name typecheck — supports Luau's monkey-patch
    // idiom (`ProfileService.GetProfileStore = function …`, `API
    // .OnEquippedChanged = signal.Event`). The receiver's declared
    // members are preserved on READ sites; only WRITES route
    // through Record. Skip when the target receiver is `self` —
    // class-method body writes (`self.X = …`) must hit the class
    // declaration, not a generic record. Skip when the property
    // name isn't a valid identifier (we use literal forms then).
    const isSelf =
      (target.expr.type === 'Local' && (target.expr as { name: string }).name === 'self')
      || (target.expr.type === 'Global' && (target.expr as { name: string }).name === 'self');
    if (
      ctx.compatMode === 'rbxts'
      && !isSelf
      && (target.expr.type === 'Local' || target.expr.type === 'Global')
      && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(target.index)
    ) {
      return factory.createPropertyAccessExpression(
        factory.createParenthesizedExpression(
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
    const valueExpr = ctx.compatMode === 'rbxts'
      ? factory.createAsExpression(
          rawRhs,
          factory.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword),
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
  const stmts: ts.Statement[] = [];
  for (let i = 0; i < stat.vars.length; i += 1) {
    const target = stat.vars[i]!;
    const value = stat.values[i];
    if (!value) continue;
    let valueExpr = compileExpr(value, ctx);
    if (target.type === 'Local') ctx.assignLocal(target.name, staticTypeOfExpr(value, ctx));
    // rbxts mode: if the target is a local that has an inferred
    // structural shape, cast the RHS `as unknown as <shape>` so a
    // reassignment from an `unknown` source (`origSize = button.Size`
    // where button.Size is a `Size: unknown` leaf in button's shape)
    // still typechecks against the local's declared shape.
    if (ctx.compatMode === 'rbxts' && target.type === 'Local') {
      const inferred = ctx.getShape((target as { name: string }).name) as
        | import('./shape-infer.js').Shape
        | undefined;
      const fromShape = inferred ? shapeToTypeNode(inferred) : null;
      if (fromShape) {
        valueExpr = factory.createAsExpression(
          factory.createAsExpression(
            valueExpr,
            factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
          ),
          fromShape,
        );
      }
    }
    // rbxts mode: `obj.X = rhs` where rhs is `unknown` / `{}` and
    // obj.X has a typed slot (TextLabel.Text: string, BasePart.
    // BrickColor: BrickColor, etc.) — cast the RHS through
    // `as unknown as typeof obj.X`. Requires obj to be a simple
    // identifier so `typeof obj.X` is valid in type position.
    // (We'd need entity-name chains for deeper paths; the simple
    // case covers the dominant `lbl.Text = …` / `wrap.Name = …`
    // patterns.)
    if (
      ctx.compatMode === 'rbxts'
      && target.type === 'IndexName'
      && (target.expr.type === 'Local' || target.expr.type === 'Global')
      && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(target.index)
    ) {
      const compiledObj = compileExpr(target.expr, ctx);
      if (ts.isIdentifier(compiledObj)) {
        valueExpr = factory.createAsExpression(
          factory.createAsExpression(
            valueExpr,
            factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
          ),
          factory.createTypeQueryNode(
            factory.createQualifiedName(
              factory.createIdentifier(compiledObj.text),
              factory.createIdentifier(target.index),
            ),
          ),
        );
      }
    }
    // `tbl[k] = v` with a non-literal numeric key compiles to a luaIndexSet
    // call; plain `target = v` would emit `luaIndex(tbl, k) = v` which is
    // not a valid LHS in TS. Literal numeric / string keys go through plain
    // bracket assignment so they preserve assignment semantics for things
    // like array.length tracking.
    const writeStmt = buildAssignmentStatement(target, valueExpr, ctx);
    stmts.push(writeStmt);
    // `_G["X"] = expr` in Lua sets the global `X`. In JS our `_G` is a
    // plain object, so the assignment only updates _G.X — a later bare
    // `X(...)` reads the implicit-global predecl (undefined) and crashes.
    // Mirror to the matching local binding when the key is a valid identifier.
    // Use `_G["X"]` as the RHS so any side effects in `expr` only run once.
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
    // rbxts mode: route arithmetic compound assigns through the
    // expanded `target = target <op> value` form so the same
    // `as any` operand widening compileBinary applies kicks in.
    // Without this, `x += hit.Cash.Value` where `hit.Cash.Value`
    // is unknown fires TS18046 (`Object of type 'unknown'`).
    // Native mode keeps the tight `+=` form since unknown
    // arithmetic isn't an issue there.
    if (ctx.compatMode === 'rbxts') {
      return factory.createExpressionStatement(
        factory.createAssignment(target, newValue),
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
  // Treat a function whose first explicit argument is literally named
  // `self` as a method, but ONLY when the function is being defined as
  // a member of an object (e.g. `function Invisicam.SetMode(self, ...)`
  // or via assignment to `Obj.method`). For bare `local function f(self, …)`
  // the `self` is a regular positional parameter — collapsing it into
  // `this` would change the function's arity and break every caller.
  const implicitSelf = (options.allowImplicitSelf ?? false)
    && fn.self === null
    && fn.args.length > 0
    && (fn.args[0]!.name === 'self' || fn.args[0]!.name === '_');
  const hasSelf = fn.self !== null || implicitSelf;
  if (hasSelf) {
    // `this: any` rather than `this: unknown`: Luau methods defined via
    // `obj:method(...)` (colon syntax) or `function obj.method(self, ...)`
    // attach to setmetatable-built instances whose shape doesn't survive
    // translation — TS has no way to recover the instance type from the
    // metatable plumbing. `unknown` rejects every `self.field` access
    // downstream; `any` matches Luau's actual semantics (the method body
    // is free to touch any field on the receiver). Users who want stricter
    // typing can annotate explicitly.
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
  // Phase 2 (rbxts-only): pre-scan the function body so paramsFromLocals
  // AND compileLocal can synthesize structural interfaces for each
  // unannotated param / local. Track every observed name in the
  // body — params AND locals — so chained reads like
  // `let origSize = button.Size; ... origSize.X.Scale` get a typed
  // local annotation rather than `: unknown`.
  let paramShapes: Map<string, import('./shape-infer.js').Shape> | undefined;
  if (ctx.compatMode === 'rbxts' && fn.body) {
    const trackedNames = new Set<string>(realArgs.map((a) => a.name));
    for (const n of collectLocalNames(fn.body)) trackedNames.add(n);
    paramShapes = collectShapes(fn.body, trackedNames);
    ctx.pushShapeScope(paramShapes as Map<string, unknown>);
  }
  for (const p of paramsFromLocals(realArgs, ctx, paramShapes)) {
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
    if (fn.vararg) ctx.defineLocal('__varargs', 'unknown');
    if (hasSelf) ctx.defineLocal('self', 'unknown');
    const bodyStatements = compileBlockBody(fn.body, ctx);
    if (hasSelf) {
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
): ts.ParameterDeclaration[] {
  const seen = new Set<string>();
  const out: ts.ParameterDeclaration[] = [];
  // Detect a trailing run of nilable annotations and mark them optional.
  // Luau treats `data: T?` as both nilable AND positionally optional, but
  // TS requires the explicit `?` marker for the latter — without it,
  // callers that omit the arg get "Expected N arguments, got N-1".
  // Optionality has to be trailing: once a required arg follows, the
  // earlier `?` slots can't be omitted positionally either.
  const optionalFrom = computeTrailingOptionalStart(locals);
  // rbxts-mode extension: a trailing run of UNANNOTATED params can also
  // be marked optional, since their type is `any` regardless. We compute
  // a separate cutoff that accepts unannotated-or-nilable; the cutoff
  // applies on top of `optionalFrom` (annotated-nilable wins because it
  // chooses the `= undefined` default path instead of `?`).
  let rbxtsOptionalFrom = ctx.compatMode === 'rbxts'
    ? computeTrailingOptionalStartRbxts(locals)
    : locals.length;
  // Phase 2 adjustment: if any param has a non-empty inferred shape,
  // it's REQUIRED (`param.X` access in the body fails if param is
  // possibly-undefined). TS forbids required-after-optional, so
  // pull `rbxtsOptionalFrom` past the last shape-required param —
  // i.e. nothing optional can precede a shape-typed param.
  if (shapes) {
    let lastShapeRequired = -1;
    locals.forEach((local, i) => {
      if (local.annotation) return;
      const sh = shapes.get(local.name);
      if (sh && !sh.empty) lastShapeRequired = i;
    });
    if (lastShapeRequired + 1 > rbxtsOptionalFrom) {
      rbxtsOptionalFrom = lastShapeRequired + 1;
    }
  }
  locals.forEach((local, i) => {
    const base = safeIdentifier(local.name);
    let name = base;
    if (seen.has(name)) name = `_dup_${i}`;
    seen.add(name);
    // For trailing nilable params (`data: T?`) we used to emit `data?: T | null`,
    // which gives the in-body type `T | null | undefined` — the extra
    // `| undefined` then conflicts with `T | null`-typed receivers (record
    // fields, other-param signatures). Instead, emit `data: T | null = null`:
    // a default value keeps the param call-site-optional, while the in-body
    // type stays the declared `T | null` without `| undefined` widening.
    const isOptional = i >= optionalFrom;
    // Native mode: leave unannotated params untyped (TS infers).
    // rbxts mode: roblox-ts requires `strict: true` which rejects
    // implicit-any params (TS7006); annotate explicitly as `unknown`.
    // Phase 1 of the rbxts cleanup switched away from `: any` —
    // every body access on the param fired roblox-ts's no-any rule.
    // `unknown` keeps the call site flexible AND satisfies strict
    // mode AND keeps roblox-ts happy. Body accesses now require
    // narrowing (TS18046); Phase 2 will narrow by inferring shapes
    // from observed access patterns.
    let ty: ts.TypeNode | undefined;
    /** True iff Phase 2 inference produced a non-empty shape for this
     *  param. Synthesized shapes assume the value exists (body reads
     *  fail otherwise), so we suppress the `?` optionality marker —
     *  callers must pass a conforming value. */
    let hasInferredShape = false;
    if (local.annotation) {
      ty = compileType(local.annotation);
    } else if (ctx.compatMode === 'rbxts') {
      const shape = shapes?.get(local.name);
      const fromShape = shape ? shapeToTypeNode(shape) : null;
      if (fromShape) {
        ty = fromShape;
        hasInferredShape = true;
      } else {
        ty = factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);
      }
    }
    // rbxts mode: Luau call semantics let any param be omitted (missing
    // positional args become `nil`); roblox-ts strict mode rejects
    // mismatched arity unless params carry `?`. For UNANNOTATED params
    // that sit in the rbxts-trailing-optional region (every later param
    // is also unannotated-or-nilable), mark them optional (`name?: any`)
    // so legacy Luau callers that pass fewer args than the declaration
    // still typecheck. An annotated `: number` param without `?` is the
    // user's explicit signal that the arg is required.
    const rbxtsImplicitOptional =
      ctx.compatMode === 'rbxts' && !local.annotation && i >= rbxtsOptionalFrom;
    // When Phase 2 inferred a non-empty shape, the body assumes the
    // value exists. Marking it optional turns `param.X` into
    // TS18048 ("possibly undefined") at every access. Drop the `?`
    // for shape-typed params and require callers to supply.
    const useQuestion = rbxtsImplicitOptional && !isOptional && !hasInferredShape;
    // In rbxts mode the default value is `undefined` to match the
    // nil-as-undefined choice (roblox-ts rejects `null` literally).
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
      // Constructor calls — `Vector3.new(…)`, `CFrame.new(…)`, etc.
      // narrow the result to the datatype so subsequent arithmetic can
      // fast-path `a + b` to `a.add(b)`.
      const f = expr.func;
      if (f.type === 'IndexName' && f.expr.type === 'Global' && ARITH_DATATYPES.has(f.expr.name)) {
        return `datatype:${f.expr.name}` as StaticValueType;
      }
      return 'unknown';
    }
    case 'ConstantBool':
      return 'boolean';
    case 'ConstantString':
      return 'string';
    case 'ConstantNil':
      return 'nil';
    case 'Local':
      return ctx.lookupLocal(expr.name);
    case 'Group':
      return staticTypeOfExpr(expr.expr, ctx);
    case 'TypeAssertion':
      return typeFromAnnotation(expr.annotation, expr.expr, ctx);
    case 'Unary':
      if (expr.op === 'not') return 'boolean';
      if (expr.op === '#' || expr.op === '-') return 'number';
      return 'unknown';
    case 'Binary':
      if (['+', '-', '*', '/', '%', '^', '//'].includes(expr.op)) {
        return staticTypeOfExpr(expr.left, ctx) === 'number'
          && staticTypeOfExpr(expr.right, ctx) === 'number'
          ? 'number'
          : 'unknown';
      }
      if (['==', '~=', '<', '<=', '>', '>='].includes(expr.op)) return 'boolean';
      // Lua `..` produces a string when either side is statically string-
      // or-number — the runtime coerces both sides to strings.
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
      // Lower `nil` to `null` in native mode (every nilable annotation
      // `T?` compiles to `T | null`, so passing/returning `nil` stays
      // aligned with the declared types). In rbxts mode, lower to
      // `undefined` instead — roblox-ts explicitly rejects `null` with
      // "null is not supported, use undefined" and asymmetric type
      // alignment is less important than passing the round-trip check.
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
      // Register the global so the emitter can either auto-import it from
      // `luau2ts/runtime` (for names the runtime exports) or prepend a
      // `declare const X: any;` (for host-environment names like `task`).
      // Local aliases shadow this — `local task = …` causes the read to
      // route via `getLocalJsName`, so we only register when there's no
      // overriding local.
      if (!ctx.getLocalJsName(expr.name)) {
        if (RUNTIME_AVAILABLE_GLOBALS.has(expr.name)) {
          // In rbxts mode these names (pcall, error, tostring, table, os,
          // string, math, ...) are real Lua/Roblox globals — roblox-ts has
          // them declared in `@rbxts/types`. Importing them from our
          // runtime would shadow the global with a JS impl that roblox-ts
          // couldn't unpack. Route through useAmbient instead so the bare
          // identifier survives to the output, with a `declare const X: any`
          // preamble keeping our own --check-ts happy.
          if (ctx.compatMode === 'rbxts') {
            ctx.useAmbient(expr.name);
          } else {
            ctx.use(expr.name);
          }
        } else if (AMBIENT_GLOBALS.has(expr.name)) {
          ctx.useAmbient(expr.name);
        }
      }
      // rbxts-mode name remappings for Lua globals that don't have a
      // matching identifier in @rbxts/types or whose name collides with
      // a TS reserved word:
      //   • `typeof`  → `typeOf`   (declared in @rbxts/compiler-types)
      //   • `workspace` → `(game.Workspace as any)` (workspace is NOT
      //     declared global in @rbxts/types; `game` is. Cast to `any`
      //     so the runtime-named children access typechecks under strict.)
      if (ctx.compatMode === 'rbxts' && !ctx.getLocalJsName(expr.name)) {
        if (expr.name === 'typeof') {
          return factory.createIdentifier('typeOf');
        }
        if (expr.name === 'workspace') {
          return factory.createAsExpression(
            factory.createPropertyAccessExpression(
              factory.createIdentifier('game'),
              factory.createIdentifier('Workspace'),
            ),
            factory.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword),
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
      // Property names allow reserved words (`obj.new` is fine) — use
      // propertyName, not safeIdentifier, so `Instance.new("Part")` stays
      // as-written instead of becoming `Instance.new_("Part")`.
      //
      // Special case: value-position `<DetectedClass>.new` in rbxts mode.
      // The class macro rewrites `<Class>.new(args)` CALL sites to
      // `new <Class>(args)`, but bare references like
      // `return { new = MyClass.new }` aren't calls and fall through to
      // here. roblox-ts doesn't expose `.new` as a real property on the
      // TS class, so the bare access fails type-check. Synthesize a
      // forwarding arrow `(...args: unknown[]) => new <Class>(...args)`
      // so the value-shape stays the same (a callable that constructs).
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
          // Cast the class to a constructor signature so TS / roblox-ts
          // accept the spread invocation regardless of the real ctor's
          // declared arity.
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
      // rbxts mode: property access on `game` / `workspace` / `script`
      // / `plugin` returns Instance-typed values. Real Roblox scripts
      // read service or child accesses freely; @rbxts/types only
      // exposes the declared properties (Workspace.Camera etc.),
      // missing every user folder (`game.MyFolder`,
      // `workspace.Tycoons`, etc.). Cast the root to `any` so the
      // entire access chain is dynamically typed. Subsequent
      // `.Parent` / FindFirstChild casts compose with this.
      //
      // (We tried a recursive `_LuauChild` type alias instead of
      // `any` to satisfy roblox-ts's no-any rule, but the
      // intersection with Instance made `Instance | undefined` slots
      // surface as TS2532. `as any` remains the working compromise
      // for these few well-known roots.)
      if (ctx.compatMode === 'rbxts') {
        // Check both the Luau-AST receiver (Global name) AND the
        // compiled-receiver identifier so macros that rewrite
        // `game:GetService("X")` to a bare `X` identifier still
        // benefit from the service-cast path.
        const luauReceiverName =
          expr.expr.type === 'Global' ? (expr.expr as { name: string }).name : null;
        if (luauReceiverName && RBX_DYNAMIC_ROOTS.has(luauReceiverName)) {
          return factory.createPropertyAccessExpression(
            factory.createAsExpression(
              compileExpr(expr.expr, ctx),
              factory.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword),
            ),
            factory.createIdentifier(propertyName(expr.index)),
          );
        }
        // For services imported from `@rbxts/services`, route
        // through the recursive `_LuauChild` interface so dynamic-
        // child access (`ReplicatedStorage.BindableEvents`,
        // `ServerScriptService.PlayerData`) typechecks without `any`.
        // Services don't have the `Parent` / `FindFirstChild`
        // pattern that broke the _LuauChild + Instance intersection
        // for `game` / `workspace` — they're plain Instance-derived
        // containers whose children are runtime-named.
        //
        // Detect a service receiver either via the Luau AST (bare
        // `ServerScriptService.Foo`) OR via the compiled receiver
        // when a macro produced the identifier (`game:GetService(
        // "ServerScriptService").Foo` → the inner Call macros to
        // identifier `ServerScriptService`, then we compile its
        // IndexName here).
        const compiledReceiver = compileExpr(expr.expr, ctx);
        const compiledIdent =
          ts.isIdentifier(compiledReceiver) ? compiledReceiver.text : null;
        const serviceName =
          (luauReceiverName && ctx.isRbxService(luauReceiverName)) ? luauReceiverName
          : (compiledIdent && ctx.isRbxService(compiledIdent)) ? compiledIdent
          : null;
        if (serviceName) {
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
      // Phase 2: when reading an INSTANCE method off the class
      // identifier as a value (`local m = Class.method`), rewrite
      // to `Class.prototype.method` so the method-descriptor is
      // accessible. The Luau idiom of capturing method references
      // (e.g. `setmetatable({}, {Connect = ScriptSignal.Connect})`)
      // doesn't work via the class identifier in TS — instance
      // methods only live on the prototype.
      if (
        ctx.compatMode === 'rbxts'
        && (expr.expr.type === 'Global' || expr.expr.type === 'Local')
        && ctx.isDetectedClassMethod(
            (expr.expr as { name: string }).name,
            expr.index,
          )
      ) {
        return factory.createPropertyAccessExpression(
          factory.createPropertyAccessExpression(
            compileExpr(expr.expr, ctx),
            factory.createIdentifier('prototype'),
          ),
          factory.createIdentifier(propertyName(expr.index)),
        );
      }
      const access = factory.createPropertyAccessExpression(
        compileExpr(expr.expr, ctx),
        factory.createIdentifier(propertyName(expr.index)),
      );
      // rbxts mode: `.Parent` access on Instance returns `Instance |
      // undefined` per @rbxts/types. Real Roblox scripts treat parent
      // chains as non-null (runtime errors if a chain link is missing)
      // AND access children whose specific types aren't statically
      // known. Cast to `any` so the result absorbs both — non-null
      // AND wide enough that subsequent property access type-checks.
      if (ctx.compatMode === 'rbxts' && expr.index === 'Parent') {
        return factory.createAsExpression(
          access,
          factory.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword),
        );
      }
      return access;
    }
    case 'IndexExpr': {
      // Lua tables are 1-indexed; JS arrays are 0-indexed. For numeric
      // literals we statically translate (`arr[1]` → `arr[0]`). For runtime
      // values we used to emit an inline `typeof i === 'number' ? i-1 : i`
      // conditional, but that silently broke dictionary lookups keyed by
      // large numeric values (Roblox developer-product/asset IDs etc.):
      // `productCash[3582943767]` would compile to a lookup of `3582943766`
      // and return undefined.
      //
      // We now emit a call to `luaIndex(t, k)`, which checks
      // `Array.isArray(t)` at runtime and only subtracts 1 when t is an
      // actual JS array. Sequence tables still index correctly; dictionary
      // tables pass through unchanged.
      let target = compileExpr(expr.expr, ctx);
      const indexExpr = expr.index;
      const index = compileExpr(indexExpr, ctx);
      // rbxts mode: `_G` is declared in @rbxts/types as `interface _G {}`
      // (empty), so `_G["deb"]` fires TS7053. Cast to `any` so dynamic
      // access through the shared global table type-checks.
      if (
        ctx.compatMode === 'rbxts'
        && expr.expr.type === 'Global'
        && (expr.expr as { name: string }).name === '_G'
      ) {
        target = factory.createParenthesizedExpression(
          factory.createAsExpression(
            target,
            factory.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword),
          ),
        );
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
        // rbxts mode: when the parent expression is a chained
        // IndexExpr / IndexName (the receiver here was something
        // like `obj[runtimeKey]` returning `unknown`), wrap the
        // receiver through `as unknown as Record<string | number,
        // unknown>` so the literal-numeric access doesn't fire
        // TS2571 ("Object is of type 'unknown'").
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
      // Runtime key: native bracket access in rbxts mode (roblox-ts preserves
      // variable indices), helper in native mode (handles 1-based at runtime).
      if (ctx.compatMode === 'rbxts') {
        // The index is a runtime variable (not a literal). Cast the
        // receiver to `Record<string, unknown>` (not `any` — that
        // would trip roblox-ts's no-any rule) so arbitrary string-
        // keyed access yields `unknown`. Cast the index through
        // `unknown as string` so Player/Instance-typed keys (common
        // in Roblox dict lookups by player) coerce to a string slot
        // without TS2538.
        const dynamicTarget = factory.createParenthesizedExpression(
          factory.createAsExpression(
            target,
            factory.createTypeReferenceNode('Record', [
              factory.createKeywordTypeNode(ts.SyntaxKind.StringKeyword),
              factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
            ]),
          ),
        );
        const coercedIndex = factory.createAsExpression(
          factory.createAsExpression(
            index,
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
      // `{} :: SomeImpl` — the empty Luau table compiles to `[]` (the
      // array literal default), and `[] as SomeImpl` is rejected by tsc
      // unless SomeImpl is itself an array type. Switch to `{}` for
      // non-array targets so the assertion lands. The inner Table check
      // is intentionally narrow: only empty tables get this swap; populated
      // tables already commit to array-vs-object via compileTableExpr.
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
      return factory.createAsExpression(compileExpr(expr.expr, ctx), targetTy);
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
      // Type-narrowed length: strings have a native .length property
      // with byte-equivalent semantics under our parser's UTF-8 strings.
      if (innerType === 'string') {
        return factory.createPropertyAccessExpression(inner, 'length');
      }
      // rbxts mode: emit `#expr` as a real Lua `#` via roblox-ts. The
      // closest TS idiom is `(expr as any).size()` for arrays (roblox-ts
      // Array.size() compiles to `#expr`), but unknown-shape values
      // need the source's intent preserved. Cast to any and call size().
      if (ctx.compatMode === 'rbxts') {
        return factory.createCallExpression(
          factory.createPropertyAccessExpression(
            factory.createParenthesizedExpression(
              factory.createAsExpression(
                inner,
                factory.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword),
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
      // `not <expr>` where the operand is statically boolean → just `!expr`.
      // For other repeatable operands, fall back to the inline truthiness
      // check (same shape as `if (truthy(x))` but negated).
      if (innerType === 'boolean') {
        return factory.createPrefixUnaryExpression(ts.SyntaxKind.ExclamationToken, inner);
      }
      if (isRepeatableExpression(inner)) {
        return factory.createPrefixUnaryExpression(
          ts.SyntaxKind.ExclamationToken,
          factory.createParenthesizedExpression(truthify(inner, ctx, innerType)),
        );
      }
      // rbxts mode: emit `!inner` directly. roblox-ts will lower TS `!` to
      // Lua `not`, which preserves the Lua-truthy semantics our luaNot
      // helper was simulating. The intermediate TS won't be JS-truthy
      // accurate (0 and "" differ), but the target is round-trip Lua.
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
  // Luau idiom: `cond and value or fallback`. After our `and` lowering
  // the LHS becomes `cond && value` whose result may be literal `false`
  // (from the false-y short-circuit). The outer `or` must fall through
  // false → fallback, but `??` only catches null/undefined. Force the
  // boolean static type so compileLogicalBinary picks `||` (which
  // catches false too) for this LHS.
  if (
    expr.op === 'or'
    && expr.left.type === 'Binary'
    && (expr.left as { op?: string }).op === 'and'
  ) {
    leftType = 'boolean';
  }
  // `or { }` fallback: `config = config or {}` overwhelmingly means
  // "default to empty object," not "default to empty array." compileTable
  // returns `[]` for `{}` by default (array literal). When the empty
  // table sits on the RHS of `or`, override to an empty-object literal
  // with a cast so it lands in any context (typed function-param
  // fallbacks, dict accumulators, array seeds) without tripping a
  // slot-type mismatch.
  //
  // For the common shape `x = x or {}` where the LHS is a plain identifier,
  // cast to `NonNullable<typeof x>` so the ternary's overall type collapses
  // to the truthy form of `x`, and the surrounding assignment can narrow
  // `x` out of `T | null | undefined`. Without this, `{} as any` poisoned
  // the false branch with `any`, which TS treats as no narrowing — every
  // subsequent `x.field` access then fired TS18049.
  //
  // For complex LHS shapes (property accesses, calls, computed indexes)
  // fall back to `as any` — `typeof` over those forms is either invalid
  // or fragile, and the surrounding assignment usually isn't `x = x or {}`
  // anyway.
  let right: ts.Expression;
  if (
    expr.op === 'or'
    && expr.right.type === 'Table'
    && expr.right.items.length === 0
  ) {
    const castType = ts.isIdentifier(left)
      ? factory.createTypeReferenceNode('NonNullable', [
          factory.createTypeQueryNode(factory.createIdentifier(left.text)),
        ])
      : factory.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword);
    right = factory.createAsExpression(
      factory.createObjectLiteralExpression([], false),
      castType,
    );
  } else {
    right = compileExpr(expr.right, ctx);
  }

  if (expr.op === 'and' || expr.op === 'or') {
    return compileLogicalBinary(expr.op, left, right, ctx, leftType);
  }

  if (leftType === 'number' && rightType === 'number') {
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

  // Datatype-arithmetic fast path. When the LEFT operand is statically a
  // Roblox datatype (Vector3, CFrame, etc.), emit a direct method call
  // instead of routing through `luaAdd`/`luaSub`/etc. The instance method
  // handles the typed overload internally (Vector3.mul accepts both
  // Vector3 and number, etc.), so this is safe for both same-datatype
  // arithmetic (`v1 + v2`) and scaling by scalar (`v1 * 2`).
  //
  // We only fast-path when the LEFT side is the datatype, not the right —
  // `2 * v1` keeps the helper since you can't call `.mul()` on a JS number.
  // The helper dispatches to the right operand's __mul anyway.
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

  // Beautify `..` concat — Lua's string-concat operator. When at least
  // one side is statically string, JS template literals capture the
  // semantics directly: nested `${expr}` interpolations call `.toString()`
  // on non-string operands, matching Lua's `..` behavior.
  if (expr.op === '..' && (leftType === 'string' || rightType === 'string')) {
    return buildTemplateLiteral([
      { value: left, type: leftType },
      { value: right, type: rightType },
    ]);
  }

  return compileBinary(expr.op, left, right, ctx);
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
      // Datatype-arithmetic fall-through: when the operands aren't
      // statically known to be `number` (the both-number fast path is
      // handled earlier in compileBinaryExpr), the result could be
      // `Vector3 - Vector3` / `CFrame * CFrame` etc.  Plain native
      // emit `left - right` fires TS2363 (RHS must be number) when
      // either side is non-number, and even `(left as any) - (right
      // as any)` types the result as `number` (any-arithmetic stays
      // numeric in TS), so a `pos = a - b` slot of `Vector3` rejects
      // with TS2322.
      //
      // Wrap both operands in `as any` for the arithmetic to typecheck
      // AND wrap the whole expression in `as any` to widen the result
      // so it's assignable to any datatype slot. roblox-ts compiles
      // `(a as any) - (b as any)` back to Lua `a - b`, and Roblox's VM
      // dispatches on __sub the same way — the roundtrip stays
      // observably identical. (Trade-off: roblox-ts's strict no-any
      // rule fires a diagnostic on every cast. Removing those without
      // dropping the cast requires per-call type inference we don't
      // have today — left for a future pass.)
      const arithmeticOps = new Set(['+', '-', '*', '/', '%', '^']);
      if (arithmeticOps.has(op)) {
        const wrap = (e: ts.Expression) =>
          factory.createParenthesizedExpression(
            factory.createAsExpression(e, factory.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword)),
          );
        return factory.createAsExpression(
          factory.createBinaryExpression(wrap(left), direct, wrap(right)),
          factory.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword),
        );
      }
      // Equality (`===` / `!==`): widen operands `as unknown` so
      // TS doesn't fire TS2367 ("comparison appears unintentional
      // because the types have no overlap") when our shape
      // inference narrowed one side to a specific function/object
      // type but the user's code compares against a primitive
      // literal. The runtime semantics are unaffected — `===` /
      // `!==` work on any pair of values.
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
      // Integer division: `Math.floor(a / b)`. roblox-ts lowers Math.floor
      // to math.floor and the slash stays as Lua `/`. Same observable
      // result as Luau's `//`.
      return factory.createCallExpression(
        factory.createPropertyAccessExpression(factory.createIdentifier('Math'), 'floor'),
        undefined,
        [factory.createBinaryExpression(left, ts.SyntaxKind.SlashToken, right)],
      );
    }
    if (op === '..') {
      // String concatenation: template literal `${left}${right}`. roblox-ts
      // emits Lua `..` for template literals, and template-string coercion
      // (calling .toString()/tostring on each interpolant) matches Lua's
      // implicit tostring conversion in `..`.
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
    // rbxts mode: comparison operands may be `unknown` (from
    // structural-shape leaves), and `<` / `<=` / etc. on unknown
    // fires TS2571. Cast both operands through `as any` so the
    // comparison goes through. roblox-ts will emit `a < b` in Lua
    // either way; the runtime dispatch uses __lt or numeric
    // comparison based on actual types.
    if (ctx.compatMode === 'rbxts') {
      const wrap = (e: ts.Expression) =>
        factory.createParenthesizedExpression(
          factory.createAsExpression(e, factory.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword)),
        );
      return factory.createBinaryExpression(wrap(left), directOp, wrap(right));
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
  // Lua-faithful `a and b` / `a or b` semantics — these aren't pure
  // boolean operators; they short-circuit and return the chosen operand
  // (potentially non-boolean). When left is statically boolean and side-
  // effect-free, JS's `&&` / `||` already match the semantics exactly,
  // so we can emit the native operator without the truthify dance.
  if (leftType === 'boolean' && isRepeatableExpression(left)) {
    return factory.createBinaryExpression(
      left,
      op === 'and' ? ts.SyntaxKind.AmpersandAmpersandToken : ts.SyntaxKind.BarBarToken,
      right,
    );
  }
  // rbxts mode: collapse `a or b` / `a and b` to native TS operators.
  // `??` and `&&` / `||` already short-circuit, so we don't need the
  // capture-LHS-once IIFE that native mode uses. The choice between `||`
  // and `??` for `or` follows the LHS's static type: a boolean LHS
  // really might be `false`, so `||` is the closer Luau match; for
  // anything else `??` reads as the typical "default when nil" intent
  // the source author meant. Lossy on edge cases (a number-typed LHS
  // that's 0 still falls through `||` in JS but is truthy in Luau), but
  // matches what roblox-ts users write by hand.
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

// Roblox functions that yield the calling thread until they complete —
// the compiled equivalent has to be awaited or the place enters tight
// busy loops on `while wait(1) do …`. Known by name so we can wrap the
// resulting CallExpression in `await`.
// pcall / xpcall might forward through to a yielding function, so
// always await — we don't know statically whether the wrapped fn yields.
// require() now returns a Promise<export> because all ModuleScript factories
// are async; callers must await it to get the resolved module value.
// `delay` and `task.delay` / `task.spawn` are fire-and-forget in Lua: they
// schedule a function and return immediately. Treating them as yielding made
// the caller async, which transitively forced every call site to be awaited
// — which then broke async-function-returns-Promise issues (e.g. ProfileService
// .GetProfileStore returned `Promise<profile_store>` instead of profile_store
// because its body had `await task.spawn(...)` and the call sites weren't
// awaited).
const YIELDING_FREE_FUNCS = new Set(['wait', 'pcall', 'xpcall', 'require']);
const YIELDING_TASK_FUNCS = new Set(['wait']);
// WaitForChild is intentionally NOT here — our runtime makes it synchronous
// (returns NullProxy on miss) so the compiler emits a plain call. Awaiting it
// would force every caller to be async, which transitively poisons Lua-style
// "synchronous-looking" call sites that the script doesn't await.
// Legacy lowercase aliases (`event:wait()`, `:invokeServer()`) appear in old
// Roblox places; treat them as yielding too. The runtime exposes both casings.
// LoadAsset / LoadAssetVersion / LoadAssetWithFormat are documented as
// yielding even without an `*Async` suffix; same for the legacy lowercase.
const YIELDING_METHODS = new Set([
  'Wait', 'wait',
  'InvokeServer', 'invokeServer', 'InvokeClient', 'invokeClient',
  'LoadAsset', 'loadAsset',
  'LoadAssetVersion', 'LoadAssetWithFormat',
]);

function isYieldingCall(expr: Extract<Expr, { type: 'Call' }>, ctx?: CompileContext): boolean {
  // rbxts mode targets Lua (via roblox-ts), where yields are implicit —
  // `wait()` / `task.wait()` / `pcall()` block naturally without needing
  // an async/await dance. Skip the JS-async wrapping entirely so the
  // emit reads as straightforward calls and roblox-ts compiles them to
  // Lua identity-transform. Top-level await in particular trips TS1378
  // since roblox-ts's tsconfig doesn't enable es2022 module support.
  if (ctx?.compatMode === 'rbxts') return false;
  // Old admin scripts snapshot Lua globals into locals at startup
  // (`local wait,pcall,...=wait,pcall,...`). The reference type flips
  // from Global to Local but the binding still points at the yielding
  // implementation, so the await wrap must still fire.
  if ((expr.func.type === 'Global' || expr.func.type === 'Local') && YIELDING_FREE_FUNCS.has(expr.func.name)) {
    return true;
  }
  if (expr.func.type === 'IndexName' && expr.func.expr.type === 'Global') {
    if (expr.func.expr.name === 'task' && YIELDING_TASK_FUNCS.has(expr.func.index)) return true;
  }
  // Match both colon-call (`event:wait()`) and dot-call (`event.wait()`) —
  // the dot form shows up in scripts that already adapted to JS-style.
  if (expr.func.type === 'IndexName' && YIELDING_METHODS.has(expr.func.index)) {
    return true;
  }
  // User-defined yielding functions discovered by the pre-pass scanner.
  // Direct calls match Local/Global names; member calls (Server.Init())
  // match the trailing index name — the scanner catalogs both forms.
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
      // FunctionStat and FunctionExpr share `type: 'Function'`. Only the
      // statement form has `func` and `name` — distinguish by structural shape.
      const s = n as unknown as { name: Expr; func: { body: BlockStat } };
      if (s.name && (s.name.type === 'Global' || s.name.type === 'Local')) {
        funcBodies.set((s.name as { name: string }).name, s.func.body);
      } else if (s.name && s.name.type === 'IndexName' && 'index' in s.name) {
        // `function Obj.Method() … end` — catalog by the trailing member
        // name. Callers like `Server.InitializeFishingZones()` resolve
        // through this when the call's IndexName-tail matches.
        funcBodies.set((s.name as { index: string }).index, s.func.body);
      }
    } else if (n.type === 'Local' && 'vars' in n && 'values' in n) {
      // `local foo = function() ... end` — function-valued local declarations.
      // Distinguish LocalStat (has `vars`/`values`) from the bare `Local`
      // variable-name node (used inside LocalStat.vars and function args).
      const s = n as unknown as LocalStat;
      for (let i = 0; i < s.vars.length; i += 1) {
        const init = s.values[i];
        if (init && init.type === 'Function' && 'body' in init) {
          funcBodies.set(s.vars[i]!.name, (init as { body: BlockStat }).body);
        }
      }
    } else if (n.type === 'Assign' && 'vars' in n && 'values' in n) {
      // `foo = function() ... end` — assignment with function rhs. Catches
      // old Roblox Animate scripts that declare yielding helpers as plain
      // global assignments instead of `function foo` or `local function foo`.
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
          // `Server.Init = async function() … end` — catalog by trailing
          // member name so call sites like `Server.Init()` get awaited.
          funcBodies.set((target as { index: string }).index, body);
        }
      }
    }
  });

  // 2. Iterate to fixed point: a function yields if its body contains any
  // call already classified as yielding (built-in or previously-marked user
  // function). Each round may newly mark a function whose callee just got
  // marked, so keep going until nothing changes.
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

/** rbxts mode: cast each call arg through `Parameters<typeof
 *  callee>[i]` so unknown-typed values flow into the callee's
 *  declared param types (Players.GetPlayerByUserId expects number,
 *  TweenService.Create expects Instance, etc.).
 *
 *  Only fires when `callee` is a "simple" reference TS can take
 *  `typeof` of — Identifier or PropertyAccessExpression chains. For
 *  complex callees (function-typed expressions, IIFEs, etc.) the
 *  args go through uncasted; the existing structural-shape work
 *  covers those.
 *
 *  Skips args that are already cast (already have a TypeAssertion
 *  ancestor) to avoid `(x as A) as Parameters<typeof f>[0]` noise.
 */
function castArgsForCall(
  callee: ts.Expression,
  args: readonly ts.Expression[],
  ctx: CompileContext,
): readonly ts.Expression[] {
  if (ctx.compatMode !== 'rbxts') return args;
  if (!isSimpleCalleeRef(callee)) return args;
  return args.map((arg, i) => {
    // Spread elements (`...args`) need an iterable, not a single
    // type. Casting `[..__varargs as Parameters<T>[i]]` would
    // require __varargs to be iterable as Parameters[i] — usually
    // false. Leave spread args alone.
    if (ts.isSpreadElement(arg)) return arg;
    // Skip parenthesised-AsExpression — already cast.
    if (ts.isParenthesizedExpression(arg) && ts.isAsExpression(arg.expression)) {
      return arg;
    }
    if (ts.isAsExpression(arg)) return arg;
    // Wrap arrow/function/binary/conditional args in parens before
    // casting — `as` binds tighter than `??`/`&&`/`||`, so a bare
    // `x ?? y as T` would parse as `x ?? (y as T)` and miss the x
    // branch. Arrow `() => { … } as T` would parse as arrow
    // returning T. Parenthesising fixes both.
    const inner = (
      ts.isArrowFunction(arg)
      || ts.isFunctionExpression(arg)
      || ts.isBinaryExpression(arg)
      || ts.isConditionalExpression(arg)
    )
      ? factory.createParenthesizedExpression(arg)
      : arg;
    return factory.createAsExpression(
      // Route through `unknown` first so TS2352 ("conversion may be
      // a mistake because neither type sufficiently overlaps") stays
      // off — the user's value might be `(...) => void` cast to
      // `thread`, etc., and TS rejects the direct cast unless we
      // explicitly widen first.
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

/** True when `expr` is a simple reference (`Identifier` or a short
 *  chain of property accesses anchored in an Identifier). `typeof
 *  expr` is valid in TS type position for these forms.
 *
 *  We cap the depth at 2 (`obj.method` is fine, `obj.field.method`
 *  is not) because deeper chains often pass through a structurally-
 *  typed `unknown` field — e.g. `ProfileService.IssueSignal.Fire`
 *  where IssueSignal is typed `unknown` from class-field inference.
 *  `typeof unknown.Fire` is invalid and fires TS2571. */
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

  // rbxts mode: `setmetatable(obj, ClassName)` is leftover plumbing
  // once we've raised the metatable pattern into a real TS class.
  // setmetatable returns its first arg, so:
  //   • If the second arg is a detected class, drop the call entirely
  //     and just yield the first arg — the class structure is already
  //     in the TS class declaration, and re-binding the metatable at
  //     runtime is observably a no-op.
  //   • Otherwise, the second arg is genuine metatable plumbing
  //     (mixins, weak refs, etc.). Cast it to `LuaMetatable<object>`
  //     so the call type-checks under @rbxts/types' setmetatable
  //     signature without resorting to `any`.
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
    if (secondIsDetectedClass) {
      // The first arg is what setmetatable returns; pass it through.
      // In expression-statement position the value is discarded; in
      // value position (e.g. `let x = setmetatable(t, C)`) the
      // binding still gets `t`, matching Luau semantics.
      return args[0]!;
    }
    ctx.useAmbient('setmetatable');
    ctx.useImport('@rbxts/types', 'LuaMetatable');
    const newArgs = [
      args[0]!,
      factory.createAsExpression(
        args[1]!,
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

  // Lua string method calls: `s:format(...)`, `"...":gsub(...)`, etc. JS
  // strings don't have `.format`/`.gsub`/`.reverse`/etc., so a literal
  // colon-method-on-string emits `"x".format(...)` which tsc rejects.
  // In native mode route to the runtime helper unconditionally — Roblox
  // classes don't define `gsub`/`format`/`match` on any datatype, so the
  // false-positive risk is negligible. In rbxts mode rewrite to the
  // namespace form `string.X(s, ...)` instead: @rbxts/types declares
  // `string` as a Lua-global with these methods, so the call stays
  // valid and round-trips back to Lua identity.
  if (
    expr.self
    && expr.func.type === 'IndexName'
    && STRING_LIB_METHODS.has(expr.func.index)
  ) {
    const methodName = expr.func.index;
    const meta = STRING_LIB_METHODS.get(methodName)!;
    if (ctx.compatMode === 'rbxts') {
      ctx.useAmbient('string');
      // For `s:format(...)` (colon form) → `string.format(s, ...)`,
      // cast each rest arg `as unknown as string | number` so
      // unknown-typed leaves satisfy format's variadic slot.
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
      const namespaceCall = factory.createCallExpression(
        factory.createPropertyAccessExpression(
          factory.createIdentifier('string'),
          factory.createIdentifier(methodName),
        ),
        undefined,
        [compileExpr(expr.func.expr, ctx), ...formattedArgs],
      );
      // gsub/find/byte return `LuaTuple<[…]>` in @rbxts/types. Extract
      // the first value in single-value Luau positions (the default —
      // destructure / multi-return contexts set preferMultiReturn=true).
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
    // gsub/find/byte return `[main, ...extras]`. Lua single-value
    // assignment takes just the main, so extract [0] for the
    // colon-call form.
    return meta.tupleFirst
      ? factory.createElementAccessExpression(helperCall, 0)
      : helperCall;
  }

  let call: ts.Expression;
  if (expr.self && expr.func.type === 'IndexName') {
    const calleeAccess = factory.createPropertyAccessExpression(
      compileExpr(expr.func.expr, ctx),
      factory.createIdentifier(propertyName(expr.func.index)),
    );
    call = factory.createCallExpression(calleeAccess, undefined, castArgsForCall(calleeAccess, args, ctx));
  } else {
    const calleeExpr = compileExpr(expr.func, ctx);
    call = factory.createCallExpression(calleeExpr, undefined, castArgsForCall(calleeExpr, args, ctx));
  }
  // rbxts mode: methods that return `Instance | undefined` in @rbxts/types
  // (FindFirstChild family, FindFirstAncestor family) plus methods that
  // return base `Instance` (`WaitForChild` — the returned child is a
  // specific subclass at runtime but typed as plain Instance) get cast
  // to `any`. Absorbs both nullability AND the loose-Instance typing
  // that triggers TS2339 "Property X does not exist on Instance" at
  // every subsequent property access. Real Roblox code knows the
  // child's actual type at the call site and proceeds without checks.
  if (
    ctx.compatMode === 'rbxts'
    && expr.self
    && expr.func.type === 'IndexName'
    && INSTANCE_LOOSE_METHODS.has(expr.func.index)
  ) {
    call = factory.createAsExpression(
      call,
      factory.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword),
    );
  }
  // rbxts mode: `require(ModuleScript)` returns `unknown` per @rbxts/types
  // because the loaded module's exports type isn't known statically.
  // Cast to `any` so `let Module = require(...); Module.Foo()` works —
  // real Roblox scripts never check the require result's shape; they
  // know which module they're loading.
  if (
    ctx.compatMode === 'rbxts'
    && expr.func.type === 'Global'
    && expr.func.name === 'require'
  ) {
    call = factory.createAsExpression(
      call,
      factory.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword),
    );
  }
  // rbxts mode: namespace-form calls into `string.X(s, ...)` for the
  // tuple-returning methods (gsub, find, match, byte) need a single-
  // value extraction `[0]` unless the caller is genuinely consuming the
  // tuple via destructure / multi-return. @rbxts/types declares these
  // as `LuaTuple<[T, ...]>`; without extraction TS rejects passing the
  // result to a `string`-typed parameter.
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
  // rbxts mode: bare `pcall(...)`, `xpcall(...)`, and `coroutine.resume`
  // return `LuaTuple<[boolean, ...rest]>` in @rbxts/types. Single-value
  // Luau positions (`local ok = pcall(f)`, `if pcall(f) == false`) take
  // only the success flag — extract `[0]` so the surrounding context
  // sees a `boolean` instead of the whole tuple.
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
  // rbxts mode: calls to file-local functions whose return is annotated
  // as `LuaTuple<[…]>` need a `[0]` extract in single-value positions.
  // Without it the LHS picks up the whole tuple as its static type
  // (LuaTuple<[any, any]>) and subsequent property access on the
  // captured first-value fails TS2339. Use a non-null assertion
  // (`call![0]`) instead of `as any` so mixed-return functions
  // (which return `LuaTuple<…> | undefined`) get the right narrowing
  // without tripping roblox-ts's no-any rule.
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

/** Instance methods whose @rbxts/types return type is too narrow for how
 *  real Roblox scripts use them — either nilable (`Instance | undefined`)
 *  for FindFirst*, or base-`Instance` for WaitForChild where the actual
 *  child is a specific subclass. The rbxts-mode emit wraps each result
 *  in `as any` so subsequent property access type-checks. */
/** Roblox-side Lua globals whose typed shape (per @rbxts/types) misses
 *  the user-folder children real scripts access. Cast the root to `any`
 *  before any property access so `game.MyFolder`, `workspace.Tycoons`,
 *  `script.Helpers`, etc. type-check. Subsequent `.Parent` and
 *  FindFirstChild casts compose. */
const RBX_DYNAMIC_ROOTS = new Set(['game', 'workspace', 'script', 'plugin']);

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
]);

function compileTableExpr(
  expr: Extract<Expr, { type: 'Table' }>,
  ctx: CompileContext,
): ts.Expression {
  const allList = expr.items.every((i) => i.kind === 'List');
  const allRecord = expr.items.every((i) => i.kind === 'Record');

  // Empty Luau `{}` is ambiguous — it could be an array seed (`{}` then
  // `table.insert(t, v)`) or an object seed (`{}` then `t.field = v`).
  // We emit `{} as any` so subsequent property access AND numeric-index
  // assignment both compile under tsc — the empty literal alone is the
  // `{}` type (no excess properties), which rejects `obj.Sync = X` even
  // though Luau tables freely grow. The `as any` matches Luau's
  // dynamic-table semantics. Annotated locals + type assertions still get
  // their typed shapes via compileLocal / TypeAssertion overrides.
  if (expr.items.length === 0) {
    return factory.createAsExpression(
      factory.createObjectLiteralExpression([], false),
      factory.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword),
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
  return factory.createPropertyAssignment(
    factory.createComputedPropertyName(compileExpr(item.key, ctx)),
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
  // Luau ModuleScripts end with `return <export-value>` — the value is
  // what `require(script)` returns. TS has no top-level `return`; rewrite
  // the trailing return as `export default <value>`. Conservative scope:
  // only when the trailing statement IS a return AND it carries a value
  // AND the file has at least one other statement (skips bare-`return X`
  // test snippets / single-line scripts where the user wants the literal
  // return form).
  if (stmts.length > 1) {
    const last = stmts[stmts.length - 1]!;
    if (ts.isReturnStatement(last) && last.expression) {
      stmts[stmts.length - 1] = factory.createExportAssignment(
        undefined,
        false,
        last.expression,
      );
      // roblox-ts rejects `export = <variable>` when the variable is
      // `let`. The Luau idiom `local M = {}; M.x = …; return M`
      // surfaces as `let M; M.x = …; export default M;` — even
      // though our metatable rewrite means M is observably const-
      // shape-wise (property mutation, not re-binding). Find the
      // matching declaration and flip its kind to `const` when the
      // exported name resolves to a top-level let. (Property-write
      // assignments don't disqualify; only `M = …` re-bindings
      // would, and those couldn't compile to a Luau-style export
      // anyway.)
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
  if (implicitGlobals.size > 0) ctx.useAmbient('_G');
  for (const name of implicitGlobals) {
    // Initialize the predecl from `_G[name]` so cross-script globals set
    // earlier in the place's startup are visible at this script's start.
    // (Best-effort: still doesn't see later updates from other scripts —
    // matching Lua semantics would need every read to consult _G, which is
    // a deeper refactor.)
    // Cast `_G` to `any` so the access type-checks under rbxts/strict
    // mode (in @rbxts/types `_G` is declared as an empty interface, so
    // bracket access fires TS7053). Native mode doesn't care, but the
    // wrap is harmless there.
    const gRead: ts.Expression = ctx.compatMode === 'rbxts'
      ? factory.createElementAccessExpression(
          factory.createParenthesizedExpression(
            factory.createAsExpression(
              factory.createIdentifier('_G'),
              factory.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword),
            ),
          ),
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
            // rbxts/strict requires an annotation here because the init
            // is `any` and the variable will later get re-assigned to
            // arbitrary values without losing its open shape.
            ctx.compatMode === 'rbxts'
              ? factory.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword)
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
    // Skip `@rbxts/types` in rbxts mode — the package declares every
    // Roblox class as a TS-level global, not as named exports. Importing
    // them surfaces TS2306 "File '...roblox.d.ts' is not a module".
    // Macros still register `useImport('@rbxts/types', X)` for the
    // intent-tracking value (telling us the script depends on X); we
    // just don't emit the import line.
    if (ctx.compatMode === 'rbxts' && module === '@rbxts/types') continue;
    allStatements.push(buildNamedImport(module, names));
  }
  // `declare const X: any;` for every Roblox / host-environment global the
  // script referenced. Pure type-only; emits nothing at runtime, but lets
  // tsc resolve the names without surfacing "Cannot find name" cascades.
  //
  // Skip entirely in rbxts mode — `pairs`, `error`, `task`, `os`, `table`,
  // `game`, `workspace`, etc. are declared by @rbxts/types as typed globals
  // there, and an `: any` declaration here would shadow those with `any`,
  // which then breaks roblox-ts's for-of iteration analysis (it relies on
  // pairs() / ipairs() having their real typed return shape). Our internal
  // --check-ts won't resolve these names anymore, but rbxts users invoke
  // roblox-ts on the output; that pipeline has the right types via
  // typeRoots: ["node_modules/@rbxts"].
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
  // rbxts mode: when any property access has used the `_LuauChild`
  // cast (service.X dynamic-child accesses), inject the interface
  // declaration. `_LuauChild` is a recursive structural type that
  // models "anything Luau lets you index into, treat as a function,
  // or chain further property access on" — every property returns
  // _LuauChild, the type itself is callable (with any args, any
  // return), so `service.Foo.Bar.FireServer(x, y)` chains work
  // without TS2339.
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

  // Force the output to be treated as a module. Without an import or export,
  // tsc treats top-level `await` as illegal ("'await' expressions are only
  // allowed at the top level of a file when that file is a module"). Even
  // a `declare const X: any;` doesn't qualify. Append `export {};` so the
  // file is unambiguously a module, but skip it when an import/export
  // already exists to keep the output clean.
  const alreadyModule = allStatements.some((s) =>
    ts.isImportDeclaration(s)
    || ts.isExportAssignment(s)
    || ts.isExportDeclaration(s)
    || ((ts.canHaveModifiers(s) ? ts.getModifiers(s) : undefined) ?? [])
      .some((m) => m.kind === ts.SyntaxKind.ExportKeyword),
  );
  if (!alreadyModule) {
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

  // Comment preservation: prepend the source's leading comment block
  // (file header). Inline comments live in the WASM CST data we don't
  // currently surface, so we keep the most-useful slice — the file
  // header — by extracting any `--` / `--[[ ]]` comments that appear
  // before the first non-comment, non-whitespace token in the source.
  if (options.preserveComments) {
    const header = extractFileHeaderComments(source);
    if (header) printed = `${header}\n${printed}`;
  }

  // Always prepend a "compiled by" header so users know the file is
  // generated and from which version of the compiler. Goes first so it's
  // visible above whatever the source author wrote.
  printed = `${COMPILER_HEADER}\n${printed}`;

  // Pretty-print the final output via Prettier. The TS factory printer
  // produces correct but ugly TypeScript: 4-space indents, no blank lines
  // between top-level blocks, no consistent quoting. Prettier with the
  // baked-in rules brings it in line with how humans write TS. Source-map
  // building runs AFTER this step so generated-line numbers match the
  // final output the user sees.
  if (options.pretty !== false) {
    try {
      printed = await prettierFormat(printed, {
        parser: 'typescript',
        semi: true,
        singleQuote: true,
        trailingComma: 'all',
        printWidth: 100,
        arrowParens: 'always',
        endOfLine: 'lf',
      });
    } catch {
      // If Prettier can't parse the output (parser bug, unusual syntax),
      // fall back to the printer's raw output rather than failing the
      // whole compile. Users can see exactly what we emitted.
    }
  }

  // Layer A: post-emit TypeScript type check. Defaults to on; set
  // postEmitCheck: false (or --no-check-ts at the CLI) to skip. Runs
  // the bundled tsc over the emitted .ts source via an in-memory
  // CompilerHost so we don't touch the filesystem or pull in external
  // @types. strict:false so any-laden translations of untyped Luau
  // don't drown the user in noise; users who want strict can run
  // tsc --strict on the output.
  // Layer A defaults: on for native mode, off for rbxts mode. In rbxts
  // mode we drop the ambient `declare const X: any;` preamble so the
  // emitted file relies on @rbxts/types' typed globals at the roblox-ts
  // step — but our internal tsc check doesn't know about @rbxts/types,
  // so the same names (pairs, error, task, os, ...) would all fail with
  // "Cannot find name." Skip the check by default; users can opt back
  // in via `--check-ts` / `typeCheck: true` if their toolchain wires
  // @rbxts/types into the tsc resolution.
  const layerADefault = ctx.compatMode === 'rbxts' ? false : true;
  const runLayerA = options.typeCheck === true
    || (options.postEmitCheck !== false && options.postEmitCheck !== undefined)
    || (options.postEmitCheck === undefined && layerADefault);
  if (runLayerA) {
    const postEmitDiags = runPostEmitCheck(printed, sourceFileName);
    for (const d of postEmitDiags) parsed.errors.push(d);
  }

  // Layer B: pre-emit Luau check via @luau2ts/analyzer. Defaults to on
  // when the package is installed; soft-fails silently otherwise (no
  // soft warning, since "default-on" means we run when we can and
  // skip when we can't, similar to Prettier formatting). Users can
  // force-enable with typeCheck:true to get the soft warning when
  // they're expecting the analyzer to be there.
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
      // Resolve the package name through an indirected variable so the
      // TypeScript checker doesn't try to resolve it at compile time.
      // The analyzer is an OPTIONAL peer; if it isn't installed we
      // soft-fail below.
      const analyzerPath = '@luau2ts' + '/analyzer';
      analyzerMod = (await import(/* @vite-ignore */ analyzerPath)) as AnalyzerMod;
    } catch {
      // Analyzer not installed. If the user explicitly asked for the
      // check (typeCheck:true or preEmitCheck:true), surface a single
      // soft warning so they know it's silently skipped. Otherwise
      // stay quiet because preEmitCheck defaults to "run if available".
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
        // Normalize the analyzer's flat {line, col} into the parser's
        // nested loc shape. Route by severity — errors join the main
        // errors list; lint-style warnings (LocalUnused, LocalShadow,
        // SameLineStatement, ImportUnused, etc.) go to `warnings` so
        // callers gating on `errors.length === 0` don't pick them up.
        //
        // ALSO route `UnknownProperty` errors of the
        // "Key 'X' not found in external type '<RobloxClass>'" shape to
        // `warnings`. Luau's `declare class` doesn't support string
        // indexers, so we can't express "any property access on
        // Instance is allowed" via the type. Real Roblox scripts
        // access children dynamically — `script.Parent.Drop`,
        // `ServerScriptService.PlayerData`, `model.PartName`, etc. —
        // and the analyzer correctly notes it doesn't statically know
        // those exist. Surfacing each as an error drowns out genuine
        // type errors; demote to warning.
        //
        // The regex matches any "external type 'Word'" target — all
        // Roblox classes in our generated definitions live in the
        // external-type space, so this covers Instance + every
        // subclass + every Service uniformly.
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
    // Walk each line of the printed output. The compiler header (and
    // optional source comment header) we prepended produce lines that
    // don't correspond to any input statement, so skip past them first.
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

  // Walk every node looking for any Global reference — read or written.
  // Luau treats an undeclared global read as `nil`; JS strict mode throws
  // ReferenceError, so we predeclare every name the script touches so reads
  // see `undefined` (≈ nil) and writes work. CompoundAssign covers `x += 1`
  // shapes; the general Global walk catches everything else (table values,
  // function args, condition expressions, …).
  //
  // Don't predeclare names that already get their own JS binding from the
  // compile output: top-level `function foo()` emits a `function` decl,
  // top-level `local foo` emits a `let foo`. A duplicate `let foo` would
  // collide with both.
  // Track function nesting: Local/LocalFunction declarations inside a
  // function body shadow only within that scope. They must not suppress
  // an implicit top-level global of the same name (e.g. `de = math.deg`
  // at file scope while a function further down has `local de = ...`).
  let fnDepth = 0;
  // Block depth excluding the root block. Locals declared inside an
  // `if`/`for`/`while`/`do` body are block-scoped in Lua — they do NOT bind
  // at file scope. Without this, `if cond then local X = … end; print(X)`
  // mistakenly marks X as declared so its outer-scope read is never
  // predeclared and the JS emits a ReferenceError.
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
