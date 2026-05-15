// Hand-written shim for the Emscripten-generated luau-analyzer.mjs.
// The module exports a default factory that returns a Promise<EmModule>.
// We only declare the runtime methods our loader uses.

export interface EmModule {
  HEAPU8: Uint8Array;
  _malloc(size: number): number;
  _free(ptr: number): void;
  _luau_analyze(srcPtr: number, srcLen: number): number;
  _luau_analyzer_free(ptr: number): void;
  UTF8ToString(ptr: number): string;
}

export interface EmModuleConfig {
  locateFile?: (path: string, prefix: string) => string;
  print?: (msg: string) => void;
  printErr?: (msg: string) => void;
}

declare const createLuauAnalyzerModule: (config?: EmModuleConfig) => Promise<EmModule>;
export default createLuauAnalyzerModule;
