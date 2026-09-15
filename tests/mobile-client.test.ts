import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { IMAGE_IMPORT_ACCEPT } from "@/lib/image-import";
import {
  ANY_FILE_PICKER_ACCEPT,
  IPHONE_VIEWPORT_WIDTH_PX,
  MOBILE_PLATE_MAX_VH,
  MOBILE_PLATE_MIN_PX,
  NARROW_LAYOUT_MAX_PX,
  PHOTO_PICKER_ACCEPT,
  TOUCH_TARGET_MIN_PX,
  filePickerAttrs,
  isNarrowViewportWidth,
  nextViewerZoomFactor,
  viewerTouchMode,
} from "@/lib/mobile-client";

describe("mobile client helpers", () => {
  it("treats iPhone-width 390 as a narrow chat-first viewport", () => {
    expect(IPHONE_VIEWPORT_WIDTH_PX).toBe(390);
    expect(isNarrowViewportWidth(IPHONE_VIEWPORT_WIDTH_PX)).toBe(true);
    expect(isNarrowViewportWidth(NARROW_LAYOUT_MAX_PX)).toBe(true);
    expect(isNarrowViewportWidth(1024)).toBe(false);
    expect(isNarrowViewportWidth(0)).toBe(false);
  });

  it("keeps a compact plate so chat is not hidden behind the preview", () => {
    expect(MOBILE_PLATE_MIN_PX).toBeGreaterThanOrEqual(TOUCH_TARGET_MIN_PX * 3);
    expect(MOBILE_PLATE_MAX_VH).toBeLessThanOrEqual(40);
    expect(TOUCH_TARGET_MIN_PX).toBe(44);
  });

  it("builds camera-roll and rear-camera pickers without rewriting import accept", () => {
    expect(filePickerAttrs("any")).toEqual({ accept: ANY_FILE_PICKER_ACCEPT });
    expect(ANY_FILE_PICKER_ACCEPT).toBe(IMAGE_IMPORT_ACCEPT);
    expect(filePickerAttrs("photo")).toEqual({ accept: PHOTO_PICKER_ACCEPT });
    expect(filePickerAttrs("photo").accept).toBe("image/*");
    expect(filePickerAttrs("photo").capture).toBeUndefined();
    expect(filePickerAttrs("camera")).toEqual({
      accept: "image/*",
      capture: "environment",
    });
    expect(IMAGE_IMPORT_ACCEPT).toMatch(/\.stl/);
    expect(IMAGE_IMPORT_ACCEPT).toMatch(/image\/jpeg/);
  });

  it("enables orbit + pinch (two-finger dolly) only on the touch viewer", () => {
    expect(viewerTouchMode(false)).toMatchObject({
      enableRotate: true,
      enableZoom: true,
      enablePan: false,
      oneFinger: "rotate",
      twoFinger: "dolly-pan",
    });
    expect(viewerTouchMode(true)).toMatchObject({
      enableRotate: true,
      enableZoom: true,
      enablePan: true,
      oneFinger: "rotate",
      twoFinger: "dolly-pan",
    });
  });

  it("steps simplified zoom buttons without flipping the camera", () => {
    expect(nextViewerZoomFactor(1, "in")).toBeLessThan(1);
    expect(nextViewerZoomFactor(1, "out")).toBeGreaterThan(1);
    expect(nextViewerZoomFactor(0.35, "in")).toBe(0.35);
    expect(nextViewerZoomFactor(3, "out")).toBe(3);
  });
});

describe("phone client wiring (responsive web only)", () => {
  it("keeps Prepare chat first-class in CSS and does not change the lg desktop grid", () => {
    const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
    expect(css).toContain('.studio-workspace[data-tab="prepare"]');
    expect(css).toContain("minmax(160px, 32vh) minmax(0, 1fr)");
    expect(css).toContain("min-height: 44px");
    expect(css).toContain("touch-action: none");
    expect(css).toContain("@media (min-width: 1024px)");
    expect(css).toContain(".studio-mobile-only");
  });

  it("adds photo/camera pickers without rewriting the library/remix path", () => {
    const app = readFileSync(new URL("../components/DescribePrintApp.tsx", import.meta.url), "utf8");
    expect(app).toContain('kind="photo"');
    expect(app).toContain('kind="camera"');
    expect(app).toContain("studio-workspace");
    expect(app).toContain("touchFriendly={!wideLayout}");
    expect(app).not.toMatch(/part-library/);
    expect(app).not.toMatch(/failure-photo|pwa|manifest\.webmanifest/i);
  });
});
