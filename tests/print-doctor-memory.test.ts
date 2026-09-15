import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  PRINT_DOCTOR_MEMORY_KEY,
  applyStoredDoctorMemory,
  emptyPrintDoctorMemory,
  findMemoryEntry,
  memoryScopeFromResult,
  parsePrintDoctorMemory,
  readPrintDoctorMemory,
  rememberPerfect,
  rememberStillBad,
  serializePrintDoctorMemory,
  writePrintDoctorMemory,
} from "@/lib/machine/print-doctor-memory";
import { diagnosePrintComplaint, looksLikeDoctorFeedback, nextAfterRejected } from "@/lib/print-doctor";

function memoryFiles(): string[] {
  return ["lib/machine/print-doctor-memory.ts", "lib/print-doctor.ts", "lib/machine/ams-help.ts"];
}

function fakeStorage(initial?: Record<string, string>): Storage {
  const data = new Map<string, string>(Object.entries(initial ?? {}));
  return {
    get length() {
      return data.size;
    },
    clear() {
      data.clear();
    },
    getItem(key: string) {
      return data.has(key) ? data.get(key)! : null;
    },
    key(index: number) {
      return [...data.keys()][index] ?? null;
    },
    removeItem(key: string) {
      data.delete(key);
    },
    setItem(key: string, value: string) {
      data.set(key, value);
    },
  };
}

describe("print-doctor feedback memory", () => {
  it("Perfect remembers the proposed fix for later similar complaints", () => {
    const first = diagnosePrintComplaint({ complaint: "stringing with PETG" });
    expect(first.fixes[0]?.id).toBe("stringing:nozzleC");

    const stored = rememberPerfect(emptyPrintDoctorMemory(), first);
    expect(serializePrintDoctorMemory(stored)).toContain("stringing:nozzleC");
    expect(serializePrintDoctorMemory(stored)).not.toMatch(/""/);

    const storage = fakeStorage();
    writePrintDoctorMemory(stored, storage);
    const reloaded = readPrintDoctorMemory(storage);
    const recalled = applyStoredDoctorMemory(
      reloaded,
      diagnosePrintComplaint({ complaint: "stringing with PETG" }),
    );
    expect(recalled.learned).toBe(true);
    expect(recalled.fixes[0]?.id).toBe("stringing:nozzleC");
    expect(recalled.diagnosis).toMatch(/Last time this worked/i);
    expect(findMemoryEntry(reloaded, memoryScopeFromResult(first))?.preferredFixId).toBe("stringing:nozzleC");
  });

  it("Still bad skips that fix next time and tries the next tweak", () => {
    const first = diagnosePrintComplaint({ complaint: "stringing with PETG" });
    const rejectedId = first.fixes[0]?.id;
    expect(rejectedId).toBe("stringing:nozzleC");

    const { store, next } = rememberStillBad(emptyPrintDoctorMemory(), first);
    expect(next.fixes[0]?.id).toBe("stringing:retractionMm");
    expect(next.fixes.some((fix) => fix.id === rejectedId)).toBe(false);
    expect(next.diagnosis).toMatch(/next likely tweak/i);
    expect(next.autofix).toBeUndefined();

    const recalled = applyStoredDoctorMemory(store, diagnosePrintComplaint({ complaint: "stringing with PETG" }));
    expect(recalled.fixes[0]?.id).toBe("stringing:retractionMm");
    expect(recalled.fixes.some((fix) => fix.id === rejectedId)).toBe(false);
    expect(recalled.learned).toBeFalsy();
  });

  it("escalates to the next likely cause, then physical steps, without LAN", () => {
    const stringing = diagnosePrintComplaint({ complaint: "stringing", material: "pla" });
    const afterFixes = stringing.fixes.reduce(
      (acc, _fix, index, all) => {
        if (index === all.length - 1) return acc;
        return rememberStillBad(acc.store, acc.next);
      },
      { store: emptyPrintDoctorMemory(), next: stringing },
    );
    const { next } = rememberStillBad(afterFixes.store, afterFixes.next);
    expect(next.defectId).toBe("wet-filament");
    expect(next.diagnosis).toMatch(/Next likely cause/i);
    expect(next.autofix).toBeUndefined();

    const exhausted = nextAfterRejected(next, {
      rejectedFixIds: next.fixes.map((fix) => fix.id ?? ""),
      rejectedDefectIds: ["stringing", "wet-filament", "under-extrusion", "clog"],
    });
    expect(exhausted.fixes.every((fix) => fix.kind === "physical")).toBe(true);
    expect(exhausted.diagnosis).toMatch(/not sending LAN/i);
  });

  it("scopes memory by material so PLA does not reuse a PETG Perfect", () => {
    const petg = diagnosePrintComplaint({ complaint: "stringing with PETG" });
    const stored = rememberPerfect(emptyPrintDoctorMemory(), petg);
    const pla = applyStoredDoctorMemory(stored, diagnosePrintComplaint({ complaint: "stringing", material: "pla" }));
    expect(pla.material).toBe("pla");
    expect(pla.learned).toBeFalsy();
    expect(pla.diagnosis).not.toMatch(/Last time this worked/i);
    expect(findMemoryEntry(stored, memoryScopeFromResult(pla))).toBeUndefined();
  });

  it("omits empty entries and ignores corrupt localStorage", () => {
    expect(serializePrintDoctorMemory(emptyPrintDoctorMemory())).toBe("");
    expect(serializePrintDoctorMemory({ entries: [{ printerId: "bambu-lab-p2s", material: "pla", symptom: "stringing" }] })).toBe(
      "",
    );
    expect(parsePrintDoctorMemory("not-json").entries).toEqual([]);
    expect(parsePrintDoctorMemory(null).entries).toEqual([]);

    const storage = fakeStorage();
    writePrintDoctorMemory(emptyPrintDoctorMemory(), storage);
    expect(storage.getItem(PRINT_DOCTOR_MEMORY_KEY)).toBeNull();
  });

  it("does not import CAD undo/history, Viewer, or heatmap files", () => {
    for (const file of memoryFiles()) {
      const src = readFileSync(path.join(process.cwd(), file), "utf8");
      expect(src).not.toMatch(/version-history|describe-edit undo|cad-history/i);
      expect(src).not.toMatch(/from ["']@\/lib\/.*undo/);
      expect(src).not.toMatch(/from ["']@\/components\/Viewer/);
      expect(src).not.toMatch(/heatmap|strength-preview/i);
      expect(src).not.toMatch(/from ["']@\/lib\/cad-reshape/);
    }
  });
});

describe("print-doctor feedback phrases", () => {
  it("accepts still bad / perfect without stealing CAD prompts", () => {
    expect(looksLikeDoctorFeedback("perfect")).toBe("perfect");
    expect(looksLikeDoctorFeedback("that worked")).toBe("perfect");
    expect(looksLikeDoctorFeedback("still bad")).toBe("still-bad");
    expect(looksLikeDoctorFeedback("still-bad")).toBe("still-bad");
    expect(looksLikeDoctorFeedback("didn't work")).toBe("still-bad");
    expect(looksLikeDoctorFeedback("a perfect cube")).toBeUndefined();
    expect(looksLikeDoctorFeedback("20mm cube with 5mm hole")).toBeUndefined();
  });
});
