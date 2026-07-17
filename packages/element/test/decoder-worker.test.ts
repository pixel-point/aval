import { afterEach, describe, expect, it, vi } from "vitest";

import {
  isDecoderCommand,
  isDecoderWorkerEvent,
  type DecoderCommand,
  type DecoderWorkerEvent
} from "../src/decoder-protocol.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("decoder worker protocol", () => {
  it("accepts only exact command and event shapes", () => {
    class Frame {}
    const VideoFrameConstructor = Frame as unknown as typeof VideoFrame;

    expect(isDecoderCommand({ t: "close", run: 1 })).toBe(true);
    expect(isDecoderCommand({ t: "close", run: 1, extra: true })).toBe(false);
    expect(isDecoderCommand({
      t: "decode",
      run: 1,
      chunks: new Array(1)
    })).toBe(false);
    const inheritedCommand = Object.assign(
      Object.create({ t: "close", run: 1 }) as Record<string, unknown>,
      { unrelated: true, alsoUnrelated: true }
    );
    expect(isDecoderCommand(inheritedCommand)).toBe(false);
    expect(isDecoderCommand({
      t: "decode",
      run: 1,
      chunks: [{
        data: new Uint8Array([1]).buffer,
        timestamp: 0,
        duration: 1,
        key: true,
        extra: true
      }]
    })).toBe(false);
    expect(isDecoderWorkerEvent({ t: "error" }, VideoFrameConstructor)).toBe(true);
    const inheritedEvent = Object.assign(
      Object.create({ t: "error" }) as Record<string, unknown>,
      { unrelated: true }
    );
    expect(isDecoderWorkerEvent(inheritedEvent, VideoFrameConstructor)).toBe(false);
    expect(isDecoderWorkerEvent(
      { t: "error", run: 1 },
      VideoFrameConstructor
    )).toBe(false);
    expect(isDecoderWorkerEvent(
      { t: "closed", run: 1, extra: true },
      VideoFrameConstructor
    )).toBe(false);
  });
});

describe("decoder worker run isolation", () => {
  it("closes a late retired-run frame instead of relabeling it as the next run", async () => {
    const worker = await fakeDecoderWorker();

    worker.command({ t: "configure", config: { codec: "avc1.640020" } });
    await Promise.resolve();
    worker.command({ t: "start", run: 1 });
    const retired = worker.decoders[0]!;
    worker.command({ t: "close", run: 1 });
    retired.resolveFlush();
    await Promise.resolve();
    worker.command({ t: "start", run: 2 });

    const late = { timestamp: 7, closed: false, close() { this.closed = true; } };
    retired.callbacks.output(late as unknown as VideoFrame);

    expect(late.closed).toBe(true);
    expect(worker.posted.filter((event) => event.t === "frame")).toEqual([]);
    expect(worker.posted).toContainEqual({ t: "closed", run: 1 });
    expect(worker.posted).toContainEqual({ t: "started", run: 2 });
  });

  it("ignores a close command after that run's flush already resolved", async () => {
    const worker = await fakeDecoderWorker();

    worker.command({ t: "configure", config: { codec: "avc1.640020" } });
    await Promise.resolve();
    worker.command({ t: "start", run: 1 });
    const retired = worker.decoders[0]!;
    worker.command({ t: "flush", run: 1 });
    retired.resolveFlush();
    await Promise.resolve();
    expect(worker.posted).toContainEqual({ t: "flushed", run: 1 });

    worker.command({ t: "close", run: 1 });
    worker.command({ t: "start", run: 2 });

    expect(worker.posted.filter((event) => event.t === "error")).toEqual([]);
    expect(worker.posted).toContainEqual({ t: "started", run: 2 });
  });

  it("reuses an in-flight flush when close wins the terminal race", async () => {
    const worker = await fakeDecoderWorker();

    worker.command({ t: "configure", config: { codec: "avc1.640020" } });
    await Promise.resolve();
    worker.command({ t: "start", run: 1 });
    const closing = worker.decoders[0]!;
    worker.command({ t: "flush", run: 1 });
    expect(closing.flushCalls).toBe(1);

    worker.command({ t: "close", run: 1 });
    expect(closing.flushCalls).toBe(1);
    closing.resolveFlush();
    await Promise.resolve();

    expect(worker.posted).toContainEqual({ t: "closed", run: 1 });
    expect(worker.posted).not.toContainEqual({ t: "flushed", run: 1 });
    worker.command({ t: "start", run: 2 });
    expect(worker.posted).toContainEqual({ t: "started", run: 2 });
  });

  it("keeps every older close idempotent and rejects future generations", async () => {
    const worker = await fakeDecoderWorker();

    worker.command({ t: "configure", config: { codec: "avc1.640020" } });
    await Promise.resolve();
    for (const run of [1, 2]) {
      worker.command({ t: "start", run });
      const decoder = worker.decoders[run - 1]!;
      worker.command({ t: "flush", run });
      decoder.resolveFlush();
      await Promise.resolve();
    }

    worker.command({ t: "close", run: 1 });
    expect(worker.posted.filter((event) => event.t === "error")).toEqual([]);
    worker.command({ t: "start", run: 3 });
    expect(worker.posted).toContainEqual({ t: "started", run: 3 });

    worker.command({ t: "close", run: 4 });
    expect(worker.posted.at(-1)).toEqual({ t: "error" });
  });

  it("turns a malformed transport command into a global failure", async () => {
    const worker = await fakeDecoderWorker();

    worker.send(null);

    expect(worker.posted).toEqual([{ t: "error" }]);
  });
});

interface FakeDecoderInstance {
  readonly callbacks: VideoDecoderInit;
  readonly flushCalls: number;
  resolveFlush(): void;
}

async function fakeDecoderWorker(): Promise<Readonly<{
  command(data: DecoderCommand): void;
  send(data: unknown): void;
  decoders: readonly FakeDecoderInstance[];
  posted: readonly DecoderWorkerEvent[];
}>> {
  let receive!: (event: MessageEvent<unknown>) => void;
  const posted: DecoderWorkerEvent[] = [];
  const decoders: FakeDecoderInstance[] = [];
  class FakeDecoder implements FakeDecoderInstance {
    public static isConfigSupported(config: VideoDecoderConfig) {
      return Promise.resolve({ supported: true, config });
    }
    public state: CodecState = "unconfigured";
    public readonly decodeQueueSize = 0;
    public readonly callbacks: VideoDecoderInit;
    readonly #flushes: Array<() => void> = [];
    public flushCalls = 0;
    public constructor(callbacks: VideoDecoderInit) {
      this.callbacks = callbacks;
      decoders.push(this);
    }
    public addEventListener(): void {}
    public configure(): void { this.state = "configured"; }
    public decode(): void {}
    public flush(): Promise<void> {
      this.flushCalls += 1;
      return new Promise((resolve) => this.#flushes.push(resolve));
    }
    public resolveFlush(): void { this.#flushes.shift()?.(); }
    public close(): void { this.state = "closed"; }
  }
  vi.stubGlobal("addEventListener", (_type: string, listener: typeof receive) => {
    receive = listener;
  });
  vi.stubGlobal("postMessage", (message: DecoderWorkerEvent) => posted.push(message));
  vi.stubGlobal("VideoDecoder", FakeDecoder);
  vi.stubGlobal("EncodedVideoChunk", class {});
  await import("../src/decoder-worker.js");
  const send = (data: unknown): void => {
    receive({ data } as MessageEvent<unknown>);
  };
  return Object.freeze({
    command: send,
    send,
    decoders,
    posted
  });
}
