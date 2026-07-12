import type { ValidatedStaticPngProfile } from "@rendered-motion/format";

/** Capture a host-supplied strict profile once and publish only local scalars. */
export function normalizeRuntimeStaticProfile(
  value: Readonly<ValidatedStaticPngProfile>,
  width: number,
  height: number,
  pngByteLength: number
): Readonly<ValidatedStaticPngProfile> {
  const expectedFilteredBytes = height * (1 + width * 4);
  const expectedRgbaBytes = width * height * 4;
  if (typeof value !== "object" || value === null) throw new TypeError();
  const suppliedWidth = Reflect.get(value, "width") as unknown;
  const suppliedHeight = Reflect.get(value, "height") as unknown;
  const suppliedRange = Reflect.get(value, "byteRange") as unknown;
  const zlibByteLength = Reflect.get(value, "zlibByteLength") as unknown;
  const filteredBytes = Reflect.get(value, "expectedFilteredBytes") as unknown;
  const rgbaBytes = Reflect.get(value, "expectedRgbaBytes") as unknown;
  if (typeof suppliedRange !== "object" || suppliedRange === null) {
    throw new TypeError();
  }
  const suppliedOffset = Reflect.get(suppliedRange, "offset") as unknown;
  const suppliedLength = Reflect.get(suppliedRange, "length") as unknown;
  if (
    suppliedWidth !== width || suppliedHeight !== height ||
    suppliedOffset !== 0 || suppliedLength !== pngByteLength ||
    typeof zlibByteLength !== "number" ||
    !Number.isSafeInteger(zlibByteLength) ||
    zlibByteLength < 1 || zlibByteLength > pngByteLength ||
    filteredBytes !== expectedFilteredBytes || rgbaBytes !== expectedRgbaBytes
  ) {
    throw new TypeError();
  }
  return Object.freeze({
    width,
    height,
    byteRange: Object.freeze({ offset: 0, length: pngByteLength }),
    zlibByteLength,
    expectedFilteredBytes,
    expectedRgbaBytes
  });
}
