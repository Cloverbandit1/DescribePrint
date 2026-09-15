import {
  getLlmConfig,
  getLlmTimeoutMs,
  isLocalOpenAiBaseUrl,
  LOCAL_AI_START_MESSAGE,
  type LlmConfig,
} from "./llm-config";
import { isDefaultOnlyRegions, mergeColorRegionSources } from "./color-regions";
import {
  hasPrintInPlaceJoints,
  inferClearanceIntent,
  normalizeCadJoints,
  parseCadJoints,
  parseClearanceIntent,
  type CadJoint,
  type ClearanceIntent,
} from "./joints";
import {
  parseDesignOptionGroups,
  resolveDesignOptions,
  type DesignOptionGroup,
} from "./design-options";
import {
  cadKnowledgeFromPrompt,
  formatKnowledgeCodegenHint,
  formatKnowledgeConstraints,
  formatKnowledgePlanHint,
  knowledgeOverallMm,
  mergeKnowledgeFeatures,
  type CadKnowledge,
} from "./knowledge";
import {
  formatPrettyUpPromptHint,
  inferCadPrettyUp,
  normalizeCadPrettyUp,
  parseCadPrettyUp,
  type CadPrettyUp,
} from "./pretty-up";
import {
  formatReliefPromptHint,
  normalizeCadReliefs,
  parseCadReliefs,
  type CadRelief,
} from "./relief";
import {
  allowsThinWalls,
  bedMaxMm,
  extractScadParams,
  formatPrinterConstraints,
  formatScadParams,
  isWallDimKey,
  printRules,
  promptAllowsOversize,
  promptAllowsSmallHole,
  statedWallMm,
  wantsMultiPart,
  wantsNewDesign,
} from "./printability";

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type CompleteChatOptions = {
  timeoutMs?: number;
  model?: string;
  temperature?: number;
};

export type CadPlan = {
  object: string;
  one_piece: boolean;
  units: "mm";
  overall_mm?: { x: number; y: number; z: number };
  features: Array<{
    name: string;
    kind?: string;
    dims_mm?: Record<string, number>;
    notes?: string;
  }>;
  holes: Array<{ d: number; purpose?: string; through?: boolean }>;
  min_wall_mm: number;
  clearance_mm: number;
  sit_on_z0: boolean;
  safety_notes?: string;
  /** Present only when the user asked for motion / a moving assembly. */
  joints?: CadJoint[];
  clearance_intent?: ClearanceIntent;
  color_regions?: Array<{
    name: string;
    color?: string;
    hex?: string;
    filament?: string;
    ams_slot?: number;
  }>;
  /** Present only when the user asked for emboss / etch / crest / initials. */
  reliefs?: CadRelief[];
  /** Present only when the user asked to pretty-up / restyle (not a structural edit). */
  pretty_up?: CadPrettyUp;
  /** Present only when the prompt names a curated character or tech keyword. */
  knowledge?: CadKnowledge;
  /** True only for a known ambiguous fork — never a settings wall. */
  needs_user_choice?: boolean;
  options?: DesignOptionGroup[];
};

export { LOCAL_AI_START_MESSAGE } from "./llm-config";

const SYSTEM_PROMPT = `You are a CAD assistant that writes OpenSCAD for FDM 3D printing.

Reply with ONLY OpenSCAD code (no markdown unless fenced as \`\`\`openscad). No commentary.

Units and output
- Units are millimeters. OpenSCAD is unitless; treat 1 unit = 1 mm. Never invent inches or "OpenSCAD units".
- Produce a single manifold solid suitable for slicing. Prefer one piece first (union overlapping solids). Split only if the user clearly needs an assembly or a moving joint.
- Sit the part on z=0 (build plate) when practical. Keep the positive-Z up orientation printable without supports when a simple redesign can avoid them.
- Keep the part on the target printer bed unless the user asks otherwise.

Printable engineering
- Minimum wall thickness 1.6 mm (1.2 mm only if the user insists and the feature is short).
- Through-holes diameter >= 2.5 mm unless the user asks smaller; add 0.3–0.4 mm clearance on holes meant to fit a real fastener or shaft.
- Snap / press / sliding fits: leave 0.2–0.4 mm clearance per side. Do not design interference that cannot print.
- Joints only when the user asks for a hinge, pin, ball, snap, or other moving assembly. Prefer print-in-place: emit SEPARATE solids with named radial_mm / axial_mm gaps — never union the pin, lid, rotor, ball, or snap hook into a fused blob. Removable multi-part kits use the larger documented clearances. Hinge and pin must be real CSG (knuckles + captured pin, or cheeks + rotor/pin). Ball must be real CSG: a sphere in a spherical socket, captive by default (neck diameter < ball_d, cavity = ball + 2×radial_mm). Snap must be real CSG: a cantilever hook + catch lip (beam ≥ 1.6 mm, flex in XY) or an annular bead + groove, with the documented gap — never fuse hook and catch.
- Avoid zero-thickness faces, knife edges, and non-manifold boolean leftovers. Difference() cutters should fully pierce the host solid (overshoot by 0.2–1 mm).
- Prefer fillets/chamfers only when they stay printable (no tiny unsupported overhangs).
- If the request is mechanically ambiguous, pick everyday real-world dimensions and still emit a printable part.

OpenSCAD best practices
- Use $fn = 64 (or $fa/$fs) for curves. Do not exceed $fn = 96.
- Prefer cube(), cylinder(), sphere(), hull(), difference(), union(), intersection(), linear_extrude(), rotate_extrude().
- Name parameters at the top (size, wall, hole_d, …) so follow-up edits are easy.
- If the user names colors or materials (e.g. red body, black letters): emit one module per region named region_<name>(), wrap each call in color("#RRGGBB"), and union them for the preview solid. Prefer raised cubes/bars for letters — avoid text() (no fonts). color() is preview metadata; each region_* module must render alone.
- Raised etchings / emboss only when asked: union a primitive motif onto the named face (emboss / raised) or difference it into that face (etch / engrave). Motifs: text / crest / disc / bar / chevron / shield / star / cross / ring / stripe / grid / diamond, or an uploaded-logo silhouette (not neural). Multiple reliefs when they ask for more than one. Wearable phrases (“back of helmet”, “chest plate”, “gauntlet cuff”) pick a face. Default region is the largest vertical face, ties to front (+Y). Default raised height 0.8 mm, recessed depth 0.6 mm. Etch must leave ≥ 1.6 mm remaining wall. One piece first. Do not close holes or fuse PIP joints. Keep the host solid — do not rebuild a new part. No Style2Fab / fonts / text().
- Pretty-up / restyle only when asked (pretty-up, restyle, fillet, chamfer, decorative ribs/panels, steampunk). Stylistic CSG only — primitive fillets (hull of cylinders), chamfers (inset-cube hull), ribs/panels/rivets. Keep planned holes, PIP joint gaps, mating faces, and ≥ 1.6 mm walls. Refuse pretty-up that would fuse print-in-place joints or close through-holes. Not neural Style2Fab.
- Knowledge pack: only when the user names a curated character/prop (stormtrooper / vader / iron man / master chief / saber hilt) or tech keyword (PLA/PETG/PA/ABS/TPU, 0.4 mm nozzle, 0.2 mm layer, joint clearance, P2S volume, print-in-place, split-for-bed). Use pack millimeters. Unknown names: ignore and design from the description. Curated stub — not a live web crawl.
- Mid-design options: if the user already picked a chip (1:1 wearable, size L, PETG, print-in-place, a named face), honor that choice. Do not re-ask.
- Never use import(), include, use <>, surface(), or any file/network access.
- Do not add echo() debug spam. Do not generate animation or $t.
- Valid syntax only: every statement ends with ';'. Balance braces and parentheses. Define modules before calling them.

Safety
- Do not design weapons, explosives, lock-defeat tools, or other harmful devices.
- If asked for unsafe or nonsense geometry, do not lecture. Quietly emit a safe, useful printable alternative that matches the spirit of the request (e.g. a paperweight, bracket, or toy-safe shape) with ordinary walls and no sharp weaponized features.
`;

const PLAN_SYSTEM_PROMPT = `You are a CAD planner for FDM 3D printing. Reply with ONLY compact JSON (no markdown, no prose).

Schema:
{"object":string,"one_piece":true,"units":"mm","overall_mm":{"x":n,"y":n,"z":n},"features":[{"name":string,"kind":string,"dims_mm":{"…":n},"notes":string}],"holes":[{"d":n,"purpose":string,"through":true}],"min_wall_mm":n,"clearance_mm":n,"sit_on_z0":true,"safety_notes":string,"joints":[{"type":"hinge|pin|ball|snap","intent":"print-in-place|multi-part","radial_mm":n,"axial_mm":n,"notes":string}],"clearance_intent":"print-in-place","color_regions":[{"name":string,"color":string,"hex":"#RRGGBB","filament":"pla","ams_slot":1}],"reliefs":[{"kind":"emboss|etch","motif":"text|crest|disc|bar|chevron|shield|star|cross|ring|stripe|grid|diamond|image","text":"DP","region":"front|back|left|right|top|bottom","target":"chest plate","height_mm":0.8,"depth_mm":0.6}],"pretty_up":{"applied":true,"refused":false,"style":"fillet|chamfer|ribs|panels|steampunk|motif","ops":[{"kind":"fillet","mm":2}],"functional_regions":[{"kind":"functional","role":"hole","note":"keep through-hole"}],"decorative_regions":[{"kind":"decorative","role":"fillet","note":"2 mm rounds"}]},"knowledge":{"pack_version":"1.0.0","curated":true,"live_web_crawl":false,"characters":[{"id":"stormtrooper-helmet","name":"stormtrooper helmet"}],"tech":[{"id":"petg","name":"PETG"}],"notes":["curated stub"]},"needs_user_choice":false,"options":[{"id":"scale_mode","label":"Scale","prompt":"Fit P2S or 1:1?","options":[{"id":"scale_mode:display","label":"Fit P2S","value":"display"}]}]}

Rules:
- Millimeters only. Real-world dimensions. One piece first unless the user clearly asks for an assembly / multi-part kit or a moving joint.
- Joints: omit the joints array unless the user asks for a hinge, pin, ball, snap, or other motion. Prefer print-in-place (one print, separate solids with radial/axial gaps). Use multi-part only when they ask for separate / removable pieces. Hinge, pin, ball, and snap are real CSG (captive ball-in-socket; cantilever or annular snap). Not a full gimbal / living-hinge library.
- If the user names colors or materials, fill color_regions (named body or painted feature, hex, optional pla/petg/pa/abs/tpu). Follow-ups like "paint the letters black" or "make the base red" recolor those named regions — do not invent new geometry. ams_slot is 1–4 export metadata, not a live printer. Omit color_regions when no color is mentioned.
- Reliefs: omit the reliefs array unless the user asks to emboss, etch, engrave, raise a crest/logo, or cut initials. kind is emboss (raised, union) or etch (recessed, difference). motif is text (block initials), crest, disc, bar, chevron, shield, star, cross, ring, stripe, grid, diamond, or image (uploaded silhouette — not Style2Fab). region is a face hint (front/back/left/right/top/bottom). target may name a wearable region (back of helmet, chest plate, gauntlet cuff). Multiple entries when they ask for more than one relief. Default region: largest vertical face, ties to front. Default height_mm 0.8, depth_mm 0.6. Etch must leave 1.6 mm walls. One piece first; do not close holes or fuse joints. Honest CSG stub — not Style2Fab.
- Pretty-up: omit pretty_up unless the user asks to pretty-up, restyle, fillet, chamfer, add decorative ribs/panels, or make it look steampunk. Separate from structural edits. Mark functional vs decorative regions. Refuse (applied=false, refused=true) if pretty-up would fuse PIP joints or close through-holes. Heuristic CSG only — not neural Style2Fab.
- Knowledge: omit the knowledge object unless the user names a curated character/prop or tech keyword. Use pack millimeters when present. Unknown names: omit knowledge and plan from the description alone. Curated in-repo stub — not a live web crawl.
- Options: omit needs_user_choice and options unless a known fork is still open (character scale P2S vs 1:1, wearable S–XL, material, PIP vs multi-part, emboss face, vague color regions, incomplete region paint). Never set needs_user_choice for an ordinary sized part. Do not dump advanced settings.
- Every feature must attach to the main solid unless it is a planned joint member. Through-holes fully pierce (overshoot 0.2–1 mm).
- min_wall_mm >= 1.6 unless the user insists thinner. clearance_mm ~ 0.3 for ordinary fits; for joints use the documented radial_mm. Sit the part on z=0.
- Fit overall_mm on the target printer bed unless they asked for a larger object.
- If the request is unsafe or nonsense, plan a safe printable alternative and note it in safety_notes. Do not refuse in words — plan the safe part.
- Keep the JSON short. No OpenSCAD in this pass.
`;

const REPAIR_HEADER = `The previous OpenSCAD failed to compile or pass mesh checks. Repair it.

Reply with ONLY corrected OpenSCAD (no markdown unless fenced as \`\`\`openscad).`;

export const REPAIR_INSTRUCTIONS = `Fix instructions:
1. Read the error. Fix that exact syntax, undefined name, or mesh issue first.
2. Common OpenSCAD pitfalls: missing ';', unbalanced { } ( ), using '=' where you need a value, calling a module before it is defined, polyhedron face winding, difference() cutters that do not fully pierce.
3. Keep 1 unit = 1 mm. Result must be a single manifold solid on z=0 when practical.
4. Walls >= 1.6 mm. Holes printable. No import/include/use/surface.
5. Prefer the smallest change that compiles and stays printable. Preserve the user's design intent and any plan dimensions.
6. If the old design cannot be repaired cleanly, rewrite a simpler one-piece solid that still matches the request.`;

export const IMPORTED_MESH_REPAIR_INSTRUCTIONS = `Fix instructions (imported-mesh wrapper — do not start over):
1. Keep import("imported.stl", convexity = 10) as the host solid. It MUST remain the FIRST child of difference().
2. Do not rebuild a cube/sphere/cylinder-only part. Do not drop or replace the import.
3. Through-holes: cutter overshoots both faces by 0.2–1 mm. Blind holes stop short of the far face (leave ≥ 1.6 mm).
4. Never union a cutter onto the import (that makes a floating cylinder / blind nub).
5. Never invert difference() (cutter first, import second).
6. Sit the result on z=0. One connected solid. Walls ≥ 1.6 mm.
7. Prefer the smallest change that compiles. Feed compiler / mesh / printability errors back into this same wrap.`;

export function classifyCompileIssue(
  error: string,
  opts: { importedMesh?: boolean; printInPlace?: boolean } = {},
): string[] {
  const hints: string[] = [];
  const text = error ?? "";
  if (/syntax|parser|unexpected|missing ;|WARNING: Ignoring unknown|ERROR:/i.test(text)) {
    hints.push("Fix the syntax or unknown token at the reported line; check semicolons and braces.");
  }
  if (/undefined|not defined|unknown variable|unknown module/i.test(text)) {
    hints.push("Define every variable and module before use.");
  }
  if (opts.importedMesh) {
    if (/from-scratch|must keep import|host solid|inverted|floating cylinder/i.test(text)) {
      hints.push(
        'Keep import("imported.stl", convexity = 10) as the first difference() child; put the hole cutter second.',
      );
    }
  } else if (/\bimport\b|\binclude\b|\buse\b|surface\(/i.test(text)) {
    hints.push("Remove filesystem calls; rebuild with cube/cylinder/sphere primitives.");
  }
  if (/manifold|mesh check|non-manifold|zero.volume|empty mesh|no-triangles/i.test(text)) {
    hints.push(
      opts.importedMesh
        ? "Keep the imported host. Extend hole cutters through the solid (overshoot 0.2–1 mm). Do not replace the import with a new primitive part."
        : "Ensure a single closed solid: union overlapping parts, extend subtractors through faces, avoid zero-thickness shells.",
    );
  }
  if (/disconnected|floating island/i.test(text)) {
    hints.push(
      opts.importedMesh
        ? "A second solid is usually a unioned cutter. difference() the hole; keep one connected imported part."
        : opts.printInPlace
          ? "Print-in-place joints are separate solids. Do not union the pin, lid, rotor, ball, or snap hook. Keep the documented radial_mm / axial_mm gaps."
          : "Union every body into one connected solid; add a 1.6+ mm bridge if pieces must stay attached.",
    );
  }
  if (/off-bed|sit on z|lowest z/i.test(text)) {
    hints.push(
      opts.importedMesh
        ? "Translate the wrap so the imported solid still sits on z=0. Do not rebuild a new part."
        : "Translate the part so the base sits on z=0.",
    );
  }
  if (/thin.wall|undersized|thinner than/i.test(text)) {
    hints.push("Thicken walls to at least 1.6 mm (4× 0.4 mm nozzle). Avoid knife edges.");
  }
  if (/exceeds the .* bed|will not fit|oversized/i.test(text)) {
    hints.push("Scale or redesign so every dimension fits the 256 × 256 × 256 mm bed, unless the user asked for a larger part.");
  }
  if (/timeout|timed out/i.test(text)) {
    hints.push("Simplify geometry; keep $fn at 48–64; avoid huge minkowski() or deep recursion.");
  }
  return hints;
}

export function buildRepairPrompt(input: {
  error: string;
  previousCode?: string;
  plan?: CadPlan | null;
  importedMesh?: boolean;
}): string {
  const printInPlace = hasPrintInPlaceJoints(input.plan);
  const parts = [
    REPAIR_HEADER,
    input.importedMesh ? IMPORTED_MESH_REPAIR_INSTRUCTIONS : REPAIR_INSTRUCTIONS,
  ];
  const hints = classifyCompileIssue(input.error, {
    importedMesh: input.importedMesh,
    printInPlace,
  });
  if (hints.length) {
    parts.push(`Error-specific hints:\n- ${hints.join("\n- ")}`);
  }
  parts.push(`Error:\n${input.error.slice(0, 2500)}`);
  if (input.plan) {
    parts.push(`Design plan (keep these dimensions):\n${JSON.stringify(input.plan)}`);
  }
  if (input.previousCode) {
    const params = extractScadParams(input.previousCode);
    const paramNote = formatScadParams(params);
    if (paramNote) {
      parts.push(`Preserve these named parameters unless they caused the error: ${paramNote}`);
    }
    parts.push(`Previous code:\n${input.previousCode.slice(0, 6000)}`);
  }
  return parts.join("\n\n");
}

export type ImportedMeshContext = {
  fileName: string;
  sizeMm: [number, number, number];
  minMm: [number, number, number];
  maxMm: [number, number, number];
  triangleCount: number;
  volumeMm3: number;
};

export function importedMeshSystemPrompt(): string {
  return `You are a CAD assistant that wraps an already-imported triangle mesh in OpenSCAD for FDM 3D printing.

Reply with ONLY OpenSCAD code (no markdown unless fenced as \`\`\`openscad). No commentary.

The host solid is already on disk in the compile folder. You MUST use exactly:
  import("imported.stl", convexity = 10)
Do not import any other file. Do not use include, use <>, or surface().

Units and output
- Millimeters. 1 unit = 1 mm.
- Keep a single printable solid. Sit the result on z=0.
- Through-holes by default: difference() the imported solid and fully pierce (overshoot 0.2–1 mm) unless the user asks for a blind hole.
- difference() children: FIRST import("imported.stl"), SECOND the cutter. Inverting this subtracts the part from a cylinder (blind nub / empty / inverted failure).
- Never union a cylinder onto the import — that leaves a floating solid, not a hole.
- Walls >= 1.6 mm. Through-holes >= 2.5 mm unless the user asks smaller. Sit the result on z=0. One connected piece.

Edits
- Scale, rotate, and translate the imported mesh to apply size / orientation requests.
- Add holes, slots, tabs, relief, or pretty-up (fillet nubs / chamfer cuts / decorative ribs) with cube()/cylinder() differenced (holes / etch / chamfer) or unioned (tabs / emboss / ribs) against the import. Image logos become silhouette/heightfield cubes on the named face. Keep import() as the host. Never close existing through-holes or fuse PIP gaps for style. No neural Style2Fab / text().
- Name parameters at the top (hole_d, scale_f, …).
- Prefer the smallest change that matches the request. Do not replace the imported part with a new primitive-only model unless the user asked to start over.

Safety
- Do not design weapons or lock-defeat tools. If asked, emit a safe printable wrapper instead.

${formatPrinterConstraints()}
`;
}

export function buildImportedMeshPrompt(input: {
  prompt: string;
  sizeNote: string;
  mesh: ImportedMeshContext;
  previousError?: string;
  previousCode?: string;
  previousPrompt?: string;
  holeSpecNote?: string;
  suggestedWrap?: string;
}): string {
  const [sx, sy, sz] = input.mesh.sizeMm;
  const [minx, miny, minz] = input.mesh.minMm;
  const [maxx, maxy, maxz] = input.mesh.maxMm;
  const cx = (minx + maxx) / 2;
  const cy = (miny + maxy) / 2;
  const meta = [
    `Imported mesh: ${input.mesh.fileName}`,
    `bbox_mm: ${sx.toFixed(2)} × ${sy.toFixed(2)} × ${sz.toFixed(2)}`,
    `min: [${minx.toFixed(2)}, ${miny.toFixed(2)}, ${minz.toFixed(2)}] max: [${maxx.toFixed(2)}, ${maxy.toFixed(2)}, ${maxz.toFixed(2)}]`,
    `center_xy: [${cx.toFixed(2)}, ${cy.toFixed(2)}]  height: ${sz.toFixed(2)}`,
    `triangles: ${input.mesh.triangleCount}  volume_mm3: ${input.mesh.volumeMm3.toFixed(1)}`,
  ].join("\n");

  if (input.previousError) {
    const parts = [
      buildRepairPrompt({
        error: input.previousError,
        previousCode: input.previousCode,
        importedMesh: true,
      }),
      "Keep import(\"imported.stl\", convexity = 10) as the host solid. Repair this wrap — do not generate an unrelated part.",
      `User request:\n${input.prompt.trim()}`,
      meta,
    ];
    if (input.holeSpecNote) parts.push(input.holeSpecNote);
    if (input.suggestedWrap) {
      parts.push(`Suggested engineering wrap (revise this; do not replace the import):\n${input.suggestedWrap.slice(0, 4000)}`);
    }
    if (input.sizeNote) parts.push(input.sizeNote);
    if (input.previousPrompt) parts.push(`Earlier description:\n${input.previousPrompt.slice(0, 2000)}`);
    return parts.join("\n\n");
  }

  const parts = [
    "Wrap the imported mesh with OpenSCAD. Host solid MUST be import(\"imported.stl\", convexity = 10).",
    `User request:\n${input.prompt.trim()}`,
    meta,
  ];
  if (input.holeSpecNote) parts.push(input.holeSpecNote);
  if (input.suggestedWrap) {
    parts.push(`Suggested engineering wrap (prefer this difference() structure):\n${input.suggestedWrap.slice(0, 4000)}`);
  }
  if (input.sizeNote) parts.push(input.sizeNote);
  if (input.previousPrompt) {
    parts.push(`Earlier description:\n${input.previousPrompt.slice(0, 2000)}`);
  }
  if (input.previousCode) {
    parts.push(`Previous wrapper (revise; do not drop the import):\n${input.previousCode.slice(0, 6000)}`);
  }
  return parts.join("\n\n");
}

export function buildUserPrompt(input: {
  prompt: string;
  sizeNote: string;
  previousError?: string;
  previousCode?: string;
  previousPrompt?: string;
  plan?: CadPlan | null;
  importedMesh?: ImportedMeshContext;
  holeSpecNote?: string;
  suggestedWrap?: string;
}): string {
  if (input.importedMesh) {
    return buildImportedMeshPrompt({
      prompt: input.prompt,
      sizeNote: input.sizeNote,
      mesh: input.importedMesh,
      previousError: input.previousError,
      previousCode: input.previousCode,
      previousPrompt: input.previousPrompt,
      holeSpecNote: input.holeSpecNote,
      suggestedWrap: input.suggestedWrap,
    });
  }
  if (input.previousError) {
    const repair = buildRepairPrompt({
      error: input.previousError,
      previousCode: input.previousCode,
      plan: input.plan,
    });
    const parts = [repair, `User request:\n${input.prompt.trim()}`];
    if (input.sizeNote) parts.push(input.sizeNote);
    if (input.previousPrompt) {
      parts.push(`Earlier description:\n${input.previousPrompt.slice(0, 2000)}`);
    }
    return parts.join("\n\n");
  }

  const parts = [`Describe this object as OpenSCAD:`, input.prompt.trim()];
  if (input.sizeNote) {
    parts.push(input.sizeNote);
  }
  if (input.plan) {
    parts.push(`Design plan (follow these features and millimeters):\n${JSON.stringify(input.plan)}`);
    if (input.plan.joints?.length) {
      parts.push(
        `Joints: emit separate solids with radial_mm / axial_mm from the plan. Prefer print-in-place. Do not union moving members. Hinge, pin, ball, and snap must be real CSG (captive socket + ball, or cantilever/annular snap with a 1.6 mm beam).`,
      );
    }
    if (input.plan.reliefs?.length) {
      parts.push(formatReliefPromptHint(input.plan.reliefs));
    }
    if (input.plan.pretty_up) {
      parts.push(formatPrettyUpPromptHint(input.plan.pretty_up));
    }
    if (input.plan.knowledge) {
      parts.push(formatKnowledgeCodegenHint(input.plan.knowledge));
    }
  }
  if (input.previousCode) {
    if (wantsNewDesign(input.prompt)) {
      parts.push(`The user wants a new object. You may start from scratch.`);
    } else if (input.plan?.joints?.length) {
      parts.push(
        `This is a follow-up edit of a working jointed part. Keep the named clearances and separate solids. Apply only the user's latest change.`,
      );
    } else {
      parts.push(
        `This is a follow-up edit of a working printable part. Keep the same overall design, named parameters, unions, and difference() structure. Apply only the user's latest change. Do not drop working features, invent a new object, or split into multiple bodies unless they clearly ask.`,
      );
    }
    if (input.previousPrompt) {
      parts.push(`Earlier description:\n${input.previousPrompt.slice(0, 2000)}`);
    }
    const params = extractScadParams(input.previousCode);
    const paramNote = formatScadParams(params);
    if (paramNote) {
      parts.push(`Preserve these named parameters unless the user asked to change them: ${paramNote}`);
    }
    parts.push(`Current OpenSCAD:\n${input.previousCode.slice(0, 6000)}`);
  }
  return parts.join("\n\n");
}

export function buildPlanPrompt(input: {
  prompt: string;
  sizeNote: string;
  previousPrompt?: string;
  previousCode?: string;
}): string {
  const parts = [`Plan this printable part as compact JSON.`, `User request:\n${input.prompt.trim()}`];
  if (input.sizeNote) parts.push(input.sizeNote);
  const knowledge = cadKnowledgeFromPrompt(input.prompt);
  if (knowledge) parts.push(formatKnowledgePlanHint(knowledge));
  if (input.previousCode) {
    if (wantsNewDesign(input.prompt)) {
      parts.push(`The user wants a new object. Plan from scratch.`);
    } else {
      parts.push(
        `This is a follow-up edit. Update only the requested dimensions/features. Keep one_piece true unless they asked for an assembly or a moving joint. Keep joints only if they still want motion. Keep reliefs only if they still want emboss/etch. Keep pretty_up only if they still want restyle. Keep knowledge only if they still name a curated character or tech keyword. Do not start over.`,
      );
    }
    if (input.previousPrompt) {
      parts.push(`Earlier description:\n${input.previousPrompt.slice(0, 2000)}`);
    }
    const params = extractScadParams(input.previousCode);
    const paramNote = formatScadParams(params);
    if (paramNote) {
      parts.push(`Existing named parameters (keep unless asked to change): ${paramNote}`);
    }
    parts.push(`Current OpenSCAD (for context, do not rewrite it here):\n${input.previousCode.slice(0, 3000)}`);
  }
  return parts.join("\n\n");
}

function asFiniteNumber(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(n) ? n : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function extractJsonObject(raw: string): string | null {
  const trimmed = raw.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fence?.[1] ?? trimmed).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  return body.slice(start, end + 1);
}

export function parseCadPlan(raw: string): CadPlan | null {
  const json = extractJsonObject(raw);
  if (!json) return null;
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const rec = data as Record<string, unknown>;
  const object = asString(rec.object) ?? asString(rec.title) ?? asString(rec.name);
  const rawFeatures = Array.isArray(rec.features) ? rec.features : [];
  const features = rawFeatures.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const f = item as Record<string, unknown>;
    const name = asString(f.name);
    if (!name) return [];
    const dims: Record<string, number> = {};
    if (f.dims_mm && typeof f.dims_mm === "object" && !Array.isArray(f.dims_mm)) {
      for (const [key, value] of Object.entries(f.dims_mm as Record<string, unknown>)) {
        const n = asFiniteNumber(value);
        if (n !== undefined) dims[key] = n;
      }
    }
    return [
      {
        name,
        kind: asString(f.kind),
        dims_mm: Object.keys(dims).length ? dims : undefined,
        notes: asString(f.notes),
      },
    ];
  });
  if (!object && features.length === 0) return null;

  const rawHoles = Array.isArray(rec.holes) ? rec.holes : [];
  const holes = rawHoles.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const h = item as Record<string, unknown>;
    const d = asFiniteNumber(h.d) ?? asFiniteNumber(h.diameter);
    if (d === undefined || d <= 0) return [];
    return [{ d, purpose: asString(h.purpose), through: h.through !== false }];
  });

  let overall_mm: CadPlan["overall_mm"];
  if (rec.overall_mm && typeof rec.overall_mm === "object" && !Array.isArray(rec.overall_mm)) {
    const o = rec.overall_mm as Record<string, unknown>;
    const x = asFiniteNumber(o.x);
    const y = asFiniteNumber(o.y);
    const z = asFiniteNumber(o.z);
    if (x !== undefined && y !== undefined && z !== undefined) {
      overall_mm = { x, y, z };
    }
  }

  const minWall = asFiniteNumber(rec.min_wall_mm) ?? 1.6;
  const clearance = asFiniteNumber(rec.clearance_mm) ?? 0.3;
  const joints = parseCadJoints(rec.joints ?? rec.joint);
  if (!joints.length) {
    const inferred = parseCadJoints({
      type: rec.joint_type ?? rec.jointType,
      intent: rec.clearance_intent ?? rec.intent,
      radial_mm: rec.clearance_mm,
    });
    joints.push(...inferred);
  }
  const clearance_intent = parseClearanceIntent(rec.clearance_intent ?? rec.intent) ?? joints[0]?.intent;

  const rawColors = Array.isArray(rec.color_regions)
    ? rec.color_regions
    : Array.isArray(rec.colors)
      ? rec.colors
      : [];
  const colorRegions = rawColors.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const c = item as Record<string, unknown>;
    const name = asString(c.name) ?? asString(c.id);
    const color = asString(c.color) ?? asString(c.colour);
    const hex = asString(c.hex) ?? asString(c.colorHex);
    if (!name && !color && !hex) return [];
    const slot = asFiniteNumber(c.ams_slot) ?? asFiniteNumber(c.amsSlot) ?? asFiniteNumber(c.extruder);
    return [
      {
        name: name ?? color ?? "region",
        color,
        hex,
        filament: asString(c.filament) ?? asString(c.material),
        ams_slot: slot !== undefined && slot >= 1 ? slot : undefined,
      },
    ];
  });

  return {
    object: object ?? "part",
    one_piece: rec.one_piece !== false,
    units: "mm",
    overall_mm,
    features,
    holes,
    min_wall_mm: minWall > 0 ? minWall : 1.6,
    clearance_mm: clearance > 0 ? clearance : 0.3,
    sit_on_z0: rec.sit_on_z0 !== false,
    safety_notes: asString(rec.safety_notes),
    joints: joints.length ? joints : undefined,
    clearance_intent,
    color_regions: colorRegions.length ? colorRegions : undefined,
    reliefs: (() => {
      const parsed = parseCadReliefs(rec.reliefs ?? rec.relief ?? rec.emboss ?? rec.etch);
      return parsed.length ? parsed : undefined;
    })(),
    pretty_up: parseCadPrettyUp(rec.pretty_up ?? rec.prettyup ?? rec.style),
    needs_user_choice: rec.needs_user_choice === true,
    options: (() => {
      const parsed = parseDesignOptionGroups(rec.options);
      return parsed.length ? parsed : undefined;
    })(),
  };
}

export function hasLiveLlm(): boolean {
  return Boolean(getLlmConfig().apiKey);
}

function firstLine(text: string): string {
  return text.split(/\r?\n/, 1)[0]?.trim() ?? "";
}

function errorText(err: unknown): string {
  if (err instanceof Error) {
    const cause =
      "cause" in err && err.cause !== undefined
        ? ` ${err.cause instanceof Error ? err.cause.message : String(err.cause)}`
        : "";
    return `${err.name} ${err.message}${cause}`;
  }
  return String(err);
}

function isUnreachableError(err: unknown): boolean {
  const text = errorText(err);
  return /fetch failed|failed to fetch|econnrefused|enotfound|econnreset|ehostunreach|enetunreach|socket|networkerror|network error|aborted|aborterror|und_err|connect (e|timeout)|other side closed/i.test(
    text,
  );
}

export function toUserFacingLlmError(err: unknown, config: LlmConfig = getLlmConfig()): Error {
  if (err instanceof Error && err.message === LOCAL_AI_START_MESSAGE) {
    return err;
  }
  if (isLocalOpenAiBaseUrl(config.baseUrl) && isUnreachableError(err)) {
    return new Error(LOCAL_AI_START_MESSAGE);
  }
  if (err instanceof Error) {
    const line = firstLine(err.message);
    if (isLocalOpenAiBaseUrl(config.baseUrl) && /econnrefused|fetch failed|failed to fetch/i.test(line)) {
      return new Error(LOCAL_AI_START_MESSAGE);
    }
    return new Error(line || LOCAL_AI_START_MESSAGE);
  }
  return new Error(isLocalOpenAiBaseUrl(config.baseUrl) ? LOCAL_AI_START_MESSAGE : "LLM request failed");
}

function normalizeChatOptions(timeoutMsOrOptions?: number | CompleteChatOptions): CompleteChatOptions {
  if (typeof timeoutMsOrOptions === "number") {
    return { timeoutMs: timeoutMsOrOptions };
  }
  return timeoutMsOrOptions ?? {};
}

export async function completeChat(
  messages: ChatMessage[],
  timeoutMsOrOptions?: number | CompleteChatOptions,
): Promise<string> {
  const options = normalizeChatOptions(timeoutMsOrOptions);
  const config = getLlmConfig();
  const timeoutMs = options.timeoutMs ?? getLlmTimeoutMs();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // Ollama’s /v1 API: Bearer + JSON only. Do not send OpenAI-Organization /
    // OpenAI-Project headers — they are unused and some local servers reject extras.
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: options.model ?? config.model,
        temperature: options.temperature ?? 0.2,
        messages,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      let body = "";
      try {
        body = await response.text();
      } catch {
        body = "";
      }
      if (
        isLocalOpenAiBaseUrl(config.baseUrl) &&
        (response.status === 502 ||
          response.status === 503 ||
          response.status === 504 ||
          /connection refused|dial tcp|no such host|connect: /i.test(body))
      ) {
        throw new Error(LOCAL_AI_START_MESSAGE);
      }
      const snippet = firstLine(body).slice(0, 240);
      throw new Error(
        snippet
          ? `LLM request failed (${response.status}): ${snippet}`
          : `LLM request failed (${response.status})`,
      );
    }

    const data = (await response.json()) as {
      choices?: { message?: { content?: string | null } }[];
      error?: { message?: string } | string;
    };
    if (data.error) {
      const msg = typeof data.error === "string" ? data.error : data.error.message;
      throw new Error(firstLine(msg ?? "LLM returned an error"));
    }
    const content = data.choices?.[0]?.message?.content;
    if (!content?.trim()) {
      throw new Error("LLM returned an empty completion");
    }
    return content;
  } catch (err) {
    throw toUserFacingLlmError(err, config);
  } finally {
    clearTimeout(timer);
  }
}

export function systemPrompt(): string {
  return `${SYSTEM_PROMPT}\n\n${formatPrinterConstraints()}\n\n${formatKnowledgeConstraints()}`;
}

export function planSystemPrompt(): string {
  return `${PLAN_SYSTEM_PROMPT}\n\n${formatPrinterConstraints()}\n\n${formatKnowledgeConstraints()}`;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Clamp a parsed plan to one-piece / printer / wall rules unless the user
 * clearly asked otherwise. Called after parseCadPlan on the live path.
 */
export function normalizeCadPlan(
  plan: CadPlan,
  input: { prompt: string; previousCode?: string | null },
): CadPlan {
  const rules = printRules();
  const multi = wantsMultiPart(input.prompt);
  const thinOk = allowsThinWalls(input.prompt);
  const statedWall = statedWallMm(input.prompt);
  let min_wall_mm = plan.min_wall_mm;
  if (statedWall !== undefined) {
    min_wall_mm = statedWall;
  } else if (!thinOk && min_wall_mm < rules.minWallMm) {
    min_wall_mm = rules.minWallMm;
  }

  const intent = inferClearanceIntent(input.prompt);
  const normalizedJoints = normalizeCadJoints(plan.joints ?? [], input.prompt);
  const joints = normalizedJoints.joints;
  const clearance_intent = normalizedJoints.clearance_intent;
  const clearance_mm =
    joints[0]?.radial_mm ??
    (plan.clearance_mm > 0 ? plan.clearance_mm : rules.clearanceMm);
  const bed = bedMaxMm(rules);
  let overall_mm = knowledgeOverallMm(input.prompt, plan.overall_mm);
  if (overall_mm) {
    const maxDim = Math.max(overall_mm.x, overall_mm.y, overall_mm.z);
    if (maxDim > bed && !promptAllowsOversize(input.prompt, maxDim)) {
      const scale = (bed * 0.98) / maxDim;
      overall_mm = {
        x: round1(overall_mm.x * scale),
        y: round1(overall_mm.y * scale),
        z: round1(overall_mm.z * scale),
      };
    }
  }

  const holes = plan.holes.map((h) => {
    let d = h.d;
    if (d < rules.minHoleMm && !promptAllowsSmallHole(input.prompt, d)) {
      d = rules.minHoleMm;
    }
    return { ...h, d, through: h.through !== false };
  });

  const features = mergeKnowledgeFeatures(input.prompt, plan.features).map((f) => {
    if (!f.dims_mm) return f;
    const dims_mm = { ...f.dims_mm };
    for (const [key, value] of Object.entries(dims_mm)) {
      if (!isWallDimKey(key)) continue;
      if (statedWall !== undefined) {
        dims_mm[key] = statedWall;
      } else if (value < min_wall_mm && !thinOk) {
        dims_mm[key] = min_wall_mm;
      }
    }
    return { ...f, dims_mm };
  });

  const merged = mergeColorRegionSources(input.prompt, plan.color_regions);
  const color_regions = isDefaultOnlyRegions(merged)
    ? undefined
    : merged.map((region) => ({
        name: region.name,
        color: region.colorName,
        hex: region.colorHex,
        filament: region.filament,
        ams_slot: region.amsSlot,
      }));

  const sizeMm: [number, number, number] | undefined = overall_mm
    ? [overall_mm.x, overall_mm.y, overall_mm.z]
    : undefined;
  const reliefs = normalizeCadReliefs(plan.reliefs ?? [], input.prompt, sizeMm);
  const pretty_up = normalizeCadPrettyUp(plan.pretty_up ?? inferCadPrettyUp({
    prompt: input.prompt,
    previousCode: input.previousCode,
    holes: plan.holes,
    joints,
    sizeMm,
    reliefs,
  }), {
    prompt: input.prompt,
    previousCode: input.previousCode,
    holes: plan.holes,
    joints,
    sizeMm,
    reliefs,
  });

  let one_piece = true;
  if (intent === "print-in-place") {
    one_piece = true;
  } else if (intent === "multi-part" || multi) {
    one_piece = plan.one_piece;
  }

  const knowledge = cadKnowledgeFromPrompt(input.prompt);
  const namedCharacter = knowledge?.characters[0]?.name;
  const designOptions = resolveDesignOptions({
    prompt: input.prompt,
    previousPrompt: undefined,
    plan: {
      needs_user_choice: plan.needs_user_choice,
      options: plan.options,
      clearance_intent,
      knowledge,
    },
  });

  return {
    ...plan,
    object: namedCharacter && (plan.object === "part" || !plan.object) ? namedCharacter : plan.object,
    one_piece,
    sit_on_z0: true,
    min_wall_mm,
    clearance_mm,
    overall_mm,
    holes,
    features,
    joints: joints.length ? joints : undefined,
    clearance_intent,
    color_regions,
    reliefs: reliefs.length ? reliefs : undefined,
    pretty_up,
    knowledge,
    needs_user_choice: designOptions.needs_user_choice,
    options: designOptions.options.length ? designOptions.options : undefined,
  };
}
