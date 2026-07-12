import { STREAMING_TEXTURE_LAYER_COUNT } from "./checked-runtime-bytes.js";
import {
  checkedOpaqueRgbaBytes,
  freezeOpaqueFrameLayout,
  validateOpaqueBackendLimits,
  validateOpaqueGeneration,
  validateOpaqueIndex,
  validateOpaqueObject,
  validateOpaqueStreamingSlots
} from "./opaque-frame-renderer-validation.js";

export const OPAQUE_STREAMING_SLOT_COUNT = STREAMING_TEXTURE_LAYER_COUNT;

export type FrameRendererState = "active" | "lost" | "error" | "disposed";

export interface OpaqueFrameTextureLayout {
  readonly codedWidth: number;
  readonly codedHeight: number;
  readonly logicalWidth: number;
  readonly logicalHeight: number;
  readonly residentLayerCount: number;
}

export interface CopyableVideoFrame {
  readonly codedWidth: number;
  readonly codedHeight: number;
  readonly displayWidth: number;
  readonly displayHeight: number;
  readonly visibleRect: DOMRectReadOnly | null;
  copyTo(
    destination: AllowSharedBufferSource,
    options?: VideoFrameCopyToOptions
  ): Promise<readonly PlaneLayout[]>;
}

export interface BorrowedVideoFrame {
  readonly frame: CopyableVideoFrame;
  close(): void;
}

export interface OpaqueFrameRendererBackendLimits {
  readonly maxTextureSize: number;
  readonly maxArrayTextureLayers: number;
}

export type OpaqueTextureKind = "resident" | "stream";

/** Small injectable boundary used for deterministic ownership tests. */
export interface OpaqueFrameRendererBackend {
  readonly limits: Readonly<OpaqueFrameRendererBackendLimits>;
  allocate(layout: OpaqueFrameTextureLayout, streamingSlots: number): void;
  upload(kind: OpaqueTextureKind, index: number, pixels: Uint8Array): void;
  draw(kind: OpaqueTextureKind, index: number): void;
  readPixels?(): Uint8Array;
  dispose(): void;
}

export interface ResidentFrameHandle {
  readonly kind: "resident";
  readonly layer: number;
  readonly resourceGeneration: number;
}

export interface StreamingFrameHandle {
  readonly kind: "stream";
  readonly slot: number;
  readonly pathGeneration: number;
  readonly uploadSerial: number;
  readonly resourceGeneration: number;
}

export type RenderFrameHandle = ResidentFrameHandle | StreamingFrameHandle;

export interface OpaqueFrameRendererSnapshot {
  readonly state: FrameRendererState;
  readonly resourceGeneration: number;
  readonly stagingBytes: number;
  readonly allocatedLayers: number;
  readonly uploadedResidentLayers: number;
  readonly uploadedStreamingSlots: number;
  readonly residentUploads: number;
  readonly streamingUploads: number;
  readonly draws: number;
  readonly closedSourceFrames: number;
  readonly staleUploads: number;
  readonly errors: number;
}

export interface OpaqueFrameRendererOptions {
  readonly streamingSlots?: number;
  /** M2 compatibility only; M5.5 production contexts terminalize on loss. */
  readonly contextLossPolicy?: "terminal" | "restorable";
  /** Bounds a browser copy that never resolves, including live uploads. */
  readonly copyTimeoutMs?: number;
  readonly timers?: Readonly<OpaqueFrameRendererTimerHost>;
}

export interface OpaqueFrameRendererTimerHost {
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
}

const DEFAULT_COPY_TIMEOUT_MS = 5_000;
const DEFAULT_RENDERER_TIMERS: Readonly<OpaqueFrameRendererTimerHost> =
  Object.freeze({
    setTimeout: (callback: () => void, milliseconds: number): unknown =>
      globalThis.setTimeout(callback, milliseconds),
    clearTimeout: (handle: unknown): void =>
      globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>)
  });

/**
 * Owns one bounded staging buffer and serializes every async frame copy before
 * passing packed RGBA bytes to an injected WebGL backend. Source frames are
 * always closed exactly once by this class after ownership is transferred.
 */
export class OpaqueFrameRenderer {
  readonly #layout: Readonly<OpaqueFrameTextureLayout>;
  readonly #streamingSlots: number;
  readonly #contextLossPolicy: "terminal" | "restorable";
  readonly #copyTimeoutMs: number;
  readonly #timers: Readonly<OpaqueFrameRendererTimerHost>;
  #staging: Uint8Array;
  readonly #claimedSources = new WeakSet<object>();
  readonly #uploadedResidentLayers = new Set<number>();
  readonly #streamingSlotVersions = new Map<
    number,
    { readonly pathGeneration: number; readonly uploadSerial: number }
  >();

  #backend: OpaqueFrameRendererBackend | null;
  #uploadAbort = new AbortController();
  #state: FrameRendererState = "active";
  #resourceGeneration = 1;
  #uploadTail: Promise<void> = Promise.resolve();
  #residentUploads = 0;
  #streamingUploads = 0;
  #nextStreamingUploadSerial = 1;
  #draws = 0;
  #closedSourceFrames = 0;
  #staleUploads = 0;
  #errors = 0;

  public constructor(
    backend: OpaqueFrameRendererBackend,
    layout: OpaqueFrameTextureLayout,
    options: OpaqueFrameRendererOptions = {}
  ) {
    this.#layout = freezeOpaqueFrameLayout(layout);
    this.#streamingSlots = validateOpaqueStreamingSlots(
      options.streamingSlots ?? OPAQUE_STREAMING_SLOT_COUNT
    );
    this.#contextLossPolicy = options.contextLossPolicy ?? "terminal";
    this.#copyTimeoutMs = options.copyTimeoutMs ?? DEFAULT_COPY_TIMEOUT_MS;
    this.#timers = options.timers ?? DEFAULT_RENDERER_TIMERS;
    if (
      this.#contextLossPolicy !== "terminal" &&
      this.#contextLossPolicy !== "restorable"
    ) {
      throw new RangeError("context loss policy must be terminal or restorable");
    }
    if (
      !Number.isSafeInteger(this.#copyTimeoutMs) ||
      this.#copyTimeoutMs <= 0 ||
      this.#copyTimeoutMs > 60_000
    ) {
      throw new RangeError(
        "renderer copy timeout must be an integer from 1 through 60000 ms"
      );
    }
    if (
      typeof this.#timers.setTimeout !== "function" ||
      typeof this.#timers.clearTimeout !== "function"
    ) {
      throw new TypeError("renderer timers are invalid");
    }
    validateOpaqueBackendLimits(backend, this.#layout);
    try {
      const codedBytes = checkedOpaqueRgbaBytes(
        this.#layout.codedWidth,
        this.#layout.codedHeight
      );
      const logicalBytes = checkedOpaqueRgbaBytes(
        this.#layout.logicalWidth,
        this.#layout.logicalHeight
      );
      this.#staging = new Uint8Array(Math.max(codedBytes, logicalBytes));
    } catch (error) {
      safeDisposeBackend(backend);
      throw normalizeError(error, "failed to allocate the RGBA staging surface");
    }
    this.#backend = backend;

    try {
      backend.allocate(this.#layout, this.#streamingSlots);
    } catch (error) {
      this.#state = "error";
      this.#errors += 1;
      safeDisposeBackend(backend);
      this.#backend = null;
      throw normalizeError(error, "failed to allocate WebGL frame textures");
    }
  }

  public get resourceGeneration(): number {
    return this.#resourceGeneration;
  }

  public get limits(): Readonly<OpaqueFrameRendererBackendLimits> {
    const backend = this.#backend;
    if (backend === null) {
      throw new RendererUnavailableError(this.#state);
    }
    return backend.limits;
  }

  /**
   * Transfers ownership of source to the renderer. The source is closed after
   * its queued copy/upload finishes, or immediately if its generation is stale.
   */
  public uploadResident(
    layer: number,
    source: BorrowedVideoFrame,
    resourceGeneration = this.#resourceGeneration
  ): Promise<ResidentFrameHandle | null> {
    validateOpaqueIndex(layer, this.#layout.residentLayerCount, "resident layer");
    return this.#queueUpload(
      source,
      resourceGeneration,
      (pixels) => {
        this.#requireActiveBackend().upload("resident", layer, pixels);
        this.#uploadedResidentLayers.add(layer);
        this.#residentUploads += 1;
        return Object.freeze({
          kind: "resident" as const,
          layer,
          resourceGeneration
        });
      }
    );
  }

  /** Transfers one decoded continuation frame into a bounded reusable slot. */
  public uploadStreaming(
    slot: number,
    pathGeneration: number,
    source: BorrowedVideoFrame,
    resourceGeneration = this.#resourceGeneration
  ): Promise<StreamingFrameHandle | null> {
    validateOpaqueIndex(slot, this.#streamingSlots, "streaming slot");
    validateOpaqueGeneration(pathGeneration, "path generation");
    return this.#queueUpload(
      source,
      resourceGeneration,
      (pixels) => {
        this.#requireActiveBackend().upload("stream", slot, pixels);
        this.#streamingUploads += 1;
        const uploadSerial = this.#nextStreamingUploadSerial;
        this.#nextStreamingUploadSerial += 1;
        this.#streamingSlotVersions.set(slot, {
          pathGeneration,
          uploadSerial
        });
        return Object.freeze({
          kind: "stream" as const,
          slot,
          pathGeneration,
          uploadSerial,
          resourceGeneration
        });
      }
    );
  }

  public residentHandle(layer: number): ResidentFrameHandle {
    this.#assertActive();
    validateOpaqueIndex(layer, this.#layout.residentLayerCount, "resident layer");
    if (!this.#uploadedResidentLayers.has(layer)) {
      throw new RendererFrameUnavailableError(
        `resident layer ${String(layer)} has not been uploaded`
      );
    }
    return Object.freeze({
      kind: "resident",
      layer,
      resourceGeneration: this.#resourceGeneration
    });
  }

  public draw(handle: RenderFrameHandle): void {
    this.#assertActive();
    if (handle.resourceGeneration !== this.#resourceGeneration) {
      throw new RendererFrameUnavailableError(
        "frame handle belongs to a stale resource generation"
      );
    }

    const backend = this.#requireActiveBackend();
    try {
      if (handle.kind === "resident") {
        validateOpaqueIndex(
          handle.layer,
          this.#layout.residentLayerCount,
          "resident layer"
        );
        if (!this.#uploadedResidentLayers.has(handle.layer)) {
          throw new RendererFrameUnavailableError(
            `resident layer ${String(handle.layer)} has not been uploaded`
          );
        }
        backend.draw("resident", handle.layer);
      } else {
        validateOpaqueIndex(handle.slot, this.#streamingSlots, "streaming slot");
        const version = this.#streamingSlotVersions.get(handle.slot);
        if (
          version === undefined ||
          version.pathGeneration !== handle.pathGeneration ||
          version.uploadSerial !== handle.uploadSerial
        ) {
          throw new RendererFrameUnavailableError(
            "streaming frame handle has been superseded"
          );
        }
        backend.draw("stream", handle.slot);
      }
    } catch (error) {
      if (
        error instanceof RendererFrameUnavailableError ||
        error instanceof RangeError
      ) throw error;
      throw this.#terminalizeError(error, "failed to draw a WebGL frame");
    }
    this.#draws += 1;
  }

  public readPixels(): Uint8Array {
    this.#assertActive();
    const readPixels = this.#requireActiveBackend().readPixels;
    if (readPixels === undefined) {
      throw new RendererUnavailableError("pixel readback is unavailable");
    }
    try {
      return readPixels.call(this.#backend);
    } catch (error) {
      throw this.#terminalizeError(error, "failed to read WebGL frame pixels");
    }
  }

  /** Invalidates all GL handles and closes the current backend. */
  public markContextLost(): void {
    if (this.#state === "disposed" || this.#state === "lost") {
      return;
    }
    this.#state = "lost";
    this.#abortUploads(new RendererUploadAbortedError("context was lost"));
    this.#resourceGeneration += 1;
    this.#uploadedResidentLayers.clear();
    this.#streamingSlotVersions.clear();
    const backend = this.#backend;
    this.#backend = null;
    if (backend !== null) {
      safeDisposeBackend(backend);
    }
  }

  /** Installs a fresh context after loss. Every resident layer must re-upload. */
  public restore(backend: OpaqueFrameRendererBackend): void {
    if (this.#contextLossPolicy !== "restorable") {
      safeDisposeBackend(backend);
      throw new RendererUnavailableError("context loss is terminal");
    }
    if (this.#state === "disposed") {
      throw new RendererDisposedError();
    }
    if (this.#state !== "lost" && this.#state !== "error") {
      throw new Error(`cannot restore a renderer in state ${this.#state}`);
    }
    validateOpaqueBackendLimits(backend, this.#layout);
    try {
      backend.allocate(this.#layout, this.#streamingSlots);
    } catch (error) {
      this.#state = "error";
      this.#errors += 1;
      safeDisposeBackend(backend);
      throw normalizeError(error, "failed to restore WebGL frame textures");
    }
    this.#backend = backend;
    this.#staging = new Uint8Array(this.#staging.byteLength);
    this.#uploadAbort = new AbortController();
    this.#state = "active";
    this.#uploadedResidentLayers.clear();
    this.#streamingSlotVersions.clear();
  }

  public snapshot(): OpaqueFrameRendererSnapshot {
    return Object.freeze({
      state: this.#state,
      resourceGeneration: this.#resourceGeneration,
      stagingBytes: this.#staging.byteLength,
      allocatedLayers:
        this.#state === "active" ? this.#layout.residentLayerCount : 0,
      uploadedResidentLayers: this.#uploadedResidentLayers.size,
      uploadedStreamingSlots: this.#streamingSlotVersions.size,
      residentUploads: this.#residentUploads,
      streamingUploads: this.#streamingUploads,
      draws: this.#draws,
      closedSourceFrames: this.#closedSourceFrames,
      staleUploads: this.#staleUploads,
      errors: this.#errors
    });
  }

  public async settled(): Promise<void> {
    await this.#uploadTail;
  }

  public dispose(): void {
    if (this.#state === "disposed") {
      return;
    }
    this.#state = "disposed";
    this.#abortUploads(new RendererUploadAbortedError("renderer was disposed"));
    this.#resourceGeneration += 1;
    this.#uploadedResidentLayers.clear();
    this.#streamingSlotVersions.clear();
    const backend = this.#backend;
    this.#backend = null;
    if (backend !== null) {
      safeDisposeBackend(backend);
    }
  }

  #queueUpload<T extends RenderFrameHandle>(
    source: BorrowedVideoFrame,
    resourceGeneration: number,
    upload: (pixels: Uint8Array) => T
  ): Promise<T | null> {
    validateOpaqueGeneration(resourceGeneration, "resource generation");
    validateOpaqueObject(source, "borrowed video frame");
    if (this.#claimedSources.has(source)) {
      throw new RendererFrameUnavailableError(
        "borrowed video frame ownership was already transferred"
      );
    }
    this.#claimedSources.add(source);
    let result: T | null = null;
    const operation = this.#uploadTail.then(async () => {
      try {
        if (
          this.#state !== "active" ||
          resourceGeneration !== this.#resourceGeneration
        ) {
          this.#staleUploads += 1;
          return;
        }
        const visibleRect = validateFrameGeometry(source.frame, this.#layout);
        const staging = this.#staging;
        const copy = source.frame.copyTo(staging, {
          rect: visibleRect,
          format: "RGBA",
          layout: [
            {
              offset: 0,
              stride: this.#layout.codedWidth * 4
            }
          ]
        });
        await awaitRendererCopy(
          copy,
          this.#uploadAbort.signal,
          this.#copyTimeoutMs,
          this.#timers
        );
        if (
          this.#state !== "active" ||
          resourceGeneration !== this.#resourceGeneration
        ) {
          this.#staleUploads += 1;
          return;
        }
        result = upload(staging);
      } catch (error) {
        if (
          this.#state === "disposed" ||
          this.#state === "lost" ||
          resourceGeneration !== this.#resourceGeneration
        ) {
          this.#staleUploads += 1;
          return;
        }
        throw this.#terminalizeError(error, "failed to upload a WebGL frame");
      } finally {
        try {
          source.close();
        } finally {
          this.#closedSourceFrames += 1;
        }
      }
    });

    this.#uploadTail = operation.catch(() => undefined);
    return operation.then(() => result);
  }

  #assertActive(): void {
    if (this.#state === "disposed") {
      throw new RendererDisposedError();
    }
    if (this.#state !== "active") {
      throw new RendererUnavailableError(this.#state);
    }
  }

  #requireActiveBackend(): OpaqueFrameRendererBackend {
    this.#assertActive();
    const backend = this.#backend;
    if (backend === null) {
      throw new RendererUnavailableError(this.#state);
    }
    return backend;
  }

  #terminalizeError(error: unknown, context: string): Error {
    if (this.#state !== "disposed" && this.#state !== "lost") {
      this.#state = "error";
      this.#abortUploads(error);
      this.#resourceGeneration += 1;
      this.#errors += 1;
      const backend = this.#backend;
      this.#backend = null;
      this.#uploadedResidentLayers.clear();
      this.#streamingSlotVersions.clear();
      if (backend !== null) safeDisposeBackend(backend);
    }
    return normalizeError(error, context);
  }

  #abortUploads(reason: unknown): void {
    if (!this.#uploadAbort.signal.aborted) {
      this.#uploadAbort.abort(reason);
    }
  }
}

export class RendererDisposedError extends Error {
  public constructor() {
    super("the WebGL frame renderer is disposed");
    this.name = "RendererDisposedError";
  }
}

export class RendererUnavailableError extends Error {
  public constructor(reason: string) {
    super(`the WebGL frame renderer is unavailable: ${reason}`);
    this.name = "RendererUnavailableError";
  }
}

export class RendererFrameUnavailableError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "RendererFrameUnavailableError";
  }
}

export class RendererUploadTimeoutError extends Error {
  public readonly timeoutMs: number;

  public constructor(timeoutMs: number) {
    super(`decoded frame copy exceeded ${String(timeoutMs)} ms`);
    this.name = "RendererUploadTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

class RendererUploadAbortedError extends DOMException {
  public constructor(message: string) {
    super(message, "AbortError");
  }
}

function validateFrameGeometry(
  frame: CopyableVideoFrame,
  layout: Readonly<OpaqueFrameTextureLayout>
): DOMRectReadOnly {
  const visible = frame.visibleRect;
  const maximumCodedWidth = Math.ceil(layout.codedWidth / 16) * 16 + 16;
  const maximumCodedHeight = Math.ceil(layout.codedHeight / 16) * 16 + 16;
  if (
    visible === null ||
    frame.displayWidth !== layout.codedWidth ||
    frame.displayHeight !== layout.codedHeight ||
    visible.width !== layout.codedWidth ||
    visible.height !== layout.codedHeight ||
    visible.x < 0 ||
    visible.y < 0 ||
    frame.codedWidth < visible.x + visible.width ||
    frame.codedHeight < visible.y + visible.height ||
    frame.codedWidth > maximumCodedWidth ||
    frame.codedHeight > maximumCodedHeight
  ) {
    throw new RangeError("decoded frame geometry does not match texture layout");
  }
  return visible;
}

function safeDisposeBackend(backend: OpaqueFrameRendererBackend): void {
  try {
    backend.dispose();
  } catch {
    // Cleanup remains best-effort after a terminal renderer failure.
  }
}

function normalizeError(error: unknown, context: string): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error(`${context}: ${String(error)}`);
}

function awaitRendererCopy(
  copy: Promise<readonly PlaneLayout[]>,
  signal: AbortSignal,
  timeoutMs: number,
  timers: Readonly<OpaqueFrameRendererTimerHost>
): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<void>((resolve, reject) => {
    let completed = false;
    let timer: unknown = null;
    const finish = (outcome: () => void): void => {
      if (completed) return;
      completed = true;
      signal.removeEventListener("abort", abort);
      if (timer !== null) {
        try {
          timers.clearTimeout(timer);
        } catch {
          // Timer cleanup cannot replace the copy outcome.
        }
      }
      outcome();
    };
    const abort = (): void => finish(() => reject(signal.reason));
    signal.addEventListener("abort", abort, { once: true });
    try {
      const handle = timers.setTimeout(() => {
        finish(() => reject(new RendererUploadTimeoutError(timeoutMs)));
      }, timeoutMs);
      timer = handle;
      if (completed) {
        try {
          timers.clearTimeout(handle);
        } catch {
          // Preserve the already selected timeout/copy outcome.
        }
      }
    } catch (error) {
      finish(() => reject(error));
      return;
    }
    void copy.then(
      () => finish(resolve),
      (error: unknown) => finish(() => reject(error))
    );
  });
}
