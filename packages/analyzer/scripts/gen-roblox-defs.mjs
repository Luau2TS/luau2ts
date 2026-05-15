#!/usr/bin/env node
// Generate Roblox-globals definitions from API-Dump.json + hand-written
// supplements (datatypes, libraries) for things the dump doesn't cover.
//
// Output: build/roblox-globals.d.lua — picked up by embed-globals.mjs at
// WASM build time and linked into the analyzer.
//
// Run: node packages/analyzer/scripts/gen-roblox-defs.mjs
// Pair with: bash packages/analyzer/build/build.sh   (rebuilds the WASM)

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dumpPath = resolve(here, 'api-dump/API-Dump.json');
const supplementsPath = resolve(here, 'supplements.d.lua');
const outPath = resolve(here, '../build/roblox-globals.d.lua');

const dump = JSON.parse(readFileSync(dumpPath, 'utf8'));
const supplements = readFileSync(supplementsPath, 'utf8');

// Track every DataType the generator references. We compare against the
// names supplements.d.lua declares; anything left unresolved gets an
// empty `declare class X end` stub injected at the top of the generated
// output. Without this, a single unresolved type reference in any class
// body causes loadDefinitionFile to "succeed" but silently corrupts the
// analyzer state — every subsequent frontend.check() returns zero
// diagnostics, including syntax errors. Found the hard way.
const referencedDataTypes = new Set();
const SUPPLEMENT_PROVIDED = (() => {
  const provided = new Set();
  for (const line of supplements.split('\n')) {
    const m = line.match(/^declare class (\w+)/);
    if (m) provided.add(m[1]);
  }
  return provided;
})();

// -- Type mapping ---------------------------------------------------------
//
// Roblox's API dump uses {Category, Name} tuples for types. Map them to
// Luau-syntax type expressions. Some categories are context-dependent
// (Tuple is variadic-arg in parameter position, multi-return in return
// position), so callers pass `position` to disambiguate.
function mapType(t, position /* 'param' | 'ret' | 'prop' */) {
  if (!t) return 'any';
  const { Category, Name } = t;
  if (Category === 'Primitive') {
    if (Name === 'bool') return 'boolean';
    if (Name === 'string') return 'string';
    if (Name === 'int' || Name === 'int64' || Name === 'float' || Name === 'double') return 'number';
    if (Name === 'null') return position === 'ret' ? '()' : 'nil';
    // The dump occasionally has `string?`, `int?` etc. encoded as Name suffix.
    if (Name.endsWith('?')) {
      const inner = mapType({ Category, Name: Name.slice(0, -1) }, position);
      return inner === 'nil' ? 'nil' : `${inner}?`;
    }
    return Name;
  }
  if (Category === 'Class') return Name; // Class names are emitted as types
  if (Category === 'DataType') {
    // The dump references DataTypes by name; declarations come from the
    // hand-written supplements file. A few well-known names need mapping
    // because they're shorthand for parameterized types, aliases, or
    // optional-suffix variants.
    if (Name === 'Objects') return '{ Instance }';
    if (Name === 'Function') return '(...any) -> ...any';
    if (Name === 'Content') return 'string';
    if (Name === 'BinaryString') return 'string';
    if (Name === 'QDir') return 'string';
    if (Name === 'OptionalCoordinateFrame') return 'CFrame?';
    if (Name === 'CoordinateFrame') return 'CFrame';
    // Trailing-`?` is the dump's encoding for optional/nilable; resolve
    // the inner name and re-wrap. Unknown inner names still get stub
    // declarations injected (see below) so the file always parses cleanly.
    if (Name.endsWith('?')) {
      const inner = mapType({ Category: 'DataType', Name: Name.slice(0, -1) }, position);
      return inner.endsWith('?') ? inner : `${inner}?`;
    }
    referencedDataTypes.add(Name);
    return Name;
  }
  if (Category === 'Enum') {
    // Roblox properties typed as `Enum.Material` etc. hold an EnumItem of
    // the specified enum. Luau type-position syntax `Enum.X` looks valid
    // but actually silently breaks loadDefinitionFile's analyzer state —
    // we lose precision (any EnumItem matches) but the analyzer keeps
    // working. Refining to per-enum types would need a way to expose the
    // Enum_X classes in the Enum namespace's value-vs-type position
    // (Luau treats them differently).
    return 'EnumItem';
  }
  if (Category === 'Group') {
    if (Name === 'Variant') return 'any';
    if (Name === 'Tuple') {
      // Variadic argument list, or multi-return. Both render as `...any`
      // — at parameter position it must be the last param (caller ensures
      // this; the dump only ever places Tuple last).
      return '...any';
    }
    if (Name === 'Array') return '{ any }';
    if (Name === 'Dictionary') return '{ [string]: any }';
    if (Name === 'Map') return '{ [any]: any }';
    if (Name === 'OptionalCoercion') return 'any?';
    if (Name === 'Dictionary?') return '({ [string]: any })?';
  }
  return 'any';
}

// -- Identifier safety ----------------------------------------------------
//
// Most Roblox identifiers are already valid Luau, but a few use reserved
// words (`function` as a parameter name in callbacks), unicode, or start
// with digits. Rename those.
const LUAU_RESERVED = new Set([
  'and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for', 'function',
  'if', 'in', 'local', 'nil', 'not', 'or', 'repeat', 'return', 'then', 'true',
  'until', 'while', 'continue', 'type', 'typeof', 'export', 'declare',
]);
function safeIdent(name) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return `_${name.replace(/[^A-Za-z0-9_]/g, '_')}`;
  if (LUAU_RESERVED.has(name)) return `_${name}`;
  return name;
}

// -- Known-optional-param overrides --------------------------------------
//
// The API dump under-marks several params: real Roblox accepts them as
// optional, but the dump's Parameter entry has no `Default` field. The
// analyzer then rejects ~every script's call as CountMismatch. Listed
// here as `<ClassName>.<MethodName>: <paramName>`. Each entry promotes
// the param to nilable (`T?` instead of `T`) so callers can omit it.
const KNOWN_OPTIONAL_PARAMS = new Set([
  'Instance.WaitForChild:timeOut',
  'Instance.FindFirstAncestorWhichIsA:recursive',
  'Instance.FindFirstChildWhichIsA:recursive',
  'Instance.IsA:isType',
  'Workspace.Raycast:raycastParams',
  'Workspace.Spherecast:raycastParams',
  'Workspace.Blockcast:raycastParams',
  'BasePart.GetPartBoundsInBox:overlapParams',
  'BasePart.GetPartBoundsInRadius:overlapParams',
  'BasePart.GetPartsInPart:overlapParams',
  'Players.GetPlayerFromCharacter:character',
  'TweenService.Create:tweenInfo',
]);

function isParamOptional(p, ownerClass, methodName) {
  if (p.Default !== undefined) return true;
  if (KNOWN_OPTIONAL_PARAMS.has(`${ownerClass}.${methodName}:${p.Name}`)) return true;
  return false;
}

// -- Format a function-type member ---------------------------------------
//
// Roblox methods are `instance:Method(args)` which in Luau-types is
// `Method: (self: ClassName, args) -> ret`. Emit that form.
function formatFunctionType(params, retType, ownerClass, methodName) {
  const parts = [];
  for (const p of params || []) {
    let typeStr = mapType(p.Type, 'param');
    if (typeStr === '...any') {
      parts.push('...any');
    } else {
      // Optional with default value: mark the slot nilable so callers
      // can omit it.
      if (isParamOptional(p, ownerClass, methodName) && !typeStr.endsWith('?') && typeStr !== 'any') {
        typeStr += '?';
      }
      parts.push(`${safeIdent(p.Name)}: ${typeStr}`);
    }
  }
  const ret = mapType(retType, 'ret');
  return `(${parts.join(', ')}) -> ${ret}`;
}

function formatMethodType(className, params, retType, methodName) {
  const parts = [`self: ${className}`];
  for (const p of params || []) {
    let typeStr = mapType(p.Type, 'param');
    if (typeStr === '...any') {
      parts.push('...any');
    } else {
      if (isParamOptional(p, className, methodName) && !typeStr.endsWith('?') && typeStr !== 'any') {
        typeStr += '?';
      }
      parts.push(`${safeIdent(p.Name)}: ${typeStr}`);
    }
  }
  const ret = mapType(retType, 'ret');
  return `(${parts.join(', ')}) -> ${ret}`;
}

// -- Skip filters --------------------------------------------------------
//
// Some members shouldn't surface to scripts. Mainly:
// - Roblox-internal security levels (RobloxScriptSecurity, etc.)
// - Hidden / Deprecated / NotBrowsable tags (best-effort; some are useful)
function shouldSkipMember(m) {
  const security =
    typeof m.Security === 'string'
      ? m.Security
      : (m.Security?.Read ?? 'None');
  if (security !== 'None' && security !== 'PluginSecurity') return true;
  if (m.Tags?.includes('NotScriptable')) return true;
  return false;
}

// -- Member emit ---------------------------------------------------------
function emitMember(className, m, lines) {
  if (shouldSkipMember(m)) return;
  const name = safeIdent(m.Name);
  // NOTE: Luau's `declare class` body doesn't accept the `read` modifier
  // (only regular `type T = { ... }` table types do). Drop it; lose a bit
  // of read-only enforcement.

  switch (m.MemberType) {
    case 'Property': {
      const ty = mapType(m.ValueType, 'prop');
      lines.push(`    ${name}: ${ty}`);
      break;
    }
    case 'Function': {
      const sig = formatMethodType(className, m.Parameters, m.ReturnType, m.Name);
      lines.push(`    ${name}: ${sig}`);
      break;
    }
    case 'Event': {
      // Events are RBXScriptSignal-typed properties. Luau's `declare class`
      // doesn't support generic class declarations, so we lose listener-
      // signature typing here and treat every signal as the same shape
      // (`Connect((...any) -> ())`). The supplements file declares
      // RBXScriptSignal with that loose listener type.
      lines.push(`    ${name}: RBXScriptSignal`);
      break;
    }
    case 'Callback': {
      // Callbacks are settable function-typed slots. The optional `?` lets
      // scripts assign nil to clear them (idiomatic Roblox pattern).
      const sig = formatFunctionType(m.Parameters, m.ReturnType, className, m.Name);
      lines.push(`    ${name}: ${sig}?`);
      break;
    }
    default:
      // Unknown member type — skip silently.
      break;
  }
}

// -- Class emit ----------------------------------------------------------
//
// Order matters: a class can't be declared before its superclass. Do a
// topological pass so `declare class Workspace extends Model` appears
// after `Model`.
function topoSortClasses(classes) {
  const byName = new Map(classes.map((c) => [c.Name, c]));
  const visited = new Set();
  const order = [];
  function visit(name) {
    if (visited.has(name)) return;
    visited.add(name);
    const c = byName.get(name);
    if (!c) return;
    if (c.Superclass && c.Superclass !== '<<<ROOT>>>') visit(c.Superclass);
    order.push(c);
  }
  for (const c of classes) visit(c.Name);
  return order;
}

function emitClass(c, lines, serviceNames) {
  // Skip the synthetic root marker; everything below it gets `extends`.
  // Roblox marks the absolute base with Superclass `<<<ROOT>>>` (typically
  // Instance's superclass).
  const ext = c.Superclass && c.Superclass !== '<<<ROOT>>>' ? ` extends ${c.Superclass}` : '';
  lines.push(`declare class ${c.Name}${ext}`);
  // Deduplicate member names — a few classes redeclare an inherited prop
  // with a stricter type, and Luau rejects duplicates inside one class
  // body.
  const seen = new Set();
  for (const m of c.Members) {
    if (seen.has(m.Name)) continue;
    seen.add(m.Name);
    emitMember(c.Name, m, lines);
  }
  // DataModel: also expose every Service as a property. Real Roblox
  // accepts `game.Players`, `game.Debris`, etc. as a shortcut for
  // `game:GetService(...)`. Without these, the analyzer flags 30+
  // legitimate accesses across the corpus.
  if (c.Name === 'DataModel' && serviceNames) {
    for (const svc of serviceNames) {
      if (seen.has(svc)) continue;
      seen.add(svc);
      lines.push(`    ${svc}: ${svc}`);
    }
  }
  lines.push('end');
  lines.push('');
}

// -- Enum emit -----------------------------------------------------------
//
// Roblox enums are accessed as `Enum.Material.Plastic`. Model as:
//   declare class EnumItem ... end
//   declare class Enum_Material   <- per-enum class with one prop per item
//       Plastic: EnumItem
//       GetEnumItems: (self) -> { EnumItem }
//   end
//   declare class GlobalEnums     <- namespace
//       Material: Enum_Material
//       ...
//   end
//   declare Enum: GlobalEnums
function emitEnums(enums, lines) {
  lines.push('-- Enums ----------------------------------------------------------');
  lines.push('-- (EnumItem itself is declared in supplements.d.lua so datatype');
  lines.push('-- supplements that reference it resolve at parse time.)');
  lines.push('');
  for (const e of enums) {
    const cname = `Enum_${e.Name}`;
    lines.push(`declare class ${cname}`);
    const seen = new Set();
    for (const item of e.Items) {
      const ident = safeIdent(item.Name);
      if (seen.has(ident)) continue;
      seen.add(ident);
      lines.push(`    ${ident}: EnumItem`);
    }
    lines.push(`    GetEnumItems: (self: ${cname}) -> { EnumItem }`);
    lines.push('end');
    lines.push('');
  }
  // Namespace + global binding.
  lines.push('declare class GlobalEnums');
  for (const e of enums) {
    lines.push(`    ${safeIdent(e.Name)}: Enum_${e.Name}`);
  }
  // Roblox also exposes `Enum:GetEnums()`.
  lines.push('    GetEnums: (self: GlobalEnums) -> { GlobalEnums }');
  lines.push('end');
  lines.push('');
  lines.push('declare Enum: GlobalEnums');
  lines.push('');
}

// -- Main ---------------------------------------------------------------
const out = [];
out.push('-- AUTO-GENERATED Roblox globals for @luau2ts/analyzer.');
out.push('-- Source: API-Dump.json (see api-dump/SOURCE.md for version).');
out.push('-- Regenerate with: node packages/analyzer/scripts/gen-roblox-defs.mjs');
out.push('--');
out.push('-- The hand-written supplements (datatypes, libraries, globals like');
out.push('-- game/script/workspace, task) are appended verbatim from');
out.push('-- scripts/supplements.d.lua. Order matters: supplements first so');
out.push('-- datatypes (Vector3, CFrame, RBXScriptSignal, ...) are declared');
out.push('-- before the class bodies that reference them.');
out.push('');

out.push(supplements);
out.push('');

// Walk all class members once to populate `referencedDataTypes` so we
// know which DataTypes aren't covered by supplements. We discard the
// emitted output of this dry run (the real emit happens below).
const dryRun = [];
const sortedClasses = topoSortClasses(dump.Classes);
for (const c of sortedClasses) emitClass(c, dryRun);

const missingDataTypes = [...referencedDataTypes].filter((n) => !SUPPLEMENT_PROVIDED.has(n));
if (missingDataTypes.length > 0) {
  out.push('-- DataType stubs (not covered by supplements; declared empty so');
  out.push('-- loadDefinitionFile resolves the names — refine in supplements');
  out.push('-- if real members are needed) ------------------------------------');
  out.push('');
  for (const n of missingDataTypes.sort()) out.push(`declare class ${n} end`);
  out.push('');
}

// Collect service class names so DataModel can expose them as direct
// properties (matching real Roblox where `game.Players` works as a
// shortcut for `game:GetService("Players")`).
const serviceNames = dump.Classes
  .filter((c) => c.Tags?.includes('Service'))
  .map((c) => c.Name)
  .sort();

out.push('-- Classes (generated) -------------------------------------------');
out.push('');
for (const c of sortedClasses) emitClass(c, out, serviceNames);

emitEnums(dump.Enums, out);

// Roblox top-level script globals. Declared LAST so the classes they're
// typed against (DataModel, Workspace, BaseScript, Plugin) are already
// in scope.
out.push('-- Top-level script globals --------------------------------------');
out.push('');
out.push('declare game: DataModel');
out.push('declare script: BaseScript');
out.push('declare workspace: Workspace');
out.push('declare plugin: Plugin');
out.push('');

writeFileSync(outPath, out.join('\n'));
console.log(`[gen-roblox-defs] wrote ${outPath} (${out.length} lines, ${sortedClasses.length} classes, ${dump.Enums.length} enums)`);
