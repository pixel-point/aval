import { describe, expect, it } from "vitest";

import { Renderer } from "../src/renderer.js";
import { RendererFailureError } from "../src/renderer-diagnostics.js";
import {
  frame,
  layout,
  webglCanvas
} from "./renderer-webgl-test-support.js";

describe("WebGL renderer operation identity", () => {
  it("keeps the draw ordinal when the backend draw fails", async () => {
    const fixture = webglCanvas();
    const renderer = new Renderer(fixture.canvas, layout());
    fixture.gl.loseOnDraw = true;

    await expect(renderer.draw(frame(), false)).rejects.toMatchObject({
      diagnostic: {
        operation: "runtime",
        operationOrdinal: 1,
        phase: "draw"
      }
    });
  });

  it("consumes one ordinal for a successful resize redraw", async () => {
    const fixture = webglCanvas();
    const renderer = new Renderer(fixture.canvas, layout());
    await renderer.draw(frame(), false);

    renderer.resize(25, 52, 2, "contain");
    await renderer.settled();
    expect(fixture.gl.drawnTextures).toHaveLength(2);

    await expect(renderer.draw(frame(undefined, 47, 104), false)).rejects.toMatchObject({
      diagnostic: {
        operation: "runtime",
        operationOrdinal: 4,
        phase: "semantic-upload"
      }
    });
  });

  it("keeps resident allocation failure on the store ordinal", async () => {
    const fixture = webglCanvas();
    const renderer = new Renderer(fixture.canvas, layout());
    fixture.gl.storageError = fixture.gl.OUT_OF_MEMORY;

    await expect(renderer.store("idle", 0, frame(), false)).rejects.toMatchObject({
      diagnostic: {
        operation: "runtime",
        operationOrdinal: 1,
        phase: "resident-texture-create"
      }
    });
  });

  it("keeps a stored draw failure on the drawStored ordinal", async () => {
    const fixture = webglCanvas();
    const renderer = new Renderer(fixture.canvas, layout());
    await renderer.store("idle", 0, frame(), false);
    fixture.gl.loseOnDraw = true;

    await expect(renderer.drawStored("idle", 0)).rejects.toMatchObject({
      diagnostic: {
        operation: "runtime",
        operationOrdinal: 2,
        phase: "draw"
      }
    });
  });

  it("keeps resident RGBA upload failure on the store ordinal", async () => {
    const fixture = webglCanvas();
    const renderer = new Renderer(fixture.canvas, layout());
    fixture.gl.rgbaUploadError = fixture.gl.OUT_OF_MEMORY;

    await expect(renderer.store("idle", 0, frame(), false)).rejects.toMatchObject({
      diagnostic: {
        operation: "runtime",
        operationOrdinal: 1,
        phase: "rgba-upload"
      }
    });
  });

  it("terminalizes a synchronous backing rejection with durable evidence", async () => {
    const fixture = webglCanvas();
    const changes: unknown[] = [];
    const renderer = new Renderer(fixture.canvas, layout(), {
      onContextChange: (change) => changes.push(change)
    });
    let backingWidth = fixture.canvas.width;
    Object.defineProperty(fixture.canvas, "width", {
      configurable: true,
      get: () => backingWidth,
      set: (value: number) => { backingWidth = value === 80 ? 79 : value; }
    });

    let rejected!: RendererFailureError;
    try { renderer.resize(40, 20, 2, "contain"); }
    catch (reason) { rejected = reason as RendererFailureError; }
    await Promise.resolve();

    expect(rejected).toBeInstanceOf(RendererFailureError);
    expect(rejected.diagnostic).toMatchObject({
      operation: "runtime",
      operationOrdinal: 1,
      phase: "resize",
      backing: { width: 79, height: 40 }
    });
    expect(changes).toEqual([{ state: "error", error: rejected }]);
    expect(renderer.snapshot()).toMatchObject({
      failure: rejected.diagnostic,
      backingWidth: 0,
      backingHeight: 0,
      stagingBytes: 0,
      textureBytes: 0,
      runtimeBytes: 0,
      resourceCount: 0,
      contextListenerCount: 0
    });
    expect([fixture.canvas.width, fixture.canvas.height]).toEqual([0, 0]);
    expect(fixture.gl.deletedPrograms).toBe(1);

    expect(() => renderer.resize(20, 10, 1, "contain"))
      .toThrowError(expect.objectContaining({ name: "AbortError" }));
    await expect(renderer.draw(frame(), false)).rejects.toMatchObject({
      name: "AbortError"
    });
    expect(renderer.snapshot().failure).toBe(rejected.diagnostic);
  });

  it("records an already-typed error at the terminal ownership boundary", async () => {
    const donor = webglCanvas();
    donor.gl.storageError = donor.gl.OUT_OF_MEMORY;
    let terminal!: RendererFailureError;
    try { new Renderer(donor.canvas, layout()); }
    catch (reason) { terminal = reason as RendererFailureError; }
    expect(terminal).toBeInstanceOf(RendererFailureError);

    const fixture = webglCanvas();
    const changes: unknown[] = [];
    fixture.gl.rejectNativeUpload = true;
    fixture.gl.drawArrays = () => { throw terminal; };
    const renderer = new Renderer(fixture.canvas, layout(), {
      onContextChange: (change) => changes.push(change)
    });

    await expect(renderer.draw(frame(), false)).rejects.toBe(terminal);
    await Promise.resolve();

    expect(renderer.snapshot()).toMatchObject({
      failure: terminal.diagnostic,
      backingWidth: 0,
      backingHeight: 0,
      runtimeBytes: 0,
      resourceCount: 0,
      contextListenerCount: 0
    });
    expect(changes).toEqual([{ state: "error", error: terminal }]);
  });
});

describe("WebGL resident upload policy", () => {
  it("validates a resident frame before allocating its target", async () => {
    const fixture = webglCanvas();
    const renderer = new Renderer(fixture.canvas, layout());
    fixture.gl.storageError = fixture.gl.OUT_OF_MEMORY;

    await expect(renderer.store(
      "idle",
      0,
      frame(undefined, 47, 104), false
    )).rejects.toMatchObject({
      diagnostic: { phase: "semantic-upload", operationOrdinal: 1 }
    });
    expect(fixture.gl.createdTextures).toHaveLength(3);
  });

  it("materializes a resident frame before allocating its target", async () => {
    const fixture = webglCanvas();
    const renderer = new Renderer(fixture.canvas, layout());
    const copyReason = new DOMException("resident copy rejected", "EncodingError");
    fixture.gl.storageError = fixture.gl.OUT_OF_MEMORY;

    await expect(renderer.store(
      "idle",
      0,
      frame(async () => Promise.reject(copyReason)), false
    )).rejects.toMatchObject({
      diagnostic: {
        phase: "rgba-copy",
        operationOrdinal: 1,
        exception: { name: "EncodingError" }
      }
    });
    expect(fixture.gl.createdTextures).toHaveLength(3);
  });

  it("stores resident frames through RGBA without changing native qualification", async () => {
    const fixture = webglCanvas();
    const renderer = new Renderer(fixture.canvas, layout());

    await renderer.store("idle", 0, frame(), false);
    await renderer.drawStored("idle", 0);

    expect(fixture.gl.nativeUploadCount).toBe(0);
    expect(fixture.gl.rgbaUploadCount).toBe(1);
    expect(fixture.gl.readPixelsCount).toBe(0);
    expect(fixture.gl.presentationUploadKinds).toEqual(["rgba-copy"]);
    expect(renderer.snapshot().backendDetails).toMatchObject({
      kind: "webgl2",
      uploadMode: "rgba-copy",
      nativeProbeAttempts: 0
    });
    renderer.dispose();
  });
});

describe("WebGL provisional output priming", () => {
  it("inspects and uploads one cached RGBA source without presenting or rotating", async () => {
    const fixture = webglCanvas();
    const renderer = new Renderer(fixture.canvas, layout());
    let copies = 0;
    let copiedDestination: AllowSharedBufferSource | null = null;
    let inspectedPixels: Uint8Array | null = null;
    const candidate = frame(async (destination) => {
      copies += 1;
      const pixels = destinationBytes(destination);
      pixels.fill(37);
      copiedDestination = destination;
      return [{ offset: 0, stride: 48 * 4 }];
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
    expect(fixture.gl.rgbaUploadSources.at(-1)).toBe(inspectedPixels);
    expect(fixture.gl.nativeUploadCount).toBe(0);
    expect(fixture.gl.drawnTextures).toHaveLength(0);
    expect(after).toMatchObject({
      stagingBytes: before.stagingBytes,
      residentBytes: before.residentBytes,
      textureBytes: before.textureBytes,
      runtimeBytes: before.runtimeBytes,
      resourceCount: before.resourceCount
    });
    expect(after.backendDetails).toMatchObject({
      kind: "webgl2",
      uploadMode: "rgba-copy",
      nativeProbeAttempts: 0
    });

    await renderer.draw(frame(), false);
    expect(fixture.gl.drawnTextures).toEqual([fixture.gl.createdTextures[0]]);
  });

  it("returns an exact inspector rejection without terminalizing", async () => {
    const fixture = webglCanvas();
    const renderer = new Renderer(fixture.canvas, layout());
    const rejection = new Error("decoded output identity mismatch");

    await expect(renderer.inspectAndPrime(frame(), (source) => {
      expect(source.rgba.pixels.byteLength).toBe(48 * 104 * 4);
      throw rejection;
    })).rejects.toBe(rejection);

    expect(renderer.snapshot().failure).toBeNull();
    expect(fixture.gl.nativeUploadCount).toBe(0);
    expect(fixture.gl.rgbaUploadCount).toBe(0);
    expect(fixture.gl.drawnTextures).toHaveLength(0);
    await renderer.draw(frame(), false);
    expect(fixture.gl.drawnTextures).toHaveLength(1);
    await expect(renderer.draw(frame(undefined, 47, 104), false)).rejects.toMatchObject({
      diagnostic: { phase: "semantic-upload", operationOrdinal: 3 }
    });
  });

  it("rejects an invalid frame before invoking the inspector", async () => {
    const fixture = webglCanvas();
    const renderer = new Renderer(fixture.canvas, layout());
    let inspected = false;

    await expect(renderer.inspectAndPrime(
      frame(undefined, 47, 104),
      () => { inspected = true; }
    )).rejects.toMatchObject({
      diagnostic: { phase: "semantic-upload", operationOrdinal: 1 }
    });
    expect(inspected).toBe(false);
  });

  it("keeps materializer and backend failures terminal on the prime ordinal", async () => {
    const copyFailureFixture = webglCanvas();
    const copyFailureRenderer = new Renderer(
      copyFailureFixture.canvas,
      layout()
    );
    const copyReason = new DOMException("copy failed", "EncodingError");
    let inspected = false;

    await expect(copyFailureRenderer.inspectAndPrime(
      frame(async () => Promise.reject(copyReason)),
      () => { inspected = true; }
    )).rejects.toMatchObject({
      diagnostic: { phase: "rgba-copy", operationOrdinal: 1 }
    });
    expect(inspected).toBe(false);
    expect(copyFailureRenderer.snapshot().failure).not.toBeNull();

    const uploadFailureFixture = webglCanvas();
    uploadFailureFixture.gl.rejectNativeUpload = true;
    uploadFailureFixture.gl.rgbaUploadError = uploadFailureFixture.gl.OUT_OF_MEMORY;
    const uploadFailureRenderer = new Renderer(
      uploadFailureFixture.canvas,
      layout()
    );
    await expect(uploadFailureRenderer.inspectAndPrime(
      frame(),
      (source) => { expect(source.rgba.pixels.byteLength).toBeGreaterThan(0); }
    )).rejects.toMatchObject({
      diagnostic: { phase: "rgba-upload", operationOrdinal: 1 }
    });
    expect(uploadFailureRenderer.snapshot().failure).not.toBeNull();
  });

  it("serializes priming and consumes one diagnostic ordinal", async () => {
    const fixture = webglCanvas();
    const renderer = new Renderer(fixture.canvas, layout());
    let resolve!: (planes: readonly PlaneLayout[]) => void;
    const pendingCopy = new Promise<readonly PlaneLayout[]>((done) => {
      resolve = done;
    });
    let inspected = false;
    const drawing = renderer.draw(frame(async () => pendingCopy), false);
    const priming = renderer.inspectAndPrime(frame(), () => {
      inspected = true;
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(inspected).toBe(false);
    expect(renderer.snapshot().pendingOperations).toBe(2);
    resolve([{ offset: 0, stride: 48 * 4 }]);
    await drawing;
    await priming;
    expect(inspected).toBe(true);

    await expect(renderer.draw(frame(undefined, 47, 104), false)).rejects.toMatchObject({
      diagnostic: { phase: "semantic-upload", operationOrdinal: 3 }
    });
  });

  it("rejects asynchronous inspectors without blocking the renderer queue", async () => {
    const fixture = webglCanvas();
    const renderer = new Renderer(fixture.canvas, layout());

    await expect(renderer.inspectAndPrime(frame(), async () => undefined))
      .rejects.toThrow("renderer frame inspector must be synchronous");

    expect(renderer.snapshot().failure).toBeNull();
    expect(fixture.gl.rgbaUploadCount).toBe(0);
    await renderer.draw(frame(), false);
    expect(fixture.gl.drawnTextures).toHaveLength(1);
  });

  it("allows a synchronous inspector to enqueue later renderer work", async () => {
    const fixture = webglCanvas();
    const renderer = new Renderer(fixture.canvas, layout());
    let reentrantDraw: Promise<void> | undefined;

    await renderer.inspectAndPrime(frame(), () => {
      reentrantDraw = renderer.draw(frame(), false);
    });
    await reentrantDraw;

    expect(fixture.gl.rgbaUploadCount).toBe(2);
    expect(fixture.gl.drawnTextures).toHaveLength(1);
    expect(renderer.snapshot().pendingOperations).toBe(0);
  });

  it("aborts boundedly when context is lost synchronously during inspection", async () => {
    const fixture = webglCanvas();
    const renderer = new Renderer(fixture.canvas, layout());
    const priming = renderer.inspectAndPrime(frame(), (source) => {
      expect(source.rgba.pixels.byteLength).toBeGreaterThan(0);
      fixture.dispatch("webglcontextlost");
    });

    await expect(priming).rejects.toMatchObject({ name: "AbortError" });
    expect(renderer.snapshot()).toMatchObject({
      pendingOperations: 0,
      sourceCopiesInFlight: 0,
      failure: null
    });
    expect(fixture.gl.rgbaUploadCount).toBe(0);
  });
});

describe("WebGL construction evidence", () => {
  it("rejects a byte cap before requesting a WebGL context", () => {
    const fixture = webglCanvas();

    expect(() => new Renderer(fixture.canvas, layout(), {
      maxRuntimeBytes: 1
    })).toThrowError(expect.objectContaining({ name: "ResourceBudgetError" }));

    expect(fixture.gl.contextRequestCount).toBe(0);
    expect(fixture.gl.createdTextures).toHaveLength(0);
  });

  it("retains bounded discovered device details on program failure", () => {
    const fixture = webglCanvas();
    fixture.gl.programLinked = false;

    let failure!: RendererFailureError;
    try { new Renderer(fixture.canvas, layout()); }
    catch (reason) { failure = reason as RendererFailureError; }

    expect(failure).toBeInstanceOf(RendererFailureError);
    expect(failure.diagnostic).toMatchObject({
      phase: "program-create",
      limits: {
        maxTextureSize: 8_192,
        maxViewportWidth: 8_192,
        maxViewportHeight: 8_192,
        maxResidentTextures: 4_096
      },
      contextAttributes: {
        alpha: true,
        antialias: false,
        depth: false,
        premultipliedAlpha: true,
        preserveDrawingBuffer: false,
        stencil: false
      },
      vendor: "Synthetic Vendor",
      renderer: "Synthetic Renderer"
    });
  });

  it("rejects a lost-context byte cap before restore allocation", async () => {
    const fixture = webglCanvas();
    const renderer = new Renderer(fixture.canvas, layout(), {
      maxBackingBytes: 1_000_000
    });
    fixture.dispatch("webglcontextlost");
    fixture.canvas.width = 1_000;
    fixture.canvas.height = 1_000;

    fixture.dispatch("webglcontextrestored");
    await renderer.settled();

    expect(fixture.gl.contextRequestCount).toBe(1);
    expect(fixture.gl.createdTextures).toHaveLength(3);
    expect(renderer.snapshot().failure).toMatchObject({
      operation: "restore",
      phase: "context-event",
      exception: { name: "ResourceBudgetError" }
    });
    renderer.dispose();
  });
});

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
