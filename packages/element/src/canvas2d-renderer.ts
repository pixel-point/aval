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
  RgbaMaterializer
} from "./rgba-materializer.js";
import type {
  RendererContextChange,
  RendererSnapshot
} from "./renderer-contract.js";

export interface Canvas2dRendererLimits {
  readonly maxTextureBytes?: number;
  readonly maxBackingBytes?: number;
  readonly maxRuntimeBytes?: number;
  readonly copyTimeoutMs?: number;
  readonly setTimeout?: (callback: () => void, delay: number) => number;
  readonly clearTimeout?: (handle: number) => void;
  readonly onContextChange?: (change: Readonly<RendererContextChange>) => void;
  readonly initialPresentation?: Readonly<{
    width: number;
    height: number;
    dpr: number;
    fit: string;
  }>;
  /** Internal deterministic surface factory; production uses ownerDocument. */
  readonly createCanvas?: (width: number, height: number) => HTMLCanvasElement;
}

type State = "active" | "lost" | "error" | "disposed";

interface CpuFrame {
  readonly color: Uint8ClampedArray;
  readonly alpha: Uint8ClampedArray | null;
}

type LastFrame =
  | Readonly<{ kind: "stream"; index: number }>
  | Readonly<{ kind: "resident"; key: string }>;

interface Surface {
  readonly canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D | null;
}

const HARD_BYTES = Number.MAX_SAFE_INTEGER;
const STREAMS = 3;
const ID = /^[a-z][a-z0-9._-]{0,63}$/;

/** Canvas2D presentation backend used only after exact-null WebGL2 creation. */
export class Canvas2dRenderer {
  readonly #canvas: HTMLCanvasElement;
  readonly #layout: Readonly<RenderLayout>;
  readonly #frameBytes: number;
  readonly #plannedStagingBytes: number;
  readonly #maxTextureBytes: number;
  readonly #maxBackingBytes: number;
  readonly #maxRuntimeBytes: number;
  readonly #createCanvas: (width: number, height: number) => HTMLCanvasElement;
  readonly #materializer: RgbaMaterializer;
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
  #colorSurface: Surface | null = null;
  #alphaSurface: Surface | null = null;
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
    this.#maxTextureBytes = cap(limits.maxTextureBytes, "texture byte cap");
    this.#maxBackingBytes = cap(limits.maxBackingBytes, "backing byte cap");
    this.#maxRuntimeBytes = cap(limits.maxRuntimeBytes, "runtime byte cap");
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

    const operationOrdinal = this.#beginOperation();
    let listeners = false;
    try {
      if (initial !== undefined) {
        this.#setOutputBacking(width, height, "construct", operationOrdinal);
      }
      const backingBytes = this.#backingBytes(width, height);
      this.#assertBudget(0, backingBytes);
      this.#streams = Array.from({ length: STREAMS }, () => this.#newFrame());
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
    const operationOrdinal = this.#beginOperation();
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
      if (this.#outputContext !== null) configureContext(this.#outputContext);
    } catch (reason) {
      const error = reason instanceof RendererFailureError
        ? reason
        : this.#failure("resize", "runtime", operationOrdinal, reason);
      this.#terminal(error);
      throw error;
    }
    if (this.#last !== null && !this.#resizeQueued) {
      this.#resizeQueued = true;
      void this.#enqueue(() => {
        if (this.#state === "active") {
          this.#drawLast("runtime", this.#beginOperation());
        }
      }).catch(() => undefined).finally(() => {
        this.#resizeQueued = false;
      });
    }
  }

  public draw(frame: VideoFrame): Promise<void> {
    return this.#enqueue(async () => {
      if (this.#state !== "active") throw unavailable();
      const operationOrdinal = this.#beginOperation();
      const slot = this.#nextStream;
      const buffer = this.#streams[slot];
      if (buffer === undefined) throw unavailable();
      await this.#materialize(frame, buffer, operationOrdinal);
      if (this.#state !== "active") throw unavailable();
      this.#render(buffer, "runtime", operationOrdinal);
      this.#last = Object.freeze({ kind: "stream", index: slot });
      this.#nextStream = (slot + 1) % STREAMS;
    });
  }

  public store(group: string, index: number, frame: VideoFrame): Promise<void> {
    const key = residentKey(group, index);
    if (this.#resident.has(key) || this.#reserved.has(key)) {
      throw new Error("resident frame already exists");
    }
    this.#assertBudget(
      this.#resident.size + this.#reserved.size + 1,
      this.#backingBytes(this.#canvas.width, this.#canvas.height)
    );
    this.#reserved.add(key);
    return this.#enqueue(async () => {
      const operationOrdinal = this.#beginOperation();
      const buffer = this.#newFrame();
      await this.#materialize(frame, buffer, operationOrdinal);
      if (this.#state !== "active") throw unavailable();
      this.#resident.set(key, buffer);
    }).finally(() => {
      this.#reserved.delete(key);
    });
  }

  public drawStored(group: string, index: number): Promise<void> {
    const key = residentKey(group, index);
    if (!this.#resident.has(key)) {
      throw new Error("resident frame is unavailable");
    }
    return this.#enqueue(() => {
      if (this.#state !== "active") throw unavailable();
      const operationOrdinal = this.#beginOperation();
      const buffer = this.#resident.get(key);
      if (buffer === undefined) throw unavailable();
      this.#render(buffer, "runtime", operationOrdinal);
      this.#last = Object.freeze({ kind: "resident", key });
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
        pendingOperations: this.#pending,
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
      pendingOperations: this.#pending,
      sourceCopiesInFlight: materializer.sourceCopiesInFlight,
      resourceCount: this.#resourceCount(),
      contextListenerCount: 2,
      failure: this.#failureError?.diagnostic ?? null
    });
  }

  public dispose(): void {
    if (this.#state === "disposed") return;
    this.#state = "disposed";
    this.#canvas.removeEventListener("contextlost", this.#lost);
    this.#canvas.removeEventListener("contextrestored", this.#restored);
    this.#resident.clear();
    this.#reserved.clear();
    this.#last = null;
    this.#releaseCpuStorage();
    this.#releaseSurfaces();
    this.#outputContext = null;
    try {
      this.#canvas.width = 0;
      this.#canvas.height = 0;
    } catch { /* terminal cleanup */ }
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
      try {
        return await task();
      } catch (reason) {
        if (
          this.#isDisposed() ||
          this.#state === "lost" && reason instanceof RendererUnavailableError
        ) throw unavailable();
        const error = reason instanceof RendererFailureError
          ? reason
          : this.#failure(
              "context-event",
              "runtime",
              this.#beginOperation(),
              reason
            );
        if (this.#state === "active" || this.#state === "lost") {
          this.#terminal(error);
        }
        throw error;
      }
    }).finally(() => {
      this.#pending -= 1;
    });
    this.#tail = job.then(() => undefined, () => undefined);
    return job;
  }

  #queueRestore(): void {
    if (this.#state !== "lost") return;
    this.#pending += 1;
    const restore = this.#tail.then(() => {
      if (this.#state !== "lost") return;
      const operationOrdinal = this.#beginOperation();
      try {
        this.#initializeContexts("restore", operationOrdinal, true);
        this.#state = "active";
        this.#drawLast("restore", operationOrdinal);
        this.#recoveries += 1;
        this.#notify(Object.freeze({ state: "restored", error: null }));
      } catch (reason) {
        const error = reason instanceof RendererFailureError
          ? reason
          : this.#failure("context-event", "restore", operationOrdinal, reason);
        this.#terminal(error);
      }
    }).finally(() => {
      this.#pending -= 1;
    });
    this.#tail = restore.then(() => undefined, () => undefined);
  }

  #initializeContexts(
    operation: RendererDiagnosticOperation,
    operationOrdinal: number,
    restore = false
  ): void {
    try {
      if (!restore) {
        this.#colorSurface = this.#newSurface(
          this.#layout.colorRect[2],
          this.#layout.colorRect[3]
        );
        this.#alphaSurface = this.#layout.alphaRect === undefined
          ? null
          : this.#newSurface(
              this.#layout.alphaRect[2],
              this.#layout.alphaRect[3]
            );
      } else {
        this.#reacquireSurface(this.#colorSurface);
        if (this.#alphaSurface !== null) {
          this.#reacquireSurface(this.#alphaSurface);
        }
      }
      const output = canvasContext(this.#canvas);
      if (output === null) throw new Error("Canvas2D output context is unavailable");
      assertContextAvailable(output);
      configureContext(output);
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

  #newSurface(width: number, height: number): Surface {
    const canvas = this.#createCanvas(width, height);
    try {
      canvas.width = width;
      canvas.height = height;
      if (canvas.width !== width || canvas.height !== height) {
        throw new Error("Canvas2D scratch surface rejected its dimensions");
      }
      const context = canvasContext(canvas);
      if (context === null) throw new Error("Canvas2D scratch context is unavailable");
      assertContextAvailable(context);
      configureContext(context);
      return { canvas, context };
    } catch (reason) {
      try {
        canvas.width = 0;
        canvas.height = 0;
      } catch { /* Preserve the context-creation cause. */ }
      throw reason;
    }
  }

  #reacquireSurface(surface: Surface | null): void {
    if (surface === null) throw new Error("Canvas2D scratch surface is unavailable");
    const context = canvasContext(surface.canvas);
    if (context === null) throw new Error("Canvas2D scratch context is unavailable");
    assertContextAvailable(context);
    configureContext(context);
    surface.context = context;
  }

  async #materialize(
    frame: VideoFrame,
    target: CpuFrame,
    operationOrdinal: number
  ): Promise<void> {
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
    const materialization = this.#materializer.create(frame, rect);
    try {
      const source = await materialization.rgba();
      if (this.#state !== "active") throw unavailable();
      this.#extract(target, source.pixels);
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
    } finally {
      materialization.release();
    }
  }

  #extract(target: CpuFrame, pixels: Uint8Array): void {
    const [colorX, colorY, colorWidth, colorHeight] = this.#layout.colorRect;
    const storageStride = this.#layout.storageWidth * 4;
    for (let row = 0; row < colorHeight; row += 1) {
      for (let column = 0; column < colorWidth; column += 1) {
        const source = (colorY + row) * storageStride + (colorX + column) * 4;
        const destination = (row * colorWidth + column) * 4;
        target.color[destination] = pixels[source] ?? 0;
        target.color[destination + 1] = pixels[source + 1] ?? 0;
        target.color[destination + 2] = pixels[source + 2] ?? 0;
        target.color[destination + 3] = 255;
      }
    }
    const alphaRect = this.#layout.alphaRect;
    const alpha = target.alpha;
    if (alphaRect === undefined || alpha === null) return;
    const [alphaX, alphaY, alphaWidth, alphaHeight] = alphaRect;
    for (let row = 0; row < alphaHeight; row += 1) {
      for (let column = 0; column < alphaWidth; column += 1) {
        const source = (alphaY + row) * storageStride + (alphaX + column) * 4;
        const destination = (row * alphaWidth + column) * 4;
        alpha[destination] = 255;
        alpha[destination + 1] = 255;
        alpha[destination + 2] = 255;
        alpha[destination + 3] = pixels[source] ?? 0;
      }
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
      assertContextAvailable(output);
      assertContextAvailable(color.context);
      putPixels(color.context, frame.color, color.canvas.width, color.canvas.height);
      if (frame.alpha !== null && alpha !== null && alpha.context !== null) {
        assertContextAvailable(alpha.context);
        putPixels(alpha.context, frame.alpha, alpha.canvas.width, alpha.canvas.height);
      }
      const viewport = calculateRendererViewport(
        this.#layout,
        this.#canvas.width,
        this.#canvas.height,
        this.#dpr,
        this.#fit
      );
      configureContext(output);
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
      assertContextAvailable(output);
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

  #newFrame(): CpuFrame {
    const colorBytes = rgbaBytes(
      this.#layout.colorRect[2],
      this.#layout.colorRect[3]
    );
    return {
      color: new Uint8ClampedArray(colorBytes),
      alpha: this.#layout.alphaRect === undefined
        ? null : new Uint8ClampedArray(colorBytes)
    };
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
    this.#resident.clear();
    this.#reserved.clear();
    this.#last = null;
    this.#releaseCpuStorage();
    this.#releaseSurfaces();
    this.#outputContext = null;
    this.#notify(Object.freeze({ state: "error", error }));
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
      try {
        this.#canvas.width = oldWidth;
        this.#canvas.height = oldHeight;
      } catch { /* classified below */ }
      throw this.#failure(
        operation === "construct" ? "backing-admission" : "resize",
        operation,
        operationOrdinal,
        reason
      );
    }
  }

  #beginOperation(): number {
    if (this.#operationSequence === Number.MAX_SAFE_INTEGER) {
      throw new RangeError("renderer operation identity is exhausted");
    }
    const ordinal = this.#operationSequence;
    this.#operationSequence += 1;
    return ordinal;
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
        width: diagnosticScalar(this.#canvas.width),
        height: diagnosticScalar(this.#canvas.height)
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
        stagingBytes: diagnosticScalar(materializer.stagingBytes),
        residentBytes: 0,
        textureBytes: 0,
        backingBytes: 0,
        runtimeBytes: diagnosticScalar(materializer.stagingBytes),
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
      ...this.#streams.map((frame) => frameBytes(frame))
    ]);
  }

  #resourceCount(): number {
    if (this.#state === "error" || this.#state === "disposed") return 0;
    return Number(this.#outputContext !== null) +
      Number(this.#colorSurface !== null && this.#colorSurface.context !== null) +
      Number(this.#alphaSurface !== null && this.#alphaSurface.context !== null) +
      this.#materializer.snapshot().resourceCount;
  }

  #isDisposed(): boolean { return this.#state === "disposed"; }

  #releaseCpuStorage(): void {
    this.#materializer.dispose();
    this.#streams = [];
    this.#nextStream = 0;
  }

  #releaseSurfaces(): void {
    for (const surface of [
      this.#colorSurface,
      this.#alphaSurface
    ]) {
      if (surface === null) continue;
      surface.context = null;
      try {
        surface.canvas.width = 0;
        surface.canvas.height = 0;
      } catch { /* terminal cleanup */ }
    }
    this.#colorSurface = null;
    this.#alphaSurface = null;
  }
}

function putPixels(
  context: CanvasRenderingContext2D,
  pixels: Uint8ClampedArray,
  width: number,
  height: number
): void {
  const image = context.createImageData(width, height);
  if (image.data.byteLength !== pixels.byteLength) {
    throw new Error("Canvas2D scratch image storage is invalid");
  }
  image.data.set(pixels);
  context.globalCompositeOperation = "copy";
  context.putImageData(image, 0, 0);
}

function configureContext(context: CanvasRenderingContext2D): void {
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "low";
}

function assertContextAvailable(context: CanvasRenderingContext2D): void {
  const candidate = context as CanvasRenderingContext2D & Readonly<{
    isContextLost?: () => boolean;
  }>;
  if (typeof candidate.isContextLost === "function" && candidate.isContextLost()) {
    throw new Error("Canvas2D context is lost");
  }
}

function canvasContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  return canvas.getContext("2d", {
    alpha: true,
    desynchronized: true,
    willReadFrequently: false
  });
}

function frameBytes(frame: CpuFrame): number {
  return checkedSum([
    frame.color.byteLength,
    frame.alpha?.byteLength ?? 0
  ]);
}

function surfaceBytes(surface: Surface | null): number {
  return surface === null
    ? 0
    : rgbaBytes(surface.canvas.width, surface.canvas.height);
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

class RendererUnavailableError extends Error {
  public constructor() {
    super("renderer is unavailable");
    this.name = "RendererUnavailableError";
  }
}

function unavailable(): RendererUnavailableError {
  return new RendererUnavailableError();
}
