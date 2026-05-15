#!/usr/bin/env node
// Copy the prebuilt Luau analyzer WASM glue into the build output, so
// the published package finds wasm/* relative to dist/.

import { cp, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const src = resolve(root, 'src', 'wasm');
const dst = resolve(root, 'dist', 'wasm');

await mkdir(dst, { recursive: true });
await cp(src, dst, { recursive: true });
console.log(`[analyzer:copy-wasm] ${src} -> ${dst}`);
