import { describe, expect, it } from "vitest";

import type { PackedAlphaWitnessV1 } from "@pixel-point/aval-format";
import {
  DecodedOutputIncompatibleError,
  qualifyDecodedPackedAlphaOutput
} from "../src/decoded-output-qualifier.js";
import type {
  MaterializedRgbaFrame,
  MaterializedRgbaFrameReference
} from "../src/rgba-materializer.js";
import { deriveRenderLayout } from "../src/renderer-geometry.js";

const layout = deriveRenderLayout({
  codedWidth: 4,
  codedHeight: 12,
  logicalWidth: 2,
  logicalHeight: 2,
  pixelAspect: [1, 1],
  colorRect: [0, 0, 2, 2],
  alphaRect: [0, 10, 2, 2]
});

describe("decoded packed-alpha output qualification", () => {
  it("accepts inclusive interval endpoints through the canonical alpha offset", () => {
    const source = materializedReference([32, 95, 64]);

    qualifyDecodedPackedAlphaOutput({
      unit: "bootstrap",
      localFrame: 2,
      layout,
      witness: witness([
        { x: 0, y: 0, expectedRange: [32, 64] },
        { x: 1, y: 0, expectedRange: [95, 95] },
        { x: 0, y: 1, expectedRange: [64, 96] }
      ]),
      source
    });
  });

  it.each([
    [31, "below"],
    [65, "above"]
  ])("rejects a sample %s the authored interval", (red) => {
    const source = materializedReference([0, 0, 0, 0, 0, 0, 0, 0, red]);

    expect(() => qualifyDecodedPackedAlphaOutput({
      unit: "bootstrap",
      localFrame: 2,
      layout,
      witness: witness([{ x: 0, y: 0, expectedRange: [32, 64] }]),
      source
    })).toThrow(DecodedOutputIncompatibleError);
  });

  it("rejects the wrong decoded frame identity without reading RGBA", () => {
    let rgbaReads = 0;
    const rgba = materializedRgba([]);
    const source = Object.freeze({
      frame: {} as VideoFrame,
      get rgba() {
        rgbaReads += 1;
        return rgba;
      }
    }) as Readonly<MaterializedRgbaFrameReference>;

    expect(() => qualifyDecodedPackedAlphaOutput({
      unit: "bootstrap",
      localFrame: 1,
      layout,
      witness: witness([{ x: 0, y: 0, expectedRange: [32, 64] }]),
      source
    })).toThrow("decoded witness frame identity is invalid");
    expect(rgbaReads).toBe(0);
  });

  it("rejects storage that cannot represent the canonical alpha pane", () => {
    const source = materializedReference([0], {
      width: 2,
      height: 2,
      stride: 8
    });

    expect(() => qualifyDecodedPackedAlphaOutput({
      unit: "bootstrap",
      localFrame: 2,
      layout,
      witness: witness([{ x: 0, y: 0, expectedRange: [32, 64] }]),
      source
    })).toThrow("decoded RGBA storage is invalid");
  });
});

function witness(
  samples: PackedAlphaWitnessV1["samples"]
): PackedAlphaWitnessV1 {
  return Object.freeze({
    kind: "packed-alpha-v1",
    unit: "bootstrap",
    frame: 2,
    samples: Object.freeze(samples)
  });
}

function materializedReference(
  red: readonly number[],
  dimensions: Readonly<{ width: number; height: number; stride: number }> = {
    width: 2,
    height: 12,
    stride: 8
  }
): Readonly<MaterializedRgbaFrameReference> {
  return Object.freeze({
    frame: {} as VideoFrame,
    rgba: materializedRgba(red, dimensions)
  });
}

function materializedRgba(
  red: readonly number[],
  dimensions: Readonly<{ width: number; height: number; stride: number }> = {
    width: 2,
    height: 12,
    stride: 8
  }
): Readonly<MaterializedRgbaFrame> {
  const pixels = new Uint8Array(dimensions.stride * dimensions.height);
  const alphaStart = (layout.alphaRect?.[1] ?? 0) * dimensions.stride +
    (layout.alphaRect?.[0] ?? 0) * 4;
  for (let index = 0; index < red.length; index += 1) {
    pixels[alphaStart + index * 4] = red[index] ?? 0;
  }
  return Object.freeze({
    width: dimensions.width,
    height: dimensions.height,
    stride: dimensions.stride,
    pixels
  }) satisfies Readonly<MaterializedRgbaFrame>;
}
