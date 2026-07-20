import { describe, expect, it } from "vitest";

import {
  RendererBackendFailure,
  type RendererBackendEvent
} from "../src/renderer-backend.js";
import { allocationBytes, rgbaBytes } from "../src/renderer-geometry.js";
import { WebGl2RendererBackend } from "../src/webgl2-renderer-backend.js";
import {
  layout,
  webglCanvas
} from "./renderer-webgl-test-support.js";

describe("WebGl2RendererBackend", () => {
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
      uploadMode: "native-probing",
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
