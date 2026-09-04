import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { compile, type CompileOptions, type CompileResult } from '../compile/index.js';
import {
  buildCorpusIndex,
  deriveCompileMaps,
  renderDts,
  type CorpusIndex,
  type CorpusScript,
} from '../compile/cross-script/index.js';
import { loadProject } from '../rojo/index.js';
import { classifyFile } from '../rojo/walk-tree.js';
import type { LuauScriptEntry } from '../rojo/types.js';
import type { CompatMode } from '../compile/context.js';

export interface ModeOptions {
  mode: CompatMode;
  sourcemap: boolean;
  checkTs: boolean | undefined;
  checkLuau: boolean | undefined;
  typeCheck: boolean | undefined;
}

function compileOptionsFor(
  sourceFile: string,
  opts: ModeOptions,
): CompileOptions {
  const out: CompileOptions = {
    sourceFile,
    compatMode: opts.mode,
  };
  if (opts.sourcemap) out.sourceMap = true;
  // Forward only EXPLICIT overrides; leave defaults to compile().
  if (opts.checkTs !== undefined) out.postEmitCheck = opts.checkTs;
  if (opts.checkLuau !== undefined) out.preEmitCheck = opts.checkLuau;
  if (opts.typeCheck !== undefined) out.typeCheck = opts.typeCheck;
  return out;
}

function reportErrors(filePath: string, result: CompileResult): boolean {
  if (result.errors.length === 0) return false;
  for (const err of result.errors) {
    // Parser/check errors carry a loc: { start: { line, col }, end }.
    // Walk through both shapes defensively so a future error variant
    // with a flat {line, col} still formats sensibly.
    const e = err as {
      message?: string;
      line?: number;
      col?: number;
      loc?: { start?: { line?: number; col?: number } };
    };
    const line = e.loc?.start?.line ?? e.line ?? 0;
    const col = e.loc?.start?.col ?? e.col ?? 0;
    const msg = e.message ?? String(err);
    process.stderr.write(`${filePath}:${line}:${col}: ${msg}\n`);
  }
  return true;
}

async function writeCompiled(
  outPath: string,
  result: CompileResult,
  sourcemap: boolean,
): Promise<void> {
  await mkdir(dirname(outPath), { recursive: true });
  let source = result.source;
  if (sourcemap && result.sourceMap) {
    const mapPath = `${outPath}.map`;
    await writeFile(mapPath, JSON.stringify(result.sourceMap), 'utf8');
    source += `//# sourceMappingURL=${basename(mapPath)}\n`;
  }
  await writeFile(outPath, source, 'utf8');
}

/** Translate a .luau source filename to its .ts counterpart, preserving
 *  Rojo-style `.server` / `.client` suffixes so the output still maps to
 *  the original instance kind. */
/** Output-relative `.ts` path → module path for import specifiers
 *  (POSIX separators, extension stripped). */
function modulePathOf(outRel: string): string {
  const posix = outRel.split(/[\\/]/).join('/');
  return posix.endsWith('.ts') ? posix.slice(0, -3) : posix;
}

function tsCounterpart(filename: string): string {
  const lower = filename.toLowerCase();
  const replacements: { from: string; to: string }[] = [
    { from: '.server.luau', to: '.server.ts' },
    { from: '.server.lua', to: '.server.ts' },
    { from: '.client.luau', to: '.client.ts' },
    { from: '.client.lua', to: '.client.ts' },
    { from: '.luau', to: '.ts' },
    { from: '.lua', to: '.ts' },
  ];
  for (const { from, to } of replacements) {
    if (lower.endsWith(from)) {
      return filename.slice(0, filename.length - from.length) + to;
    }
  }
  return filename;
}

/** Translate an absolute filesystem path to a corpus key by stripping
 *  the .luau / .lua extension (and the .server / .client suffix). The
 *  index keys with this form, and per-script compile() consumes it as
 *  `corpusPath` so `require(script.Parent.X)` resolves consistently. */
function filesystemToCorpusPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  return normalized.replace(/\.(server|client)\.lua[u]?$/i, '').replace(/\.lua[u]?$/i, '');
}

/** Emit a .d.ts for the given corpus entry into `outputRoot/.types/<rel>`,
 *  where `<rel>` mirrors the compiled-`.ts` layout but ends in `.d.ts`.
 *  Skips quietly when the module's inferred return shape is empty (no
 *  signal to publish), when the script isn't a ModuleScript (Scripts and
 *  LocalScripts don't export a return value), or when the emit mode
 *  isn't rbxts (the .d.ts references @rbxts/types globals that don't
 *  exist in native mode). */
async function emitDtsIfApplicable(args: {
  outputRoot: string;
  outRel: string;
  corpusPath: string;
  scriptKind: 'ModuleScript' | 'Script' | 'LocalScript' | undefined;
  index: CorpusIndex;
  compatMode: CompatMode;
}): Promise<void> {
  if (args.compatMode !== 'rbxts') return;
  if (args.scriptKind && args.scriptKind !== 'ModuleScript') return;
  const entry = args.index.modules.get(args.corpusPath);
  if (!entry) return;
  const text = renderDts(entry);
  if (!text) return;
  const dtsRel = args.outRel.replace(/\.ts$/, '.d.ts');
  const dtsPath = join(args.outputRoot, '.types', dtsRel);
  await mkdir(dirname(dtsPath), { recursive: true });
  await writeFile(dtsPath, text, 'utf8');
}

/** Single-file mode. If `outputArg` is undefined, writes to stdout. */
export async function compileFileMode(
  inputArg: string,
  outputArg: string | undefined,
  opts: ModeOptions,
): Promise<number> {
  const abs = resolve(inputArg);
  const source = await readFile(abs, 'utf8');
  const result = await compile(source, compileOptionsFor(abs, opts));
  const hadErrors = reportErrors(abs, result);

  if (outputArg === undefined || outputArg === '-') {
    process.stdout.write(result.source);
    if (opts.sourcemap && result.sourceMap) {
      process.stderr.write(
        `[luau2ts] --sourcemap with stdout is a no-op; pass -o to emit a .ts.map.\n`,
      );
    }
  } else {
    await writeCompiled(resolve(outputArg), result, opts.sourcemap);
  }
  return hadErrors ? 1 : 0;
}

interface DirEntry {
  filePath: string;
  source: string;
  corpusPath: string;
  scriptKind: 'ModuleScript' | 'Script' | 'LocalScript';
}

/** Directory mode. Walks every `.luau`/`.lua` under `inputDir` and writes
 *  a mirrored tree under `outputDir`. */
export async function compileDirMode(
  inputArg: string,
  outputArg: string,
  opts: ModeOptions,
): Promise<number> {
  const inputRoot = resolve(inputArg);
  const outputRoot = resolve(outputArg);
  const inputStat = await stat(inputRoot);
  if (!inputStat.isDirectory()) {
    throw new Error(`Not a directory: ${inputArg}`);
  }

  // Single walk: collect every source, build the cross-script index
  // from it, then re-iterate to compile with the index threaded in.
  // Reading sources twice would double IO; building the index inline
  // during compile would force a per-script first-pass that doesn't
  // see modules later in the walk order.
  const entries: DirEntry[] = [];
  await walkDir(inputRoot, async (filePath) => {
    const cls = classifyFile(basename(filePath));
    if (!cls) return;
    const source = await readFile(filePath, 'utf8');
    entries.push({
      filePath,
      source,
      corpusPath: filesystemToCorpusPath(filePath),
      scriptKind: cls.kind,
    });
  });

  const { index, moduleReturnTypes, moduleRecordMapFields, moduleExportedMembers } = await buildCorpus(
    entries.map((e) => ({
      corpusPath: e.corpusPath,
      source: e.source,
      scriptKind: e.scriptKind,
    })),
  );

  const moduleOutPaths = new Map<string, string>();
  for (const e of entries) {
    const rel = relative(inputRoot, e.filePath);
    moduleOutPaths.set(e.corpusPath, modulePathOf(join(dirname(rel), tsCounterpart(basename(rel)))));
  }

  let anyErrors = false;
  for (const e of entries) {
    const base = compileOptionsFor(e.filePath, opts);
    const rel = relative(inputRoot, e.filePath);
    const outRel = join(dirname(rel), tsCounterpart(basename(rel)));
    const result = await compile(e.source, {
      ...base,
      corpusPath: e.corpusPath,
      moduleReturnTypes,
      moduleRecordMapFields,
      moduleExportedMembers,
      moduleOutPaths,
      outPath: modulePathOf(outRel),
    });
    if (reportErrors(e.filePath, result)) anyErrors = true;
    await writeCompiled(join(outputRoot, outRel), result, opts.sourcemap);
    await emitDtsIfApplicable({
      outputRoot,
      outRel,
      corpusPath: e.corpusPath,
      scriptKind: e.scriptKind,
      index,
      compatMode: opts.mode,
    });
  }

  process.stderr.write(`[luau2ts] compiled ${entries.length} file(s) into ${outputRoot}\n`);
  return anyErrors ? 1 : 0;
}

async function walkDir(
  dir: string,
  visit: (filePath: string) => Promise<void>,
): Promise<void> {
  const entries = await readdir(dir);
  for (const entry of entries.sort()) {
    const full = join(dir, entry);
    const st = await stat(full);
    if (st.isDirectory()) {
      await walkDir(full, visit);
    } else if (st.isFile()) {
      await visit(full);
    }
  }
}

/** Rojo project mode. Walks `default.project.json` (or the given file)
 *  and emits one `.ts` per discovered Luau script, mirroring the project's
 *  on-disk layout under `outputDir`. */
export async function compileProjectMode(
  projectArg: string,
  outputArg: string,
  opts: ModeOptions,
): Promise<number> {
  const project = await loadProject(projectArg);
  const outputRoot = resolve(outputArg);
  const projectDir = dirname(project.projectFile);

  // Project mode has true Roblox instance paths from the Rojo tree
  // (rather than the filesystem-derived corpus paths dir mode falls
  // back to). Pass those directly so `require(game.ReplicatedStorage.X)`
  // and `require(script.Parent.X)` resolve through the same keys.
  const corpusScripts: CorpusScript[] = project.scripts.map((s) => ({
    corpusPath: instancePathToCorpusPath(s.instancePath),
    source: s.source,
    scriptKind: s.scriptKind,
  }));
  const { index, moduleReturnTypes, moduleRecordMapFields, moduleExportedMembers } = await buildCorpus(corpusScripts);

  const moduleOutPaths = new Map<string, string>();
  for (const entry of project.scripts) {
    const rel = relative(projectDir, entry.filePath);
    moduleOutPaths.set(
      instancePathToCorpusPath(entry.instancePath),
      modulePathOf(join(dirname(rel), tsCounterpart(basename(rel)))),
    );
  }

  let anyErrors = false;
  for (const entry of project.scripts) {
    const corpusPath = instancePathToCorpusPath(entry.instancePath);
    const base = compileOptionsFor(entry.filePath, opts);
    const rel = relative(projectDir, entry.filePath);
    const outRel = join(dirname(rel), tsCounterpart(basename(rel)));
    const result = await compile(entry.source, {
      ...base,
      corpusPath,
      moduleReturnTypes,
      moduleRecordMapFields,
      moduleExportedMembers,
      moduleOutPaths,
      outPath: modulePathOf(outRel),
    });
    if (reportErrors(entry.filePath, result)) anyErrors = true;
    await writeCompiled(join(outputRoot, outRel), result, opts.sourcemap);
    await emitDtsIfApplicable({
      outputRoot,
      outRel,
      corpusPath,
      scriptKind: entry.scriptKind,
      index,
      compatMode: opts.mode,
    });
  }

  process.stderr.write(
    `[luau2ts] compiled ${project.scripts.length} script(s) from ${project.name} into ${outputRoot}\n`,
  );
  return anyErrors ? 1 : 0;
}

function instancePathToCorpusPath(parts: LuauScriptEntry['instancePath']): string {
  return '/' + parts.join('/');
}

async function buildCorpus(scripts: readonly CorpusScript[]): Promise<{
  index: CorpusIndex;
  moduleReturnTypes: Map<string, string>;
  moduleRecordMapFields: Map<string, string[]>;
  moduleExportedMembers: Map<string, Map<string, 'method' | 'property' | 'recordMap'>>;
}> {
  // rbxts emit is the only mode that consumes the cross-script maps
  // today, but building the index unconditionally costs ~1ms/script
  // and lets `native`-mode .d.ts emit (a Phase 2 deliverable) reuse
  // the same data. Skip only the empty-corpus case.
  if (scripts.length === 0) {
    return {
      index: { modules: new Map() },
      moduleReturnTypes: new Map(),
      moduleRecordMapFields: new Map(),
      moduleExportedMembers: new Map(),
    };
  }
  const index = await buildCorpusIndex(scripts);
  const { moduleReturnTypes, moduleRecordMapFields, moduleExportedMembers } = deriveCompileMaps(index);
  return { index, moduleReturnTypes, moduleRecordMapFields, moduleExportedMembers };
}

// Surface extname so the v8 minifier doesn't drop it as unused; we keep
// the import explicit since it's used by tests of this module externally.
export { extname };
