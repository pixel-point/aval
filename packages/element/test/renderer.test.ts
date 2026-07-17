import { describe, expect, it } from "vitest";

import {
  Renderer,
  type RenderLayout
} from "../src/renderer.js";

describe("renderer geometry admission", () => {
  it("accepts canonical even-padded odd packed storage", () => {
    expect(() => new Renderer(canvas(), layout())).toThrow(/WebGL2/u);
  });

  it("rejects extent-based storage that drops canonical odd padding", () => {
    expect(() => new Renderer(canvas(), {
      ...layout(), storageWidth: 47, storageHeight: 103
    })).toThrow(/storage rectangle/u);
  });

  it("rejects invalid pixel aspect before allocating WebGL resources", () => {
    expect(() => new Renderer(canvas(), {
      ...layout(), pixelAspect: [0, 1]
    })).toThrow(/pixel aspect/u);
  });
});

describe("renderer runtime ownership", () => {
  it("applies exact initial presentation backing before resource admission", () => {
    const fixture = webglCanvas();
    const renderer = new Renderer(fixture.canvas, layout(), {
      initialPresentation: { width: 20, height: 10, dpr: 2, fit: "cover" }
    });

    expect(renderer.snapshot()).toMatchObject({
      cssWidth: 20,
      cssHeight: 10,
      backingWidth: 40,
      backingHeight: 20,
      effectiveDprX: 2,
      effectiveDprY: 2
    });
    renderer.dispose();
  });

  it("rotates three streaming textures and accounts for every allocation", async () => {
    const fixture = webglCanvas();
    const renderer = new Renderer(fixture.canvas, layout());
    for (let index = 0; index < 4; index += 1) await renderer.draw(frame());

    expect(fixture.gl.drawnTextures).toEqual([
      fixture.gl.createdTextures[0],
      fixture.gl.createdTextures[1],
      fixture.gl.createdTextures[2],
      fixture.gl.createdTextures[0]
    ]);
    expect(renderer.snapshot()).toMatchObject({
      textureBytes: Math.ceil(48 * 112 * 4 * 3 * 5 / 4),
      resourceCount: 4,
      sourceCopiesInFlight: 0
    });
  });

  it("admits the exact rounded GPU allocation boundary", () => {
    const textureBytes = Math.ceil(48 * 112 * 4 * 3 * 5 / 4);
    const backingBytes = Math.ceil(48 * 104 * 4 * 5 / 4);
    const stagingBytes = 48 * 104 * 4;
    const runtimeBytes = textureBytes + backingBytes + stagingBytes;
    const exact = new Renderer(webglCanvas().canvas, layout(), {
      maxTextureBytes: textureBytes,
      maxBackingBytes: backingBytes,
      maxRuntimeBytes: runtimeBytes
    });
    expect(exact.snapshot()).toMatchObject({ textureBytes, runtimeBytes });
    exact.dispose();

    expect(() => new Renderer(webglCanvas().canvas, layout(), {
      maxTextureBytes: textureBytes - 1,
      maxBackingBytes: backingBytes,
      maxRuntimeBytes: runtimeBytes
    })).toThrow(/resource byte cap/u);
    expect(() => new Renderer(webglCanvas().canvas, layout(), {
      maxTextureBytes: textureBytes,
      maxBackingBytes: backingBytes - 1,
      maxRuntimeBytes: runtimeBytes
    })).toThrow(/resource byte cap/u);
    expect(() => new Renderer(webglCanvas().canvas, layout(), {
      maxTextureBytes: textureBytes,
      maxBackingBytes: backingBytes,
      maxRuntimeBytes: runtimeBytes - 1
    })).toThrow(/resource byte cap/u);
  });

  it("restores exact canvas state after failed admission before a later candidate", () => {
    const fixture = webglCanvas();
    const original = [fixture.canvas.width, fixture.canvas.height];
    expect(() => new Renderer(fixture.canvas, layout(), {
      initialPresentation: { width: 20, height: 10, dpr: 2, fit: "contain" },
      maxBackingBytes: 1
    })).toThrow(/resource byte cap/u);
    expect([fixture.canvas.width, fixture.canvas.height]).toEqual(original);

    const second = new Renderer(fixture.canvas, layout(), {
      initialPresentation: { width: 30, height: 12, dpr: 2, fit: "cover" }
    });
    expect([fixture.canvas.width, fixture.canvas.height]).toEqual([60, 24]);
    second.dispose();

    const terminal = webglCanvas();
    const terminalOriginal = [terminal.canvas.width, terminal.canvas.height];
    expect(() => new Renderer(terminal.canvas, layout(), {
      initialPresentation: { width: 99, height: 77, dpr: 1, fit: "fill" },
      maxRuntimeBytes: 1
    })).toThrow(/resource byte cap/u);
    expect([terminal.canvas.width, terminal.canvas.height]).toEqual(terminalOriginal);
  });

  it("rejects a draw that loses its context and reports loss asynchronously", async () => {
    const fixture = webglCanvas();
    const changes: string[] = [];
    const renderer = new Renderer(fixture.canvas, layout(), {
      onContextChange: (state) => changes.push(state)
    });
    fixture.gl.loseOnDraw = true;

    await expect(renderer.draw(frame())).rejects.toMatchObject({ name: "AbortError" });
    expect(changes).toEqual(["lost"]);
    expect(renderer.snapshot()).toMatchObject({
      contextLossCount: 1,
      textureBytes: 0,
      resourceCount: 0
    });
  });

  it("keeps an unresolved raw frame copy visible after disposal", async () => {
    const fixture = webglCanvas();
    const copy = deferred<readonly PlaneLayout[]>();
    const renderer = new Renderer(fixture.canvas, layout());
    fixture.gl.rejectNativeUpload = true;
    const drawing = renderer.draw(frame(() => copy.promise));
    await eventually(() => renderer.snapshot().sourceCopiesInFlight === 1);

    renderer.dispose();
    expect(renderer.snapshot().sourceCopiesInFlight).toBe(1);
    copy.resolve([{ offset: 0, stride: 48 * 4 }]);
    await expect(drawing).rejects.toMatchObject({ name: "AbortError" });
    expect(renderer.snapshot().sourceCopiesInFlight).toBe(0);
  });
});

function layout(): RenderLayout {
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

function canvas(): HTMLCanvasElement {
  return {
    width: 1,
    height: 1,
    addEventListener() {},
    removeEventListener() {},
    getContext() { return null; }
  } as unknown as HTMLCanvasElement;
}

function frame(
  copy: () => Promise<readonly PlaneLayout[]> = async () => [
    { offset: 0, stride: 48 * 4 }
  ]
): VideoFrame {
  return {
    codedWidth: 48,
    codedHeight: 112,
    displayWidth: 48,
    displayHeight: 104,
    visibleRect: { x: 0, y: 0, width: 48, height: 104 },
    copyTo: copy
  } as unknown as VideoFrame;
}

function webglCanvas(): Readonly<{
  canvas: HTMLCanvasElement;
  gl: TestGl;
}> {
  const gl = new TestGl();
  const listeners = new Map<string, EventListener>();
  const canvas = {
    width: 48,
    height: 104,
    addEventListener(type: string, listener: EventListener) {
      listeners.set(type, listener);
    },
    removeEventListener(type: string) { listeners.delete(type); },
    getContext() { return gl as unknown as WebGL2RenderingContext; }
  } as unknown as HTMLCanvasElement;
  return Object.freeze({ canvas, gl });
}

class TestGl {
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

  public readonly createdTextures: WebGLTexture[] = [];
  public readonly drawnTextures: WebGLTexture[] = [];
  public rejectNativeUpload = false;
  public loseOnDraw = false;
  #bound: WebGLTexture | null = null;
  #error = 0;
  #lost = false;

  public getParameter(parameter: number): number | readonly number[] {
    return parameter === this.MAX_VIEWPORT_DIMS ? [8_192, 8_192] : 8_192;
  }
  public createShader(): WebGLShader { return {} as WebGLShader; }
  public shaderSource(): void {}
  public compileShader(): void {}
  public getShaderParameter(): boolean { return true; }
  public deleteShader(): void {}
  public createProgram(): WebGLProgram { return {} as WebGLProgram; }
  public attachShader(): void {}
  public linkProgram(): void {}
  public getProgramParameter(): boolean { return true; }
  public deleteProgram(): void {}
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
  public texStorage2D(): void {}
  public texSubImage2D(...values: readonly unknown[]): void {
    if (values.length === 7 && this.rejectNativeUpload) this.#error = 1;
  }
  public getUniformLocation(): WebGLUniformLocation {
    return {} as WebGLUniformLocation;
  }
  public clearColor(): void {}
  public disable(): void {}
  public pixelStorei(): void {}
  public viewport(): void {}
  public clear(): void {}
  public useProgram(): void {}
  public activeTexture(): void {}
  public uniform1i(): void {}
  public uniform1f(): void {}
  public uniform4f(): void {}
  public drawArrays(): void {
    if (this.#bound !== null) this.drawnTextures.push(this.#bound);
    if (this.loseOnDraw) this.#lost = true;
  }
  public getError(): number {
    const error = this.#error;
    this.#error = 0;
    return error;
  }
  public isContextLost(): boolean { return this.#lost; }
}

function deferred<T>(): Readonly<{
  promise: Promise<T>;
  resolve(value: T): void;
}> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return Object.freeze({ promise, resolve });
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error("condition did not become true");
}
