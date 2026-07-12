export const RUNTIME_MEBIBYTE = 1024 * 1024;
export const BYTES_PER_RGBA_PIXEL = 4;
export const GPU_OVERHEAD_NUMERATOR = 5;
export const GPU_OVERHEAD_DENOMINATOR = 4;
export const STREAMING_TEXTURE_LAYER_COUNT = 3;
export const MAX_PLAYER_RUNTIME_BYTES = 64 * RUNTIME_MEBIBYTE;

type ByteOperand = number | bigint;

/** Add non-negative byte terms without losing integer precision. */
export function checkedByteSum(
  values: readonly ByteOperand[],
  label: string
): bigint {
  let total = 0n;
  for (const value of values) total += checkedByteOperand(value, label);
  return total;
}

/** Multiply non-negative byte factors without Number overflow. */
export function checkedByteProduct(
  values: readonly ByteOperand[],
  label: string
): bigint {
  let total = 1n;
  for (const value of values) total *= checkedByteOperand(value, label);
  return total;
}

export function checkedRgbaBytes(
  width: number,
  height: number,
  layers = 1,
  label = "RGBA bytes"
): bigint {
  validateNonNegativeSafeInteger(width, `${label} width`);
  validateNonNegativeSafeInteger(height, `${label} height`);
  validateNonNegativeSafeInteger(layers, `${label} layers`);
  return checkedByteProduct(
    [width, height, BYTES_PER_RGBA_PIXEL, layers],
    label
  );
}

/** Apply the frozen 25% allocation overhead, rounding upward. */
export function roundedGpuAllocationBytes(bytes: ByteOperand): bigint {
  const value = checkedByteOperand(bytes, "GPU allocation bytes");
  return (
    value * BigInt(GPU_OVERHEAD_NUMERATOR) +
    BigInt(GPU_OVERHEAD_DENOMINATOR - 1)
  ) / BigInt(GPU_OVERHEAD_DENOMINATOR);
}

export function checkedByteNumber(value: bigint, label: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`${label} exceeds JavaScript's safe-integer range`);
  }
  return Number(value);
}

export function validatePositiveSafeInteger(
  value: number,
  label: string
): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
}

export function validateNonNegativeSafeInteger(
  value: number,
  label: string
): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
}

function checkedByteOperand(value: ByteOperand, label: string): bigint {
  if (typeof value === "bigint") {
    if (value < 0n) throw new RangeError(`${label} must not be negative`);
    return value;
  }
  validateNonNegativeSafeInteger(value, label);
  return BigInt(value);
}
