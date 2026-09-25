import { deriveVideoRenditionGeometry, type VideoRenditionGeometry } from "@pixel-point/aval-format";
import { describe, expect, it } from "vitest";

import { composeVideoSurfaceRgba16 } from "../src/compile/video-surface-rgba16.js";

function pixel(
  rgba: Uint16Array,
  width: number,
  x: number,
  y: number
): number[] {
  const offset = (y * width + x) * 4;
  return [...rgba.subarray(offset, offset + 4)];
}

describe("canonical RGBA16 encoded surface", () => {
  it("composes a horizontal mask directly with the same color dilation and neutral padding", () => {
    const geometry: VideoRenditionGeometry = {
      ...deriveVideoRenditionGeometry({ canvasWidth: 3, canvasHeight: 1, visibleWidth: 3, visibleHeight: 1,
        layout: "packed-alpha", storage: { widthAlignment: 2, heightAlignment: 2 } }),
      codedWidth: 16, codedHeight: 2, decodedStorageRect: [0, 0, 16, 2], visibleAlphaRect: [12, 0, 3, 1],
      codedRgbaBytes: 128, decodedRgbaBytes: 128
    };
    const source = Uint16Array.of(60_000, 1_000, 2_000, 65_535, 9_000, 8_000, 7_000, 0, 3_000, 4_000, 50_000, 32_768);
    const surface = composeVideoSurfaceRgba16(source, geometry);
    expect(pixel(surface, 16, 1, 0)).toEqual([60_000, 1_000, 2_000, 65_535]);
    expect(pixel(surface, 16, 12, 0)).toEqual([65_535, 65_535, 65_535, 65_535]);
    expect(pixel(surface, 16, 13, 0)).toEqual([0, 0, 0, 65_535]);
    expect(pixel(surface, 16, 14, 0)).toEqual([32_768, 32_768, 32_768, 65_535]);
    expect(pixel(surface, 16, 4, 0)).toEqual([0, 0, 0, 65_535]);
    expect(() => composeVideoSurfaceRgba16(source, { ...geometry, visibleAlphaRect: [10, 0, 3, 1] })).toThrow();
  });

  it("composes packed color, neutral gutter/padding, and full-precision alpha", () => {
    const geometry = deriveVideoRenditionGeometry({
      canvasWidth: 3,
      canvasHeight: 1,
      layout: "packed-alpha",
      visibleWidth: 3,
      visibleHeight: 1,
      storage: { widthAlignment: 4, heightAlignment: 2 }
    });
    const source = Uint16Array.of(
      60_000, 1_000, 2_000, 65_535,
      9_000, 8_000, 7_000, 0,
      3_000, 4_000, 50_000, 32_768
    );
    const surface = composeVideoSurfaceRgba16(source, geometry);

    expect(pixel(surface, geometry.codedWidth, 0, 0))
      .toEqual([60_000, 1_000, 2_000, 65_535]);
    expect(pixel(surface, geometry.codedWidth, 1, 0))
      .toEqual([60_000, 1_000, 2_000, 65_535]);
    expect(pixel(surface, geometry.codedWidth, 2, 0))
      .toEqual([3_000, 4_000, 50_000, 65_535]);
    expect(pixel(surface, geometry.codedWidth, 3, 0))
      .toEqual([0, 0, 0, 65_535]);

    const alphaY = geometry.visibleAlphaRect![1];
    expect(pixel(surface, geometry.codedWidth, 0, alphaY))
      .toEqual([65_535, 65_535, 65_535, 65_535]);
    expect(pixel(surface, geometry.codedWidth, 1, alphaY))
      .toEqual([0, 0, 0, 65_535]);
    expect(pixel(surface, geometry.codedWidth, 2, alphaY))
      .toEqual([32_768, 32_768, 32_768, 65_535]);
    expect(pixel(surface, geometry.codedWidth, 0, 2))
      .toEqual([0, 0, 0, 65_535]);
    expect(surface).toHaveLength(
      geometry.codedWidth * geometry.codedHeight * 4
    );
  });

  it("preserves opaque source channels without mutating the input", () => {
    const geometry = deriveVideoRenditionGeometry({
      canvasWidth: 2,
      canvasHeight: 2,
      layout: "opaque",
      visibleWidth: 2,
      visibleHeight: 2,
      storage: { widthAlignment: 2, heightAlignment: 2 }
    });
    const source = Uint16Array.from({ length: 16 }, (_, index) => index * 3_001);
    const before = source.slice();
    const surface = composeVideoSurfaceRgba16(source, geometry);

    expect(source).toEqual(before);
    for (let pixelIndex = 0; pixelIndex < 4; pixelIndex += 1) {
      expect([...surface.subarray(pixelIndex * 4, pixelIndex * 4 + 3)])
        .toEqual([...source.subarray(pixelIndex * 4, pixelIndex * 4 + 3)]);
      expect(surface[pixelIndex * 4 + 3]).toBe(65_535);
    }
  });

  it("rejects malformed geometry and source cardinality", () => {
    const geometry = deriveVideoRenditionGeometry({
      canvasWidth: 2,
      canvasHeight: 2,
      layout: "opaque",
      visibleWidth: 2,
      visibleHeight: 2,
      storage: { widthAlignment: 2, heightAlignment: 2 }
    });
    expect(() => composeVideoSurfaceRgba16(new Uint16Array(15), geometry))
      .toThrow(/length/u);
    expect(() => composeVideoSurfaceRgba16(new Uint16Array(16), {
      ...geometry,
      codedWidth: 1
    })).toThrow();
  });
});
