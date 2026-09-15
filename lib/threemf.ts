import JSZip from "jszip";
import {
  DEFAULT_COLOR_HEX,
  DEFAULT_COLOR_NAME,
  displayColorHex,
  normalizeColorHex,
  slugifyRegionName,
  type ColorRegion,
} from "./color-regions";
import {
  amsSlotPlanSidecarJson,
  buildAmsSlotPlan,
  declaredDesignFilaments,
  parseAmsSlotPlan,
} from "./machine/ams";
import type { AmsSlotPlan } from "./machine/types";
import { normalizeFilamentId, printPresetSummary, type FilamentId, type PrintPresetSummary } from "./printers";
import type { Mesh, Triangle } from "./types";

export type ThreeMfObject = {
  id?: number;
  name: string;
  mesh: Mesh;
  colorHex: string;
  colorName?: string;
  filament?: string;
  extruder?: number;
};

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
  <Default Extension="config" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
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

function xmlUnescape(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
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

function objectMeshXml(mesh: Mesh): { vertexXml: string; triangleXml: string } {
  const { vertices, triangles } = weldVertices(mesh);
  return {
    vertexXml: vertices.map(([x, y, z]) => `          <vertex x="${x}" y="${y}" z="${z}"/>`).join("\n"),
    triangleXml: triangles
      .map(([v1, v2, v3]) => `          <triangle v1="${v1}" v2="${v2}" v3="${v3}"/>`)
      .join("\n"),
  };
}

function defaultObject(mesh: Mesh, name: string, filament: FilamentId = "pla"): ThreeMfObject {
  return {
    name,
    mesh,
    colorHex: DEFAULT_COLOR_HEX,
    colorName: DEFAULT_COLOR_NAME,
    filament,
    extruder: 1,
  };
}

export function objectsFromRegions(
  meshes: Mesh[],
  regions: ColorRegion[],
  fallbackName = "part",
  fallbackFilament: FilamentId = "pla",
): ThreeMfObject[] {
  if (meshes.length === 0) return [];
  if (meshes.length === 1 && regions.length <= 1) {
    const region = regions[0];
    return [
      {
        name: region?.name ?? fallbackName,
        mesh: meshes[0],
        colorHex: region?.colorHex ?? DEFAULT_COLOR_HEX,
        colorName: region?.colorName ?? DEFAULT_COLOR_NAME,
        filament: region?.filament ?? fallbackFilament,
        extruder: region?.amsSlot ?? 1,
      },
    ];
  }
  return meshes.map((mesh, index) => {
    const region = regions[index] ?? regions[0];
    return {
      name: region?.name ?? `${fallbackName}-${index + 1}`,
      mesh,
      colorHex: region?.colorHex ?? DEFAULT_COLOR_HEX,
      colorName: region?.colorName ?? DEFAULT_COLOR_NAME,
      filament: region?.filament ?? fallbackFilament,
      extruder: region?.amsSlot ?? Math.min(index + 1, 4),
    };
  });
}

export function colorRegionsFromObjects(objects: ThreeMfObject[]): ColorRegion[] {
  if (objects.length === 0) return [];
  return objects.map((object, index) => ({
    id: slugifyRegionName(object.name || `region_${index + 1}`),
    name: object.name || `region_${index + 1}`,
    colorName: object.colorName ?? DEFAULT_COLOR_NAME,
    colorHex: normalizeColorHex(object.colorHex) ?? DEFAULT_COLOR_HEX,
    filament: normalizeFilamentId(object.filament) ?? "pla",
    amsSlot: object.extruder && object.extruder >= 1 ? object.extruder : index + 1,
  }));
}

function modelSettingsXml(objects: Array<ThreeMfObject & { id: number }>): string {
  const blocks = objects
    .map((object) => {
      const extruder = object.extruder ?? 1;
      const name = xmlEscape(object.name);
      return `  <object id="${object.id}">
    <metadata key="name" value="${name}"/>
    <metadata key="extruder" value="${extruder}"/>
    <part id="1" subtype="normal_part">
      <metadata key="name" value="${name}"/>
      <metadata key="extruder" value="${extruder}"/>
      <metadata key="filament" value="${xmlEscape(object.filament ?? "pla")}"/>
      <metadata key="filament_colour" value="${normalizeColorHex(object.colorHex) ?? DEFAULT_COLOR_HEX}"/>
    </part>
  </object>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<config>
${blocks}
</config>
`;
}

function printPresetMetadataXml(preset: PrintPresetSummary): string {
  const rows: Array<[string, string]> = [
    ["DescribePrint:preset_material", preset.material],
    ["DescribePrint:preset_name", preset.name],
    ["DescribePrint:preset_nozzle_c", String(preset.nozzleC)],
    ["DescribePrint:preset_bed_c", String(preset.bedC)],
    ["DescribePrint:preset_speed_mms", String(preset.printSpeedMms)],
    ["DescribePrint:preset_speed_tier", preset.speedTier],
    ["DescribePrint:preset_fan_percent", String(preset.fanPercent)],
    ["DescribePrint:preset_cooling", preset.coolingHint],
    ["DescribePrint:preset_flow_percent", String(preset.flowPercent)],
    ["DescribePrint:preset_advisory", "true"],
  ];
  return rows.map(([key, value]) => `  <metadata name="${xmlEscape(key)}">${xmlEscape(value)}</metadata>`).join("\n");
}

export function planFromThreeMfObjects(
  objects: ThreeMfObject[],
  material: string,
  explicit?: AmsSlotPlan | null,
): AmsSlotPlan {
  if (explicit?.slots.length) return explicit;
  return buildAmsSlotPlan({
    material,
    design: declaredDesignFilaments(
      objects.map((object, index) => ({
        id: object.name || `object-${index + 1}`,
        name: object.name,
        type: object.filament,
        colorHex: object.colorHex,
        colorName: object.colorName,
      })),
    ),
  });
}

export function amsSlotPlanMetadataXml(plan: AmsSlotPlan): string {
  const rows: Array<[string, string]> = [["DescribePrint:ams_plan", JSON.stringify(plan)]];
  for (const slot of plan.slots) {
    rows.push([`DescribePrint:ams_tray_${slot.index}`, slot.material]);
    if (slot.color) rows.push([`DescribePrint:ams_tray_${slot.index}_color`, slot.color]);
    rows.push([`DescribePrint:ams_tray_${slot.index}_source`, slot.source]);
    if (slot.designId) rows.push([`DescribePrint:ams_tray_${slot.index}_design`, slot.designId]);
  }
  return rows.map(([key, value]) => `  <metadata name="${xmlEscape(key)}">${xmlEscape(value)}</metadata>`).join("\n");
}

function stripAmsPlanMetadata(xml: string): string {
  return xml.replace(/\s*<metadata name="DescribePrint:ams_[^"]*">[\s\S]*?<\/metadata>/g, "");
}

export function upsertAmsPlanMetadata(xml: string, plan: AmsSlotPlan): string {
  const cleaned = stripAmsPlanMetadata(xml);
  const block = amsSlotPlanMetadataXml(plan);
  if (/DescribePrint:preset_advisory/.test(cleaned)) {
    return cleaned.replace(
      /(<metadata name="DescribePrint:preset_advisory">[\s\S]*?<\/metadata>)/,
      `$1\n${block}`,
    );
  }
  if (/<metadata name="Title">/.test(cleaned)) {
    return cleaned.replace(/(<metadata name="Title">[\s\S]*?<\/metadata>)/, `$1\n${block}`);
  }
  return cleaned.replace(/(<model\b[^>]*>)/i, `$1\n${block}`);
}

function parseModelAmsSlotPlan(xml: string): AmsSlotPlan | undefined {
  for (const meta of xml.matchAll(/<[\w.:]*metadata\b([^>]*)>([\s\S]*?)<\/[\w.:]*metadata>/gi)) {
    const key = (attr(meta[1] ?? "", "name") ?? "").toLowerCase();
    const value = xmlUnescape((meta[2] ?? "").trim());
    if (key === "describeprint:ams_plan" && value) {
      const parsed = parseAmsSlotPlan(value);
      if (parsed?.slots.length) return parsed;
    }
  }
  const slots: AmsSlotPlan["slots"] = [];
  for (const meta of xml.matchAll(/<[\w.:]*metadata\b([^>]*)>([\s\S]*?)<\/[\w.:]*metadata>/gi)) {
    const key = (attr(meta[1] ?? "", "name") ?? "").toLowerCase();
    const value = (meta[2] ?? "").trim();
    const tray = key.match(/^describeprint:ams_tray_(\d+)$/);
    if (tray && value) {
      const index = Number(tray[1]);
      slots.push({ index, material: value, source: "preset" });
    }
    const color = key.match(/^describeprint:ams_tray_(\d+)_color$/);
    if (color) {
      const index = Number(color[1]);
      const existing = slots.find((slot) => slot.index === index);
      if (existing && value) existing.color = value;
    }
    const source = key.match(/^describeprint:ams_tray_(\d+)_source$/);
    if (source) {
      const index = Number(source[1]);
      const existing = slots.find((slot) => slot.index === index);
      if (existing && (value === "live" || value === "preset" || value === "manual")) existing.source = value;
    }
  }
  return slots.length ? { slots } : undefined;
}

export async function meshesTo3mf(
  objects: ThreeMfObject[],
  name = "DescribePrint",
  printPreset?: PrintPresetSummary | null,
  amsSlotPlan?: AmsSlotPlan | null,
): Promise<Buffer> {
  const preset = printPreset ?? printPresetSummary("pla");
  const list = (objects.length ? objects : [defaultObject({ triangles: [] }, name, preset.material)]).map((object, index) => ({
    ...object,
    id: object.id ?? index + 2,
  }));
  const slotPlan = planFromThreeMfObjects(list, preset.material, amsSlotPlan);

  const materials = list
    .map((object, index) => {
      const label = object.colorName && object.colorName !== DEFAULT_COLOR_NAME
        ? `${object.name} (${object.colorName} ${(object.filament ?? "pla").toUpperCase()})`
        : object.name;
      return `      <base name="${xmlEscape(label)}" displaycolor="${displayColorHex(object.colorHex)}"/>`;
    })
    .join("\n");

  const objectXml = list
    .map((object, index) => {
      const { vertexXml, triangleXml } = objectMeshXml(object.mesh);
      const extruder = object.extruder ?? 1;
      return `    <object id="${object.id}" name="${xmlEscape(object.name)}" type="model" pid="1" pindex="${index}">
      <metadata name="Title">${xmlEscape(object.name)}</metadata>
      <metadata name="slic3rpe:extruder">${extruder}</metadata>
      <metadata name="DescribePrint:ams_slot">${extruder}</metadata>
      <metadata name="DescribePrint:filament">${xmlEscape(object.filament ?? "pla")}</metadata>
      <mesh>
        <vertices>
${vertexXml}
        </vertices>
        <triangles>
${triangleXml}
        </triangles>
      </mesh>
    </object>`;
    })
    .join("\n");

  const buildItems = list.map((object) => `    <item objectid="${object.id}"/>`).join("\n");

  const model = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:slic3rpe="http://schemas.slic3r.org/3mf/2017/06">
  <metadata name="Application">DescribePrint</metadata>
  <metadata name="Title">${xmlEscape(name)}</metadata>
${printPresetMetadataXml(preset)}
${amsSlotPlanMetadataXml(slotPlan)}
  <resources>
    <basematerials id="1">
${materials}
    </basematerials>
${objectXml}
  </resources>
  <build>
${buildItems}
  </build>
</model>
`;

  const zip = new JSZip();
  zip.file("[Content_Types].xml", CONTENT_TYPES);
  zip.folder("_rels")?.file(".rels", RELS);
  zip.folder("3D")?.file("3dmodel.model", model);
  const metadata = zip.folder("Metadata");
  metadata?.file("model_settings.config", modelSettingsXml(list));
  metadata?.file("print_preset.json", `${JSON.stringify(preset)}\n`);
  metadata?.file("ams_slot_plan.json", amsSlotPlanSidecarJson(slotPlan));
  const bytes = await zip.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
  return Buffer.from(bytes);
}

export async function meshTo3mf(
  mesh: Mesh,
  name = "DescribePrint",
  printPreset?: PrintPresetSummary | null,
  amsSlotPlan?: AmsSlotPlan | null,
): Promise<Buffer> {
  return meshesTo3mf([defaultObject(mesh, name, printPreset?.material ?? "pla")], name, printPreset, amsSlotPlan);
}

/** Rewrite AMS plan metadata in an existing 3MF without remeshing. */
export async function stampAmsSlotPlan(buffer: Buffer, plan: AmsSlotPlan): Promise<Buffer> {
  const zip = await JSZip.loadAsync(buffer);
  const modelFiles = Object.keys(zip.files).filter((name) => /\.model$/i.test(name) && !zip.files[name]?.dir);
  for (const name of modelFiles) {
    const xml = await zip.files[name]!.async("string");
    zip.file(name, upsertAmsPlanMetadata(xml, plan));
  }
  const sidecarName =
    Object.keys(zip.files).find((name) => /ams_slot_plan\.json$/i.test(name)) ?? "Metadata/ams_slot_plan.json";
  zip.file(sidecarName, amsSlotPlanSidecarJson(plan));
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

function parseMeshBlock(block: string, scale: number): Mesh {
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
  const triangles: Triangle[] = [];
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
  return { triangles };
}

function parseBaseMaterials(xml: string): Map<string, { name: string; colorHex: string }> {
  const materials = new Map<string, { name: string; colorHex: string }>();
  for (const group of xml.matchAll(/<[\w.:]*basematerials\b([^>]*)>([\s\S]*?)<\/[\w.:]*basematerials>/gi)) {
    const groupId = attr(group[1] ?? "", "id") ?? "1";
    let index = 0;
    for (const base of (group[2] ?? "").matchAll(/<[\w.:]*base\b([^>]*)\/?>/gi)) {
      const name = attr(base[1] ?? "", "name") ?? `material-${index}`;
      const colorHex = normalizeColorHex(attr(base[1] ?? "", "displaycolor")) ?? DEFAULT_COLOR_HEX;
      materials.set(`${groupId}:${index}`, { name, colorHex });
      index += 1;
    }
  }
  for (const group of xml.matchAll(/<[\w.:]*colorgroup\b([^>]*)>([\s\S]*?)<\/[\w.:]*colorgroup>/gi)) {
    const groupId = attr(group[1] ?? "", "id") ?? "color";
    let index = 0;
    for (const color of (group[2] ?? "").matchAll(/<[\w.:]*color\b([^>]*)\/?>/gi)) {
      const colorHex = normalizeColorHex(attr(color[1] ?? "", "color")) ?? DEFAULT_COLOR_HEX;
      materials.set(`${groupId}:${index}`, { name: `color-${index}`, colorHex });
      index += 1;
    }
  }
  return materials;
}

function parseObjectMetadata(body: string): { extruder?: number; filament?: string; title?: string } {
  let extruder: number | undefined;
  let filament: string | undefined;
  let title: string | undefined;
  for (const meta of body.matchAll(/<[\w.:]*metadata\b([^>]*)>([\s\S]*?)<\/[\w.:]*metadata>/gi)) {
    const key = (attr(meta[1] ?? "", "name") ?? "").toLowerCase();
    const value = (meta[2] ?? "").trim();
    if (/extruder|ams_slot/.test(key)) {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 1) extruder = n;
    }
    if (/filament$/.test(key) && value) filament = value;
    if (key === "title" && value) title = value;
  }
  return { extruder, filament, title };
}

function parseModelSettings(xml: string): Map<number, { extruder?: number; name?: string; filament?: string; colorHex?: string }> {
  const map = new Map<number, { extruder?: number; name?: string; filament?: string; colorHex?: string }>();
  for (const object of xml.matchAll(/<object\b([^>]*)>([\s\S]*?)<\/object>/gi)) {
    const id = parseNumber(attr(object[1] ?? "", "id"));
    if (id === null) continue;
    const info: { extruder?: number; name?: string; filament?: string; colorHex?: string } = {};
    for (const meta of (object[2] ?? "").matchAll(/<metadata\b([^>]*)\/?>/gi)) {
      const key = (attr(meta[1] ?? "", "key") ?? "").toLowerCase();
      const value = attr(meta[1] ?? "", "value") ?? "";
      if (key === "name") info.name = value;
      if (key === "extruder") {
        const n = Number(value);
        if (Number.isFinite(n) && n >= 1) info.extruder = n;
      }
      if (key === "filament") info.filament = value;
      if (key === "filament_colour" || key === "filament_color") info.colorHex = normalizeColorHex(value);
    }
    map.set(id, info);
  }
  return map;
}

export type Parsed3mf = {
  mesh: Mesh;
  objects: ThreeMfObject[];
  printPreset?: PrintPresetSummary;
  amsSlotPlan?: AmsSlotPlan;
};

function parseModelPrintPreset(xml: string): PrintPresetSummary | undefined {
  const fields = new Map<string, string>();
  for (const meta of xml.matchAll(/<[\w.:]*metadata\b([^>]*)>([\s\S]*?)<\/[\w.:]*metadata>/gi)) {
    const key = (attr(meta[1] ?? "", "name") ?? "").toLowerCase();
    const value = (meta[2] ?? "").trim();
    if (key.startsWith("describeprint:preset_") && value) {
      fields.set(key.replace("describeprint:preset_", ""), value);
    }
  }
  const material = normalizeFilamentId(fields.get("material"));
  if (!material) return undefined;
  const summary = printPresetSummary(material);
  const nozzleC = Number(fields.get("nozzle_c"));
  const bedC = Number(fields.get("bed_c"));
  return {
    ...summary,
    name: fields.get("name") || summary.name,
    nozzleC: Number.isFinite(nozzleC) ? nozzleC : summary.nozzleC,
    bedC: Number.isFinite(bedC) ? bedC : summary.bedC,
    speedTier: (fields.get("speed_tier") as PrintPresetSummary["speedTier"]) || summary.speedTier,
    coolingHint: fields.get("cooling") || summary.coolingHint,
    advisory: true,
  };
}

/**
 * Read a 3MF package into objects (colors preserved when present) plus a
 * concatenated preview mesh in millimeters. Build-item transforms are ignored.
 */
export async function parse3mfDocument(buffer: Buffer): Promise<Parsed3mf> {
  if (buffer.length < 4 || buffer.subarray(0, 2).toString("utf8") !== "PK") {
    throw new Error("File is not a 3MF package");
  }

  const zip = await JSZip.loadAsync(buffer);
  const modelFiles = Object.keys(zip.files).filter((name) => /\.model$/i.test(name) && !zip.files[name]?.dir);
  if (modelFiles.length === 0) {
    throw new Error("3MF package has no .model mesh");
  }

  let settings = new Map<number, { extruder?: number; name?: string; filament?: string; colorHex?: string }>();
  const settingsFile = Object.keys(zip.files).find((name) => /model_settings\.config$/i.test(name));
  if (settingsFile) {
    settings = parseModelSettings(await zip.files[settingsFile]!.async("string"));
  }

  const objects: ThreeMfObject[] = [];
  const triangles: Triangle[] = [];
  let printPreset: PrintPresetSummary | undefined;
  let amsSlotPlan: AmsSlotPlan | undefined;
  const planFile = Object.keys(zip.files).find((name) => /ams_slot_plan\.json$/i.test(name));
  if (planFile) {
    try {
      const parsed = parseAmsSlotPlan(JSON.parse(await zip.files[planFile]!.async("string")));
      if (parsed?.slots.length) amsSlotPlan = parsed;
    } catch {
      // ignore malformed sidecar
    }
  }
  const presetFile = Object.keys(zip.files).find((name) => /print_preset\.json$/i.test(name));
  if (presetFile) {
    try {
      const raw = JSON.parse(await zip.files[presetFile]!.async("string")) as PrintPresetSummary;
      if (raw && normalizeFilamentId(raw.material)) printPreset = { ...printPresetSummary(raw.material), ...raw, advisory: true };
    } catch {
      // ignore malformed sidecar inside the package
    }
  }

  for (const name of modelFiles) {
    const xml = await zip.files[name]!.async("string");
    printPreset ??= parseModelPrintPreset(xml);
    amsSlotPlan ??= parseModelAmsSlotPlan(xml);
    const scale = unitScale(xml);
    const materials = parseBaseMaterials(xml);
    const objectBlocks = xml.match(/<[\w.:]*object\b[\s\S]*?<\/[\w.:]*object>/gi) ?? [];
    for (const block of objectBlocks) {
      const header = block.match(/<[\w.:]*object\b([^>]*)>/i)?.[1] ?? "";
      const objectId = parseNumber(attr(header, "id")) ?? undefined;
      const pid = attr(header, "pid");
      const pindex = parseNumber(attr(header, "pindex"));
      const meshBlocks = block.match(/<[\w.:]*mesh\b[\s\S]*?<\/[\w.:]*mesh>/gi) ?? [];
      if (meshBlocks.length === 0) continue;
      const mesh = {
        triangles: meshBlocks.flatMap((meshBlock) => parseMeshBlock(meshBlock, scale).triangles),
      };
      if (mesh.triangles.length === 0) continue;
      const meta = parseObjectMetadata(block);
      const extra = objectId !== undefined ? settings.get(objectId) : undefined;
      const material = pid !== undefined && pindex !== null ? materials.get(`${pid}:${pindex}`) : undefined;
      const colorHex =
        extra?.colorHex ??
        material?.colorHex ??
        normalizeColorHex(attr(header, "displaycolor")) ??
        DEFAULT_COLOR_HEX;
      const objectName = extra?.name ?? attr(header, "name") ?? meta.title ?? material?.name ?? `object-${objectId ?? objects.length + 1}`;
      objects.push({
        id: objectId,
        name: objectName,
        mesh,
        colorHex,
        colorName: material?.name,
        filament: extra?.filament ?? meta.filament,
        extruder: extra?.extruder ?? meta.extruder,
      });
      triangles.push(...mesh.triangles);
    }

    if (objects.length === 0) {
      const meshBlocks = xml.match(/<[\w.:]*mesh\b[\s\S]*?<\/[\w.:]*mesh>/gi) ?? [];
      for (const block of meshBlocks) {
        const mesh = parseMeshBlock(block, scale);
        triangles.push(...mesh.triangles);
      }
    }
  }

  if (triangles.length === 0) {
    throw new Error("3MF mesh has no triangles");
  }
  return { mesh: { triangles }, objects, printPreset, amsSlotPlan };
}

/**
 * Read a 3MF package into a single triangle mesh in millimeters.
 * Concatenates every <mesh> in the package. Build-item transforms are ignored
 * (M2 stub — typical single-body exports still land correctly).
 */
export async function parse3mf(buffer: Buffer): Promise<Mesh> {
  const parsed = await parse3mfDocument(buffer);
  return parsed.mesh;
}

export function looksLike3mf(buffer: Buffer, fileName?: string): boolean {
  if (fileName && /\.3mf$/i.test(fileName)) return true;
  return buffer.length >= 4 && buffer.subarray(0, 2).toString("utf8") === "PK";
}
