import { describe, expect, it } from "vitest";

import {
  computePresentationGeometry,
  rasterizePresentationRect,
  type PresentationGeometryInput
} from "./presentation-geometry.js";

describe("computePresentationGeometry", () => {
  it("computes centered contain for the animated plane", () => {
    const geometry = computePresentationGeometry(input({
      fit: "contain",
      cssWidth: 100,
      cssHeight: 100,
      devicePixelRatio: 2
    }));

    expect(geometry.sourceRect).toEqual({ x: 0, y: 0, width: 100, height: 50 });
    expect(geometry.destinationCssRect).toEqual({
      x: 0,
      y: 25,
      width: 100,
      height: 50
    });
    expect(geometry.backing).toEqual({ width: 200, height: 200 });
    expect(geometry.destinationBackingRect).toEqual({
      x: 0,
      y: 50,
      width: 200,
      height: 100
    });
    expect(geometry.planes.animated).toEqual({
      sourceRect: geometry.sourceRect,
      destinationCssRect: geometry.destinationCssRect,
      destinationBackingRect: geometry.destinationBackingRect
    });
    expect(geometry.byteTerms).toEqual({
      bytesPerPlane: 160_000,
      totalBackingBytes: 160_000
    });
  });

  it("computes cover crop in source pixels with non-square pixel aspect", () => {
    const geometry = computePresentationGeometry(input({
      fit: "cover",
      pixelAspectNumerator: 2,
      pixelAspectDenominator: 1,
      cssWidth: 100,
      cssHeight: 100
    }));

    expect(geometry.displayAspect).toBe(4);
    expect(geometry.sourceRect).toEqual({
      x: 37.5,
      y: 0,
      width: 25,
      height: 50
    });
    expect(geometry.destinationCssRect).toEqual({
      x: 0,
      y: 0,
      width: 100,
      height: 100
    });
  });

  it("implements fill and intrinsic none without changing the source", () => {
    const fill = computePresentationGeometry(input({
      fit: "fill",
      cssWidth: 75,
      cssHeight: 125
    }));
    expect(fill.sourceRect).toEqual({ x: 0, y: 0, width: 100, height: 50 });
    expect(fill.destinationCssRect).toEqual({
      x: 0,
      y: 0,
      width: 75,
      height: 125
    });

    const none = computePresentationGeometry(input({
      fit: "none",
      pixelAspectNumerator: 3,
      pixelAspectDenominator: 2,
      cssWidth: 80,
      cssHeight: 40
    }));
    expect(none.sourceRect).toEqual({ x: 0, y: 0, width: 100, height: 50 });
    expect(none.destinationCssRect).toEqual({
      x: -35,
      y: -5,
      width: 150,
      height: 50
    });
  });

  it("rounds desired DPR backing upward and preserves fractional mappings", () => {
    const geometry = computePresentationGeometry(input({
      canvasWidth: 17,
      canvasHeight: 11,
      fit: "contain",
      cssWidth: 37.25,
      cssHeight: 23.75,
      devicePixelRatio: 1.5
    }));

    expect(geometry.backing).toEqual({ width: 56, height: 36 });
    expect(geometry.effectiveDevicePixelRatio).toEqual({
      x: 56 / 37.25,
      y: 36 / 23.75
    });
    expect(geometry.destinationBackingRect.width).toBeCloseTo(
      geometry.destinationCssRect.width * 56 / 37.25,
      12
    );
  });

  it("preserves exact backings above the former dimension ceiling", () => {
    const geometry = computePresentationGeometry(input({
      cssWidth: 1_000,
      cssHeight: 500,
      devicePixelRatio: 4,
      maxBackingWidth: 4_000,
      maxBackingHeight: 2_000,
      maxBackingBytes: 4_000 * 2_000 * 8
    }));

    expect(geometry.backing).toEqual({ width: 4_000, height: 2_000 });
    expect(geometry.byteTerms.totalBackingBytes).toBe(32_000_000);
  });

  it("rejects an explicit host or device dimension without downscaling", () => {
    expect(() => computePresentationGeometry(input({
      cssWidth: 1_000,
      cssHeight: 500,
      devicePixelRatio: 4,
      maxBackingWidth: 1_200,
      maxBackingHeight: 900,
      maxBackingBytes: 512 * 1024 * 1024
    }))).toThrow("host or device dimensions");
  });

  it("rejects an explicit byte policy without downscaling", () => {
    for (const [width, height] of [[512, 1], [1, 512]] as const) {
      expect(() => computePresentationGeometry(input({
        canvasWidth: width,
        canvasHeight: height,
        cssWidth: width,
        cssHeight: height,
        maxBackingWidth: 2_048,
        maxBackingHeight: 2_048,
        maxBackingBytes: 8
      }))).toThrow("host byte policy");
    }
  });

  it("is deterministic and returns an immutable ownership graph", () => {
    const value = input({ fit: "cover", cssWidth: 91.5, cssHeight: 63.25 });
    const first = computePresentationGeometry(value);
    const second = computePresentationGeometry(value);

    expect(second).toEqual(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.sourceRect)).toBe(true);
    expect(Object.isFrozen(first.destinationCssRect)).toBe(true);
    expect(Object.isFrozen(first.destinationBackingRect)).toBe(true);
    expect(Object.isFrozen(first.backing)).toBe(true);
    expect(Object.isFrozen(first.planes)).toBe(true);
  });

  it("accepts equivalent non-reduced wire pixel-aspect terms", () => {
    const canonical = computePresentationGeometry(input({
      pixelAspectNumerator: 1,
      pixelAspectDenominator: 1
    }));
    const wireValid = computePresentationGeometry(input({
      pixelAspectNumerator: 2,
      pixelAspectDenominator: 2
    }));

    expect(wireValid).toEqual(canonical);
  });

  it("rejects non-finite, non-positive, unsafe, and impossible inputs", () => {
    for (const override of [
      { canvasWidth: 0 },
      { canvasHeight: 0 },
      { pixelAspectNumerator: 0 },
      { pixelAspectDenominator: 0 },
      { cssWidth: 0 },
      { cssHeight: Number.NaN },
      { devicePixelRatio: Number.POSITIVE_INFINITY },
      { maxBackingWidth: 0 },
      { maxBackingHeight: 0 },
      { maxBackingBytes: 7 }
    ] as const) {
      expect(() => computePresentationGeometry(input(override)))
        .toThrow();
    }
    expect(() => computePresentationGeometry(input({
      fit: "stretch" as unknown as "fill"
    }))).toThrow("fit");
  });

  it("rasterizes shared destination bounds without independent plane rounding", () => {
    expect(rasterizePresentationRect({
      x: 1.4,
      y: 2.6,
      width: 7.3,
      height: 8.1
    })).toEqual({ x: 1, y: 3, width: 8, height: 8 });
  });
});

function input(
  override: Partial<PresentationGeometryInput> = {}
): PresentationGeometryInput {
  return {
    canvasWidth: 100,
    canvasHeight: 50,
    pixelAspectNumerator: 1,
    pixelAspectDenominator: 1,
    fit: "contain",
    cssWidth: 100,
    cssHeight: 100,
    devicePixelRatio: 1,
    maxBackingWidth: 4_096,
    maxBackingHeight: 4_096,
    maxBackingBytes: 64 * 1024 * 1024,
    ...override
  };
}
