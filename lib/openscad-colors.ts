import {
  resolveColorToken,
  slugifyRegionName,
  type ColorRegion,
  type ColorRegionDraft,
} from "./color-regions";

export type ScadColorBody = {
  name: string;
  moduleName?: string;
  renderStatement: string;
  colorName?: string;
  colorHex?: string;
};

function extractBalanced(code: string, openIndex: number): string | null {
  if (code[openIndex] !== "{") return null;
  let depth = 0;
  for (let i = openIndex; i < code.length; i++) {
    const ch = code[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return code.slice(openIndex + 1, i);
    }
  }
  return null;
}

function uniqueBodies(bodies: ScadColorBody[]): ScadColorBody[] {
  const seen = new Set<string>();
  const out: ScadColorBody[] = [];
  for (const body of bodies) {
    const key = body.moduleName ?? body.renderStatement;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(body);
  }
  return out;
}

/**
 * Find independently renderable color bodies in OpenSCAD.
 * Prefers `module region_<name>()` plus `color("…")` wrappers.
 */
export function extractOpenScadColorBodies(code: string): ScadColorBody[] {
  const bodies: ScadColorBody[] = [];

  const regionComment =
    /\/\/\s*REGION:([A-Za-z0-9_-]+)(?:\s+color=([^\s]+))?(?:\s+hex=(#[0-9A-Fa-f]{3,8}))?/g;
  for (const match of code.matchAll(regionComment)) {
    const name = match[1] ?? "region";
    const token = resolveColorToken(match[3]) ?? resolveColorToken(match[2]);
    const moduleName = `region_${slugifyRegionName(name)}`;
    bodies.push({
      name,
      moduleName,
      renderStatement: `${moduleName}()`,
      colorName: token?.colorName,
      colorHex: token?.colorHex,
    });
  }

  const regionModules = /module\s+(region_([A-Za-z0-9_]+))\s*\(/g;
  for (const match of code.matchAll(regionModules)) {
    const moduleName = match[1];
    const name = (match[2] ?? moduleName).replace(/_/g, " ");
    if (!moduleName) continue;
    bodies.push({
      name,
      moduleName,
      renderStatement: `${moduleName}()`,
    });
  }

  const colorCall =
    /color\s*\(\s*["']([^"']+)["'](?:\s*,\s*[\d.]+)?\s*\)\s*/g;
  let match: RegExpExecArray | null;
  while ((match = colorCall.exec(code))) {
    const token = resolveColorToken(match[1]);
    const after = match.index + match[0].length;
    const rest = code.slice(after).trimStart();
    const ident = rest.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
    if (ident?.[1]) {
      bodies.push({
        name: ident[1].replace(/^region_/, "").replace(/_/g, " "),
        moduleName: ident[1],
        renderStatement: `${ident[1]}()`,
        colorName: token?.colorName,
        colorHex: token?.colorHex,
      });
      continue;
    }
    const trimmedOffset = code.slice(after).match(/^\s*/)?.[0].length ?? 0;
    const braceAt = after + trimmedOffset;
    if (code[braceAt] === "{") {
      const block = extractBalanced(code, braceAt);
      if (block && block.trim()) {
        const name = token?.colorName ?? `region_${bodies.length + 1}`;
        bodies.push({
          name,
          renderStatement: block.trim(),
          colorName: token?.colorName,
          colorHex: token?.colorHex,
        });
      }
    }
  }

  return uniqueBodies(bodies);
}

export function mergeScadBodiesWithRegions(
  bodies: ScadColorBody[],
  regions: ColorRegion[],
): Array<ScadColorBody & { region: ColorRegion }> {
  if (bodies.length === 0) return [];
  return bodies.map((body, index) => {
    const byModule = regions.find((region) => `region_${region.id}` === body.moduleName);
    const byName = regions.find((region) => slugifyRegionName(region.name) === slugifyRegionName(body.name));
    const byColor = body.colorHex
      ? regions.find((region) => region.colorHex === body.colorHex)
      : undefined;
    const fallback = regions[index] ?? regions[0];
    const token = resolveColorToken(body.colorHex) ?? resolveColorToken(body.colorName);
    const region = byModule ?? byName ?? byColor ?? fallback;
    return {
      ...body,
      region: {
        ...region,
        colorName: token?.colorName ?? region.colorName,
        colorHex: token?.colorHex ?? region.colorHex,
      },
    };
  });
}

export function scadWithOnlyBody(code: string, renderStatement: string): string {
  const trimmed = code.replace(/\s+$/, "");
  const statement = renderStatement.trim().replace(/;+\s*$/, "");
  return `${trimmed}\n\n// DescribePrint color-region isolate\n!${statement};\n`;
}

export function draftsFromScadBodies(bodies: ScadColorBody[]): ColorRegionDraft[] {
  return bodies.map((body) => ({
    name: body.name,
    color: body.colorName,
    hex: body.colorHex,
  }));
}

const ASSEMBLY_HELPER =
  /^(knuckle|bore_cut|cheek|head|pad|foot|cut|helper|util|debug)$/i;

function stripScadNoise(code: string): string {
  return code
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '""');
}

function displayModuleName(moduleName: string): string {
  return moduleName.replace(/^region_/, "").replace(/_/g, " ").trim() || moduleName;
}

/**
 * Named solids invoked at file scope (not helpers called only from inside modules).
 * Joint fixtures call `box_body(); lid(); hinge_pin();` as separate solids.
 */
export function extractOpenScadAssemblyBodies(code: string): ScadColorBody[] {
  const colored = extractOpenScadColorBodies(code);
  if (colored.length >= 2) return colored;

  const text = stripScadNoise(code);
  const defined = new Set<string>();
  for (const match of text.matchAll(/\bmodule\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
    if (match[1]) defined.add(match[1]);
  }
  if (defined.size === 0) return colored;

  const topLevelCalls: string[] = [];
  const callRe = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = callRe.exec(text))) {
    const name = match[1] ?? "";
    const before = text.slice(0, match.index);
    let depth = 0;
    for (const ch of before) {
      if (ch === "{") depth += 1;
      else if (ch === "}") depth = Math.max(0, depth - 1);
    }
    if (name === "module" || name === "function" || name === "if" || name === "for" || name === "let") continue;
    if (depth !== 0) continue;
    if (!defined.has(name) || ASSEMBLY_HELPER.test(name)) continue;
    const preceding = before.slice(Math.max(0, before.length - 10));
    if (/\bmodule\s*$/.test(preceding)) continue;
    if (!topLevelCalls.includes(name)) topLevelCalls.push(name);
  }

  if (topLevelCalls.length < 2) return colored;

  return uniqueBodies(
    topLevelCalls.map((moduleName) => ({
      name: displayModuleName(moduleName),
      moduleName,
      renderStatement: `${moduleName}()`,
    })),
  );
}
