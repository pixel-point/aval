import { Canvas2dRenderer } from "./canvas2d-renderer.js";
import {
  createRendererFailureDiagnostic,
  RendererFailureError,
  type RendererDiagnosticContextAttributes,
  type RendererDiagnosticOperation,
  type RendererDiagnosticPhase,
  type RendererDiagnosticUploadPath
} from "./renderer-diagnostics.js";
import {
  allocationBytes,
  calculateRendererBacking,
  calculateRendererViewport,
  checkedProduct,
  checkedRenderLayout as checkedLayout,
  checkedSum,
  isRendererFit,
  rgbaBytes,
  validateRenderFrame as validateFrame,
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
  selectRendererBackend,
  WebGlUnavailableError
} from "./renderer-selection.js";
import type {
  RendererBackend,
  RendererContextChange,
  RendererSnapshot,
  RendererUploadMode
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
// The manifest and caller own admission policy. Keep the renderer default at
// the runtime's exact-arithmetic boundary instead of inventing a 64 MiB cap.
const HARD_BYTES = Number.MAX_SAFE_INTEGER;
const STREAMS = 3;
const NATIVE_PROBE_EDGE = 8;
const NATIVE_PROBE_PIXELS = NATIVE_PROBE_EDGE * NATIVE_PROBE_EDGE;
const NATIVE_PROBE_BYTES = NATIVE_PROBE_PIXELS * 4;
const NATIVE_PROBE_ACCOUNTED_BYTES = NATIVE_PROBE_BYTES * 2;
const MAX_NATIVE_PROBE_ATTEMPTS = 3;
const ID = /^[a-z][a-z0-9._-]{0,63}$/;

export class Renderer implements RendererBackend {
  readonly #backend: RendererBackend;

  public constructor(
    canvas: HTMLCanvasElement,
    layout: Readonly<RenderLayout>,
    limits: Readonly<RendererLimits> = {}
  ) {
    this.#backend = selectRendererBackend<RendererBackend>(
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
    this.#backend.resize(cssWidth, cssHeight, devicePixelRatio, fit);
  }

  public draw(frame: VideoFrame): Promise<void> {
    return this.#backend.draw(frame);
  }

  public store(group: string, index: number, frame: VideoFrame): Promise<void> {
    return this.#backend.store(group, index, frame);
  }

  public drawStored(group: string, index: number): Promise<void> {
    return this.#backend.drawStored(group, index);
  }

  public settled(): Promise<void> {
    return this.#backend.settled();
  }

  public admit(residentCount: number): Readonly<{
    textureBytes: number;
    runtimeBytes: number;
  }> {
    return this.#backend.admit(residentCount);
  }

  public snapshot(): Readonly<RendererSnapshot> {
    return this.#backend.snapshot();
  }

  public dispose(): void {
    this.#backend.dispose();
  }
}

class WebGl2Renderer {
  readonly #canvas: HTMLCanvasElement;
  readonly #layout: Readonly<RenderLayout>;
  readonly #lost: (event: Event) => void;
  readonly #restored: () => void;
  readonly #textureBytesPerFrame: number;
  readonly #storageBytesPerFrame: number;
  readonly #maxTextureBytes: number;
  readonly #maxBackingBytes: number;
  readonly #maxRuntimeBytes: number;
  readonly #materializer: RgbaMaterializer;
  readonly #onContextChange:
    ((change: Readonly<RendererContextChange>) => void) | undefined;
  readonly #resident = new Map<string, WebGLTexture>();
  readonly #reserved = new Set<string>();
  #gl: WebGL2RenderingContext | null = null;
  #program: WebGLProgram | null = null;
  #streams: WebGLTexture[] = [];
  #nextStream = 0;
  #last: string | number | null = null;
  #state: State = "active";
  #tail: Promise<void> = Promise.resolve();
  #pending = 0;
  // 0 = copyTo fallback, 1 = native upload needs probing, 2 = native proven.
  #native = 1;
  #nativeProbeAttempts = 0;
  #nativeProbeInFlight = false;
  #nativeProbeReadback = new Uint8Array(0);
  #referenceProbeReadback = new Uint8Array(0);
  #resizeQueued = false;
  #fit: RendererFit = "contain";
  #cssWidth = 0;
  #cssHeight = 0;
  #dpr = 1;
  #maxTextureSize = 0;
  #maxViewportWidth = 0;
  #maxViewportHeight = 0;
  #maxResidentTextures = 0;
  #losses = 0;
  #recoveries = 0;
  #operationSequence = 0;
  #initializingTextureCount = 0;
  #failureError: RendererFailureError | null = null;
  #contextAttributes: Readonly<RendererDiagnosticContextAttributes> | null = null;
  #vendor: string | null = null;
  #rendererName: string | null = null;

  public constructor(
    canvas: HTMLCanvasElement,
    layout: Readonly<RenderLayout>,
    limits: Readonly<RendererLimits> = {}
  ) {
    this.#canvas = canvas;
    this.#layout = checkedLayout(layout);
    this.#textureBytesPerFrame = rgbaBytes(
      this.#layout.codedWidth,
      this.#layout.codedHeight
    );
    this.#storageBytesPerFrame = rgbaBytes(
      this.#layout.storageWidth,
      this.#layout.storageHeight
    );
    this.#maxTextureBytes = cap(limits.maxTextureBytes, "texture byte cap");
    this.#maxBackingBytes = cap(limits.maxBackingBytes, "backing byte cap");
    this.#maxRuntimeBytes = cap(limits.maxRuntimeBytes, "runtime byte cap");
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
        createCanvas: limits.createCanvas ?? defaultCanvasFactory(canvas)
      }
    );
    this.#onContextChange = limits.onContextChange;
    this.#lost = (event) => {
      event.preventDefault();
      this.#markLost();
    };
    this.#restored = () => this.#queueRestore();
    const initial = limits.initialPresentation;
    let width = canvas.width;
    let height = canvas.height;
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
    }
    const oldWidth = canvas.width;
    const oldHeight = canvas.height;
    const operationOrdinal = this.#beginOperation();
    try {
      if (initial !== undefined) {
        try {
          canvas.width = width;
          canvas.height = height;
          if (canvas.width !== width || canvas.height !== height) {
            throw new Error("canvas rejected its exact backing dimensions");
          }
        } catch (reason) {
          throw this.#failure(
            "backing-admission",
            "construct",
            operationOrdinal,
            reason
          );
        }
        this.#cssWidth = Math.max(1, initial.width);
        this.#cssHeight = Math.max(1, initial.height);
        this.#dpr = Math.max(0.1, initial.dpr);
        if (!isRendererFit(initial.fit)) {
          throw new RangeError("renderer presentation geometry is invalid");
        }
        this.#fit = initial.fit;
      }
      this.#assertBudget(0, this.#backingBytes(canvas.width, canvas.height));
      canvas.addEventListener("webglcontextlost", this.#lost);
      canvas.addEventListener("webglcontextrestored", this.#restored);
      this.#initialize("construct", operationOrdinal);
    } catch (error) {
      canvas.removeEventListener("webglcontextlost", this.#lost);
      canvas.removeEventListener("webglcontextrestored", this.#restored);
      this.#destroy();
      this.#state = "error";
      this.#materializer.dispose();
      this.#releaseNativeProbe();
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
    const { width, height, dpr } = calculateRendererBacking(
      cssWidth,
      cssHeight,
      devicePixelRatio
    );
    const operationOrdinal = this.#beginOperation();
    if (
      width > this.#maxTextureSize || height > this.#maxTextureSize ||
      width > this.#maxViewportWidth || height > this.#maxViewportHeight
    ) {
      const error = this.#failure(
        "resize",
        "runtime",
        operationOrdinal,
        new Error("renderer backing dimensions exceed device limits"),
        { contextLost: this.#gl === null ? false : contextLost(this.#gl) }
      );
      this.#terminal(error);
      throw error;
    }
    const backingBytes = this.#backingBytes(width, height);
    this.#assertBudget(this.#resident.size + this.#reserved.size, backingBytes);
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
      } catch { /* terminalized below */ }
      const error = this.#failure(
        "resize",
        "runtime",
        operationOrdinal,
        reason
      );
      this.#terminal(error);
      throw error;
    }
    this.#cssWidth = Math.max(1, cssWidth);
    this.#cssHeight = Math.max(1, cssHeight);
    this.#dpr = dpr;
    this.#fit = fit;
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
      if (this.#state === "lost") {
        this.#last = null;
        throw unavailable();
      }
      const operationOrdinal = this.#beginOperation();
      const slot = this.#nextStream;
      const texture = this.#streams[slot];
      if (texture === undefined) throw unavailable();
      if (!await this.#uploadFrame(texture, frame, operationOrdinal)) {
        this.#last = null;
        throw unavailable();
      }
      this.#render(texture, "runtime", operationOrdinal);
      if (this.#state !== "active") throw unavailable();
      this.#last = slot;
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
      let rect: DOMRectReadOnly;
      try { rect = validateFrame(frame, this.#layout); }
      catch (reason) {
        throw this.#failure(
          "semantic-upload",
          "runtime",
          operationOrdinal,
          reason
        );
      }
      const materialization = this.#materializer.create(frame, rect);
      try {
        const source = await this.#materialize(
          materialization,
          operationOrdinal
        );
        if (this.#state === "disposed" || this.#state === "error") {
          throw unavailable();
        }
        if (this.#state !== "active") throw unavailable();
        const gl = this.#gl;
        if (gl === null) throw unavailable();
        let texture: WebGLTexture;
        try { texture = this.#createTexture(gl); }
        catch (reason) {
          throw this.#failure(
            "resident-texture-create",
            "runtime",
            operationOrdinal,
            reason,
            {
              glError: capturedGlError(reason, gl),
              contextLost: contextLost(gl),
              uploadPath: "rgba-copy"
            }
          );
        }
        if (contextLost(gl)) {
          throw this.#failure(
            "resident-texture-create",
            "runtime",
            operationOrdinal,
            new Error("WebGL context was lost during resident texture creation"),
            { contextLost: true, uploadPath: "rgba-copy" }
          );
        }
        try { this.#uploadPixels(gl, texture, source.pixels); }
        catch (reason) {
          const glError = capturedGlError(reason, gl);
          try { gl.deleteTexture(texture); } catch { /* preserve upload cause */ }
          throw this.#failure(
            "rgba-upload",
            "runtime",
            operationOrdinal,
            reason,
            {
              glError,
              contextLost: contextLost(gl),
              uploadPath: "rgba-copy"
            }
          );
        }
        if (contextLost(gl)) {
          try { gl.deleteTexture(texture); } catch { /* preserve context-loss cause */ }
          throw this.#failure(
            "rgba-upload",
            "runtime",
            operationOrdinal,
            new Error("WebGL context was lost during resident RGBA upload"),
            { contextLost: true, uploadPath: "rgba-copy" }
          );
        }
        this.#resident.set(key, texture);
      } finally {
        materialization.release();
      }
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
      if (this.#state === "lost") throw unavailable();
      const operationOrdinal = this.#beginOperation();
      const texture = this.#resident.get(key);
      if (texture === undefined) throw unavailable();
      this.#render(texture, "runtime", operationOrdinal);
      if (this.#state !== "active") throw unavailable();
      this.#last = key;
    });
  }

  public settled(): Promise<void> {
    return this.#tail;
  }

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
    const backingBytes = this.#state === "disposed"
      ? 0 : this.#ownedBackingBytes(this.#canvas.width, this.#canvas.height);
    const residentCount = this.#resident.size;
    const textureBytes = this.#state === "active"
      ? allocationBytes(checkedProduct(
          this.#textureBytesPerFrame,
          residentCount + STREAMS
        ))
      : 0;
    const residentBytes = 0;
    return Object.freeze({
      backendDetails: Object.freeze({
        kind: "webgl2" as const,
        uploadMode: nativeUploadMode(this.#native),
        nativeProbeAttempts: this.#nativeProbeAttempts,
        probeReadbackBytes: this.#probeReadbackBytes(),
        nativeProbeInFlight: this.#nativeProbeInFlight
      }),
      cssWidth: this.#cssWidth,
      cssHeight: this.#cssHeight,
      backingWidth: this.#canvas.width,
      backingHeight: this.#canvas.height,
      effectiveDprX: this.#cssWidth > 0 ? this.#canvas.width / this.#cssWidth : 0,
      effectiveDprY: this.#cssHeight > 0 ? this.#canvas.height / this.#cssHeight : 0,
      contextLossCount: this.#losses,
      contextRecoveryCount: this.#recoveries,
      stagingBytes: materializer.stagingBytes,
      residentBytes,
      textureBytes,
      runtimeBytes: checkedSum([
        backingBytes,
        materializer.stagingBytes,
        this.#probeReadbackBytes(),
        residentBytes,
        textureBytes
      ]),
      pendingOperations: this.#pending,
      sourceCopiesInFlight: materializer.sourceCopiesInFlight,
      resourceCount: Number(this.#program !== null) +
        this.#streams.length +
        this.#resident.size +
        materializer.resourceCount,
      contextListenerCount: this.#state === "disposed" ? 0 : 2,
      failure: this.#failureError?.diagnostic ?? null
    });
  }

  public dispose(): void {
    if (this.#state === "disposed") return;
    this.#state = "disposed";
    this.#canvas.removeEventListener("webglcontextlost", this.#lost);
    this.#canvas.removeEventListener("webglcontextrestored", this.#restored);
    this.#destroy();
    this.#resident.clear();
    this.#reserved.clear();
    this.#last = null;
    this.#materializer.dispose();
    this.#releaseNativeProbe();
    try {
      this.#canvas.width = 0;
      this.#canvas.height = 0;
    } catch { /* terminal */ }
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
        if (this.#state !== "active" && isAbortError(reason)) throw reason;
        if (reason instanceof RendererArithmeticError) throw reason;
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
        this.#initialize("restore", operationOrdinal);
        this.#state = "active";
        this.#recoveries += 1;
        this.#notify(Object.freeze({ state: "restored", error: null }));
        if (this.#last !== null) this.#drawLast("restore", operationOrdinal);
      } catch (reason) {
        const error = reason instanceof RendererFailureError
          ? reason
          : this.#failure(
              "context-event",
              "restore",
              operationOrdinal,
              reason
            );
        this.#terminal(error);
      }
    }).finally(() => {
      this.#pending -= 1;
    });
    this.#tail = restore.then(() => undefined, () => undefined);
  }

  #initialize(
    operation: RendererDiagnosticOperation,
    operationOrdinal: number
  ): void {
    this.#assertBudget(
      this.#resident.size,
      this.#backingBytes(this.#canvas.width, this.#canvas.height)
    );
    let gl: WebGL2RenderingContext | null = null;
    try {
      gl = this.#canvas.getContext("webgl2", {
        alpha: true,
        antialias: false,
        depth: false,
        stencil: false,
        desynchronized: true,
        premultipliedAlpha: true,
        preserveDrawingBuffer: false
      });
    } catch (reason) {
      throw this.#failure(
        "context-create",
        operation,
        operationOrdinal,
        reason
      );
    }
    if (gl === null && operation === "construct") {
      throw new WebGlUnavailableError();
    }
    if (gl === null || contextLost(gl)) {
      throw this.#failure(
        "context-create",
        operation,
        operationOrdinal,
        new Error("WebGL2 is unavailable"),
        { contextLost: gl === null ? false : contextLost(gl) }
      );
    }
    this.#contextAttributes = readContextAttributes(gl);
    const device = readDeviceIdentity(gl);
    this.#vendor = device.vendor;
    this.#rendererName = device.renderer;
    let maxTextureSize: number;
    let maxResidentTextures: number;
    let maxViewportWidth: number;
    let maxViewportHeight: number;
    try {
      maxTextureSize = positiveGl(gl.getParameter(gl.MAX_TEXTURE_SIZE));
      maxResidentTextures = Math.min(
        4096,
        positiveGl(gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS))
      );
      const viewport = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as
        ArrayLike<unknown> | null;
      maxViewportWidth = positiveGl(viewport?.[0]);
      maxViewportHeight = positiveGl(viewport?.[1]);
    } catch (reason) {
      throw this.#failure(
        "capability-query",
        operation,
        operationOrdinal,
        reason,
        { glError: readGlError(gl), contextLost: contextLost(gl) }
      );
    }
    this.#maxTextureSize = maxTextureSize;
    this.#maxViewportWidth = maxViewportWidth;
    this.#maxViewportHeight = maxViewportHeight;
    this.#maxResidentTextures = maxResidentTextures;
    if (
      this.#layout.codedWidth > maxTextureSize ||
      this.#layout.codedHeight > maxTextureSize ||
      this.#canvas.width > maxTextureSize ||
      this.#canvas.height > maxTextureSize ||
      this.#canvas.width > maxViewportWidth ||
      this.#canvas.height > maxViewportHeight
    ) {
      throw this.#failure(
        "device-limits",
        operation,
        operationOrdinal,
        new Error("renderer dimensions exceed WebGL limits"),
        { contextLost: contextLost(gl) }
      );
    }
    if (this.#resident.size > maxResidentTextures) {
      throw this.#failure(
        "device-limits",
        operation,
        operationOrdinal,
        new Error("resident texture count exceeds WebGL limits"),
        { contextLost: contextLost(gl) }
      );
    }
    let program: WebGLProgram | null = null;
    const streams: WebGLTexture[] = [];
    this.#initializingTextureCount = 0;
    try {
      try {
        program = createProgram(gl, this.#layout);
        const glError = readGlError(gl);
        if (glError !== null) {
          throw new RendererGlOperationError(
            "WebGL program creation failed",
            glError
          );
        }
      } catch (reason) {
        throw this.#failure(
          "program-create",
          operation,
          operationOrdinal,
          reason,
          {
            glError: capturedGlError(reason, gl),
            contextLost: contextLost(gl)
          }
        );
      }
      for (let index = 0; index < STREAMS; index += 1) {
        try {
          streams.push(this.#createTexture(gl));
          this.#initializingTextureCount = streams.length;
        } catch (reason) {
          throw this.#failure(
            "stream-texture-create",
            operation,
            operationOrdinal,
            reason,
            {
              glError: capturedGlError(reason, gl),
              contextLost: contextLost(gl),
              textureOrdinal: index
            }
          );
        }
      }
      gl.clearColor(0, 0, 0, 0);
      gl.disable(gl.BLEND);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      this.#gl = gl;
      this.#program = program;
      this.#streams = streams;
      this.#initializingTextureCount = 0;
      this.#nextStream = 0;
      this.#native = 1;
      this.#nativeProbeAttempts = 0;
      this.#nativeProbeInFlight = false;
      this.#nativeProbeReadback = new Uint8Array(NATIVE_PROBE_BYTES);
      this.#referenceProbeReadback = new Uint8Array(NATIVE_PROBE_BYTES);
    } catch (reason) {
      const error = reason instanceof RendererFailureError
        ? reason
        : this.#failure(
            "context-event",
            operation,
            operationOrdinal,
            reason,
            {
              glError: capturedGlError(reason, gl),
              contextLost: contextLost(gl)
            }
          );
      for (const stream of streams) {
        try { gl.deleteTexture(stream); } catch { /* preserve initialization cause */ }
      }
      if (program !== null) {
        try { gl.deleteProgram(program); } catch { /* preserve initialization cause */ }
      }
      this.#initializingTextureCount = 0;
      throw error;
    }
  }

  async #uploadFrame(
    texture: WebGLTexture,
    frame: VideoFrame,
    operationOrdinal: number
  ): Promise<boolean> {
    let rect: DOMRectReadOnly;
    try { rect = validateFrame(frame, this.#layout); }
    catch (reason) {
      throw this.#failure(
        "semantic-upload",
        "runtime",
        operationOrdinal,
        reason
      );
    }
    if (this.#state !== "active") return false;
    const gl = this.#gl;
    if (gl === null) return false;
    const materialization = this.#materializer.create(frame, rect);
    try {
      if (this.#native !== 0) {
        drainErrors(gl);
        let nativeError: number | null = null;
        let nativeReason: unknown = null;
        try {
          gl.bindTexture(gl.TEXTURE_2D, texture);
          gl.texSubImage2D(
            gl.TEXTURE_2D,
            0,
            0,
            0,
            gl.RGBA,
            gl.UNSIGNED_BYTE,
            frame
          );
          nativeError = readGlError(gl);
        } catch (reason) {
          nativeReason = reason;
          nativeError = readGlError(gl);
        }
        if (contextLost(gl)) {
          throw this.#failure(
            "native-upload",
            "runtime",
            operationOrdinal,
            nativeReason ?? new Error(
              "WebGL context was lost during native frame upload"
            ),
            {
              glError: nativeError,
              contextLost: true,
              uploadPath: "native"
            }
          );
        }
        if (nativeReason === null && nativeError === null) {
          if (this.#native === 2) return true;
          return await this.#qualifyNativeUpload(
            gl,
            texture,
            materialization,
            operationOrdinal
          );
        }
        this.#native = 0;
      }
      drainErrors(gl);
      const source = await this.#materialize(materialization, operationOrdinal);
      if (this.#state !== "active" || this.#gl !== gl) return false;
      this.#uploadRgbaFrame(gl, texture, source, operationOrdinal);
      return true;
    } finally {
      materialization.release();
    }
  }

  async #qualifyNativeUpload(
    gl: WebGL2RenderingContext,
    texture: WebGLTexture,
    materialization: Readonly<RgbaMaterialization>,
    operationOrdinal: number
  ): Promise<boolean> {
    if (
      this.#nativeProbeAttempts >= MAX_NATIVE_PROBE_ATTEMPTS ||
      this.#canvas.width < NATIVE_PROBE_EDGE ||
      this.#canvas.height < NATIVE_PROBE_EDGE ||
      this.#probeReadbackBytes() !== NATIVE_PROBE_ACCOUNTED_BYTES
    ) {
      this.#native = 0;
      drainErrors(gl);
      const source = await this.#materialize(materialization, operationOrdinal);
      if (this.#state !== "active" || this.#gl !== gl) return false;
      this.#uploadRgbaFrame(gl, texture, source, operationOrdinal);
      return true;
    }

    this.#nativeProbeAttempts += 1;
    this.#nativeProbeInFlight = true;
    try {
      // Resolve the CPU copy before touching the main framebuffer. Native and
      // reference probe draws can then run back-to-back in one microtask, and
      // the caller's full presentation draw never exposes unproven pixels.
      const source = await this.#materialize(materialization, operationOrdinal);
      if (this.#state !== "active" || this.#gl !== gl) return false;

      const nativeProbe = this.#readNativeProbe(
        gl,
        texture,
        this.#nativeProbeReadback
      );
      if (nativeProbe.contextLost) {
        throw this.#failure(
          "native-upload",
          "runtime",
          operationOrdinal,
          nativeProbe.reason,
          {
            glError: nativeProbe.glError,
            contextLost: true,
            uploadPath: "native"
          }
        );
      }

      drainErrors(gl);
      this.#uploadRgbaFrame(gl, texture, source, operationOrdinal);
      const referenceProbe = nativeProbe.ok
        ? this.#readNativeProbe(gl, texture, this.#referenceProbeReadback)
        : failedProbe(new Error("native probe readback was unavailable"));
      if (referenceProbe.contextLost) {
        throw this.#failure(
          "draw",
          "runtime",
          operationOrdinal,
          referenceProbe.reason,
          {
            glError: referenceProbe.glError,
            contextLost: true,
            uploadPath: "rgba-copy"
          }
        );
      }

      if (
        !nativeProbe.ok ||
        !referenceProbe.ok ||
        !equivalentProbe(
          this.#nativeProbeReadback,
          this.#referenceProbeReadback
        )
      ) {
        this.#native = 0;
      } else if (informativeProbe(this.#referenceProbeReadback)) {
        this.#native = 2;
      } else if (this.#nativeProbeAttempts >= MAX_NATIVE_PROBE_ATTEMPTS) {
        this.#native = 0;
      }
      return true;
    } finally {
      this.#nativeProbeInFlight = false;
      if (this.#gl === gl && !contextLost(gl)) {
        try {
          gl.viewport(0, 0, this.#canvas.width, this.#canvas.height);
        } catch { /* The following presentation draw retains exact evidence. */ }
      }
    }
  }

  #uploadRgbaFrame(
    gl: WebGL2RenderingContext,
    texture: WebGLTexture,
    source: Readonly<MaterializedRgbaFrame>,
    operationOrdinal: number
  ): void {
    try { this.#uploadPixels(gl, texture, source.pixels); }
    catch (reason) {
      throw this.#failure(
        "rgba-upload",
        "runtime",
        operationOrdinal,
        reason,
        {
          glError: capturedGlError(reason, gl),
          contextLost: contextLost(gl),
          uploadPath: "rgba-copy"
        }
      );
    }
    if (contextLost(gl)) {
      throw this.#failure(
        "rgba-upload",
        "runtime",
        operationOrdinal,
        new Error("WebGL context was lost during RGBA frame upload"),
        { contextLost: true, uploadPath: "rgba-copy" }
      );
    }
  }

  #readNativeProbe(
    gl: WebGL2RenderingContext,
    texture: WebGLTexture,
    target: Uint8Array
  ): NativeProbeResult {
    drainErrors(gl);
    try {
      gl.viewport(0, 0, NATIVE_PROBE_EDGE, NATIVE_PROBE_EDGE);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(this.#program);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      let glError = readGlError(gl);
      if (glError !== null || contextLost(gl)) {
        return failedProbe(
          new Error("WebGL native probe draw failed"),
          glError,
          contextLost(gl)
        );
      }
      target.fill(0);
      gl.readPixels(
        0,
        0,
        NATIVE_PROBE_EDGE,
        NATIVE_PROBE_EDGE,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        target
      );
      glError = readGlError(gl);
      if (glError !== null || contextLost(gl)) {
        return failedProbe(
          new Error("WebGL native probe readback failed"),
          glError,
          contextLost(gl)
        );
      }
      return Object.freeze({
        ok: true,
        reason: null,
        glError: null,
        contextLost: false
      });
    } catch (reason) {
      return failedProbe(reason, readGlError(gl), contextLost(gl));
    }
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
        { uploadPath: "rgba-copy" }
      );
    }
  }

  #createTexture(gl: WebGL2RenderingContext): WebGLTexture {
    const texture = gl.createTexture();
    if (texture === null) throw new Error("WebGL texture is unavailable");
    try {
      drainErrors(gl);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texStorage2D(
        gl.TEXTURE_2D,
        1,
        gl.RGBA8,
        this.#layout.codedWidth,
        this.#layout.codedHeight
      );
      const glError = readGlError(gl);
      if (glError !== null) {
        throw new RendererGlOperationError(
          "WebGL texture allocation failed",
          glError
        );
      }
      return texture;
    } catch (reason) {
      const error = captureGlOperationError(
        gl,
        reason,
        "WebGL texture allocation failed"
      );
      try { gl.deleteTexture(texture); } catch { /* preserve allocation cause */ }
      throw error;
    }
  }

  #uploadPixels(
    gl: WebGL2RenderingContext,
    texture: WebGLTexture,
    pixels: Uint8Array
  ): void {
    if (pixels.byteLength !== this.#storageBytesPerFrame) {
      throw new RangeError("resident pixel storage is invalid");
    }
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      this.#layout.storageWidth,
      this.#layout.storageHeight,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      pixels
    );
    const glError = readGlError(gl);
    if (glError !== null) {
      throw new RendererGlOperationError("WebGL RGBA upload failed", glError);
    }
  }

  #render(
    texture: WebGLTexture,
    operation: RendererDiagnosticOperation,
    operationOrdinal: number
  ): void {
    const gl = this.#gl;
    const program = this.#program;
    if (this.#state !== "active" || gl === null || program === null) {
      throw unavailable();
    }
    const backingWidth = this.#canvas.width;
    const backingHeight = this.#canvas.height;
    const viewport = calculateRendererViewport(
      this.#layout,
      backingWidth,
      backingHeight,
      this.#dpr,
      this.#fit
    );
    if (
      viewport.width > this.#maxViewportWidth ||
      viewport.height > this.#maxViewportHeight
    ) throw new RendererArithmeticError("renderer viewport exceeds device limits");
    try {
      gl.viewport(0, 0, backingWidth, backingHeight);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.viewport(
        viewport.x,
        viewport.y,
        viewport.width,
        viewport.height
      );
      gl.useProgram(program);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      const glError = readGlError(gl);
      if (glError !== null) {
        throw new RendererGlOperationError("WebGL draw failed", glError);
      }
      if (contextLost(gl) || this.#state !== "active") {
        throw new Error("WebGL context was lost during draw");
      }
    } catch (reason) {
      throw this.#failure(
        "draw",
        operation,
        operationOrdinal,
        reason,
        {
          glError: capturedGlError(reason, gl),
          contextLost: contextLost(gl)
        }
      );
    }
  }

  #drawLast(
    operation: RendererDiagnosticOperation,
    operationOrdinal: number
  ): void {
    const last = this.#last;
    if (last === null) return;
    const texture = typeof last === "number"
      ? this.#streams[last]
      : this.#resident.get(last);
    if (texture !== null && texture !== undefined) {
      this.#render(texture, operation, operationOrdinal);
    }
  }

  #markLost(): void {
    if (this.#state !== "active") return;
    this.#state = "lost";
    this.#losses += 1;
    this.#gl = null;
    this.#program = null;
    this.#streams = [];
    this.#nextStream = 0;
    this.#maxTextureSize = 0;
    this.#maxViewportWidth = 0;
    this.#maxViewportHeight = 0;
    this.#maxResidentTextures = 0;
    this.#contextAttributes = null;
    this.#vendor = null;
    this.#rendererName = null;
    this.#last = null;
    this.#resident.clear();
    this.#releaseNativeProbe();
    this.#materializer.reset();
    this.#notify(Object.freeze({ state: "lost", error: null }));
  }

  #terminal(error?: RendererFailureError): void {
    if (this.#state === "disposed" || this.#state === "error") return;
    const terminalError = error ?? this.#failure(
      "context-event",
      "runtime",
      this.#beginOperation(),
      new Error("WebGL renderer failed")
    );
    this.#state = "error";
    this.#destroy();
    this.#resident.clear();
    this.#reserved.clear();
    this.#last = null;
    this.#materializer.dispose();
    this.#releaseNativeProbe();
    this.#notify(Object.freeze({ state: "error", error: terminalError }));
  }

  #notify(change: Readonly<RendererContextChange>): void {
    queueMicrotask(() => {
      try { this.#onContextChange?.(change); } catch { /* Host callbacks are isolated. */ }
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
    }> = {}
  ): RendererFailureError {
    if (reason instanceof RendererFailureError) return reason;
    if (this.#failureError !== null) return this.#failureError;
    const bytes = this.#diagnosticBytes();
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
      bytes,
      limits: {
        maxTextureSize: this.#maxTextureSize,
        maxViewportWidth: this.#maxViewportWidth,
        maxViewportHeight: this.#maxViewportHeight,
        maxResidentTextures: this.#maxResidentTextures
      },
      contextAttributes: this.#contextAttributes,
      vendor: this.#vendor,
      renderer: this.#rendererName
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
      const materializer = this.#materializer.snapshot();
      const backingBytes = this.#ownedBackingBytes(
        this.#canvas.width,
        this.#canvas.height
      );
      const textureCount = this.#initializingTextureCount +
        (this.#state === "active"
          ? this.#resident.size + this.#streams.length
          : 0);
      const textureBytes = textureCount === 0
        ? 0
        : allocationBytes(checkedProduct(
            this.#textureBytesPerFrame,
            textureCount
          ));
      const residentBytes = 0;
      return Object.freeze({
        stagingBytes: materializer.stagingBytes,
        residentBytes,
        textureBytes,
        backingBytes,
        runtimeBytes: checkedSum([
          materializer.stagingBytes,
          this.#probeReadbackBytes(),
          residentBytes,
          textureBytes,
          backingBytes
        ]),
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
        runtimeBytes: diagnosticScalar(
          materializer.stagingBytes + this.#probeReadbackBytes()
        ),
        maxTextureBytes: this.#maxTextureBytes,
        maxBackingBytes: this.#maxBackingBytes,
        maxRuntimeBytes: this.#maxRuntimeBytes
      });
    }
  }

  #destroy(): void {
    const gl = this.#gl;
    if (gl !== null) {
      for (const texture of this.#resident.values()) {
        try { gl.deleteTexture(texture); } catch { /* terminal cleanup */ }
      }
      for (const stream of this.#streams) {
        try { gl.deleteTexture(stream); } catch { /* terminal cleanup */ }
      }
      if (this.#program !== null) {
        try { gl.deleteProgram(this.#program); } catch { /* terminal cleanup */ }
      }
    }
    this.#gl = null;
    this.#program = null;
    this.#streams = [];
    this.#nextStream = 0;
  }

  #probeReadbackBytes(): number {
    return this.#nativeProbeReadback.byteLength +
      this.#referenceProbeReadback.byteLength;
  }

  #releaseNativeProbe(): void {
    this.#nativeProbeInFlight = false;
    this.#nativeProbeReadback = new Uint8Array(0);
    this.#referenceProbeReadback = new Uint8Array(0);
  }

  #backingBytes(width: number, height: number): number {
    return allocationBytes(checkedSum([
      rgbaBytes(width, height),
      this.#materializer.budget().maximumFallbackBackingBytes
    ]));
  }

  #ownedBackingBytes(width: number, height: number): number {
    return allocationBytes(checkedSum([
      rgbaBytes(width, height),
      this.#materializer.snapshot().readbackBackingBytes
    ]));
  }

  #assertBudget(
    residentCount: number,
    backingBytes: number
  ): Readonly<{ textureBytes: number; runtimeBytes: number }> {
    if (this.#maxResidentTextures > 0 && residentCount > this.#maxResidentTextures) {
      throw new RangeError("resident texture count exceeds device limits");
    }
    const textureBytes = allocationBytes(checkedProduct(
      this.#textureBytesPerFrame,
      residentCount + STREAMS
    ));
    const materializer = this.#materializer.budget();
    const runtimeBytes = checkedSum([
      textureBytes,
      materializer.stagingBytes,
      materializer.maximumTransientReadbackBytes,
      NATIVE_PROBE_ACCOUNTED_BYTES,
      backingBytes
    ]);
    if (
      textureBytes > this.#maxTextureBytes ||
      backingBytes > this.#maxBackingBytes ||
      runtimeBytes > this.#maxRuntimeBytes
    ) {
      const error = new RangeError("renderer resource byte cap exceeded");
      error.name = "ResourceBudgetError";
      throw error;
    }
    return Object.freeze({ textureBytes, runtimeBytes });
  }
}

function residentKey(group: string, index: number): string {
  if (!ID.test(group) || !Number.isSafeInteger(index) || index < 0) {
    throw new RangeError("resident frame key is invalid");
  }
  return `${group}\0${String(index)}`;
}

function cap(value: number | undefined, label: string): number {
  if (value === undefined) return HARD_BYTES;
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${label} is invalid`);
  return Math.min(value, HARD_BYTES);
}

function positiveGl(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error("WebGL device limit is invalid");
  }
  return value;
}

class RendererGlOperationError extends Error {
  public constructor(
    message: string,
    public readonly glError: number | null
  ) {
    super(message);
    this.name = "RendererGlOperationError";
  }
}

class RendererArithmeticError extends RangeError {}

interface NativeProbeResult {
  readonly ok: boolean;
  readonly reason: unknown;
  readonly glError: number | null;
  readonly contextLost: boolean;
}

function failedProbe(
  reason: unknown,
  glError: number | null = null,
  lost = false
): NativeProbeResult {
  return Object.freeze({ ok: false, reason, glError, contextLost: lost });
}

function nativeUploadMode(value: number): RendererUploadMode {
  if (value === 0) return "rgba-copy";
  if (value === 2) return "native";
  return "native-probing";
}

function informativeProbe(pixels: Uint8Array): boolean {
  if (pixels.byteLength !== NATIVE_PROBE_BYTES) return false;
  const minimum = [255, 255, 255, 255];
  const maximum = [0, 0, 0, 0];
  let visibleSignal = false;
  for (let offset = 0; offset < pixels.byteLength; offset += 4) {
    const red = pixels[offset] ?? 0;
    const green = pixels[offset + 1] ?? 0;
    const blue = pixels[offset + 2] ?? 0;
    const alpha = pixels[offset + 3] ?? 0;
    const channels = [red, green, blue, alpha];
    for (let channel = 0; channel < channels.length; channel += 1) {
      minimum[channel] = Math.min(minimum[channel] ?? 255, channels[channel] ?? 0);
      maximum[channel] = Math.max(maximum[channel] ?? 0, channels[channel] ?? 0);
    }
    // Integer Rec. 709 luma is sufficient for the bounded false-positive
    // discriminator and avoids float-dependent comparison at the threshold.
    const luma = (54 * red + 183 * green + 19 * blue) >> 8;
    if (alpha > 16 || luma > 16) visibleSignal = true;
  }
  return visibleSignal && maximum.some((value, channel) =>
    value - (minimum[channel] ?? value) >= 16);
}

function equivalentProbe(native: Uint8Array, reference: Uint8Array): boolean {
  if (
    native.byteLength !== NATIVE_PROBE_BYTES ||
    reference.byteLength !== NATIVE_PROBE_BYTES
  ) return false;
  for (let offset = 0; offset < reference.byteLength; offset += 4) {
    const referenceAlpha = reference[offset + 3] ?? 0;
    const nativeAlpha = native[offset + 3] ?? 0;
    if (Math.abs(nativeAlpha - referenceAlpha) > 1) return false;
    if (referenceAlpha === 0) continue;
    for (let channel = 0; channel < 3; channel += 1) {
      if (Math.abs(
        (native[offset + channel] ?? 0) -
        (reference[offset + channel] ?? 0)
      ) > 3) return false;
    }
  }
  return true;
}

function capturedGlError(
  reason: unknown,
  gl: WebGL2RenderingContext
): number | null {
  return reason instanceof RendererGlOperationError
    ? reason.glError
    : readGlError(gl);
}

function captureGlOperationError(
  gl: WebGL2RenderingContext,
  reason: unknown,
  fallbackMessage: string
): RendererGlOperationError {
  if (reason instanceof RendererGlOperationError) return reason;
  let message = fallbackMessage;
  try {
    if (reason instanceof Error && reason.message.length > 0) {
      message = reason.message;
    }
  } catch { /* retain the fixed fallback message */ }
  return new RendererGlOperationError(message, readGlError(gl));
}

function readGlError(gl: WebGL2RenderingContext): number | null {
  try {
    const value = gl.getError();
    return Number.isSafeInteger(value) && value >= 0 && value !== gl.NO_ERROR
      ? value : null;
  } catch {
    return null;
  }
}

function contextLost(gl: WebGL2RenderingContext): boolean {
  try { return gl.isContextLost() === true; }
  catch { return false; }
}

function readContextAttributes(
  gl: WebGL2RenderingContext
): Readonly<RendererDiagnosticContextAttributes> | null {
  let value: unknown;
  try { value = gl.getContextAttributes(); }
  catch { return null; }
  if (typeof value !== "object" || value === null) return null;
  try {
    const record = value as Readonly<Record<string, unknown>>;
    const powerPreference = record.powerPreference;
    return Object.freeze({
      alpha: diagnosticBoolean(record.alpha),
      antialias: diagnosticBoolean(record.antialias),
      depth: diagnosticBoolean(record.depth),
      desynchronized: diagnosticBoolean(record.desynchronized),
      failIfMajorPerformanceCaveat:
        diagnosticBoolean(record.failIfMajorPerformanceCaveat),
      powerPreference:
        powerPreference === "default" ||
        powerPreference === "high-performance" ||
        powerPreference === "low-power"
          ? powerPreference : null,
      premultipliedAlpha: diagnosticBoolean(record.premultipliedAlpha),
      preserveDrawingBuffer: diagnosticBoolean(record.preserveDrawingBuffer),
      stencil: diagnosticBoolean(record.stencil),
      xrCompatible: diagnosticBoolean(record.xrCompatible)
    });
  } catch {
    return null;
  }
}

function diagnosticBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function diagnosticScalar(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value : 0;
}

function readDeviceIdentity(gl: WebGL2RenderingContext): Readonly<{
  vendor: string | null;
  renderer: string | null;
}> {
  try {
    const extension = gl.getExtension("WEBGL_debug_renderer_info") as
      Readonly<{
        UNMASKED_VENDOR_WEBGL?: unknown;
        UNMASKED_RENDERER_WEBGL?: unknown;
      }> | null;
    if (extension === null) return Object.freeze({ vendor: null, renderer: null });
    const vendor = typeof extension.UNMASKED_VENDOR_WEBGL === "number"
      ? gl.getParameter(extension.UNMASKED_VENDOR_WEBGL) : null;
    const renderer = typeof extension.UNMASKED_RENDERER_WEBGL === "number"
      ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) : null;
    return Object.freeze({
      vendor: typeof vendor === "string" ? vendor : null,
      renderer: typeof renderer === "string" ? renderer : null
    });
  } catch {
    return Object.freeze({ vendor: null, renderer: null });
  }
}

function drainErrors(gl: WebGL2RenderingContext): void {
  try {
    for (let index = 0; index < 8 && gl.getError() !== gl.NO_ERROR; index += 1) {
      // Error draining is bounded because a lost context may report forever.
    }
  } catch { /* Error polling is diagnostic-only. */ }
}

function unavailable(): Error {
  return new DOMException("WebGL renderer is unavailable", "AbortError");
}

function isAbortError(reason: unknown): boolean {
  if (typeof reason !== "object" || reason === null) return false;
  try { return (reason as Readonly<{ name?: unknown }>).name === "AbortError"; }
  catch { return false; }
}

function createProgram(
  gl: WebGL2RenderingContext,
  layout: Readonly<RenderLayout>
): WebGLProgram {
  let vertex: WebGLShader | null = null;
  let fragment: WebGLShader | null = null;
  let program: WebGLProgram | null = null;
  try {
    drainErrors(gl);
    vertex = shader(gl, gl.VERTEX_SHADER, `#version 300 es
const vec2 p[3]=vec2[](vec2(-1,-1),vec2(3,-1),vec2(-1,3));
out vec2 v;void main(){vec2 q=p[gl_VertexID];v=(q+1.)/2.;gl_Position=vec4(q,0,1);}`);
    fragment = shader(gl, gl.FRAGMENT_SHADER, `#version 300 es
precision highp float;uniform sampler2D f;uniform vec4 c,a;uniform float h;in vec2 v;out vec4 o;
void main(){vec2 u=v;u.y=1.-u.y;vec3 r=texture(f,c.xy+u*c.zw).rgb;float q=h>.5?texture(f,a.xy+u*a.zw).r:1.;o=vec4(r*q,q);}`);
    program = gl.createProgram();
    if (program === null) throw new Error("WebGL program is unavailable");
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error("WebGL program link failed");
    }
    gl.useProgram(program);
    const sampler = gl.getUniformLocation(program, "f");
    const color = gl.getUniformLocation(program, "c");
    const alpha = gl.getUniformLocation(program, "a");
    const hasAlpha = gl.getUniformLocation(program, "h");
    if (sampler === null || color === null || alpha === null || hasAlpha === null) {
      throw new Error("WebGL shader uniforms are unavailable");
    }
    gl.uniform1i(sampler, 0);
    uv(gl, color, layout.colorRect, layout);
    uv(gl, alpha, layout.alphaRect ?? layout.colorRect, layout);
    gl.uniform1f(hasAlpha, layout.alphaRect === undefined ? 0 : 1);
    const glError = readGlError(gl);
    if (glError !== null) {
      throw new RendererGlOperationError(
        "WebGL program creation failed",
        glError
      );
    }
    return program;
  } catch (reason) {
    const error = captureGlOperationError(
      gl,
      reason,
      "WebGL program creation failed"
    );
    if (program !== null) {
      try { gl.deleteProgram(program); } catch { /* preserve program cause */ }
    }
    throw error;
  } finally {
    if (vertex !== null) {
      try { gl.deleteShader(vertex); } catch { /* preserve program cause */ }
    }
    if (fragment !== null) {
      try { gl.deleteShader(fragment); } catch { /* preserve program cause */ }
    }
  }
}

function shader(
  gl: WebGL2RenderingContext,
  kind: number,
  source: string
): WebGLShader {
  const result = gl.createShader(kind);
  if (result === null) throw new Error("WebGL shader is unavailable");
  try {
    gl.shaderSource(result, source);
    gl.compileShader(result);
    if (!gl.getShaderParameter(result, gl.COMPILE_STATUS)) {
      throw new Error("WebGL shader compilation failed");
    }
    const glError = readGlError(gl);
    if (glError !== null) {
      throw new RendererGlOperationError(
        "WebGL shader creation failed",
        glError
      );
    }
    return result;
  } catch (reason) {
    const error = captureGlOperationError(
      gl,
      reason,
      "WebGL shader creation failed"
    );
    try { gl.deleteShader(result); } catch { /* preserve shader cause */ }
    throw error;
  }
}

function uv(
  gl: WebGL2RenderingContext,
  location: WebGLUniformLocation,
  rect: readonly [number, number, number, number],
  layout: Readonly<RenderLayout>
): void {
  gl.uniform4f(
    location,
    (rect[0] + 0.5) / layout.codedWidth,
    (rect[1] + 0.5) / layout.codedHeight,
    (rect[2] - 1) / layout.codedWidth,
    (rect[3] - 1) / layout.codedHeight
  );
}
