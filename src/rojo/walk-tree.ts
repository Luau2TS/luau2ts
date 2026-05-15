import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import type {
  LuauScriptEntry,
  RojoProjectNode,
  ScriptKind,
} from './types.js';

/** Classify a single filename by its Rojo-style suffix.
 *
 *  Returns:
 *  - `{ kind, baseName, isInit }` for recognised script files
 *  - `null` for anything we don't translate (json, csv, txt, unknown).
 *
 *  Suffix grammar (Rojo 7+ convention):
 *  - `init.luau` / `init.lua`               → ModuleScript (folder collapses)
 *  - `init.server.luau` / `init.server.lua` → Script
 *  - `init.client.luau` / `init.client.lua` → LocalScript
 *  - `<name>.luau` / `<name>.lua`           → ModuleScript named <name>
 *  - `<name>.server.luau` / `<name>.server.lua` → Script named <name>
 *  - `<name>.client.luau` / `<name>.client.lua` → LocalScript named <name>
 *
 *  Order matters: `foo.server.luau` must match `.server.luau` before
 *  `.luau` so we check the longer suffix first.
 */
export function classifyFile(filename: string): {
  kind: ScriptKind;
  baseName: string;
  isInit: boolean;
} | null {
  const lower = filename.toLowerCase();
  const suffixes: { tail: string; kind: ScriptKind }[] = [
    { tail: '.server.luau', kind: 'Script' },
    { tail: '.server.lua', kind: 'Script' },
    { tail: '.client.luau', kind: 'LocalScript' },
    { tail: '.client.lua', kind: 'LocalScript' },
    { tail: '.luau', kind: 'ModuleScript' },
    { tail: '.lua', kind: 'ModuleScript' },
  ];
  for (const { tail, kind } of suffixes) {
    if (lower.endsWith(tail)) {
      const baseName = filename.slice(0, filename.length - tail.length);
      const isInit = baseName === 'init';
      return { kind, baseName, isInit };
    }
  }
  return null;
}

/** `$className` strings Rojo uses for explicit script-class assignment.
 *  A node's `$className` overrides the kind inferred from its `$path`. */
const SCRIPT_CLASS_NAMES: Record<string, ScriptKind> = {
  ModuleScript: 'ModuleScript',
  Script: 'Script',
  LocalScript: 'LocalScript',
};

/** Walk a single Rojo tree node, accumulating script entries.
 *
 *  - If the node has a `$path` pointing to a `.luau`/`.lua` file, record a
 *    single script entry at the current instance path.
 *  - If `$path` points to a directory, walk it: subdirectories nest as
 *    Folder instances; files become scripts; `init.*` files collapse the
 *    containing folder into a script of the matching kind.
 *  - If the node has children (keys that don't start with `$`), recurse
 *    into each child with its key as the next path component.
 */
export async function walkNode(
  node: RojoProjectNode,
  instancePath: string[],
  projectDir: string,
  out: LuauScriptEntry[],
): Promise<void> {
  if (node.$path !== undefined) {
    const abs = resolve(projectDir, node.$path);
    await walkPath(abs, instancePath, node.$className, out);
  }

  // Recurse into named children (anything not starting with `$`).
  // Sort keys for deterministic output across filesystems / platforms.
  const childKeys = Object.keys(node)
    .filter((k) => !k.startsWith('$'))
    .sort();
  for (const childName of childKeys) {
    const childNode = node[childName] as RojoProjectNode;
    if (typeof childNode !== 'object' || childNode === null) continue;
    await walkNode(childNode, [...instancePath, childName], projectDir, out);
  }
}

/** Walk a filesystem entry pointed at by a `$path`. */
async function walkPath(
  absPath: string,
  instancePath: string[],
  explicitClassName: string | undefined,
  out: LuauScriptEntry[],
): Promise<void> {
  let st;
  try {
    st = await stat(absPath);
  } catch {
    // Missing $path is a Rojo project error, but we tolerate it here so a
    // partial project still yields the scripts it does have. The CLI can
    // surface a warning to the user.
    return;
  }

  if (st.isFile()) {
    const cls = classifyFile(basename(absPath));
    if (!cls) return;
    const kind = (explicitClassName && SCRIPT_CLASS_NAMES[explicitClassName])
      || cls.kind;
    const source = await readFile(absPath, 'utf8');
    out.push({ instancePath, scriptKind: kind, filePath: absPath, source });
    return;
  }

  if (!st.isDirectory()) return;

  // Directory: scan for init.* first to decide whether the directory
  // itself collapses into a script, then recurse into children.
  const entries = (await readdir(absPath)).sort();
  let initKind: ScriptKind | null = null;
  let initFile: string | null = null;
  for (const entry of entries) {
    const cls = classifyFile(entry);
    if (cls && cls.isInit) {
      initKind = cls.kind;
      initFile = join(absPath, entry);
      break;
    }
  }

  if (initFile) {
    const kind = (explicitClassName && SCRIPT_CLASS_NAMES[explicitClassName])
      || initKind!;
    const source = await readFile(initFile, 'utf8');
    out.push({ instancePath, scriptKind: kind, filePath: initFile, source });
  }

  for (const entry of entries) {
    const entryPath = join(absPath, entry);
    const entryStat = await stat(entryPath);
    if (entryStat.isDirectory()) {
      await walkPath(entryPath, [...instancePath, entry], undefined, out);
      continue;
    }
    if (!entryStat.isFile()) continue;
    const cls = classifyFile(entry);
    if (!cls || cls.isInit) continue;
    const source = await readFile(entryPath, 'utf8');
    out.push({
      instancePath: [...instancePath, cls.baseName],
      scriptKind: cls.kind,
      filePath: entryPath,
      source,
    });
  }
}

/** Resolve the project file path: accept either a direct path to a
 *  `*.project.json` file or a directory containing `default.project.json`. */
export async function resolveProjectFile(arg: string): Promise<string> {
  const abs = resolve(arg);
  const st = await stat(abs);
  if (st.isFile()) return abs;
  if (st.isDirectory()) return join(abs, 'default.project.json');
  throw new Error(`Project path is neither file nor directory: ${arg}`);
}

export function projectDirOf(projectFile: string): string {
  return dirname(projectFile);
}

export function defaultProjectName(projectFile: string): string {
  const base = basename(projectFile);
  // Strip `.project.json` to derive a stable project name.
  const ext = extname(base);
  if (ext === '.json') {
    const withoutJson = base.slice(0, -ext.length);
    if (withoutJson.endsWith('.project')) {
      return withoutJson.slice(0, -'.project'.length) || 'project';
    }
    return withoutJson;
  }
  return base;
}
