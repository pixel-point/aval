import {
  RendererDisposedError,
  RendererUnavailableError,
  type OpaqueFrameRendererBackend,
  type OpaqueFrameRendererBackendLimits,
  type OpaqueFrameTextureLayout,
  type OpaqueTextureKind
} from "./opaque-frame-renderer.js";
import {
  checkedOpaqueRgbaBytes,
  validateOpaqueBackendLimits,
  validateOpaqueStreamingSlots
} from "./opaque-frame-renderer-validation.js";

export interface BrowserOpaqueFrameBackendOptions {
  /** Debug/test-only swap retention; production defaults to the fast path. */
  readonly preserveDrawingBuffer?: boolean;
  /** Debug/test-only GL polling after every upload and draw. */
  readonly checkErrors?: boolean;
}

/** Real WebGL2 backend. Context loss is terminalized by OpaqueFrameRenderer. */
export class BrowserOpaqueFrameBackend implements OpaqueFrameRendererBackend {
  public readonly limits: Readonly<OpaqueFrameRendererBackendLimits>;

  readonly #canvas: HTMLCanvasElement;
  readonly #gl: WebGL2RenderingContext;
  readonly #checkErrors: boolean;
  #residentTexture: WebGLTexture | null = null;
  #streamingTexture: WebGLTexture | null = null;
  #program: WebGLProgram | null = null;
  #vertexArray: WebGLVertexArrayObject | null = null;
  #layerLocation: WebGLUniformLocation | null = null;
  #samplerLocation: WebGLUniformLocation | null = null;
  #codedWidth = 0;
  #codedHeight = 0;
  #allocated = false;
  #disposed = false;

  public constructor(
    canvas: HTMLCanvasElement,
    options: Readonly<BrowserOpaqueFrameBackendOptions> = {}
  ) {
    this.#checkErrors = options.checkErrors ?? false;
    const gl = canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      depth: false,
      desynchronized: true,
      preserveDrawingBuffer: options.preserveDrawingBuffer ?? false,
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

  public allocate(
    layout: OpaqueFrameTextureLayout,
    streamingSlots: number
  ): void {
    this.#assertUsable();
    if (this.#allocated) {
      throw new Error("WebGL frame textures are already allocated");
    }
    validateOpaqueBackendLimits(this, layout);
    validateOpaqueStreamingSlots(streamingSlots);
    const gl = this.#gl;
    this.#canvas.width = layout.logicalWidth;
    this.#canvas.height = layout.logicalHeight;
    this.#codedWidth = layout.codedWidth;
    this.#codedHeight = layout.codedHeight;

    try {
      this.#program = createProgram(gl);
      this.#vertexArray = requireGlObject(
        gl.createVertexArray(),
        "vertex array"
      );
      this.#residentTexture = layout.residentLayerCount === 0
        ? null
        : createTextureArray(
            gl,
            layout.codedWidth,
            layout.codedHeight,
            layout.residentLayerCount
          );
      this.#streamingTexture = createTextureArray(
        gl,
        layout.codedWidth,
        layout.codedHeight,
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
    kind: OpaqueTextureKind,
    index: number,
    pixels: Uint8Array
  ): void {
    this.#assertAllocated();
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
  }

  public draw(kind: OpaqueTextureKind, index: number): void {
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
    if (this.#checkErrors) assertNoGlError(gl, `${kind} texture draw`);
  }

  public readPixels(): Uint8Array {
    this.#assertAllocated();
    const bottomUp = new Uint8Array(
      checkedOpaqueRgbaBytes(this.#canvas.width, this.#canvas.height)
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
    if (this.#disposed) return;
    this.#disposed = true;
    this.#deleteResources();
  }

  #textureFor(kind: OpaqueTextureKind): WebGLTexture {
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
    this.#codedWidth = 0;
    this.#codedHeight = 0;
    this.#allocated = false;
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
    vertex = compileShader(gl, gl.VERTEX_SHADER, `#version 300 es
    precision highp float;
    const vec2 positions[3] = vec2[](
      vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0)
    );
    out vec2 v_uv;
    void main() {
      vec2 position = positions[gl_VertexID];
      gl_Position = vec4(position, 0.0, 1.0);
      v_uv = vec2((position.x + 1.0) * 0.5, 1.0 - (position.y + 1.0) * 0.5);
    }`);
    fragment = compileShader(gl, gl.FRAGMENT_SHADER, `#version 300 es
    precision highp float;
    precision highp sampler2DArray;
    in vec2 v_uv;
    uniform sampler2DArray u_frames;
    uniform float u_layer;
    out vec4 out_color;
    void main() { out_color = texture(u_frames, vec3(v_uv, u_layer)); }`);
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
    if (program !== null) gl.deleteProgram(program);
    throw error;
  } finally {
    if (vertex !== null) gl.deleteShader(vertex);
    if (fragment !== null) gl.deleteShader(fragment);
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
