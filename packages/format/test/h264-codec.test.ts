import { describe, expect, it } from "vitest";

import {
  h264CodecForProfileLevel,
  minimumH264CompatibilityLevel,
  parseH264Codec
} from "../src/h264/index.js";

describe("H264 compatibility codec policy", () => {
  it.each([
    [48, 112, 30, 1, 11, "avc1.42E00B"],
    [512, 512, 24, 1, 30, "avc1.42E01E"],
    [640, 368, 24, 1, 30, "avc1.42E01E"],
    [1_280, 720, 24, 1, 31, "avc1.42E01F"]
  ] as const)(
    "selects the minimum practical level for %ix%i at %i/%i",
    (codedWidth, codedHeight, numerator, denominator, levelIdc, codec) => {
      const selected = minimumH264CompatibilityLevel({
        codedWidth,
        codedHeight,
        frameRate: { numerator, denominator },
        maximumBitrate: 192_000,
        maximumCpbBits: 500_000
      });

      expect(selected).toBe(levelIdc);
      expect(h264CodecForProfileLevel("constrained-baseline", selected))
        .toBe(codec);
    }
  );

  it("keeps legacy High codecs readable while identifying their profile", () => {
    expect(parseH264Codec("avc1.42E01F")).toMatchObject({
      codec: "avc1.42E01F",
      profile: "constrained-baseline",
      profileIdc: 66,
      profileCompatibility: 0xe0,
      levelIdc: 31,
      maximumBitrate: 14_000_000,
      maximumCpbBits: 14_000_000
    });
    expect(parseH264Codec("avc1.64001F")).toMatchObject({
      codec: "avc1.64001F",
      profile: "high",
      profileIdc: 100,
      profileCompatibility: 0,
      levelIdc: 31,
      maximumBitrate: 17_500_000,
      maximumCpbBits: 17_500_000
    });
  });

  it("applies High-profile MaxBR and CPB scaling without changing Baseline limits", () => {
    expect(parseH264Codec("avc1.42E028")).toMatchObject({
      maximumBitrate: 20_000_000,
      maximumCpbBits: 25_000_000
    });
    expect(parseH264Codec("avc1.640028")).toMatchObject({
      maximumBitrate: 25_000_000,
      maximumCpbBits: 31_250_000
    });
  });

  it("uses exact rational macroblock-rate comparisons and rejects invalid geometry", () => {
    expect(minimumH264CompatibilityLevel({
      codedWidth: 640,
      codedHeight: 368,
      frameRate: { numerator: 24_000, denominator: 1_001 },
      maximumBitrate: 192_000,
      maximumCpbBits: 500_000
    })).toBe(30);
    expect(() => minimumH264CompatibilityLevel({
      codedWidth: 641,
      codedHeight: 368,
      frameRate: { numerator: 24, denominator: 1 },
      maximumBitrate: 192_000,
      maximumCpbBits: 500_000
    })).toThrow();
  });

  it("includes configured MaxBR and CPB bits in minimum-level selection", () => {
    const tiny = {
      codedWidth: 48,
      codedHeight: 112,
      frameRate: { numerator: 30, denominator: 1 }
    } as const;
    expect(minimumH264CompatibilityLevel({
      ...tiny,
      maximumBitrate: 192_001,
      maximumCpbBits: 500_000
    })).toBe(12);
    expect(minimumH264CompatibilityLevel({
      ...tiny,
      maximumBitrate: 192_000,
      maximumCpbBits: 500_001
    })).toBe(12);
    expect(() => minimumH264CompatibilityLevel({
      ...tiny,
      maximumBitrate: 800_000_001,
      maximumCpbBits: 800_000_001
    })).toThrow();
  });
});
