import { describe, expect, it } from "vitest";

import { validateExampleAssets } from "../validate-example-assets.mjs";

describe("checked-in browser example assets", () => {
  it("match their reports, source markup, graphs, and wire/output profiles", async () => {
    await expect(validateExampleAssets()).resolves.toEqual({
      assetsInspected: 16,
      bundlesValidated: [
        "grass-rabbit",
        "grass-rabbit-codecs",
        "kinetic-orb",
        "end-user-playground"
      ],
      wireAssetsValidated: 16,
      packedWitnessesValidated: 4,
      staticSourcePagesValidated: [
        "grass-rabbit",
        "kinetic-orb",
        "end-user-playground"
      ],
      dynamicSourcePagesValidated: ["grass-rabbit-codecs"]
    });
  }, 120_000);
});
