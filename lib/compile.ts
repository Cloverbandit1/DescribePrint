import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveOpenscadBin } from "./openscad";

const DEFAULT_TIMEOUT_MS = 45_000;

export type CompileResult = {
  stl: Buffer;
  stderr: string;
  stdout: string;
  workDir: string;
};

export class CompileError extends Error {
  stderr: string;
  constructor(message: string, stderr = "") {
    super(message);
    this.name = "CompileError";
    this.stderr = stderr;
  }
}

function compileOpenscadBin(): string {
  return resolveOpenscadBin();
}

function timeoutMs(): number {
  const raw = Number(process.env.OPENSCAD_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

async function runCommand(
  command: string,
  args: string[],
  opts: { cwd: string; timeout: number },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: {
        ...process.env,
        // Prefer software GL if a display is missing.
        LIBGL_ALWAYS_SOFTWARE: process.env.LIBGL_ALWAYS_SOFTWARE || "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new CompileError(`OpenSCAD timed out after ${opts.timeout}ms`, stderr));
    }, opts.timeout);

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

export async function compileOpenScad(code: string, workDir?: string): Promise<CompileResult> {
  const dir = workDir ?? (await mkdtemp(path.join(tmpdir(), "describeprint-")));
  await mkdir(dir, { recursive: true });
  const scadPath = path.join(dir, "model.scad");
  const stlPath = path.join(dir, "model.stl");
  await writeFile(scadPath, code, "utf8");

  const bin = compileOpenscadBin();
  const timeout = timeoutMs();
  const args = ["-o", stlPath, "--export-format=binstl", scadPath];

  const looksLikeDisplayError = (stderr: string, stdout: string) =>
    /cannot open display|no display|glx|egl|qt\.qpa|could not initialize|unable to open|xcb/i.test(
      `${stderr}\n${stdout}`,
    );

  let result: { code: number | null; stdout: string; stderr: string };
  try {
    result = await runCommand(bin, args, { cwd: dir, timeout });
    if (result.code !== 0 && looksLikeDisplayError(result.stderr, result.stdout)) {
      result = await runCommand("xvfb-run", ["-a", bin, ...args], { cwd: dir, timeout });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if ("code" in (err as NodeJS.ErrnoException) && (err as NodeJS.ErrnoException).code === "ENOENT") {
      if ((err as NodeJS.ErrnoException).path === "xvfb-run") {
        throw new CompileError(
          "OpenSCAD needs a display. Install xvfb (`sudo apt-get install -y xvfb`) or run under xvfb-run.",
          message,
        );
      }
      throw new CompileError(
        "OpenSCAD is not installed or not on PATH. Install from https://openscad.org/, set OPENSCAD_PATH to the executable, or place a portable copy in vendor/openscad/.",
        message,
      );
    }
    throw err;
  }

  if (result.code !== 0) {
    throw new CompileError(
      `OpenSCAD exited with code ${result.code}: ${result.stderr || result.stdout || "no output"}`.slice(0, 4000),
      result.stderr,
    );
  }

  let stl: Buffer;
  try {
    stl = await readFile(stlPath);
  } catch {
    throw new CompileError("OpenSCAD did not write an STL file", result.stderr);
  }

  if (stl.length === 0) {
    throw new CompileError("OpenSCAD wrote an empty STL", result.stderr);
  }

  return { stl, stderr: result.stderr, stdout: result.stdout, workDir: dir };
}

export async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "describeprint-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
