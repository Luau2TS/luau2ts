// Browser-safe public surface. Pulls only the compiler and the
// inlined WASM parser. The Rojo project reader (which needs Node's
// `fs/promises`) lives at the `luau2ts/rojo` subpath so this entry
// point can be bundled for the browser without dragging Node modules
// into the bundle graph.
export {
  compile,
  type CompileOptions,
  type CompileResult,
} from './compile/index.js';
export type { CompatMode } from './compile/context.js';
