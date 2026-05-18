// Pass-A driver: walk a corpus of Luau sources, parse each, and run
// analyzeModuleReturn on every ModuleScript candidate to build the
// corpus index. Lifted from the inline pre-pass that the stress harness
// has been doing since the require-infer Pass 2 landed; the CLI's
// directory and project modes now share the same code path.

import ts from 'typescript';
import { parse } from '../../parser/index.js';
import { analyzeModuleReturn } from '../require-infer.js';
import { buildPromotionMap, collectCrossScriptCallSites } from './call-sites.js';
import type { CorpusIndex, ModuleIndexEntry } from './index.js';

export interface CorpusScript {
  /** Corpus key for this script — Roblox instance path or filesystem
   *  path-sans-extension. Used as the lookup key both when this script's
   *  own requires resolve other modules AND when other scripts'
   *  `require()` calls resolve to it. */
  corpusPath: string;
  source: string;
  /** Optional script-kind hint. When set to anything other than
   *  `'ModuleScript'`, return-shape inference is skipped (Scripts and
   *  LocalScripts don't export a return value). Unset means "attempt
   *  inference and let analyzeModuleReturn no-op on non-modules". */
  scriptKind?: 'ModuleScript' | 'Script' | 'LocalScript';
}

export async function buildCorpusIndex(
  scripts: readonly CorpusScript[],
): Promise<CorpusIndex> {
  const modules = new Map<string, ModuleIndexEntry>();
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
  const dummySF = ts.createSourceFile(
    '_dummy.ts',
    '',
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TS,
  );

  // Parse in parallel — WASM init amortizes across the batch and each
  // parse is independent. The analysis itself is fast and sequential.
  const parsedResults = await Promise.all(
    scripts.map(async (s) => {
      if (s.scriptKind && s.scriptKind !== 'ModuleScript') return null;
      try {
        const p = await parse(s.source);
        return p.root ? { script: s, root: p.root } : null;
      } catch {
        // Embedded rbxl scripts sometimes carry partial / obfuscated
        // sources that don't parse. Skip silently to match the stress
        // harness's prior behaviour.
        return null;
      }
    }),
  );

  // Pass B (cross-script): walk every parsed script, collect call
  // sites against require-bound locals. The result feeds Pass C's
  // property→method promotion.
  const allCallSites = parsedResults.flatMap((e) =>
    e ? collectCrossScriptCallSites(e.root, e.script.corpusPath) : [],
  );
  const promotions = buildPromotionMap(allCallSites);

  // Pass A + C combined: re-run analyzeModuleReturn with the
  // promotion set per module so the printed returnTypeText reflects
  // the upgraded classifications. The members map and the printed
  // type stay in lockstep — TS only sees the printed type, so both
  // must agree.
  for (const e of parsedResults) {
    if (!e) continue;
    const promote = promotions.get(e.script.corpusPath);
    const { type, recordMapFields, members } = analyzeModuleReturn(e.root, promote);
    if (!type) continue;
    const returnTypeText = printer.printNode(ts.EmitHint.Unspecified, type, dummySF);
    modules.set(e.script.corpusPath, {
      returnTypeText,
      recordMapFields,
      exportedMembers: new Map(members),
      exportedFns: new Map(),
      parentClass: null,
    });
  }

  return { modules };
}

/** Convenience: derive the compile() option maps from a corpus index.
 *  CLI consumers pass these into every per-script compile() call so the
 *  cross-script `require(X)` resolver can replace the `_LuauChild`
 *  fallback. */
export function deriveCompileMaps(index: CorpusIndex): {
  moduleReturnTypes: Map<string, string>;
  moduleRecordMapFields: Map<string, string[]>;
  moduleExportedMembers: Map<string, Map<string, 'method' | 'property' | 'recordMap'>>;
} {
  const moduleReturnTypes = new Map<string, string>();
  const moduleRecordMapFields = new Map<string, string[]>();
  const moduleExportedMembers = new Map<string, Map<string, 'method' | 'property' | 'recordMap'>>();
  for (const [path, entry] of index.modules) {
    if (entry.returnTypeText) moduleReturnTypes.set(path, entry.returnTypeText);
    if (entry.recordMapFields.length > 0) {
      moduleRecordMapFields.set(path, entry.recordMapFields);
    }
    if (entry.exportedMembers.size > 0) {
      moduleExportedMembers.set(path, new Map(entry.exportedMembers));
    }
  }
  return { moduleReturnTypes, moduleRecordMapFields, moduleExportedMembers };
}
