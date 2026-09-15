import type { Mesh, Triangle } from "./types";

const HEADER_BYTES = 80;
const TRIANGLE_BYTES = 50;

function readFloat32(view: DataView, offset: number): number {
  return view.getFloat32(offset, true);
}

function readVec3(view: DataView, offset: number): [number, number, number] {
  return [readFloat32(view, offset), readFloat32(view, offset + 4), readFloat32(view, offset + 8)];
}

export function isAsciiStl(buffer: Buffer): boolean {
  if (buffer.length < 15) return false;
  const head = buffer.subarray(0, 16).toString("ascii").toLowerCase();
  return head.startsWith("solid") && !looksBinaryDespiteSolid(buffer);
}

function looksBinaryDespiteSolid(buffer: Buffer): boolean {
  if (buffer.length < HEADER_BYTES + 4) return false;
  const count = buffer.readUInt32LE(HEADER_BYTES);
  return HEADER_BYTES + 4 + count * TRIANGLE_BYTES === buffer.length;
}

export function parseStl(buffer: Buffer): Mesh {
  if (buffer.length === 0) {
    throw new Error("STL is empty");
  }
  if (isAsciiStl(buffer)) {
    return parseAsciiStl(buffer.toString("utf8"));
  }
  return parseBinaryStl(buffer);
}

export function parseBinaryStl(buffer: Buffer): Mesh {
  if (buffer.length < HEADER_BYTES + 4) {
    throw new Error("Binary STL is truncated");
  }
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const count = view.getUint32(HEADER_BYTES, true);
  const expected = HEADER_BYTES + 4 + count * TRIANGLE_BYTES;
  if (buffer.length < expected) {
    throw new Error(`Binary STL length ${buffer.length} is shorter than ${expected} for ${count} triangles`);
  }

  const triangles: Triangle[] = [];
  let offset = HEADER_BYTES + 4;
  for (let i = 0; i < count; i++) {
    const normal = readVec3(view, offset);
    const v1 = readVec3(view, offset + 12);
    const v2 = readVec3(view, offset + 24);
    const v3 = readVec3(view, offset + 36);
    triangles.push({ normal, vertices: [v1, v2, v3] });
    offset += TRIANGLE_BYTES;
  }
  return { triangles };
}

export function parseAsciiStl(text: string): Mesh {
  const triangles: Triangle[] = [];
  const facetRe =
    /facet\s+normal\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)([\s\S]*?)endfacet/gi;
  const vertexRe = /vertex\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)/gi;

  for (const match of text.matchAll(facetRe)) {
    const normal: [number, number, number] = [
      Number(match[1]),
      Number(match[2]),
      Number(match[3]),
    ];
    const verts: [number, number, number][] = [];
    const body = match[4] ?? "";
    for (const v of body.matchAll(vertexRe)) {
      verts.push([Number(v[1]), Number(v[2]), Number(v[3])]);
    }
    if (verts.length !== 3 || verts.some((p) => p.some((n) => !Number.isFinite(n)))) {
      throw new Error("ASCII STL facet is malformed");
    }
    triangles.push({
      normal,
      vertices: verts as Triangle["vertices"],
    });
  }
  return { triangles };
}

export function writeBinaryStl(mesh: Mesh, header = "DescribePrint"): Buffer {
  const count = mesh.triangles.length;
  const buffer = Buffer.alloc(HEADER_BYTES + 4 + count * TRIANGLE_BYTES);
  buffer.write(header.slice(0, HEADER_BYTES), 0, "ascii");
  buffer.writeUInt32LE(count, HEADER_BYTES);

  let offset = HEADER_BYTES + 4;
  for (const tri of mesh.triangles) {
    writeVec3(buffer, offset, tri.normal);
    writeVec3(buffer, offset + 12, tri.vertices[0]);
    writeVec3(buffer, offset + 24, tri.vertices[1]);
    writeVec3(buffer, offset + 36, tri.vertices[2]);
    buffer.writeUInt16LE(0, offset + 48);
    offset += TRIANGLE_BYTES;
  }
  return buffer;
}

function writeVec3(buffer: Buffer, offset: number, v: [number, number, number]) {
  buffer.writeFloatLE(v[0], offset);
  buffer.writeFloatLE(v[1], offset + 4);
  buffer.writeFloatLE(v[2], offset + 8);
}

export function makeAxisAlignedBoxMesh(
  size: [number, number, number] = [10, 10, 10],
  origin: [number, number, number] = [0, 0, 0],
): Mesh {
  const [sx, sy, sz] = size;
  const [ox, oy, oz] = origin;
  const p: [number, number, number][] = [
    [ox, oy, oz],
    [ox + sx, oy, oz],
    [ox + sx, oy + sy, oz],
    [ox, oy + sy, oz],
    [ox, oy, oz + sz],
    [ox + sx, oy, oz + sz],
    [ox + sx, oy + sy, oz + sz],
    [ox, oy + sy, oz + sz],
  ];

  const faces: [number, number, number, [number, number, number]][] = [
    [0, 2, 1, [0, 0, -1]],
    [0, 3, 2, [0, 0, -1]],
    [4, 5, 6, [0, 0, 1]],
    [4, 6, 7, [0, 0, 1]],
    [0, 1, 5, [0, -1, 0]],
    [0, 5, 4, [0, -1, 0]],
    [2, 3, 7, [0, 1, 0]],
    [2, 7, 6, [0, 1, 0]],
    [0, 4, 7, [-1, 0, 0]],
    [0, 7, 3, [-1, 0, 0]],
    [1, 2, 6, [1, 0, 0]],
    [1, 6, 5, [1, 0, 0]],
  ];

  return {
    triangles: faces.map(([a, b, c, normal]) => ({
      normal,
      vertices: [p[a], p[b], p[c]],
    })),
  };
}
