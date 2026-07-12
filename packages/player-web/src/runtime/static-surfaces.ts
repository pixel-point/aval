import type { CompiledManifestV01 } from "@rendered-motion/format";

import type { RuntimeAssetCatalog } from "./asset-catalog.js";
import {
  checkedByteNumber,
  checkedByteProduct,
  checkedRgbaBytes,
  validatePositiveSafeInteger
} from "./checked-runtime-bytes.js";
import {
  captureLeasedStaticPngDecoder,
  type LeasedStaticPngDecode
} from "./leased-static-png-decoder.js";
import {
  StaticSurfaceStoreDisposedError,
  StaticSurfaceUnavailableError
} from "./static-surface-errors.js";
import {
  StaticSurfaceCache,
  type StaticSurfaceCacheSnapshot,
  type StaticSurfaceEviction
} from "./static-surface-cache.js";
import {
  awaitSurfaceResourceReservation,
  captureSurfaceResourceLease,
  normalizeStaticSurfaceStoreOptions,
  safelySetSurfaceRole,
  type CapturedSurfaceResourceLease,
  type StaticSurfaceStoreOptions,
  type StaticSurfaceStoreResourceHost,
  type StaticSurfaceStoreResourceLease,
  type StaticSurfaceStoreSurfaceRole
} from "./static-surface-store-resources.js";
import { cloneStaticDecodeSnapshot } from "./static-surface-snapshot.js";

export type {
  StaticSurfaceStoreOptions,
  StaticSurfaceStoreResourceHost,
  StaticSurfaceStoreResourceLease,
  StaticSurfaceStoreSurfaceRole
} from "./static-surface-store-resources.js";

export { BrowserStaticCanvasPlane } from "./browser-static-canvas-plane.js";
export {
  StaticSurfaceStoreDisposedError,
  StaticSurfaceUnavailableError
} from "./static-surface-errors.js";

export {
  BrowserStaticSurfaceDecoder,
  StaticSurfaceDecodeTimeoutError
} from "./strict-static-decoder.js";
export type {
  BrowserDecodedStaticSurface,
  BrowserStaticDecoderResourceCategory,
  BrowserStaticDecoderResourceHost,
  BrowserStaticDecoderResourceLease,
  BrowserStaticSurfaceDecoderOptions,
  BrowserStaticSurfaceDecoderSnapshot,
  BrowserStaticSurfaceTimerHost,
  StaticPngInflatePath
} from "./strict-static-decoder.js";

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
  readonly expectedWidth: number;
  readonly expectedHeight: number;
}

export interface StaticSurfaceDecoder<
  TSurface extends DecodedStaticSurface = DecodedStaticSurface
> {
  decode(
    png: Uint8Array,
    options: StaticSurfaceDecodeOptions
  ): Promise<TSurface>;
  snapshot?(): Readonly<StaticSurfaceDecodeSnapshot>;
}

export interface StaticSurfaceDecodeSnapshot {
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

/** The host owns layering; present() must draw and cover atomically. */
export interface StaticPresentationPlane<
  TSurface extends DecodedStaticSurface = DecodedStaticSurface
> {
  present(
    surface: TSurface,
    width: number,
    height: number,
    options?: { readonly cover?: boolean }
  ): void;
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
  readonly redecodedSurfaces: number;
  readonly closedSurfaces: number;
  readonly leaseReservations: number;
  readonly leaseReleases: number;
  readonly presentations: number;
  readonly errors: number;
  readonly cache: Readonly<StaticSurfaceCacheSnapshot>;
  readonly decode: Readonly<StaticSurfaceDecodeSnapshot> | null;
}

interface ManagedStaticSurface<TSurface extends DecodedStaticSurface> {
  readonly surface: TSurface;
  readonly lease: CapturedSurfaceResourceLease;
  close(): void;
}

interface RetainedSurface<TSurface extends DecodedStaticSurface> {
  readonly staticFrame: string;
  readonly managed: ManagedStaticSurface<TSurface>;
}

export class StaticSurfaceStore<
  TSurface extends DecodedStaticSurface = DecodedStaticSurface
> {
  readonly #catalog: StaticSurfaceCatalogView;
  readonly #decoder: StaticSurfaceDecoder<TSurface>;
  readonly #decodeLeasedPng: LeasedStaticPngDecode<TSurface> | null;
  readonly #plane: StaticPresentationPlane<TSurface>;
  readonly #width: number;
  readonly #height: number;
  readonly #surfaceBytes: number;
  readonly #allValidatedBytes: number;
  readonly #staticByState: ReadonlyMap<string, string>;
  readonly #pngBytesByStaticFrame: ReadonlyMap<string, number>;
  readonly #referencedStaticIds: readonly string[];
  readonly #validated = new Set<string>();
  readonly #ownedSurfaces = new WeakSet<object>();
  readonly #closedSurfaces = new WeakSet<object>();
  readonly #surfaceClosers = new WeakMap<object, () => unknown>();
  readonly #controllers = new Set<AbortController>();
  readonly #cache: StaticSurfaceCache<ManagedStaticSurface<TSurface>>;
  readonly #resourceHost: Readonly<StaticSurfaceStoreResourceHost>;
  readonly #retainOptionalSurfaces: boolean;

  #current: RetainedSurface<TSurface> | null = null;
  #incoming: RetainedSurface<TSurface> | null = null;
  #currentState: string | null = null;
  #tail: Promise<void> = Promise.resolve();
  #activePresentController: AbortController | null = null;
  #latestPresentation = 0;
  #disposed = false;
  #decodedSurfaceCount = 0;
  #redecodedSurfaceCount = 0;
  #closedSurfaceCount = 0;
  #leaseReservationCount = 0;
  #leaseReleaseCount = 0;
  #localTouchSequence = 0;
  #presentationCount = 0;
  #errors = 0;

  public constructor(
    catalog: StaticSurfaceCatalogView,
    decoder: StaticSurfaceDecoder<TSurface>,
    plane: StaticPresentationPlane<TSurface>,
    options: Readonly<StaticSurfaceStoreOptions> = {}
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
    const pngBytesByStaticFrame = new Map<string, number>();
    for (const frame of manifest.staticFrames) {
      validatePositiveSafeInteger(frame.length, "static PNG byte length");
      if (pngBytesByStaticFrame.has(frame.id)) {
        throw new TypeError("static PNG descriptor is duplicated");
      }
      pngBytesByStaticFrame.set(frame.id, frame.length);
    }
    this.#pngBytesByStaticFrame = pngBytesByStaticFrame;
    this.#referencedStaticIds = Object.freeze(
      [...new Set(manifest.states.map(({ staticFrame }) => staticFrame))].sort()
    );
    this.#allValidatedBytes = checkedStaticByteCount(
      this.#referencedStaticIds.length,
      this.#surfaceBytes,
      "validated static bytes"
    );
    this.#catalog = catalog;
    this.#decoder = decoder;
    this.#decodeLeasedPng = captureLeasedStaticPngDecoder(decoder);
    this.#plane = plane;
    const normalizedOptions = normalizeStaticSurfaceStoreOptions(options);
    this.#retainOptionalSurfaces = normalizedOptions.retainOptionalSurfaces;
    this.#resourceHost = normalizedOptions.resourceHost ??
      this.#createLocalResourceHost();
    this.#cache = new StaticSurfaceCache<ManagedStaticSurface<TSurface>>();
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
    options: {
      readonly signal?: AbortSignal;
      readonly cover?: boolean;
    } = {}
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
      async () => this.#present(
        state,
        staticFrame,
        generation,
        controller.signal,
        options.cover !== false
      )
    );
    void operation.finally(() => {
      if (this.#activePresentController === controller) {
        this.#activePresentController = null;
      }
    }).catch(() => undefined);
    return operation;
  }

  /** Sequentially validates every unique referenced static. */
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
        const decoded = await this.#getOrDecode(staticFrame, controller.signal);
        this.#setIncoming(staticFrame, decoded.managed);
        try {
          const nextNewlyValidated = checkedCounterIncrement(
            newlyValidated,
            "newly validated static surfaces"
          );
          this.#validated.add(staticFrame);
          newlyValidated = nextNewlyValidated;
        } finally {
          this.#releaseIncoming(decoded.managed);
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

  public currentState(): string | null {
    return this.#currentState;
  }

  /** Page reclamation seam: hard-pinned current/incoming entries are skipped. */
  public reclaimOldest(): Readonly<StaticSurfaceEviction> | null {
    this.#assertActive();
    return this.#cache.evictOldest();
  }

  public snapshot(): Readonly<StaticSurfaceStoreSnapshot> {
    const cache = this.#cache.snapshot();
    return Object.freeze({
      state: this.#disposed ? "disposed" : "active",
      currentState: this.#currentState,
      currentStaticFrame: this.#current?.staticFrame ?? null,
      incomingStaticFrame: this.#incoming?.staticFrame ?? null,
      retainedSurfaces: cache.retainedSurfaces,
      peakRetainedSurfaces: cache.peakRetainedSurfaces,
      retainedRgbaBytes: cache.retainedBytes,
      peakRetainedRgbaBytes: cache.peakRetainedBytes,
      validatedStaticFrames: this.#validated.size,
      validatedRgbaBytes: this.#validated.size === this.#referencedStaticIds.length
        ? this.#allValidatedBytes
        : checkedStaticByteCount(
            this.#validated.size,
            this.#surfaceBytes,
            "validated static bytes"
          ),
      decodedSurfaces: this.#decodedSurfaceCount,
      redecodedSurfaces: this.#redecodedSurfaceCount,
      closedSurfaces: this.#closedSurfaceCount,
      leaseReservations: this.#leaseReservationCount,
      leaseReleases: this.#leaseReleaseCount,
      presentations: this.#presentationCount,
      errors: this.#errors,
      cache,
      decode: cloneStaticDecodeSnapshot(this.#decoder.snapshot?.())
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
    this.#incoming = null;
    this.#current = null;
    this.#currentState = null;
    this.#cache.dispose();
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
    signal: AbortSignal,
    cover: boolean
  ): Promise<Readonly<StaticSurfacePresentationReport>> {
    throwIfAborted(signal);
    this.#assertActive();
    this.#assertLatest(generation);
    if (this.#current?.staticFrame === staticFrame) {
      this.#cache.get(staticFrame, this.#nextTouchSequence());
      const presentationCount = checkedCounterIncrement(
        this.#presentationCount,
        "static surface presentations"
      );
      if (cover) {
        this.#plane.coverStatic();
        throwIfAborted(signal);
        this.#assertActive();
        this.#assertLatest(generation);
      }
      this.#currentState = state;
      this.#presentationCount = presentationCount;
      return Object.freeze({
        state,
        staticFrame,
        redecoded: false,
        rgbaBytes: this.#surfaceBytes
      });
    }

    const decoded = await this.#getOrDecode(staticFrame, signal);
    const managed = decoded.managed;
    this.#setIncoming(staticFrame, managed);
    try {
      throwIfAborted(signal);
      this.#assertActive();
      this.#assertLatest(generation);
      const presentationCount = checkedCounterIncrement(
        this.#presentationCount,
        "static surface presentations"
      );
      try {
        this.#plane.present(
          managed.surface,
          this.#width,
          this.#height,
          Object.freeze({ cover })
        );
      } catch (error) {
        if (error instanceof StaticSurfaceStoreDisposedError) this.dispose();
        throw error;
      }
      const previous = this.#current;
      try {
        throwIfAborted(signal);
        this.#assertActive();
        this.#assertLatest(generation);
      } catch (error) {
        // Disposal already closed and detached both retained slots. A hostile
        // plane that returns after reentering disposal must not let this outer
        // presentation resurrect terminal accounting as a provisional first
        // surface.
        if (this.#disposed) throw error;
        if (previous === null) {
          // The first successful draw is the only coherent rollback surface.
          // Retain it provisionally while the already-queued newest request
          // replaces it, so the plane never points at a closed image.
          try {
            this.#commitIncoming(
              state,
              staticFrame,
              presentationCount,
              previous
            );
          } catch {
            this.#retainProvisional(
              state,
              staticFrame,
              presentationCount
            );
          }
        } else {
          this.#restoreAfterStalePresentation(previous, cover);
        }
        throw error;
      }
      try {
        this.#commitIncoming(
          state,
          staticFrame,
          presentationCount,
          previous
        );
      } catch (error) {
        if (previous === null) {
          this.#retainProvisional(state, staticFrame, presentationCount);
        } else {
          this.#restoreAfterStalePresentation(previous, cover);
        }
        throw error;
      }
      return Object.freeze({
        state,
        staticFrame,
        redecoded: decoded.decoded,
        rgbaBytes: this.#surfaceBytes
      });
    } finally {
      this.#releaseIncoming(managed);
    }
  }

  async #getOrDecode(
    staticFrame: string,
    signal: AbortSignal
  ): Promise<Readonly<{
    managed: ManagedStaticSurface<TSurface>;
    decoded: boolean;
  }>> {
    const touchSequence = this.#nextTouchSequence();
    const cached = this.#cache.get(staticFrame, touchSequence);
    if (cached !== null) return Object.freeze({ managed: cached, decoded: false });
    return Object.freeze({
      managed: await this.#decode(staticFrame, signal, touchSequence),
      decoded: true
    });
  }

  async #decode(
    staticFrame: string,
    signal: AbortSignal,
    touchSequence: number
  ): Promise<ManagedStaticSurface<TSurface>> {
    throwIfAborted(signal);
    this.#assertActive();
    const wasValidated = this.#validated.has(staticFrame);
    const lease = await this.#reserveSurface(staticFrame, signal);
    const decodedSurfaceCount = checkedCounterIncrement(
      this.#decodedSurfaceCount,
      "decoded static surfaces"
    );
    let surface: TSurface | null = null;
    let ownsSurface = false;
    try {
      const decodeOptions = Object.freeze({
        signal,
        expectedWidth: this.#width,
        expectedHeight: this.#height
      });
      const byteLength = this.#pngBytesByStaticFrame.get(staticFrame);
      if (byteLength === undefined) {
        throw new StaticSurfaceUnavailableError(
          "static PNG descriptor is unavailable"
        );
      }
      const source = Object.freeze({
        byteLength,
        copy: () => this.#catalog.copyStaticPng(staticFrame)
      });
      const leasedDecode = this.#decodeLeasedPng?.(source, decodeOptions) ?? null;
      // Explicit compatibility path for custom decoders without the internal
      // reserve-before-copy capability.
      surface = await (leasedDecode ?? this.#decoder.decode(
        source.copy(),
        decodeOptions
      ));
    } catch (error) {
      lease.release();
      if (signal.aborted) throw abortReason(signal);
      throw error;
    }
    this.#decodedSurfaceCount = decodedSurfaceCount;
    if (surface === null || typeof surface !== "object") {
      lease.release();
      throw new StaticSurfaceUnavailableError("decoder returned no surface");
    }
    if (this.#ownedSurfaces.has(surface)) {
      lease.release();
      throw new StaticSurfaceUnavailableError("decoder reused a surface identity");
    }
    this.#ownedSurfaces.add(surface);
    ownsSurface = true;
    let width: unknown;
    let height: unknown;
    let close: unknown;
    try {
      // Capture the closer once before touching other hostile accessors so a
      // malformed surface can still be retired without re-reading its shape.
      close = Reflect.get(surface, "close");
      width = Reflect.get(surface, "width");
      height = Reflect.get(surface, "height");
    } catch {
      this.#closeUnknown(surface, close);
      lease.release();
      throw new StaticSurfaceUnavailableError(
        "decoded static surface is invalid"
      );
    }
    if (typeof close === "function") {
      this.#surfaceClosers.set(
        surface,
        () => Reflect.apply(close as (...args: never[]) => unknown, surface, [])
      );
    }
    if (
      width !== this.#width ||
      height !== this.#height ||
      typeof close !== "function"
    ) {
      this.#closeUnknown(surface, close);
      lease.release();
      throw new StaticSurfaceUnavailableError(
        "decoded static surface dimensions do not match the logical canvas"
      );
    }
    if (signal.aborted || this.#disposed) {
      this.#close(surface);
      lease.release();
      throw signal.aborted ? abortReason(signal) : disposedError();
    }
    const managed: ManagedStaticSurface<TSurface> = Object.freeze({
      surface,
      lease,
      close: (): void => this.#close(surface)
    });
    try {
      this.#cache.install(
        staticFrame,
        managed,
        this.#surfaceBytes,
        lease,
        touchSequence
      );
    } catch (error) {
      if (ownsSurface) this.#close(surface);
      lease.release();
      throw error;
    }
    if (wasValidated) {
      this.#redecodedSurfaceCount = checkedCounterIncrement(
        this.#redecodedSurfaceCount,
        "redecoded static surfaces"
      );
    }
    return managed;
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
      try {
        unlink();
      } catch {
        // Local operation ownership is terminal even when a hostile caller
        // refuses listener removal.
      } finally {
        this.#controllers.delete(controller);
      }
    }).catch(() => undefined);
    return result;
  }

  #assertLatest(generation: number): void {
    if (generation !== this.#latestPresentation) throw supersededError();
  }

  #setIncoming(
    staticFrame: string,
    managed: ManagedStaticSurface<TSurface>
  ): void {
    managed.lease.setRole("incoming");
    try {
      this.#cache.pinIncoming(staticFrame);
      this.#incoming = { staticFrame, managed };
    } catch (error) {
      safelySetSurfaceRole(managed.lease, "optional");
      throw error;
    }
  }

  #releaseIncoming(managed: ManagedStaticSurface<TSurface>): void {
    if (this.#incoming?.managed !== managed) return;
    const staticFrame = this.#incoming.staticFrame;
    this.#incoming = null;
    if (!this.#disposed) {
      this.#cache.pinIncoming(null);
      safelySetSurfaceRole(managed.lease, "optional");
      if (!this.#retainOptionalSurfaces) this.#cache.remove(staticFrame);
    }
  }

  #commitIncoming(
    state: string,
    staticFrame: string,
    presentationCount: number,
    previous: RetainedSurface<TSurface> | null
  ): void {
    const incoming = this.#incoming;
    if (incoming === null || incoming.staticFrame !== staticFrame) {
      throw new StaticSurfaceUnavailableError(
        "incoming static surface disappeared before commit"
      );
    }
    incoming.managed.lease.setRole("current");
    try {
      previous?.managed.lease.setRole("optional");
    } catch (error) {
      safelySetSurfaceRole(incoming.managed.lease, "incoming");
      throw error;
    }
    this.#cache.pinCurrent(staticFrame);
    this.#cache.pinIncoming(null);
    this.#current = incoming;
    this.#incoming = null;
    this.#currentState = state;
    this.#validated.add(staticFrame);
    this.#presentationCount = presentationCount;
    if (previous !== null && !this.#retainOptionalSurfaces) {
      this.#cache.remove(previous.staticFrame);
    }
  }

  #retainProvisional(
    state: string,
    staticFrame: string,
    presentationCount: number
  ): void {
    const incoming = this.#incoming;
    if (incoming === null || incoming.staticFrame !== staticFrame) return;
    safelySetSurfaceRole(incoming.managed.lease, "current");
    this.#cache.pinCurrent(staticFrame);
    this.#cache.pinIncoming(null);
    this.#current = incoming;
    this.#incoming = null;
    this.#currentState = state;
    this.#validated.add(staticFrame);
    this.#presentationCount = presentationCount;
  }

  async #reserveSurface(
    staticFrame: string,
    signal: AbortSignal
  ): Promise<CapturedSurfaceResourceLease> {
    const nextReservations = checkedCounterIncrement(
      this.#leaseReservationCount,
      "static surface lease reservations"
    );
    const pendingLease = this.#resourceHost.reserveDecodedSurface(Object.freeze({
      staticFrame,
      byteLength: this.#surfaceBytes,
      role: "incoming" as const
    }));
    const rawLease = await awaitSurfaceResourceReservation(
      pendingLease,
      signal
    );
    const lease = captureSurfaceResourceLease(rawLease, () => {
      this.#leaseReleaseCount = checkedCounterIncrement(
        this.#leaseReleaseCount,
        "static surface lease releases"
      );
    });
    this.#leaseReservationCount = nextReservations;
    return lease;
  }

  #nextTouchSequence(): number {
    const value = this.#resourceHost.nextTouchSequence();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(
        "static surface touch sequence must be a non-negative safe integer"
      );
    }
    return value;
  }

  #createLocalResourceHost(): Readonly<StaticSurfaceStoreResourceHost> {
    return Object.freeze({
      reserveDecodedSurface: () => Object.freeze({
        setRole: (_role: StaticSurfaceStoreSurfaceRole): void => undefined,
        release: (): void => undefined
      }),
      nextTouchSequence: (): number => {
        this.#localTouchSequence = checkedCounterIncrement(
          this.#localTouchSequence,
          "local static surface touch sequence"
        );
        return this.#localTouchSequence;
      }
    });
  }

  #restoreAfterStalePresentation(
    previous: RetainedSurface<TSurface>,
    cover: boolean
  ): void {
    try {
      this.#plane.present(
        previous.managed.surface,
        this.#width,
        this.#height,
        Object.freeze({ cover })
      );
    } catch {
      this.dispose();
      throw new StaticSurfaceUnavailableError(
        "static presentation rollback failed"
      );
    }
  }

  #close(surface: TSurface): void {
    this.#closeUnknown(surface, this.#surfaceClosers.get(surface));
  }

  #closeUnknown(surface: object, capturedClose: unknown): void {
    if (this.#closedSurfaces.has(surface)) return;
    const closedSurfaceCount = checkedCounterIncrement(
      this.#closedSurfaceCount,
      "closed static surfaces"
    );
    this.#closedSurfaces.add(surface);
    this.#closedSurfaceCount = closedSurfaceCount;
    try {
      if (typeof capturedClose === "function") {
        Reflect.apply(
          capturedClose as (...args: never[]) => unknown,
          surface,
          []
        );
      }
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
  if (source.aborted) {
    abort();
    return () => undefined;
  }
  let linked = true;
  try {
    source.addEventListener("abort", abort, { once: true });
  } catch (error) {
    // A host can retain the listener and still throw from registration.
    // Roll that partial attachment back before exposing the failure.
    try { source.removeEventListener("abort", abort); } catch {}
    linked = false;
    throw error;
  }
  return () => {
    if (!linked) return;
    linked = false;
    source.removeEventListener("abort", abort);
  };
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
