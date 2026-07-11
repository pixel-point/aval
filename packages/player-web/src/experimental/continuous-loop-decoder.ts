import { createEncodedLoopUnit, type EncodedLoopUnit } from "./encoded-loop.js";
import {
  durationForFrame,
  splitVirtualFrame,
  timestampForFrame
} from "./rational-time.js";

const DEFAULT_MAX_IN_FLIGHT = 16;

export interface ManagedDecodedFrame {
  /**
   * The underlying frame is borrowed until close() is called. Consumers must
   * close the managed handle, rather than closing this property directly, so
   * ownership metrics stay exact.
   */
  readonly frame: VideoFrame;
  readonly virtualFrame: bigint;
  readonly iteration: bigint;
  readonly contentFrame: number;
  readonly timestamp: number;
  readonly duration: number;
  readonly closed: boolean;
  close(): void;
}

export interface ContinuousLoopDecoderMetrics {
  readonly configureCalls: number;
  readonly resetCalls: number;
  readonly boundaryFlushCalls: number;
  readonly terminalFlushCalls: number;
  readonly submittedChunks: number;
  readonly outputFrames: number;
  readonly closedFrames: number;
  readonly openFrames: number;
  readonly queuedFrames: number;
  readonly reorderBufferedFrames: number;
  readonly inFlightFrames: number;
  readonly maxQueueDepth: number;
  readonly errors: number;
  readonly decodeQueueSize: number;
  readonly terminalFlushCompleted: boolean;
  readonly disposed: boolean;
}

/** The small WebCodecs surface used by this experiment and its unit fakes. */
export interface VideoDecoderAdapter {
  readonly decodeQueueSize: number;
  configure(config: VideoDecoderConfig): void;
  decode(chunk: EncodedVideoChunk): void;
  flush(): Promise<void>;
  close(): void;
}

export type VideoDecoderFactory = (
  init: VideoDecoderInit
) => VideoDecoderAdapter;

export type EncodedVideoChunkFactory = (
  init: EncodedVideoChunkInit
) => EncodedVideoChunk;

export interface ContinuousLoopDecoderOptions {
  readonly startVirtualFrame?: number | bigint;
  readonly maxInFlight?: number;
  readonly decoderFactory?: VideoDecoderFactory;
  readonly chunkFactory?: EncodedVideoChunkFactory;
}

export interface WaitForFramesOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

interface SubmittedFrame {
  readonly virtualFrame: bigint;
  readonly iteration: bigint;
  readonly contentFrame: number;
  readonly timestamp: number;
  readonly duration: number;
}

interface FrameWaiter {
  readonly minimum: number;
  readonly resolve: () => void;
  readonly reject: (reason: unknown) => void;
  readonly signal: AbortSignal | null;
  readonly abortListener: (() => void) | null;
  timeout: ReturnType<typeof setTimeout> | null;
}

interface MutableMetrics {
  configureCalls: number;
  resetCalls: number;
  boundaryFlushCalls: number;
  terminalFlushCalls: number;
  submittedChunks: number;
  outputFrames: number;
  closedFrames: number;
  openFrames: number;
  maxQueueDepth: number;
  errors: number;
}

/** Raised when no more decoder output can satisfy a frame waiter. */
export class DecoderEndOfStreamError extends Error {
  public constructor(message = "the decoder reached end of stream") {
    super(message);
    this.name = "DecoderEndOfStreamError";
  }
}

/** Raised when an operation is attempted after dispose(). */
export class DecoderDisposedError extends Error {
  public constructor(message = "the continuous loop decoder is disposed") {
    super(message);
    this.name = "DecoderDisposedError";
  }
}

/** Raised when waitForFrames() observes no progress before its deadline. */
export class DecoderWatchdogError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "DecoderWatchdogError";
  }
}

/**
 * Replays one independently decodable encoded unit on an unbounded timestamp
 * line. The decoder is configured exactly once. Unit boundaries only select
 * frame zero again: they never configure, reset, seek, or flush the decoder.
 *
 * Decoded frames remain owned by this object until takeFrame() transfers a
 * managed handle to the caller. Taking a frame releases one input-horizon slot;
 * closing it releases the underlying VideoFrame and updates ownership metrics.
 */
export class ContinuousLoopDecoder {
  readonly #unit: EncodedLoopUnit;
  readonly #decoder: VideoDecoderAdapter;
  readonly #chunkFactory: EncodedVideoChunkFactory;
  readonly #maxInFlight: number;
  readonly #metadataByTimestamp = new Map<number, SubmittedFrame>();
  readonly #reorderBuffer = new Map<bigint, ManagedDecodedFrameImpl>();
  readonly #readyQueue: ManagedDecodedFrameImpl[] = [];
  readonly #openFrames = new Set<ManagedDecodedFrameImpl>();
  readonly #waiters = new Set<FrameWaiter>();
  readonly #metrics: MutableMetrics = {
    configureCalls: 0,
    resetCalls: 0,
    boundaryFlushCalls: 0,
    terminalFlushCalls: 0,
    submittedChunks: 0,
    outputFrames: 0,
    closedFrames: 0,
    openFrames: 0,
    maxQueueDepth: 0,
    errors: 0
  };

  #nextVirtualFrame: bigint;
  #nextFrameToQueue: bigint;
  #inFlightFrames = 0;
  #fatalError: Error | null = null;
  #terminalFlushPromise: Promise<void> | null = null;
  #terminalFlushCompleted = false;
  #disposed = false;
  #decoderClosed = false;

  public constructor(
    unit: EncodedLoopUnit,
    options: ContinuousLoopDecoderOptions = {}
  ) {
    this.#unit = createEncodedLoopUnit(unit);
    this.#maxInFlight = validateMaxInFlight(
      options.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT
    );
    this.#nextVirtualFrame = normalizeVirtualFrame(
      options.startVirtualFrame ?? 0n,
      "start virtual frame"
    );
    this.#nextFrameToQueue = this.#nextVirtualFrame;
    this.#chunkFactory = options.chunkFactory ?? defaultChunkFactory;

    const decoderFactory = options.decoderFactory ?? defaultDecoderFactory;
    this.#decoder = decoderFactory({
      output: (frame) => {
        this.#handleOutput(frame);
      },
      error: (error) => {
        this.#fail(normalizeError(error, "video decoder error"));
      }
    });

    this.#metrics.configureCalls += 1;
    try {
      this.#decoder.configure(this.#unit.config);
    } catch (error) {
      this.#metrics.errors += 1;
      this.#closeDecoder();
      throw normalizeError(error, "failed to configure the video decoder");
    }
  }

  public get unit(): EncodedLoopUnit {
    return this.#unit;
  }

  public get maxInFlight(): number {
    return this.#maxInFlight;
  }

  public get nextVirtualFrame(): bigint {
    return this.#nextVirtualFrame;
  }

  /**
   * Synchronously submits chunks until the input horizon reaches target.
   * stopBeforeVirtualFrame is exclusive and is useful for finite stress runs.
   */
  public fillToAhead(
    target = this.#maxInFlight,
    stopBeforeVirtualFrame?: number | bigint
  ): number {
    this.#assertCanSubmit();
    validateAheadTarget(target, this.#maxInFlight);

    const stopBefore =
      stopBeforeVirtualFrame === undefined
        ? null
        : normalizeVirtualFrame(
            stopBeforeVirtualFrame,
            "stop-before virtual frame"
          );
    let submitted = 0;

    while (
      this.#inFlightFrames < target &&
      (stopBefore === null || this.#nextVirtualFrame < stopBefore)
    ) {
      this.#submitNextFrame();
      submitted += 1;
    }

    return submitted;
  }

  /** Returns the next chronological decoded frame, or undefined if none waits. */
  public takeFrame(): ManagedDecodedFrame | undefined {
    this.#throwIfFailedOrDisposed();

    const frame = this.#readyQueue.shift();
    if (frame === undefined) {
      return undefined;
    }

    if (this.#inFlightFrames <= 0) {
      frame.close();
      this.#fail(
        new Error("decoder input-horizon accounting became inconsistent")
      );
      this.#throwIfFailedOrDisposed();
      return undefined;
    }

    this.#inFlightFrames -= 1;
    this.#settleWaiters();
    return frame;
  }

  /**
   * Waits until at least minimum chronological frames can be taken. A timeout
   * is a no-progress watchdog only; it does not reset or flush the decoder.
   */
  public waitForFrames(
    minimum = 1,
    options: WaitForFramesOptions = {}
  ): Promise<void> {
    validateWaitMinimum(minimum, this.#maxInFlight);
    validateTimeout(options.timeoutMs);

    try {
      this.#throwIfFailedOrDisposed();
    } catch (error) {
      return Promise.reject(error);
    }

    if (this.#readyQueue.length >= minimum) {
      return Promise.resolve();
    }
    if (options.signal?.aborted === true) {
      return Promise.reject(abortReason(options.signal));
    }
    if (this.#cannotProduceMoreFrames()) {
      return Promise.reject(new DecoderEndOfStreamError());
    }

    return new Promise<void>((resolve, reject) => {
      const signal = options.signal ?? null;
      let waiter: FrameWaiter;
      const abortListener =
        signal === null
          ? null
          : () => {
              this.#finishWaiter(waiter, () => {
                reject(abortReason(signal));
              });
            };
      waiter = {
        minimum,
        resolve,
        reject,
        signal,
        abortListener,
        timeout: null
      };

      if (options.timeoutMs !== undefined) {
        waiter.timeout = setTimeout(() => {
          this.#finishWaiter(waiter, () => {
            reject(
              new DecoderWatchdogError(
                `no decoded-frame progress for ${String(options.timeoutMs)} ms`
              )
            );
          });
        }, options.timeoutMs);
      }
      if (signal !== null && abortListener !== null) {
        signal.addEventListener("abort", abortListener, { once: true });
      }
      this.#waiters.add(waiter);
      this.#settleWaiters();
    });
  }

  /**
   * Flushes once after the caller has submitted its final chunk. This is a
   * terminal drain, never a loop-boundary operation. Repeated calls share the
   * same promise and do not increment the counter.
   */
  public terminalFlush(): Promise<void> {
    if (this.#terminalFlushPromise !== null) {
      return this.#terminalFlushPromise;
    }

    try {
      this.#throwIfFailedOrDisposed();
    } catch (error) {
      return Promise.reject(error);
    }

    this.#metrics.terminalFlushCalls += 1;
    this.#terminalFlushPromise = Promise.resolve()
      .then(async () => {
        await this.#decoder.flush();
        if (this.#metadataByTimestamp.size !== 0) {
          throw new Error(
            `terminal decoder flush omitted ${String(
              this.#metadataByTimestamp.size
            )} submitted frame(s)`
          );
        }
        if (this.#reorderBuffer.size !== 0) {
          throw new Error(
            "terminal decoder flush left a non-consecutive output sequence"
          );
        }
        this.#terminalFlushCompleted = true;
        this.#settleWaiters();
      })
      .catch((error: unknown) => {
        const normalized = normalizeError(error, "terminal decoder flush failed");
        this.#fail(normalized);
        throw normalized;
      });

    return this.#terminalFlushPromise;
  }

  public snapshotMetrics(): ContinuousLoopDecoderMetrics {
    return Object.freeze({
      configureCalls: this.#metrics.configureCalls,
      resetCalls: this.#metrics.resetCalls,
      boundaryFlushCalls: this.#metrics.boundaryFlushCalls,
      terminalFlushCalls: this.#metrics.terminalFlushCalls,
      submittedChunks: this.#metrics.submittedChunks,
      outputFrames: this.#metrics.outputFrames,
      closedFrames: this.#metrics.closedFrames,
      openFrames: this.#metrics.openFrames,
      queuedFrames: this.#readyQueue.length,
      reorderBufferedFrames: this.#reorderBuffer.size,
      inFlightFrames: this.#inFlightFrames,
      maxQueueDepth: this.#metrics.maxQueueDepth,
      errors: this.#metrics.errors,
      decodeQueueSize: this.#readDecodeQueueSize(),
      terminalFlushCompleted: this.#terminalFlushCompleted,
      disposed: this.#disposed
    });
  }

  /** Closes all owned frames and the decoder. It deliberately never flushes. */
  public dispose(): void {
    if (this.#disposed) {
      return;
    }

    this.#disposed = true;
    this.#rejectAllWaiters(new DecoderDisposedError());
    this.#metadataByTimestamp.clear();
    this.#reorderBuffer.clear();
    this.#readyQueue.length = 0;

    for (const frame of [...this.#openFrames]) {
      frame.close();
    }

    this.#closeDecoder();
  }

  #submitNextFrame(): void {
    const virtualFrame = this.#nextVirtualFrame;
    const position = splitVirtualFrame(
      virtualFrame,
      this.#unit.frames.length
    );
    const source = this.#unit.frames[position.contentFrame];
    if (source === undefined) {
      throw new Error("encoded loop content-frame lookup failed");
    }

    const timestamp = timestampForFrame(virtualFrame, this.#unit.frameRate);
    const duration = durationForFrame(virtualFrame, this.#unit.frameRate);
    if (this.#metadataByTimestamp.has(timestamp)) {
      throw new Error(`duplicate global decoder timestamp ${String(timestamp)}`);
    }

    const submitted: SubmittedFrame = {
      virtualFrame,
      iteration: position.iteration,
      contentFrame: position.contentFrame,
      timestamp,
      duration
    };
    const chunk = this.#chunkFactory({
      type: source.type,
      timestamp,
      duration,
      data: source.data
    });

    this.#metadataByTimestamp.set(timestamp, submitted);
    this.#nextVirtualFrame += 1n;
    this.#inFlightFrames += 1;
    this.#metrics.submittedChunks += 1;

    try {
      this.#decoder.decode(chunk);
    } catch (error) {
      this.#metadataByTimestamp.delete(timestamp);
      this.#nextVirtualFrame -= 1n;
      this.#inFlightFrames -= 1;
      this.#metrics.submittedChunks -= 1;
      const normalized = normalizeError(error, "video decoder rejected a chunk");
      this.#fail(normalized);
      throw normalized;
    }
  }

  #handleOutput(frame: VideoFrame): void {
    this.#metrics.outputFrames += 1;
    this.#metrics.openFrames += 1;

    if (this.#fatalError !== null || this.#disposed) {
      this.#closeUnmanagedFrame(frame);
      return;
    }

    const submitted = this.#metadataByTimestamp.get(frame.timestamp);
    if (submitted === undefined) {
      this.#closeUnmanagedFrame(frame);
      this.#fail(
        new Error(
          `decoder produced an unrecognized timestamp ${String(frame.timestamp)}`
        )
      );
      return;
    }

    if (!this.#hasExpectedDimensions(frame)) {
      const geometry = this.#describeOutputGeometry(frame);
      this.#metadataByTimestamp.delete(frame.timestamp);
      this.#closeUnmanagedFrame(frame);
      this.#fail(
        new Error(
          `decoder output geometry ${geometry} does not match the encoded loop unit`
        )
      );
      return;
    }

    this.#metadataByTimestamp.delete(frame.timestamp);
    if (this.#reorderBuffer.has(submitted.virtualFrame)) {
      this.#closeUnmanagedFrame(frame);
      this.#fail(
        new Error(
          `decoder produced virtual frame ${String(
            submitted.virtualFrame
          )} more than once`
        )
      );
      return;
    }

    const managed = new ManagedDecodedFrameImpl(frame, submitted, () => {
      if (!this.#openFrames.delete(managed)) {
        return;
      }
      this.#metrics.openFrames -= 1;
      this.#metrics.closedFrames += 1;
    });
    this.#openFrames.add(managed);
    this.#reorderBuffer.set(submitted.virtualFrame, managed);
    this.#updateMaxQueueDepth();
    this.#drainReorderBuffer();
  }

  #drainReorderBuffer(): void {
    for (;;) {
      const frame = this.#reorderBuffer.get(this.#nextFrameToQueue);
      if (frame === undefined) {
        break;
      }

      this.#reorderBuffer.delete(this.#nextFrameToQueue);
      this.#readyQueue.push(frame);
      this.#nextFrameToQueue += 1n;
    }

    this.#updateMaxQueueDepth();
    this.#settleWaiters();
  }

  #hasExpectedDimensions(frame: VideoFrame): boolean {
    const visible = frame.visibleRect;
    const maximumCodedWidth =
      Math.ceil(this.#unit.codedWidth / 16) * 16 + 16;
    const maximumCodedHeight =
      Math.ceil(this.#unit.codedHeight / 16) * 16 + 16;

    return (
      visible !== null &&
      frame.displayWidth === this.#unit.displayWidth &&
      frame.displayHeight === this.#unit.displayHeight &&
      visible.width === this.#unit.displayWidth &&
      visible.height === this.#unit.displayHeight &&
      visible.x >= 0 &&
      visible.y >= 0 &&
      frame.codedWidth >= visible.x + visible.width &&
      frame.codedHeight >= visible.y + visible.height &&
      frame.codedWidth <= maximumCodedWidth &&
      frame.codedHeight <= maximumCodedHeight
    );
  }

  #describeOutputGeometry(frame: VideoFrame): string {
    const visible = frame.visibleRect;
    if (visible === null) {
      return `${String(frame.codedWidth)}x${String(
        frame.codedHeight
      )} (display ${String(frame.displayWidth)}x${String(
        frame.displayHeight
      )}, no visible rectangle)`;
    }
    return `${String(frame.codedWidth)}x${String(
      frame.codedHeight
    )} (display ${String(frame.displayWidth)}x${String(
      frame.displayHeight
    )}, visible ${String(visible.x)},${String(visible.y)} ${String(
      visible.width
    )}x${String(visible.height)})`;
  }

  #updateMaxQueueDepth(): void {
    this.#metrics.maxQueueDepth = Math.max(
      this.#metrics.maxQueueDepth,
      this.#readyQueue.length + this.#reorderBuffer.size
    );
  }

  #closeUnmanagedFrame(frame: VideoFrame): void {
    try {
      frame.close();
    } finally {
      this.#metrics.openFrames -= 1;
      this.#metrics.closedFrames += 1;
    }
  }

  #settleWaiters(): void {
    for (const waiter of [...this.#waiters]) {
      if (this.#readyQueue.length >= waiter.minimum) {
        this.#finishWaiter(waiter, waiter.resolve);
        continue;
      }

      if (this.#fatalError !== null) {
        this.#finishWaiter(waiter, () => {
          waiter.reject(this.#fatalError);
        });
        continue;
      }
      if (this.#disposed) {
        this.#finishWaiter(waiter, () => {
          waiter.reject(new DecoderDisposedError());
        });
        continue;
      }
      if (this.#cannotProduceMoreFrames()) {
        this.#finishWaiter(waiter, () => {
          waiter.reject(new DecoderEndOfStreamError());
        });
      }
    }
  }

  #finishWaiter(waiter: FrameWaiter, finish: () => void): void {
    if (!this.#waiters.delete(waiter)) {
      return;
    }
    if (waiter.timeout !== null) {
      clearTimeout(waiter.timeout);
      waiter.timeout = null;
    }
    if (waiter.signal !== null && waiter.abortListener !== null) {
      waiter.signal.removeEventListener("abort", waiter.abortListener);
    }
    finish();
  }

  #rejectAllWaiters(reason: unknown): void {
    for (const waiter of [...this.#waiters]) {
      this.#finishWaiter(waiter, () => {
        waiter.reject(reason);
      });
    }
  }

  #cannotProduceMoreFrames(): boolean {
    return (
      this.#terminalFlushCompleted &&
      this.#metadataByTimestamp.size === 0 &&
      this.#reorderBuffer.size === 0
    );
  }

  #assertCanSubmit(): void {
    this.#throwIfFailedOrDisposed();
    if (this.#terminalFlushPromise !== null) {
      throw new DecoderEndOfStreamError(
        "cannot submit chunks after terminal flush begins"
      );
    }
  }

  #throwIfFailedOrDisposed(): void {
    if (this.#fatalError !== null) {
      throw this.#fatalError;
    }
    if (this.#disposed) {
      throw new DecoderDisposedError();
    }
  }

  #fail(error: Error): void {
    if (this.#fatalError !== null || this.#disposed) {
      return;
    }
    this.#fatalError = error;
    this.#metrics.errors += 1;
    this.#rejectAllWaiters(error);
    this.#metadataByTimestamp.clear();
    this.#reorderBuffer.clear();
    this.#readyQueue.length = 0;
    this.#inFlightFrames = 0;
    for (const frame of [...this.#openFrames]) {
      frame.close();
    }
    this.#closeDecoder();
  }

  #readDecodeQueueSize(): number {
    if (this.#decoderClosed) {
      return 0;
    }
    try {
      return this.#decoder.decodeQueueSize;
    } catch {
      return 0;
    }
  }

  #closeDecoder(): void {
    if (this.#decoderClosed) {
      return;
    }
    this.#decoderClosed = true;
    try {
      this.#decoder.close();
    } catch {
      // close() is best-effort during cleanup; all frames are still reclaimed.
    }
  }
}

class ManagedDecodedFrameImpl implements ManagedDecodedFrame {
  readonly #onClose: () => void;
  #closed = false;

  public constructor(
    public readonly frame: VideoFrame,
    submitted: SubmittedFrame,
    onClose: () => void
  ) {
    this.virtualFrame = submitted.virtualFrame;
    this.iteration = submitted.iteration;
    this.contentFrame = submitted.contentFrame;
    this.timestamp = submitted.timestamp;
    this.duration = submitted.duration;
    this.#onClose = onClose;
  }

  public readonly virtualFrame: bigint;
  public readonly iteration: bigint;
  public readonly contentFrame: number;
  public readonly timestamp: number;
  public readonly duration: number;

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
      this.#onClose();
    }
  }
}

function defaultDecoderFactory(init: VideoDecoderInit): VideoDecoderAdapter {
  if (typeof VideoDecoder === "undefined") {
    throw new TypeError("VideoDecoder is unavailable in this environment");
  }
  return new VideoDecoder(init);
}

function defaultChunkFactory(init: EncodedVideoChunkInit): EncodedVideoChunk {
  if (typeof EncodedVideoChunk === "undefined") {
    throw new TypeError(
      "EncodedVideoChunk is unavailable in this environment"
    );
  }
  return new EncodedVideoChunk(init);
}

function validateMaxInFlight(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 256) {
    throw new RangeError("maxInFlight must be an integer from 1 through 256");
  }
  return value;
}

function validateAheadTarget(target: number, maximum: number): void {
  if (!Number.isSafeInteger(target) || target < 0 || target > maximum) {
    throw new RangeError(
      `ahead target must be an integer from 0 through ${String(maximum)}`
    );
  }
}

function validateWaitMinimum(minimum: number, maximum: number): void {
  if (!Number.isSafeInteger(minimum) || minimum <= 0 || minimum > maximum) {
    throw new RangeError(
      `minimum frame count must be an integer from 1 through ${String(maximum)}`
    );
  }
}

function validateTimeout(timeoutMs: number | undefined): void {
  if (
    timeoutMs !== undefined &&
    (!Number.isFinite(timeoutMs) || timeoutMs < 0)
  ) {
    throw new RangeError("timeoutMs must be a finite non-negative number");
  }
}

function normalizeVirtualFrame(
  value: number | bigint,
  label: string
): bigint {
  if (typeof value === "bigint") {
    if (value < 0n) {
      throw new RangeError(`${label} must be non-negative`);
    }
    return value;
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(
      `${label} must be a non-negative safe integer or bigint`
    );
  }
  return BigInt(value);
}

function normalizeError(error: unknown, context: string): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error(context, { cause: error });
}

function abortReason(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) {
    return signal.reason;
  }
  return new DOMException("the frame wait was aborted", "AbortError");
}
