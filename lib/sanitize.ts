export type SanitizeOk = { ok: true; code: string };
export type SanitizeErr = { ok: false; errors: string[] };
export type SanitizeResult = SanitizeOk | SanitizeErr;

export type SanitizeOptions = {
  /**
   * Allow a single server-written mesh: import("imported.stl") with optional
   * convexity. Used for describe-to-edit on an imported STL/3MF. All other
   * filesystem calls stay blocked.
   */
  allowImportedMesh?: boolean;
};

/** Filename written into the OpenSCAD work dir for imported-mesh wrappers. */
export const IMPORTED_MESH_FILENAME = "imported.stl";

const ALLOWED_IMPORTED_MESH_CALL_G =
  /import\s*\(\s*"imported\.stl"(?:\s*,\s*convexity\s*=\s*\d+)?\s*\)/gi;

export const ALLOWED_IMPORTED_MESH_CALL =
  /import\s*\(\s*"imported\.stl"(?:\s*,\s*convexity\s*=\s*\d+)?\s*\)/i;

const MAX_CODE_BYTES = 80_000;

const FORBIDDEN: { pattern: RegExp; reason: string }[] = [
  { pattern: /\bimport\s*\(/i, reason: "import() is blocked (filesystem access)" },
  { pattern: /\binclude\s*[<"]/i, reason: "include is blocked (filesystem access)" },
  { pattern: /\buse\s*[<"]/i, reason: "use <> is blocked (filesystem access)" },
  { pattern: /\bsurface\s*\(/i, reason: "surface() is blocked (filesystem access)" },
  { pattern: /\bimport_dxf\s*\(/i, reason: "import_dxf() is blocked" },
  { pattern: /\bimport_stl\s*\(/i, reason: "import_stl() is blocked" },
  { pattern: /\bdxf_linear_extrude\s*\(/i, reason: "dxf_linear_extrude() is blocked" },
  { pattern: /\bdxf_rotate_extrude\s*\(/i, reason: "dxf_rotate_extrude() is blocked" },
];

const HAS_SOLID = /\b(cube|sphere|cylinder|polyhedron|square|circle|polygon|text|hull|minkowski|linear_extrude|rotate_extrude|multmatrix)\s*\(/i;

export function extractOpenScad(raw: string): string {
  const trimmed = raw.trim();
  const fence = trimmed.match(/```(?:openscad|scad|cad)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) {
    return fence[1].trim();
  }
  return trimmed;
}

export function sanitizeOpenScad(raw: string, options: SanitizeOptions = {}): SanitizeResult {
  const errors: string[] = [];
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return { ok: false, errors: ["Generated code is empty"] };
  }

  const code = extractOpenScad(raw);
  const allowImported = Boolean(options.allowImportedMesh);
  const scanned = allowImported ? code.replace(ALLOWED_IMPORTED_MESH_CALL_G, "IMPORTED_MESH") : code;

  if (code.length > MAX_CODE_BYTES) {
    errors.push(`Generated code exceeds ${MAX_CODE_BYTES} bytes`);
  }
  if (code.includes("\0")) {
    errors.push("Generated code contains a null byte");
  }
  if (/[\u0001-\u0008\u000B\u000C\u000E-\u001F]/.test(code)) {
    errors.push("Generated code contains control characters");
  }

  for (const { pattern, reason } of FORBIDDEN) {
    if (pattern.test(scanned)) {
      errors.push(reason);
    }
  }

  if (/(?:^|[\s;])(?:import|include|use)\b/i.test(scanned) && /\.\.\//.test(scanned)) {
    errors.push("Path traversal is blocked");
  }

  if (allowImported && /import\s*\(/i.test(scanned)) {
    errors.push('Only import("imported.stl") is allowed for imported-mesh edits');
  }

  const hasImportedHost = allowImported && ALLOWED_IMPORTED_MESH_CALL.test(code);
  if (allowImported && !hasImportedHost) {
    errors.push('Imported-mesh edits must keep import("imported.stl") as the host solid');
  }

  const hasSolid = HAS_SOLID.test(code) || hasImportedHost;
  if (!hasSolid) {
    errors.push("Code does not contain a recognized OpenSCAD solid primitive");
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const withHeader = code.includes("$fn")
    ? code
    : `$fn = 64; // default facet quality (mm units)\n${code}`;

  return { ok: true, code: withHeader };
}
