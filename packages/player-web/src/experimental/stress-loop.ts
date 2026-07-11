import {
  ContinuousLoopDecoder,
  type ContinuousLoopDecoderMetrics,
  type EncodedVideoChunkFactory,
  type ManagedDecodedFrame,
  type VideoDecoderFactory
} from "./continuous-loop-decoder.js";
import type { EncodedLoopUnit } from "./encoded-loop.js";
import {
  durationForFrame,
  splitVirtualFrame,
  timestampForFrame
} from "./rational-time.js";

export const STRESS_LOOP_ITERATIONS = 1_001;
export const STRESS_LOOP_OUTPUT_FRAMES = 2_002;
export const STRESS_LOOP_SEAMS = 1_000;

const DEFAULT_WATCHDOG_MS = 10_000;
const DEFAULT_MINIMUM_THROUGHPUT = 1.5;

type Awaitable<T> = T | PromiseLike<T>;

export interface StressExpectedFrame {
  readonly virtualFrame: bigint;
  readonly iteration: bigint;
  readonly contentFrame: number;
  readonly timestamp: number;
  readonly duration: number;
}

export type StressTagReader = (
  frame: VideoFrame,
  expected: StressExpectedFrame
) => Awaitable<number>;

export type StressFrameValidator = (
  frame: ManagedDecodedFrame,
  expected: StressExpectedFrame
) => Awaitable<void>;

export interface ContinuousLoopStressOptions {
  /** Reads the fixture's machine-readable content-frame tag. */
  readonly readTag?: StressTagReader;
  /** Alternative or additional pixel/content validator. */
  readonly validateFrame?: StressFrameValidator;
  readonly onValidatedFrame?: (
    expected: StressExpectedFrame,
    validatedCount: number
  ) => void;
  readonly maxInFlight?: number;
  readonly watchdogMs?: number;
  readonly minimumThroughput?: number;
  readonly decoderFactory?: VideoDecoderFactory;
  readonly chunkFactory?: EncodedVideoChunkFactory;
  readonly now?: () => number;
}

export interface ContinuousLoopStressReport {
  readonly passed: true;
  readonly iterations: typeof STRESS_LOOP_ITERATIONS;
  readonly outputFrames: typeof STRESS_LOOP_OUTPUT_FRAMES;
  readonly seams: typeof STRESS_LOOP_SEAMS;
  readonly validatedTags: number;
  readonly elapsedMs: number;
  readonly mediaDurationSeconds: number;
  readonly throughputMultiple: number;
  readonly minimumThroughput: number;
  readonly metrics: ContinuousLoopDecoderMetrics;
}

/**
 * Proves 1,000 loop seams without a seek, reset, reconfigure, or seam flush.
 * The supplied unit must be the two-frame tagged stress fixture.
 */
export async function runContinuousLoopStress(
  unit: EncodedLoopUnit,
  optionsOrReader: ContinuousLoopStressOptions | StressTagReader
): Promise<ContinuousLoopStressReport> {
  const options = normalizeOptions(optionsOrReader);
  if (unit.frames.length !== 2) {
    throw new RangeError("the continuous-loop stress unit must have two frames");
  }
  if (options.readTag === undefined && options.validateFrame === undefined) {
    throw new TypeError("stress requires readTag or validateFrame");
  }

  const watchdogMs = options.watchdogMs ?? DEFAULT_WATCHDOG_MS;
  const minimumThroughput =
    options.minimumThroughput ?? DEFAULT_MINIMUM_THROUGHPUT;
  const maxInFlight = options.maxInFlight ?? 16;
  validatePositiveFinite(watchdogMs, "watchdogMs");
  validatePositiveFinite(minimumThroughput, "minimumThroughput");

  const decoderOptions = {
    maxInFlight,
    ...(options.decoderFactory === undefined
      ? {}
      : { decoderFactory: options.decoderFactory }),
    ...(options.chunkFactory === undefined
      ? {}
      : { chunkFactory: options.chunkFactory })
  };
  const decoder = new ContinuousLoopDecoder(unit, decoderOptions);
  const now = options.now ?? defaultNow;
  const startedAt = now();
  const stopBefore = BigInt(STRESS_LOOP_OUTPUT_FRAMES);
  let seams = 0;
  let validatedTags = 0;
  let terminalFlush: Promise<void> | null = null;

  const fillAndMaybeFlush = (): void => {
    if (terminalFlush !== null) {
      return;
    }
    decoder.fillToAhead(maxInFlight, stopBefore);
    if (
      terminalFlush === null &&
      decoder.snapshotMetrics().submittedChunks === STRESS_LOOP_OUTPUT_FRAMES
    ) {
      terminalFlush = decoder.terminalFlush();
      // Attach a handler immediately; the original promise is still awaited.
      void terminalFlush.catch(() => undefined);
    }
  };

  try {
    fillAndMaybeFlush();

    for (
      let ordinal = 0;
      ordinal < STRESS_LOOP_OUTPUT_FRAMES;
      ordinal += 1
    ) {
      await decoder.waitForFrames(1, { timeoutMs: watchdogMs });
      const decoded = decoder.takeFrame();
      if (decoded === undefined) {
        throw new Error("decoder signalled readiness without a queued frame");
      }

      fillAndMaybeFlush();
      const expected = expectedFrame(ordinal, unit);

      try {
        validateMetadata(decoded, expected);
        if (ordinal > 0 && expected.contentFrame === 0) {
          seams += 1;
        }

        await withWatchdog(
          validateContent(decoded, expected, options, () => {
            validatedTags += 1;
          }),
          watchdogMs,
          "decoded-frame tag validation"
        );
        options.onValidatedFrame?.(expected, ordinal + 1);
      } finally {
        decoded.close();
      }
    }

    if (terminalFlush === null) {
      throw new Error("stress ended before every encoded chunk was submitted");
    }
    await terminalFlush;

    const elapsedMs = Math.max(0, now() - startedAt);
    const mediaDurationMicroseconds =
      timestampForFrame(STRESS_LOOP_OUTPUT_FRAMES, unit.frameRate) -
      timestampForFrame(0, unit.frameRate);
    const mediaDurationSeconds = mediaDurationMicroseconds / 1_000_000;
    const throughputMultiple =
      elapsedMs === 0
        ? Number.POSITIVE_INFINITY
        : mediaDurationMicroseconds / (elapsedMs * 1_000);

    if (seams !== STRESS_LOOP_SEAMS) {
      throw new Error(
        `expected ${String(STRESS_LOOP_SEAMS)} seams, observed ${String(seams)}`
      );
    }
    if (throughputMultiple < minimumThroughput) {
      throw new Error(
        `decode throughput ${throughputMultiple.toFixed(2)}x is below ${minimumThroughput.toFixed(2)}x realtime`
      );
    }

    assertFinalMetrics(decoder.snapshotMetrics());
    decoder.dispose();
    const metrics = decoder.snapshotMetrics();
    if (metrics.openFrames !== 0 || metrics.closedFrames !== metrics.outputFrames) {
      throw new Error("stress disposal left decoded VideoFrames open");
    }

    return Object.freeze({
      passed: true,
      iterations: STRESS_LOOP_ITERATIONS,
      outputFrames: STRESS_LOOP_OUTPUT_FRAMES,
      seams: STRESS_LOOP_SEAMS,
      validatedTags,
      elapsedMs,
      mediaDurationSeconds,
      throughputMultiple,
      minimumThroughput,
      metrics
    });
  } finally {
    decoder.dispose();
  }
}

function expectedFrame(
  ordinal: number,
  unit: EncodedLoopUnit
): StressExpectedFrame {
  const virtualFrame = BigInt(ordinal);
  const position = splitVirtualFrame(virtualFrame, unit.frames.length);

  return {
    virtualFrame,
    iteration: position.iteration,
    contentFrame: position.contentFrame,
    timestamp: timestampForFrame(virtualFrame, unit.frameRate),
    duration: durationForFrame(virtualFrame, unit.frameRate)
  };
}

function validateMetadata(
  decoded: ManagedDecodedFrame,
  expected: StressExpectedFrame
): void {
  if (
    decoded.virtualFrame !== expected.virtualFrame ||
    decoded.iteration !== expected.iteration ||
    decoded.contentFrame !== expected.contentFrame ||
    decoded.timestamp !== expected.timestamp ||
    decoded.duration !== expected.duration ||
    decoded.frame.timestamp !== expected.timestamp
  ) {
    throw new Error(
      `decoded metadata mismatch at virtual frame ${String(
        expected.virtualFrame
      )}`
    );
  }
}

async function validateContent(
  decoded: ManagedDecodedFrame,
  expected: StressExpectedFrame,
  options: ContinuousLoopStressOptions,
  countTag: () => void
): Promise<void> {
  if (options.readTag !== undefined) {
    const tag = await options.readTag(decoded.frame, expected);
    if (tag !== expected.contentFrame) {
      throw new Error(
        `content tag ${String(tag)} did not match frame ${String(
          expected.contentFrame
        )} at virtual frame ${String(expected.virtualFrame)}`
      );
    }
    countTag();
  }
  await options.validateFrame?.(decoded, expected);
}

function assertFinalMetrics(metrics: ContinuousLoopDecoderMetrics): void {
  if (
    metrics.configureCalls !== 1 ||
    metrics.resetCalls !== 0 ||
    metrics.boundaryFlushCalls !== 0 ||
    metrics.terminalFlushCalls !== 1 ||
    metrics.submittedChunks !== STRESS_LOOP_OUTPUT_FRAMES ||
    metrics.outputFrames !== STRESS_LOOP_OUTPUT_FRAMES ||
    metrics.openFrames !== 0 ||
    metrics.queuedFrames !== 0 ||
    metrics.reorderBufferedFrames !== 0 ||
    metrics.inFlightFrames !== 0 ||
    metrics.errors !== 0 ||
    !metrics.terminalFlushCompleted
  ) {
    throw new Error("continuous-loop decoder counters failed the stress gate");
  }
}

function normalizeOptions(
  optionsOrReader: ContinuousLoopStressOptions | StressTagReader
): ContinuousLoopStressOptions {
  return typeof optionsOrReader === "function"
    ? { readTag: optionsOrReader }
    : optionsOrReader;
}

async function withWatchdog<T>(
  operation: Promise<T>,
  timeoutMs: number,
  label: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} made no progress for ${String(timeoutMs)} ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function validatePositiveFinite(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive finite number`);
  }
}

function defaultNow(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}
