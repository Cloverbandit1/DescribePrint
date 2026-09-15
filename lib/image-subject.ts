import { countMaskCells, type BinaryMask } from "./image-mask";
import type { ImageFragmentIdentify, ImageSubjectClass, ImageSubjectIdentify, ImageSubjectSource } from "./types";

const HEAD_CHAT =
  /\b(heads?|faces?|mugshots?|portraits?|selfies?|headshot|complete(?:\s+the)?\s+body|match(?:\s+this)?\s+head|matching\s+(?:body|torso)|add(?:\s+a)?\s+(?:torso|body)|finish(?:\s+the)?\s+(?:figure|body)|full(?:\s+)?figure)\b/i;
const HELMET_CHAT = /\b(helmets?|helms?|visors?)\b/i;
const BUST_CHAT = /\b(busts?|shoulders?|torso\s+from\s+(?:this\s+)?(?:head|photo)|statue\s+bust)\b/i;
const COMPLETE_CHAT =
  /\b(complete(?:\s+the)?\s+body|match(?:\s+this)?\s+head|matching\s+(?:body|torso)|add(?:\s+a)?\s+(?:torso|body)|finish(?:\s+the)?\s+(?:figure|body)|full(?:\s+)?figure|complete(?:\s+this)?\s+(?:partial|bust|head|helmet))\b/i;

const HEAD_FILE = /\b(heads?|faces?|mugshots?|portraits?|selfies?|headshots?)\b/i;
const HELMET_FILE = /\b(helmets?|helms?|visors?)\b/i;
const BUST_FILE = /\b(busts?|shoulders)\b/i;
const GENERIC_FILE = /\b(mugs?|cups?|plates?|brackets?|disks?|shards?|wedges?)\b/i;

export type SubjectMaskFeatures = {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  width: number;
  height: number;
  aspect: number;
  circularity: number;
  solidity: number;
  topWidth: number;
  midWidth: number;
  botWidth: number;
  neckTaper: number;
  shoulderFlare: number;
  occupancyY: number;
  topBias: number;
  symmetry: number;
  fillOfBbox: number;
};

export function promptSuggestsCompleteBody(text: string | null | undefined): boolean {
  return Boolean(text && COMPLETE_CHAT.test(text));
}

export function promptSuggestsHead(text: string | null | undefined): boolean {
  return Boolean(text && HEAD_CHAT.test(text));
}

export function noneSubjectIdentify(): ImageSubjectIdentify {
  return {
    class: "none",
    confidence: 0,
    source: "heuristic",
    note: "Silhouette does not look like a head, helmet, or bust partial.",
  };
}

export function maskSubjectBBox(mask: BinaryMask): { minX: number; maxX: number; minY: number; maxY: number } | null {
  let minX = mask.width;
  let maxX = -1;
  let minY = mask.height;
  let maxY = -1;
  for (let y = 0; y < mask.height; y++) {
    for (let x = 0; x < mask.width; x++) {
      if (!mask.cells[y * mask.width + x]) continue;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }
  if (maxX < minX || maxY < minY) return null;
  return { minX, maxX, minY, maxY };
}

export function measureSubjectFeatures(mask: BinaryMask): SubjectMaskFeatures | null {
  const box = maskSubjectBBox(mask);
  if (!box) return null;
  const width = box.maxX - box.minX + 1;
  const height = box.maxY - box.minY + 1;
  const area = countMaskCells(mask);
  const perimeter = countPerimeterCells(mask);
  const circularity = perimeter > 0 ? (4 * Math.PI * area) / (perimeter * perimeter) : 0;
  const bboxArea = Math.max(1, width * height);
  const topWidth = bandWidth(mask, box, 0, 0.33);
  const midWidth = bandWidth(mask, box, 0.33, 0.66);
  const botWidth = bandWidth(mask, box, 0.66, 1);
  const left = countSide(mask, box, "left");
  const right = countSide(mask, box, "right");
  const sideTotal = Math.max(1, left + right);
  return {
    minX: box.minX,
    maxX: box.maxX,
    minY: box.minY,
    maxY: box.maxY,
    width,
    height,
    aspect: width > 0 ? height / width : 0,
    circularity,
    solidity: bboxArea > 0 ? area / bboxArea : 0,
    topWidth,
    midWidth,
    botWidth,
    neckTaper: botWidth > 0 ? midWidth / botWidth : 1,
    shoulderFlare: midWidth > 0 ? botWidth / midWidth : 1,
    occupancyY: mask.height > 0 ? height / mask.height : 0,
    topBias: mask.height > 0 ? 1 - (box.minY + box.maxY) / 2 / mask.height : 0.5,
    symmetry: 1 - Math.abs(left - right) / sideTotal,
    fillOfBbox: area / bboxArea,
  };
}

export function identifyPartialSubject(
  mask: BinaryMask,
  opts?: { prompt?: string | null; fileName?: string | null; fragment?: ImageFragmentIdentify | null },
): ImageSubjectIdentify {
  const prompt = opts?.prompt ?? "";
  const fileName = tokenizeName(opts?.fileName ?? "");
  const features = measureSubjectFeatures(mask);
  const chatClass = classFromText(prompt, "chat");
  const fileClass = classFromText(fileName, "filename");
  const heuristic = features ? classFromFeatures(features, opts?.fragment) : noneSubjectIdentify();
  if (
    fileClass === "none" &&
    GENERIC_FILE.test(fileName) &&
    !promptSuggestsCompleteBody(prompt) &&
    !chatClass
  ) {
    if (opts?.fragment?.looksLikeFragment) {
      return {
        class: "fragment",
        confidence: 0.7,
        source: "filename",
        note: "File name looks like a generic object; fragment identify still applies.",
      };
    }
    return noneSubjectIdentify();
  }

  let next: ImageSubjectIdentify = heuristic;
  let source: ImageSubjectSource = "heuristic";

  if (fileClass && fileClass !== "none") {
    next = {
      class: fileClass,
      confidence: Math.max(heuristic.confidence, 0.72),
      source: "filename",
      note: subjectNote(fileClass, "filename"),
    };
    source = heuristic.class !== "none" && heuristic.class !== fileClass ? "mixed" : "filename";
  }
  if (chatClass && chatClass !== "none") {
    const preferChat = chatClass !== "none";
    if (preferChat) {
      next = {
        class: chatClass === "none" ? next.class : chatClass,
        confidence: Math.max(next.confidence, 0.8),
        source: "chat",
        note: subjectNote(chatClass, "chat"),
      };
      source = next.source === "heuristic" || next.source === "filename" ? "mixed" : "chat";
      if (fileClass && fileClass !== chatClass && fileClass !== "none") source = "mixed";
    }
  }
  if (promptSuggestsCompleteBody(prompt) && next.class === "none") {
    next = {
      class: "head",
      confidence: 0.64,
      source: "chat",
      note: "Chat asked to complete a matching body — treating the subject as a head partial.",
    };
    source = "chat";
  }
  if (opts?.fragment?.looksLikeFragment && next.class === "none") {
    next = {
      class: "fragment",
      confidence: 0.7,
      source: "heuristic",
      note: "Silhouette looks like a broken fragment, not a head/helmet/bust to complete.",
    };
  }

  return { ...next, source: source === "heuristic" ? next.source : source };
}

export function shouldCompletePartial(
  subject: ImageSubjectIdentify,
  opts?: { prompt?: string | null; fragment?: ImageFragmentIdentify | null },
): boolean {
  if (promptSuggestsCompleteBody(opts?.prompt)) return true;
  if (opts?.fragment?.looksLikeFragment && subject.source === "heuristic" && subject.confidence < 0.75) {
    return false;
  }
  if (subject.class === "head" || subject.class === "helmet" || subject.class === "bust") {
    return subject.confidence >= 0.55;
  }
  return false;
}

function classFromText(text: string, source: "chat" | "filename"): ImageSubjectClass | null {
  if (!text) return null;
  if (source === "filename") {
    const tokens = tokenizeName(text);
    if (GENERIC_FILE.test(tokens)) return "none";
    if (HELMET_FILE.test(tokens)) return "helmet";
    if (BUST_FILE.test(tokens)) return "bust";
    if (HEAD_FILE.test(tokens)) return "head";
    return null;
  }
  if (HELMET_CHAT.test(text) && !promptSuggestsCompleteBody(text)) return "helmet";
  if (BUST_CHAT.test(text) && !/\bcomplete(?:\s+the)?\s+body\b/i.test(text)) return "bust";
  if (HEAD_CHAT.test(text)) return "head";
  if (HELMET_CHAT.test(text)) return "helmet";
  return null;
}

function classFromFeatures(features: SubjectMaskFeatures, fragment?: ImageFragmentIdentify | null): ImageSubjectIdentify {
  const headScore = scoreHead(features);
  const helmetScore = scoreHelmet(features);
  const bustScore = scoreBust(features);

  if (bustScore >= 0.58 && bustScore >= headScore && bustScore >= helmetScore) {
    return {
      class: "bust",
      confidence: clamp01(bustScore),
      source: "heuristic",
      note: "Silhouette looks like a bust / head-and-shoulders partial.",
    };
  }
  if (helmetScore >= 0.6 && helmetScore > headScore + 0.04) {
    return {
      class: "helmet",
      confidence: clamp01(helmetScore),
      source: "heuristic",
      note: "Silhouette looks like a helmet / helm partial.",
    };
  }
  if (headScore >= 0.58) {
    return {
      class: "head",
      confidence: clamp01(headScore),
      source: "heuristic",
      note: "Silhouette looks like a head / mugshot partial.",
    };
  }
  if (fragment?.looksLikeFragment) {
    return {
      class: "fragment",
      confidence: 0.7,
      source: "heuristic",
      note: "Silhouette looks like a broken fragment, not a head/helmet/bust to complete.",
    };
  }
  return noneSubjectIdentify();
}

function scoreHead(f: SubjectMaskFeatures): number {
  let score = 0;
  if (f.circularity >= 0.48 && f.circularity <= 1.15) score += 0.28;
  else if (f.circularity >= 0.36) score += 0.12;
  if (f.aspect >= 0.85 && f.aspect <= 1.75) score += 0.22;
  else if (f.aspect >= 0.7 && f.aspect <= 2.0) score += 0.08;
  if (f.symmetry >= 0.72) score += 0.2;
  else if (f.symmetry >= 0.6) score += 0.06;
  if (f.neckTaper >= 1.06 && f.shoulderFlare < 1.32) score += 0.16;
  const mugshotCrop = f.occupancyY <= 0.78 && f.topBias >= 0.52;
  const hasNeck = f.neckTaper >= 1.08;
  if (mugshotCrop) score += 0.14;
  if (f.fillOfBbox >= 0.55 && f.fillOfBbox <= 0.92) score += 0.08;
  if (f.symmetry < 0.58) score -= 0.28;
  if (f.shoulderFlare >= 1.45) score -= 0.12;
  if (f.occupancyY >= 0.8 && f.neckTaper < 1.05 && f.topBias < 0.55) score -= 0.25;
  if (!hasNeck && !mugshotCrop) score -= 0.36;
  return score;
}

function scoreHelmet(f: SubjectMaskFeatures): number {
  let score = scoreHead(f) * 0.72;
  if (f.topWidth >= f.midWidth * 1.06) score += 0.18;
  if (f.aspect >= 0.7 && f.aspect <= 1.35) score += 0.1;
  if (f.symmetry < 0.6) score -= 0.2;
  return score;
}

function scoreBust(f: SubjectMaskFeatures): number {
  let score = 0;
  if (f.shoulderFlare >= 1.32) score += 0.34;
  if (f.aspect >= 1.0 && f.aspect <= 2.35) score += 0.2;
  if (f.symmetry >= 0.68) score += 0.18;
  if (f.topWidth > 0 && f.botWidth / f.topWidth >= 1.25) score += 0.16;
  if (f.circularity >= 0.28) score += 0.08;
  if (f.symmetry < 0.58) score -= 0.24;
  return score;
}

function subjectNote(cls: ImageSubjectClass, source: "chat" | "filename"): string {
  const via = source === "chat" ? "chat" : "the file name";
  if (cls === "helmet") return `Identified a helmet / helm partial from ${via}.`;
  if (cls === "bust") return `Identified a bust / shoulders partial from ${via}.`;
  if (cls === "head") return `Identified a head / mugshot partial from ${via}.`;
  if (cls === "fragment") return `Identified a fragment from ${via}.`;
  return `No completeable partial from ${via}.`;
}

function bandWidth(
  mask: BinaryMask,
  box: { minX: number; maxX: number; minY: number; maxY: number },
  t0: number,
  t1: number,
): number {
  const y0 = box.minY + Math.floor((box.maxY - box.minY) * t0);
  const y1 = box.minY + Math.max(y0, Math.ceil((box.maxY - box.minY) * t1));
  let maxSpan = 0;
  for (let y = y0; y <= Math.min(box.maxY, y1); y++) {
    let minX = mask.width;
    let maxX = -1;
    for (let x = box.minX; x <= box.maxX; x++) {
      if (!mask.cells[y * mask.width + x]) continue;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
    }
    if (maxX >= minX) maxSpan = Math.max(maxSpan, maxX - minX + 1);
  }
  return maxSpan;
}

function countSide(mask: BinaryMask, box: { minX: number; maxX: number; minY: number; maxY: number }, side: "left" | "right"): number {
  const mid = (box.minX + box.maxX) / 2;
  let n = 0;
  for (let y = box.minY; y <= box.maxY; y++) {
    for (let x = box.minX; x <= box.maxX; x++) {
      if (!mask.cells[y * mask.width + x]) continue;
      if (side === "left" ? x <= mid : x >= mid) n++;
    }
  }
  return n;
}

function countPerimeterCells(mask: BinaryMask): number {
  let n = 0;
  for (let y = 0; y < mask.height; y++) {
    for (let x = 0; x < mask.width; x++) {
      if (!mask.cells[y * mask.width + x]) continue;
      const edge =
        !at(mask, x - 1, y) || !at(mask, x + 1, y) || !at(mask, x, y - 1) || !at(mask, x, y + 1);
      if (edge) n++;
    }
  }
  return n;
}

function at(mask: BinaryMask, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= mask.width || y >= mask.height) return false;
  return mask.cells[y * mask.width + x] === 1;
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

function tokenizeName(value: string): string {
  return value.replace(/[_\-.]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2");
}
