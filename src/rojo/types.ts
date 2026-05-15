export type ScriptKind = 'ModuleScript' | 'Script' | 'LocalScript';

export interface LuauScriptEntry {
  /** Path components from the project's DataModel root to this script's
   *  parent instance, then ending with the script's own name. Example:
   *  `['ReplicatedStorage', 'Shared', 'Util']` for a ModuleScript
   *  `Util` at `ReplicatedStorage/Shared/Util.luau`. */
  instancePath: string[];
  /** Whether the source file is a server-only Script, a client-only
   *  LocalScript, or a shared ModuleScript. Determined by the
   *  `.server.luau` / `.client.luau` / `.luau` filename suffix
   *  (or by `$className` on the Rojo project node, when set). */
  scriptKind: ScriptKind;
  /** Absolute filesystem path of the .luau / .lua source. */
  filePath: string;
  /** UTF-8 file contents. Loaded eagerly so a single project read can be
   *  fed straight into the compiler without further IO. */
  source: string;
}

export interface RojoProjectNode {
  $className?: string;
  $path?: string;
  $properties?: Record<string, unknown>;
  [childName: string]: unknown;
}

export interface RojoProjectFile {
  name?: string;
  tree: RojoProjectNode;
  servePort?: number;
  servePlaceIds?: number[];
}

export interface LoadedProject {
  /** The project file's `name` field, or the project file's filename if absent. */
  name: string;
  /** Absolute path to the project file (e.g. `/foo/default.project.json`). */
  projectFile: string;
  /** All discovered .luau / .lua scripts, in deterministic depth-first order. */
  scripts: LuauScriptEntry[];
}
