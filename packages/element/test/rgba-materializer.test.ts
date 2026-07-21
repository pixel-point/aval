import { describe, expect, it, vi } from "vitest";

import {
  MaterializerFailureError,
  RgbaMaterializer
} from "../src/rgba-materializer.js";

describe("RgbaMaterializer", () => {
  it("uses the exact RGBA copy contract and memoizes one copy per operation", async () => {
    const copyTo = vi.fn(async (
      destination: AllowSharedBufferSource,
      options?: VideoFrameCopyToOptions
    ) => {
      bytes(destination).set([1, 2, 3, 4, 5, 6, 7, 8]);
      return [{ offset: 0, stride: 8 }];
    });
    const frame = videoFrame(copyTo);
    const materializer = new RgbaMaterializer(2, 1);
    const operation = materializer.create(frame, visibleRect(), false);
    expect(copyTo).not.toHaveBeenCalled();

    const [first, second] = await Promise.all([
      operation.rgba(),
      operation.rgba()
    ]);

    expect(first).toBe(second);
    expect(first).toEqual({
      width: 2,
      height: 1,
      stride: 8,
      pixels: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])
    });
    expect(copyTo).toHaveBeenCalledTimes(1);
    expect(copyTo.mock.calls[0]?.[1]).toEqual({
      format: "RGBA",
      rect: visibleRect(),
      layout: [{ offset: 0, stride: 8 }]
    });

    operation.release();
    await expect(operation.rgba()).rejects.toMatchObject({ name: "AbortError" });
    const next = materializer.create(frame, visibleRect(), false);
    await next.rgba();
    next.release();
    expect(copyTo).toHaveBeenCalledTimes(2);
    expect(materializer.budget()).toEqual({
      stagingBytes: 8,
      maximumFallbackBackingBytes: 8,
      maximumTransientReadbackBytes: 8
    });
  });

  it("rejects a successful green-corrupt copy in favor of Canvas2D readback", async () => {
    const copied = [
      0, 220, 0, 255,
      0, 180, 0, 255
    ];
    const reference = [
      20, 80, 180, 255,
      30, 110, 220, 255
    ];
    const copyTo = vi.fn(async (destination: AllowSharedBufferSource) => {
      bytes(destination).set(copied);
      return [{ offset: 0, stride: 8 }];
    });
    const fixture = readbackFixture(2, 1, reference);
    const materializer = new RgbaMaterializer(2, 1, {
      createCanvas: fixture.createCanvas
    });

    const first = materializer.create(videoFrame(copyTo), visibleRect(), true);
    await expect(first.rgba()).resolves.toMatchObject({
      pixels: new Uint8Array(reference)
    });
    first.release();

    const second = materializer.create(videoFrame(copyTo), visibleRect(), false);
    await expect(second.rgba()).resolves.toMatchObject({
      pixels: new Uint8Array(reference)
    });
    second.release();

    expect(copyTo).toHaveBeenCalledTimes(1);
    expect(fixture.context.drawCalls).toHaveLength(2);
  });

  it("requalifies a green copy when the decoder run changes", async () => {
    const reference = [
      20, 80, 180, 255,
      30, 110, 220, 255
    ];
    const green = [
      0, 220, 0, 255,
      0, 180, 0, 255
    ];
    const copyTo = vi.fn(async (destination: AllowSharedBufferSource) => {
      bytes(destination).set(green);
      return [{ offset: 0, stride: 8 }];
    });
    const fixture = readbackFixture(2, 1, green);
    const materializer = new RgbaMaterializer(2, 1, {
      createCanvas: fixture.createCanvas
    });

    for (const newDecoderRun of [false, false]) {
      const operation = materializer.create(
        videoFrame(copyTo),
        visibleRect(),
        newDecoderRun
      );
      await expect(operation.rgba()).resolves.toMatchObject({
        pixels: new Uint8Array(green)
      });
      operation.release();
    }
    fixture.context.setValues(reference);
    const restarted = materializer.create(videoFrame(copyTo), visibleRect(), true);
    await expect(restarted.rgba()).resolves.toMatchObject({
      pixels: new Uint8Array(reference)
    });
    restarted.release();

    expect(copyTo).toHaveBeenCalledTimes(3);
    expect(fixture.context.drawCalls).toHaveLength(2);
  });

  it("checks green corruption that begins within one decoder run", async () => {
    const healthy = [
      20, 80, 180, 255,
      30, 110, 220, 255
    ];
    const corrupt = [
      0, 220, 0, 255,
      0, 180, 0, 255
    ];
    const copyTo = vi.fn(async (destination: AllowSharedBufferSource) => {
      bytes(destination).set(copyTo.mock.calls.length === 1 ? healthy : corrupt);
      return [{ offset: 0, stride: 8 }];
    });
    const fixture = readbackFixture(2, 1, healthy);
    const materializer = new RgbaMaterializer(2, 1, {
      createCanvas: fixture.createCanvas
    });

    for (const _index of [0, 1]) {
      const operation = materializer.create(
        videoFrame(copyTo),
        visibleRect(), false
      );
      await expect(operation.rgba()).resolves.toMatchObject({
        pixels: new Uint8Array(healthy)
      });
      operation.release();
    }

    expect(copyTo).toHaveBeenCalledTimes(2);
    expect(fixture.context.drawCalls).toHaveLength(1);
  });

  it("keeps a proven corrupt copy disabled across owner reset", async () => {
    const copied = [
      0, 220, 0, 255,
      0, 180, 0, 255
    ];
    const reference = [
      20, 80, 180, 255,
      30, 110, 220, 255
    ];
    const copyTo = vi.fn(async (destination: AllowSharedBufferSource) => {
      bytes(destination).set(copied);
      return [{ offset: 0, stride: 8 }];
    });
    const fixture = readbackFixture(2, 1, reference);
    const materializer = new RgbaMaterializer(2, 1, {
      createCanvas: fixture.createCanvas
    });

    const first = materializer.create(videoFrame(copyTo), visibleRect(), true);
    await first.rgba();
    first.release();
    materializer.reset();
    const second = materializer.create(videoFrame(copyTo), visibleRect(), true);
    await expect(second.rgba()).resolves.toMatchObject({
      pixels: new Uint8Array(reference)
    });
    second.release();

    expect(copyTo).toHaveBeenCalledTimes(1);
    expect(fixture.creations).toBe(2);
    expect(fixture.context.drawCalls).toHaveLength(2);
  });

  it("periodically rechecks a continuous green sequence within one run", async () => {
    const reference = [
      20, 80, 180, 255,
      30, 110, 220, 255
    ];
    const green = [
      0, 220, 0, 255,
      0, 180, 0, 255
    ];
    const copyTo = vi.fn(async (destination: AllowSharedBufferSource) => {
      bytes(destination).set(green);
      return [{ offset: 0, stride: 8 }];
    });
    const fixture = readbackFixture(2, 1, green);
    const materializer = new RgbaMaterializer(2, 1, {
      createCanvas: fixture.createCanvas
    });

    const first = materializer.create(videoFrame(copyTo), visibleRect(), false);
    await first.rgba();
    first.release();
    fixture.context.setValues(reference);
    for (let frameIndex = 1; frameIndex < 8; frameIndex += 1) {
      const operation = materializer.create(videoFrame(copyTo), visibleRect(), false);
      const result = await operation.rgba();
      operation.release();
      if (frameIndex < 7) expect(result.pixels).toEqual(new Uint8Array(green));
      else expect(result.pixels).toEqual(new Uint8Array(reference));
    }

    expect(copyTo).toHaveBeenCalledTimes(8);
    expect(fixture.context.drawCalls).toHaveLength(2);
  });

  it("rejects a second deferred frame before reverse settlement can corrupt RGBA", async () => {
    const firstCopy = deferred<readonly PlaneLayout[]>();
    const secondCopy = deferred<readonly PlaneLayout[]>();
    let firstDestination!: Uint8Array;
    const firstCopyTo = vi.fn((destination: AllowSharedBufferSource) => {
      firstDestination = bytes(destination);
      return firstCopy.promise;
    });
    const secondCopyTo = vi.fn((destination: AllowSharedBufferSource) => {
      bytes(destination).set([9, 8, 7, 6, 5, 4, 3, 2]);
      return secondCopy.promise;
    });
    const materializer = new RgbaMaterializer(2, 1);
    const first = materializer.create(videoFrame(firstCopyTo), visibleRect(), false);
    const firstRgba = first.rgba();
    expect(first.rgba()).toBe(firstRgba);
    const overlapping = materializer.create(
      videoFrame(secondCopyTo),
      visibleRect(), false
    );
    const rejected = overlapping.rgba();
    expect(overlapping.rgba()).toBe(rejected);

    await expect(rejected).rejects.toMatchObject({
      name: "MaterializerFailureError",
      stage: "copy",
      reason: { name: "InvalidStateError" }
    });
    expect(secondCopyTo).not.toHaveBeenCalled();

    secondCopy.resolve([{ offset: 0, stride: 8 }]);
    expect(firstDestination).toBeInstanceOf(Uint8Array);
    firstDestination.set([1, 2, 3, 4, 5, 6, 7, 8]);
    firstCopy.resolve([{ offset: 0, stride: 8 }]);
    await expect(firstRgba).resolves.toMatchObject({
      pixels: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])
    });
    first.release();
    overlapping.release();

    const next = materializer.create(videoFrame(secondCopyTo), visibleRect(), false);
    await expect(next.rgba()).resolves.toMatchObject({
      pixels: new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2])
    });
    next.release();
    expect(secondCopyTo).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["synchronous TypeError", () => {
      throw new TypeError("RGBA copy is unsupported");
    }],
    ["asynchronous TypeError", async () => {
      throw new TypeError("RGBA copy is unsupported");
    }],
    ["NotSupportedError", async () => {
      throw new DOMException("RGBA copy is unsupported", "NotSupportedError");
    }]
  ] as const)("uses one bounded Canvas2D readback for %s", async (
    _label,
    copyTo
  ) => {
    const fixture = readbackFixture(2, 1, [9, 8, 7, 6, 5, 4, 3, 2]);
    const frame = videoFrame(copyTo, 4, 2);
    const materializer = new RgbaMaterializer(2, 1, {
      createCanvas: fixture.createCanvas
    });

    const operation = materializer.create(frame, visibleRect(), false);
    const result = await operation.rgba();
    operation.release();

    expect(result.pixels).toEqual(new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2]));
    expect(fixture.creations).toBe(1);
    expect(fixture.context.drawCalls).toEqual([[
      frame, 0, 0, 4, 2, 0, 0, 2, 1
    ]]);
    expect(fixture.context.readCalls).toEqual([[0, 0, 2, 1]]);
    expect(fixture.contextRequest).toEqual({
      alpha: true,
      willReadFrequently: true
    });
    expect(materializer.snapshot()).toEqual({
      stagingBytes: 8,
      readbackBackingBytes: 8,
      sourceCopiesInFlight: 0,
      resourceCount: 1
    });
    const next = materializer.create(frame, visibleRect(), false);
    await next.rgba();
    next.release();
    expect(fixture.creations).toBe(1);
    expect(fixture.context.drawCalls).toHaveLength(2);
  });

  it.each([
    ["non-array copy contract", async () =>
      ({ length: 1 } as unknown as readonly PlaneLayout[])],
    ["empty copy contract", async () => []],
    ["multi-plane copy contract", async () => [
      { offset: 0, stride: 8 }, { offset: 0, stride: 8 }
    ]],
    ["offset copy contract", async () => [{ offset: 1, stride: 8 }]],
    ["stride copy contract", async () => [{ offset: 0, stride: 4 }]],
    ["abort", async () => {
      throw new DOMException("copy aborted", "AbortError");
    }],
    ["security", async () => {
      throw new DOMException("copy denied", "SecurityError");
    }]
  ] as const)("keeps a %s failure terminal without Canvas fallback", async (
    _label,
    copyTo
  ) => {
    const fixture = readbackFixture(2, 1, new Array(8).fill(0));
    const materializer = new RgbaMaterializer(2, 1, {
      createCanvas: fixture.createCanvas
    });

    await expect(materializer.create(videoFrame(copyTo), visibleRect(), false).rgba())
      .rejects.toBeInstanceOf(MaterializerFailureError);
    expect(fixture.creations).toBe(0);
  });

  it("keeps late raw writes leased after timeout and caller release", async () => {
    const pending = deferred<readonly PlaneLayout[]>();
    const fixture = readbackFixture(2, 1, new Array(8).fill(0));
    let abandonedDestination!: Uint8Array;
    let expire = (): void => undefined;
    const materializer = new RgbaMaterializer(2, 1, {
      copyTimeoutMs: 1,
      createCanvas: fixture.createCanvas,
      setTimeout(callback) { expire = callback; return 1; },
      clearTimeout() {}
    });
    const operation = materializer.create(
      videoFrame(destination => {
        abandonedDestination = bytes(destination);
        return pending.promise;
      }),
      visibleRect(), false
    );
    const rgba = operation.rgba();
    await Promise.resolve();
    expect(materializer.snapshot().sourceCopiesInFlight).toBe(1);

    expire();
    await expect(rgba).rejects.toMatchObject({
      name: "MaterializerFailureError",
      reason: { name: "TimeoutError" }
    });
    expect(fixture.creations).toBe(0);
    expect(materializer.snapshot().sourceCopiesInFlight).toBe(1);

    operation.release();
    const nextCopyTo = vi.fn(async (destination: AllowSharedBufferSource) => {
      bytes(destination).set([1, 2, 3, 4, 5, 6, 7, 8]);
      return [{ offset: 0, stride: 8 }];
    });
    const overlapping = materializer.create(
      videoFrame(nextCopyTo),
      visibleRect(), false
    );
    const overlappingRgba = overlapping.rgba();
    expect(overlapping.rgba()).toBe(overlappingRgba);
    await expect(overlappingRgba).rejects.toMatchObject({
      reason: { name: "InvalidStateError" }
    });
    overlapping.release();
    expect(nextCopyTo).not.toHaveBeenCalled();
    expect(materializer.snapshot().sourceCopiesInFlight).toBe(1);

    expect(abandonedDestination).toBeInstanceOf(Uint8Array);
    abandonedDestination.set([9, 9, 9, 9, 9, 9, 9, 9]);
    expect(nextCopyTo).not.toHaveBeenCalled();
    expect(materializer.snapshot().sourceCopiesInFlight).toBe(1);
    pending.resolve([{ offset: 0, stride: 8 }]);
    await eventually(() => materializer.snapshot().sourceCopiesInFlight === 0);
    const next = materializer.create(videoFrame(nextCopyTo), visibleRect(), false);
    await expect(next.rgba()).resolves.toMatchObject({
      pixels: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])
    });
    next.release();
  });

  it("reports Canvas readback failure instead of the provisional copy error", async () => {
    const copyError = new TypeError("RGBA copy is unsupported");
    const readbackError = new DOMException("canvas is tainted", "SecurityError");
    const fixture = readbackFixture(2, 1, new Array(8).fill(0));
    fixture.context.readError = readbackError;
    const materializer = new RgbaMaterializer(2, 1, {
      createCanvas: fixture.createCanvas
    });
    const operation = materializer.create(
      videoFrame(async () => { throw copyError; }),
      visibleRect(), false
    );

    const first = operation.rgba();
    const second = operation.rgba();
    expect(first).toBe(second);
    await expect(first).rejects.toMatchObject({
      name: "MaterializerFailureError",
      reason: readbackError
    });
    expect(fixture.creations).toBe(1);
    expect(fixture.context.readCalls).toHaveLength(1);
  });

  it("rejects suspicious green copy output when qualification readback fails", async () => {
    const readbackError = new DOMException("canvas is tainted", "SecurityError");
    const fixture = readbackFixture(2, 1, new Array(8).fill(0));
    fixture.context.readError = readbackError;
    const materializer = new RgbaMaterializer(2, 1, {
      createCanvas: fixture.createCanvas
    });
    const operation = materializer.create(videoFrame(async (destination) => {
      bytes(destination).set([
        0, 220, 0, 255,
        0, 180, 0, 255
      ]);
      return [{ offset: 0, stride: 8 }];
    }), visibleRect(), false);

    await expect(operation.rgba()).rejects.toMatchObject({
      name: "MaterializerFailureError",
      stage: "readback",
      reason: readbackError
    });
    expect(fixture.context.readCalls).toHaveLength(1);
  });

  it("invalidates a pending operation on owner reset without falling back", async () => {
    const pending = deferred<readonly PlaneLayout[]>();
    const fixture = readbackFixture(2, 1, new Array(8).fill(0));
    const materializer = new RgbaMaterializer(2, 1, {
      createCanvas: fixture.createCanvas
    });
    const rgba = materializer.create(
      videoFrame(() => pending.promise),
      visibleRect(), false
    ).rgba();
    await Promise.resolve();

    materializer.reset();
    pending.reject(new TypeError("RGBA copy is unsupported"));

    await expect(rgba).rejects.toMatchObject({ name: "AbortError" });
    expect(fixture.creations).toBe(0);
    expect(materializer.snapshot().stagingBytes).toBe(8);
  });

  it("releases owned storage while an abandoned copy settles safely", async () => {
    const pending = deferred<readonly PlaneLayout[]>();
    const materializer = new RgbaMaterializer(2, 1);
    const rgba = materializer.create(
      videoFrame(() => pending.promise),
      visibleRect(), false
    ).rgba();
    await Promise.resolve();
    expect(materializer.snapshot().sourceCopiesInFlight).toBe(1);

    materializer.dispose();
    expect(materializer.snapshot()).toMatchObject({
      stagingBytes: 0,
      readbackBackingBytes: 0,
      sourceCopiesInFlight: 1,
      resourceCount: 0
    });
    pending.resolve([{ offset: 0, stride: 8 }]);

    await expect(rgba).rejects.toMatchObject({ name: "AbortError" });
    expect(materializer.snapshot().sourceCopiesInFlight).toBe(0);
  });

  it("rejects a reference created after disposal without acquiring staging", async () => {
    const copyTo = vi.fn(async () => [{ offset: 0, stride: 8 }]);
    const materializer = new RgbaMaterializer(2, 1);
    materializer.dispose();
    const operation = materializer.create(videoFrame(copyTo), visibleRect(), false);

    await expect(operation.rgba()).rejects.toMatchObject({ name: "AbortError" });
    expect(copyTo).not.toHaveBeenCalled();
    operation.release();
  });
});

function visibleRect(): DOMRectReadOnly {
  return { x: 0, y: 0, width: 2, height: 1 } as DOMRectReadOnly;
}

function videoFrame(
  copyTo: (
    destination: AllowSharedBufferSource,
    options?: VideoFrameCopyToOptions
  ) => Promise<readonly PlaneLayout[]>,
  displayWidth = 2,
  displayHeight = 1
): VideoFrame {
  return {
    displayWidth,
    displayHeight,
    copyTo
  } as unknown as VideoFrame;
}

function bytes(destination: AllowSharedBufferSource): Uint8Array {
  if (ArrayBuffer.isView(destination)) {
    return new Uint8Array(
      destination.buffer,
      destination.byteOffset,
      destination.byteLength
    );
  }
  return new Uint8Array(destination);
}

function readbackFixture(
  width: number,
  height: number,
  values: readonly number[]
): {
  readonly context: TestContext;
  readonly createCanvas: (width: number, height: number) => HTMLCanvasElement;
  creations: number;
  contextRequest: unknown;
} {
  const fixture = {
    context: new TestContext(width, height, values),
    creations: 0,
    contextRequest: null as unknown,
    createCanvas: (_width: number, _height: number) => null as unknown as HTMLCanvasElement
  };
  fixture.createCanvas = (canvasWidth, canvasHeight) => {
    fixture.creations += 1;
    return {
      width: canvasWidth,
      height: canvasHeight,
      getContext(type: string, options: unknown) {
        fixture.contextRequest = options;
        return type === "2d" ? fixture.context : null;
      }
    } as unknown as HTMLCanvasElement;
  };
  return fixture;
}

class TestContext {
  readonly #width: number;
  readonly #height: number;
  #values: readonly number[];
  public globalCompositeOperation = "source-over";
  public imageSmoothingEnabled = false;
  public imageSmoothingQuality: ImageSmoothingQuality = "high";
  public readError: unknown = null;
  public readonly drawCalls: unknown[][] = [];
  public readonly readCalls: number[][] = [];

  public constructor(
    width: number,
    height: number,
    values: readonly number[]
  ) {
    this.#width = width;
    this.#height = height;
    this.#values = values;
  }

  public clearRect(): void {}
  public setValues(values: readonly number[]): void { this.#values = values; }
  public drawImage(...args: unknown[]): void { this.drawCalls.push(args); }
  public getImageData(...args: number[]): ImageData {
    this.readCalls.push(args);
    if (this.readError !== null) throw this.readError;
    return {
      width: this.#width,
      height: this.#height,
      data: new Uint8ClampedArray(this.#values)
    } as ImageData;
  }
  public isContextLost(): boolean { return false; }
}

function deferred<T>(): Readonly<{
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function eventually(assertion: () => boolean): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) {
    if (assertion()) return;
    await Promise.resolve();
  }
  throw new Error("condition did not become true");
}
