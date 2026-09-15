import { IMAGE_IMPORT_ACCEPT } from "./image-import";

/** Matches the existing `lg:` / `wideLayout` breakpoint (Prepare | Preview collapse). */
export const NARROW_LAYOUT_MAX_PX = 1023;
export const NARROW_LAYOUT_QUERY = `(max-width: ${NARROW_LAYOUT_MAX_PX}px)`;
export const WIDE_LAYOUT_QUERY = "(min-width: 1024px)";

/** Apple HIG / WCAG 2.2 minimum target for thumb taps. */
export const TOUCH_TARGET_MIN_PX = 44;

/** Compact plate strip on Prepare so chat + composer stay first-class. */
export const MOBILE_PLATE_MIN_PX = 160;
export const MOBILE_PLATE_MAX_VH = 32;

/** iPhone 14/15 logical width — used in docs and layout tests. */
export const IPHONE_VIEWPORT_WIDTH_PX = 390;

/** Camera-roll / photo-library picker. No `capture` so iOS offers the library. */
export const PHOTO_PICKER_ACCEPT = "image/*";

export type FilePickerKind = "any" | "photo" | "camera";

export type FilePickerAttrs = {
  accept: string;
  capture?: "environment";
};

/**
 * Mobile-friendly file input attributes.
 *
 * - `any`: existing STL / 3MF / photo import (desktop + Import file).
 * - `photo`: camera roll / photo library (`accept="image/*"`, no capture).
 * - `camera`: rear-camera capture hint (`capture="environment"`).
 */
export function filePickerAttrs(kind: FilePickerKind): FilePickerAttrs {
  if (kind === "camera") {
    return { accept: PHOTO_PICKER_ACCEPT, capture: "environment" };
  }
  if (kind === "photo") {
    return { accept: PHOTO_PICKER_ACCEPT };
  }
  return { accept: IMAGE_IMPORT_ACCEPT };
}

export type ViewerTouchMode = {
  enableRotate: boolean;
  enableZoom: boolean;
  enablePan: boolean;
  enableDamping: boolean;
  oneFinger: "rotate";
  twoFinger: "dolly-pan";
};

/** Orbit + pinch (two-finger dolly/pan). Desktop keeps rotate/zoom; pan stays off. */
export function viewerTouchMode(touchFriendly: boolean): ViewerTouchMode {
  return {
    enableRotate: true,
    enableZoom: true,
    enablePan: touchFriendly,
    enableDamping: true,
    oneFinger: "rotate",
    twoFinger: "dolly-pan",
  };
}

const ZOOM_STEP = 1.2;
const ZOOM_MIN = 0.35;
const ZOOM_MAX = 3;

/** Multiplier on the camera distance from the orbit target. 1 = default. */
export function nextViewerZoomFactor(current: number, direction: "in" | "out"): number {
  const next = direction === "in" ? current / ZOOM_STEP : current * ZOOM_STEP;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Number(next.toFixed(4))));
}

export function isNarrowViewportWidth(widthPx: number): boolean {
  return Number.isFinite(widthPx) && widthPx > 0 && widthPx <= NARROW_LAYOUT_MAX_PX;
}
