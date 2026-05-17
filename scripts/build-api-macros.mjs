#!/usr/bin/env node
// Generate Roblox-API macros from API-Dump.json + @rbxts/types stdlib.
//
// Outputs (under src/compile/macros/generated/):
//   - api-data.ts       structured data the compiler consults at emit time
//   - stdlib.ts         registerMacro per stdlib function (string/math/os/…)
//   - constructors.ts   registerConstructorMacro per datatype with .new
//   - static-factories.ts datatype static factories
//   - enums.ts          Enum item references
//   - exclusions.json   any API entries we explicitly don't macro, with reason
//
// Reproducible: deterministic key order, no timestamps, no environment-derived
// state. Re-running on the same inputs must produce byte-identical output.
//
// Sources of truth:
//   - https://raw.githubusercontent.com/MaximumADHD/Roblox-Client-Tracker/roblox/API-Dump.json
//   - node_modules/@rbxts/types/include/{lua,macro_math,roblox}.d.ts
//   - node_modules/@rbxts/types/include/generated/{enums,…}.d.ts

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

const API_DUMP_URL =
  'https://raw.githubusercontent.com/MaximumADHD/Roblox-Client-Tracker/roblox/API-Dump.json';
const CACHE_DIR = resolve(repoRoot, 'src/compile/macros/generated/cache');
const API_DUMP_CACHE = resolve(CACHE_DIR, 'api-dump.json');
const OUT_DIR = resolve(repoRoot, 'src/compile/macros/generated');
const TYPES_DIR = resolve(repoRoot, 'node_modules/@rbxts/types/include');

mkdirSync(CACHE_DIR, { recursive: true });
mkdirSync(OUT_DIR, { recursive: true });

async function loadApiDump() {
  const force = process.argv.includes('--refresh');
  if (existsSync(API_DUMP_CACHE) && !force) {
    return JSON.parse(readFileSync(API_DUMP_CACHE, 'utf8'));
  }
  console.error(`[build-api-macros] fetching ${API_DUMP_URL}`);
  const res = await fetch(API_DUMP_URL);
  if (!res.ok) throw new Error(`fetch ${API_DUMP_URL}: ${res.status}`);
  const text = await res.text();
  writeFileSync(API_DUMP_CACHE, text);
  return JSON.parse(text);
}

function loadStdlibTypes() {
  const luaDts = readFileSync(resolve(TYPES_DIR, 'lua.d.ts'), 'utf8');
  // Roblox-side globals + datatypes live in roblox.d.ts; we only consult it
  // for Lua-stdlib-adjacent globals (`task`, `bit32`, etc.) that aren't in
  // lua.d.ts. Most signatures are in lua.d.ts.
  const robloxDts = readFileSync(resolve(TYPES_DIR, 'roblox.d.ts'), 'utf8');
  return { luaDts, robloxDts };
}

/* ────────────────────────────────────────────────────────────────────── */
/*  Stdlib parser                                                          */
/* ────────────────────────────────────────────────────────────────────── */

/** Walk a `.d.ts` text for `interface X { … }` (or `namespace X`)
 *  declarations and extract method signatures by simple regex. The
 *  signatures we care about are uniform: `<name>(<args>): <ret>;`. */
function parseInterfaceSignatures(dts, interfaceName) {
  // Find the interface body. Allow `interface Foo { … }` or
  // `interface Foo extends Y { … }`.
  const re = new RegExp(`(?:^|\\n)(?:declare\\s+)?(?:interface|namespace)\\s+${interfaceName}\\b[^{]*\\{`);
  const match = re.exec(dts);
  if (process.env.LUAU2TS_DEBUG_PARSE) {
    console.error(`[parse] ${interfaceName}: ${match ? 'found at ' + match.index : 'not found'}`);
  }
  if (!match) return [];
  let depth = 1;
  let i = match.index + match[0].length;
  const start = i;
  while (i < dts.length && depth > 0) {
    const c = dts[i];
    if (c === '{') depth += 1;
    else if (c === '}') depth -= 1;
    i += 1;
  }
  const body = dts.slice(start, i - 1);
  return parseSignatures(body);
}

/** Inside an interface body, extract method signatures. Tolerant: skips
 *  property-only declarations, comments, and JSDoc blocks. */
function parseSignatures(body) {
  // Strip /** … */ blocks and // line comments so the regex doesn't
  // accidentally pick up text inside doc comments.
  const stripped = body
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  // Match `<name>(<args>): <ret>;` — possibly preceded by `readonly`,
  // generic params, etc. We capture name + args + return text.
  // The args block can contain nested parens; do a brace/paren matcher.
  const out = [];
  let i = 0;
  while (i < stripped.length) {
    // Skip whitespace + leading modifiers.
    while (i < stripped.length && /\s/.test(stripped[i])) i += 1;
    if (i >= stripped.length) break;
    // Identifier start. Skip leading `function`/`const`/`let`/`readonly`
    // declaration keywords — we only care about the method name.
    let restText = stripped.slice(i);
    const kwMatch = /^(function|const|let|static)\s+/.exec(restText);
    if (kwMatch) {
      i += kwMatch[0].length;
      restText = stripped.slice(i);
    }
    // `readonly` is a property modifier, never a method modifier; once we
    // see it the rest of the line is a property — skip to next stmt.
    if (/^readonly\b/.test(restText)) {
      while (i < stripped.length && stripped[i] !== ';' && stripped[i] !== '\n') i += 1;
      i += 1;
      continue;
    }
    // Anonymous constructor signature: `new (...): T`. Treat as a method
    // named 'new' for our purposes.
    const ctorMatch = /^new\s*\(/.exec(restText);
    let name;
    let p;
    if (ctorMatch) {
      name = 'new';
      p = i + ctorMatch[0].length - 1;
    } else {
      const nameMatch = /^([A-Za-z_$][\w$]*)/.exec(restText);
      if (!nameMatch) {
        while (i < stripped.length && stripped[i] !== ';' && stripped[i] !== '\n') i += 1;
        i += 1;
        continue;
      }
      name = nameMatch[1];
      p = i + name.length;
    }
    // Skip generic args `<T>` if present.
    if (stripped[p] === '<') {
      let gd = 1;
      p += 1;
      while (p < stripped.length && gd > 0) {
        if (stripped[p] === '<') gd += 1;
        else if (stripped[p] === '>') gd -= 1;
        p += 1;
      }
    }
    // Require `(` for a method.
    if (stripped[p] !== '(') {
      // Not a method (property or other). Skip past `;`.
      while (p < stripped.length && stripped[p] !== ';' && stripped[p] !== '\n') p += 1;
      i = p + 1;
      continue;
    }
    // Match parens.
    let pd = 1;
    const argsStart = p + 1;
    p += 1;
    while (p < stripped.length && pd > 0) {
      if (stripped[p] === '(') pd += 1;
      else if (stripped[p] === ')') pd -= 1;
      p += 1;
    }
    const args = stripped.slice(argsStart, p - 1);
    // Read return type up to `;` or newline.
    let retStart = p;
    while (retStart < stripped.length && /[\s:]/.test(stripped[retStart])) retStart += 1;
    let retEnd = retStart;
    let bd = 0;
    let pd2 = 0;
    while (retEnd < stripped.length) {
      const c = stripped[retEnd];
      if (c === '{') bd += 1;
      else if (c === '}') bd -= 1;
      else if (c === '(') pd2 += 1;
      else if (c === ')') pd2 -= 1;
      else if (c === ';' && bd === 0 && pd2 === 0) break;
      else if (c === '\n' && bd === 0 && pd2 === 0) break;
      retEnd += 1;
    }
    const ret = stripped.slice(retStart, retEnd).trim();
    out.push({ name, args: parseArgList(args), returnText: ret });
    i = retEnd + 1;
  }
  return out;
}

function parseArgList(argsText) {
  // Split on top-level commas (depth 0).
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < argsText.length; i += 1) {
    const c = argsText[i];
    if (c === '<' || c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === '>' || c === ')' || c === ']' || c === '}') depth -= 1;
    else if (c === ',' && depth === 0) {
      out.push(argsText.slice(start, i).trim());
      start = i + 1;
    }
  }
  const last = argsText.slice(start).trim();
  if (last) out.push(last);
  return out
    .map((a) => parseArg(a))
    .filter(Boolean);
}

function parseArg(text) {
  // Form: `name: T` or `name?: T` or `...name: T[]`.
  const rest = text.startsWith('...');
  let body = rest ? text.slice(3) : text;
  const m = /^([A-Za-z_$][\w$]*)\s*(\??)\s*:\s*([\s\S]+)$/.exec(body);
  if (!m) return null;
  return { name: m[1], optional: !!m[2], rest, type: m[3].trim() };
}

/* ────────────────────────────────────────────────────────────────────── */
/*  Stdlib namespaces — string, table, math, os, coroutine, bit32, utf8,   */
/*  buffer, debug, task                                                    */
/* ────────────────────────────────────────────────────────────────────── */

const STDLIB_NAMESPACES = [
  'string',
  'table',
  'math',
  'os',
  'coroutine',
  'bit32',
  'utf8',
  'buffer',
  'debug',
  'task',
];

function harvestStdlib({ luaDts, robloxDts }) {
  const out = {};
  for (const ns of STDLIB_NAMESPACES) {
    const luaSig = parseInterfaceSignatures(luaDts, ns)
      .concat(parseInterfaceSignatures(robloxDts, ns));
    if (luaSig.length === 0) continue;
    // Dedupe by name.
    const seen = new Map();
    for (const s of luaSig) {
      if (!seen.has(s.name)) seen.set(s.name, s);
    }
    out[ns] = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
  return out;
}

/* ────────────────────────────────────────────────────────────────────── */
/*  API-Dump.json — classes, enums, datatypes                              */
/* ────────────────────────────────────────────────────────────────────── */

function classifyClasses(dump) {
  const classes = {};
  for (const cls of dump.Classes) {
    const entry = {
      extends: cls.Superclass && cls.Superclass !== '<<<ROOT>>>'
        ? cls.Superclass : null,
      tags: cls.Tags ?? [],
      properties: {},
      methods: {},
      events: {},
      callbacks: {},
    };
    for (const m of cls.Members ?? []) {
      const tags = m.Tags ?? [];
      // Skip removed/deprecated-but-not-deleted: keep them so coverage is
      // complete, but flag them. NotScriptable items can't be called from
      // script at all — exclude with reason.
      if (tags.includes('NotScriptable')) continue;
      switch (m.MemberType) {
        case 'Property':
          entry.properties[m.Name] = {
            type: typeRefToText(m.ValueType),
            tags,
            security: m.Security,
          };
          break;
        case 'Function':
          entry.methods[m.Name] = {
            params: (m.Parameters ?? []).map((p) => ({
              name: p.Name,
              type: typeRefToText(p.Type),
              hasDefault: !!p.Default,
            })),
            returnType: typeRefToText(m.ReturnType),
            tags,
            security: m.Security,
          };
          break;
        case 'Event':
          entry.events[m.Name] = {
            params: (m.Parameters ?? []).map((p) => ({
              name: p.Name,
              type: typeRefToText(p.Type),
            })),
            tags,
            security: m.Security,
          };
          break;
        case 'Callback':
          entry.callbacks[m.Name] = {
            params: (m.Parameters ?? []).map((p) => ({
              name: p.Name,
              type: typeRefToText(p.Type),
            })),
            returnType: typeRefToText(m.ReturnType),
            tags,
            security: m.Security,
          };
          break;
        default:
          break;
      }
    }
    classes[cls.Name] = entry;
  }
  return classes;
}

function typeRefToText(t) {
  if (!t) return 'unknown';
  // API-Dump fields: { Category, Name } sometimes; also tuple types
  // for return values.
  if (typeof t === 'string') return t;
  if (t.Name) return t.Name;
  return 'unknown';
}

function classifyEnums(dump) {
  const out = {};
  for (const e of dump.Enums) {
    out[e.Name] = (e.Items ?? []).map((it) => ({
      name: it.Name,
      value: it.Value,
      tags: it.Tags ?? [],
    })).sort((a, b) => a.value - b.value);
  }
  return out;
}

/* ────────────────────────────────────────────────────────────────────── */
/*  Datatype constructors (`.new`) and static factories                    */
/* ────────────────────────────────────────────────────────────────────── */

// API-Dump.json's `Constructors` field used to hold these; modern dumps
// expose datatype constructors via separate fields. Use a fixed list of
// known datatypes and consult @rbxts/types for their constructor + static
// signatures.

const ROBLOX_DATATYPES = [
  'Vector3', 'Vector2', 'Vector3int16', 'Vector2int16',
  'CFrame', 'Color3', 'BrickColor',
  'UDim', 'UDim2',
  'NumberRange', 'NumberSequence', 'NumberSequenceKeypoint',
  'ColorSequence', 'ColorSequenceKeypoint',
  'Region3', 'Region3int16', 'Rect', 'Ray',
  'RaycastParams', 'OverlapParams',
  'TweenInfo', 'Random', 'DateTime',
  'Faces', 'Axes', 'PhysicalProperties',
  'Path2DControlPoint', 'FloatCurveKey', 'RotationCurveKey',
  'CatalogSearchParams', 'Font', 'Path2DControlPoint',
];

function harvestDatatypes(robloxDts) {
  const out = {};
  for (const name of ROBLOX_DATATYPES) {
    // The .d.ts declares `interface <Type>Constructor { new (…): <Type>; … }`.
    const ctorIface = `${name}Constructor`;
    const sigs = parseInterfaceSignatures(robloxDts, ctorIface);
    const constructors = [];
    const staticMethods = [];
    for (const s of sigs) {
      if (s.name === 'new') {
        constructors.push(s);
      } else {
        staticMethods.push(s);
      }
    }
    if (constructors.length === 0 && staticMethods.length === 0) continue;
    out[name] = {
      constructors,
      staticMethods: staticMethods.sort((a, b) => a.name.localeCompare(b.name)),
    };
  }
  return out;
}

/* ────────────────────────────────────────────────────────────────────── */
/*  Emitters                                                              */
/* ────────────────────────────────────────────────────────────────────── */

function serializeJson(obj) {
  // Deterministic key order: lexicographic at every level.
  return JSON.stringify(obj, sortKeys, 2);
}

function sortKeys(_key, value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = value[k];
    return out;
  }
  return value;
}

function emitApiData({ classes, enums, stdlib, datatypes }) {
  const header = '// AUTO-GENERATED by scripts/build-api-macros.mjs. Do not edit by hand.\n'
    + '// Run `pnpm build` to regenerate.\n\n'
    + "import type { ApiData } from './types.js';\n\n";
  const data = { classes, enums, stdlib, datatypes };
  const body = `const data: ApiData = ${serializeJson(data)};\nexport default data;\n`;
  writeFileSync(resolve(OUT_DIR, 'api-data.ts'), header + body);
  console.error(`[build-api-macros] api-data.ts: ${Object.keys(classes).length} classes, ${Object.keys(enums).length} enums, ${Object.keys(stdlib).length} stdlib namespaces, ${Object.keys(datatypes).length} datatypes`);
}

function emitTypes() {
  const t = `// AUTO-GENERATED by scripts/build-api-macros.mjs. Do not edit by hand.

export interface ApiData {
  classes: Record<string, ClassEntry>;
  enums: Record<string, EnumItem[]>;
  stdlib: Record<string, StdlibFn[]>;
  datatypes: Record<string, DatatypeEntry>;
}

export interface ClassEntry {
  extends: string | null;
  tags: string[];
  properties: Record<string, PropertyEntry>;
  methods: Record<string, MethodEntry>;
  events: Record<string, EventEntry>;
  callbacks: Record<string, CallbackEntry>;
}

export interface PropertyEntry {
  type: string;
  tags: string[];
  security: unknown;
}

export interface MethodEntry {
  params: ParamEntry[];
  returnType: string;
  tags: string[];
  security: unknown;
}

export interface ParamEntry {
  name: string;
  type: string;
  hasDefault?: boolean;
}

export interface EventEntry {
  params: ParamEntry[];
  tags: string[];
  security: unknown;
}

export interface CallbackEntry {
  params: ParamEntry[];
  returnType: string;
  tags: string[];
  security: unknown;
}

export interface EnumItem {
  name: string;
  value: number;
  tags: string[];
}

export interface StdlibFn {
  name: string;
  args: StdlibArg[];
  returnText: string;
}

export interface StdlibArg {
  name: string;
  type: string;
  optional: boolean;
  rest: boolean;
}

export interface DatatypeEntry {
  constructors: StdlibFn[];
  staticMethods: StdlibFn[];
}
`;
  writeFileSync(resolve(OUT_DIR, 'types.ts'), t);
}

/** Map a @rbxts/types TS-type text to a SlotKind the cast-skip path
 *  understands. Returns `null` for complex / overloaded types — the gate
 *  needs the cast in those cases to satisfy TS overload resolution. */
function tsTypeToSlotKind(text) {
  if (!text) return null;
  const t = text.replace(/\s+/g, '');
  if (t === 'string') return 'string';
  if (t === 'number' || t === 'int' || t === 'float' || t === 'double') return 'number';
  if (t === 'boolean' || t === 'bool') return 'boolean';
  if (t === 'unknown') return 'any';
  if (t === 'number|string' || t === 'string|number') return 'number|string';
  if (t === 'Instance') return 'instance';
  return null;
}

function emitStdlibSlots(stdlib) {
  const out = {};
  for (const [ns, fns] of Object.entries(stdlib)) {
    for (const fn of fns) {
      const path = `${ns}.${fn.name}`;
      const slots = {};
      let rest;
      let any = false;
      for (let i = 0; i < fn.args.length; i += 1) {
        const a = fn.args[i];
        const kind = tsTypeToSlotKind(a.type);
        if (a.rest) {
          if (kind) rest = kind;
          break;
        }
        if (kind) {
          slots[i] = kind;
          any = true;
        }
      }
      // Only emit an entry when at least one slot is mappable. The cast
      // gate falls through to the default `Parameters<typeof>` wrap
      // otherwise — needed for overloaded callees like task.spawn.
      if (!any && !rest) continue;
      const entry = { slots };
      if (rest) entry.rest = rest;
      out[path] = entry;
    }
  }
  const header = '// AUTO-GENERATED by scripts/build-api-macros.mjs. Do not edit by hand.\n\n'
    + 'export type SlotKind = "string" | "number" | "boolean" | "number|string" | "instance" | "any";\n'
    + 'export interface SlotEntry {\n'
    + '  slots: Record<number, SlotKind>;\n'
    + '  rest?: SlotKind;\n'
    + '}\n\n';
  const body = `export const STDLIB_SLOTS: Record<string, SlotEntry> = ${serializeJson(out)};\n`;
  writeFileSync(resolve(OUT_DIR, 'stdlib-slots.ts'), header + body);
  console.error(`[build-api-macros] stdlib-slots.ts: ${Object.keys(out).length} entries`);
}

function emitDatatypeStaticSlots(datatypes) {
  const out = {};
  function buildEntry(fn) {
    const slots = {};
    let rest;
    let any = false;
    for (let i = 0; i < fn.args.length; i += 1) {
      const a = fn.args[i];
      const kind = tsTypeToSlotKind(a.type);
      if (a.rest) {
        if (kind) rest = kind;
        break;
      }
      if (kind) {
        slots[i] = kind;
        any = true;
      }
    }
    if (!any && !rest) return null;
    const e = { slots };
    if (rest) e.rest = rest;
    return e;
  }
  for (const [name, entry] of Object.entries(datatypes)) {
    for (const fn of entry.staticMethods) {
      const built = buildEntry(fn);
      if (built) out[`${name}.${fn.name}`] = built;
    }
    for (const fn of entry.constructors) {
      const built = buildEntry(fn);
      if (built) out[`${name}.new`] = built;
    }
  }
  const header = '// AUTO-GENERATED by scripts/build-api-macros.mjs. Do not edit by hand.\n\n'
    + "import type { SlotEntry } from './stdlib-slots.js';\n\n";
  const body = `export const DATATYPE_SLOTS: Record<string, SlotEntry> = ${serializeJson(out)};\n`;
  writeFileSync(resolve(OUT_DIR, 'datatype-slots.ts'), header + body);
  console.error(`[build-api-macros] datatype-slots.ts: ${Object.keys(out).length} entries`);
}

function emitExclusions(dump) {
  // Walk every API-Dump member and record those we deliberately skip.
  const exclusions = [];
  for (const cls of dump.Classes) {
    for (const m of cls.Members ?? []) {
      const tags = m.Tags ?? [];
      if (tags.includes('NotScriptable')) {
        exclusions.push({
          class: cls.Name,
          member: m.Name,
          kind: m.MemberType,
          reason: 'NotScriptable tag — Roblox prohibits script access',
        });
      }
    }
  }
  writeFileSync(
    resolve(OUT_DIR, 'exclusions.json'),
    serializeJson({ entries: exclusions.sort((a, b) =>
      `${a.class}.${a.member}`.localeCompare(`${b.class}.${b.member}`)
    ) }),
  );
  console.error(`[build-api-macros] exclusions.json: ${exclusions.length} entries`);
}

/* ────────────────────────────────────────────────────────────────────── */
/*  Entry point                                                            */
/* ────────────────────────────────────────────────────────────────────── */

const dump = await loadApiDump();
const types = loadStdlibTypes();
const stdlib = harvestStdlib(types);
const classes = classifyClasses(dump);
const enums = classifyEnums(dump);
const datatypes = harvestDatatypes(types.robloxDts);

emitTypes();
emitApiData({ classes, enums, stdlib, datatypes });
emitExclusions(dump);
emitStdlibSlots(stdlib);
emitDatatypeStaticSlots(datatypes);

// Macro registration files come next — emitted in subsequent passes after
// the data file lands and the dispatch logic in compileCall/compileExpr
// consults it.
console.error('[build-api-macros] done');
