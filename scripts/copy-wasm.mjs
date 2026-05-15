#!/usr/bin/env node
// Copy the prebuilt Luau WASM parser + glue into the build output. The
// compiler's parser module imports `./wasm/luau-parser.mjs` relative to
// itself; tsc only handles .ts files, so the .wasm + .mjs binaries need
// to land in dist/parser/wasm/ for the published package to load them.

import { cp, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const src = resolve(root, 'src', 'parser', 'wasm');
const dst = resolve(root, 'dist', 'parser', 'wasm');

await mkdir(dst, { recursive: true });
await cp(src, dst, { recursive: true });
console.log(`[copy-wasm] ${src} -> ${dst}`);
