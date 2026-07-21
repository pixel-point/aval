import { describe, expect, it } from "vitest";

import {
  RendererBackendFailure,
  type RendererBackendEvent
} from "../src/renderer-backend.js";
import { allocationBytes, rgbaBytes } from "../src/renderer-geometry.js";
import { WebGl2RendererBackend } from "../src/webgl2-renderer-backend.js";
import {
  compactOpaqueFrame,
  compactOpaqueLayout,
  frame,
  layout,
  webglCanvas
} from "./renderer-webgl-test-support.js";

describe("WebGl2RendererBackend", () => {
  it("omits the low-latency hint from transparent presentation", () => {
    const fixture = webglCanvas();
    const backend = new WebGl2RendererBackend(
      fixture.canvas,
      layout(),
      () => undefined
    );

    expect(fixture.gl.contextRequestAttributes).toEqual({
      alpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false
    });
    backend.dispose();
  });

  it("keeps packed-alpha streaming on deterministic RGBA uploads", async () => {
    const fixture = webglCanvas();
    const backend = new WebGl2RendererBackend(
      fixture.canvas,
      layout(),
      () => undefined
    );
    const target = backend.allocateTarget("stream", 0);
    const pixels = new Uint8Array(48 * 104 * 4);

    await backend.upload(target, Object.freeze({
      frame: frame(),
      newDecoderRun: false,
      rgba: async () => Object.freeze({
        width: 48,
        height: 104,
        stride: 48 * 4,
        pixels
      })
    }));

    expect(fixture.gl.nativeUploadCount).toBe(0);
    expect(fixture.gl.readPixelsCount).toBe(0);
    expect(fixture.gl.rgbaUploadCount).toBe(1);
    expect(fixture.gl.rgbaUploadSources).toEqual([pixels]);
    expect(backend.snapshot(0, 48, 104).details).toMatchObject({
      uploadMode: "rgba-copy",
      nativeProbeAttempts: 0,
      probeReadbackBytes: 0,
      nativeProbeInFlight: false
    });
    backend.dispose();
  });

  it("retains bounded native qualification for opaque streaming", async () => {
    const fixture = webglCanvas(48, 48);
    const backend = new WebGl2RendererBackend(
      fixture.canvas,
      compactOpaqueLayout(),
      () => undefined
    );
    const target = backend.allocateTarget("stream", 0);

    await backend.upload(target, Object.freeze({
      frame: compactOpaqueFrame(),
      newDecoderRun: false,
      rgba: async () => Object.freeze({
        width: 48,
        height: 48,
        stride: 48 * 4,
        pixels: new Uint8Array(48 * 48 * 4)
      })
    }));

    expect(fixture.gl.nativeUploadCount).toBe(1);
    expect(fixture.gl.readPixelsCount).toBe(2);
    expect(fixture.gl.rgbaUploadCount).toBe(1);
    expect(backend.snapshot(0, 48, 48).details).toMatchObject({
      uploadMode: "native",
      nativeProbeAttempts: 1,
      probeReadbackBytes: 8 * 8 * 4 * 2,
      nativeProbeInFlight: false
    });
    backend.dispose();
  });

  it("requalifies native upload when the decoder run changes", async () => {
    const fixture = webglCanvas(48, 48);
    const backend = new WebGl2RendererBackend(
      fixture.canvas,
      compactOpaqueLayout(),
      () => undefined
    );
    const target = backend.allocateTarget("stream", 0);
    const pixels = new Uint8Array(48 * 48 * 4);
    const source = (newDecoderRun: boolean) => Object.freeze({
      frame: compactOpaqueFrame(),
      newDecoderRun,
      rgba: async () => Object.freeze({
        width: 48,
        height: 48,
        stride: 48 * 4,
        pixels
      })
    });

    await backend.upload(target, source(false));
    fixture.gl.nativeReadback = new Uint8Array(8 * 8 * 4);
    await backend.upload(target, source(true));
    await backend.upload(target, source(true));

    expect(fixture.gl.nativeUploadCount).toBe(2);
    expect(fixture.gl.rgbaUploadCount).toBe(3);
    expect(fixture.gl.readPixelsCount).toBe(4);
    expect(backend.snapshot(0, 48, 48).details).toMatchObject({
      uploadMode: "rgba-copy",
      nativeProbeAttempts: 2
    });
    backend.dispose();
  });

  it("keeps healthy native upload across repeated decoder-run canaries", async () => {
    const fixture = webglCanvas(48, 48);
    const backend = new WebGl2RendererBackend(
      fixture.canvas,
      compactOpaqueLayout(),
      () => undefined
    );
    const target = backend.allocateTarget("stream", 0);
    const pixels = new Uint8Array(48 * 48 * 4);

    for (let run = 0; run < 6; run += 1) {
      await backend.upload(target, Object.freeze({
        frame: compactOpaqueFrame(),
        newDecoderRun: run > 0,
        rgba: async () => Object.freeze({
          width: 48,
          height: 48,
          stride: 48 * 4,
          pixels
        })
      }));
    }

    expect(fixture.gl.nativeUploadCount).toBe(6);
    expect(fixture.gl.rgbaUploadCount).toBe(6);
    expect(fixture.gl.readPixelsCount).toBe(12);
    expect(backend.snapshot(0, 48, 48).details).toMatchObject({
      uploadMode: "native",
      nativeProbeAttempts: 6
    });
    backend.dispose();
  });

  it("uploads explicit RGBA without attempting or mutating native qualification", async () => {
    const fixture = webglCanvas();
    const backend = new WebGl2RendererBackend(
      fixture.canvas,
      layout(),
      () => undefined
    );
    const target = backend.allocateTarget("resident", 0);

    await backend.uploadRgba(target, Object.freeze({
      width: 48,
      height: 104,
      stride: 48 * 4,
      pixels: new Uint8Array(48 * 104 * 4)
    }));

    expect(fixture.gl.nativeUploadCount).toBe(0);
    expect(fixture.gl.rgbaUploadCount).toBe(1);
    expect(backend.snapshot(1, 48, 104).details).toMatchObject({
      uploadMode: "rgba-copy",
      nativeProbeAttempts: 0
    });
    backend.dispose();
  });

  it("accounts the caller's explicit planned target count", () => {
    const fixture = webglCanvas();
    const backend = new WebGl2RendererBackend(
      fixture.canvas,
      layout(),
      () => undefined
    );

    expect(backend.plannedMemory(1, 6, 48, 104).textureBytes).toBe(
      allocationBytes(rgbaBytes(48, 112) * 6)
    );
    backend.dispose();
  });

  it("carries discovery evidence and cleans a local program after setup fails", () => {
    const fixture = webglCanvas();
    fixture.gl.setupError = new Error("post-program setup failed");

    let failure!: RendererBackendFailure;
    try {
      new WebGl2RendererBackend(fixture.canvas, layout(), () => undefined);
    } catch (reason) {
      failure = reason as RendererBackendFailure;
    }

    expect(failure).toBeInstanceOf(RendererBackendFailure);
    expect(failure.evidence.phase).toBe("context-event");
    expect(failure.snapshot).toMatchObject({
      limits: {
        maxTextureSize: 8_192,
        maxViewportWidth: 8_192,
        maxViewportHeight: 8_192,
        maxResidentTextures: 4_096
      },
      vendor: "Synthetic Vendor",
      renderer: "Synthetic Renderer"
    });
    expect(fixture.gl.deletedPrograms).toBe(1);
  });

  it("installs the context event sink during construction", () => {
    const fixture = webglCanvas();
    const events: RendererBackendEvent[] = [];
    const backend = new WebGl2RendererBackend(
      fixture.canvas,
      layout(),
      (event) => events.push(event)
    );

    fixture.dispatch("webglcontextlost");

    expect(events).toEqual([{ kind: "lost" }]);
    backend.dispose();
  });
});
