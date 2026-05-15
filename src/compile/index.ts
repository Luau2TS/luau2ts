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
import { compileType, compileTypePack } from './type.js';
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
  if (stat.vars.length > 1 && stat.values.length === 1 && stat.values[0]?.type === 'Call') {
    const rawInit = compileExpr(stat.values[0]!, ctx);
    const init = factory.createCallExpression(
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
    const initExpr = init ? compileExpr(init, ctx) : undefined;
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
      newDecls.push(
        factory.createVariableDeclaration(
          factory.createIdentifier(jsName),
          undefined,
          v.annotation ? compileType(v.annotation) : undefined,
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
function maxMultiReturnArity(body: BlockStat | Stat): number | null {
  let max: number | null = null;
  function walk(stat: Stat | null | undefined): void {
    if (!stat) return;
    if (stat.type === 'Function' || stat.type === 'LocalFunction') return;
    if (stat.type === 'Return') {
      if (stat.values.length > 1) {
        max = Math.max(max ?? 0, stat.values.length);
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
  const { params, returnType, body } = compileFunctionShape(stat.func, ctx);
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
          undefined,
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
    undefined,
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
  const fn = compileFunctionExpr(stat.func, ctx);
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
    return factory.createFunctionDeclaration(
      asyncModIfNeeded(fn.body),
      undefined,
      factory.createIdentifier(safeIdentifier(stat.name.name)),
      undefined,
      paramsFromLocals(stat.func.args),
      stat.func.returnAnnotation ? compileTypePack(stat.func.returnAnnotation) : undefined,
      fn.body,
    );
  }
  // Member: `obj.x = function ...` — use the parsed name as an lvalue.
  return factory.createExpressionStatement(
    factory.createAssignment(compileExpr(stat.name, ctx), fn),
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

  if (stat.values.length === 1 && stat.values[0]!.type === 'Call') {
    const call = stat.values[0] as Extract<Expr, { type: 'Call' }>;
    const callee = call.func;
    if (callee.type === 'Global' && (callee.name === 'ipairs' || callee.name === 'pairs') && call.args.length === 1) {
      const fast = compileForInFastPath(stat, callee.name, call.args[0]!, ctx);
      if (fast) return fast;
    }
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
    const valueExpr = factory.createCallExpression(
      factory.createIdentifier(ctx.use('multiret')),
      undefined,
      [compileExpr(stat.values[0]!, ctx)],
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
    const targetExpr = compileExpr(target, ctx);
    const valueExpr = compileExpr(value, ctx);
    if (target.type === 'Local') ctx.assignLocal(target.name, staticTypeOfExpr(value, ctx));
    stmts.push(
      factory.createExpressionStatement(
        factory.createAssignment(targetExpr, valueExpr),
      ),
    );
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
  const op = compoundAssignToken(stat.op);
  if (op !== undefined) {
    return factory.createExpressionStatement(factory.createBinaryExpression(target, op, value));
  }
  if (stat.op === '..') {
    const concat = ctx.use('luaConcat');
    return factory.createExpressionStatement(
      factory.createAssignment(
        target,
        factory.createCallExpression(factory.createIdentifier(concat), undefined, [target, value]),
      ),
    );
  }
  if (stat.op === '//') {
    const idiv = ctx.use('luaIdiv');
    return factory.createExpressionStatement(
      factory.createAssignment(
        target,
        factory.createCallExpression(factory.createIdentifier(idiv), undefined, [target, value]),
      ),
    );
  }
  return factory.createExpressionStatement(
    factory.createAssignment(target, compileBinary(stat.op, target, value, ctx)),
  );
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
  // `type X<T> = ...` → `type X<T> = ...;` with same generics.
  const typeParams = stat.generics.map((g) =>
    factory.createTypeParameterDeclaration(
      undefined,
      factory.createIdentifier(g.name),
      undefined,
      g.defaultValue ? compileType(g.defaultValue) : undefined,
    ),
  );
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
  returnType: ts.TypeNode | undefined;
  body: ts.Block;
}

function compileFunctionShape(fn: FunctionExpr, ctx: CompileContext): CompiledFunction {
  const params: ts.ParameterDeclaration[] = [];
  // Treat any function whose first explicit argument is literally named
  // `self` as a method, even if defined via dot syntax. Roblox places
  // ship plenty of dot-defined methods like
  // `Invisicam.SetMode = function(self, newMode) end` paired with
  // colon calls (`Invisicam:SetMode(x)`); without this, the function
  // signature would consume the call's first real argument into `self`
  // and shift everything else down by one. `self` is reserved by
  // convention in Lua, so the false-positive risk is negligible.
  const implicitSelf = fn.self === null
    && fn.args.length > 0
    && fn.args[0]!.name === 'self';
  const hasSelf = fn.self !== null || implicitSelf;
  if (hasSelf) {
    params.push(
      factory.createParameterDeclaration(
        undefined,
        undefined,
        factory.createIdentifier('this'),
        undefined,
        factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
      ),
    );
  }
  const realArgs = implicitSelf ? fn.args.slice(1) : fn.args;
  for (const p of paramsFromLocals(realArgs)) {
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
  return {
    params,
    returnType,
    body: factory.createBlock(innerStatements, true),
  };
}

function paramsFromLocals(locals: readonly Local[]): ts.ParameterDeclaration[] {
  const seen = new Set<string>();
  const out: ts.ParameterDeclaration[] = [];
  locals.forEach((local, i) => {
    const base = safeIdentifier(local.name);
    let name = base;
    if (seen.has(name)) name = `_dup_${i}`;
    seen.add(name);
    out.push(
      factory.createParameterDeclaration(
        undefined,
        undefined,
        factory.createIdentifier(name),
        undefined,
        local.annotation ? compileType(local.annotation) : undefined,
      ),
    );
  });
  return out;
}

function compileFunctionExpr(fn: FunctionExpr, ctx: CompileContext): ts.FunctionExpression {
  const { params, returnType, body } = compileFunctionShape(fn, ctx);
  return factory.createFunctionExpression(
    asyncModIfNeeded(body),
    undefined,
    undefined,
    undefined,
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
      return factory.createIdentifier('undefined');
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
    case 'IndexName':
      // Property names allow reserved words (`obj.new` is fine) — use
      // propertyName, not safeIdentifier, so `Instance.new("Part")` stays
      // as-written instead of becoming `Instance.new_("Part")`.
      return factory.createPropertyAccessExpression(
        compileExpr(expr.expr, ctx),
        factory.createIdentifier(propertyName(expr.index)),
      );
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
      const target = compileExpr(expr.expr, ctx);
      const indexExpr = expr.index;
      const index = compileExpr(indexExpr, ctx);
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
        return factory.createElementAccessExpression(target, lit);
      }
      if (indexExpr.type === 'ConstantString') {
        return factory.createElementAccessExpression(target, index);
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
    case 'TypeAssertion':
      return factory.createAsExpression(compileExpr(expr.expr, ctx), compileType(expr.annotation));
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
      const fn = ctx.use('luaNot');
      return factory.createCallExpression(factory.createIdentifier(fn), undefined, [inner]);
    }
  }
}

function compileBinaryExpr(expr: Extract<Expr, { type: 'Binary' }>, ctx: CompileContext): ts.Expression {
  const leftType = staticTypeOfExpr(expr.left, ctx);
  const rightType = staticTypeOfExpr(expr.right, ctx);
  const left = compileExpr(expr.left, ctx);
  const right = compileExpr(expr.right, ctx);

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
  if (directOp !== undefined) return factory.createBinaryExpression(left, directOp, right);

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
  const isTruthyFn = ctx.use('isTruthy');
  const leftId = factory.createIdentifier('__l');
  const needsAsync = nodeContainsAwait(right);
  const choose = factory.createConditionalExpression(
    factory.createCallExpression(factory.createIdentifier(isTruthyFn), undefined, [leftId]),
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
  // Old admin scripts snapshot Lua globals into locals at startup
  // (`local wait,pcall,...=wait,pcall,...`). The reference type flips
  // from Global to Local but the binding still points at the yielding
  // implementation, so the await wrap must still fire.
  if ((expr.func.type === 'Global' || expr.func.type === 'Local') && YIELDING_FREE_FUNCS.has(expr.func.name)) return true;
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

function compileExprAsArg(a: Expr, ctx: CompileContext): ts.Expression {
  if (a.type === 'Varargs') {
    return factory.createSpreadElement(factory.createIdentifier('__varargs'));
  }
  return compileExpr(a, ctx);
}

function compileCall(expr: Extract<Expr, { type: 'Call' }>, ctx: CompileContext): ts.Expression {
  const args = expr.args.map((a) => compileExprAsArg(a, ctx));

  // Macro registry — interception point for compatMode='rbxts' rewrites
  // (Vector3.new → new Vector3, Instance.new("Part") → new Part(),
  // game:GetService("X") → imported X singleton, TS.async → async fn, …).
  // Macros may decline (return undefined) and fall through to default emit.
  const macroResult = lookupMacro({ call: expr, compiledArgs: args, ctx });
  if (macroResult !== undefined) {
    if (isYieldingCall(expr, ctx)) return factory.createAwaitExpression(macroResult);
    return macroResult;
  }

  let call: ts.Expression;
  if (expr.self && expr.func.type === 'IndexName') {
    call = factory.createCallExpression(
      factory.createPropertyAccessExpression(
        compileExpr(expr.func.expr, ctx),
        factory.createIdentifier(propertyName(expr.func.index)),
      ),
      undefined,
      args,
    );
  } else {
    call = factory.createCallExpression(compileExpr(expr.func, ctx), undefined, args);
  }
  if (isYieldingCall(expr, ctx)) {
    return factory.createAwaitExpression(call);
  }
  return call;
}

function compileTableExpr(
  expr: Extract<Expr, { type: 'Table' }>,
  ctx: CompileContext,
): ts.Expression {
  const allList = expr.items.every((i) => i.kind === 'List');
  const allRecord = expr.items.every((i) => i.kind === 'Record');

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
  const value = compileExpr(item.value, ctx);
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
}

export interface CompileResult {
  /** Full TypeScript source of the compiled output. */
  source: string;
  /** Helper names the output imports from luau2ts/runtime. */
  helpers: string[];
  /** Parser errors, if any (compiler returns parser-error output even so). */
  errors: ParseResult['errors'];
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
  const stmts: ts.Statement[] = rootBlock ? compileBlockBody(rootBlock, ctx) : [];
  const helpers = ctx.importedHelpers();

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
  for (const name of implicitGlobals) {
    // Initialize the predecl from `_G[name]` so cross-script globals set
    // earlier in the place's startup are visible at this script's start.
    // (Best-effort: still doesn't see later updates from other scripts —
    // matching Lua semantics would need every read to consult _G, which is
    // a deeper refactor.)
    implicitGlobalDecls.push(
      factory.createVariableStatement(
        undefined,
        factory.createVariableDeclarationList(
          [factory.createVariableDeclaration(
            factory.createIdentifier(safeIdentifier(name)),
            undefined,
            undefined,
            factory.createElementAccessExpression(
              factory.createIdentifier('_G'),
              factory.createStringLiteral(name),
            ),
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
    allStatements.push(buildNamedImport(module, names));
  }
  allStatements.push(...implicitGlobalDecls);
  allStatements.push(...stmts);

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
 *  blocks (imports, function/class declarations, big control-flow). The
 *  TS factory printer doesn't do this — it just newlines between every
 *  statement — so we insert separators heuristically. The rules are
 *  conservative: only insert a blank line at boundaries between distinct
 *  *kinds* of top-level statements, and never inside a block. */
function beautifyOutput(source: string): string {
  const lines = source.split('\n');
  const out: string[] = [];
  let prev: 'import' | 'class' | 'function' | 'control' | 'simple' | 'blank' | 'start' = 'start';
  let depth = 0;

  function classify(line: string): typeof prev {
    const trimmed = line.trim();
    if (trimmed === '') return 'blank';
    if (trimmed.startsWith('import ')) return 'import';
    if (/^(?:export\s+)?(?:abstract\s+)?class\b/.test(trimmed)) return 'class';
    if (/^(?:export\s+)?(?:async\s+)?function\b/.test(trimmed)) return 'function';
    if (/^(?:if|for|while|do|switch|try)\b/.test(trimmed)) return 'control';
    return 'simple';
  }

  for (const raw of lines) {
    // Track brace depth on the *previous* line; statements outside any
    // block are at depth 0.
    if (depth === 0 && prev !== 'start' && prev !== 'blank') {
      const kind = classify(raw);
      // Add a blank line at the boundary between distinct kinds.
      const isBoundary =
        (prev === 'import' && kind !== 'import')
        || (prev === 'class' && kind !== 'blank')
        || (prev === 'function' && kind !== 'blank')
        || (prev === 'control' && kind !== 'blank')
        || (kind === 'class' || kind === 'function');
      if (isBoundary && kind !== 'blank') out.push('');
    }
    out.push(raw);
    if (raw.trim() !== '') prev = classify(raw);
    // Update brace depth based on this line's contribution.
    for (const c of raw) {
      if (c === '{') depth++;
      else if (c === '}') depth = Math.max(0, depth - 1);
    }
  }
  return out.join('\n');
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
