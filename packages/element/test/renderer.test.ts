import { describe, expect, it } from "vitest";

import {
  deriveVideoRenditionGeometry,
  PACKED_ALPHA_GUTTER
} from "@pixel-point/aval-format";

import {
  Renderer,
  type RenderLayout
} from "../src/renderer.js";
import { deriveRenderLayout } from "../src/renderer-geometry.js";
import { RendererFailureError } from "../src/renderer-diagnostics.js";

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
      backend: "canvas2d",
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
    try { await renderer.store("group", 0, frame()); }
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
      await renderer.draw(frame(async () => Promise.reject(reason)));
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
  it("qualifies native upload against ImageBitmap when RGBA copy is unsupported", async () => {
    const fixture = webglCanvas();
    const pixels = informativeProbePixels();
    fixture.gl.nativeReadback = pixels;
    fixture.gl.rgbaReadback = pixels;
    const created: TestImageBitmap[] = [];
    const candidate = frame(() => {
      throw new TypeError("layout size is invalid");
    });
    const renderer = new Renderer(fixture.canvas, layout(), {
      createImageBitmap: async (source, sx, sy, sw, sh, options) => {
        expect([source, sx, sy, sw, sh, options]).toEqual([
          candidate, 0, 0, 48, 104,
          { resizeWidth: 48, resizeHeight: 104 }
        ]);
        const bitmap = testImageBitmap();
        created.push(bitmap);
        return bitmap;
      }
    });

    await renderer.draw(candidate);

    expect(renderer.snapshot()).toMatchObject({
      uploadMode: "native",
      nativeProbeAttempts: 1,
      sourceCopiesInFlight: 0
    });
    expect(fixture.gl.nativeUploadCount).toBe(1);
    expect(fixture.gl.rgbaUploadCount).toBe(1);
    expect(fixture.gl.presentationUploadKinds).toEqual(["rgba-copy"]);
    expect(created.map((bitmap) => bitmap.closeCount)).toEqual([1]);

    await renderer.draw(candidate);
    expect(created).toHaveLength(1);
    expect(fixture.gl.nativeUploadCount).toBe(2);
  });

  it("maps ImageBitmap fallback through display space into packed storage", async () => {
    const fixture = webglCanvas();
    fixture.gl.rejectNativeUpload = true;
    const candidate = frame(
      () => Promise.reject(new TypeError("layout size is invalid")),
      96,
      208
    );
    const bitmap = testImageBitmap();
    const renderer = new Renderer(fixture.canvas, layout(), {
      createImageBitmap: async (source, sx, sy, sw, sh, options) => {
        expect([source, sx, sy, sw, sh, options]).toEqual([
          candidate, 0, 0, 96, 208,
          { resizeWidth: 48, resizeHeight: 104 }
        ]);
        return bitmap;
      }
    });

    await renderer.draw(candidate);

    expect(fixture.gl.rgbaUploadCount).toBe(1);
    expect(bitmap.closeCount).toBe(1);
  });

  it("locks and releases ImageBitmap fallback after a native mismatch", async () => {
    const fixture = webglCanvas();
    fixture.gl.nativeReadback = blackProbePixels();
    fixture.gl.rgbaReadback = informativeProbePixels();
    const created: TestImageBitmap[] = [];
    const renderer = new Renderer(fixture.canvas, layout(), {
      createImageBitmap: async () => {
        const bitmap = testImageBitmap();
        created.push(bitmap);
        return bitmap;
      }
    });
    const candidate = frame(() => Promise.reject(
      new TypeError("layout size is invalid")
    ));

    await renderer.draw(candidate);
    await renderer.draw(candidate);

    expect(renderer.snapshot().uploadMode).toBe("rgba-copy");
    expect(fixture.gl.nativeUploadCount).toBe(1);
    expect(fixture.gl.rgbaUploadCount).toBe(2);
    expect(fixture.gl.presentationUploadKinds).toEqual([
      "rgba-copy",
      "rgba-copy"
    ]);
    expect(created.map((bitmap) => bitmap.closeCount)).toEqual([1, 1]);
  });

  it("reports ImageBitmap conversion failure without preserving a provisional copy error", async () => {
    const fixture = webglCanvas();
    fixture.gl.rejectNativeUpload = true;
    const copyReason = new TypeError("layout size is invalid");
    const bitmapReason = new DOMException(
      "decoded frame cannot become an ImageBitmap",
      "InvalidStateError"
    );
    const renderer = new Renderer(fixture.canvas, layout(), {
      createImageBitmap: async () => Promise.reject(bitmapReason)
    });

    await expect(renderer.draw(frame(() => Promise.reject(copyReason))))
      .rejects.toMatchObject({
        diagnostic: {
          phase: "rgba-copy",
          uploadPath: "rgba-copy",
          exception: {
            name: "InvalidStateError",
            message: "decoded frame cannot become an ImageBitmap"
          }
        }
      });
  });

  it("closes ImageBitmap when its WebGL upload fails", async () => {
    const fixture = webglCanvas();
    fixture.gl.rejectNativeUpload = true;
    fixture.gl.rgbaUploadError = 0x0505;
    const bitmap = testImageBitmap();
    const renderer = new Renderer(fixture.canvas, layout(), {
      createImageBitmap: async () => bitmap
    });

    await expect(renderer.draw(frame(() => {
      throw new TypeError("layout size is invalid");
    }))).rejects.toMatchObject({
      diagnostic: {
        phase: "rgba-upload",
        uploadPath: "rgba-copy",
        glError: 0x0505
      }
    });
    expect(bitmap.closeCount).toBe(1);
  });

  it("closes an ImageBitmap that resolves after conversion timeout", async () => {
    const fixture = webglCanvas();
    fixture.gl.rejectNativeUpload = true;
    const pending = deferred<ImageBitmap>();
    let expire = (): void => undefined;
    const bitmap = testImageBitmap();
    const renderer = new Renderer(fixture.canvas, layout(), {
      createImageBitmap: async () => pending.promise,
      setTimeout: (callback) => {
        expire = callback;
        return 1;
      },
      clearTimeout: () => undefined,
      copyTimeoutMs: 1
    });
    const drawing = renderer.draw(frame(() => {
      throw new TypeError("layout size is invalid");
    }));
    await eventually(() => renderer.snapshot().sourceCopiesInFlight === 1);

    expire();
    await expect(drawing).rejects.toMatchObject({
      diagnostic: {
        phase: "rgba-copy",
        exception: { name: "TimeoutError" }
      }
    });
    pending.resolve(bitmap);
    await eventually(() => bitmap.closeCount === 1);
    expect(renderer.snapshot().sourceCopiesInFlight).toBe(0);
  });

  it("keeps the first frame correct and selects RGBA after silent native corruption", async () => {
    const fixture = webglCanvas();
    fixture.gl.nativeReadback = blackProbePixels();
    fixture.gl.rgbaReadback = informativeProbePixels();
    const renderer = new Renderer(fixture.canvas, layout());

    await expect(renderer.draw(frame())).resolves.toBeUndefined();

    expect(fixture.gl.nativeUploadCount).toBe(1);
    expect(fixture.gl.rgbaUploadCount).toBe(1);
    expect(fixture.gl.readPixelsCount).toBe(2);
    expect(fixture.gl.presentationUploadKinds).toEqual(["rgba-copy"]);
    expect(renderer.snapshot()).toMatchObject({
      uploadMode: "rgba-copy",
      nativeProbeAttempts: 1,
      probeReadbackBytes: 8 * 8 * 4 * 2,
      nativeProbeInFlight: false
    });

    await renderer.draw(frame());
    expect(fixture.gl.nativeUploadCount).toBe(1);
    expect(fixture.gl.rgbaUploadCount).toBe(2);
    expect(fixture.gl.presentationUploadKinds).toEqual([
      "rgba-copy",
      "rgba-copy"
    ]);
  });

  it("rejects a native mismatch even when the RGBA reference is uninformative", async () => {
    const fixture = webglCanvas();
    fixture.gl.nativeReadback = informativeProbePixels();
    fixture.gl.rgbaReadback = blackProbePixels();
    const renderer = new Renderer(fixture.canvas, layout());

    await renderer.draw(frame());

    expect(renderer.snapshot()).toMatchObject({
      uploadMode: "rgba-copy",
      nativeProbeAttempts: 1,
      nativeProbeInFlight: false
    });
    expect(fixture.gl.presentationUploadKinds).toEqual(["rgba-copy"]);

    await renderer.draw(frame());
    expect(fixture.gl.nativeUploadCount).toBe(1);
    expect(fixture.gl.rgbaUploadCount).toBe(2);
  });

  it("selects RGBA permanently when native probe readback reports a GL error", async () => {
    const fixture = webglCanvas();
    fixture.gl.nextProbeReadError = 0x0502;
    const renderer = new Renderer(fixture.canvas, layout());

    await renderer.draw(frame());

    expect(renderer.snapshot()).toMatchObject({
      uploadMode: "rgba-copy",
      nativeProbeAttempts: 1,
      nativeProbeInFlight: false
    });
    expect(fixture.gl.presentationUploadKinds).toEqual(["rgba-copy"]);

    await renderer.draw(frame());
    expect(fixture.gl.nativeUploadCount).toBe(1);
    expect(fixture.gl.rgbaUploadCount).toBe(2);
    expect(fixture.gl.readPixelsCount).toBe(1);
  });

  it("falls back permanently when a later proven native upload reports a GL error", async () => {
    const fixture = webglCanvas();
    const pixels = informativeProbePixels();
    fixture.gl.nativeReadback = pixels;
    fixture.gl.rgbaReadback = pixels;
    const renderer = new Renderer(fixture.canvas, layout());

    await renderer.draw(frame());
    expect(renderer.snapshot()).toMatchObject({
      uploadMode: "native",
      nativeProbeAttempts: 1
    });
    expect(fixture.gl.presentationUploadKinds).toEqual(["rgba-copy"]);

    fixture.gl.nextNativeUploadError = 0x0502;
    await renderer.draw(frame());
    await renderer.draw(frame());

    expect(renderer.snapshot().uploadMode).toBe("rgba-copy");
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
    const within = webglCanvas();
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
    const accepted = new Renderer(within.canvas, layout());

    await accepted.draw(frame());
    expect(accepted.snapshot().uploadMode).toBe("native");

    const outside = webglCanvas();
    const mismatched = reference.slice();
    mismatched[4] = (reference[4] ?? 0) + 4;
    outside.gl.nativeReadback = mismatched;
    outside.gl.rgbaReadback = reference;
    const rejected = new Renderer(outside.canvas, layout());

    await rejected.draw(frame());
    expect(rejected.snapshot().uploadMode).toBe("rgba-copy");
  });

  it("bounds uninformative native qualification and resets only after restore", async () => {
    const fixture = webglCanvas();
    fixture.gl.nativeReadback = blackProbePixels();
    fixture.gl.rgbaReadback = blackProbePixels();
    const renderer = new Renderer(fixture.canvas, layout());

    await renderer.draw(frame());
    await renderer.draw(frame());
    expect(renderer.snapshot()).toMatchObject({
      uploadMode: "native-probing",
      nativeProbeAttempts: 2
    });
    await renderer.draw(frame());
    expect(renderer.snapshot()).toMatchObject({
      uploadMode: "rgba-copy",
      nativeProbeAttempts: 3
    });
    await renderer.draw(frame());
    expect(fixture.gl.nativeUploadCount).toBe(3);
    expect(fixture.gl.readPixelsCount).toBe(6);

    fixture.dispatch("webglcontextlost");
    expect(renderer.snapshot()).toMatchObject({
      uploadMode: "rgba-copy",
      nativeProbeAttempts: 3,
      probeReadbackBytes: 0,
      nativeProbeInFlight: false
    });
    fixture.dispatch("webglcontextrestored");
    await renderer.settled();
    expect(renderer.snapshot()).toMatchObject({
      uploadMode: "native-probing",
      nativeProbeAttempts: 0,
      probeReadbackBytes: 8 * 8 * 4 * 2,
      nativeProbeInFlight: false
    });
  });

  it("releases qualification accounting when context loss interrupts a copy", async () => {
    const fixture = webglCanvas();
    const copy = deferred<readonly PlaneLayout[]>();
    const renderer = new Renderer(fixture.canvas, layout());
    const drawing = renderer.draw(frame(() => copy.promise));
    await eventually(() => renderer.snapshot().nativeProbeInFlight);

    fixture.dispatch("webglcontextlost");
    expect(renderer.snapshot()).toMatchObject({
      uploadMode: "native-probing",
      nativeProbeAttempts: 1,
      probeReadbackBytes: 0,
      nativeProbeInFlight: false,
      failure: null
    });
    copy.resolve([{ offset: 0, stride: 48 * 4 }]);
    await expect(drawing).rejects.toMatchObject({ name: "AbortError" });
    expect(renderer.snapshot().sourceCopiesInFlight).toBe(0);

    fixture.dispatch("webglcontextrestored");
    await renderer.settled();
    expect(renderer.snapshot()).toMatchObject({
      uploadMode: "native-probing",
      nativeProbeAttempts: 0,
      probeReadbackBytes: 8 * 8 * 4 * 2,
      nativeProbeInFlight: false,
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
      ))).resolves.toBeUndefined();
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
    ))).rejects.toThrow("decoded frame geometry is invalid");
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
    for (let index = 0; index < 4; index += 1) await renderer.draw(frame());

    expect(fixture.gl.drawnTextures).toEqual([
      fixture.gl.createdTextures[0],
      fixture.gl.createdTextures[1],
      fixture.gl.createdTextures[2],
      fixture.gl.createdTextures[0]
    ]);
    expect(renderer.snapshot()).toMatchObject({
      textureBytes: Math.ceil(48 * 112 * 4 * 3 * 5 / 4),
      resourceCount: 4,
      probeReadbackBytes: 8 * 8 * 4 * 2,
      sourceCopiesInFlight: 0
    });
  });

  it("admits the exact rounded GPU allocation boundary", () => {
    const textureBytes = Math.ceil(48 * 112 * 4 * 3 * 5 / 4);
    const backingBytes = Math.ceil(48 * 104 * 4 * 5 / 4);
    const stagingBytes = 48 * 104 * 4;
    const probeReadbackBytes = 8 * 8 * 4 * 2;
    const runtimeBytes = textureBytes + backingBytes + stagingBytes +
      probeReadbackBytes;
    const exact = new Renderer(webglCanvas().canvas, layout(), {
      maxTextureBytes: textureBytes,
      maxBackingBytes: backingBytes,
      maxRuntimeBytes: runtimeBytes
    });
    expect(exact.snapshot()).toMatchObject({
      textureBytes,
      probeReadbackBytes,
      runtimeBytes
    });
    exact.dispose();

    expect(() => new Renderer(webglCanvas().canvas, layout(), {
      maxTextureBytes: textureBytes - 1,
      maxBackingBytes: backingBytes,
      maxRuntimeBytes: runtimeBytes
    })).toThrow(/resource byte cap/u);
    expect(() => new Renderer(webglCanvas().canvas, layout(), {
      maxTextureBytes: textureBytes,
      maxBackingBytes: backingBytes - 1,
      maxRuntimeBytes: runtimeBytes
    })).toThrow(/resource byte cap/u);
    expect(() => new Renderer(webglCanvas().canvas, layout(), {
      maxTextureBytes: textureBytes,
      maxBackingBytes: backingBytes,
      maxRuntimeBytes: runtimeBytes - 1
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
    try { await renderer.draw(frame()); }
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

    await expect(renderer.draw(frame())).rejects.toBeInstanceOf(RangeError);
    expect(renderer.snapshot().failure).toBeNull();
    renderer.dispose();
  });

  it("keeps an unresolved raw frame copy visible after disposal", async () => {
    const fixture = webglCanvas();
    const copy = deferred<readonly PlaneLayout[]>();
    const renderer = new Renderer(fixture.canvas, layout());
    const drawing = renderer.draw(frame(() => copy.promise));
    await eventually(() =>
      renderer.snapshot().sourceCopiesInFlight === 1 &&
      renderer.snapshot().nativeProbeInFlight);

    expect(renderer.snapshot()).toMatchObject({
      sourceCopiesInFlight: 1,
      nativeProbeInFlight: true,
      probeReadbackBytes: 8 * 8 * 4 * 2
    });
    renderer.dispose();
    expect(renderer.snapshot()).toMatchObject({
      sourceCopiesInFlight: 1,
      nativeProbeInFlight: false,
      probeReadbackBytes: 0,
      runtimeBytes: 0,
      resourceCount: 0
    });
    copy.resolve([{ offset: 0, stride: 48 * 4 }]);
    await expect(drawing).rejects.toMatchObject({ name: "AbortError" });
    expect(renderer.snapshot().sourceCopiesInFlight).toBe(0);
  });
});

function layout(): RenderLayout {
  return {
    codedWidth: 48,
    codedHeight: 112,
    storageWidth: 48,
    storageHeight: 104,
    logicalWidth: 47,
    logicalHeight: 47,
    pixelAspect: [3, 2],
    colorRect: [0, 0, 47, 47],
    alphaRect: [0, 56, 47, 47]
  };
}

function opaqueLayout(): RenderLayout {
  return {
    codedWidth: 640,
    codedHeight: 360,
    storageWidth: 640,
    storageHeight: 360,
    logicalWidth: 640,
    logicalHeight: 360,
    pixelAspect: [1, 1],
    colorRect: [0, 0, 640, 360]
  };
}

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

function frame(
  copy: () => Promise<readonly PlaneLayout[]> = async () => [
    { offset: 0, stride: 48 * 4 }
  ],
  displayWidth = 48,
  displayHeight = 104
): VideoFrame {
  return {
    codedWidth: 48,
    codedHeight: 112,
    displayWidth,
    displayHeight,
    visibleRect: { x: 0, y: 0, width: 48, height: 104 },
    copyTo: copy
  } as unknown as VideoFrame;
}

function frameWithGeometry(
  renderLayout: Readonly<RenderLayout>,
  displayWidth: number,
  displayHeight: number
): VideoFrame {
  const stride = renderLayout.storageWidth * 4;
  return {
    codedWidth: renderLayout.codedWidth,
    codedHeight: renderLayout.codedHeight,
    displayWidth,
    displayHeight,
    visibleRect: {
      x: 0,
      y: 0,
      width: renderLayout.storageWidth,
      height: renderLayout.storageHeight
    },
    copyTo: async () => [{ offset: 0, stride }]
  } as unknown as VideoFrame;
}

function webglCanvas(): Readonly<{
  canvas: HTMLCanvasElement;
  gl: TestGl;
  dispatch(type: "webglcontextlost" | "webglcontextrestored"): void;
}>;
function webglCanvas(width: number, height: number): Readonly<{
  canvas: HTMLCanvasElement;
  gl: TestGl;
  dispatch(type: "webglcontextlost" | "webglcontextrestored"): void;
}>;
function webglCanvas(width = 48, height = 104): Readonly<{
  canvas: HTMLCanvasElement;
  gl: TestGl;
  dispatch(type: "webglcontextlost" | "webglcontextrestored"): void;
}> {
  const gl = new TestGl();
  const listeners = new Map<string, EventListener>();
  const canvas = {
    width,
    height,
    addEventListener(type: string, listener: EventListener) {
      listeners.set(type, listener);
    },
    removeEventListener(type: string) { listeners.delete(type); },
    getContext() { return gl as unknown as WebGL2RenderingContext; }
  } as unknown as HTMLCanvasElement;
  const dispatch = (type: "webglcontextlost" | "webglcontextrestored"): void => {
    gl.contextLost = type === "webglcontextlost";
    const event = Object.freeze({ preventDefault() {} }) as unknown as Event;
    listeners.get(type)?.(event);
  };
  return Object.freeze({ canvas, gl, dispatch });
}

class TestGl {
  public readonly MAX_TEXTURE_SIZE = 1;
  public readonly MAX_ARRAY_TEXTURE_LAYERS = 2;
  public readonly MAX_VIEWPORT_DIMS = 3;
  public readonly VERTEX_SHADER = 4;
  public readonly FRAGMENT_SHADER = 5;
  public readonly COMPILE_STATUS = 6;
  public readonly LINK_STATUS = 7;
  public readonly TEXTURE_2D = 8;
  public readonly TEXTURE_MIN_FILTER = 9;
  public readonly TEXTURE_MAG_FILTER = 10;
  public readonly TEXTURE_WRAP_S = 11;
  public readonly TEXTURE_WRAP_T = 12;
  public readonly CLAMP_TO_EDGE = 13;
  public readonly LINEAR = 14;
  public readonly RGBA8 = 15;
  public readonly TEXTURE0 = 16;
  public readonly TRIANGLES = 17;
  public readonly COLOR_BUFFER_BIT = 18;
  public readonly NO_ERROR = 0;
  public readonly RGBA = 19;
  public readonly UNSIGNED_BYTE = 20;
  public readonly UNPACK_ALIGNMENT = 21;
  public readonly BLEND = 22;
  public readonly OUT_OF_MEMORY = 0x0505;

  public readonly createdTextures: WebGLTexture[] = [];
  public readonly drawnTextures: WebGLTexture[] = [];
  public rejectNativeUpload = false;
  public nativeReadback: Uint8Array = informativeProbePixels();
  public rgbaReadback: Uint8Array = informativeProbePixels();
  public nextNativeUploadError = 0;
  public nextProbeReadError = 0;
  public nativeUploadCount = 0;
  public rgbaUploadCount = 0;
  public readPixelsCount = 0;
  public readonly presentationUploadKinds: ("native" | "rgba-copy")[] = [];
  public loseOnDraw = false;
  public maxTextureSize = 8_192;
  public maxResidentTextures = 8_192;
  public maxViewportWidth = 8_192;
  public maxViewportHeight = 8_192;
  public programLinked = true;
  public programLinkError = 0;
  public deleteProgramError = 0;
  public storageError = 0;
  public rgbaUploadError = 0;
  public contextLost = false;
  #bound: WebGLTexture | null = null;
  #lastUploadKind: "native" | "rgba-copy" = "rgba-copy";
  #viewportWidth = 0;
  #viewportHeight = 0;
  #error = 0;
  #lost = false;

  public getParameter(parameter: number): number | readonly number[] {
    if (parameter === this.MAX_TEXTURE_SIZE) return this.maxTextureSize;
    if (parameter === this.MAX_ARRAY_TEXTURE_LAYERS) return this.maxResidentTextures;
    if (parameter === this.MAX_VIEWPORT_DIMS) {
      return [this.maxViewportWidth, this.maxViewportHeight];
    }
    return 8_192;
  }
  public getContextAttributes(): WebGLContextAttributes {
    return {
      alpha: true,
      antialias: false,
      depth: false,
      failIfMajorPerformanceCaveat: false,
      powerPreference: "default",
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
      stencil: false,
      diagnosticSecret: "must not escape"
    } as WebGLContextAttributes;
  }
  public getExtension(): null { return null; }
  public createShader(): WebGLShader { return {} as WebGLShader; }
  public shaderSource(): void {}
  public compileShader(): void {}
  public getShaderParameter(): boolean { return true; }
  public deleteShader(): void {}
  public createProgram(): WebGLProgram { return {} as WebGLProgram; }
  public attachShader(): void {}
  public linkProgram(): void {}
  public getProgramParameter(): boolean {
    if (!this.programLinked && this.programLinkError !== 0) {
      this.#error = this.programLinkError;
    }
    return this.programLinked;
  }
  public deleteProgram(): void {
    if (this.deleteProgramError !== 0) this.#error = this.deleteProgramError;
  }
  public createTexture(): WebGLTexture {
    const texture = { id: this.createdTextures.length } as unknown as WebGLTexture;
    this.createdTextures.push(texture);
    return texture;
  }
  public deleteTexture(): void {}
  public bindTexture(_target: number, texture: WebGLTexture | null): void {
    this.#bound = texture;
  }
  public texParameteri(): void {}
  public texStorage2D(): void {
    if (this.storageError !== 0) this.#error = this.storageError;
  }
  public texSubImage2D(...values: readonly unknown[]): void {
    if (values.length === 7) {
      if (isTestImageBitmap(values[6])) {
        this.#lastUploadKind = "rgba-copy";
        this.rgbaUploadCount += 1;
        if (this.rgbaUploadError !== 0) this.#error = this.rgbaUploadError;
      } else {
        this.#lastUploadKind = "native";
        this.nativeUploadCount += 1;
        if (this.rejectNativeUpload) this.#error = 1;
        if (this.nextNativeUploadError !== 0) {
          this.#error = this.nextNativeUploadError;
          this.nextNativeUploadError = 0;
        }
      }
    }
    if (values.length === 9) {
      this.#lastUploadKind = "rgba-copy";
      this.rgbaUploadCount += 1;
      if (this.rgbaUploadError !== 0) this.#error = this.rgbaUploadError;
    }
  }
  public getUniformLocation(): WebGLUniformLocation {
    return {} as WebGLUniformLocation;
  }
  public clearColor(): void {}
  public disable(): void {}
  public pixelStorei(): void {}
  public viewport(_x: number, _y: number, width: number, height: number): void {
    this.#viewportWidth = width;
    this.#viewportHeight = height;
  }
  public clear(): void {}
  public useProgram(): void {}
  public activeTexture(): void {}
  public uniform1i(): void {}
  public uniform1f(): void {}
  public uniform4f(): void {}
  public drawArrays(): void {
    const presentation = this.#viewportWidth !== 8 || this.#viewportHeight !== 8;
    if (this.#bound !== null && presentation) {
      this.drawnTextures.push(this.#bound);
      this.presentationUploadKinds.push(this.#lastUploadKind);
    }
    if (this.loseOnDraw && presentation) this.#lost = true;
  }
  public readPixels(
    _x: number,
    _y: number,
    _width: number,
    _height: number,
    _format: number,
    _type: number,
    target: Uint8Array
  ): void {
    this.readPixelsCount += 1;
    target.set(this.#lastUploadKind === "native"
      ? this.nativeReadback : this.rgbaReadback);
    if (this.nextProbeReadError !== 0) {
      this.#error = this.nextProbeReadError;
      this.nextProbeReadError = 0;
    }
  }
  public getError(): number {
    const error = this.#error;
    this.#error = 0;
    return error;
  }
  public isContextLost(): boolean { return this.#lost || this.contextLost; }
}

function blackProbePixels(): Uint8Array {
  return new Uint8Array(8 * 8 * 4);
}

function informativeProbePixels(): Uint8Array {
  const pixels = new Uint8Array(8 * 8 * 4);
  for (let sample = 0; sample < 8 * 8; sample += 1) {
    const offset = sample * 4;
    pixels[offset] = sample % 2 === 0 ? 48 : 160;
    pixels[offset + 1] = sample % 3 === 0 ? 32 : 96;
    pixels[offset + 2] = sample % 5 === 0 ? 16 : 80;
    pixels[offset + 3] = sample % 7 === 0 ? 96 : 255;
  }
  return pixels;
}

interface TestImageBitmap extends ImageBitmap {
  readonly __testImageBitmap: true;
  closeCount: number;
}

function testImageBitmap(width = 48, height = 104): TestImageBitmap {
  return {
    __testImageBitmap: true,
    width,
    height,
    closeCount: 0,
    close() { this.closeCount += 1; }
  } as TestImageBitmap;
}

function isTestImageBitmap(value: unknown): value is TestImageBitmap {
  return typeof value === "object" && value !== null &&
    (value as Readonly<{ __testImageBitmap?: unknown }>).__testImageBitmap === true;
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
