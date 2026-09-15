import { describe, expect, it, vi } from "vitest";
import { resolveDesignOptions } from "@/lib/design-options";
import { STORMTROOPER_HELMET_PROMPT } from "@/lib/knowledge";
import {
  applyUserProfileToRequest,
  defaultUserProfile,
  formatUserProfileSummary,
  getServerUserProfile,
  getUserProfileSnapshot,
  hasCustomUserProfile,
  normalizeUserProfile,
  parseUserProfile,
  serializeUserProfile,
  sessionDefaultsFromProfile,
  upsertUserProfileAmsSlot,
  USER_PROFILE_NOTE,
  USER_PROFILE_STORAGE_KEY,
  writeUserProfile,
} from "@/lib/user-profile";

describe("user profile stub", () => {
  it("defaults to P2S + PLA with no saved wearable size or AMS labels", () => {
    const profile = defaultUserProfile();
    expect(profile).toEqual({
      version: 1,
      cloudAccount: false,
      printerId: "bambu-lab-p2s",
      wearableSize: null,
      wearableCategory: "helmet_mask",
      filament: "pla",
      partSizeHint: null,
      units: "mm",
      amsSlots: [],
    });
    expect(hasCustomUserProfile(profile)).toBe(false);
    expect(USER_PROFILE_STORAGE_KEY).toBe("describeprint.userProfile");
    expect(USER_PROFILE_NOTE).toMatch(/this device only/i);
    expect(USER_PROFILE_NOTE).toMatch(/not a cloud account/i);
  });

  it("round-trips saved sizes, filament, and AMS slot prefs", () => {
    const profile = normalizeUserProfile({
      wearableSize: "L",
      wearableCategory: "torso_armor",
      filament: "PETG",
      partSizeHint: 180,
      units: "mm",
      amsSlots: [
        { index: 0, label: "red PLA", material: "pla", colorHex: "#f00" },
        { index: 2, label: "black", material: "petg", color: "#111111" },
      ],
    });
    expect(profile.printerId).toBe("bambu-lab-p2s");
    expect(profile.cloudAccount).toBe(false);
    expect(profile.wearableSize).toBe("L");
    expect(profile.wearableCategory).toBe("torso_armor");
    expect(profile.filament).toBe("petg");
    expect(profile.partSizeHint).toBe(180);
    expect(profile.amsSlots).toEqual([
      { index: 0, label: "red PLA", material: "pla", colorHex: "#ff0000" },
      { index: 2, label: "black", material: "petg", colorHex: "#111111" },
    ]);
    expect(parseUserProfile(serializeUserProfile(profile))).toEqual(profile);
    expect(hasCustomUserProfile(profile)).toBe(true);
    expect(formatUserProfileSummary(profile)).toMatch(/L \(Large\)/);
    expect(formatUserProfileSummary(profile)).toMatch(/PETG/);
    expect(formatUserProfileSummary(profile)).toMatch(/AMS red PLA\/black/);
  });

  it("drops junk, unknown printers, duplicate trays, and invalid JSON", () => {
    expect(parseUserProfile(null)).toEqual(defaultUserProfile());
    expect(parseUserProfile("not-json")).toEqual(defaultUserProfile());
    expect(
      normalizeUserProfile({
        printerId: "prusa-xl",
        wearableSize: "tiny",
        wearableCategory: "hat",
        filament: "woodfill",
        partSizeHint: -4,
        units: "cubits",
        amsSlots: [
          { index: 9, label: "nope" },
          { index: 1, label: "accent" },
          { index: 1, label: "duplicate" },
          { index: 0 },
          "nope",
        ],
      }),
    ).toEqual({
      ...defaultUserProfile(),
      amsSlots: [{ index: 1, label: "accent" }],
    });
  });

  it("treats native / empty size as unset and upserts AMS prefs without inventing empty trays", () => {
    expect(normalizeUserProfile({ wearableSize: "native" }).wearableSize).toBeNull();
    expect(normalizeUserProfile({ wearableSize: "" }).wearableSize).toBeNull();
    const cleared = upsertUserProfileAmsSlot(
      normalizeUserProfile({ amsSlots: [{ index: 0, label: "body", material: "pla" }] }),
      { index: 0, label: "" },
    );
    expect(cleared.amsSlots).toEqual([]);
    const added = upsertUserProfileAmsSlot(defaultUserProfile(), {
      index: 3,
      label: "flex",
      material: "tpu",
    });
    expect(added.amsSlots).toEqual([{ index: 3, label: "flex", material: "tpu" }]);
  });

  it("fills unset generate / options fields and never overrides an explicit request", () => {
    const profile = normalizeUserProfile({
      wearableSize: "XL",
      wearableCategory: "gauntlet",
      filament: "pa",
      partSizeHint: 90,
      units: "in",
    });
    expect(applyUserProfileToRequest({ prompt: "helmet" }, profile)).toMatchObject({
      prompt: "helmet",
      wearableSize: "XL",
      wearableCategory: "gauntlet",
      filament: "pa",
      sizeHint: 90,
      units: "in",
    });
    expect(
      applyUserProfileToRequest(
        { wearableSize: "S", wearableCategory: "bracer", filament: "tpu", sizeHint: 40, units: "mm" },
        profile,
      ),
    ).toMatchObject({
      wearableSize: "S",
      wearableCategory: "bracer",
      filament: "tpu",
      sizeHint: 40,
      units: "mm",
    });
    expect(applyUserProfileToRequest({ wearableSize: null, sizeHint: null }, profile)).toMatchObject({
      wearableSize: null,
      sizeHint: null,
      filament: "pa",
    });
    expect(sessionDefaultsFromProfile(profile)).toEqual({
      wearableSize: "XL",
      wearableCategory: "gauntlet",
      filament: "pa",
      sizeHint: "90",
      units: "in",
    });
  });

  it("applies a saved size / filament so mid-design chips do not re-ask", () => {
    const profile = normalizeUserProfile({ wearableSize: "L", filament: "petg" });
    const seeded = applyUserProfileToRequest(
      { prompt: "wearable stormtrooper helmet" },
      profile,
    );
    const resolved = resolveDesignOptions({
      prompt: seeded.prompt,
      wearableSize: seeded.wearableSize,
      filament: seeded.filament,
    });
    expect(resolved.options.map((group) => group.id)).toEqual([]);
    expect(resolved.needs_user_choice).toBe(false);

    expect(
      resolveDesignOptions({
        prompt: STORMTROOPER_HELMET_PROMPT,
        choices: [{ id: "scale_mode", value: "wearable" }],
        wearableSize: profile.wearableSize,
      }).options.map((group) => group.id),
    ).toEqual([]);

    expect(
      resolveDesignOptions({
        prompt: "which material should I use for this clip?",
        filament: profile.filament,
      }).needs_user_choice,
    ).toBe(false);
  });

  it("keeps the server snapshot identity-stable for useSyncExternalStore", () => {
    expect(getServerUserProfile()).toBe(getServerUserProfile());
    expect(getServerUserProfile()).toEqual(defaultUserProfile());
  });

  it("caches a localStorage snapshot until the profile is rewritten", () => {
    const store = new Map<string, string>();
    const localStorage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
    };
    vi.stubGlobal("window", { localStorage });
    const saved = writeUserProfile(
      normalizeUserProfile({ wearableSize: "XL", filament: "abs", amsSlots: [{ index: 1, label: "accent" }] }),
    );
    expect(store.get(USER_PROFILE_STORAGE_KEY)).toBe(serializeUserProfile(saved));
    expect(getUserProfileSnapshot()).toBe(saved);
    expect(getUserProfileSnapshot()).toEqual(saved);
    vi.unstubAllGlobals();
  });
});
