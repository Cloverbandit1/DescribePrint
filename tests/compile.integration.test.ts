import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { compileOpenScad, withTempDir } from "@/lib/compile";
import { defaultFixture, matchFixture } from "@/lib/fixtures";
import { BALL_FIXTURE_PROMPT, HINGE_FIXTURE_PROMPT, PIN_FIXTURE_PROMPT, SNAP_FIXTURE_PROMPT } from "@/lib/joints";
import { CUBE_FILLET_PROMPT, CUBE_STEAMPUNK_PROMPT } from "@/lib/pretty-up";
import {
  CHEST_CHEVRON_PROMPT,
  CUBE_ETCH_PROMPT,
  GAUNTLET_CUFF_PROMPT,
  HELMET_EMBOSS_PROMPT,
  HELMET_MULTI_RELIEF_PROMPT,
} from "@/lib/relief";
import { buildImportedMeshWrapper, parseImportHoleSpec } from "@/lib/import-hole";
import { boundingBoxMm, checkMesh, countSolidComponents, hasHardMeshFailure } from "@/lib/mesh-check";
import { resolveOpenscad } from "@/lib/openscad";
import { IMPORTED_MESH_FILENAME, sanitizeOpenScad } from "@/lib/sanitize";
import { sitMeshOnBed } from "@/lib/mesh-transform";
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

  it.skipIf(!hasOpenscad())("compiles each two-color fixture region as its own mesh", async () => {
    const fixture = matchFixture("red 40mm plaque with black letters");
    expect(fixture).not.toBeNull();
    const sanitized = sanitizeOpenScad(fixture!.code);
    expect(sanitized.ok).toBe(true);
    if (!sanitized.ok) return;

    await withTempDir(async (dir) => {
      const full = await compileOpenScad(sanitized.code, dir);
      const body = await compileOpenScad(`${sanitized.code}\n!region_body();\n`, dir);
      const letters = await compileOpenScad(`${sanitized.code}\n!region_letters();\n`, dir);
      expect(parseStl(full.stl).triangles.length).toBeGreaterThan(parseStl(body.stl).triangles.length);
      expect(parseStl(letters.stl).triangles.length).toBeGreaterThan(0);
      expect(checkMesh(parseStl(body.stl)).volumeMm3).toBeGreaterThan(checkMesh(parseStl(letters.stl)).volumeMm3);
    });
  });

  it.skipIf(!hasOpenscad())("differences an 8 mm through-hole from a 20 mm cube STL", async () => {
    const mesh = sitMeshOnBed(makeAxisAlignedBoxMesh([20, 20, 20]));
    const spec = parseImportHoleSpec("add an 8 mm hole through the center", boundingBoxMm(mesh));
    expect(spec?.through).toBe(true);
    const wrapper = sanitizeOpenScad(buildImportedMeshWrapper({ mesh, hole: spec }), { allowImportedMesh: true });
    expect(wrapper.ok).toBe(true);
    if (!wrapper.ok) return;

    await withTempDir(async (dir) => {
      await writeFile(path.join(dir, IMPORTED_MESH_FILENAME), writeBinaryStl(mesh));
      const compiled = await compileOpenScad(wrapper.code, dir);
      const result = sitMeshOnBed(parseStl(compiled.stl));
      const report = checkMesh(result);
      expect(hasHardMeshFailure(report)).toBe(false);
      expect(countSolidComponents(result)).toBe(1);
      expect(report.boundingBoxMm.min[2]).toBeCloseTo(0, 1);
      expect(report.volumeMm3).toBeGreaterThan(5500);
      expect(report.volumeMm3).toBeLessThan(7800);
    });
  });

  it.skipIf(!hasOpenscad())("compiles the print-in-place hinge fixture to a printable mesh", async () => {
    const fixture = matchFixture(HINGE_FIXTURE_PROMPT);
    expect(fixture).not.toBeNull();
    const sanitized = sanitizeOpenScad(fixture!.code);
    expect(sanitized.ok).toBe(true);
    if (!sanitized.ok) return;

    await withTempDir(async (dir) => {
      const compiled = await compileOpenScad(sanitized.code, dir);
      const report = checkMesh(parseStl(compiled.stl));
      expect(hasHardMeshFailure(report)).toBe(false);
      expect(report.triangleCount).toBeGreaterThan(0);
      expect(report.volumeMm3).toBeGreaterThan(0);
      expect(countSolidComponents(parseStl(compiled.stl))).toBeGreaterThan(1);
      expect(report.boundingBoxMm.min[2]).toBeLessThanOrEqual(0.05);
    });
  });

  it.skipIf(!hasOpenscad())("compiles the print-in-place pin fixture to a printable mesh", async () => {
    const fixture = matchFixture(PIN_FIXTURE_PROMPT);
    expect(fixture).not.toBeNull();
    const sanitized = sanitizeOpenScad(fixture!.code);
    expect(sanitized.ok).toBe(true);
    if (!sanitized.ok) return;

    await withTempDir(async (dir) => {
      const compiled = await compileOpenScad(sanitized.code, dir);
      const report = checkMesh(parseStl(compiled.stl));
      expect(hasHardMeshFailure(report)).toBe(false);
      expect(report.volumeMm3).toBeGreaterThan(0);
      expect(countSolidComponents(parseStl(compiled.stl))).toBeGreaterThan(1);
    });
  });

  it.skipIf(!hasOpenscad())("compiles the print-in-place ball fixture to a printable mesh", async () => {
    const fixture = matchFixture(BALL_FIXTURE_PROMPT);
    expect(fixture).not.toBeNull();
    const sanitized = sanitizeOpenScad(fixture!.code);
    expect(sanitized.ok).toBe(true);
    if (!sanitized.ok) return;

    await withTempDir(async (dir) => {
      const compiled = await compileOpenScad(sanitized.code, dir);
      const report = checkMesh(parseStl(compiled.stl));
      expect(hasHardMeshFailure(report)).toBe(false);
      expect(report.volumeMm3).toBeGreaterThan(0);
      expect(countSolidComponents(parseStl(compiled.stl))).toBeGreaterThan(1);
    });
  });

  it.skipIf(!hasOpenscad())("compiles the snap-fit fixture to a printable mesh", async () => {
    const fixture = matchFixture(SNAP_FIXTURE_PROMPT);
    expect(fixture).not.toBeNull();
    const sanitized = sanitizeOpenScad(fixture!.code);
    expect(sanitized.ok).toBe(true);
    if (!sanitized.ok) return;

    await withTempDir(async (dir) => {
      const compiled = await compileOpenScad(sanitized.code, dir);
      const report = checkMesh(parseStl(compiled.stl));
      expect(hasHardMeshFailure(report)).toBe(false);
      expect(report.volumeMm3).toBeGreaterThan(0);
      expect(countSolidComponents(parseStl(compiled.stl))).toBeGreaterThan(1);
    });
  });

  it.skipIf(!hasOpenscad())("compiles chest, gauntlet, and multi-relief fixtures", async () => {
    const chest = matchFixture(CHEST_CHEVRON_PROMPT);
    const cuff = matchFixture(GAUNTLET_CUFF_PROMPT);
    const multi = matchFixture(HELMET_MULTI_RELIEF_PROMPT);
    expect(chest && cuff && multi).toBeTruthy();
    const chestOk = sanitizeOpenScad(chest!.code);
    const cuffOk = sanitizeOpenScad(cuff!.code);
    const multiOk = sanitizeOpenScad(multi!.code);
    expect(chestOk.ok && cuffOk.ok && multiOk.ok).toBe(true);
    if (!chestOk.ok || !cuffOk.ok || !multiOk.ok) return;

    await withTempDir(async (dir) => {
      const chestMesh = parseStl((await compileOpenScad(chestOk.code, dir)).stl);
      const cuffMesh = parseStl((await compileOpenScad(cuffOk.code, dir)).stl);
      const multiMesh = parseStl((await compileOpenScad(multiOk.code, dir)).stl);
      expect(hasHardMeshFailure(checkMesh(chestMesh))).toBe(false);
      expect(hasHardMeshFailure(checkMesh(cuffMesh))).toBe(false);
      expect(hasHardMeshFailure(checkMesh(multiMesh))).toBe(false);
      expect(checkMesh(chestMesh).volumeMm3).toBeGreaterThan(0);
      expect(checkMesh(cuffMesh).volumeMm3).toBeGreaterThan(0);
      expect(checkMesh(multiMesh).volumeMm3).toBeGreaterThan(0);
    });
  });

  it.skipIf(!hasOpenscad())("compiles the helmet emboss and cube etch fixtures", async () => {
    const helmet = matchFixture(HELMET_EMBOSS_PROMPT);
    const cube = matchFixture(CUBE_ETCH_PROMPT);
    expect(helmet && cube).toBeTruthy();
    const helmetOk = sanitizeOpenScad(helmet!.code);
    const cubeOk = sanitizeOpenScad(cube!.code);
    expect(helmetOk.ok && cubeOk.ok).toBe(true);
    if (!helmetOk.ok || !cubeOk.ok) return;

    await withTempDir(async (dir) => {
      const helmetMesh = parseStl((await compileOpenScad(helmetOk.code, dir)).stl);
      const cubeMesh = parseStl((await compileOpenScad(cubeOk.code, dir)).stl);
      expect(hasHardMeshFailure(checkMesh(helmetMesh))).toBe(false);
      expect(hasHardMeshFailure(checkMesh(cubeMesh))).toBe(false);
      expect(checkMesh(helmetMesh).volumeMm3).toBeGreaterThan(0);
      expect(checkMesh(cubeMesh).volumeMm3).toBeGreaterThan(0);
      expect(checkMesh(cubeMesh).volumeMm3).toBeLessThan(8000);
    });
  });

  it.skipIf(!hasOpenscad())("compiles pretty-up fillet and steampunk fixtures without closing the hole", async () => {
    const fillet = matchFixture(CUBE_FILLET_PROMPT);
    const steampunk = matchFixture(CUBE_STEAMPUNK_PROMPT);
    expect(fillet && steampunk).toBeTruthy();
    const filletOk = sanitizeOpenScad(fillet!.code);
    const steamOk = sanitizeOpenScad(steampunk!.code);
    expect(filletOk.ok && steamOk.ok).toBe(true);
    if (!filletOk.ok || !steamOk.ok) return;

    await withTempDir(async (dir) => {
      const filletMesh = parseStl((await compileOpenScad(filletOk.code, dir)).stl);
      const steamMesh = parseStl((await compileOpenScad(steamOk.code, dir)).stl);
      const filletReport = checkMesh(filletMesh);
      const steamReport = checkMesh(steamMesh);
      expect(hasHardMeshFailure(filletReport)).toBe(false);
      expect(hasHardMeshFailure(steamReport)).toBe(false);
      expect(filletReport.volumeMm3).toBeGreaterThan(0);
      expect(filletReport.volumeMm3).toBeLessThan(8000);
      expect(steamReport.volumeMm3).toBeGreaterThan(filletReport.volumeMm3);
    });
  });
});
