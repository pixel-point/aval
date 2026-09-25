import { AvalAlphaError, type AlphaRect, type AlphaSource } from "./types.js";

const VERTEX = `attribute vec2 p;varying vec2 uv;
void main(){uv=vec2((p.x+1.)*.5,(1.-p.y)*.5);gl_Position=vec4(p,0.,1.);}`;
const FRAGMENT = `precision highp float;varying vec2 uv;
uniform sampler2D frame;uniform vec4 color,mask;uniform vec2 pixel;
vec2 at(vec4 r){return clamp(r.xy+uv*r.zw,r.xy+pixel*.5,r.xy+r.zw-pixel*.5);}
void main(){vec3 rgb=texture2D(frame,at(color)).rgb;
float a=clamp(dot(texture2D(frame,at(mask)).rgb,vec3(.2126,.7152,.0722)),0.,1.);gl_FragColor=vec4(rgb*a,a);}`;

/** One video texture; WebGL1 also works on devices without WebCodecs/WebGL2. */
export function createCompositor(canvas: HTMLCanvasElement, restored: () => void) {
  const context = canvas.getContext("webgl", {
    alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false
  });
  if (!context) throw failure("WebGL is unavailable");
  const gl = context;
  let program: WebGLProgram | null = null;
  let texture: WebGLTexture | null = null;
  let buffer: WebGLBuffer | null = null;
  let lost = false;
  let disposed = false;
  let source: AlphaSource | undefined;
  const contextLost = () => lost || gl.isContextLost();

  function initialize() {
    const vertex = shader(gl, gl.VERTEX_SHADER, VERTEX);
    let fragment: WebGLShader | undefined;
    const next = gl.createProgram();
    try {
      if (!next) throw failure("Cannot allocate shader program");
      fragment = shader(gl, gl.FRAGMENT_SHADER, FRAGMENT);
      gl.attachShader(next, vertex);
      gl.attachShader(next, fragment);
      gl.linkProgram(next);
    } catch (error) { gl.deleteProgram(next); throw error; }
    finally { gl.deleteShader(vertex); if (fragment) gl.deleteShader(fragment); }
    if (!gl.getProgramParameter(next, gl.LINK_STATUS)) {
      gl.deleteProgram(next);
      throw failure("Cannot link alpha shader");
    }
    program = next;
    gl.useProgram(program);
    buffer = gl.createBuffer()!;
    texture = gl.createTexture()!;
    if (!buffer || !texture) throw failure("Cannot allocate video texture");
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const location = gl.getAttribLocation(program, "p");
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    // The grayscale pane is coverage data; preserve decoded RGB channel values.
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.disable(gl.DITHER);
    gl.uniform1i(gl.getUniformLocation(program, "frame"), 0);
    if (source) configure(source);
  }

  function configure(next: AlphaSource) {
    if (contextLost()) return false;
    const maximum = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    if (contextLost()) return false;
    if (next.width > maximum || next.height > maximum) throw failure("Packed video exceeds the texture limit");
    source = next;
    canvas.width = next.colorRect[2];
    canvas.height = next.colorRect[3];
    gl.viewport(0, 0, canvas.width, canvas.height);
    const rect = (name: string, r: AlphaRect) => gl.uniform4f(
      gl.getUniformLocation(program!, name), r[0] / next.width, r[1] / next.height,
      r[2] / next.width, r[3] / next.height
    );
    rect("color", next.colorRect);
    rect("mask", next.alphaRect);
    gl.uniform2f(gl.getUniformLocation(program!, "pixel"), 1 / next.width, 1 / next.height);
    return !contextLost();
  }

  function draw(video: HTMLVideoElement): boolean {
    if (disposed || contextLost() || video.readyState < 2) return false;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    const error = gl.getError();
    if (gl.isContextLost()) return false;
    if (error !== gl.NO_ERROR) throw failure("Video texture upload or alpha draw failed");
    return true;
  }

  const onLost = (event: Event) => { event.preventDefault(); lost = true; };
  const onRestored = () => { lost = false; restored(); };
  function waitForContext(timeout: number, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (!contextLost()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const finish = (error?: unknown) => {
        clearTimeout(timer);
        canvas.removeEventListener("webglcontextrestored", success);
        signal.removeEventListener("abort", aborted);
        if (error) reject(error); else resolve();
      };
      const success = () => finish();
      const aborted = () => finish(signal.reason);
      const timer = setTimeout(() => finish(failure("WebGL context restoration timed out")), Math.max(0, timeout));
      canvas.addEventListener("webglcontextrestored", success);
      signal.addEventListener("abort", aborted, { once: true });
      if (signal.aborted) aborted();
    });
  }
  function destroy() {
    disposed = true;
    canvas.removeEventListener("webglcontextlost", onLost);
    canvas.removeEventListener("webglcontextrestored", onRestored);
    gl.deleteTexture(texture);
    gl.deleteBuffer(buffer);
    gl.deleteProgram(program);
  }
  canvas.addEventListener("webglcontextlost", onLost);
  canvas.addEventListener("webglcontextrestored", onRestored);
  try { if (!contextLost()) initialize(); }
  catch (error) { if (!contextLost()) { destroy(); throw error; } }
  return { configure, draw, contextLost, waitForContext, restore: initialize, destroy };
}

function shader(gl: WebGLRenderingContext, kind: number, code: string): WebGLShader {
  const result = gl.createShader(kind);
  if (!result) throw failure("Cannot allocate alpha shader");
  gl.shaderSource(result, code);
  gl.compileShader(result);
  if (!gl.getShaderParameter(result, gl.COMPILE_STATUS)) {
    gl.deleteShader(result);
    throw failure("Cannot compile alpha shader");
  }
  return result;
}
function failure(message: string): AvalAlphaError { return new AvalAlphaError("rendering", message); }
