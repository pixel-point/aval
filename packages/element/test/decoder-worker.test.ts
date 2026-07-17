import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("decoder worker run isolation", () => {
  it("closes a late retired-run frame instead of relabeling it as the next run", async () => {
    let receive!: (event: MessageEvent<unknown>) => void;
    const posted: unknown[] = [];
    const decoders: FakeDecoder[] = [];
    class FakeDecoder {
      public static isConfigSupported(config: VideoDecoderConfig) {
        return Promise.resolve({ supported: true, config });
      }
      public state: CodecState = "unconfigured";
      public readonly decodeQueueSize = 0;
      public readonly callbacks: VideoDecoderInit;
      readonly #flushes: Array<() => void> = [];
      public constructor(callbacks: VideoDecoderInit) {
        this.callbacks = callbacks;
        decoders.push(this);
      }
      public addEventListener(): void {}
      public configure(): void { this.state = "configured"; }
      public decode(): void {}
      public flush(): Promise<void> {
        return new Promise((resolve) => this.#flushes.push(resolve));
      }
      public resolveFlush(): void { this.#flushes.shift()?.(); }
      public close(): void { this.state = "closed"; }
    }
    vi.stubGlobal("addEventListener", (_type: string, listener: typeof receive) => {
      receive = listener;
    });
    vi.stubGlobal("postMessage", (message: unknown) => posted.push(message));
    vi.stubGlobal("VideoDecoder", FakeDecoder);
    vi.stubGlobal("EncodedVideoChunk", class {});
    await import("../src/decoder-worker.js");

    command({ t: "configure", config: { codec: "avc1.640020" } });
    await Promise.resolve();
    command({ t: "start", run: 1 });
    const retired = decoders[0]!;
    command({ t: "close", run: 1 });
    retired.resolveFlush();
    await Promise.resolve();
    command({ t: "start", run: 2 });

    const late = { timestamp: 7, closed: false, close() { this.closed = true; } };
    retired.callbacks.output(late as unknown as VideoFrame);

    expect(late.closed).toBe(true);
    expect(posted.filter((value) =>
      (value as { t?: string }).t === "frame"
    )).toEqual([]);
    expect(posted).toContainEqual({ t: "closed", run: 1 });
    expect(posted).toContainEqual({ t: "started", run: 2 });

    function command(data: unknown): void {
      receive({ data } as MessageEvent<unknown>);
    }
  });
});
