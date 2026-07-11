const MICROSECONDS_PER_SECOND = 1_000_000n;
const MAX_FRAME_RATE = 60n;
const MAX_SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);

export interface RationalFrameRate {
  readonly numerator: number;
  readonly denominator: number;
}

export interface VirtualFramePosition {
  readonly iteration: bigint;
  readonly contentFrame: number;
}

/**
 * Validates the exact rational clock used by the experimental player.
 *
 * Rates are deliberately not reduced: preserving the authored numerator and
 * denominator makes the clock carried by the unit explicit. Comparisons are
 * performed with integers, so a rate near the 60 fps ceiling is never rounded
 * through JavaScript floating-point arithmetic.
 */
export function validateFrameRate(rate: RationalFrameRate): void {
  validatePositiveSafeInteger(rate.numerator, "frame-rate numerator");
  validatePositiveSafeInteger(rate.denominator, "frame-rate denominator");

  if (
    BigInt(rate.numerator) >
    MAX_FRAME_RATE * BigInt(rate.denominator)
  ) {
    throw new RangeError("frame rate must not exceed 60 fps");
  }
}

/**
 * Maps a virtual content-frame ordinal to the WebCodecs integer-microsecond
 * clock. The calculation uses exact integers and rounds ties away from zero
 * (round-half-up for the non-negative frame domain).
 */
export function timestampForFrame(
  virtualFrame: number | bigint,
  rate: RationalFrameRate
): number {
  validateFrameRate(rate);

  const frame = normalizeVirtualFrame(virtualFrame);
  const dividend =
    frame * MICROSECONDS_PER_SECOND * BigInt(rate.denominator);
  const timestamp = divideRoundHalfUp(dividend, BigInt(rate.numerator));

  if (timestamp > MAX_SAFE_INTEGER) {
    throw new RangeError(
      "frame timestamp exceeds JavaScript's safe-integer range"
    );
  }

  return Number(timestamp);
}

/**
 * Returns the duration of a frame from adjacent timestamps. This avoids the
 * cumulative drift caused by repeatedly adding an already-rounded duration.
 */
export function durationForFrame(
  virtualFrame: number | bigint,
  rate: RationalFrameRate
): number {
  const frame = normalizeVirtualFrame(virtualFrame);
  const timestamp = timestampForFrame(frame, rate);
  const nextTimestamp = timestampForFrame(frame + 1n, rate);

  return nextTimestamp - timestamp;
}

/**
 * Maps the unbounded scheduler clock back to a reusable encoded loop frame.
 */
export function splitVirtualFrame(
  virtualFrame: number | bigint,
  unitFrameCount: number
): VirtualFramePosition {
  const frame = normalizeVirtualFrame(virtualFrame);
  validatePositiveSafeInteger(unitFrameCount, "unit frame count");

  const count = BigInt(unitFrameCount);

  return {
    iteration: frame / count,
    contentFrame: Number(frame % count)
  };
}

function normalizeVirtualFrame(virtualFrame: number | bigint): bigint {
  if (typeof virtualFrame === "bigint") {
    if (virtualFrame < 0n) {
      throw new RangeError("virtual frame must be non-negative");
    }

    return virtualFrame;
  }

  if (!Number.isSafeInteger(virtualFrame) || virtualFrame < 0) {
    throw new RangeError(
      "virtual frame must be a non-negative safe integer or bigint"
    );
  }

  return BigInt(virtualFrame);
}

function validatePositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
}

function divideRoundHalfUp(dividend: bigint, divisor: bigint): bigint {
  const quotient = dividend / divisor;
  const remainder = dividend % divisor;

  return quotient + (remainder * 2n >= divisor ? 1n : 0n);
}
