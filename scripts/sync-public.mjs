#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const COPIES = [
  ['openrig/index.html', 'public/demo/index.html'],
  ['openrig/index.html', 'public/deck/index.html'],
  ['landing/index.html', 'public/index.html']
];

for (const [srcRel, dstRel] of COPIES) {
  const src = path.join(root, srcRel);
  const dst = path.join(root, dstRel);
  await fs.mkdir(path.dirname(dst), { recursive: true });
  await fs.copyFile(src, dst);
  console.log(`synced ${srcRel} -> ${dstRel}`);
}

const assetsSrc = path.join(root, 'openrig/assets');
const assetsDst = path.join(root, 'public/assets');
await fs.rm(assetsDst, { recursive: true, force: true });
await fs.cp(assetsSrc, assetsDst, { recursive: true });
console.log('synced openrig/assets -> public/assets');
