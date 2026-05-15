import type { CompatMode } from '../compile/context.js';

export interface ParsedArgs {
  /** Positional input: a `.luau`/`.lua` file, a directory, or undefined when `-p` is set. */
  input: string | undefined;
  /** Project file path, set by `-p` / `--project`. Mutually exclusive with `input`. */
  project: string | undefined;
  /** Output target. For single-file input: a file path (or `-` for stdout, the default).
   *  For directory or project input: an output directory. */
  output: string | undefined;
  mode: CompatMode;
  sourcemap: boolean;
  help: boolean;
  version: boolean;
}

export class ArgError extends Error {}

export function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = {
    input: undefined,
    project: undefined,
    output: undefined,
    mode: 'rbxts',
    sourcemap: false,
    help: false,
    version: false,
  };
  const positional: string[] = [];

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i]!;
    if (arg === '--') {
      // All remaining args are positional, mirroring POSIX convention.
      for (let j = i + 1; j < argv.length; j += 1) positional.push(argv[j]!);
      break;
    }
    if (arg === '-h' || arg === '--help') {
      result.help = true;
      i += 1;
      continue;
    }
    if (arg === '-v' || arg === '--version') {
      result.version = true;
      i += 1;
      continue;
    }
    if (arg === '--sourcemap') {
      result.sourcemap = true;
      i += 1;
      continue;
    }
    if (arg === '-o' || arg === '--output') {
      const value = argv[i + 1];
      if (value === undefined) throw new ArgError(`Missing value for ${arg}`);
      result.output = value;
      i += 2;
      continue;
    }
    if (arg.startsWith('--output=')) {
      result.output = arg.slice('--output='.length);
      i += 1;
      continue;
    }
    if (arg === '-p' || arg === '--project') {
      const value = argv[i + 1];
      if (value === undefined) throw new ArgError(`Missing value for ${arg}`);
      result.project = value;
      i += 2;
      continue;
    }
    if (arg.startsWith('--project=')) {
      result.project = arg.slice('--project='.length);
      i += 1;
      continue;
    }
    if (arg === '--mode') {
      const value = argv[i + 1];
      if (value === undefined) throw new ArgError('Missing value for --mode');
      if (value !== 'rbxts' && value !== 'native') {
        throw new ArgError(`Invalid --mode value: ${value} (expected rbxts or native)`);
      }
      result.mode = value;
      i += 2;
      continue;
    }
    if (arg.startsWith('--mode=')) {
      const value = arg.slice('--mode='.length);
      if (value !== 'rbxts' && value !== 'native') {
        throw new ArgError(`Invalid --mode value: ${value} (expected rbxts or native)`);
      }
      result.mode = value;
      i += 1;
      continue;
    }
    if (arg.startsWith('-')) {
      throw new ArgError(`Unknown flag: ${arg}`);
    }
    positional.push(arg);
    i += 1;
  }

  if (positional.length > 1) {
    throw new ArgError(
      `Too many positional arguments (expected 0 or 1, got ${positional.length}). `
        + `Use -o for the output target.`,
    );
  }
  if (positional.length === 1) result.input = positional[0];

  if (result.input && result.project) {
    throw new ArgError('Cannot use a positional input and -p / --project together.');
  }

  return result;
}

export const HELP_TEXT = `luau2ts — A Luau-to-TypeScript compiler for Roblox.

Usage:
  luau2ts <file.luau>                    Compile one file. Writes to stdout.
  luau2ts <file.luau> -o <file.ts>       Compile one file. Writes to a file.
  luau2ts <dir/> -o <out/>               Compile every .luau/.lua under <dir/>.
                                          Mirrors the input tree into <out/>.
  luau2ts -p <default.project.json> -o <out/>
                                          Walk a Rojo project file, compile
                                          every script it references, and
                                          emit a roblox-ts-shaped tree.

Flags:
  -o, --output <path>     Output file or directory. Default: stdout for
                          single-file input; required for dir/project.
  -p, --project <path>    Path to a Rojo *.project.json file, or a directory
                          containing default.project.json.
      --mode <name>       Emit compatibility mode. One of:
                            rbxts   (default) — emits TS that imports from
                                                @rbxts/types, @rbxts/services,
                                                etc. Pairs with roblox-ts.
                            native           — emits TS that imports stdlib
                                                helpers from 'luau2ts/runtime'.
                                                Pairs with a host runtime that
                                                provides Roblox's Luau API.
      --sourcemap         Emit a .ts.map next to each .ts.
  -h, --help              Show this help text.
  -v, --version           Print the installed luau2ts version.
`;
