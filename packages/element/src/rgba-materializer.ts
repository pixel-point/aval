import { rgbaBytes } from "./renderer-geometry.js";
import {
  assertCanvas2dContextAvailable,
  canvas2dContext,
  configureCanvas2dContext
} from "./canvas2d-context.js";

export interface RgbaMaterializerOptions {
  readonly copyTimeoutMs?: number;
  readonly setTimeout?: (callback: () => void, delay: number) => number;
  readonly clearTimeout?: (handle: number) => void;
  readonly createCanvas?: (width: number, height: number) => HTMLCanvasElement;
}
export interface MaterializedRgbaFrame {
  readonly width: number;
  readonly height: number;
  readonly stride: number;
  /** Borrowed staging storage, valid only until owner release/reset/dispose. */
  readonly pixels: Uint8Array;
}
export interface RgbaFrameReference {
  readonly frame: VideoFrame;
  readonly rgba: () => Promise<Readonly<MaterializedRgbaFrame>>;
}
export interface MaterializedRgbaFrameReference {
  readonly frame: VideoFrame;
  readonly rgba: Readonly<MaterializedRgbaFrame>;
}
export interface RgbaMaterialization extends RgbaFrameReference {
  /** Releases the staging lease and invalidates materialized pixels. */
  release(): void;
}
export interface RgbaMaterializerBudget {
  readonly stagingBytes: number;
  readonly maximumFallbackBackingBytes: number;
  readonly maximumTransientReadbackBytes: number;
}
export interface RgbaMaterializerSnapshot {
  readonly stagingBytes: number;
  readonly readbackBackingBytes: number;
  readonly sourceCopiesInFlight: number;
  readonly resourceCount: number;
}
export type MaterializerFailureStage = "copy" | "readback";
export class MaterializerFailureError extends Error {
  public constructor(
    public readonly stage: MaterializerFailureStage,
    public readonly reason: unknown
  ) {
    super("decoded frame RGBA materialization failed", { cause: reason });
    this.name = "MaterializerFailureError";
  }
}
interface ReadbackSurface {
  readonly canvas: HTMLCanvasElement;
  readonly context: CanvasRenderingContext2D;
}
interface ActiveLease {
  /** Materialization plus any raw copy that can still write staging. */
  pendingSettlements: number;
  releaseRequested: boolean;
}

const COPY_TIMEOUT = 5_000;

/** One bounded, lazy CPU frame copy shared by all consumers of an operation. */
export class RgbaMaterializer {
  readonly #width: number;
  readonly #height: number;
  readonly #stride: number;
  readonly #storageBytes: number;
  readonly #copyTimeoutMs: number;
  readonly #setTimeout: (callback: () => void, delay: number) => number;
  readonly #clearTimeout: (handle: number) => void;
  readonly #createCanvas: ((width: number, height: number) => HTMLCanvasElement) | null;
  #staging: Uint8Array;
  #readback: ReadbackSurface | null = null;
  #sourceCopiesInFlight = 0;
  #epoch: object = Object.freeze({});
  #activeLease: ActiveLease | null = null;
  #disposed = false;

  public constructor(
    width: number,
    height: number,
    options: Readonly<RgbaMaterializerOptions> = {}
  ) {
    this.#storageBytes = rgbaBytes(width, height);
    this.#width = width;
    this.#height = height;
    this.#stride = width * 4;
    this.#copyTimeoutMs = options.copyTimeoutMs ?? COPY_TIMEOUT;
    this.#setTimeout = options.setTimeout ?? ((callback, delay) =>
      globalThis.setTimeout(callback, delay) as unknown as number);
    this.#clearTimeout = options.clearTimeout ?? ((handle) =>
      globalThis.clearTimeout(handle));
    this.#createCanvas = options.createCanvas ?? null;
    if (!Number.isSafeInteger(this.#copyTimeoutMs) || this.#copyTimeoutMs < 1 ||
      this.#copyTimeoutMs > 60_000) {
      throw new RangeError("renderer copy timeout is invalid");
    }
    this.#staging = new Uint8Array(this.#storageBytes);
  }

  public create(frame: VideoFrame, rect: DOMRectReadOnly): Readonly<RgbaMaterialization> {
    let result: Promise<Readonly<MaterializedRgbaFrame>> | null = null;
    let released = false;
    const epoch = this.#epoch;
    const lease: ActiveLease = {
      pendingSettlements: 1, releaseRequested: false
    };
    const unavailable = (): boolean => this.#disposed || released || this.#epoch !== epoch;
    return Object.freeze({
      frame,
      rgba: () => {
        if (unavailable()) return Promise.reject(aborted());
        if (result === null) {
          if (this.#activeLease !== null) result = Promise.reject(overlap());
          else {
            this.#activeLease = lease;
            result = this.#materialize(frame, rect, unavailable, lease)
              .finally(() => this.#settleLeaseWork(lease));
          }
        }
        return result;
      },
      release: () => {
        released = true;
        if (this.#activeLease !== lease) return;
        lease.releaseRequested = true;
        this.#retireLease(lease);
      }
    });
  }

  public budget(): Readonly<RgbaMaterializerBudget> {
    return Object.freeze({
      stagingBytes: this.#storageBytes,
      maximumFallbackBackingBytes: this.#storageBytes,
      maximumTransientReadbackBytes: this.#storageBytes
    });
  }

  public snapshot(): Readonly<RgbaMaterializerSnapshot> {
    return Object.freeze({
      stagingBytes: this.#staging.byteLength,
      readbackBackingBytes: this.#readback === null ? 0 : this.#storageBytes,
      sourceCopiesInFlight: this.#sourceCopiesInFlight,
      resourceCount: Number(this.#readback !== null)
    });
  }

  public reset(): void {
    this.#epoch = Object.freeze({});
    const lease = this.#activeLease;
    if (lease !== null) { lease.releaseRequested = true; this.#retireLease(lease); }
    const surface = this.#readback;
    this.#readback = null;
    if (surface === null) return;
    try { surface.canvas.width = 0; surface.canvas.height = 0; }
    catch { /* Bounded scratch cleanup is best-effort. */ }
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#staging = new Uint8Array(0);
    this.reset();
  }

  async #materialize(
    frame: VideoFrame, rect: DOMRectReadOnly, released: () => boolean,
    lease: ActiveLease
  ): Promise<Readonly<MaterializedRgbaFrame>> {
    try {
      return await this.#copy(frame, rect, released, lease);
    } catch (reason) {
      if (this.#disposed || released()) throw aborted();
      if (!isUnsupportedRgbaCopy(reason)) {
        throw new MaterializerFailureError("copy", reason);
      }
    }
    try {
      return this.#readPixels(frame, released);
    } catch (reason) {
      if (this.#disposed || released()) throw aborted();
      throw new MaterializerFailureError("readback", reason);
    }
  }

  async #copy(
    frame: VideoFrame, rect: DOMRectReadOnly, released: () => boolean,
    lease: ActiveLease
  ): Promise<Readonly<MaterializedRgbaFrame>> {
    if (this.#disposed || this.#staging.byteLength !== this.#storageBytes) {
      throw aborted();
    }
    const staging = this.#staging;
    staging.fill(0);
    lease.pendingSettlements += 1;
    this.#sourceCopiesInFlight += 1;
    let operation: Promise<readonly PlaneLayout[]>;
    try {
      operation = frame.copyTo(staging, {
        format: "RGBA",
        rect,
        layout: [{ offset: 0, stride: this.#stride }]
      });
    } catch (reason) {
      this.#settleSourceCopy(lease);
      throw reason;
    }
    void operation.then(
      () => this.#settleSourceCopy(lease),
      () => this.#settleSourceCopy(lease)
    );
    const planes = await timed(
      operation,
      this.#copyTimeoutMs,
      this.#setTimeout,
      this.#clearTimeout
    );
    if (this.#disposed || released()) throw aborted();
    const plane = Array.isArray(planes) ? planes[0] : undefined;
    if (
      !Array.isArray(planes) || planes.length !== 1 || plane === undefined ||
      plane.offset !== 0 || plane.stride !== this.#stride
    ) throw new Error("decoded frame copy layout is invalid");
    return this.#result(staging);
  }

  #readPixels(
    frame: VideoFrame, released: () => boolean
  ): Readonly<MaterializedRgbaFrame> {
    if (this.#disposed || released() ||
      this.#staging.byteLength !== this.#storageBytes) {
      throw aborted();
    }
    const { context } = this.#readbackSurface();
    assertCanvas2dContextAvailable(context);
    configureCanvas2dContext(context);
    context.globalCompositeOperation = "copy";
    context.clearRect(0, 0, this.#width, this.#height);
    context.drawImage(
      frame, 0, 0, frame.displayWidth, frame.displayHeight,
      0, 0, this.#width, this.#height
    );
    const image = context.getImageData(0, 0, this.#width, this.#height);
    if (
      image.width !== this.#width || image.height !== this.#height ||
      image.data.byteLength !== this.#storageBytes
    ) throw new Error("Canvas2D readback storage is invalid");
    this.#staging.set(image.data);
    return this.#result(this.#staging);
  }

  #readbackSurface(): ReadbackSurface {
    if (this.#readback !== null) return this.#readback;
    const factory = this.#createCanvas;
    if (factory === null) {
      throw new Error("Canvas2D readback surface factory is unavailable");
    }
    const canvas = factory(this.#width, this.#height);
    try {
      canvas.width = this.#width;
      canvas.height = this.#height;
      if (canvas.width !== this.#width || canvas.height !== this.#height) throw new Error(
        "Canvas2D readback surface rejected its dimensions"
      );
      const context = canvas2dContext(canvas, true);
      if (context === null) throw new Error("Canvas2D readback context is unavailable");
      assertCanvas2dContextAvailable(context);
      configureCanvas2dContext(context);
      this.#readback = Object.freeze({ canvas, context });
      return this.#readback;
    } catch (reason) {
      try { canvas.width = 0; canvas.height = 0; }
      catch { /* Preserve the readback creation cause. */ }
      throw reason;
    }
  }

  #result(pixels: Uint8Array): Readonly<MaterializedRgbaFrame> {
    return Object.freeze({ width: this.#width, height: this.#height, stride: this.#stride, pixels });
  }

  #settleSourceCopy(lease: ActiveLease): void {
    this.#sourceCopiesInFlight -= 1;
    this.#settleLeaseWork(lease);
  }
  #settleLeaseWork(lease: ActiveLease): void {
    if (this.#activeLease !== lease) return;
    lease.pendingSettlements -= 1;
    this.#retireLease(lease);
  }
  #retireLease(lease: ActiveLease): void {
    if (this.#activeLease === lease && lease.releaseRequested &&
      lease.pendingSettlements === 0) this.#activeLease = null;
  }
}

export function defaultCanvasFactory(output: HTMLCanvasElement):
  (width: number, height: number) => HTMLCanvasElement {
  return (width, height) => {
    const document = output.ownerDocument ?? globalThis.document;
    if (document === undefined)
      throw new Error("Canvas2D scratch surface factory is unavailable");
    return document.createElement("canvas");
  };
}

function isUnsupportedRgbaCopy(reason: unknown): boolean {
  return reason instanceof TypeError ||
    reason instanceof DOMException && reason.name === "NotSupportedError";
}

function aborted(): DOMException {
  return new DOMException("RGBA materializer is unavailable", "AbortError");
}

function overlap(): MaterializerFailureError {
  const reason = new DOMException(
    "another RGBA materialization is active", "InvalidStateError");
  return new MaterializerFailureError("copy", reason);
}

function timed<T>(
  operation: Promise<T>,
  timeoutMs: number,
  setTimer: (callback: () => void, delay: number) => number,
  clearTimer: (handle: number) => void
): Promise<T> {
  let timeout = 0;
  const expiration = new Promise<never>((_resolve, reject) => {
    timeout = setTimer(() => reject(new DOMException(
      "decoded frame RGBA copy timed out",
      "TimeoutError"
    )), timeoutMs);
  });
  return Promise.race([operation, expiration]).finally(() => clearTimer(timeout));
}
