import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { compileOpenScad, withTempDir } from "@/lib/compile";
import { defaultFixture } from "@/lib/fixtures";
import { checkMesh, hasHardMeshFailure } from "@/lib/mesh-check";
import { sanitizeOpenScad } from "@/lib/sanitize";
import { parseStl } from "@/lib/stl";

function hasOpenscad(): boolean {
  const bin = process.env.OPENSCAD_BIN || "openscad";
  const probe = spawnSync(bin, ["-v"], { encoding: "utf8" });
  return probe.status === 0 || Boolean(probe.stderr || probe.stdout);
}

describe("OpenSCAD compile path", () => {
  it.skipIf(!hasOpenscad())("compiles the default fixture to a printable STL", async () => {
    const sanitized = sanitizeOpenScad(defaultFixture().code);
    expect(sanitized.ok).toBe(true);
    if (!sanitized.ok) return;

    await withTempDir(async (dir) => {
      const compiled = await compileOpenScad(sanitized.code, dir);
      expect(compiled.stl.length).toBeGreaterThan(80);
      const report = checkMesh(parseStl(compiled.stl));
      expect(hasHardMeshFailure(report)).toBe(false);
      expect(report.triangleCount).toBeGreaterThan(0);
      expect(report.volumeMm3).toBeGreaterThan(0);
    });
  });
});
