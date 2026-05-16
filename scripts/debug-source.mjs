#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const parserModule = await import(
  'file:///' + resolve('C:/Users/tonyt/Desktop/projects/rbx-web/packages/runtime/dist/rbxl-binary.js').replace(/\\/g, '/'),
);
const { parseRbxlBinaryToIR } = parserModule;
const bytes = readFileSync('C:/Users/tonyt/Desktop/thisisatest.rbxl');
const roots = parseRbxlBinaryToIR(bytes);

const name = process.argv[2] ?? 'WeaponsClient';
const pat = process.argv[3] ?? 'newCenter';

function walk(node, path) {
  const n = typeof node.properties?.Name === 'string' ? node.properties.Name : '?';
  const here = path + '/' + n;
  if (typeof node.properties?.Source === 'string' && here.includes(name)) {
    console.log('=== ' + here);
    const lines = node.properties.Source.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(pat)) {
        console.log((i + 1) + ': ' + lines[i]);
      }
    }
  }
  for (const c of node.children ?? []) walk(c, here);
}
for (const r of roots) walk(r, '');
