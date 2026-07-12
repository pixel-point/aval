import type { CompiledManifestV01 } from "@rendered-motion/format";

import type { RuntimeAssetCatalog } from "./asset-catalog.js";
import {
  checkedByteNumber,
  checkedByteProduct,
  checkedRgbaBytes
} from "./checked-runtime-bytes.js";

export interface StaticSurfaceCatalogView {
  readonly manifest: Readonly<CompiledManifestV01>;
  copyStaticPng(staticFrame: string): Uint8Array;
}

export interface DecodedStaticSurface {
  readonly width: number;
  readonly height: number;
  close(): void;
}

export interface StaticSurfaceDecodeOptions {
  readonly signal: AbortSignal;
}

export interface StaticSurfaceDecoder<
  TSurface extends DecodedStaticSurface = DecodedStaticSurface
> {
  decode(
    png: Uint8Array,
    options: StaticSurfaceDecodeOptions
  ): Promise<TSurface>;
}

/** The host owns layering; present() must draw and cover atomically. */
export interface StaticPresentationPlane<
  TSurface extends DecodedStaticSurface = DecodedStaticSurface
> {
  present(surface: TSurface, width: number, height: number): void;
  coverStatic(): void;
  revealAnimated(): void;
  dispose?(): void;
}

export interface StaticSurfacePresentationReport {
  readonly state: string;
  readonly staticFrame: string;
  readonly redecoded: boolean;
  readonly rgbaBytes: number;
}

export interface StaticSurfaceValidationReport {
  readonly uniqueStaticFrames: number;
  readonly newlyValidated: number;
  readonly validatedRgbaBytes: number;
}

export interface StaticSurfaceStoreSnapshot {
  readonly state: "active" | "disposed";
  readonly currentState: string | null;
  readonly currentStaticFrame: string | null;
  readonly incomingStaticFrame: string | null;
  readonly retainedSurfaces: number;
  readonly peakRetainedSurfaces: number;
  readonly retainedRgbaBytes: number;
  readonly peakRetainedRgbaBytes: number;
  readonly validatedStaticFrames: number;
  readonly validatedRgbaBytes: number;
  readonly decodedSurfaces: number;
  readonly closedSurfaces: number;
  readonly presentations: number;
  readonly errors: number;
}

interface RetainedSurface<TSurface extends DecodedStaticSurface> {
  readonly staticFrame: string;
  readonly surface: TSurface;
}

export class StaticSurfaceStore<
  TSurface extends DecodedStaticSurface = DecodedStaticSurface
> {
  readonly #catalog: StaticSurfaceCatalogView;
  readonly #decoder: StaticSurfaceDecoder<TSurface>;
  readonly #plane: StaticPresentationPlane<TSurface>;
  readonly #width: number;
  readonly #height: number;
  readonly #surfaceBytes: number;
  readonly #maximumRetainedBytes: number;
  readonly #allValidatedBytes: number;
  readonly #staticByState: ReadonlyMap<string, string>;
  readonly #referencedStaticIds: readonly string[];
  readonly #validated = new Set<string>();
  readonly #ownedSurfaces = new WeakSet<object>();
  readonly #closedSurfaces = new WeakSet<object>();
  readonly #controllers = new Set<AbortController>();

  #current: RetainedSurface<TSurface> | null = null;
  #incoming: RetainedSurface<TSurface> | null = null;
  #currentState: string | null = null;
  #tail: Promise<void> = Promise.resolve();
  #activePresentController: AbortController | null = null;
  #latestPresentation = 0;
  #disposed = false;
  #peakRetainedSurfaces = 0;
  #decodedSurfaceCount = 0;
  #closedSurfaceCount = 0;
  #presentationCount = 0;
  #errors = 0;

  public constructor(
    catalog: StaticSurfaceCatalogView,
    decoder: StaticSurfaceDecoder<TSurface>,
    plane: StaticPresentationPlane<TSurface>
  ) {
    validateObject(catalog, "static surface catalog");
    validateObject(decoder, "static surface decoder");
    validateObject(plane, "static presentation plane");
    const manifest = catalog.manifest;
    this.#width = manifest.canvas.width;
    this.#height = manifest.canvas.height;
    this.#surfaceBytes = checkedByteNumber(
      checkedRgbaBytes(this.#width, this.#height, 1, "static surface bytes"),
      "static surface bytes"
    );
    this.#staticByState = new Map(
      manifest.states.map(({ id, staticFrame }) => [id, staticFrame])
    );
    this.#referencedStaticIds = Object.freeze(
      [...new Set(manifest.states.map(({ staticFrame }) => staticFrame))].sort()
    );
    this.#maximumRetainedBytes = checkedStaticByteCount(
      2,
      this.#surfaceBytes,
      "two-surface static peak"
    );
    this.#allValidatedBytes = checkedStaticByteCount(
      this.#referencedStaticIds.length,
      this.#surfaceBytes,
      "validated static bytes"
    );
    this.#catalog = catalog;
    this.#decoder = decoder;
    this.#plane = plane;
  }

  public installInitial(options: {
    readonly state?: string;
    readonly signal?: AbortSignal;
  } = {}): Promise<Readonly<StaticSurfacePresentationReport>> {
    const state = options.state ?? this.#catalog.manifest.initialState;
    return this.presentState(state, options);
  }

  public presentState(
    state: string,
    options: { readonly signal?: AbortSignal } = {}
  ): Promise<Readonly<StaticSurfacePresentationReport>> {
    this.#assertActive();
    const staticFrame = this.#staticByState.get(state);
    if (staticFrame === undefined) {
      throw new RangeError(`static presentation state ${state} is unknown`);
    }
    const generation = checkedCounterIncrement(
      this.#latestPresentation,
      "static presentation generation",
      Number.MAX_SAFE_INTEGER - 1
    );
    this.#latestPresentation = generation;
    this.#activePresentController?.abort(supersededError());
    const controller = new AbortController();
    this.#activePresentController = controller;
    const operation = this.#enqueue(
      controller,
      options.signal,
      async () => this.#present(state, staticFrame, generation, controller.signal)
    );
    void operation.finally(() => {
      if (this.#activePresentController === controller) {
        this.#activePresentController = null;
      }
    }).catch(() => undefined);
    return operation;
  }

  /** Sequentially probes every unique referenced static and closes each probe. */
  public validateAll(options: {
    readonly signal?: AbortSignal;
  } = {}): Promise<Readonly<StaticSurfaceValidationReport>> {
    this.#assertActive();
    const controller = new AbortController();
    return this.#enqueue(controller, options.signal, async () => {
      let newlyValidated = 0;
      for (const staticFrame of this.#referencedStaticIds) {
        throwIfAborted(controller.signal);
        if (this.#validated.has(staticFrame)) continue;
        const surface = await this.#decode(staticFrame, controller.signal);
        this.#incoming = { staticFrame, surface };
        this.#trackPeak();
        try {
          const nextNewlyValidated = checkedCounterIncrement(
            newlyValidated,
            "newly validated static surfaces"
          );
          this.#validated.add(staticFrame);
          newlyValidated = nextNewlyValidated;
        } finally {
          this.#incoming = null;
          this.#close(surface);
        }
      }
      return Object.freeze({
        uniqueStaticFrames: this.#referencedStaticIds.length,
        newlyValidated,
        validatedRgbaBytes: checkedStaticByteCount(
          this.#validated.size,
          this.#surfaceBytes,
          "validated static bytes"
        )
      });
    });
  }

  /** Cover animation with the retained static pixels without touching WebGL. */
  public coverCurrent(): void {
    this.#assertActive();
    if (this.#current === null) {
      throw new StaticSurfaceUnavailableError("no current static surface");
    }
    this.#plane.coverStatic();
  }

  public revealAnimated(): void {
    this.#assertActive();
    this.#plane.revealAnimated();
  }

  public snapshot(): Readonly<StaticSurfaceStoreSnapshot> {
    const retained = Number(this.#current !== null) + Number(this.#incoming !== null);
    return Object.freeze({
      state: this.#disposed ? "disposed" : "active",
      currentState: this.#currentState,
      currentStaticFrame: this.#current?.staticFrame ?? null,
      incomingStaticFrame: this.#incoming?.staticFrame ?? null,
      retainedSurfaces: retained,
      peakRetainedSurfaces: this.#peakRetainedSurfaces,
      retainedRgbaBytes: retained === 2
        ? this.#maximumRetainedBytes
        : retained * this.#surfaceBytes,
      peakRetainedRgbaBytes: this.#peakRetainedSurfaces === 2
        ? this.#maximumRetainedBytes
        : this.#peakRetainedSurfaces * this.#surfaceBytes,
      validatedStaticFrames: this.#validated.size,
      validatedRgbaBytes: this.#validated.size === this.#referencedStaticIds.length
        ? this.#allValidatedBytes
        : checkedStaticByteCount(
            this.#validated.size,
            this.#surfaceBytes,
            "validated static bytes"
          ),
      decodedSurfaces: this.#decodedSurfaceCount,
      closedSurfaces: this.#closedSurfaceCount,
      presentations: this.#presentationCount,
      errors: this.#errors
    });
  }

  public async settled(): Promise<void> {
    await this.#tail;
  }

  public dispose(): void {
    if (this.#disposed) return;
    const terminalGeneration = checkedCounterIncrement(
      this.#latestPresentation,
      "static presentation generation"
    );
    this.#disposed = true;
    this.#latestPresentation = terminalGeneration;
    for (const controller of this.#controllers) {
      controller.abort(disposedError());
    }
    this.#controllers.clear();
    this.#activePresentController = null;
    if (this.#incoming !== null) {
      this.#close(this.#incoming.surface);
      this.#incoming = null;
    }
    if (this.#current !== null) {
      this.#close(this.#current.surface);
      this.#current = null;
    }
    this.#currentState = null;
    try {
      this.#plane.dispose?.();
    } catch {
      this.#errors = checkedCounterIncrement(
        this.#errors,
        "static surface errors"
      );
    }
  }

  async #present(
    state: string,
    staticFrame: string,
    generation: number,
    signal: AbortSignal
  ): Promise<Readonly<StaticSurfacePresentationReport>> {
    throwIfAborted(signal);
    this.#assertActive();
    this.#assertLatest(generation);
    if (this.#current?.staticFrame === staticFrame) {
      const presentationCount = checkedCounterIncrement(
        this.#presentationCount,
        "static surface presentations"
      );
      this.#plane.coverStatic();
      this.#currentState = state;
      this.#presentationCount = presentationCount;
      return Object.freeze({
        state,
        staticFrame,
        redecoded: false,
        rgbaBytes: this.#surfaceBytes
      });
    }

    const surface = await this.#decode(staticFrame, signal);
    this.#incoming = { staticFrame, surface };
    this.#trackPeak();
    try {
      throwIfAborted(signal);
      this.#assertActive();
      this.#assertLatest(generation);
      const presentationCount = checkedCounterIncrement(
        this.#presentationCount,
        "static surface presentations"
      );
      this.#plane.present(surface, this.#width, this.#height);
      const previous = this.#current;
      this.#current = this.#incoming;
      this.#incoming = null;
      this.#currentState = state;
      this.#validated.add(staticFrame);
      this.#presentationCount = presentationCount;
      if (previous !== null) this.#close(previous.surface);
      return Object.freeze({
        state,
        staticFrame,
        redecoded: true,
        rgbaBytes: this.#surfaceBytes
      });
    } finally {
      if (this.#incoming?.surface === surface) {
        this.#incoming = null;
        this.#close(surface);
      }
    }
  }

  async #decode(staticFrame: string, signal: AbortSignal): Promise<TSurface> {
    throwIfAborted(signal);
    this.#assertActive();
    const decodedSurfaceCount = checkedCounterIncrement(
      this.#decodedSurfaceCount,
      "decoded static surfaces"
    );
    const png = this.#catalog.copyStaticPng(staticFrame);
    let surface: TSurface;
    try {
      surface = await this.#decoder.decode(png, { signal });
    } catch (error) {
      if (signal.aborted) throw abortReason(signal);
      throw error;
    }
    this.#decodedSurfaceCount = decodedSurfaceCount;
    if (surface === null || typeof surface !== "object") {
      throw new StaticSurfaceUnavailableError("decoder returned no surface");
    }
    if (this.#ownedSurfaces.has(surface)) {
      throw new StaticSurfaceUnavailableError("decoder reused a surface identity");
    }
    this.#ownedSurfaces.add(surface);
    if (
      surface.width !== this.#width ||
      surface.height !== this.#height ||
      typeof surface.close !== "function"
    ) {
      this.#close(surface);
      throw new StaticSurfaceUnavailableError(
        "decoded static surface dimensions do not match the logical canvas"
      );
    }
    if (signal.aborted || this.#disposed) {
      this.#close(surface);
      throw signal.aborted ? abortReason(signal) : disposedError();
    }
    return surface;
  }

  #enqueue<TResult>(
    controller: AbortController,
    callerSignal: AbortSignal | undefined,
    operation: () => Promise<TResult>
  ): Promise<TResult> {
    const unlink = forwardAbort(callerSignal, controller);
    this.#controllers.add(controller);
    const result = this.#tail.then(async () => {
      throwIfAborted(controller.signal);
      this.#assertActive();
      try {
        return await operation();
      } catch (error) {
        if (!isAbortError(error) && !this.#disposed) {
          this.#errors = checkedCounterIncrement(
            this.#errors,
            "static surface errors"
          );
        }
        throw error;
      }
    });
    this.#tail = result.then(() => undefined, () => undefined);
    void result.finally(() => {
      unlink();
      this.#controllers.delete(controller);
    }).catch(() => undefined);
    return result;
  }

  #assertLatest(generation: number): void {
    if (generation !== this.#latestPresentation) throw supersededError();
  }

  #trackPeak(): void {
    const retained = Number(this.#current !== null) + Number(this.#incoming !== null);
    this.#peakRetainedSurfaces = Math.max(this.#peakRetainedSurfaces, retained);
    if (retained > 2) {
      throw new Error("static surface store exceeded the two-surface bound");
    }
  }

  #close(surface: TSurface): void {
    if (this.#closedSurfaces.has(surface)) return;
    const closedSurfaceCount = checkedCounterIncrement(
      this.#closedSurfaceCount,
      "closed static surfaces"
    );
    this.#closedSurfaces.add(surface);
    this.#closedSurfaceCount = closedSurfaceCount;
    try {
      surface.close();
    } catch {
      this.#errors = checkedCounterIncrement(
        this.#errors,
        "static surface errors"
      );
    }
  }

  #assertActive(): void {
    if (this.#disposed) throw disposedError();
  }
}

export class StaticSurfaceUnavailableError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "StaticSurfaceUnavailableError";
  }
}

export class StaticSurfaceStoreDisposedError extends Error {
  public constructor() {
    super("the static surface store is disposed");
    this.name = "StaticSurfaceStoreDisposedError";
  }
}

export interface BrowserDecodedStaticSurface extends DecodedStaticSurface {
  readonly image: ImageBitmap;
}

export interface BrowserStaticSurfaceDecoderOptions {
  readonly timeoutMs?: number;
  readonly timers?: Readonly<BrowserStaticSurfaceTimerHost>;
}

export interface BrowserStaticSurfaceTimerHost {
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
}

const DEFAULT_STATIC_DECODE_TIMEOUT_MS = 5_000;
const DEFAULT_STATIC_DECODE_TIMERS: Readonly<BrowserStaticSurfaceTimerHost> =
  Object.freeze({
    setTimeout: (callback: () => void, milliseconds: number): unknown =>
      globalThis.setTimeout(callback, milliseconds),
    clearTimeout: (handle: unknown): void =>
      globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>)
  });

/** Narrow browser decode adapter; successful decode is the M5.5 PNG check. */
export class BrowserStaticSurfaceDecoder
implements StaticSurfaceDecoder<BrowserDecodedStaticSurface> {
  readonly #decodeImage: (blob: Blob) => Promise<ImageBitmap>;
  readonly #timeoutMs: number;
  readonly #timers: Readonly<BrowserStaticSurfaceTimerHost>;

  public constructor(
    decodeImage: (blob: Blob) => Promise<ImageBitmap> = (blob) =>
      createImageBitmap(blob),
    options: Readonly<BrowserStaticSurfaceDecoderOptions> = {}
  ) {
    this.#decodeImage = decodeImage;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_STATIC_DECODE_TIMEOUT_MS;
    this.#timers = options.timers ?? DEFAULT_STATIC_DECODE_TIMERS;
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
      typeof this.#timers.setTimeout !== "function" ||
      typeof this.#timers.clearTimeout !== "function"
    ) {
      throw new TypeError("static decode timers are invalid");
    }
  }

  public async decode(
    png: Uint8Array,
    options: StaticSurfaceDecodeOptions
  ): Promise<BrowserDecodedStaticSurface> {
    throwIfAborted(options.signal);
    let image: ImageBitmap;
    try {
      image = await awaitBrowserImageDecode(
        this.#decodeImage(new Blob([png as BlobPart], {
          type: "image/png"
        })),
        options.signal,
        this.#timeoutMs,
        this.#timers
      );
    } catch (error) {
      if (options.signal.aborted) throw abortReason(options.signal);
      throw error;
    }
    if (options.signal.aborted) {
      image.close();
      throw abortReason(options.signal);
    }
    let closed = false;
    return Object.freeze({
      image,
      width: image.width,
      height: image.height,
      close() {
        if (closed) return;
        closed = true;
        image.close();
      }
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

/** Canvas adapter only; DOM layering remains a host-supplied callback. */
export class BrowserStaticCanvasPlane
implements StaticPresentationPlane<BrowserDecodedStaticSurface> {
  readonly #canvas: HTMLCanvasElement;
  readonly #context: CanvasRenderingContext2D;
  readonly #setStaticVisible: (visible: boolean) => void;
  #disposed = false;

  public constructor(
    canvas: HTMLCanvasElement,
    setStaticVisible: (visible: boolean) => void
  ) {
    const context = canvas.getContext("2d", { alpha: true });
    if (context === null) {
      throw new StaticSurfaceUnavailableError("2D static canvas is unavailable");
    }
    this.#canvas = canvas;
    this.#context = context;
    this.#setStaticVisible = setStaticVisible;
  }

  public present(
    surface: BrowserDecodedStaticSurface,
    width: number,
    height: number
  ): void {
    this.#assertActive();
    this.#canvas.width = width;
    this.#canvas.height = height;
    this.#context.drawImage(surface.image, 0, 0, width, height);
    this.#setStaticVisible(true);
  }

  public coverStatic(): void {
    this.#assertActive();
    this.#setStaticVisible(true);
  }

  public revealAnimated(): void {
    this.#assertActive();
    this.#setStaticVisible(false);
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#context.clearRect(0, 0, this.#canvas.width, this.#canvas.height);
    this.#setStaticVisible(false);
  }

  #assertActive(): void {
    if (this.#disposed) throw disposedError();
  }
}

/** Live catalog satisfies the narrow store dependency without an adapter. */
export function asStaticSurfaceCatalog(
  catalog: RuntimeAssetCatalog
): StaticSurfaceCatalogView {
  return catalog;
}

function forwardAbort(
  source: AbortSignal | undefined,
  target: AbortController
): () => void {
  if (source === undefined) return () => undefined;
  const abort = (): void => target.abort(abortReason(source));
  if (source.aborted) abort();
  else source.addEventListener("abort", abort, { once: true });
  return () => source.removeEventListener("abort", abort);
}

function awaitBrowserImageDecode(
  decode: Promise<ImageBitmap>,
  signal: AbortSignal,
  timeoutMs: number,
  timers: Readonly<BrowserStaticSurfaceTimerHost>
): Promise<ImageBitmap> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<ImageBitmap>((resolve, reject) => {
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
    const abort = (): void => finish(() => reject(abortReason(signal)));
    signal.addEventListener("abort", abort, { once: true });
    try {
      const handle = timers.setTimeout(() => {
        finish(() => reject(new StaticSurfaceDecodeTimeoutError(timeoutMs)));
      }, timeoutMs);
      timer = handle;
      if (completed) {
        try {
          timers.clearTimeout(handle);
        } catch {
          // Preserve the already selected timeout/decode outcome.
        }
      }
    } catch (error) {
      finish(() => reject(error));
    }
    void decode.then(
      (image) => {
        if (completed) {
          safeCloseImage(image);
          return;
        }
        finish(() => resolve(image));
      },
      (error: unknown) => finish(() => reject(error))
    );
  });
}

function safeCloseImage(image: ImageBitmap): void {
  try {
    image.close();
  } catch {
    // A late native decode owns no player state; cleanup is best-effort.
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

function abortReason(signal: AbortSignal): DOMException {
  return isAbortError(signal.reason)
    ? signal.reason as DOMException
    : new DOMException("static surface operation aborted", "AbortError");
}

function supersededError(): DOMException {
  return new DOMException("static presentation superseded", "AbortError");
}

function disposedError(): StaticSurfaceStoreDisposedError {
  return new StaticSurfaceStoreDisposedError();
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function validateObject(value: unknown, label: string): void {
  if (value === null || typeof value !== "object") {
    throw new TypeError(`${label} must be an object`);
  }
}

function checkedCounterIncrement(
  value: number,
  label: string,
  maximum = Number.MAX_SAFE_INTEGER
): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    !Number.isSafeInteger(maximum) ||
    maximum < 1 ||
    value >= maximum
  ) {
    throw new RangeError(`${label} exceeds safe-integer range`);
  }
  return value + 1;
}

function checkedStaticByteCount(
  surfaces: number,
  surfaceBytes: number,
  label: string
): number {
  return checkedByteNumber(
    checkedByteProduct([surfaces, surfaceBytes], label),
    label
  );
}
