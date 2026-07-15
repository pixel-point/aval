import { deriveAvcRenditionGeometry } from "@pixel-point/aval-format";
import { describe, expect, it } from "vitest";

import {
  FRAME_STREAMING_SLOT_COUNT,
  FrameRenderer,
  LegacyOpaqueFrameRenderer,
  RendererFrameUnavailableError,
  RendererUploadTimeoutError,
  type BorrowedVideoFrame,
  type CopyableVideoFrame,
  type FrameRendererBackend,
  type LegacyOpaqueFrameRendererBackend,
  type LegacyOpaqueFrameTextureLayout,
  type FrameTextureKind,
  type FrameTextureLayout
} from "./frame-renderer.js";

const GEOMETRY = deriveAvcRenditionGeometry({
  profile: "avc-annexb-packed-alpha-v0",
  canvasWidth: 3,
  canvasHeight: 1,
  colorRect: [0, 0, 3, 1],
  alphaRect: [0, 10, 3, 1],
  codedWidth: 16,
  codedHeight: 16
});

const LAYOUT: FrameTextureLayout = {
  geometry: GEOMETRY,
  logicalWidth: 6,
  logicalHeight: 2,
  residentLayerCount: 2
};

describe("profile-neutral frame renderer", () => {
  it("applies MAX_TEXTURE_SIZE only to allocated coded textures", () => {
    const backend = new FakeBackend();
    const geometry = deriveAvcRenditionGeometry({
      profile: "avc-annexb-opaque-v0",
      canvasWidth: 12_000,
      canvasHeight: 4_000,
      colorRect: [0, 0, 3, 1],
      codedWidth: 16,
      codedHeight: 16
    });

    expect(() => new FrameRenderer(backend, {
      geometry,
      logicalWidth: 12_000,
      logicalHeight: 4_000,
      residentLayerCount: 0
    })).not.toThrow();
    expect(backend.allocations).toHaveLength(1);
  });

  it("keeps the legacy device check scoped to coded textures", () => {
    const backend = new FakeLegacyBackend();

    expect(() => new LegacyOpaqueFrameRenderer(backend, {
      codedWidth: 16,
      codedHeight: 16,
      logicalWidth: 12_000,
      logicalHeight: 4_000,
      residentLayerCount: 0
    })).not.toThrow();
  });

  it("rejects a forged packed-alpha gutter before allocating a backend", () => {
    const backend = new FakeBackend();
    expect(() => new FrameRenderer(backend, {
      ...LAYOUT,
      geometry: {
        ...GEOMETRY,
        visibleAlphaRect: [0, 8, 3, 1]
      }
    })).toThrow(/fixed eight-pixel gutter/);
    expect(backend.allocations).toHaveLength(0);
  });

  it("rejects a forged decoded crop even when its byte count is consistent", () => {
    const backend = new FakeBackend();
    expect(() => new FrameRenderer(backend, {
      ...LAYOUT,
      geometry: {
        ...GEOMETRY,
        decodedStorageRect: [0, 0, 4, 11],
        decodedRgbaBytes: 4 * 11 * 4
      }
    })).toThrow(/canonical AVC rendition geometry/);
    expect(backend.allocations).toHaveLength(0);
  });

  it("copies the exact decoded storage rect into one coded-size staging surface", async () => {
    const backend = new FakeBackend();
    const renderer = new FrameRenderer(backend, LAYOUT);
    const source = borrowedFrame(41);

    const handle = await renderer.uploadResident(1, source.source);

    expect(handle).toEqual({
      kind: "resident",
      layer: 1,
      resourceGeneration: 1
    });
    expect(source.closeCalls()).toBe(1);
    expect(source.copyOptions()).toEqual({
      rect: {
        x: 0,
        y: 0,
        width: 4,
        height: 12
      },
      format: "RGBA",
      layout: [{ offset: 0, stride: 64 }]
    });
    expect(backend.allocations).toEqual([{
      layout: expect.objectContaining({
        geometry: GEOMETRY,
        logicalWidth: 6,
        logicalHeight: 2,
        residentLayerCount: 2
      }),
      streamingSlots: FRAME_STREAMING_SLOT_COUNT
    }]);
    const allocatedLayout = backend.allocations[0]?.layout;
    expect(Object.isFrozen(allocatedLayout)).toBe(true);
    expect(Object.isFrozen(allocatedLayout?.geometry)).toBe(true);
    expect(Object.isFrozen(
      allocatedLayout?.geometry.decodedStorageRect
    )).toBe(true);
    expect(backend.uploads[0]?.pixels).toHaveLength(16 * 16 * 4);
    expect(renderer.snapshot()).toMatchObject({
      stagingBytes: 16 * 16 * 4,
      codedTextureBytesPerLayer: 16 * 16 * 4,
      allocatedTextureBytes: 16 * 16 * 4 * 5,
      allocatedTextureLayers: 5,
      closedSourceFrames: 1
    });
  });

  it("uploads a validated native frame when the backend supports it", async () => {
    const backend = new FakeNativeBackend();
    const renderer = new FrameRenderer(backend, LAYOUT);
    const source = borrowedFrame(31, {
      copyFailure: new TypeError("RGBA copy is unsupported")
    });

    await expect(renderer.uploadResident(1, source.source)).resolves.toEqual({
      kind: "resident",
      layer: 1,
      resourceGeneration: 1
    });
    expect(source.copyOptions()).toBeUndefined();
    expect(source.closeCalls()).toBe(1);
    expect(backend.uploads).toHaveLength(0);
    expect(backend.frameUploads).toEqual([{
      kind: "resident",
      index: 1,
      frame: source.source.frame,
      layout: { x: 0, y: 0, width: 4, height: 12 }
    }]);
  });

  it("falls back to the bounded RGBA copy when native upload fails", async () => {
    const backend = new FakeNativeBackend();
    backend.frameUploadFailure = new TypeError("native upload is unsupported");
    const renderer = new FrameRenderer(backend, LAYOUT);
    const source = borrowedFrame(19);

    await expect(renderer.uploadStreaming(0, 1, source.source)).resolves.toMatchObject({
      kind: "stream",
      slot: 0,
      pathGeneration: 1
    });
    expect(source.copyOptions()).toEqual({
      rect: { x: 0, y: 0, width: 4, height: 12 },
      format: "RGBA",
      layout: [{ offset: 0, stride: 64 }]
    });
    expect(source.closeCalls()).toBe(1);
    expect(backend.uploads).toHaveLength(1);
  });

  it("does not commit a native upload that reenters renderer disposal", async () => {
    const backend = new FakeNativeBackend();
    const renderer = new FrameRenderer(backend, LAYOUT);
    const source = borrowedFrame(13);
    backend.frameUploadAction = () => renderer.dispose();

    await expect(renderer.uploadResident(0, source.source)).resolves.toBeNull();
    expect(source.closeCalls()).toBe(1);
    expect(renderer.snapshot()).toMatchObject({
      state: "disposed",
      uploadedResidentLayers: 0,
      residentUploads: 0
    });
  });

  it("bounds browser-owned coded padding while copying only exact storage pixels", async () => {
    const backend = new FakeBackend();
    const renderer = new FrameRenderer(backend, LAYOUT);
    const source = borrowedFrame(23, {
      codedWidth: 32,
      codedHeight: 34
    });

    await expect(renderer.uploadResident(0, source.source)).resolves.toMatchObject({
      kind: "resident",
      layer: 0
    });
    expect(source.copyOptions()).toEqual({
      rect: { x: 0, y: 0, width: 4, height: 12 },
      format: "RGBA",
      layout: [{ offset: 0, stride: 64 }]
    });
    expect(backend.uploads[0]?.pixels).toHaveLength(16 * 16 * 4);
  });

  it("rejects decoder allocation outside the reserved padding bound", async () => {
    const backend = new FakeBackend();
    const renderer = new FrameRenderer(backend, LAYOUT);
    const source = borrowedFrame(23, {
      codedWidth: 49,
      codedHeight: 16
    });

    await expect(renderer.uploadResident(0, source.source)).rejects.toThrow(
      /decoded frame geometry/
    );
    expect(source.closeCalls()).toBe(1);
    expect(backend.uploads).toHaveLength(0);
  });

  it("rejects a wrong copy layout, closes once, and terminalizes", async () => {
    const backend = new FakeBackend();
    const renderer = new FrameRenderer(backend, LAYOUT);
    const source = borrowedFrame(7, { copyStride: 16 });

    await expect(renderer.uploadResident(0, source.source)).rejects.toThrow(
      /copy layout/
    );
    expect(source.closeCalls()).toBe(1);
    expect(backend.uploads).toHaveLength(0);
    expect(backend.disposeCalls).toBe(1);
    expect(renderer.snapshot()).toMatchObject({ state: "error", errors: 1 });
  });

  it("does not expose a browser backend exception message", async () => {
    const backend = new FakeBackend();
    backend.uploadFailure = new Error("driver-secret-raw-message");
    const renderer = new FrameRenderer(backend, LAYOUT);
    const source = borrowedFrame(7);

    const failure = await renderer.uploadResident(0, source.source).catch(
      (error: unknown) => error
    );
    expect(failure).toMatchObject({
      message: "failed to upload a WebGL frame"
    });
    expect((failure as Error).message).not.toContain("driver-secret");
  });

  it("sanitizes host RangeErrors from every frame presentation boundary", async () => {
    const uploadBackend = new FakeBackend();
    uploadBackend.uploadFailure = new RangeError("/private/upload-secret");
    const uploadRenderer = new FrameRenderer(uploadBackend, LAYOUT);
    const uploadFailure = await uploadRenderer
      .uploadResident(0, borrowedFrame(1).source)
      .catch((error: unknown) => error);
    expect(uploadFailure).toMatchObject({
      message: "failed to upload a WebGL frame"
    });

    const copyRenderer = new FrameRenderer(new FakeBackend(), LAYOUT);
    const copyFailure = await copyRenderer
      .uploadResident(0, borrowedFrame(2, {
        copyFailure: new RangeError("/private/copy-secret")
      }).source)
      .catch((error: unknown) => error);
    expect(copyFailure).toMatchObject({
      message: "failed to upload a WebGL frame"
    });

    const drawBackend = new FakeBackend();
    const drawRenderer = new FrameRenderer(drawBackend, LAYOUT);
    const drawHandle = await drawRenderer.uploadResident(
      0,
      borrowedFrame(3).source
    );
    if (drawHandle === null) throw new Error("draw handle is missing");
    drawBackend.drawFailure = new RangeError("/private/draw-secret");
    expect(() => drawRenderer.draw(drawHandle)).toThrow(
      "failed to draw a WebGL frame"
    );

    const readBackend = new FakeBackend();
    const readRenderer = new FrameRenderer(readBackend, LAYOUT);
    readBackend.readFailure = new RangeError("/private/read-secret");
    expect(() => readRenderer.readPixels()).toThrow(
      "failed to read WebGL frame pixels"
    );

    for (const failure of [uploadFailure, copyFailure]) {
      expect((failure as Error).message).not.toContain("private");
    }
  });

  it("sanitizes a native AbortError that was not authored by the renderer", async () => {
    const renderer = new FrameRenderer(new FakeBackend(), LAYOUT);
    const failure = await renderer.uploadResident(0, borrowedFrame(1, {
      copyFailure: new DOMException("/private/native-abort-secret", "AbortError")
    }).source).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      message: "failed to upload a WebGL frame"
    });
    expect((failure as Error).message).not.toContain("native-abort-secret");
  });

  it("terminalizes atomically when closing a transferred frame fails", async () => {
    const backend = new FakeBackend();
    const renderer = new FrameRenderer(backend, LAYOUT);
    const source = borrowedFrame(4, {
      closeFailure: new RangeError("/private/close-secret")
    });

    const failure = await renderer.uploadResident(0, source.source).catch(
      (error: unknown) => error
    );

    expect(failure).toMatchObject({
      message: "failed to close a decoded video frame"
    });
    expect((failure as Error).message).not.toContain("close-secret");
    expect(source.closeCalls()).toBe(1);
    expect(() => renderer.residentHandle(0)).toThrow();
    expect(renderer.snapshot()).toMatchObject({
      state: "error",
      uploadedResidentLayers: 0,
      closedSourceFrames: 0,
      errors: 1
    });
    expect(backend.disposeCalls).toBe(1);
  });

  it("does not commit an upload when the backend disposes the renderer", async () => {
    const backend = new FakeBackend();
    const renderer = new FrameRenderer(backend, LAYOUT);
    backend.uploadAction = () => renderer.dispose();

    await expect(renderer.uploadResident(0, borrowedFrame(5).source))
      .resolves.toBeNull();
    expect(renderer.snapshot()).toMatchObject({
      state: "disposed",
      stagingBytes: 0,
      sourceCopiesInFlight: 0,
      uploadedResidentLayers: 0,
      residentUploads: 0
    });
  });

  it("does not return a handle when source close disposes the renderer", async () => {
    const backend = new FakeBackend();
    const renderer = new FrameRenderer(backend, LAYOUT);
    const source = borrowedFrame(5, {
      closeAction: () => renderer.dispose()
    });

    await expect(renderer.uploadResident(0, source.source)).resolves.toBeNull();
    expect(source.closeCalls()).toBe(1);
    expect(renderer.snapshot()).toMatchObject({
      state: "disposed",
      stagingBytes: 0,
      uploadedResidentLayers: 0
    });
  });

  it("rejects draw and readback when their backend callbacks dispose", async () => {
    const drawBackend = new FakeBackend();
    const drawRenderer = new FrameRenderer(drawBackend, LAYOUT);
    const handle = await drawRenderer.uploadResident(0, borrowedFrame(2).source);
    if (handle === null) throw new Error("resident handle is missing");
    drawBackend.drawAction = () => drawRenderer.dispose();
    expect(() => drawRenderer.draw(handle)).toThrowError(
      expect.objectContaining({ name: "RendererDisposedError" })
    );
    expect(drawRenderer.snapshot().draws).toBe(0);

    const readBackend = new FakeBackend();
    const readRenderer = new FrameRenderer(readBackend, LAYOUT);
    readBackend.readAction = () => readRenderer.dispose();
    expect(() => readRenderer.readPixels()).toThrowError(
      expect.objectContaining({ name: "RendererDisposedError" })
    );
  });

  it("restores one geometry-backed implementation and invalidates old handles", async () => {
    const initial = new FakeBackend();
    const renderer = new FrameRenderer(initial, LAYOUT, {
      contextLossPolicy: "restorable"
    });
    const oldSource = borrowedFrame(1);
    const old = await renderer.uploadResident(0, oldSource.source);
    if (old === null) throw new Error("old resident handle is missing");

    renderer.markContextLost();
    const replacement = new FakeBackend();
    renderer.restore(replacement);

    expect(() => renderer.draw(old)).toThrow(RendererFrameUnavailableError);
    expect(replacement.allocations[0]?.layout.geometry).toEqual(GEOMETRY);
    const freshSource = borrowedFrame(2);
    const fresh = await renderer.uploadResident(
      0,
      freshSource.source,
      renderer.resourceGeneration
    );
    if (fresh === null) throw new Error("fresh resident handle is missing");
    renderer.draw(fresh);
    expect(oldSource.closeCalls()).toBe(1);
    expect(freshSource.closeCalls()).toBe(1);
    expect(replacement.draws).toEqual([["resident", 0]]);
  });

  it("refuses restoration while an uncancellable old frame copy owns staging", async () => {
    const callbacks: Array<() => void> = [];
    const gate = deferred<void>();
    const initial = new FakeBackend();
    const renderer = new FrameRenderer(initial, LAYOUT, {
      contextLossPolicy: "restorable",
      copyTimeoutMs: 10,
      timers: {
        setTimeout(callback) {
          callbacks.push(callback);
          return callbacks.length;
        },
        clearTimeout() {}
      }
    });
    const oldSource = borrowedFrame(9, { copyGate: gate.promise });
    const oldUpload = renderer.uploadResident(0, oldSource.source);
    await Promise.resolve();
    callbacks[0]!();
    await expect(oldUpload).rejects.toBeInstanceOf(RendererUploadTimeoutError);

    const premature = new FakeBackend();
    expect(() => renderer.restore(premature)).toThrow(
      "decoded frame copy is still settling"
    );
    expect(premature.disposeCalls).toBe(1);

    gate.resolve(undefined);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const replacement = new FakeBackend();
    renderer.restore(replacement);
    await renderer.uploadResident(0, borrowedFrame(4).source);
    expect(replacement.uploads[0]?.pixels[0]).toBe(4);
    expect(oldSource.closeCalls()).toBe(1);
  });

  it("does not resurrect when replacement allocation disposes the renderer", () => {
    const renderer = new FrameRenderer(new FakeBackend(), LAYOUT, {
      contextLossPolicy: "restorable"
    });
    renderer.markContextLost();
    const replacement = new FakeBackend();
    replacement.allocateAction = () => renderer.dispose();

    expect(() => renderer.restore(replacement)).toThrowError(
      expect.objectContaining({ name: "RendererDisposedError" })
    );
    expect(replacement.disposeCalls).toBe(1);
    expect(renderer.snapshot()).toMatchObject({
      state: "disposed",
      stagingBytes: 0,
      allocatedTextureBytes: 0
    });
  });

  it("does not resurrect when replacement limit inspection disposes the renderer", () => {
    const renderer = new FrameRenderer(new FakeBackend(), LAYOUT, {
      contextLossPolicy: "restorable"
    });
    renderer.markContextLost();
    let disposals = 0;
    const replacement = {
      get limits() {
        renderer.dispose();
        return { maxTextureSize: 8_192, maxArrayTextureLayers: 2_048 };
      },
      allocate() {},
      upload() {},
      draw() {},
      dispose() {
        disposals += 1;
      }
    } satisfies FrameRendererBackend;

    expect(() => renderer.restore(replacement)).toThrowError(
      expect.objectContaining({ name: "RendererDisposedError" })
    );
    expect(disposals).toBe(1);
    expect(renderer.snapshot()).toMatchObject({
      state: "disposed",
      stagingBytes: 0
    });
  });

  it("releases an invalid replacement backend during restore validation", () => {
    const renderer = new FrameRenderer(new FakeBackend(), LAYOUT, {
      contextLossPolicy: "restorable"
    });
    renderer.markContextLost();
    const replacement = new FakeBackend();
    Object.defineProperty(replacement, "limits", {
      value: { maxTextureSize: 8_192, maxArrayTextureLayers: 1 }
    });

    expect(() => renderer.restore(replacement)).toThrow();
    expect(replacement.disposeCalls).toBe(1);
    expect(renderer.snapshot().state).toBe("error");
  });

  it("releases renderer staging while an aborted native copy settles late", async () => {
    const renderer = new FrameRenderer(new FakeBackend(), LAYOUT);
    const source = borrowedFrame(8, {
      copyGate: new Promise<void>(() => undefined)
    });
    const upload = renderer.uploadResident(0, source.source);
    await Promise.resolve();

    renderer.dispose();

    await expect(upload).resolves.toBeNull();
    expect(renderer.snapshot()).toMatchObject({
      state: "disposed",
      stagingBytes: 0,
      sourceCopiesInFlight: 1,
      uploadedResidentLayers: 0
    });
    expect(source.closeCalls()).toBe(1);
  });

  it("watchdogs a live copy and still closes its source exactly once", async () => {
    const callbacks: Array<() => void> = [];
    const backend = new FakeBackend();
    const renderer = new FrameRenderer(backend, LAYOUT, {
      copyTimeoutMs: 10,
      timers: {
        setTimeout(callback) {
          callbacks.push(callback);
          return callbacks.length;
        },
        clearTimeout() {}
      }
    });
    const source = borrowedFrame(3, { copyGate: new Promise(() => undefined) });
    const upload = renderer.uploadStreaming(0, 1, source.source);
    await Promise.resolve();

    callbacks[0]!();

    await expect(upload).rejects.toBeInstanceOf(RendererUploadTimeoutError);
    await expect(renderer.settled()).resolves.toBeUndefined();
    expect(source.closeCalls()).toBe(1);
    expect(backend.disposeCalls).toBe(1);
  });

  it("requires format geometry through the neutral constructor", () => {
    expect(() => new FrameRenderer(new FakeBackend(), {
      logicalWidth: 1,
      logicalHeight: 1,
      residentLayerCount: 0
    } as FrameTextureLayout)).toThrow(/geometry/);
  });

  it("keeps implementation-selected coded padding inside the legacy adapter only", async () => {
    const backend = new FakeLegacyBackend();
    const layout: LegacyOpaqueFrameTextureLayout = {
      codedWidth: 256,
      codedHeight: 256,
      logicalWidth: 256,
      logicalHeight: 256,
      residentLayerCount: 1
    };
    const renderer = new LegacyOpaqueFrameRenderer(backend, layout);
    const source = borrowedFrame(9, {
      codedWidth: 272,
      codedHeight: 272,
      displayWidth: 256,
      displayHeight: 256,
      visibleWidth: 256,
      visibleHeight: 256,
      copyStride: 1_024
    });

    await expect(renderer.uploadResident(0, source.source)).resolves.toMatchObject({
      kind: "resident",
      layer: 0
    });
    expect(source.copyOptions()).toEqual({
      rect: { x: 0, y: 0, width: 256, height: 256 },
      format: "RGBA",
      layout: [{ offset: 0, stride: 1_024 }]
    });
    expect(source.closeCalls()).toBe(1);
    expect(backend.uploads[0]?.pixels).toHaveLength(256 * 256 * 4);
  });
});

class FakeBackend implements FrameRendererBackend {
  public readonly limits = Object.freeze({
    maxTextureSize: 8_192,
    maxArrayTextureLayers: 2_048
  });
  public readonly allocations: Array<{
    readonly layout: Readonly<FrameTextureLayout>;
    readonly streamingSlots: number;
  }> = [];
  public readonly uploads: Array<{
    readonly kind: FrameTextureKind;
    readonly index: number;
    readonly pixels: Uint8Array;
  }> = [];
  public readonly draws: Array<[FrameTextureKind, number]> = [];
  public disposeCalls = 0;
  public uploadFailure: Error | null = null;
  public drawFailure: Error | null = null;
  public readFailure: Error | null = null;
  public allocateAction: (() => void) | null = null;
  public uploadAction: (() => void) | null = null;
  public drawAction: (() => void) | null = null;
  public readAction: (() => void) | null = null;

  public allocate(layout: FrameTextureLayout, streamingSlots: number): void {
    this.allocateAction?.();
    this.allocations.push({ layout, streamingSlots });
  }

  public upload(kind: FrameTextureKind, index: number, pixels: Uint8Array): void {
    if (this.uploadFailure !== null) throw this.uploadFailure;
    this.uploadAction?.();
    this.uploads.push({ kind, index, pixels });
  }

  public draw(kind: FrameTextureKind, index: number): void {
    if (this.drawFailure !== null) throw this.drawFailure;
    this.drawAction?.();
    this.draws.push([kind, index]);
  }

  public readPixels(): Uint8Array {
    if (this.readFailure !== null) throw this.readFailure;
    this.readAction?.();
    return new Uint8Array([1, 2, 3, 4]);
  }

  public dispose(): void {
    this.disposeCalls += 1;
  }
}

class FakeNativeBackend extends FakeBackend {
  public readonly frameUploads: Array<{
    readonly kind: FrameTextureKind;
    readonly index: number;
    readonly frame: CopyableVideoFrame;
    readonly layout: Readonly<{
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
    }>;
  }> = [];
  public frameUploadFailure: Error | null = null;
  public frameUploadAction: (() => void) | null = null;

  public uploadFrame(
    kind: FrameTextureKind,
    index: number,
    frame: CopyableVideoFrame,
    layout: Readonly<{
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
    }>
  ): void {
    if (this.frameUploadFailure !== null) throw this.frameUploadFailure;
    this.frameUploadAction?.();
    this.frameUploads.push({ kind, index, frame, layout });
  }
}

class FakeLegacyBackend implements LegacyOpaqueFrameRendererBackend {
  public readonly limits = Object.freeze({
    maxTextureSize: 8_192,
    maxArrayTextureLayers: 2_048
  });
  public readonly uploads: Array<{
    readonly kind: FrameTextureKind;
    readonly index: number;
    readonly pixels: Uint8Array;
  }> = [];

  public allocate(): void {}

  public upload(kind: FrameTextureKind, index: number, pixels: Uint8Array): void {
    this.uploads.push({ kind, index, pixels });
  }

  public draw(): void {}

  public dispose(): void {}
}

function borrowedFrame(
  value: number,
  options: {
    readonly copyGate?: Promise<void>;
    readonly copyStride?: number;
    readonly codedWidth?: number;
    readonly codedHeight?: number;
    readonly displayWidth?: number;
    readonly displayHeight?: number;
    readonly visibleWidth?: number;
    readonly visibleHeight?: number;
    readonly copyFailure?: Error;
    readonly closeFailure?: Error;
    readonly closeAction?: () => void;
  } = {}
): {
  readonly source: BorrowedVideoFrame;
  closeCalls(): number;
  copyOptions(): unknown;
} {
  let closes = 0;
  let observedOptions: VideoFrameCopyToOptions | undefined;
  const visibleWidth = options.visibleWidth ?? 4;
  const visibleHeight = options.visibleHeight ?? 12;
  const frame: CopyableVideoFrame = {
    codedWidth: options.codedWidth ?? 16,
    codedHeight: options.codedHeight ?? 16,
    displayWidth: options.displayWidth ?? 4,
    displayHeight: options.displayHeight ?? 12,
    visibleRect: {
      x: 0,
      y: 0,
      width: visibleWidth,
      height: visibleHeight
    } as DOMRectReadOnly,
    async copyTo(destination, copyOptions) {
      observedOptions = copyOptions;
      await options.copyGate;
      if (options.copyFailure !== undefined) throw options.copyFailure;
      const bytes = ArrayBuffer.isView(destination)
        ? new Uint8Array(
            destination.buffer,
            destination.byteOffset,
            destination.byteLength
          )
        : new Uint8Array(destination);
      bytes.fill(value, 0, visibleWidth * visibleHeight * 4);
      return [{ offset: 0, stride: options.copyStride ?? 64 }];
    }
  };
  return {
    source: {
      frame,
      close() {
        closes += 1;
        options.closeAction?.();
        if (options.closeFailure !== undefined) throw options.closeFailure;
      }
    },
    closeCalls: () => closes,
    copyOptions: () => normalizeCopyOptions(observedOptions)
  };
}

function normalizeCopyOptions(options: VideoFrameCopyToOptions | undefined): unknown {
  if (options === undefined) return undefined;
  const rect = options.rect;
  return {
    rect: rect === undefined
      ? undefined
      : { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    format: options.format,
    layout: options.layout?.map(({ offset, stride }) => ({ offset, stride }))
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((done) => {
      resolve = done;
    }),
    resolve(value) {
      resolve(value);
    }
  };
}
