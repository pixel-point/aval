export function canvas2dContext(
  canvas: HTMLCanvasElement,
  willReadFrequently: boolean
): CanvasRenderingContext2D | null {
  // Avoid Android low-latency surfaces; normal composition/readback is required.
  return canvas.getContext("2d", {
    alpha: true,
    willReadFrequently
  });
}

export function configureCanvas2dContext(
  context: CanvasRenderingContext2D
): void {
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "low";
}

export function assertCanvas2dContextAvailable(
  context: CanvasRenderingContext2D
): void {
  const candidate = context as CanvasRenderingContext2D & Readonly<{
    isContextLost?: () => boolean;
  }>;
  if (typeof candidate.isContextLost === "function" && candidate.isContextLost()) {
    throw new Error("Canvas2D context is lost");
  }
}
