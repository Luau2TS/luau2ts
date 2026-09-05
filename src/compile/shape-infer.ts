// Per-variable structural shape inference for rbxts-mode emit.
// Scans a function body and records the per-variable access pattern
// (props, methods, indexed access). The aggregated shape is materialized
// as a TS interface and used as the param/local annotation.

import ts from 'typescript';
import type { Expr, Stat, FunctionExpr } from '../parser/index.js';

const { factory } = ts;

/** Recursive structural shape for a single Luau variable. The shape
 *  is monotone — the union of all observed accesses. */
export interface Shape {
  props: Map<string, Shape>;
  methods: Map<string, { maxArgs: number }>;
  indexed: boolean;
  assigned: boolean;
  /** Variable was directly called (`fn(args)`); emit a call signature. */
  callable: boolean;
  /** No access observed — fall back to caller's existing annotation. */
  empty: boolean;
  /** Leaf-usage evidence. A leaf read in a position only a number can
   *  occupy (`x + 1`, `x % 2`, `math.floor(x)`) is `number`; one only a
   *  string can occupy (`string.upper(x)`) is `string`. Both together,
   *  or a write of anything else, and the leaf stays `unknown` — the
   *  per-use bridge is no worse than a wrong declaration. */
  numberEvidence: boolean;
  stringEvidence: boolean;
  assignedKinds: Set<'number' | 'string' | 'other'>;
}

function newShape(): Shape {
  return {
    props: new Map(),
    methods: new Map(),
    indexed: false,
    assigned: false,
    callable: false,
    empty: true,
    numberEvidence: false,
    stringEvidence: false,
    assignedKinds: new Set(),
  };
}

/** True when a Luau expression is a number on its face: a numeric
 *  literal, `#x`, or a `math.*` call. Used to disambiguate `+`/`-`/`<`
 *  (valid on vectors and strings too) — a number on the other side
 *  pins the tracked operand to number. */
function isPlainNumber(e: Expr | null | undefined): boolean {
  if (!e) return false;
  switch (e.type) {
    case 'ConstantNumber':
    case 'ConstantInteger':
      return true;
    case 'Group':
      return isPlainNumber(e.expr);
    case 'Unary':
      return e.op === '#' || (e.op === '-' && isPlainNumber(e.expr));
    case 'Call':
      return e.func.type === 'IndexName' && e.func.expr.type === 'Global' && e.func.expr.name === 'math';
    default:
      return false;
  }
}

function kindOfWrite(e: Expr): 'number' | 'string' | 'other' {
  if (e.type === 'ConstantNumber' || e.type === 'ConstantInteger') return 'number';
  if (e.type === 'ConstantString') return 'string';
  if (e.type === 'Group') return kindOfWrite(e.expr);
  if (isPlainNumber(e)) return 'number';
  return 'other';
}

/** Members only a string has. `string.format`'s first arg and `..`
 *  operands are excluded: numbers flow through both. */
const STRING_ONLY_LIB = new Set(['upper', 'lower', 'sub', 'rep', 'reverse', 'split', 'gsub', 'gmatch', 'find', 'match', 'byte', 'len']);
const NUMBER_ONLY_OPS = new Set(['%', '//', '^']);

function getOrAddProp(shape: Shape, name: string): Shape {
  shape.empty = false;
  let s = shape.props.get(name);
  if (!s) {
    s = newShape();
    shape.props.set(name, s);
  }
  return s;
}

function recordMethod(shape: Shape, name: string, argc: number): Shape {
  shape.empty = false;
  const existing = shape.methods.get(name);
  if (existing) {
    existing.maxArgs = Math.max(existing.maxArgs, argc);
  } else {
    shape.methods.set(name, { maxArgs: argc });
  }
  // Mirror methods into props so chained access on the result is captured.
  return getOrAddProp(shape, name);
}

/** Collect shapes for each name in `vars` within a body. Names outside
 *  `vars` aren't tracked. */
export function collectShapes(body: Stat, vars: Set<string>): Map<string, Shape> {
  const shapes = new Map<string, Shape>();
  for (const v of vars) shapes.set(v, newShape());

  /** Returns the result-value shape, or null if untracked. */
  function visitExpr(expr: Expr | null | undefined): Shape | null {
    if (!expr) return null;
    switch (expr.type) {
      case 'Local':
      case 'Global': {
        const name = (expr as { name: string }).name;
        const s = shapes.get(name);
        return s ?? null;
      }
      case 'IndexName': {
        const receiver = visitExpr((expr as { expr: Expr }).expr);
        if (!receiver) return null;
        return getOrAddProp(receiver, (expr as { index: string }).index);
      }
      case 'IndexExpr': {
        const receiver = visitExpr((expr as { expr: Expr }).expr);
        if (receiver) {
          receiver.indexed = true;
          receiver.empty = false;
        }
        visitExpr((expr as { index: Expr }).index);
        return null;
      }
      case 'Call': {
        const call = expr as Extract<Expr, { type: 'Call' }>;
        // table.X(t, ...) macros lower to instance methods on `t` — record them
        // so the first-arg shape acquires the right method.
        const macroMap: Record<string, string> = {
          'table.insert': 'push',
          'table.remove': 'remove',
          'table.concat': 'join',
          'table.sort': 'sort',
          'table.find': 'indexOf',
          'table.clone': 'slice',
        };
        if (
          call.func && call.func.type === 'IndexName'
          && (call.func as { expr: Expr }).expr.type === 'Global'
        ) {
          const nsName = ((call.func as { expr: Expr }).expr as { name: string }).name;
          const methodName = (call.func as { index: string }).index;
          const key = `${nsName}.${methodName}`;
          const macroMethod = macroMap[key];
          if (macroMethod && call.args.length > 0) {
            const tgtShape = visitExpr(call.args[0]);
            if (tgtShape) {
              recordMethod(tgtShape, macroMethod, call.args.length - 1);
            }
            for (const a of call.args.slice(1)) visitExpr(a);
            return null;
          }
        }
        if (call.func && call.func.type === 'IndexName') {
          const idx = (call.func as { index: string }).index;
          const innerExpr = (call.func as { expr: Expr }).expr;
          if (innerExpr.type === 'Global' && innerExpr.name === 'math') {
            // Every math.* argument is a number.
            for (const a of call.args) {
              const s = visitExpr(a);
              if (s) s.numberEvidence = true;
            }
            return null;
          }
          if (innerExpr.type === 'Global' && innerExpr.name === 'string' && STRING_ONLY_LIB.has(idx) && call.args.length > 0) {
            const s = visitExpr(call.args[0]);
            if (s) s.stringEvidence = true;
            for (const a of call.args.slice(1)) visitExpr(a);
            return null;
          }
          if (call.self && STRING_ONLY_LIB.has(idx)) {
            // `s:upper()` — the receiver is a string.
            const s = visitExpr(innerExpr);
            if (s) s.stringEvidence = true;
            for (const a of call.args) visitExpr(a);
            return null;
          }
          const innerShape = visitExpr(innerExpr);
          if (innerShape) {
            recordMethod(innerShape, idx, call.args.length);
          }
        } else {
          // Bare call on a tracked var — mark callable so shapeToTypeNode emits a call signature.
          const innerShape = visitExpr(call.func);
          if (innerShape) {
            innerShape.empty = false;
            innerShape.callable = true;
            const meta = innerShape.methods.get('__call__');
            if (meta) {
              meta.maxArgs = Math.max(meta.maxArgs, call.args.length);
            } else {
              innerShape.methods.set('__call__', { maxArgs: call.args.length });
            }
          }
        }
        for (const a of call.args) visitExpr(a);
        return null;
      }
      case 'Binary': {
        const b = expr as Extract<Expr, { type: 'Binary' }>;
        const ls = visitExpr(b.left);
        const rs = visitExpr(b.right);
        const numberOnly = NUMBER_ONLY_OPS.has(b.op);
        // `+`/`-`/`<`… admit vectors and strings; a plain-number partner
        // rules those out for the tracked side.
        const pinnedByPartner = ['+', '-', '<', '>', '<=', '>='].includes(b.op);
        if (ls && (numberOnly || (pinnedByPartner && isPlainNumber(b.right)))) ls.numberEvidence = true;
        if (rs && (numberOnly || (pinnedByPartner && isPlainNumber(b.left)))) rs.numberEvidence = true;
        return null;
      }
      case 'Unary': {
        visitExpr((expr as { expr: Expr }).expr);
        return null;
      }
      case 'Group':
        return visitExpr((expr as { expr: Expr }).expr);
      case 'IfElse': {
        const i = expr as { condition: Expr; trueExpr: Expr; falseExpr: Expr };
        visitExpr(i.condition);
        visitExpr(i.trueExpr);
        visitExpr(i.falseExpr);
        return null;
      }
      case 'Table': {
        const t = expr as { items: { key: Expr | null; value: Expr }[] };
        for (const item of t.items) {
          if (item.key) visitExpr(item.key);
          visitExpr(item.value);
        }
        return null;
      }
      case 'Function': {
        visitFunction(expr as FunctionExpr);
        return null;
      }
      case 'TypeAssertion': {
        visitExpr((expr as { expr: Expr }).expr);
        return null;
      }
      default:
        return null;
    }
  }

  function visitFunction(fn: FunctionExpr): void {
    if (!fn.body) return;
    visitStat(fn.body);
  }

  function visitStat(stat: Stat | null | undefined): void {
    if (!stat) return;
    switch (stat.type) {
      case 'Block': {
        for (const s of (stat as { body: Stat[] }).body) visitStat(s);
        return;
      }
      case 'If': {
        const i = stat as { condition: Expr; thenBody: Stat; elseBody: Stat | null };
        visitExpr(i.condition);
        visitStat(i.thenBody);
        visitStat(i.elseBody);
        return;
      }
      case 'While':
      case 'Repeat': {
        const w = stat as { condition: Expr; body: Stat };
        visitExpr(w.condition);
        visitStat(w.body);
        return;
      }
      case 'For': {
        const f = stat as { from: Expr; to: Expr; step?: Expr | null; body: Stat };
        visitExpr(f.from);
        visitExpr(f.to);
        if (f.step) visitExpr(f.step);
        visitStat(f.body);
        return;
      }
      case 'ForIn': {
        const f = stat as { values: Expr[]; body: Stat };
        for (const v of f.values) visitExpr(v);
        visitStat(f.body);
        return;
      }
      case 'Return': {
        for (const v of (stat as { values: Expr[] }).values) visitExpr(v);
        return;
      }
      case 'Local': {
        for (const v of (stat as { values: Expr[] }).values) visitExpr(v);
        return;
      }
      case 'Assign': {
        const a = stat as { vars: Expr[]; values: Expr[] };
        a.vars.forEach((tgt, ti) => {
          if (tgt.type === 'IndexName') {
            const inner = visitExpr((tgt as { expr: Expr }).expr);
            if (inner) {
              const propName = (tgt as { index: string }).index;
              const prop = getOrAddProp(inner, propName);
              prop.assigned = true;
              const rhs = a.values[ti];
              prop.assignedKinds.add(rhs ? kindOfWrite(rhs) : 'other');
            }
          } else if (tgt.type === 'IndexExpr') {
            const inner = visitExpr((tgt as { expr: Expr }).expr);
            if (inner) inner.indexed = true;
            visitExpr((tgt as { index: Expr }).index);
          } else {
            visitExpr(tgt);
          }
        });
        for (const v of a.values) visitExpr(v);
        return;
      }
      case 'CompoundAssign': {
        const c = stat as Extract<Stat, { type: 'CompoundAssign' }>;
        const target = visitExpr(c.var);
        visitExpr(c.value);
        if (target) {
          if (NUMBER_ONLY_OPS.has(c.op) || (['+', '-'].includes(c.op) && isPlainNumber(c.value))) {
            target.numberEvidence = true;
            target.assignedKinds.add('number');
          } else if (c.op === '..') {
            target.assignedKinds.add('other');
          } else {
            target.assignedKinds.add('other');
          }
        }
        return;
      }
      case 'Expr': {
        visitExpr((stat as { expr: Expr }).expr);
        return;
      }
      case 'Function': {
        visitFunction((stat as { func: FunctionExpr }).func);
        return;
      }
      case 'LocalFunction': {
        visitFunction((stat as { func: FunctionExpr }).func);
        return;
      }
      default:
        return;
    }
  }

  visitStat(body);
  return shapes;
}

/** Collect every name introduced by `local` / `local function` in `body`. */
export function collectLocalNames(body: Stat): Set<string> {
  const names = new Set<string>();
  function visit(stat: Stat | null | undefined): void {
    if (!stat) return;
    switch (stat.type) {
      case 'Block':
        for (const s of (stat as { body: Stat[] }).body) visit(s);
        return;
      case 'If': {
        const i = stat as { thenBody: Stat; elseBody: Stat | null };
        visit(i.thenBody);
        visit(i.elseBody);
        return;
      }
      case 'While':
      case 'Repeat':
        visit((stat as { body: Stat }).body);
        return;
      case 'For':
        names.add((stat as { var: { name: string } }).var.name);
        visit((stat as { body: Stat }).body);
        return;
      case 'ForIn':
        for (const v of (stat as { vars: { name: string }[] }).vars) {
          names.add(v.name);
        }
        visit((stat as { body: Stat }).body);
        return;
      case 'Local':
        for (const v of (stat as { vars: { name: string }[] }).vars) {
          names.add(v.name);
        }
        return;
      case 'LocalFunction':
        names.add((stat as { name: { name: string } }).name.name);
        return;
      // Nested function scopes — inner locals don't bleed in.
      default:
        return;
    }
  }
  visit(body);
  return names;
}

/** Instance-interface members that identify a value as a Roblox Instance.
 *  Triggers `& Instance` intersection on the synthesized type. Includes
 *  universal Instance properties (Name, Parent, ClassName, Archivable)
 *  so shape-typed locals whose only observed access is `.Name`/`.Parent`
 *  still get the `& Instance` intersection — without it, shapeToTypeNode
 *  produces a bare `{Name: unknown; Parent: unknown}` literal that loses
 *  navigation methods (FindFirstChild, etc.) and triggers TS2339 on
 *  every chain access through the local. */
const INSTANCE_DISCRIMINATORS = new Set([
  'GetAttribute', 'SetAttribute', 'GetAttributes', 'SetAttributes',
  'IsA', 'IsDescendantOf', 'IsAncestorOf',
  'WaitForChild', 'FindFirstChild', 'FindFirstChildOfClass',
  'FindFirstChildWhichIsA', 'FindFirstAncestor', 'FindFirstAncestorOfClass',
  'FindFirstAncestorWhichIsA',
  'GetChildren', 'GetDescendants', 'GetFullName',
  'GetPropertyChangedSignal', 'GetAttributeChangedSignal',
  'Destroy', 'Clone',
  'ClassName', 'Name', 'Parent', 'Archivable',
]);

/** Player-only members — pick `& Player` over `& Instance` for typed signatures. */
const PLAYER_DISCRIMINATORS = new Set([
  'UserId', 'DisplayName', 'Character', 'CharacterAdded',
  'CharacterRemoving', 'LoadCharacter', 'GetRoleInGroup',
  'GetRankInGroup', 'IsInGroup', 'Kick',
]);

function intersectionTypeName(shape: Shape): string | null {
  const has = (name: string) =>
    shape.props.has(name) || shape.methods.has(name);
  for (const d of PLAYER_DISCRIMINATORS) if (has(d)) return 'Player';
  // Vector3 (X/Y/Z) — check before Instance, no overlap with INSTANCE_DISCRIMINATORS.
  if (has('X') && has('Y') && has('Z')) return 'Vector3';
  for (const d of INSTANCE_DISCRIMINATORS) if (has(d)) return 'Instance';
  return null;
}

/** Methods that identify a value as a JS Array — treat as `Array<defined>`. */
const ARRAY_METHOD_DISCRIMINATORS = new Set([
  'push', 'pop', 'shift', 'unshift', 'insert', 'remove',
  'indexOf', 'lastIndexOf', 'join', 'concat', 'find',
  'forEach', 'map', 'filter', 'reduce',
]);

function looksLikeArray(shape: Shape): boolean {
  for (const name of shape.methods.keys()) {
    if (ARRAY_METHOD_DISCRIMINATORS.has(name)) return true;
  }
  return false;
}

/** Names the intersection target already declares — drop from synthesized literal
 *  so our loose `(...args: unknown[]): unknown` doesn't shadow the @rbxts/types one. */
function intersectionTargetDeclaresName(target: string, name: string): boolean {
  if (target === 'Instance') return INSTANCE_DISCRIMINATORS.has(name);
  // Player extends Instance — every Instance member is also a Player
  // member.
  if (target === 'Player') return INSTANCE_DISCRIMINATORS.has(name)
    || PLAYER_DISCRIMINATORS.has(name);
  if (target === 'Vector3') return name === 'X' || name === 'Y' || name === 'Z'
    || name === 'add' || name === 'sub' || name === 'mul' || name === 'div'
    || name === 'Magnitude' || name === 'Unit';
  return false;
}

/** Convert a Shape to a TS type-literal node, or null if empty.
 *  Methods get `(...args: unknown[]): unknown`; indexed shapes get
 *  `[k: string]: unknown`. */
export function shapeToTypeNode(shape: Shape): ts.TypeNode | null {
  if (shape.empty) return null;

  // Array-like shapes get `Array<defined>` — typed methods (push/splice/indexOf)
  // are needed for chained access. `defined` over `unknown` to satisfy `this: defined[]`.
  if (looksLikeArray(shape)) {
    return factory.createArrayTypeNode(
      factory.createTypeReferenceNode('defined', undefined),
    );
  }

  const members: ts.TypeElement[] = [];

  if (shape.callable) {
    // `__call__` is the arity record; skip in the prop loop below.
    const callMeta = shape.methods.get('__call__');
    members.push(
      factory.createCallSignature(
        undefined,
        [factory.createParameterDeclaration(
          undefined,
          factory.createToken(ts.SyntaxKind.DotDotDotToken),
          factory.createIdentifier('args'),
          undefined,
          factory.createArrayTypeNode(factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword)),
        )],
        factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
      ),
    );
    void callMeta;
  }

  for (const [name, child] of shape.props) {
    if (name === '__call__') continue;
    // Methods get `name(...args: unknown[]): unknown`; properties use child shape.
    // TODO: track return shapes through call.results in a future iteration.
    const methodMeta = shape.methods.get(name);
    if (methodMeta) {
      members.push(
        factory.createMethodSignature(
          undefined,
          propertyName(name),
          undefined,
          undefined,
          [factory.createParameterDeclaration(
            undefined,
            factory.createToken(ts.SyntaxKind.DotDotDotToken),
            factory.createIdentifier('args'),
            undefined,
            factory.createArrayTypeNode(factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword)),
          )],
          factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
        ),
      );
      continue;
    }
    const childType = shapeToTypeNode(child)
      ?? leafTypeNode(child)
      ?? factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);
    members.push(
      factory.createPropertySignature(
        undefined,
        propertyName(name),
        undefined,
        childType,
      ),
    );
  }

  if (shape.indexed) {
    members.push(
      factory.createIndexSignature(
        undefined,
        [factory.createParameterDeclaration(
          undefined,
          undefined,
          factory.createIdentifier('k'),
          undefined,
          factory.createKeywordTypeNode(ts.SyntaxKind.StringKeyword),
        )],
        factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
      ),
    );
  }

  if (members.length === 0) return null;
  // For recognized Roblox classes, drop members the class already declares,
  // then intersect: `{ ...extras } & TargetClass`.
  const targetClass = intersectionTypeName(shape);
  if (targetClass) {
    const trimmedMembers = members.filter((m) => {
      const name = m.name && ts.isIdentifier(m.name) ? m.name.text : undefined;
      if (!name) return true;
      return !intersectionTargetDeclaresName(targetClass, name);
    });
    const intersectedLiteral = trimmedMembers.length > 0
      ? factory.createTypeLiteralNode(trimmedMembers)
      : null;
    if (intersectedLiteral) {
      return factory.createIntersectionTypeNode([
        intersectedLiteral,
        factory.createTypeReferenceNode(targetClass, undefined),
      ]);
    }
    return factory.createTypeReferenceNode(targetClass, undefined);
  }
  return factory.createTypeLiteralNode(members);
}

/** The primitive a leaf's usage pins it to, or null. */
export function leafPrimitive(shape: Shape): 'number' | 'string' | null {
  if (!shape.empty) return null;
  const writes = shape.assignedKinds;
  if (shape.numberEvidence && !shape.stringEvidence) {
    for (const k of writes) if (k !== 'number') return null;
    return 'number';
  }
  if (shape.stringEvidence && !shape.numberEvidence) {
    for (const k of writes) if (k !== 'string') return null;
    return 'string';
  }
  return null;
}

function leafTypeNode(shape: Shape): ts.TypeNode | null {
  const prim = leafPrimitive(shape);
  if (prim === 'number') return factory.createKeywordTypeNode(ts.SyntaxKind.NumberKeyword);
  if (prim === 'string') return factory.createKeywordTypeNode(ts.SyntaxKind.StringKeyword);
  return null;
}

function propertyName(name: string): ts.PropertyName {
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) {
    return factory.createIdentifier(name);
  }
  return factory.createStringLiteral(name);
}

/** Merge `other` into `dst` in place. Same-name props recurse;
 *  same-name methods keep the larger maxArgs. */
export function mergeShape(dst: Shape, other: Shape): void {
  dst.numberEvidence = dst.numberEvidence || other.numberEvidence;
  dst.stringEvidence = dst.stringEvidence || other.stringEvidence;
  for (const k of other.assignedKinds) dst.assignedKinds.add(k);
  if (other.empty) return;
  dst.empty = false;
  dst.indexed = dst.indexed || other.indexed;
  dst.assigned = dst.assigned || other.assigned;
  for (const [name, child] of other.props) {
    const existing = dst.props.get(name);
    if (existing) {
      mergeShape(existing, child);
    } else {
      dst.props.set(name, child);
    }
  }
  for (const [name, meta] of other.methods) {
    const existing = dst.methods.get(name);
    if (existing) {
      existing.maxArgs = Math.max(existing.maxArgs, meta.maxArgs);
    } else {
      dst.methods.set(name, { ...meta });
    }
  }
}
