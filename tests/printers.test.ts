import { describe, expect, it } from "vitest";
import { BAMBU_LAB_P2S, defaultPrinter } from "@/lib/printers";

describe("printer profiles (V0 stub)", () => {
  it("defaults to the Bambu Lab P2S build volume and 0.4 mm nozzle", () => {
    const printer = defaultPrinter();
    expect(printer).toEqual(BAMBU_LAB_P2S);
    expect(printer.buildVolumeMm).toEqual([256, 256, 256]);
    expect(printer.nozzleMm).toBe(0.4);
    expect(printer.supportedNozzlesMm).toContain(0.4);
  });
});
