export type Severity = 'error' | 'warning';

export interface Diagnostic {
  severity: Severity;
  /** Symbolic code from the Luau analyzer (e.g. `TypeMismatch`,
   *  `UnknownSymbol`) for type errors, or a lint code (e.g.
   *  `LocalShadow`, `UnusedFunction`) for warnings. */
  code: string;
  message: string;
  /** 1-indexed line/column matching the convention in luau2ts core. */
  line: number;
  col: number;
  endLine: number;
  endCol: number;
}

/** Raw shape emitted by the WASM wrapper. Used internally; the public
 *  `analyze()` function maps these into `Diagnostic` objects with the
 *  severity tag set. */
export interface RawAnalyzerResult {
  errors: Array<{
    line: number;
    col: number;
    endLine: number;
    endCol: number;
    code: string;
    message: string;
  }>;
  warnings: Array<{
    line: number;
    col: number;
    endLine: number;
    endCol: number;
    code: string;
    message: string;
  }>;
}
