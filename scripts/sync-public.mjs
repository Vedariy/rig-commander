#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const appVersion = String(pkg.version || '3.2.0');

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

const STAMP_VERSION_TARGETS = new Set([
  'public/demo/index.html',
  'public/deck/index.html',
  'public/index.html'
]);

for (const [srcRel, dstRel] of COPIES) {
  const src = path.join(root, srcRel);
  const dst = path.join(root, dstRel);
  await fs.mkdir(path.dirname(dst), { recursive: true });
  if (STAMP_VERSION_TARGETS.has(dstRel)) {
    const html = (await fs.readFile(src, 'utf8')).replace(
      /(<meta\s+name="app-version"\s+content=")[^"]*(")/i,
      `$1${appVersion}$2`
    );
    await fs.writeFile(dst, html, 'utf8');
  } else {
    await fs.copyFile(src, dst);
  }
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
