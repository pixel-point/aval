import {
  DECODER_WORKER_HARD_LIMITS,
  type DecoderWorkerAvcProfile,
  type DecoderWorkerAvcConfig,
  type DecoderWorkerErrorCode,
  type DecoderWorkerEvent,
  type DecoderWorkerLimits,
  type DecoderWorkerOutputExpectation,
  type DecoderWorkerSample
} from "./protocol.js";

export interface DecoderWorkerClientOptions {
  readonly disposeTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
}

export interface DecoderWorkerConfigureOptions {
  readonly config: DecoderWorkerAvcConfig;
  readonly avcProfile: DecoderWorkerAvcProfile;
  readonly expectedOutput: DecoderWorkerOutputExpectation;
  readonly limits: DecoderWorkerLimits;
}

export interface DecoderWorkerWaitOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface ManagedDecoderWorkerFrame {
  readonly frame: VideoFrame;
  readonly frameId: number;
  readonly generation: number;
  readonly ordinal: number;
  readonly unitId: string;
  readonly unitInstance: number;
  readonly unitFrame: number;
  readonly timestamp: number;
  readonly duration: number;
  readonly decodedBytes: number;
  readonly closed: boolean;
  close(): void;
}

export class DecoderWorkerRemoteError extends Error {
  public readonly code: DecoderWorkerErrorCode;
  public readonly fatal: boolean;

  public constructor(
    code: DecoderWorkerErrorCode,
    message: string,
    fatal: boolean
  ) {
    super(message);
    this.name = "DecoderWorkerRemoteError";
    this.code = code;
    this.fatal = fatal;
  }
}

export class DecoderWorkerTransportError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "DecoderWorkerTransportError";
  }
}

export class DecoderWorkerGenerationAbortedError extends Error {
  public readonly generation: number;

  public constructor(generation: number) {
    super(`decoder generation ${String(generation)} was aborted or superseded`);
    this.name = "DecoderWorkerGenerationAbortedError";
    this.generation = generation;
  }
}

export class DecoderWorkerWatchdogError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "DecoderWorkerWatchdogError";
  }
}

export class ManagedDecoderWorkerFrameImpl
  implements ManagedDecoderWorkerFrame
{
  public readonly frame: VideoFrame;
  public readonly frameId: number;
  public readonly generation: number;
  public readonly ordinal: number;
  public readonly unitId: string;
  public readonly unitInstance: number;
  public readonly unitFrame: number;
  public readonly timestamp: number;
  public readonly duration: number;
  public readonly decodedBytes: number;
  readonly #release: () => void;
  #closed = false;

  public constructor(
    event: Extract<DecoderWorkerEvent, { readonly type: "frame" }>,
    release: () => void
  ) {
    this.frame = event.frame;
    this.frameId = event.frameId;
    this.generation = event.generation;
    this.ordinal = event.ordinal;
    this.unitId = event.unitId;
    this.unitInstance = event.unitInstance;
    this.unitFrame = event.unitFrame;
    this.timestamp = event.timestamp;
    this.duration = event.duration;
    this.decodedBytes = event.decodedBytes;
    this.#release = release;
  }

  public get closed(): boolean {
    return this.#closed;
  }

  public close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    try {
      this.frame.close();
    } finally {
      this.#release();
    }
  }

  public closeWithoutRelease(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.frame.close();
  }
}

export function collectUniqueSampleBuffers(
  samples: readonly DecoderWorkerSample[]
): Transferable[] {
  if (
    samples.length < 1 ||
    samples.length > DECODER_WORKER_HARD_LIMITS.maxPendingSamples
  ) {
    throw new DecoderWorkerRemoteError(
      "PROTOCOL_ERROR",
      `decode batch must contain between 1 and ${String(
        DECODER_WORKER_HARD_LIMITS.maxPendingSamples
      )} samples`,
      false
    );
  }
  const seen = new Set<ArrayBuffer>();
  const transfer: Transferable[] = [];
  for (const sample of samples) {
    if (!(sample.data instanceof ArrayBuffer)) {
      throw new DecoderWorkerRemoteError(
        "PROTOCOL_ERROR",
        "decode sample data must be an ArrayBuffer",
        false
      );
    }
    if (
      sample.data.byteLength < 1 ||
      sample.data.byteLength > DECODER_WORKER_HARD_LIMITS.maxSampleBytes
    ) {
      throw new DecoderWorkerRemoteError(
        "PROTOCOL_ERROR",
        `decode sample data exceeds the ${String(
          DECODER_WORKER_HARD_LIMITS.maxSampleBytes
        )}-byte worker cap`,
        false
      );
    }
    if (seen.has(sample.data)) {
      throw new DecoderWorkerRemoteError(
        "PROTOCOL_ERROR",
        "decode samples must own distinct ArrayBuffers",
        false
      );
    }
    seen.add(sample.data);
    transfer.push(sample.data);
  }
  return transfer;
}

export function assertSubmissionCredit(
  sampleCount: number,
  limits: DecoderWorkerLimits,
  metrics: {
    readonly pendingSamples: number;
    readonly submittedFrames: number;
    readonly leasedFrames: number;
  }
): void {
  const pendingCredit = limits.maxPendingSamples - metrics.pendingSamples;
  const outstandingCredit =
    limits.maxOutstandingFrames -
    metrics.pendingSamples -
    metrics.submittedFrames -
    metrics.leasedFrames;
  if (sampleCount > pendingCredit || sampleCount > outstandingCredit) {
    throw new DecoderWorkerRemoteError(
      "BACKPRESSURE_LIMIT",
      "decode batch exceeds available worker credit",
      false
    );
  }
}

export function validateDisposeTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 30_000) {
    throw new RangeError("disposeTimeoutMs must be an integer from 1 through 30000");
  }
  return value;
}

export function validateRequestTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 30_000) {
    throw new RangeError("requestTimeoutMs must be an integer from 1 through 30000");
  }
  return value;
}

export function validateWaitMinimum(
  minimum: number,
  limits: DecoderWorkerLimits | null
): void {
  if (!Number.isSafeInteger(minimum) || minimum < 1) {
    throw new RangeError("minimum frames must be a positive safe integer");
  }
  if (limits !== null && minimum > limits.maxOutstandingFrames) {
    throw new RangeError("minimum frames exceeds the configured worker horizon");
  }
}

export function validateWaitTimeout(value: number | undefined): void {
  if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
    throw new RangeError("wait timeout must be a finite non-negative number");
  }
}

export function abortReason(signal: AbortSignal): unknown {
  return signal.reason === undefined
    ? createAbortError("decoder frame wait was aborted")
    : signal.reason;
}

export function createAbortError(message: string): DOMException {
  return new DOMException(message, "AbortError");
}

export function normalizeTransportError(
  error: unknown,
  message: string
): Error {
  if (error instanceof Error && error.message.length > 0) {
    return new DecoderWorkerTransportError(`${message}: ${error.message}`);
  }
  return new DecoderWorkerTransportError(message);
}

export function closeFrameFromMalformedEvent(value: unknown): void {
  if (typeof value !== "object" || value === null) {
    return;
  }
  const frame = (value as { readonly frame?: unknown }).frame;
  if (
    typeof frame === "object" &&
    frame !== null &&
    "close" in frame &&
    typeof (frame as { readonly close?: unknown }).close === "function"
  ) {
    try {
      (frame as { close(): void }).close();
    } catch {
      // A malformed event is terminal regardless; cleanup is best effort.
    }
  }
}
