import { STREAMING_SLOT_COUNT } from "./resident-frame-plan.js";

export { STREAMING_SLOT_COUNT } from "./resident-frame-plan.js";

export type FrameRendererState = "active" | "lost" | "error" | "disposed";

export interface FrameTextureLayout {
  readonly width: number;
  readonly height: number;
  readonly layerCount: number;
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

export type BackendTextureKind = "resident" | "stream";

/** Small injectable boundary used for deterministic ownership tests. */
export interface FrameRendererBackend {
  readonly limits: Readonly<FrameRendererBackendLimits>;
  allocate(layout: FrameTextureLayout, streamingSlots: number): void;
  upload(kind: BackendTextureKind, index: number, pixels: Uint8Array): void;
  draw(kind: BackendTextureKind, index: number): void;
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

export interface WebGlFrameRendererSnapshot {
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

export interface WebGlFrameRendererOptions {
  readonly streamingSlots?: number;
}

/**
 * Owns one bounded staging buffer and serializes every async frame copy before
 * passing packed RGBA bytes to an injected WebGL backend. Source frames are
 * always closed exactly once by this class after ownership is transferred.
 */
export class WebGlFrameRenderer {
  readonly #layout: Readonly<FrameTextureLayout>;
  readonly #streamingSlots: number;
  readonly #staging: Uint8Array;
  readonly #uploadedResidentLayers = new Set<number>();
  readonly #streamingSlotVersions = new Map<
    number,
    { readonly pathGeneration: number; readonly uploadSerial: number }
  >();

  #backend: FrameRendererBackend | null;
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
    backend: FrameRendererBackend,
    layout: FrameTextureLayout,
    options: WebGlFrameRendererOptions = {}
  ) {
    this.#layout = freezeLayout(layout);
    this.#streamingSlots = validateStreamingSlots(
      options.streamingSlots ?? STREAMING_SLOT_COUNT
    );
    validateBackendLimits(backend, this.#layout);
    this.#staging = new Uint8Array(
      checkedRgbaBytes(this.#layout.width, this.#layout.height)
    );
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
    validateIndex(layer, this.#layout.layerCount, "resident layer");
    return this.#queueUpload(
      source,
      resourceGeneration,
      () => {
        this.#requireActiveBackend().upload("resident", layer, this.#staging);
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
    validateIndex(slot, this.#streamingSlots, "streaming slot");
    validateGeneration(pathGeneration, "path generation");
    return this.#queueUpload(
      source,
      resourceGeneration,
      () => {
        this.#requireActiveBackend().upload("stream", slot, this.#staging);
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
    validateIndex(layer, this.#layout.layerCount, "resident layer");
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
    if (handle.kind === "resident") {
      validateIndex(handle.layer, this.#layout.layerCount, "resident layer");
      if (!this.#uploadedResidentLayers.has(handle.layer)) {
        throw new RendererFrameUnavailableError(
          `resident layer ${String(handle.layer)} has not been uploaded`
        );
      }
      backend.draw("resident", handle.layer);
    } else {
      validateIndex(handle.slot, this.#streamingSlots, "streaming slot");
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
    this.#draws += 1;
  }

  public readPixels(): Uint8Array {
    this.#assertActive();
    const readPixels = this.#requireActiveBackend().readPixels;
    if (readPixels === undefined) {
      throw new RendererUnavailableError("pixel readback is unavailable");
    }
    return readPixels.call(this.#backend);
  }

  /** Invalidates all GL handles and closes the current backend. */
  public markContextLost(): void {
    if (this.#state === "disposed" || this.#state === "lost") {
      return;
    }
    this.#state = "lost";
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
    if (this.#state === "disposed") {
      throw new RendererDisposedError();
    }
    if (this.#state !== "lost" && this.#state !== "error") {
      throw new Error(`cannot restore a renderer in state ${this.#state}`);
    }
    validateBackendLimits(backend, this.#layout);
    try {
      backend.allocate(this.#layout, this.#streamingSlots);
    } catch (error) {
      this.#state = "error";
      this.#errors += 1;
      safeDisposeBackend(backend);
      throw normalizeError(error, "failed to restore WebGL frame textures");
    }
    this.#backend = backend;
    this.#state = "active";
    this.#uploadedResidentLayers.clear();
    this.#streamingSlotVersions.clear();
  }

  public snapshot(): WebGlFrameRendererSnapshot {
    return Object.freeze({
      state: this.#state,
      resourceGeneration: this.#resourceGeneration,
      stagingBytes: this.#staging.byteLength,
      allocatedLayers:
        this.#state === "active" ? this.#layout.layerCount : 0,
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
    upload: () => T
  ): Promise<T | null> {
    validateGeneration(resourceGeneration, "resource generation");
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
        await source.frame.copyTo(this.#staging, {
          rect: visibleRect,
          format: "RGBA",
          layout: [
            {
              offset: 0,
              stride: this.#layout.width * 4
            }
          ]
        });
        if (
          this.#state !== "active" ||
          resourceGeneration !== this.#resourceGeneration
        ) {
          this.#staleUploads += 1;
          return;
        }
        result = upload();
      } catch (error) {
        if (this.#state !== "disposed" && this.#state !== "lost") {
          this.#state = "error";
          this.#resourceGeneration += 1;
          this.#errors += 1;
          const backend = this.#backend;
          this.#backend = null;
          this.#uploadedResidentLayers.clear();
          this.#streamingSlotVersions.clear();
          if (backend !== null) {
            safeDisposeBackend(backend);
          }
        }
        throw normalizeError(error, "failed to upload a WebGL frame");
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

  #requireActiveBackend(): FrameRendererBackend {
    this.#assertActive();
    const backend = this.#backend;
    if (backend === null) {
      throw new RendererUnavailableError(this.#state);
    }
    return backend;
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

/** Real WebGL2 backend. Context lifecycle is coordinated by the player. */
export class BrowserWebGl2FrameBackend implements FrameRendererBackend {
  public readonly limits: Readonly<FrameRendererBackendLimits>;

  readonly #canvas: HTMLCanvasElement;
  readonly #gl: WebGL2RenderingContext;
  #residentTexture: WebGLTexture | null = null;
  #streamingTexture: WebGLTexture | null = null;
  #program: WebGLProgram | null = null;
  #vertexArray: WebGLVertexArrayObject | null = null;
  #layerLocation: WebGLUniformLocation | null = null;
  #samplerLocation: WebGLUniformLocation | null = null;
  #allocated = false;
  #disposed = false;

  public constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      depth: false,
      desynchronized: true,
      preserveDrawingBuffer: true,
      premultipliedAlpha: true
    });
    if (gl === null) {
      throw new RendererUnavailableError("WebGL2 is unavailable");
    }
    this.#canvas = canvas;
    this.#gl = gl;
    this.limits = Object.freeze({
      maxTextureSize: requirePositiveGlLimit(
        gl.getParameter(gl.MAX_TEXTURE_SIZE),
        "MAX_TEXTURE_SIZE"
      ),
      maxArrayTextureLayers: requirePositiveGlLimit(
        gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS),
        "MAX_ARRAY_TEXTURE_LAYERS"
      )
    });
  }

  public allocate(layout: FrameTextureLayout, streamingSlots: number): void {
    this.#assertUsable();
    if (this.#allocated) {
      throw new Error("WebGL frame textures are already allocated");
    }
    validateBackendLimits(this, layout);
    validateStreamingSlots(streamingSlots);
    const gl = this.#gl;
    this.#canvas.width = layout.width;
    this.#canvas.height = layout.height;

    try {
      this.#program = createProgram(gl);
      this.#vertexArray = requireGlObject(
        gl.createVertexArray(),
        "vertex array"
      );
      this.#residentTexture = createTextureArray(
        gl,
        layout.width,
        layout.height,
        layout.layerCount
      );
      this.#streamingTexture = createTextureArray(
        gl,
        layout.width,
        layout.height,
        streamingSlots
      );
      this.#layerLocation = gl.getUniformLocation(this.#program, "u_layer");
      this.#samplerLocation = gl.getUniformLocation(this.#program, "u_frames");
      if (this.#layerLocation === null || this.#samplerLocation === null) {
        throw new Error("WebGL frame shader uniforms are unavailable");
      }
      assertNoGlError(gl, "texture allocation");
      this.#allocated = true;
    } catch (error) {
      this.#deleteResources();
      throw error;
    }
  }

  public upload(
    kind: BackendTextureKind,
    index: number,
    pixels: Uint8Array
  ): void {
    this.#assertAllocated();
    const gl = this.#gl;
    const texture = this.#textureFor(kind);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage3D(
      gl.TEXTURE_2D_ARRAY,
      0,
      0,
      0,
      index,
      this.#canvas.width,
      this.#canvas.height,
      1,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      pixels
    );
    assertNoGlError(gl, `${kind} texture upload`);
  }

  public draw(kind: BackendTextureKind, index: number): void {
    this.#assertAllocated();
    const gl = this.#gl;
    const program = requireGlObject(this.#program, "shader program");
    gl.viewport(0, 0, this.#canvas.width, this.#canvas.height);
    gl.useProgram(program);
    gl.bindVertexArray(this.#vertexArray);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.#textureFor(kind));
    gl.uniform1i(this.#samplerLocation, 0);
    gl.uniform1f(this.#layerLocation, index);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    assertNoGlError(gl, `${kind} texture draw`);
  }

  public readPixels(): Uint8Array {
    this.#assertAllocated();
    const bottomUp = new Uint8Array(
      checkedRgbaBytes(this.#canvas.width, this.#canvas.height)
    );
    this.#gl.readPixels(
      0,
      0,
      this.#canvas.width,
      this.#canvas.height,
      this.#gl.RGBA,
      this.#gl.UNSIGNED_BYTE,
      bottomUp
    );
    assertNoGlError(this.#gl, "pixel readback");
    return flipRgbaRows(bottomUp, this.#canvas.width, this.#canvas.height);
  }

  public dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#deleteResources();
  }

  #textureFor(kind: BackendTextureKind): WebGLTexture {
    return requireGlObject(
      kind === "resident" ? this.#residentTexture : this.#streamingTexture,
      `${kind} texture`
    );
  }

  #assertUsable(): void {
    if (this.#disposed) {
      throw new RendererDisposedError();
    }
  }

  #assertAllocated(): void {
    this.#assertUsable();
    if (!this.#allocated || this.#gl.isContextLost()) {
      throw new RendererUnavailableError("WebGL context is not ready");
    }
  }

  #deleteResources(): void {
    const gl = this.#gl;
    if (this.#residentTexture !== null) {
      gl.deleteTexture(this.#residentTexture);
      this.#residentTexture = null;
    }
    if (this.#streamingTexture !== null) {
      gl.deleteTexture(this.#streamingTexture);
      this.#streamingTexture = null;
    }
    if (this.#vertexArray !== null) {
      gl.deleteVertexArray(this.#vertexArray);
      this.#vertexArray = null;
    }
    if (this.#program !== null) {
      gl.deleteProgram(this.#program);
      this.#program = null;
    }
    this.#layerLocation = null;
    this.#samplerLocation = null;
    this.#allocated = false;
  }
}

function freezeLayout(layout: FrameTextureLayout): Readonly<FrameTextureLayout> {
  const width = validateDimension(layout.width, "texture width");
  const height = validateDimension(layout.height, "texture height");
  const layerCount = validateDimension(layout.layerCount, "texture layer count");
  checkedRgbaBytes(width, height);
  return Object.freeze({ width, height, layerCount });
}

function validateFrameGeometry(
  frame: CopyableVideoFrame,
  layout: Readonly<FrameTextureLayout>
): DOMRectReadOnly {
  const visible = frame.visibleRect;
  const maximumCodedWidth = Math.ceil(layout.width / 16) * 16 + 16;
  const maximumCodedHeight = Math.ceil(layout.height / 16) * 16 + 16;
  if (
    visible === null ||
    frame.displayWidth !== layout.width ||
    frame.displayHeight !== layout.height ||
    visible.width !== layout.width ||
    visible.height !== layout.height ||
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

function validateBackendLimits(
  backend: FrameRendererBackend,
  layout: Readonly<FrameTextureLayout>
): void {
  const { maxTextureSize, maxArrayTextureLayers } = backend.limits;
  validateDimension(maxTextureSize, "MAX_TEXTURE_SIZE");
  validateDimension(maxArrayTextureLayers, "MAX_ARRAY_TEXTURE_LAYERS");
  if (layout.width > maxTextureSize || layout.height > maxTextureSize) {
    throw new RangeError("frame texture dimensions exceed MAX_TEXTURE_SIZE");
  }
  if (layout.layerCount > maxArrayTextureLayers) {
    throw new RangeError("resident layers exceed MAX_ARRAY_TEXTURE_LAYERS");
  }
}

function checkedRgbaBytes(width: number, height: number): number {
  const pixels = width * height;
  const bytes = pixels * 4;
  if (!Number.isSafeInteger(pixels) || !Number.isSafeInteger(bytes)) {
    throw new RangeError("RGBA staging byte count exceeds safe integer range");
  }
  return bytes;
}

function validateDimension(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function validateStreamingSlots(value: number): number {
  if (value !== STREAMING_SLOT_COUNT) {
    throw new RangeError(
      `streaming slots must be exactly ${String(STREAMING_SLOT_COUNT)}`
    );
  }
  return value;
}

function validateIndex(value: number, exclusiveEnd: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value >= exclusiveEnd) {
    throw new RangeError(
      `${label} must be an integer in [0, ${String(exclusiveEnd)})`
    );
  }
}

function validateGeneration(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
}

function safeDisposeBackend(backend: FrameRendererBackend): void {
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

function requirePositiveGlLimit(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new RendererUnavailableError(`${label} is invalid`);
  }
  return value;
}

function requireGlObject<T>(value: T | null, label: string): T {
  if (value === null) {
    throw new Error(`failed to create WebGL ${label}`);
  }
  return value;
}

function createTextureArray(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
  layers: number
): WebGLTexture {
  const texture = requireGlObject(gl.createTexture(), "texture array");
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, width, height, layers);
  return texture;
}

function createProgram(gl: WebGL2RenderingContext): WebGLProgram {
  let vertex: WebGLShader | null = null;
  let fragment: WebGLShader | null = null;
  let program: WebGLProgram | null = null;

  try {
    vertex = compileShader(
      gl,
      gl.VERTEX_SHADER,
      `#version 300 es
    precision highp float;
    const vec2 positions[3] = vec2[](
      vec2(-1.0, -1.0),
      vec2(3.0, -1.0),
      vec2(-1.0, 3.0)
    );
    out vec2 v_uv;
    void main() {
      vec2 position = positions[gl_VertexID];
      gl_Position = vec4(position, 0.0, 1.0);
      v_uv = vec2((position.x + 1.0) * 0.5, 1.0 - (position.y + 1.0) * 0.5);
    }`
    );
    fragment = compileShader(
      gl,
      gl.FRAGMENT_SHADER,
      `#version 300 es
    precision highp float;
    precision highp sampler2DArray;
    in vec2 v_uv;
    uniform sampler2DArray u_frames;
    uniform float u_layer;
    out vec4 out_color;
    void main() {
      out_color = texture(u_frames, vec3(v_uv, u_layer));
    }`
    );
    program = requireGlObject(gl.createProgram(), "shader program");
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    if (gl.getProgramParameter(program, gl.LINK_STATUS) !== true) {
      throw new Error(
        `failed to link WebGL frame shader: ${gl.getProgramInfoLog(program) ?? "unknown error"}`
      );
    }
    return program;
  } catch (error) {
    if (program !== null) {
      gl.deleteProgram(program);
    }
    throw error;
  } finally {
    if (vertex !== null) {
      gl.deleteShader(vertex);
    }
    if (fragment !== null) {
      gl.deleteShader(fragment);
    }
  }
}

function compileShader(
  gl: WebGL2RenderingContext,
  type: number,
  source: string
): WebGLShader {
  const shader = requireGlObject(gl.createShader(type), "shader");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS) !== true) {
    const message = gl.getShaderInfoLog(shader) ?? "unknown error";
    gl.deleteShader(shader);
    throw new Error(`failed to compile WebGL frame shader: ${message}`);
  }
  return shader;
}

function assertNoGlError(gl: WebGL2RenderingContext, operation: string): void {
  const error = gl.getError();
  if (error !== gl.NO_ERROR) {
    throw new Error(`${operation} failed with WebGL error ${String(error)}`);
  }
}

function flipRgbaRows(
  bottomUp: Uint8Array,
  width: number,
  height: number
): Uint8Array {
  const stride = width * 4;
  const topDown = new Uint8Array(bottomUp.byteLength);
  for (let sourceRow = 0; sourceRow < height; sourceRow += 1) {
    const targetRow = height - 1 - sourceRow;
    topDown.set(
      bottomUp.subarray(sourceRow * stride, (sourceRow + 1) * stride),
      targetRow * stride
    );
  }
  return topDown;
}
