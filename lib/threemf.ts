import JSZip from "jszip";
import type { Mesh, Triangle } from "./types";

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>
`;

const RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>
`;

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function weldVertices(mesh: Mesh): { vertices: [number, number, number][]; triangles: [number, number, number][] } {
  const map = new Map<string, number>();
  const vertices: [number, number, number][] = [];
  const triangles: [number, number, number][] = [];

  const indexOf = (v: [number, number, number]) => {
    const key = `${v[0].toFixed(5)},${v[1].toFixed(5)},${v[2].toFixed(5)}`;
    const existing = map.get(key);
    if (existing !== undefined) return existing;
    const id = vertices.length;
    map.set(key, id);
    vertices.push(v);
    return id;
  };

  for (const tri of mesh.triangles) {
    triangles.push([indexOf(tri.vertices[0]), indexOf(tri.vertices[1]), indexOf(tri.vertices[2])]);
  }

  return { vertices, triangles };
}

export async function meshTo3mf(mesh: Mesh, name = "DescribePrint"): Promise<Buffer> {
  const { vertices, triangles } = weldVertices(mesh);
  const vertexXml = vertices
    .map(([x, y, z]) => `          <vertex x="${x}" y="${y}" z="${z}"/>`)
    .join("\n");
  const triangleXml = triangles
    .map(([v1, v2, v3]) => `          <triangle v1="${v1}" v2="${v2}" v3="${v3}"/>`)
    .join("\n");

  const model = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <metadata name="Application">DescribePrint</metadata>
  <metadata name="Title">${xmlEscape(name)}</metadata>
  <resources>
    <basematerials id="1">
      <base name="Default" displaycolor="#C4C4C8FF"/>
    </basematerials>
    <object id="2" type="model" pid="1" pindex="0">
      <mesh>
        <vertices>
${vertexXml}
        </vertices>
        <triangles>
${triangleXml}
        </triangles>
      </mesh>
    </object>
  </resources>
  <build>
    <item objectid="2"/>
  </build>
</model>
`;

  const zip = new JSZip();
  zip.file("[Content_Types].xml", CONTENT_TYPES);
  zip.folder("_rels")?.file(".rels", RELS);
  zip.folder("3D")?.file("3dmodel.model", model);
  const bytes = await zip.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
  return Buffer.from(bytes);
}

const UNIT_TO_MM: Record<string, number> = {
  micron: 0.001,
  micrometer: 0.001,
  millimeter: 1,
  centimeter: 10,
  meter: 1000,
  inch: 25.4,
  foot: 304.8,
};

function attr(tag: string, name: string): string | undefined {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, "i"));
  return match?.[1];
}

function unitScale(xml: string): number {
  const match = xml.match(/<[\w.:]*model\b([^>]*)>/i);
  const unit = match ? attr(match[1] ?? "", "unit")?.toLowerCase() : undefined;
  return UNIT_TO_MM[unit ?? "millimeter"] ?? 1;
}

function parseNumber(value: string | undefined): number | null {
  if (value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Read a 3MF package into a single triangle mesh in millimeters.
 * Concatenates every <mesh> in the package. Build-item transforms are ignored
 * (M2 stub — typical single-body exports still land correctly).
 */
export async function parse3mf(buffer: Buffer): Promise<Mesh> {
  if (buffer.length < 4 || buffer.subarray(0, 2).toString("utf8") !== "PK") {
    throw new Error("File is not a 3MF package");
  }

  const zip = await JSZip.loadAsync(buffer);
  const modelFiles = Object.keys(zip.files).filter((name) => /\.model$/i.test(name) && !zip.files[name]?.dir);
  if (modelFiles.length === 0) {
    throw new Error("3MF package has no .model mesh");
  }

  const triangles: Triangle[] = [];
  for (const name of modelFiles) {
    const xml = await zip.files[name]!.async("string");
    const scale = unitScale(xml);
    const meshBlocks = xml.match(/<[\w.:]*mesh\b[\s\S]*?<\/[\w.:]*mesh>/gi) ?? [];
    for (const block of meshBlocks) {
      const vertices: [number, number, number][] = [];
      for (const v of block.matchAll(/<[\w.:]*vertex\b([^>]*)\/?>/gi)) {
        const x = parseNumber(attr(v[1] ?? "", "x"));
        const y = parseNumber(attr(v[1] ?? "", "y"));
        const z = parseNumber(attr(v[1] ?? "", "z"));
        if (x === null || y === null || z === null) {
          throw new Error("3MF vertex is missing x/y/z");
        }
        vertices.push([x * scale, y * scale, z * scale]);
      }
      for (const t of block.matchAll(/<[\w.:]*triangle\b([^>]*)\/?>/gi)) {
        const i0 = parseNumber(attr(t[1] ?? "", "v1"));
        const i1 = parseNumber(attr(t[1] ?? "", "v2"));
        const i2 = parseNumber(attr(t[1] ?? "", "v3"));
        if (i0 === null || i1 === null || i2 === null) {
          throw new Error("3MF triangle is missing v1/v2/v3");
        }
        const a = vertices[i0];
        const b = vertices[i1];
        const c = vertices[i2];
        if (!a || !b || !c) {
          throw new Error("3MF triangle references a missing vertex");
        }
        triangles.push({
          normal: [0, 0, 0],
          vertices: [a, b, c],
        });
      }
    }
  }

  if (triangles.length === 0) {
    throw new Error("3MF mesh has no triangles");
  }
  return { triangles };
}

export function looksLike3mf(buffer: Buffer, fileName?: string): boolean {
  if (fileName && /\.3mf$/i.test(fileName)) return true;
  return buffer.length >= 4 && buffer.subarray(0, 2).toString("utf8") === "PK";
}
