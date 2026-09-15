import { looksLike3mf, parse3mf } from "./threemf";
import { parseStl } from "./stl";
import type { Mesh } from "./types";

export const MAX_IMPORT_BYTES = 30 * 1024 * 1024;

export type ImportedMeshFormat = "stl" | "3mf";

export type ImportedMesh = {
  mesh: Mesh;
  format: ImportedMeshFormat;
  fileName: string;
};

export function safeImportFileName(fileName: string | undefined): string {
  const base = (fileName ?? "imported").split(/[/\\]/).pop() ?? "imported";
  const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "");
  return cleaned.slice(0, 120) || "imported";
}

export function detectImportFormat(buffer: Buffer, fileName?: string): ImportedMeshFormat {
  const name = fileName ?? "";
  if (/\.3mf$/i.test(name) || looksLike3mf(buffer, name)) return "3mf";
  if (/\.stl$/i.test(name)) return "stl";
  if (looksLike3mf(buffer)) return "3mf";
  return "stl";
}

export async function parseImportedMesh(buffer: Buffer, fileName?: string): Promise<ImportedMesh> {
  if (!buffer?.length) {
    throw new Error("Choose an STL or 3MF file to import.");
  }
  if (buffer.length > MAX_IMPORT_BYTES) {
    throw new Error(`Import is limited to ${Math.round(MAX_IMPORT_BYTES / (1024 * 1024))} MB.`);
  }

  const safeName = safeImportFileName(fileName);
  const format = detectImportFormat(buffer, fileName ?? safeName);
  const mesh = format === "3mf" ? await parse3mf(buffer) : parseStl(buffer);
  if (mesh.triangles.length === 0) {
    throw new Error("Imported mesh has no triangles.");
  }
  return { mesh, format, fileName: safeName };
}

export function importedMeshStubScad(input: {
  fileName: string;
  sizeMm: [number, number, number];
  triangleCount: number;
  wearableSize?: string | null;
  wearableCategory?: string | null;
}): string {
  const [x, y, z] = input.sizeMm;
  const size = input.wearableSize ?? "native (assumed M)";
  const category = input.wearableCategory ?? "helmet_mask";
  return `// DescribePrint imported mesh (not generated OpenSCAD)
// file: ${input.fileName}
// bbox_mm: ${x.toFixed(2)} x ${y.toFixed(2)} x ${z.toFixed(2)}
// triangles: ${input.triangleCount}
// wearable_size: ${size}
// wearable_category: ${category}
//
// Chat follow-ups can scale this mesh or wrap it with import("imported.stl").
// Full triangle sculpt / Style2Fab is not available yet.
`;
}
