const MICROSECONDS_PER_SECOND = 1_000_000n;
const MAX_SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);
const MAX_FRAME_RATE = 60n;

export interface WebCodecsFrameRate {
  readonly numerator: number;
  readonly denominator: number;
}

export interface WebCodecsTiming {
  readonly timestamp: number;
  readonly duration: number;
}

/** Convert AVAL's exact frame-clock ticks to WebCodecs integer microseconds. */
export function webCodecsTimingForTicks(
  timestamp: number,
  duration: number,
  frameRate: Readonly<WebCodecsFrameRate>
): Readonly<WebCodecsTiming> {
  validateTick(timestamp, "timestamp");
  validateTick(duration, "duration");
  validateFrameRate(frameRate);

  const end = BigInt(timestamp) + BigInt(duration);
  if (end > MAX_SAFE_INTEGER) {
    throw new RangeError("decoder frame timing exceeds the safe-integer range");
  }

  const startMicroseconds = microsecondsForTick(BigInt(timestamp), frameRate);
  const endMicroseconds = microsecondsForTick(end, frameRate);
  const convertedDuration = endMicroseconds - startMicroseconds;
  if (
    convertedDuration < 0 ||
    convertedDuration > Number.MAX_SAFE_INTEGER ||
    duration > 0 && convertedDuration === 0
  ) {
    throw new RangeError("decoder frame duration cannot be represented in microseconds");
  }

  return Object.freeze({
    timestamp: startMicroseconds,
    duration: convertedDuration
  });
}

function microsecondsForTick(
  tick: bigint,
  frameRate: Readonly<WebCodecsFrameRate>
): number {
  const numerator =
    tick * MICROSECONDS_PER_SECOND * BigInt(frameRate.denominator);
  const denominator = BigInt(frameRate.numerator);
  const rounded = (numerator + denominator / 2n) / denominator;
  if (rounded > MAX_SAFE_INTEGER) {
    throw new RangeError("decoder frame timestamp exceeds the safe-integer range");
  }
  return Number(rounded);
}

function validateTick(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`decoder frame ${label} must be a non-negative safe integer`);
  }
}

function validateFrameRate(frameRate: Readonly<WebCodecsFrameRate>): void {
  if (
    !Number.isSafeInteger(frameRate.numerator) ||
    frameRate.numerator < 1 ||
    !Number.isSafeInteger(frameRate.denominator) ||
    frameRate.denominator < 1 ||
    BigInt(frameRate.numerator) >
      MAX_FRAME_RATE * BigInt(frameRate.denominator)
  ) {
    throw new RangeError("decoder frame rate is invalid");
  }
}
