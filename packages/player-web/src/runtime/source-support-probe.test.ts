import { describe, expect, it, vi } from "vitest";

import { DecoderWorkerClient } from "../decoder-worker/client.js";
import type { WorkerVideoDecoderAdapter } from "../decoder-worker/core.js";
import { DecoderWorkerHost } from "../decoder-worker/host.js";
import {
  DECODER_WORKER_PROTOCOL_VERSION,
  type DecoderWorkerClientPort,
  type DecoderWorkerMessagePort,
  type DecoderWorkerProbeConfig,
  type DecoderWorkerVideoConfig
} from "../decoder-worker/protocol.js";
import {
  SourceSupportProbe,
  createSourceSupportProbe
} from "./source-support-probe.js";

const PROBE_CONFIGS = Object.freeze([
  probeConfig("avc1.640020"),
  probeConfig("hvc1.1.6.L30.90"),
  probeConfig("vp09.00.10.08.01.01.01.01.00"),
  probeConfig("av01.0.00M.10.0.110.01.01.01.0")
]);

describe("module-worker source support probe", () => {
  it("rejects animated sources when module workers are unavailable", async () => {
    vi.stubGlobal("Worker", undefined);
    try {
      const owner = createSourceSupportProbe();

      await expect(owner.probe(PROBE_CONFIGS[0]!)).resolves.toBe(false);
      await expect(owner.dispose()).resolves.toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("probes all codec families before configuration and returns only booleans", async () => {
    const observed: VideoDecoderConfig[] = [];
    const fixture = createProbeFixture(async (config) => {
      observed.push(config);
      return {
        supported: !config.codec.startsWith("vp09."),
        config: {
          ...config,
          hardwareAcceleration: "no-preference",
          optimizeForLatency: false
        } as VideoDecoderConfig
      };
    });

    const results: boolean[] = [];
    for (const config of PROBE_CONFIGS) {
      results.push(await fixture.owner.probe(config));
    }

    expect(results).toEqual([true, true, false, true]);
    expect(observed.map(({ codec }) => codec)).toEqual(
      PROBE_CONFIGS.map(({ codec }) => codec)
    );
    expect(observed.every((config) => !("description" in config))).toBe(true);
    expect(fixture.decoderFactory).not.toHaveBeenCalled();
    expect(await fixture.client.snapshotMetrics()).toMatchObject({
      configureCalls: 0,
      disposed: false
    });
    await fixture.dispose();
  });

  it("creates the probe in the packaged module-worker boundary", async () => {
    const { clientPort, workerPort } = createPortPair();
    const host = new DecoderWorkerHost(workerPort, {
      supportProbe: async (config) => ({ supported: true, config }),
      decoderFactory: () => {
        throw new Error("support probe must not construct a decoder");
      }
    });
    let observedUrl: URL | undefined;
    let observedOptions: WorkerOptions | undefined;
    const owner = createSourceSupportProbe({
      disposeTimeoutMs: 100,
      workerName: "aval-source-probe",
      workerFactory: (url, options) => {
        observedUrl = url;
        observedOptions = options;
        return clientPort;
      }
    });

    await expect(owner.probe(PROBE_CONFIGS[0]!)).resolves.toBe(true);
    expect(observedUrl?.pathname).toMatch(/decoder-worker\/entry\.js$/u);
    expect(observedOptions).toEqual({
      type: "module",
      name: "aval-source-probe"
    });
    await owner.dispose();
    expect(clientPort.terminateCalls).toBe(1);
    host.detach();
  });

  it("validates the browser config echo even for unsupported results", async () => {
    const fixture = createProbeFixture(async (config) => ({
      supported: false,
      config: { ...config, codec: "avc1.42E01E" }
    }));

    await expect(fixture.owner.probe(PROBE_CONFIGS[0]!)).rejects.toMatchObject({
      name: "DecoderWorkerRemoteError",
      code: "DECODER_PROBE_FAILED",
      fatal: false
    });
    await fixture.owner.dispose();
    expect(fixture.clientPort.terminateCalls).toBe(1);
    fixture.host.detach();
  });

  it("treats malformed support flags as probe failures, never as unsupported", async () => {
    const fixture = createProbeFixture(async (config) => ({
      supported: "no" as unknown as boolean,
      config
    }));

    await expect(fixture.owner.probe(PROBE_CONFIGS[1]!)).rejects.toMatchObject({
      code: "DECODER_PROBE_FAILED"
    });
    await fixture.dispose();
  });

  it("rejects hostile request dictionaries before invoking WebCodecs", async () => {
    const supportProbe = vi.fn(async (config: VideoDecoderConfig) => ({
      supported: true,
      config
    }));
    const fixture = createProbeFixture(supportProbe);
    const hostile = {
      ...PROBE_CONFIGS[0]!,
      description: new Uint8Array([1, 2, 3])
    } as unknown as DecoderWorkerProbeConfig;

    await expect(fixture.owner.probe(hostile)).rejects.toMatchObject({
      code: "PROTOCOL_ERROR",
      fatal: true
    });
    expect(supportProbe).not.toHaveBeenCalled();
    await fixture.owner.dispose();
    fixture.host.detach();
  });

  it("validates the exact echoed request id", async () => {
    const port = new ManualClientPort();
    const client = new DecoderWorkerClient(port, {
      requestTimeoutMs: 100,
      disposeTimeoutMs: 20
    });
    const pending = client.probeConfig(PROBE_CONFIGS[0]!);
    const request = port.posted[0] as { readonly requestId: number };
    port.emit({
      type: "probe-result",
      protocolVersion: DECODER_WORKER_PROTOCOL_VERSION,
      requestId: request.requestId + 1,
      supported: true
    });

    await expect(pending).rejects.toMatchObject({
      name: "DecoderWorkerTransportError"
    });
    expect(port.terminateCalls).toBe(1);
    await client.dispose();
  });

  it("aborts an in-flight probe and retires its worker owner", async () => {
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const fixture = createProbeFixture(async (config) => {
      started();
      await gate;
      return { supported: true, config };
    });
    const controller = new AbortController();
    const reason = new Error("source superseded");
    const pending = fixture.owner.probe(PROBE_CONFIGS[2]!, {
      signal: controller.signal
    });
    await entered;

    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    release();
    await fixture.owner.dispose();
    expect(fixture.clientPort.terminateCalls).toBe(1);
    await expect(fixture.owner.probe(PROBE_CONFIGS[0]!)).rejects.toMatchObject({
      name: "AbortError"
    });
    fixture.host.detach();
  });

  it("still validates a late response after an aborted probe times out", async () => {
    vi.useFakeTimers();
    try {
      const port = new ManualClientPort();
      const client = new DecoderWorkerClient(port, {
        requestTimeoutMs: 10,
        disposeTimeoutMs: 10
      });
      const controller = new AbortController();
      const reason = new Error("probe superseded");
      const pending = client.probeConfig(PROBE_CONFIGS[0]!, {
        signal: controller.signal
      });
      const request = port.posted[0] as { readonly requestId: number };

      controller.abort(reason);
      await expect(pending).rejects.toBe(reason);
      await vi.advanceTimersByTimeAsync(10);
      port.emit({
        type: "ack",
        protocolVersion: DECODER_WORKER_PROTOCOL_VERSION,
        requestId: request.requestId,
        operation: "configure"
      });

      expect(port.terminateCalls).toBe(1);
      await client.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects concurrent probes instead of obscuring authored order", async () => {
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const fixture = createProbeFixture(async (config) => {
      started();
      await gate;
      return { supported: true, config };
    });
    const first = fixture.owner.probe(PROBE_CONFIGS[0]!);
    await entered;

    await expect(fixture.owner.probe(PROBE_CONFIGS[1]!)).rejects.toThrow(
      /must run sequentially/iu
    );
    release();
    await expect(first).resolves.toBe(true);
    await fixture.dispose();
  });

  it("preserves configure-once semantics after any number of probes", async () => {
    const fixture = createProbeFixture(async (config) => ({
      supported: true,
      config
    }));
    await expect(fixture.client.probeConfig(PROBE_CONFIGS[0]!)).resolves.toBe(true);
    await expect(fixture.client.probeConfig(PROBE_CONFIGS[1]!)).resolves.toBe(true);

    const config: DecoderWorkerVideoConfig = {
      codec: "avc1.640020",
      codedWidth: 64,
      codedHeight: 64,
      hardwareAcceleration: "no-preference",
      optimizeForLatency: true
    };
    const configure = () => fixture.client.configure({
      config,
      videoProfile: {
        codecFamily: "h264",
        bitDepth: 8,
        codedWidth: 64,
        codedHeight: 64,
        frameRate: { numerator: 30, denominator: 1 },
        requireBt709LimitedRange: true
      },
      expectedOutput: {
        codedWidth: 64,
        codedHeight: 64,
        displayWidth: 64,
        displayHeight: 64,
        visibleRect: { x: 0, y: 0, width: 64, height: 64 },
        colorSpace: null
      },
      limits: {
        maxDecodeQueueSize: 4,
        maxPendingSamples: 8,
        maxOutstandingFrames: 4,
        maxDecodedBytes: 64 * 64 * 4 * 4
      }
    });
    await configure();

    expect(await fixture.client.snapshotMetrics()).toMatchObject({
      configureCalls: 1
    });
    await expect(fixture.client.probeConfig(PROBE_CONFIGS[0]!)).rejects.toMatchObject({
      code: "ALREADY_CONFIGURED"
    });
    await expect(configure()).rejects.toMatchObject({
      code: "ALREADY_CONFIGURED"
    });
    expect(fixture.decoder.configureCalls).toBe(1);
    await fixture.dispose();
  });
});

interface ProbeFixture {
  readonly client: DecoderWorkerClient;
  readonly owner: SourceSupportProbe;
  readonly host: DecoderWorkerHost;
  readonly clientPort: FakeDuplexPort;
  readonly decoder: FakeVideoDecoder;
  readonly decoderFactory: ReturnType<typeof vi.fn>;
  dispose(): Promise<void>;
}

function createProbeFixture(
  supportProbe: (config: VideoDecoderConfig) => Promise<VideoDecoderSupport>
): ProbeFixture {
  const { clientPort, workerPort } = createPortPair();
  const decoder = new FakeVideoDecoder();
  const decoderFactory = vi.fn(() => decoder);
  const host = new DecoderWorkerHost(workerPort, {
    supportProbe,
    decoderFactory
  });
  const client = new DecoderWorkerClient(clientPort, {
    requestTimeoutMs: 200,
    disposeTimeoutMs: 100
  });
  const owner = new SourceSupportProbe(client);
  return {
    client,
    owner,
    host,
    clientPort,
    decoder,
    decoderFactory,
    dispose: async () => {
      await owner.dispose();
      host.detach();
    }
  };
}

function probeConfig(codec: string): Readonly<DecoderWorkerProbeConfig> {
  return Object.freeze({
    codec,
    codedWidth: 64,
    codedHeight: 32,
    displayAspectWidth: 64,
    displayAspectHeight: 32,
    colorSpace: Object.freeze({
      primaries: "bt709" as const,
      transfer: "bt709" as const,
      matrix: "bt709" as const,
      fullRange: false as const
    })
  });
}

class FakeVideoDecoder implements WorkerVideoDecoderAdapter {
  public readonly decodeQueueSize = 0;
  public configureCalls = 0;
  public closeCalls = 0;

  public setDequeueCallback(_callback: () => void): void {}
  public configure(_config: VideoDecoderConfig): void {
    this.configureCalls += 1;
  }
  public decode(_chunk: EncodedVideoChunk): void {}
  public async flush(): Promise<void> {}
  public close(): void {
    this.closeCalls += 1;
  }
}

function createPortPair(): {
  readonly clientPort: FakeDuplexPort;
  readonly workerPort: FakeDuplexPort;
} {
  const clientPort = new FakeDuplexPort();
  const workerPort = new FakeDuplexPort();
  clientPort.connect(workerPort);
  workerPort.connect(clientPort);
  return { clientPort, workerPort };
}

class FakeDuplexPort implements DecoderWorkerClientPort, DecoderWorkerMessagePort {
  readonly #messageListeners = new Set<(event: MessageEvent<unknown>) => void>();
  readonly #messageErrorListeners = new Set<
    (event: MessageEvent<unknown>) => void
  >();
  readonly #errorListeners = new Set<(event: ErrorEvent) => void>();
  #peer: FakeDuplexPort | null = null;
  #terminated = false;
  public terminateCalls = 0;

  public connect(peer: FakeDuplexPort): void {
    this.#peer = peer;
  }

  public postMessage(message: unknown, _transfer?: Transferable[]): void {
    if (this.#terminated || this.#peer === null) {
      throw new Error("fake worker port is terminated");
    }
    const peer = this.#peer;
    queueMicrotask(() => {
      if (peer.#terminated) return;
      const event = { data: message } as MessageEvent<unknown>;
      for (const listener of [...peer.#messageListeners]) listener(event);
    });
  }

  public addEventListener(
    type: "message",
    listener: (event: MessageEvent<unknown>) => void
  ): void;
  public addEventListener(
    type: "messageerror",
    listener: (event: MessageEvent<unknown>) => void
  ): void;
  public addEventListener(type: "error", listener: (event: ErrorEvent) => void): void;
  public addEventListener(
    type: "message" | "messageerror" | "error",
    listener:
      | ((event: MessageEvent<unknown>) => void)
      | ((event: ErrorEvent) => void)
  ): void {
    if (type === "message") {
      this.#messageListeners.add(listener as (event: MessageEvent<unknown>) => void);
    } else if (type === "messageerror") {
      this.#messageErrorListeners.add(
        listener as (event: MessageEvent<unknown>) => void
      );
    } else {
      this.#errorListeners.add(listener as (event: ErrorEvent) => void);
    }
  }

  public removeEventListener(
    type: "message",
    listener: (event: MessageEvent<unknown>) => void
  ): void;
  public removeEventListener(
    type: "messageerror",
    listener: (event: MessageEvent<unknown>) => void
  ): void;
  public removeEventListener(type: "error", listener: (event: ErrorEvent) => void): void;
  public removeEventListener(
    type: "message" | "messageerror" | "error",
    listener:
      | ((event: MessageEvent<unknown>) => void)
      | ((event: ErrorEvent) => void)
  ): void {
    if (type === "message") {
      this.#messageListeners.delete(
        listener as (event: MessageEvent<unknown>) => void
      );
    } else if (type === "messageerror") {
      this.#messageErrorListeners.delete(
        listener as (event: MessageEvent<unknown>) => void
      );
    } else {
      this.#errorListeners.delete(listener as (event: ErrorEvent) => void);
    }
  }

  public terminate(): void {
    if (this.#terminated) return;
    this.#terminated = true;
    this.#peer?.terminateFromPeer();
    this.terminateCalls += 1;
  }

  private terminateFromPeer(): void {
    this.#terminated = true;
  }
}

class ManualClientPort implements DecoderWorkerClientPort {
  readonly #messageListeners = new Set<(event: MessageEvent<unknown>) => void>();
  readonly #messageErrorListeners = new Set<
    (event: MessageEvent<unknown>) => void
  >();
  readonly #errorListeners = new Set<(event: ErrorEvent) => void>();
  public readonly posted: unknown[] = [];
  public terminateCalls = 0;

  public postMessage(message: unknown): void {
    this.posted.push(message);
  }

  public emit(message: unknown): void {
    const event = { data: message } as MessageEvent<unknown>;
    for (const listener of [...this.#messageListeners]) listener(event);
  }

  public addEventListener(
    type: "message",
    listener: (event: MessageEvent<unknown>) => void
  ): void;
  public addEventListener(
    type: "messageerror",
    listener: (event: MessageEvent<unknown>) => void
  ): void;
  public addEventListener(type: "error", listener: (event: ErrorEvent) => void): void;
  public addEventListener(
    type: "message" | "messageerror" | "error",
    listener:
      | ((event: MessageEvent<unknown>) => void)
      | ((event: ErrorEvent) => void)
  ): void {
    if (type === "message") {
      this.#messageListeners.add(listener as (event: MessageEvent<unknown>) => void);
    } else if (type === "messageerror") {
      this.#messageErrorListeners.add(
        listener as (event: MessageEvent<unknown>) => void
      );
    } else {
      this.#errorListeners.add(listener as (event: ErrorEvent) => void);
    }
  }

  public removeEventListener(
    type: "message",
    listener: (event: MessageEvent<unknown>) => void
  ): void;
  public removeEventListener(
    type: "messageerror",
    listener: (event: MessageEvent<unknown>) => void
  ): void;
  public removeEventListener(type: "error", listener: (event: ErrorEvent) => void): void;
  public removeEventListener(
    type: "message" | "messageerror" | "error",
    listener:
      | ((event: MessageEvent<unknown>) => void)
      | ((event: ErrorEvent) => void)
  ): void {
    if (type === "message") {
      this.#messageListeners.delete(
        listener as (event: MessageEvent<unknown>) => void
      );
    } else if (type === "messageerror") {
      this.#messageErrorListeners.delete(
        listener as (event: MessageEvent<unknown>) => void
      );
    } else {
      this.#errorListeners.delete(listener as (event: ErrorEvent) => void);
    }
  }

  public terminate(): void {
    this.terminateCalls += 1;
  }
}
