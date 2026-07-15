import {
  maximumAvcDecoderSurfaceDimension,
  type AvcRenditionGeometry
} from "@pixel-point/aval-format";

import { STREAMING_TEXTURE_LAYER_COUNT } from "./checked-runtime-bytes.js";
import {
  checkedFrameTextureBytes,
  createLegacyOpaqueFrameLayout,
  freezeFrameLayout,
  freezeLegacyFrameLayout,
  toLegacyOpaqueFrameLayout,
  validateFrameBackendLimits,
  validateFrameGeneration,
  validateFrameIndex,
  validateFrameObject,
  validateFrameStreamingSlots
} from "./frame-renderer-validation.js";

export const FRAME_STREAMING_SLOT_COUNT = STREAMING_TEXTURE_LAYER_COUNT;

export type FrameRendererState = "active" | "lost" | "error" | "disposed";

export interface FrameTextureLayout {
  readonly geometry: Readonly<AvcRenditionGeometry>;
  readonly logicalWidth: number;
  readonly logicalHeight: number;
  readonly residentLayerCount: number;
}

/** @deprecated Use FrameTextureLayout with explicit rendition geometry. */
export interface LegacyOpaqueFrameTextureLayout {
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

export interface FrameRendererBackendLimits {
  readonly maxTextureSize: number;
  readonly maxArrayTextureLayers: number;
}

export type FrameTextureKind = "resident" | "stream";

export interface FrameSourceLayout {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Small injectable boundary used for deterministic ownership tests. */
export interface FrameRendererBackend {
  readonly limits: Readonly<FrameRendererBackendLimits>;
  allocate(layout: FrameTextureLayout, streamingSlots: number): void;
  upload(kind: FrameTextureKind, index: number, pixels: Uint8Array): void;
  /** Optional native-source path for browsers without VideoFrame RGBA copy. */
  uploadFrame?(
    kind: FrameTextureKind,
    index: number,
    frame: CopyableVideoFrame,
    layout: Readonly<FrameSourceLayout>
  ): void;
  draw(kind: FrameTextureKind, index: number): void;
  readPixels?(): Uint8Array;
  dispose(): void;
}

/** @deprecated Compatibility boundary for the pre-geometry opaque renderer. */
export interface LegacyOpaqueFrameRendererBackend {
  readonly limits: Readonly<FrameRendererBackendLimits>;
  allocate(layout: LegacyOpaqueFrameTextureLayout, streamingSlots: number): void;
  upload(kind: FrameTextureKind, index: number, pixels: Uint8Array): void;
  uploadFrame?(
    kind: FrameTextureKind,
    index: number,
    frame: CopyableVideoFrame,
    layout: Readonly<FrameSourceLayout>
  ): void;
  draw(kind: FrameTextureKind, index: number): void;
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

export interface FrameRendererSnapshot {
  readonly state: FrameRendererState;
  readonly resourceGeneration: number;
  readonly stagingBytes: number;
  readonly sourceCopiesInFlight: number;
  readonly codedTextureBytesPerLayer: number;
  readonly allocatedTextureBytes: number;
  readonly allocatedTextureLayers: number;
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

export interface FrameRendererOptions {
  readonly streamingSlots?: number;
  /** M2 compatibility only; M5.5 production contexts terminalize on loss. */
  readonly contextLossPolicy?: "terminal" | "restorable";
  /** Bounds a browser copy that never resolves, including live uploads. */
  readonly copyTimeoutMs?: number;
  readonly timers?: Readonly<FrameRendererTimerHost>;
}

export interface FrameRendererTimerHost {
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
}

const DEFAULT_COPY_TIMEOUT_MS = 5_000;
const DEFAULT_RENDERER_TIMERS: Readonly<FrameRendererTimerHost> =
  Object.freeze({
    setTimeout: (callback: () => void, milliseconds: number): unknown =>
      globalThis.setTimeout(callback, milliseconds),
    clearTimeout: (handle: unknown): void =>
      globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>)
  });

// Legacy WebCodecs experiments accepted implementation-selected coded padding
// around an exact visible rectangle. A private WeakSet keeps that policy
// available only to the deprecated adapter; format-backed AVC always uses the
// strict geometry branch below.
const LEGACY_VISIBLE_FRAME_OPTIONS = new WeakSet<object>();

/**
 * Serializes native frame uploads and owns one bounded RGBA staging fallback.
 * Source frames are always closed exactly once after ownership is transferred.
 */
export class FrameRenderer {
  readonly #layout: Readonly<FrameTextureLayout>;
  readonly #streamingSlots: number;
  readonly #contextLossPolicy: "terminal" | "restorable";
  readonly #copyTimeoutMs: number;
  readonly #timers: Readonly<FrameRendererTimerHost>;
  readonly #codedTextureBytesPerLayer: number;
  readonly #allocatedTextureBytes: number;
  readonly #legacyVisibleFrameGeometry: boolean;
  #staging: Uint8Array;
  readonly #claimedSources = new WeakSet<object>();
  readonly #uploadedResidentLayers = new Set<number>();
  readonly #streamingSlotVersions = new Map<
    number,
    { readonly pathGeneration: number; readonly uploadSerial: number }
  >();

  #backend: FrameRendererBackend | null;
  #uploadAbort = new AbortController();
  #state: FrameRendererState = "active";
  #resourceGeneration = 1;
  #uploadTail: Promise<void> = Promise.resolve();
  #residentUploads = 0;
  #streamingUploads = 0;
  #nextStreamingUploadSerial = 1;
  #sourceCopiesInFlight = 0;
  #draws = 0;
  #closedSourceFrames = 0;
  #staleUploads = 0;
  #errors = 0;

  public constructor(
    backend: FrameRendererBackend,
    layout: FrameTextureLayout,
    options: FrameRendererOptions = {}
  ) {
    this.#legacyVisibleFrameGeometry = LEGACY_VISIBLE_FRAME_OPTIONS.has(options);
    this.#layout = this.#legacyVisibleFrameGeometry
      ? freezeLegacyFrameLayout(layout)
      : freezeFrameLayout(layout);
    this.#streamingSlots = validateFrameStreamingSlots(
      options.streamingSlots ?? FRAME_STREAMING_SLOT_COUNT
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
    validateFrameBackendLimits(backend, this.#layout);
    try {
      this.#codedTextureBytesPerLayer =
        this.#layout.geometry.codedRgbaBytes;
      this.#allocatedTextureBytes = checkedFrameTextureBytes(
        this.#codedTextureBytesPerLayer,
        this.#layout.residentLayerCount + this.#streamingSlots
      );
      this.#staging = new Uint8Array(this.#codedTextureBytesPerLayer);
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

  public get limits(): Readonly<FrameRendererBackendLimits> {
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
    validateFrameIndex(layer, this.#layout.residentLayerCount, "resident layer");
    return this.#queueUpload(
      source,
      resourceGeneration,
      Object.freeze({ kind: "resident", index: layer }),
      () => {
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
    validateFrameIndex(slot, this.#streamingSlots, "streaming slot");
    validateFrameGeneration(pathGeneration, "path generation");
    return this.#queueUpload(
      source,
      resourceGeneration,
      Object.freeze({ kind: "stream", index: slot }),
      () => {
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
    validateFrameIndex(layer, this.#layout.residentLayerCount, "resident layer");
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

    let kind: FrameTextureKind;
    let index: number;
    if (handle.kind === "resident") {
      validateFrameIndex(
        handle.layer,
        this.#layout.residentLayerCount,
        "resident layer"
      );
      if (!this.#uploadedResidentLayers.has(handle.layer)) {
        throw new RendererFrameUnavailableError(
          `resident layer ${String(handle.layer)} has not been uploaded`
        );
      }
      kind = "resident";
      index = handle.layer;
    } else {
      validateFrameIndex(handle.slot, this.#streamingSlots, "streaming slot");
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
      kind = "stream";
      index = handle.slot;
    }

    try {
      this.#requireActiveBackend().draw(kind, index);
      this.#assertActive();
      if (handle.resourceGeneration !== this.#resourceGeneration) {
        throw new RendererFrameUnavailableError(
          "renderer changed during frame draw"
        );
      }
    } catch (error) {
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
      const pixels = readPixels.call(this.#backend);
      this.#assertActive();
      return pixels;
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
  public restore(backend: FrameRendererBackend): void {
    if (this.#contextLossPolicy !== "restorable") {
      safeDisposeBackend(backend);
      throw new RendererUnavailableError("context loss is terminal");
    }
    if (this.#state === "disposed") {
      safeDisposeBackend(backend);
      throw new RendererDisposedError();
    }
    if (this.#state !== "lost" && this.#state !== "error") {
      safeDisposeBackend(backend);
      throw new Error(`cannot restore a renderer in state ${this.#state}`);
    }
    if (this.#sourceCopiesInFlight !== 0) {
      safeDisposeBackend(backend);
      throw new RendererUnavailableError(
        "a decoded frame copy is still settling"
      );
    }
    const expectedState = this.#state;
    const expectedGeneration = this.#resourceGeneration;
    try {
      validateFrameBackendLimits(backend, this.#layout);
      this.#assertRestoreUnchanged(expectedState, expectedGeneration);
      backend.allocate(this.#layout, this.#streamingSlots);
      this.#assertRestoreUnchanged(expectedState, expectedGeneration);
    } catch (error) {
      safeDisposeBackend(backend);
      if (
        this.#state !== expectedState ||
        this.#resourceGeneration !== expectedGeneration
      ) {
        throw this.#restoreStateChangedError();
      }
      this.#state = "error";
      this.#errors += 1;
      throw normalizeError(error, "failed to restore WebGL frame textures");
    }
    this.#staging.fill(0);
    this.#backend = backend;
    this.#uploadAbort = new AbortController();
    this.#state = "active";
    this.#uploadedResidentLayers.clear();
    this.#streamingSlotVersions.clear();
  }

  public snapshot(): FrameRendererSnapshot {
    const allocatedLayerCount =
      this.#layout.residentLayerCount + this.#streamingSlots;
    return Object.freeze({
      state: this.#state,
      resourceGeneration: this.#resourceGeneration,
      stagingBytes: this.#staging.byteLength,
      sourceCopiesInFlight: this.#sourceCopiesInFlight,
      codedTextureBytesPerLayer: this.#codedTextureBytesPerLayer,
      allocatedTextureBytes: this.#state === "active"
        ? this.#allocatedTextureBytes
        : 0,
      allocatedTextureLayers:
        this.#state === "active" ? allocatedLayerCount : 0,
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
    this.#staging = new Uint8Array(0);
    const backend = this.#backend;
    this.#backend = null;
    if (backend !== null) {
      safeDisposeBackend(backend);
    }
  }

  #queueUpload<T extends RenderFrameHandle>(
    source: BorrowedVideoFrame,
    resourceGeneration: number,
    destination: Readonly<{
      readonly kind: FrameTextureKind;
      readonly index: number;
    }>,
    commit: () => T
  ): Promise<T | null> {
    validateFrameGeneration(resourceGeneration, "resource generation");
    validateFrameObject(source, "borrowed video frame");
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
        const copyLayout = validateFrameGeometry(
          source.frame,
          this.#layout,
          this.#legacyVisibleFrameGeometry
        );
        const backend = this.#requireActiveBackend();
        let uploaded = false;
        if (backend.uploadFrame !== undefined) {
          try {
            backend.uploadFrame(
              destination.kind,
              destination.index,
              source.frame,
              copyLayout.source
            );
            uploaded = true;
          } catch {
            if (
              this.#state !== "active" ||
              resourceGeneration !== this.#resourceGeneration
            ) {
              throw new RendererUploadAbortedError(
                "renderer changed during native frame upload"
              );
            }
            // Some engines expose the WebGL overload but reject a native
            // VideoFrame at runtime. The bounded RGBA copy remains the fallback.
          }
        }
        if (!uploaded) {
          const staging = this.#staging;
          staging.fill(0);
          const copy = this.#trackSourceCopy(source.frame.copyTo(staging, {
            rect: copyLayout.rect,
            format: "RGBA",
            layout: [
              {
                offset: copyLayout.offset,
                stride: copyLayout.stride
              }
            ]
          }));
          const copiedPlanes = await awaitRendererCopy(
            copy,
            this.#uploadAbort.signal,
            this.#copyTimeoutMs,
            this.#timers
          );
          validateCopiedPlaneLayout(copiedPlanes, copyLayout);
          this.#assertUploadCurrent(resourceGeneration);
          backend.upload(destination.kind, destination.index, staging);
        }
        this.#assertUploadCurrent(resourceGeneration);
        if (
          this.#state !== "active" ||
          resourceGeneration !== this.#resourceGeneration
        ) {
          this.#staleUploads += 1;
          return;
        }
        result = commit();
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
          this.#closedSourceFrames += 1;
          if (
            result !== null &&
            (
              this.#state !== "active" ||
              resourceGeneration !== this.#resourceGeneration
            )
          ) {
            result = null;
            this.#staleUploads += 1;
          }
        } catch (error) {
          throw this.#terminalizeError(
            error,
            "failed to close a decoded video frame"
          );
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

  #requireActiveBackend(): FrameRendererBackend {
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
      this.#abortUploads(new RendererUploadAbortedError("renderer failed"));
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

  #trackSourceCopy(
    copy: Promise<readonly PlaneLayout[]>
  ): Promise<readonly PlaneLayout[]> {
    this.#sourceCopiesInFlight += 1;
    void copy.then(
      () => {
        this.#sourceCopiesInFlight -= 1;
      },
      () => {
        this.#sourceCopiesInFlight -= 1;
      }
    );
    return copy;
  }

  #assertUploadCurrent(resourceGeneration: number): void {
    if (
      this.#state !== "active" ||
      resourceGeneration !== this.#resourceGeneration
    ) {
      throw new RendererUploadAbortedError(
        "renderer changed during frame upload"
      );
    }
  }

  #assertRestoreUnchanged(
    expectedState: "lost" | "error",
    expectedGeneration: number
  ): void {
    if (
      this.#state !== expectedState ||
      this.#resourceGeneration !== expectedGeneration
    ) {
      throw new RendererUnavailableError(
        "renderer state changed during context restoration"
      );
    }
  }

  #restoreStateChangedError(): Error {
    return this.#state === "disposed"
      ? new RendererDisposedError()
      : new RendererUnavailableError(
          "renderer state changed during context restoration"
        );
  }
}

/**
 * @deprecated Use FrameRenderer and pass an AvcRenditionGeometry explicitly.
 * This class only adapts the old opaque constructor to the same renderer core.
 */
export class LegacyOpaqueFrameRenderer extends FrameRenderer {
  public constructor(
    backend: LegacyOpaqueFrameRendererBackend,
    layout: LegacyOpaqueFrameTextureLayout,
    options: FrameRendererOptions = {}
  ) {
    super(
      adaptLegacyOpaqueBackend(backend),
      createLegacyOpaqueFrameLayout(layout),
      createLegacyVisibleFrameOptions(options)
    );
  }

  public override restore(
    backend: FrameRendererBackend | LegacyOpaqueFrameRendererBackend
  ): void {
    super.restore(adaptLegacyOpaqueBackend(backend));
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

/** Marks renderer-authored validation failures safe for public diagnostics. */
class FrameRendererValidationError extends RangeError {}

function validateFrameGeometry(
  frame: CopyableVideoFrame,
  layout: Readonly<FrameTextureLayout>,
  legacyVisibleFrameGeometry: boolean
): Readonly<FrameCopyLayout> {
  const geometry = layout.geometry;
  const [x, y, width, height] = geometry.decodedStorageRect;
  const visible = frame.visibleRect;
  if (legacyVisibleFrameGeometry) {
    const maximumCodedWidth = Math.ceil(width / 16) * 16 + 16;
    const maximumCodedHeight = Math.ceil(height / 16) * 16 + 16;
    if (
      visible === null ||
      frame.displayWidth !== width ||
      frame.displayHeight !== height ||
      visible.width !== width ||
      visible.height !== height ||
      visible.x < 0 ||
      visible.y < 0 ||
      frame.codedWidth < visible.x + visible.width ||
      frame.codedHeight < visible.y + visible.height ||
      frame.codedWidth > maximumCodedWidth ||
      frame.codedHeight > maximumCodedHeight
    ) {
      throw new FrameRendererValidationError(
        "decoded frame geometry does not match texture layout"
      );
    }
    return Object.freeze({
      rect: visible,
      offset: 0,
      stride: width * 4,
      source: Object.freeze({ x: 0, y: 0, width, height })
    });
  }
  if (
    visible === null ||
    frame.displayWidth !== width ||
    frame.displayHeight !== height ||
    visible.x !== x ||
    visible.y !== y ||
    visible.width !== width ||
    visible.height !== height ||
    frame.codedWidth < visible.x + visible.width ||
    frame.codedHeight < visible.y + visible.height ||
    frame.codedWidth > maximumAvcDecoderSurfaceDimension(geometry.codedWidth) ||
    frame.codedHeight > maximumAvcDecoderSurfaceDimension(geometry.codedHeight)
  ) {
    throw new FrameRendererValidationError(
      "decoded frame geometry does not match texture layout"
    );
  }
  return Object.freeze({
    rect: visible,
    offset: (y * geometry.codedWidth + x) * 4,
    stride: geometry.codedWidth * 4,
    source: Object.freeze({ x, y, width, height })
  });
}

function createLegacyVisibleFrameOptions(
  options: Readonly<FrameRendererOptions>
): Readonly<FrameRendererOptions> {
  const compatible = Object.freeze({ ...options });
  LEGACY_VISIBLE_FRAME_OPTIONS.add(compatible);
  return compatible;
}

interface FrameCopyLayout {
  readonly rect: DOMRectReadOnly;
  readonly offset: number;
  readonly stride: number;
  readonly source: Readonly<FrameSourceLayout>;
}

function validateCopiedPlaneLayout(
  planes: readonly PlaneLayout[],
  expected: Readonly<FrameCopyLayout>
): void {
  const plane = planes[0];
  if (
    planes.length !== 1 ||
    plane === undefined ||
    plane.offset !== expected.offset ||
    plane.stride !== expected.stride
  ) {
    throw new FrameRendererValidationError(
      "decoded frame copy layout does not match staging"
    );
  }
}

function safeDisposeBackend(backend: FrameRendererBackend): void {
  try {
    backend.dispose();
  } catch {
    // Cleanup remains best-effort after a terminal renderer failure.
  }
}

function normalizeError(_error: unknown, context: string): Error {
  if (
    _error instanceof FrameRendererValidationError ||
    _error instanceof RendererDisposedError ||
    _error instanceof RendererUnavailableError ||
    _error instanceof RendererUploadTimeoutError ||
    _error instanceof RendererUploadAbortedError
  ) {
    return _error;
  }
  // WebGL/WebCodecs exception text can contain driver data and is unstable.
  return new Error(context);
}

function awaitRendererCopy(
  copy: Promise<readonly PlaneLayout[]>,
  signal: AbortSignal,
  timeoutMs: number,
  timers: Readonly<FrameRendererTimerHost>
): Promise<readonly PlaneLayout[]> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<readonly PlaneLayout[]>((resolve, reject) => {
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
      (planes) => finish(() => resolve(planes)),
      (error: unknown) => finish(() => reject(error))
    );
  });
}

function adaptLegacyOpaqueBackend(
  backend: LegacyOpaqueFrameRendererBackend | FrameRendererBackend
): FrameRendererBackend {
  const allocate = (
    layout: FrameTextureLayout,
    streamingSlots: number
  ): void => {
    const legacy = { ...toLegacyOpaqueFrameLayout(layout) };
    Object.defineProperty(legacy, "geometry", {
      configurable: false,
      enumerable: false,
      value: layout.geometry,
      writable: false
    });
    Object.freeze(legacy);
    backend.allocate(
      legacy as LegacyOpaqueFrameTextureLayout & FrameTextureLayout,
      streamingSlots
    );
  };
  const base: FrameRendererBackend = {
    limits: backend.limits,
    allocate,
    upload: (kind, index, pixels) => backend.upload(kind, index, pixels),
    ...(backend.uploadFrame === undefined
      ? {}
      : {
          uploadFrame: (kind, index, frame, layout) =>
            backend.uploadFrame!(kind, index, frame, layout)
        }),
    draw: (kind, index) => backend.draw(kind, index),
    dispose: () => backend.dispose()
  };
  return backend.readPixels === undefined
    ? base
    : {
        ...base,
        readPixels: () => backend.readPixels!()
      };
}
