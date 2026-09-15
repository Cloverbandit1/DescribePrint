import {
  convexHullFill,
  countConnectedComponents,
  countMaskCells,
  fillInteriorHoles,
  labelMaskComponents,
  maxDistanceToBackground,
  repairMask,
  subtractMask,
  type BinaryMask,
} from "./image-mask";
import type { ImageFragmentIdentify, ImageFragmentKind } from "./types";

const FRAGMENT_HINT =
  /\b(fragments?|broken(?:\s+(?:off|piece|part|bit))?|missing(?:\s+(?:chunk|piece|part|bit|volume))?|shards?|snapped|chipped(?:\s+off)?|piece of(?:\s+the)?)\b/i;

export function promptSuggestsFragment(text: string | null | undefined): boolean {
  return Boolean(text && FRAGMENT_HINT.test(text));
}

export function identifyFragment(mask: BinaryMask, prompt?: string | null): ImageFragmentIdentify {
  const components = countConnectedComponents(mask);
  const fragmentCells = countMaskCells(mask);
  const filled = fillInteriorHoles(mask);
  const hull = convexHullFill(filled);
  const hullCells = countMaskCells(hull);
  const filledCells = countMaskCells(filled);
  const missing = subtractMask(hull, filled);
  const missingParts = labelMaskComponents(missing);
  const largestMissing = missingParts.sizes.length ? Math.max(...missingParts.sizes) : 0;
  const largestMissingFrac = hullCells > 0 ? largestMissing / hullCells : 0;
  const solidity = hullCells > 0 ? filledCells / hullCells : 1;
  const maxDist = maxDistanceToBackground(filled);
  const equivR = Math.sqrt(Math.max(filledCells, 1) / Math.PI);
  const thicknessRatio = equivR > 0 ? maxDist / equivR : 0;
  const promptHint = promptSuggestsFragment(prompt);
  const joinedByClose =
    components.count >= 2 && countConnectedComponents(repairMask(mask)).count < components.count;

  let kind: ImageFragmentKind = "none";
  if (components.count >= 2) {
    kind = joinedByClose ? "crack" : "disconnected-pieces";
  } else if (largestMissingFrac >= 0.1 && solidity < 0.88 && thicknessRatio >= 0.32) {
    kind = "missing-chunk";
  } else if (promptHint && largestMissingFrac >= 0.04 && solidity < 0.94) {
    kind = "missing-chunk";
  }

  const looksLikeFragment = kind !== "none";
  const intendedWholeCells = looksLikeFragment ? Math.max(hullCells, fragmentCells) : fragmentCells;

  return {
    looksLikeFragment,
    kind,
    restoredMissingVolume: false,
    fragmentCells,
    intendedWholeCells,
    largestMissingFrac,
    solidity,
    note: fragmentNote({
      looksLikeFragment,
      kind,
      restoredMissingVolume: false,
      promptHint,
    }),
  };
}

export function restoreFragmentMask(mask: BinaryMask, fragment: ImageFragmentIdentify): BinaryMask {
  const closed = repairMask(mask);
  if (!fragment.looksLikeFragment) return closed;
  return convexHullFill(closed);
}

export function withRestoredFragment(
  fragment: ImageFragmentIdentify,
  restored: BinaryMask,
  applied: boolean,
): ImageFragmentIdentify {
  const intendedWholeCells = Math.max(fragment.intendedWholeCells, countMaskCells(restored));
  const restoredMissingVolume = applied && fragment.looksLikeFragment && intendedWholeCells > fragment.fragmentCells;
  return {
    ...fragment,
    intendedWholeCells,
    restoredMissingVolume,
    note: fragmentNote({
      looksLikeFragment: fragment.looksLikeFragment,
      kind: fragment.kind,
      restoredMissingVolume,
    }),
  };
}

export function fragmentNote(input: {
  looksLikeFragment: boolean;
  kind: ImageFragmentKind;
  restoredMissingVolume: boolean;
  promptHint?: boolean;
}): string {
  if (!input.looksLikeFragment) {
    return "Silhouette looks like a complete subject, not a broken fragment.";
  }
  const what =
    input.kind === "crack"
      ? "a cracked / split fragment (gap between pieces of the intended whole)"
      : input.kind === "disconnected-pieces"
        ? "disconnected pieces of a broken part, not a finished whole"
        : "a fragment with a missing chunk, not the intended whole";
  if (input.restoredMissingVolume) {
    return `Identified ${what}. Repair-by-default restored the missing volume. Say “keep the wear” to leave the fragment as photographed.`;
  }
  return `Identified ${what}. Keep damage / wear is on — the missing volume was left unrestored.`;
}

export function noneFragmentIdentify(): ImageFragmentIdentify {
  return {
    looksLikeFragment: false,
    kind: "none",
    restoredMissingVolume: false,
    fragmentCells: 0,
    intendedWholeCells: 0,
    largestMissingFrac: 0,
    solidity: 1,
    note: "Silhouette looks like a complete subject, not a broken fragment.",
  };
}
