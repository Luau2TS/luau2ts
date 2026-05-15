// Loads @rbxts/types + @rbxts/compiler-types into the rbxts-worker's
// virtual filesystem so roblox-ts has the typings it needs to compile
// even bare-bones TypeScript. Mirrors the upstream roblox-ts.com
// playground pattern: fetch package.json from jsdelivr, then recursively
// fetch every referenced .d.ts file via the standard `<reference path>`
// / `<reference types>` / `import from "@rbxts/foo"` declarations.
//
// All files land at /node_modules/<pkg>/<file> in the worker VFS. Once
// loaded, roblox-ts's MacroManager finds the Promise / Map / Set / etc.
// symbol declarations it expects.

const SCOPE = '@rbxts';
const JS_DELIVR = 'https://cdn.jsdelivr.net/npm';
const CORE_PACKAGES = ['types', 'compiler-types'];

const REFERENCE_PATH_REGEX = /\/\/\/\s*<reference path=["']([^"']+)["']\s*\/>/g;
const REFERENCE_TYPES_REGEX = /\/\/\/\s*<reference types=["']@rbxts\/([^"']+)["']\s*\/>/g;
const IMPORT_EXPORT_REGEX = /(?:import|export)\s+.+\s+from\s+['"]([^'"]+)['"]/g;

interface PackageJson {
  version: string;
  main?: string;
  typings?: string;
  types?: string;
  dependencies?: Record<string, string>;
}

interface State {
  worker: Worker;
  /** Files we've already fetched (de-dupe across recursive walks). */
  loaded: Set<string>;
  /** Packages we've already started downloading. */
  packages: Set<string>;
}

function pathDirname(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}

/** Mini path.resolve. Doesn't fully implement POSIX rules but handles the
 *  cases the @rbxts typings actually use (relative paths up to one `..`). */
function pathResolve(from: string, ref: string): string {
  if (ref.startsWith('/')) return ref;
  const segments = (from + '/' + ref).split('/');
  const stack: string[] = [];
  for (const seg of segments) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') stack.pop();
    else stack.push(seg);
  }
  return '/' + stack.join('/');
}

function pathJoin(a: string, b: string): string {
  if (a.endsWith('/')) a = a.slice(0, -1);
  if (b.startsWith('/')) b = b.slice(1);
  return `${a}/${b}`;
}

function getMatches(re: RegExp, src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(re)) out.push(m[1]!);
  return out;
}

async function downloadFile(filePath: string): Promise<Response> {
  const parts = filePath.split('/');
  // Pin to @latest if no version is specified on the package segment.
  if (parts[1] && !parts[1].includes('@')) parts[1] = `${parts[1]}@latest`;
  return fetch(`${JS_DELIVR}/${parts.join('/')}`);
}

function writeFile(state: State, filePath: string, content: string): void {
  state.worker.postMessage({
    type: 'writeFile',
    filePath: `/node_modules/${filePath}`,
    content,
  });
}

async function downloadDefinition(state: State, pkgName: string, filePath: string): Promise<void> {
  if (state.loaded.has(filePath)) return;
  state.loaded.add(filePath);

  let response = await downloadFile(filePath);
  if (response.status === 404) {
    // Package omitted the trailing /index.d.ts in its types field.
    filePath = filePath.slice(0, -'.d.ts'.length) + '/index.d.ts';
    response = await downloadFile(filePath);
  }
  if (response.status !== 200) return;

  const content = await response.text();
  const jobs: Promise<unknown>[] = [];

  for (const ref of getMatches(REFERENCE_PATH_REGEX, content)) {
    const refPath = pathResolve(pathDirname(filePath), ref).slice(1);
    jobs.push(downloadDefinition(state, pkgName, refPath));
  }

  for (let ref of getMatches(IMPORT_EXPORT_REGEX, content)) {
    if (ref.endsWith('.') || ref.endsWith('..')) ref += '/index';
    if (ref.startsWith(SCOPE)) {
      jobs.push(downloadPackage(state, ref.slice(SCOPE.length + 1)));
    } else {
      const refPath = pathResolve(pathDirname(filePath), ref).slice(1) + '.d.ts';
      jobs.push(downloadDefinition(state, pkgName, refPath));
    }
  }

  for (const ref of getMatches(REFERENCE_TYPES_REGEX, content)) {
    jobs.push(downloadPackage(state, ref));
  }

  writeFile(state, filePath, content);
  await Promise.allSettled(jobs);
}

async function downloadPackage(state: State, name: string): Promise<void> {
  if (state.packages.has(name)) return;
  state.packages.add(name);

  const pkgName = `${SCOPE}/${name}`;
  const pkgJsonPath = `${pkgName}/package.json`;
  const pkgJsonResponse = await downloadFile(pkgJsonPath);
  if (pkgJsonResponse.status !== 200) {
    // Drop the marker so a later attempt can retry.
    state.packages.delete(name);
    return;
  }
  const pkgJson = (await pkgJsonResponse.json()) as PackageJson;
  writeFile(state, pkgJsonPath, JSON.stringify(pkgJson));

  const mainPath = pathResolve(`/${pkgName}`, pkgJson.main ?? '').slice(1);
  const typingsPath = pathResolve(
    `/${pkgName}`,
    pkgJson.types ?? pkgJson.typings ?? 'index.d.ts',
  ).slice(1);
  state.worker.postMessage({
    type: 'setMapping',
    typingsPath: `/node_modules/${typingsPath}`,
    mainPath: `/node_modules/${mainPath}`,
  });
  await downloadDefinition(state, pkgName, typingsPath);
}

/** Fetch the core typings bundle (@rbxts/types + @rbxts/compiler-types)
 *  and feed each .d.ts into the worker's VFS. Resolves once every file
 *  the worker needs has been written. */
export async function bootstrapWorkerTypings(worker: Worker): Promise<void> {
  const state: State = { worker, loaded: new Set(), packages: new Set() };
  await Promise.all(CORE_PACKAGES.map((name) => downloadPackage(state, name)));
}

// Exposed for unused-export silencing; pathJoin is reserved for future use
// when we add per-example bundled typings (e.g. a Roact example needs
// @rbxts/roact loaded too).
export const __unusedPathJoin = pathJoin;
