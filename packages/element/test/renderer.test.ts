import { describe, expect, it } from "vitest";

import {
  deriveVideoRenditionGeometry,
  PACKED_ALPHA_GUTTER
} from "@pixel-point/aval-format";

import {
  Renderer,
  type RendererBackendDetails
} from "../src/renderer.js";
import { deriveRenderLayout } from "../src/renderer-geometry.js";
import { RendererFailureError } from "../src/renderer-diagnostics.js";
import {
  blackProbePixels,
  compactOpaqueFrame,
  compactOpaqueLayout,
  frame,
  frameWithGeometry,
  informativeProbePixels,
  layout,
  opaqueLayout,
  rgbaReadbackFixture,
  webglCanvas,
  type TestGl
} from "./renderer-webgl-test-support.js";

describe("renderer geometry admission", () => {
  it.each([
    ["odd", 47, 47],
    ["even", 48, 32]
  ] as const)("derives %s packed storage from format geometry", (
    _parity,
    visibleWidth,
    visibleHeight
  ) => {
    const geometry = deriveVideoRenditionGeometry({
      canvasWidth: visibleWidth,
      canvasHeight: visibleHeight,
      layout: "packed-alpha",
      visibleWidth,
      visibleHeight,
      storage: { widthAlignment: 16, heightAlignment: 16 }
    });

    const result = deriveRenderLayout({
      codedWidth: geometry.codedWidth,
      codedHeight: geometry.codedHeight,
      logicalWidth: visibleWidth,
      logicalHeight: visibleHeight,
      pixelAspect: [1, 1],
      colorRect: geometry.visibleColorRect,
      alphaRect: geometry.visibleAlphaRect!
    });

    expect(result.colorRect).toEqual(geometry.visibleColorRect);
    expect(result.alphaRect).toEqual(geometry.visibleAlphaRect);
    expect([
      result.storageWidth,
      result.storageHeight
    ]).toEqual(geometry.decodedStorageRect.slice(2));
    expect([result.codedWidth, result.codedHeight]).toEqual([
      geometry.codedWidth,
      geometry.codedHeight
    ]);
    expect(result.alphaRect![1] - (visibleHeight + visibleHeight % 2))
      .toBe(PACKED_ALPHA_GUTTER);
  });

  it("accepts canonical even-padded odd packed storage", () => {
    expect(() => new Renderer(canvas(), layout())).toThrow(/WebGL2/u);
  });

  it("selects Canvas2D on the same canvas only after exact-null WebGL2", () => {
    const fixture = canvas2dOnlyFixture();
    const renderer = new Renderer(fixture.canvas, layout(), {
      createCanvas: fixture.createCanvas
    });

    expect(renderer.snapshot()).toMatchObject({
      backendDetails: { kind: "canvas2d" },
      failure: null,
      textureBytes: 0
    });
    expect(fixture.outputRequests).toEqual(["webgl2", "2d"]);
    renderer.dispose();
  });

  it("rejects extent-based storage that drops canonical odd padding", () => {
    expect(() => new Renderer(canvas(), {
      ...layout(), storageWidth: 47, storageHeight: 103
    })).toThrow(/storage rectangle/u);
  });

  it("rejects invalid pixel aspect before allocating WebGL resources", () => {
    expect(() => new Renderer(canvas(), {
      ...layout(), pixelAspect: [0, 1]
    })).toThrow(/pixel aspect/u);
  });
});

describe("renderer failure diagnostics", () => {
  it("distinguishes context creation from pre-GL resource admission", () => {
    expectRendererFailure(
      () => new Renderer(canvas(), layout()),
      {
        backend: "webgl2",
        operation: "construct",
        phase: "context-create",
        contextLost: false
      }
    );

    expect(() => new Renderer(webglCanvas().canvas, layout(), {
      maxRuntimeBytes: 1
    })).toThrowError(expect.objectContaining({ name: "ResourceBudgetError" }));
  });

  it.each([
    ["invalid capability", (gl: TestGl) => { gl.maxTextureSize = 0; },
      "capability-query"],
    ["too-small device", (gl: TestGl) => { gl.maxTextureSize = 47; },
      "device-limits"],
    ["program creation", (gl: TestGl) => { gl.programLinked = false; },
      "program-create"]
  ] as const)("classifies %s failures", (_name, arrange, phase) => {
    const fixture = webglCanvas();
    arrange(fixture.gl);

    expectRendererFailure(
      () => new Renderer(fixture.canvas, layout()),
      { operation: "construct", phase, contextLost: false }
    );
  });

  it("captures the first stream texture GL error and ordinal", () => {
    const fixture = webglCanvas();
    fixture.gl.storageError = 0x0505;

    const error = expectRendererFailure(
      () => new Renderer(fixture.canvas, layout()),
      {
        operation: "construct",
        phase: "stream-texture-create",
        contextLost: false,
        glError: 0x0505,
        textureOrdinal: 0
      }
    );
    expectDeeplyFrozen(error.diagnostic);
  });

  it("classifies an exact canvas backing rejection before WebGL creation", () => {
    const fixture = webglCanvas();
    let backingWidth = fixture.canvas.width;
    Object.defineProperty(fixture.canvas, "width", {
      configurable: true,
      get: () => backingWidth,
      set: (value: number) => { backingWidth = value === 40 ? 39 : value; }
    });

    expectRendererFailure(
      () => new Renderer(fixture.canvas, layout(), {
        initialPresentation: { width: 20, height: 10, dpr: 2, fit: "contain" }
      }),
      {
        operation: "construct",
        phase: "backing-admission",
        contextLost: false,
        backing: { width: 39, height: 20 }
      }
    );
  });

  it("allowlists exact context-attribute keys", () => {
    const fixture = webglCanvas();
    fixture.gl.storageError = 0x0505;
    const error = expectRendererFailure(
      () => new Renderer(fixture.canvas, layout()),
      { phase: "stream-texture-create" }
    );

    expect(Object.keys(error.diagnostic.contextAttributes ?? {})).toEqual([
      "alpha",
      "antialias",
      "depth",
      "desynchronized",
      "failIfMajorPerformanceCaveat",
      "powerPreference",
      "premultipliedAlpha",
      "preserveDrawingBuffer",
      "stencil",
      "xrCompatible"
    ]);
  });

  it("captures a program GL error before cleanup can replace it", () => {
    const fixture = webglCanvas();
    fixture.gl.programLinked = false;
    fixture.gl.programLinkError = 0x0502;
    fixture.gl.deleteProgramError = 0x0505;

    expectRendererFailure(
      () => new Renderer(fixture.canvas, layout()),
      {
        operation: "construct",
        phase: "program-create",
        contextLost: false,
        glError: 0x0502
      }
    );
  });

  it("classifies a resident pixel failure as an RGBA upload", async () => {
    const fixture = webglCanvas();
    const renderer = new Renderer(fixture.canvas, layout());
    fixture.gl.rgbaUploadError = 0x0505;

    let rejected!: RendererFailureError;
    try { await renderer.store("group", 0, frame(), false); }
    catch (error) { rejected = error as RendererFailureError; }

    expect(rejected).toBeInstanceOf(RendererFailureError);
    expect(rejected.diagnostic).toMatchObject({
      operation: "runtime",
      phase: "rgba-upload",
      uploadPath: "rgba-copy",
      contextLost: false,
      glError: 0x0505
    });
  });

  it("preserves a rejected RGBA copy as the callback and promise identity", async () => {
    const fixture = webglCanvas();
    const changes: unknown[] = [];
    const renderer = new Renderer(fixture.canvas, layout(), {
      onContextChange: (change) => changes.push(change)
    });
    fixture.gl.rejectNativeUpload = true;
    const reason = new DOMException("copy rejected", "EncodingError");

    let rejected!: RendererFailureError;
    try {
      await renderer.draw(frame(async () => Promise.reject(reason)), false);
    } catch (error) {
      expect(error).toBeInstanceOf(RendererFailureError);
      rejected = error as RendererFailureError;
    }
    await Promise.resolve();

    expect(rejected.diagnostic).toMatchObject({
      operation: "runtime",
      phase: "rgba-copy",
      uploadPath: "rgba-copy",
      contextLost: false,
      exception: { name: "EncodingError", message: "copy rejected" }
    });
    expect(renderer.snapshot().failure).toBe(rejected.diagnostic);
    expect(changes).toEqual([{ state: "error", error: rejected }]);
  });

  it("keeps an actual context event recoverable without masking restore failure", async () => {
    const fixture = webglCanvas();
    const changes: unknown[] = [];
    const renderer = new Renderer(fixture.canvas, layout(), {
      onContextChange: (change) => changes.push(change)
    });

    fixture.dispatch("webglcontextlost");
    await Promise.resolve();
    expect(changes).toEqual([{ state: "lost", error: null }]);
    expect(renderer.snapshot().failure).toBeNull();

    fixture.gl.storageError = 0x0505;
    fixture.dispatch("webglcontextrestored");
    await renderer.settled();
    await Promise.resolve();

    const errorChange = changes[1] as Readonly<{
      state: "error";
      error: RendererFailureError;
    }>;
    expect(errorChange.state).toBe("error");
    expect(errorChange.error.diagnostic).toMatchObject({
      operation: "restore",
      phase: "stream-texture-create",
      textureOrdinal: 0,
      glError: 0x0505
    });
    expect(renderer.snapshot().failure).toBe(errorChange.error.diagnostic);
  });
});

describe("renderer runtime ownership", () => {
  it("qualifies native upload against Canvas readback when RGBA copy is unsupported", async () => {
    const fixture = webglCanvas(48, 48);
    const pixels = informativeProbePixels();
    fixture.gl.nativeReadback = pixels;
    fixture.gl.rgbaReadback = pixels;
    const readback = rgbaReadbackFixture();
    const candidate = compactOpaqueFrame(() => {
      throw new TypeError("layout size is invalid");
    });
    const renderer = new Renderer(fixture.canvas, compactOpaqueLayout(), {
      createCanvas: readback.createCanvas
    });

    await renderer.draw(candidate, false);

    expect(renderer.snapshot()).toMatchObject({
      backendDetails: {
        kind: "webgl2",
        uploadMode: "native",
        nativeProbeAttempts: 1
      },
      sourceCopiesInFlight: 0
    });
    expect(fixture.gl.nativeUploadCount).toBe(1);
    expect(fixture.gl.rgbaUploadCount).toBe(1);
    expect(fixture.gl.presentationUploadKinds).toEqual(["rgba-copy"]);
    expect(readback.state.creations).toBe(1);
    expect(readback.state.drawCalls).toHaveLength(1);

    await renderer.draw(candidate, false);
    expect(readback.state.drawCalls).toHaveLength(1);
    expect(fixture.gl.nativeUploadCount).toBe(2);
  });

  it("locks and reuses bounded Canvas readback after a native mismatch", async () => {
    const fixture = webglCanvas(48, 48);
    fixture.gl.nativeReadback = blackProbePixels();
    fixture.gl.rgbaReadback = informativeProbePixels();
    const readback = rgbaReadbackFixture();
    const renderer = new Renderer(fixture.canvas, compactOpaqueLayout(), {
      createCanvas: readback.createCanvas
    });
    const candidate = compactOpaqueFrame(() => Promise.reject(
      new TypeError("layout size is invalid")
    ));

    await renderer.draw(candidate, false);
    await renderer.draw(candidate, false);

    expect(webGlDetails(renderer).uploadMode).toBe("rgba-copy");
    expect(fixture.gl.nativeUploadCount).toBe(1);
    expect(fixture.gl.rgbaUploadCount).toBe(2);
    expect(fixture.gl.presentationUploadKinds).toEqual([
      "rgba-copy",
      "rgba-copy"
    ]);
    expect(readback.state.creations).toBe(1);
    expect(readback.state.drawCalls).toHaveLength(2);
  });

  it("reports Canvas readback failure without preserving a provisional copy error", async () => {
    const fixture = webglCanvas();
    fixture.gl.rejectNativeUpload = true;
    const copyReason = new TypeError("layout size is invalid");
    const readbackReason = new DOMException(
      "decoded frame cannot be read from Canvas2D",
      "InvalidStateError"
    );
    const readback = rgbaReadbackFixture();
    readback.state.readError = readbackReason;
    const renderer = new Renderer(fixture.canvas, layout(), {
      createCanvas: readback.createCanvas
    });

    await expect(renderer.draw(frame(() => Promise.reject(copyReason)), false))
      .rejects.toMatchObject({
        diagnostic: {
          phase: "rgba-copy",
          uploadPath: "rgba-copy",
          exception: {
            name: "InvalidStateError",
            message: "decoded frame cannot be read from Canvas2D"
          }
        }
      });
  });

  it("maps a materialized Canvas source upload failure to RGBA upload", async () => {
    const fixture = webglCanvas();
    fixture.gl.rejectNativeUpload = true;
    fixture.gl.rgbaUploadError = 0x0505;
    const readback = rgbaReadbackFixture();
    const renderer = new Renderer(fixture.canvas, layout(), {
      createCanvas: readback.createCanvas
    });

    await expect(renderer.draw(frame(() => {
      throw new TypeError("layout size is invalid");
    }), false)).rejects.toMatchObject({
      diagnostic: {
        phase: "rgba-upload",
        uploadPath: "rgba-copy",
        glError: 0x0505
      }
    });
  });

  it("keeps a raw copy visible until it settles after a terminal timeout", async () => {
    const fixture = webglCanvas();
    fixture.gl.rejectNativeUpload = true;
    const pending = deferred<readonly PlaneLayout[]>();
    let expire = (): void => undefined;
    const renderer = new Renderer(fixture.canvas, layout(), {
      setTimeout: (callback) => {
        expire = callback;
        return 1;
      },
      clearTimeout: () => undefined,
      copyTimeoutMs: 1
    });
    const drawing = renderer.draw(frame(() => pending.promise), false);
    await eventually(() => renderer.snapshot().sourceCopiesInFlight === 1);

    expire();
    await expect(drawing).rejects.toMatchObject({
      diagnostic: {
        phase: "rgba-copy",
        exception: { name: "TimeoutError" }
      }
    });
    pending.resolve([{ offset: 0, stride: 48 * 4 }]);
    await eventually(() => renderer.snapshot().sourceCopiesInFlight === 0);
    expect(renderer.snapshot().sourceCopiesInFlight).toBe(0);
  });

  it("keeps the first frame correct and selects RGBA after silent native corruption", async () => {
    const fixture = webglCanvas(48, 48);
    fixture.gl.nativeReadback = blackProbePixels();
    fixture.gl.rgbaReadback = informativeProbePixels();
    const renderer = new Renderer(fixture.canvas, compactOpaqueLayout());

    await expect(renderer.draw(compactOpaqueFrame(), false)).resolves.toBeUndefined();

    expect(fixture.gl.nativeUploadCount).toBe(1);
    expect(fixture.gl.rgbaUploadCount).toBe(1);
    expect(fixture.gl.readPixelsCount).toBe(2);
    expect(fixture.gl.presentationUploadKinds).toEqual(["rgba-copy"]);
    expect(renderer.snapshot()).toMatchObject({
      backendDetails: {
        kind: "webgl2",
        uploadMode: "rgba-copy",
        nativeProbeAttempts: 1,
        probeReadbackBytes: 8 * 8 * 4 * 2,
        nativeProbeInFlight: false
      }
    });

    await renderer.draw(compactOpaqueFrame(), false);
    expect(fixture.gl.nativeUploadCount).toBe(1);
    expect(fixture.gl.rgbaUploadCount).toBe(2);
    expect(fixture.gl.presentationUploadKinds).toEqual([
      "rgba-copy",
      "rgba-copy"
    ]);
  });

  it("rejects a native mismatch even when the RGBA reference is uninformative", async () => {
    const fixture = webglCanvas(48, 48);
    fixture.gl.nativeReadback = informativeProbePixels();
    fixture.gl.rgbaReadback = blackProbePixels();
    const renderer = new Renderer(fixture.canvas, compactOpaqueLayout());

    await renderer.draw(compactOpaqueFrame(), false);

    expect(renderer.snapshot()).toMatchObject({
      backendDetails: {
        kind: "webgl2",
        uploadMode: "rgba-copy",
        nativeProbeAttempts: 1,
        nativeProbeInFlight: false
      }
    });
    expect(fixture.gl.presentationUploadKinds).toEqual(["rgba-copy"]);

    await renderer.draw(compactOpaqueFrame(), false);
    expect(fixture.gl.nativeUploadCount).toBe(1);
    expect(fixture.gl.rgbaUploadCount).toBe(2);
  });

  it("selects RGBA permanently when native probe readback reports a GL error", async () => {
    const fixture = webglCanvas(48, 48);
    fixture.gl.nextProbeReadError = 0x0502;
    const renderer = new Renderer(fixture.canvas, compactOpaqueLayout());

    await renderer.draw(compactOpaqueFrame(), false);

    expect(renderer.snapshot()).toMatchObject({
      backendDetails: {
        kind: "webgl2",
        uploadMode: "rgba-copy",
        nativeProbeAttempts: 1,
        nativeProbeInFlight: false
      }
    });
    expect(fixture.gl.presentationUploadKinds).toEqual(["rgba-copy"]);

    await renderer.draw(compactOpaqueFrame(), false);
    expect(fixture.gl.nativeUploadCount).toBe(1);
    expect(fixture.gl.rgbaUploadCount).toBe(2);
    expect(fixture.gl.readPixelsCount).toBe(1);
  });

  it("falls back permanently when a later proven native upload reports a GL error", async () => {
    const fixture = webglCanvas(48, 48);
    const pixels = informativeProbePixels();
    fixture.gl.nativeReadback = pixels;
    fixture.gl.rgbaReadback = pixels;
    const renderer = new Renderer(fixture.canvas, compactOpaqueLayout());

    await renderer.draw(compactOpaqueFrame(), false);
    expect(renderer.snapshot()).toMatchObject({
      backendDetails: {
        kind: "webgl2",
        uploadMode: "native",
        nativeProbeAttempts: 1
      }
    });
    expect(fixture.gl.presentationUploadKinds).toEqual(["rgba-copy"]);

    fixture.gl.nextNativeUploadError = 0x0502;
    await renderer.draw(compactOpaqueFrame(), false);
    await renderer.draw(compactOpaqueFrame(), false);

    expect(webGlDetails(renderer).uploadMode).toBe("rgba-copy");
    expect(fixture.gl.nativeUploadCount).toBe(2);
    expect(fixture.gl.rgbaUploadCount).toBe(3);
    expect(fixture.gl.readPixelsCount).toBe(2);
    expect(fixture.gl.presentationUploadKinds).toEqual([
      "rgba-copy",
      "rgba-copy",
      "rgba-copy"
    ]);
  });

  it("uses the exact premultiplied probe tolerances", async () => {
    const within = webglCanvas(48, 48);
    const reference = informativeProbePixels();
    reference[3] = 0;
    const native = reference.slice();
    native[0] = 255;
    native[1] = 255;
    native[2] = 255;
    native[4] = (reference[4] ?? 0) + 3;
    native[7] = (reference[7] ?? 0) - 1;
    within.gl.nativeReadback = native;
    within.gl.rgbaReadback = reference;
    const accepted = new Renderer(within.canvas, compactOpaqueLayout());

    await accepted.draw(compactOpaqueFrame(), false);
    expect(webGlDetails(accepted).uploadMode).toBe("native");

    const outside = webglCanvas(48, 48);
    const mismatched = reference.slice();
    mismatched[4] = (reference[4] ?? 0) + 4;
    outside.gl.nativeReadback = mismatched;
    outside.gl.rgbaReadback = reference;
    const rejected = new Renderer(outside.canvas, compactOpaqueLayout());

    await rejected.draw(compactOpaqueFrame(), false);
    expect(webGlDetails(rejected).uploadMode).toBe("rgba-copy");
  });

  it("bounds uninformative native qualification and resets only after restore", async () => {
    const fixture = webglCanvas(48, 48);
    fixture.gl.nativeReadback = blackProbePixels();
    fixture.gl.rgbaReadback = blackProbePixels();
    const renderer = new Renderer(fixture.canvas, compactOpaqueLayout());

    await renderer.draw(compactOpaqueFrame(), false);
    await renderer.draw(compactOpaqueFrame(), false);
    expect(renderer.snapshot()).toMatchObject({
      backendDetails: {
        kind: "webgl2",
        uploadMode: "native-probing",
        nativeProbeAttempts: 2
      }
    });
    await renderer.draw(compactOpaqueFrame(), false);
    expect(renderer.snapshot()).toMatchObject({
      backendDetails: {
        kind: "webgl2",
        uploadMode: "rgba-copy",
        nativeProbeAttempts: 3
      }
    });
    await renderer.draw(compactOpaqueFrame(), false);
    expect(fixture.gl.nativeUploadCount).toBe(3);
    expect(fixture.gl.readPixelsCount).toBe(6);

    fixture.dispatch("webglcontextlost");
    expect(renderer.snapshot()).toMatchObject({
      backendDetails: {
        kind: "webgl2",
        uploadMode: "rgba-copy",
        nativeProbeAttempts: 3,
        probeReadbackBytes: 0,
        nativeProbeInFlight: false
      }
    });
    fixture.dispatch("webglcontextrestored");
    await renderer.settled();
    expect(renderer.snapshot()).toMatchObject({
      backendDetails: {
        kind: "webgl2",
        uploadMode: "native-probing",
        nativeProbeAttempts: 0,
        probeReadbackBytes: 8 * 8 * 4 * 2,
        nativeProbeInFlight: false
      }
    });
  });

  it("releases qualification accounting when context loss interrupts a copy", async () => {
    const fixture = webglCanvas(48, 48);
    const copy = deferred<readonly PlaneLayout[]>();
    const renderer = new Renderer(fixture.canvas, compactOpaqueLayout());
    const drawing = renderer.draw(compactOpaqueFrame(() => copy.promise), false);
    await eventually(() => webGlDetails(renderer).nativeProbeInFlight);

    fixture.dispatch("webglcontextlost");
    expect(renderer.snapshot()).toMatchObject({
      backendDetails: {
        kind: "webgl2",
        uploadMode: "native-probing",
        nativeProbeAttempts: 1,
        probeReadbackBytes: 0,
        nativeProbeInFlight: false
      },
      failure: null
    });
    copy.resolve([{ offset: 0, stride: 48 * 4 }]);
    await expect(drawing).rejects.toMatchObject({ name: "AbortError" });
    expect(renderer.snapshot().sourceCopiesInFlight).toBe(0);

    fixture.dispatch("webglcontextrestored");
    await renderer.settled();
    expect(renderer.snapshot()).toMatchObject({
      backendDetails: {
        kind: "webgl2",
        uploadMode: "native-probing",
        nativeProbeAttempts: 0,
        probeReadbackBytes: 8 * 8 * 4 * 2,
        nativeProbeInFlight: false
      },
      failure: null
    });
  });

  it.each([
    [layout(), 96, 208],
    [opaqueLayout(), 1_280, 720]
  ] as const)(
    "accepts a frame whose display dimensions preserve the authored aspect",
    async (renderLayout, displayWidth, displayHeight) => {
      const fixture = webglCanvas(renderLayout.storageWidth, renderLayout.storageHeight);
      const renderer = new Renderer(fixture.canvas, renderLayout);

      await expect(renderer.draw(frameWithGeometry(
        renderLayout,
        displayWidth,
        displayHeight
      ), false)).resolves.toBeUndefined();
      renderer.dispose();
    }
  );

  it("rejects a near-miss display aspect without weakening visible storage", async () => {
    const renderLayout = opaqueLayout();
    const fixture = webglCanvas(renderLayout.storageWidth, renderLayout.storageHeight);
    const renderer = new Renderer(fixture.canvas, renderLayout);

    await expect(renderer.draw(frameWithGeometry(
      renderLayout,
      1_279,
      720
    ), false)).rejects.toThrow("decoded frame geometry is invalid");
  });

  it("applies exact initial presentation backing before resource admission", () => {
    const fixture = webglCanvas();
    const renderer = new Renderer(fixture.canvas, layout(), {
      initialPresentation: { width: 20, height: 10, dpr: 2, fit: "cover" }
    });

    expect(renderer.snapshot()).toMatchObject({
      cssWidth: 20,
      cssHeight: 10,
      backingWidth: 40,
      backingHeight: 20,
      effectiveDprX: 2,
      effectiveDprY: 2
    });
    renderer.dispose();
  });

  it("rotates three streaming textures and accounts for every allocation", async () => {
    const fixture = webglCanvas();
    const renderer = new Renderer(fixture.canvas, layout());
    for (let index = 0; index < 4; index += 1) await renderer.draw(frame(), false);

    expect(fixture.gl.drawnTextures).toEqual([
      fixture.gl.createdTextures[0],
      fixture.gl.createdTextures[1],
      fixture.gl.createdTextures[2],
      fixture.gl.createdTextures[0]
    ]);
    expect(renderer.snapshot()).toMatchObject({
      textureBytes: Math.ceil(48 * 112 * 4 * 3 * 5 / 4),
      resourceCount: 4,
      backendDetails: {
        kind: "webgl2",
        probeReadbackBytes: 0
      },
      sourceCopiesInFlight: 0
    });
  });

  it("admits the exact rounded GPU allocation boundary", () => {
    const textureBytes = Math.ceil(48 * 112 * 4 * 3 * 5 / 4);
    const stagingBytes = 48 * 104 * 4;
    const ownedBackingBytes = Math.ceil(stagingBytes * 5 / 4);
    const admittedBackingBytes = Math.ceil(stagingBytes * 2 * 5 / 4);
    const probeReadbackBytes = 0;
    const ownedRuntimeBytes = textureBytes + ownedBackingBytes + stagingBytes +
      probeReadbackBytes;
    const admittedRuntimeBytes = textureBytes + admittedBackingBytes +
      stagingBytes * 2 + probeReadbackBytes;
    const exact = new Renderer(webglCanvas().canvas, layout(), {
      maxTextureBytes: textureBytes,
      maxBackingBytes: admittedBackingBytes,
      maxRuntimeBytes: admittedRuntimeBytes
    });
    expect(exact.snapshot()).toMatchObject({
      textureBytes,
      backendDetails: { kind: "webgl2", probeReadbackBytes },
      runtimeBytes: ownedRuntimeBytes
    });
    expect(exact.admit(0)).toEqual({
      textureBytes,
      runtimeBytes: admittedRuntimeBytes
    });
    exact.dispose();

    expect(() => new Renderer(webglCanvas().canvas, layout(), {
      maxTextureBytes: textureBytes - 1,
      maxBackingBytes: admittedBackingBytes,
      maxRuntimeBytes: admittedRuntimeBytes
    })).toThrow(/resource byte cap/u);
    expect(() => new Renderer(webglCanvas().canvas, layout(), {
      maxTextureBytes: textureBytes,
      maxBackingBytes: admittedBackingBytes - 1,
      maxRuntimeBytes: admittedRuntimeBytes
    })).toThrow(/resource byte cap/u);
    expect(() => new Renderer(webglCanvas().canvas, layout(), {
      maxTextureBytes: textureBytes,
      maxBackingBytes: admittedBackingBytes,
      maxRuntimeBytes: admittedRuntimeBytes - 1
    })).toThrow(/resource byte cap/u);
  });

  it("restores exact canvas state after failed admission before a later candidate", () => {
    const fixture = webglCanvas();
    const original = [fixture.canvas.width, fixture.canvas.height];
    expect(() => new Renderer(fixture.canvas, layout(), {
      initialPresentation: { width: 20, height: 10, dpr: 2, fit: "contain" },
      maxBackingBytes: 1
    })).toThrow(/resource byte cap/u);
    expect([fixture.canvas.width, fixture.canvas.height]).toEqual(original);

    const second = new Renderer(fixture.canvas, layout(), {
      initialPresentation: { width: 30, height: 12, dpr: 2, fit: "cover" }
    });
    expect([fixture.canvas.width, fixture.canvas.height]).toEqual([60, 24]);
    second.dispose();

    const terminal = webglCanvas();
    const terminalOriginal = [terminal.canvas.width, terminal.canvas.height];
    expect(() => new Renderer(terminal.canvas, layout(), {
      initialPresentation: { width: 99, height: 77, dpr: 1, fit: "fill" },
      maxRuntimeBytes: 1
    })).toThrow(/resource byte cap/u);
    expect([terminal.canvas.width, terminal.canvas.height]).toEqual(terminalOriginal);
  });

  it("does not relabel a polled draw failure as an actual context event", async () => {
    const fixture = webglCanvas();
    const changes: unknown[] = [];
    const renderer = new Renderer(fixture.canvas, layout(), {
      onContextChange: (change) => changes.push(change)
    });
    fixture.gl.loseOnDraw = true;

    let rejected!: RendererFailureError;
    try { await renderer.draw(frame(), false); }
    catch (error) { rejected = error as RendererFailureError; }
    await Promise.resolve();

    expect(rejected).toBeInstanceOf(RendererFailureError);
    expect(rejected.diagnostic).toMatchObject({
      operation: "runtime",
      phase: "draw",
      contextLost: true
    });
    expect(changes).toEqual([{ state: "error", error: rejected }]);
    expect(renderer.snapshot()).toMatchObject({
      contextLossCount: 0,
      textureBytes: 0,
      resourceCount: 0
    });
  });

  it("does not relabel exact viewport arithmetic as a GL failure", async () => {
    const fixture = webglCanvas();
    const renderer = new Renderer(fixture.canvas, layout(), {
      initialPresentation: { width: 48, height: 104, dpr: 1, fit: "fill" }
    });
    fixture.canvas.width = 9_000;

    await expect(renderer.draw(frame(), false)).rejects.toBeInstanceOf(RangeError);
    expect(renderer.snapshot().failure).toBeNull();
    renderer.dispose();
  });

  it("keeps an unresolved raw frame copy visible after disposal", async () => {
    const fixture = webglCanvas(48, 48);
    const copy = deferred<readonly PlaneLayout[]>();
    const renderer = new Renderer(fixture.canvas, compactOpaqueLayout());
    const drawing = renderer.draw(compactOpaqueFrame(() => copy.promise), false);
    await eventually(() =>
      renderer.snapshot().sourceCopiesInFlight === 1 &&
      webGlDetails(renderer).nativeProbeInFlight);

    expect(renderer.snapshot()).toMatchObject({
      sourceCopiesInFlight: 1,
      backendDetails: {
        kind: "webgl2",
        nativeProbeInFlight: true,
        probeReadbackBytes: 8 * 8 * 4 * 2
      }
    });
    renderer.dispose();
    expect(renderer.snapshot()).toMatchObject({
      sourceCopiesInFlight: 1,
      backendDetails: {
        kind: "webgl2",
        nativeProbeInFlight: false,
        probeReadbackBytes: 0
      },
      runtimeBytes: 0,
      resourceCount: 0
    });
    copy.resolve([{ offset: 0, stride: 48 * 4 }]);
    await expect(drawing).rejects.toMatchObject({ name: "AbortError" });
    expect(renderer.snapshot().sourceCopiesInFlight).toBe(0);
  });
});

function canvas(): HTMLCanvasElement {
  return {
    width: 1,
    height: 1,
    addEventListener() {},
    removeEventListener() {},
    getContext() { throw new Error("WebGL2 is unavailable"); }
  } as unknown as HTMLCanvasElement;
}

function canvas2dOnlyFixture(): Readonly<{
  canvas: HTMLCanvasElement;
  createCanvas: (width: number, height: number) => HTMLCanvasElement;
  outputRequests: string[];
}> {
  const outputRequests: string[] = [];
  const makeCanvas = (
    width: number,
    height: number,
    recordRequests: boolean
  ): HTMLCanvasElement => {
    const context = {
      imageSmoothingEnabled: false,
      imageSmoothingQuality: "high",
      globalCompositeOperation: "source-over"
    } as unknown as CanvasRenderingContext2D;
    return {
      width,
      height,
      addEventListener() {},
      removeEventListener() {},
      getContext(type: string) {
        if (recordRequests) outputRequests.push(type);
        return type === "2d" ? context : null;
      }
    } as unknown as HTMLCanvasElement;
  };
  return {
    canvas: makeCanvas(48, 104, true),
    createCanvas: (width, height) => makeCanvas(width, height, false),
    outputRequests
  };
}

function webGlDetails(
  renderer: Renderer
): Extract<RendererBackendDetails, { readonly kind: "webgl2" }> {
  const details = renderer.snapshot().backendDetails;
  if (details.kind !== "webgl2") {
    throw new Error("renderer did not select WebGL2");
  }
  return details;
}

function expectRendererFailure(
  operation: () => unknown,
  expected: Readonly<Record<string, unknown>>
): RendererFailureError {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(RendererFailureError);
    const failure = error as RendererFailureError;
    expect(failure.diagnostic).toMatchObject(expected);
    return failure;
  }
  throw new Error("renderer operation did not fail");
}

function expectDeeplyFrozen(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  expect(Object.isFrozen(value)).toBe(true);
  for (const nested of Object.values(value)) expectDeeplyFrozen(nested, seen);
}

function deferred<T>(): Readonly<{
  promise: Promise<T>;
  resolve(value: T): void;
}> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return Object.freeze({ promise, resolve });
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error("condition did not become true");
}
