import { defaultColorRegion, type ColorRegion } from "./color-regions";
import { colorRegionsFromObjects, looksLike3mf, parse3mfDocument, type ThreeMfObject } from "./threemf";
import { parseStl } from "./stl";
import type { Mesh } from "./types";

export const MAX_IMPORT_BYTES = 30 * 1024 * 1024;

export type ImportedMeshFormat = "stl" | "3mf";

export type ImportedMesh = {
  mesh: Mesh;
  format: ImportedMeshFormat;
  fileName: string;
  objects: ThreeMfObject[];
  colorRegions: ColorRegion[];
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
  if (format === "3mf") {
    const parsed = await parse3mfDocument(buffer);
    if (parsed.mesh.triangles.length === 0) {
      throw new Error("Imported mesh has no triangles.");
    }
    const objects = parsed.objects.length
      ? parsed.objects
      : [{ name: safeName, mesh: parsed.mesh, colorHex: "#C4C4C8", colorName: "default", filament: "pla", extruder: 1 }];
    return {
      mesh: parsed.mesh,
      format,
      fileName: safeName,
      objects,
      colorRegions: colorRegionsFromObjects(objects),
    };
  }

  const mesh = parseStl(buffer);
  if (mesh.triangles.length === 0) {
    throw new Error("Imported mesh has no triangles.");
  }
  const region = defaultColorRegion();
  return {
    mesh,
    format,
    fileName: safeName,
    objects: [{ name: safeName, mesh, colorHex: region.colorHex, colorName: region.colorName, filament: region.filament, extruder: region.amsSlot }],
    colorRegions: [region],
  };
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
