import { describe, expect, it } from "vitest";

import { deriveVideoRenditionGeometry } from "@pixel-point/aval-format";

import { Canvas2dRenderer } from "../src/canvas2d-renderer.js";
import { Renderer } from "../src/renderer.js";
import {
  calculateRendererViewport,
  deriveRenderLayout,
  type RenderLayout
} from "../src/renderer-geometry.js";
import { RendererFailureError } from "../src/renderer-diagnostics.js";

describe("Canvas2dRenderer packed-alpha presentation", () => {
  it("omits the low-latency hint from transparent output", () => {
    const fixture = canvasFixture();
    const renderer = new Canvas2dRenderer(
      htmlCanvas(fixture.output),
      packedLayout(),
      { createCanvas: fixture.createCanvas }
    );

    expect(fixture.output.contextRequest).toEqual({
      alpha: true,
      willReadFrequently: false
    });
    renderer.dispose();
  });

  it("materializes straight RGBA into three bounded stream slots", async () => {
    const fixture = canvasFixture();
    const renderer = new Canvas2dRenderer(htmlCanvas(fixture.output), packedLayout(), {
      createCanvas: fixture.createCanvas,
      initialPresentation: { width: 6, height: 4, dpr: 2, fit: "contain" }
    });

    await renderer.draw(packedFrame([0, 128, 255]));

    const snapshot = renderer.snapshot();
    expect(snapshot).toMatchObject({
      backendDetails: { kind: "canvas2d" },
      backingWidth: 12,
      backingHeight: 8,
      textureBytes: 0
    });
    expect(snapshot).not.toHaveProperty("uploadMode");
    expect(snapshot).not.toHaveProperty("nativeProbeAttempts");
    expect(snapshot).not.toHaveProperty("probeReadbackBytes");
    expect(snapshot).not.toHaveProperty("nativeProbeInFlight");
    expect(snapshot.stagingBytes).toBe(4 * 12 * 4 + 3 * (3 * 2 * 4 * 2));

    const color = fixture.surface(3, 2, 0).context.lastImageData;
    const mask = fixture.surface(3, 2, 1).context.lastImageData;
    expect(Array.from(color?.data.slice(0, 8) ?? []))
      .toEqual([10, 20, 30, 255, 11, 20, 30, 255]);
    expect(color?.data.filter((_value, index) => index % 4 === 3))
      .toEqual(new Uint8ClampedArray([255, 255, 255, 255, 255, 255]));
    expect(mask?.data.filter((_value, index) => index % 4 === 3))
      .toEqual(new Uint8ClampedArray([0, 128, 255, 0, 128, 255]));

    const output = fixture.output.context;
    expect(output.draws.map(({ composite }) => composite))
      .toEqual(["source-over", "destination-in"]);
    expect(fixture.surfaces.length).toBeGreaterThan(0);
    for (const surface of fixture.surfaces) {
      expect(surface.contextRequest).toEqual({
        alpha: true,
        willReadFrequently: false
      });
    }
  });

  it("keeps resident identities independent and redraws after resize", async () => {
    const fixture = canvasFixture();
    const renderer = new Canvas2dRenderer(htmlCanvas(fixture.output), packedLayout(), {
      createCanvas: fixture.createCanvas
    });
    await renderer.store("idle", 0, packedFrame([0, 128, 255]));
    expect(() => renderer.store("idle", 0, packedFrame([1, 2, 3])))
      .toThrow(/already exists/u);
    await renderer.drawStored("idle", 0);
    const before = fixture.output.context.draws.length;

    renderer.resize(20, 10, 2, "cover");
    await renderer.settled();

    expect(fixture.output.context.draws.length).toBe(before + 2);
    expect(() => renderer.drawStored("idle", 1)).toThrow(/unavailable/u);
  });

  it("captures a rejected resize backing before rollback and cleanup", async () => {
    const fixture = canvasFixture();
    const changes: unknown[] = [];
    const renderer = new Canvas2dRenderer(htmlCanvas(fixture.output), packedLayout(), {
      createCanvas: fixture.createCanvas,
      onContextChange: (change) => changes.push(change)
    });
    let backingWidth = fixture.output.width;
    Object.defineProperty(fixture.output, "width", {
      configurable: true,
      get: () => backingWidth,
      set: (value: number) => { backingWidth = value === 40 ? 39 : value; }
    });

    let rejected!: RendererFailureError;
    try { renderer.resize(20, 10, 2, "contain"); }
    catch (reason) { rejected = reason as RendererFailureError; }
    await Promise.resolve();

    expect(rejected).toBeInstanceOf(RendererFailureError);
    expect(rejected.diagnostic).toMatchObject({
      backend: "canvas2d",
      operation: "runtime",
      operationOrdinal: 1,
      phase: "resize",
      backing: { width: 39, height: 20 }
    });
    expect(changes).toEqual([{ state: "error", error: rejected }]);
    expect(renderer.snapshot()).toMatchObject({
      failure: rejected.diagnostic,
      backingWidth: 0,
      backingHeight: 0,
      runtimeBytes: 0,
      resourceCount: 0,
      contextListenerCount: 0
    });
    expect(fixture.output.listenerCount).toBe(0);
    await expect(renderer.draw(packedFrame([1, 2, 3])))
      .rejects.toThrow(/unavailable/u);
    expect(renderer.snapshot().failure).toBe(rejected.diagnostic);
  });

  it("presents opaque odd-padded storage without creating an alpha scratch", async () => {
    const fixture = canvasFixture(4, 2);
    const renderer = new Canvas2dRenderer(htmlCanvas(fixture.output), opaqueLayout(), {
      createCanvas: fixture.createCanvas
    });

    await renderer.draw(opaqueFrame());

    expect(fixture.surfaces.filter((surface) =>
      surface.initialWidth === 3 && surface.initialHeight === 2
    )).toHaveLength(1);
    expect(fixture.output.context.draws.map(({ composite }) => composite))
      .toEqual(["source-over"]);
    expect(renderer.snapshot().stagingBytes).toBe(4 * 2 * 4 + 3 * (3 * 2 * 4));
  });

  it("uses exactly three stream buffers without growing across rotation", async () => {
    const fixture = canvasFixture();
    const renderer = new Canvas2dRenderer(htmlCanvas(fixture.output), packedLayout(), {
      createCanvas: fixture.createCanvas
    });
    const bytes = renderer.snapshot().stagingBytes;

    for (let index = 0; index < 7; index += 1) {
      await renderer.draw(packedFrame([index, index + 1, index + 2]));
    }

    expect(renderer.snapshot().stagingBytes).toBe(bytes);
    expect(renderer.snapshot().residentBytes).toBe(0);
  });

  it("inspects and primes one cached RGBA source without presenting or allocating", async () => {
    const fixture = canvasFixture();
    const renderer = new Renderer(htmlCanvas(fixture.output), packedLayout(), {
      createCanvas: fixture.createCanvas
    });
    let copies = 0;
    let copiedDestination: AllowSharedBufferSource | null = null;
    let inspectedPixels: Uint8Array | null = null;
    const candidate = frameWithCopy(async (destination) => {
      copies += 1;
      copiedDestination = destination;
      destinationBytes(destination).set(packedPixels([0, 128, 255]));
      return [{ offset: 0, stride: 16 }];
    });
    const before = renderer.snapshot();

    await renderer.inspectAndPrime(candidate, (source) => {
      expect(source.frame).toBe(candidate);
      expect(Object.isFrozen(source)).toBe(true);
      expect(Object.keys(source)).toEqual(["frame", "rgba"]);
      expect(source).not.toHaveProperty("release");
      expect(Object.isFrozen(source.rgba)).toBe(true);
      inspectedPixels = source.rgba.pixels;
    });

    const after = renderer.snapshot();
    expect(copies).toBe(1);
    expect(inspectedPixels).toBe(copiedDestination);
    expect(fixture.output.context.draws).toHaveLength(0);
    expect(after).toMatchObject({
      stagingBytes: before.stagingBytes,
      residentBytes: before.residentBytes,
      runtimeBytes: before.runtimeBytes,
      resourceCount: before.resourceCount
    });

    await renderer.draw(packedFrame([1, 2, 3]));
    expect(fixture.output.context.draws).toHaveLength(2);
  });

  it("returns an exact inspector rejection and remains usable", async () => {
    const fixture = canvasFixture();
    const renderer = new Canvas2dRenderer(htmlCanvas(fixture.output), packedLayout(), {
      createCanvas: fixture.createCanvas
    });
    const rejection = new Error("decoded output identity mismatch");

    await expect(renderer.inspectAndPrime(
      packedFrame([0, 128, 255]),
      (source) => {
        expect(source.rgba.pixels.byteLength).toBe(4 * 12 * 4);
        throw rejection;
      }
    )).rejects.toBe(rejection);

    expect(renderer.snapshot().failure).toBeNull();
    expect(fixture.output.context.draws).toHaveLength(0);
    await renderer.draw(packedFrame([1, 2, 3]));
    expect(fixture.output.context.draws).toHaveLength(2);
    const invalid = {
      ...packedFrame([4, 5, 6]),
      displayWidth: 3
    } as unknown as VideoFrame;
    await expect(renderer.draw(invalid)).rejects.toMatchObject({
      diagnostic: { phase: "semantic-upload", operationOrdinal: 3 }
    });
  });

  it("rejects an invalid frame before invoking the inspector", async () => {
    const fixture = canvasFixture();
    const renderer = new Canvas2dRenderer(htmlCanvas(fixture.output), packedLayout(), {
      createCanvas: fixture.createCanvas
    });
    const invalid = {
      ...packedFrame([0, 128, 255]),
      displayWidth: 3
    } as unknown as VideoFrame;
    let inspected = false;

    await expect(renderer.inspectAndPrime(invalid, () => {
      inspected = true;
    })).rejects.toMatchObject({
      diagnostic: { phase: "semantic-upload", operationOrdinal: 1 }
    });
    expect(inspected).toBe(false);
  });

  it("keeps a pre-inspection materializer failure terminal", async () => {
    const fixture = canvasFixture();
    const renderer = new Canvas2dRenderer(htmlCanvas(fixture.output), packedLayout(), {
      createCanvas: fixture.createCanvas
    });
    const copyReason = new DOMException("copy failed", "EncodingError");
    let inspected = false;

    await expect(renderer.inspectAndPrime(
      frameWithCopy(async () => Promise.reject(copyReason)),
      () => { inspected = true; }
    )).rejects.toMatchObject({
      diagnostic: { phase: "rgba-copy", operationOrdinal: 1 }
    });
    expect(inspected).toBe(false);
    expect(renderer.snapshot()).toMatchObject({
      failure: expect.any(Object),
      backingWidth: 0,
      backingHeight: 0,
      runtimeBytes: 0,
      contextListenerCount: 0
    });
    expect(fixture.output.listenerCount).toBe(0);
    await expect(renderer.draw(packedFrame([1, 2, 3])))
      .rejects.toThrow(/unavailable/u);
  });

  it("does not replace the presented frame or advance its stream slot", async () => {
    const fixture = canvasFixture();
    const renderer = new Canvas2dRenderer(htmlCanvas(fixture.output), packedLayout(), {
      createCanvas: fixture.createCanvas
    });
    await renderer.draw(packedFrame([0, 128, 255]));
    const draws = fixture.output.context.draws.length;

    await renderer.inspectAndPrime(
      packedFrame([255, 255, 255]),
      (source) => { expect(source.rgba.pixels.byteLength).toBeGreaterThan(0); }
    );
    expect(fixture.output.context.draws).toHaveLength(draws);

    renderer.resize(8, 6, 1, "contain");
    await renderer.settled();
    const mask = fixture.surface(3, 2, 1).context.lastImageData;
    expect(mask?.data.filter((_value, index) => index % 4 === 3))
      .toEqual(new Uint8ClampedArray([0, 128, 255, 0, 128, 255]));
  });

  it("serializes priming and consumes one diagnostic ordinal", async () => {
    const fixture = canvasFixture();
    const renderer = new Canvas2dRenderer(htmlCanvas(fixture.output), packedLayout(), {
      createCanvas: fixture.createCanvas
    });
    let resolve!: (planes: readonly PlaneLayout[]) => void;
    const pendingCopy = new Promise<readonly PlaneLayout[]>((done) => {
      resolve = done;
    });
    let inspected = false;
    const drawing = renderer.draw(frameWithCopy(async () => pendingCopy));
    const priming = renderer.inspectAndPrime(
      packedFrame([0, 128, 255]),
      () => { inspected = true; }
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(inspected).toBe(false);
    expect(renderer.snapshot().pendingOperations).toBe(2);
    resolve([{ offset: 0, stride: 16 }]);
    await drawing;
    await priming;

    const invalid = {
      ...packedFrame([1, 2, 3]),
      displayWidth: 3
    } as unknown as VideoFrame;
    await expect(renderer.draw(invalid)).rejects.toMatchObject({
      diagnostic: { phase: "semantic-upload", operationOrdinal: 3 }
    });
  });

  it("rejects asynchronous inspectors without blocking the renderer queue", async () => {
    const fixture = canvasFixture();
    const renderer = new Canvas2dRenderer(htmlCanvas(fixture.output), packedLayout(), {
      createCanvas: fixture.createCanvas
    });

    await expect(renderer.inspectAndPrime(
      packedFrame([0, 128, 255]),
      async () => undefined
    )).rejects.toThrow("renderer frame inspector must be synchronous");

    expect(renderer.snapshot().failure).toBeNull();
    expect(fixture.output.context.draws).toHaveLength(0);
    await renderer.draw(packedFrame([1, 2, 3]));
    expect(fixture.output.context.draws).toHaveLength(2);
  });

  it("allows a synchronous inspector to enqueue later renderer work", async () => {
    const fixture = canvasFixture();
    const renderer = new Canvas2dRenderer(htmlCanvas(fixture.output), packedLayout(), {
      createCanvas: fixture.createCanvas
    });
    let reentrantDraw: Promise<void> | undefined;

    await renderer.inspectAndPrime(packedFrame([0, 128, 255]), () => {
      reentrantDraw = renderer.draw(packedFrame([1, 2, 3]));
    });
    await reentrantDraw;

    expect(fixture.output.context.draws).toHaveLength(2);
    expect(renderer.snapshot().pendingOperations).toBe(0);
  });

  it("aborts boundedly when disposed synchronously during inspection", async () => {
    const fixture = canvasFixture();
    const renderer = new Canvas2dRenderer(htmlCanvas(fixture.output), packedLayout(), {
      createCanvas: fixture.createCanvas
    });
    const priming = renderer.inspectAndPrime(
      packedFrame([0, 128, 255]),
      (source) => {
        expect(source.rgba.pixels.byteLength).toBeGreaterThan(0);
        renderer.dispose();
      }
    );

    await expect(priming).rejects.toThrow(/unavailable/u);
    expect(renderer.snapshot()).toMatchObject({
      pendingOperations: 0,
      sourceCopiesInFlight: 0,
      resourceCount: 0,
      runtimeBytes: 0
    });
  });

  it("uses the exact single-plane RGBA copyTo contract", async () => {
    const fixture = canvasFixture();
    const renderer = new Canvas2dRenderer(htmlCanvas(fixture.output), packedLayout(), {
      createCanvas: fixture.createCanvas
    });
    let copiedInto: AllowSharedBufferSource | null = null;
    let copyOptions: VideoFrameCopyToOptions | undefined;

    await renderer.draw(frameWithCopy(async (destination, options) => {
      copiedInto = destination;
      copyOptions = options;
      destinationBytes(destination).set(packedPixels([0, 128, 255]));
      return [{ offset: 0, stride: 16 }];
    }));

    expect((copiedInto as Uint8Array | null)?.byteLength).toBe(192);
    expect(copyOptions).toEqual({
      format: "RGBA",
      rect: { x: 0, y: 0, width: 4, height: 12 },
      layout: [{ offset: 0, stride: 16 }]
    });
  });

  it("accounts exact persistent bytes and the detached-readback admission peak", () => {
    const fixture = canvasFixture();
    const renderer = new Canvas2dRenderer(htmlCanvas(fixture.output), packedLayout(), {
      createCanvas: fixture.createCanvas,
      maxRuntimeBytes: 1_116
    });

    expect(renderer.snapshot()).toMatchObject({
      stagingBytes: 336,
      residentBytes: 0,
      textureBytes: 0,
      runtimeBytes: 636
    });
    expect(renderer.admit(0)).toEqual({ textureBytes: 0, runtimeBytes: 1_068 });
    expect(renderer.admit(1)).toEqual({ textureBytes: 0, runtimeBytes: 1_116 });
    renderer.dispose();

    const rejected = canvasFixture();
    expect(() => new Canvas2dRenderer(
      htmlCanvas(rejected.output),
      packedLayout(),
      { createCanvas: rejected.createCanvas, maxRuntimeBytes: 1_067 }
    )).toThrowError(expect.objectContaining({ name: "ResourceBudgetError" }));
  });

  it("allows only an unsupported RGBA copy to use detached Canvas2D readback", async () => {
    const fixture = canvasFixture();
    const renderer = new Canvas2dRenderer(htmlCanvas(fixture.output), packedLayout(), {
      createCanvas: fixture.createCanvas
    });
    await renderer.draw(frameWithCopy(() => {
      throw new DOMException("RGBA is unsupported", "NotSupportedError");
    }));

    const readback = fixture.surface(4, 12, 0).context;
    expect(readback.draws).toHaveLength(1);
    expect(renderer.snapshot().failure).toBeNull();
  });

  it("reads an already cropped VideoFrame from display space", async () => {
    const fixture = canvasFixture();
    const renderer = new Canvas2dRenderer(htmlCanvas(fixture.output), packedLayout(), {
      createCanvas: fixture.createCanvas
    });
    const candidate = {
      ...frameWithCopy(() => {
        throw new TypeError("RGBA copy is unsupported");
      }),
      codedWidth: 12,
      codedHeight: 30,
      displayWidth: 8,
      displayHeight: 24,
      visibleRect: { x: 2, y: 3, width: 4, height: 12 }
    } as unknown as VideoFrame;

    await renderer.draw(candidate);

    const readback = fixture.surface(4, 12, 0).context;
    expect(readback.draws[0]?.args.slice(1, 5)).toEqual([0, 0, 8, 24]);
  });

  it("accounts a reserved resident frame while its copy is pending", async () => {
    let resolve!: (planes: readonly PlaneLayout[]) => void;
    const copy = new Promise<readonly PlaneLayout[]>((done) => { resolve = done; });
    const fixture = canvasFixture();
    const renderer = new Canvas2dRenderer(htmlCanvas(fixture.output), packedLayout(), {
      createCanvas: fixture.createCanvas
    });

    const storing = renderer.store("idle", 0, frameWithCopy(() => copy));
    expect(renderer.snapshot()).toMatchObject({
      residentBytes: 48,
      runtimeBytes: 684
    });
    resolve([{ offset: 0, stride: 16 }]);
    await storing;
    expect(renderer.snapshot().residentBytes).toBe(48);
  });

  it.each([
    ["invalid layout", async () => [{ offset: 0, stride: 15 }], "Error"],
    ["abort", async () => {
      throw new DOMException("copy aborted", "AbortError");
    }, "AbortError"]
  ] as const)("terminalizes %s without detached readback", async (
    _name,
    copy,
    exceptionName
  ) => {
    const fixture = canvasFixture();
    const renderer = new Canvas2dRenderer(htmlCanvas(fixture.output), packedLayout(), {
      createCanvas: fixture.createCanvas
    });
    await expect(renderer.draw(frameWithCopy(copy))).rejects
      .toBeInstanceOf(RendererFailureError);
    expect(fixture.surfaces.filter((surface) =>
      surface.initialWidth === 4 && surface.initialHeight === 12
    )).toHaveLength(0);
    expect(renderer.snapshot().failure).toMatchObject({
      backend: "canvas2d",
      phase: "rgba-copy",
      uploadPath: "rgba-copy",
      exception: { name: exceptionName }
    });
  });

  it("terminalizes a timed-out copy without detached readback", async () => {
    let fire: (() => void) | undefined;
    const fixture = canvasFixture();
    const renderer = new Canvas2dRenderer(htmlCanvas(fixture.output), packedLayout(), {
      createCanvas: fixture.createCanvas,
      setTimeout: (callback) => { fire = callback; return 7; },
      clearTimeout() {}
    });
    const pending = renderer.draw(frameWithCopy(() => new Promise(() => undefined)));
    await Promise.resolve();
    await Promise.resolve();
    fire?.();

    await expect(pending).rejects.toBeInstanceOf(RendererFailureError);
    expect(fixture.surfaces.filter((surface) =>
      surface.initialWidth === 4 && surface.initialHeight === 12
    )).toHaveLength(0);
    expect(renderer.snapshot().failure).toMatchObject({
      phase: "rgba-copy",
      exception: { name: "TimeoutError" }
    });
  });
});

describe("Canvas2dRenderer geometry and lifecycle", () => {
  it("shares exact fit, pixel-aspect, DPR, centering, and cover offsets", () => {
    expect(calculateRendererViewport(packedLayout(), 12, 8, 2, "contain"))
      .toEqual({ x: 0, y: 0, width: 12, height: 8 });
    expect(calculateRendererViewport({
      ...packedLayout(), logicalWidth: 4, logicalHeight: 4, pixelAspect: [2, 1]
    }, 10, 10, 1, "cover"))
      .toEqual({ x: -5, y: 0, width: 20, height: 10 });
    expect(calculateRendererViewport(packedLayout(), 12, 8, 2, "none"))
      .toEqual({ x: 3, y: 2, width: 6, height: 4 });
    expect(calculateRendererViewport(packedLayout(), 17, 11, 3, "fill"))
      .toEqual({ x: 0, y: 0, width: 17, height: 11 });
  });

  it("recovers a Canvas2D context and redraws the retained CPU frame", async () => {
    const changes: unknown[] = [];
    const fixture = canvasFixture();
    const renderer = new Canvas2dRenderer(htmlCanvas(fixture.output), packedLayout(), {
      createCanvas: fixture.createCanvas,
      onContextChange: (change) => changes.push(change)
    });
    await renderer.draw(packedFrame([0, 128, 255]));
    const before = fixture.output.context.draws.length;

    fixture.output.dispatch("contextlost");
    fixture.output.dispatch("contextrestored");
    await renderer.settled();
    await Promise.resolve();

    expect(changes).toEqual([
      { state: "lost", error: null },
      { state: "restored", error: null }
    ]);
    expect(fixture.output.context.draws.length).toBe(before + 2);
    expect(renderer.snapshot()).toMatchObject({
      contextLossCount: 1,
      contextRecoveryCount: 1
    });
  });

  it("releases listeners, surfaces, streams, and residents on disposal", async () => {
    const fixture = canvasFixture();
    const renderer = new Canvas2dRenderer(htmlCanvas(fixture.output), packedLayout(), {
      createCanvas: fixture.createCanvas
    });
    await renderer.store("idle", 0, packedFrame([0, 128, 255]));
    renderer.dispose();

    expect(renderer.snapshot()).toMatchObject({
      backingWidth: 0,
      backingHeight: 0,
      stagingBytes: 0,
      residentBytes: 0,
      textureBytes: 0,
      runtimeBytes: 0,
      resourceCount: 0,
      contextListenerCount: 0
    });
    expect(fixture.output.listenerCount).toBe(0);
    expect(fixture.surfaces.every(({ width, height }) => width === 0 && height === 0))
      .toBe(true);
  });

  it("terminalizes a lost scratch context during restore", async () => {
    const changes: unknown[] = [];
    const fixture = canvasFixture();
    const renderer = new Canvas2dRenderer(htmlCanvas(fixture.output), packedLayout(), {
      createCanvas: fixture.createCanvas,
      onContextChange: (change) => changes.push(change)
    });
    await renderer.draw(packedFrame([0, 128, 255]));
    fixture.output.dispatch("contextlost");
    fixture.surfaces[0]!.context.contextLost = true;
    fixture.output.dispatch("contextrestored");
    await renderer.settled();
    await Promise.resolve();

    expect(changes[0]).toEqual({ state: "lost", error: null });
    expect(changes[1]).toMatchObject({
      state: "error",
      error: { diagnostic: { backend: "canvas2d", phase: "context-event" } }
    });
    expect(renderer.snapshot()).toMatchObject({ resourceCount: 0 });
  });

  it("does not publish restoration until retained redraw succeeds", async () => {
    const changes: unknown[] = [];
    const fixture = canvasFixture();
    const renderer = new Canvas2dRenderer(htmlCanvas(fixture.output), packedLayout(), {
      createCanvas: fixture.createCanvas,
      onContextChange: (change) => changes.push(change)
    });
    await renderer.draw(packedFrame([0, 128, 255]));
    fixture.output.dispatch("contextlost");
    fixture.output.context.throwOnDraw = true;
    fixture.output.dispatch("contextrestored");
    await renderer.settled();
    await Promise.resolve();

    expect(changes.map((change) => (change as { state: string }).state))
      .toEqual(["lost", "error"]);
    expect(renderer.snapshot()).toMatchObject({
      contextLossCount: 1,
      contextRecoveryCount: 0,
      failure: { backend: "canvas2d", operation: "restore", phase: "draw" }
    });
  });

  it("disposes safely while a source copy is pending", async () => {
    let resolve!: (planes: readonly PlaneLayout[]) => void;
    const copy = new Promise<readonly PlaneLayout[]>((done) => { resolve = done; });
    const fixture = canvasFixture();
    const renderer = new Canvas2dRenderer(htmlCanvas(fixture.output), packedLayout(), {
      createCanvas: fixture.createCanvas
    });
    const drawing = renderer.draw(frameWithCopy(() => copy));
    await Promise.resolve();
    await Promise.resolve();

    renderer.dispose();
    resolve([{ offset: 0, stride: 16 }]);
    await expect(drawing).rejects.toThrow(/unavailable/u);
    await renderer.settled();

    expect(renderer.snapshot()).toMatchObject({
      stagingBytes: 0,
      residentBytes: 0,
      runtimeBytes: 0,
      sourceCopiesInFlight: 0,
      resourceCount: 0,
      contextListenerCount: 0
    });
  });
});

function packedLayout(): RenderLayout {
  const geometry = deriveVideoRenditionGeometry({
    canvasWidth: 3,
    canvasHeight: 2,
    layout: "packed-alpha",
    visibleWidth: 3,
    visibleHeight: 2,
    storage: { widthAlignment: 2, heightAlignment: 2 }
  });
  return deriveRenderLayout({
    codedWidth: geometry.codedWidth,
    codedHeight: geometry.codedHeight,
    logicalWidth: 3,
    logicalHeight: 2,
    pixelAspect: [1, 1],
    colorRect: geometry.visibleColorRect,
    alphaRect: geometry.visibleAlphaRect!
  });
}

function packedFrame(alpha: readonly [number, number, number]): VideoFrame {
  return frameWithCopy(async (destination) => {
    const pixels = destinationBytes(destination);
    pixels.set(packedPixels(alpha));
    return [{ offset: 0, stride: 16 }];
  });
}

function packedPixels(alpha: readonly [number, number, number]): Uint8Array {
  const pixels = new Uint8Array(4 * 12 * 4);
  pixels.fill(231);
  for (let row = 0; row < 2; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      const color = (row * 4 + column) * 4;
      pixels.set([10 + column, 20 + row, 30, 7], color);
      const mask = ((10 + row) * 4 + column) * 4;
      pixels.set([alpha[column] ?? 0, 99, 88, 77], mask);
    }
  }
  return pixels;
}

function frameWithCopy(
  copyTo: (
    destination: AllowSharedBufferSource,
    options?: VideoFrameCopyToOptions
  ) => Promise<readonly PlaneLayout[]>
): VideoFrame {
  return {
    codedWidth: 4,
    codedHeight: 12,
    displayWidth: 4,
    displayHeight: 12,
    visibleRect: { x: 0, y: 0, width: 4, height: 12 },
    copyTo
  } as unknown as VideoFrame;
}

function opaqueLayout(): RenderLayout {
  return {
    codedWidth: 4,
    codedHeight: 2,
    storageWidth: 4,
    storageHeight: 2,
    logicalWidth: 3,
    logicalHeight: 2,
    pixelAspect: [1, 1],
    colorRect: [0, 0, 3, 2]
  };
}

function opaqueFrame(): VideoFrame {
  return {
    codedWidth: 4,
    codedHeight: 2,
    displayWidth: 4,
    displayHeight: 2,
    visibleRect: { x: 0, y: 0, width: 4, height: 2 },
    copyTo: async (destination: AllowSharedBufferSource) => {
      destinationBytes(destination).fill(91);
      return [{ offset: 0, stride: 16 }];
    }
  } as unknown as VideoFrame;
}

function destinationBytes(destination: AllowSharedBufferSource): Uint8Array {
  if (ArrayBuffer.isView(destination)) {
    return new Uint8Array(
      destination.buffer,
      destination.byteOffset,
      destination.byteLength
    );
  }
  return new Uint8Array(destination);
}

function canvasFixture(width = 4, height = 12): Readonly<{
  output: TestCanvas;
  surfaces: TestCanvas[];
  createCanvas: (width: number, height: number) => HTMLCanvasElement;
  surface(width: number, height: number, ordinal: number): TestCanvas;
}> {
  const output = new TestCanvas(width, height);
  const surfaces: TestCanvas[] = [];
  const createCanvas = (width: number, height: number): HTMLCanvasElement => {
    const surface = new TestCanvas(width, height);
    surfaces.push(surface);
    return surface as unknown as HTMLCanvasElement;
  };
  return {
    output,
    surfaces,
    createCanvas,
    surface(width, height, ordinal) {
      const candidates = surfaces.filter((surface) =>
        surface.initialWidth === width && surface.initialHeight === height
      );
      const result = candidates[ordinal];
      if (result === undefined) throw new Error("test surface is unavailable");
      return result;
    }
  };
}

class TestCanvas {
  public readonly context = new TestContext(this);
  public contextRequest: unknown = null;
  public readonly initialWidth: number;
  public readonly initialHeight: number;
  public width: number;
  public height: number;
  readonly #listeners = new Map<string, EventListener>();

  public constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.initialWidth = width;
    this.initialHeight = height;
  }

  public get listenerCount(): number { return this.#listeners.size; }

  public getContext(
    type: string,
    options?: unknown
  ): CanvasRenderingContext2D | null {
    if (type === "2d") this.contextRequest = options;
    return type === "2d" ? this.context as unknown as CanvasRenderingContext2D : null;
  }

  public addEventListener(type: string, listener: EventListener): void {
    this.#listeners.set(type, listener);
  }

  public removeEventListener(type: string): void { this.#listeners.delete(type); }

  public dispatch(type: "contextlost" | "contextrestored"): void {
    this.#listeners.get(type)?.({ preventDefault() {} } as Event);
  }
}

class TestContext {
  public globalCompositeOperation = "source-over";
  public imageSmoothingEnabled = false;
  public imageSmoothingQuality: ImageSmoothingQuality = "high";
  public lastImageData: ImageData | null = null;
  public contextLost = false;
  public throwOnDraw = false;
  public readonly draws: Array<Readonly<{ composite: string; args: readonly unknown[] }>> = [];

  public constructor(public readonly canvas: TestCanvas) {}

  public clearRect(): void {}

  public createImageData(width: number, height: number): ImageData {
    return { width, height, data: new Uint8ClampedArray(width * height * 4) } as ImageData;
  }

  public putImageData(image: ImageData): void { this.lastImageData = image; }

  public drawImage(...args: unknown[]): void {
    if (this.throwOnDraw) throw new Error("test Canvas2D draw failed");
    this.draws.push({ composite: this.globalCompositeOperation, args });
  }

  public getImageData(): ImageData {
    return this.lastImageData ?? this.createImageData(this.canvas.width, this.canvas.height);
  }

  public isContextLost(): boolean { return this.contextLost; }
}

function htmlCanvas(canvas: TestCanvas): HTMLCanvasElement {
  return canvas as unknown as HTMLCanvasElement;
}
