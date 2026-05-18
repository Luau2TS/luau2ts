// Pass 4 of the architectural finish: narrow `Instance`-typed locals
// to a more-specific subclass when downstream member access only fits
// one subclass. E.g. `light: Instance` accessed via `light.Color` and
// `light.Material` narrows to `BasePart`. Tightens the receiver type
// so `light.Color = X` doesn't need a Record bridge.
//
// Conservative defaults: only narrows when EVERY observed member
// resolves to a single common subclass via api-data. If observed
// members fit multiple classes equally, leaves the local as Instance.

import type { BlockStat, Expr, Stat } from '../parser/index.js';
import { lookupClassProperty, lookupClassEvent, lookupClassMethod, apiData } from './macros/generated/dispatch.js';
import type { ClassOracle } from './oracle/index.js';

const CLASSES = apiData.classes;

/** For each Local in `root` currently tracked as `Instance`, return
 *  the narrowest subclass that has every observed member. Locals with
 *  ambiguous/empty observed accesses are omitted (caller keeps them
 *  as Instance). Only narrows to classes that exist in `@rbxts/types`
 *  (per `oracle.isClass`) — api-data covers Roblox's full API surface
 *  including classes not exposed in the TS bindings. */
export function inferInstanceNarrowings(
  root: BlockStat,
  candidateLocals: Set<string>,
  oracle: ClassOracle,
): Map<string, string> {
  const observed = new Map<string, Set<string>>();
  for (const name of candidateLocals) observed.set(name, new Set());

  const visit = (s: Stat | null | undefined): void => {
    if (!s) return;
    walkExpr(s, (e) => {
      if (e.type === 'IndexName' && e.expr.type === 'Local') {
        const set = observed.get(e.expr.name);
        if (set) set.add(e.index);
      }
    });
    switch (s.type) {
      case 'Block':
        for (const c of (s as { body: Stat[] }).body) visit(c);
        return;
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
  visit(root);

  const out = new Map<string, string>();
  for (const [name, members] of observed) {
    if (members.size === 0) continue;
    const cls = lowestCommonClassFor(members, oracle);
    if (cls && cls !== 'Instance') out.set(name, cls);
  }
  return out;
}

/** Find the most-specific class that declares every member in `members`.
 *  Returns null when no single class fits. Limited to Instance-rooted
 *  classes — service / RBXObject / RBXScriptSignal stay out. */
function lowestCommonClassFor(members: Set<string>, oracle: ClassOracle): string | null {
  // Candidate set starts as all Instance-rooted classes that are also
  // exposed in `@rbxts/types` (oracle.isClass). Pure api-data-only
  // classes (e.g. Flag, GuiMain) can't be referenced as TS types.
  const candidates: string[] = [];
  for (const name of Object.keys(CLASSES)) {
    if (!extendsInstance(name)) continue;
    if (!oracle.isClass(name)) continue;
    if (everyMemberIn(members, name)) candidates.push(name);
  }
  if (candidates.length === 0) return null;
  // Pick the SHALLOWEST class with all members. Going deeper risks
  // narrowing to an unrelated subclass that happens to also declare
  // the same members (e.g. both BindableEvent.Fire and
  // RocketPropulsion.Fire match `obj.Fire(...)`). The shallowest is the
  // most-likely intent and avoids false-positive narrowings.
  // Ties at the shallowest depth → don't narrow.
  let best: string | null = null;
  let bestDepth = Infinity;
  let ambiguous = false;
  for (const c of candidates) {
    const d = depth(c);
    if (d < bestDepth) {
      best = c;
      bestDepth = d;
      ambiguous = false;
    } else if (d === bestDepth) {
      ambiguous = true;
    }
  }
  return ambiguous ? null : best;
}

function extendsInstance(name: string): boolean {
  let cur: string | null = name;
  const seen = new Set<string>();
  while (cur && !seen.has(cur)) {
    if (cur === 'Instance') return true;
    seen.add(cur);
    cur = CLASSES[cur]?.extends ?? null;
  }
  return false;
}

function depth(name: string): number {
  let cur: string | null = name;
  let n = 0;
  const seen = new Set<string>();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    cur = CLASSES[cur]?.extends ?? null;
    n++;
  }
  return n;
}

function everyMemberIn(members: Set<string>, className: string): boolean {
  for (const m of members) {
    if (!classHasMember(className, m)) return false;
  }
  return true;
}

function classHasMember(className: string, member: string): boolean {
  return !!lookupClassProperty(className, member)
    || !!lookupClassMethod(className, member)
    || lookupClassEvent(className, member);
}

function walkExpr(node: unknown, visit: (e: Expr) => void): void {
  if (!node || typeof node !== 'object') return;
  const t = (node as { type?: string }).type;
  if (typeof t === 'string') visit(node as Expr);
  for (const v of Object.values(node as Record<string, unknown>)) {
    if (Array.isArray(v)) for (const it of v) walkExpr(it, visit);
    else if (v && typeof v === 'object') walkExpr(v, visit);
  }
}
