#!/usr/bin/env node
// Convert roblox-globals.d.lua into a C++ header (roblox_globals_data.h)
// containing the file's bytes as a const char array plus a length constant.
// Consumed by wrapper.cpp at WASM compile time so the Roblox globals get
// linked into the analyzer alongside Luau's own builtins.
//
// Run from build/: `node embed-globals.mjs` — build.sh invokes us before
// emcc, but the script is also fine to run manually for quick iteration.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const sourcePath = resolve(here, 'roblox-globals.d.lua');
const headerPath = resolve(here, 'roblox_globals_data.h');

const bytes = readFileSync(sourcePath);

// Emit as `static const char[]` with hex byte literals. Initializer-list
// form survives any byte value including embedded NULs (loadDefinitionFile
// takes a std::string_view with explicit length, so we don't rely on
// NUL-termination — but we append one anyway out of paranoia).
const lines = [];
lines.push('// AUTO-GENERATED. Do not edit. Source: roblox-globals.d.lua.');
lines.push('// Regenerate with: node packages/analyzer/build/embed-globals.mjs');
lines.push('#pragma once');
lines.push('#include <cstddef>');
lines.push('');
// `unsigned char` so UTF-8 / non-ASCII bytes in the .d.lua source (em-
// dashes in comments, etc.) don't trip clang's narrowing check on
// platforms where `char` is signed. wrapper.cpp casts to `const char*`
// at use because Luau::loadDefinitionFile takes std::string_view.
lines.push(`static constexpr std::size_t kRobloxGlobalsLen = ${bytes.length};`);
lines.push('static const unsigned char kRobloxGlobals[] = {');

// 16 bytes per line keeps the header readable enough to grep without
// blowing up the compiler with one-byte-per-line. Hex literals because
// non-printable + non-ASCII bytes survive cleanly.
const PER_LINE = 16;
for (let i = 0; i < bytes.length; i += PER_LINE) {
  const chunk = bytes.subarray(i, i + PER_LINE);
  const parts = [];
  for (const b of chunk) parts.push(`0x${b.toString(16).padStart(2, '0')}`);
  lines.push('  ' + parts.join(', ') + ',');
}
// Trailing NUL byte (cheap defensive habit; consumers use the explicit
// length but a stray strlen() won't run off the end).
lines.push('  0x00');
lines.push('};');
lines.push('');

writeFileSync(headerPath, lines.join('\n'));
console.log(`[embed-globals] ${sourcePath} (${bytes.length} bytes) -> ${headerPath}`);
