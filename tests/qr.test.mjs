import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeQrMatrix, renderQrSvg } from '../openrig/assets/domain/qr.js';

test('encodeQrMatrix produces valid ISO 18004 geometry, finder patterns and version scaling', () => {
  const small = encodeQrMatrix('https://rig-commander.vercel.app/demo');
  assert.ok(small.version >= 2 && small.version <= 5);
  assert.equal(small.size, small.version * 4 + 17);
  assert.equal(small.matrix.length, small.size);
  assert.equal(small.matrix[0].length, small.size);

  // Verify 7x7 finder corners (top-left, top-right, bottom-left)
  for (const [r0, c0] of [[0, 0], [0, small.size - 7], [small.size - 7, 0]]) {
    assert.equal(small.matrix[r0][c0], 1);
    assert.equal(small.matrix[r0 + 3][c0 + 3], 1);
    assert.equal(small.matrix[r0 + 1][c0 + 1], 0);
  }
  // Dark module at (size - 8, 8)
  assert.equal(small.matrix[small.size - 8][8], 1);

  // Longer URL triggers Version 7+ (version info blocks)
  const longUrl = 'https://rig-commander.vercel.app/demo?source=qr&lang=ru&track=share&ref=' + 'a'.repeat(70);
  const large = encodeQrMatrix(longUrl);
  assert.ok(large.version >= 7 && large.version <= 10, `Expected V7+, got V${large.version}`);
  assert.equal(large.size, large.version * 4 + 17);
});

test('renderQrSvg outputs crisp standalone SVG with quiet zone and rejects oversized payloads', () => {
  const svg = renderQrSvg('https://rig-commander.vercel.app/demo?source=qr&lang=en', { size: 240, margin: 4 });
  assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240"'));
  assert.ok(svg.includes('shape-rendering="crispEdges"'));
  assert.ok(svg.includes('<path d="M'));
  assert.ok(svg.endsWith('</svg>'));

  assert.throws(() => encodeQrMatrix('x'.repeat(250)), RangeError);
});
