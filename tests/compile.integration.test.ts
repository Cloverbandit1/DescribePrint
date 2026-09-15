import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { compileOpenScad, withTempDir } from "@/lib/compile";
import { defaultFixture } from "@/lib/fixtures";
import { checkMesh, hasHardMeshFailure } from "@/lib/mesh-check";
import { resolveOpenscad } from "@/lib/openscad";
import { IMPORTED_MESH_FILENAME, sanitizeOpenScad } from "@/lib/sanitize";
import { makeAxisAlignedBoxMesh, parseStl, writeBinaryStl } from "@/lib/stl";

function hasOpenscad(): boolean {
  const resolved = resolveOpenscad();
  if (!resolved.found && !process.env.OPENSCAD_BIN && !process.env.OPENSCAD_PATH) {
    const probe = spawnSync(resolved.command, ["-v"], { encoding: "utf8" });
    return probe.status === 0 || Boolean(probe.stderr || probe.stdout);
  }
  if (!resolved.found) return false;
  const probe = spawnSync(resolved.command, ["-v"], { encoding: "utf8" });
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

  it.skipIf(!hasOpenscad())("compiles an imported-mesh wrapper around a server-written STL", async () => {
    const wrapper = sanitizeOpenScad(
      `difference() {
  import("${IMPORTED_MESH_FILENAME}", convexity = 10);
  translate([5, 5, -1]) cylinder(h = 12, d = 4);
}`,
      { allowImportedMesh: true },
    );
    expect(wrapper.ok).toBe(true);
    if (!wrapper.ok) return;

    await withTempDir(async (dir) => {
      await writeFile(path.join(dir, IMPORTED_MESH_FILENAME), writeBinaryStl(makeAxisAlignedBoxMesh([10, 10, 10])));
      const compiled = await compileOpenScad(wrapper.code, dir);
      const report = checkMesh(parseStl(compiled.stl));
      expect(hasHardMeshFailure(report)).toBe(false);
      expect(report.triangleCount).toBeGreaterThan(0);
    });
  });
});
