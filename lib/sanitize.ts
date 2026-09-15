export type SanitizeOk = { ok: true; code: string };
export type SanitizeErr = { ok: false; errors: string[] };
export type SanitizeResult = SanitizeOk | SanitizeErr;

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

export function sanitizeOpenScad(raw: string): SanitizeResult {
  const errors: string[] = [];
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return { ok: false, errors: ["Generated code is empty"] };
  }

  const code = extractOpenScad(raw);

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
    if (pattern.test(code)) {
      errors.push(reason);
    }
  }

  if (/(?:^|[\s;])(?:import|include|use)\b/i.test(code) && /\.\.\//.test(code)) {
    errors.push("Path traversal is blocked");
  }

  if (!HAS_SOLID.test(code)) {
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
