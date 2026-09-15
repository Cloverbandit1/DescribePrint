import JSZip from "jszip";
import type { Mesh } from "./types";

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
