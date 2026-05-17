#!/usr/bin/env node
// Extracts a compact API oracle from @rbxts/types and writes
// src/compile/oracle/data.generated.ts. Run as `prebuild`.
//
// We pull from node_modules/@rbxts/types unless RBXTS_TYPES_PATH overrides.

import ts from 'typescript';
import path from 'node:path';
import fs from 'node:fs';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const typesRoot =
  process.env.RBXTS_TYPES_PATH ||
  path.join(repoRoot, 'node_modules', '@rbxts', 'types', 'include');

if (!fs.existsSync(typesRoot)) {
  console.error(`[build-oracle] @rbxts/types not found at ${typesRoot}.`);
  console.error('[build-oracle] Set RBXTS_TYPES_PATH or `pnpm add -wD @rbxts/types`.');
  process.exit(1);
}

const robloxFile = path.join(typesRoot, 'roblox.d.ts');
const generatedFile = path.join(typesRoot, 'generated', 'None.d.ts');

const program = ts.createProgram([robloxFile, generatedFile], {
  noLib: true,
  noResolve: false,
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.ESNext,
  skipLibCheck: true,
});

/** @type {Record<string, ClassEntry>} */
const classes = {};
/** @type {Record<string, string>} */
const instancesIndex = {};
/** @type {Record<string, string>} */
const creatableInstances = {};
/** @type {Record<string, string>} */
const services = {};
/** @type {Set<string>} */
const vector3Properties = new Set();

/**
 * @typedef {{ extends?: string, properties: Record<string,PropertyEntry>, methods: Record<string,MethodSig|MethodSig[]> }} ClassEntry
 * @typedef {{ type: string, readonly?: boolean }} PropertyEntry
 * @typedef {{ returnText: string, paramCount: number, optionalParams?: number, strategy?: { kind: string } }} MethodSig
 */

const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });
const dummySourceFile = ts.createSourceFile('__oracle__.ts', '', ts.ScriptTarget.ESNext);

function printType(node) {
  if (!node) return 'unknown';
  return printer.printNode(ts.EmitHint.Unspecified, node, dummySourceFile).replace(/\s+/g, ' ').trim();
}

function getExtends(decl) {
  const heritage = decl.heritageClauses?.find(h => h.token === ts.SyntaxKind.ExtendsKeyword);
  if (!heritage) return undefined;
  const first = heritage.types[0];
  if (!first) return undefined;
  if (first.expression.kind === ts.SyntaxKind.Identifier) {
    return first.expression.text;
  }
  return undefined;
}

function classifyMethodStrategy(decl, name) {
  // Hand-pinned generic strategies.
  // FindFirstChildOfClass<T extends keyof Instances>(this, className: T): Instances[T] | undefined
  // FindFirstChildWhichIsA / FindFirstAncestorWhichIsA likewise
  // WaitForChild has overloads (string)=>Instance and (string,timeout)=>Instance|undefined
  // GetService<T extends keyof S>(this, className: T): S[T]
  const generics = decl.typeParameters;
  if (!generics) return undefined;
  const ret = printType(decl.type);
  // Match Instances[T] | undefined or Instances[T]
  if (/^Instances\[\w+\]\s*\|\s*undefined$/.test(ret)) {
    return { kind: 'instancesIndexOptional' };
  }
  if (/^Instances\[\w+\]$/.test(ret)) {
    return { kind: 'instancesIndex' };
  }
  // CreatableInstances[T]
  if (/^CreatableInstances\[\w+\]\s*\|\s*undefined$/.test(ret)) {
    return { kind: 'creatableInstancesIndexOptional' };
  }
  if (/^CreatableInstances\[\w+\]$/.test(ret)) {
    return { kind: 'creatableInstancesIndex' };
  }
  if (/^S\[\w+\]$/.test(ret) && name === 'GetService') {
    return { kind: 'servicesIndex' };
  }
  return undefined;
}

function memberName(node) {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node)) return node.text;
  return undefined;
}

function collectMembers(decl) {
  /** @type {Record<string, PropertyEntry>} */
  const properties = {};
  /** @type {Record<string, MethodSig | MethodSig[]>} */
  const methods = {};

  for (const member of decl.members) {
    if (ts.isPropertySignature(member)) {
      const name = memberName(member.name);
      if (!name) continue;
      const typeText = printType(member.type);
      const readonly = !!member.modifiers?.some(m => m.kind === ts.SyntaxKind.ReadonlyKeyword);
      properties[name] = { type: typeText, readonly };
      if (typeText === 'Vector3' || typeText === 'Vector3 | undefined') {
        vector3Properties.add(name);
      }
    } else if (ts.isMethodSignature(member)) {
      const name = memberName(member.name);
      if (!name) continue;
      let params = member.parameters;
      if (params.length && ts.isIdentifier(params[0].name) && params[0].name.text === 'this') {
        params = params.slice(1);
      }
      const required = params.filter(p => !p.questionToken && !p.dotDotDotToken).length;
      const total = params.length;
      const returnText = printType(member.type);
      const strategy = classifyMethodStrategy(member, name);
      const sig = {
        returnText,
        paramCount: required,
        optionalParams: total - required,
        ...(strategy ? { strategy } : {}),
      };
      const existing = methods[name];
      if (existing === undefined) {
        methods[name] = sig;
      } else if (Array.isArray(existing)) {
        existing.push(sig);
      } else {
        methods[name] = [existing, sig];
      }
    }
  }

  return { properties, methods };
}

function processInterface(decl) {
  const name = decl.name.text;
  // Skip noisy nominal-typed _nominal_X fields by stripping them later (kept in props for now).
  if (name === 'Instances') {
    for (const m of decl.members) {
      if (ts.isPropertySignature(m) && (ts.isIdentifier(m.name) || ts.isStringLiteral(m.name))) {
        instancesIndex[m.name.text] = printType(m.type);
      }
    }
    return;
  }
  if (name === 'CreatableInstances') {
    for (const m of decl.members) {
      if (ts.isPropertySignature(m) && (ts.isIdentifier(m.name) || ts.isStringLiteral(m.name))) {
        creatableInstances[m.name.text] = printType(m.type);
      }
    }
    return;
  }
  if (name === 'Services') {
    for (const m of decl.members) {
      if (ts.isPropertySignature(m) && (ts.isIdentifier(m.name) || ts.isStringLiteral(m.name))) {
        services[m.name.text] = printType(m.type);
      }
    }
    return;
  }

  const { properties, methods } = collectMembers(decl);
  const ext = getExtends(decl);
  if (classes[name]) {
    // Merge (interfaces can be declared multiple times).
    Object.assign(classes[name].properties, properties);
    for (const [m, sig] of Object.entries(methods)) {
      if (!classes[name].methods[m]) classes[name].methods[m] = sig;
    }
    if (!classes[name].extends && ext) classes[name].extends = ext;
  } else {
    classes[name] = { ...(ext ? { extends: ext } : {}), properties, methods };
  }
}

for (const sourceFile of program.getSourceFiles()) {
  if (!sourceFile.fileName.includes('rbxts/types')) continue;
  ts.forEachChild(sourceFile, node => {
    if (ts.isInterfaceDeclaration(node)) {
      processInterface(node);
    }
  });
}

// Prune internal nominal-symbol props and prune the deep class set to
// what we need. Keep classes reachable from Services + a whitelist plus
// every class referenced as a property type from those (so Player.Character
// brings Model, Character brings Humanoid, etc.).

const KEEP = new Set([
  'Instance', 'RBXObject', 'BasePart', 'Part', 'MeshPart', 'TrussPart', 'CornerWedgePart',
  'WedgePart', 'SpawnLocation', 'Player', 'Players', 'Workspace', 'PVInstance', 'Model',
  'Folder', 'Configuration', 'Folder', 'StringValue', 'IntValue', 'NumberValue',
  'BoolValue', 'ObjectValue', 'CFrameValue', 'Vector3Value', 'BrickColorValue', 'Color3Value',
  'Humanoid', 'HumanoidDescription', 'Animator', 'Animation', 'AnimationTrack',
  'Tool', 'Accessory', 'Hat', 'Shirt', 'Pants', 'ShirtGraphic',
  'PlayerGui', 'StarterGui', 'StarterPack', 'StarterPlayer', 'StarterCharacter',
  'StarterCharacterScripts', 'StarterPlayerScripts', 'Backpack', 'Lighting',
  'ReplicatedStorage', 'ServerStorage', 'ReplicatedFirst', 'ServerScriptService',
  'TweenService', 'RunService', 'UserInputService', 'ContextActionService',
  'MarketplaceService', 'DataStoreService', 'HttpService', 'MessagingService',
  'TeleportService', 'BadgeService', 'GroupService', 'Chat', 'CollectionService',
  'GameSettings', 'GuiObject', 'GuiBase', 'GuiBase2d', 'GuiBase3d',
  'TextLabel', 'TextButton', 'TextBox', 'ImageLabel', 'ImageButton',
  'ScrollingFrame', 'Frame', 'ScreenGui', 'BillboardGui', 'SurfaceGui',
  'ViewportFrame', 'UIListLayout', 'UIGridLayout', 'UICorner', 'UIStroke',
  'UIPadding', 'UIScale', 'UISizeConstraint', 'UIAspectRatioConstraint',
  'GuiButton', 'LayerCollector', 'RemoteEvent', 'RemoteFunction', 'BindableEvent', 'BindableFunction',
  'Camera', 'Sound', 'SoundService', 'SoundGroup', 'Texture', 'Decal',
  'ParticleEmitter', 'Beam', 'Trail', 'Light', 'PointLight', 'SpotLight', 'SurfaceLight',
  'Attachment', 'Weld', 'WeldConstraint', 'Motor6D', 'Constraint', 'AlignPosition',
  'Mouse', 'PlayerMouse', 'PlayerScripts',
  'Script', 'LocalScript', 'ModuleScript', 'BaseScript', 'LuaSourceContainer',
  'ServiceProvider', 'DataModel', 'GenericService',
  'TerrainRegion', 'Terrain',
]);

// Track classes reachable from Services interface so we keep them.
const reachable = new Set();
function markReachable(name) {
  if (!name || reachable.has(name)) return;
  reachable.add(name);
  const c = classes[name];
  if (!c) return;
  if (c.extends) markReachable(c.extends);
  for (const p of Object.values(c.properties)) {
    // Extract identifier-like base names from textual type.
    for (const ref of p.type.split(/[^A-Za-z0-9_]+/)) {
      if (ref && /^[A-Z]/.test(ref) && classes[ref]) markReachable(ref);
    }
  }
}
for (const cls of Object.values(services)) markReachable(cls);
for (const cls of Object.values(instancesIndex)) markReachable(cls);
for (const cls of Object.values(creatableInstances)) markReachable(cls);
for (const name of KEEP) markReachable(name);

// Filter to reachable.
const prunedClasses = {};
for (const name of reachable) {
  if (classes[name]) prunedClasses[name] = classes[name];
}

// Strip internal nominal-symbol property fields (e.g. _nominal_Players).
for (const cls of Object.values(prunedClasses)) {
  for (const key of Object.keys(cls.properties)) {
    if (key.startsWith('_nominal_')) delete cls.properties[key];
  }
}

// Emit data.generated.ts
const outPath = path.join(repoRoot, 'src', 'compile', 'oracle', 'data.generated.ts');
fs.mkdirSync(path.dirname(outPath), { recursive: true });

const banner = `// AUTO-GENERATED by scripts/build-oracle.mjs from @rbxts/types. Do not edit by hand.
// Run \`pnpm build\` to regenerate.

`;

const body = `import type { OracleData } from './types.js';

const data: OracleData = ${JSON.stringify({
  classes: prunedClasses,
  instancesIndex,
  creatableInstances,
  services,
  vector3Properties: Array.from(vector3Properties).sort(),
}, null, 0)};

export default data;
`;

fs.writeFileSync(outPath, banner + body, 'utf8');

const size = fs.statSync(outPath).size;
console.log(`[build-oracle] wrote ${outPath} (${(size/1024).toFixed(1)} KB, ${Object.keys(prunedClasses).length} classes, ${Object.keys(instancesIndex).length} instancesIndex)`);
