import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { compile, type CompileOptions, type CompileResult } from '../compile/index.js';
import { loadProject } from '../rojo/index.js';
import { classifyFile } from '../rojo/walk-tree.js';
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

  let anyErrors = false;
  let compiledCount = 0;
  await walkDir(inputRoot, async (filePath) => {
    if (!classifyFile(basename(filePath))) return;
    const source = await readFile(filePath, 'utf8');
    const result = await compile(source, compileOptionsFor(filePath, opts));
    if (reportErrors(filePath, result)) anyErrors = true;
    const rel = relative(inputRoot, filePath);
    const outRel = join(dirname(rel), tsCounterpart(basename(rel)));
    await writeCompiled(join(outputRoot, outRel), result, opts.sourcemap);
    compiledCount += 1;
  });

  process.stderr.write(`[luau2ts] compiled ${compiledCount} file(s) into ${outputRoot}\n`);
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

  let anyErrors = false;
  for (const entry of project.scripts) {
    const result = await compile(entry.source, compileOptionsFor(entry.filePath, opts));
    if (reportErrors(entry.filePath, result)) anyErrors = true;
    const rel = relative(projectDir, entry.filePath);
    const outRel = join(dirname(rel), tsCounterpart(basename(rel)));
    await writeCompiled(join(outputRoot, outRel), result, opts.sourcemap);
  }

  process.stderr.write(
    `[luau2ts] compiled ${project.scripts.length} script(s) from ${project.name} into ${outputRoot}\n`,
  );
  return anyErrors ? 1 : 0;
}

// Surface extname so the v8 minifier doesn't drop it as unused; we keep
// the import explicit since it's used by tests of this module externally.
export { extname };
