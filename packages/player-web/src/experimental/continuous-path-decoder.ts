import {
  type EncodedVideoChunkFactory,
  type VideoDecoderAdapter,
  type VideoDecoderFactory
} from "./continuous-loop-decoder.js";
import {
  createEncodedLoopUnit,
  type EncodedLoopUnit
} from "./encoded-loop.js";
import {
  durationForFrame,
  timestampForFrame,
  type RationalFrameRate
} from "./rational-time.js";

const DEFAULT_MAX_IN_FLIGHT = 16;

export type PathFramePurpose = "cached-runway" | "continuation";

export interface ContinuousPathUnit {
  readonly id: string;
  readonly unit: EncodedLoopUnit;
}

export interface StartPathOptions {
  /**
   * Decoder outputs in [0, cachedRunwayFrames) duplicate resident runway
   * layers. They are validated and closed without entering the ready queue.
   */
  readonly cachedRunwayFrames?: number;
  /** Desired submitted/output horizon after the route change. */
  readonly aheadFrames?: number;
}

export interface WaitForPathFramesOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface ManagedPathFrame {
  /**
   * Borrowed until close() is called. Consumers close the managed handle so
   * decoder ownership metrics remain exact.
   */
  readonly frame: VideoFrame;
  readonly decodeOrdinal: bigint;
  readonly pathGeneration: number;
  readonly unitId: string;
  readonly pathFrame: bigint;
  readonly contentFrame: number;
  readonly purpose: "continuation";
  readonly timestamp: number;
  readonly duration: number;
  readonly closed: boolean;
  close(): void;
}

export interface ContinuousPathDecoderMetrics {
  readonly configureCalls: number;
  readonly resetCalls: number;
  readonly flushCalls: number;
  readonly boundaryFlushCalls: number;
  readonly pathStarts: number;
  readonly submittedChunks: number;
  readonly outputFrames: number;
  readonly continuationOutputFrames: number;
  readonly cachedRunwayOutputs: number;
  readonly staleOutputs: number;
  readonly closedFrames: number;
  readonly openFrames: number;
  readonly queuedFrames: number;
  readonly reorderBufferedFrames: number;
  readonly inFlightFrames: number;
  readonly maxInFlightFrames: number;
  readonly maxQueueDepth: number;
  readonly errors: number;
  readonly decodeQueueSize: number;
  readonly activeGeneration: number | null;
  readonly activeUnitId: string | null;
  readonly nextDecodeOrdinal: bigint;
  readonly disposed: boolean;
}

export interface ContinuousPathDecoderOptions {
  readonly maxInFlight?: number;
  readonly decoderFactory?: VideoDecoderFactory;
  readonly chunkFactory?: EncodedVideoChunkFactory;
}

interface RegisteredPathUnit {
  readonly id: string;
  readonly unit: EncodedLoopUnit;
}

interface ActivePath {
  readonly generation: number;
  readonly registered: RegisteredPathUnit;
  readonly cachedRunwayFrames: bigint;
  nextPathFrame: bigint;
}

interface SubmittedPathFrame {
  readonly decodeOrdinal: bigint;
  readonly pathGeneration: number;
  readonly unitId: string;
  readonly pathFrame: bigint;
  readonly contentFrame: number;
  readonly purpose: PathFramePurpose;
  readonly timestamp: number;
  readonly duration: number;
}

interface FrameWaiter {
  readonly generation: number;
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
  flushCalls: number;
  boundaryFlushCalls: number;
  pathStarts: number;
  submittedChunks: number;
  outputFrames: number;
  continuationOutputFrames: number;
  cachedRunwayOutputs: number;
  staleOutputs: number;
  closedFrames: number;
  openFrames: number;
  maxInFlightFrames: number;
  maxQueueDepth: number;
  errors: number;
}

export class PathDecoderDisposedError extends Error {
  public constructor(message = "the continuous path decoder is disposed") {
    super(message);
    this.name = "PathDecoderDisposedError";
  }
}

export class PathDecoderNotStartedError extends Error {
  public constructor(message = "no decoder path has been started") {
    super(message);
    this.name = "PathDecoderNotStartedError";
  }
}

export class PathDecoderSupersededError extends Error {
  public readonly pathGeneration: number;

  public constructor(pathGeneration: number) {
    super(`decoder path generation ${String(pathGeneration)} was superseded`);
    this.name = "PathDecoderSupersededError";
    this.pathGeneration = pathGeneration;
  }
}

export class PathDecoderWatchdogError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "PathDecoderWatchdogError";
  }
}

/**
 * Runs compatible, independently decodable body units through one configured
 * VideoDecoder. Decoder timestamps use one monotonic ordinal and therefore do
 * not restart when the selected unit or path generation changes.
 *
 * A path switch never resets, reconfigures, or flushes the decoder. Already
 * submitted obsolete work remains bounded by maxInFlight and is closed when it
 * appears. Outputs covered by the resident endpoint runway are likewise closed
 * internally; only continuation frames transfer to the consumer.
 */
export class ContinuousPathDecoder {
  readonly #units: ReadonlyMap<string, RegisteredPathUnit>;
  readonly #frameRate: Readonly<RationalFrameRate>;
  readonly #decoder: VideoDecoderAdapter;
  readonly #chunkFactory: EncodedVideoChunkFactory;
  readonly #maxInFlight: number;
  readonly #metadataByTimestamp = new Map<number, SubmittedPathFrame>();
  readonly #reorderBuffer = new Map<bigint, ManagedPathFrameImpl>();
  readonly #settledOrdinals = new Set<bigint>();
  readonly #readyQueue: ManagedPathFrameImpl[] = [];
  readonly #openFrames = new Set<ManagedPathFrameImpl>();
  readonly #decoderOwnedFrames = new Set<ManagedPathFrameImpl>();
  readonly #waiters = new Set<FrameWaiter>();
  readonly #metrics: MutableMetrics = {
    configureCalls: 0,
    resetCalls: 0,
    flushCalls: 0,
    boundaryFlushCalls: 0,
    pathStarts: 0,
    submittedChunks: 0,
    outputFrames: 0,
    continuationOutputFrames: 0,
    cachedRunwayOutputs: 0,
    staleOutputs: 0,
    closedFrames: 0,
    openFrames: 0,
    maxInFlightFrames: 0,
    maxQueueDepth: 0,
    errors: 0
  };

  #activePath: ActivePath | null = null;
  #activeGeneration: number | null = null;
  #nextDecodeOrdinal = 0n;
  #nextOutputOrdinal = 0n;
  #desiredAhead = 0;
  #inFlightFrames = 0;
  #fatalError: Error | null = null;
  #disposed = false;
  #decoderClosed = false;

  public constructor(
    units: readonly ContinuousPathUnit[],
    options: ContinuousPathDecoderOptions = {}
  ) {
    const registered = registerCompatibleUnits(units);
    this.#units = registered.units;
    this.#frameRate = registered.frameRate;
    this.#maxInFlight = validateMaxInFlight(
      options.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT
    );
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
      this.#decoder.configure(registered.decoderConfig);
      if (this.#fatalError !== null) {
        throw this.#fatalError;
      }
    } catch (error) {
      if (this.#fatalError === null) {
        this.#metrics.errors += 1;
      }
      this.#closeDecoder();
      throw normalizeError(error, "failed to configure the video decoder");
    }
  }

  public get maxInFlight(): number {
    return this.#maxInFlight;
  }

  public get activeGeneration(): number | null {
    return this.#activeGeneration;
  }

  /**
   * Selects a new body path and immediately tries to build its bounded horizon.
   * The returned monotonically increasing generation identifies its outputs.
   */
  public startPath(
    unitId: string,
    options: StartPathOptions = {}
  ): number {
    this.#throwIfFailedOrDisposed();
    const registered = this.#units.get(unitId);
    if (registered === undefined) {
      throw new RangeError(`unknown decoder path unit ${JSON.stringify(unitId)}`);
    }

    const cachedRunwayFrames = validateCachedRunwayFrames(
      options.cachedRunwayFrames ?? 0
    );
    const aheadFrames = validateAheadTarget(
      options.aheadFrames ?? this.#maxInFlight,
      this.#maxInFlight
    );
    const generation = nextGeneration(this.#activeGeneration);

    this.#rejectSupersededWaiters(generation);
    this.#activeGeneration = generation;
    this.#activePath = {
      generation,
      registered,
      cachedRunwayFrames: BigInt(cachedRunwayFrames),
      nextPathFrame: 0n
    };
    this.#desiredAhead = aheadFrames;
    this.#metrics.pathStarts += 1;

    this.#discardDecoderOwnedFramesFromOlderPaths(generation);
    this.#throwIfFailedOrDisposed();
    this.#drainReorderBuffer();
    this.#fillToDesiredAhead();
    this.#settleWaiters();

    return generation;
  }

  /** Changes the persistent input/output high-water for the active path. */
  public fillToAhead(target = this.#maxInFlight): number {
    this.#throwIfFailedOrDisposed();
    this.#assertPathStarted();
    this.#desiredAhead = validateAheadTarget(target, this.#maxInFlight);
    return this.#fillToDesiredAhead();
  }

  /** Returns the next continuation frame for the current path generation. */
  public takeFrame(): ManagedPathFrame | undefined {
    this.#throwIfFailedOrDisposed();
    this.#assertPathStarted();

    const frame = this.#readyQueue.shift();
    if (frame === undefined) {
      return undefined;
    }
    if (frame.pathGeneration !== this.#activeGeneration) {
      frame.close();
      this.#fail(new Error("a stale path frame entered the ready queue"));
      this.#throwIfFailedOrDisposed();
      return undefined;
    }

    if (!this.#releaseHorizonSlot()) {
      this.#throwIfFailedOrDisposed();
    }
    this.#fillToDesiredAhead();
    this.#settleWaiters();
    this.#throwIfFailedOrDisposed();
    if (!this.#decoderOwnedFrames.delete(frame)) {
      const error = new Error(
        "decoder frame ownership was lost before consumer transfer"
      );
      this.#fail(error);
      throw error;
    }
    return frame;
  }

  /**
   * Waits for continuation frames from the generation active at call time.
   * A route change rejects rather than silently satisfying an old waiter with
   * frames from the new route.
   */
  public waitForFrames(
    minimum = 1,
    options: WaitForPathFramesOptions = {}
  ): Promise<void> {
    validateWaitMinimum(minimum, this.#maxInFlight);
    validateTimeout(options.timeoutMs);

    try {
      this.#throwIfFailedOrDisposed();
      this.#assertPathStarted();
    } catch (error) {
      return Promise.reject(error);
    }

    const generation = this.#activeGeneration;
    if (generation === null) {
      return Promise.reject(new PathDecoderNotStartedError());
    }
    if (this.#readyQueue.length >= minimum) {
      return Promise.resolve();
    }
    if (options.signal?.aborted === true) {
      return Promise.reject(abortReason(options.signal));
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
        generation,
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
              new PathDecoderWatchdogError(
                `no continuation-frame progress for ${String(
                  options.timeoutMs
                )} ms in path generation ${String(generation)}`
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

  public snapshotMetrics(): ContinuousPathDecoderMetrics {
    return Object.freeze({
      configureCalls: this.#metrics.configureCalls,
      resetCalls: this.#metrics.resetCalls,
      flushCalls: this.#metrics.flushCalls,
      boundaryFlushCalls: this.#metrics.boundaryFlushCalls,
      pathStarts: this.#metrics.pathStarts,
      submittedChunks: this.#metrics.submittedChunks,
      outputFrames: this.#metrics.outputFrames,
      continuationOutputFrames: this.#metrics.continuationOutputFrames,
      cachedRunwayOutputs: this.#metrics.cachedRunwayOutputs,
      staleOutputs: this.#metrics.staleOutputs,
      closedFrames: this.#metrics.closedFrames,
      openFrames: this.#metrics.openFrames,
      queuedFrames: this.#readyQueue.length,
      reorderBufferedFrames: this.#reorderBuffer.size,
      inFlightFrames: this.#inFlightFrames,
      maxInFlightFrames: this.#metrics.maxInFlightFrames,
      maxQueueDepth: this.#metrics.maxQueueDepth,
      errors: this.#metrics.errors,
      decodeQueueSize: this.#readDecodeQueueSize(),
      activeGeneration: this.#activeGeneration,
      activeUnitId: this.#activePath?.registered.id ?? null,
      nextDecodeOrdinal: this.#nextDecodeOrdinal,
      disposed: this.#disposed
    });
  }

  /**
   * Closes every decoder-owned frame and the sole decoder without flushing it.
   * Frames returned by takeFrame() remain consumer-owned until their managed
   * handles are closed.
   */
  public dispose(): void {
    if (this.#disposed) {
      return;
    }

    this.#disposed = true;
    this.#rejectAllWaiters(new PathDecoderDisposedError());
    this.#metadataByTimestamp.clear();
    this.#settledOrdinals.clear();
    this.#reorderBuffer.clear();
    this.#readyQueue.length = 0;
    this.#activePath = null;
    this.#desiredAhead = 0;
    this.#inFlightFrames = 0;

    for (const frame of [...this.#decoderOwnedFrames]) {
      frame.close();
    }
    this.#closeDecoder();
  }

  #fillToDesiredAhead(): number {
    if (this.#activePath === null || this.#fatalError !== null || this.#disposed) {
      return 0;
    }

    let submitted = 0;
    while (this.#inFlightFrames < this.#desiredAhead) {
      this.#submitNextFrame(this.#activePath);
      submitted += 1;
    }
    return submitted;
  }

  #submitNextFrame(path: ActivePath): void {
    const { unit } = path.registered;
    const pathFrame = path.nextPathFrame;
    const contentFrame = Number(pathFrame % BigInt(unit.frames.length));
    const source = unit.frames[contentFrame];
    if (source === undefined) {
      const error = new Error("encoded path content-frame lookup failed");
      this.#fail(error);
      throw error;
    }

    const decodeOrdinal = this.#nextDecodeOrdinal;
    let timestamp: number;
    let duration: number;
    let chunk: EncodedVideoChunk;
    try {
      timestamp = timestampForFrame(decodeOrdinal, this.#frameRate);
      duration = durationForFrame(decodeOrdinal, this.#frameRate);
      chunk = this.#chunkFactory({
        type: source.type,
        timestamp,
        duration,
        data: source.data
      });
    } catch (error) {
      const normalized = normalizeError(error, "failed to create an encoded path chunk");
      this.#fail(normalized);
      throw normalized;
    }

    if (this.#metadataByTimestamp.has(timestamp)) {
      const error = new Error(`duplicate global decoder timestamp ${String(timestamp)}`);
      this.#fail(error);
      throw error;
    }

    const submitted: SubmittedPathFrame = {
      decodeOrdinal,
      pathGeneration: path.generation,
      unitId: path.registered.id,
      pathFrame,
      contentFrame,
      purpose:
        pathFrame < path.cachedRunwayFrames
          ? "cached-runway"
          : "continuation",
      timestamp,
      duration
    };

    this.#metadataByTimestamp.set(timestamp, submitted);
    path.nextPathFrame += 1n;
    this.#nextDecodeOrdinal += 1n;
    this.#inFlightFrames += 1;
    this.#metrics.submittedChunks += 1;
    this.#metrics.maxInFlightFrames = Math.max(
      this.#metrics.maxInFlightFrames,
      this.#inFlightFrames
    );

    try {
      this.#decoder.decode(chunk);
    } catch (error) {
      this.#metadataByTimestamp.delete(timestamp);
      path.nextPathFrame -= 1n;
      this.#nextDecodeOrdinal -= 1n;
      this.#inFlightFrames -= 1;
      this.#metrics.submittedChunks -= 1;
      const normalized = normalizeError(error, "video decoder rejected a path chunk");
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

    const registered = this.#units.get(submitted.unitId);
    if (registered === undefined || !hasExpectedDimensions(frame, registered.unit)) {
      this.#metadataByTimestamp.delete(frame.timestamp);
      this.#closeUnmanagedFrame(frame);
      this.#fail(
        new Error(
          `decoder output geometry ${describeOutputGeometry(
            frame
          )} does not match path unit ${JSON.stringify(submitted.unitId)}`
        )
      );
      return;
    }

    this.#metadataByTimestamp.delete(frame.timestamp);
    if (submitted.pathGeneration !== this.#activeGeneration) {
      this.#metrics.staleOutputs += 1;
      this.#closeUnmanagedFrame(frame);
      if (
        !this.#settleOrdinalWithoutQueue(submitted.decodeOrdinal) ||
        !this.#releaseHorizonSlot()
      ) {
        return;
      }
      this.#afterOutputProgress();
      return;
    }

    if (submitted.purpose === "cached-runway") {
      this.#metrics.cachedRunwayOutputs += 1;
      this.#closeUnmanagedFrame(frame);
      if (
        !this.#settleOrdinalWithoutQueue(submitted.decodeOrdinal) ||
        !this.#releaseHorizonSlot()
      ) {
        return;
      }
      this.#afterOutputProgress();
      return;
    }

    if (
      this.#reorderBuffer.has(submitted.decodeOrdinal) ||
      this.#settledOrdinals.has(submitted.decodeOrdinal)
    ) {
      this.#closeUnmanagedFrame(frame);
      this.#fail(
        new Error(
          `decoder produced decode ordinal ${String(
            submitted.decodeOrdinal
          )} more than once`
        )
      );
      return;
    }

    const managed = new ManagedPathFrameImpl(frame, submitted, () => {
      this.#decoderOwnedFrames.delete(managed);
      if (!this.#openFrames.delete(managed)) {
        return;
      }
      this.#metrics.openFrames -= 1;
      this.#metrics.closedFrames += 1;
    });
    this.#openFrames.add(managed);
    this.#decoderOwnedFrames.add(managed);
    this.#reorderBuffer.set(submitted.decodeOrdinal, managed);
    this.#metrics.continuationOutputFrames += 1;
    this.#updateMaxQueueDepth();
    this.#afterOutputProgress();
  }

  #afterOutputProgress(): void {
    try {
      this.#drainReorderBuffer();
      this.#fillToDesiredAhead();
      this.#settleWaiters();
    } catch (error) {
      this.#fail(normalizeError(error, "path decoder output processing failed"));
    }
  }

  #settleOrdinalWithoutQueue(decodeOrdinal: bigint): boolean {
    if (
      decodeOrdinal < this.#nextOutputOrdinal ||
      this.#settledOrdinals.has(decodeOrdinal) ||
      this.#reorderBuffer.has(decodeOrdinal)
    ) {
      const error = new Error(
        `decoder output ordinal ${String(decodeOrdinal)} settled more than once`
      );
      this.#fail(error);
      return false;
    }
    this.#settledOrdinals.add(decodeOrdinal);
    return true;
  }

  #drainReorderBuffer(): void {
    for (;;) {
      if (this.#settledOrdinals.delete(this.#nextOutputOrdinal)) {
        this.#nextOutputOrdinal += 1n;
        continue;
      }

      const frame = this.#reorderBuffer.get(this.#nextOutputOrdinal);
      if (frame === undefined) {
        break;
      }
      this.#reorderBuffer.delete(this.#nextOutputOrdinal);
      this.#readyQueue.push(frame);
      this.#nextOutputOrdinal += 1n;
    }
    this.#updateMaxQueueDepth();
  }

  #discardDecoderOwnedFramesFromOlderPaths(generation: number): void {
    for (const frame of this.#readyQueue.splice(0)) {
      if (frame.pathGeneration === generation) {
        this.#readyQueue.push(frame);
        continue;
      }
      this.#metrics.staleOutputs += 1;
      frame.close();
      if (!this.#releaseHorizonSlot()) {
        return;
      }
    }

    for (const [ordinal, frame] of [...this.#reorderBuffer]) {
      if (frame.pathGeneration === generation) {
        continue;
      }
      this.#reorderBuffer.delete(ordinal);
      this.#metrics.staleOutputs += 1;
      frame.close();
      if (
        !this.#settleOrdinalWithoutQueue(ordinal) ||
        !this.#releaseHorizonSlot()
      ) {
        return;
      }
    }
    this.#updateMaxQueueDepth();
  }

  #releaseHorizonSlot(): boolean {
    if (this.#inFlightFrames <= 0) {
      const error = new Error("decoder input-horizon accounting became inconsistent");
      this.#fail(error);
      return false;
    }
    this.#inFlightFrames -= 1;
    return true;
  }

  #updateMaxQueueDepth(): void {
    this.#metrics.maxQueueDepth = Math.max(
      this.#metrics.maxQueueDepth,
      this.#readyQueue.length + this.#reorderBuffer.size
    );
  }

  #settleWaiters(): void {
    for (const waiter of [...this.#waiters]) {
      if (this.#fatalError !== null) {
        this.#finishWaiter(waiter, () => {
          waiter.reject(this.#fatalError);
        });
        continue;
      }
      if (this.#disposed) {
        this.#finishWaiter(waiter, () => {
          waiter.reject(new PathDecoderDisposedError());
        });
        continue;
      }
      if (waiter.generation !== this.#activeGeneration) {
        this.#finishWaiter(waiter, () => {
          waiter.reject(new PathDecoderSupersededError(waiter.generation));
        });
        continue;
      }
      if (this.#readyQueue.length >= waiter.minimum) {
        this.#finishWaiter(waiter, waiter.resolve);
      }
    }
  }

  #rejectSupersededWaiters(nextGeneration: number): void {
    for (const waiter of [...this.#waiters]) {
      if (waiter.generation === nextGeneration) {
        continue;
      }
      this.#finishWaiter(waiter, () => {
        waiter.reject(new PathDecoderSupersededError(waiter.generation));
      });
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

  #assertPathStarted(): void {
    if (this.#activePath === null || this.#activeGeneration === null) {
      throw new PathDecoderNotStartedError();
    }
  }

  #throwIfFailedOrDisposed(): void {
    if (this.#fatalError !== null) {
      throw this.#fatalError;
    }
    if (this.#disposed) {
      throw new PathDecoderDisposedError();
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
    this.#settledOrdinals.clear();
    this.#reorderBuffer.clear();
    this.#readyQueue.length = 0;
    this.#activePath = null;
    this.#desiredAhead = 0;
    this.#inFlightFrames = 0;
    for (const frame of [...this.#decoderOwnedFrames]) {
      frame.close();
    }
    this.#closeDecoder();
  }

  #closeUnmanagedFrame(frame: VideoFrame): void {
    try {
      frame.close();
    } finally {
      this.#metrics.openFrames -= 1;
      this.#metrics.closedFrames += 1;
    }
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
      // Decoder close is best-effort; all decoded frames are still reclaimed.
    }
  }
}

class ManagedPathFrameImpl implements ManagedPathFrame {
  readonly #onClose: () => void;
  #closed = false;

  public constructor(
    public readonly frame: VideoFrame,
    submitted: SubmittedPathFrame,
    onClose: () => void
  ) {
    this.decodeOrdinal = submitted.decodeOrdinal;
    this.pathGeneration = submitted.pathGeneration;
    this.unitId = submitted.unitId;
    this.pathFrame = submitted.pathFrame;
    this.contentFrame = submitted.contentFrame;
    this.timestamp = submitted.timestamp;
    this.duration = submitted.duration;
    this.#onClose = onClose;
  }

  public readonly decodeOrdinal: bigint;
  public readonly pathGeneration: number;
  public readonly unitId: string;
  public readonly pathFrame: bigint;
  public readonly contentFrame: number;
  public readonly purpose = "continuation" as const;
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

function registerCompatibleUnits(units: readonly ContinuousPathUnit[]): {
  readonly units: ReadonlyMap<string, RegisteredPathUnit>;
  readonly frameRate: Readonly<RationalFrameRate>;
  readonly decoderConfig: Readonly<VideoDecoderConfig>;
} {
  if (!Array.isArray(units) || units.length === 0) {
    throw new RangeError("continuous path decoder requires at least one unit");
  }

  const registered = new Map<string, RegisteredPathUnit>();
  let reference: EncodedLoopUnit | null = null;
  for (const [index, entry] of units.entries()) {
    if (entry === null || typeof entry !== "object") {
      throw new TypeError(`path unit ${String(index)} must be an object`);
    }
    if (typeof entry.id !== "string" || entry.id.length === 0) {
      throw new TypeError(`path unit ${String(index)} id must be a non-empty string`);
    }
    if (registered.has(entry.id)) {
      throw new TypeError(`duplicate path unit id ${JSON.stringify(entry.id)}`);
    }

    const unit = createEncodedLoopUnit(entry.unit);
    if (reference !== null && !unitsAreDecoderCompatible(reference, unit)) {
      throw new TypeError(
        `path unit ${JSON.stringify(entry.id)} is not decoder-compatible with the first unit`
      );
    }
    reference ??= unit;
    registered.set(entry.id, Object.freeze({ id: entry.id, unit }));
  }

  if (reference === null) {
    throw new RangeError("continuous path decoder requires at least one unit");
  }
  return {
    units: registered,
    frameRate: reference.frameRate,
    decoderConfig: reference.config
  };
}

function unitsAreDecoderCompatible(
  reference: EncodedLoopUnit,
  candidate: EncodedLoopUnit
): boolean {
  return (
    reference.codedWidth === candidate.codedWidth &&
    reference.codedHeight === candidate.codedHeight &&
    reference.displayWidth === candidate.displayWidth &&
    reference.displayHeight === candidate.displayHeight &&
    reference.frameRate.numerator === candidate.frameRate.numerator &&
    reference.frameRate.denominator === candidate.frameRate.denominator &&
    decoderConfigsEqual(reference.config, candidate.config)
  );
}

function decoderConfigsEqual(
  left: Readonly<VideoDecoderConfig>,
  right: Readonly<VideoDecoderConfig>
): boolean {
  return (
    left.codec === right.codec &&
    left.codedWidth === right.codedWidth &&
    left.codedHeight === right.codedHeight &&
    left.displayAspectWidth === right.displayAspectWidth &&
    left.displayAspectHeight === right.displayAspectHeight &&
    left.hardwareAcceleration === right.hardwareAcceleration &&
    left.optimizeForLatency === right.optimizeForLatency &&
    colorSpacesEqual(left.colorSpace, right.colorSpace) &&
    bufferSourcesEqual(left.description, right.description)
  );
}

function colorSpacesEqual(
  left: VideoColorSpaceInit | undefined,
  right: VideoColorSpaceInit | undefined
): boolean {
  if (left === undefined || right === undefined) {
    return left === right;
  }
  return (
    left.primaries === right.primaries &&
    left.transfer === right.transfer &&
    left.matrix === right.matrix &&
    left.fullRange === right.fullRange
  );
}

function bufferSourcesEqual(
  left: AllowSharedBufferSource | undefined,
  right: AllowSharedBufferSource | undefined
): boolean {
  if (left === undefined || right === undefined) {
    return left === right;
  }
  const leftBytes = bufferSourceBytes(left);
  const rightBytes = bufferSourceBytes(right);
  if (leftBytes.byteLength !== rightBytes.byteLength) {
    return false;
  }
  return leftBytes.every((value, index) => value === rightBytes[index]);
}

function bufferSourceBytes(source: AllowSharedBufferSource): Uint8Array {
  return ArrayBuffer.isView(source)
    ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
    : new Uint8Array(source);
}

function hasExpectedDimensions(
  frame: VideoFrame,
  unit: EncodedLoopUnit
): boolean {
  const visible = frame.visibleRect;
  const maximumCodedWidth = Math.ceil(unit.codedWidth / 16) * 16 + 16;
  const maximumCodedHeight = Math.ceil(unit.codedHeight / 16) * 16 + 16;

  return (
    visible !== null &&
    frame.displayWidth === unit.displayWidth &&
    frame.displayHeight === unit.displayHeight &&
    visible.width === unit.displayWidth &&
    visible.height === unit.displayHeight &&
    visible.x >= 0 &&
    visible.y >= 0 &&
    frame.codedWidth >= visible.x + visible.width &&
    frame.codedHeight >= visible.y + visible.height &&
    frame.codedWidth <= maximumCodedWidth &&
    frame.codedHeight <= maximumCodedHeight
  );
}

function describeOutputGeometry(frame: VideoFrame): string {
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

function defaultDecoderFactory(init: VideoDecoderInit): VideoDecoderAdapter {
  if (typeof VideoDecoder === "undefined") {
    throw new TypeError("VideoDecoder is unavailable in this environment");
  }
  return new VideoDecoder(init);
}

function defaultChunkFactory(init: EncodedVideoChunkInit): EncodedVideoChunk {
  if (typeof EncodedVideoChunk === "undefined") {
    throw new TypeError("EncodedVideoChunk is unavailable in this environment");
  }
  return new EncodedVideoChunk(init);
}

function validateMaxInFlight(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 256) {
    throw new RangeError("maxInFlight must be an integer from 1 through 256");
  }
  return value;
}

function validateAheadTarget(value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new RangeError(
      `ahead frame count must be an integer from 0 through ${String(maximum)}`
    );
  }
  return value;
}

function validateCachedRunwayFrames(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 12) {
    throw new RangeError("cachedRunwayFrames must be an integer from 0 through 12");
  }
  return value;
}

function validateWaitMinimum(value: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new RangeError(
      `minimum frame count must be an integer from 1 through ${String(maximum)}`
    );
  }
}

function validateTimeout(value: number | undefined): void {
  if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
    throw new RangeError("timeoutMs must be a finite non-negative number");
  }
}

function nextGeneration(current: number | null): number {
  const next = current === null ? 1 : current + 1;
  if (!Number.isSafeInteger(next)) {
    throw new RangeError("path generation exceeds JavaScript's safe-integer range");
  }
  return next;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function normalizeError(error: unknown, message: string): Error {
  return error instanceof Error ? error : new Error(message, { cause: error });
}
