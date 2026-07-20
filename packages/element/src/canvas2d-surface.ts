import {
  assertCanvas2dContextAvailable,
  canvas2dContext,
  configureCanvas2dContext
} from "./canvas2d-context.js";

export interface Canvas2dSurface {
  readonly canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D | null;
}

export function createCanvas2dSurface(
  createCanvas: (width: number, height: number) => HTMLCanvasElement,
  width: number,
  height: number
): Canvas2dSurface {
  const canvas = createCanvas(width, height);
  try {
    canvas.width = width;
    canvas.height = height;
    if (canvas.width !== width || canvas.height !== height) {
      throw new Error("Canvas2D scratch surface rejected its dimensions");
    }
    const context = canvas2dContext(canvas, false);
    if (context === null) throw new Error("Canvas2D scratch context is unavailable");
    assertCanvas2dContextAvailable(context);
    configureCanvas2dContext(context);
    return { canvas, context };
  } catch (reason) {
    try {
      canvas.width = 0;
      canvas.height = 0;
    } catch { /* Preserve the context-creation cause. */ }
    throw reason;
  }
}

export function reacquireCanvas2dSurface(
  surface: Canvas2dSurface | null
): void {
  if (surface === null) throw new Error("Canvas2D scratch surface is unavailable");
  const context = canvas2dContext(surface.canvas, false);
  if (context === null) throw new Error("Canvas2D scratch context is unavailable");
  assertCanvas2dContextAvailable(context);
  configureCanvas2dContext(context);
  surface.context = context;
}

export function releaseCanvas2dSurface(surface: Canvas2dSurface | null): void {
  if (surface === null) return;
  surface.context = null;
  try {
    surface.canvas.width = 0;
    surface.canvas.height = 0;
  } catch { /* terminal cleanup */ }
}

/** Writes one exact CPU frame into a Canvas2D scratch surface. */
export function putCanvas2dPixels(
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
