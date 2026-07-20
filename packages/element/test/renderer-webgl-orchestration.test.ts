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

    await expect(renderer.draw(frame())).rejects.toMatchObject({
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
    await renderer.draw(frame());

    renderer.resize(25, 52, 2, "contain");
    await renderer.settled();
    expect(fixture.gl.drawnTextures).toHaveLength(2);

    await expect(renderer.draw(frame(undefined, 47, 104))).rejects.toMatchObject({
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

    await expect(renderer.store("idle", 0, frame())).rejects.toMatchObject({
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
    await renderer.store("idle", 0, frame());
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

    await expect(renderer.store("idle", 0, frame())).rejects.toMatchObject({
      diagnostic: {
        operation: "runtime",
        operationOrdinal: 1,
        phase: "rgba-upload"
      }
    });
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
      frame(undefined, 47, 104)
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
      frame(async () => Promise.reject(copyReason))
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

    await renderer.store("idle", 0, frame());
    await renderer.drawStored("idle", 0);

    expect(fixture.gl.nativeUploadCount).toBe(0);
    expect(fixture.gl.rgbaUploadCount).toBe(1);
    expect(fixture.gl.readPixelsCount).toBe(0);
    expect(fixture.gl.presentationUploadKinds).toEqual(["rgba-copy"]);
    expect(renderer.snapshot().backendDetails).toMatchObject({
      kind: "webgl2",
      uploadMode: "native-probing",
      nativeProbeAttempts: 0
    });
    renderer.dispose();
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
