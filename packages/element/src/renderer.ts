import { Canvas2dRenderer } from "./canvas2d-renderer.js";
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
import { selectRendererBackend } from "./renderer-selection.js";
import { planWebGl2Memory, WebGl2RendererBackend } from "./webgl2-renderer-backend.js";
import type {
  RendererContextChange,
  RendererRuntime,
  RendererSnapshot
} from "./renderer-contract.js";

export type { RenderLayout } from "./renderer-geometry.js";
export type {
  RendererBackendDetails,
  RendererContextChange,
  RendererSnapshot,
  RendererUploadMode
} from "./renderer-contract.js";

export interface RendererLimits {
  readonly maxTextureBytes?: number;
  readonly maxBackingBytes?: number;
  readonly maxRuntimeBytes?: number;
  readonly copyTimeoutMs?: number;
  readonly setTimeout?: (callback: () => void, delay: number) => number;
  readonly clearTimeout?: (handle: number) => void;
  readonly createCanvas?: (width: number, height: number) => HTMLCanvasElement;
  readonly onContextChange?: (change: Readonly<RendererContextChange>) => void;
  readonly initialPresentation?: Readonly<{
    width: number;
    height: number;
    dpr: number;
    fit: string;
  }>;
}

type State = "active" | "lost" | "error" | "disposed";
type LastFrame = number | string;

const HARD_BYTES = Number.MAX_SAFE_INTEGER;
const STREAMS = 3;
const ID = /^[a-z][a-z0-9._-]{0,63}$/;

/** Stable public renderer; backend selection remains exact-null only. */
export class Renderer implements RendererRuntime {
  readonly #runtime: RendererRuntime;

  public constructor(
    canvas: HTMLCanvasElement,
    layout: Readonly<RenderLayout>,
    limits: Readonly<RendererLimits> = {}
  ) {
    this.#runtime = selectRendererBackend<RendererRuntime>(
      () => new WebGl2Renderer(canvas, layout, limits),
      () => new Canvas2dRenderer(canvas, layout, limits)
    );
  }

  public resize(
    cssWidth: number,
    cssHeight: number,
    devicePixelRatio: number,
    fit: string
  ): void {
    this.#runtime.resize(cssWidth, cssHeight, devicePixelRatio, fit);
  }
  public draw(frame: VideoFrame): Promise<void> { return this.#runtime.draw(frame); }
  public store(group: string, index: number, frame: VideoFrame): Promise<void> {
    return this.#runtime.store(group, index, frame);
  }
  public drawStored(group: string, index: number): Promise<void> {
    return this.#runtime.drawStored(group, index);
  }
  public settled(): Promise<void> { return this.#runtime.settled(); }
  public admit(residentCount: number): Readonly<{
    textureBytes: number;
    runtimeBytes: number;
  }> { return this.#runtime.admit(residentCount); }
  public snapshot(): Readonly<RendererSnapshot> { return this.#runtime.snapshot(); }
  public dispose(): void { this.#runtime.dispose(); }
}

/** Temporary WebGL orchestration; the next slice moves it into the controller. */
class WebGl2Renderer implements RendererRuntime {
  readonly #canvas: HTMLCanvasElement;
  readonly #layout: Readonly<RenderLayout>;
  readonly #maxTextureBytes: number;
  readonly #maxBackingBytes: number;
  readonly #maxRuntimeBytes: number;
  readonly #materializer: RgbaMaterializer;
  readonly #onContextChange:
    ((change: Readonly<RendererContextChange>) => void) | undefined;
  readonly #resident = new Map<string, RendererBackendTarget>();
  readonly #reserved = new Set<string>();
  #backend: RendererBackend | null = null;
  #streams: RendererBackendTarget[] = [];
  #nextStream = 0;
  #last: LastFrame | null = null;
  #state: State = "active";
  #tail: Promise<void> = Promise.resolve();
  #pending = 0;
  #resizeQueued = false;
  #fit: RendererFit = "contain";
  #cssWidth = 0;
  #cssHeight = 0;
  #dpr = 1;
  #losses = 0;
  #recoveries = 0;
  #operationSequence = 0;
  #failureError: RendererFailureError | null = null;

  public constructor(
    canvas: HTMLCanvasElement,
    layout: Readonly<RenderLayout>,
    limits: Readonly<RendererLimits>
  ) {
    this.#canvas = canvas;
    this.#layout = checkedRenderLayout(layout);
    this.#maxTextureBytes = cap(limits.maxTextureBytes, "texture byte cap");
    this.#maxBackingBytes = cap(limits.maxBackingBytes, "backing byte cap");
    this.#maxRuntimeBytes = cap(limits.maxRuntimeBytes, "runtime byte cap");
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
    const oldWidth = canvas.width;
    const oldHeight = canvas.height;
    const operationOrdinal = this.#beginOperation();
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
    const operationOrdinal = this.#beginOperation();
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
    this.#setBacking(backing.width, backing.height, "runtime", operationOrdinal);
    this.#cssWidth = Math.max(1, cssWidth);
    this.#cssHeight = Math.max(1, cssHeight);
    this.#dpr = backing.dpr;
    this.#fit = fit;
    if (this.#last !== null && !this.#resizeQueued) {
      this.#resizeQueued = true;
      void this.#enqueue(() => {
        if (this.#state === "active") return this.#operate(
          "runtime",
          (ordinal) => this.#drawLast("runtime", ordinal)
        );
        return undefined;
      }).catch(() => undefined).finally(() => { this.#resizeQueued = false; });
    }
  }

  public draw(frame: VideoFrame): Promise<void> {
    return this.#enqueue(async () => {
      if (this.#state === "lost") { this.#last = null; throw unavailable(); }
      await this.#operate("runtime", async (operationOrdinal) => {
        const slot = this.#nextStream;
        const target = this.#streams[slot];
        if (target === undefined) throw unavailable();
        await this.#upload(target, frame, operationOrdinal);
        if (this.#state !== "active") throw unavailable();
        this.#drawTarget(target, "runtime", operationOrdinal);
        this.#last = slot;
        this.#nextStream = (slot + 1) % STREAMS;
      });
    });
  }

  public store(group: string, index: number, frame: VideoFrame): Promise<void> {
    const key = residentKey(group, index);
    if (this.#resident.has(key) || this.#reserved.has(key)) {
      throw new Error("resident frame already exists");
    }
    this.#assertBudget(
      this.#resident.size + this.#reserved.size + 1,
      this.#canvas.width,
      this.#canvas.height
    );
    this.#reserved.add(key);
    return this.#enqueue(() => this.#operate("runtime", async (operationOrdinal) => {
      const materialization = this.#createMaterialization(frame, operationOrdinal);
      try {
        const source = await this.#materialize(materialization, operationOrdinal);
        if (this.#state !== "active") throw unavailable();
        const backend = this.#activeBackend();
        let target: RendererBackendTarget | null = null;
        try {
          target = backend.allocateTarget("resident", 0);
          backend.uploadRgba(target, source);
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
    })).finally(() => { this.#reserved.delete(key); });
  }

  public drawStored(group: string, index: number): Promise<void> {
    const key = residentKey(group, index);
    if (!this.#resident.has(key)) throw new Error("resident frame is unavailable");
    return this.#enqueue(() => {
      if (this.#state === "lost") throw unavailable();
      return this.#operate("runtime", (operationOrdinal) => {
        const target = this.#resident.get(key);
        if (target === undefined) throw unavailable();
        this.#drawTarget(target, "runtime", operationOrdinal);
        this.#last = key;
      });
    });
  }

  public settled(): Promise<void> { return this.#tail; }

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
      pendingOperations: this.#pending,
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
    try { this.#canvas.width = 0; this.#canvas.height = 0; }
    catch { /* terminal cleanup */ }
  }

  #enqueue<T>(task: () => T | Promise<T>): Promise<T> {
    if (this.#state === "disposed" || this.#state === "error") {
      return Promise.reject(unavailable());
    }
    this.#pending += 1;
    const job = this.#tail.then(async () => {
      if (this.#state === "disposed" || this.#state === "error") {
        throw unavailable();
      }
      try { return await task(); }
      catch (reason) {
        if (reason instanceof RendererFailureError) {
          if (this.#state === "active" || this.#state === "lost") {
            this.#terminal(reason);
          }
        }
        throw reason;
      }
    }).finally(() => { this.#pending -= 1; });
    this.#tail = job.then(() => undefined, () => undefined);
    return job;
  }

  async #operate<T>(
    operation: RendererDiagnosticOperation,
    task: (operationOrdinal: number) => T | Promise<T>
  ): Promise<T> {
    const operationOrdinal = this.#beginOperation();
    try { return await task(operationOrdinal); }
    catch (reason) {
      if (
        reason instanceof RendererFailureError ||
        reason instanceof RendererBackendArithmeticError ||
        this.#state !== "active" && isAbortError(reason)
      ) throw reason;
      throw reason instanceof RendererBackendFailure
        ? this.#failureFromBackend(reason, operation, operationOrdinal)
        : this.#failure(
            "context-event",
            operation,
            operationOrdinal,
            reason
          );
    }
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
    this.#pending += 1;
    const restore = this.#tail.then(() => {
      if (this.#state !== "lost") return;
      const ordinal = this.#beginOperation();
      try {
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
      } catch (reason) {
        const error = reason instanceof RendererBackendFailure
          ? this.#failureFromBackend(reason, "restore", ordinal)
          : this.#failure("context-event", "restore", ordinal, reason);
        this.#terminal(error);
      }
    }).finally(() => { this.#pending -= 1; });
    this.#tail = restore.then(() => undefined, () => undefined);
  }

  async #upload(
    target: RendererBackendTarget,
    frame: VideoFrame,
    operationOrdinal: number
  ): Promise<void> {
    const materialization = this.#createMaterialization(frame, operationOrdinal);
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
    } finally {
      materialization.release();
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
    this.#backend?.deactivate();
    this.#resident.clear();
    this.#reserved.clear();
    this.#streams = [];
    this.#last = null;
    this.#materializer.dispose();
    this.#notify(Object.freeze({ state: "error", error }));
  }

  #notify(change: Readonly<RendererContextChange>): void {
    queueMicrotask(() => {
      try { this.#onContextChange?.(change); }
      catch { /* Host callbacks are isolated. */ }
    });
  }

  #beginOperation(): number {
    if (this.#operationSequence === Number.MAX_SAFE_INTEGER) {
      throw new RangeError("renderer operation identity is exhausted");
    }
    const ordinal = this.#operationSequence;
    this.#operationSequence += 1;
    return ordinal;
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
        width: diagnosticScalar(this.#canvas.width),
        height: diagnosticScalar(this.#canvas.height)
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
        stagingBytes: diagnosticScalar(this.#materializer.snapshot().stagingBytes),
        residentBytes: 0,
        textureBytes: 0,
        backingBytes: 0,
        runtimeBytes: diagnosticScalar(this.#materializer.snapshot().stagingBytes),
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

function residentKey(group: string, index: number): string {
  if (!ID.test(group) || !Number.isSafeInteger(index) || index < 0) {
    throw new RangeError("resident frame key is invalid");
  }
  return `${group}\0${String(index)}`;
}

function cap(value: number | undefined, label: string): number {
  if (value === undefined) return HARD_BYTES;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${label} is invalid`);
  }
  return Math.min(value, HARD_BYTES);
}

function diagnosticScalar(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value : 0;
}

function isAbortError(reason: unknown): boolean {
  if (typeof reason !== "object" || reason === null) return false;
  try { return (reason as Readonly<{ name?: unknown }>).name === "AbortError"; }
  catch { return false; }
}

function unavailable(): DOMException {
  return new DOMException("WebGL renderer is unavailable", "AbortError");
}
