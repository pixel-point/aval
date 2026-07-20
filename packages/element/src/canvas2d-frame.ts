import {
  checkedSum,
  rgbaBytes,
  type RenderLayout
} from "./renderer-geometry.js";

export interface Canvas2dCpuFrame {
  readonly color: Uint8ClampedArray;
  readonly alpha: Uint8ClampedArray | null;
}

/** Allocates one exact color/mask CPU frame for a validated render layout. */
export function createCanvas2dCpuFrame(
  layout: Readonly<RenderLayout>
): Canvas2dCpuFrame {
  const colorBytes = rgbaBytes(layout.colorRect[2], layout.colorRect[3]);
  return {
    color: new Uint8ClampedArray(colorBytes),
    alpha: layout.alphaRect === undefined
      ? null : new Uint8ClampedArray(colorBytes)
  };
}

/** Extracts packed color and optional red-channel alpha into an existing frame. */
export function extractCanvas2dCpuFrame(
  layout: Readonly<RenderLayout>,
  target: Canvas2dCpuFrame,
  pixels: Uint8Array
): void {
  extractColor(layout, target.color, pixels);
  const alphaRect = layout.alphaRect;
  const alpha = target.alpha;
  if (alphaRect === undefined || alpha === null) return;
  const [alphaX, alphaY, alphaWidth, alphaHeight] = alphaRect;
  const storageStride = layout.storageWidth * 4;
  for (let row = 0; row < alphaHeight; row += 1) {
    for (let column = 0; column < alphaWidth; column += 1) {
      const source = (alphaY + row) * storageStride + (alphaX + column) * 4;
      const destination = (row * alphaWidth + column) * 4;
      alpha[destination] = 255;
      alpha[destination + 1] = 255;
      alpha[destination + 2] = 255;
      alpha[destination + 3] = pixels[source] ?? 0;
    }
  }
}

export function canvas2dCpuFrameBytes(frame: Canvas2dCpuFrame): number {
  return checkedSum([frame.color.byteLength, frame.alpha?.byteLength ?? 0]);
}

function extractColor(
  layout: Readonly<RenderLayout>,
  target: Uint8ClampedArray,
  pixels: Uint8Array
): void {
  const [colorX, colorY, colorWidth, colorHeight] = layout.colorRect;
  const storageStride = layout.storageWidth * 4;
  for (let row = 0; row < colorHeight; row += 1) {
    for (let column = 0; column < colorWidth; column += 1) {
      const source = (colorY + row) * storageStride + (colorX + column) * 4;
      const destination = (row * colorWidth + column) * 4;
      target[destination] = pixels[source] ?? 0;
      target[destination + 1] = pixels[source + 1] ?? 0;
      target[destination + 2] = pixels[source + 2] ?? 0;
      target[destination + 3] = 255;
    }
  }
}
