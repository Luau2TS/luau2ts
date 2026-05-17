// API-data-driven dispatch helpers. Used by the main compiler (compileCall,
// compileExpr IndexName) BEFORE the inference fallback paths fire — so a
// known-class method/property emits with proper Parameters + return-type
// casts straight from the API surface, not from heuristic class detection.

import apiData from './api-data.js';
import type { ClassEntry, MethodEntry, PropertyEntry, ParamEntry, StdlibFn } from './types.js';

const classes: Record<string, ClassEntry> = apiData.classes;

/** True when `name` is `Instance` or a class that transitively extends
 *  Instance (per api-data's extends chain). */
export function isInstanceClass(name: string): boolean {
  let cur: string | null = name;
  const seen = new Set<string>();
  while (cur && !seen.has(cur)) {
    if (cur === 'Instance') return true;
    seen.add(cur);
    cur = classes[cur]?.extends ?? null;
  }
  return false;
}

/** Walk the extends chain (most specific → least) and return the first
 *  class entry that declares `methodName`. */
export function lookupClassMethod(className: string, methodName: string): MethodEntry | undefined {
  let cur: string | null = className;
  const guard = new Set<string>();
  while (cur && !guard.has(cur)) {
    guard.add(cur);
    const entry: ClassEntry | undefined = classes[cur];
    if (!entry) return undefined;
    const m = entry.methods[methodName];
    if (m) return m;
    cur = entry.extends;
  }
  return undefined;
}

/** Walk the extends chain and return the first class entry that declares
 *  `propName` (either as a property or as an event / callback). */
export function lookupClassProperty(className: string, propName: string): PropertyEntry | undefined {
  let cur: string | null = className;
  const guard = new Set<string>();
  while (cur && !guard.has(cur)) {
    guard.add(cur);
    const entry: ClassEntry | undefined = classes[cur];
    if (!entry) return undefined;
    const p = entry.properties[propName];
    if (p) return p;
    cur = entry.extends;
  }
  return undefined;
}

/** Walk the extends chain and check if `name` is an event/callback (used
 *  for signal-method receiver casts). */
export function lookupClassEvent(className: string, eventName: string): boolean {
  let cur: string | null = className;
  const guard = new Set<string>();
  while (cur && !guard.has(cur)) {
    guard.add(cur);
    const entry: ClassEntry | undefined = classes[cur];
    if (!entry) return false;
    if (entry.events[eventName] || entry.callbacks[eventName]) return true;
    cur = entry.extends;
  }
  return false;
}

/** Lookup stdlib function. `ns` is `string`/`math`/etc.; `name` is the
 *  function within. */
export function lookupStdlibFn(ns: string, name: string): StdlibFn | undefined {
  const list = apiData.stdlib[ns];
  if (!list) return undefined;
  return list.find((f) => f.name === name);
}

/** Map an API-Dump.json type text to a simplified `SlotKind` used by the
 *  arg-cast skip logic in `castArgsForCall`. */
export function apiTypeToSlotKind(text: string): 'string' | 'number' | 'boolean' | 'number|string' | 'instance' | 'any' | undefined {
  if (!text) return undefined;
  const t = text.replace(/\s+/g, '').replace(/\|undefined$/, '');
  switch (t) {
    case 'string': return 'string';
    case 'number':
    case 'int':
    case 'int64':
    case 'float':
    case 'double': return 'number';
    case 'boolean':
    case 'bool': return 'boolean';
    case 'Instance': return 'instance';
    default: return undefined;
  }
}

/** Express an API-Dump.json type text as a TS type reference string the
 *  emitter can drop directly into `as <TS-text>`. Returns `undefined`
 *  for types we don't yet model (function types, generics, etc.). */
export function apiTypeToTsText(text: string): string | undefined {
  if (!text || text === 'unknown' || text === 'any' || text === 'void') return undefined;
  // API-Dump.json sometimes wraps types in `?` for optional; strip and add `| undefined`.
  const optional = text.endsWith('?');
  const base = optional ? text.slice(0, -1) : text;
  // Atomic primitives.
  if (/^(string|boolean|bool|number|int|int64|float|double)$/.test(base)) {
    const norm = base === 'bool' ? 'boolean'
      : /^(int|int64|float|double)$/.test(base) ? 'number'
      : base;
    return optional ? `${norm} | undefined` : norm;
  }
  // Class names or enum names — assume they're declared globally by @rbxts/types.
  if (/^[A-Z][\w.]*$/.test(base)) {
    return optional ? `${base} | undefined` : base;
  }
  return undefined;
}

export { apiData };
export type { MethodEntry, PropertyEntry, ParamEntry, StdlibFn };
