import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const windowsDir = path.resolve(import.meta.dirname, "../scripts/windows");

function packPs1Files() {
  return readdirSync(windowsDir)
    .filter((name) => name.endsWith(".ps1"))
    .map((name) => path.join(windowsDir, name));
}

/** Windows PowerShell 5.1 treats U+201C / U+201D as string delimiters. */
const SMART_DOUBLE = /[\u201c\u201d]/;
/** UTF-8 em dash / arrow / ellipsis become smart quotes when 5.1 reads the file as ANSI. */
const RISKY_UNICODE = /[\u2014\u2013\u2192\u2026]/;

function assertNoEscapedClosingQuote(text, file) {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trimStart().startsWith("#")) continue;
    let inDouble = false;
    let inSingle = false;
    for (let c = 0; c < line.length; c++) {
      const ch = line[c];
      const prev = c > 0 ? line[c - 1] : "";
      if (!inDouble && ch === "'" && !inSingle) {
        inSingle = true;
        continue;
      }
      if (inSingle) {
        if (ch === "'" && line[c + 1] === "'") {
          c += 1;
          continue;
        }
        if (ch === "'") inSingle = false;
        continue;
      }
      if (ch === "`" && inDouble) {
        c += 1;
        continue;
      }
      if (ch === '"') {
        if (inDouble && prev === "\\") {
          throw new Error(
            `${path.basename(file)}:${i + 1}: backslash-quote inside a double-quoted string (Windows PowerShell 5.1 parse error)`,
          );
        }
        inDouble = !inDouble;
      }
    }
    if (inDouble) {
      throw new Error(`${path.basename(file)}:${i + 1}: unterminated double-quoted string`);
    }
  }
}

describe("Windows PowerShell 5.1 parse safety", () => {
  it("pack scripts are UTF-8 BOM + ASCII (no ANSI-misdecoded terminator)", () => {
    const files = packPs1Files();
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const buf = readFileSync(file);
      expect(buf.subarray(0, 3), path.basename(file)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
      const text = buf.subarray(3).toString("utf8");
      expect(text, path.basename(file)).toMatch(/^[\x09\x0a\x0d\x20-\x7e]*$/);
      expect(text, path.basename(file)).not.toMatch(SMART_DOUBLE);
      expect(text, path.basename(file)).not.toMatch(RISKY_UNICODE);
      expect(() => assertNoEscapedClosingQuote(text, file)).not.toThrow();
    }
  });

  it("Install-AllosWorstation.ps1 does not embed Desktop paths in double quotes", () => {
    const text = readFileSync(path.join(windowsDir, "Install-AllosWorstation.ps1"), "utf8").replace(
      /^\uFEFF/,
      "",
    );
    expect(text).not.toMatch(/"[^"]*Desktop\\AllosWorstation\\DescribePrint[^"]*"/);
    expect(text).toMatch(/'Smith often stays on OneDrive Desktop\\AllosWorstation\\DescribePrint'/);
    expect(text).toMatch(/Join-Path \$env:USERPROFILE 'AllosWorstation\\DescribePrint'/);
    expect(text).toMatch(/--local-app-data/);
    expect(text).toMatch(/\[switch\]\$AutoStart/);
    expect(text).toMatch(/\[switch\]\$RemoveAutoStart/);
    expect(text).toMatch(/Install-AutoStart\.ps1/);
  });
});
