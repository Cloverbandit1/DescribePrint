import { deflateSync, inflateSync } from "node:zlib";
import jpeg from "jpeg-js";

export type ImageRasterFormat = "png" | "jpeg" | "webp";

export type ImageRaster = {
  width: number;
  height: number;
  data: Uint8Array;
  format: ImageRasterFormat;
  /** True when pixels were invented from the file header (WebP stub). */
  pixelsInferred: boolean;
};

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function detectImageFormat(buffer: Buffer, fileName?: string): ImageRasterFormat | null {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_SIG)) return "png";
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "jpeg";
  if (looksLikeWebp(buffer)) return "webp";
  const ext = (fileName ?? "").split(/[/\\]/).pop()?.toLowerCase() ?? "";
  if (ext.endsWith(".png")) return "png";
  if (ext.endsWith(".jpg") || ext.endsWith(".jpeg")) return "jpeg";
  if (ext.endsWith(".webp")) return "webp";
  return null;
}

export function looksLikeWebp(buffer: Buffer): boolean {
  return (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  );
}

export function decodeImageRaster(buffer: Buffer, fileName?: string): ImageRaster {
  const format = detectImageFormat(buffer, fileName);
  if (!format) {
    throw new Error("Choose a PNG, JPG, or WebP photo.");
  }
  if (format === "png") return { ...decodePng(buffer), format, pixelsInferred: false };
  if (format === "jpeg") return { ...decodeJpeg(buffer), format, pixelsInferred: false };
  return decodeWebpStub(buffer);
}

export function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  if (width < 1 || height < 1) throw new Error("PNG size is invalid.");
  if (rgba.length !== width * height * 4) throw new Error("PNG pixel buffer length is wrong.");

  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 4 + 1);
    raw[row] = 0;
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), row + 1);
  }

  const chunks = [PNG_SIG, chunk("IHDR", ihdr(width, height, 8, 6)), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))];
  return Buffer.concat(chunks);
}

export function encodeJpeg(width: number, height: number, rgba: Uint8Array, quality = 85): Buffer {
  const encoded = jpeg.encode({ data: Buffer.from(rgba), width, height }, quality);
  return Buffer.from(encoded.data);
}

/** Minimal RIFF/VP8X WebP used by tests — pixels are not a real photo. */
export function encodeWebpStub(width: number, height: number): Buffer {
  const w = Math.max(1, Math.round(width)) - 1;
  const h = Math.max(1, Math.round(height)) - 1;
  const payload = Buffer.alloc(10);
  payload[0] = 0;
  payload.writeUIntLE(w, 4, 3);
  payload.writeUIntLE(h, 7, 3);
  const vp8x = Buffer.concat([Buffer.from("VP8X"), u32le(payload.length), payload]);
  const riffSize = 4 + vp8x.length;
  return Buffer.concat([Buffer.from("RIFF"), u32le(riffSize), Buffer.from("WEBP"), vp8x]);
}

function decodeJpeg(buffer: Buffer): { width: number; height: number; data: Uint8Array } {
  try {
    const raw = jpeg.decode(buffer, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: 24 });
    if (!raw.width || !raw.height || !raw.data?.length) {
      throw new Error("JPEG has no pixels.");
    }
    return { width: raw.width, height: raw.height, data: new Uint8Array(raw.data) };
  } catch (err) {
    const message = err instanceof Error ? err.message : "JPEG decode failed";
    throw new Error(message.includes("JPEG") ? message : `Could not read this JPEG (${message}).`);
  }
}

function decodeWebpStub(buffer: Buffer): ImageRaster {
  const size = readWebpSize(buffer);
  if (!size) {
    throw new Error("Could not read this WebP. PNG or JPG decodes the silhouette; WebP currently uses the file size header.");
  }
  const { width, height } = size;
  const data = filledSubjectRgba(width, height);
  return { width, height, data, format: "webp", pixelsInferred: true };
}

export function readWebpSize(buffer: Buffer): { width: number; height: number } | null {
  if (!looksLikeWebp(buffer) || buffer.length < 20) return null;
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const fourcc = buffer.subarray(offset, offset + 4).toString("ascii");
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    if (end > buffer.length) return null;
    if (fourcc === "VP8X" && size >= 10) {
      const width = buffer.readUIntLE(start + 4, 3) + 1;
      const height = buffer.readUIntLE(start + 7, 3) + 1;
      return { width, height };
    }
    if (fourcc === "VP8 " && size >= 10) {
      const tag = start;
      if (buffer[tag + 3] === 0x9d && buffer[tag + 4] === 0x01 && buffer[tag + 5] === 0x2a) {
        const width = buffer.readUInt16LE(tag + 6) & 0x3fff;
        const height = buffer.readUInt16LE(tag + 8) & 0x3fff;
        return { width, height };
      }
    }
    if (fourcc === "VP8L" && size >= 5 && buffer[start] === 0x2f) {
      const bits = buffer.readUInt32LE(start + 1);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    offset = end + (size % 2);
  }
  return null;
}

function filledSubjectRgba(width: number, height: number): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  const padX = Math.max(1, Math.round(width * 0.12));
  const padY = Math.max(1, Math.round(height * 0.12));
  const rx = Math.max(2, Math.round(Math.min(width, height) * 0.18));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const inside = roundedRectContains(x, y, padX, padY, width - padX - 1, height - padY - 1, rx);
      const i = (y * width + x) * 4;
      if (inside) {
        data[i] = 40;
        data[i + 1] = 40;
        data[i + 2] = 44;
        data[i + 3] = 255;
      } else {
        data[i] = 255;
        data[i + 1] = 255;
        data[i + 2] = 255;
        data[i + 3] = 0;
      }
    }
  }
  return data;
}

function roundedRectContains(x: number, y: number, x0: number, y0: number, x1: number, y1: number, r: number): boolean {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx0 = x0 + r;
  const cy0 = y0 + r;
  const cx1 = x1 - r;
  const cy1 = y1 - r;
  if (x >= cx0 && x <= cx1) return true;
  if (y >= cy0 && y <= cy1) return true;
  const dx = x < cx0 ? x - cx0 : x - cx1;
  const dy = y < cy0 ? y - cy0 : y - cy1;
  return dx * dx + dy * dy <= r * r;
}

function decodePng(buffer: Buffer): { width: number; height: number; data: Uint8Array } {
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIG)) {
    throw new Error("This PNG is truncated or invalid.");
  }

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idats: Buffer[] = [];
  let palette: Buffer | null = null;
  let transparent: Buffer | null = null;

  let offset = 8;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString("ascii");
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (data.length < length) throw new Error("This PNG is truncated.");
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8] ?? 0;
      colorType = data[9] ?? 0;
      interlace = data[12] ?? 0;
    } else if (type === "PLTE") {
      palette = Buffer.from(data);
    } else if (type === "tRNS") {
      transparent = Buffer.from(data);
    } else if (type === "IDAT") {
      idats.push(Buffer.from(data));
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }

  if (width < 1 || height < 1 || width > 8192 || height > 8192) {
    throw new Error("PNG dimensions are not usable.");
  }
  if (bitDepth !== 8) throw new Error("Only 8-bit PNG photos are supported in this stub.");
  if (interlace !== 0) throw new Error("Interlaced PNG is not supported in this stub.");

  const inflated = inflateSync(Buffer.concat(idats));
  const bpp = pngBytesPerPixel(colorType);
  const stride = width * bpp;
  const expected = height * (stride + 1);
  if (inflated.length < expected) throw new Error("PNG pixel data is truncated.");

  const recon = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = inflated[y * (stride + 1)] ?? 0;
    const src = inflated.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const dest = recon.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : recon.subarray((y - 1) * stride, y * stride);
    unfilter(filter, src, dest, prev, bpp);
  }

  return { width, height, data: pngToRgba(recon, width, height, colorType, palette, transparent) };
}

function pngBytesPerPixel(colorType: number): number {
  switch (colorType) {
    case 0:
      return 1;
    case 2:
      return 3;
    case 3:
      return 1;
    case 4:
      return 2;
    case 6:
      return 4;
    default:
      throw new Error("Unsupported PNG color type.");
  }
}

function unfilter(filter: number, src: Buffer, dest: Buffer, prev: Buffer | null, bpp: number) {
  for (let i = 0; i < src.length; i++) {
    const a = i >= bpp ? dest[i - bpp]! : 0;
    const b = prev ? prev[i]! : 0;
    const c = prev && i >= bpp ? prev[i - bpp]! : 0;
    const x = src[i]!;
    if (filter === 0) dest[i] = x;
    else if (filter === 1) dest[i] = (x + a) & 255;
    else if (filter === 2) dest[i] = (x + b) & 255;
    else if (filter === 3) dest[i] = (x + Math.floor((a + b) / 2)) & 255;
    else if (filter === 4) dest[i] = (x + paeth(a, b, c)) & 255;
    else throw new Error("Unsupported PNG filter.");
  }
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function pngToRgba(
  recon: Buffer,
  width: number,
  height: number,
  colorType: number,
  palette: Buffer | null,
  transparent: Buffer | null,
): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 255;
    if (colorType === 6) {
      r = recon[i * 4]!;
      g = recon[i * 4 + 1]!;
      b = recon[i * 4 + 2]!;
      a = recon[i * 4 + 3]!;
    } else if (colorType === 2) {
      r = recon[i * 3]!;
      g = recon[i * 3 + 1]!;
      b = recon[i * 3 + 2]!;
    } else if (colorType === 0) {
      r = g = b = recon[i]!;
    } else if (colorType === 4) {
      r = g = b = recon[i * 2]!;
      a = recon[i * 2 + 1]!;
    } else if (colorType === 3) {
      if (!palette) throw new Error("Palette PNG is missing PLTE.");
      const index = recon[i]!;
      r = palette[index * 3] ?? 0;
      g = palette[index * 3 + 1] ?? 0;
      b = palette[index * 3 + 2] ?? 0;
      if (transparent && index < transparent.length) a = transparent[index]!;
    }
    const o = i * 4;
    out[o] = r;
    out[o + 1] = g;
    out[o + 2] = b;
    out[o + 3] = a;
  }
  return out;
}

function ihdr(width: number, height: number, bitDepth: number, colorType: number): Buffer {
  const data = Buffer.alloc(13);
  data.writeUInt32BE(width, 0);
  data.writeUInt32BE(height, 4);
  data[8] = bitDepth;
  data[9] = colorType;
  return data;
}

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type), data]);
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), 8 + data.length);
  return out;
}

function u32le(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0, 0);
  return b;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buffer) {
    c = CRC_TABLE[(c ^ byte) & 255]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}
