import {
  RendererDisposedError,
  RendererUnavailableError,
  type CopyableVideoFrame,
  type FrameRendererBackend,
  type FrameRendererBackendLimits,
  type FrameSourceLayout,
  type FrameTextureLayout,
  type FrameTextureKind,
  type LegacyOpaqueFrameRendererBackend,
  type LegacyOpaqueFrameTextureLayout
} from "./frame-renderer.js";
import {
  checkedFrameRgbaBytes,
  createLegacyOpaqueFrameLayout,
  deriveFrameSamplingLayout,
  freezeFrameLayout,
  validateFrameBackendLimits,
  validateFrameStreamingSlots,
  type FrameSamplingLayout
} from "./frame-renderer-validation.js";
import {
  rasterizePresentationRect,
  type PresentationGeometry
} from "./presentation-geometry.js";

export interface BrowserFrameBackendOptions {
  /** Debug/test-only swap retention; production defaults to the fast path. */
  readonly preserveDrawingBuffer?: boolean;
  /** Debug/test-only GL polling after every upload and draw. */
  readonly checkErrors?: boolean;
}

/** Real profile-neutral WebGL2 compositor. */
export class BrowserFrameBackend implements FrameRendererBackend {
  public readonly limits: Readonly<FrameRendererBackendLimits>;

  readonly #canvas: HTMLCanvasElement;
  readonly #gl: WebGL2RenderingContext;
  readonly #checkErrors: boolean;
  #residentTexture: WebGLTexture | null = null;
  #streamingTexture: WebGLTexture | null = null;
  #program: WebGLProgram | null = null;
  #vertexArray: WebGLVertexArrayObject | null = null;
  #layerLocation: WebGLUniformLocation | null = null;
  #samplerLocation: WebGLUniformLocation | null = null;
  #colorUvLocation: WebGLUniformLocation | null = null;
  #alphaUvLocation: WebGLUniformLocation | null = null;
  #hasAlphaLocation: WebGLUniformLocation | null = null;
  #outputRectLocation: WebGLUniformLocation | null = null;
  #sampling: Readonly<FrameSamplingLayout> | null = null;
  #presentation: Readonly<BackendPresentationMapping> | null = null;
  #logicalWidth = 0;
  #logicalHeight = 0;
  #lastDraw: Readonly<{ readonly kind: FrameTextureKind; readonly index: number }> | null = null;
  #codedWidth = 0;
  #codedHeight = 0;
  #allocated = false;
  #disposed = false;

  public constructor(
    canvas: HTMLCanvasElement,
    options: Readonly<BrowserFrameBackendOptions> = {}
  ) {
    this.#checkErrors = options.checkErrors ?? false;
    let gl: WebGL2RenderingContext | null;
    try {
      gl = canvas.getContext("webgl2", {
        alpha: true,
        antialias: false,
        depth: false,
        desynchronized: true,
        preserveDrawingBuffer: options.preserveDrawingBuffer ?? false,
        premultipliedAlpha: true
      });
    } catch {
      throw new RendererUnavailableError("WebGL2 context creation failed");
    }
    if (gl === null) {
      throw new RendererUnavailableError("WebGL2 is unavailable");
    }
    this.#canvas = canvas;
    this.#gl = gl;
    try {
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
    } catch {
      throw new RendererUnavailableError("WebGL2 device limits are unavailable");
    }
  }

  public allocate(
    layout: FrameTextureLayout,
    streamingSlots: number
  ): void {
    this.#assertUsable();
    if (this.#allocated) {
      throw new Error("WebGL frame textures are already allocated");
    }
    const checkedLayout = freezeFrameLayout(layout);
    validateFrameBackendLimits(this, checkedLayout);
    validateFrameStreamingSlots(streamingSlots);
    this.#assertUsable();
    const gl = this.#gl;
    try {
      this.#logicalWidth = checkedLayout.logicalWidth;
      this.#logicalHeight = checkedLayout.logicalHeight;
      if (this.#presentation === null) {
        this.#canvas.width = checkedLayout.logicalWidth;
        this.#assertUsable();
        this.#canvas.height = checkedLayout.logicalHeight;
        this.#assertUsable();
        this.#assertExactBacking(
          checkedLayout.logicalWidth,
          checkedLayout.logicalHeight
        );
      } else {
        validatePresentationMapping(
          this.#presentation,
          checkedLayout.logicalWidth,
          checkedLayout.logicalHeight
        );
        this.#canvas.width = this.#presentation.backingWidth;
        this.#assertUsable();
        this.#canvas.height = this.#presentation.backingHeight;
        this.#assertUsable();
        this.#assertExactBacking(
          this.#presentation.backingWidth,
          this.#presentation.backingHeight
        );
      }
      this.#assertUsable();
      this.#codedWidth = checkedLayout.geometry.codedWidth;
      this.#codedHeight = checkedLayout.geometry.codedHeight;
      this.#sampling = deriveFrameSamplingLayout(checkedLayout);
      this.#assertUsable();
      this.#program = createProgram(gl);
      this.#vertexArray = requireGlObject(
        gl.createVertexArray(),
        "vertex array"
      );
      this.#residentTexture = checkedLayout.residentLayerCount === 0
        ? null
        : createTextureArray(
            gl,
            checkedLayout.geometry.codedWidth,
            checkedLayout.geometry.codedHeight,
            checkedLayout.residentLayerCount
          );
      this.#streamingTexture = createTextureArray(
        gl,
        checkedLayout.geometry.codedWidth,
        checkedLayout.geometry.codedHeight,
        streamingSlots
      );
      this.#layerLocation = gl.getUniformLocation(this.#program, "u_layer");
      this.#samplerLocation = gl.getUniformLocation(this.#program, "u_frames");
      this.#colorUvLocation = gl.getUniformLocation(this.#program, "u_color_uv");
      this.#alphaUvLocation = gl.getUniformLocation(this.#program, "u_alpha_uv");
      this.#hasAlphaLocation = gl.getUniformLocation(this.#program, "u_has_alpha");
      this.#outputRectLocation = gl.getUniformLocation(this.#program, "u_output_rect");
      if (
        this.#layerLocation === null ||
        this.#samplerLocation === null ||
        this.#colorUvLocation === null ||
        this.#alphaUvLocation === null ||
        this.#hasAlphaLocation === null ||
        this.#outputRectLocation === null
      ) {
        throw new Error("WebGL frame shader uniforms are unavailable");
      }
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.clearColor(0, 0, 0, 0);
      assertNoGlError(gl, "texture allocation");
      this.#assertUsable();
      this.#allocated = true;
    } catch (error) {
      this.#deleteResources();
      if (this.#disposed) throw new RendererDisposedError();
      throw error;
    }
  }

  public upload(
    kind: FrameTextureKind,
    index: number,
    pixels: Uint8Array
  ): void {
    this.#assertAllocated();
    const expectedBytes = checkedFrameRgbaBytes(
      this.#codedWidth,
      this.#codedHeight
    );
    if (pixels.byteLength !== expectedBytes) {
      throw new RangeError("frame upload must contain one coded RGBA layer");
    }
    const gl = this.#gl;
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.#textureFor(kind));
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage3D(
      gl.TEXTURE_2D_ARRAY,
      0,
      0,
      0,
      index,
      this.#codedWidth,
      this.#codedHeight,
      1,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      pixels
    );
    if (this.#checkErrors) assertNoGlError(gl, `${kind} texture upload`);
    this.#assertAllocated();
  }

  public uploadFrame(
    kind: FrameTextureKind,
    index: number,
    frame: CopyableVideoFrame,
    layout: Readonly<FrameSourceLayout>
  ): void {
    this.#assertAllocated();
    validateSourceLayout(layout, this.#codedWidth, this.#codedHeight);
    const gl = this.#gl;
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.#textureFor(kind));
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage3D(
      gl.TEXTURE_2D_ARRAY,
      0,
      layout.x,
      layout.y,
      index,
      layout.width,
      layout.height,
      1,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      frame as VideoFrame
    );
    // A native-source overload can fail only through the GL error channel.
    // Always consume it so FrameRenderer can retry with its RGBA copy fallback.
    assertNoGlError(gl, `${kind} native frame upload`);
    this.#assertAllocated();
  }

  /** Resize/redraw only; decoder, textures, graph time, and generations survive. */
  public setPresentationGeometry(
    geometry: Readonly<PresentationGeometry>
  ): boolean {
    this.#assertUsable();
    const mapping = clonePresentationMapping(geometry);
    this.#assertUsable();
    if (
      mapping.backingWidth > this.limits.maxTextureSize ||
      mapping.backingHeight > this.limits.maxTextureSize
    ) {
      throw new RendererUnavailableError(
        "presentation backing exceeds WebGL MAX_TEXTURE_SIZE"
      );
    }
    if (this.#logicalWidth > 0) {
      validatePresentationMapping(
        mapping,
        this.#logicalWidth,
        this.#logicalHeight
      );
    }
    if (samePresentationMapping(this.#presentation, mapping)) return false;
    const previous = this.#presentation;
    const previousWidth = this.#canvas.width;
    const previousHeight = this.#canvas.height;
    const last = this.#lastDraw;
    this.#presentation = mapping;
    try {
      this.#canvas.width = mapping.backingWidth;
      this.#assertUsable();
      this.#canvas.height = mapping.backingHeight;
      this.#assertUsable();
      this.#assertExactBacking(mapping.backingWidth, mapping.backingHeight);
      if (this.#allocated && last !== null) this.draw(last.kind, last.index);
    } catch (error) {
      this.#presentation = previous;
      if (this.#disposed) throw new RendererDisposedError();
      let rollbackFailed = false;
      try {
        this.#canvas.width = previousWidth;
      } catch {
        rollbackFailed = true;
      }
      try {
        this.#canvas.height = previousHeight;
      } catch {
        rollbackFailed = true;
      }
      if (this.#allocated && last !== null) {
        try {
          this.draw(last.kind, last.index);
        } catch {
          rollbackFailed = true;
        }
      }
      if (rollbackFailed) {
        this.dispose();
        throw new RendererUnavailableError(
          "frame presentation rollback failed"
        );
      }
      throw new RendererUnavailableError("frame presentation update failed");
    }
    return true;
  }

  public draw(kind: FrameTextureKind, index: number): void {
    this.#assertAllocated();
    const gl = this.#gl;
    const program = requireGlObject(this.#program, "shader program");
    const baseSampling = requireGlObject(this.#sampling, "sampling layout");
    const presentation = this.#presentation;
    const sampling = presentation === null
      ? baseSampling
      : cropSamplingLayout(
          baseSampling,
          presentation,
          this.#logicalWidth,
          this.#logicalHeight
        );
    const canvasWidth = this.#canvas.width;
    const canvasHeight = this.#canvas.height;
    this.#assertAllocated();
    let viewportX = 0;
    let viewportY = 0;
    let viewportWidth = canvasWidth;
    let viewportHeight = canvasHeight;
    gl.viewport(viewportX, viewportY, viewportWidth, viewportHeight);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (presentation !== null) {
      const destination = presentation.destination;
      viewportX = destination.x;
      viewportY = canvasHeight - destination.y - destination.height;
      viewportWidth = destination.width;
      viewportHeight = destination.height;
      gl.viewport(
        viewportX,
        viewportY,
        viewportWidth,
        viewportHeight
      );
    }
    gl.useProgram(program);
    gl.bindVertexArray(this.#vertexArray);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.#textureFor(kind));
    gl.uniform1i(this.#samplerLocation, 0);
    gl.uniform1f(this.#layerLocation, index);
    gl.uniform1f(this.#hasAlphaLocation, sampling.hasAlpha ? 1 : 0);
    gl.uniform4f(
      this.#outputRectLocation,
      viewportX,
      viewportY,
      viewportWidth,
      viewportHeight
    );
    setUvUniform(gl, this.#colorUvLocation, sampling.color);
    setUvUniform(
      gl,
      this.#alphaUvLocation,
      sampling.alpha ?? sampling.color
    );
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (this.#checkErrors) assertNoGlError(gl, `${kind} texture draw`);
    this.#assertAllocated();
    this.#lastDraw = Object.freeze({ kind, index });
  }

  public readPixels(): Uint8Array {
    this.#assertAllocated();
    const width = this.#canvas.width;
    const height = this.#canvas.height;
    this.#assertAllocated();
    const bottomUp = new Uint8Array(
      checkedFrameRgbaBytes(width, height)
    );
    this.#gl.readPixels(
      0,
      0,
      width,
      height,
      this.#gl.RGBA,
      this.#gl.UNSIGNED_BYTE,
      bottomUp
    );
    assertNoGlError(this.#gl, "pixel readback");
    this.#assertAllocated();
    return flipRgbaRows(bottomUp, width, height);
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#deleteResources();
  }

  #assertExactBacking(width: number, height: number): void {
    if (this.#canvas.width !== width || this.#canvas.height !== height) {
      throw new RendererUnavailableError(
        "browser did not allocate the exact frame backing"
      );
    }
  }

  #textureFor(kind: FrameTextureKind): WebGLTexture {
    return requireGlObject(
      kind === "resident" ? this.#residentTexture : this.#streamingTexture,
      `${kind} texture`
    );
  }

  #assertUsable(): void {
    if (this.#disposed) throw new RendererDisposedError();
  }

  #assertAllocated(): void {
    this.#assertUsable();
    if (!this.#allocated) {
      throw new RendererUnavailableError("WebGL context is not ready");
    }
    const contextLost = this.#gl.isContextLost();
    this.#assertUsable();
    if (!this.#allocated || contextLost) {
      throw new RendererUnavailableError("WebGL context is not ready");
    }
  }

  #deleteResources(): void {
    const gl = this.#gl;
    if (this.#residentTexture !== null) {
      const texture = this.#residentTexture;
      this.#residentTexture = null;
      safeDeleteGlObject(() => gl.deleteTexture(texture));
    }
    if (this.#streamingTexture !== null) {
      const texture = this.#streamingTexture;
      this.#streamingTexture = null;
      safeDeleteGlObject(() => gl.deleteTexture(texture));
    }
    if (this.#vertexArray !== null) {
      const vertexArray = this.#vertexArray;
      this.#vertexArray = null;
      safeDeleteGlObject(() => gl.deleteVertexArray(vertexArray));
    }
    if (this.#program !== null) {
      const program = this.#program;
      this.#program = null;
      safeDeleteGlObject(() => gl.deleteProgram(program));
    }
    this.#layerLocation = null;
    this.#samplerLocation = null;
    this.#colorUvLocation = null;
    this.#alphaUvLocation = null;
    this.#hasAlphaLocation = null;
    this.#outputRectLocation = null;
    this.#sampling = null;
    this.#codedWidth = 0;
    this.#codedHeight = 0;
    this.#allocated = false;
  }
}

interface BackendPresentationMapping {
  readonly backingWidth: number;
  readonly backingHeight: number;
  readonly sourceX: number;
  readonly sourceY: number;
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly destination: Readonly<{
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  }>;
}

function clonePresentationMapping(
  geometry: Readonly<PresentationGeometry>
): Readonly<BackendPresentationMapping> {
  if (geometry === null || typeof geometry !== "object") {
    throw new TypeError("browser presentation geometry must be an object");
  }
  const destination = rasterizePresentationRect(
    geometry.destinationBackingRect
  );
  const mapping = Object.freeze({
    backingWidth: geometry.backing.width,
    backingHeight: geometry.backing.height,
    sourceX: geometry.sourceRect.x,
    sourceY: geometry.sourceRect.y,
    sourceWidth: geometry.sourceRect.width,
    sourceHeight: geometry.sourceRect.height,
    destination
  });
  validatePresentationMapping(mapping);
  return mapping;
}

function validatePresentationMapping(
  mapping: Readonly<BackendPresentationMapping>,
  logicalWidth?: number,
  logicalHeight?: number
): void {
  for (const [value, label] of [
    [mapping.backingWidth, "backing width"],
    [mapping.backingHeight, "backing height"]
  ] as const) {
    if (
      !Number.isSafeInteger(value) ||
      value < 1
    ) {
      throw new RangeError(`browser presentation ${label} is invalid`);
    }
  }
  for (const value of [
    mapping.sourceX,
    mapping.sourceY,
    mapping.sourceWidth,
    mapping.sourceHeight
  ]) {
    if (!Number.isFinite(value)) {
      throw new RangeError("browser presentation source crop is invalid");
    }
  }
  if (
    mapping.sourceX < 0 ||
    mapping.sourceY < 0 ||
    mapping.sourceWidth <= 0 ||
    mapping.sourceHeight <= 0 ||
    (logicalWidth !== undefined &&
      mapping.sourceX + mapping.sourceWidth > logicalWidth) ||
    (logicalHeight !== undefined &&
      mapping.sourceY + mapping.sourceHeight > logicalHeight)
  ) {
    throw new RangeError("browser presentation source crop is out of bounds");
  }
}

function samePresentationMapping(
  left: Readonly<BackendPresentationMapping> | null,
  right: Readonly<BackendPresentationMapping>
): boolean {
  return left !== null &&
    left.backingWidth === right.backingWidth &&
    left.backingHeight === right.backingHeight &&
    left.sourceX === right.sourceX &&
    left.sourceY === right.sourceY &&
    left.sourceWidth === right.sourceWidth &&
    left.sourceHeight === right.sourceHeight &&
    left.destination.x === right.destination.x &&
    left.destination.y === right.destination.y &&
    left.destination.width === right.destination.width &&
    left.destination.height === right.destination.height;
}

function cropSamplingLayout(
  sampling: Readonly<FrameSamplingLayout>,
  mapping: Readonly<BackendPresentationMapping>,
  logicalWidth: number,
  logicalHeight: number
): Readonly<FrameSamplingLayout> {
  const crop = (transform: FrameSamplingLayout["color"]) => {
    const x = cropSamplingAxis(
      transform.offsetX,
      transform.scaleX,
      mapping.sourceX,
      mapping.sourceWidth,
      logicalWidth,
      sampling.visibleWidth
    );
    const y = cropSamplingAxis(
      transform.offsetY,
      transform.scaleY,
      mapping.sourceY,
      mapping.sourceHeight,
      logicalHeight,
      sampling.visibleHeight
    );
    return Object.freeze({
      offsetX: x.offset,
      offsetY: y.offset,
      scaleX: x.scale,
      scaleY: y.scale
    });
  };
  return Object.freeze({
    hasAlpha: sampling.hasAlpha,
    visibleWidth: sampling.visibleWidth,
    visibleHeight: sampling.visibleHeight,
    color: crop(sampling.color),
    alpha: sampling.alpha === null ? null : crop(sampling.alpha)
  });
}

/**
 * Compose a logical source-edge crop with a transform whose endpoints are the
 * first and last visible texel centers. Edge fractions cannot be composed
 * directly with that center-domain transform: doing so shifts both crop ends
 * toward adjacent texels. Map into rendition texel-edge space first, then
 * select the centers inside the crop.
 */
function cropSamplingAxis(
  offset: number,
  scale: number,
  sourceStart: number,
  sourceExtent: number,
  logicalExtent: number,
  visibleExtent: number
): Readonly<{ readonly offset: number; readonly scale: number }> {
  if (visibleExtent === 1) {
    return Object.freeze({ offset, scale: 0 });
  }

  const renditionScale = visibleExtent / logicalExtent;
  const texelEdgeStart = sourceStart * renditionScale;
  const texelEdgeExtent = sourceExtent * renditionScale;
  let firstCenterIndex: number;
  let lastCenterIndex: number;
  if (texelEdgeExtent >= 1) {
    firstCenterIndex = texelEdgeStart;
    lastCenterIndex = texelEdgeStart + texelEdgeExtent - 1;
  } else {
    const midpointIndex = texelEdgeStart + texelEdgeExtent / 2 - 0.5;
    firstCenterIndex = midpointIndex;
    lastCenterIndex = midpointIndex;
  }

  const lastVisibleIndex = visibleExtent - 1;
  const first = clamp(firstCenterIndex, 0, lastVisibleIndex);
  const last = clamp(lastCenterIndex, first, lastVisibleIndex);
  return Object.freeze({
    offset: offset + scale * first / lastVisibleIndex,
    scale: scale * (last - first) / lastVisibleIndex
  });
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

/** @deprecated Use BrowserFrameBackend with explicit frame geometry. */
export class LegacyBrowserOpaqueFrameBackend
implements LegacyOpaqueFrameRendererBackend {
  readonly #backend: BrowserFrameBackend;

  public constructor(
    canvas: HTMLCanvasElement,
    options: Readonly<BrowserFrameBackendOptions> = {}
  ) {
    this.#backend = new BrowserFrameBackend(canvas, options);
  }

  public get limits(): Readonly<FrameRendererBackendLimits> {
    return this.#backend.limits;
  }

  public allocate(
    layout: LegacyOpaqueFrameTextureLayout,
    streamingSlots: number
  ): void {
    this.#backend.allocate(
      createLegacyOpaqueFrameLayout(layout),
      streamingSlots
    );
  }

  public upload(
    kind: FrameTextureKind,
    index: number,
    pixels: Uint8Array
  ): void {
    this.#backend.upload(kind, index, pixels);
  }

  public uploadFrame(
    kind: FrameTextureKind,
    index: number,
    frame: CopyableVideoFrame,
    layout: Readonly<FrameSourceLayout>
  ): void {
    this.#backend.uploadFrame(kind, index, frame, layout);
  }

  public draw(kind: FrameTextureKind, index: number): void {
    this.#backend.draw(kind, index);
  }

  public readPixels(): Uint8Array {
    return this.#backend.readPixels();
  }

  public dispose(): void {
    this.#backend.dispose();
  }
}

function validateSourceLayout(
  layout: Readonly<FrameSourceLayout>,
  codedWidth: number,
  codedHeight: number
): void {
  if (
    layout === null ||
    typeof layout !== "object" ||
    !Number.isSafeInteger(layout.x) ||
    !Number.isSafeInteger(layout.y) ||
    !Number.isSafeInteger(layout.width) ||
    !Number.isSafeInteger(layout.height) ||
    layout.x < 0 ||
    layout.y < 0 ||
    layout.width < 1 ||
    layout.height < 1 ||
    layout.x + layout.width > codedWidth ||
    layout.y + layout.height > codedHeight
  ) {
    throw new RangeError("native frame upload layout is out of bounds");
  }
}

function requirePositiveGlLimit(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new RendererUnavailableError(`${label} is invalid`);
  }
  return value;
}

function requireGlObject<T>(value: T | null, label: string): T {
  if (value === null) throw new Error(`failed to create WebGL ${label}`);
  return value;
}

function safeDeleteGlObject(remove: () => void): void {
  try {
    remove();
  } catch {
    // Continue releasing every independently-owned WebGL object.
  }
}

function createTextureArray(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
  layers: number
): WebGLTexture {
  const texture = requireGlObject(gl.createTexture(), "texture array");
  try {
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, width, height, layers);
    return texture;
  } catch (error) {
    safeDeleteGlObject(() => gl.deleteTexture(texture));
    throw error;
  }
}

function createProgram(gl: WebGL2RenderingContext): WebGLProgram {
  let vertex: WebGLShader | null = null;
  let fragment: WebGLShader | null = null;
  let program: WebGLProgram | null = null;
  try {
    vertex = compileShader(gl, gl.VERTEX_SHADER, `#version 300 es
    precision highp float;
    const vec2 positions[3] = vec2[](
      vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0)
    );
    void main() {
      vec2 position = positions[gl_VertexID];
      gl_Position = vec4(position, 0.0, 1.0);
    }`);
    fragment = compileShader(gl, gl.FRAGMENT_SHADER, FRAME_FRAGMENT_SHADER_SOURCE);
    program = requireGlObject(gl.createProgram(), "shader program");
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    if (gl.getProgramParameter(program, gl.LINK_STATUS) !== true) {
      // Driver logs are neither stable nor safe diagnostics payloads.
      throw new Error("failed to link the WebGL frame shader");
    }
    return program;
  } catch (error) {
    if (program !== null) {
      safeDeleteGlObject(() => gl.deleteProgram(program));
    }
    throw error;
  } finally {
    if (vertex !== null) {
      safeDeleteGlObject(() => gl.deleteShader(vertex));
    }
    if (fragment !== null) {
      safeDeleteGlObject(() => gl.deleteShader(fragment));
    }
  }
}

export const FRAME_FRAGMENT_SHADER_SOURCE = `#version 300 es
precision highp float;
precision highp sampler2DArray;
uniform sampler2DArray u_frames;
uniform float u_layer;
uniform vec4 u_color_uv;
uniform vec4 u_alpha_uv;
uniform vec4 u_output_rect;
uniform float u_has_alpha;
out vec4 out_color;
void main() {
  vec2 output_index = gl_FragCoord.xy - u_output_rect.xy - vec2(0.5);
  vec2 output_span = max(u_output_rect.zw - vec2(1.0), vec2(1.0));
  vec2 sample_uv = output_index / output_span;
  sample_uv.y = 1.0 - sample_uv.y;
  if (u_output_rect.z <= 1.0) sample_uv.x = 0.5;
  if (u_output_rect.w <= 1.0) sample_uv.y = 0.5;
  sample_uv = clamp(sample_uv, vec2(0.0), vec2(1.0));
  vec2 color_uv = u_color_uv.xy + sample_uv * u_color_uv.zw;
  vec3 color = texture(u_frames, vec3(color_uv, u_layer)).rgb;
  float alpha = 1.0;
  if (u_has_alpha > 0.5) {
    vec2 alpha_uv = u_alpha_uv.xy + sample_uv * u_alpha_uv.zw;
    alpha = clamp(texture(u_frames, vec3(alpha_uv, u_layer)).r, 0.0, 1.0);
  }
  out_color = vec4(color * alpha, alpha);
}`;

function setUvUniform(
  gl: WebGL2RenderingContext,
  location: WebGLUniformLocation | null,
  transform: Readonly<{
    readonly offsetX: number;
    readonly offsetY: number;
    readonly scaleX: number;
    readonly scaleY: number;
  }>
): void {
  gl.uniform4f(
    location,
    transform.offsetX,
    transform.offsetY,
    transform.scaleX,
    transform.scaleY
  );
}

function compileShader(
  gl: WebGL2RenderingContext,
  type: number,
  source: string
): WebGLShader {
  const shader = requireGlObject(gl.createShader(type), "shader");
  try {
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (gl.getShaderParameter(shader, gl.COMPILE_STATUS) !== true) {
      throw new Error("failed to compile the WebGL frame shader");
    }
    return shader;
  } catch (error) {
    safeDeleteGlObject(() => gl.deleteShader(shader));
    throw error;
  }
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
