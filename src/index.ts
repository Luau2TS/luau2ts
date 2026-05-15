export {
  compile,
  type CompileOptions,
  type CompileResult,
} from './compile/index.js';
export type { CompatMode } from './compile/context.js';

export { loadProject, classifyFile } from './rojo/index.js';
export type {
  LoadedProject,
  LuauScriptEntry,
  RojoProjectFile,
  RojoProjectNode,
  ScriptKind,
} from './rojo/index.js';
