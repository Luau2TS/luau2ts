import ts from 'typescript';
import type {
  TypeFunctionNode,
  TypeNode,
  TypePack,
  TypeReferenceNode,
  TypeTableNode,
} from '../parser/index.js';

const { factory } = ts;

const PRIMITIVE_TYPE_NAMES: Record<string, ts.KeywordTypeSyntaxKind> = {
  number: ts.SyntaxKind.NumberKeyword,
  string: ts.SyntaxKind.StringKeyword,
  boolean: ts.SyntaxKind.BooleanKeyword,
  any: ts.SyntaxKind.AnyKeyword,
  unknown: ts.SyntaxKind.UnknownKeyword,
  never: ts.SyntaxKind.NeverKeyword,
  void: ts.SyntaxKind.VoidKeyword,
};

/** Map of type-alias name → generic arity, set by the compiler before
 *  emitting types so `Foo<a, b, c>` for a Luau alias declared as
 *  `type Foo<T...>` can be re-grouped into `Foo<[a, b, c]>` (a tuple
 *  filling the pack). Module-scope rather than ctx-parameter so the
 *  twenty-odd compileType call sites don't all need a context arg.
 *  Set by `setAliasArities` on each compile() run. */
let aliasArities: Map<string, { generics: number; hasPack: boolean }> = new Map();

export function setAliasArities(map: Map<string, { generics: number; hasPack: boolean }>): void {
  aliasArities = map;
}

/** Module-scoped mode flag: set by compile() before every run. Lets the
 *  type compiler emit `undefined` for `nil` in rbxts mode (where roblox-ts
 *  rejects `null` outright) while keeping the original `null` mapping in
 *  native mode (where every nilable annotation `T?` is `T | null`). */
let currentCompatMode: 'native' | 'rbxts' = 'native';

export function setTypeCompatMode(mode: 'native' | 'rbxts'): void {
  currentCompatMode = mode;
}

function nilTypeNode(): ts.TypeNode {
  return currentCompatMode === 'rbxts'
    ? factory.createKeywordTypeNode(ts.SyntaxKind.UndefinedKeyword)
    : factory.createLiteralTypeNode(factory.createNull());
}

export function compileType(t: TypeNode | null | undefined): ts.TypeNode {
  if (!t) return factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);
  switch (t.type) {
    case 'TypeReference':
      return compileTypeReference(t);
    case 'TypeOptional':
      // Bare `?` — only appears as part of `T?` desugared into `T | nil` by
      // the parser, so this case usually rides inside a TypeUnion.
      return nilTypeNode();
    case 'TypeUnion':
      return factory.createUnionTypeNode(t.types.map(compileType));
    case 'TypeIntersection':
      return factory.createIntersectionTypeNode(t.types.map(compileType));
    case 'TypeTypeof':
      // `typeof x` — emit a typeof query node referencing the expression's
      // identifier when possible.
      if (t.expr.type === 'Local' || t.expr.type === 'Global') {
        return factory.createTypeQueryNode(factory.createIdentifier(t.expr.name));
      }
      // `typeof(setmetatable(body :: BodyType, meta :: MetaType))` — Luau's
      // canonical "instance type" idiom. TS has no native equivalent, but we
      // can synthesize one by intersecting BodyType (the per-instance fields
      // like `_handlers`, `_nextId`) with MetaType (which carries the method
      // table via `__index`). Without this, every `type Foo = typeof(...)`
      // alias collapses to `unknown` and every `self.field` access cascades.
      if (
        t.expr.type === 'Call'
        && t.expr.func.type === 'Global'
        && t.expr.func.name === 'setmetatable'
        && t.expr.args.length >= 1
      ) {
        const bodyArg = t.expr.args[0]!;
        const metaArg = t.expr.args[1];
        const bodyTy =
          bodyArg.type === 'TypeAssertion'
            ? compileType(bodyArg.annotation)
            : null;
        const metaTy =
          metaArg && metaArg.type === 'TypeAssertion'
            ? compileType(metaArg.annotation)
            : null;
        if (bodyTy && metaTy) return factory.createIntersectionTypeNode([bodyTy, metaTy]);
        if (bodyTy) return bodyTy;
        if (metaTy) return metaTy;
      }
      return factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);
    case 'TypeSingletonBool':
      return factory.createLiteralTypeNode(t.value ? factory.createTrue() : factory.createFalse());
    case 'TypeSingletonString':
      return factory.createLiteralTypeNode(factory.createStringLiteral(t.value));
    case 'TypeGroup':
      return factory.createParenthesizedType(compileType(t.groupType));
    case 'TypeTable':
      return compileTypeTable(t);
    case 'TypeFunction':
      return compileTypeFunction(t);
    case 'TypeError':
    case 'UnknownType':
    default:
      return factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);
  }
}

function compileTypeReference(t: TypeReferenceNode): ts.TypeNode {
  if (t.name === 'nil') return nilTypeNode();

  const kw = PRIMITIVE_TYPE_NAMES[t.name];
  if (kw !== undefined && !t.prefix && t.parameters.length === 0) {
    if (currentCompatMode === 'rbxts' && t.name === 'any') {
      return factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);
    }
    return factory.createKeywordTypeNode(kw);
  }

  const name = t.prefix
    ? factory.createQualifiedName(factory.createIdentifier(t.prefix), t.name)
    : factory.createIdentifier(t.name);

  // Convert each Luau type arg to a TS type node. Type-pack args (rare in
  // user code, but common for `T...` references) collapse here too.
  const argNodes = t.parameters.map((p) => {
    if (!p) return undefined;
    if (p.kind === 'type') return compileType(p.value);
    const pack = p.value;
    if (pack.type === 'TypePackGeneric') {
      return factory.createTypeReferenceNode(pack.genericName);
    }
    if (pack.type === 'TypePackVariadic') {
      return factory.createArrayTypeNode(compileType(pack.variadicType));
    }
    if (pack.type === 'TypePackExplicit') {
      const ts2 = pack.typeList.types;
      if (ts2.length === 0) {
        return factory.createArrayTypeNode(factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword));
      }
      return factory.createTupleTypeNode(ts2.map(compileType));
    }
    return factory.createArrayTypeNode(factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword));
  }).filter((x): x is ts.TypeNode => x !== undefined);

  // When the target alias was declared with a type-pack (`type Foo<T...>`),
  // the TS-side alias takes a single tuple-typed generic. Luau call sites
  // often write `Foo<a, b, c>` (three positional `kind: 'type'` args filling
  // the pack); emit those as `Foo<[a, b, c]>` so the count matches the
  // alias arity. If the source itself supplies a pack arg (`Foo<T...>` or
  // `Foo<(a, b)>`), it's already in the right shape — don't re-wrap it.
  const arity = aliasArities.get(t.name);
  let typeArgs = argNodes;
  const onlyPositionalTypes = t.parameters.every((p) => p && p.kind === 'type');
  if (arity && arity.hasPack && onlyPositionalTypes) {
    const head = argNodes.slice(0, arity.generics);
    const tailNodes = argNodes.slice(arity.generics);
    const packArg = tailNodes.length === 0
      ? factory.createArrayTypeNode(factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword))
      : factory.createTupleTypeNode(tailNodes);
    typeArgs = [...head, packArg];
  }

  return factory.createTypeReferenceNode(name, typeArgs.length > 0 ? typeArgs : undefined);
}

function compileTypeTable(t: TypeTableNode): ts.TypeNode {
  // Luau's `{T}` is the conventional array shorthand for `{[number]: T}`.
  // Emit it as a TS array `T[]` so `push`/`pop`/`length` work; falling
  // through to a numeric-keyed index signature is technically correct but
  // strips array-ness from downstream usage.
  if (
    t.props.length === 0
    && t.indexer
    && t.indexer.indexType.type === 'TypeReference'
    && t.indexer.indexType.name === 'number'
  ) {
    return factory.createArrayTypeNode(compileType(t.indexer.resultType));
  }
  const members: ts.TypeElement[] = [];
  for (const prop of t.props) {
    members.push(
      factory.createPropertySignature(
        undefined,
        factory.createIdentifier(prop.name),
        undefined,
        compileType(prop.propType),
      ),
    );
  }
  if (t.indexer) {
    // TS index signatures allow only `string`, `number`, `symbol`, or
    // template-literal types as the key — a Luau index like `[LogLevel]`
    // where `LogLevel` is `"trace" | "debug" | ...` produces a TS error
    // (1337) if emitted as `[key: LogLevel]: V`. Detect the
    // non-primitive case and emit a mapped type `{ [K in LogLevel]: V }`
    // instead. Property signatures (if any) get merged via intersection.
    const idx = t.indexer.indexType;
    const idxName = idx.type === 'TypeReference' ? idx.name : null;
    // TS allows only string/number/symbol as plain index-signature keys.
    // Anything else (literal unions, named aliases, etc.) goes through a
    // mapped type instead.
    const isPlainIndex =
      idxName !== null
      && (idxName === 'string' || idxName === 'number' || idxName === 'symbol');
    if (!isPlainIndex) {
      const mapped = factory.createMappedTypeNode(
        undefined,
        factory.createTypeParameterDeclaration(
          undefined,
          factory.createIdentifier('K'),
          compileType(t.indexer.indexType),
          undefined,
        ),
        undefined,
        undefined,
        compileType(t.indexer.resultType),
        undefined,
      );
      if (members.length === 0) return mapped;
      return factory.createIntersectionTypeNode([
        factory.createTypeLiteralNode(members),
        mapped,
      ]);
    }
    members.push(
      factory.createIndexSignature(
        undefined,
        [
          factory.createParameterDeclaration(
            undefined,
            undefined,
            factory.createIdentifier('key'),
            undefined,
            compileType(t.indexer.indexType),
          ),
        ],
        compileType(t.indexer.resultType),
      ),
    );
  }
  return factory.createTypeLiteralNode(members);
}

function compileTypeFunction(t: TypeFunctionNode): ts.TypeNode {
  const params: ts.ParameterDeclaration[] = [];
  for (let i = 0; i < t.argTypes.types.length; i += 1) {
    const argType = t.argTypes.types[i]!;
    const argName = t.argNames[i];
    // Luau impl-table method shape: `addSink: (self: StateMachine, …) -> ()`.
    // TS-side the same signature is `(this: StateMachine, …) => void`, which
    // matches the implementation we emit (`function (this: any, …) {}`).
    // Keep `self` as a parameter name only when it isn't the conventional
    // first-arg-of-a-method-impl — that pattern would otherwise force an
    // arity mismatch between the impl type and the actual function.
    const isImplicitSelf = i === 0 && argName?.name === 'self';
    params.push(
      factory.createParameterDeclaration(
        undefined,
        undefined,
        factory.createIdentifier(isImplicitSelf ? 'this' : argName?.name ?? `arg${i}`),
        undefined,
        compileType(argType),
      ),
    );
  }
  if (t.argTypes.tailType) {
    const tail = t.argTypes.tailType;
    const restType =
      tail.type === 'TypePackVariadic'
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
  const ret = compileTypePack(t.returnTypes);
  return factory.createFunctionTypeNode(undefined, params, ret);
}

/** Compile a type-pack into a single TS type usable as a return type. */
export function compileTypePack(pack: TypePack | null): ts.TypeNode {
  if (!pack) return factory.createKeywordTypeNode(ts.SyntaxKind.VoidKeyword);
  switch (pack.type) {
    case 'TypePackExplicit': {
      const types = pack.typeList.types;
      if (types.length === 0 && !pack.typeList.tailType) {
        return factory.createKeywordTypeNode(ts.SyntaxKind.VoidKeyword);
      }
      if (types.length === 1 && !pack.typeList.tailType) return compileType(types[0]!);
      return factory.createTupleTypeNode(types.map(compileType));
    }
    case 'TypePackVariadic':
      return factory.createArrayTypeNode(compileType(pack.variadicType));
    case 'TypePackGeneric':
      return factory.createTypeReferenceNode(pack.genericName);
    default:
      return factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);
  }
}
