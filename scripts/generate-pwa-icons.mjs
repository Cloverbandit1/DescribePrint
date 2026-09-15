#!/usr/bin/env node
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function crc32(buf) {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function u32(n) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32BE(n);
  return buf;
}

function chunk(type, data) {
  const tag = Buffer.from(type);
  return Buffer.concat([u32(data.length), tag, data, u32(crc32(Buffer.concat([tag, data])))]);
}

function rgbPng(size, pixel) {
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    const row = y * (size * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b] = pixel(x, y, size);
      const o = row + 1 + x * 3;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function describePrintIcon(x, y, size) {
  const nx = (x + 0.5) / size;
  const ny = (y + 0.5) / size;
  const bg = [0x00, 0xb3, 0x47];
  const ink = [0x06, 0x21, 0x0f];
  const panel = [0x2b, 0x2b, 0x2b];
  const inset = 0.12;
  if (nx < inset || nx > 1 - inset || ny < inset || ny > 1 - inset) return bg;
  if (nx > 0.22 && nx < 0.78 && ny > 0.22 && ny < 0.78) {
    const inner = nx > 0.34 && nx < 0.66 && ny > 0.34 && ny < 0.66;
    return inner ? bg : panel;
  }
  return ink;
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pub = path.join(root, "public");
mkdirSync(pub, { recursive: true });
writeFileSync(path.join(pub, "icon-192.png"), rgbPng(192, describePrintIcon));
writeFileSync(path.join(pub, "icon-512.png"), rgbPng(512, describePrintIcon));
writeFileSync(path.join(pub, "apple-touch-icon.png"), rgbPng(180, describePrintIcon));
console.log("Wrote public/icon-192.png, public/icon-512.png, public/apple-touch-icon.png");
