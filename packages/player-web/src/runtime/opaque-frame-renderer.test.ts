import { describe, expect, it } from "vitest";

import {
  OPAQUE_STREAMING_SLOT_COUNT,
  OpaqueFrameRenderer,
  RendererDisposedError,
  RendererFrameUnavailableError,
  RendererUnavailableError,
  RendererUploadTimeoutError,
  type BorrowedVideoFrame,
  type CopyableVideoFrame,
  type OpaqueFrameRendererBackend,
  type OpaqueFrameTextureLayout,
  type OpaqueTextureKind
} from "./opaque-frame-renderer.js";

const LAYOUT: OpaqueFrameTextureLayout = {
  codedWidth: 4,
  codedHeight: 3,
  logicalWidth: 8,
  logicalHeight: 6,
  residentLayerCount: 2
};

describe("opaque frame renderer", () => {
  it("sizes the one staging surface for a logical canvas larger than the coded rendition", async () => {
    const backend = new FakeBackend();
    const renderer = new OpaqueFrameRenderer(backend, LAYOUT);
    const residentSource = borrowedFrame(11);
    const streamSource = borrowedFrame(29);
    const resident = await renderer.uploadResident(1, residentSource.source);
    const stream = await renderer.uploadStreaming(2, 7, streamSource.source);

    expect(backend.allocations).toEqual([{
      ...LAYOUT,
      streamingSlots: OPAQUE_STREAMING_SLOT_COUNT
    }]);
    expect(backend.uploads.map(({ kind, index, firstByte }) =>
      [kind, index, firstByte]
    )).toEqual([
      ["resident", 1, 11],
      ["stream", 2, 29]
    ]);
    expect(backend.uploads[0]?.pixels).toBe(backend.uploads[1]?.pixels);
    expect(residentSource.closeCalls()).toBe(1);
    expect(streamSource.closeCalls()).toBe(1);
    if (resident === null || stream === null) throw new Error("missing handle");
    renderer.draw(resident);
    renderer.draw(stream);
    expect(backend.draws).toEqual([["resident", 1], ["stream", 2]]);
    expect(renderer.snapshot()).toMatchObject({
      stagingBytes: 192,
      allocatedLayers: 2,
      uploadedResidentLayers: 1,
      uploadedStreamingSlots: 1,
      draws: 2,
      closedSourceFrames: 2
    });
  });

  it("accepts zero resident layers without inventing a resident allocation", async () => {
    const backend = new FakeBackend();
    const renderer = new OpaqueFrameRenderer(backend, {
      ...LAYOUT,
      residentLayerCount: 0
    });
    const source = borrowedFrame(4);
    const stream = await renderer.uploadStreaming(0, 1, source.source);

    expect(backend.allocations[0]).toMatchObject({ residentLayerCount: 0 });
    expect(renderer.snapshot()).toMatchObject({ allocatedLayers: 0 });
    expect(() => renderer.residentHandle(0)).toThrow(RangeError);
    if (stream === null) throw new Error("missing stream handle");
    expect(() => renderer.draw(stream)).not.toThrow();
  });

  it.each([0, 1, 2, 4, 3.5, Number.NaN])(
    "rejects a non-three streaming allocation: %s",
    (streamingSlots) => {
      const backend = new FakeBackend();
      expect(() => new OpaqueFrameRenderer(
        backend,
        LAYOUT,
        { streamingSlots }
      )).toThrow("streaming slots must be exactly 3");
      expect(backend.allocations).toEqual([]);
    }
  );

  it("owns each borrowed source once and rejects a second transfer", async () => {
    const renderer = new OpaqueFrameRenderer(new FakeBackend(), LAYOUT);
    const source = borrowedFrame(8);
    await renderer.uploadResident(0, source.source);

    expect(() => renderer.uploadStreaming(0, 1, source.source))
      .toThrow("ownership was already transferred");
    expect(source.closeCalls()).toBe(1);
    expect(renderer.snapshot().closedSourceFrames).toBe(1);
  });

  it("versions all three streaming slots and rejects overwritten handles", async () => {
    const renderer = new OpaqueFrameRenderer(new FakeBackend(), LAYOUT);
    const handles = await Promise.all([0, 1, 2].map((slot) =>
      renderer.uploadStreaming(slot, 4, borrowedFrame(slot).source)
    ));
    const first = handles[1];
    if (first === null || first === undefined) {
      throw new Error("missing first handle");
    }
    const replacement = await renderer.uploadStreaming(
      1,
      4,
      borrowedFrame(9).source
    );
    if (replacement === null) throw new Error("missing replacement handle");

    expect(() => renderer.draw(first)).toThrow(RendererFrameUnavailableError);
    expect(() => renderer.draw(replacement)).not.toThrow();
    expect(renderer.snapshot().uploadedStreamingSlots).toBe(3);
  });

  it("terminalizes context loss and closes queued frames as stale", async () => {
    const backend = new FakeBackend();
    const renderer = new OpaqueFrameRenderer(backend, LAYOUT);
    const gate = deferred();
    const first = borrowedFrame(1, { copyGate: gate.promise });
    const second = borrowedFrame(2);
    const firstUpload = renderer.uploadResident(0, first.source);
    const secondUpload = renderer.uploadResident(1, second.source);
    await Promise.resolve();
    renderer.markContextLost();
    gate.resolve();

    await expect(firstUpload).resolves.toBeNull();
    await expect(secondUpload).resolves.toBeNull();
    expect(first.closeCalls()).toBe(1);
    expect(second.closeCalls()).toBe(1);
    expect(backend.disposeCalls).toBe(1);
    expect(renderer.snapshot()).toMatchObject({
      state: "lost",
      resourceGeneration: 2,
      staleUploads: 2
    });
    const replacement = new FakeBackend();
    expect(() => renderer.restore(replacement))
      .toThrow("context loss is terminal");
    expect(replacement.disposeCalls).toBe(1);
  });

  it("closes bad geometry and upload failures while releasing partial resources", async () => {
    const badGeometryBackend = new FakeBackend();
    const badGeometryRenderer = new OpaqueFrameRenderer(
      badGeometryBackend,
      LAYOUT
    );
    const bad = borrowedFrame(1, { displayWidth: 5 });
    await expect(badGeometryRenderer.uploadResident(0, bad.source))
      .rejects.toThrow("geometry");
    expect(bad.closeCalls()).toBe(1);
    expect(badGeometryBackend.disposeCalls).toBe(1);
    expect(badGeometryRenderer.snapshot()).toMatchObject({
      state: "error",
      errors: 1
    });

    const uploadBackend = new FakeBackend();
    uploadBackend.failUpload = true;
    const uploadRenderer = new OpaqueFrameRenderer(uploadBackend, LAYOUT);
    const source = borrowedFrame(3);
    await expect(uploadRenderer.uploadResident(0, source.source))
      .rejects.toThrow("injected upload failure");
    expect(source.closeCalls()).toBe(1);
    expect(uploadBackend.disposeCalls).toBe(1);
  });

  it("terminally releases allocation, draw, and readback failures", async () => {
    const allocation = new FakeBackend();
    allocation.failAllocate = true;
    expect(() => new OpaqueFrameRenderer(allocation, LAYOUT))
      .toThrow("injected allocation failure");
    expect(allocation.disposeCalls).toBe(1);

    const drawing = new FakeBackend();
    const drawRenderer = new OpaqueFrameRenderer(drawing, LAYOUT);
    const handle = await drawRenderer.uploadStreaming(
      0,
      1,
      borrowedFrame(2).source
    );
    if (handle === null) throw new Error("missing handle");
    drawing.failDraw = true;
    expect(() => drawRenderer.draw(handle)).toThrow("injected draw failure");
    expect(drawing.disposeCalls).toBe(1);
    expect(drawRenderer.snapshot().state).toBe("error");

    const reading = new FakeBackend();
    const readRenderer = new OpaqueFrameRenderer(reading, LAYOUT);
    reading.failRead = true;
    expect(() => readRenderer.readPixels()).toThrow("injected read failure");
    expect(reading.disposeCalls).toBe(1);
    expect(readRenderer.snapshot().state).toBe("error");
  });

  it("rejects unavailable readback without corrupting an otherwise active renderer", () => {
    const backend = new FakeBackend();
    const renderer = new OpaqueFrameRenderer(withoutReadback(backend), LAYOUT);

    expect(() => renderer.readPixels()).toThrow(RendererUnavailableError);
    expect(renderer.snapshot().state).toBe("active");
  });

  it("disposes idempotently and prevents queued work from reaching the backend", async () => {
    const backend = new FakeBackend();
    const renderer = new OpaqueFrameRenderer(backend, LAYOUT);
    const source = borrowedFrame(6);
    const upload = renderer.uploadResident(0, source.source);
    renderer.dispose();
    renderer.dispose();

    await expect(upload).resolves.toBeNull();
    expect(source.closeCalls()).toBe(1);
    expect(backend.uploads).toEqual([]);
    expect(backend.disposeCalls).toBe(1);
    expect(() => renderer.residentHandle(0)).toThrow(RendererDisposedError);
  });

  it("settles and closes a source whose browser copy never returns", async () => {
    const renderer = new OpaqueFrameRenderer(new FakeBackend(), LAYOUT);
    const source = borrowedFrame(6, { copyGate: new Promise(() => undefined) });
    const upload = renderer.uploadResident(0, source.source);
    await Promise.resolve();

    renderer.dispose();

    await expect(upload).resolves.toBeNull();
    await expect(renderer.settled()).resolves.toBeUndefined();
    expect(source.closeCalls()).toBe(1);
    expect(renderer.snapshot()).toMatchObject({
      state: "disposed",
      closedSourceFrames: 1,
      staleUploads: 1
    });
  });

  it("terminalizes a live copy at the bounded upload watchdog", async () => {
    const callbacks: Array<() => void> = [];
    const backend = new FakeBackend();
    const renderer = new OpaqueFrameRenderer(backend, LAYOUT, {
      copyTimeoutMs: 10,
      timers: {
        setTimeout(callback) {
          callbacks.push(callback);
          return callbacks.length;
        },
        clearTimeout() {}
      }
    });
    const source = borrowedFrame(7, { copyGate: new Promise(() => undefined) });
    const upload = renderer.uploadResident(0, source.source);
    await Promise.resolve();
    expect(callbacks).toHaveLength(1);

    callbacks[0]!();

    await expect(upload).rejects.toBeInstanceOf(RendererUploadTimeoutError);
    await expect(renderer.settled()).resolves.toBeUndefined();
    expect(source.closeCalls()).toBe(1);
    expect(backend.disposeCalls).toBe(1);
    expect(renderer.snapshot()).toMatchObject({ state: "error", errors: 1 });
  });
});

class FakeBackend implements OpaqueFrameRendererBackend {
  public readonly limits = Object.freeze({
    maxTextureSize: 8_192,
    maxArrayTextureLayers: 2_048
  });
  public readonly allocations: Array<
    OpaqueFrameTextureLayout & { readonly streamingSlots: number }
  > = [];
  public readonly uploads: Array<{
    readonly kind: OpaqueTextureKind;
    readonly index: number;
    readonly firstByte: number;
    readonly pixels: Uint8Array;
  }> = [];
  public readonly draws: Array<[OpaqueTextureKind, number]> = [];
  public failAllocate = false;
  public failUpload = false;
  public failDraw = false;
  public failRead = false;
  public disposeCalls = 0;

  public allocate(
    layout: OpaqueFrameTextureLayout,
    streamingSlots: number
  ): void {
    if (this.failAllocate) throw new Error("injected allocation failure");
    this.allocations.push({ ...layout, streamingSlots });
  }

  public upload(
    kind: OpaqueTextureKind,
    index: number,
    pixels: Uint8Array
  ): void {
    if (this.failUpload) throw new Error("injected upload failure");
    this.uploads.push({
      kind,
      index,
      firstByte: pixels[0] ?? -1,
      pixels
    });
  }

  public draw(kind: OpaqueTextureKind, index: number): void {
    if (this.failDraw) throw new Error("injected draw failure");
    this.draws.push([kind, index]);
  }

  public readPixels(): Uint8Array {
    if (this.failRead) throw new Error("injected read failure");
    return new Uint8Array([1, 2, 3, 4]);
  }

  public dispose(): void {
    this.disposeCalls += 1;
  }
}

function borrowedFrame(
  value: number,
  options: {
    readonly displayWidth?: number;
    readonly copyGate?: Promise<void>;
  } = {}
): { readonly source: BorrowedVideoFrame; closeCalls(): number } {
  let closes = 0;
  const frame: CopyableVideoFrame = {
    codedWidth: LAYOUT.codedWidth,
    codedHeight: LAYOUT.codedHeight,
    displayWidth: options.displayWidth ?? LAYOUT.codedWidth,
    displayHeight: LAYOUT.codedHeight,
    visibleRect: {
      x: 0,
      y: 0,
      width: LAYOUT.codedWidth,
      height: LAYOUT.codedHeight
    } as DOMRectReadOnly,
    async copyTo(destination) {
      await options.copyGate;
      const bytes = ArrayBuffer.isView(destination)
        ? new Uint8Array(
            destination.buffer,
            destination.byteOffset,
            destination.byteLength
          )
        : new Uint8Array(destination);
      bytes.fill(value);
      return [{ offset: 0, stride: LAYOUT.codedWidth * 4 }];
    }
  };
  return {
    source: {
      frame,
      close() {
        closes += 1;
      }
    },
    closeCalls: () => closes
  };
}

function withoutReadback(backend: FakeBackend): OpaqueFrameRendererBackend {
  return {
    limits: backend.limits,
    allocate: backend.allocate.bind(backend),
    upload: backend.upload.bind(backend),
    draw: backend.draw.bind(backend),
    dispose: backend.dispose.bind(backend)
  };
}

function deferred(): {
  readonly promise: Promise<void>;
  resolve(): void;
} {
  let resolvePromise: () => void;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve() {
      resolvePromise();
    }
  };
}
