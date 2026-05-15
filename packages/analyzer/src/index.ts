import createLuauAnalyzerModule, { type EmModule } from './wasm/luau-analyzer.mjs';
import type { Diagnostic, RawAnalyzerResult } from './types.js';

export type { Diagnostic, Severity } from './types.js';

let modulePromise: Promise<EmModule> | null = null;

function loadModule(): Promise<EmModule> {
  modulePromise ??= createLuauAnalyzerModule();
  return modulePromise;
}

/** Run Luau's official type checker against a single source string.
 *  Returns the union of type errors (severity 'error') and lint
 *  warnings (severity 'warning'). Empty array on clean code.
 *
 *  The first call loads the WASM module (~5 MB). Subsequent calls
 *  reuse the cached module. The analyzer is stateless across calls;
 *  feed it whole files, not partial snippets. */
export async function analyze(source: string): Promise<Diagnostic[]> {
  const m = await loadModule();
  const bytes = new TextEncoder().encode(source);
  const ptr = m._malloc(bytes.length);
  if (!ptr) throw new Error('luau-analyzer: malloc failed');
  try {
    m.HEAPU8.set(bytes, ptr);
    const resultPtr = m._luau_analyze(ptr, bytes.length);
    if (!resultPtr) throw new Error('luau-analyzer: analyze returned null');
    const json = m.UTF8ToString(resultPtr);
    const raw = JSON.parse(json) as RawAnalyzerResult;
    const diagnostics: Diagnostic[] = [];
    for (const e of raw.errors) {
      diagnostics.push({
        severity: 'error',
        code: e.code,
        message: e.message,
        line: e.line,
        col: e.col,
        endLine: e.endLine,
        endCol: e.endCol,
      });
    }
    for (const w of raw.warnings) {
      diagnostics.push({
        severity: 'warning',
        code: w.code,
        message: w.message,
        line: w.line,
        col: w.col,
        endLine: w.endLine,
        endCol: w.endCol,
      });
    }
    return diagnostics;
  } finally {
    m._free(ptr);
  }
}
