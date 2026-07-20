import {
  classifyDecoderColor,
  type DecoderColorTuple
} from "@pixel-point/aval-format";
import {
  isDecoderTerminalEvent,
  isDecoderWorkerEvent,
  type DecoderChunk,
  type DecoderCommand,
  type DecoderRunEvent
} from "./decoder-protocol.js";
import { ELEMENT_DECODER_CAPACITY } from "./decoder-capacity.js";
import { sameAspectRatio } from "./media-geometry.js";
import {
  captureDecoderFrameMetadata,
  createDecoderOutputFailure,
  createDecoderFailureDiagnostic,
  inspectDecoderFrameMetadata,
  type DecoderDiagnosticCode,
  type DecoderDiagnosticPhase,
  type DecoderExpectedOutputMetadata,
  type DecoderFailureDiagnostic,
  type DecoderFrameMetadata,
  type DecoderObservedFrameMetadata,
  type DecoderOutputFailure,
  type DecoderOutputFailureKind,
  type DecoderOutputField
} from "./decoder-diagnostics.js";
import { saturatingIncrement } from "./playback-lifecycle.js";
import {
  webCodecsTimingForTicks,
  type WebCodecsFrameRate
} from "./webcodecs-time.js";

export interface DecodeSample {
  readonly data: ArrayBuffer;
  readonly timestamp: number;
  readonly duration: number;
  readonly key: boolean;
  readonly displayedFrames: number;
}

export interface DecoderOutputExpectation {
  readonly codedWidth: number;
  readonly codedHeight: number;
  readonly displayWidth: number;
  readonly displayHeight: number;
  readonly visibleRect: Readonly<{
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  }>;
  readonly colorSpace: Readonly<{
    readonly fullRange: boolean | null;
    readonly matrix: VideoMatrixCoefficients | null;
    readonly primaries: VideoColorPrimaries | null;
    readonly transfer: VideoTransferCharacteristics | null;
  }> | null;
}

export interface DecoderLimits {
  readonly maxDecodedBytes?: number;
  readonly onDecodedBytes?: (bytes: number) => void;
  readonly onEncodedBytes?: (bytes: number) => void;
  readonly Worker?: typeof globalThis.Worker;
  readonly VideoFrame?: typeof globalThis.VideoFrame;
  readonly setTimeout?: (callback: () => void, delay: number) => number;
  readonly clearTimeout?: (handle: number) => void;
  /** When present, DecodeSample timing is expressed in AVAL frame ticks. */
  readonly sampleFrameRate?: Readonly<WebCodecsFrameRate>;
}

export interface DecoderSnapshot {
  readonly workerCount: number;
  readonly openFrames: number;
  readonly openFrameBytes: number;
  readonly lifecycle: Readonly<{
    readonly outputsAccepted: number;
    readonly runsClosed: number;
    readonly nativeDecoderCreates: number;
    readonly nativeDecoderCloses: number;
  }>;
  readonly diagnostic: Readonly<DecoderFailureDiagnostic> | null;
}

export type DecoderLocalFailure =
  | Readonly<{ kind: "unsupported-config" }>
  | Readonly<{
      kind: "operation-rejected";
      phase: "configure" | "decode" | "flush";
      errorName: "NotSupportedError" | "EncodingError";
    }>
  | Readonly<{ kind: "decoded-metadata-incompatible" }>;

export class DecoderLocalFailureError extends Error {
  public constructor(
    public readonly failure: Readonly<DecoderLocalFailure>,
    public readonly reason: Error
  ) {
    super(reason.message);
    this.name = "DecoderLocalFailureError";
  }
}

const PROGRESS_MS = 2_000;
const MAX_BYTES = Number.MAX_SAFE_INTEGER;
const DEFAULT_DECODER_COLOR: Readonly<DecoderColorTuple> = Object.freeze([
  "bt709",
  "bt709",
  "bt709",
  false
]);

type DecoderLane =
  | Readonly<{ phase: "idle"; generationFloor: number }>
  | Readonly<{ phase: "running"; run: DecodeRun }>
  | Readonly<{ phase: "retained"; run: DecodeRun }>
  | Readonly<{ phase: "closing"; run: DecodeRun }>
  | Readonly<{ phase: "terminal" }>;

export class Decoder {
  readonly #worker: Worker;
  readonly #expectation: DecoderOutputExpectation;
  readonly #maxDecodedBytes: number;
  readonly #onDecodedBytes: ((bytes: number) => void) | undefined;
  readonly #onEncodedBytes: ((bytes: number) => void) | undefined;
  readonly #VideoFrame: typeof globalThis.VideoFrame;
  readonly #setTimeout: (callback: () => void, delay: number) => number;
  readonly #clearTimeout: (handle: number) => void;
  readonly #sampleFrameRate: Readonly<WebCodecsFrameRate> | null;
  readonly #support = deferred<boolean>();
  readonly #failure = deferred<never>();
  #run: DecodeRun | null = null;
  #sequence = 0;
  #decodedBytes = 0;
  #encodedBytes = 0;
  #lane: DecoderLane = { phase: "idle", generationFloor: 0 };
  #configured = false;
  #disposed = false;
  #error: Error | undefined;
  #diagnostic: Readonly<DecoderFailureDiagnostic> | null = null;
  #outputsAccepted = 0;
  #runsClosed = 0;
  #nativeDecoderCreates = 0;
  #nativeDecoderCloses = 0;
  #nativeCreateGenerationFloor = 0;
  #nativeCloseGenerationFloor = 0;

  public constructor(
    config: Readonly<VideoDecoderConfig>,
    expectation: Readonly<DecoderOutputExpectation> =
      defaultExpectation(config),
    limits: Readonly<DecoderLimits> = {}
  ) {
    this.#expectation = validateExpectation(expectation);
    this.#maxDecodedBytes = limits.maxDecodedBytes ?? MAX_BYTES;
    if (!Number.isSafeInteger(this.#maxDecodedBytes) || this.#maxDecodedBytes < 1) {
      throw new RangeError("decoder byte ceiling is invalid");
    }
    if (limits.onDecodedBytes !== undefined && typeof limits.onDecodedBytes !== "function") {
      throw new TypeError("decoded byte observer is invalid");
    }
    if (limits.onEncodedBytes !== undefined && typeof limits.onEncodedBytes !== "function") {
      throw new TypeError("encoded byte observer is invalid");
    }
    this.#onDecodedBytes = limits.onDecodedBytes;
    this.#onEncodedBytes = limits.onEncodedBytes;
    this.#setTimeout = limits.setTimeout ?? ((callback, delay) =>
      globalThis.setTimeout(callback, delay) as unknown as number);
    this.#clearTimeout = limits.clearTimeout ?? ((handle) => globalThis.clearTimeout(handle));
    this.#sampleFrameRate = limits.sampleFrameRate === undefined
      ? null
      : validateSampleFrameRate(limits.sampleFrameRate);
    const WorkerConstructor = limits.Worker ?? globalThis.Worker;
    const VideoFrameConstructor = limits.VideoFrame ?? globalThis.VideoFrame;
    if (typeof WorkerConstructor !== "function" ||
      typeof VideoFrameConstructor !== "function") {
      throw new TypeError("decoder platform is unavailable");
    }
    this.#VideoFrame = VideoFrameConstructor;
    this.#worker = new WorkerConstructor(
      new URL("./decoder-worker.js?no-inline", import.meta.url),
      { type: "module", name: "aval-decoder" }
    );
    this.#worker.addEventListener("message", (event: MessageEvent<unknown>) => {
      this.#receive(event.data);
    });
    this.#worker.addEventListener("error", (event) => {
      const reason = workerErrorReason(event);
      this.#fail(reason, this.#localDiagnostic(
        "frame-transfer",
        "transport",
        reason
      ));
    });
    this.#worker.addEventListener("messageerror", () => {
      const reason = new Error("AVAL decoder message transport failed");
      this.#fail(reason, this.#localDiagnostic(
        "frame-transfer",
        "transport",
        reason
      ));
    });
    try {
      this.#post({ t: "configure", config: { ...config } });
    } catch (reason) {
      const error = asError(reason, "AVAL decoder configuration transport failed");
      this.#fail(error, this.#localDiagnostic("probe", "transport", reason));
    }
    void this.#support.promise.catch(() => undefined);
    void this.#failure.promise.catch(() => undefined);
  }

  /** Probes the configuration in the same worker that will decode it. */
  public supported(): Promise<boolean> {
    return this.#support.promise;
  }

  /** Rejects exactly once if this physical lane becomes unusable. */
  public failure(): Promise<never> {
    return this.#failure.promise;
  }

  /** Exact terminal cause for aggregate decoder-pool support arbitration. */
  public terminalError(): Error | null {
    return this.#error ?? null;
  }

  public createRun(samples: readonly Readonly<DecodeSample>[]): DecodeRun {
    if (this.#disposed) throw abortError();
    if (this.#error !== undefined) throw this.#error;
    if (
      !this.#configured || this.#lane.phase !== "idle" || this.#run !== null
    ) {
      throw new Error("decoder lane is unavailable");
    }
    if (this.#sequence === MAX_BYTES) {
      throw new RangeError("decoder run identity is exhausted");
    }
    const sampleFrameRate = this.#sampleFrameRate;
    const runtimeSamples = sampleFrameRate === null
      ? samples
      : samples.map((sample) => webCodecsSampleForTicks(sample, sampleFrameRate));
    const id = ++this.#sequence;
    const run = new DecodeRun(
      id,
      runtimeSamples,
      this.#expectation,
      this.#VideoFrame,
      (message, transfer) => {
        if (this.#disposed || this.#error !== undefined) throw abortError();
        this.#post(message, transfer);
      },
      () => this.#availableCredit(),
      () => this.#creditChanged(),
      (bytes) => this.#claimDecodedBytes(bytes),
      (bytes) => this.#releaseDecodedBytes(bytes),
      () => this.#closeRun(run),
      (error, diagnostic) => this.#fail(error, diagnostic),
      this.#setTimeout,
      this.#clearTimeout
    );
    const previousEncodedBytes = this.#encodedBytes;
    if (run.encodedBytes > MAX_BYTES - previousEncodedBytes) {
      throw new RangeError("decoder encoded copies exceed their byte ceiling");
    }
    this.#encodedBytes += run.encodedBytes;
    try { this.#onEncodedBytes?.(this.#encodedBytes); }
    catch (error) {
      this.#encodedBytes = previousEncodedBytes;
      throw error;
    }
    this.#run = run;
    this.#lane = { phase: "running", run };
    run.activate();
    try {
      this.#post({ t: "start", run: run.generation });
    } catch (reason) {
      const error = asError(reason, "AVAL decoder start transport failed");
      this.#fail(error, this.#localDiagnostic(
        "configure",
        "transport",
        reason,
        run.generation
      ));
    }
    return run;
  }

  public snapshot(): Readonly<DecoderSnapshot> {
    return Object.freeze({
      workerCount: this.#disposed || this.#error !== undefined ? 0 : 1,
      openFrames: this.#run?.openFrames ?? 0,
      openFrameBytes: this.#decodedBytes,
      lifecycle: Object.freeze({
        outputsAccepted: this.#outputsAccepted,
        runsClosed: this.#runsClosed,
        nativeDecoderCreates: this.#nativeDecoderCreates,
        nativeDecoderCloses: this.#nativeDecoderCloses
      }),
      diagnostic: this.#diagnostic
    });
  }

  public get encodedBytes(): number { return this.#encodedBytes; }

  /** True only when the worker has acknowledged retirement and can start now. */
  public get available(): boolean {
    return this.#configured && !this.#disposed && this.#error === undefined &&
      this.#lane.phase === "idle" && this.#run === null;
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#lane = { phase: "terminal" };
    const run = this.#run;
    run?.close();
    try { this.#post({ t: "dispose" }); } catch { /* terminal */ }
    this.#worker.terminate();
    if (run !== null) this.#deleteRun(run);
    this.#support.reject(abortError());
  }

  #receive(value: unknown): void {
    if (this.#disposed || this.#lane.phase === "terminal") {
      closeTransferredFrame(value, this.#VideoFrame);
      return;
    }
    if (!isDecoderWorkerEvent(value, this.#VideoFrame)) {
      closeTransferredFrame(value, this.#VideoFrame);
      const reason = new Error("AVAL decoder received an invalid worker message");
      this.#fail(reason, this.#localDiagnostic(
        "frame-transfer",
        "transport",
        reason
      ));
      return;
    }
    if (value.t === "configured") {
      if (this.#configured) {
        const reason = new Error("AVAL decoder was configured more than once");
        this.#fail(reason, this.#localDiagnostic(
          "configure",
          "decoder-operation",
          reason
        ));
        return;
      }
      this.#configured = value.supported;
      this.#support.resolve(value.supported);
      if (!value.supported) {
        const reason = new Error("AVAL decoder configuration is unsupported");
        this.#fail(reason, this.#localDiagnostic(
          "probe",
          "unsupported-config",
          reason
        ));
        return;
      }
      return;
    }
    if (value.t === "error") {
      this.#fail(new Error("AVAL decoder failed"), value.diagnostic);
      return;
    }
    this.#receiveRun(value);
  }

  #receiveRun(event: DecoderRunEvent): void {
    const lane = this.#lane;
    if (lane.phase === "terminal") {
      if (event.t === "frame") event.frame.close();
      return;
    }
    if (lane.phase === "idle") {
      if (event.run <= lane.generationFloor) this.#receiveStale(event);
      else this.#rejectRunEvent(event);
      return;
    }
    const generation = lane.run.generation;
    if (event.run < generation) {
      this.#receiveStale(event);
      return;
    }
    if (event.run > generation) {
      this.#rejectRunEvent(event);
      return;
    }
    if (lane.phase === "closing") {
      if (event.t === "frame") {
        event.frame.close();
        return;
      }
      if (event.t === "started") this.#recordNativeCreate(event.run);
      if (isDecoderTerminalEvent(event)) {
        this.#recordNativeClose(event.run);
        this.#settleClosed(lane.run);
      }
      // Start and acceptance may already be in flight when local close wins.
      return;
    }
    if (lane.phase === "retained") {
      const reason = new Error("AVAL decoder emitted after flush");
      if (event.t !== "frame") {
        this.#fail(reason, this.#runDiagnostic(
          "flush",
          "decoder-operation",
          reason,
          lane.run,
          event
        ));
        return;
      }
      const inspection = inspectDecoderFrameMetadata(event.frame);
      event.frame.close();
      const ordinal = lane.run.ordinal(event.timestamp);
      const outputFailure = inspection.outputFailure ??
        createDecoderOutputFailure({
          kind: ordinal === null ? "unknown-output" : "duplicate-output",
          validationLayer: "host-expectation",
          field: ordinal === null ? "timestamp" : "ordinal",
          expected: null,
          actual: observedOutputMetadata(inspection.metadata, null)
        });
      this.#fail(reason, this.#runDiagnostic(
        "output-validation",
        "invalid-output",
        reason,
        lane.run,
        event,
        outputFailure
      ));
      return;
    }
    if (event.t === "closed") {
      const reason = new Error("AVAL decoder closed an active run");
      this.#fail(reason, this.#runDiagnostic(
        "decode",
        "decoder-operation",
        reason,
        lane.run,
        event
      ));
      return;
    }
    try {
      lane.run.receive(event);
    } catch (error) {
      if (event.t === "frame") event.frame.close();
      const reason = asError(error, "AVAL decoder run failed");
      this.#fail(reason, this.#runDiagnostic(
        "decode",
        "decoder-operation",
        error,
        lane.run,
        event
      ));
      return;
    }
    if (event.t === "started") this.#recordNativeCreate(event.run);
    if (event.t === "frame") {
      this.#outputsAccepted = saturatingIncrement(this.#outputsAccepted);
    }
    if (isDecoderTerminalEvent(event)) this.#recordNativeClose(event.run);
    if (event.t === "flushed") this.#retain(lane.run);
  }

  #receiveStale(event: DecoderRunEvent): void {
    if (isDecoderTerminalEvent(event)) return;
    if (event.t === "frame") event.frame.close();
    const reason = new Error("AVAL decoder emitted a stale run event");
    this.#fail(reason, this.#localDiagnostic(
      "frame-transfer",
      "transport",
      reason,
      event.run
    ));
  }

  #rejectRunEvent(event: DecoderRunEvent): void {
    if (event.t === "frame") event.frame.close();
    const reason = new Error("AVAL decoder emitted an unexpected run event");
    this.#fail(reason, this.#localDiagnostic(
      "frame-transfer",
      "transport",
      reason,
      event.run
    ));
  }

  #settleClosed(run: DecodeRun): void {
    this.#lane = {
      phase: "idle",
      generationFloor: run.generation
    };
    this.#deleteRun(run);
    this.#runsClosed = saturatingIncrement(this.#runsClosed);
  }

  #retain(run: DecodeRun): void {
    this.#lane = { phase: "retained", run };
  }

  #closeRun(run: DecodeRun): void {
    if (
      this.#disposed ||
      this.#error !== undefined ||
      this.#lane.phase === "terminal"
    ) {
      this.#deleteRun(run);
      return;
    }
    if (this.#lane.phase === "closing" && this.#lane.run === run) return;
    if (this.#lane.phase === "retained" && this.#lane.run === run) {
      this.#lane = {
        phase: "idle",
        generationFloor: run.generation
      };
      this.#deleteRun(run);
      this.#runsClosed = saturatingIncrement(this.#runsClosed);
      return;
    }
    if (this.#lane.phase !== "running" || this.#lane.run !== run) {
      this.#deleteRun(run);
      return;
    }
    this.#lane = { phase: "closing", run };
    try {
      this.#post({ t: "close", run: run.generation });
    } catch (reason) {
      const error = asError(reason, "AVAL decoder close transport failed");
      this.#fail(error, this.#localDiagnostic(
        "flush",
        "transport",
        reason,
        run.generation
      ));
    }
  }

  #availableCredit(): number {
    return Math.max(
      0,
      ELEMENT_DECODER_CAPACITY.ringSize - (this.#run?.outstanding ?? 0)
    );
  }

  #creditChanged(): void {
    if (this.#lane.phase === "running") this.#lane.run.pump();
  }

  #post(message: DecoderCommand, transfer?: Transferable[]): void {
    if (transfer === undefined) this.#worker.postMessage(message);
    else this.#worker.postMessage(message, transfer);
  }

  #claimDecodedBytes(bytes: number): void {
    if (bytes > this.#maxDecodedBytes - this.#decodedBytes) {
      throw new RangeError("AVAL decoded surfaces exceed their byte ceiling");
    }
    const previous = this.#decodedBytes;
    this.#decodedBytes += bytes;
    try {
      this.#onDecodedBytes?.(this.#decodedBytes);
    } catch (error) {
      this.#decodedBytes = previous;
      throw error;
    }
  }

  #releaseDecodedBytes(bytes: number): void {
    if (bytes > this.#decodedBytes) {
      const reason = new Error("AVAL decoded surface accounting failed");
      this.#fail(reason, this.#localDiagnostic(
        "decode",
        "decoder-operation",
        reason
      ));
      return;
    }
    this.#decodedBytes -= bytes;
    try {
      this.#onDecodedBytes?.(this.#decodedBytes);
    } catch (error) {
      const reason = asError(error, "decoded byte observer failed");
      this.#fail(reason, this.#localDiagnostic(
        "decode",
        "decoder-operation",
        error
      ));
    }
  }

  #deleteRun(run: DecodeRun): void {
    if (this.#run !== run) return;
    this.#run = null;
    this.#encodedBytes -= run.encodedBytes;
    try { this.#onEncodedBytes?.(this.#encodedBytes); }
    catch (error) {
      const reason = asError(error, "encoded byte observer failed");
      this.#fail(reason, this.#localDiagnostic(
        "decode",
        "decoder-operation",
        error
      ));
    }
  }

  #recordNativeCreate(generation: number): void {
    if (generation <= this.#nativeCreateGenerationFloor) return;
    this.#nativeCreateGenerationFloor = generation;
    this.#nativeDecoderCreates = saturatingIncrement(this.#nativeDecoderCreates);
  }

  #recordNativeClose(generation: number): void {
    if (generation <= this.#nativeCloseGenerationFloor) return;
    this.#nativeCloseGenerationFloor = generation;
    this.#nativeDecoderCloses = saturatingIncrement(this.#nativeDecoderCloses);
  }

  #localDiagnostic(
    phase: DecoderDiagnosticPhase,
    code: DecoderDiagnosticCode,
    reason: unknown,
    run = this.#run?.generation ?? null,
    decodeOrdinal: number | null = null,
    firstFrame = this.#run?.diagnosticFirstFrame ?? null
  ): Readonly<DecoderFailureDiagnostic> {
    return createDecoderFailureDiagnostic({
      phase,
      code,
      reason,
      run,
      decodeOrdinal,
      firstFrame
    });
  }

  #runDiagnostic(
    phase: DecoderDiagnosticPhase,
    code: DecoderDiagnosticCode,
    reason: unknown,
    run: DecodeRun,
    event: DecoderRunEvent,
    outputFailure: Readonly<DecoderOutputFailure> | null = null
  ): Readonly<DecoderFailureDiagnostic> {
    return createDecoderFailureDiagnostic({
      phase,
      code,
      reason,
      run: run.generation,
      decodeOrdinal: event.t === "frame" ? run.ordinal(event.timestamp) : null,
      firstFrame: run.diagnosticFirstFrame,
      lastGoodFrame: run.diagnosticLastGoodFrame,
      outputFailure
    });
  }

  #fail(
    error = new Error("AVAL decoder failed"),
    diagnostic = this.#localDiagnostic(
      "decode",
      "decoder-operation",
      error
    )
  ): void {
    if (this.#disposed || this.#error !== undefined) return;
    const reported = decoderReportedError(error, diagnostic);
    this.#error = reported;
    this.#diagnostic = diagnostic;
    this.#failure.reject(reported);
    this.#support.reject(reported);
    const run = this.#run;
    run?.fail(reported);
    if (run !== null) this.#deleteRun(run);
    this.#lane = { phase: "terminal" };
    this.#worker.terminate();
  }
}

function decoderReportedError(
  error: Error,
  diagnostic: Readonly<DecoderFailureDiagnostic>
): Error {
  if (error instanceof DecoderLocalFailureError) return error;
  const failure = decoderLocalFailure(diagnostic);
  return failure === null ? error : new DecoderLocalFailureError(failure, error);
}

function decoderLocalFailure(
  diagnostic: Readonly<DecoderFailureDiagnostic>
): Readonly<DecoderLocalFailure> | null {
  if (diagnostic.phase === "probe") {
    if (diagnostic.code === "unsupported-config" ||
      diagnostic.code === "decoder-operation" &&
      retryableDecoderErrorName(diagnostic.exception?.name)) {
      return Object.freeze({ kind: "unsupported-config" });
    }
    return null;
  }
  if (
    diagnostic.phase === "output-validation" &&
    diagnostic.code === "invalid-output" &&
    diagnostic.outputFailure !== null
  ) {
    return Object.freeze({ kind: "decoded-metadata-incompatible" });
  }
  if (
    (diagnostic.phase === "configure" ||
      diagnostic.phase === "decode" ||
      diagnostic.phase === "flush") &&
    (diagnostic.code === "decoder-operation" ||
      diagnostic.phase === "configure" &&
      diagnostic.code === "unsupported-config")
  ) {
    const errorName = diagnostic.code === "unsupported-config"
      ? "NotSupportedError"
      : diagnostic.exception?.name;
    if (retryableDecoderErrorName(errorName)) {
      return Object.freeze({
        kind: "operation-rejected",
        phase: diagnostic.phase,
        errorName
      });
    }
  }
  return null;
}

function retryableDecoderErrorName(
  value: string | undefined
): value is "NotSupportedError" | "EncodingError" {
  return value === "NotSupportedError" || value === "EncodingError";
}

function validateSampleFrameRate(
  frameRate: Readonly<WebCodecsFrameRate>
): Readonly<WebCodecsFrameRate> {
  // Exercise the same validation used for every conversion once at setup.
  webCodecsTimingForTicks(0, 0, frameRate);
  return Object.freeze({
    numerator: frameRate.numerator,
    denominator: frameRate.denominator
  });
}

function webCodecsSampleForTicks(
  sample: Readonly<DecodeSample>,
  frameRate: Readonly<WebCodecsFrameRate>
): Readonly<DecodeSample> {
  const timing = webCodecsTimingForTicks(
    sample.timestamp,
    sample.duration,
    frameRate
  );
  if (
    Number.isSafeInteger(sample.displayedFrames) &&
    sample.displayedFrames > 1 &&
    sample.duration > 0
  ) {
    for (let order = 1; order < sample.displayedFrames; order += 1) {
      const outputTick =
        BigInt(sample.timestamp) + BigInt(sample.duration) * BigInt(order);
      if (outputTick > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new RangeError("multi-frame decoder timing exceeds the safe-integer range");
      }
      const output = webCodecsTimingForTicks(
        Number(outputTick),
        sample.duration,
        frameRate
      );
      if (
        output.timestamp !== timing.timestamp + timing.duration * order ||
        output.duration !== timing.duration
      ) {
        throw new RangeError(
          "multi-frame decoder timing cannot be represented by one WebCodecs chunk"
        );
      }
    }
  }
  return Object.freeze({ ...sample, ...timing });
}

export class DecodeRun {
  readonly #id: number;
  readonly #samples: readonly Readonly<DecodeSample>[];
  readonly #expectation: DecoderOutputExpectation;
  readonly #VideoFrame: typeof globalThis.VideoFrame;
  readonly #post: (message: DecoderCommand, transfer?: Transferable[]) => void;
  readonly #credit: () => number;
  readonly #creditChanged: () => void;
  readonly #claimBytes: (bytes: number) => void;
  readonly #releaseBytes: (bytes: number) => void;
  readonly #retire: () => void;
  readonly #fatal: (
    error: Error,
    diagnostic: Readonly<DecoderFailureDiagnostic>
  ) => void;
  readonly #setTimeout: (callback: () => void, delay: number) => number;
  readonly #clearTimeout: (handle: number) => void;
  readonly #frames = new Map<number, VideoFrame>();
  readonly #leased = new Map<VideoFrame, number>();
  readonly #frameBytes = new Map<VideoFrame, number>();
  readonly #owned = new WeakSet<VideoFrame>();
  readonly #outputs = new Map<number, Readonly<{
    index: number;
    sample: number;
    duration: number;
  }>>();
  readonly #seen = new Set<number>();
  readonly #taken = new Set<number>();
  readonly #waiters = new Set<() => void>();
  #nextSample = 0;
  #received = 0;
  #outstanding = 0;
  #openBytes = 0;
  #activated = false;
  #started = false;
  #batchInFlight = false;
  #flushSent = false;
  #flushed = false;
  #closed = false;
  #error: Error | undefined;
  #progressTimer: number | undefined;
  #firstFrame: Readonly<DecoderFrameMetadata> | null = null;
  #lastGoodFrame: Readonly<DecoderFrameMetadata> | null = null;

  public readonly frameCount: number;
  public readonly encodedBytes: number;

  public constructor(
    id: number,
    samples: readonly Readonly<DecodeSample>[],
    expectation: Readonly<DecoderOutputExpectation>,
    VideoFrameConstructor: typeof globalThis.VideoFrame,
    post: (message: DecoderCommand, transfer?: Transferable[]) => void,
    credit: () => number,
    creditChanged: () => void,
    claimBytes: (bytes: number) => void,
    releaseBytes: (bytes: number) => void,
    retire: () => void,
    fatal: (
      error: Error,
      diagnostic: Readonly<DecoderFailureDiagnostic>
    ) => void,
    setTimeout: (callback: () => void, delay: number) => number,
    clearTimeout: (handle: number) => void
  ) {
    if (!Number.isSafeInteger(id) || id < 1) throw new RangeError("invalid decoder run");
    this.#id = id;
    this.#samples = Object.freeze(samples.map((sample) => Object.freeze({ ...sample })));
    this.#expectation = expectation;
    this.#VideoFrame = VideoFrameConstructor;
    this.#post = post;
    this.#credit = credit;
    this.#creditChanged = creditChanged;
    this.#claimBytes = claimBytes;
    this.#releaseBytes = releaseBytes;
    this.#retire = retire;
    this.#fatal = fatal;
    this.#setTimeout = setTimeout;
    this.#clearTimeout = clearTimeout;
    const outputs: Array<{ timestamp: number; sample: number; duration: number }> = [];
    const buffers = new Set<ArrayBuffer>();
    let encodedBytes = 0;
    if (this.#samples.length > 0 && !this.#samples[0]!.key) {
      throw new RangeError("decoder run must begin with a key chunk");
    }
    for (let sampleIndex = 0; sampleIndex < this.#samples.length; sampleIndex += 1) {
      const sample = this.#samples[sampleIndex]!;
      validateSample(sample, buffers);
      if (sample.data.byteLength > MAX_BYTES - encodedBytes) {
        throw new RangeError("decoder encoded copies exceed their byte ceiling");
      }
      encodedBytes += sample.data.byteLength;
      for (let order = 0; order < sample.displayedFrames; order += 1) {
        const timestamp = sample.timestamp + sample.duration * order;
        if (!Number.isSafeInteger(timestamp)) throw new RangeError("unsafe frame timestamp");
        outputs.push({ timestamp, sample: sampleIndex, duration: sample.duration });
      }
    }
    outputs.sort((left, right) => left.timestamp - right.timestamp);
    for (let index = 0; index < outputs.length; index += 1) {
      const output = outputs[index]!;
      if (this.#outputs.has(output.timestamp)) {
        throw new RangeError("duplicate frame timestamp");
      }
      this.#outputs.set(output.timestamp, Object.freeze({
        index,
        sample: output.sample,
        duration: output.duration
      }));
    }
    this.encodedBytes = encodedBytes;
    this.frameCount = outputs.length;
  }

  public get generation(): number { return this.#id; }
  public get openFrames(): number { return this.#frames.size + this.#leased.size; }
  public get outstanding(): number { return this.#outstanding; }
  public get closed(): boolean { return this.#closed; }
  public get diagnosticFirstFrame(): Readonly<DecoderFrameMetadata> | null {
    return this.#firstFrame;
  }
  public get diagnosticLastGoodFrame(): Readonly<DecoderFrameMetadata> | null {
    return this.#lastGoodFrame;
  }

  public ordinal(timestamp: number): number | null {
    return this.#outputs.get(timestamp)?.index ?? null;
  }

  public activate(): void {
    if (this.#activated || this.#closed) return;
    this.#activated = true;
    this.#updateProgressWatchdog(true);
  }

  public receive(event: DecoderRunEvent): void {
    if (this.#closed) {
      if (event.t === "frame") event.frame.close();
      return;
    }
    if (event.t === "started") {
      if (this.#started) {
        this.#failOperation(
          new Error("duplicate decoder start"),
          "configure",
          "decoder-operation"
        );
      }
      this.#started = true;
      this.pump();
      this.#updateProgressWatchdog(true);
      return;
    }
    if (event.t === "accepted") {
      if (!this.#batchInFlight) {
        this.#failOperation(
          new Error("unexpected decoder acceptance"),
          "decode",
          "decoder-operation"
        );
      }
      this.#batchInFlight = false;
      this.pump();
      this.#updateProgressWatchdog(true);
      return;
    }
    if (event.t === "flushed") {
      if (
        !this.#flushSent ||
        this.#batchInFlight ||
        this.#nextSample !== this.#samples.length ||
        this.#received !== this.frameCount
      ) {
        const outputFailure = this.#outputFailure(
          "incomplete-output",
          "frame-count",
          null,
          this.#received,
          this.frameCount
        );
        this.#failOperation(
          new Error("AVAL decoder output is incomplete"),
          "output-validation",
          "invalid-output",
          this.#nextOutputOrdinal(),
          outputFailure
        );
      }
      this.#flushed = true;
      this.#clearProgressWatchdog();
      this.#wake();
      return;
    }
    if (event.t === "closed") {
      this.#clearProgressWatchdog();
      return;
    }
    const inspection = inspectDecoderFrameMetadata(event.frame);
    if (inspection.metadata === null) {
      this.#failOperation(
        new Error("AVAL decoder returned malformed output metadata"),
        "output-validation",
        "invalid-output",
        this.ordinal(event.timestamp),
        inspection.outputFailure
      );
    }
    let frameMetadata = inspection.metadata;
    const expected = this.#outputs.get(event.timestamp);
    if (expected === undefined) {
      this.#failOperation(
        new Error("AVAL decoder returned an unknown frame"),
        "output-validation",
        "invalid-output",
        null,
        this.#outputFailure(
          "unknown-output",
          "timestamp",
          frameMetadata,
          null,
          null
        )
      );
    }
    if (this.#seen.has(event.timestamp) || this.#frames.has(expected.index)) {
      this.#failOperation(
        new Error("duplicate decoded frame"),
        "output-validation",
        "invalid-output",
        expected.index,
        this.#outputFailure(
          "duplicate-output",
          "ordinal",
          frameMetadata,
          null,
          null,
          expected.duration
        )
      );
    }
    if (expected.sample >= this.#nextSample || this.#outstanding < 1) {
      this.#failOperation(
        new Error("AVAL decoder returned an unknown frame"),
        "output-validation",
        "invalid-output",
        expected.index,
        this.#outputFailure(
          "unknown-output",
          "ordinal",
          frameMetadata,
          null,
          null,
          expected.duration
        )
      );
    }
    let outputFrame = event.frame;
    if (
      expected.duration > 0 &&
      (frameMetadata.duration === null || frameMetadata.duration === 0)
    ) {
      const repaired = repairMissingFrameDuration(
        event.frame,
        event.timestamp,
        expected.duration,
        this.#VideoFrame
      );
      if (repaired !== null) {
        outputFrame = repaired.frame;
        frameMetadata = repaired.metadata;
      }
    }
    let frameBytes: number;
    try {
      frameBytes = validateFrame(
        outputFrame,
        event.timestamp,
        expected.duration,
        this.#expectation,
        frameMetadata
      );
    } catch (reason) {
      if (outputFrame !== event.frame) outputFrame.close();
      const validation = reason instanceof DecoderFrameValidationError
        ? reason
        : new DecoderFrameValidationError(
            "coded-allocation",
            "allocation",
            asError(reason, "AVAL decoder returned an invalid frame")
          );
      this.#failOperation(
        validation.reason,
        "output-validation",
        "invalid-output",
        expected.index,
        this.#outputFailure(
          validation.kind,
          validation.field,
          frameMetadata,
          null,
          null,
          expected.duration
        )
      );
    }
    try {
      this.#claimBytes(frameBytes);
    } catch (reason) {
      if (outputFrame !== event.frame) outputFrame.close();
      this.#failOperation(
        asError(reason, "AVAL decoder could not retain an output frame"),
        "decode",
        "decoder-operation",
        expected.index
      );
    }
    try {
      this.#seen.add(event.timestamp);
      this.#frames.set(expected.index, outputFrame);
      this.#frameBytes.set(outputFrame, frameBytes);
      this.#openBytes += frameBytes;
      this.#received += 1;
      this.#firstFrame ??= frameMetadata;
      this.#lastGoodFrame = frameMetadata;
    } catch (error) {
      this.#seen.delete(event.timestamp);
      this.#frames.delete(expected.index);
      this.#frameBytes.delete(outputFrame);
      if (outputFrame !== event.frame) outputFrame.close();
      this.#releaseBytes(frameBytes);
      throw error;
    }
    this.#updateProgressWatchdog(true);
    this.#wake();
  }

  public async ready(
    minimum = Math.min(
      ELEMENT_DECODER_CAPACITY.candidateReadyFrames,
      this.frameCount
    )
  ): Promise<void> {
    const target = Math.max(0, Math.min(minimum, this.frameCount));
    await this.#wait(() => {
      for (let index = 0; index < target; index += 1) {
        if (!this.#frames.has(index) && !this.#taken.has(index)) return false;
      }
      return true;
    });
  }

  public async take(index: number): Promise<VideoFrame> {
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.frameCount) {
      throw new RangeError("decoded frame index is out of range");
    }
    if (this.#taken.has(index)) throw new Error("decoded frame was already taken");
    await this.#wait(() => this.#frames.has(index));
    if (this.#taken.has(index)) throw new Error("decoded frame was already taken");
    const frame = this.#frames.get(index);
    if (frame === undefined) throw abortError();
    this.#taken.add(index);
    this.#frames.delete(index);
    this.#leased.set(frame, index);
    this.#owned.add(frame);
    return frame;
  }

  /** Closes a taken frame and returns its decoder-surface credit. */
  public release(frame: VideoFrame): void {
    if (!this.#owned.has(frame)) throw new Error("decoded frame is not owned by this run");
    if (!this.#leased.has(frame)) return;
    const frameBytes = this.#frameBytes.get(frame);
    if (frameBytes === undefined) throw new Error("decoded frame bytes are unavailable");
    this.#leased.delete(frame);
    this.#frameBytes.delete(frame);
    try {
      frame.close();
    } finally {
      this.#outstanding -= 1;
      this.#openBytes -= frameBytes;
      this.#releaseBytes(frameBytes);
      this.#creditChanged();
    }
  }

  public async complete(): Promise<void> {
    await this.#wait(() => this.#flushed);
  }

  public fail(error = new Error("AVAL decoder failed")): void {
    if (this.#closed) return;
    this.#error = error;
    this.#closed = true;
    this.#clearProgressWatchdog();
    this.#releaseFrames();
    this.#wake();
    this.#retire();
  }

  public close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#error = abortError();
    this.#clearProgressWatchdog();
    this.#releaseFrames();
    this.#wake();
    this.#retire();
  }

  public pump(): void {
    if (!this.#started || this.#closed || this.#batchInFlight || this.#flushSent) {
      this.#updateProgressWatchdog(false);
      return;
    }
    const chunks: DecoderChunk[] = [];
    const transfer: Transferable[] = [];
    let reserved = 0;
    const available = this.#credit();
    while (
      this.#nextSample < this.#samples.length &&
      chunks.length < ELEMENT_DECODER_CAPACITY.ringSize
    ) {
      const sample = this.#samples[this.#nextSample]!;
      if (sample.displayedFrames > available - reserved) break;
      this.#nextSample += 1;
      reserved += sample.displayedFrames;
      chunks.push({
        data: sample.data,
        timestamp: sample.timestamp,
        duration: sample.duration,
        key: sample.key
      });
      transfer.push(sample.data);
    }
    if (chunks.length > 0) {
      this.#outstanding += reserved;
      this.#batchInFlight = true;
      try {
        this.#post({ t: "decode", run: this.#id, chunks }, transfer);
      } catch (reason) {
        this.#batchInFlight = false;
        this.#outstanding -= reserved;
        const error = asError(reason, "AVAL decoder chunk transport failed");
        this.#fatal(error, this.#diagnostic(
          "frame-transfer",
          "transport",
          reason,
          this.#nextOutputOrdinal()
        ));
      }
      this.#updateProgressWatchdog(true);
      return;
    }
    if (this.#nextSample === this.#samples.length) {
      this.#flushSent = true;
      try {
        this.#post({ t: "flush", run: this.#id });
      } catch (reason) {
        const error = asError(reason, "AVAL decoder flush transport failed");
        this.#fatal(error, this.#diagnostic(
          "frame-transfer",
          "transport",
          reason,
          null
        ));
      }
      this.#updateProgressWatchdog(true);
      return;
    }
    this.#updateProgressWatchdog(false);
  }

  async #wait(predicate: () => boolean): Promise<void> {
    while (!predicate()) {
      if (this.#error !== undefined) throw this.#error;
      await new Promise<void>((resolve) => {
        this.#waiters.add(resolve);
        this.#updateProgressWatchdog(true);
      });
      if (this.#error !== undefined) throw this.#error;
    }
    this.#updateProgressWatchdog(false);
  }

  #releaseFrames(): void {
    for (const frame of this.#frames.values()) frame.close();
    for (const frame of this.#leased.keys()) frame.close();
    this.#frames.clear();
    this.#leased.clear();
    this.#frameBytes.clear();
    const openBytes = this.#openBytes;
    this.#openBytes = 0;
    this.#outstanding = 0;
    if (openBytes > 0) this.#releaseBytes(openBytes);
    this.#creditChanged();
  }

  #updateProgressWatchdog(refresh: boolean): void {
    // A ready prefetched run may intentionally park reordered frames until it
    // becomes visible. Only a caller awaiting progress owns a timeout.
    const waiting = this.#waiters.size > 0 &&
      this.#activated && !this.#closed && !this.#flushed && (
      !this.#started ||
      this.#batchInFlight ||
      this.#flushSent ||
      this.#outstanding > this.openFrames
    );
    if (!waiting) {
      this.#clearProgressWatchdog();
      return;
    }
    if (!refresh && this.#progressTimer !== undefined) return;
    this.#clearProgressWatchdog();
    this.#progressTimer = this.#setTimeout(() => {
      this.#progressTimer = undefined;
      const error = decodeTimeout();
      this.#fatal(error, this.#diagnostic(
        this.#flushSent ? "flush" : "decode",
        "watchdog-timeout",
        error,
        this.#nextOutputOrdinal()
      ));
    }, PROGRESS_MS);
  }

  #clearProgressWatchdog(): void {
    if (this.#progressTimer !== undefined) this.#clearTimeout(this.#progressTimer);
    this.#progressTimer = undefined;
  }

  #wake(): void {
    for (const resolve of this.#waiters) resolve();
    this.#waiters.clear();
  }

  #nextOutputOrdinal(): number | null {
    for (const [timestamp, output] of this.#outputs) {
      if (!this.#seen.has(timestamp)) return output.index;
    }
    return null;
  }

  #outputFailure(
    kind: DecoderOutputFailureKind,
    field: DecoderOutputField,
    actualFrame: Readonly<DecoderFrameMetadata> | null,
    receivedFrameCount: number | null,
    expectedFrameCount: number | null,
    expectedDuration?: number
  ): Readonly<DecoderOutputFailure> {
    const expected = expectedDuration === undefined && expectedFrameCount === null
      ? null
      : expectedOutputMetadata(
          this.#expectation,
          actualFrame?.timestamp ?? null,
          expectedDuration ?? null,
          expectedFrameCount
        );
    return createDecoderOutputFailure({
      kind,
      validationLayer: "host-expectation",
      field,
      expected,
      actual: observedOutputMetadata(actualFrame, receivedFrameCount)
    });
  }

  #diagnostic(
    phase: DecoderDiagnosticPhase,
    code: DecoderDiagnosticCode,
    reason: unknown,
    decodeOrdinal: number | null,
    outputFailure: Readonly<DecoderOutputFailure> | null = null
  ): Readonly<DecoderFailureDiagnostic> {
    return createDecoderFailureDiagnostic({
      phase,
      code,
      reason,
      run: this.#id,
      decodeOrdinal,
      firstFrame: this.#firstFrame,
      lastGoodFrame: this.#lastGoodFrame,
      outputFailure
    });
  }

  #failOperation(
    error: Error,
    phase: DecoderDiagnosticPhase,
    code: DecoderDiagnosticCode,
    decodeOrdinal: number | null = null,
    outputFailure: Readonly<DecoderOutputFailure> | null = null
  ): never {
    this.#fatal(error, this.#diagnostic(
      phase,
      code,
      error,
      decodeOrdinal,
      outputFailure
    ));
    throw error;
  }
}

function validateSample(sample: Readonly<DecodeSample>, buffers: Set<ArrayBuffer>): void {
  if (
    !(sample.data instanceof ArrayBuffer) ||
    sample.data.byteLength < 1 ||
    buffers.has(sample.data) ||
    !Number.isSafeInteger(sample.timestamp) ||
    sample.timestamp < 0 ||
    !Number.isSafeInteger(sample.duration) ||
    sample.duration < 0 ||
    !Number.isSafeInteger(sample.displayedFrames) ||
    sample.displayedFrames < 0 ||
    sample.displayedFrames > ELEMENT_DECODER_CAPACITY.ringSize ||
    sample.displayedFrames > 0 && sample.duration === 0 ||
    typeof sample.key !== "boolean"
  ) throw new RangeError("invalid decoder sample");
  buffers.add(sample.data);
}

class DecoderFrameValidationError extends Error {
  public constructor(
    public readonly kind: DecoderOutputFailureKind,
    public readonly field: DecoderOutputField,
    public readonly reason = new Error("AVAL decoder returned an invalid frame")
  ) {
    super(reason.message);
    this.name = "DecoderFrameValidationError";
  }
}

function repairMissingFrameDuration(
  frame: VideoFrame,
  timestamp: number,
  duration: number,
  VideoFrameConstructor: typeof globalThis.VideoFrame
): Readonly<{
  frame: VideoFrame;
  metadata: Readonly<DecoderFrameMetadata>;
}> | null {
  // WebCodecs says decoded duration is copied from its EncodedVideoChunk, but
  // Safari HEVC can intermittently elide it. Re-wrap only missing metadata;
  // every non-zero mismatch still reaches strict validation unchanged.
  let repaired: VideoFrame | null = null;
  try {
    repaired = new VideoFrameConstructor(frame, { duration });
    if (repaired === frame) return null;
    const inspection = inspectDecoderFrameMetadata(repaired);
    if (
      inspection.metadata === null ||
      inspection.metadata.timestamp !== timestamp ||
      inspection.metadata.duration !== duration
    ) {
      repaired.close();
      return null;
    }
    frame.close();
    return Object.freeze({ frame: repaired, metadata: inspection.metadata });
  } catch {
    if (repaired !== null && repaired !== frame) repaired.close();
    return null;
  }
}

function validateFrame(
  frame: VideoFrame,
  timestamp: number,
  duration: number,
  expected: Readonly<DecoderOutputExpectation>,
  metadata: Readonly<DecoderFrameMetadata>
): number {
  const rect = frame.visibleRect;
  if (metadata.timestamp !== timestamp) {
    throw new DecoderFrameValidationError("timing", "timestamp");
  }
  if (metadata.duration !== duration) {
    throw new DecoderFrameValidationError("timing", "duration");
  }
  if (!sameAspectRatio(
    metadata.displayWidth,
    metadata.displayHeight,
    expected.displayWidth,
    expected.displayHeight
  )) {
    throw new DecoderFrameValidationError("display-aspect", "display-aspect");
  }
  if (rect === null ||
    rect.width !== expected.visibleRect.width ||
    rect.height !== expected.visibleRect.height ||
    rect.x > metadata.codedWidth - rect.width ||
    rect.y > metadata.codedHeight - rect.height) {
    throw new DecoderFrameValidationError("visible-rect", "visible-rect");
  }
  const expectedColor = decoderExpectedColorTuple(expected.colorSpace);
  const actualColor = decoderColorTuple(frame.colorSpace);
  if (classifyDecoderColor(expectedColor, actualColor).kind === "incompatible") {
    throw new DecoderFrameValidationError("color-space", "color-space");
  }
  try {
    return decodedFrameBytes(metadata.codedWidth, metadata.codedHeight);
  } catch (reason) {
    throw new DecoderFrameValidationError(
      "coded-allocation",
      "allocation",
      asError(reason, "AVAL decoder returned an unsafe coded allocation")
    );
  }
}

function expectedOutputMetadata(
  expectation: Readonly<DecoderOutputExpectation>,
  timestamp: number | null,
  duration: number | null,
  frameCount: number | null
): Readonly<DecoderExpectedOutputMetadata> {
  return Object.freeze({
    timestamp,
    duration,
    codedWidth: expectation.codedWidth,
    codedHeight: expectation.codedHeight,
    displayAspectWidth: expectation.displayWidth,
    displayAspectHeight: expectation.displayHeight,
    visibleRect: Object.freeze({ ...expectation.visibleRect }),
    colorSpace: expectationColorSpaceMetadata(expectation.colorSpace),
    frameCount
  });
}

function observedOutputMetadata(
  metadata: Readonly<DecoderFrameMetadata> | null,
  receivedFrameCount: number | null
): Readonly<DecoderObservedFrameMetadata> {
  return Object.freeze({
    timestamp: metadata?.timestamp ?? null,
    duration: metadata?.duration ?? null,
    codedWidth: metadata?.codedWidth ?? null,
    codedHeight: metadata?.codedHeight ?? null,
    displayWidth: metadata?.displayWidth ?? null,
    displayHeight: metadata?.displayHeight ?? null,
    visibleRect: metadata?.visibleRect === null || metadata === null
      ? null
      : Object.freeze({ ...metadata.visibleRect }),
    colorSpace: metadata?.colorSpace === null || metadata === null
      ? null
      : Object.freeze([...metadata.colorSpace]) as DecoderObservedFrameMetadata["colorSpace"],
    receivedFrameCount
  });
}

function expectationColorSpaceMetadata(
  colorSpace: DecoderOutputExpectation["colorSpace"]
): DecoderExpectedOutputMetadata["colorSpace"] {
  if (colorSpace === null) return null;
  return Object.freeze([
    colorSpace.primaries,
    colorSpace.transfer,
    colorSpace.matrix,
    colorSpace.fullRange
  ]);
}

function decodedFrameBytes(width: number, height: number): number {
  if (width > Math.floor(MAX_BYTES / height)) {
    throw new Error("AVAL decoder returned an unsafe coded allocation");
  }
  const pixels = width * height;
  if (pixels > Math.floor(MAX_BYTES / 4)) {
    throw new Error("AVAL decoder returned an unsafe coded allocation");
  }
  return pixels * 4;
}

function decoderExpectedColorTuple(
  colorSpace: DecoderOutputExpectation["colorSpace"]
): Readonly<DecoderColorTuple> {
  return colorSpace === null ? DEFAULT_DECODER_COLOR : decoderColorTuple(colorSpace);
}

function decoderColorTuple(colorSpace: Readonly<{
  readonly fullRange: boolean | null;
  readonly matrix: VideoMatrixCoefficients | null;
  readonly primaries: VideoColorPrimaries | null;
  readonly transfer: VideoTransferCharacteristics | null;
}>): DecoderColorTuple {
  return [
    colorSpace.primaries,
    colorSpace.transfer,
    colorSpace.matrix,
    colorSpace.fullRange
  ];
}

function defaultExpectation(
  config: Readonly<VideoDecoderConfig>
): DecoderOutputExpectation {
  const codedWidth = config.codedWidth;
  const codedHeight = config.codedHeight;
  if (
    codedWidth === undefined ||
    codedHeight === undefined ||
    !positive(codedWidth) ||
    !positive(codedHeight)
  ) {
    throw new RangeError("decoder configuration requires coded dimensions");
  }
  const displayWidth = config.displayAspectWidth ?? codedWidth;
  const displayHeight = config.displayAspectHeight ?? codedHeight;
  const color = config.colorSpace;
  return {
    codedWidth,
    codedHeight,
    displayWidth,
    displayHeight,
    visibleRect: { x: 0, y: 0, width: displayWidth, height: displayHeight },
    colorSpace: color === undefined ? null : {
      fullRange: color.fullRange ?? null,
      matrix: color.matrix ?? null,
      primaries: color.primaries ?? null,
      transfer: color.transfer ?? null
    }
  };
}

function validateExpectation(
  value: Readonly<DecoderOutputExpectation>
): DecoderOutputExpectation {
  const rect = value.visibleRect;
  if (
    !positive(value.codedWidth) ||
    !positive(value.codedHeight) ||
    !positive(value.displayWidth) ||
    !positive(value.displayHeight) ||
    !Number.isSafeInteger(rect.x) ||
    rect.x < 0 ||
    !Number.isSafeInteger(rect.y) ||
    rect.y < 0 ||
    !positive(rect.width) ||
    !positive(rect.height) ||
    rect.x > value.codedWidth - rect.width ||
    rect.y > value.codedHeight - rect.height
  ) throw new RangeError("invalid decoder output expectation");
  return Object.freeze({
    codedWidth: value.codedWidth,
    codedHeight: value.codedHeight,
    displayWidth: value.displayWidth,
    displayHeight: value.displayHeight,
    visibleRect: Object.freeze({ ...rect }),
    colorSpace: value.colorSpace === null ? null : Object.freeze({ ...value.colorSpace })
  });
}

function positive(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function closeTransferredFrame(
  value: unknown,
  VideoFrameConstructor: typeof globalThis.VideoFrame
): void {
  if (
    typeof value === "object" &&
    value !== null &&
    "frame" in value &&
    value.frame instanceof VideoFrameConstructor
  ) value.frame.close();
}

function captureFrameMetadata(
  frame: VideoFrame
): Readonly<DecoderFrameMetadata> | null {
  try { return captureDecoderFrameMetadata(frame); }
  catch { return null; }
}

function workerErrorReason(event: Event): Error {
  try {
    if ("error" in event && event.error instanceof Error) return event.error;
    if ("message" in event && typeof event.message === "string") {
      return new Error(event.message || "AVAL decoder worker failed");
    }
  } catch { /* use stable terminal reason */ }
  return new Error("AVAL decoder worker failed");
}

function asError(reason: unknown, message: string): Error {
  return reason instanceof Error ? reason : new Error(message);
}

function deferred<T>(): Readonly<{
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function abortError(): Error {
  return new DOMException("AVAL decoder operation was aborted", "AbortError");
}

function decodeTimeout(): Error {
  return new DOMException("AVAL decoder made no progress", "TimeoutError");
}
