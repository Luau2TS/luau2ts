#!/usr/bin/env node
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';
import pkgJson from '../../package.json' with { type: 'json' };
import { ArgError, HELP_TEXT, parseArgs } from './args.js';
import {
  compileDirMode,
  compileFileMode,
  compileProjectMode,
} from './modes.js';

async function main(): Promise<number> {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    if (err instanceof ArgError) {
      process.stderr.write(`luau2ts: ${err.message}\n`);
      process.stderr.write(`Run \`luau2ts --help\` for usage.\n`);
      return 2;
    }
    throw err;
  }

  if (args.help) {
    process.stdout.write(HELP_TEXT);
    return 0;
  }
  if (args.version) {
    const version = (pkgJson as { version: string }).version;
    process.stdout.write(`luau2ts ${version}\n`);
    return 0;
  }

  const opts = {
    mode: args.mode,
    sourcemap: args.sourcemap,
    checkTs: args.checkTs,
    checkLuau: args.checkLuau,
    typeCheck: args.typeCheck,
  };

  if (args.project !== undefined) {
    if (!args.output) {
      process.stderr.write(`luau2ts: -p/--project requires -o/--output\n`);
      return 2;
    }
    return compileProjectMode(args.project, args.output, opts);
  }

  if (args.input === undefined) {
    process.stdout.write(HELP_TEXT);
    return 0;
  }

  const inputAbs = resolve(args.input);
  let inputStat;
  try {
    inputStat = await stat(inputAbs);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`luau2ts: cannot read ${args.input}: ${msg}\n`);
    return 1;
  }

  if (inputStat.isDirectory()) {
    if (!args.output) {
      process.stderr.write(`luau2ts: directory input requires -o/--output\n`);
      return 2;
    }
    return compileDirMode(args.input, args.output, opts);
  }
  return compileFileMode(args.input, args.output, opts);
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`luau2ts: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exit(1);
  },
);
