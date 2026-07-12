import {
  DecoderWorkerCoreError,
  normalizeCoreError,
  validateConfiguration,
  validateDecodedFrame,
  validateGeneration,
  validateSupportResultConfiguration
} from "./core-validation.js";
import {
  createDefaultWorkerAvcInspector,
  inspectWorkerSample,
  type WorkerAvcInspector,
  type WorkerAvcInspectorFactory
} from "./avc-inspector-adapter.js";
import { FrameCreditLedger } from "./frame-credit-ledger.js";
import {
  DECODER_WORKER_PROTOCOL_VERSION,
  type DecoderWorkerCommand,
  type DecoderWorkerErrorEvent,
  type DecoderWorkerEvent,
  type DecoderWorkerLimits,
  type DecoderWorkerMetrics,
  type DecoderWorkerOutputExpectation,
  type DecoderWorkerSample
} from "./protocol.js";
import { DecoderSampleSequence } from "./sample-sequence.js";

export interface WorkerVideoDecoderAdapter {
  readonly decodeQueueSize: number;
  setDequeueCallback(callback: () => void): void;
  configure(config: VideoDecoderConfig): void;
  decode(chunk: EncodedVideoChunk): void;
  close(): void;
}

export type WorkerVideoDecoderFactory = (
  init: VideoDecoderInit
) => WorkerVideoDecoderAdapter;

export type WorkerEncodedVideoChunkFactory = (
  init: EncodedVideoChunkInit
) => EncodedVideoChunk;

export type WorkerVideoDecoderSupportProbe = (
  config: VideoDecoderConfig
) => Promise<VideoDecoderSupport>;

export type DecoderWorkerEventSink = (
  event: DecoderWorkerEvent,
  transfer?: Transferable[]
) => void;

export interface DecoderWorkerCoreOptions {
  readonly emit: DecoderWorkerEventSink;
  readonly decoderFactory?: WorkerVideoDecoderFactory;
  readonly chunkFactory?: WorkerEncodedVideoChunkFactory;
  readonly supportProbe?: WorkerVideoDecoderSupportProbe;
  readonly inspectorFactory?: WorkerAvcInspectorFactory;
}

interface PendingSample {
  readonly generation: number;
  readonly sample: DecoderWorkerSample;
}

interface SubmittedSample extends PendingSample {}

interface MutableMetrics {
  configureCalls: number;
  acceptedSamples: number;
  submittedChunks: number;
  outputFrames: number;
  deliveredFrames: number;
  releasedFrames: number;
  staleFrames: number;
  closedFrames: number;
  errors: number;
}

/**
 * Worker-local owner of the sole VideoDecoder.
 *
 * Generation changes retire obsolete work but deliberately never invoke
 * configure, reset, or flush. Input is bounded by both WebCodecs queue depth
 * and explicit frame credits; transferred frames retain a credit until the
 * main-thread owner releases them.
 */
export class DecoderWorkerCore {
  readonly #emitEvent: DecoderWorkerEventSink;
  readonly #decoderFactory: WorkerVideoDecoderFactory;
  readonly #chunkFactory: WorkerEncodedVideoChunkFactory;
  readonly #supportProbe: WorkerVideoDecoderSupportProbe;
  readonly #inspectorFactory: WorkerAvcInspectorFactory;
  readonly #pending: PendingSample[] = [];
  readonly #submittedByTimestamp = new Map<number, SubmittedSample>();
  readonly #credits = new FrameCreditLedger();
  readonly #sequence = new DecoderSampleSequence();
  readonly #settledOrdinals = new Set<number>();
  readonly #metrics: MutableMetrics = {
    configureCalls: 0,
    acceptedSamples: 0,
    submittedChunks: 0,
    outputFrames: 0,
    deliveredFrames: 0,
    releasedFrames: 0,
    staleFrames: 0,
    closedFrames: 0,
    errors: 0
  };

  #decoder: WorkerVideoDecoderAdapter | null = null;
  #inspector: WorkerAvcInspector | null = null;
  #expectedOutput: DecoderWorkerOutputExpectation | null = null;
  #limits: DecoderWorkerLimits | null = null;
  #activeGeneration: number | null = null;
  #lastGeneration = 0;
  #lastRequestId = 0;
  #nextOutputOrdinal = 0;
  #failure: DecoderWorkerCoreError | null = null;
  #disposed = false;
  #decoderClosed = false;
  #configuring = false;

  public constructor(options: DecoderWorkerCoreOptions) {
    this.#emitEvent = options.emit;
    this.#decoderFactory = options.decoderFactory ?? defaultDecoderFactory;
    this.#chunkFactory = options.chunkFactory ?? defaultChunkFactory;
    this.#supportProbe = options.supportProbe ?? defaultSupportProbe;
    this.#inspectorFactory =
      options.inspectorFactory ?? createDefaultWorkerAvcInspector;
  }

  public async handle(command: DecoderWorkerCommand): Promise<void> {
    if (command.type !== "release-frame") {
      if (command.requestId <= this.#lastRequestId) {
        this.#fail(
          new DecoderWorkerCoreError(
            "PROTOCOL_ERROR",
            "decoder worker request ids must increase monotonically",
            true
          ),
          command.requestId
        );
        return;
      }
      this.#lastRequestId = command.requestId;
    }
    if (command.type === "dispose") {
      this.#dispose(command.requestId);
      return;
    }
    if (this.#disposed) {
      this.#emitError(
        command.type === "release-frame" ? null : command.requestId,
        new DecoderWorkerCoreError("DISPOSED", "decoder worker is disposed")
      );
      return;
    }
    if (command.type === "snapshot") {
      this.#emit({
        type: "snapshot",
        protocolVersion: DECODER_WORKER_PROTOCOL_VERSION,
        requestId: command.requestId,
        metrics: this.snapshotMetrics()
      });
      return;
    }
    if (this.#failure !== null) {
      this.#emitError(
        command.type === "release-frame" ? null : command.requestId,
        this.#failure
      );
      return;
    }

    try {
      switch (command.type) {
        case "configure":
          await this.#configure(command);
          break;
        case "activate-generation":
          this.#activateGeneration(command.requestId, command.generation);
          break;
        case "submit":
          this.#submit(command.requestId, command.generation, command.samples);
          break;
        case "abort-generation":
          this.#abortGeneration(command.requestId, command.generation);
          break;
        case "release-frame":
          this.#releaseFrame(command.frameId);
          break;
        default:
          command satisfies never;
      }
    } catch (error) {
      const normalized = normalizeCoreError(
        error,
        "PROTOCOL_ERROR",
        "decoder worker command failed",
        false
      );
      if (normalized.fatal) {
        this.#fail(normalized, command.type === "release-frame" ? null : command.requestId);
      } else {
        this.#emitError(
          command.type === "release-frame" ? null : command.requestId,
          normalized
        );
      }
    }
  }

  public rejectMalformedCommand(requestId: number | null): void {
    this.#fail(
      new DecoderWorkerCoreError(
        "PROTOCOL_ERROR",
        "decoder worker received a malformed command",
        true
      ),
      requestId
    );
  }

  public snapshotMetrics(): DecoderWorkerMetrics {
    return Object.freeze({
      configureCalls: this.#metrics.configureCalls,
      resetCalls: 0 as const,
      flushCalls: 0 as const,
      boundaryFlushCalls: 0 as const,
      acceptedSamples: this.#metrics.acceptedSamples,
      submittedChunks: this.#metrics.submittedChunks,
      outputFrames: this.#metrics.outputFrames,
      deliveredFrames: this.#metrics.deliveredFrames,
      releasedFrames: this.#metrics.releasedFrames,
      staleFrames: this.#metrics.staleFrames,
      closedFrames: this.#metrics.closedFrames,
      pendingSamples: this.#pending.length,
      submittedFrames: this.#submittedByTimestamp.size,
      leasedFrames: this.#credits.count,
      leasedDecodedBytes: this.#credits.decodedBytes,
      decodeQueueSize: this.#readDecodeQueueSize(),
      activeGeneration: this.#activeGeneration,
      nextSubmissionOrdinal: this.#sequence.nextOrdinal,
      nextOutputOrdinal: this.#nextOutputOrdinal,
      errors: this.#metrics.errors,
      disposed: this.#disposed
    });
  }

  async #configure(
    command: Extract<DecoderWorkerCommand, { readonly type: "configure" }>
  ): Promise<void> {
    if (
      this.#decoder !== null ||
      this.#metrics.configureCalls !== 0 ||
      this.#configuring
    ) {
      throw new DecoderWorkerCoreError(
        "ALREADY_CONFIGURED",
        "decoder worker may be configured only once"
      );
    }
    validateConfiguration(
      command.config,
      command.avcProfile,
      command.expectedOutput,
      command.limits
    );
    this.#configuring = true;

    let decoder: WorkerVideoDecoderAdapter | null = null;
    try {
      const support = await this.#supportProbe(command.config);
      if (!support.supported || support.config === undefined) {
        throw new DecoderWorkerCoreError(
          "DECODER_CONFIGURE_FAILED",
          "WebCodecs does not support the requested decoder configuration",
          true
        );
      }
      validateSupportResultConfiguration(support.config, command.config);
      this.#inspector = this.#inspectorFactory(command.avcProfile);
      decoder = this.#decoderFactory({
        output: (frame) => {
          this.#handleOutput(frame);
        },
        error: (error) => {
          this.#fail(
            normalizeCoreError(
              error,
              "DECODER_OUTPUT_INVALID",
              "WebCodecs decoder failed",
              true
            ),
            null
          );
        }
      });
      decoder.setDequeueCallback(() => {
        this.#pump();
      });
      decoder.configure(command.config);
      if (this.#failure !== null) {
        throw this.#failure;
      }
    } catch (error) {
      const normalized = normalizeCoreError(
        error,
        "DECODER_CONFIGURE_FAILED",
        "failed to configure WebCodecs decoder",
        true
      );
      try {
        decoder?.close();
      } catch {
        // The original configure failure is the actionable error.
      }
      throw normalized;
    } finally {
      this.#configuring = false;
    }

    if (decoder === null) {
      throw new DecoderWorkerCoreError(
        "DECODER_CONFIGURE_FAILED",
        "decoder factory did not return an adapter",
        true
      );
    }
    this.#decoder = decoder;
    this.#expectedOutput = command.expectedOutput;
    this.#limits = command.limits;
    this.#metrics.configureCalls += 1;
    this.#emitAck(command.requestId, "configure");
  }

  #activateGeneration(requestId: number, generation: number): void {
    this.#assertConfigured();
    validateGeneration(generation);
    if (generation <= this.#lastGeneration) {
      throw new DecoderWorkerCoreError(
        "GENERATION_MISMATCH",
        "decoder generations must increase monotonically"
      );
    }

    this.#retirePending(generation, false);
    this.#sequence.activate(generation);
    this.#requireInspector().resetUnitSequence();
    this.#activeGeneration = generation;
    this.#lastGeneration = generation;
    this.#emitAck(requestId, "activate-generation");
    this.#pump();
  }

  #submit(
    requestId: number,
    generation: number,
    samples: readonly DecoderWorkerSample[]
  ): void {
    this.#assertConfigured();
    if (generation !== this.#activeGeneration) {
      throw new DecoderWorkerCoreError(
        "GENERATION_MISMATCH",
        "decode submission does not target the active generation"
      );
    }
    const limits = this.#requireLimits();
    if (samples.length < 1) {
      throw new DecoderWorkerCoreError(
        "PROTOCOL_ERROR",
        "decode submission must contain at least one sample",
        true
      );
    }
    if (this.#pending.length + samples.length > limits.maxPendingSamples) {
      throw new DecoderWorkerCoreError(
        "BACKPRESSURE_LIMIT",
        "decode submission exceeds the pending-sample budget"
      );
    }
    if (
      this.#pending.length +
        this.#submittedByTimestamp.size +
        this.#credits.count +
        samples.length >
      limits.maxOutstandingFrames
    ) {
      throw new DecoderWorkerCoreError(
        "BACKPRESSURE_LIMIT",
        "decode submission exceeds the outstanding-frame budget"
      );
    }

    this.#sequence.accept(generation, samples);
    const inspector = this.#requireInspector();
    const inspected: DecoderWorkerSample[] = [];
    try {
      for (const sample of samples) {
        inspected.push(inspectWorkerSample(inspector, sample));
      }
    } catch (error) {
      throw normalizeCoreError(
        error,
        "DECODER_SUBMIT_FAILED",
        "strict AVC access-unit inspection failed",
        true
      );
    }
    for (const sample of inspected) {
      this.#pending.push({ generation, sample });
    }
    this.#metrics.acceptedSamples += samples.length;
    this.#emitAck(requestId, "submit");
    this.#pump();
  }

  #abortGeneration(requestId: number, generation: number): void {
    this.#assertConfigured();
    validateGeneration(generation);
    if (generation !== this.#activeGeneration) {
      throw new DecoderWorkerCoreError(
        "GENERATION_MISMATCH",
        "only the active decoder generation can be aborted"
      );
    }
    this.#activeGeneration = null;
    this.#retirePending(generation, true);
    this.#sequence.abort(generation);
    this.#emitAck(requestId, "abort-generation");
  }

  #releaseFrame(frameId: number): void {
    this.#credits.release(frameId);
    this.#metrics.releasedFrames += 1;
    this.#pump();
  }

  #pump(): void {
    if (
      this.#failure !== null ||
      this.#disposed ||
      this.#decoder === null ||
      this.#limits === null
    ) {
      return;
    }

    while (
      this.#pending.length > 0 &&
      this.#readDecodeQueueSize() < this.#limits.maxDecodeQueueSize &&
      this.#credits.hasSubmissionCredit(
        this.#submittedByTimestamp.size,
        this.#limits.maxOutstandingFrames
      )
    ) {
      const pending = this.#pending.shift();
      if (pending === undefined) {
        return;
      }
      if (pending.generation !== this.#activeGeneration) {
        this.#settleWithoutOutput(pending.sample.ordinal);
        continue;
      }

      const sample = pending.sample;
      let chunk: EncodedVideoChunk;
      try {
        chunk = this.#chunkFactory({
          type: sample.type,
          timestamp: sample.timestamp,
          duration: sample.duration,
          data: sample.data
        });
      } catch (error) {
        this.#fail(
          normalizeCoreError(
            error,
            "DECODER_SUBMIT_FAILED",
            "failed to construct EncodedVideoChunk",
            true
          ),
          null
        );
        return;
      }

      this.#submittedByTimestamp.set(sample.timestamp, pending);
      this.#metrics.submittedChunks += 1;
      try {
        this.#decoder.decode(chunk);
      } catch (error) {
        this.#submittedByTimestamp.delete(sample.timestamp);
        this.#fail(
          normalizeCoreError(
            error,
            "DECODER_SUBMIT_FAILED",
            "WebCodecs rejected an encoded chunk",
            true
          ),
          null
        );
        return;
      }
    }
  }

  #handleOutput(frame: VideoFrame): void {
    this.#metrics.outputFrames += 1;
    if (this.#disposed || this.#failure !== null) {
      this.#closeFrame(frame);
      return;
    }

    const submitted = this.#submittedByTimestamp.get(frame.timestamp);
    if (submitted === undefined) {
      this.#closeFrame(frame);
      this.#fail(
        new DecoderWorkerCoreError(
          "DECODER_OUTPUT_INVALID",
          "decoder produced an output with an unknown timestamp",
          true
        ),
        null
      );
      return;
    }
    this.#submittedByTimestamp.delete(frame.timestamp);
    let ownsFrame = true;

    try {
      this.#advanceSettledOrdinals();
      if (submitted.sample.ordinal !== this.#nextOutputOrdinal) {
        throw new DecoderWorkerCoreError(
          "DECODER_OUTPUT_INVALID",
          "decoder output order violated the low-delay profile",
          true
        );
      }
      const expected = this.#requireExpectedOutput();
      const decodedBytes = validateDecodedFrame(
        frame,
        expected,
        submitted.sample.timestamp,
        submitted.sample.duration
      );
      // Each accepted unit instance is contiguous and bounded by
      // unitFrameCount. Timestamp metadata is consumed exactly once, so this
      // output cannot increase that unit's count beyond its submitted count.
      this.#nextOutputOrdinal += 1;
      this.#advanceSettledOrdinals();

      if (submitted.generation !== this.#activeGeneration) {
        this.#metrics.staleFrames += 1;
        this.#closeFrame(frame);
        ownsFrame = false;
        this.#pump();
        return;
      }

      const limits = this.#requireLimits();
      const frameId = this.#credits.lease(
        submitted.generation,
        decodedBytes,
        limits.maxDecodedBytes
      );
      this.#metrics.deliveredFrames += 1;

      try {
        this.#emitEvent(
          {
            type: "frame",
            protocolVersion: DECODER_WORKER_PROTOCOL_VERSION,
            frameId,
            generation: submitted.generation,
            ordinal: submitted.sample.ordinal,
            unitId: submitted.sample.unitId,
            unitInstance: submitted.sample.unitInstance,
            unitFrame: submitted.sample.unitFrame,
            timestamp: submitted.sample.timestamp,
            duration: submitted.sample.duration,
            decodedBytes,
            frame
          },
          [frame]
        );
        ownsFrame = false;
      } catch (error) {
        this.#credits.revoke(frameId);
        throw normalizeCoreError(
          error,
          "TRANSPORT_FAILED",
          "failed to transfer decoded frame",
          true
        );
      }
      this.#pump();
    } catch (error) {
      if (ownsFrame) {
        this.#closeFrame(frame);
      }
      this.#fail(
        normalizeCoreError(
          error,
          "DECODER_OUTPUT_INVALID",
          "decoder output validation failed",
          true
        ),
        null
      );
    }
  }

  #retirePending(generation: number, inclusive: boolean): void {
    let write = 0;
    for (const pending of this.#pending) {
      if (
        pending.generation < generation ||
        (inclusive && pending.generation === generation)
      ) {
        this.#settleWithoutOutput(pending.sample.ordinal);
      } else {
        this.#pending[write] = pending;
        write += 1;
      }
    }
    this.#pending.length = write;
  }

  #settleWithoutOutput(ordinal: number): void {
    if (ordinal < this.#nextOutputOrdinal) {
      return;
    }
    this.#settledOrdinals.add(ordinal);
    this.#advanceSettledOrdinals();
  }

  #advanceSettledOrdinals(): void {
    while (this.#settledOrdinals.delete(this.#nextOutputOrdinal)) {
      this.#nextOutputOrdinal += 1;
    }
  }

  #dispose(requestId: number): void {
    if (!this.#disposed) {
      this.#disposed = true;
      this.#activeGeneration = null;
      this.#pending.length = 0;
      this.#submittedByTimestamp.clear();
      this.#settledOrdinals.clear();
      this.#sequence.clearActive();
      this.#credits.clear();
      this.#inspector = null;
      this.#closeDecoder();
    }
    this.#emit({
      type: "disposed",
      protocolVersion: DECODER_WORKER_PROTOCOL_VERSION,
      requestId
    });
  }

  #fail(error: DecoderWorkerCoreError, requestId: number | null): void {
    if (this.#failure !== null || this.#disposed) {
      return;
    }
    this.#failure = error;
    this.#metrics.errors += 1;
    this.#activeGeneration = null;
    this.#pending.length = 0;
    this.#submittedByTimestamp.clear();
    this.#settledOrdinals.clear();
    this.#sequence.clearActive();
    this.#credits.clear();
    this.#inspector = null;
    this.#closeDecoder();
    this.#emitError(requestId, error);
  }

  #emitAck(
    requestId: number,
    operation: Extract<DecoderWorkerEvent, { type: "ack" }>['operation']
  ): void {
    this.#emit({
      type: "ack",
      protocolVersion: DECODER_WORKER_PROTOCOL_VERSION,
      requestId,
      operation
    });
  }

  #emitError(requestId: number | null, error: DecoderWorkerCoreError): void {
    this.#metrics.errors += error.fatal && this.#failure === error ? 0 : 1;
    const event: DecoderWorkerErrorEvent = {
      type: "error",
      protocolVersion: DECODER_WORKER_PROTOCOL_VERSION,
      requestId,
      code: error.code,
      message: error.message,
      fatal: error.fatal
    };
    this.#emit(event);
  }

  #emit(event: DecoderWorkerEvent): void {
    try {
      this.#emitEvent(event);
    } catch (error) {
      if (this.#failure === null && !this.#disposed) {
        this.#fail(
          normalizeCoreError(
            error,
            "TRANSPORT_FAILED",
            "decoder worker transport failed",
            true
          ),
          null
        );
      }
    }
  }

  #assertConfigured(): void {
    if (this.#decoder === null || this.#expectedOutput === null || this.#limits === null) {
      throw new DecoderWorkerCoreError(
        "NOT_CONFIGURED",
        "decoder worker must be configured before use"
      );
    }
  }

  #requireExpectedOutput(): DecoderWorkerOutputExpectation {
    const expected = this.#expectedOutput;
    if (expected === null) {
      throw new DecoderWorkerCoreError(
        "NOT_CONFIGURED",
        "decoder output expectation is unavailable",
        true
      );
    }
    return expected;
  }

  #requireLimits(): DecoderWorkerLimits {
    const limits = this.#limits;
    if (limits === null) {
      throw new DecoderWorkerCoreError(
        "NOT_CONFIGURED",
        "decoder limits are unavailable",
        true
      );
    }
    return limits;
  }

  #requireInspector(): WorkerAvcInspector {
    const inspector = this.#inspector;
    if (inspector === null) {
      throw new DecoderWorkerCoreError(
        "NOT_CONFIGURED",
        "AVC inspector is unavailable",
        true
      );
    }
    return inspector;
  }

  #readDecodeQueueSize(): number {
    if (this.#decoder === null || this.#decoderClosed) {
      return 0;
    }
    const size = this.#decoder.decodeQueueSize;
    if (!Number.isSafeInteger(size) || size < 0) {
      this.#fail(
        new DecoderWorkerCoreError(
          "DECODER_OUTPUT_INVALID",
          "WebCodecs reported an invalid decodeQueueSize",
          true
        ),
        null
      );
      return 0;
    }
    return size;
  }

  #closeFrame(frame: VideoFrame): void {
    try {
      frame.close();
    } finally {
      this.#metrics.closedFrames += 1;
    }
  }

  #closeDecoder(): void {
    if (this.#decoder === null || this.#decoderClosed) {
      return;
    }
    this.#decoderClosed = true;
    try {
      this.#decoder.close();
    } catch {
      // Decoder closure is best effort after a terminal failure.
    }
  }

}

function defaultDecoderFactory(init: VideoDecoderInit): WorkerVideoDecoderAdapter {
  const decoder = new VideoDecoder(init);
  let dequeue: (() => void) | undefined;
  return {
    get decodeQueueSize(): number {
      return decoder.decodeQueueSize;
    },
    setDequeueCallback(callback): void {
      if (dequeue !== undefined) {
        decoder.removeEventListener("dequeue", dequeue);
      }
      dequeue = callback;
      decoder.addEventListener("dequeue", callback);
    },
    configure(config): void {
      decoder.configure(config);
    },
    decode(chunk): void {
      decoder.decode(chunk);
    },
    close(): void {
      if (dequeue !== undefined) {
        decoder.removeEventListener("dequeue", dequeue);
        dequeue = undefined;
      }
      decoder.close();
    }
  };
}

function defaultChunkFactory(init: EncodedVideoChunkInit): EncodedVideoChunk {
  return new EncodedVideoChunk(init);
}

async function defaultSupportProbe(
  config: VideoDecoderConfig
): Promise<VideoDecoderSupport> {
  return VideoDecoder.isConfigSupported(config);
}
