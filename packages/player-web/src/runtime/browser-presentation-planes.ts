import type { CanvasV01 } from "@pixel-point/aval-format";

import {
  RendererUnavailableError,
  type CopyableVideoFrame,
  type FrameRendererBackend,
  type FrameSourceLayout
} from "./frame-renderer.js";
import type { FrameTextureKind, FrameTextureLayout } from "./frame-renderer.js";
import {
  BrowserFrameBackend,
  type BrowserFrameBackendOptions
} from "./frame-renderer-browser.js";
import {
  computePresentationGeometry,
  type PresentationFit,
  type PresentationGeometry
} from "./presentation-geometry.js";
import {
  capturePresentationPlaneOptions
} from "./browser-presentation-options.js";
import {
  assertResourceReservations,
  canvasBackingAllocationBytes,
  createPresentationResourceReservation,
  liveResourceTotal,
  safelyReleaseBackingResources,
  safelyRollbackBackingTransition,
  type BrowserCanvasBackingResourceHost,
  type BrowserCanvasBackingResourceTransition,
  type PresentationResourceReservation
} from "./browser-canvas-backing-resources.js";
import type {
  RuntimeCanvasBackingSize,
  RuntimeCanvasResourceHost,
  RuntimeCanvasResourceLease,
  RuntimeCanvasResourcePlan
} from "./canvas-resource-plan.js";
import {
  checkedByteNumber,
  checkedByteProduct
} from "./checked-runtime-bytes.js";
import type { BrowserContextRecoveryEventTarget } from "./browser-context-recovery.js";
import {
  OwnedCanvasContextEventTarget,
  createPrimedBackingResources,
  initialPresentationGeometry,
  isPromiseLike,
  replayPresentationOptions
} from "./browser-presentation-planes-support.js";

export interface PresentableFrameBackend extends FrameRendererBackend {
  setPresentationGeometry(
    geometry: Readonly<PresentationGeometry>
  ): boolean;
}

export type {
  BrowserCanvasBackingResourceHost,
  BrowserCanvasBackingResourceInput,
  BrowserCanvasBackingResourceTransition
} from "./browser-canvas-backing-resources.js";

export interface BrowserPresentationPlanesOptions {
  readonly animatedCanvas: HTMLCanvasElement;
  readonly canvas: Readonly<CanvasV01>;
  readonly maxBackingWidth?: number;
  readonly maxBackingHeight?: number;
  readonly maxBackingBytes: number;
  /** Exact host box/DPR used for the first backing allocation, when known. */
  readonly initialPresentation?: Readonly<BrowserPresentationResizeInput>;
  readonly onClamp?: (
    geometry: Readonly<PresentationGeometry>
  ) => void;
  readonly backingResources?: BrowserCanvasBackingResourceHost;
  readonly createBackend?: (
    canvas: HTMLCanvasElement,
    options?: Readonly<BrowserFrameBackendOptions>
  ) => PresentableFrameBackend;
}

export interface BrowserPresentationResizeInput {
  readonly cssWidth: number;
  readonly cssHeight: number;
  readonly devicePixelRatio: number;
  readonly fit?: PresentationFit;
  readonly maxBackingBytes?: number;
}

export interface BrowserPresentationPlanesSnapshot {
  readonly generation: number;
  readonly resizeCount: number;
  readonly equivalentResizeCount: number;
  readonly backendAttached: boolean;
  readonly contextListeners: number;
  readonly resourceReservations: number;
  readonly effectiveMaxBackingBytes: number;
  readonly liveResourceTotals: readonly number[];
  readonly geometry: Readonly<PresentationGeometry> | null;
}

/** Browser owner for the single animated presentation canvas. */
export class BrowserPresentationPlanes implements RuntimeCanvasResourceHost {
  readonly #animatedCanvas: HTMLCanvasElement;
  readonly #canvas: Readonly<CanvasV01>;
  readonly #maxBackingWidth: number;
  readonly #maxBackingHeight: number;
  readonly #maxBackingBytes: number;
  readonly #onClamp: BrowserPresentationPlanesOptions["onClamp"];
  readonly #backingResources: Readonly<BrowserCanvasBackingResourceHost> | null;
  readonly #asynchronousBackingGrowth: boolean;
  readonly #createBackend: NonNullable<
    BrowserPresentationPlanesOptions["createBackend"]
  >;

  #backend: PresentableFrameBackend | null = null;
  #contextTarget: OwnedCanvasContextEventTarget | null = null;
  readonly #resourceReservations = new Map<
    symbol,
    Readonly<PresentationResourceReservation>
  >();
  #geometry: Readonly<PresentationGeometry> | null = null;
  #generation = 0;
  #resizeCount = 0;
  #equivalentResizeCount = 0;
  #backendAdmissionActive = false;
  #backingAdmissionActive = false;
  #backingAdmissionCommitActive = false;
  #admittedBackingTransition: Readonly<{
    readonly allocationBytes: number;
    readonly transition: BrowserCanvasBackingResourceTransition;
  }> | null = null;
  #mutationActive = false;
  #disposed = false;

  public constructor(options: Readonly<BrowserPresentationPlanesOptions>) {
    const captured = capturePresentationPlaneOptions(options);
    if (captured.backingResources?.asynchronous === true) {
      throw new TypeError(
        "asynchronous canvas backing admission requires BrowserPresentationPlanes.create()"
      );
    }
    this.#animatedCanvas = captured.animatedCanvas;
    this.#canvas = captured.canvas;
    this.#maxBackingWidth = captured.maxBackingWidth;
    this.#maxBackingHeight = captured.maxBackingHeight;
    this.#maxBackingBytes = captured.maxBackingBytes;
    this.#onClamp = captured.onClamp;
    this.#backingResources = captured.backingResources;
    this.#asynchronousBackingGrowth =
      captured.backingResources?.asynchronousAfterInitial === true;
    this.#createBackend = captured.createBackend ??
      ((canvas, backendOptions) =>
        new BrowserFrameBackend(canvas, backendOptions));
    let initialTransition: BrowserCanvasBackingResourceTransition | null = null;
    let initial!: Readonly<PresentationGeometry>;
    try {
      initial = initialPresentationGeometry(captured);
      initialTransition = this.#beginBackingTransition(initial);
      initialTransition?.assertActive?.();
    } catch (error) {
      safelyRollbackBackingTransition(initialTransition);
      safelyReleaseBackingResources(captured.backingResources);
      throw error;
    }
    // Release the browser's implicit 300x150 stores before computing the first
    // owned allocation. No M6 backing exists before exact admission succeeds.
    try {
      captured.animatedCanvas.width = 0;
      captured.animatedCanvas.height = 0;
    } catch (error) {
      resetCanvasBacking(captured.animatedCanvas);
      safelyRollbackBackingTransition(initialTransition);
      safelyReleaseBackingResources(captured.backingResources);
      throw error;
    }
    try {
      captured.animatedCanvas.width = initial.backing.width;
      captured.animatedCanvas.height = initial.backing.height;
      assertExactCanvasBacking(
        captured.animatedCanvas,
        initial.backing,
        "animated presentation"
      );
      this.#geometry = initial;
      if (initial.clampReasons.length > 0) {
        try {
          this.#onClamp?.(initial);
        } catch {
          // Diagnostics cannot own initial presentation geometry.
        }
        // The observational host may still mutate either captured canvas
        // without throwing. Reassert the committed initial backing after it
        // returns.
        captured.animatedCanvas.width = initial.backing.width;
        captured.animatedCanvas.height = initial.backing.height;
      }
      initialTransition?.commit();
    } catch (error) {
      resetCanvasBacking(captured.animatedCanvas);
      safelyRollbackBackingTransition(initialTransition);
      safelyReleaseBackingResources(captured.backingResources);
      throw error;
    }
  }

  /** Admit the initial backing before the canvas is mutated. */
  public static async create(
    options: Readonly<BrowserPresentationPlanesOptions>
  ): Promise<BrowserPresentationPlanes> {
    const captured = capturePresentationPlaneOptions(options);
    const resources = captured.backingResources;
    if (resources === null) {
      return new BrowserPresentationPlanes(replayPresentationOptions(captured));
    }
    const initial = initialPresentationGeometry(captured);
    const allocationBytes = canvasBackingAllocationBytes(initial);
    const transition = await resources.beginTransition(Object.freeze({
      animatedAllocationBytes: allocationBytes
    }));
    const primed = createPrimedBackingResources(
      resources,
      transition,
      allocationBytes
    );
    return new BrowserPresentationPlanes(
      replayPresentationOptions(captured, primed)
    );
  }

  /** Factory passed to the neutral browser AVC composition. */
  public createFrameBackend(
    options?: Readonly<BrowserFrameBackendOptions>
  ): PresentableFrameBackend {
    this.#assertActiveWithTerminalReset();
    if (this.#backend !== null || this.#backendAdmissionActive) {
      throw new RangeError("a presentation backend is already attached");
    }
    this.#beginMutation();
    this.#backendAdmissionActive = true;
    try {
      return this.#createFrameBackendTransaction(options);
    } finally {
      this.#backendAdmissionActive = false;
      this.#endMutation();
    }
  }

  #createFrameBackendTransaction(
    options?: Readonly<BrowserFrameBackendOptions>
  ): PresentableFrameBackend {
    let created: PresentableFrameBackend;
    try {
      created = this.#createBackend(this.#animatedCanvas, options);
    } catch (error) {
      this.#settleAnimatedBackingAfterBackendFailure();
      throw error;
    }
    const admission = capturePresentationBackend(created);
    if (!admission.valid) {
      disposeCapturedPresentationBackend(admission.dispose);
      this.#settleAnimatedBackingAfterBackendFailure();
      throw new TypeError("presentation backend is not resize-capable");
    }
    const validated = admission.backend;
    if (this.#disposed) {
      disposeCapturedPresentationBackend(validated.dispose);
      this.#resetDisposedBackings();
      this.#assertActive();
    }
    let backend: AttachedPresentationBackend | null = null;
    try {
      if (
        this.#geometry !== null &&
        (
          this.#geometry.backing.width > validated.limits.maxTextureSize ||
          this.#geometry.backing.height > validated.limits.maxTextureSize
        )
      ) {
        throw new RendererUnavailableError(
          "presentation backing exceeds WebGL MAX_TEXTURE_SIZE"
        );
      }
      const attached = new AttachedPresentationBackend(
        validated,
        () => {
          if (this.#backend === attached) this.#backend = null;
        }
      );
      backend = attached;
      this.#backend = attached;
      if (this.#geometry !== null) {
        attached.setPresentationGeometry(this.#geometry);
      }
      this.#assertActive();
      return attached;
    } catch (error) {
      if (backend === null) {
        disposeCapturedPresentationBackend(validated.dispose);
      } else {
        try {
          backend.dispose();
        } catch {
          // The wrapper detaches in finally even if raw disposal rejects.
        }
      }
      this.#settleAnimatedBackingAfterBackendFailure();
      throw error;
    }
  }

  public ownsAnimatedCanvas(canvas: HTMLCanvasElement): boolean {
    return canvas === this.#animatedCanvas;
  }

  /** Narrow event capability; neither the canvas nor its GL context escapes. */
  public animatedContextTarget(): BrowserContextRecoveryEventTarget {
    this.#assertActive();
    this.#contextTarget ??= new OwnedCanvasContextEventTarget(
      this.#animatedCanvas
    );
    return this.#contextTarget;
  }

  public currentCanvasBacking(): Readonly<RuntimeCanvasBackingSize> {
    const backing = this.#geometry?.backing ?? this.#canvas;
    return Object.freeze({ width: backing.width, height: backing.height });
  }

  public reserveCanvasResources(
    plan: Readonly<RuntimeCanvasResourcePlan>
  ): RuntimeCanvasResourceLease {
    this.#assertActive();
    this.#beginMutation();
    try {
      const reservation = createPresentationResourceReservation(plan);
      this.#assertActiveWithTerminalReset();
      const current = this.currentCanvasBacking();
      const currentRawBytes = checkedByteNumber(
        checkedByteProduct(
          [current.width, current.height, 4],
          "current presentation backing bytes"
        ),
        "current presentation backing bytes"
      );
      if (currentRawBytes > reservation.maximumRawBackingBytes) {
        throw new RangeError(
          "current presentation backing exceeds the resource plan"
        );
      }
      const owner = Symbol("presentation-resource-reservation");
      this.#resourceReservations.set(owner, reservation);
      let released = false;
      return Object.freeze({
        release: () => {
          if (released) return;
          released = true;
          this.#resourceReservations.delete(owner);
        }
      });
    } finally {
      this.#endMutation();
    }
  }

  public resize(
    input: Readonly<BrowserPresentationResizeInput>
  ): Readonly<PresentationGeometry> {
    this.#assertActive();
    this.#beginMutation();
    try {
      if (input === null || typeof input !== "object") {
        throw new TypeError("browser presentation resize input must be an object");
      }
    const geometry = this.#computeResizeGeometry(input);
    const backend = this.#backend;
    this.#assertActiveWithTerminalReset();
    assertResourceReservations(this.#resourceReservations.values(), geometry);
    if (sameGeometry(this.#geometry, geometry)) {
      this.#equivalentResizeCount = increment(
        this.#equivalentResizeCount,
        "equivalent presentation resize count"
      );
      if (sameGeometryMetadata(this.#geometry!, geometry)) {
        return this.#geometry!;
      }
      this.#geometry = geometry;
      this.#emitClamp(geometry);
      this.#assertActiveWithTerminalReset();
      return geometry;
    }
    const previous = this.#geometry;
    const backingTransition = this.#beginBackingTransition(geometry);
    let animatedChanged: boolean;
    try {
      backingTransition?.assertActive?.();
      animatedChanged = backend?.setPresentationGeometry(geometry) ??
        !sameGeometry(previous, geometry);
      this.#assertActiveWithTerminalReset();
      const animatedWidth = this.#animatedCanvas.width;
      this.#assertActiveWithTerminalReset();
      const animatedHeight = this.#animatedCanvas.height;
      this.#assertActiveWithTerminalReset();
      if (animatedWidth !== geometry.backing.width) {
        this.#animatedCanvas.width = geometry.backing.width;
        this.#assertActiveWithTerminalReset();
      }
      if (animatedHeight !== geometry.backing.height) {
        this.#animatedCanvas.height = geometry.backing.height;
        this.#assertActiveWithTerminalReset();
      }
      assertExactCanvasBacking(
        this.#animatedCanvas,
        geometry.backing,
        "animated presentation"
      );
      this.#assertActiveWithTerminalReset();
      backingTransition?.commit();
    } catch (error) {
      if (this.#disposed) {
        this.#resetDisposedBackings();
        safelyRollbackBackingTransition(backingTransition);
        this.#assertActive();
      }
      if (previous === null) {
        // There is no committed mapping to restore transactionally.
        safelyRollbackBackingTransition(backingTransition);
        this.dispose();
      } else {
        let rollbackFailed = false;
        try {
          backend?.setPresentationGeometry(previous);
        } catch {
          rollbackFailed = true;
        }
        if (this.#disposed) {
          this.#resetDisposedBackings();
          safelyRollbackBackingTransition(backingTransition);
          this.#assertActive();
        }
        if (!this.#restoreAnimatedBackingTo(previous.backing)) {
          rollbackFailed = true;
        }
        if (this.#disposed) {
          this.#resetDisposedBackings();
          safelyRollbackBackingTransition(backingTransition);
          this.#assertActive();
        }
        safelyRollbackBackingTransition(backingTransition);
        if (rollbackFailed) {
          // A live owner whose rollback failed is no longer coherent.
          this.dispose();
        }
      }
      throw error;
    }
    if (!animatedChanged) {
      this.#equivalentResizeCount = increment(
        this.#equivalentResizeCount,
        "equivalent presentation resize count"
      );
      this.#geometry = geometry;
      this.#emitClamp(geometry);
      this.#assertActiveWithTerminalReset();
      return geometry;
    }
    this.#geometry = geometry;
    this.#generation = increment(
      this.#generation,
      "presentation geometry generation"
    );
    this.#resizeCount = increment(
      this.#resizeCount,
      "presentation resize count"
    );
    this.#emitClamp(geometry);
    this.#assertActiveWithTerminalReset();
      return geometry;
    } finally {
      this.#endMutation();
    }
  }

  /** Await page-pressure cleanup before backing growth mutates the canvas. */
  public async resizeWithAdmission(
    input: Readonly<BrowserPresentationResizeInput>
  ): Promise<Readonly<PresentationGeometry>> {
    this.#assertActive();
    if (this.#backingAdmissionActive) {
      throw new RangeError("canvas backing admission is already active");
    }
    if (input === null || typeof input !== "object") {
      throw new TypeError("browser presentation resize input must be an object");
    }
    const geometry = this.#computeResizeGeometry(input);
    if (sameGeometry(this.#geometry, geometry)) return this.resize(input);
    this.#backingAdmissionActive = true;
    let transition: BrowserCanvasBackingResourceTransition | null = null;
    try {
      transition = await this.#beginBackingTransitionAsync(geometry);
      this.#assertActiveWithTerminalReset();
      if (transition === null) {
        this.#backingAdmissionCommitActive = true;
        return this.resize(input);
      }
      const allocationBytes = canvasBackingAllocationBytes(geometry);
      this.#admittedBackingTransition = Object.freeze({
        allocationBytes,
        transition
      });
      this.#backingAdmissionCommitActive = true;
      const result = this.resize(input);
      transition = null;
      return result;
    } finally {
      this.#backingAdmissionCommitActive = false;
      this.#backingAdmissionActive = false;
      const unconsumed = this.#admittedBackingTransition;
      this.#admittedBackingTransition = null;
      safelyRollbackBackingTransition(unconsumed?.transition ?? transition);
    }
  }

  #emitClamp(geometry: Readonly<PresentationGeometry>): void {
    if (geometry.clampReasons.length === 0) return;
    try {
      this.#onClamp?.(geometry);
    } catch {
      // Diagnostics cannot own presentation geometry.
    }
  }

  #computeResizeGeometry(
    input: Readonly<BrowserPresentationResizeInput>
  ): Readonly<PresentationGeometry> {
    const backend = this.#backend;
    return computePresentationGeometry({
      canvasWidth: this.#canvas.width,
      canvasHeight: this.#canvas.height,
      pixelAspectNumerator: this.#canvas.pixelAspect[0],
      pixelAspectDenominator: this.#canvas.pixelAspect[1],
      fit: input.fit ?? this.#canvas.fit,
      cssWidth: input.cssWidth,
      cssHeight: input.cssHeight,
      devicePixelRatio: input.devicePixelRatio,
      maxBackingWidth: Math.min(
        this.#maxBackingWidth,
        backend?.limits.maxTextureSize ?? this.#maxBackingWidth
      ),
      maxBackingHeight: Math.min(
        this.#maxBackingHeight,
        backend?.limits.maxTextureSize ?? this.#maxBackingHeight
      ),
      maxBackingBytes: Math.min(
        this.#maxBackingBytes,
        input.maxBackingBytes ?? this.#maxBackingBytes,
        ...[...this.#resourceReservations.values()].map(
          ({ maximumRawBackingBytes }) => maximumRawBackingBytes
        )
      )
    });
  }

  #beginBackingTransition(
    geometry: Readonly<PresentationGeometry>
  ): BrowserCanvasBackingResourceTransition | null {
    const resources = this.#backingResources;
    if (resources === null) return null;
    const allocationBytes = canvasBackingAllocationBytes(geometry);
    const admitted = this.#admittedBackingTransition;
    if (admitted !== null) {
      if (admitted.allocationBytes !== allocationBytes) {
        throw new RangeError("admitted canvas backing no longer matches geometry");
      }
      this.#admittedBackingTransition = null;
      return admitted.transition;
    }
    if (this.#geometry !== null && this.#asynchronousBackingGrowth) {
      throw new TypeError(
        "asynchronous canvas growth requires resizeWithAdmission()"
      );
    }
    const transition = resources.beginTransition(Object.freeze({
      animatedAllocationBytes: allocationBytes
    }));
    if (isPromiseLike(transition)) {
      void Promise.resolve(transition).then(
        (late) => safelyRollbackBackingTransition(late),
        () => undefined
      );
      throw new TypeError(
        "asynchronous canvas growth requires resizeWithAdmission()"
      );
    }
    return transition;
  }

  async #beginBackingTransitionAsync(
    geometry: Readonly<PresentationGeometry>
  ): Promise<BrowserCanvasBackingResourceTransition | null> {
    const resources = this.#backingResources;
    if (resources === null) return null;
    const allocationBytes = canvasBackingAllocationBytes(geometry);
    return Promise.resolve(resources.beginTransition(Object.freeze({
      animatedAllocationBytes: allocationBytes
    })));
  }

  #restoreAnimatedBacking(): boolean {
    const backing = this.#geometry?.backing ?? this.#canvas;
    return this.#restoreAnimatedBackingTo(backing);
  }

  #restoreAnimatedBackingTo(
    backing: Readonly<RuntimeCanvasBackingSize>
  ): boolean {
    let restored = true;
    try {
      if (this.#animatedCanvas.width !== backing.width) {
        this.#animatedCanvas.width = backing.width;
      }
    } catch {
      restored = false;
    }
    try {
      if (this.#animatedCanvas.height !== backing.height) {
        this.#animatedCanvas.height = backing.height;
      }
    } catch {
      restored = false;
    }
    if (restored) {
      try {
        restored = this.#animatedCanvas.width === backing.width &&
          this.#animatedCanvas.height === backing.height;
      } catch {
        restored = false;
      }
    }
    return restored;
  }

  #settleAnimatedBackingAfterBackendFailure(): void {
    if (this.#disposed) {
      this.#resetDisposedBackings();
      return;
    }
    if (!this.#restoreAnimatedBacking()) this.dispose();
    if (this.#disposed) this.#resetDisposedBackings();
  }

  #assertActiveWithTerminalReset(): void {
    if (this.#disposed) this.#resetDisposedBackings();
    this.#assertActive();
  }

  #beginMutation(): void {
    if (this.#backingAdmissionActive && !this.#backingAdmissionCommitActive) {
      throw new RangeError("browser presentation backing admission is active");
    }
    if (this.#mutationActive) {
      throw new RangeError(
        "browser presentation mutation reentered synchronously"
      );
    }
    this.#mutationActive = true;
  }

  #endMutation(): void {
    this.#mutationActive = false;
  }

  #resetDisposedBackings(): void {
    resetCanvasBacking(this.#animatedCanvas);
  }
  public snapshot(): Readonly<BrowserPresentationPlanesSnapshot> {
    return Object.freeze({
      generation: this.#generation,
      resizeCount: this.#resizeCount,
      equivalentResizeCount: this.#equivalentResizeCount,
      backendAttached: this.#backend !== null,
      contextListeners: this.#contextTarget?.listenerCount ?? 0,
      resourceReservations: this.#resourceReservations.size,
      effectiveMaxBackingBytes: Math.min(
        this.#maxBackingBytes,
        ...[...this.#resourceReservations.values()].map(
          ({ maximumRawBackingBytes }) => maximumRawBackingBytes
        )
      ),
      liveResourceTotals: Object.freeze(
        [...this.#resourceReservations.values()].map((reservation) =>
          liveResourceTotal(
            reservation,
            this.#geometry?.byteTerms.bytesPerPlane ??
              checkedByteNumber(
                checkedByteProduct(
                  [this.#canvas.width, this.#canvas.height, 4],
                  "logical presentation plane bytes"
                ),
                "logical presentation plane bytes"
              )
          )
        )
      ),
      geometry: this.#geometry
    });
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    const backend = this.#backend;
    this.#backend = null;
    this.#geometry = null;
    this.#resourceReservations.clear();
    this.#contextTarget?.dispose();
    this.#contextTarget = null;
    try {
      backend?.dispose();
    } catch {
      // Terminal cleanup continues through canvas/accounting release.
    }
    this.#resetDisposedBackings();
    safelyReleaseBackingResources(this.#backingResources);
  }

  #assertActive(): void {
    if (this.#disposed) {
      throw new DOMException("browser presentation planes are disposed", "AbortError");
    }
  }
}

function disposeCapturedPresentationBackend(
  dispose: (() => unknown) | null
): void {
  if (dispose === null) return;
  try {
    dispose();
  } catch {
    // The stable invalid-backend/initialization result remains authoritative.
  }
}

interface ValidatedPresentationBackend {
  readonly limits: Readonly<PresentableFrameBackend["limits"]>;
  readonly setPresentationGeometry: PresentableFrameBackend["setPresentationGeometry"];
  readonly allocate: PresentableFrameBackend["allocate"];
  readonly upload: PresentableFrameBackend["upload"];
  readonly uploadFrame: NonNullable<PresentableFrameBackend["uploadFrame"]> | null;
  readonly draw: PresentableFrameBackend["draw"];
  readonly readPixels: NonNullable<PresentableFrameBackend["readPixels"]> | null;
  readonly dispose: () => unknown;
}

interface CapturedPresentationBackendSuccess {
  readonly valid: true;
  readonly backend: Readonly<ValidatedPresentationBackend>;
}

interface CapturedPresentationBackendFailure {
  readonly valid: false;
  readonly dispose: (() => unknown) | null;
}

type CapturedPresentationBackend =
  | CapturedPresentationBackendSuccess
  | CapturedPresentationBackendFailure;

function capturePresentationBackend(
  value: unknown
): Readonly<CapturedPresentationBackend> {
  if (value === null || typeof value !== "object") {
    return Object.freeze({ valid: false, dispose: null });
  }
  let dispose: (() => unknown) | null = null;
  try {
    const disposeImplementation = Reflect.get(value, "dispose") as unknown;
    if (typeof disposeImplementation !== "function") {
      return Object.freeze({ valid: false, dispose: null });
    }
    dispose = () => Reflect.apply(disposeImplementation, value, []);
    const setPresentationGeometryImplementation = Reflect.get(
      value,
      "setPresentationGeometry"
    ) as unknown;
    const allocateImplementation = Reflect.get(value, "allocate") as unknown;
    const uploadImplementation = Reflect.get(value, "upload") as unknown;
    const uploadFrameImplementation = Reflect.get(value, "uploadFrame") as unknown;
    const drawImplementation = Reflect.get(value, "draw") as unknown;
    const readPixelsImplementation = Reflect.get(value, "readPixels") as unknown;
    if (
      typeof setPresentationGeometryImplementation !== "function" ||
      typeof allocateImplementation !== "function" ||
      typeof uploadImplementation !== "function" ||
      typeof drawImplementation !== "function" ||
      (
        uploadFrameImplementation !== undefined &&
        typeof uploadFrameImplementation !== "function"
      ) ||
      (
        readPixelsImplementation !== undefined &&
        typeof readPixelsImplementation !== "function"
      )
    ) {
      return Object.freeze({ valid: false, dispose });
    }
    const limits = Reflect.get(value, "limits") as unknown;
    if (limits === null || typeof limits !== "object") {
      return Object.freeze({ valid: false, dispose });
    }
    const maxTextureSize = Reflect.get(limits, "maxTextureSize");
    const maxArrayTextureLayers = Reflect.get(limits, "maxArrayTextureLayers");
    if (
      !Number.isSafeInteger(maxTextureSize) ||
      !Number.isSafeInteger(maxArrayTextureLayers) ||
      (maxTextureSize as number) < 1 ||
      (maxArrayTextureLayers as number) < 1
    ) {
      return Object.freeze({ valid: false, dispose });
    }
    return Object.freeze({
      valid: true,
      backend: Object.freeze({
        limits: Object.freeze({
          maxTextureSize: maxTextureSize as number,
          maxArrayTextureLayers: maxArrayTextureLayers as number
        }),
        setPresentationGeometry: (
          geometry: Readonly<PresentationGeometry>
        ) => Reflect.apply(
          setPresentationGeometryImplementation,
          value,
          [geometry]
        ) as boolean,
        allocate: (layout: FrameTextureLayout, slots: number) => {
          Reflect.apply(allocateImplementation, value, [layout, slots]);
        },
        upload: (
          kind: FrameTextureKind,
          index: number,
          pixels: Uint8Array
        ) => {
          Reflect.apply(uploadImplementation, value, [kind, index, pixels]);
        },
        uploadFrame: uploadFrameImplementation === undefined
          ? null
          : (
            kind: FrameTextureKind,
            index: number,
            frame: CopyableVideoFrame,
            layout: Readonly<FrameSourceLayout>
          ) => {
            Reflect.apply(uploadFrameImplementation, value, [
              kind,
              index,
              frame,
              layout
            ]);
          },
        draw: (kind: FrameTextureKind, index: number) => {
          Reflect.apply(drawImplementation, value, [kind, index]);
        },
        readPixels: readPixelsImplementation === undefined
          ? null
          : () => Reflect.apply(
            readPixelsImplementation,
            value,
            []
          ) as Uint8Array,
        dispose
      })
    });
  } catch {
    return Object.freeze({ valid: false, dispose });
  }
}

function resetCanvasBacking(canvas: HTMLCanvasElement): void {
  try {
    canvas.width = 0;
  } catch {
    // Continue through the independent height store.
  }
  try {
    canvas.height = 0;
  } catch {
    // Best-effort constructor/terminal rollback has no remaining owner.
  }
}

function assertExactCanvasBacking(
  canvas: HTMLCanvasElement,
  backing: Readonly<RuntimeCanvasBackingSize>,
  label: string
): void {
  if (canvas.width !== backing.width || canvas.height !== backing.height) {
    throw new RangeError(`${label} backing allocation was not exact`);
  }
}

/** Detaches the plane owner exactly when the candidate releases its backend. */
class AttachedPresentationBackend implements PresentableFrameBackend {
  readonly #backend: Readonly<ValidatedPresentationBackend>;
  readonly #onDispose: () => void;
  #disposed = false;

  public readonly limits;
  public readonly readPixels?: () => Uint8Array;
  public readonly uploadFrame?: (
    kind: FrameTextureKind,
    index: number,
    frame: CopyableVideoFrame,
    layout: Readonly<FrameSourceLayout>
  ) => void;

  public constructor(
    backend: Readonly<ValidatedPresentationBackend>,
    onDispose: () => void
  ) {
    this.#backend = backend;
    this.#onDispose = onDispose;
    this.limits = backend.limits;
    const readPixels = backend.readPixels;
    if (readPixels !== null) {
      this.readPixels = () => {
        this.#assertActive();
        const pixels = readPixels();
        this.#assertActive();
        return pixels;
      };
    }
    const uploadFrame = backend.uploadFrame;
    if (uploadFrame !== null) {
      this.uploadFrame = (kind, index, frame, layout) => {
        this.#assertActive();
        uploadFrame(kind, index, frame, layout);
        this.#assertActive();
      };
    }
  }

  public setPresentationGeometry(
    geometry: Readonly<PresentationGeometry>
  ): boolean {
    this.#assertActive();
    const changed = this.#backend.setPresentationGeometry(geometry);
    this.#assertActive();
    return changed;
  }

  public allocate(layout: FrameTextureLayout, slots: number): void {
    this.#assertActive();
    this.#backend.allocate(layout, slots);
    this.#assertActive();
  }

  public upload(kind: FrameTextureKind, index: number, pixels: Uint8Array): void {
    this.#assertActive();
    this.#backend.upload(kind, index, pixels);
    this.#assertActive();
  }

  public draw(kind: FrameTextureKind, index: number): void {
    this.#assertActive();
    this.#backend.draw(kind, index);
    this.#assertActive();
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    try {
      this.#backend.dispose();
    } finally {
      this.#onDispose();
    }
  }

  #assertActive(): void {
    if (this.#disposed) {
      throw new DOMException("presentation backend is disposed", "AbortError");
    }
  }
}

function sameGeometry(
  left: Readonly<PresentationGeometry> | null,
  right: Readonly<PresentationGeometry>
): boolean {
  return left !== null &&
    left.backing.width === right.backing.width &&
    left.backing.height === right.backing.height &&
    left.sourceRect.x === right.sourceRect.x &&
    left.sourceRect.y === right.sourceRect.y &&
    left.sourceRect.width === right.sourceRect.width &&
    left.sourceRect.height === right.sourceRect.height &&
    left.destinationBackingRect.x === right.destinationBackingRect.x &&
    left.destinationBackingRect.y === right.destinationBackingRect.y &&
    left.destinationBackingRect.width === right.destinationBackingRect.width &&
    left.destinationBackingRect.height === right.destinationBackingRect.height;
}

function sameGeometryMetadata(
  left: Readonly<PresentationGeometry>,
  right: Readonly<PresentationGeometry>
): boolean {
  return left.fit === right.fit &&
    left.desiredBacking.width === right.desiredBacking.width &&
    left.desiredBacking.height === right.desiredBacking.height &&
    left.destinationCssRect.x === right.destinationCssRect.x &&
    left.destinationCssRect.y === right.destinationCssRect.y &&
    left.destinationCssRect.width === right.destinationCssRect.width &&
    left.destinationCssRect.height === right.destinationCssRect.height &&
    left.effectiveDevicePixelRatio.x === right.effectiveDevicePixelRatio.x &&
    left.effectiveDevicePixelRatio.y === right.effectiveDevicePixelRatio.y &&
    left.resolutionScale === right.resolutionScale &&
    left.clampReasons.length === right.clampReasons.length &&
    left.clampReasons.every((reason, index) =>
      reason === right.clampReasons[index]
    );
}

function increment(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value >= Number.MAX_SAFE_INTEGER) {
    throw new RangeError(`${label} exceeds safe integer range`);
  }
  return value + 1;
}
