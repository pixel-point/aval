import {
  DECODER_WORKER_HARD_LIMITS,
  type DecoderWorkerLimits,
  type DecoderWorkerMetrics,
  type DecoderWorkerSample
} from "../decoder-worker/protocol.js";
import type { ManagedDecoderWorkerFrame } from "../decoder-worker/client.js";

interface PreparationWorkerState {
  readonly activeGeneration: number | null;
  readonly queuedFrames: number;
  readonly openFrames: number;
}

export class InteractionCachePreparationTimeoutError extends Error {
  public readonly timeoutMs: number;

  public constructor(timeoutMs: number) {
    super(`interaction cache preparation exceeded ${String(timeoutMs)} ms`);
    this.name = "InteractionCachePreparationTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export function validateManagedOutput(
  frame: ManagedDecoderWorkerFrame,
  sample: Readonly<DecoderWorkerSample>,
  maximumDecodedBytes: number
): void {
  if (
    frame.closed ||
    !Number.isSafeInteger(frame.frameId) ||
    frame.frameId < 1 ||
    frame.ordinal !== sample.ordinal ||
    frame.unitId !== sample.unitId ||
    frame.unitInstance !== sample.unitInstance ||
    frame.unitFrame !== sample.unitFrame ||
    frame.timestamp !== sample.timestamp ||
    frame.duration !== sample.duration ||
    !Number.isSafeInteger(frame.decodedBytes) ||
    frame.decodedBytes < 1 ||
    frame.decodedBytes > maximumDecodedBytes
  ) {
    throw new RangeError(
      "worker output did not match submitted cache identity"
    );
  }
}

export function validateMetrics(
  metrics: DecoderWorkerMetrics,
  limits: Readonly<DecoderWorkerLimits>,
  generation: number
): void {
  validateObject(metrics, "decoder worker metrics");
  for (const [label, value] of [
    ["pending samples", metrics.pendingSamples],
    ["submitted frames", metrics.submittedFrames],
    ["leased frames", metrics.leasedFrames],
    ["leased decoded bytes", metrics.leasedDecodedBytes]
  ] as const) {
    validateNonNegativeInteger(value, label);
  }
  if (metrics.activeGeneration !== generation) {
    throw supersededError("worker metrics generation was superseded");
  }
  if (
    metrics.resetCalls !== 0 ||
    metrics.flushCalls !== 0 ||
    metrics.boundaryFlushCalls !== 0
  ) {
    throw new RangeError("worker preparation must not reset or flush");
  }
  if (
    metrics.pendingSamples > limits.maxPendingSamples ||
    checkedSum(
      [metrics.pendingSamples, metrics.submittedFrames, metrics.leasedFrames],
      "worker outstanding preparation frames"
    ) > limits.maxOutstandingFrames ||
    metrics.leasedDecodedBytes > limits.maxDecodedBytes
  ) {
    throw new RangeError("worker preparation metrics exceed configured limits");
  }
}

export function assertQuiescent(
  worker: PreparationWorkerState,
  metrics: DecoderWorkerMetrics,
  phase: string
): void {
  validateNonNegativeInteger(worker.queuedFrames, "queued worker frames");
  validateNonNegativeInteger(worker.openFrames, "open worker frames");
  if (
    worker.queuedFrames !== 0 ||
    worker.openFrames !== 0 ||
    metrics.pendingSamples !== 0 ||
    metrics.submittedFrames !== 0 ||
    metrics.leasedFrames !== 0 ||
    metrics.leasedDecodedBytes !== 0
  ) {
    throw new RangeError(`worker must be quiescent ${phase}`);
  }
}

export function assertActiveGeneration(
  worker: Pick<PreparationWorkerState, "activeGeneration">,
  generation: number
): void {
  if (worker.activeGeneration !== generation) {
    throw supersededError("worker generation changed during preparation");
  }
}

export function createDeadlineSignal(
  source: AbortSignal | undefined,
  timeoutMs: number
): Readonly<{ readonly signal: AbortSignal; dispose(): void }> {
  const controller = new AbortController();
  const forward = (): void => controller.abort(abortReason(source));
  if (source?.aborted === true) forward();
  else source?.addEventListener("abort", forward, { once: true });
  const timer = setTimeout(() => {
    controller.abort(new InteractionCachePreparationTimeoutError(timeoutMs));
  }, timeoutMs);
  return Object.freeze({
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      source?.removeEventListener("abort", forward);
    }
  });
}

export function awaitAbortable<T>(
  promise: Promise<T>,
  signal: AbortSignal
): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => {
      signal.removeEventListener("abort", abort);
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", abort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      }
    );
  });
}

export function supersededError(message: string): DOMException {
  return new DOMException(message, "AbortError");
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw abortReason(signal);
}

export function validateLimits(limits: Readonly<DecoderWorkerLimits>): void {
  validateObject(limits, "interaction cache worker limits");
  for (const [label, value, maximum] of [
    ["decode queue", limits.maxDecodeQueueSize,
      DECODER_WORKER_HARD_LIMITS.maxDecodeQueueSize],
    ["pending samples", limits.maxPendingSamples,
      DECODER_WORKER_HARD_LIMITS.maxPendingSamples],
    ["outstanding frames", limits.maxOutstandingFrames,
      DECODER_WORKER_HARD_LIMITS.maxOutstandingFrames],
    ["decoded bytes", limits.maxDecodedBytes,
      DECODER_WORKER_HARD_LIMITS.maxDecodedBytes]
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
      throw new RangeError(
        `${label} limit must be a positive integer no greater than ${String(maximum)}`
      );
    }
  }
}

export function validateMaximumBatch(
  value: number,
  limits: Readonly<DecoderWorkerLimits>
): number {
  const maximum = Math.min(
    limits.maxPendingSamples,
    limits.maxOutstandingFrames,
    DECODER_WORKER_HARD_LIMITS.maxPendingSamples
  );
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(
      `preparation batch size must be an integer from 1 through ${String(maximum)}`
    );
  }
  return value;
}

export function validateTimeout(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError("interaction cache timeout must be finite and positive");
  }
  return value;
}

export function requirePositiveGeneration(
  value: number | null,
  label: string
): number {
  if (!Number.isSafeInteger(value) || (value ?? 0) < 1) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
  return value as number;
}

export function checkedIncrement(value: number, label: string): number {
  return checkedAdd(value, 1, label);
}

export function checkedAdd(left: number, right: number, label: string): number {
  if (
    !Number.isSafeInteger(left) ||
    !Number.isSafeInteger(right) ||
    left < 0 ||
    right < 0 ||
    left > Number.MAX_SAFE_INTEGER - right
  ) {
    throw new RangeError(`${label} exceeded the safe-integer range`);
  }
  return left + right;
}

export function checkedSum(values: readonly number[], label: string): number {
  return values.reduce(
    (total, value) => checkedAdd(total, value, label),
    0
  );
}

export function validateObject(value: unknown, label: string): void {
  if (value === null || typeof value !== "object") {
    throw new TypeError(`${label} must be an object`);
  }
}

function validateNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
}

function abortReason(signal: AbortSignal | undefined): unknown {
  return signal?.reason ?? new DOMException(
    "interaction cache preparation aborted",
    "AbortError"
  );
}
