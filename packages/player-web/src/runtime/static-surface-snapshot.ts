import type { StaticSurfaceDecodeSnapshot } from "./static-surfaces.js";

const STATIC_DECODE_COUNTERS = Object.freeze([
  "nativeAttempts",
  "nativeSuccesses",
  "pureAttempts",
  "pureSuccesses",
  "errors",
  "peakPngCopyBytes",
  "peakZlibBytes",
  "peakFilteredBytes",
  "peakRgbaBytes",
  "bitmapCloses"
] as const);

/** Capture diagnostics without publishing a decoder-owned mutable snapshot. */
export function cloneStaticDecodeSnapshot(
  value: Readonly<StaticSurfaceDecodeSnapshot> | undefined
): Readonly<StaticSurfaceDecodeSnapshot> | null {
  if (value === undefined) return null;
  const result = {} as Record<(typeof STATIC_DECODE_COUNTERS)[number], number>;
  for (const key of STATIC_DECODE_COUNTERS) {
    const field = value[key];
    if (!Number.isSafeInteger(field) || field < 0) {
      throw new RangeError(`static decoder snapshot ${key} is invalid`);
    }
    result[key] = field;
  }
  return Object.freeze(result);
}
