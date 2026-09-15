import { describe, expect, it } from "vitest";
import {
  linuxInstallFiles,
  macosInstallFiles,
  portableOpenscadDirs,
  resolveOpenscad,
  windowsInstallDirs,
} from "@/lib/openscad";

describe("OpenSCAD resolution", () => {
  it("prefers OPENSCAD_PATH when it points at a file", () => {
    const resolved = resolveOpenscad({
      platform: "win32",
      cwd: "C:\\AllosWorkstation\\DescribePrint",
      homedir: "C:\\Users\\owner",
      env: { OPENSCAD_PATH: "D:\\portable\\openscad.exe", OPENSCAD_BIN: "C:\\ignored\\openscad.exe" },
      isFile: (file) => file === "D:\\portable\\openscad.exe",
    });
    expect(resolved.found).toBe(true);
    expect(resolved.source).toBe("OPENSCAD_PATH");
    expect(resolved.command).toBe("D:\\portable\\openscad.exe");
  });

  it("treats OPENSCAD_PATH as a folder and appends openscad.exe on Windows", () => {
    const resolved = resolveOpenscad({
      platform: "win32",
      cwd: "C:\\repo",
      homedir: "C:\\Users\\owner",
      env: { OPENSCAD_PATH: "D:\\OpenSCADPortable" },
      isFile: (file) => file === "D:\\OpenSCADPortable\\openscad.exe",
    });
    expect(resolved.found).toBe(true);
    expect(resolved.command).toBe("D:\\OpenSCADPortable\\openscad.exe");
    expect(resolved.source).toBe("OPENSCAD_PATH");
  });

  it("reports a missing OPENSCAD_PATH without falling through to PATH", () => {
    const resolved = resolveOpenscad({
      platform: "win32",
      cwd: "C:\\repo",
      homedir: "C:\\Users\\owner",
      env: {
        OPENSCAD_PATH: "Z:\\missing\\openscad.exe",
        PATH: "C:\\Windows\\System32",
      },
      isFile: () => false,
    });
    expect(resolved.found).toBe(false);
    expect(resolved.source).toBe("OPENSCAD_PATH");
    expect(resolved.command).toBe("Z:\\missing\\openscad.exe");
  });

  it("honors an explicit OPENSCAD_BIN path", () => {
    const resolved = resolveOpenscad({
      platform: "linux",
      cwd: "/opt/describeprint",
      homedir: "/home/owner",
      env: { OPENSCAD_BIN: "/opt/custom/openscad" },
      isFile: (file) => file === "/opt/custom/openscad",
    });
    expect(resolved.found).toBe(true);
    expect(resolved.source).toBe("OPENSCAD_BIN");
    expect(resolved.command).toBe("/opt/custom/openscad");
  });

  it("finds a portable drop-in under vendor/openscad", () => {
    const resolved = resolveOpenscad({
      platform: "win32",
      cwd: "C:\\AllosWorkstation\\DescribePrint",
      homedir: "C:\\Users\\owner",
      env: {},
      isFile: (file) => file === "C:\\AllosWorkstation\\DescribePrint\\vendor\\openscad\\openscad.exe",
    });
    expect(resolved.found).toBe(true);
    expect(resolved.source).toBe("portable");
    expect(resolved.command).toBe("C:\\AllosWorkstation\\DescribePrint\\vendor\\openscad\\openscad.exe");
    expect(portableOpenscadDirs("C:\\AllosWorkstation\\DescribePrint", "win32")).toContain(
      "C:\\AllosWorkstation\\DescribePrint\\vendor\\openscad",
    );
  });

  it("auto-finds a typical Windows Program Files install", () => {
    const dirs = windowsInstallDirs(
      { ProgramFiles: "C:\\Program Files", LOCALAPPDATA: "C:\\Users\\owner\\AppData\\Local" },
      "C:\\Users\\owner",
    );
    expect(dirs).toContain("C:\\Program Files\\OpenSCAD");
    expect(dirs).toContain("C:\\Program Files\\OpenSCAD (Nightly)");
    expect(dirs).toContain("C:\\Users\\owner\\AppData\\Local\\Programs\\OpenSCAD");

    const resolved = resolveOpenscad({
      platform: "win32",
      cwd: "C:\\repo",
      homedir: "C:\\Users\\owner",
      env: { ProgramFiles: "C:\\Program Files", LOCALAPPDATA: "C:\\Users\\owner\\AppData\\Local" },
      isFile: (file) => file === "C:\\Program Files\\OpenSCAD\\openscad.exe",
    });
    expect(resolved.found).toBe(true);
    expect(resolved.source).toBe("windows-install");
    expect(resolved.command).toBe("C:\\Program Files\\OpenSCAD\\openscad.exe");
  });

  it("finds OpenSCAD on PATH when no env override is set", () => {
    const resolved = resolveOpenscad({
      platform: "linux",
      cwd: "/workspace",
      homedir: "/home/owner",
      env: { PATH: "/opt/bin:/usr/bin" },
      isFile: (file) => file === "/opt/bin/openscad",
    });
    expect(resolved.found).toBe(true);
    expect(resolved.source).toBe("path");
    expect(resolved.command).toBe("/opt/bin/openscad");
  });

  it("lists macOS and Linux well-known install files", () => {
    expect(macosInstallFiles()[0]).toContain("OpenSCAD.app");
    expect(linuxInstallFiles()).toContain("/usr/bin/openscad");
  });

  it("does not treat a bare OPENSCAD_BIN=openscad as a final path", () => {
    const resolved = resolveOpenscad({
      platform: "win32",
      cwd: "C:\\repo",
      homedir: "C:\\Users\\owner",
      env: {
        OPENSCAD_BIN: "openscad",
        ProgramFiles: "C:\\Program Files",
      },
      isFile: (file) => file === "C:\\Program Files\\OpenSCAD\\openscad.exe",
    });
    expect(resolved.found).toBe(true);
    expect(resolved.source).toBe("windows-install");
  });
});
