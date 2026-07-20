import { describe, expect, it, vi } from "vitest";

import type { PackedAlphaWitnessV1 } from "../src/asset.js";
import {
  DecodedOutputIncompatibleError,
  qualifyDecodedPackedAlphaOutput
} from "../src/decoded-output-qualifier.js";
import type {
  MaterializedRgbaFrame,
  RgbaMaterialization
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
  it("accepts inclusive interval endpoints through the canonical alpha offset", async () => {
    const source = materialization([32, 95, 64]);

    await qualifyDecodedPackedAlphaOutput({
      unit: "bootstrap",
      localFrame: 2,
      layout,
      witness: witness([
        { x: 0, y: 0, expectedRange: [32, 64] },
        { x: 1, y: 0, expectedRange: [95, 95] },
        { x: 0, y: 1, expectedRange: [64, 96] }
      ]),
      source: source.value
    });

    expect(source.rgba).toHaveBeenCalledTimes(1);
  });

  it.each([
    [31, "below"],
    [65, "above"]
  ])("rejects a sample %s the authored interval", async (red) => {
    const source = materialization([0, 0, 0, 0, 0, 0, 0, 0, red]);

    await expect(qualifyDecodedPackedAlphaOutput({
      unit: "bootstrap",
      localFrame: 2,
      layout,
      witness: witness([{ x: 0, y: 0, expectedRange: [32, 64] }]),
      source: source.value
    })).rejects.toBeInstanceOf(DecodedOutputIncompatibleError);
    expect(source.rgba).toHaveBeenCalledTimes(1);
  });

  it("rejects the wrong decoded frame identity without materializing", async () => {
    const source = materialization([]);

    await expect(qualifyDecodedPackedAlphaOutput({
      unit: "bootstrap",
      localFrame: 1,
      layout,
      witness: witness([{ x: 0, y: 0, expectedRange: [32, 64] }]),
      source: source.value
    })).rejects.toThrow("decoded witness frame identity is invalid");
    expect(source.rgba).not.toHaveBeenCalled();
  });

  it("keeps materializer failures terminal", async () => {
    const failure = new Error("copy failed");
    const failed = materialization([], failure);
    await expect(qualifyDecodedPackedAlphaOutput({
      unit: "bootstrap",
      localFrame: 2,
      layout,
      witness: witness([{ x: 0, y: 0, expectedRange: [32, 64] }]),
      source: failed.value
    })).rejects.toBe(failure);
  });

  it("rejects storage that cannot represent the canonical alpha pane", async () => {
    const source = materialization([0], undefined, {
      width: 2,
      height: 2,
      stride: 8
    });

    await expect(qualifyDecodedPackedAlphaOutput({
      unit: "bootstrap",
      localFrame: 2,
      layout,
      witness: witness([{ x: 0, y: 0, expectedRange: [32, 64] }]),
      source: source.value
    })).rejects.toThrow("decoded RGBA storage is invalid");
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

function materialization(
  red: readonly number[],
  failure?: unknown,
  dimensions: Readonly<{ width: number; height: number; stride: number }> = {
    width: 2,
    height: 12,
    stride: 8
  }
): Readonly<{
  value: Readonly<RgbaMaterialization>;
  rgba: ReturnType<typeof vi.fn>;
}> {
  const pixels = new Uint8Array(dimensions.stride * dimensions.height);
  const alphaStart = (layout.alphaRect?.[1] ?? 0) * dimensions.stride +
    (layout.alphaRect?.[0] ?? 0) * 4;
  for (let index = 0; index < red.length; index += 1) {
    pixels[alphaStart + index * 4] = red[index] ?? 0;
  }
  const frame = Object.freeze({
    width: dimensions.width,
    height: dimensions.height,
    stride: dimensions.stride,
    pixels
  }) satisfies Readonly<MaterializedRgbaFrame>;
  const rgba = vi.fn(() => failure === undefined
    ? Promise.resolve(frame)
    : Promise.reject(failure));
  return Object.freeze({
    rgba,
    value: Object.freeze({
      frame: {} as VideoFrame,
      rgba,
      release: vi.fn()
    })
  });
}
