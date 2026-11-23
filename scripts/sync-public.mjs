#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const COPIES = [
  ['openrig/index.html', 'public/demo/index.html'],
  ['openrig/index.html', 'public/deck/index.html'],
  ['openrig/manifest.webmanifest', 'public/manifest.webmanifest'],
  ['openrig/sw.js', 'public/sw.js'],
  ['landing/index.html', 'public/index.html'],
  ['landing/passport.html', 'public/passport/index.html'],
  ['landing/passport.html', 'openrig/passport.html'],
  ['landing/guide.html', 'public/guide/index.html'],
  ['landing/guide.html', 'openrig/guide.html']
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

const mediaSrc = path.join(root, 'landing/media');
const mediaDst = path.join(root, 'public/media');
try {
  await fs.access(mediaSrc);
  await fs.rm(mediaDst, { recursive: true, force: true });
  await fs.cp(mediaSrc, mediaDst, { recursive: true });
  console.log('synced landing/media -> public/media');
} catch {}
