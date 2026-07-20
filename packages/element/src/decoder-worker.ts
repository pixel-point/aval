import {
  createDecoderOutputFailure,
  createDecoderFailureDiagnostic,
  inspectDecoderFrameMetadata,
  type DecoderDiagnosticCode,
  type DecoderDiagnosticPhase,
  type DecoderFailureDiagnostic,
  type DecoderFrameMetadata,
  type DecoderOutputFailure
} from "./decoder-diagnostics.js";
import {
  DECODER_RING_SIZE,
  isDecoderCommand,
  type DecoderChunk,
  type DecoderCommand,
  type DecoderWorkerEvent
} from "./decoder-protocol.js";
import { isPlainRecord } from "./plain-record.js";

interface WorkerPort {
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<unknown>) => void
  ): void;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}

type Session = Readonly<{
  config: VideoDecoderConfig;
  generationFloor: number;
}>;

type BrowserVideoDecoderConfig = VideoDecoderConfig & Readonly<{
  rotation?: unknown;
  flip?: unknown;
}>;

type OwnedRunState = Readonly<{
  session: Session;
  run: number;
  decoder: VideoDecoder;
}>;

type ReadyState = OwnedRunState & Readonly<{ phase: "ready" }>;
type AcceptingState = OwnedRunState & Readonly<{
  phase: "accepting";
  pending: DecoderChunk[];
}>;
type FlushingState = OwnedRunState & Readonly<{
  phase: "flushing";
  completion: Promise<void>;
}>;
type ClosingState = OwnedRunState & Readonly<{
  phase: "closing";
  completion: Promise<void>;
}>;

type WorkerState =
  | Readonly<{ phase: "unconfigured" }>
  | Readonly<{ phase: "configuring" }>
  | Readonly<{ phase: "idle"; session: Session }>
  | ReadyState
  | AcceptingState
  | FlushingState
  | ClosingState
  | Readonly<{ phase: "terminal" }>;

const port = globalThis as unknown as WorkerPort;
const CLOSE_MS = 2_000;
const VIDEO_CONFIG_KEYS = new Set<string>([
  "codec",
  "codedWidth",
  "codedHeight",
  "displayAspectWidth",
  "displayAspectHeight",
  "colorSpace",
  "hardwareAcceleration",
  "optimizeForLatency",
  "rotation",
  "flip"
]);
let state: WorkerState = { phase: "unconfigured" };
let nextDecodeOrdinal = 0;
const decodeOrdinalsByTimestamp = new Map<number, number[]>();
let retainedDecodeOrdinalCount = 0;
let firstFrame: Readonly<DecoderFrameMetadata> | null = null;
let lastGoodFrame: Readonly<DecoderFrameMetadata> | null = null;

port.addEventListener("message", (event) => {
  if (state.phase === "terminal") return;
  if (!isDecoderCommand(event.data)) {
    const context = diagnosticContextForState(state);
    fail(
      context.phase,
      "transport",
      null,
      context.run,
      null
    );
    return;
  }
  try { handle(event.data); }
  catch (error) {
    const context = diagnosticContextForCommand(event.data);
    fail(
      context.phase,
      "decoder-operation",
      error,
      context.run,
      null
    );
  }
});

function handle(command: DecoderCommand): void {
  if (command.t === "configure") {
    configure(command.config);
    return;
  }
  if (command.t === "start") {
    start(command.run);
    return;
  }
  if (command.t === "decode") {
    decode(command.run, command.chunks);
    return;
  }
  if (command.t === "flush") {
    flush(command.run);
    return;
  }
  if (command.t === "close") {
    close(command.run);
    return;
  }
  if (command.t === "dispose") {
    dispose();
    return;
  }
  command satisfies never;
}

function configure(config: VideoDecoderConfig): void {
  if (state.phase !== "unconfigured") throw new Error();
  const configuring: WorkerState = { phase: "configuring" };
  state = configuring;
  void VideoDecoder.isConfigSupported(config).then(
    (result) => {
      if (state !== configuring) return;
      try {
        if (!result.supported) {
          emit({ t: "configured", supported: false });
          state = { phase: "terminal" };
          return;
        }
        const validatedConfig = validateSupportConfigEcho(
          config,
          result.config
        );
        if (validatedConfig === null) {
          fail("probe", "unsupported-config", null, null, null);
          return;
        }
        state = {
          phase: "idle",
          session: {
            config: validatedConfig,
            generationFloor: 0
          }
        };
        emit({ t: "configured", supported: true });
      } catch (error) {
        fail("probe", "decoder-operation", error, null, null);
      }
    },
    (error) => fail("probe", "decoder-operation", error, null, null)
  );
}

function start(run: number): void {
  if (state.phase !== "idle" || run <= state.session.generationFloor) {
    throw new Error();
  }
  const session = state.session;
  resetRunEvidence();
  let owned!: VideoDecoder;
  owned = new VideoDecoder({
    output: (frame) => output(run, owned, frame),
    error: (error) => decoderError(run, owned, error)
  });
  const ready: ReadyState = {
    phase: "ready",
    session,
    run,
    decoder: owned
  };
  state = ready;
  owned.addEventListener("dequeue", () => pump(run, owned));
  owned.configure(session.config);
  emit({ t: "started", run });
}

function decode(run: number, chunks: readonly DecoderChunk[]): void {
  const ready = requireReady(run);
  const accepting: AcceptingState = {
    phase: "accepting",
    session: ready.session,
    run,
    decoder: ready.decoder,
    pending: [...chunks]
  };
  state = accepting;
  pump(run, ready.decoder);
}

function flush(run: number): void {
  const ready = requireReady(run);
  const completion = ready.decoder.flush();
  const flushing: FlushingState = {
    phase: "flushing",
    session: ready.session,
    run,
    decoder: ready.decoder,
    completion
  };
  state = flushing;
  void completion.then(
    () => finishFlush(flushing),
    (error) => {
      if (state === flushing) {
        fail(
          "flush",
          "decoder-operation",
          error,
          flushing.run,
          null
        );
      }
    }
  );
}

function close(run: number): void {
  const current = state;
  if (current.phase === "idle") {
    if (run <= current.session.generationFloor) return;
    throw new Error();
  }
  if (!ownsRun(current)) throw new Error();
  if (run < current.run) return;
  if (run > current.run) throw new Error();
  if (current.phase === "closing") return;
  const completion = current.phase === "flushing"
    ? current.completion
    : current.decoder.flush();
  beginClose(current, completion);
}

function output(run: number, owned: VideoDecoder, frame: VideoFrame): void {
  if (!ownsLiveDecoder(state, run, owned)) {
    closeFrame(frame);
    return;
  }
  const inspection = inspectDecoderFrameMetadata(frame);
  if (inspection.metadata === null) {
    const decodeOrdinal = takeFrameDecodeOrdinal(frame);
    closeFrame(frame);
    fail(
      "output-validation",
      "invalid-output",
      new TypeError("invalid decoder output metadata"),
      run,
      decodeOrdinal,
      inspection.outputFailure
    );
    return;
  }
  const metadata = inspection.metadata;
  const decodeOrdinal = takeDecodeOrdinal(metadata.timestamp);
  firstFrame ??= metadata;
  try {
    emit({ t: "frame", run, timestamp: metadata.timestamp, frame }, [frame]);
    lastGoodFrame = metadata;
  } catch (error) {
    closeFrame(frame);
    fail(
      "frame-transfer",
      "transport",
      error,
      run,
      decodeOrdinal
    );
  }
}

function pump(run: number, owned: VideoDecoder): void {
  const accepting = state;
  if (
    accepting.phase !== "accepting" ||
    accepting.run !== run ||
    accepting.decoder !== owned
  ) return;
  while (
    accepting.pending.length > 0 &&
    owned.decodeQueueSize < DECODER_RING_SIZE
  ) {
    const chunk = accepting.pending.shift()!;
    const decodeOrdinal = nextDecodeOrdinal;
    nextDecodeOrdinal += 1;
    try {
      retainDecodeOrdinal(chunk.timestamp, decodeOrdinal);
      owned.decode(new EncodedVideoChunk({
        type: chunk.key ? "key" : "delta",
        timestamp: chunk.timestamp,
        duration: chunk.duration,
        data: chunk.data
      }));
    } catch (error) {
      releaseDecodeOrdinal(chunk.timestamp, decodeOrdinal);
      fail(
        "decode",
        "decoder-operation",
        error,
        run,
        decodeOrdinal
      );
      return;
    }
  }
  if (accepting.pending.length === 0) {
    try {
      state = {
        phase: "ready",
        session: accepting.session,
        run,
        decoder: owned
      };
      emit({ t: "accepted", run });
    } catch (error) {
      fail("decode", "decoder-operation", error, run, null);
    }
  }
}

function finishFlush(flushing: FlushingState): void {
  if (state !== flushing) return;
  try {
    retire(flushing.decoder);
    state = idleAfter(flushing);
    emit({ t: "flushed", run: flushing.run });
    resetRunEvidence();
  } catch (error) {
    fail(
      "flush",
      "decoder-operation",
      error,
      flushing.run,
      null
    );
  }
}

function beginClose(
  owner: ReadyState | AcceptingState | FlushingState,
  completion: Promise<void>
): void {
  const closing: ClosingState = {
    phase: "closing",
    session: owner.session,
    run: owner.run,
    decoder: owner.decoder,
    completion
  };
  state = closing;
  let settled = false;
  let timer: ReturnType<typeof setTimeout>;
  const finish = (): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (state !== closing) return;
    try {
      retire(closing.decoder);
      state = idleAfter(closing);
      emit({ t: "closed", run: closing.run });
      resetRunEvidence();
    } catch (error) {
      fail(
        "flush",
        "decoder-operation",
        error,
        closing.run,
        null
      );
    }
  };
  const reject = (error: unknown): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (state !== closing) return;
    fail(
      "flush",
      "decoder-operation",
      error,
      closing.run,
      null
    );
  };
  timer = setTimeout(finish, CLOSE_MS);
  void completion.then(finish, reject);
}

function decoderError(
  run: number,
  owned: VideoDecoder,
  error: DOMException
): void {
  if (ownsLiveDecoder(state, run, owned)) {
    fail(
      "decode",
      "decoder-operation",
      error,
      run,
      null
    );
  }
}

function requireReady(run: number): ReadyState {
  if (
    state.phase !== "ready" ||
    state.run !== run ||
    state.decoder.state !== "configured"
  ) throw new Error();
  return state;
}

function ownsRun(
  value: WorkerState
): value is ReadyState | AcceptingState | FlushingState | ClosingState {
  return value.phase === "ready" ||
    value.phase === "accepting" ||
    value.phase === "flushing" ||
    value.phase === "closing";
}

function ownsLiveDecoder(
  value: WorkerState,
  run: number,
  decoder: VideoDecoder
): value is ReadyState | AcceptingState | FlushingState {
  return (
    value.phase === "ready" ||
    value.phase === "accepting" ||
    value.phase === "flushing"
  ) && value.run === run && value.decoder === decoder;
}

function idleAfter(owner: OwnedRunState): WorkerState {
  return {
    phase: "idle",
    session: {
      config: owner.session.config,
      generationFloor: owner.run
    }
  };
}

function retire(decoder: VideoDecoder): void {
  decoder.close();
}

function closeFrame(frame: VideoFrame): void {
  try { frame.close(); } catch { /* retired */ }
}

function emit(event: DecoderWorkerEvent, transfer?: Transferable[]): void {
  if (transfer === undefined) port.postMessage(event);
  else port.postMessage(event, transfer);
}

function currentDecoder(value: WorkerState): VideoDecoder | undefined {
  return ownsRun(value) ? value.decoder : undefined;
}

function fail(
  phase: DecoderDiagnosticPhase,
  code: DecoderDiagnosticCode,
  reason: unknown,
  run: number | null,
  decodeOrdinal: number | null,
  outputFailure: Readonly<DecoderOutputFailure> | null = null
): void {
  if (state.phase === "terminal") return;
  const decoder = currentDecoder(state);
  state = { phase: "terminal" };
  try { decoder?.close(); } catch { /* terminal */ }
  const diagnostic = failureDiagnostic(
    phase,
    code,
    reason,
    run,
    decodeOrdinal,
    outputFailure
  );
  resetRunEvidence();
  try { emit({ t: "error", diagnostic }); }
  catch { /* terminal transport */ }
}

function dispose(): void {
  if (state.phase === "terminal") return;
  const decoder = currentDecoder(state);
  state = { phase: "terminal" };
  try { decoder?.close(); } catch { /* terminal */ }
}

function failureDiagnostic(
  phase: DecoderDiagnosticPhase,
  code: DecoderDiagnosticCode,
  reason: unknown,
  run: number | null,
  decodeOrdinal: number | null,
  outputFailure: Readonly<DecoderOutputFailure> | null
): Readonly<DecoderFailureDiagnostic> {
  try {
    return createDecoderFailureDiagnostic({
      phase,
      code,
      reason,
      run,
      decodeOrdinal,
      firstFrame,
      lastGoodFrame,
      outputFailure
    });
  } catch {
    return createDecoderFailureDiagnostic({
      phase: "output-validation",
      code: "invalid-output",
      reason: null,
      run: null,
      decodeOrdinal: null,
      firstFrame: null,
      lastGoodFrame: null,
      outputFailure: createDecoderOutputFailure({
        kind: "metadata-shape",
        validationLayer: "worker-shape",
        field: null,
        expected: null,
        actual: null
      })
    });
  }
}

function diagnosticContextForCommand(
  command: DecoderCommand
): Readonly<{ phase: DecoderDiagnosticPhase; run: number | null }> {
  if (command.t === "configure") return { phase: "probe", run: null };
  if (command.t === "start") return { phase: "configure", run: command.run };
  if (command.t === "decode") return { phase: "decode", run: command.run };
  if (command.t === "flush" || command.t === "close") {
    return { phase: "flush", run: command.run };
  }
  return { phase: "probe", run: null };
}

function diagnosticContextForState(
  value: WorkerState
): Readonly<{ phase: DecoderDiagnosticPhase; run: number | null }> {
  if (value.phase === "configuring" || value.phase === "unconfigured") {
    return { phase: "probe", run: null };
  }
  if (value.phase === "idle") return { phase: "configure", run: null };
  if (value.phase === "flushing" || value.phase === "closing") {
    return { phase: "flush", run: value.run };
  }
  if (value.phase === "ready" || value.phase === "accepting") {
    return { phase: "decode", run: value.run };
  }
  return { phase: "probe", run: null };
}

function resetRunEvidence(): void {
  nextDecodeOrdinal = 0;
  decodeOrdinalsByTimestamp.clear();
  retainedDecodeOrdinalCount = 0;
  firstFrame = null;
  lastGoodFrame = null;
}

function validateSupportConfigEcho(
  requested: Readonly<VideoDecoderConfig>,
  echoed: Readonly<VideoDecoderConfig> | undefined
): VideoDecoderConfig | null {
  try {
    if (!isPlainRecord(requested) || !isPlainRecord(echoed)) return null;
    const requestedConfig = requested as BrowserVideoDecoderConfig;
    const echoedConfig = echoed as BrowserVideoDecoderConfig;
    if (
      Object.keys(requestedConfig).some((key) => !VIDEO_CONFIG_KEYS.has(key)) ||
      Object.keys(echoedConfig).some((key) => !VIDEO_CONFIG_KEYS.has(key))
    ) return null;
    for (const key of Object.keys(requestedConfig)) {
      if (!sameConfigMember(
        echoedConfig[key as keyof BrowserVideoDecoderConfig],
        requestedConfig[key as keyof BrowserVideoDecoderConfig]
      )) return null;
    }
    if (
      !("hardwareAcceleration" in requestedConfig) &&
      echoedConfig.hardwareAcceleration !== undefined &&
      echoedConfig.hardwareAcceleration !== "no-preference"
    ) return null;
    if (
      !("optimizeForLatency" in requestedConfig) &&
      echoedConfig.optimizeForLatency !== undefined &&
      echoedConfig.optimizeForLatency !== false
    ) return null;
    if (
      !("rotation" in requestedConfig) &&
      echoedConfig.rotation !== undefined &&
      echoedConfig.rotation !== 0
    ) return null;
    if (
      !("flip" in requestedConfig) &&
      echoedConfig.flip !== undefined &&
      echoedConfig.flip !== false
    ) return null;
    const clone: BrowserVideoDecoderConfig = {
      ...requestedConfig,
      ...(requestedConfig.colorSpace === undefined
        ? {}
        : { colorSpace: Object.freeze({ ...requestedConfig.colorSpace }) })
    };
    return Object.freeze(clone);
  } catch {
    return null;
  }
}

function sameConfigMember(left: unknown, right: unknown): boolean {
  if (isPlainRecord(left) && isPlainRecord(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return leftKeys.length === rightKeys.length &&
      leftKeys.every((key) => key in right && left[key] === right[key]);
  }
  return left === right;
}

function retainDecodeOrdinal(timestamp: number, ordinal: number): void {
  if (retainedDecodeOrdinalCount >= DECODER_RING_SIZE) return;
  const retained = decodeOrdinalsByTimestamp.get(timestamp);
  if (retained === undefined) decodeOrdinalsByTimestamp.set(timestamp, [ordinal]);
  else retained.push(ordinal);
  retainedDecodeOrdinalCount += 1;
}

function takeDecodeOrdinal(timestamp: number): number | null {
  const retained = decodeOrdinalsByTimestamp.get(timestamp);
  const ordinal = retained?.shift();
  if (retained !== undefined && retained.length === 0) {
    decodeOrdinalsByTimestamp.delete(timestamp);
  }
  if (ordinal !== undefined) retainedDecodeOrdinalCount -= 1;
  return ordinal ?? null;
}

function takeFrameDecodeOrdinal(frame: VideoFrame): number | null {
  let timestamp: number;
  try { timestamp = frame.timestamp; }
  catch { return null; }
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) return null;
  return takeDecodeOrdinal(timestamp);
}

function releaseDecodeOrdinal(timestamp: number, ordinal: number): void {
  const retained = decodeOrdinalsByTimestamp.get(timestamp);
  if (retained === undefined) return;
  const index = retained.lastIndexOf(ordinal);
  if (index >= 0) {
    retained.splice(index, 1);
    retainedDecodeOrdinalCount -= 1;
  }
  if (retained.length === 0) decodeOrdinalsByTimestamp.delete(timestamp);
}
