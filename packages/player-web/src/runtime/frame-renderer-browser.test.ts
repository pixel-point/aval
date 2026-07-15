import { deriveAvcRenditionGeometry } from "@pixel-point/aval-format";
import { describe, expect, it } from "vitest";

import {
  BrowserFrameBackend,
  FRAME_FRAGMENT_SHADER_SOURCE
} from "./frame-renderer-browser.js";
import type {
  CopyableVideoFrame,
  FrameTextureLayout
} from "./frame-renderer.js";
import {
  deriveFrameSamplingLayout
} from "./frame-renderer-validation.js";
import { computePresentationGeometry } from "./presentation-geometry.js";

const PACKED_LAYOUT: FrameTextureLayout = {
  geometry: deriveAvcRenditionGeometry({
    profile: "avc-annexb-packed-alpha-v0",
    canvasWidth: 3,
    canvasHeight: 1,
    colorRect: [0, 0, 3, 1],
    alphaRect: [0, 10, 3, 1],
    codedWidth: 16,
    codedHeight: 16
  }),
  logicalWidth: 6,
  logicalHeight: 2,
  residentLayerCount: 1
};

const FULL_PACKED_LAYOUT: FrameTextureLayout = {
  geometry: deriveAvcRenditionGeometry({
    profile: "avc-annexb-packed-alpha-v0",
    canvasWidth: 6,
    canvasHeight: 2,
    colorRect: [0, 0, 6, 2],
    alphaRect: [0, 10, 6, 2],
    codedWidth: 16,
    codedHeight: 16
  }),
  logicalWidth: 6,
  logicalHeight: 2,
  residentLayerCount: 1
};

const ODD_PACKED_LAYOUT: FrameTextureLayout = {
  geometry: deriveAvcRenditionGeometry({
    profile: "avc-annexb-packed-alpha-v0",
    canvasWidth: 7,
    canvasHeight: 5,
    colorRect: [0, 0, 7, 5],
    alphaRect: [0, 14, 7, 5],
    codedWidth: 16,
    codedHeight: 32
  }),
  logicalWidth: 7,
  logicalHeight: 5,
  residentLayerCount: 1
};

describe("browser profile-neutral frame backend", () => {
  it("sanitizes a host failure while acquiring the WebGL2 context", () => {
    const secret = "/private/context-secret";
    const canvas = {
      getContext() {
        throw new RangeError(secret);
      }
    } as unknown as HTMLCanvasElement;

    const failure = captureFailure(() => new BrowserFrameBackend(canvas));

    expect(failure).toMatchObject({
      message:
        "the WebGL frame renderer is unavailable: WebGL2 context creation failed"
    });
    expect(failure.message).not.toContain(secret);
  });

  it("sanitizes a host failure while probing WebGL2 device limits", () => {
    const fixture = createRecordingCanvas();
    const secret = "/private/device-limit-secret";
    fixture.gl.parameterFailure = new RangeError(secret);

    const failure = captureFailure(
      () => new BrowserFrameBackend(fixture.canvas)
    );

    expect(failure).toMatchObject({
      message:
        "the WebGL frame renderer is unavailable: WebGL2 device limits are unavailable"
    });
    expect(failure.message).not.toContain(secret);
  });

  it("sanitizes a host redraw failure after restoring presentation pixels", () => {
    const fixture = createRecordingCanvas();
    const backend = new BrowserFrameBackend(fixture.canvas);
    backend.allocate(FULL_PACKED_LAYOUT, 3);
    backend.draw("stream", 0);
    const secret = "/private/resize-driver-secret";
    fixture.gl.drawFailure = new RangeError(secret);
    const geometry = computePresentationGeometry({
      canvasWidth: 6,
      canvasHeight: 2,
      pixelAspectNumerator: 1,
      pixelAspectDenominator: 1,
      fit: "contain",
      cssWidth: 12,
      cssHeight: 4,
      devicePixelRatio: 1,
      maxBackingWidth: 2_048,
      maxBackingHeight: 2_048,
      maxBackingBytes: 1_024 * 1_024
    });

    const failure = captureFailure(
      () => backend.setPresentationGeometry(geometry)
    );

    expect(failure.message).toContain("frame presentation update failed");
    expect(failure.message).not.toContain(secret);
    expect(fixture.canvas).toMatchObject({ width: 6, height: 2 });
    expect(() => backend.draw("stream", 0)).not.toThrow();
  });

  it("derives inset texel-center transforms that cannot sample gutter or padding", () => {
    const sampling = deriveFrameSamplingLayout(PACKED_LAYOUT);
    expect(sampling).toEqual({
      hasAlpha: true,
      visibleWidth: 3,
      visibleHeight: 1,
      color: {
        offsetX: 0.5 / 16,
        offsetY: 0.5 / 16,
        scaleX: 2 / 16,
        scaleY: 0
      },
      alpha: {
        offsetX: 0.5 / 16,
        offsetY: 10.5 / 16,
        scaleX: 2 / 16,
        scaleY: 0
      }
    });
    expect([0, 1].map((u) => mapUv(sampling.color, u, 0))).toEqual([
      [0.5 / 16, 0.5 / 16],
      [2.5 / 16, 0.5 / 16]
    ]);
    if (sampling.alpha === null) throw new Error("alpha transform is missing");
    expect([0, 1].map((u) => mapUv(sampling.alpha!, u, 0))).toEqual([
      [0.5 / 16, 10.5 / 16],
      [2.5 / 16, 10.5 / 16]
    ]);
  });

  it("uses an alpha premultiplied context, exact blend state, and packed uniforms", () => {
    const fixture = createRecordingCanvas();
    const backend = new BrowserFrameBackend(fixture.canvas, {
      checkErrors: true
    });

    backend.allocate(PACKED_LAYOUT, 3);
    backend.upload("resident", 0, new Uint8Array(16 * 16 * 4));
    backend.draw("resident", 0);

    expect(fixture.contextOptions).toMatchObject({
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      preserveDrawingBuffer: false
    });
    expect(fixture.gl.enabled).toContain(fixture.gl.BLEND);
    expect(fixture.gl.blends).toContainEqual([
      fixture.gl.ONE,
      fixture.gl.ONE_MINUS_SRC_ALPHA
    ]);
    expect(fixture.gl.clears).toContain(fixture.gl.COLOR_BUFFER_BIT);
    expect(fixture.gl.uniformScalars.get("u_has_alpha")).toBe(1);
    expect(fixture.gl.uniformVectors.get("u_color_uv")).toEqual([
      0.5 / 16,
      0.5 / 16,
      2 / 16,
      0
    ]);
    expect(fixture.gl.uniformVectors.get("u_alpha_uv")).toEqual([
      0.5 / 16,
      10.5 / 16,
      2 / 16,
      0
    ]);
    expect(fixture.gl.uniformVectors.get("u_output_rect")).toEqual([
      0, 0, 6, 2
    ]);
    expect(fixture.gl.textureFilters.every((filter) =>
      filter === fixture.gl.LINEAR
    )).toBe(true);
    expect(fixture.gl.pixelStores).toContainEqual([
      fixture.gl.UNPACK_ALIGNMENT,
      1
    ]);
    expect(fixture.gl.uploads).toContainEqual({
      width: 16,
      height: 16,
      depth: 1,
      layer: 0,
      byteLength: 16 * 16 * 4
    });
  });

  it("uploads a native VideoFrame into the exact texture-array rectangle", () => {
    const fixture = createRecordingCanvas();
    const backend = new BrowserFrameBackend(fixture.canvas);
    const frame = {} as CopyableVideoFrame;

    backend.allocate(PACKED_LAYOUT, 3);
    backend.uploadFrame("resident", 1, frame, {
      x: 2,
      y: 3,
      width: 4,
      height: 5
    });

    expect(fixture.gl.nativeUploads).toEqual([{
      x: 2,
      y: 3,
      width: 4,
      height: 5,
      depth: 1,
      layer: 1,
      source: frame
    }]);
  });

  it("keeps opaque alpha exactly one and freezes premultiplied shader math", () => {
    const fixture = createRecordingCanvas();
    const backend = new BrowserFrameBackend(fixture.canvas);
    const opaque: FrameTextureLayout = {
      geometry: deriveAvcRenditionGeometry({
        profile: "avc-annexb-opaque-v0",
        canvasWidth: 3,
        canvasHeight: 1,
        colorRect: [0, 0, 3, 1],
        codedWidth: 16,
        codedHeight: 16
      }),
      logicalWidth: 3,
      logicalHeight: 1,
      residentLayerCount: 0
    };

    backend.allocate(opaque, 3);
    backend.draw("stream", 1);

    expect(fixture.gl.uniformScalars.get("u_has_alpha")).toBe(0);
    expect(FRAME_FRAGMENT_SHADER_SOURCE).toContain("float alpha = 1.0");
    expect(FRAME_FRAGMENT_SHADER_SOURCE).toContain(".r, 0.0, 1.0");
    expect(FRAME_FRAGMENT_SHADER_SOURCE).toContain(
      "vec4(color * alpha, alpha)"
    );
    expect(FRAME_FRAGMENT_SHADER_SOURCE).toContain(
      "u_output_rect.zw - vec2(1.0)"
    );
    expect(FRAME_FRAGMENT_SHADER_SOURCE).toContain(
      "sample_uv = clamp(sample_uv, vec2(0.0), vec2(1.0))"
    );
  });

  it("rejects a presentation backing that changes during texture allocation", () => {
    const fixture = createRecordingCanvas();
    const backend = new BrowserFrameBackend(fixture.canvas);
    const geometry = computePresentationGeometry({
      canvasWidth: 6,
      canvasHeight: 2,
      pixelAspectNumerator: 1,
      pixelAspectDenominator: 1,
      fit: "contain",
      cssWidth: 12,
      cssHeight: 4,
      devicePixelRatio: 1,
      maxBackingWidth: 2_048,
      maxBackingHeight: 2_048,
      maxBackingBytes: 1_024 * 1_024
    });
    backend.setPresentationGeometry(geometry);
    fixture.canvas.height = 1;
    fixture.ignoreHeightSetIn(1);

    expect(() => backend.allocate(FULL_PACKED_LAYOUT, 3)).toThrow(
      "browser did not allocate the exact frame backing"
    );
    expect(new Set(fixture.gl.deletedTextures)).toEqual(
      new Set(fixture.gl.createdTextures)
    );
  });

  it("deletes every partial texture when array allocation fails", () => {
    const fixture = createRecordingCanvas();
    fixture.gl.failTextureAllocationAt = 2;
    const backend = new BrowserFrameBackend(fixture.canvas);

    expect(() => backend.allocate(PACKED_LAYOUT, 3)).toThrow(
      "injected texture allocation failure"
    );
    expect(new Set(fixture.gl.deletedTextures)).toEqual(
      new Set(fixture.gl.createdTextures)
    );
  });

  it.each([
    "shaderSource",
    "compileShader",
    "getShaderParameter"
  ] as const)(
    "deletes every shader once when %s throws during fragment compilation",
    (step) => {
      const fixture = createRecordingCanvas();
      fixture.gl.shaderFailure = { step, ordinal: 2 };
      const backend = new BrowserFrameBackend(fixture.canvas);

      expect(() => backend.allocate(PACKED_LAYOUT, 3)).toThrow(
        `injected ${step} failure`
      );

      expect(fixture.gl.createdShaders).toHaveLength(2);
      expect(fixture.gl.deletedShaders).toHaveLength(2);
      for (const shader of fixture.gl.createdShaders) {
        expect(fixture.gl.deletedShaders.filter(
          (deleted) => deleted === shader
        )).toHaveLength(1);
      }
    }
  );

  it("does not inspect unsafe shader info logs on compile-status failure", () => {
    const fixture = createRecordingCanvas();
    fixture.gl.compileStatusFailureOrdinal = 2;
    fixture.gl.infoLogFailure = new RangeError("/private/shader-log-secret");
    const backend = new BrowserFrameBackend(fixture.canvas);

    expect(() => backend.allocate(PACKED_LAYOUT, 3)).toThrow(
      "failed to compile the WebGL frame shader"
    );

    expect(fixture.gl.infoLogReads).toBe(0);
    expect(fixture.gl.createdShaders).toHaveLength(2);
    expect(fixture.gl.deletedShaders).toHaveLength(2);
    for (const shader of fixture.gl.createdShaders) {
      expect(fixture.gl.deletedShaders.filter(
        (deleted) => deleted === shader
      )).toHaveLength(1);
    }
  });

  it("maps a logical crop through a lower rendition's texel-edge space", () => {
    const fixture = createRecordingCanvas();
    const backend = new BrowserFrameBackend(fixture.canvas);
    backend.allocate(PACKED_LAYOUT, 3);
    backend.draw("stream", 1);
    const drawsBeforeResize = fixture.gl.drawCalls;
    const geometry = computePresentationGeometry({
      canvasWidth: 6,
      canvasHeight: 2,
      pixelAspectNumerator: 1,
      pixelAspectDenominator: 1,
      fit: "cover",
      cssWidth: 4,
      cssHeight: 4,
      devicePixelRatio: 2,
      maxBackingWidth: 2_048,
      maxBackingHeight: 2_048,
      maxBackingBytes: 1_024 * 1_024
    });

    expect(backend.setPresentationGeometry(geometry)).toBe(true);

    expect(fixture.canvas.width).toBe(8);
    expect(fixture.canvas.height).toBe(8);
    expect(fixture.gl.drawCalls).toBe(drawsBeforeResize + 1);
    expect(fixture.gl.viewports.slice(-2)).toEqual([
      [0, 0, 8, 8],
      [0, 0, 8, 8]
    ]);
    expect(fixture.gl.uniformVectors.get("u_color_uv")).toEqual([
      1.5 / 16,
      0.5 / 16,
      0,
      0
    ]);
    expect(fixture.gl.uniformVectors.get("u_alpha_uv")).toEqual([
      1.5 / 16,
      10.5 / 16,
      0,
      0
    ]);
    expect(fixture.gl.uniformVectors.get("u_output_rect")).toEqual([
      0, 0, 8, 8
    ]);
    expect(backend.setPresentationGeometry(geometry)).toBe(false);
    expect(fixture.gl.drawCalls).toBe(drawsBeforeResize + 1);
  });

  it("terminalizes when both the requested redraw and rollback redraw fail", () => {
    const fixture = createRecordingCanvas();
    const backend = new BrowserFrameBackend(fixture.canvas);
    backend.allocate(FULL_PACKED_LAYOUT, 3);
    backend.draw("stream", 1);
    const first = computePresentationGeometry({
      canvasWidth: 6,
      canvasHeight: 2,
      pixelAspectNumerator: 1,
      pixelAspectDenominator: 1,
      fit: "contain",
      cssWidth: 12,
      cssHeight: 4,
      devicePixelRatio: 1,
      maxBackingWidth: 2_048,
      maxBackingHeight: 2_048,
      maxBackingBytes: 1_024 * 1_024
    });
    const second = computePresentationGeometry({
      canvasWidth: 6,
      canvasHeight: 2,
      pixelAspectNumerator: 1,
      pixelAspectDenominator: 1,
      fit: "contain",
      cssWidth: 18,
      cssHeight: 8,
      devicePixelRatio: 1,
      maxBackingWidth: 2_048,
      maxBackingHeight: 2_048,
      maxBackingBytes: 1_024 * 1_024
    });
    backend.setPresentationGeometry(first);
    fixture.gl.failDrawCalls = 2;

    expect(() => backend.setPresentationGeometry(second))
      .toThrow("frame presentation rollback failed");
    expect(() => backend.draw("stream", 1)).toThrow("disposed");
    expect(new Set(fixture.gl.deletedTextures)).toEqual(
      new Set(fixture.gl.createdTextures)
    );
  });

  it("terminalizes when a backing setter fails during redraw rollback", () => {
    const fixture = createRecordingCanvas();
    const backend = new BrowserFrameBackend(fixture.canvas);
    backend.allocate(FULL_PACKED_LAYOUT, 3);
    backend.draw("stream", 1);
    const geometry = computePresentationGeometry({
      canvasWidth: 6,
      canvasHeight: 2,
      pixelAspectNumerator: 1,
      pixelAspectDenominator: 1,
      fit: "contain",
      cssWidth: 18,
      cssHeight: 8,
      devicePixelRatio: 1,
      maxBackingWidth: 2_048,
      maxBackingHeight: 2_048,
      maxBackingBytes: 1_024 * 1_024
    });
    fixture.failWidthSetIn(2);
    fixture.gl.failDrawCalls = 1;

    expect(() => backend.setPresentationGeometry(geometry))
      .toThrow("frame presentation rollback failed");
    expect(() => backend.draw("stream", 1)).toThrow("disposed");
  });

  it("maps integer crop edges to exact packed color and alpha texel centers", () => {
    const fixture = createRecordingCanvas();
    const backend = new BrowserFrameBackend(fixture.canvas);
    backend.allocate(FULL_PACKED_LAYOUT, 3);
    backend.draw("stream", 1);
    const geometry = computePresentationGeometry({
      canvasWidth: 6,
      canvasHeight: 2,
      pixelAspectNumerator: 1,
      pixelAspectDenominator: 1,
      fit: "cover",
      cssWidth: 4,
      cssHeight: 4,
      devicePixelRatio: 2,
      maxBackingWidth: 2_048,
      maxBackingHeight: 2_048,
      maxBackingBytes: 1_024 * 1_024
    });

    expect(geometry.sourceRect).toEqual({ x: 2, y: 0, width: 2, height: 2 });
    backend.setPresentationGeometry(geometry);

    const color = requireUniform(fixture.gl, "u_color_uv");
    const alpha = requireUniform(fixture.gl, "u_alpha_uv");
    expectUvAxis(color, "x", 16, 2.5, 3.5);
    expectUvAxis(color, "y", 16, 0.5, 1.5);
    expectUvAxis(alpha, "x", 16, 2.5, 3.5);
    expectUvAxis(alpha, "y", 16, 10.5, 11.5);
    expectLinearFootprintsInside(color, "x", 16, 2, 3);
    expectLinearFootprintsInside(color, "y", 16, 0, 1);
    expectLinearFootprintsInside(alpha, "x", 16, 2, 3);
    expectLinearFootprintsInside(alpha, "y", 16, 10, 11);
  });

  it("keeps odd fractional cover crops inside both visible packed panes", () => {
    const fixture = createRecordingCanvas();
    const backend = new BrowserFrameBackend(fixture.canvas);
    backend.allocate(ODD_PACKED_LAYOUT, 3);
    backend.draw("stream", 1);
    const geometry = computePresentationGeometry({
      canvasWidth: 7,
      canvasHeight: 5,
      pixelAspectNumerator: 1,
      pixelAspectDenominator: 1,
      fit: "cover",
      cssWidth: 11,
      cssHeight: 7,
      devicePixelRatio: 1.25,
      maxBackingWidth: 2_048,
      maxBackingHeight: 2_048,
      maxBackingBytes: 1_024 * 1_024
    });

    expect(geometry.sourceRect.x).toBe(0);
    expect(geometry.sourceRect.width).toBe(7);
    expect(geometry.sourceRect.y).toBeCloseTo(3 / 11, 12);
    expect(geometry.sourceRect.height).toBeCloseTo(49 / 11, 12);
    backend.setPresentationGeometry(geometry);

    const color = requireUniform(fixture.gl, "u_color_uv");
    const alpha = requireUniform(fixture.gl, "u_alpha_uv");
    const firstY = geometry.sourceRect.y + 0.5;
    const lastY = geometry.sourceRect.y + geometry.sourceRect.height - 0.5;
    expectUvAxis(color, "x", 16, 0.5, 6.5);
    expectUvAxis(color, "y", 32, firstY, lastY);
    expectUvAxis(alpha, "x", 16, 0.5, 6.5);
    expectUvAxis(alpha, "y", 32, 14 + firstY, 14 + lastY);
    expectLinearFootprintsInside(color, "x", 16, 0, 6);
    expectLinearFootprintsInside(color, "y", 32, 0, 4);
    expectLinearFootprintsInside(alpha, "x", 16, 0, 6);
    expectLinearFootprintsInside(alpha, "y", 32, 14, 18);
  });

  it("collapses a sub-texel cover crop to its midpoint without reversing", () => {
    const fixture = createRecordingCanvas();
    const backend = new BrowserFrameBackend(fixture.canvas);
    backend.allocate(FULL_PACKED_LAYOUT, 3);
    backend.draw("stream", 1);
    const geometry = computePresentationGeometry({
      canvasWidth: 6,
      canvasHeight: 2,
      pixelAspectNumerator: 1,
      pixelAspectDenominator: 1,
      fit: "cover",
      cssWidth: 1,
      cssHeight: 4,
      devicePixelRatio: 1,
      maxBackingWidth: 2_048,
      maxBackingHeight: 2_048,
      maxBackingBytes: 1_024 * 1_024
    });

    expect(geometry.sourceRect).toEqual({
      x: 2.75,
      y: 0,
      width: 0.5,
      height: 2
    });
    backend.setPresentationGeometry(geometry);

    const color = requireUniform(fixture.gl, "u_color_uv");
    const alpha = requireUniform(fixture.gl, "u_alpha_uv");
    expectUvAxis(color, "x", 16, 3, 3);
    expectUvAxis(alpha, "x", 16, 3, 3);
    expect(color[2]).toBe(0);
    expect(alpha[2]).toBe(0);
  });

  it("clamps sub-texel boundary crops to each pane's outer centers", () => {
    const fixture = createRecordingCanvas();
    const backend = new BrowserFrameBackend(fixture.canvas);
    backend.allocate(FULL_PACKED_LAYOUT, 3);
    backend.draw("stream", 1);
    const base = computePresentationGeometry({
      canvasWidth: 6,
      canvasHeight: 2,
      pixelAspectNumerator: 1,
      pixelAspectDenominator: 1,
      fit: "fill",
      cssWidth: 6,
      cssHeight: 2,
      devicePixelRatio: 1,
      maxBackingWidth: 2_048,
      maxBackingHeight: 2_048,
      maxBackingBytes: 1_024 * 1_024
    });

    backend.setPresentationGeometry(Object.freeze({
      ...base,
      sourceRect: Object.freeze({ x: 0, y: 0, width: 0.25, height: 2 })
    }));
    let color = requireUniform(fixture.gl, "u_color_uv");
    let alpha = requireUniform(fixture.gl, "u_alpha_uv");
    expectUvAxis(color, "x", 16, 0.5, 0.5);
    expectUvAxis(alpha, "x", 16, 0.5, 0.5);

    backend.setPresentationGeometry(Object.freeze({
      ...base,
      sourceRect: Object.freeze({ x: 5.75, y: 0, width: 0.25, height: 2 })
    }));
    color = requireUniform(fixture.gl, "u_color_uv");
    alpha = requireUniform(fixture.gl, "u_alpha_uv");
    expectUvAxis(color, "x", 16, 5.5, 5.5);
    expectUvAxis(alpha, "x", 16, 5.5, 5.5);
  });
});

function requireUniform(gl: RecordingGl, name: string): readonly number[] {
  const value = gl.uniformVectors.get(name);
  if (value === undefined) throw new Error(`uniform ${name} was not recorded`);
  return value;
}

function expectUvAxis(
  transform: readonly number[],
  axis: "x" | "y",
  codedExtent: number,
  firstCenter: number,
  lastCenter: number
): void {
  const offsetIndex = axis === "x" ? 0 : 1;
  const scaleIndex = axis === "x" ? 2 : 3;
  const offset = transform[offsetIndex];
  const scale = transform[scaleIndex];
  if (offset === undefined || scale === undefined) {
    throw new Error("UV transform is incomplete");
  }
  expect(offset * codedExtent).toBeCloseTo(firstCenter, 12);
  expect((offset + scale) * codedExtent).toBeCloseTo(lastCenter, 12);
}

function expectLinearFootprintsInside(
  transform: readonly number[],
  axis: "x" | "y",
  codedExtent: number,
  firstAllowedTexel: number,
  lastAllowedTexel: number
): void {
  const offsetIndex = axis === "x" ? 0 : 1;
  const scaleIndex = axis === "x" ? 2 : 3;
  const offset = transform[offsetIndex];
  const scale = transform[scaleIndex];
  if (offset === undefined || scale === undefined) {
    throw new Error("UV transform is incomplete");
  }
  for (let step = 0; step <= 64; step += 1) {
    const uv = offset + scale * step / 64;
    let texelIndex = uv * codedExtent - 0.5;
    const nearest = Math.round(texelIndex);
    if (Math.abs(texelIndex - nearest) <= 1e-10) texelIndex = nearest;
    expect(Math.floor(texelIndex)).toBeGreaterThanOrEqual(firstAllowedTexel);
    expect(Math.ceil(texelIndex)).toBeLessThanOrEqual(lastAllowedTexel);
  }
}

function mapUv(
  transform: Readonly<{
    readonly offsetX: number;
    readonly offsetY: number;
    readonly scaleX: number;
    readonly scaleY: number;
  }>,
  u: number,
  v: number
): readonly [number, number] {
  return [
    transform.offsetX + u * transform.scaleX,
    transform.offsetY + v * transform.scaleY
  ];
}

function createRecordingCanvas(): {
  readonly canvas: HTMLCanvasElement;
  readonly gl: RecordingGl;
  readonly contextOptions: WebGLContextAttributes;
  readonly failWidthSetIn: (calls: number) => void;
  readonly ignoreHeightSetIn: (calls: number) => void;
} {
  const gl = new RecordingGl();
  let contextOptions: WebGLContextAttributes | undefined;
  let width = 0;
  let height = 0;
  let failWidthCountdown = 0;
  let ignoreHeightCountdown = 0;
  const canvas = {
    get width() {
      return width;
    },
    set width(value: number) {
      if (failWidthCountdown > 0) {
        failWidthCountdown -= 1;
        if (failWidthCountdown === 0) {
          throw new Error("injected canvas width setter failure");
        }
      }
      width = value;
    },
    get height() {
      return height;
    },
    set height(value: number) {
      if (ignoreHeightCountdown > 0) {
        ignoreHeightCountdown -= 1;
        if (ignoreHeightCountdown === 0) return;
      }
      height = value;
    },
    getContext(_kind: string, options: WebGLContextAttributes) {
      contextOptions = options;
      return gl as unknown as WebGL2RenderingContext;
    }
  } as unknown as HTMLCanvasElement;
  return {
    canvas,
    gl,
    failWidthSetIn(calls: number) {
      failWidthCountdown = calls;
    },
    ignoreHeightSetIn(calls: number) {
      ignoreHeightCountdown = calls;
    },
    get contextOptions() {
      if (contextOptions === undefined) throw new Error("context not requested");
      return contextOptions;
    }
  };
}

class RecordingGl {
  public readonly MAX_TEXTURE_SIZE = 1;
  public readonly MAX_ARRAY_TEXTURE_LAYERS = 2;
  public readonly VERTEX_SHADER = 3;
  public readonly FRAGMENT_SHADER = 4;
  public readonly COMPILE_STATUS = 5;
  public readonly LINK_STATUS = 6;
  public readonly TEXTURE_2D_ARRAY = 7;
  public readonly TEXTURE_MIN_FILTER = 8;
  public readonly TEXTURE_MAG_FILTER = 9;
  public readonly TEXTURE_WRAP_S = 10;
  public readonly TEXTURE_WRAP_T = 11;
  public readonly CLAMP_TO_EDGE = 12;
  public readonly LINEAR = 13;
  public readonly RGBA8 = 14;
  public readonly TEXTURE0 = 15;
  public readonly TRIANGLES = 16;
  public readonly BLEND = 17;
  public readonly ONE = 18;
  public readonly ONE_MINUS_SRC_ALPHA = 19;
  public readonly COLOR_BUFFER_BIT = 20;
  public readonly NO_ERROR = 0;
  public readonly RGBA = 21;
  public readonly UNSIGNED_BYTE = 22;
  public readonly UNPACK_ALIGNMENT = 23;

  public readonly enabled: number[] = [];
  public readonly blends: Array<[number, number]> = [];
  public readonly clears: number[] = [];
  public readonly textureFilters: number[] = [];
  public readonly uniformScalars = new Map<string, number>();
  public readonly uniformVectors = new Map<string, number[]>();
  public readonly pixelStores: Array<[number, number]> = [];
  public readonly uploads: Array<{
    readonly width: number;
    readonly height: number;
    readonly depth: number;
    readonly layer: number;
    readonly byteLength: number;
  }> = [];
  public readonly nativeUploads: Array<{
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
    readonly depth: number;
    readonly layer: number;
    readonly source: TexImageSource;
  }> = [];
  public readonly createdTextures: WebGLTexture[] = [];
  public readonly deletedTextures: WebGLTexture[] = [];
  public readonly createdShaders: WebGLShader[] = [];
  public readonly deletedShaders: WebGLShader[] = [];
  public readonly viewports: Array<[number, number, number, number]> = [];
  public drawCalls = 0;
  public failDrawCalls = 0;
  public drawFailure: Error | null = null;
  public failTextureAllocationAt: number | null = null;
  public parameterFailure: Error | null = null;
  public shaderFailure: Readonly<{
    readonly step: "shaderSource" | "compileShader" | "getShaderParameter";
    readonly ordinal: number;
  }> | null = null;
  public compileStatusFailureOrdinal: number | null = null;
  public infoLogFailure: Error | null = null;
  public infoLogReads = 0;
  readonly #locations = new Map<string, WebGLUniformLocation>();
  #shader = 0;

  public getParameter(): number {
    if (this.parameterFailure !== null) throw this.parameterFailure;
    return 8_192;
  }
  public createShader(): WebGLShader {
    this.#shader += 1;
    const shader = { id: this.#shader } as unknown as WebGLShader;
    this.createdShaders.push(shader);
    return shader;
  }
  public shaderSource(shader: WebGLShader): void {
    this.#throwShaderFailure("shaderSource", shader);
  }
  public compileShader(shader: WebGLShader): void {
    this.#throwShaderFailure("compileShader", shader);
  }
  public getShaderParameter(shader: WebGLShader): boolean {
    this.#throwShaderFailure("getShaderParameter", shader);
    return this.#shaderOrdinal(shader) !== this.compileStatusFailureOrdinal;
  }
  public getShaderInfoLog(): string {
    this.infoLogReads += 1;
    if (this.infoLogFailure !== null) throw this.infoLogFailure;
    return "";
  }
  public deleteShader(shader: WebGLShader): void {
    this.deletedShaders.push(shader);
  }
  public createProgram(): WebGLProgram {
    return {} as WebGLProgram;
  }
  public attachShader(): void {}
  public linkProgram(): void {}
  public getProgramParameter(): boolean { return true; }
  public getProgramInfoLog(): string { return ""; }
  public deleteProgram(): void {}
  public createVertexArray(): WebGLVertexArrayObject {
    return {} as WebGLVertexArrayObject;
  }
  public deleteVertexArray(): void {}
  public createTexture(): WebGLTexture {
    const texture = {
      id: this.createdTextures.length + 1
    } as unknown as WebGLTexture;
    this.createdTextures.push(texture);
    return texture;
  }
  public deleteTexture(texture: WebGLTexture): void {
    this.deletedTextures.push(texture);
  }
  public bindTexture(): void {}
  public texParameteri(_target: number, parameter: number, value: number): void {
    if (
      parameter === this.TEXTURE_MIN_FILTER ||
      parameter === this.TEXTURE_MAG_FILTER
    ) this.textureFilters.push(value);
  }
  public texStorage3D(): void {
    if (this.failTextureAllocationAt === this.createdTextures.length) {
      throw new Error("injected texture allocation failure");
    }
  }
  public getUniformLocation(_program: WebGLProgram, name: string): WebGLUniformLocation {
    const location = { name } as unknown as WebGLUniformLocation;
    this.#locations.set(name, location);
    return location;
  }
  public enable(value: number): void { this.enabled.push(value); }
  public blendFunc(source: number, destination: number): void {
    this.blends.push([source, destination]);
  }
  public clearColor(): void {}
  public clear(mask: number): void { this.clears.push(mask); }
  public viewport(x: number, y: number, width: number, height: number): void {
    this.viewports.push([x, y, width, height]);
  }
  public useProgram(): void {}
  public bindVertexArray(): void {}
  public activeTexture(): void {}
  public uniform1i(location: WebGLUniformLocation | null, value: number): void {
    this.uniformScalars.set(this.#name(location), value);
  }
  public uniform1f(location: WebGLUniformLocation | null, value: number): void {
    this.uniformScalars.set(this.#name(location), value);
  }
  public uniform4f(
    location: WebGLUniformLocation | null,
    x: number,
    y: number,
    z: number,
    w: number
  ): void {
    this.uniformVectors.set(this.#name(location), [x, y, z, w]);
  }
  public drawArrays(): void {
    if (this.drawFailure !== null) {
      const failure = this.drawFailure;
      this.drawFailure = null;
      throw failure;
    }
    if (this.failDrawCalls > 0) {
      this.failDrawCalls -= 1;
      throw new Error("injected frame draw failure");
    }
    this.drawCalls += 1;
  }
  public getError(): number { return this.NO_ERROR; }
  public isContextLost(): boolean { return false; }
  public pixelStorei(parameter: number, value: number): void {
    this.pixelStores.push([parameter, value]);
  }
  public texSubImage3D(
    _target: number,
    _level: number,
    x: number,
    y: number,
    layer: number,
    width: number,
    height: number,
    depth: number,
    _format: number,
    _type: number,
    source: Uint8Array | TexImageSource
  ): void {
    if (source instanceof Uint8Array) {
      this.uploads.push({
        width,
        height,
        depth,
        layer,
        byteLength: source.byteLength
      });
    } else {
      this.nativeUploads.push({
        x,
        y,
        width,
        height,
        depth,
        layer,
        source
      });
    }
  }
  public readPixels(): void {}

  #name(location: WebGLUniformLocation | null): string {
    if (location === null) throw new Error("uniform location is null");
    return (location as unknown as { readonly name: string }).name;
  }

  #shaderOrdinal(shader: WebGLShader): number {
    return (shader as unknown as { readonly id: number }).id;
  }

  #throwShaderFailure(
    step: "shaderSource" | "compileShader" | "getShaderParameter",
    shader: WebGLShader
  ): void {
    if (
      this.shaderFailure?.step === step &&
      this.shaderFailure.ordinal === this.#shaderOrdinal(shader)
    ) {
      throw new Error(`injected ${step} failure`);
    }
  }
}

function captureFailure(operation: () => unknown): Error {
  try {
    operation();
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error("operation failed without an Error instance");
  }
  throw new Error("operation unexpectedly succeeded");
}
