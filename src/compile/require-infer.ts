// Cross-script ModuleScript return-type inference. Pass 2 of the
// Phase 3-finish architecture. Given a parsed module body, walks the IR
// to find the trailing `return X` statement, infers a structural type
// for X by collecting `function X.Y(...)`/`X.Y = ...`/`X[k] = ...`
// patterns within the same module.
//
// The result lives in a corpus-wide cache keyed by module path so per-
// script compile() calls (which receive a `requireResolver` in their
// options) can substitute the synthesized type at `require(path)` emit
// time, replacing the `_LuauChild` fallback.
//
// Session-D polish: each method captures its FunctionExpr so the
// emitter can run `inferParamPrimitives` and surface real param types
// instead of `(...args: unknown[]): defined`. Each property captures
// its initializer value expression so primitive / datatype constructors
// emit as their concrete type. Bindings to `Instance.new("BindableEvent")`
// are tracked so `module.X = bindable.Event` emits as `RBXScriptSignal<unknown>`.

import ts from 'typescript';
import type { BlockStat, Expr, FunctionExpr, Stat } from '../parser/index.js';
import { inferParamPrimitives, type Primitive } from './param-infer.js';

const { factory } = ts;

export interface ModuleReturnAnalysis {
  /** TS type node for the module's return value, or null if no usable
   *  return statement was found. */
  readonly type: ts.TypeNode | null;
  /** Field names typed as `Record<string, defined>` (empty-table init
   *  pattern). Consumer scripts use this to skip the bracket-access
   *  Record bridge when chaining into one of these fields. */
  readonly recordMapFields: string[];
  /** Structured map of exported member name → kind. Same data the
   *  TypeNode was built from, exposed separately so cross-script
   *  consumers can ask "is M.foo a method?" without re-parsing the
   *  printed type text. Empty when `type` is null.
   *
   *  Signals (`module.X = bindable.Event`) externalize as 'property'
   *  for backward compatibility with downstream consumers that match
   *  the prior method/property/recordMap kinds. The emitter knows the
   *  internal 'signal' classification and emits `RBXScriptSignal<...>`. */
  readonly members: ReadonlyMap<string, 'method' | 'property' | 'recordMap'>;
}

/** Internal-only classification carrying enough data to synthesize a
 *  real signature/type. Kept separate from the public `members` map
 *  so adding a new internal kind doesn't break downstream consumers. */
interface MemberInfo {
  kind: 'method' | 'property' | 'recordMap' | 'signal';
  /** Method: the FunctionExpr backing the declaration. Drives
   *  `inferParamPrimitives` for real param types. */
  fn?: FunctionExpr;
  /** Property/method-alias: the RHS expression. Drives the initializer-
   *  value type capture (primitives, datatype ctors, etc.) and alias
   *  resolution. */
  valueExpr?: Expr;
  /** Method-alias: the target member name on the same module
   *  (`module.X = module.Y` ⇒ X is an alias of Y). Resolved late so
   *  forward references work regardless of source order. */
  aliasOf?: string;
}

/** Analyze a parsed module body and return a structural type for its
 *  trailing return value.
 *
 *  `promoteMembers`, when set, names exported members that should be
 *  rendered as method signatures (`name(...args): defined`) even if the
 *  local analysis classified them as plain properties. Used by the
 *  cross-script call-site pass to upgrade `M.X = signal.new()` patterns
 *  once a sibling script's `M.X(...)` call confirms the member is
 *  callable in practice. */
export function analyzeModuleReturn(
  body: BlockStat | Stat,
  promoteMembers?: ReadonlySet<string>,
): ModuleReturnAnalysis {
  const returnedName = findTrailingReturnName(body);
  if (!returnedName) return { type: null, recordMapFields: [], members: new Map() };

  const members = new Map<string, MemberInfo>();
  // Session-D fix 3: pre-pass for signal-typed locals so initializer
  // assignments + later mutations can recognize `local b =
  // Instance.new("BindableEvent")` patterns.
  const signalLocals = collectSignalLocals(body);
  // First, harvest fields from the local's initializer if it's a table
  // literal: `local Defs = { achievements = {...}, badges = {...} }`.
  collectInitializerFields(body, returnedName, members, signalLocals);
  // Then collect mutations: `function X.Y(...)`, `X.Y = ...`.
  collectMemberAssignments(body, returnedName, members, signalLocals);
  // Apply cross-script call-site promotions: any property observed as
  // callable from another script becomes a method. RecordMap promotion
  // would be a separate signal — keep it untouched here.
  if (promoteMembers) {
    for (const name of promoteMembers) {
      const info = members.get(name);
      if (info && info.kind === 'property') members.set(name, { ...info, kind: 'method' });
    }
  }

  // Resolve method-aliases: `module.X = module.Y` ⇒ X inherits Y's fn.
  for (const [name, info] of members) {
    if (!info.aliasOf) continue;
    const target = members.get(info.aliasOf);
    if (!target) continue;
    if (target.kind === 'method' && target.fn) {
      members.set(name, { kind: 'method', fn: target.fn });
    }
  }

  if (members.size === 0) return { type: null, recordMapFields: [], members: new Map() };
  const recordMapFields: string[] = [];
  const publicKinds = new Map<string, 'method' | 'property' | 'recordMap'>();
  for (const [name, info] of members) {
    if (info.kind === 'recordMap') recordMapFields.push(name);
    publicKinds.set(name, info.kind === 'signal' ? 'property' : info.kind);
  }

  const memberSignatures: ts.TypeElement[] = [];
  for (const [name, info] of members) {
    if (!isValidIdentifier(name)) continue;
    const node = buildMemberSignature(name, info);
    if (node) memberSignatures.push(node);
  }
  if (memberSignatures.length === 0) return { type: null, recordMapFields, members: publicKinds };
  return { type: factory.createTypeLiteralNode(memberSignatures), recordMapFields, members: publicKinds };
}

function buildMemberSignature(name: string, info: MemberInfo): ts.TypeElement | null {
  if (info.kind === 'method') {
    return buildMethodSignature(name, info.fn);
  }
  if (info.kind === 'recordMap') {
    return factory.createPropertySignature(
      undefined,
      factory.createIdentifier(name),
      undefined,
      factory.createTypeReferenceNode('Record', [
        factory.createKeywordTypeNode(ts.SyntaxKind.StringKeyword),
        factory.createUnionTypeNode([
          factory.createTypeReferenceNode('defined', undefined),
          factory.createKeywordTypeNode(ts.SyntaxKind.UndefinedKeyword),
        ]),
      ]),
    );
  }
  if (info.kind === 'signal') {
    // @rbxts/types signature: `RBXScriptSignal<T extends Callback = Callback>`.
    // Explicit `defined` violates the bound, so we let the generic
    // default. Consumers get the full signal API surface (Connect,
    // Once, Wait, ConnectParallel) typed against the default callback.
    return factory.createPropertySignature(
      undefined,
      factory.createIdentifier(name),
      undefined,
      factory.createTypeReferenceNode('RBXScriptSignal', undefined),
    );
  }
  // property
  const fieldType = info.valueExpr ? staticTypeOfModuleInit(info.valueExpr) : null;
  return factory.createPropertySignature(
    undefined,
    factory.createIdentifier(name),
    undefined,
    fieldType ?? factory.createTypeReferenceNode('defined', undefined),
  );
}

function buildMethodSignature(name: string, fn: FunctionExpr | undefined): ts.TypeElement {
  // Default fallback: untyped rest-args + `defined` return — the shape
  // every method had before Session-D's polish.
  const defaultParam = factory.createParameterDeclaration(
    undefined,
    factory.createToken(ts.SyntaxKind.DotDotDotToken),
    'args',
    undefined,
    factory.createArrayTypeNode(factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword)),
  );
  const defaultReturn = factory.createTypeReferenceNode('defined', undefined);
  if (!fn) {
    return factory.createMethodSignature(
      undefined,
      factory.createIdentifier(name),
      undefined,
      undefined,
      [defaultParam],
      defaultReturn,
    );
  }
  // Session-D fix 1: run `inferParamPrimitives` on the method body to
  // surface real param types. Per-param: emit `name: <prim>` when
  // inferred, otherwise leave the param typed `unknown`. Trailing
  // `...args: unknown[]` keeps the signature variadic-callable so
  // surprise extra args (Roblox idiomatic for nilable arg packs) don't
  // become TS errors at consumer call sites.
  const primitives = inferParamPrimitives(fn);
  const realArgs = fn.self ? fn.args.slice(1) : fn.args;
  // Skip the rich signature when every param is unknown — the default
  // rest-args form is shorter and equally informative.
  let anyTyped = false;
  for (const a of realArgs) {
    if (primitives.has(a.name)) { anyTyped = true; break; }
  }
  if (!anyTyped) {
    return factory.createMethodSignature(
      undefined,
      factory.createIdentifier(name),
      undefined,
      undefined,
      [defaultParam],
      defaultReturn,
    );
  }
  const params: ts.ParameterDeclaration[] = realArgs.map((a) => {
    const prim = primitives.get(a.name);
    const paramType = prim ? primitiveTypeNode(prim) : factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);
    return factory.createParameterDeclaration(
      undefined,
      undefined,
      safeParamName(a.name),
      undefined,
      paramType,
      undefined,
    );
  });
  // Preserve rest-args at the end so consumers passing extra args don't
  // trip TS2554 on signatures synthesized from underspecified Luau
  // bodies. This is the "wrong types are worse than `defined`" guard
  // turned inside-out: under-narrowing is safe, over-narrowing is not.
  params.push(defaultParam);
  return factory.createMethodSignature(
    undefined,
    factory.createIdentifier(name),
    undefined,
    undefined,
    params,
    defaultReturn,
  );
}

function primitiveTypeNode(prim: Primitive): ts.TypeNode {
  switch (prim) {
    case 'number': return factory.createKeywordTypeNode(ts.SyntaxKind.NumberKeyword);
    case 'string': return factory.createKeywordTypeNode(ts.SyntaxKind.StringKeyword);
    case 'boolean': return factory.createKeywordTypeNode(ts.SyntaxKind.BooleanKeyword);
  }
}

function safeParamName(name: string): string {
  // Lua allows `_` as a throwaway name; TS rejects duplicated `_`
  // params, but a single `_` is fine. Identifier-shaped names pass
  // through verbatim; anything else collapses to `arg`.
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) return name;
  return 'arg';
}

/** Compute the synthesized TS type for a `module.X = <value>` or
 *  `local module = { X = <value> }` initializer. Returns null when the
 *  value's static type isn't inferable — caller falls back to `defined`.
 *
 *  Anti-landmine: this NEVER returns `unknown`. Either we know the
 *  type concretely or we return null and let the caller emit `defined`.
 *  Wrong types are worse than `defined`. */
function staticTypeOfModuleInit(expr: Expr): ts.TypeNode | null {
  switch (expr.type) {
    case 'ConstantNumber':
    case 'ConstantInteger':
      return factory.createKeywordTypeNode(ts.SyntaxKind.NumberKeyword);
    case 'ConstantString':
      return factory.createKeywordTypeNode(ts.SyntaxKind.StringKeyword);
    case 'ConstantBool':
      return factory.createKeywordTypeNode(ts.SyntaxKind.BooleanKeyword);
    case 'ConstantNil':
      return null;
    case 'Group':
      return staticTypeOfModuleInit((expr as { expr: Expr }).expr);
    case 'Call':
      return staticTypeOfDatatypeCtor(expr as Extract<Expr, { type: 'Call' }>);
    case 'Table':
      return staticTypeOfTableLiteral(expr as Extract<Expr, { type: 'Table' }>);
    default:
      return null;
  }
}

/** Recognize Roblox datatype constructors and emit the datatype name.
 *  Limited to the well-known, no-aliasing constructors so we never
 *  emit a wrong type. */
const DATATYPE_CTORS: Record<string, ReadonlySet<string>> = {
  Color3: new Set(['new', 'fromRGB', 'fromHSV', 'fromHex']),
  Vector3: new Set(['new', 'FromAxis', 'FromNormalId', 'fromBuffer', 'zero', 'one']),
  Vector2: new Set(['new']),
  CFrame: new Set(['new', 'fromMatrix', 'fromAxisAngle', 'fromOrientation', 'fromEulerAnglesXYZ', 'fromEulerAnglesYXZ', 'Angles', 'lookAt']),
  UDim: new Set(['new']),
  UDim2: new Set(['new', 'fromScale', 'fromOffset']),
  BrickColor: new Set(['new', 'palette', 'random', 'White', 'Gray', 'DarkGray', 'Black']),
  Region3: new Set(['new']),
  TweenInfo: new Set(['new']),
  NumberRange: new Set(['new']),
  NumberSequence: new Set(['new']),
  ColorSequence: new Set(['new']),
  Rect: new Set(['new']),
  Ray: new Set(['new']),
  RaycastParams: new Set(['new']),
  OverlapParams: new Set(['new']),
  Random: new Set(['new']),
  DateTime: new Set(['now', 'fromIsoDate', 'fromUnixTimestamp', 'fromUnixTimestampMillis', 'fromUniversalTime', 'fromLocalTime']),
  Faces: new Set(['new']),
  Axes: new Set(['new']),
  PathWaypoint: new Set(['new']),
  PhysicalProperties: new Set(['new']),
};

function staticTypeOfDatatypeCtor(call: Extract<Expr, { type: 'Call' }>): ts.TypeNode | null {
  const fn = call.func;
  if (fn.type !== 'IndexName') return null;
  if (fn.expr.type !== 'Global') return null;
  const ctorName = (fn.expr as { name: string }).name;
  const methods = DATATYPE_CTORS[ctorName];
  if (!methods || !methods.has(fn.index)) return null;
  return factory.createTypeReferenceNode(ctorName, undefined);
}

function staticTypeOfTableLiteral(table: Extract<Expr, { type: 'Table' }>): ts.TypeNode | null {
  if (table.items.length === 0) return null; // recordMap path handles empty tables

  // List-style table → array detection.
  if (table.items.every((it) => it.key === null && it.kind === 'List')) {
    // Pass 1: uniform-element-type. Every item resolves to the SAME
    // static type (primitive, datatype, nested array of same shape).
    let uniformType: ts.TypeNode | null = null;
    let uniformText: string | null = null;
    let uniform = true;
    for (const it of table.items) {
      const t = staticTypeOfModuleInit(it.value);
      if (!t) { uniform = false; break; }
      const text = typeNodeText(t);
      if (uniformText === null) { uniformText = text; uniformType = t; }
      else if (text !== uniformText) { uniform = false; break; }
    }
    if (uniform && uniformType) return factory.createArrayTypeNode(uniformType);

    // Pass 2: array-of-records. Every element is itself a table literal
    // with named string keys. All elements must share the same key set;
    // per-key types unify with `defined` fallback for per-key conflict.
    return arrayOfRecordsType(table.items);
  }

  // Dict-style table → literal object detection. Every item has a
  // ConstantString key (identifier-safe). Synthesizes a per-entry
  // literal object type `{k1: T1; k2: T2; ...}` where each Tn comes
  // from recursive `staticTypeOfModuleInit` on the entry's value.
  // Strict: any unresolved entry value ⇒ whole-table fallback to null
  // (caller emits `defined`). No union, no partial.
  if (table.items.every((it) => it.key !== null && it.key.type === 'ConstantString')) {
    return dictRecordType(table.items);
  }

  return null;
}

/** Synthesize a literal object type from a string-keyed table literal.
 *  Each item produces `keyName: <static-type-of-value>`. Returns null
 *  if any entry's value isn't statically typeable, mirroring the array
 *  branches' anti-landmine: never invent a type, defer to `defined`. */
function dictRecordType(
  items: ReadonlyArray<{ key: Expr | null; value: Expr; kind: 'List' | 'Record' | 'General' }>,
): ts.TypeNode | null {
  const memberSignatures: ts.TypeElement[] = [];
  for (const it of items) {
    if (!it.key || it.key.type !== 'ConstantString') return null;
    const keyName = (it.key as { value: string }).value;
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(keyName)) return null;
    const valueType = staticTypeOfModuleInit(it.value);
    if (!valueType) return null;
    memberSignatures.push(
      factory.createPropertySignature(
        undefined,
        factory.createIdentifier(keyName),
        undefined,
        valueType,
      ),
    );
  }
  if (memberSignatures.length === 0) return null;
  return factory.createTypeLiteralNode(memberSignatures);
}

/** Synthesize `Array<{...}>` from a list of element-table-literals,
 *  or null when the elements aren't uniform records. */
function arrayOfRecordsType(
  items: ReadonlyArray<{ key: Expr | null; value: Expr; kind: 'List' | 'Record' | 'General' }>,
): ts.TypeNode | null {
  // Every element must be a non-empty table literal with named keys.
  const elements: Array<Map<string, Expr>> = [];
  for (const it of items) {
    if (it.value.type !== 'Table') return null;
    const inner = it.value as { items: { key: Expr | null; value: Expr; kind: string }[] };
    if (inner.items.length === 0) return null;
    const keys = new Map<string, Expr>();
    for (const sub of inner.items) {
      // Reject array-style elements inside the record — they aren't
      // structurally part of the record shape we're synthesizing.
      if (!sub.key || sub.key.type !== 'ConstantString') return null;
      const keyName = (sub.key as { value: string }).value;
      // Skip non-identifier keys — `{"some-key" = ...}` patterns require
      // a string-literal property signature which `factory.createIdentifier`
      // can't represent without escaping. Conservative: give up.
      if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(keyName)) return null;
      keys.set(keyName, sub.value);
    }
    elements.push(keys);
  }
  if (elements.length === 0) return null;

  // All elements must agree on the key set exactly. Goal explicitly
  // forbids partial / optional fields here — heterogeneous shapes are
  // the case the prior audit deferred, and unioning them would invent
  // structure the source code doesn't guarantee.
  const firstKeys = elements[0]!;
  for (let i = 1; i < elements.length; i++) {
    const ei = elements[i]!;
    if (ei.size !== firstKeys.size) return null;
    for (const k of firstKeys.keys()) {
      if (!ei.has(k)) return null;
    }
  }

  // Per-key unification: every element's value for this key must yield
  // the same static type. Conflicts → `defined` for that key (NOT a
  // union — wrong types are worse than defined). Unresolved values →
  // `defined` for that key.
  const memberSignatures: ts.TypeElement[] = [];
  for (const key of firstKeys.keys()) {
    let keyType: ts.TypeNode | null = null;
    let keyText: string | null = null;
    let resolved = true;
    for (const elem of elements) {
      const t = staticTypeOfModuleInit(elem.get(key)!);
      if (!t) { resolved = false; break; }
      const text = typeNodeText(t);
      if (keyText === null) { keyText = text; keyType = t; }
      else if (text !== keyText) { resolved = false; break; }
    }
    const finalType = resolved && keyType
      ? keyType
      : factory.createTypeReferenceNode('defined', undefined);
    memberSignatures.push(
      factory.createPropertySignature(
        undefined,
        factory.createIdentifier(key),
        undefined,
        finalType,
      ),
    );
  }
  if (memberSignatures.length === 0) return null;
  return factory.createArrayTypeNode(factory.createTypeLiteralNode(memberSignatures));
}

function typeNodeText(t: ts.TypeNode): string {
  // Structural fingerprint. Two type nodes have the same fingerprint
  // iff their TS types are structurally identical. Used by the
  // array-of-uniform-elements detector to decide whether all elements
  // have the same type — a too-coarse fingerprint here causes
  // structurally-different record literals to falsely uniformize,
  // leaking heterogeneous shapes into a single Array<T> annotation.
  if (ts.isTypeReferenceNode(t)) {
    const head = ts.isIdentifier(t.typeName) ? t.typeName.text : '?';
    if (!t.typeArguments || t.typeArguments.length === 0) return `ref:${head}`;
    return `ref:${head}<${t.typeArguments.map(typeNodeText).join(',')}>`;
  }
  if (ts.isTypeLiteralNode(t)) {
    const members = t.members
      .map((m) => {
        if (ts.isPropertySignature(m) && m.name && m.type) {
          const name = ts.isIdentifier(m.name) ? m.name.text
            : ts.isStringLiteral(m.name) ? m.name.text
            : '?';
          return `${name}:${typeNodeText(m.type)}`;
        }
        return '?';
      })
      .sort();
    return `lit:{${members.join(';')}}`;
  }
  if (ts.isArrayTypeNode(t)) return `arr:${typeNodeText(t.elementType)}`;
  if (ts.isIntersectionTypeNode(t)) {
    return `&:[${t.types.map(typeNodeText).sort().join('|')}]`;
  }
  if (ts.isUnionTypeNode(t)) {
    return `|:[${t.types.map(typeNodeText).sort().join('|')}]`;
  }
  switch (t.kind) {
    case ts.SyntaxKind.NumberKeyword: return 'number';
    case ts.SyntaxKind.StringKeyword: return 'string';
    case ts.SyntaxKind.BooleanKeyword: return 'boolean';
    case ts.SyntaxKind.UnknownKeyword: return 'unknown';
    case ts.SyntaxKind.UndefinedKeyword: return 'undefined';
    default: return `kind:${t.kind}`;
  }
}

/** Pre-pass: find every `local <name> = Instance.new("BindableEvent")`
 *  (or RemoteEvent / Signal / signal.new()-style ctor) in the module
 *  body so `module.X = <name>.Event` can be classified as a signal. */
function collectSignalLocals(body: Stat): Set<string> {
  const out = new Set<string>();
  const visit = (s: Stat | null | undefined): void => {
    if (!s) return;
    switch (s.type) {
      case 'Block': {
        const b = s as { body: Stat[] };
        for (const c of b.body) visit(c);
        return;
      }
      case 'Local': {
        const ls = s as { vars: { name: string }[]; values: Expr[] };
        for (let i = 0; i < ls.vars.length; i++) {
          const init = ls.values[i];
          if (init && isSignalCtor(init)) out.add(ls.vars[i]!.name);
        }
        return;
      }
      case 'If': {
        const i = s as { thenBody: Stat; elseBody: Stat | null };
        visit(i.thenBody);
        visit(i.elseBody);
        return;
      }
      case 'While':
      case 'Repeat':
      case 'For':
      case 'ForIn':
        visit((s as { body: Stat }).body);
        return;
      default:
        return;
    }
  };
  visit(body);
  return out;
}

const SIGNAL_INSTANCE_CLASSES = new Set(['BindableEvent', 'RemoteEvent', 'BindableFunction']);

function isSignalCtor(expr: Expr): boolean {
  if (expr.type !== 'Call') return false;
  const fn = expr.func;
  // `Instance.new("BindableEvent")` / `Instance.new("RemoteEvent")`.
  if (
    fn.type === 'IndexName'
    && fn.expr.type === 'Global'
    && (fn.expr as { name: string }).name === 'Instance'
    && fn.index === 'new'
    && expr.args[0]?.type === 'ConstantString'
  ) {
    const cls = (expr.args[0] as { value: string }).value;
    return SIGNAL_INSTANCE_CLASSES.has(cls);
  }
  return false;
}

/** Match `<localName>.Event` (BindableEvent's signal access). */
function eventAccessLocal(expr: Expr, signalLocals: ReadonlySet<string>): string | null {
  if (expr.type !== 'IndexName') return null;
  if (expr.index !== 'Event' && expr.index !== 'OnInvoke') return null;
  if (expr.expr.type !== 'Local') return null;
  const name = (expr.expr as { name: string }).name;
  return signalLocals.has(name) ? name : null;
}

/** Walk `body` and record member assignments/method declarations on
 *  `targetName`. */
function collectMemberAssignments(
  body: Stat,
  targetName: string,
  out: Map<string, MemberInfo>,
  signalLocals: ReadonlySet<string>,
): void {
  const visit = (s: Stat | null | undefined): void => {
    if (!s) return;
    switch (s.type) {
      case 'Block': {
        const b = s as { body: Stat[] };
        for (const c of b.body) visit(c);
        return;
      }
      case 'If': {
        const i = s as { thenBody: Stat; elseBody: Stat | null };
        visit(i.thenBody);
        visit(i.elseBody);
        return;
      }
      case 'While':
      case 'Repeat': {
        visit((s as { body: Stat }).body);
        return;
      }
      case 'For':
      case 'ForIn': {
        visit((s as { body: Stat }).body);
        return;
      }
      case 'Function': {
        const fs = s as { name: Expr; func: FunctionExpr };
        recordMemberDecl(fs.name, targetName, { kind: 'method', fn: fs.func }, out);
        return;
      }
      case 'Assign': {
        const a = s as { vars: Expr[]; values: Expr[] };
        for (let i = 0; i < a.vars.length; i++) {
          const v = a.vars[i]!;
          const val = a.values[i];
          let info: MemberInfo = val
            ? { kind: 'property', valueExpr: val }
            : { kind: 'property' };
          if (val && val.type === 'Function') {
            info = { kind: 'method', fn: val as FunctionExpr };
          } else if (val && val.type === 'Table' && (val as { items: unknown[] }).items.length === 0) {
            info = { kind: 'recordMap' };
          } else if (val) {
            // Signal alias: `module.X = bindable.Event`.
            if (eventAccessLocal(val, signalLocals)) {
              info = { kind: 'signal' };
            }
            // Method alias: `module.X = module.Y` (or `local Y` that
            // backs a same-module function). Resolved late.
            else if (val.type === 'IndexName'
              && val.expr.type === 'Local'
              && (val.expr as { name: string }).name === targetName) {
              info = { kind: 'method', aliasOf: val.index };
            }
            else if (val.type === 'Local') {
              // `module.X = someLocal` — could be a function alias if
              // someLocal is itself a local function. Leave as property
              // with valueExpr captured; resolution would require a
              // local-function index and isn't critical for the corpus.
              info = { kind: 'property', valueExpr: val };
            }
          }
          recordMemberDecl(v, targetName, info, out);
        }
        return;
      }
      // local M = setmetatable({}, {__index = M}) and other patterns
      // are not detected — only the trailing return-name's same-scope
      // mutations are scanned.
      default:
        return;
    }
  };
  visit(body);
}

function collectInitializerFields(
  body: Stat,
  targetName: string,
  out: Map<string, MemberInfo>,
  signalLocals: ReadonlySet<string>,
): void {
  // Find `local <targetName> = { ... }` at any depth and harvest the
  // table's keyed fields. Only inspect the top-level keys; nested
  // structures stay as `defined`.
  const visit = (s: Stat | null | undefined): void => {
    if (!s) return;
    switch (s.type) {
      case 'Block': {
        const b = s as { body: Stat[] };
        for (const c of b.body) visit(c);
        return;
      }
      case 'If': {
        const i = s as { thenBody: Stat; elseBody: Stat | null };
        visit(i.thenBody);
        visit(i.elseBody);
        return;
      }
      case 'Local': {
        const l = s as { vars: { name: string }[]; values: Expr[] };
        for (let i = 0; i < l.vars.length; i++) {
          if (l.vars[i]!.name !== targetName) continue;
          const init = l.values[i];
          if (!init || init.type !== 'Table') continue;
          const t = init as { items: { key: Expr | null; value: Expr }[] };
          for (const item of t.items) {
            const key = item.key;
            if (!key || key.type !== 'ConstantString') continue;
            const name = (key as { value: string }).value;
            let info: MemberInfo;
            if (item.value && item.value.type === 'Function') {
              info = { kind: 'method', fn: item.value as FunctionExpr };
            } else if (item.value && eventAccessLocal(item.value, signalLocals)) {
              info = { kind: 'signal' };
            } else if (item.value && item.value.type === 'Table'
              && (item.value as { items: unknown[] }).items.length === 0) {
              // Initializer-table empty sub-table — treat as recordMap
              // only if it's clearly a string-keyed map. Skipping for
              // now to avoid regressing array-init cases.
              info = { kind: 'property', valueExpr: item.value };
            } else {
              info = { kind: 'property', valueExpr: item.value };
            }
            const existing = out.get(name);
            if (info.kind === 'method' || !existing) out.set(name, info);
          }
        }
        return;
      }
      default:
        return;
    }
  };
  visit(body);
}

function recordMemberDecl(
  lvalue: Expr,
  targetName: string,
  info: MemberInfo,
  out: Map<string, MemberInfo>,
): void {
  // `function targetName.X(...)` and `targetName.X = ...`.
  if (lvalue.type !== 'IndexName') return;
  if (lvalue.expr.type === 'Local' && lvalue.expr.name === targetName) {
    const existing = out.get(lvalue.index);
    // Priority: method > signal > recordMap > property. Method always
    // wins; signal promotes a property; recordMap promotes a property;
    // property doesn't overwrite either.
    if (info.kind === 'method' || !existing) out.set(lvalue.index, info);
    else if (info.kind === 'signal' && existing.kind === 'property') out.set(lvalue.index, info);
    else if (info.kind === 'recordMap' && existing.kind === 'property') out.set(lvalue.index, info);
  }
}

function isValidIdentifier(name: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name);
}

/** Resolve a `require(X)` argument to a corpus path string (or null if
 *  unresolvable). `currentScriptPath` is the path of the requiring
 *  script. Handles common Roblox path patterns. */
export function resolveRequirePath(arg: Expr, currentScriptPath: string): string | null {
  const segs = collectChainSegments(arg);
  if (!segs) return null;
  const { rootKind, rootName, members } = segs;
  // Build candidate paths.
  if (rootKind === 'script') {
    // `script.Parent.Foo.Bar` → walk up from currentScriptPath.
    // currentScriptPath is `/Workspace/Foo/Bar` (the script itself).
    // `script.Parent` → parent dir of currentScriptPath.
    // `script.Parent.X` → parent/X.
    let cur = currentScriptPath;
    const remaining: string[] = [];
    for (const m of members) {
      if (m === 'Parent') {
        const idx = cur.lastIndexOf('/');
        if (idx <= 0) return null;
        cur = cur.slice(0, idx);
      } else {
        remaining.push(m);
      }
    }
    if (remaining.length === 0) return null;
    return `${cur}/${remaining.join('/')}`;
  }
  if (rootKind === 'service') {
    // `ReplicatedStorage.Foo.Bar` → `/<service>/Foo/Bar`.
    return `/${rootName}/${members.join('/')}`;
  }
  if (rootKind === 'game') {
    // `game.<service>.Foo.Bar` → `/<service>/Foo/Bar`.
    if (members.length === 0) return null;
    const [svc, ...rest] = members;
    return `/${svc}/${rest.join('/')}`;
  }
  return null;
}

function collectChainSegments(expr: Expr): {
  rootKind: 'script' | 'service' | 'game';
  rootName: string;
  members: string[];
} | null {
  const SERVICE_NAMES = new Set([
    'ReplicatedStorage', 'ServerStorage', 'ServerScriptService',
    'StarterGui', 'StarterPack', 'StarterPlayer', 'Lighting',
    'ReplicatedFirst', 'Workspace',
  ]);
  const members: string[] = [];
  let cur: Expr = expr;
  // Unwrap `:WaitForChild("X")` / `:FindFirstChild("X")` calls — the
  // require path treats them as a navigation step to `X`. Same for
  // `game:GetService("X")` which the service-rewrite pass should have
  // already collapsed, but handle it defensively.
  while (true) {
    if (cur.type === 'IndexName' && cur.op === '.') {
      members.unshift(cur.index);
      cur = cur.expr;
      continue;
    }
    if (
      cur.type === 'Call'
      && cur.self
      && cur.func.type === 'IndexName'
      && (cur.func.index === 'WaitForChild' || cur.func.index === 'FindFirstChild')
      && cur.args.length >= 1
      && cur.args[0]!.type === 'ConstantString'
    ) {
      members.unshift((cur.args[0] as { value: string }).value);
      cur = cur.func.expr;
      continue;
    }
    if (
      cur.type === 'Call'
      && cur.self
      && cur.func.type === 'IndexName'
      && cur.func.index === 'GetService'
      && cur.func.expr.type === 'Global'
      && cur.func.expr.name === 'game'
      && cur.args.length >= 1
      && cur.args[0]!.type === 'ConstantString'
    ) {
      const svc = (cur.args[0] as { value: string }).value;
      if (SERVICE_NAMES.has(svc)) {
        return { rootKind: 'service', rootName: svc, members };
      }
      return null;
    }
    break;
  }
  if (cur.type === 'Global') {
    const n = cur.name;
    if (n === 'script') return { rootKind: 'script', rootName: n, members };
    if (n === 'game') return { rootKind: 'game', rootName: n, members };
    if (SERVICE_NAMES.has(n)) return { rootKind: 'service', rootName: n, members };
  }
  return null;
}

/** Strip the leaf script name, returning the directory path. Used to
 *  walk `script.Parent` from a script's full corpus path. */
export function scriptParentDir(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx > 0 ? path.slice(0, idx) : path;
}

/** Find the trailing `return X` statement and return X's name if it's a
 *  bare Local. Otherwise null. */
function findTrailingReturnName(body: BlockStat | Stat): string | null {
  const block = body.type === 'Block' ? body : null;
  if (!block) return null;
  for (let i = block.body.length - 1; i >= 0; i--) {
    const s = block.body[i]!;
    if (s.type === 'Return') {
      const r = s as { values: Expr[] };
      if (r.values.length !== 1) return null;
      const v = r.values[0]!;
      if (v.type === 'Local') return v.name;
      return null;
    }
  }
  return null;
}
