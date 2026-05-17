// Read-side API around the @rbxts/types oracle data.
import data from './data.generated.js';
import type { ClassEntry, MethodSig } from './types.js';
import { CONVENTIONAL_CHILDREN } from './name-table.js';

export type OracleType =
  | { kind: 'class'; name: string; nullable?: boolean }
  | { kind: 'primitive'; name: 'number' | 'string' | 'boolean' | 'unknown' }
  | { kind: 'array'; element: OracleType }
  | { kind: 'union'; members: OracleType[] }
  | { kind: 'raw'; text: string };

function parseTypeText(text: string | undefined): OracleType {
  if (!text) return { kind: 'primitive', name: 'unknown' };
  const trimmed = text.replace(/^\(|\)$/g, '').trim();
  const parts = trimmed.split('|').map(s => s.trim()).filter(Boolean);
  if (parts.length > 1) {
    const nullable = parts.some(p => p === 'undefined' || p === 'null');
    const rest = parts.filter(p => p !== 'undefined' && p !== 'null');
    if (rest.length === 1) {
      const inner = parseTypeText(rest[0]!);
      if (inner.kind === 'class') {
        const wantNullable = nullable || inner.nullable;
        return wantNullable ? { kind: 'class', name: inner.name, nullable: true } : { kind: 'class', name: inner.name };
      }
      return inner;
    }
    return { kind: 'union', members: parts.map(parseTypeText) };
  }
  if (trimmed === 'string' || trimmed === 'number' || trimmed === 'boolean') {
    return { kind: 'primitive', name: trimmed as 'string' | 'number' | 'boolean' };
  }
  if (trimmed === 'unknown' || trimmed === 'any') {
    return { kind: 'primitive', name: 'unknown' };
  }
  const arrayMatch = /^(?:ReadonlyArray|Array)<(.+)>$/.exec(trimmed);
  if (arrayMatch) {
    return { kind: 'array', element: parseTypeText(arrayMatch[1]) };
  }
  const shorthandArray = /^(.+)\[\]$/.exec(trimmed);
  if (shorthandArray) {
    return { kind: 'array', element: parseTypeText(shorthandArray[1]) };
  }
  if (/^[A-Z][A-Za-z0-9_]*$/.test(trimmed) && data.classes[trimmed]) {
    return { kind: 'class', name: trimmed };
  }
  return { kind: 'raw', text };
}

function pickOverload(sigs: MethodSig | MethodSig[], argCount: number): MethodSig {
  if (!Array.isArray(sigs)) return sigs;
  for (const s of sigs) {
    if (argCount >= s.paramCount && argCount <= s.paramCount + (s.optionalParams ?? 0)) {
      return s;
    }
  }
  return sigs[0]!;
}

function entry(className: string): ClassEntry | undefined {
  return data.classes[className];
}

export interface ClassOracle {
  isClass(name: string): boolean;
  extendsChain(name: string): readonly string[];
  isA(name: string, candidate: string): boolean;
  propertyType(className: string, prop: string): OracleType | null;
  methodReturnType(className: string, method: string, argCount: number): OracleType | null;
  serviceClass(name: string): string | null;
  isService(name: string): boolean;
  isVector3TypedProperty(prop: string): boolean;
  childNameClass(name: string): string | null;
  /** WaitForChild semantics: literal name → name-table class. Else honest Instance. */
  waitForChildResult(receiverClass: string | undefined, literalName: string | undefined, argCount: 1 | 2): {
    type: string;
    nullable: boolean;
  };
  /** FindFirstChild semantics: always optional. literal name → name-table or Instance. */
  findFirstChildResult(receiverClass: string | undefined, literalName: string | undefined): {
    type: string;
    nullable: boolean;
  };
  findFirstChildOfClassResult(className: string): string;
}

class ClassOracleImpl implements ClassOracle {
  isClass(name: string): boolean {
    return !!entry(name);
  }
  extendsChain(name: string): readonly string[] {
    const out: string[] = [];
    let cur: string | undefined = name;
    while (cur) {
      out.push(cur);
      cur = entry(cur)?.extends;
    }
    return out;
  }
  isA(name: string, candidate: string): boolean {
    return this.extendsChain(name).includes(candidate);
  }
  propertyType(className: string, prop: string): OracleType | null {
    for (const cls of this.extendsChain(className)) {
      const p = entry(cls)?.properties?.[prop];
      if (p) return parseTypeText(p.type);
    }
    return null;
  }
  methodReturnType(className: string, method: string, argCount: number): OracleType | null {
    for (const cls of this.extendsChain(className)) {
      const m = entry(cls)?.methods?.[method];
      if (m) return parseTypeText(pickOverload(m, argCount).returnText);
    }
    return null;
  }
  serviceClass(name: string): string | null {
    return data.services[name] ?? null;
  }
  isService(name: string): boolean {
    return name in data.services;
  }
  isVector3TypedProperty(prop: string): boolean {
    // Use the build-time set, but explicitly include canonical Vector3 names
    // that might come from non-Roblox-class shapes too.
    return data.vector3Properties.includes(prop) || VECTOR3_FALLBACK.has(prop);
  }
  childNameClass(name: string): string | null {
    return CONVENTIONAL_CHILDREN[name] ?? null;
  }
  waitForChildResult(_receiverClass: string | undefined, literalName: string | undefined, argCount: 1 | 2): { type: string; nullable: boolean } {
    // 2-arg form returns Instance | undefined regardless.
    if (argCount === 2) return { type: 'Instance', nullable: true };
    if (literalName) {
      const named = this.childNameClass(literalName);
      if (named) return { type: named, nullable: false };
    }
    return { type: 'Instance', nullable: false };
  }
  findFirstChildResult(_receiverClass: string | undefined, literalName: string | undefined): { type: string; nullable: boolean } {
    if (literalName) {
      const named = this.childNameClass(literalName);
      if (named) return { type: named, nullable: true };
    }
    return { type: 'Instance', nullable: true };
  }
  findFirstChildOfClassResult(className: string): string {
    if (data.instancesIndex[className]) return data.instancesIndex[className];
    return 'Instance';
  }
}

const VECTOR3_FALLBACK = new Set([
  'Position', 'Size', 'Velocity', 'RotVelocity', 'AssemblyLinearVelocity', 'AssemblyAngularVelocity',
  'WalkToPoint', 'CameraOffset', 'TopSurface', 'BottomSurface',
]);

let singleton: ClassOracle | null = null;
export function getOracle(): ClassOracle {
  if (!singleton) singleton = new ClassOracleImpl();
  return singleton;
}
export { parseTypeText };
