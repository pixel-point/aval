import {
  DECODER_RING_SIZE,
  isDecoderCommand,
  type DecoderChunk,
  type DecoderCommand,
  type DecoderWorkerEvent
} from "./decoder-protocol.js";

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
let state: WorkerState = { phase: "unconfigured" };

port.addEventListener("message", (event) => {
  if (state.phase === "terminal") return;
  if (!isDecoderCommand(event.data)) {
    fail();
    return;
  }
  try { handle(event.data); }
  catch { fail(); }
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
        state = {
          phase: "idle",
          session: {
            config: result.config ?? config,
            generationFloor: 0
          }
        };
        emit({ t: "configured", supported: true });
      } catch { fail(); }
    },
    () => fail()
  );
}

function start(run: number): void {
  if (state.phase !== "idle" || run <= state.session.generationFloor) {
    throw new Error();
  }
  const session = state.session;
  let owned!: VideoDecoder;
  owned = new VideoDecoder({
    output: (frame) => output(run, owned, frame),
    error: () => decoderError(run, owned)
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
    () => { if (state === flushing) fail(); }
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
    frame.close();
    return;
  }
  try {
    emit({ t: "frame", run, timestamp: frame.timestamp, frame }, [frame]);
  } catch {
    frame.close();
    fail();
  }
}

function pump(run: number, owned: VideoDecoder): void {
  const accepting = state;
  if (
    accepting.phase !== "accepting" ||
    accepting.run !== run ||
    accepting.decoder !== owned
  ) return;
  try {
    while (
      accepting.pending.length > 0 &&
      owned.decodeQueueSize < DECODER_RING_SIZE
    ) {
      const chunk = accepting.pending.shift()!;
      owned.decode(new EncodedVideoChunk({
        type: chunk.key ? "key" : "delta",
        timestamp: chunk.timestamp,
        duration: chunk.duration,
        data: chunk.data
      }));
    }
    if (accepting.pending.length === 0) {
      state = {
        phase: "ready",
        session: accepting.session,
        run,
        decoder: owned
      };
      emit({ t: "accepted", run });
    }
  } catch { fail(); }
}

function finishFlush(flushing: FlushingState): void {
  if (state !== flushing) return;
  try {
    retire(flushing.decoder);
    state = idleAfter(flushing);
    emit({ t: "flushed", run: flushing.run });
  } catch { fail(); }
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
    } catch { fail(); }
  };
  timer = setTimeout(finish, CLOSE_MS);
  void completion.then(finish, finish);
}

function decoderError(run: number, owned: VideoDecoder): void {
  if (ownsLiveDecoder(state, run, owned)) fail();
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
  try { decoder.close(); } catch { /* retired */ }
}

function emit(event: DecoderWorkerEvent, transfer?: Transferable[]): void {
  if (transfer === undefined) port.postMessage(event);
  else port.postMessage(event, transfer);
}

function currentDecoder(value: WorkerState): VideoDecoder | undefined {
  return ownsRun(value) ? value.decoder : undefined;
}

function fail(): void {
  if (state.phase === "terminal") return;
  const decoder = currentDecoder(state);
  state = { phase: "terminal" };
  try { decoder?.close(); } catch { /* terminal */ }
  try { emit({ t: "error" }); } catch { /* terminal transport */ }
}

function dispose(): void {
  if (state.phase === "terminal") return;
  const decoder = currentDecoder(state);
  state = { phase: "terminal" };
  try { decoder?.close(); } catch { /* terminal */ }
}
