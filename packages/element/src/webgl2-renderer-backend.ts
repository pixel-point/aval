import type { RendererDiagnosticContextAttributes } from "./renderer-diagnostics.js";
import {
  allocationBytes,
  checkedProduct,
  rgbaBytes,
  type RenderLayout,
  type RendererViewport
} from "./renderer-geometry.js";
import {
  RENDERER_BACKEND_TARGET,
  RendererBackendArithmeticError,
  RendererBackendFailure,
  backendFailure,
  webglBackendDetails,
  type RendererBackend,
  type RendererBackendEventSink,
  type RendererBackendMemory,
  type RendererBackendSnapshot,
  type RendererBackendTarget,
  type RendererBackendTargetKind,
  type RendererRgbaUploadSource,
  type RendererUploadSource
} from "./renderer-backend.js";
import { WebGlUnavailableError } from "./renderer-selection.js";
import type { RendererUploadMode } from "./renderer-contract.js";
import {
  equivalentRgbaPixels,
  informativeRgbaPixels
} from "./rgba-qualification.js";

const PROBE_EDGE = 8;
const PROBE_BYTES = PROBE_EDGE * PROBE_EDGE * 4;
const PROBE_ACCOUNTED_BYTES = PROBE_BYTES * 2;
const MAX_PROBE_ATTEMPTS = 3;

type BackendState = "active" | "lost" | "inactive" | "disposed";

class WebGlTarget implements RendererBackendTarget {
  public readonly [RENDERER_BACKEND_TARGET] = true as const;
  public constructor(public readonly texture: WebGLTexture) {}
}

interface NativeProbeResult {
  readonly ok: boolean;
  readonly reason: unknown;
  readonly glError: number | null;
  readonly contextLost: boolean;
}

/** WebGL2 platform primitives. Generic orchestration lives in the controller. */
export class WebGl2RendererBackend implements RendererBackend {
  public readonly kind = "webgl2" as const;
  readonly #canvas: HTMLCanvasElement;
  readonly #layout: Readonly<RenderLayout>;
  readonly #textureBytes: number;
  readonly #storageBytes: number;
  readonly #lost: (event: Event) => void;
  readonly #restored: () => void;
  readonly #targets = new Set<WebGlTarget>();
  #sink: RendererBackendEventSink;
  #gl: WebGL2RenderingContext | null = null;
  #program: WebGLProgram | null = null;
  #state: BackendState = "inactive";
  #listeners = false;
  // 0 = RGBA copy, 1 = native requires qualification, 2 = native proven.
  #native = 1;
  #nativeProbeAttempts = 0;
  #nativeProbeWindowAttempts = 0;
  #nativeProbeInFlight = false;
  #nativeProbe = new Uint8Array(0);
  #referenceProbe = new Uint8Array(0);
  #maxTextureSize = 0;
  #maxViewportWidth = 0;
  #maxViewportHeight = 0;
  #maxResidentTextures = 0;
  #contextAttributes: Readonly<RendererDiagnosticContextAttributes> | null = null;
  #vendor: string | null = null;
  #rendererName: string | null = null;

  public constructor(
    canvas: HTMLCanvasElement,
    layout: Readonly<RenderLayout>,
    sink: RendererBackendEventSink
  ) {
    this.#canvas = canvas;
    this.#layout = layout;
    this.#native = initialNativeUploadState(layout);
    this.#sink = sink;
    this.#textureBytes = rgbaBytes(layout.codedWidth, layout.codedHeight);
    this.#storageBytes = rgbaBytes(layout.storageWidth, layout.storageHeight);
    this.#lost = (event) => {
      event.preventDefault();
      this.#markLost();
    };
    this.#restored = () => {
      if (this.#state === "lost") this.#sink(Object.freeze({ kind: "restore" }));
    };
    try {
      this.#initialize(true);
      canvas.addEventListener("webglcontextlost", this.#lost);
      canvas.addEventListener("webglcontextrestored", this.#restored);
      this.#listeners = true;
    } catch (reason) {
      try { canvas.removeEventListener("webglcontextlost", this.#lost); }
      catch { /* Preserve the construction cause. */ }
      try { canvas.removeEventListener("webglcontextrestored", this.#restored); }
      catch { /* Preserve the construction cause. */ }
      const failure = reason instanceof RendererBackendFailure
        ? new RendererBackendFailure(
            reason.evidence,
            this.snapshot(0, canvas.width, canvas.height)
          )
        : reason;
      this.#destroy();
      throw failure;
    }
  }

  public validatePresentation(width: number, height: number): void {
    if (
      width > this.#maxTextureSize || height > this.#maxTextureSize ||
      width > this.#maxViewportWidth || height > this.#maxViewportHeight
    ) throw new RendererBackendArithmeticError(
      "renderer backing dimensions exceed device limits"
    );
  }

  public allocateTarget(
    kind: RendererBackendTargetKind,
    ordinal: number
  ): RendererBackendTarget {
    const gl = this.#activeGl();
    let texture: WebGLTexture | null = null;
    try {
      texture = createTexture(gl, this.#layout);
      if (contextLost(gl)) {
        throw new Error("WebGL context was lost during texture creation");
      }
      const target = new WebGlTarget(texture);
      this.#targets.add(target);
      return target;
    } catch (reason) {
      const failure = backendFailure(
        kind === "stream" ? "stream-texture-create" : "resident-texture-create",
        reason,
        {
          glError: capturedGlError(reason, gl),
          contextLost: contextLost(gl),
          textureOrdinal: kind === "stream" ? ordinal : null,
          ...(kind === "resident" ? { uploadPath: "rgba-copy" as const } : {})
        }
      );
      if (texture !== null) {
        try { gl.deleteTexture(texture); } catch { /* preserve allocation cause */ }
      }
      throw failure;
    }
  }

  public async upload(
    target: RendererBackendTarget,
    source: RendererUploadSource
  ): Promise<void> {
    const owned = this.#ownedTarget(target);
    const gl = this.#activeGl();
    if (source.newDecoderRun && this.#native === 2) {
      this.#native = 1;
      this.#nativeProbeWindowAttempts = 0;
    }
    if (this.#native !== 0) {
      drainErrors(gl);
      let nativeError: number | null = null;
      let nativeReason: unknown = null;
      try {
        gl.bindTexture(gl.TEXTURE_2D, owned.texture);
        gl.texSubImage2D(
          gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, source.frame
        );
        nativeError = readGlError(gl);
      } catch (reason) {
        nativeReason = reason;
        nativeError = readGlError(gl);
      }
      if (contextLost(gl)) throw backendFailure(
        "native-upload",
        nativeReason ?? new Error("WebGL context was lost during native upload"),
        { glError: nativeError, contextLost: true, uploadPath: "native" }
      );
      if (nativeReason === null && nativeError === null) {
        if (this.#native === 2) return;
        await this.#qualifyNative(gl, owned, source);
        return;
      }
      this.#native = 0;
    }
    const rgba = await source.rgba();
    if (this.#state !== "active" || this.#gl !== gl) throw unavailable();
    this.#uploadRgba(gl, owned.texture, rgba.pixels);
  }

  public uploadRgba(
    target: RendererBackendTarget,
    source: RendererRgbaUploadSource
  ): void {
    const owned = this.#ownedTarget(target);
    const gl = this.#activeGl();
    this.#uploadRgba(gl, owned.texture, source.pixels);
  }

  public draw(
    target: RendererBackendTarget,
    viewport: Readonly<RendererViewport>
  ): void {
    const owned = this.#ownedTarget(target);
    const gl = this.#activeGl();
    const program = this.#program;
    if (program === null) throw unavailable();
    if (
      viewport.width > this.#maxViewportWidth ||
      viewport.height > this.#maxViewportHeight
    ) throw new RendererBackendArithmeticError(
      "renderer viewport exceeds device limits"
    );
    try {
      gl.viewport(0, 0, this.#canvas.width, this.#canvas.height);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.viewport(viewport.x, viewport.y, viewport.width, viewport.height);
      gl.useProgram(program);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, owned.texture);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      const glError = readGlError(gl);
      if (glError !== null) throw new GlOperationError("WebGL draw failed", glError);
      if (contextLost(gl) || this.#state !== "active") {
        throw new Error("WebGL context was lost during draw");
      }
    } catch (reason) {
      throw backendFailure("draw", reason, {
        glError: capturedGlError(reason, gl),
        contextLost: contextLost(gl)
      });
    }
  }

  public releaseTarget(target: RendererBackendTarget): void {
    if (!(target instanceof WebGlTarget) || !this.#targets.delete(target)) return;
    const gl = this.#gl;
    if (gl !== null) {
      try { gl.deleteTexture(target.texture); } catch { /* best-effort cleanup */ }
    }
  }

  public plannedMemory(
    residentCount: number,
    plannedTargetCount: number,
    backingWidth: number,
    backingHeight: number
  ): Readonly<RendererBackendMemory> {
    const result = planWebGl2Memory(
      this.#layout,
      residentCount,
      plannedTargetCount,
      backingWidth,
      backingHeight
    );
    if (this.#maxResidentTextures > 0 && residentCount > this.#maxResidentTextures) {
      throw new RangeError("resident texture count exceeds device limits");
    }
    return result;
  }

  public snapshot(
    _residentCount: number,
    backingWidth: number,
    backingHeight: number
  ): Readonly<RendererBackendSnapshot> {
    const active = this.#state === "active";
    const textureBytes = active
      ? allocationBytes(checkedProduct(this.#textureBytes, this.#targets.size))
      : 0;
    return Object.freeze({
      details: webglBackendDetails(
        nativeUploadMode(this.#native),
        this.#nativeProbeAttempts,
        this.#probeReadbackBytes(),
        this.#nativeProbeInFlight
      ),
      memory: memory(
        textureBytes,
        this.#state === "disposed" ? 0 : rgbaBytes(backingWidth, backingHeight),
        this.#probeReadbackBytes()
      ),
      resourceCount: Number(this.#program !== null) + this.#targets.size,
      contextListenerCount: this.#listeners ? 2 : 0,
      limits: Object.freeze({
        maxTextureSize: this.#maxTextureSize,
        maxViewportWidth: this.#maxViewportWidth,
        maxViewportHeight: this.#maxViewportHeight,
        maxResidentTextures: this.#maxResidentTextures
      }),
      contextAttributes: this.#contextAttributes,
      vendor: this.#vendor,
      renderer: this.#rendererName
    });
  }

  public restore(): void {
    if (this.#state !== "lost") throw unavailable();
    this.#initialize(false);
  }

  public deactivate(): void {
    if (this.#state === "inactive" || this.#state === "disposed") return;
    this.#state = "inactive";
    this.#destroy();
    this.#releaseProbe();
  }

  public dispose(): void {
    if (this.#state === "disposed") return;
    this.deactivate();
    this.#state = "disposed";
    if (this.#listeners) {
      this.#canvas.removeEventListener("webglcontextlost", this.#lost);
      this.#canvas.removeEventListener("webglcontextrestored", this.#restored);
      this.#listeners = false;
    }
    this.#sink = () => undefined;
  }

  async #qualifyNative(
    gl: WebGL2RenderingContext,
    target: WebGlTarget,
    source: RendererUploadSource
  ): Promise<void> {
    if (
      this.#nativeProbeWindowAttempts >= MAX_PROBE_ATTEMPTS ||
      this.#canvas.width < PROBE_EDGE || this.#canvas.height < PROBE_EDGE ||
      this.#probeReadbackBytes() !== PROBE_ACCOUNTED_BYTES
    ) {
      this.#native = 0;
      const rgba = await source.rgba();
      if (this.#state !== "active" || this.#gl !== gl) throw unavailable();
      this.#uploadRgba(gl, target.texture, rgba.pixels);
      return;
    }
    this.#nativeProbeAttempts = Math.min(
      Number.MAX_SAFE_INTEGER,
      this.#nativeProbeAttempts + 1
    );
    this.#nativeProbeWindowAttempts += 1;
    this.#nativeProbeInFlight = true;
    try {
      const rgba = await source.rgba();
      if (this.#state !== "active" || this.#gl !== gl) throw unavailable();
      const native = this.#readProbe(gl, target.texture, this.#nativeProbe);
      if (native.contextLost) throw backendFailure(
        "native-upload", native.reason,
        { glError: native.glError, contextLost: true, uploadPath: "native" }
      );
      drainErrors(gl);
      this.#uploadRgba(gl, target.texture, rgba.pixels);
      const reference = native.ok
        ? this.#readProbe(gl, target.texture, this.#referenceProbe)
        : failedProbe(new Error("native probe readback was unavailable"));
      if (reference.contextLost) throw backendFailure(
        "draw", reference.reason,
        { glError: reference.glError, contextLost: true, uploadPath: "rgba-copy" }
      );
      if (!native.ok || !reference.ok ||
        !equivalentRgbaPixels(this.#nativeProbe, this.#referenceProbe)) {
        this.#native = 0;
      } else if (informativeRgbaPixels(this.#referenceProbe)) {
        this.#native = 2;
      } else if (this.#nativeProbeWindowAttempts >= MAX_PROBE_ATTEMPTS) {
        this.#native = 0;
      }
    } finally {
      this.#nativeProbeInFlight = false;
      if (this.#gl === gl && !contextLost(gl)) {
        try { gl.viewport(0, 0, this.#canvas.width, this.#canvas.height); }
        catch { /* The presentation draw retains exact evidence. */ }
      }
    }
  }

  #uploadRgba(
    gl: WebGL2RenderingContext,
    texture: WebGLTexture,
    pixels: Uint8Array
  ): void {
    try {
      if (pixels.byteLength !== this.#storageBytes) {
        throw new RangeError("resident pixel storage is invalid");
      }
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texSubImage2D(
        gl.TEXTURE_2D, 0, 0, 0,
        this.#layout.storageWidth, this.#layout.storageHeight,
        gl.RGBA, gl.UNSIGNED_BYTE, pixels
      );
      const glError = readGlError(gl);
      if (glError !== null) {
        throw new GlOperationError("WebGL RGBA upload failed", glError);
      }
    } catch (reason) {
      throw backendFailure("rgba-upload", reason, {
        glError: capturedGlError(reason, gl),
        contextLost: contextLost(gl),
        uploadPath: "rgba-copy"
      });
    }
    if (contextLost(gl)) throw backendFailure(
      "rgba-upload",
      new Error("WebGL context was lost during RGBA frame upload"),
      { contextLost: true, uploadPath: "rgba-copy" }
    );
  }

  #readProbe(
    gl: WebGL2RenderingContext,
    texture: WebGLTexture,
    target: Uint8Array
  ): NativeProbeResult {
    drainErrors(gl);
    try {
      gl.viewport(0, 0, PROBE_EDGE, PROBE_EDGE);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(this.#program);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      let glError = readGlError(gl);
      if (glError !== null || contextLost(gl)) return failedProbe(
        new Error("WebGL native probe draw failed"), glError, contextLost(gl)
      );
      target.fill(0);
      gl.readPixels(
        0, 0, PROBE_EDGE, PROBE_EDGE,
        gl.RGBA, gl.UNSIGNED_BYTE, target
      );
      glError = readGlError(gl);
      if (glError !== null || contextLost(gl)) return failedProbe(
        new Error("WebGL native probe readback failed"), glError, contextLost(gl)
      );
      return Object.freeze({
        ok: true, reason: null, glError: null, contextLost: false
      });
    } catch (reason) {
      return failedProbe(reason, readGlError(gl), contextLost(gl));
    }
  }

  #initialize(construct: boolean): void {
    const native = initialNativeUploadState(this.#layout);
    let gl: WebGL2RenderingContext | null;
    try {
      // Keep presentation in normal DOM composition. Android Chromium may
      // route desynchronized WebGL through an opaque low-latency surface.
      gl = this.#canvas.getContext("webgl2", {
        alpha: true, antialias: false, depth: false, stencil: false,
        premultipliedAlpha: true,
        preserveDrawingBuffer: false
      });
    } catch (reason) {
      throw backendFailure("context-create", reason);
    }
    if (gl === null && construct) throw new WebGlUnavailableError();
    if (gl === null || contextLost(gl)) throw backendFailure(
      "context-create", new Error("WebGL2 is unavailable"),
      { contextLost: gl === null ? false : contextLost(gl) }
    );
    this.#readCapabilities(gl);
    this.#validateDeviceDimensions(gl);
    let program: WebGLProgram;
    try { program = createProgram(gl, this.#layout); }
    catch (reason) {
      throw backendFailure("program-create", reason, {
        glError: capturedGlError(reason, gl), contextLost: contextLost(gl)
      });
    }
    let nativeProbe = new Uint8Array(0);
    let referenceProbe = new Uint8Array(0);
    try {
      gl.clearColor(0, 0, 0, 0);
      gl.disable(gl.BLEND);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      nativeProbe = native === 0
        ? new Uint8Array(0) : new Uint8Array(PROBE_BYTES);
      referenceProbe = native === 0
        ? new Uint8Array(0) : new Uint8Array(PROBE_BYTES);
    } catch (reason) {
      const failure = backendFailure("context-event", reason, {
        glError: capturedGlError(reason, gl), contextLost: contextLost(gl)
      });
      try { gl.deleteProgram(program); } catch { /* preserve setup cause */ }
      throw failure;
    }
    this.#gl = gl;
    this.#program = program;
    this.#state = "active";
    this.#native = native;
    this.#nativeProbeAttempts = 0;
    this.#nativeProbeWindowAttempts = 0;
    this.#nativeProbeInFlight = false;
    this.#nativeProbe = nativeProbe;
    this.#referenceProbe = referenceProbe;
  }

  #readCapabilities(gl: WebGL2RenderingContext): void {
    this.#contextAttributes = readContextAttributes(gl);
    const device = readDeviceIdentity(gl);
    this.#vendor = device.vendor;
    this.#rendererName = device.renderer;
    try {
      this.#maxTextureSize = positiveGl(gl.getParameter(gl.MAX_TEXTURE_SIZE));
      this.#maxResidentTextures = Math.min(
        4096,
        positiveGl(gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS))
      );
      const viewport = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as
        ArrayLike<unknown> | null;
      this.#maxViewportWidth = positiveGl(viewport?.[0]);
      this.#maxViewportHeight = positiveGl(viewport?.[1]);
    } catch (reason) {
      throw backendFailure("capability-query", reason, {
        glError: readGlError(gl), contextLost: contextLost(gl)
      });
    }
  }

  #validateDeviceDimensions(gl: WebGL2RenderingContext): void {
    if (
      this.#layout.codedWidth > this.#maxTextureSize ||
      this.#layout.codedHeight > this.#maxTextureSize ||
      this.#canvas.width > this.#maxTextureSize ||
      this.#canvas.height > this.#maxTextureSize ||
      this.#canvas.width > this.#maxViewportWidth ||
      this.#canvas.height > this.#maxViewportHeight
    ) throw backendFailure(
      "device-limits", new Error("renderer dimensions exceed WebGL limits"),
      { contextLost: contextLost(gl) }
    );
  }

  #ownedTarget(target: RendererBackendTarget): WebGlTarget {
    if (!(target instanceof WebGlTarget) || !this.#targets.has(target)) {
      throw unavailable();
    }
    return target;
  }

  #activeGl(): WebGL2RenderingContext {
    const gl = this.#gl;
    if (this.#state !== "active" || gl === null) throw unavailable();
    return gl;
  }

  #markLost(): void {
    if (this.#state !== "active") return;
    this.#state = "lost";
    this.#gl = null;
    this.#program = null;
    this.#targets.clear();
    this.#maxTextureSize = 0;
    this.#maxViewportWidth = 0;
    this.#maxViewportHeight = 0;
    this.#maxResidentTextures = 0;
    this.#contextAttributes = null;
    this.#vendor = null;
    this.#rendererName = null;
    this.#releaseProbe();
    this.#sink(Object.freeze({ kind: "lost" }));
  }

  #destroy(): void {
    const gl = this.#gl;
    if (gl !== null) {
      for (const target of this.#targets) {
        try { gl.deleteTexture(target.texture); } catch { /* terminal cleanup */ }
      }
      if (this.#program !== null) {
        try { gl.deleteProgram(this.#program); } catch { /* terminal cleanup */ }
      }
    }
    this.#targets.clear();
    this.#gl = null;
    this.#program = null;
  }

  #probeReadbackBytes(): number {
    return this.#nativeProbe.byteLength + this.#referenceProbe.byteLength;
  }

  #releaseProbe(): void {
    this.#nativeProbeInFlight = false;
    this.#nativeProbe = new Uint8Array(0);
    this.#referenceProbe = new Uint8Array(0);
  }
}

function memory(
  textureBytes: number,
  backingRawBytes: number,
  runtimeOverheadBytes: number
): Readonly<RendererBackendMemory> {
  return Object.freeze({
    stagingBytes: 0,
    residentBytes: 0,
    textureBytes,
    backingRawBytes,
    runtimeOverheadBytes
  });
}

/** Pure byte planning used before WebGL context or resource acquisition. */
export function planWebGl2Memory(
  layout: Readonly<RenderLayout>,
  residentCount: number,
  plannedTargetCount: number,
  backingWidth: number,
  backingHeight: number
): Readonly<RendererBackendMemory> {
  if (!Number.isSafeInteger(residentCount) || residentCount < 0) {
    throw new RangeError("resident texture count is invalid");
  }
  if (!Number.isSafeInteger(plannedTargetCount) ||
    plannedTargetCount < residentCount) {
    throw new RangeError("planned texture count is invalid");
  }
  return memory(
    allocationBytes(checkedProduct(
      rgbaBytes(layout.codedWidth, layout.codedHeight),
      plannedTargetCount
    )),
    rgbaBytes(backingWidth, backingHeight),
    initialNativeUploadState(layout) === 1 ? PROBE_ACCOUNTED_BYTES : 0
  );
}

function nativeUploadMode(value: number): RendererUploadMode {
  if (value === 0) return "rgba-copy";
  if (value === 2) return "native";
  return "native-probing";
}

function initialNativeUploadState(layout: Readonly<RenderLayout>): 0 | 1 {
  // Packed alpha turns decoded luma into output transparency. Some native
  // VideoFrame texture paths preserve a coarse probe while corrupting that
  // spatial relationship, so use the already-bounded RGBA path end to end.
  return layout.alphaRect === undefined ? 1 : 0;
}

function failedProbe(
  reason: unknown,
  glError: number | null = null,
  lost = false
): NativeProbeResult {
  return Object.freeze({ ok: false, reason, glError, contextLost: lost });
}

class GlOperationError extends Error {
  public constructor(message: string, public readonly glError: number | null) {
    super(message);
    this.name = "GlOperationError";
  }
}

function createTexture(
  gl: WebGL2RenderingContext,
  layout: Readonly<RenderLayout>
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
      gl.TEXTURE_2D, 1, gl.RGBA8, layout.codedWidth, layout.codedHeight
    );
    const glError = readGlError(gl);
    if (glError !== null) {
      throw new GlOperationError("WebGL texture allocation failed", glError);
    }
    return texture;
  } catch (reason) {
    const error = captureGlOperationError(
      gl, reason, "WebGL texture allocation failed"
    );
    try { gl.deleteTexture(texture); } catch { /* preserve allocation cause */ }
    throw error;
  }
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
      throw new GlOperationError("WebGL program creation failed", glError);
    }
    return program;
  } catch (reason) {
    const error = captureGlOperationError(gl, reason, "WebGL program creation failed");
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
      throw new GlOperationError("WebGL shader creation failed", glError);
    }
    return result;
  } catch (reason) {
    const error = captureGlOperationError(gl, reason, "WebGL shader creation failed");
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

function positiveGl(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error("WebGL device limit is invalid");
  }
  return value;
}

function capturedGlError(
  reason: unknown,
  gl: WebGL2RenderingContext
): number | null {
  return reason instanceof GlOperationError ? reason.glError : readGlError(gl);
}

function captureGlOperationError(
  gl: WebGL2RenderingContext,
  reason: unknown,
  fallbackMessage: string
): GlOperationError {
  if (reason instanceof GlOperationError) return reason;
  let message = fallbackMessage;
  try {
    if (reason instanceof Error && reason.message.length > 0) message = reason.message;
  } catch { /* retain the fixed fallback */ }
  return new GlOperationError(message, readGlError(gl));
}

function readGlError(gl: WebGL2RenderingContext): number | null {
  try {
    const value = gl.getError();
    return Number.isSafeInteger(value) && value >= 0 && value !== gl.NO_ERROR
      ? value : null;
  } catch { return null; }
}

function contextLost(gl: WebGL2RenderingContext): boolean {
  try { return gl.isContextLost() === true; }
  catch { return false; }
}

function drainErrors(gl: WebGL2RenderingContext): void {
  try {
    for (let index = 0; index < 8 && gl.getError() !== gl.NO_ERROR; index += 1) {
      // Bounded because a lost context may report forever.
    }
  } catch { /* diagnostic-only */ }
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
        powerPreference === "default" || powerPreference === "high-performance" ||
        powerPreference === "low-power" ? powerPreference : null,
      premultipliedAlpha: diagnosticBoolean(record.premultipliedAlpha),
      preserveDrawingBuffer: diagnosticBoolean(record.preserveDrawingBuffer),
      stencil: diagnosticBoolean(record.stencil),
      xrCompatible: diagnosticBoolean(record.xrCompatible)
    });
  } catch { return null; }
}

function diagnosticBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function readDeviceIdentity(gl: WebGL2RenderingContext): Readonly<{
  vendor: string | null;
  renderer: string | null;
}> {
  try {
    const extension = gl.getExtension("WEBGL_debug_renderer_info") as Readonly<{
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
  } catch { return Object.freeze({ vendor: null, renderer: null }); }
}

function unavailable(): DOMException {
  return new DOMException("WebGL renderer backend is unavailable", "AbortError");
}
