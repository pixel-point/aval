import {
  createRendererFailureDiagnostic,
  RendererFailureError,
  type RendererDiagnosticOperation,
  type RendererDiagnosticPhase,
  type RendererDiagnosticUploadPath
} from "./renderer-diagnostics.js";
import {
  allocationBytes,
  calculateRendererBacking,
  calculateRendererViewport,
  checkedRenderLayout,
  checkedSum,
  isRendererFit,
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
  RendererBackendArithmeticError,
  RendererBackendFailure,
  type RendererBackend,
  type RendererBackendEvent,
  type RendererBackendSnapshot,
  type RendererBackendTarget
} from "./renderer-backend.js";
import { planWebGl2Memory, WebGl2RendererBackend } from "./webgl2-renderer-backend.js";
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
import type { RendererLimits } from "./renderer-limits.js";
import type {
  RendererContextChange,
  RendererFrameInspector,
  RendererRuntime,
  RendererSnapshot
} from "./renderer-contract.js";

type State = "active" | "lost" | "error" | "disposed";
type LastFrame = number | string;

const STREAMS = 3;

/** WebGL2 orchestration over the low-level backend and RGBA materializer. */
export class WebGl2Renderer implements RendererRuntime {
  readonly #canvas: HTMLCanvasElement;
  readonly #layout: Readonly<RenderLayout>;
  readonly #maxTextureBytes: number;
  readonly #maxBackingBytes: number;
  readonly #maxRuntimeBytes: number;
  readonly #materializer: RgbaMaterializer;
  readonly #operations: RendererOperationCoordinator<RendererFailureError>;
  readonly #onContextChange:
    ((change: Readonly<RendererContextChange>) => void) | undefined;
  readonly #resident = new Map<string, RendererBackendTarget>();
  readonly #reserved = new Set<string>();
  #backend: RendererBackend | null = null;
  #streams: RendererBackendTarget[] = [];
  #nextStream = 0;
  #last: LastFrame | null = null;
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
    limits: Readonly<RendererLimits>
  ) {
    this.#canvas = canvas;
    this.#layout = checkedRenderLayout(layout);
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
    this.#materializer = new RgbaMaterializer(
      this.#layout.storageWidth,
      this.#layout.storageHeight,
      {
        ...(limits.copyTimeoutMs === undefined
          ? {} : { copyTimeoutMs: limits.copyTimeoutMs }),
        ...(limits.setTimeout === undefined ? {} : { setTimeout: limits.setTimeout }),
        ...(limits.clearTimeout === undefined
          ? {} : { clearTimeout: limits.clearTimeout }),
        createCanvas: limits.createCanvas ?? defaultCanvasFactory(canvas)
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
    const oldWidth = canvas.width;
    const oldHeight = canvas.height;
    const operationOrdinal = this.#operations.beginOperation();
    try {
      this.#applyInitialPresentation(limits.initialPresentation, operationOrdinal);
      this.#assertBudget(0, canvas.width, canvas.height);
      const backend: RendererBackend = new WebGl2RendererBackend(
        canvas,
        this.#layout,
        (event) => this.#handleBackendEvent(event)
      );
      this.#backend = backend;
      this.#streams = this.#allocateStreams(backend);
    } catch (reason) {
      const error = reason instanceof RendererBackendFailure
        ? this.#failureFromBackend(reason, "construct", operationOrdinal)
        : reason;
      this.#state = "error";
      this.#backend?.dispose();
      this.#backend = null;
      this.#materializer.dispose();
      try { canvas.width = oldWidth; canvas.height = oldHeight; }
      catch { /* The constructor remains terminal. */ }
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
    const backing = calculateRendererBacking(cssWidth, cssHeight, devicePixelRatio);
    const operationOrdinal = this.#operations.beginOperation();
    const backend = this.#backend;
    if (backend === null) throw unavailable();
    try { backend.validatePresentation(backing.width, backing.height); }
    catch (reason) {
      const error = this.#failure("resize", "runtime", operationOrdinal, reason);
      this.#terminal(error);
      throw error;
    }
    this.#assertBudget(
      this.#resident.size + this.#reserved.size,
      backing.width,
      backing.height
    );
    try {
      this.#setBacking(backing.width, backing.height, "runtime", operationOrdinal);
      this.#cssWidth = Math.max(1, cssWidth);
      this.#cssHeight = Math.max(1, cssHeight);
      this.#dpr = backing.dpr;
      this.#fit = fit;
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
      ).catch(() => undefined).finally(() => { this.#resizeQueued = false; });
    }
  }

  public draw(frame: VideoFrame): Promise<void> {
    return this.#operations.enqueue("runtime", async (operationOrdinal) => {
      if (this.#state === "lost") { this.#last = null; throw unavailable(); }
      const slot = this.#nextStream;
      const target = this.#streams[slot];
      if (target === undefined) throw unavailable();
      await this.#upload(target, frame, operationOrdinal);
      if (this.#state !== "active") throw unavailable();
      this.#drawTarget(target, "runtime", operationOrdinal);
      this.#last = slot;
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
      if (this.#state === "lost") throw unavailable();
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
        this.#uploadRgba(target, source, operationOrdinal);
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
      this.#canvas.width,
      this.#canvas.height
    );
    this.#reserved.add(key);
    return this.#operations.enqueue("runtime", async (operationOrdinal) => {
      const materialization = this.#createMaterialization(frame, operationOrdinal);
      try {
        const source = await this.#materialize(materialization, operationOrdinal);
        if (this.#state !== "active") throw unavailable();
        const backend = this.#activeBackend();
        let target: RendererBackendTarget | null = null;
        try {
          target = backend.allocateTarget("resident", 0);
          this.#uploadRgba(target, source, operationOrdinal);
          if (this.#state !== "active") throw unavailable();
          this.#resident.set(key, target);
          target = null;
        } catch (reason) {
          if (target !== null) backend.releaseTarget(target);
          throw reason;
        }
      } finally {
        materialization.release();
      }
    }).finally(() => { this.#reserved.delete(key); });
  }

  public drawStored(group: string, index: number): Promise<void> {
    const key = rendererResidentKey(group, index);
    if (!this.#resident.has(key)) throw new Error("resident frame is unavailable");
    return this.#operations.enqueue("runtime", (operationOrdinal) => {
      if (this.#state === "lost") throw unavailable();
      const target = this.#resident.get(key);
      if (target === undefined) throw unavailable();
      this.#drawTarget(target, "runtime", operationOrdinal);
      this.#last = key;
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
      this.#canvas.width,
      this.#canvas.height
    );
  }

  public snapshot(): Readonly<RendererSnapshot> {
    const materializer = this.#materializer.snapshot();
    const backend = this.#backendSnapshot();
    const backingBytes = allocationBytes(checkedSum([
      backend.memory.backingRawBytes,
      materializer.readbackBackingBytes
    ]));
    const stagingBytes = checkedSum([
      materializer.stagingBytes,
      backend.memory.stagingBytes
    ]);
    const runtimeBytes = this.#state === "disposed" ? 0 : checkedSum([
      stagingBytes,
      backend.memory.residentBytes,
      backend.memory.textureBytes,
      backingBytes,
      backend.memory.runtimeOverheadBytes
    ]);
    return Object.freeze({
      backendDetails: backend.details,
      cssWidth: this.#cssWidth,
      cssHeight: this.#cssHeight,
      backingWidth: this.#canvas.width,
      backingHeight: this.#canvas.height,
      effectiveDprX: this.#cssWidth > 0 ? this.#canvas.width / this.#cssWidth : 0,
      effectiveDprY: this.#cssHeight > 0 ? this.#canvas.height / this.#cssHeight : 0,
      contextLossCount: this.#losses,
      contextRecoveryCount: this.#recoveries,
      stagingBytes: this.#state === "disposed" ? 0 : stagingBytes,
      residentBytes: this.#state === "disposed" ? 0 : backend.memory.residentBytes,
      textureBytes: this.#state === "disposed" ? 0 : backend.memory.textureBytes,
      runtimeBytes,
      pendingOperations: this.#operations.pendingOperations,
      sourceCopiesInFlight: materializer.sourceCopiesInFlight,
      resourceCount: backend.resourceCount + materializer.resourceCount,
      contextListenerCount: backend.contextListenerCount,
      failure: this.#failureError?.diagnostic ?? null
    });
  }

  public dispose(): void {
    if (this.#state === "disposed") return;
    this.#state = "disposed";
    this.#backend?.dispose();
    this.#resident.clear();
    this.#reserved.clear();
    this.#streams = [];
    this.#last = null;
    this.#materializer.dispose();
    this.#releaseOutputBacking();
  }

  #classifyOperationFailure(
    reason: unknown,
    operation: RendererDiagnosticOperation,
    operationOrdinal: number
  ): RendererFailureError | null {
    if (this.#state !== "active" && namedError(reason, "AbortError")) {
      return null;
    }
    if (reason instanceof RendererFailureError) return reason;
    if (reason instanceof RendererBackendArithmeticError) return null;
    return reason instanceof RendererBackendFailure
      ? this.#failureFromBackend(reason, operation, operationOrdinal)
      : this.#failure("context-event", operation, operationOrdinal, reason);
  }

  #handleBackendEvent(event: Readonly<RendererBackendEvent>): void {
    if (event.kind === "restore") { this.#queueRestore(); return; }
    if (this.#state !== "active") return;
    this.#state = "lost";
    this.#losses += 1;
    this.#streams = [];
    this.#resident.clear();
    this.#reserved.clear();
    this.#last = null;
    this.#nextStream = 0;
    this.#materializer.reset();
    this.#notify(Object.freeze({ state: "lost", error: null }));
  }

  #queueRestore(): void {
    if (this.#state !== "lost") return;
    void this.#operations.enqueueIf(
      "restore",
      () => this.#state === "lost",
      (ordinal) => {
        const backend = this.#activeBackend(false);
        this.#assertBudget(
          this.#resident.size, this.#canvas.width, this.#canvas.height
        );
        backend.restore();
        this.#streams = this.#allocateStreams(backend);
        this.#state = "active";
        this.#recoveries += 1;
        this.#notify(Object.freeze({ state: "restored", error: null }));
        if (this.#last !== null) this.#drawLast("restore", ordinal);
      }
    ).catch(() => undefined);
  }

  async #upload(
    target: RendererBackendTarget,
    frame: VideoFrame,
    operationOrdinal: number
  ): Promise<void> {
    const materialization = this.#createMaterialization(frame, operationOrdinal);
    try {
      await this.#uploadMaterialization(target, materialization, operationOrdinal);
    } finally {
      materialization.release();
    }
  }

  async #uploadMaterialization(
    target: RendererBackendTarget,
    materialization: Readonly<RgbaMaterialization>,
    operationOrdinal: number
  ): Promise<void> {
    try {
      await this.#activeBackend().upload(target, materialization);
      if (this.#state !== "active") throw unavailable();
    } catch (reason) {
      if (this.#state !== "active") throw unavailable();
      if (reason instanceof MaterializerFailureError) throw this.#failure(
        "rgba-copy",
        "runtime",
        operationOrdinal,
        reason.reason,
        { uploadPath: "rgba-copy" }
      );
      if (reason instanceof RendererBackendFailure) {
        throw this.#failureFromBackend(reason, "runtime", operationOrdinal);
      }
      throw reason;
    }
  }

  #createMaterialization(
    frame: VideoFrame,
    operationOrdinal: number
  ): Readonly<RgbaMaterialization> {
    let rect: DOMRectReadOnly;
    try { rect = validateRenderFrame(frame, this.#layout); }
    catch (reason) {
      throw this.#failure("semantic-upload", "runtime", operationOrdinal, reason);
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
      if (reason instanceof MaterializerFailureError) throw this.#failure(
        "rgba-copy",
        "runtime",
        operationOrdinal,
        reason.reason,
        { uploadPath: "rgba-copy" }
      );
      throw reason;
    }
  }

  #uploadRgba(
    target: RendererBackendTarget,
    source: Readonly<MaterializedRgbaFrame>,
    operationOrdinal: number
  ): void {
    try {
      this.#activeBackend().uploadRgba(target, source);
      if (this.#state !== "active") throw unavailable();
    } catch (reason) {
      if (this.#state !== "active") throw unavailable();
      if (reason instanceof RendererBackendFailure) {
        throw this.#failureFromBackend(reason, "runtime", operationOrdinal);
      }
      throw reason;
    }
  }

  #drawTarget(
    target: RendererBackendTarget,
    operation: RendererDiagnosticOperation,
    operationOrdinal: number
  ): void {
    const viewport = calculateRendererViewport(
      this.#layout,
      this.#canvas.width,
      this.#canvas.height,
      this.#dpr,
      this.#fit
    );
    try { this.#activeBackend().draw(target, viewport); }
    catch (reason) {
      if (reason instanceof RendererBackendFailure) {
        throw this.#failureFromBackend(reason, operation, operationOrdinal);
      }
      throw reason;
    }
    if (this.#state !== "active") throw unavailable();
  }

  #drawLast(
    operation: RendererDiagnosticOperation,
    operationOrdinal: number
  ): void {
    const last = this.#last;
    if (last === null) return;
    const target = typeof last === "number"
      ? this.#streams[last]
      : this.#resident.get(last);
    if (target !== undefined) {
      this.#drawTarget(target, operation, operationOrdinal);
    }
  }

  #allocateStreams(backend: RendererBackend): RendererBackendTarget[] {
    const streams: RendererBackendTarget[] = [];
    try {
      for (let ordinal = 0; ordinal < STREAMS; ordinal += 1) {
        streams.push(backend.allocateTarget("stream", ordinal));
      }
      return streams;
    } catch (reason) {
      for (const target of streams) backend.releaseTarget(target);
      throw reason;
    }
  }

  #applyInitialPresentation(
    initial: RendererLimits["initialPresentation"],
    operationOrdinal: number
  ): void {
    if (initial === undefined) return;
    if (!isRendererFit(initial.fit)) {
      throw new RangeError("renderer presentation geometry is invalid");
    }
    const backing = calculateRendererBacking(initial.width, initial.height, initial.dpr);
    this.#setBacking(backing.width, backing.height, "construct", operationOrdinal);
    this.#cssWidth = Math.max(1, initial.width);
    this.#cssHeight = Math.max(1, initial.height);
    this.#dpr = backing.dpr;
    this.#fit = initial.fit;
  }

  #setBacking(
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
      try { this.#canvas.width = oldWidth; this.#canvas.height = oldHeight; }
      catch { /* classified below */ }
      throw error;
    }
  }

  #assertBudget(
    residentCount: number,
    backingWidth: number,
    backingHeight: number
  ): Readonly<{ textureBytes: number; runtimeBytes: number }> {
    const plannedTargetCount = checkedSum([residentCount, STREAMS]);
    const backend = this.#backend;
    const memory = backend === null || this.#state === "lost"
      ? planWebGl2Memory(this.#layout, residentCount, plannedTargetCount,
          backingWidth, backingHeight)
      : backend.plannedMemory(residentCount, plannedTargetCount,
          backingWidth, backingHeight);
    const materializer = this.#materializer.budget();
    const backingBytes = allocationBytes(checkedSum([
      memory.backingRawBytes,
      materializer.maximumFallbackBackingBytes
    ]));
    const runtimeBytes = checkedSum([
      memory.stagingBytes,
      memory.residentBytes,
      memory.textureBytes,
      backingBytes,
      memory.runtimeOverheadBytes,
      materializer.stagingBytes,
      materializer.maximumTransientReadbackBytes
    ]);
    if (
      memory.textureBytes > this.#maxTextureBytes ||
      backingBytes > this.#maxBackingBytes ||
      runtimeBytes > this.#maxRuntimeBytes
    ) {
      const error = new RangeError("renderer resource byte cap exceeded");
      error.name = "ResourceBudgetError";
      throw error;
    }
    return Object.freeze({ textureBytes: memory.textureBytes, runtimeBytes });
  }

  #terminal(error: RendererFailureError): void {
    if (this.#state === "disposed" || this.#state === "error") return;
    this.#state = "error";
    this.#failureError = error;
    this.#backend?.dispose();
    this.#resident.clear();
    this.#reserved.clear();
    this.#streams = [];
    this.#last = null;
    this.#materializer.dispose();
    this.#releaseOutputBacking();
    this.#notify(Object.freeze({ state: "error", error }));
  }

  #releaseOutputBacking(): void {
    try { this.#canvas.width = 0; this.#canvas.height = 0; }
    catch { /* terminal cleanup */ }
  }

  #notify(change: Readonly<RendererContextChange>): void {
    queueMicrotask(() => {
      try { this.#onContextChange?.(change); }
      catch { /* Host callbacks are isolated. */ }
    });
  }

  #failureFromBackend(
    failure: RendererBackendFailure,
    operation: RendererDiagnosticOperation,
    operationOrdinal: number
  ): RendererFailureError {
    const evidence = failure.evidence;
    return this.#failure(
      evidence.phase,
      operation,
      operationOrdinal,
      evidence.reason,
      evidence,
      failure.snapshot
    );
  }

  #failure(
    phase: RendererDiagnosticPhase,
    operation: RendererDiagnosticOperation,
    operationOrdinal: number,
    reason: unknown,
    details: Readonly<{
      glError?: number | null;
      contextLost?: boolean;
      uploadPath?: RendererDiagnosticUploadPath | null;
      textureOrdinal?: number | null;
    }> = {},
    failureSnapshot: Readonly<RendererBackendSnapshot> | null = null
  ): RendererFailureError {
    if (reason instanceof RendererFailureError) return reason;
    if (this.#failureError !== null) return this.#failureError;
    const backend = failureSnapshot ?? this.#backendSnapshot();
    const diagnostic = createRendererFailureDiagnostic({
      backend: "webgl2",
      phase,
      operation,
      operationOrdinal,
      reason,
      glError: details.glError ?? null,
      contextLost: details.contextLost ?? false,
      uploadPath: details.uploadPath ?? null,
      textureOrdinal: details.textureOrdinal ?? null,
      layout: this.#layout,
      backing: {
        width: rendererDiagnosticScalar(this.#canvas.width),
        height: rendererDiagnosticScalar(this.#canvas.height)
      },
      bytes: this.#diagnosticBytes(backend),
      limits: backend.limits,
      contextAttributes: backend.contextAttributes,
      vendor: backend.vendor,
      renderer: backend.renderer
    });
    this.#failureError = new RendererFailureError(diagnostic);
    return this.#failureError;
  }

  #diagnosticBytes(backend: Readonly<RendererBackendSnapshot>): Readonly<{
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
      const materializer = this.#materializer.snapshot();
      const backingBytes = allocationBytes(checkedSum([
        backend.memory.backingRawBytes,
        materializer.readbackBackingBytes
      ]));
      const stagingBytes = checkedSum([
        backend.memory.stagingBytes,
        materializer.stagingBytes
      ]);
      return Object.freeze({
        stagingBytes,
        residentBytes: backend.memory.residentBytes,
        textureBytes: backend.memory.textureBytes,
        backingBytes,
        runtimeBytes: checkedSum([
          stagingBytes,
          backend.memory.residentBytes,
          backend.memory.textureBytes,
          backingBytes,
          backend.memory.runtimeOverheadBytes
        ]),
        maxTextureBytes: this.#maxTextureBytes,
        maxBackingBytes: this.#maxBackingBytes,
        maxRuntimeBytes: this.#maxRuntimeBytes
      });
    } catch {
      return Object.freeze({
        stagingBytes: rendererDiagnosticScalar(
          this.#materializer.snapshot().stagingBytes
        ),
        residentBytes: 0,
        textureBytes: 0,
        backingBytes: 0,
        runtimeBytes: rendererDiagnosticScalar(
          this.#materializer.snapshot().stagingBytes
        ),
        maxTextureBytes: this.#maxTextureBytes,
        maxBackingBytes: this.#maxBackingBytes,
        maxRuntimeBytes: this.#maxRuntimeBytes
      });
    }
  }

  #backendSnapshot(): Readonly<RendererBackendSnapshot> {
    const backend = this.#backend;
    if (backend !== null) return backend.snapshot(
      this.#resident.size,
      this.#canvas.width,
      this.#canvas.height
    );
    return emptyBackendSnapshot();
  }

  #activeBackend(requireActive = true): RendererBackend {
    const backend = this.#backend;
    if (backend === null || requireActive && this.#state !== "active") {
      throw unavailable();
    }
    return backend;
  }
}

function emptyBackendSnapshot(): Readonly<RendererBackendSnapshot> {
  return Object.freeze({
    details: Object.freeze({
      kind: "webgl2" as const,
      uploadMode: "native-probing" as const,
      nativeProbeAttempts: 0, probeReadbackBytes: 0, nativeProbeInFlight: false
    }),
    memory: Object.freeze({
      stagingBytes: 0, residentBytes: 0, textureBytes: 0,
      backingRawBytes: 0, runtimeOverheadBytes: 0
    }),
    resourceCount: 0,
    contextListenerCount: 0,
    limits: Object.freeze({
      maxTextureSize: 0, maxViewportWidth: 0,
      maxViewportHeight: 0, maxResidentTextures: 0
    }),
    contextAttributes: null, vendor: null, renderer: null
  });
}

function unavailable(): DOMException {
  return new DOMException("WebGL renderer is unavailable", "AbortError");
}
