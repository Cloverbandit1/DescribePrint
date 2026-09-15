import { describe, expect, it } from "vitest";
import { extractOpenScad, sanitizeOpenScad } from "@/lib/sanitize";

describe("extractOpenScad", () => {
  it("unwraps fenced OpenSCAD", () => {
    const raw = "Here you go:\n```openscad\ncube(10);\n```\n";
    expect(extractOpenScad(raw)).toBe("cube(10);");
  });

  it("returns raw code when there is no fence", () => {
    expect(extractOpenScad("  sphere(5);  ")).toBe("sphere(5);");
  });
});

describe("sanitizeOpenScad", () => {
  it("accepts a simple cube and injects $fn when missing", () => {
    const result = sanitizeOpenScad("cube(20);");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.code).toMatch(/\$fn\s*=/);
      expect(result.code).toContain("cube(20);");
    }
  });

  it("rejects empty input", () => {
    const result = sanitizeOpenScad("   ");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toMatch(/empty/i);
  });

  it("blocks filesystem escapes", () => {
    const samples = [
      'import("part.stl");',
      "include <../secret.scad>",
      "use </etc/passwd>",
      'surface("heightmap.dat");',
      "import_dxf(file = \"x.dxf\");",
    ];
    for (const sample of samples) {
      const result = sanitizeOpenScad(sample);
      expect(result.ok, sample).toBe(false);
    }
  });

  it("blocks path traversal combined with include-like tokens", () => {
    const result = sanitizeOpenScad('include "../outside.scad";\ncube(1);');
    expect(result.ok).toBe(false);
  });

  it("rejects code with no solid primitive", () => {
    const result = sanitizeOpenScad("x = 1 + 2;");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(" ")).toMatch(/primitive/i);
    }
  });

  it("allows only import(\"imported.stl\") when editing an imported mesh", () => {
    const allowed = sanitizeOpenScad(
      'difference() { import("imported.stl", convexity = 10); cylinder(h = 20, d = 8); }',
      { allowImportedMesh: true },
    );
    expect(allowed.ok).toBe(true);

    const blockedDefault = sanitizeOpenScad('import("imported.stl");');
    expect(blockedDefault.ok).toBe(false);

    const otherFile = sanitizeOpenScad('import("evil.stl"); cube(1);', { allowImportedMesh: true });
    expect(otherFile.ok).toBe(false);

    const fromScratch = sanitizeOpenScad("cube(20);", { allowImportedMesh: true });
    expect(fromScratch.ok).toBe(false);
    if (!fromScratch.ok) {
      expect(fromScratch.errors.join(" ")).toMatch(/imported\.stl/i);
    }
  });

  it("rejects oversized payloads", () => {
    const result = sanitizeOpenScad(`cube(1);\n${"//".padEnd(80_010, "x")}`);
    expect(result.ok).toBe(false);
  });
});
