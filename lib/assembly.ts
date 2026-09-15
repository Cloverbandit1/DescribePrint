/**
 * Assembly / explode stub — inspect multi-body designs as assembled or exploded.
 *
 * Detects parts from planned joints, named OpenSCAD modules, multi-object 3MF
 * regions, or disconnected mesh islands. Explode offsets are a one-axis
 * heuristic — not constraint-solved kinematics.
 */
import { slugifyRegionName, DEFAULT_COLOR_HEX, DEFAULT_COLOR_NAME, type ColorRegion } from "./color-regions";
import { inferJointType, type CadJoint, type JointType } from "./joints";
import { boundingBoxMm, signedVolumeMm3 } from "./mesh-check";
import { translateMesh } from "./mesh-transform";
import { extractOpenScadAssemblyBodies } from "./openscad-colors";
import JSZip from "jszip";
import { writeBinaryStl } from "./stl";
import { parse3mfDocument, type ThreeMfObject } from "./threemf";
import type { BoundingBoxMm, Mesh } from "./types";

export const ASSEMBLY_DISCLAIMER =
  "Assembly explode is a heuristic offset along one axis — not constraint-solved kinematics.";

export const EXPLODE_GAP_MM = 12;

export type AssemblySource = "joints" | "modules" | "color-regions" | "mesh-islands" | "single";

export type ExplodeAxis = "x" | "y" | "z";

export type AssemblyPartInfo = {
  id: string;
  name: string;
  triangleCount: number;
  boundingBoxMm: BoundingBoxMm;
  explodeOffsetMm: [number, number, number];
};

export type AssemblyInfo = {
  isAssembly: boolean;
  source: AssemblySource;
  parts: AssemblyPartInfo[];
  explodeAxis: ExplodeAxis;
  explodeGapMm: number;
  kinematics: false;
  method: "heuristic-offset";
  disclaimer: string;
};

export type AssemblyPartMesh = {
  id: string;
  name: string;
  mesh: Mesh;
  colorHex: string;
  colorName?: string;
  filament?: string;
  extruder?: number;
};

const JOINT_PART_LABELS: Record<JointType, string[]> = {
  hinge: ["box body", "lid", "hinge pin"],
  pin: ["stator", "rotor"],
  ball: ["socket", "ball"],
  snap: ["catch", "hook"],
};

const AXIS_INDEX: Record<ExplodeAxis, 0 | 1 | 2> = { x: 0, y: 1, z: 2 };

function prettyPartName(raw: string, index: number): string {
  const cleaned = raw.replace(/^region_/, "").replace(/[_-]+/g, " ").trim();
  return cleaned || `part ${index + 1}`;
}

function uniquePartId(name: string, used: Set<string>, index: number): string {
  let id = slugifyRegionName(name);
  if (!used.has(id)) {
    used.add(id);
    return id;
  }
  id = `${id}_${index + 1}`;
  used.add(id);
  return id;
}

export function inferExplodeAxis(boxes: BoundingBoxMm[]): ExplodeAxis {
  if (boxes.length === 0) return "x";
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const box of boxes) {
    min[0] = Math.min(min[0], box.min[0]);
    min[1] = Math.min(min[1], box.min[1]);
    min[2] = Math.min(min[2], box.min[2]);
    max[0] = Math.max(max[0], box.max[0]);
    max[1] = Math.max(max[1], box.max[1]);
    max[2] = Math.max(max[2], box.max[2]);
  }
  const size: [number, number, number] = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  if (size[1] >= size[0] && size[1] >= size[2]) return "y";
  if (size[0] >= size[2]) return "x";
  return "z";
}

/**
 * Offset each part along `axis` so AABBs sit in a line with `gapMm` between them.
 * Order follows assembled centroids. Not a joint solver.
 */
export function explodeOffsetsMm(
  boxes: BoundingBoxMm[],
  axis: ExplodeAxis = inferExplodeAxis(boxes),
  gapMm = EXPLODE_GAP_MM,
): Array<[number, number, number]> {
  if (boxes.length <= 1) return boxes.map(() => [0, 0, 0]);
  const idx = AXIS_INDEX[axis];
  const ranked = boxes.map((box, index) => ({
    index,
    box,
    centroid: (box.min[idx] + box.max[idx]) / 2,
  }));
  ranked.sort((a, b) => a.centroid - b.centroid || a.index - b.index);

  let cursor = 0;
  const raw: number[] = ranked.map(() => 0);
  for (let i = 0; i < ranked.length; i++) {
    const item = ranked[i]!;
    raw[i] = cursor - item.box.min[idx];
    cursor += item.box.size[idx] + Math.max(gapMm, 0);
  }
  const mean = raw.reduce((sum, value) => sum + value, 0) / raw.length;
  const offsets: Array<[number, number, number]> = boxes.map(() => [0, 0, 0]);
  for (let i = 0; i < ranked.length; i++) {
    const vec: [number, number, number] = [0, 0, 0];
    vec[idx] = Math.round((raw[i]! - mean) * 100) / 100;
    offsets[ranked[i]!.index] = vec;
  }
  return offsets;
}

export function applyExplodeOffsets(meshes: Mesh[], offsets: Array<[number, number, number]>): Mesh[] {
  return meshes.map((mesh, index) => translateMesh(mesh, offsets[index] ?? [0, 0, 0]));
}

export function combineMeshes(meshes: Mesh[]): Mesh {
  return { triangles: meshes.flatMap((mesh) => mesh.triangles) };
}

export function explodedMeshFromParts(parts: AssemblyPartMesh[], axis?: ExplodeAxis, gapMm = EXPLODE_GAP_MM): Mesh {
  const boxes = parts.map((part) => boundingBoxMm(part.mesh));
  const explodeAxis = axis ?? inferExplodeAxis(boxes);
  const offsets = explodeOffsetsMm(boxes, explodeAxis, gapMm);
  return combineMeshes(applyExplodeOffsets(parts.map((part) => part.mesh), offsets));
}

function detectSource(opts: {
  objectCount: number;
  code?: string | null;
  joints?: CadJoint[] | null;
  prompt?: string | null;
  namedColors: boolean;
}): AssemblySource {
  if (opts.objectCount < 2) return "single";
  if (opts.namedColors) return "color-regions";
  if (opts.joints?.length || inferJointType(opts.prompt ?? "")) return "joints";
  if (opts.code && extractOpenScadAssemblyBodies(opts.code).length >= 2) return "modules";
  return "mesh-islands";
}

function namesFromContext(
  count: number,
  opts: { code?: string | null; joints?: CadJoint[] | null; prompt?: string | null; objectNames?: string[] },
): string[] {
  const fromObjects = (opts.objectNames ?? []).map((name, index) => prettyPartName(name, index));
  if (fromObjects.length >= count && fromObjects.some((name) => !/^part\s+\d+$/i.test(name) && name !== "part" && name !== "DescribePrint")) {
    return fromObjects.slice(0, count);
  }
  const bodies = opts.code ? extractOpenScadAssemblyBodies(opts.code) : [];
  if (bodies.length >= count) {
    return bodies.slice(0, count).map((body, index) => prettyPartName(body.name, index));
  }
  const jointType = opts.joints?.[0]?.type ?? inferJointType(opts.prompt ?? "");
  const labels = jointType ? JOINT_PART_LABELS[jointType] : [];
  if (labels.length >= count) return labels.slice(0, count);
  if (labels.length && count === labels.length + 0) return labels;
  return Array.from({ length: count }, (_, index) => labels[index] ?? `part ${index + 1}`);
}

export function partsFromObjects(
  objects: ThreeMfObject[],
  opts: { code?: string | null; joints?: CadJoint[] | null; prompt?: string | null } = {},
): AssemblyPartMesh[] {
  const used = new Set<string>();
  const names = namesFromContext(objects.length, {
    ...opts,
    objectNames: objects.map((object) => object.name),
  });
  return objects.map((object, index) => {
    const name = prettyPartName(names[index] ?? object.name ?? `part ${index + 1}`, index);
    return {
      id: uniquePartId(name, used, index),
      name,
      mesh: object.mesh,
      colorHex: object.colorHex ?? DEFAULT_COLOR_HEX,
      colorName: object.colorName,
      filament: object.filament,
      extruder: object.extruder,
    };
  });
}

export function partsFromIslands(
  islands: Mesh[],
  opts: { code?: string | null; joints?: CadJoint[] | null; prompt?: string | null } = {},
): AssemblyPartMesh[] {
  const ranked = islands
    .map((mesh, index) => ({ mesh, index, volume: Math.abs(signedVolumeMm3(mesh)) }))
    .sort((a, b) => b.volume - a.volume || a.index - b.index);
  const names = namesFromContext(ranked.length, opts);
  const used = new Set<string>();
  return ranked.map((item, index) => {
    const name = prettyPartName(names[index] ?? `part ${index + 1}`, index);
    return {
      id: uniquePartId(name, used, index),
      name,
      mesh: item.mesh,
      colorHex: DEFAULT_COLOR_HEX,
      colorName: DEFAULT_COLOR_NAME,
    };
  });
}

export function assemblyFromParts(
  parts: AssemblyPartMesh[],
  opts: { code?: string | null; joints?: CadJoint[] | null; prompt?: string | null; namedColors?: boolean } = {},
): AssemblyInfo {
  const boxes = parts.map((part) => boundingBoxMm(part.mesh));
  const explodeAxis = inferExplodeAxis(boxes);
  const offsets = explodeOffsetsMm(boxes, explodeAxis, EXPLODE_GAP_MM);
  const source = detectSource({
    objectCount: parts.length,
    code: opts.code,
    joints: opts.joints,
    prompt: opts.prompt,
    namedColors: Boolean(opts.namedColors),
  });
  return {
    isAssembly: parts.length >= 2,
    source,
    parts: parts.map((part, index) => ({
      id: part.id,
      name: part.name,
      triangleCount: part.mesh.triangles.length,
      boundingBoxMm: boxes[index]!,
      explodeOffsetMm: offsets[index] ?? [0, 0, 0],
    })),
    explodeAxis,
    explodeGapMm: EXPLODE_GAP_MM,
    kinematics: false,
    method: "heuristic-offset",
    disclaimer: ASSEMBLY_DISCLAIMER,
  };
}

export function emptyAssembly(): AssemblyInfo {
  return {
    isAssembly: false,
    source: "single",
    parts: [],
    explodeAxis: "x",
    explodeGapMm: EXPLODE_GAP_MM,
    kinematics: false,
    method: "heuristic-offset",
    disclaimer: ASSEMBLY_DISCLAIMER,
  };
}

export function formatAssemblyNote(assembly: AssemblyInfo | null | undefined): string {
  if (!assembly?.isAssembly || assembly.parts.length < 2) return "";
  const names = assembly.parts.map((part) => part.name).join(", ");
  return `Assembly (${assembly.parts.length} parts: ${names}). Toggle Assembled / Exploded on the plate. Download part STLs or the multi-object 3MF. ${ASSEMBLY_DISCLAIMER}`;
}

export function assemblyPartFileName(part: { id: string; name?: string }): string {
  return `${slugifyRegionName(part.id || part.name || "part")}.stl`;
}

export function partStlBuffer(part: AssemblyPartMesh): Buffer {
  return writeBinaryStl(part.mesh, part.name.slice(0, 80));
}

export function explodedStlBuffer(parts: AssemblyPartMesh[], assembly?: AssemblyInfo | null): Buffer {
  const mesh = explodedMeshFromParts(parts, assembly?.explodeAxis, assembly?.explodeGapMm ?? EXPLODE_GAP_MM);
  return writeBinaryStl(mesh, "DescribePrint exploded");
}

export function objectsFromAssemblyParts(parts: AssemblyPartMesh[]): ThreeMfObject[] {
  return parts.map((part, index) => ({
    name: part.name,
    mesh: part.mesh,
    colorHex: part.colorHex ?? DEFAULT_COLOR_HEX,
    colorName: part.colorName ?? DEFAULT_COLOR_NAME,
    filament: part.filament,
    extruder: part.extruder ?? Math.min(index + 1, 4),
  }));
}

export function hasNamedPartColors(regions: ColorRegion[]): boolean {
  return regions.some((region) => (region.colorName ?? DEFAULT_COLOR_NAME) !== DEFAULT_COLOR_NAME);
}

export async function partsFromThreeMf(
  buffer: Buffer,
  opts: { code?: string | null; joints?: CadJoint[] | null; prompt?: string | null } = {},
): Promise<AssemblyPartMesh[]> {
  const parsed = await parse3mfDocument(buffer);
  if (parsed.objects.length === 0) return [];
  return partsFromObjects(parsed.objects, opts);
}

export async function partsZipBuffer(parts: AssemblyPartMesh[]): Promise<Buffer> {
  const zip = new JSZip();
  for (const part of parts) {
    zip.file(assemblyPartFileName(part), partStlBuffer(part));
  }
  const bytes = await zip.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
  return Buffer.from(bytes);
}

export function partDownloadUrl(jobId: string, partId: string): string {
  return `/api/jobs/${jobId}/part-${slugifyRegionName(partId)}.stl`;
}
