import {
  deriveVideoRenditionGeometry,
  FormatError,
  type VideoRenditionGeometry
} from "@pixel-point/aval-format";

import { sameAspectRatio } from "./media-geometry.js";

export interface RenderLayout {
  readonly codedWidth: number;
  readonly codedHeight: number;
  readonly storageWidth: number;
  readonly storageHeight: number;
  readonly logicalWidth: number;
  readonly logicalHeight: number;
  readonly pixelAspect: readonly [number, number];
  readonly colorRect: readonly [number, number, number, number];
  readonly alphaRect?: readonly [number, number, number, number];
}

export type RenderLayoutInput = Omit<
  RenderLayout,
  "storageWidth" | "storageHeight"
>;

export type RendererFit = "contain" | "cover" | "fill" | "none";

export interface RendererViewport {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface RendererBackingSize {
  readonly width: number;
  readonly height: number;
  readonly dpr: number;
}

export function deriveRenderLayout(
  value: Readonly<RenderLayoutInput>
): RenderLayout {
  const geometry = canonicalRenderGeometry(value);
  return checkedRenderLayoutAgainstGeometry({
    ...value,
    storageWidth: geometry.decodedStorageRect[2],
    storageHeight: geometry.decodedStorageRect[3]
  }, geometry);
}

export function checkedRenderLayout(value: Readonly<RenderLayout>): RenderLayout {
  return checkedRenderLayoutAgainstGeometry(
    value,
    canonicalRenderGeometry(value)
  );
}

function checkedRenderLayoutAgainstGeometry(
  value: Readonly<RenderLayout>,
  geometry: Readonly<VideoRenditionGeometry>
): RenderLayout {
  const codedWidth = rendererDimension(value.codedWidth);
  const codedHeight = rendererDimension(value.codedHeight);
  const storageWidth = rendererDimension(value.storageWidth);
  const storageHeight = rendererDimension(value.storageHeight);
  const logicalWidth = rendererDimension(value.logicalWidth);
  const logicalHeight = rendererDimension(value.logicalHeight);
  const pixelAspect = value.pixelAspect;
  if (
    pixelAspect.length !== 2 ||
    !Number.isSafeInteger(pixelAspect[0]) || pixelAspect[0] < 1 ||
    !Number.isSafeInteger(pixelAspect[1]) || pixelAspect[1] < 1 ||
    !Number.isFinite(logicalWidth * pixelAspect[0] / pixelAspect[1])
  ) throw new RangeError("renderer pixel aspect is invalid");
  if (storageWidth > codedWidth || storageHeight > codedHeight) {
    throw new RangeError("renderer storage exceeds coded dimensions");
  }
  const colorRect = checkedRect(value.colorRect, storageWidth, storageHeight);
  const alphaRect = value.alphaRect === undefined
    ? undefined : checkedRect(value.alphaRect, storageWidth, storageHeight);
  const expectedColor = geometry.visibleColorRect;
  const expectedAlpha = geometry.visibleAlphaRect;
  const expectedStorage = geometry.decodedStorageRect;
  if (
    !sameRect(colorRect, expectedColor) ||
    storageWidth !== expectedStorage[2] ||
    storageHeight !== expectedStorage[3] ||
    alphaRect === undefined !== (expectedAlpha === undefined) ||
    alphaRect !== undefined && expectedAlpha !== undefined &&
      !sameRect(alphaRect, expectedAlpha)
  ) {
    throw new RangeError("renderer storage rectangle is not canonical");
  }
  return Object.freeze({
    codedWidth,
    codedHeight,
    storageWidth,
    storageHeight,
    logicalWidth,
    logicalHeight,
    pixelAspect: Object.freeze([pixelAspect[0], pixelAspect[1]]) as
      readonly [number, number],
    colorRect,
    ...(alphaRect === undefined ? {} : { alphaRect })
  });
}

function canonicalRenderGeometry(
  value: Readonly<Pick<
    RenderLayout,
    "colorRect" | "alphaRect"
  >>
): Readonly<VideoRenditionGeometry> {
  if (value.colorRect.length !== 4) {
    throw new RangeError("renderer rectangle is invalid");
  }
  const visibleWidth = rendererDimension(value.colorRect[2]);
  const visibleHeight = rendererDimension(value.colorRect[3]);
  try {
    return deriveVideoRenditionGeometry({
      canvasWidth: visibleWidth,
      canvasHeight: visibleHeight,
      layout: value.alphaRect === undefined ? "opaque" : "packed-alpha",
      visibleWidth,
      visibleHeight,
      storage: { widthAlignment: 1, heightAlignment: 1 }
    });
  } catch (error) {
    if (error instanceof FormatError) {
      throw new RangeError(
        "renderer storage rectangle is not canonical",
        { cause: error }
      );
    }
    throw error;
  }
}

function sameRect(
  left: readonly [number, number, number, number],
  right: readonly [number, number, number, number]
): boolean {
  return left[0] === right[0] && left[1] === right[1] &&
    left[2] === right[2] && left[3] === right[3];
}

export function validateRenderFrame(
  frame: VideoFrame,
  layout: Readonly<RenderLayout>
): DOMRectReadOnly {
  const visible = frame.visibleRect;
  if (
    visible === null ||
    !Number.isSafeInteger(frame.codedWidth) || frame.codedWidth < 1 ||
    !Number.isSafeInteger(frame.codedHeight) || frame.codedHeight < 1 ||
    !Number.isSafeInteger(frame.displayWidth) || frame.displayWidth < 1 ||
    !Number.isSafeInteger(frame.displayHeight) || frame.displayHeight < 1 ||
    !sameAspectRatio(
      frame.displayWidth,
      frame.displayHeight,
      layout.storageWidth,
      layout.storageHeight
    ) ||
    !Number.isSafeInteger(visible.x) || visible.x < 0 ||
    !Number.isSafeInteger(visible.y) || visible.y < 0 ||
    visible.width !== layout.storageWidth ||
    visible.height !== layout.storageHeight ||
    visible.x > frame.codedWidth - visible.width ||
    visible.y > frame.codedHeight - visible.height
  ) throw new Error("decoded frame geometry is invalid");
  return visible;
}

export function calculateRendererBacking(
  cssWidth: number,
  cssHeight: number,
  devicePixelRatio: number
): RendererBackingSize {
  if (
    !Number.isFinite(cssWidth) || cssWidth < 0 ||
    !Number.isFinite(cssHeight) || cssHeight < 0 ||
    !Number.isFinite(devicePixelRatio) || devicePixelRatio <= 0
  ) throw new RangeError("renderer presentation geometry is invalid");
  const dpr = Math.max(0.1, devicePixelRatio);
  const width = Math.max(1, Math.round(cssWidth * dpr));
  const height = Math.max(1, Math.round(cssHeight * dpr));
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)) {
    throw new RangeError("renderer backing dimensions are invalid");
  }
  return Object.freeze({ width, height, dpr });
}

export function calculateRendererViewport(
  layout: Readonly<RenderLayout>,
  backingWidth: number,
  backingHeight: number,
  devicePixelRatio: number,
  fit: RendererFit
): RendererViewport {
  if (
    !Number.isSafeInteger(backingWidth) || backingWidth < 1 ||
    !Number.isSafeInteger(backingHeight) || backingHeight < 1 ||
    !Number.isFinite(devicePixelRatio) || devicePixelRatio <= 0 ||
    !isRendererFit(fit)
  ) throw new RangeError("renderer viewport geometry is invalid");
  const sourceWidth = layout.logicalWidth *
    layout.pixelAspect[0] / layout.pixelAspect[1];
  const sourceHeight = layout.logicalHeight;
  if (!Number.isFinite(sourceWidth) || sourceWidth <= 0) {
    throw new RangeError("renderer viewport source is invalid");
  }
  let width = backingWidth;
  let height = backingHeight;
  if (fit !== "fill") {
    const scale = fit === "cover"
      ? Math.max(backingWidth / sourceWidth, backingHeight / sourceHeight)
      : fit === "none"
        ? devicePixelRatio
        : Math.min(backingWidth / sourceWidth, backingHeight / sourceHeight);
    width = Math.max(1, Math.round(sourceWidth * scale));
    height = Math.max(1, Math.round(sourceHeight * scale));
  }
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)) {
    throw new RangeError("renderer viewport exceeds arithmetic limits");
  }
  return Object.freeze({
    x: Math.round((backingWidth - width) / 2),
    y: Math.round((backingHeight - height) / 2),
    width,
    height
  });
}

export function isRendererFit(value: string): value is RendererFit {
  return value === "contain" || value === "cover" ||
    value === "fill" || value === "none";
}

export function rgbaBytes(width: number, height: number): number {
  return checkedProduct(checkedProduct(width, height), 4);
}

export function allocationBytes(rawBytes: number): number {
  return Math.ceil(checkedProduct(rawBytes, 5) / 4);
}

export function checkedProduct(left: number, right: number): number {
  if (
    !Number.isSafeInteger(left) || left < 0 ||
    !Number.isSafeInteger(right) || right < 0 ||
    right !== 0 && left > Math.floor(Number.MAX_SAFE_INTEGER / right)
  ) throw new RangeError("renderer byte count is unsafe");
  return left * right;
}

export function checkedSum(values: readonly number[]): number {
  let total = 0;
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value < 0 ||
      value > Number.MAX_SAFE_INTEGER - total) {
      throw new RangeError("renderer byte sum is unsafe");
    }
    total += value;
  }
  return total;
}

function checkedRect(
  value: readonly number[],
  width: number,
  height: number
): readonly [number, number, number, number] {
  if (value.length !== 4) throw new RangeError("renderer rectangle is invalid");
  const result = [
    rendererCoordinate(value[0]),
    rendererCoordinate(value[1]),
    rendererDimension(value[2]),
    rendererDimension(value[3])
  ] as [number, number, number, number];
  if (result[0] > width - result[2] || result[1] > height - result[3]) {
    throw new RangeError("renderer rectangle exceeds storage");
  }
  return Object.freeze(result);
}

function rendererCoordinate(value: number | undefined): number {
  if (value === undefined || !Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("renderer coordinate is invalid");
  }
  return value;
}

function rendererDimension(value: number | undefined): number {
  if (value === undefined || !Number.isSafeInteger(value) || value < 1) {
    throw new RangeError("renderer dimension is invalid");
  }
  return value;
}
