import { defaultPrinter, type PrinterProfile } from "./printers";

/**
 * Stub alternate printers for the "design exceeds current machine" owner
 * requirement. These are designation / suggestion profiles only — not a farm,
 * not live control, and not a slicer picker.
 */
export type AlternateMachineId = "creality-k1-max" | "bambu-lab-h2d" | "prusa-xl";

export type AlternateMachineProfile = {
  id: AlternateMachineId;
  name: string;
  vendor: string;
  buildVolumeMm: [number, number, number];
  stub: true;
  notes: string;
};

export type MachineDesignation = {
  currentPrinterId: string;
  currentPrinterName: string;
  currentBuildVolumeMm: [number, number, number];
  exceedsCurrentPrinter: boolean;
  oversizedAxes: Array<"x" | "y" | "z">;
  suggestedMachines: AlternateMachineProfile[];
  designatedMachine: AlternateMachineProfile | null;
  message: string | null;
};

export const ALTERNATE_MACHINES: AlternateMachineProfile[] = [
  {
    id: "creality-k1-max",
    name: "Creality K1 Max",
    vendor: "Creality",
    buildVolumeMm: [300, 300, 300],
    stub: true,
    notes: "Stub designation only — not connected, not a farm target.",
  },
  {
    id: "bambu-lab-h2d",
    name: "Bambu Lab H2D",
    vendor: "Bambu Lab",
    buildVolumeMm: [340, 320, 325],
    stub: true,
    notes: "Stub designation only — not connected, not a farm target.",
  },
  {
    id: "prusa-xl",
    name: "Prusa XL",
    vendor: "Prusa Research",
    buildVolumeMm: [360, 360, 360],
    stub: true,
    notes: "Stub designation only — not connected, not a farm target.",
  },
];

const AXIS: Array<"x" | "y" | "z"> = ["x", "y", "z"];

export function machineFitsSize(buildVolumeMm: [number, number, number], sizeMm: [number, number, number]): boolean {
  return sizeMm.every((dim, index) => dim <= buildVolumeMm[index]! + 1e-6);
}

export function oversizedAxesFor(buildVolumeMm: [number, number, number], sizeMm: [number, number, number]): Array<"x" | "y" | "z"> {
  return AXIS.filter((_, index) => sizeMm[index]! > buildVolumeMm[index]! + 1e-6);
}

export function machinesThatFit(sizeMm: [number, number, number]): AlternateMachineProfile[] {
  return ALTERNATE_MACHINES.filter((machine) => machineFitsSize(machine.buildVolumeMm, sizeMm)).sort(
    (a, b) => volumeOf(a.buildVolumeMm) - volumeOf(b.buildVolumeMm),
  );
}

export function designateMachineForSize(
  sizeMm: [number, number, number],
  current: PrinterProfile = defaultPrinter(),
): MachineDesignation {
  const oversizedAxes = oversizedAxesFor(current.buildVolumeMm, sizeMm);
  const exceedsCurrentPrinter = oversizedAxes.length > 0;
  const suggestedMachines = exceedsCurrentPrinter ? machinesThatFit(sizeMm) : [];
  const designatedMachine = suggestedMachines[0] ?? null;
  return {
    currentPrinterId: current.id,
    currentPrinterName: current.name,
    currentBuildVolumeMm: current.buildVolumeMm,
    exceedsCurrentPrinter,
    oversizedAxes,
    suggestedMachines,
    designatedMachine,
    message: designationMessage({
      sizeMm,
      current,
      exceedsCurrentPrinter,
      suggestedMachines,
      designatedMachine,
    }),
  };
}

function volumeOf(size: [number, number, number]): number {
  return size[0] * size[1] * size[2];
}

function designationMessage(input: {
  sizeMm: [number, number, number];
  current: PrinterProfile;
  exceedsCurrentPrinter: boolean;
  suggestedMachines: AlternateMachineProfile[];
  designatedMachine: AlternateMachineProfile | null;
}): string | null {
  if (!input.exceedsCurrentPrinter) return null;
  const [x, y, z] = input.sizeMm.map((n) => n.toFixed(1));
  const [cx, cy, cz] = input.current.buildVolumeMm;
  const head = `This solid is ${x} × ${y} × ${z} mm — larger than the current ${input.current.name} (${cx} × ${cy} × ${cz} mm).`;
  if (input.designatedMachine) {
    const [dx, dy, dz] = input.designatedMachine.buildVolumeMm;
    const others = input.suggestedMachines
      .slice(1)
      .map((machine) => machine.name)
      .join(", ");
    const extra = others ? ` Also fits: ${others}.` : "";
    return `${head} Designated stub machine: ${input.designatedMachine.name} (${dx} × ${dy} × ${dz} mm).${extra} Files are still exported — this is not a farm send.`;
  }
  return `${head} None of the stub alternate machines (K1 Max 300³, H2D 340×320×325, Prusa XL 360³) fit either. Files are still exported.`;
}
