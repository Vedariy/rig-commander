/**
 * Pure zero-dependency ISO/IEC 18004 QR Code (Model 2, Byte Mode, EC Level M, Versions 1–10)
 * SVG generator for instant desktop -> phone PWA handoff without external QR APIs.
 */

// GF(256) with primitive polynomial x^8 + x^4 + x^3 + x^2 + 1 (0x11D)
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function rsGeneratorPoly(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    const factor = GF_EXP[i];
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], factor);
    }
    poly = next;
  }
  return poly;
}

function rsComputeEcc(data, ecCount) {
  const gen = rsGeneratorPoly(ecCount);
  const rem = new Uint8Array(ecCount);
  for (let i = 0; i < data.length; i++) {
    const factor = data[i] ^ rem[0];
    for (let j = 0; j < ecCount - 1; j++) rem[j] = rem[j + 1];
    rem[ecCount - 1] = 0;
    if (factor !== 0) {
      for (let j = 0; j < ecCount; j++) {
        rem[j] ^= gfMul(gen[j + 1], factor);
      }
    }
  }
  return rem;
}

// Level M block specifications for QR Versions 1..10:
// [version, totalDataCodewords, ecPerBlock, [[groupBlocks, groupDataBytes], ...]]
const EC_M_SPECS = [
  null,
  { ver: 1, dataBytes: 16, ecPerBlock: 10, groups: [[1, 16]], align: [] },
  { ver: 2, dataBytes: 28, ecPerBlock: 16, groups: [[1, 28]], align: [6, 18] },
  { ver: 3, dataBytes: 44, ecPerBlock: 26, groups: [[1, 44]], align: [6, 22] },
  { ver: 4, dataBytes: 64, ecPerBlock: 18, groups: [[2, 32]], align: [6, 26] },
  { ver: 5, dataBytes: 86, ecPerBlock: 24, groups: [[2, 43]], align: [6, 30] },
  { ver: 6, dataBytes: 108, ecPerBlock: 16, groups: [[4, 27]], align: [6, 34] },
  { ver: 7, dataBytes: 124, ecPerBlock: 18, groups: [[4, 31]], align: [6, 22, 38] },
  { ver: 8, dataBytes: 154, ecPerBlock: 22, groups: [[2, 38], [2, 39]], align: [6, 24, 42] },
  { ver: 9, dataBytes: 182, ecPerBlock: 22, groups: [[3, 36], [2, 37]], align: [6, 26, 46] },
  { ver: 10, dataBytes: 216, ecPerBlock: 26, groups: [[4, 43], [1, 44]], align: [6, 28, 50] }
];

function utf8Bytes(str) {
  if (typeof TextEncoder !== 'undefined') {
    return Array.from(new TextEncoder().encode(String(str ?? '')));
  }
  const s = unescape(encodeURIComponent(String(str ?? '')));
  const out = [];
  for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i));
  return out;
}

function chooseVersionM(byteLen) {
  for (let v = 1; v < EC_M_SPECS.length; v++) {
    const spec = EC_M_SPECS[v];
    const countBits = v <= 9 ? 8 : 16;
    const capBytes = Math.floor((spec.dataBytes * 8 - 4 - countBits) / 8);
    if (byteLen <= capBytes) return spec;
  }
  throw new RangeError(`QR payload too long (${byteLen} bytes > 213 byte limit)`);
}

function buildCodewords(bytes, spec) {
  const bits = [];
  const pushBits = (val, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
  };

  // Byte mode indicator (0100) + length
  pushBits(0b0100, 4);
  pushBits(bytes.length, spec.ver <= 9 ? 8 : 16);
  for (const b of bytes) pushBits(b, 8);

  const totalDataBits = spec.dataBytes * 8;
  // Terminator (up to 4 zero bits)
  const term = Math.min(4, totalDataBits - bits.length);
  for (let i = 0; i < term; i++) bits.push(0);
  // Pad to byte boundary
  while (bits.length % 8 !== 0) bits.push(0);

  const data = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
    data.push(byte);
  }
  const pads = [0xec, 0x11];
  let padIdx = 0;
  while (data.length < spec.dataBytes) {
    data.push(pads[padIdx++ & 1]);
  }

  // Split into RS blocks and interleave
  const dataBlocks = [];
  const ecBlocks = [];
  let offset = 0;
  for (const [count, len] of spec.groups) {
    for (let b = 0; b < count; b++) {
      const slice = data.slice(offset, offset + len);
      offset += len;
      dataBlocks.push(slice);
      ecBlocks.push(rsComputeEcc(slice, spec.ecPerBlock));
    }
  }

  const out = [];
  const maxDataLen = Math.max(...dataBlocks.map(b => b.length));
  for (let i = 0; i < maxDataLen; i++) {
    for (const blk of dataBlocks) {
      if (i < blk.length) out.push(blk[i]);
    }
  }
  for (let i = 0; i < spec.ecPerBlock; i++) {
    for (const blk of ecBlocks) {
      out.push(blk[i]);
    }
  }
  return out;
}

function computeFormatBitsM(mask) {
  // EC Level M = 00
  const data = (0b00 << 3) | (mask & 7);
  let rem = data << 10;
  for (let i = 14; i >= 10; i--) {
    if ((rem >>> i) & 1) rem ^= 0x537 << (i - 10);
  }
  return ((data << 10) | rem) ^ 0x5412;
}

function computeVersionBits(ver) {
  let rem = ver << 12;
  for (let i = 17; i >= 12; i--) {
    if ((rem >>> i) & 1) rem ^= 0x1f25 << (i - 12);
  }
  return (ver << 12) | rem;
}

function applyMaskFn(mask, r, c) {
  switch (mask) {
    case 0: return (r + c) % 2 === 0;
    case 1: return r % 2 === 0;
    case 2: return c % 3 === 0;
    case 3: return (r + c) % 3 === 0;
    case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
    case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
    case 6: return ((((r * c) % 2) + ((r * c) % 3)) % 2) === 0;
    case 7: return ((((r + c) % 2) + ((r * c) % 3)) % 2) === 0;
    default: return false;
  }
}

function computePenalty(mat) {
  const n = mat.length;
  let score = 0;

  // Rule 1: 5+ adjacent same-color modules in row/col
  for (let r = 0; r < n; r++) {
    let run = 1;
    for (let c = 1; c < n; c++) {
      if (mat[r][c] === mat[r][c - 1]) {
        run++;
        if (run === 5) score += 3;
        else if (run > 5) score += 1;
      } else {
        run = 1;
      }
    }
  }
  for (let c = 0; c < n; c++) {
    let run = 1;
    for (let r = 1; r < n; r++) {
      if (mat[r][c] === mat[r - 1][c]) {
        run++;
        if (run === 5) score += 3;
        else if (run > 5) score += 1;
      } else {
        run = 1;
      }
    }
  }

  // Rule 2: 2x2 same-color blocks
  for (let r = 0; r < n - 1; r++) {
    for (let c = 0; c < n - 1; c++) {
      const v = mat[r][c];
      if (v === mat[r][c + 1] && v === mat[r + 1][c] && v === mat[r + 1][c + 1]) {
        score += 3;
      }
    }
  }

  // Rule 3: finder-like pattern 10111010000 or 00001011101
  const p1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const p2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  for (let r = 0; r < n; r++) {
    for (let c = 0; c <= n - 11; c++) {
      let m1 = true;
      let m2 = true;
      for (let k = 0; k < 11; k++) {
        if (mat[r][c + k] !== p1[k]) m1 = false;
        if (mat[r][c + k] !== p2[k]) m2 = false;
      }
      if (m1 || m2) score += 40;
    }
  }
  for (let c = 0; c < n; c++) {
    for (let r = 0; r <= n - 11; r++) {
      let m1 = true;
      let m2 = true;
      for (let k = 0; k < 11; k++) {
        if (mat[r + k][c] !== p1[k]) m1 = false;
        if (mat[r + k][c] !== p2[k]) m2 = false;
      }
      if (m1 || m2) score += 40;
    }
  }

  // Rule 4: dark/light balance
  let dark = 0;
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) if (mat[r][c]) dark++;
  }
  const pct = (dark * 100) / (n * n);
  score += Math.floor(Math.abs(pct - 50) / 5) * 10;
  return score;
}

export function encodeQrMatrix(text) {
  const bytes = utf8Bytes(text);
  const spec = chooseVersionM(bytes.length);
  const size = spec.ver * 4 + 17;
  const codewords = buildCodewords(bytes, spec);

  const isFunc = Array.from({ length: size }, () => new Uint8Array(size));
  const base = Array.from({ length: size }, () => new Uint8Array(size));

  const setFunc = (r, c, val) => {
    if (r < 0 || r >= size || c < 0 || c >= size) return;
    isFunc[r][c] = 1;
    base[r][c] = val ? 1 : 0;
  };

  // Finder patterns + 1-module white separators
  const drawFinder = (top, left) => {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const r = top + dr;
        const c = left + dc;
        if (r < 0 || r >= size || c < 0 || c >= size) continue;
        const inOuter = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
        const onBorder = dr === 0 || dr === 6 || dc === 0 || dc === 6;
        const inCore = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
        setFunc(r, c, inOuter && (onBorder || inCore));
      }
    }
  };
  drawFinder(0, 0);
  drawFinder(0, size - 7);
  drawFinder(size - 7, 0);

  // Timing patterns
  for (let i = 8; i < size - 8; i++) {
    setFunc(6, i, i % 2 === 0);
    setFunc(i, 6, i % 2 === 0);
  }

  // Alignment patterns
  const centers = spec.align;
  for (const r0 of centers) {
    for (const c0 of centers) {
      const overlapsFinder =
        (r0 === 6 && c0 === 6) ||
        (r0 === 6 && c0 === size - 7) ||
        (r0 === size - 7 && c0 === 6);
      if (overlapsFinder) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const dist = Math.max(Math.abs(dr), Math.abs(dc));
          setFunc(r0 + dr, c0 + dc, dist === 0 || dist === 2);
        }
      }
    }
  }

  // Reserve format info strips + dark module
  for (let i = 0; i <= 8; i++) {
    if (i !== 6) {
      isFunc[8][i] = 1;
      isFunc[i][8] = 1;
    }
  }
  for (let i = size - 8; i < size; i++) {
    isFunc[8][i] = 1;
    isFunc[i][8] = 1;
  }
  setFunc(size - 8, 8, 1);

  // Version info blocks for V7+
  if (spec.ver >= 7) {
    const verBits = computeVersionBits(spec.ver);
    for (let i = 0; i < 18; i++) {
      const bit = (verBits >>> i) & 1;
      const a = Math.floor(i / 3);
      const b = size - 11 + (i % 3);
      setFunc(a, b, bit);
      setFunc(b, a, bit);
    }
  }

  // Place data + EC bits in standard upward/downward 2-column zigzag
  const bitStream = [];
  for (const cw of codewords) {
    for (let b = 7; b >= 0; b--) bitStream.push((cw >>> b) & 1);
  }
  let bitIdx = 0;
  let upward = true;
  for (let rightCol = size - 1; rightCol >= 1; rightCol -= 2) {
    if (rightCol === 6) rightCol = 5; // skip vertical timing column
    for (let step = 0; step < size; step++) {
      const r = upward ? size - 1 - step : step;
      for (let dx = 0; dx < 2; dx++) {
        const c = rightCol - dx;
        if (!isFunc[r][c]) {
          base[r][c] = bitIdx < bitStream.length ? bitStream[bitIdx++] : 0;
        }
      }
    }
    upward = !upward;
  }

  const writeFormat = (mat, mask) => {
    const fmt = computeFormatBitsM(mask);
    // Top-left copy: bit 14 at (8,0) down to bit 0 at (0,8)
    const tlCoords = [
      [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
      [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]
    ];
    for (let i = 0; i < 15; i++) {
      const bit = (fmt >>> (14 - i)) & 1;
      const [r, c] = tlCoords[i];
      mat[r][c] = bit;
    }
    // Split copy: bit 14..8 at (size-1..size-7, 8), bit 7..0 at (8, size-8..size-1)
    for (let i = 0; i < 7; i++) {
      mat[size - 1 - i][8] = (fmt >>> (14 - i)) & 1;
    }
    for (let i = 0; i < 8; i++) {
      mat[8][size - 8 + i] = (fmt >>> (7 - i)) & 1;
    }
  };

  let bestMask = 0;
  let bestScore = Infinity;
  let bestMat = null;

  for (let mask = 0; mask < 8; mask++) {
    const mat = base.map((row, r) => {
      const copy = new Uint8Array(row);
      for (let c = 0; c < size; c++) {
        if (!isFunc[r][c] && applyMaskFn(mask, r, c)) {
          copy[c] ^= 1;
        }
      }
      return copy;
    });
    writeFormat(mat, mask);
    const pen = computePenalty(mat);
    if (pen < bestScore) {
      bestScore = pen;
      bestMask = mask;
      bestMat = mat;
    }
  }

  return {
    version: spec.ver,
    size,
    mask: bestMask,
    matrix: bestMat.map(row => Array.from(row))
  };
}

export function renderQrSvg(text, {
  size = 228,
  margin = 4,
  fg = '#030712',
  bg = '#ffffff',
  rx = 12
} = {}) {
  const { size: n, matrix } = encodeQrMatrix(text);
  const total = n + margin * 2;
  let pathData = '';
  for (let r = 0; r < n; r++) {
    let c = 0;
    while (c < n) {
      if (matrix[r][c]) {
        const start = c;
        while (c < n && matrix[r][c]) c++;
        const len = c - start;
        pathData += `M${start + margin} ${r + margin}h${len}v1h-${len}z`;
      } else {
        c++;
      }
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges" role="img" aria-label="QR code">` +
    `<rect width="${total}" height="${total}" rx="${(rx * total / size).toFixed(2)}" fill="${bg}"/>` +
    `<path d="${pathData}" fill="${fg}"/>` +
    `</svg>`;
}
