import { STREAMING_TEXTURE_LAYER_COUNT } from "./checked-runtime-bytes.js";
import type {
  OpaqueFrameRendererBackend,
  OpaqueFrameTextureLayout
} from "./opaque-frame-renderer.js";

export function freezeOpaqueFrameLayout(
  layout: OpaqueFrameTextureLayout
): Readonly<OpaqueFrameTextureLayout> {
  validateOpaqueObject(layout, "opaque texture layout");
  const codedWidth = validateOpaqueDimension(
    layout.codedWidth,
    "coded texture width"
  );
  const codedHeight = validateOpaqueDimension(
    layout.codedHeight,
    "coded texture height"
  );
  const logicalWidth = validateOpaqueDimension(
    layout.logicalWidth,
    "logical width"
  );
  const logicalHeight = validateOpaqueDimension(
    layout.logicalHeight,
    "logical height"
  );
  const residentLayerCount = validateOpaqueNonNegativeDimension(
    layout.residentLayerCount,
    "resident texture layer count"
  );
  checkedOpaqueRgbaBytes(codedWidth, codedHeight);
  checkedOpaqueRgbaBytes(logicalWidth, logicalHeight);
  return Object.freeze({
    codedWidth,
    codedHeight,
    logicalWidth,
    logicalHeight,
    residentLayerCount
  });
}

export function validateOpaqueBackendLimits(
  backend: OpaqueFrameRendererBackend,
  layout: Readonly<OpaqueFrameTextureLayout>
): void {
  const { maxTextureSize, maxArrayTextureLayers } = backend.limits;
  validateOpaqueDimension(maxTextureSize, "MAX_TEXTURE_SIZE");
  validateOpaqueDimension(maxArrayTextureLayers, "MAX_ARRAY_TEXTURE_LAYERS");
  if (
    layout.codedWidth > maxTextureSize ||
    layout.codedHeight > maxTextureSize ||
    layout.logicalWidth > maxTextureSize ||
    layout.logicalHeight > maxTextureSize
  ) {
    throw new RangeError("frame texture dimensions exceed MAX_TEXTURE_SIZE");
  }
  if (layout.residentLayerCount > maxArrayTextureLayers) {
    throw new RangeError("resident layers exceed MAX_ARRAY_TEXTURE_LAYERS");
  }
}

export function checkedOpaqueRgbaBytes(
  width: number,
  height: number
): number {
  const pixels = width * height;
  const bytes = pixels * 4;
  if (!Number.isSafeInteger(pixels) || !Number.isSafeInteger(bytes)) {
    throw new RangeError("RGBA staging byte count exceeds safe integer range");
  }
  return bytes;
}

export function validateOpaqueDimension(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
  return value;
}

export function validateOpaqueNonNegativeDimension(
  value: number,
  label: string
): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

export function validateOpaqueStreamingSlots(value: number): number {
  if (value !== STREAMING_TEXTURE_LAYER_COUNT) {
    throw new RangeError(
      `streaming slots must be exactly ${String(STREAMING_TEXTURE_LAYER_COUNT)}`
    );
  }
  return value;
}

export function validateOpaqueIndex(
  value: number,
  exclusiveEnd: number,
  label: string
): void {
  if (!Number.isSafeInteger(value) || value < 0 || value >= exclusiveEnd) {
    throw new RangeError(
      `${label} must be an integer in [0, ${String(exclusiveEnd)})`
    );
  }
}

export function validateOpaqueGeneration(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
}

export function validateOpaqueObject(value: unknown, label: string): void {
  if (value === null || typeof value !== "object") {
    throw new TypeError(`${label} must be an object`);
  }
}
