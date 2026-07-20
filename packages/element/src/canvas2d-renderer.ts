import {
  createRendererFailureDiagnostic,
  RendererFailureError,
  type RendererDiagnosticOperation,
  type RendererDiagnosticPhase,
  type RendererDiagnosticUploadPath
} from "./renderer-diagnostics.js";
import {
  canvas2dCpuFrameBytes,
  createCanvas2dCpuFrame,
  extractCanvas2dCpuFrame,
  type Canvas2dCpuFrame as CpuFrame
} from "./canvas2d-frame.js";
import {
  createCanvas2dSurface,
  putCanvas2dPixels,
  reacquireCanvas2dSurface,
  releaseCanvas2dSurface,
  type Canvas2dSurface
} from "./canvas2d-surface.js";
import {
  assertCanvas2dContextAvailable,
  canvas2dContext,
  configureCanvas2dContext
} from "./canvas2d-context.js";
import {
  allocationBytes,
  calculateRendererBacking,
  calculateRendererViewport,
  checkedProduct,
  checkedRenderLayout,
  checkedSum,
  isRendererFit,
  rgbaBytes,
  validateRenderFrame,
  type RenderLayout,
  type RendererFit
} from "./renderer-geometry.js";
import {
  defaultCanvasFactory,
  MaterializerFailureError,
  RgbaMaterializer,
  type MaterializedRgbaFrame,
  type RgbaMaterialization
} from "./rgba-materializer.js";
import {
  inspectMaterializedRgbaFrame,
  rethrowInspectionRejection
} from "./renderer-inspection.js";
import { RendererOperationCoordinator } from
  "./renderer-operation-coordinator.js";
import {
  namedError,
  rendererCap,
  rendererDiagnosticScalar,
  rendererResidentKey
} from "./renderer-utilities.js";
import type {
  RendererContextChange,
  RendererFrameInspector,
  RendererRuntime,
  RendererSnapshot
} from "./renderer-contract.js";
import type { RendererLimits } from "./renderer-limits.js";

export type Canvas2dRendererLimits = RendererLimits;

type State = "active" | "lost" | "error" | "disposed";

type LastFrame =
  | Readonly<{ kind: "stream"; index: number }>
  | Readonly<{ kind: "resident"; key: string }>;

const STREAMS = 3;

/** Canvas2D presentation backend used only after exact-null WebGL2 creation. */
export class Canvas2dRenderer implements RendererRuntime {
  readonly #canvas: HTMLCanvasElement;
  readonly #layout: Readonly<RenderLayout>;
  readonly #frameBytes: number;
  readonly #plannedStagingBytes: number;
  readonly #maxTextureBytes: number;
  readonly #maxBackingBytes: number;
  readonly #maxRuntimeBytes: number;
  readonly #createCanvas: (width: number, height: number) => HTMLCanvasElement;
  readonly #materializer: RgbaMaterializer;
  readonly #operations: RendererOperationCoordinator<RendererFailureError>;
  readonly #onContextChange:
    ((change: Readonly<RendererContextChange>) => void) | undefined;
  readonly #lost: (event: Event) => void;
  readonly #restored: () => void;
  readonly #resident = new Map<string, CpuFrame>();
  readonly #reserved = new Set<string>();
  #streams: CpuFrame[] = [];
  #nextStream = 0;
  #last: LastFrame | null = null;
  #outputContext: CanvasRenderingContext2D | null = null;
  #colorSurface: Canvas2dSurface | null = null;
  #alphaSurface: Canvas2dSurface | null = null;
  #state: State = "active";
  #resizeQueued = false;
  #fit: RendererFit = "contain";
  #cssWidth = 0;
  #cssHeight = 0;
  #dpr = 1;
  #losses = 0;
  #recoveries = 0;
  #failureError: RendererFailureError | null = null;

  public constructor(
    canvas: HTMLCanvasElement,
    layout: Readonly<RenderLayout>,
    limits: Readonly<Canvas2dRendererLimits> = {}
  ) {
    this.#canvas = canvas;
    this.#layout = checkedRenderLayout(layout);
    const colorBytes = rgbaBytes(
      this.#layout.colorRect[2],
      this.#layout.colorRect[3]
    );
    this.#frameBytes = checkedProduct(
      colorBytes,
      this.#layout.alphaRect === undefined ? 1 : 2
    );
    const storageBytes = rgbaBytes(
      this.#layout.storageWidth,
      this.#layout.storageHeight
    );
    this.#plannedStagingBytes = checkedSum([
      storageBytes,
      checkedProduct(STREAMS, this.#frameBytes)
    ]);
    this.#maxTextureBytes = rendererCap(
      limits.maxTextureBytes,
      "texture byte cap"
    );
    this.#maxBackingBytes = rendererCap(
      limits.maxBackingBytes,
      "backing byte cap"
    );
    this.#maxRuntimeBytes = rendererCap(
      limits.maxRuntimeBytes,
      "runtime byte cap"
    );
    this.#createCanvas = limits.createCanvas ?? defaultCanvasFactory(canvas);
    this.#materializer = new RgbaMaterializer(
      this.#layout.storageWidth,
      this.#layout.storageHeight,
      {
        ...(limits.copyTimeoutMs === undefined
          ? {} : { copyTimeoutMs: limits.copyTimeoutMs }),
        ...(limits.setTimeout === undefined
          ? {} : { setTimeout: limits.setTimeout }),
        ...(limits.clearTimeout === undefined
          ? {} : { clearTimeout: limits.clearTimeout }),
        createCanvas: this.#createCanvas
      }
    );
    this.#onContextChange = limits.onContextChange;
    this.#operations = new RendererOperationCoordinator({
      accepting: () => this.#state !== "disposed" && this.#state !== "error",
      unavailable,
      classify: (reason, operation, operationOrdinal) =>
        this.#classifyOperationFailure(reason, operation, operationOrdinal),
      terminal: (error) => this.#terminal(error)
    });
    this.#lost = (event) => {
      event.preventDefault();
      this.#markLost();
    };
    this.#restored = () => this.#queueRestore();

    const oldWidth = canvas.width;
    const oldHeight = canvas.height;
    const initial = limits.initialPresentation;
    let width = oldWidth;
    let height = oldHeight;
    if (initial !== undefined) {
      if (!isRendererFit(initial.fit)) {
        throw new RangeError("renderer presentation geometry is invalid");
      }
      const backing = calculateRendererBacking(
        initial.width,
        initial.height,
        initial.dpr
      );
      width = backing.width;
      height = backing.height;
      this.#cssWidth = Math.max(1, initial.width);
      this.#cssHeight = Math.max(1, initial.height);
      this.#dpr = backing.dpr;
      this.#fit = initial.fit;
    }

    const operationOrdinal = this.#operations.beginOperation();
    let listeners = false;
    try {
      if (initial !== undefined) {
        this.#setOutputBacking(width, height, "construct", operationOrdinal);
      }
      const backingBytes = this.#backingBytes(width, height);
      this.#assertBudget(0, backingBytes);
      this.#streams = Array.from(
        { length: STREAMS },
        () => createCanvas2dCpuFrame(this.#layout)
      );
      this.#initializeContexts("construct", operationOrdinal);
      canvas.addEventListener("contextlost", this.#lost);
      canvas.addEventListener("contextrestored", this.#restored);
      listeners = true;
    } catch (reason) {
      if (listeners) {
        canvas.removeEventListener("contextlost", this.#lost);
        canvas.removeEventListener("contextrestored", this.#restored);
      }
      const error = reason instanceof RendererFailureError ||
        reason instanceof RangeError && reason.name === "ResourceBudgetError"
        ? reason
        : this.#failure("context-create", "construct", operationOrdinal, reason);
      this.#state = "error";
      this.#releaseCpuStorage();
      this.#releaseSurfaces();
      this.#outputContext = null;
      try {
        canvas.width = oldWidth;
        canvas.height = oldHeight;
      } catch { /* The constructor remains terminal. */ }
      throw error;
    }
  }

  public resize(
    cssWidth: number,
    cssHeight: number,
    devicePixelRatio: number,
    fit: string
  ): void {
    if (this.#state === "disposed") return;
    if (this.#state === "error") throw unavailable();
    if (!isRendererFit(fit)) {
      throw new RangeError("renderer presentation geometry is invalid");
    }
    const backing = calculateRendererBacking(
      cssWidth,
      cssHeight,
      devicePixelRatio
    );
    const operationOrdinal = this.#operations.beginOperation();
    const backingBytes = this.#backingBytes(backing.width, backing.height);
    this.#assertBudget(this.#resident.size + this.#reserved.size, backingBytes);
    try {
      this.#setOutputBacking(
        backing.width,
        backing.height,
        "runtime",
        operationOrdinal
      );
      this.#cssWidth = Math.max(1, cssWidth);
      this.#cssHeight = Math.max(1, cssHeight);
      this.#dpr = backing.dpr;
      this.#fit = fit;
      if (this.#outputContext !== null) {
        configureCanvas2dContext(this.#outputContext);
      }
    } catch (reason) {
      const error = reason instanceof RendererFailureError
        ? reason
        : this.#failure("resize", "runtime", operationOrdinal, reason);
      this.#terminal(error);
      throw error;
    }
    if (this.#last !== null && !this.#resizeQueued) {
      this.#resizeQueued = true;
      void this.#operations.enqueueIf(
        "runtime",
        () => this.#state === "active",
        (ordinal) => this.#drawLast("runtime", ordinal)
      ).catch(() => undefined).finally(() => {
        this.#resizeQueued = false;
      });
    }
  }

  public draw(frame: VideoFrame): Promise<void> {
    return this.#operations.enqueue("runtime", async (operationOrdinal) => {
      if (this.#state !== "active") throw unavailable();
      const slot = this.#nextStream;
      const buffer = this.#streams[slot];
      if (buffer === undefined) throw unavailable();
      await this.#upload(frame, buffer, operationOrdinal);
      if (this.#state !== "active") throw unavailable();
      this.#render(buffer, "runtime", operationOrdinal);
      this.#last = Object.freeze({ kind: "stream", index: slot });
      this.#nextStream = (slot + 1) % STREAMS;
    });
  }

  public async inspectAndPrime(
    frame: VideoFrame,
    inspect: RendererFrameInspector
  ): Promise<void> {
    const outcome = await this.#operations.enqueue(
      "runtime",
      async (operationOrdinal) => {
      if (this.#state !== "active") throw unavailable();
      const materialization = this.#createMaterialization(
        frame,
        operationOrdinal
      );
      try {
        const source = await this.#materialize(
          materialization,
          operationOrdinal
        );
        if (this.#state !== "active") throw unavailable();
        const inspected = inspectMaterializedRgbaFrame(frame, source, inspect);
        if (this.#state !== "active") throw unavailable();
        if (inspected.kind === "rejected") return inspected;
        const target = this.#streams[this.#nextStream];
        if (target === undefined) throw unavailable();
        this.#primeRgba(target, source, operationOrdinal);
        return inspected;
      } finally {
        materialization.release();
      }
      }
    );
    rethrowInspectionRejection(outcome);
  }

  public store(group: string, index: number, frame: VideoFrame): Promise<void> {
    const key = rendererResidentKey(group, index);
    if (this.#resident.has(key) || this.#reserved.has(key)) {
      throw new Error("resident frame already exists");
    }
    this.#assertBudget(
      this.#resident.size + this.#reserved.size + 1,
      this.#backingBytes(this.#canvas.width, this.#canvas.height)
    );
    this.#reserved.add(key);
    return this.#operations.enqueue("runtime", async (operationOrdinal) => {
      const buffer = createCanvas2dCpuFrame(this.#layout);
      await this.#upload(frame, buffer, operationOrdinal);
      if (this.#state !== "active") throw unavailable();
      this.#resident.set(key, buffer);
    }).finally(() => {
      this.#reserved.delete(key);
    });
  }

  public drawStored(group: string, index: number): Promise<void> {
    const key = rendererResidentKey(group, index);
    if (!this.#resident.has(key)) {
      throw new Error("resident frame is unavailable");
    }
    return this.#operations.enqueue("runtime", (operationOrdinal) => {
      if (this.#state !== "active") throw unavailable();
      const buffer = this.#resident.get(key);
      if (buffer === undefined) throw unavailable();
      this.#render(buffer, "runtime", operationOrdinal);
      this.#last = Object.freeze({ kind: "resident", key });
    });
  }

  public settled(): Promise<void> { return this.#operations.settled(); }

  public admit(residentCount: number): Readonly<{
    textureBytes: number;
    runtimeBytes: number;
  }> {
    if (!Number.isSafeInteger(residentCount) || residentCount < 0) {
      throw new RangeError("resident texture count is invalid");
    }
    if (this.#state !== "active") throw unavailable();
    return this.#assertBudget(
      residentCount,
      this.#backingBytes(this.#canvas.width, this.#canvas.height)
    );
  }

  public snapshot(): Readonly<RendererSnapshot> {
    const materializer = this.#materializer.snapshot();
    if (this.#state === "disposed") {
      return Object.freeze({
        backendDetails: Object.freeze({ kind: "canvas2d" as const }),
        cssWidth: this.#cssWidth,
        cssHeight: this.#cssHeight,
        backingWidth: this.#canvas.width,
        backingHeight: this.#canvas.height,
        effectiveDprX: 0,
        effectiveDprY: 0,
        contextLossCount: this.#losses,
        contextRecoveryCount: this.#recoveries,
        stagingBytes: 0,
        residentBytes: 0,
        textureBytes: 0 as const,
        runtimeBytes: 0,
        pendingOperations: this.#operations.pendingOperations,
        sourceCopiesInFlight: materializer.sourceCopiesInFlight,
        resourceCount: 0,
        contextListenerCount: 0,
        failure: this.#failureError?.diagnostic ?? null
      });
    }
    const residentBytes = checkedProduct(
      this.#resident.size + this.#reserved.size,
      this.#frameBytes
    );
    const backingBytes = this.#ownedBackingBytes(
      this.#canvas.width,
      this.#canvas.height
    );
    const stagingBytes = this.#stagingBytes();
    return Object.freeze({
      backendDetails: Object.freeze({ kind: "canvas2d" as const }),
      cssWidth: this.#cssWidth,
      cssHeight: this.#cssHeight,
      backingWidth: this.#canvas.width,
      backingHeight: this.#canvas.height,
      effectiveDprX: this.#cssWidth > 0 ? this.#canvas.width / this.#cssWidth : 0,
      effectiveDprY: this.#cssHeight > 0 ? this.#canvas.height / this.#cssHeight : 0,
      contextLossCount: this.#losses,
      contextRecoveryCount: this.#recoveries,
      stagingBytes,
      residentBytes,
      textureBytes: 0 as const,
      runtimeBytes: checkedSum([stagingBytes, residentBytes, backingBytes]),
      pendingOperations: this.#operations.pendingOperations,
      sourceCopiesInFlight: materializer.sourceCopiesInFlight,
      resourceCount: this.#resourceCount(),
      contextListenerCount: this.#state === "error" ? 0 : 2,
      failure: this.#failureError?.diagnostic ?? null
    });
  }

  public dispose(): void {
    if (this.#state === "disposed") return;
    this.#state = "disposed";
    this.#removeContextListeners();
    this.#resident.clear();
    this.#reserved.clear();
    this.#last = null;
    this.#releaseCpuStorage();
    this.#releaseSurfaces();
    this.#outputContext = null;
    this.#releaseOutputBacking();
  }


  #classifyOperationFailure(
    reason: unknown,
    operation: RendererDiagnosticOperation,
    operationOrdinal: number
  ): RendererFailureError | null {
    if (
      this.#state !== "active" &&
      namedError(reason, "RendererUnavailableError")
    ) return null;
    if (reason instanceof RendererFailureError) return reason;
    return this.#failure(
      "context-event",
      operation,
      operationOrdinal,
      reason
    );
  }

  #queueRestore(): void {
    if (this.#state !== "lost") return;
    void this.#operations.enqueueIf(
      "restore",
      () => this.#state === "lost",
      (operationOrdinal) => {
        this.#initializeContexts("restore", operationOrdinal, true);
        this.#state = "active";
        this.#drawLast("restore", operationOrdinal);
        this.#recoveries += 1;
        this.#notify(Object.freeze({ state: "restored", error: null }));
      }
    ).catch(() => undefined);
  }

  #initializeContexts(
    operation: RendererDiagnosticOperation,
    operationOrdinal: number,
    restore = false
  ): void {
    try {
      if (!restore) {
        this.#colorSurface = createCanvas2dSurface(
          this.#createCanvas,
          this.#layout.colorRect[2],
          this.#layout.colorRect[3]
        );
        this.#alphaSurface = this.#layout.alphaRect === undefined
          ? null
          : createCanvas2dSurface(
              this.#createCanvas,
              this.#layout.alphaRect[2],
              this.#layout.alphaRect[3]
            );
      } else {
        reacquireCanvas2dSurface(this.#colorSurface);
        if (this.#alphaSurface !== null) {
          reacquireCanvas2dSurface(this.#alphaSurface);
        }
      }
      const output = canvas2dContext(this.#canvas, false);
      if (output === null) throw new Error("Canvas2D output context is unavailable");
      assertCanvas2dContextAvailable(output);
      configureCanvas2dContext(output);
      this.#outputContext = output;
    } catch (reason) {
      throw this.#failure(
        restore ? "context-event" : "context-create",
        operation,
        operationOrdinal,
        reason
      );
    }
  }

  async #upload(
    frame: VideoFrame,
    target: CpuFrame,
    operationOrdinal: number
  ): Promise<void> {
    const materialization = this.#createMaterialization(frame, operationOrdinal);
    try {
      const source = await this.#materialize(materialization, operationOrdinal);
      if (this.#state !== "active") throw unavailable();
      this.#primeRgba(target, source, operationOrdinal);
    } finally {
      materialization.release();
    }
  }

  #createMaterialization(
    frame: VideoFrame,
    operationOrdinal: number
  ): Readonly<RgbaMaterialization> {
    let rect: DOMRectReadOnly;
    try {
      rect = validateRenderFrame(frame, this.#layout);
    } catch (reason) {
      throw this.#failure(
        "semantic-upload",
        "runtime",
        operationOrdinal,
        reason
      );
    }
    return this.#materializer.create(frame, rect);
  }

  async #materialize(
    materialization: Readonly<RgbaMaterialization>,
    operationOrdinal: number
  ): Promise<Readonly<MaterializedRgbaFrame>> {
    try {
      return await materialization.rgba();
    } catch (reason) {
      if (this.#state !== "active") throw unavailable();
      if (!(reason instanceof MaterializerFailureError)) throw reason;
      throw this.#failure(
        "rgba-copy",
        "runtime",
        operationOrdinal,
        reason.reason,
        "rgba-copy"
      );
    }
  }

  #primeRgba(
    target: CpuFrame,
    source: Readonly<MaterializedRgbaFrame>,
    operationOrdinal: number
  ): void {
    try {
      extractCanvas2dCpuFrame(this.#layout, target, source.pixels);
    } catch (reason) {
      throw this.#failure(
        "rgba-copy",
        "runtime",
        operationOrdinal,
        reason,
        "rgba-copy"
      );
    }
  }

  #render(
    frame: CpuFrame,
    operation: RendererDiagnosticOperation,
    operationOrdinal: number
  ): void {
    if (this.#state !== "active") throw unavailable();
    const output = this.#outputContext;
    const color = this.#colorSurface;
    const alpha = this.#alphaSurface;
    if (output === null || color === null || color.context === null ||
      frame.alpha !== null && (alpha === null || alpha.context === null)) {
      throw unavailable();
    }
    try {
      assertCanvas2dContextAvailable(output);
      assertCanvas2dContextAvailable(color.context);
      putCanvas2dPixels(
        color.context,
        frame.color,
        color.canvas.width,
        color.canvas.height
      );
      if (frame.alpha !== null && alpha !== null && alpha.context !== null) {
        assertCanvas2dContextAvailable(alpha.context);
        putCanvas2dPixels(
          alpha.context,
          frame.alpha,
          alpha.canvas.width,
          alpha.canvas.height
        );
      }
      const viewport = calculateRendererViewport(
        this.#layout,
        this.#canvas.width,
        this.#canvas.height,
        this.#dpr,
        this.#fit
      );
      configureCanvas2dContext(output);
      output.globalCompositeOperation = "source-over";
      output.clearRect(0, 0, this.#canvas.width, this.#canvas.height);
      output.drawImage(
        color.canvas,
        0,
        0,
        color.canvas.width,
        color.canvas.height,
        viewport.x,
        viewport.y,
        viewport.width,
        viewport.height
      );
      if (frame.alpha !== null && alpha !== null) {
        output.globalCompositeOperation = "destination-in";
        output.drawImage(
          alpha.canvas,
          0,
          0,
          alpha.canvas.width,
          alpha.canvas.height,
          viewport.x,
          viewport.y,
          viewport.width,
          viewport.height
        );
      }
      output.globalCompositeOperation = "source-over";
      assertCanvas2dContextAvailable(output);
    } catch (reason) {
      try { output.globalCompositeOperation = "source-over"; } catch { /* evidence retained */ }
      throw this.#failure("draw", operation, operationOrdinal, reason);
    }
  }

  #drawLast(
    operation: RendererDiagnosticOperation,
    operationOrdinal: number
  ): void {
    const last = this.#last;
    if (last === null) return;
    const frame = last.kind === "stream"
      ? this.#streams[last.index]
      : this.#resident.get(last.key);
    if (frame !== undefined) this.#render(frame, operation, operationOrdinal);
  }

  #markLost(): void {
    if (this.#state !== "active") return;
    this.#state = "lost";
    this.#losses += 1;
    this.#outputContext = null;
    this.#materializer.reset();
    this.#notify(Object.freeze({ state: "lost", error: null }));
  }

  #terminal(error: RendererFailureError): void {
    if (this.#state === "disposed" || this.#state === "error") return;
    this.#state = "error";
    this.#failureError = error;
    this.#removeContextListeners();
    this.#resident.clear();
    this.#reserved.clear();
    this.#last = null;
    this.#releaseCpuStorage();
    this.#releaseSurfaces();
    this.#outputContext = null;
    this.#releaseOutputBacking();
    this.#notify(Object.freeze({ state: "error", error }));
  }

  #removeContextListeners(): void {
    this.#canvas.removeEventListener("contextlost", this.#lost);
    this.#canvas.removeEventListener("contextrestored", this.#restored);
  }

  #releaseOutputBacking(): void {
    try {
      this.#canvas.width = 0;
      this.#canvas.height = 0;
    } catch { /* terminal cleanup */ }
  }

  #notify(change: Readonly<RendererContextChange>): void {
    queueMicrotask(() => {
      try { this.#onContextChange?.(change); } catch { /* Host callbacks are isolated. */ }
    });
  }

  #setOutputBacking(
    width: number,
    height: number,
    operation: RendererDiagnosticOperation,
    operationOrdinal: number
  ): void {
    const oldWidth = this.#canvas.width;
    const oldHeight = this.#canvas.height;
    try {
      if (oldWidth !== width) this.#canvas.width = width;
      if (oldHeight !== height) this.#canvas.height = height;
      if (this.#canvas.width !== width || this.#canvas.height !== height) {
        throw new Error("canvas rejected its exact backing dimensions");
      }
    } catch (reason) {
      const error = this.#failure(
        operation === "construct" ? "backing-admission" : "resize",
        operation,
        operationOrdinal,
        reason
      );
      try {
        this.#canvas.width = oldWidth;
        this.#canvas.height = oldHeight;
      } catch { /* classified below */ }
      throw error;
    }
  }

  #failure(
    phase: RendererDiagnosticPhase,
    operation: RendererDiagnosticOperation,
    operationOrdinal: number,
    reason: unknown,
    uploadPath: RendererDiagnosticUploadPath | null = null
  ): RendererFailureError {
    if (reason instanceof RendererFailureError) return reason;
    if (this.#failureError !== null) return this.#failureError;
    const bytes = this.#diagnosticBytes();
    const diagnostic = createRendererFailureDiagnostic({
      backend: "canvas2d",
      phase,
      operation,
      operationOrdinal,
      reason,
      glError: null,
      contextLost: this.#state === "lost",
      uploadPath,
      textureOrdinal: null,
      layout: this.#layout,
      backing: {
        width: rendererDiagnosticScalar(this.#canvas.width),
        height: rendererDiagnosticScalar(this.#canvas.height)
      },
      bytes,
      limits: {
        maxTextureSize: 0,
        maxViewportWidth: 0,
        maxViewportHeight: 0,
        maxResidentTextures: 0
      },
      contextAttributes: null,
      vendor: null,
      renderer: null
    });
    this.#failureError = new RendererFailureError(diagnostic);
    return this.#failureError;
  }

  #diagnosticBytes(): Readonly<{
    stagingBytes: number;
    residentBytes: number;
    textureBytes: number;
    backingBytes: number;
    runtimeBytes: number;
    maxTextureBytes: number;
    maxBackingBytes: number;
    maxRuntimeBytes: number;
  }> {
    try {
      const stagingBytes = this.#stagingBytes();
      const residentBytes = checkedProduct(
        this.#resident.size + this.#reserved.size,
        this.#frameBytes
      );
      const backingBytes = this.#ownedBackingBytes(
        this.#canvas.width,
        this.#canvas.height
      );
      return Object.freeze({
        stagingBytes,
        residentBytes,
        textureBytes: 0,
        backingBytes,
        runtimeBytes: checkedSum([stagingBytes, residentBytes, backingBytes]),
        maxTextureBytes: this.#maxTextureBytes,
        maxBackingBytes: this.#maxBackingBytes,
        maxRuntimeBytes: this.#maxRuntimeBytes
      });
    } catch {
      const materializer = this.#materializer.snapshot();
      return Object.freeze({
        stagingBytes: rendererDiagnosticScalar(materializer.stagingBytes),
        residentBytes: 0,
        textureBytes: 0,
        backingBytes: 0,
        runtimeBytes: rendererDiagnosticScalar(materializer.stagingBytes),
        maxTextureBytes: this.#maxTextureBytes,
        maxBackingBytes: this.#maxBackingBytes,
        maxRuntimeBytes: this.#maxRuntimeBytes
      });
    }
  }

  #backingBytes(outputWidth: number, outputHeight: number): number {
    const raw = checkedSum([
      rgbaBytes(outputWidth, outputHeight),
      rgbaBytes(this.#layout.colorRect[2], this.#layout.colorRect[3]),
      this.#layout.alphaRect === undefined
        ? 0 : rgbaBytes(this.#layout.alphaRect[2], this.#layout.alphaRect[3]),
      this.#materializer.budget().maximumFallbackBackingBytes
    ]);
    return allocationBytes(raw);
  }

  #ownedBackingBytes(outputWidth: number, outputHeight: number): number {
    const materializer = this.#materializer.snapshot();
    const raw = checkedSum([
      rgbaBytes(outputWidth, outputHeight),
      surfaceBytes(this.#colorSurface),
      surfaceBytes(this.#alphaSurface),
      materializer.readbackBackingBytes
    ]);
    return allocationBytes(raw);
  }

  #assertBudget(
    residentCount: number,
    backingBytes: number
  ): Readonly<{ textureBytes: 0; runtimeBytes: number }> {
    const residentBytes = checkedProduct(residentCount, this.#frameBytes);
    // getImageData can briefly own one detached P-sized return allocation in
    // addition to the persistent readback surface and staging buffer.
    const runtimeBytes = checkedSum([
      this.#plannedStagingBytes,
      residentBytes,
      backingBytes,
      this.#materializer.budget().maximumTransientReadbackBytes
    ]);
    if (
      backingBytes > this.#maxBackingBytes ||
      runtimeBytes > this.#maxRuntimeBytes
    ) {
      const error = new RangeError("renderer resource byte cap exceeded");
      error.name = "ResourceBudgetError";
      throw error;
    }
    return Object.freeze({ textureBytes: 0 as const, runtimeBytes });
  }

  #stagingBytes(): number {
    const stagingBytes = this.#materializer.snapshot().stagingBytes;
    if (stagingBytes === 0 && this.#streams.length === 0) return 0;
    return checkedSum([
      stagingBytes,
      ...this.#streams.map((frame) => canvas2dCpuFrameBytes(frame))
    ]);
  }

  #resourceCount(): number {
    if (this.#state === "error" || this.#state === "disposed") return 0;
    return Number(this.#outputContext !== null) +
      Number(this.#colorSurface !== null && this.#colorSurface.context !== null) +
      Number(this.#alphaSurface !== null && this.#alphaSurface.context !== null) +
      this.#materializer.snapshot().resourceCount;
  }

  #releaseCpuStorage(): void {
    this.#materializer.dispose();
    this.#streams = [];
    this.#nextStream = 0;
  }

  #releaseSurfaces(): void {
    releaseCanvas2dSurface(this.#colorSurface);
    releaseCanvas2dSurface(this.#alphaSurface);
    this.#colorSurface = null;
    this.#alphaSurface = null;
  }
}

function surfaceBytes(surface: Canvas2dSurface | null): number {
  return surface === null
    ? 0
    : rgbaBytes(surface.canvas.width, surface.canvas.height);
}

class RendererUnavailableError extends Error {
  public constructor() {
    super("renderer is unavailable");
    this.name = "RendererUnavailableError";
  }
}

function unavailable(): RendererUnavailableError {
  return new RendererUnavailableError();
}
