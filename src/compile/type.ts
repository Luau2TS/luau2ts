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

export function compileType(t: TypeNode | null | undefined): ts.TypeNode {
  if (!t) return factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);
  switch (t.type) {
    case 'TypeReference':
      return compileTypeReference(t);
    case 'TypeOptional':
      // Bare `?` — only appears as part of `T?` desugared into `T | nil` by
      // the parser, so this case usually rides inside a TypeUnion. Emit `null`.
      return factory.createLiteralTypeNode(factory.createNull());
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
  if (t.name === 'nil') return factory.createLiteralTypeNode(factory.createNull());

  const kw = PRIMITIVE_TYPE_NAMES[t.name];
  if (kw !== undefined && !t.prefix && t.parameters.length === 0) {
    return factory.createKeywordTypeNode(kw);
  }

  const name = t.prefix
    ? factory.createQualifiedName(factory.createIdentifier(t.prefix), t.name)
    : factory.createIdentifier(t.name);

  const typeArgs = t.parameters
    .map((p) => {
      if (!p) return undefined;
      if (p.kind === 'type') return compileType(p.value);
      // Type-pack parameters (rare in our scope) — fall through to unknown.
      return factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);
    })
    .filter((x): x is ts.TypeNode => x !== undefined);

  return factory.createTypeReferenceNode(name, typeArgs.length > 0 ? typeArgs : undefined);
}

function compileTypeTable(t: TypeTableNode): ts.TypeNode {
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
    params.push(
      factory.createParameterDeclaration(
        undefined,
        undefined,
        factory.createIdentifier(argName?.name ?? `arg${i}`),
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
