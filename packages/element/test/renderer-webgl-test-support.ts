import type { RenderLayout } from "../src/renderer.js";

export function layout(): RenderLayout {
  return {
    codedWidth: 48,
    codedHeight: 112,
    storageWidth: 48,
    storageHeight: 104,
    logicalWidth: 47,
    logicalHeight: 47,
    pixelAspect: [3, 2],
    colorRect: [0, 0, 47, 47],
    alphaRect: [0, 56, 47, 47]
  };
}

export function opaqueLayout(): RenderLayout {
  return {
    codedWidth: 640,
    codedHeight: 360,
    storageWidth: 640,
    storageHeight: 360,
    logicalWidth: 640,
    logicalHeight: 360,
    pixelAspect: [1, 1],
    colorRect: [0, 0, 640, 360]
  };
}

export function frame(
  copy: () => Promise<readonly PlaneLayout[]> = async () => [
    { offset: 0, stride: 48 * 4 }
  ],
  displayWidth = 48,
  displayHeight = 104
): VideoFrame {
  return {
    codedWidth: 48,
    codedHeight: 112,
    displayWidth,
    displayHeight,
    visibleRect: { x: 0, y: 0, width: 48, height: 104 },
    copyTo: copy
  } as unknown as VideoFrame;
}

export function frameWithGeometry(
  renderLayout: Readonly<RenderLayout>,
  displayWidth: number,
  displayHeight: number
): VideoFrame {
  const stride = renderLayout.storageWidth * 4;
  return {
    codedWidth: renderLayout.codedWidth,
    codedHeight: renderLayout.codedHeight,
    displayWidth,
    displayHeight,
    visibleRect: {
      x: 0,
      y: 0,
      width: renderLayout.storageWidth,
      height: renderLayout.storageHeight
    },
    copyTo: async () => [{ offset: 0, stride }]
  } as unknown as VideoFrame;
}

export function webglCanvas(): Readonly<{
  canvas: HTMLCanvasElement;
  gl: TestGl;
  dispatch(type: "webglcontextlost" | "webglcontextrestored"): void;
}>;
export function webglCanvas(width: number, height: number): Readonly<{
  canvas: HTMLCanvasElement;
  gl: TestGl;
  dispatch(type: "webglcontextlost" | "webglcontextrestored"): void;
}>;
export function webglCanvas(width = 48, height = 104): Readonly<{
  canvas: HTMLCanvasElement;
  gl: TestGl;
  dispatch(type: "webglcontextlost" | "webglcontextrestored"): void;
}> {
  const gl = new TestGl();
  const listeners = new Map<string, EventListener>();
  const canvas = {
    width,
    height,
    addEventListener(type: string, listener: EventListener) {
      listeners.set(type, listener);
    },
    removeEventListener(type: string) { listeners.delete(type); },
    getContext() { return gl as unknown as WebGL2RenderingContext; }
  } as unknown as HTMLCanvasElement;
  const dispatch = (type: "webglcontextlost" | "webglcontextrestored"): void => {
    gl.contextLost = type === "webglcontextlost";
    const event = Object.freeze({ preventDefault() {} }) as unknown as Event;
    listeners.get(type)?.(event);
  };
  return Object.freeze({ canvas, gl, dispatch });
}

export class TestGl {
  public readonly MAX_TEXTURE_SIZE = 1;
  public readonly MAX_ARRAY_TEXTURE_LAYERS = 2;
  public readonly MAX_VIEWPORT_DIMS = 3;
  public readonly VERTEX_SHADER = 4;
  public readonly FRAGMENT_SHADER = 5;
  public readonly COMPILE_STATUS = 6;
  public readonly LINK_STATUS = 7;
  public readonly TEXTURE_2D = 8;
  public readonly TEXTURE_MIN_FILTER = 9;
  public readonly TEXTURE_MAG_FILTER = 10;
  public readonly TEXTURE_WRAP_S = 11;
  public readonly TEXTURE_WRAP_T = 12;
  public readonly CLAMP_TO_EDGE = 13;
  public readonly LINEAR = 14;
  public readonly RGBA8 = 15;
  public readonly TEXTURE0 = 16;
  public readonly TRIANGLES = 17;
  public readonly COLOR_BUFFER_BIT = 18;
  public readonly NO_ERROR = 0;
  public readonly RGBA = 19;
  public readonly UNSIGNED_BYTE = 20;
  public readonly UNPACK_ALIGNMENT = 21;
  public readonly BLEND = 22;
  public readonly OUT_OF_MEMORY = 0x0505;

  public readonly createdTextures: WebGLTexture[] = [];
  public readonly drawnTextures: WebGLTexture[] = [];
  public rejectNativeUpload = false;
  public nativeReadback: Uint8Array = informativeProbePixels();
  public rgbaReadback: Uint8Array = informativeProbePixels();
  public nextNativeUploadError = 0;
  public nextProbeReadError = 0;
  public nativeUploadCount = 0;
  public rgbaUploadCount = 0;
  public readPixelsCount = 0;
  public readonly presentationUploadKinds: ("native" | "rgba-copy")[] = [];
  public loseOnDraw = false;
  public maxTextureSize = 8_192;
  public maxResidentTextures = 8_192;
  public maxViewportWidth = 8_192;
  public maxViewportHeight = 8_192;
  public programLinked = true;
  public programLinkError = 0;
  public deleteProgramError = 0;
  public storageError = 0;
  public rgbaUploadError = 0;
  public contextLost = false;
  #bound: WebGLTexture | null = null;
  #lastUploadKind: "native" | "rgba-copy" = "rgba-copy";
  #viewportWidth = 0;
  #viewportHeight = 0;
  #error = 0;
  #lost = false;

  public getParameter(parameter: number): number | readonly number[] {
    if (parameter === this.MAX_TEXTURE_SIZE) return this.maxTextureSize;
    if (parameter === this.MAX_ARRAY_TEXTURE_LAYERS) return this.maxResidentTextures;
    if (parameter === this.MAX_VIEWPORT_DIMS) {
      return [this.maxViewportWidth, this.maxViewportHeight];
    }
    return 8_192;
  }

  public getContextAttributes(): WebGLContextAttributes {
    return {
      alpha: true,
      antialias: false,
      depth: false,
      failIfMajorPerformanceCaveat: false,
      powerPreference: "default",
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
      stencil: false,
      diagnosticSecret: "must not escape"
    } as WebGLContextAttributes;
  }

  public getExtension(): null { return null; }
  public createShader(): WebGLShader { return {} as WebGLShader; }
  public shaderSource(): void {}
  public compileShader(): void {}
  public getShaderParameter(): boolean { return true; }
  public deleteShader(): void {}
  public createProgram(): WebGLProgram { return {} as WebGLProgram; }
  public attachShader(): void {}
  public linkProgram(): void {}
  public getProgramParameter(): boolean {
    if (!this.programLinked && this.programLinkError !== 0) {
      this.#error = this.programLinkError;
    }
    return this.programLinked;
  }
  public deleteProgram(): void {
    if (this.deleteProgramError !== 0) this.#error = this.deleteProgramError;
  }
  public createTexture(): WebGLTexture {
    const texture = { id: this.createdTextures.length } as unknown as WebGLTexture;
    this.createdTextures.push(texture);
    return texture;
  }
  public deleteTexture(): void {}
  public bindTexture(_target: number, texture: WebGLTexture | null): void {
    this.#bound = texture;
  }
  public texParameteri(): void {}
  public texStorage2D(): void {
    if (this.storageError !== 0) this.#error = this.storageError;
  }
  public texSubImage2D(...values: readonly unknown[]): void {
    if (values.length === 7) {
      this.#lastUploadKind = "native";
      this.nativeUploadCount += 1;
      if (this.rejectNativeUpload) this.#error = 1;
      if (this.nextNativeUploadError !== 0) {
        this.#error = this.nextNativeUploadError;
        this.nextNativeUploadError = 0;
      }
    }
    if (values.length === 9) {
      this.#lastUploadKind = "rgba-copy";
      this.rgbaUploadCount += 1;
      if (this.rgbaUploadError !== 0) this.#error = this.rgbaUploadError;
    }
  }
  public getUniformLocation(): WebGLUniformLocation {
    return {} as WebGLUniformLocation;
  }
  public clearColor(): void {}
  public disable(): void {}
  public pixelStorei(): void {}
  public viewport(_x: number, _y: number, width: number, height: number): void {
    this.#viewportWidth = width;
    this.#viewportHeight = height;
  }
  public clear(): void {}
  public useProgram(): void {}
  public activeTexture(): void {}
  public uniform1i(): void {}
  public uniform1f(): void {}
  public uniform4f(): void {}
  public drawArrays(): void {
    const presentation = this.#viewportWidth !== 8 || this.#viewportHeight !== 8;
    if (this.#bound !== null && presentation) {
      this.drawnTextures.push(this.#bound);
      this.presentationUploadKinds.push(this.#lastUploadKind);
    }
    if (this.loseOnDraw && presentation) this.#lost = true;
  }
  public readPixels(
    _x: number,
    _y: number,
    _width: number,
    _height: number,
    _format: number,
    _type: number,
    target: Uint8Array
  ): void {
    this.readPixelsCount += 1;
    target.set(this.#lastUploadKind === "native"
      ? this.nativeReadback : this.rgbaReadback);
    if (this.nextProbeReadError !== 0) {
      this.#error = this.nextProbeReadError;
      this.nextProbeReadError = 0;
    }
  }
  public getError(): number {
    const error = this.#error;
    this.#error = 0;
    return error;
  }
  public isContextLost(): boolean { return this.#lost || this.contextLost; }
}

export function blackProbePixels(): Uint8Array {
  return new Uint8Array(8 * 8 * 4);
}

export function informativeProbePixels(): Uint8Array {
  const pixels = new Uint8Array(8 * 8 * 4);
  for (let sample = 0; sample < 8 * 8; sample += 1) {
    const offset = sample * 4;
    pixels[offset] = sample % 2 === 0 ? 48 : 160;
    pixels[offset + 1] = sample % 3 === 0 ? 32 : 96;
    pixels[offset + 2] = sample % 5 === 0 ? 16 : 80;
    pixels[offset + 3] = sample % 7 === 0 ? 96 : 255;
  }
  return pixels;
}

export function rgbaReadbackFixture(
  pixels = new Uint8ClampedArray(48 * 104 * 4)
): Readonly<{
  createCanvas: (width: number, height: number) => HTMLCanvasElement;
  state: {
    creations: number;
    drawCalls: unknown[][];
    readError: unknown;
  };
}> {
  const state = {
    creations: 0,
    drawCalls: [] as unknown[][],
    readError: null as unknown
  };
  const context = {
    globalCompositeOperation: "source-over",
    imageSmoothingEnabled: false,
    imageSmoothingQuality: "high" as ImageSmoothingQuality,
    clearRect() {},
    drawImage(...args: unknown[]) { state.drawCalls.push(args); },
    getImageData(_x: number, _y: number, width: number, height: number) {
      if (state.readError !== null) throw state.readError;
      return { width, height, data: pixels } as ImageData;
    },
    isContextLost() { return false; }
  };
  return Object.freeze({
    state,
    createCanvas(width, height) {
      state.creations += 1;
      return {
        width,
        height,
        getContext(type: string) {
          return type === "2d"
            ? context as unknown as CanvasRenderingContext2D
            : null;
        }
      } as unknown as HTMLCanvasElement;
    }
  });
}
