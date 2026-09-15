import { designateMachineForSize, type MachineDesignation } from "./alternate-machines";
import { detectImportFormat } from "./import-mesh";
import { decodeImageRaster, detectImageFormat, type ImageRaster } from "./image-raster";
import { buildImageSolidMesh, DEFAULT_IMAGE_TARGET_MAX_MM } from "./image-solid";
import { checkMesh } from "./mesh-check";
import type { ImageImportMeta, ImageRasterFormat, Mesh } from "./types";

export const MAX_IMAGE_IMPORT_BYTES = 12 * 1024 * 1024;
export const IMAGE_IMPORT_ACCEPT =
  ".stl,.3mf,.png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp,model/stl,application/vnd.ms-package.3dmanufacturing-3dmodel+xml";

export type ImageImportOptions = {
  repair: boolean;
  keepWear: boolean;
  targetMaxMm: number | null;
  prompt?: string | null;
};

export type ImageSolidBuild = {
  mesh: Mesh;
  fileName: string;
  format: ImageRasterFormat;
  repairApplied: boolean;
  keepWear: boolean;
  pixelsInferred: boolean;
  targetMaxMm: number;
  thicknessMm: number;
  designation: MachineDesignation;
  notes: string[];
  meta: ImageImportMeta;
};

const KEEP_WEAR =
  /\bkeep(?:ing)?(?:\s+the)?\s+(?:damage|wear|cracks?|broken|chips?|scuffs?)\b|\bdo not repair\b|\bdon't repair\b|\bpreserve wear\b/i;

export function wantsKeepWear(text: string | null | undefined): boolean {
  return Boolean(text && KEEP_WEAR.test(text));
}

export function parseBoolFlag(value: unknown, fallback: boolean): boolean {
  if (value == null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const text = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(text)) return true;
  if (["0", "false", "no", "off"].includes(text)) return false;
  return fallback;
}

export function parseImageImportOptions(input: {
  repair?: unknown;
  keepWear?: unknown;
  keep_wear?: unknown;
  targetMaxMm?: unknown;
  target_max_mm?: unknown;
  prompt?: unknown;
  note?: unknown;
}): ImageImportOptions {
  const prompt = typeof input.prompt === "string" ? input.prompt : typeof input.note === "string" ? input.note : null;
  const keepWear =
    parseBoolFlag(input.keepWear ?? input.keep_wear, false) || wantsKeepWear(prompt);
  const repair = keepWear ? false : parseBoolFlag(input.repair, true);
  const rawTarget = input.targetMaxMm ?? input.target_max_mm;
  const target = rawTarget == null || rawTarget === "" ? null : Number(rawTarget);
  return {
    repair,
    keepWear,
    targetMaxMm: target && Number.isFinite(target) && target > 0 ? target : null,
    prompt,
  };
}

export function looksLikeImageUpload(buffer: Buffer, fileName?: string): boolean {
  return detectImageFormat(buffer, fileName) != null && !looksLikeMeshUpload(buffer, fileName);
}

function looksLikeMeshUpload(buffer: Buffer, fileName?: string): boolean {
  const name = fileName ?? "";
  if (/\.(stl|3mf)$/i.test(name)) return true;
  try {
    return detectImportFormat(buffer, fileName) === "3mf" && !detectImageFormat(buffer, fileName);
  } catch {
    return false;
  }
}

export function validateImageUpload(buffer: Buffer, fileName?: string): ImageRasterFormat {
  if (!buffer?.length) {
    throw new Error("Choose a PNG, JPG, or WebP photo.");
  }
  if (buffer.length > MAX_IMAGE_IMPORT_BYTES) {
    throw new Error(`Photo import is limited to ${Math.round(MAX_IMAGE_IMPORT_BYTES / (1024 * 1024))} MB.`);
  }
  const format = detectImageFormat(buffer, fileName);
  if (!format) {
    throw new Error("Choose a PNG, JPG, or WebP photo.");
  }
  const name = (fileName ?? "").toLowerCase();
  if (name && !/\.(png|jpe?g|webp)$/.test(name) && !detectImageFormat(buffer)) {
    throw new Error("Choose a PNG, JPG, or WebP photo.");
  }
  return format;
}

export function imageSolidStubScad(input: {
  fileName: string;
  sizeMm: [number, number, number];
  triangleCount: number;
  format: ImageRasterFormat;
  repairApplied: boolean;
  keepWear: boolean;
  designation: MachineDesignation;
}): string {
  const [x, y, z] = input.sizeMm;
  const machine = input.designation.designatedMachine
    ? `${input.designation.designatedMachine.name} (${input.designation.designatedMachine.buildVolumeMm.join(" × ")} mm)`
    : input.designation.currentPrinterName;
  return `// DescribePrint image → solid stub (not photogrammetry / NeRF)
// file: ${input.fileName}
// format: ${input.format}
// method: silhouette + thickness + inferred backside cap
// bbox_mm: ${x.toFixed(2)} x ${y.toFixed(2)} x ${z.toFixed(2)}
// triangles: ${input.triangleCount}
// repair_applied: ${input.repairApplied}
// keep_wear: ${input.keepWear}
// designated_machine: ${machine}
//
// Unseen / backside geometry is inferred. This is not a neural reconstruction.
// Chat follow-ups can scale this mesh or wrap it with import("imported.stl").
`;
}

export function imageImportNotes(build: {
  repairApplied: boolean;
  keepWear: boolean;
  pixelsInferred: boolean;
  format: ImageRasterFormat;
  thicknessMm: number;
  designation: MachineDesignation;
}): string[] {
  const notes = [
    `Photo became a full 3D printable solid (silhouette + ${build.thicknessMm.toFixed(1)} mm thickness + inferred backside cap). Not a front-only relief. Photogrammetry / NeRF is not implemented.`,
    build.repairApplied
      ? "Repair-by-default filled cracks and interior holes in the silhouette. Say “keep the wear” or turn on Keep damage to preserve chips and cracks."
      : "Keep damage / wear is on — cracks and missing chunks in the photo were left in the silhouette.",
  ];
  if (build.pixelsInferred) {
    notes.push(
      `${build.format.toUpperCase()} pixel silhouette is stubbed from the file header (rounded subject of the photo’s aspect ratio). PNG and JPG decode the real silhouette.`,
    );
  }
  if (build.designation.message) notes.push(build.designation.message);
  notes.push("Imported mesh is on the plate in millimeters. Size presets and scale/rotate/sit-on-bed edit the real triangles. Adding holes wraps the import in OpenSCAD (partial — not full mesh sculpt).");
  return notes;
}

export function buildImageSolidFromUpload(
  buffer: Buffer,
  fileName: string | undefined,
  options: ImageImportOptions,
): ImageSolidBuild {
  validateImageUpload(buffer, fileName);
  const raster: ImageRaster = decodeImageRaster(buffer, fileName);
  const built = buildImageSolidMesh(raster, {
    targetMaxMm: options.targetMaxMm ?? DEFAULT_IMAGE_TARGET_MAX_MM,
    repair: options.repair,
  });
  const report = checkMesh(built.mesh);
  const designation = designateMachineForSize(report.boundingBoxMm.size);
  const safeName = sanitizeImageFileName(fileName, raster.format);
  const keepWear = options.keepWear || !options.repair;
  const meta: ImageImportMeta = {
    kind: "image-solid",
    format: raster.format,
    repairApplied: built.repaired,
    keepWear,
    inferredBackside: true,
    method: "silhouette-extrude",
    photogrammetry: false,
    neuralReconstruction: false,
    pixelsInferred: raster.pixelsInferred,
  };
  return {
    mesh: built.mesh,
    fileName: safeName,
    format: raster.format,
    repairApplied: built.repaired,
    keepWear,
    pixelsInferred: raster.pixelsInferred,
    targetMaxMm: built.targetMaxMm,
    thicknessMm: built.thicknessMm,
    designation,
    notes: imageImportNotes({
      repairApplied: built.repaired,
      keepWear,
      pixelsInferred: raster.pixelsInferred,
      format: raster.format,
      thicknessMm: built.thicknessMm,
      designation,
    }),
    meta,
  };
}

export function sanitizeImageFileName(fileName: string | undefined, format: ImageRasterFormat): string {
  const base = (fileName ?? `photo.${format === "jpeg" ? "jpg" : format}`).split(/[/\\]/).pop() ?? "photo";
  const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "");
  return cleaned.slice(0, 120) || `photo.${format === "jpeg" ? "jpg" : format}`;
}
