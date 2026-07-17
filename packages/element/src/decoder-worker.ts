export {};

type Chunk = Readonly<{
  data: ArrayBuffer;
  timestamp: number;
  duration: number;
  key: boolean;
}>;

type DecodeCommand =
  | Readonly<{ t: "configure"; config: VideoDecoderConfig }>
  | Readonly<{ t: "start"; run: number }>
  | Readonly<{ t: "decode"; run: number; chunks: readonly Chunk[] }>
  | Readonly<{ t: "flush"; run: number }>
  | Readonly<{ t: "close"; run: number }>
  | Readonly<{ t: "dispose" }>;

interface WorkerPort {
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<unknown>) => void
  ): void;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}

const port = globalThis as unknown as WorkerPort;
const LIMIT = 12;
const CLOSE_MS = 2_000;
let decoder: VideoDecoder | undefined;
let config: VideoDecoderConfig | undefined;
let active = 0;
let closing = 0;
let generation = 0;
let pending: Chunk[] = [];
let awaitingAcceptance = false;
let flushing = false;
let terminal = false;
let configuring = false;

port.addEventListener("message", (event) => {
  const command = event.data as DecodeCommand;
  if (terminal) return;
  try {
    if (command.t === "configure") {
      if (configuring || decoder !== undefined || config !== undefined) throw new Error();
      configuring = true;
      const token = ++generation;
      void VideoDecoder.isConfigSupported(command.config).then(
        (result) => {
          try {
            if (terminal || token !== generation) return;
            configuring = false;
            if (!result.supported) {
              port.postMessage({ t: "configured", supported: false });
              return;
            }
            config = result.config ?? command.config;
            port.postMessage({ t: "configured", supported: true });
          } catch { fail(0); }
        },
        () => fail(0)
      );
      return;
    }
    if (command.t === "start") {
      requireRun(command.run, false);
      const run = command.run;
      let owned!: VideoDecoder;
      owned = new VideoDecoder({
        output: (frame) => output(run, owned, frame),
        error: () => decoderError(run, owned)
      });
      owned.addEventListener("dequeue", () => pump(run, owned));
      owned.configure(config!);
      decoder = owned;
      active = run;
      generation += 1;
      port.postMessage({ t: "started", run });
      return;
    }
    if (command.t === "decode") {
      const owned = requireRun(command.run, true);
      if (
        flushing || awaitingAcceptance || command.chunks.length < 1 ||
        command.chunks.length > LIMIT
      ) throw new Error();
      for (const chunk of command.chunks) validateChunk(chunk);
      pending = [...command.chunks];
      awaitingAcceptance = true;
      pump(command.run, owned);
      return;
    }
    if (command.t === "flush") {
      const owned = requireRun(command.run, true);
      if (flushing || awaitingAcceptance || pending.length > 0) throw new Error();
      flushing = true;
      const token = generation;
      const run = active;
      void owned.flush().then(
        () => {
          if (terminal || token !== generation || run !== active || decoder !== owned) return;
          try {
            retire(owned);
            flushing = false;
            active = 0;
            port.postMessage({ t: "flushed", run });
          } catch { fail(run); }
        },
        () => {
          if (token === generation && run === active && decoder === owned) fail(run);
        }
      );
      return;
    }
    if (command.t === "close") {
      const owned = requireRun(command.run, true);
      beginClose(command.run, owned);
      return;
    }
    if (command.t === "dispose") {
      dispose();
      return;
    }
    throw new Error();
  } catch {
    fail("run" in command && typeof command.run === "number" ? command.run : active);
  }
});

function output(run: number, owned: VideoDecoder, frame: VideoFrame): void {
  if (terminal || closing !== 0 || active !== run || decoder !== owned) {
    frame.close();
    return;
  }
  try {
    port.postMessage({ t: "frame", run, timestamp: frame.timestamp, frame }, [frame]);
  } catch {
    frame.close();
    fail(run);
  }
}

function pump(run: number, owned: VideoDecoder): void {
  if (
    terminal || closing !== 0 || active !== run || decoder !== owned ||
    !awaitingAcceptance
  ) return;
  try {
    while (pending.length > 0 && owned.decodeQueueSize < LIMIT) {
      const chunk = pending.shift()!;
      owned.decode(new EncodedVideoChunk({
        type: chunk.key ? "key" : "delta",
        timestamp: chunk.timestamp,
        duration: chunk.duration,
        data: chunk.data
      }));
    }
    if (pending.length === 0) {
      awaitingAcceptance = false;
      port.postMessage({ t: "accepted", run });
    }
  } catch { fail(run); }
}

function beginClose(run: number, owned: VideoDecoder): void {
  const token = ++generation;
  closing = run;
  active = 0;
  pending = [];
  awaitingAcceptance = false;
  flushing = false;
  let settled = false;
  const timer = setTimeout(() => finish(), CLOSE_MS);
  const finish = (): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (terminal || token !== generation || closing !== run || decoder !== owned) return;
    retire(owned);
    closing = 0;
    port.postMessage({ t: "closed", run });
  };
  try { void owned.flush().then(finish, finish); }
  catch { finish(); }
}

function decoderError(run: number, owned: VideoDecoder): void {
  if (terminal || decoder !== owned) return;
  if (closing === run) return;
  if (active === run) fail(run);
}

function requireRun(run: number, existing: boolean): VideoDecoder {
  if (!Number.isSafeInteger(run) || run < 1 || config === undefined) throw new Error();
  if (!existing) {
    if (active !== 0 || closing !== 0 || flushing || decoder !== undefined) throw new Error();
    return undefined as never;
  }
  if (active !== run || closing !== 0 || decoder?.state !== "configured") throw new Error();
  return decoder;
}

function validateChunk(chunk: Chunk): void {
  if (
    !(chunk.data instanceof ArrayBuffer) || chunk.data.byteLength < 1 ||
    !Number.isSafeInteger(chunk.timestamp) || chunk.timestamp < 0 ||
    !Number.isSafeInteger(chunk.duration) || chunk.duration < 0 ||
    typeof chunk.key !== "boolean"
  ) throw new Error();
}

function retire(owned: VideoDecoder): void {
  try { owned.close(); } catch { /* retired */ }
  if (decoder === owned) decoder = undefined;
}

function fail(run: number): void {
  if (terminal) return;
  terminal = true;
  generation += 1;
  pending = [];
  try { decoder?.close(); } catch { /* terminal */ }
  decoder = undefined;
  config = undefined;
  port.postMessage({ t: "error", run });
}

function dispose(): void {
  if (terminal) return;
  terminal = true;
  generation += 1;
  pending = [];
  try { decoder?.close(); } catch { /* terminal */ }
  decoder = undefined;
  config = undefined;
}
