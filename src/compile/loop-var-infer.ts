// Per-script loop-variable shape inference. For each `for ... in ...`
// statement, walks the body collecting observed property/method access
// on each loop variable, and synthesizes a TS type literal so the
// destructured binding typechecks downstream member access without
// routing through `Record<string, unknown>`.
//
// Mirrors script-parent-infer.ts's `defined`/`Instance` fallback rules:
// synthesized types never contain bare `unknown` as a field type. Field
// types fall back to `defined`; intermediate "this is an Instance child"
// nodes intersect with `Instance` so navigation/event methods still
// resolve through @rbxts/types.

import ts from 'typescript';
import type { BlockStat, ForInStat, Stat } from '../parser/index.js';
import type { ClassOracle } from './oracle/index.js';
import { collectShapes, type Shape } from './shape-infer.js';

const { factory } = ts;

/** Roblox property names whose datatype is stable across class families.
 *  Copied (not imported) from script-parent-infer so the two passes
 *  evolve independently — loop vars are typically BaseParts whereas
 *  script.Parent chains span a wider class set. */
const ROBLOX_PROPERTY_TYPES: Record<string, string> = {
  CFrame: 'CFrame',
  Position: 'Vector3',
  Size: 'Vector3',
  Orientation: 'Vector3',
  PivotOffset: 'CFrame',
  Color: 'Color3',
  BrickColor: 'BrickColor',
  Material: 'Enum.Material',
  Transparency: 'number',
  Reflectance: 'number',
  Anchored: 'boolean',
  CanCollide: 'boolean',
  CanTouch: 'boolean',
  CanQuery: 'boolean',
  Locked: 'boolean',
  ClassName: 'string',
  Name: 'string',
  Visible: 'boolean',
  Active: 'boolean',
  Text: 'string',
  TextScaled: 'boolean',
  TextWrapped: 'boolean',
  BackgroundTransparency: 'number',
  BackgroundColor3: 'Color3',
  TextColor3: 'Color3',
  AnchorPoint: 'Vector2',
  Velocity: 'Vector3',
};

export interface LoopVarTypes {
  /** Map keyed by ForInStat object identity. The inner map binds each
   *  declared loop-var name to its synthesized TS type node. Vars with
   *  no observed access (e.g., an unused index in `for _, v in ...`)
   *  are absent from the inner map. */
  byStat: Map<ForInStat, Map<string, ts.TypeNode>>;
  /** Type alias declarations to emit at the top of the compiled module,
   *  named `_$LoopShape_<N>`. Each declared loop var that gets a non-
   *  trivial shape references one of these so the `for` declaration
   *  stays compact. */
  declarations: ts.Statement[];
}

const EMPTY: LoopVarTypes = { byStat: new Map(), declarations: [] };

/** Walk `body` to find every ForInStat, collect observed shapes for its
 *  loop vars within that statement's body, and synthesize a TS type for
 *  each. Returns mappings + the declarations to prepend. */
export function inferLoopVarShapes(body: Stat, oracle: ClassOracle): LoopVarTypes {
  const stats: ForInStat[] = [];
  collectForInStats(body, stats);
  if (stats.length === 0) return EMPTY;

  const byStat = new Map<ForInStat, Map<string, ts.TypeNode>>();
  const declarations: ts.Statement[] = [];
  let aliasCounter = 0;

  for (const stat of stats) {
    const varNames = stat.vars.map((v) => v.name).filter((n) => n !== '_');
    if (varNames.length === 0) continue;
    const trackSet = new Set(varNames);
    const shapes = collectShapes(stat.body, trackSet);
    const perVar = new Map<string, ts.TypeNode>();
    for (const name of varNames) {
      const shape = shapes.get(name);
      if (!shape || shape.empty) continue;
      const literal = buildLoopVarTypeLiteral(shape, oracle, 0);
      if (!literal) continue;
      // Intersect with Instance — for-in loop variables in Roblox code
      // iterate over Instance children almost universally
      // (`pairs(model:GetChildren())`, `ipairs(folder:GetChildren())`).
      // The intersection preserves navigation methods (`FindFirstChild`,
      // events) without forcing a specific subclass.
      const intersection = factory.createIntersectionTypeNode([
        literal,
        factory.createTypeReferenceNode('Instance', undefined),
      ]);
      const aliasName = `_$LoopShape_${aliasCounter++}`;
      declarations.push(
        factory.createTypeAliasDeclaration(undefined, aliasName, undefined, intersection),
      );
      perVar.set(name, factory.createTypeReferenceNode(aliasName, undefined));
    }
    if (perVar.size > 0) byStat.set(stat, perVar);
  }

  if (byStat.size === 0) return EMPTY;
  return { byStat, declarations };
}

function collectForInStats(node: Stat | null | undefined, out: ForInStat[]): void {
  if (!node) return;
  if (node.type === 'ForIn') out.push(node as ForInStat);
  switch (node.type) {
    case 'Block': {
      const b = node as BlockStat;
      for (const c of b.body) collectForInStats(c, out);
      return;
    }
    case 'If': {
      const i = node as { thenBody: Stat; elseBody: Stat | null };
      collectForInStats(i.thenBody, out);
      collectForInStats(i.elseBody, out);
      return;
    }
    case 'While':
    case 'Repeat':
    case 'For':
    case 'ForIn':
      collectForInStats((node as { body: Stat }).body, out);
      return;
    case 'LocalFunction':
    case 'Function': {
      const fs = node as { func: { body: BlockStat } };
      collectForInStats(fs.func.body, out);
      return;
    }
    default:
      return;
  }
}

/** Synthesis with `defined`/`Instance` fallbacks — never produces a
 *  bare `unknown` field type. Mirrors script-parent-infer.ts's
 *  buildShapeLiteral semantics. */
function buildLoopVarTypeLiteral(
  shape: Shape,
  oracle: ClassOracle,
  depth: number,
): ts.TypeNode | null {
  if (shape.empty || depth > 6) return null;
  const members: ts.TypeElement[] = [];

  for (const [name, child] of shape.props) {
    if (name === '__call__') continue;
    const methodMeta = shape.methods.get(name);
    if (methodMeta) {
      // Drop members the base Instance class already declares — the
      // intersection picks up the real typed signature without our
      // generic shadow blocking it.
      if (oracle.methodReturnType('Instance', name, 0)) continue;
      members.push(
        factory.createMethodSignature(
          undefined,
          propertyName(name),
          undefined,
          undefined,
          [factory.createParameterDeclaration(
            undefined,
            factory.createToken(ts.SyntaxKind.DotDotDotToken),
            'args',
            undefined,
            factory.createArrayTypeNode(factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword)),
          )],
          factory.createTypeReferenceNode('defined', undefined),
        ),
      );
      continue;
    }
    const oracleClass = oracle.childNameClass(name);
    const robloxPropType = ROBLOX_PROPERTY_TYPES[name];
    const nestedLiteral = buildLoopVarTypeLiteral(child, oracle, depth + 1);
    let childType: ts.TypeNode;
    if (oracleClass && (!nestedLiteral || child.empty)) {
      childType = factory.createTypeReferenceNode(oracleClass, undefined);
    } else if (child.assigned && !nestedLiteral) {
      childType = factory.createTypeReferenceNode('defined', undefined);
    } else if (robloxPropType) {
      childType = factory.createTypeReferenceNode(robloxPropType, undefined);
    } else if (nestedLiteral) {
      childType = factory.createIntersectionTypeNode([
        nestedLiteral,
        factory.createTypeReferenceNode('Instance', undefined),
      ]);
    } else if (oracleClass) {
      childType = factory.createTypeReferenceNode(oracleClass, undefined);
    } else if (child.assigned) {
      childType = factory.createTypeReferenceNode('defined', undefined);
    } else {
      childType = factory.createTypeReferenceNode('defined', undefined);
    }
    members.push(
      factory.createPropertySignature(
        undefined,
        propertyName(name),
        undefined,
        childType,
      ),
    );
  }

  if (members.length === 0) return null;
  return factory.createTypeLiteralNode(members);
}

function propertyName(name: string): ts.PropertyName {
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) {
    return factory.createIdentifier(name);
  }
  return factory.createStringLiteral(name);
}
