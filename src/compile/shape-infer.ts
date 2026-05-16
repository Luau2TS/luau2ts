// Per-variable structural shape inference for rbxts-mode emit.
//
// Phase 2 of the rbxts emit cleanup. Phase 1 dropped blanket `as any`
// casts and switched unannotated params/locals to `: unknown`. That
// surfaced ~600 TS18046 errors where the body accesses `.X.Y` on an
// unknown-typed value.
//
// This module scans a function body (or any Stat) and records, per
// variable name, the structural pattern of accesses observed:
//
//   button.Size.X.Scale           → { Size: { X: { Scale: {} } } }
//   button:GetAttribute("foo")    → adds GetAttribute as a method
//   button.MouseEnter.Connect(f)  → { MouseEnter: { Connect: <method> } }
//
// The aggregated shape is then materialized as a TS interface and
// used as the param/local annotation. The annotation needs to be a
// SUPERTYPE of whatever the call site passes — declaring only the
// properties we *use* in the body means callers can pass any value
// that has at least those, which matches Luau's structural typing.

import ts from 'typescript';
import type { Expr, Stat, FunctionExpr } from '../parser/index.js';

const { factory } = ts;

/** Recursive structural shape for a single Luau variable.
 *
 *  - `props` records `var.X` access; the inner shape captures further
 *    chained access on `X` (e.g. `var.X.Y`).
 *  - `methods` records `var:m(...)` / `var.m(...)` call patterns; the
 *    value is the max arity observed so the synthesized signature has
 *    enough placeholder params for any call site.
 *  - `indexed` is true if we saw `var[k]` — emit an index signature.
 *  - `assigned` is true if we saw `var.X = …` (vs. just reads). Used
 *    to decide between `readonly` and writable in the synthesized
 *    interface.
 *
 *  The shape is monotone: every observed pattern is included. We
 *  don't try to narrow or specialize — the union of accesses is the
 *  declared interface. */
export interface Shape {
  props: Map<string, Shape>;
  methods: Map<string, { maxArgs: number }>;
  indexed: boolean;
  assigned: boolean;
  /** True if the variable was directly called (`fn(args)`). Triggers
   *  shapeToTypeNode to emit a call signature alongside the
   *  property literal so `fn(...)` typechecks. */
  callable: boolean;
  /** True if this shape is the empty leaf — the variable was used
   *  bare (`local s; print(s)`) without any property/method/index
   *  access. In that case there's nothing to synthesize and we
   *  fall back to the caller's existing annotation. */
  empty: boolean;
}

function newShape(): Shape {
  return {
    props: new Map(),
    methods: new Map(),
    indexed: false,
    assigned: false,
    callable: false,
    empty: true,
  };
}

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
  // Methods can also be accessed as values (`button.MouseEnter` is read
  // and then `.Connect` called). We mirror them into props so chained
  // access on the method result is captured (the inner shape is the
  // result of the call).
  return getOrAddProp(shape, name);
}

/** Collect shapes for a set of variable names within a body. The
 *  `vars` set is the names we want to track (typically function
 *  params and locally-declared variables of the current scope).
 *  Shapes for variables NOT in the set are ignored — chained access
 *  on `x.foo.bar` only contributes if `x` is in the set; we don't
 *  separately track `x.foo`. */
export function collectShapes(body: Stat, vars: Set<string>): Map<string, Shape> {
  const shapes = new Map<string, Shape>();
  for (const v of vars) shapes.set(v, newShape());

  /** Walk an expression. Returns the shape that the expression's
   *  resulting value should have, or null if the expression doesn't
   *  terminate in a tracked variable (in which case nested access
   *  isn't recorded). */
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
        // `<receiver>.<name>` — record the access on the receiver's
        // shape and return the inner shape so further `.Y` access
        // chains correctly.
        const receiver = visitExpr((expr as { expr: Expr }).expr);
        if (!receiver) return null;
        return getOrAddProp(receiver, (expr as { index: string }).index);
      }
      case 'IndexExpr': {
        // `<receiver>[<key>]` — record indexed-access flag on the
        // receiver. Don't track the key expression as a property
        // name (it's a runtime value, not a static name); but DO
        // walk the key expression in case it references a tracked
        // variable.
        const receiver = visitExpr((expr as { expr: Expr }).expr);
        if (receiver) receiver.indexed = true;
        visitExpr((expr as { index: Expr }).index);
        return null;
      }
      case 'Call': {
        const call = expr as Extract<Expr, { type: 'Call' }>;
        // Detect method call patterns first.
        if (call.func && call.func.type === 'IndexName') {
          const idx = (call.func as { index: string }).index;
          const innerExpr = (call.func as { expr: Expr }).expr;
          const innerShape = visitExpr(innerExpr);
          if (innerShape) {
            // Record the method, including the colon-call (self) form.
            // arg count excludes the implicit self that Luau colon-syntax
            // adds at the AST level (we look at call.args.length).
            recordMethod(innerShape, idx, call.args.length);
          }
        } else {
          // Bare call on a tracked variable: `fn(...)` or
          // `callback(args)`. Mark the variable as callable so
          // shapeToTypeNode synthesizes a call signature instead
          // of a property literal.
          const innerShape = visitExpr(call.func);
          if (innerShape) {
            innerShape.empty = false;
            innerShape.callable = true;
            // Track max arity for the call signature.
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
        const b = expr as { left: Expr; right: Expr };
        visitExpr(b.left);
        visitExpr(b.right);
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
        for (const tgt of a.vars) {
          // Detect `var.X = …` and record the property as assigned
          // (write context) on the receiver's shape.
          if (tgt.type === 'IndexName') {
            const inner = visitExpr((tgt as { expr: Expr }).expr);
            if (inner) {
              const propName = (tgt as { index: string }).index;
              const prop = getOrAddProp(inner, propName);
              prop.assigned = true;
            }
          } else if (tgt.type === 'IndexExpr') {
            const inner = visitExpr((tgt as { expr: Expr }).expr);
            if (inner) inner.indexed = true;
            visitExpr((tgt as { index: Expr }).index);
          } else {
            visitExpr(tgt);
          }
        }
        for (const v of a.values) visitExpr(v);
        return;
      }
      case 'CompoundAssign': {
        const c = stat as { var: Expr; value: Expr };
        visitExpr(c.var);
        visitExpr(c.value);
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

/** Walk a Stat and collect every name introduced by `local <name> =
 *  …` declarations (including destructure patterns and `local
 *  function f()` forms). Used by callers that want to track shapes
 *  for the entire scope, not just params. */
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
        // `for i = a, b do` — `i` is local to the loop. Track it so
        // body accesses on `i.X` (rare but possible) get shaped.
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
      // Function-statement & nested function expressions create their
      // own scope; their inner locals don't bleed into ours. Skip.
      default:
        return;
    }
  }
  visit(body);
  return names;
}

/** Members of @rbxts/types' Instance interface that almost-certainly
 *  identify a value as a Roblox Instance. If a variable's shape
 *  records any of these, intersect the synthesized type with
 *  `Instance` so the value flows into APIs that expect Instance
 *  (TweenService.Create, FindFirstChild predicates, etc.) without
 *  TS2345 ("not assignable to parameter of type 'Instance'"). */
const INSTANCE_DISCRIMINATORS = new Set([
  'GetAttribute', 'SetAttribute', 'GetAttributes',
  'IsA', 'IsDescendantOf', 'IsAncestorOf',
  'WaitForChild', 'FindFirstChild', 'FindFirstChildOfClass',
  'FindFirstChildWhichIsA', 'FindFirstAncestor', 'FindFirstAncestorOfClass',
  'GetChildren', 'GetDescendants', 'GetFullName',
  'GetPropertyChangedSignal', 'GetAttributeChangedSignal',
  'Destroy', 'Clone',
  'ClassName',
]);

/** True if the shape includes any property/method that's definitively
 *  on Instance (and nowhere else in common code). Used to decide
 *  whether to intersect the synthesized type literal with Instance. */
function looksLikeInstance(shape: Shape): boolean {
  for (const name of shape.props.keys()) {
    if (INSTANCE_DISCRIMINATORS.has(name)) return true;
  }
  for (const name of shape.methods.keys()) {
    if (INSTANCE_DISCRIMINATORS.has(name)) return true;
  }
  return false;
}

/** Convert a Shape into a TS type-literal node, or `null` if the shape
 *  is empty (no observed access — fall back to whatever default
 *  annotation the caller would otherwise emit, typically `unknown`).
 *
 *  Property names that aren't valid JS identifiers are quoted. Methods
 *  declare `unknown[]` rest params sized to the max observed call
 *  arity, returning `unknown`. Indexed shapes get a `[k: string]:
 *  unknown` index signature. */
export function shapeToTypeNode(shape: Shape): ts.TypeNode | null {
  if (shape.empty) return null;
  const members: ts.TypeElement[] = [];

  if (shape.callable) {
    // Bare-call pattern: `fn(arg)`, `callback()`. Add a call
    // signature `(...args: unknown[]): unknown` so the variable
    // typechecks as callable. The synthetic `__call__` entry in
    // shape.methods is the arity record; skip it in the prop loop
    // below so we don't also emit it as a method.
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
    // If the property was also called as a method, declare it as a
    // method signature (callable + chainable). Otherwise it's a
    // property with the inferred child shape (or `unknown` if leaf).
    const methodMeta = shape.methods.get(name);
    if (methodMeta) {
      // Method signature: `name(...args: unknown[]): unknown`. The
      // rest param accepts any arity, matching the laxness of Luau
      // method dispatch. Return type is `unknown` since we don't
      // track return shapes (TODO: chain back through call.results
      // in a future iteration).
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
    // Leaf type: `unknown` is the safe default. Earlier we tried
    // `number` to cover the Luau coordinate idiom (Vector3/UDim2
    // component access), but that caused TS2322 storms on writes
    // (`obj.Size = new UDim2(...)` failed because Size was typed
    // `number`). A future iteration could choose leaf types from
    // observed usage (numeric arithmetic → number; assigned a UDim2
    // → UDim2; etc.) — for now we accept the residual TS18046
    // surface on number-context leaves.
    const childType = shapeToTypeNode(child)
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
  // If the shape looks like an Instance (has GetAttribute / IsA /
  // FindFirstChild / etc.), drop any INSTANCE_DISCRIMINATORS members
  // from the synthesized literal (Instance already declares them
  // with stricter sigs — `Destroy(): void` vs. our `Destroy(...args:
  // unknown[]): unknown`). Then intersect with Instance so the
  // result has Instance's typed members AND the structural-literal's
  // extras (user-named children, attributes accessed by name etc.).
  if (looksLikeInstance(shape)) {
    const trimmedMembers = members.filter((m) => {
      const name = m.name && ts.isIdentifier(m.name) ? m.name.text : undefined;
      if (!name) return true;
      return !INSTANCE_DISCRIMINATORS.has(name);
    });
    const intersectedLiteral = trimmedMembers.length > 0
      ? factory.createTypeLiteralNode(trimmedMembers)
      : null;
    if (intersectedLiteral) {
      return factory.createIntersectionTypeNode([
        intersectedLiteral,
        factory.createTypeReferenceNode('Instance', undefined),
      ]);
    }
    // Shape was nothing but Instance discriminators — just emit Instance.
    return factory.createTypeReferenceNode('Instance', undefined);
  }
  return factory.createTypeLiteralNode(members);
}

function propertyName(name: string): ts.PropertyName {
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) {
    return factory.createIdentifier(name);
  }
  return factory.createStringLiteral(name);
}

/** Merge `other` into `dst` in place. Used by class-shape to aggregate
 *  the `self` shape across all of a class's ctor / methods (each
 *  method observes a partial view of the instance; the union is the
 *  full surface). Same-name props recurse; same-name methods take the
 *  larger maxArgs. */
export function mergeShape(dst: Shape, other: Shape): void {
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
