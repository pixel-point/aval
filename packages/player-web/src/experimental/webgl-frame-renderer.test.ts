import { describe, expect, it } from "vitest";

import {
  BrowserWebGl2FrameBackend,
  RendererDisposedError,
  RendererFrameUnavailableError,
  RendererUnavailableError,
  STREAMING_SLOT_COUNT,
  WebGlFrameRenderer,
  type BackendTextureKind,
  type BorrowedVideoFrame,
  type CopyableVideoFrame,
  type FrameRendererBackend,
  type FrameTextureLayout
} from "./webgl-frame-renderer.js";

const LAYOUT: FrameTextureLayout = {
  width: 4,
  height: 3,
  layerCount: 3
};

describe("WebGlFrameRenderer", () => {
  it("allocates once, serializes uploads, reuses one staging buffer, and closes sources", async () => {
    const backend = new FakeBackend();
    const renderer = new WebGlFrameRenderer(backend, LAYOUT);
    const first = createBorrowedFrame(11);
    const second = createBorrowedFrame(29);

    const [resident, stream] = await Promise.all([
      renderer.uploadResident(1, first.source),
      renderer.uploadStreaming(0, 7, second.source)
    ]);

    expect(backend.allocations).toEqual([
      { ...LAYOUT, streamingSlots: STREAMING_SLOT_COUNT }
    ]);
    expect(backend.uploads.map(({ kind, index, firstByte }) => [kind, index, firstByte])).toEqual([
      ["resident", 1, 11],
      ["stream", 0, 29]
    ]);
    expect(backend.uploads[0]?.pixels).toBe(backend.uploads[1]?.pixels);
    expect(first.closeCalls()).toBe(1);
    expect(second.closeCalls()).toBe(1);
    expect(resident).toEqual({
      kind: "resident",
      layer: 1,
      resourceGeneration: 1
    });
    expect(stream).toEqual({
      kind: "stream",
      slot: 0,
      pathGeneration: 7,
      uploadSerial: 1,
      resourceGeneration: 1
    });

    renderer.draw(renderer.residentHandle(1));
    if (stream === null) {
      throw new Error("stream handle unexpectedly missing");
    }
    renderer.draw(stream);
    expect(backend.draws).toEqual([
      ["resident", 1],
      ["stream", 0]
    ]);
    expect(renderer.snapshot()).toMatchObject({
      state: "active",
      stagingBytes: 48,
      allocatedLayers: 3,
      uploadedResidentLayers: 1,
      uploadedStreamingSlots: 1,
      residentUploads: 1,
      streamingUploads: 1,
      draws: 2,
      closedSourceFrames: 2,
      staleUploads: 0,
      errors: 0
    });
  });

  it.each([0, 1, 2, 4, 1.5, Number.NaN])(
    "rejects a non-three streaming-slot allocation: %s",
    (streamingSlots) => {
      const backend = new FakeBackend();

      expect(
        () => new WebGlFrameRenderer(backend, LAYOUT, { streamingSlots })
      ).toThrow("streaming slots must be exactly 3");
      expect(backend.allocations).toHaveLength(0);
      expect(backend.disposeCalls).toBe(0);
    }
  );

  it("rejects hardware-limit overflow before backend allocation", () => {
    const backend = new FakeBackend({
      maxTextureSize: 3,
      maxArrayTextureLayers: 3
    });

    expect(() => new WebGlFrameRenderer(backend, LAYOUT)).toThrow(
      /MAX_TEXTURE_SIZE/
    );
    expect(backend.allocations).toHaveLength(0);
    expect(backend.disposeCalls).toBe(0);
  });

  it("closes a bad-geometry source and terminally releases partial resources", async () => {
    const backend = new FakeBackend();
    const renderer = new WebGlFrameRenderer(backend, LAYOUT);
    const bad = createBorrowedFrame(1, { displayWidth: 5 });

    await expect(renderer.uploadResident(0, bad.source)).rejects.toThrow(
      /geometry/
    );
    expect(bad.closeCalls()).toBe(1);
    expect(backend.disposeCalls).toBe(1);
    expect(renderer.snapshot()).toMatchObject({
      state: "error",
      allocatedLayers: 0,
      uploadedResidentLayers: 0,
      errors: 1,
      closedSourceFrames: 1
    });
    expect(() => renderer.draw({
      kind: "resident",
      layer: 0,
      resourceGeneration: 1
    })).toThrow(RendererUnavailableError);
  });

  it("deletes a partial texture set when backend upload fails", async () => {
    const backend = new FakeBackend();
    backend.failUploadAt = 2;
    const renderer = new WebGlFrameRenderer(backend, LAYOUT);
    const first = createBorrowedFrame(3);
    const second = createBorrowedFrame(4);

    await renderer.uploadResident(0, first.source);
    await expect(renderer.uploadResident(1, second.source)).rejects.toThrow(
      /injected upload failure/
    );

    expect(first.closeCalls()).toBe(1);
    expect(second.closeCalls()).toBe(1);
    expect(backend.disposeCalls).toBe(1);
    expect(renderer.snapshot()).toMatchObject({
      state: "error",
      allocatedLayers: 0,
      uploadedResidentLayers: 0,
      errors: 1
    });
  });

  it("closes queued work as stale when context loss wins the async race", async () => {
    const backend = new FakeBackend();
    const renderer = new WebGlFrameRenderer(backend, LAYOUT);
    const deferred = createDeferred<void>();
    const first = createBorrowedFrame(8, { copyGate: deferred.promise });
    const second = createBorrowedFrame(9);
    const firstUpload = renderer.uploadResident(0, first.source);
    const secondUpload = renderer.uploadResident(1, second.source);
    await Promise.resolve();

    renderer.markContextLost();
    deferred.resolve();

    await expect(firstUpload).resolves.toBeNull();
    await expect(secondUpload).resolves.toBeNull();
    expect(first.closeCalls()).toBe(1);
    expect(second.closeCalls()).toBe(1);
    expect(backend.uploads).toHaveLength(0);
    expect(backend.disposeCalls).toBe(1);
    expect(renderer.snapshot()).toMatchObject({
      state: "lost",
      resourceGeneration: 2,
      staleUploads: 2,
      closedSourceFrames: 2
    });
  });

  it("restores with a new backend and invalidates every old handle", async () => {
    const oldBackend = new FakeBackend();
    const renderer = new WebGlFrameRenderer(oldBackend, LAYOUT);
    const oldSource = createBorrowedFrame(5);
    const oldHandle = await renderer.uploadResident(0, oldSource.source);
    if (oldHandle === null) {
      throw new Error("resident handle unexpectedly missing");
    }
    renderer.markContextLost();

    const replacement = new FakeBackend();
    renderer.restore(replacement);
    expect(() => renderer.draw(oldHandle)).toThrow(
      RendererFrameUnavailableError
    );
    expect(() => renderer.residentHandle(0)).toThrow(
      RendererFrameUnavailableError
    );

    const freshSource = createBorrowedFrame(6);
    const fresh = await renderer.uploadResident(
      0,
      freshSource.source,
      renderer.resourceGeneration
    );
    if (fresh === null) {
      throw new Error("fresh resident handle unexpectedly missing");
    }
    renderer.draw(fresh);
    expect(replacement.uploads).toHaveLength(1);
    expect(replacement.draws).toEqual([["resident", 0]]);
  });

  it("disposes idempotently and prevents queued work from touching the backend", async () => {
    const backend = new FakeBackend();
    const renderer = new WebGlFrameRenderer(backend, LAYOUT);
    const source = createBorrowedFrame(7);
    const upload = renderer.uploadResident(0, source.source);

    renderer.dispose();
    renderer.dispose();

    await expect(upload).resolves.toBeNull();
    expect(source.closeCalls()).toBe(1);
    expect(backend.uploads).toHaveLength(0);
    expect(backend.disposeCalls).toBe(1);
    expect(renderer.snapshot()).toMatchObject({
      state: "disposed",
      allocatedLayers: 0,
      staleUploads: 1
    });
    expect(() => renderer.residentHandle(0)).toThrow(RendererDisposedError);
  });

  it("rejects a draw until its resident layer has completed upload", () => {
    const renderer = new WebGlFrameRenderer(new FakeBackend(), LAYOUT);
    expect(() => renderer.residentHandle(2)).toThrow(
      RendererFrameUnavailableError
    );
  });

  it("rejects a streaming handle after its reusable slot is overwritten", async () => {
    const renderer = new WebGlFrameRenderer(new FakeBackend(), LAYOUT);
    const first = await renderer.uploadStreaming(
      0,
      2,
      createBorrowedFrame(1).source
    );
    const second = await renderer.uploadStreaming(
      0,
      2,
      createBorrowedFrame(2).source
    );
    if (first === null || second === null) {
      throw new Error("stream handle unexpectedly missing");
    }

    expect(() => renderer.draw(first)).toThrow(RendererFrameUnavailableError);
    expect(() => renderer.draw(second)).not.toThrow();
  });

  it.each(["fragment", "program"] as const)(
    "deletes compiled shaders when %s creation fails",
    (failure) => {
      const fixture = createShaderFailureCanvas(failure);
      const backend = new BrowserWebGl2FrameBackend(fixture.canvas);

      expect(() => backend.allocate(LAYOUT, STREAMING_SLOT_COUNT)).toThrow();
      expect(new Set(fixture.deletedShaders)).toEqual(
        new Set(fixture.shaders)
      );
    }
  );
});

class FakeBackend implements FrameRendererBackend {
  public readonly limits;
  public readonly allocations: Array<FrameTextureLayout & { streamingSlots: number }> = [];
  public readonly uploads: Array<{
    kind: BackendTextureKind;
    index: number;
    firstByte: number;
    pixels: Uint8Array;
  }> = [];
  public readonly draws: Array<[BackendTextureKind, number]> = [];
  public failUploadAt: number | null = null;
  public disposeCalls = 0;

  public constructor(
    limits = { maxTextureSize: 8_192, maxArrayTextureLayers: 2_048 }
  ) {
    this.limits = Object.freeze({ ...limits });
  }

  public allocate(layout: FrameTextureLayout, streamingSlots: number): void {
    this.allocations.push({ ...layout, streamingSlots });
  }

  public upload(
    kind: BackendTextureKind,
    index: number,
    pixels: Uint8Array
  ): void {
    if (this.failUploadAt === this.uploads.length + 1) {
      throw new Error("injected upload failure");
    }
    this.uploads.push({
      kind,
      index,
      firstByte: pixels[0] ?? -1,
      pixels
    });
  }

  public draw(kind: BackendTextureKind, index: number): void {
    this.draws.push([kind, index]);
  }

  public readPixels(): Uint8Array {
    return new Uint8Array([1, 2, 3, 4]);
  }

  public dispose(): void {
    this.disposeCalls += 1;
  }
}

interface FakeFrameOptions {
  readonly displayWidth?: number;
  readonly copyGate?: Promise<void>;
}

function createBorrowedFrame(value: number, options: FakeFrameOptions = {}): {
  readonly source: BorrowedVideoFrame;
  closeCalls(): number;
} {
  let closes = 0;
  const visibleRect = {
    x: 0,
    y: 0,
    width: LAYOUT.width,
    height: LAYOUT.height
  } as DOMRectReadOnly;
  const frame: CopyableVideoFrame = {
    codedWidth: LAYOUT.width,
    codedHeight: LAYOUT.height,
    displayWidth: options.displayWidth ?? LAYOUT.width,
    displayHeight: LAYOUT.height,
    visibleRect,
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
      return [{ offset: 0, stride: LAYOUT.width * 4 }];
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

function createDeferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolvePromise: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value) {
      resolvePromise(value);
    }
  };
}

function createShaderFailureCanvas(failure: "fragment" | "program"): {
  readonly canvas: HTMLCanvasElement;
  readonly shaders: readonly WebGLShader[];
  readonly deletedShaders: WebGLShader[];
} {
  const vertex = { label: "vertex" } as unknown as WebGLShader;
  const fragment = { label: "fragment" } as unknown as WebGLShader;
  const shaders = [vertex, fragment] as const;
  const deletedShaders: WebGLShader[] = [];
  let shaderIndex = 0;
  const gl = {
    MAX_TEXTURE_SIZE: 1,
    MAX_ARRAY_TEXTURE_LAYERS: 2,
    VERTEX_SHADER: 3,
    FRAGMENT_SHADER: 4,
    COMPILE_STATUS: 5,
    getParameter() {
      return 8_192;
    },
    createShader() {
      return shaders[shaderIndex++] ?? null;
    },
    shaderSource() {},
    compileShader() {},
    getShaderParameter(shader: WebGLShader) {
      return failure !== "fragment" || shader !== fragment;
    },
    getShaderInfoLog() {
      return "injected shader failure";
    },
    deleteShader(shader: WebGLShader) {
      deletedShaders.push(shader);
    },
    createProgram() {
      return failure === "program"
        ? null
        : ({ label: "program" } as unknown as WebGLProgram);
    },
    deleteProgram() {},
    deleteTexture() {},
    deleteVertexArray() {}
  } as unknown as WebGL2RenderingContext;
  const canvas = {
    width: 0,
    height: 0,
    getContext() {
      return gl;
    }
  } as unknown as HTMLCanvasElement;

  return { canvas, shaders, deletedShaders };
}
