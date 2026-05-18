// Per-script class-shape inference for dynamic roots (`script`, `workspace`).
// Pass 1 of the Phase 3-finish architecture. Walks the script's IR, collects
// observed member accesses rooted at `script`/`workspace`/known aliases,
// synthesizes a structural type per root, and emits a type alias the
// emitter can cast through — replacing the `_LuauChild` fallback for these
// chains.
//
// Conservative defaults (per the goal's "synthesized types never contain
// `unknown`" rule): method returns and fallback field types use `defined`,
// not `unknown`. The intersection with `Instance` / `LuaSourceContainer`
// preserves the underlying Roblox-API surface so navigation/event methods
// still typecheck.

import ts from 'typescript';
import type { Stat, Expr } from '../parser/index.js';
import type { ClassOracle } from './oracle/index.js';
import { collectShapes, type Shape } from './shape-infer.js';

const { factory } = ts;

/** Roots we run the synthesis on. Each maps to its TS base class so
 *  intersection preserves the Roblox-API methods (FindFirstChild, etc).
 *  Services with statically-named children (ReplicatedStorage etc.) benefit
 *  the same way: their `.X.Y.Z` chains get structural typing. */
const DYNAMIC_ROOTS: Record<string, string> = {
  script: 'LuaSourceContainer',
  workspace: 'Workspace',
  ReplicatedStorage: 'ReplicatedStorage',
  ServerStorage: 'ServerStorage',
  ServerScriptService: 'ServerScriptService',
  StarterGui: 'StarterGui',
  Lighting: 'Lighting',
  ReplicatedFirst: 'ReplicatedFirst',
  StarterPlayer: 'StarterPlayer',
  StarterPack: 'StarterPack',
};

/** Common Roblox property names with stable types. Used by Pass 1 to type
 *  leaf fields on synthesized chains (e.g. `script.Parent.CFrame` → CFrame
 *  datatype, not `Instance`). Keep narrow — only names whose type doesn't
 *  vary across the BasePart/GuiObject/etc. families. */
const ROBLOX_PROPERTY_TYPES: Record<string, string> = {
  // CFrame / Vector3 datatypes
  CFrame: 'CFrame',
  Position: 'Vector3',
  Size: 'Vector3',
  Velocity: 'Vector3',
  RotVelocity: 'Vector3',
  AssemblyLinearVelocity: 'Vector3',
  AssemblyAngularVelocity: 'Vector3',
  Orientation: 'Vector3',
  PivotOffset: 'CFrame',
  // Color
  Color: 'Color3',
  BrickColor: 'BrickColor',
  // Material/Enum
  Material: 'Enum.Material',
  // Primitives
  Transparency: 'number',
  Reflectance: 'number',
  CollisionGroupId: 'number',
  Mass: 'number',
  Anchored: 'boolean',
  CanCollide: 'boolean',
  CanTouch: 'boolean',
  CanQuery: 'boolean',
  Locked: 'boolean',
  ClassName: 'string',
  Name: 'string',
  // GuiObject family
  Visible: 'boolean',
  Active: 'boolean',
  BackgroundTransparency: 'number',
  BorderSizePixel: 'number',
  ZIndex: 'number',
  Text: 'string',
  TextScaled: 'boolean',
  TextWrapped: 'boolean',
  BackgroundColor3: 'Color3',
  TextColor3: 'Color3',
  AnchorPoint: 'Vector2',
};

export interface ScriptParentInferResult {
  /** Per-root TS type node for `compileExpr` to cast through when emitting
   *  the bare `script` / `workspace` global reference. */
  readonly rootTypes: Map<string, ts.TypeNode>;
  /** Per-alias-local TS type node, for `local model = script.Parent` style
   *  re-bindings. The local-init compile path consults this to annotate
   *  the synthesized const declaration. */
  readonly aliasTypes: Map<string, ts.TypeNode>;
  /** Type alias declarations to emit at the top of the compiled module. */
  readonly declarations: ts.Statement[];
}

const EMPTY_RESULT: ScriptParentInferResult = {
  rootTypes: new Map(),
  aliasTypes: new Map(),
  declarations: [],
};

/** Build synthesized type aliases for `script`/`workspace` chains seen in
 *  `body`. Returns empty maps when no chain access is observed (then the
 *  caller falls back to the existing `_LuauChild` emission). */
export function inferScriptParentShapes(
  body: Stat,
  oracle: ClassOracle,
  aliasInits: Map<string, Expr>,
): ScriptParentInferResult {
  if (!body) return EMPTY_RESULT;
  // Identify locals whose init is a `script.Parent[.X...]` chain (1-hop
  // alias). Those are tracked alongside the dynamic roots so accesses
  // through them feed the same shape.
  const aliasOf = new Map<string, string>();
  for (const [name, init] of aliasInits) {
    const root = chainRootOfDynamicAlias(init);
    if (root) aliasOf.set(name, root);
  }
  const trackedNames = new Set<string>([
    ...Object.keys(DYNAMIC_ROOTS),
    ...aliasOf.keys(),
  ]);
  const shapes = collectShapes(body, trackedNames);
  // Merge alias shapes into their referent's shape so the synthesis
  // operates on the union of observed accesses.
  for (const [aliasName, rootName] of aliasOf) {
    const aliasShape = shapes.get(aliasName);
    const rootShape = shapes.get(rootName);
    if (!aliasShape || !rootShape) continue;
    // The alias init is some chain prefix (`script.Parent`, etc). Place
    // the alias's observations under that prefix in the root shape.
    const chain = chainKeysOfDynamicAlias(aliasInits.get(aliasName)!);
    if (!chain) continue;
    let cur = rootShape;
    for (const k of chain) {
      if (!cur.props.has(k)) {
        cur.empty = false;
        cur.props.set(k, emptyShape());
      }
      cur = cur.props.get(k)!;
    }
    // Mark non-empty so the merge picks it up.
    if (!aliasShape.empty) cur.empty = false;
    mergeShape(cur, aliasShape);
  }

  const rootTypes = new Map<string, ts.TypeNode>();
  const aliasTypes = new Map<string, ts.TypeNode>();
  const declarations: ts.Statement[] = [];
  let aliasCounter = 0;
  const nextAlias = () => `_$Shape_${aliasCounter++}`;

  for (const [name, baseClass] of Object.entries(DYNAMIC_ROOTS)) {
    const shape = shapes.get(name);
    if (!shape || shape.empty) continue;
    const literal = buildShapeLiteral(shape, oracle, 0);
    if (!literal) continue;
    const aliasName = nextAlias();
    const intersection = factory.createIntersectionTypeNode([
      literal,
      factory.createTypeReferenceNode(baseClass, undefined),
    ]);
    declarations.push(
      factory.createTypeAliasDeclaration(
        undefined,
        aliasName,
        undefined,
        intersection,
      ),
    );
    rootTypes.set(name, factory.createTypeReferenceNode(aliasName, undefined));
  }

  // Per-alias-local type: walk the alias's chain inside its root shape
  // and emit the type at that depth.
  for (const [aliasName, rootName] of aliasOf) {
    const rootShape = shapes.get(rootName);
    const initExpr = aliasInits.get(aliasName);
    if (!rootShape || !initExpr) continue;
    const chain = chainKeysOfDynamicAlias(initExpr);
    if (!chain) continue;
    let cur: Shape | undefined = rootShape;
    for (const k of chain) {
      cur = cur?.props.get(k);
      if (!cur) break;
    }
    if (!cur || cur.empty) continue;
    const literal = buildShapeLiteral(cur, oracle, 0);
    if (!literal) continue;
    const intersection = factory.createIntersectionTypeNode([
      literal,
      factory.createTypeReferenceNode('Instance', undefined),
    ]);
    aliasTypes.set(aliasName, intersection);
  }

  if (declarations.length === 0 && aliasTypes.size === 0) return EMPTY_RESULT;
  return { rootTypes, aliasTypes, declarations };
}

function emptyShape(): Shape {
  return { props: new Map(), methods: new Map(), indexed: false, assigned: false, callable: false, empty: true };
}

function mergeShape(dst: Shape, src: Shape): void {
  if (src.empty) return;
  dst.empty = false;
  dst.indexed = dst.indexed || src.indexed;
  for (const [name, child] of src.props) {
    const ex = dst.props.get(name);
    if (ex) mergeShape(ex, child);
    else dst.props.set(name, child);
  }
  for (const [name, meta] of src.methods) {
    const ex = dst.methods.get(name);
    if (ex) ex.maxArgs = Math.max(ex.maxArgs, meta.maxArgs);
    else dst.methods.set(name, { ...meta });
  }
}

/** Return the dynamic-root name (`script`/`workspace`) the given init
 *  chain is anchored at, or null if it isn't a dynamic-root chain. */
function chainRootOfDynamicAlias(init: Expr): string | null {
  let cur: Expr = init;
  while (cur.type === 'IndexName' && cur.op === '.') {
    cur = cur.expr;
  }
  if (cur.type === 'Global' && cur.name in DYNAMIC_ROOTS) return cur.name;
  return null;
}

/** Return the property-name chain (root-first) for a dynamic-root init,
 *  or null if not applicable. e.g. `script.Parent.Foo` → ['Parent', 'Foo']. */
function chainKeysOfDynamicAlias(init: Expr): string[] | null {
  const keys: string[] = [];
  let cur: Expr = init;
  while (cur.type === 'IndexName' && cur.op === '.') {
    keys.unshift(cur.index);
    cur = cur.expr;
  }
  if (cur.type === 'Global' && cur.name in DYNAMIC_ROOTS) return keys;
  return null;
}

function buildShapeLiteral(shape: Shape, oracle: ClassOracle, depth: number): ts.TypeNode | null {
  if (shape.empty || depth > 8) return null;
  const members: ts.TypeElement[] = [];

  for (const [name, child] of shape.props) {
    if (name === '__call__') continue;
    const methodMeta = shape.methods.get(name);
    if (methodMeta) {
      // Skip method signatures the base class (Instance) already
      // declares — the intersection picks up the real typed signature
      // (e.g. GetChildren(): Instance[]) instead of our generic
      // `defined`-returning shadow.
      if (oracle.methodReturnType('Instance', name, 0)) continue;
      // Method signature. Return type uses `defined` per the
      // no-unknown-in-synthesis rule. Chained `.Method().X` access on
      // the result falls back to `defined` semantics (any property
      // typechecks as `defined`).
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
    // Field. If the name maps to a known Roblox class via oracle's
    // child-name table (Humanoid → Humanoid, etc.) AND the observed
    // shape on the child is empty, use that class directly. Otherwise
    // synthesize a structural type for the child and intersect with
    // Instance so navigation/event access still typechecks.
    const oracleClass = oracle.childNameClass(name);
    const robloxPropType = ROBLOX_PROPERTY_TYPES[name];
    let childType: ts.TypeNode;
    const nestedLiteral = buildShapeLiteral(child, oracle, depth + 1);
    if (oracleClass && (!nestedLiteral || child.empty)) {
      childType = factory.createTypeReferenceNode(oracleClass, undefined);
    } else if (child.assigned && !nestedLiteral) {
      // Assigned leaf — use `defined` to accept any RHS (BrickColor,
      // number, Color3, etc.) without forcing a specific datatype.
      // Stricter types (ROBLOX_PROPERTY_TYPES) misreport for scripts
      // using deprecated mixed-case aliases (lookVector vs LookVector).
      childType = factory.createTypeReferenceNode('defined', undefined);
    } else if (robloxPropType) {
      // Known Roblox property name with stable datatype — emit it
      // directly even if nested members were observed. The datatype's
      // @rbxts/types declaration covers method/property access on the
      // result, so `script.Parent.CFrame.lookVector` resolves naturally.
      childType = factory.createTypeReferenceNode(robloxPropType, undefined);
    } else if (nestedLiteral) {
      // Intersect synthesized child shape with Instance — accessed Parent
      // navigations etc. still resolve via Instance's @rbxts/types
      // declaration.
      childType = factory.createIntersectionTypeNode([
        nestedLiteral,
        factory.createTypeReferenceNode('Instance', undefined),
      ]);
    } else if (oracleClass) {
      childType = factory.createTypeReferenceNode(oracleClass, undefined);
    } else if (child.assigned) {
      // Field is observed as a write target but never read. `defined`
      // accepts any RHS (BrickColor, Color3, primitives, etc.) so the
      // assignment compiles without a Record bridge.
      childType = factory.createTypeReferenceNode('defined', undefined);
    } else {
      // No child-name match and no observed members — fall back to
      // `Instance` (broadest sound type for an unknown Roblox child).
      childType = factory.createTypeReferenceNode('Instance', undefined);
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
