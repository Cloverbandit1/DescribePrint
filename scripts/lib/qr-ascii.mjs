/**
 * Tiny QR (byte mode, ECC L, versions 1-4) for Start-script URLs.
 * No extra npm dependency. Good enough for http://<ipv4>:3000.
 */

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

function gfMul(a, b) {
  if (!a || !b) return 0;
  return EXP[LOG[a] + LOG[b]];
}

function rsGenerator(ecLen) {
  let poly = [1];
  for (let i = 0; i < ecLen; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

function rsEncode(data, ecLen) {
  const gen = rsGenerator(ecLen);
  const out = new Array(ecLen).fill(0);
  for (const byte of data) {
    const factor = byte ^ out[0];
    out.shift();
    out.push(0);
    if (!factor) continue;
    for (let i = 0; i < gen.length - 1; i++) {
      out[i] ^= gfMul(gen[i + 1], factor);
    }
  }
  return out;
}

/** Version 1-4, ECC L: [version, size, dataCodewords, ecCodewords, align] */
const VERSIONS = [
  { version: 1, size: 21, data: 19, ec: 7, align: null },
  { version: 2, size: 25, data: 34, ec: 10, align: 18 },
  { version: 3, size: 29, data: 55, ec: 15, align: 22 },
  { version: 4, size: 33, data: 80, ec: 20, align: 26 },
];

function bitsToBytes(bits) {
  const bytes = [];
  for (let i = 0; i < bits.length; i += 8) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | (bits[i + j] ?? 0);
    bytes.push(v);
  }
  return bytes;
}

function encodeData(text, spec) {
  const payload = Buffer.from(text, "utf8");
  const bits = [];
  const push = (value, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((value >> i) & 1);
  };
  push(0b0100, 4);
  push(payload.length, spec.version <= 9 ? 8 : 16);
  for (const byte of payload) push(byte, 8);
  const capacity = spec.data * 8;
  const term = Math.min(4, capacity - bits.length);
  for (let i = 0; i < term; i++) bits.push(0);
  while (bits.length % 8) bits.push(0);
  const bytes = bitsToBytes(bits);
  const pads = [0xec, 0x11];
  let p = 0;
  while (bytes.length < spec.data) bytes.push(pads[p++ % 2]);
  return bytes.slice(0, spec.data);
}

function placeFinder(mod, x, y) {
  for (let dy = -1; dy <= 7; dy++) {
    for (let dx = -1; dx <= 7; dx++) {
      const xx = x + dx;
      const yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= mod.length || yy >= mod.length) continue;
      const on =
        dx === -1 ||
        dx === 7 ||
        dy === -1 ||
        dy === 7 ||
        (dx >= 0 && dx <= 6 && dy >= 0 && dy <= 6 && (dx === 0 || dx === 6 || dy === 0 || dy === 6)) ||
        (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4);
      if (dx >= 0 && dx <= 6 && dy >= 0 && dy <= 6) {
        const ring = dx === 0 || dx === 6 || dy === 0 || dy === 6;
        const core = dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4;
        mod[yy][xx] = ring || core ? 1 : 0;
      } else if (on && (dx === -1 || dx === 7 || dy === -1 || dy === 7)) {
        if (xx >= 0 && yy >= 0 && xx < mod.length && yy < mod.length) mod[yy][xx] = 0;
      }
    }
  }
}

function placeTiming(mod) {
  for (let i = 8; i < mod.length - 8; i++) {
    mod[6][i] = i % 2 === 0 ? 1 : 0;
    mod[i][6] = i % 2 === 0 ? 1 : 0;
  }
}

function placeAlign(mod, pos) {
  if (pos == null) return;
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const on = Math.max(Math.abs(dx), Math.abs(dy)) !== 1 || (dx === 0 && dy === 0);
      const ring = Math.max(Math.abs(dx), Math.abs(dy)) === 2;
      const core = dx === 0 && dy === 0;
      mod[pos + dy][pos + dx] = ring || core ? 1 : 0;
      void on;
    }
  }
}

function reserved(size) {
  const r = Array.from({ length: size }, () => Array(size).fill(false));
  const mark = (x, y) => {
    if (x >= 0 && y >= 0 && x < size && y < size) r[y][x] = true;
  };
  for (let y = 0; y < 9; y++) for (let x = 0; x < 9; x++) mark(x, y);
  for (let y = 0; y < 9; y++) for (let x = size - 8; x < size; x++) mark(x, y);
  for (let y = size - 8; y < size; y++) for (let x = 0; x < 9; x++) mark(x, y);
  for (let i = 0; i < size; i++) {
    mark(i, 6);
    mark(6, i);
  }
  return r;
}

function markAlignReserved(r, pos) {
  if (pos == null) return;
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      r[pos + dy][pos + dx] = true;
    }
  }
}

function maskBit(mask, x, y) {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0;
    case 1:
      return y % 2 === 0;
    case 2:
      return x % 3 === 0;
    case 3:
      return (x + y) % 3 === 0;
    case 4:
      return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6:
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default:
      return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
}

function placeData(mod, reservedMap, bytes) {
  const size = mod.length;
  const bits = [];
  for (const byte of bytes) {
    for (let i = 7; i >= 0; i--) bits.push((byte >> i) & 1);
  }
  let bit = 0;
  let upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col -= 1;
    for (let i = 0; i < size; i++) {
      const y = upward ? size - 1 - i : i;
      for (const x of [col, col - 1]) {
        if (reservedMap[y][x]) continue;
        mod[y][x] = bits[bit++] ?? 0;
      }
    }
    upward = !upward;
  }
}

function applyMask(mod, reservedMap, mask) {
  const size = mod.length;
  const out = mod.map((row) => row.slice());
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!reservedMap[y][x] && maskBit(mask, x, y)) out[y][x] ^= 1;
    }
  }
  return out;
}

/** BCH(15,5) format info for ECC L (01) + mask 0-7. */
const FORMAT_L = [0x77c4, 0x72f3, 0x7daa, 0x789d, 0x662f, 0x6318, 0x6c41, 0x6976];

function placeFormat(mod, mask) {
  const bits = FORMAT_L[mask];
  const size = mod.length;
  for (let i = 0; i < 15; i++) {
    const bit = (bits >> (14 - i)) & 1;
    if (i < 6) {
      mod[i][8] = bit;
      mod[8][size - 1 - i] = bit;
    } else if (i === 6) {
      mod[7][8] = bit;
      mod[8][size - 1 - i] = bit;
    } else if (i === 7) {
      mod[8][8] = bit;
      mod[8][7] = bit;
    } else if (i === 8) {
      mod[8][7] = bit;
      mod[size - 7][8] = bit;
    } else {
      mod[8][14 - i] = bit;
      mod[size - 15 + i][8] = bit;
    }
  }
  mod[size - 8][8] = 1;
}

function penalty(mod) {
  const size = mod.length;
  let score = 0;
  const runScore = (run) => (run >= 5 ? 3 + (run - 5) : 0);
  for (let y = 0; y < size; y++) {
    let run = 1;
    for (let x = 1; x < size; x++) {
      if (mod[y][x] === mod[y][x - 1]) run += 1;
      else {
        score += runScore(run);
        run = 1;
      }
    }
    score += runScore(run);
  }
  for (let x = 0; x < size; x++) {
    let run = 1;
    for (let y = 1; y < size; y++) {
      if (mod[y][x] === mod[y - 1][x]) run += 1;
      else {
        score += runScore(run);
        run = 1;
      }
    }
    score += runScore(run);
  }
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const v = mod[y][x];
      if (v === mod[y][x + 1] && v === mod[y + 1][x] && v === mod[y + 1][x + 1]) score += 3;
    }
  }
  let dark = 0;
  for (const row of mod) for (const cell of row) dark += cell;
  const percent = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;
  return score;
}

export function encodeQrMatrix(text) {
  const payload = Buffer.from(text, "utf8");
  const spec = VERSIONS.find((row) => payload.length + 2 <= row.data);
  if (!spec) {
    throw new Error("URL too long for the built-in Start QR (versions 1-4).");
  }
  const data = encodeData(text, spec);
  const ecc = rsEncode(data, spec.ec);
  const codewords = data.concat(ecc);
  const size = spec.size;
  const reservedMap = reserved(size);
  markAlignReserved(reservedMap, spec.align);
  reservedMap[size - 8][8] = true;

  const base = Array.from({ length: size }, () => Array(size).fill(0));
  placeFinder(base, 0, 0);
  placeFinder(base, size - 7, 0);
  placeFinder(base, 0, size - 7);
  placeTiming(base);
  placeAlign(base, spec.align);
  placeData(base, reservedMap, codewords);

  let best = null;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const masked = applyMask(base, reservedMap, mask);
    placeFormat(masked, mask);
    const score = penalty(masked);
    if (score < bestScore) {
      bestScore = score;
      best = masked;
    }
  }
  return best;
}

export function renderAsciiQr(text, { quiet = 2 } = {}) {
  const matrix = encodeQrMatrix(text);
  const lines = [];
  const dark = "██";
  const light = "  ";
  const width = matrix.length + quiet * 2;
  const blank = light.repeat(width);
  for (let i = 0; i < quiet; i++) lines.push(blank);
  for (const row of matrix) {
    let line = light.repeat(quiet);
    for (const cell of row) line += cell ? dark : light;
    line += light.repeat(quiet);
    lines.push(line);
  }
  for (let i = 0; i < quiet; i++) lines.push(blank);
  return lines.join("\n");
}

export function printAsciiQr(text, write = console.log) {
  write(renderAsciiQr(text));
}
