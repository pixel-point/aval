import {
  FormatError,
  decodePngRgba,
  decodePngRgbaFromInflated,
  validatePngProfile,
  type PngDecodePlan,
  type PngRgbaDecodeResult
} from "@rendered-motion/format";

import {
  createBrowserPngNativeInflater,
  type BrowserPngNativeInflater
} from "./png-inflate-browser.js";
import { RuntimePlaybackError } from "./errors.js";
import {
  LEASED_STATIC_PNG_DECODER,
  type LeasedStaticPngSource
} from "./leased-static-png-decoder.js";
import type {
  StaticSurfaceDecodeOptions,
  StaticSurfaceDecodeSnapshot,
  StaticSurfaceDecoder
} from "./static-surfaces.js";

export type StaticPngInflatePath = "native" | "pure";

export interface BrowserDecodedStaticSurface {
  readonly image: ImageBitmap;
  readonly width: number;
  readonly height: number;
  readonly inflatePath: StaticPngInflatePath;
  close(): void;
}

export interface BrowserStaticSurfaceTimerHost {
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
}

export type BrowserStaticDecoderResourceCategory =
  | "png-copy"
  | "png-zlib"
  | "png-scratch";

export interface BrowserStaticDecoderResourceLease {
  release(): void;
}

export interface BrowserStaticDecoderResourceHost {
  reserve(
    category: BrowserStaticDecoderResourceCategory,
    byteLength: number
  ): BrowserStaticDecoderResourceLease |
    PromiseLike<BrowserStaticDecoderResourceLease>;
}

export interface BrowserStaticSurfaceDecoderSnapshot
extends StaticSurfaceDecodeSnapshot {
  readonly nativeAttempts: number;
  readonly nativeSuccesses: number;
  readonly pureAttempts: number;
  readonly pureSuccesses: number;
  readonly errors: number;
  readonly peakPngCopyBytes: number;
  readonly peakZlibBytes: number;
  readonly peakFilteredBytes: number;
  readonly peakRgbaBytes: number;
  readonly bitmapCloses: number;
}

export interface BrowserStaticSurfaceDecoderOptions {
  readonly timeoutMs?: number;
  readonly timers?: Readonly<BrowserStaticSurfaceTimerHost>;
  /** Null is an explicit capability-unavailable test/host policy. */
  readonly nativeInflater?: Readonly<BrowserPngNativeInflater> | null;
  readonly pureDecode?: (plan: PngDecodePlan) => PngRgbaDecodeResult;
  readonly createBitmap?: (
    rgba: Uint8Array,
    width: number,
    height: number
  ) => Promise<ImageBitmap>;
  readonly resourceHost?: BrowserStaticDecoderResourceHost;
}

interface CapturedStaticBitmap {
  readonly image: ImageBitmap;
  readonly width: number;
  readonly height: number;
  retire(): void;
}

const DEFAULT_STATIC_DECODE_TIMEOUT_MS = 5_000;
const DEFAULT_STATIC_DECODE_TIMERS: Readonly<BrowserStaticSurfaceTimerHost> =
  Object.freeze({
    setTimeout: (callback: () => void, milliseconds: number): unknown =>
      globalThis.setTimeout(callback, milliseconds),
    clearTimeout: (handle: unknown): void =>
      globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>)
  });

/** Strict PNG grammar + bounded native/pure inflate + validated RGBA bitmap. */
export class BrowserStaticSurfaceDecoder
implements StaticSurfaceDecoder<BrowserDecodedStaticSurface> {
  readonly #nativeInflater: Readonly<BrowserPngNativeInflater>;
  readonly #pureDecode: (plan: PngDecodePlan) => PngRgbaDecodeResult;
  readonly #nativeInflaterInjected: boolean;
  readonly #pureDecodeInjected: boolean;
  readonly #createBitmap: BrowserStaticSurfaceDecoderOptions["createBitmap"];
  readonly #timeoutMs: number;
  readonly #timers: Readonly<BrowserStaticSurfaceTimerHost>;
  readonly #reserveTransient: ((
    category: BrowserStaticDecoderResourceCategory,
    byteLength: number
  ) => BrowserStaticDecoderResourceLease |
    PromiseLike<BrowserStaticDecoderResourceLease>) | null;

  #nativeAttempts = 0;
  #nativeSuccesses = 0;
  #pureAttempts = 0;
  #pureSuccesses = 0;
  #errors = 0;
  #peakPngCopyBytes = 0;
  #peakZlibBytes = 0;
  #peakFilteredBytes = 0;
  #peakRgbaBytes = 0;
  #bitmapCloses = 0;

  public constructor(
    options: Readonly<BrowserStaticSurfaceDecoderOptions> = {}
  ) {
    if (options === null || typeof options !== "object") {
      throw new TypeError("strict static decoder options must be an object");
    }
    this.#nativeInflater = options.nativeInflater === null
      ? Object.freeze({
          supported: false,
          async inflate(): Promise<Uint8Array> {
            throw new FormatError(
              "PNG_DEFLATE_INVALID",
              "native PNG inflate is unavailable"
            );
          }
        })
      : options.nativeInflater ?? createBrowserPngNativeInflater();
    this.#pureDecode = options.pureDecode ?? decodePngRgba;
    this.#nativeInflaterInjected = options.nativeInflater !== undefined &&
      options.nativeInflater !== null;
    this.#pureDecodeInjected = options.pureDecode !== undefined;
    this.#createBitmap = options.createBitmap ?? createBitmapFromRgba;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_STATIC_DECODE_TIMEOUT_MS;
    this.#timers = options.timers ?? DEFAULT_STATIC_DECODE_TIMERS;
    this.#reserveTransient = options.resourceHost === undefined
      ? null
      : captureStaticDecoderResourceHost(options.resourceHost);
    if (
      !Number.isSafeInteger(this.#timeoutMs) ||
      this.#timeoutMs <= 0 ||
      this.#timeoutMs > 60_000
    ) {
      throw new RangeError(
        "static decode timeout must be an integer from 1 through 60000 ms"
      );
    }
    if (
      typeof this.#nativeInflater.supported !== "boolean" ||
      typeof this.#nativeInflater.inflate !== "function" ||
      typeof this.#pureDecode !== "function" ||
      typeof this.#createBitmap !== "function" ||
      typeof this.#timers.setTimeout !== "function" ||
      typeof this.#timers.clearTimeout !== "function"
    ) {
      throw new TypeError("strict static decoder dependencies are invalid");
    }
  }

  public snapshot(): Readonly<BrowserStaticSurfaceDecoderSnapshot> {
    return Object.freeze({
      nativeAttempts: this.#nativeAttempts,
      nativeSuccesses: this.#nativeSuccesses,
      pureAttempts: this.#pureAttempts,
      pureSuccesses: this.#pureSuccesses,
      errors: this.#errors,
      peakPngCopyBytes: this.#peakPngCopyBytes,
      peakZlibBytes: this.#peakZlibBytes,
      peakFilteredBytes: this.#peakFilteredBytes,
      peakRgbaBytes: this.#peakRgbaBytes,
      bitmapCloses: this.#bitmapCloses
    });
  }

  public async decode(
    png: Uint8Array,
    options: StaticSurfaceDecodeOptions
  ): Promise<BrowserDecodedStaticSurface> {
    // Compatibility adapter: custom callers may already own this eager copy.
    // StaticSurfaceStore uses the internal leased-source symbol capability.
    return this.#decodeSource(Object.freeze({
      byteLength: png.byteLength,
      copy: () => png
    }), options, false);
  }

  /** @internal Exact leased-copy capability consumed by StaticSurfaceStore. */
  public [LEASED_STATIC_PNG_DECODER](
    source: Readonly<LeasedStaticPngSource>,
    options: Readonly<StaticSurfaceDecodeOptions>
  ): Promise<BrowserDecodedStaticSurface> | null {
    if (this.#reserveTransient === null) return null;
    return this.#decodeSource(source, options, true);
  }

  async #decodeSource(
    source: Readonly<LeasedStaticPngSource>,
    options: Readonly<StaticSurfaceDecodeOptions>,
    requireExactOwnedCopy: boolean
  ): Promise<BrowserDecodedStaticSurface> {
    throwIfAborted(options.signal);
    const resourceLeases: BrowserStaticDecoderResourceLease[] = [];
    let plan: PngDecodePlan;
    let decoded: Readonly<{
      readonly bitmap: Readonly<CapturedStaticBitmap>;
      readonly path: StaticPngInflatePath;
    }>;
    try {
      if (this.#reserveTransient !== null) {
        resourceLeases.push(captureStaticDecoderResourceLease(
          await this.#reserveResource(
            "png-copy",
            source.byteLength,
            options.signal
          )
        ));
      }
      throwIfAborted(options.signal);
      const png = source.copy();
      if (
        !(png instanceof Uint8Array) ||
        png.byteLength !== source.byteLength ||
        (
          requireExactOwnedCopy &&
          (
            !(png.buffer instanceof ArrayBuffer) ||
            png.byteOffset !== 0 ||
            png.buffer.byteLength !== source.byteLength
          )
        )
      ) {
        throw new TypeError("static PNG copy does not match its exact lease");
      }
      plan = validatePngProfile({
        png,
        expectedWidth: options.expectedWidth,
        expectedHeight: options.expectedHeight
      });
      this.#peakPngCopyBytes = Math.max(
        this.#peakPngCopyBytes,
        plan.byteRange.length
      );
      this.#peakZlibBytes = Math.max(
        this.#peakZlibBytes,
        plan.zlibByteLength
      );
      this.#peakFilteredBytes = Math.max(
        this.#peakFilteredBytes,
        plan.expectedFilteredBytes
      );
      this.#peakRgbaBytes = Math.max(
        this.#peakRgbaBytes,
        plan.expectedRgbaBytes
      );
      if (this.#reserveTransient !== null) {
        resourceLeases.push(captureStaticDecoderResourceLease(
          await this.#reserveResource(
            "png-zlib",
            plan.zlibByteLength,
            options.signal
          )
        ));
        resourceLeases.push(captureStaticDecoderResourceLease(
          await this.#reserveResource(
            "png-scratch",
            staticDecoderScratchBytes(plan, this.#nativeInflater.supported),
            options.signal
          )
        ));
      }
      decoded = await awaitStrictBitmapDecode(
        (operationSignal) => this.#decodeBitmap(plan, operationSignal),
        options.signal,
        this.#timeoutMs,
        this.#timers,
        (late) => late.bitmap.retire()
      );
    } catch (error) {
      this.#errors = checkedIncrement(this.#errors, "static decode errors");
      if (
        error instanceof RuntimePlaybackError ||
        error instanceof FormatError ||
        error instanceof StaticSurfaceDecodeTimeoutError ||
        (error instanceof DOMException && error.name === "AbortError")
      ) {
        throw error;
      }
      throw new FormatError(
        "PNG_DEFLATE_INVALID",
        "validated static pixels could not create a browser surface"
      );
    } finally {
      releaseStaticDecoderResources(resourceLeases);
    }
    let closed = false;
    return Object.freeze({
      image: decoded.bitmap.image,
      width: plan.width,
      height: plan.height,
      inflatePath: decoded.path,
      close: () => {
        if (closed) return;
        closed = true;
        decoded.bitmap.retire();
      }
    });
  }

  async #decodeBitmap(
    plan: PngDecodePlan,
    signal: AbortSignal
  ): Promise<Readonly<{
    readonly bitmap: Readonly<CapturedStaticBitmap>;
    readonly path: StaticPngInflatePath;
  }>> {
    let result: PngRgbaDecodeResult;
    let path: StaticPngInflatePath;
    if (this.#nativeInflater.supported) {
      this.#nativeAttempts = checkedIncrement(
        this.#nativeAttempts,
        "native static inflate attempts"
      );
      let filtered: Uint8Array;
      try {
        filtered = await this.#nativeInflater.inflate(
          plan.copyZlibBytes(),
          plan.expectedFilteredBytes,
          signal
        );
      } catch (error) {
        if (signal.aborted) throw abortReason(signal);
        if (!this.#nativeInflaterInjected && error instanceof FormatError) {
          throw error;
        }
        throw new FormatError(
          "PNG_DEFLATE_INVALID",
          "native static inflate failed"
        );
      }
      throwIfAborted(signal);
      result = decodePngRgbaFromInflated(plan, filtered);
      this.#nativeSuccesses = checkedIncrement(
        this.#nativeSuccesses,
        "native static inflate successes"
      );
      path = "native";
    } else {
      this.#pureAttempts = checkedIncrement(
        this.#pureAttempts,
        "pure static inflate attempts"
      );
      try {
        result = this.#pureDecode(plan);
      } catch (error) {
        if (signal.aborted) throw abortReason(signal);
        if (!this.#pureDecodeInjected && error instanceof FormatError) {
          throw error;
        }
        throw new FormatError(
          "PNG_DEFLATE_INVALID",
          "pure static decode failed"
        );
      }
      this.#pureSuccesses = checkedIncrement(
        this.#pureSuccesses,
        "pure static inflate successes"
      );
      path = "pure";
    }
    throwIfAborted(signal);
    let image: unknown;
    try {
      image = await this.#createBitmap!(
        result.rgba,
        result.width,
        result.height
      );
    } catch {
      // A host exception, including a forged FormatError, must not cross the
      // strict decoder boundary with attacker-controlled text.
      throw new TypeError("validated RGBA bitmap creation failed");
    }
    const bitmap = this.#captureBitmap(
      image,
      result.width,
      result.height
    );
    if (signal.aborted) {
      bitmap.retire();
      throw abortReason(signal);
    }
    return Object.freeze({ bitmap, path });
  }

  async #reserveResource(
    category: BrowserStaticDecoderResourceCategory,
    byteLength: number,
    signal: AbortSignal
  ): Promise<BrowserStaticDecoderResourceLease> {
    const reserve = this.#reserveTransient;
    if (reserve === null) {
      throw new TypeError("static decoder resource admission is unavailable");
    }
    const pending = Promise.resolve(reserve(category, byteLength));
    if (signal.aborted) {
      void pending.then((late) => {
        try { late.release(); } catch {}
      }, () => undefined);
      throw abortReason(signal);
    }
    return awaitStrictBitmapDecode(
      () => pending,
      signal,
      this.#timeoutMs,
      this.#timers,
      (late) => {
        try { late.release(); } catch {}
      }
    );
  }

  #captureBitmap(
    value: unknown,
    expectedWidth: number,
    expectedHeight: number
  ): Readonly<CapturedStaticBitmap> {
    if (value === null || typeof value !== "object") {
      throw new TypeError("validated RGBA bitmap identity is invalid");
    }
    const image = value as ImageBitmap;
    let capturedClose: unknown;
    let retired = false;
    const retire = (): void => {
      if (retired) return;
      retired = true;
      this.#bitmapCloses = checkedIncrement(
        this.#bitmapCloses,
        "static bitmap closes"
      );
      try {
        if (typeof capturedClose === "function") {
          Reflect.apply(
            capturedClose as (...args: never[]) => unknown,
            image,
            []
          );
        }
      } catch {
        // The exact host bitmap has been retired from player ownership. A
        // hostile native closer cannot replace the selected public outcome.
      }
    };

    try {
      // Capture the closer before dimensions so a failing dimension accessor
      // still leaves an exact, stable cleanup path. No host field is re-read.
      capturedClose = Reflect.get(image, "close");
    } catch {
      retire();
      throw new TypeError("validated RGBA bitmap closer is invalid");
    }
    if (typeof capturedClose !== "function") {
      retire();
      throw new TypeError("validated RGBA bitmap closer is invalid");
    }

    let width: unknown;
    let height: unknown;
    try {
      width = Reflect.get(image, "width");
      height = Reflect.get(image, "height");
    } catch {
      retire();
      throw new TypeError("validated RGBA bitmap dimensions are invalid");
    }
    if (width !== expectedWidth || height !== expectedHeight) {
      retire();
      throw new FormatError(
        "PNG_DEFLATE_INVALID",
        "validated RGBA bitmap dimensions changed during surface creation"
      );
    }

    return Object.freeze({
      image,
      width: expectedWidth,
      height: expectedHeight,
      retire
    });
  }
}

export class StaticSurfaceDecodeTimeoutError extends Error {
  public readonly timeoutMs: number;

  public constructor(timeoutMs: number) {
    super(`static image decode exceeded ${String(timeoutMs)} ms`);
    this.name = "StaticSurfaceDecodeTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

async function createBitmapFromRgba(
  rgba: Uint8Array,
  width: number,
  height: number
): Promise<ImageBitmap> {
  if (typeof ImageData !== "function" || typeof createImageBitmap !== "function") {
    throw new TypeError("validated RGBA bitmap creation is unavailable");
  }
  if (!(rgba.buffer instanceof ArrayBuffer)) {
    throw new TypeError("validated RGBA bitmap storage must be an ArrayBuffer");
  }
  const clamped = new Uint8ClampedArray(
    rgba.buffer,
    rgba.byteOffset,
    rgba.byteLength
  );
  return createImageBitmap(new ImageData(clamped, width, height));
}

function captureStaticDecoderResourceHost(
  value: BrowserStaticDecoderResourceHost
): (
  category: BrowserStaticDecoderResourceCategory,
  byteLength: number
) => BrowserStaticDecoderResourceLease |
  PromiseLike<BrowserStaticDecoderResourceLease> {
  if (value === null || typeof value !== "object") {
    throw new TypeError("static decoder resource host is malformed");
  }
  let reserve: unknown;
  try {
    reserve = Reflect.get(value, "reserve");
  } catch {
    throw new TypeError("static decoder resource host is inaccessible");
  }
  if (typeof reserve !== "function") {
    throw new TypeError("static decoder resource host is malformed");
  }
  return (category, byteLength) => Reflect.apply(
    reserve,
    value,
    [category, byteLength]
  ) as BrowserStaticDecoderResourceLease |
    PromiseLike<BrowserStaticDecoderResourceLease>;
}

function captureStaticDecoderResourceLease(
  value: BrowserStaticDecoderResourceLease
): BrowserStaticDecoderResourceLease {
  if (value === null || typeof value !== "object") {
    throw new TypeError("static decoder resource lease is malformed");
  }
  let release: unknown;
  try {
    release = Reflect.get(value, "release");
  } catch {
    throw new TypeError("static decoder resource lease is inaccessible");
  }
  if (typeof release !== "function") {
    throw new TypeError("static decoder resource lease is malformed");
  }
  let released = false;
  return Object.freeze({
    release(): void {
      if (released) return;
      released = true;
      Reflect.apply(release, value, []);
    }
  });
}

function releaseStaticDecoderResources(
  leases: BrowserStaticDecoderResourceLease[]
): void {
  for (let index = leases.length - 1; index >= 0; index -= 1) {
    try {
      leases[index]!.release();
    } catch {
      // Accounting cleanup continues across a hostile release capability.
    }
  }
  leases.length = 0;
}

function staticDecoderScratchBytes(
  plan: Readonly<PngDecodePlan>,
  native: boolean
): number {
  const filteredAndRgba = checkedResourceSum(
    plan.expectedFilteredBytes,
    plan.expectedRgbaBytes,
    "static decoder filtered and RGBA bytes"
  );
  if (!native) return filteredAndRgba;
  const doubleFiltered = checkedResourceProduct(
    plan.expectedFilteredBytes,
    2,
    "static decoder double filtered bytes"
  );
  const nativeInflate = checkedResourceSum(
    plan.zlibByteLength,
    doubleFiltered,
    "static decoder native inflate bytes"
  );
  return Math.max(nativeInflate, filteredAndRgba);
}

function checkedResourceSum(left: number, right: number, label: string): number {
  if (
    !Number.isSafeInteger(left) ||
    left < 0 ||
    !Number.isSafeInteger(right) ||
    right < 0 ||
    left > Number.MAX_SAFE_INTEGER - right
  ) {
    throw new RangeError(`${label} exceed the safe-integer range`);
  }
  return left + right;
}

function checkedResourceProduct(
  left: number,
  right: number,
  label: string
): number {
  if (
    !Number.isSafeInteger(left) ||
    left < 0 ||
    !Number.isSafeInteger(right) ||
    right < 0 ||
    (right !== 0 && left > Math.floor(Number.MAX_SAFE_INTEGER / right))
  ) {
    throw new RangeError(`${label} exceed the safe-integer range`);
  }
  return left * right;
}

function awaitStrictBitmapDecode<T>(
  startDecode: (signal: AbortSignal) => Promise<T>,
  signal: AbortSignal,
  timeoutMs: number,
  timers: Readonly<BrowserStaticSurfaceTimerHost>,
  closeLate: (value: T) => void
): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const operationController = new AbortController();
    let completed = false;
    let timer: unknown = null;
    const cleanup = (): void => {
      signal.removeEventListener("abort", abort);
      if (timer !== null) {
        try {
          timers.clearTimeout(timer);
        } catch {
          // Cleanup cannot replace the selected decode outcome.
        }
      }
    };
    const finish = (outcome: () => void): void => {
      if (completed) return;
      completed = true;
      cleanup();
      outcome();
    };
    const abort = (): void => {
      const reason = abortReason(signal);
      operationController.abort(reason);
      finish(() => reject(reason));
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      const handle = timers.setTimeout(() => {
        const reason = new StaticSurfaceDecodeTimeoutError(timeoutMs);
        operationController.abort(reason);
        finish(() => reject(reason));
      }, timeoutMs);
      timer = handle;
      if (completed) {
        try {
          timers.clearTimeout(handle);
        } catch {
          // Preserve the already selected outcome.
        }
      }
    } catch (error) {
      operationController.abort(error);
      finish(() => reject(error));
    }
    if (completed) return;
    let decode: Promise<T>;
    try {
      decode = Promise.resolve(startDecode(operationController.signal));
    } catch (error) {
      operationController.abort(error);
      finish(() => reject(error));
      return;
    }
    void decode.then(
      (value) => {
        if (completed) {
          closeLate(value);
          return;
        }
        finish(() => resolve(value));
      },
      (error: unknown) => finish(() => reject(error))
    );
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

function abortReason(signal: AbortSignal): DOMException {
  return signal.reason instanceof DOMException &&
    signal.reason.name === "AbortError"
    ? signal.reason
    : new DOMException("strict static decode aborted", "AbortError");
}

function checkedIncrement(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER) {
    throw new RangeError(`${label} exceeds the safe integer range`);
  }
  return value + 1;
}
