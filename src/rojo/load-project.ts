import { readFile } from 'node:fs/promises';
import type {
  LoadedProject,
  LuauScriptEntry,
  RojoProjectFile,
} from './types.js';
import {
  defaultProjectName,
  projectDirOf,
  resolveProjectFile,
  walkNode,
} from './walk-tree.js';

/** Load a Rojo project file and produce the flat list of Luau scripts it
 *  describes, ready to feed to `compile()`. Accepts either a direct path
 *  to a `*.project.json` file or a directory containing
 *  `default.project.json`.
 *
 *  This is intentionally a read-only walker: it does not synthesize JSON
 *  modules, does not produce a Roblox instance IR, and does not watch
 *  for file changes. For runtime / HMR use cases, depend on a separate
 *  package built on top of this one. */
export async function loadProject(projectArg: string): Promise<LoadedProject> {
  const projectFile = await resolveProjectFile(projectArg);
  const raw = await readFile(projectFile, 'utf8');
  let parsed: RojoProjectFile;
  try {
    parsed = JSON.parse(raw) as RojoProjectFile;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse ${projectFile}: ${msg}`);
  }
  if (!parsed.tree || typeof parsed.tree !== 'object') {
    throw new Error(`${projectFile}: missing or invalid "tree" property`);
  }

  const projectDir = projectDirOf(projectFile);
  const scripts: LuauScriptEntry[] = [];
  await walkNode(parsed.tree, [], projectDir, scripts);

  return {
    name: parsed.name ?? defaultProjectName(projectFile),
    projectFile,
    scripts,
  };
}
