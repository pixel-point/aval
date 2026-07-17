export interface RenderLayout {
  readonly codedWidth: number;
  readonly codedHeight: number;
  readonly storageWidth: number;
  readonly storageHeight: number;
  readonly logicalWidth: number;
  readonly logicalHeight: number;
  readonly pixelAspect: readonly [number, number];
  readonly colorRect: readonly [number, number, number, number];
  readonly alphaRect?: readonly [number, number, number, number];
}

export interface RendererLimits {
  readonly maxTextureBytes?: number;
  readonly maxBackingBytes?: number;
  readonly maxRuntimeBytes?: number;
  readonly copyTimeoutMs?: number;
  readonly setTimeout?: (callback: () => void, delay: number) => number;
  readonly clearTimeout?: (handle: number) => void;
  readonly onContextChange?: (state: "lost" | "restored" | "error") => void;
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
const COPY_TIMEOUT = 5_000;
const STREAMS = 3;
const ID = /^[a-z][a-z0-9._-]{0,63}$/;

export class Renderer {
  readonly #canvas: HTMLCanvasElement;
  readonly #layout: Readonly<RenderLayout>;
  readonly #lost: (event: Event) => void;
  readonly #restored: () => void;
  readonly #textureBytesPerFrame: number;
  readonly #storageBytesPerFrame: number;
  readonly #maxTextureBytes: number;
  readonly #maxBackingBytes: number;
  readonly #maxRuntimeBytes: number;
  readonly #copyTimeoutMs: number;
  readonly #setTimeout: (callback: () => void, delay: number) => number;
  readonly #clearTimeout: (handle: number) => void;
  readonly #onContextChange: ((state: "lost" | "restored" | "error") => void) | undefined;
  readonly #resident = new Map<string, WebGLTexture>();
  readonly #reserved = new Set<string>();
  #staging: Uint8Array;
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
  #resizeQueued = false;
  #fit = "contain";
  #cssWidth = 0;
  #cssHeight = 0;
  #dpr = 1;
  #maxTextureSize = 0;
  #maxViewportWidth = 0;
  #maxViewportHeight = 0;
  #maxResidentTextures = 0;
  #losses = 0;
  #recoveries = 0;
  #sourceCopiesInFlight = 0;

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
    this.#copyTimeoutMs = limits.copyTimeoutMs ?? COPY_TIMEOUT;
    this.#setTimeout = limits.setTimeout ?? ((callback, delay) =>
      globalThis.setTimeout(callback, delay) as unknown as number);
    this.#clearTimeout = limits.clearTimeout ?? ((handle) => globalThis.clearTimeout(handle));
    this.#onContextChange = limits.onContextChange;
    if (
      !Number.isSafeInteger(this.#copyTimeoutMs) ||
      this.#copyTimeoutMs < 1 ||
      this.#copyTimeoutMs > 60_000
    ) throw new RangeError("renderer copy timeout is invalid");
    this.#staging = new Uint8Array(0);
    this.#lost = (event) => {
      event.preventDefault();
      this.#markLost();
    };
    this.#restored = () => this.#queueRestore();
    const initial = limits.initialPresentation;
    let width = canvas.width;
    let height = canvas.height;
    if (initial !== undefined) {
      if (!Number.isFinite(initial.width) || initial.width < 0 ||
        !Number.isFinite(initial.height) || initial.height < 0 ||
        !Number.isFinite(initial.dpr) || initial.dpr <= 0 ||
        !["contain", "cover", "fill", "none"].includes(initial.fit)) {
        throw new RangeError("renderer presentation geometry is invalid");
      }
      width = Math.max(1, Math.round(initial.width * initial.dpr));
      height = Math.max(1, Math.round(initial.height * initial.dpr));
      if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)) {
        throw new RangeError("renderer backing dimensions are invalid");
      }
    }
    const oldWidth = canvas.width;
    const oldHeight = canvas.height;
    try {
      if (initial !== undefined) {
        canvas.width = width;
        canvas.height = height;
        if (canvas.width !== width || canvas.height !== height) {
          throw new Error("canvas rejected its exact backing dimensions");
        }
        this.#cssWidth = Math.max(1, initial.width);
        this.#cssHeight = Math.max(1, initial.height);
        this.#dpr = initial.dpr;
        this.#fit = initial.fit;
      }
      this.#assertBudget(0, this.#backingBytes(canvas.width, canvas.height));
      this.#staging = new Uint8Array(this.#storageBytesPerFrame);
      canvas.addEventListener("webglcontextlost", this.#lost);
      canvas.addEventListener("webglcontextrestored", this.#restored);
      this.#initialize();
    } catch (error) {
      canvas.removeEventListener("webglcontextlost", this.#lost);
      canvas.removeEventListener("webglcontextrestored", this.#restored);
      this.#destroy();
      this.#state = "error";
      this.#staging = new Uint8Array(0);
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
    if (
      !Number.isFinite(cssWidth) || cssWidth < 0 ||
      !Number.isFinite(cssHeight) || cssHeight < 0 ||
      !Number.isFinite(devicePixelRatio) || devicePixelRatio <= 0 ||
      !["contain", "cover", "fill", "none"].includes(fit)
    ) throw new RangeError("renderer presentation geometry is invalid");
    const dpr = Math.max(0.1, devicePixelRatio);
    const width = Math.max(1, Math.round(cssWidth * dpr));
    const height = Math.max(1, Math.round(cssHeight * dpr));
    if (
      !Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
      width > this.#maxTextureSize || height > this.#maxTextureSize ||
      width > this.#maxViewportWidth || height > this.#maxViewportHeight
    ) throw new RangeError("renderer backing dimensions exceed device limits");
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
    } catch (error) {
      try {
        this.#canvas.width = oldWidth;
        this.#canvas.height = oldHeight;
      } catch { /* terminalized below */ }
      this.#terminal();
      throw error;
    }
    this.#cssWidth = Math.max(1, cssWidth);
    this.#cssHeight = Math.max(1, cssHeight);
    this.#dpr = dpr;
    this.#fit = fit;
    if (this.#last !== null && !this.#resizeQueued) {
      this.#resizeQueued = true;
      void this.#enqueue(() => {
        if (this.#state === "active") this.#drawLast();
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
      const slot = this.#nextStream;
      const texture = this.#streams[slot];
      if (texture === undefined) throw unavailable();
      if (!await this.#uploadFrame(texture, frame)) {
        this.#last = null;
        throw unavailable();
      }
      this.#render(texture);
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
      const rect = validateFrame(frame, this.#layout);
      const staging = await this.#copy(frame, rect);
      if (this.#state === "disposed" || this.#state === "error") {
        throw unavailable();
      }
      if (this.#state !== "active") throw unavailable();
      const gl = this.#gl;
      if (gl === null) throw unavailable();
      const texture = this.#createTexture(gl, staging);
      if (gl.isContextLost()) {
        this.#markLost();
        throw unavailable();
      }
      this.#resident.set(key, texture);
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
      const texture = this.#resident.get(key);
      if (texture === undefined) throw unavailable();
      this.#render(texture);
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

  public snapshot(): Readonly<{
    cssWidth: number;
    cssHeight: number;
    backingWidth: number;
    backingHeight: number;
    effectiveDprX: number;
    effectiveDprY: number;
    contextLossCount: number;
    contextRecoveryCount: number;
    stagingBytes: number;
    residentBytes: number;
    textureBytes: number;
    runtimeBytes: number;
    pendingOperations: number;
    sourceCopiesInFlight: number;
    resourceCount: number;
    contextListenerCount: number;
  }> {
    const backingBytes = this.#state === "disposed"
      ? 0 : this.#backingBytes(this.#canvas.width, this.#canvas.height);
    const residentCount = this.#resident.size;
    const textureBytes = this.#state === "active"
      ? allocationBytes(checkedProduct(
          this.#textureBytesPerFrame,
          residentCount + STREAMS
        ))
      : 0;
    const residentBytes = 0;
    return Object.freeze({
      cssWidth: this.#cssWidth,
      cssHeight: this.#cssHeight,
      backingWidth: this.#canvas.width,
      backingHeight: this.#canvas.height,
      effectiveDprX: this.#cssWidth > 0 ? this.#canvas.width / this.#cssWidth : 0,
      effectiveDprY: this.#cssHeight > 0 ? this.#canvas.height / this.#cssHeight : 0,
      contextLossCount: this.#losses,
      contextRecoveryCount: this.#recoveries,
      stagingBytes: this.#staging.byteLength,
      residentBytes,
      textureBytes,
      runtimeBytes: checkedSum([
        backingBytes,
        this.#staging.byteLength,
        residentBytes,
        textureBytes
      ]),
      pendingOperations: this.#pending,
      sourceCopiesInFlight: this.#sourceCopiesInFlight,
      resourceCount: Number(this.#program !== null) +
        this.#streams.length +
        this.#resident.size,
      contextListenerCount: this.#state === "disposed" ? 0 : 2
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
    this.#staging = new Uint8Array(0);
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
      } catch (error) {
        if (this.#state === "active") this.#terminal();
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
      try {
        this.#initialize();
        this.#state = "active";
        this.#recoveries += 1;
        this.#notify("restored");
        if (this.#last !== null) this.#drawLast();
      } catch {
        this.#terminal();
      }
    }).finally(() => {
      this.#pending -= 1;
    });
    this.#tail = restore.then(() => undefined, () => undefined);
  }

  #initialize(): void {
    this.#assertBudget(
      this.#resident.size,
      this.#backingBytes(this.#canvas.width, this.#canvas.height)
    );
    const gl = this.#canvas.getContext("webgl2", {
      alpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      desynchronized: true,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false
    });
    if (gl === null || gl.isContextLost()) throw new Error("WebGL2 is unavailable");
    const maxTextureSize = positiveGl(gl.getParameter(gl.MAX_TEXTURE_SIZE));
    const maxResidentTextures = Math.min(
      4096,
      positiveGl(gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS))
    );
    const viewport = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as ArrayLike<unknown> | null;
    const maxViewportWidth = positiveGl(viewport?.[0]);
    const maxViewportHeight = positiveGl(viewport?.[1]);
    if (
      this.#layout.codedWidth > maxTextureSize ||
      this.#layout.codedHeight > maxTextureSize ||
      this.#canvas.width > maxTextureSize ||
      this.#canvas.height > maxTextureSize ||
      this.#canvas.width > maxViewportWidth ||
      this.#canvas.height > maxViewportHeight
    ) throw new Error("renderer dimensions exceed WebGL limits");
    if (this.#resident.size > maxResidentTextures) {
      throw new Error("resident texture count exceeds WebGL limits");
    }
    let program: WebGLProgram | null = null;
    const streams: WebGLTexture[] = [];
    try {
      program = createProgram(gl, this.#layout);
      for (let index = 0; index < STREAMS; index += 1) {
        streams.push(this.#createTexture(gl));
      }
      gl.clearColor(0, 0, 0, 0);
      gl.disable(gl.BLEND);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      this.#gl = gl;
      this.#program = program;
      this.#streams = streams;
      this.#nextStream = 0;
      this.#native = 1;
      this.#maxTextureSize = maxTextureSize;
      this.#maxViewportWidth = maxViewportWidth;
      this.#maxViewportHeight = maxViewportHeight;
      this.#maxResidentTextures = maxResidentTextures;
    } catch (error) {
      for (const stream of streams) gl.deleteTexture(stream);
      if (program !== null) gl.deleteProgram(program);
      throw error;
    }
  }

  async #uploadFrame(texture: WebGLTexture, frame: VideoFrame): Promise<boolean> {
    const rect = validateFrame(frame, this.#layout);
    if (this.#state !== "active") return false;
    const gl = this.#gl;
    if (gl === null) return false;
    if (this.#native !== 0) {
      if (this.#native === 1) drainErrors(gl);
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
        if (
          (this.#native === 2 || gl.getError() === gl.NO_ERROR) &&
          !gl.isContextLost()
        ) {
          this.#native = 2;
          return true;
        }
      } catch { /* bounded RGBA copy below */ }
      if (gl.isContextLost()) {
        this.#markLost();
        return false;
      }
      this.#native = 0;
      drainErrors(gl);
    }
    const pixels = await this.#copy(frame, rect);
    if (this.#state !== "active" || this.#gl !== gl) return false;
    this.#uploadPixels(gl, texture, pixels);
    if (gl.isContextLost()) {
      this.#markLost();
      return false;
    }
    return true;
  }

  async #copy(frame: VideoFrame, rect: DOMRectReadOnly): Promise<Uint8Array> {
    const staging = this.#staging;
    if (staging.byteLength !== this.#storageBytesPerFrame) throw unavailable();
    staging.fill(0);
    const stride = this.#layout.storageWidth * 4;
    const raw = frame.copyTo(staging, {
      format: "RGBA",
      rect,
      layout: [{ offset: 0, stride }]
    });
    this.#sourceCopiesInFlight += 1;
    void raw.then(
      () => { this.#sourceCopiesInFlight -= 1; },
      () => { this.#sourceCopiesInFlight -= 1; }
    );
    const planes = await timed(
      raw,
      this.#copyTimeoutMs,
      this.#setTimeout,
      this.#clearTimeout
    );
    const plane = planes[0];
    if (
      planes.length !== 1 ||
      plane === undefined ||
      plane.offset !== 0 ||
      plane.stride !== stride
    ) throw new Error("decoded frame copy layout is invalid");
    return staging;
  }

  #createTexture(
    gl: WebGL2RenderingContext,
    pixels?: Uint8Array
  ): WebGLTexture {
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
      if (pixels !== undefined) this.#uploadPixels(gl, texture, pixels);
      if (gl.getError() !== gl.NO_ERROR) throw new Error("WebGL texture allocation failed");
      return texture;
    } catch (error) {
      gl.deleteTexture(texture);
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
  }

  #render(texture: WebGLTexture): void {
    const gl = this.#gl;
    const program = this.#program;
    if (this.#state !== "active" || gl === null || program === null) {
      throw unavailable();
    }
    const backingWidth = this.#canvas.width;
    const backingHeight = this.#canvas.height;
    const sourceWidth = this.#layout.logicalWidth *
      this.#layout.pixelAspect[0] / this.#layout.pixelAspect[1];
    const sourceHeight = this.#layout.logicalHeight;
    let width = backingWidth;
    let height = backingHeight;
    if (this.#fit !== "fill") {
      const scale = this.#fit === "cover"
        ? Math.max(backingWidth / sourceWidth, backingHeight / sourceHeight)
        : this.#fit === "none"
          ? this.#dpr
          : Math.min(backingWidth / sourceWidth, backingHeight / sourceHeight);
      width = Math.max(1, Math.round(sourceWidth * scale));
      height = Math.max(1, Math.round(sourceHeight * scale));
    }
    if (
      !Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
      width > this.#maxViewportWidth || height > this.#maxViewportHeight
    ) throw new RangeError("renderer viewport exceeds device limits");
    gl.viewport(0, 0, backingWidth, backingHeight);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.viewport(
      Math.round((backingWidth - width) / 2),
      Math.round((backingHeight - height) / 2),
      width,
      height
    );
    gl.useProgram(program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (gl.isContextLost() || this.#state !== "active") {
      this.#markLost();
      throw unavailable();
    }
  }

  #drawLast(): void {
    const last = this.#last;
    if (last === null) return;
    const texture = typeof last === "number"
      ? this.#streams[last]
      : this.#resident.get(last);
    if (texture !== null && texture !== undefined) this.#render(texture);
  }

  #markLost(): void {
    if (this.#state !== "active") return;
    this.#state = "lost";
    this.#losses += 1;
    this.#gl = null;
    this.#program = null;
    this.#streams = [];
    this.#nextStream = 0;
    this.#native = 1;
    this.#last = null;
    this.#resident.clear();
    this.#notify("lost");
  }

  #terminal(): void {
    if (this.#state === "disposed" || this.#state === "error") return;
    this.#state = "error";
    this.#destroy();
    this.#resident.clear();
    this.#reserved.clear();
    this.#last = null;
    this.#staging = new Uint8Array(0);
    this.#notify("error");
  }

  #notify(state: "lost" | "restored" | "error"): void {
    queueMicrotask(() => {
      try { this.#onContextChange?.(state); } catch { /* Host callbacks are isolated. */ }
    });
  }

  #destroy(): void {
    const gl = this.#gl;
    if (gl !== null) {
      for (const texture of this.#resident.values()) gl.deleteTexture(texture);
      for (const stream of this.#streams) gl.deleteTexture(stream);
      if (this.#program !== null) gl.deleteProgram(this.#program);
    }
    this.#gl = null;
    this.#program = null;
    this.#streams = [];
    this.#nextStream = 0;
  }

  #backingBytes(width: number, height: number): number {
    return allocationBytes(rgbaBytes(width, height));
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
    const runtimeBytes = checkedSum([
      textureBytes,
      this.#storageBytesPerFrame,
      backingBytes
    ]);
    if (
      textureBytes > this.#maxTextureBytes ||
      backingBytes > this.#maxBackingBytes ||
      runtimeBytes > this.#maxRuntimeBytes
    ) throw new RangeError("renderer resource byte cap exceeded");
    return Object.freeze({ textureBytes, runtimeBytes });
  }
}

function allocationBytes(rawBytes: number): number {
  return Math.ceil(checkedProduct(rawBytes, 5) / 4);
}

function checkedLayout(value: Readonly<RenderLayout>): RenderLayout {
  const codedWidth = dimension(value.codedWidth);
  const codedHeight = dimension(value.codedHeight);
  const storageWidth = dimension(value.storageWidth);
  const storageHeight = dimension(value.storageHeight);
  const logicalWidth = dimension(value.logicalWidth);
  const logicalHeight = dimension(value.logicalHeight);
  const pixelAspect = value.pixelAspect;
  if (
    pixelAspect.length !== 2 ||
    !Number.isSafeInteger(pixelAspect[0]) || pixelAspect[0] < 1 ||
    !Number.isSafeInteger(pixelAspect[1]) || pixelAspect[1] < 1 ||
    !Number.isFinite(logicalWidth * pixelAspect[0] / pixelAspect[1])
  ) throw new RangeError("renderer pixel aspect is invalid");
  if (storageWidth > codedWidth || storageHeight > codedHeight) {
    throw new RangeError("renderer storage exceeds coded dimensions");
  }
  const colorRect = rect(value.colorRect, storageWidth, storageHeight);
  const alphaRect = value.alphaRect === undefined
    ? undefined : rect(value.alphaRect, storageWidth, storageHeight);
  const paneWidth = colorRect[2] + colorRect[2] % 2;
  const paneHeight = colorRect[3] + colorRect[3] % 2;
  const expectedHeight = alphaRect === undefined
    ? paneHeight : paneHeight * 2 + 8;
  if (
    colorRect[0] !== 0 || colorRect[1] !== 0 ||
    storageWidth !== paneWidth || storageHeight !== expectedHeight ||
    alphaRect !== undefined && (
      alphaRect[0] !== 0 || alphaRect[1] !== paneHeight + 8 ||
      alphaRect[2] !== colorRect[2] || alphaRect[3] !== colorRect[3]
    )
  ) {
    throw new RangeError("renderer storage rectangle is not canonical");
  }
  return Object.freeze({
    codedWidth,
    codedHeight,
    storageWidth,
    storageHeight,
    logicalWidth,
    logicalHeight,
    pixelAspect: Object.freeze([pixelAspect[0], pixelAspect[1]]) as
      readonly [number, number],
    colorRect,
    ...(alphaRect === undefined ? {} : { alphaRect })
  });
}

function validateFrame(
  frame: VideoFrame,
  layout: Readonly<RenderLayout>
): DOMRectReadOnly {
  const visible = frame.visibleRect;
  if (
    visible === null ||
    !Number.isSafeInteger(frame.codedWidth) || frame.codedWidth < 1 ||
    !Number.isSafeInteger(frame.codedHeight) || frame.codedHeight < 1 ||
    frame.displayWidth !== layout.storageWidth ||
    frame.displayHeight !== layout.storageHeight ||
    !Number.isSafeInteger(visible.x) || visible.x < 0 ||
    !Number.isSafeInteger(visible.y) || visible.y < 0 ||
    visible.width !== layout.storageWidth ||
    visible.height !== layout.storageHeight ||
    visible.x > frame.codedWidth - visible.width ||
    visible.y > frame.codedHeight - visible.height
  ) throw new Error("decoded frame geometry is invalid");
  return visible;
}

function residentKey(group: string, index: number): string {
  if (!ID.test(group) || !Number.isSafeInteger(index) || index < 0) {
    throw new RangeError("resident frame key is invalid");
  }
  return `${group}\0${String(index)}`;
}

function rect(
  value: readonly number[],
  width: number,
  height: number
): readonly [number, number, number, number] {
  if (value.length !== 4) throw new RangeError("renderer rectangle is invalid");
  const result = [
    coordinate(value[0]),
    coordinate(value[1]),
    dimension(value[2]),
    dimension(value[3])
  ] as [number, number, number, number];
  if (
    result[0] > width - result[2] ||
    result[1] > height - result[3]
  ) throw new RangeError("renderer rectangle exceeds storage");
  return Object.freeze(result);
}

function coordinate(value: number | undefined): number {
  if (!Number.isSafeInteger(value) || value === undefined || value < 0) {
    throw new RangeError("renderer coordinate is invalid");
  }
  return value;
}

function dimension(value: number | undefined): number {
  if (value === undefined || !Number.isSafeInteger(value) || value < 1) {
    throw new RangeError("renderer dimension is invalid");
  }
  return value;
}

function rgbaBytes(width: number, height: number): number {
  return checkedProduct(checkedProduct(width, height), 4);
}

function checkedProduct(left: number, right: number): number {
  if (
    !Number.isSafeInteger(left) || left < 0 ||
    !Number.isSafeInteger(right) || right < 0 ||
    right !== 0 && left > Math.floor(Number.MAX_SAFE_INTEGER / right)
  ) throw new RangeError("renderer byte count is unsafe");
  return left * right;
}

function checkedSum(values: readonly number[]): number {
  let total = 0;
  for (const value of values) {
    if (value > Number.MAX_SAFE_INTEGER - total) {
      throw new RangeError("renderer byte sum is unsafe");
    }
    total += value;
  }
  return total;
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

function drainErrors(gl: WebGL2RenderingContext): void {
  for (let index = 0; index < 8 && gl.getError() !== gl.NO_ERROR; index += 1) {
    // Error draining is bounded because a lost context may report forever.
  }
}

function unavailable(): Error {
  return new DOMException("WebGL renderer is unavailable", "AbortError");
}

function timed<T>(
  operation: Promise<T>,
  milliseconds: number,
  setTimeout: (callback: () => void, delay: number) => number,
  clearTimeout: (handle: number) => void
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new DOMException("decoded frame copy timed out", "TimeoutError"));
    }, milliseconds);
    operation.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function createProgram(
  gl: WebGL2RenderingContext,
  layout: Readonly<RenderLayout>
): WebGLProgram {
  let vertex: WebGLShader | null = null;
  let fragment: WebGLShader | null = null;
  let program: WebGLProgram | null = null;
  try {
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
    return program;
  } catch (error) {
    if (program !== null) gl.deleteProgram(program);
    throw error;
  } finally {
    if (vertex !== null) gl.deleteShader(vertex);
    if (fragment !== null) gl.deleteShader(fragment);
  }
}

function shader(
  gl: WebGL2RenderingContext,
  kind: number,
  source: string
): WebGLShader {
  const result = gl.createShader(kind);
  if (result === null) throw new Error("WebGL shader is unavailable");
  gl.shaderSource(result, source);
  gl.compileShader(result);
  if (!gl.getShaderParameter(result, gl.COMPILE_STATUS)) {
    gl.deleteShader(result);
    throw new Error("WebGL shader compilation failed");
  }
  return result;
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
