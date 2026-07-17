import { describe, expect, it } from "vitest";

import { DecoderWorkerClient } from "./client.js";
import {
  type DecoderWorkerEventSink,
  DecoderWorkerCore,
  type WorkerVideoDecoderAdapter
} from "./core.js";
import {
  validateConfiguration,
  validateDecodedFrame,
  validateSupportResultConfiguration
} from "./core-validation.js";
import { DecoderWorkerHost } from "./host.js";
import {
  DECODER_WORKER_PROTOCOL_VERSION,
  type DecoderWorkerCommand,
  type DecoderWorkerClientPort,
  type DecoderWorkerEvent,
  type DecoderWorkerLimits,
  type DecoderWorkerMessagePort,
  type DecoderWorkerSample,
  type DecoderWorkerVideoProfile
} from "./protocol.js";

const CODECS = Object.freeze({
  h264: "avc1.640020",
  h265: "hvc1.1.6.L93.B0",
  vp9: "vp09.00.10.08.01.01.01.01.00",
  av1: "av01.0.04M.10.0.110.01.01.01.0"
} as const);

describe("codec-neutral decoder worker", () => {
  it.each([
    ["h264", 8],
    ["h265", 8],
    ["vp9", 8],
    ["av1", 10]
  ] as const)("accepts an exact %s WebCodecs configuration", (family, bitDepth) => {
    expect(() => validateConfiguration(
      decoderConfig(CODECS[family]),
      videoProfile(family, bitDepth),
      expectedOutput(),
      limits()
    )).not.toThrow();
  });

  it("rejects codec/profile mismatches and codec descriptions", () => {
    expect(() => validateConfiguration(
      decoderConfig(CODECS.h265),
      videoProfile("h264", 8),
      expectedOutput(),
      limits()
    )).toThrow(/codec family/iu);

    expect(() => validateConfiguration(
      {
        ...decoderConfig(CODECS.h264),
        description: new Uint8Array([1])
      },
      videoProfile("h264", 8),
      expectedOutput(),
      limits()
    )).toThrow(/unsupported field/iu);
  });

  it("accepts browser-default transform fields in the support echo", () => {
    const requested = decoderConfig(CODECS.av1);
    expect(() => validateSupportResultConfiguration(
      {
        ...requested,
        rotation: 0,
        flip: false
      },
      requested
    )).not.toThrow();
    expect(() => validateSupportResultConfiguration(
      { ...requested, rotation: 90 },
      requested
    )).toThrow(/rotation/iu);
    expect(() => validateSupportResultConfiguration(
      { ...requested, flip: true },
      requested
    )).toThrow(/flip/iu);
  });

  it.each([
    ["VP9", 128, 104, 0, 0, 48, 104],
    ["H.264", 48, 130, 0, 0, 48, 112],
    ["relocated", 128, 130, 32, 8, 48, 112]
  ] as const)(
    "accepts browser-owned %s decoder allocation padding",
    (
      _family,
      frameCodedWidth,
      frameCodedHeight,
      visibleX,
      visibleY,
      renditionWidth,
      renditionHeight
    ) => {
      const frame = {
        timestamp: 0,
        duration: 1_000,
        codedWidth: frameCodedWidth,
        codedHeight: frameCodedHeight,
        displayWidth: 48,
        displayHeight: 104,
        visibleRect: { x: visibleX, y: visibleY, width: 48, height: 104 },
        colorSpace: {
          fullRange: null,
          matrix: null,
          primaries: null,
          transfer: null
        }
      } as unknown as VideoFrame;

      expect(validateDecodedFrame(frame, {
        codedWidth: renditionWidth,
        codedHeight: renditionHeight,
        displayWidth: 48,
        displayHeight: 104,
        visibleRect: { x: 0, y: 0, width: 48, height: 104 },
        colorSpace: null
      }, 0, 1_000)).toBe(renditionWidth * renditionHeight * 4);
    }
  );

  it.each([
    ["Chromium", false],
    ["WebKit", true]
  ] as const)(
    "accepts %s sRGB transfer normalization of limited BT.709",
    (_browser, fullRange) => {
      const frame = decodedFrame({
        fullRange,
        matrix: "bt709",
        primaries: "bt709",
        transfer: "iec61966-2-1"
      });

      expect(validateDecodedFrame(frame, {
        ...expectedOutput(),
        colorSpace: {
          fullRange: false,
          matrix: "bt709",
          primaries: "bt709",
          transfer: "bt709"
        }
      }, 0, 1_000)).toBe(16);
    }
  );

  it("rejects contradictory metadata with an sRGB transfer normalization", () => {
    const frame = decodedFrame({
      fullRange: false,
      matrix: "bt709",
      primaries: "smpte170m",
      transfer: "iec61966-2-1"
    });

    expect(() => validateDecodedFrame(frame, expectedOutput(), 0, 1_000))
      .toThrow(/color space/iu);
  });

  it("probes before configuration without consuming configure-once state", async () => {
    const fixture = createFixture("vp9", 8);
    await fixture.handle({
      type: "probe-config",
      protocolVersion: DECODER_WORKER_PROTOCOL_VERSION,
      requestId: 1,
      config: decoderConfig(CODECS.vp9)
    });
    expect(fixture.events).toContainEqual(expect.objectContaining({
      type: "probe-result",
      requestId: 1,
      supported: true
    }));

    await fixture.configure(2);
    await fixture.configure(3);
    expect(fixture.decoder.configureCalls).toBe(1);
    expect(fixture.events).toContainEqual(expect.objectContaining({
      type: "error",
      requestId: 3,
      code: "ALREADY_CONFIGURED",
      fatal: false
    }));
  });

  it("publishes H.265 callbacks in presentation order rather than decode order", async () => {
    const fixture = createFixture("h265", 8);
    await fixture.configure(1);
    await fixture.activate(2, 1);
    await fixture.submit(3, 1, [
      sample({
        decodeIndex: 0,
        unitChunkCount: 3,
        unitFrameCount: 3,
        presentationIndices: [0],
        presentationTimestamp: 0,
        randomAccess: true,
        data: buffer(1)
      }),
      sample({
        decodeIndex: 1,
        unitChunkCount: 3,
        unitFrameCount: 3,
        presentationIndices: [2],
        presentationTimestamp: 2_000,
        randomAccess: false,
        data: buffer(2)
      }),
      sample({
        decodeIndex: 2,
        unitChunkCount: 3,
        unitFrameCount: 3,
        presentationIndices: [1],
        presentationTimestamp: 1_000,
        randomAccess: false,
        data: buffer(3)
      })
    ]);

    fixture.decoder.emit(0);
    fixture.decoder.emit(2_000);
    expect(frameEvents(fixture.events).map((event) => event.unitFrame)).toEqual([0]);
    fixture.decoder.emit(1_000);
    expect(frameEvents(fixture.events).map((event) => event.unitFrame)).toEqual([
      0,
      1,
      2
    ]);
    expect(frameEvents(fixture.events).map((event) => event.decodeIndex)).toEqual([
      0,
      2,
      1
    ]);

    fixture.decoder.resolveFlush(0);
    await settle();
    expect(fixture.core.snapshotMetrics()).toMatchObject({
      flushCalls: 1,
      boundaryFlushCalls: 1,
      outputFrames: 3,
      deliveredFrames: 3,
      submittedFrames: 0
    });
  });

  it.each(["vp9", "av1"] as const)(
    "accepts a hidden %s chunk without requiring an output",
    async (family) => {
      const bitDepth = family === "av1" ? 10 : 8;
      const fixture = createFixture(family, bitDepth);
      await fixture.configure(1);
      await fixture.activate(2, 1);
      await fixture.submit(3, 1, [
        sample({
          decodeIndex: 0,
          unitChunkCount: 2,
          unitFrameCount: 1,
          presentationIndices: [],
          presentationTimestamp: 0,
          duration: 0,
          randomAccess: true,
          displayedFrameCount: 0,
          data: buffer(4)
        }),
        sample({
          decodeIndex: 1,
          unitChunkCount: 2,
          unitFrameCount: 1,
          presentationIndices: [0],
          presentationTimestamp: 0,
          randomAccess: false,
          data: buffer(5)
        })
      ]);

      fixture.decoder.emit(0, 1);
      fixture.decoder.resolveFlush(0);
      await settle();
      expect(fixture.decoder.decoded.map((chunk) => chunk.type)).toEqual([
        "key",
        "delta"
      ]);
      expect(frameEvents(fixture.events)).toHaveLength(1);
      expect(fixture.core.snapshotMetrics()).toMatchObject({
        submittedChunks: 2,
        outputFrames: 1,
        deliveredFrames: 1,
        submittedFrames: 0
      });
    }
  );

  it("maps multiple displayed outputs from one chunk without a one-to-one assumption", async () => {
    const fixture = createFixture("vp9", 8);
    await fixture.configure(1);
    await fixture.activate(2, 1);
    await fixture.submit(3, 1, [sample({
      unitFrameCount: 2,
      presentationIndices: [0, 1],
      displayedFrameCount: 2
    })]);

    fixture.decoder.emit(1_000, 0);
    expect(frameEvents(fixture.events)).toHaveLength(0);
    fixture.decoder.emit(0, 0);
    expect(frameEvents(fixture.events).map((event) => event.ordinal)).toEqual([0, 1]);
    fixture.decoder.resolveFlush(0);
    await settle();
    expect(fixture.core.snapshotMetrics().outputFrames).toBe(2);
  });

  it("keeps partial unit state across submits and frees credit per displayed frame", async () => {
    const fixture = createFixture("h265", 8, limits({
      maxOutstandingFrames: 1,
      maxDecodedBytes: 16
    }));
    await fixture.configure(1);
    await fixture.activate(2, 1);

    await fixture.submit(3, 1, [unitChunk(0, 3, 3, 0, 10)]);
    fixture.decoder.emit(0);
    const first = frameEvents(fixture.events)[0]!;
    await fixture.handle(release(first.frameId));

    await fixture.submit(4, 1, [unitChunk(1, 3, 3, 1, 11)]);
    fixture.decoder.emit(1_000);
    const second = frameEvents(fixture.events)[1]!;
    await fixture.handle(release(second.frameId));

    await fixture.submit(5, 1, [unitChunk(2, 3, 3, 2, 12)]);
    fixture.decoder.emit(2_000);
    fixture.decoder.resolveFlush(0);
    await settle();

    expect(frameEvents(fixture.events).map((event) => event.unitFrame)).toEqual([
      0,
      1,
      2
    ]);
    expect(fixture.core.snapshotMetrics()).toMatchObject({
      acceptedSamples: 3,
      pendingSamples: 0,
      submittedFrames: 0,
      flushCalls: 1
    });
  });

  it("does not enter the next dependency group until the previous boundary flush resolves", async () => {
    const fixture = createFixture("h264", 8);
    await fixture.configure(1);
    await fixture.activate(2, 1);
    await fixture.submit(3, 1, [
      sample({ data: buffer(1) }),
      sample({
        unitId: "next",
        unitInstance: 1,
        presentationOrdinalBase: 1,
        presentationTimestamp: 1_000,
        data: buffer(2)
      })
    ]);

    expect(fixture.decoder.decoded).toHaveLength(1);
    fixture.decoder.emit(0);
    fixture.decoder.resolveFlush(0);
    await settle();
    expect(fixture.decoder.decoded).toHaveLength(2);
    expect(fixture.decoder.flushCalls).toBe(2);

    fixture.decoder.emit(1_000);
    fixture.decoder.resolveFlush(1);
    await settle();
    expect(frameEvents(fixture.events).map((event) => event.unitId)).toEqual([
      "unit",
      "next"
    ]);
  });

  it("allows hidden lookahead while frame credit is leased and rejects another display", async () => {
    const fixture = createFixture("av1", 10, limits({
      maxOutstandingFrames: 1,
      maxDecodedBytes: 16
    }));
    await fixture.configure(1);
    await fixture.activate(2, 1);
    await fixture.submit(3, 1, [sample({ data: buffer(1) })]);
    fixture.decoder.emit(0);
    fixture.decoder.resolveFlush(0);
    await settle();

    await fixture.submit(4, 1, [sample({
      unitId: "lookahead",
      unitInstance: 1,
      unitChunkCount: 2,
      presentationOrdinalBase: 1,
      decodeIndex: 0,
      unitFrameCount: 1,
      presentationIndices: [],
      displayedFrameCount: 0,
      duration: 0,
      randomAccess: true,
      data: buffer(2)
    })]);
    expect(lastEvent(fixture.events)).toMatchObject({
      type: "ack",
      operation: "submit"
    });

    await fixture.submit(5, 1, [sample({
      unitId: "lookahead",
      unitInstance: 1,
      unitChunkCount: 2,
      presentationOrdinalBase: 1,
      decodeIndex: 1,
      unitFrameCount: 1,
      presentationIndices: [0],
      presentationTimestamp: 1_000,
      data: buffer(3)
    })]);
    expect(lastEvent(fixture.events)).toMatchObject({
      type: "error",
      code: "BACKPRESSURE_LIMIT",
      fatal: false
    });
  });

  it("closes delayed output from an aborted generation and drains the replacement", async () => {
    const fixture = createFixture("h265", 8);
    await fixture.configure(1);
    await fixture.activate(2, 1);
    await fixture.submit(3, 1, [sample()]);

    await fixture.activate(4, 2);
    const stale = fixture.decoder.emit(0);
    expect(stale.closeCalls).toBe(1);
    fixture.decoder.resolveFlush(0);
    await settle();

    await fixture.submit(5, 2, [sample({
      presentationOrdinalBase: 1,
      presentationTimestamp: 1_000,
      data: buffer(2)
    })]);
    fixture.decoder.emit(1_000);
    fixture.decoder.resolveFlush(1);
    await settle();
    expect(frameEvents(fixture.events)).toHaveLength(1);
    expect(frameEvents(fixture.events)[0]).toMatchObject({
      generation: 2,
      ordinal: 1
    });
    expect(fixture.core.snapshotMetrics().staleFrames).toBe(1);
  });

  it("fails closed when a hidden chunk unexpectedly produces a frame", async () => {
    const fixture = createFixture("vp9", 8);
    await fixture.configure(1);
    await fixture.activate(2, 1);
    await fixture.submit(3, 1, [sample({
      unitChunkCount: 2,
      presentationIndices: [],
      displayedFrameCount: 0,
      duration: 0,
      data: buffer(1)
    })]);

    const unexpected = fixture.decoder.emit(0);
    expect(unexpected.closeCalls).toBe(1);
    expect(fixture.decoder.closeCalls).toBe(1);
    expect(lastEvent(fixture.events)).toMatchObject({
      type: "error",
      code: "DECODER_OUTPUT_INVALID",
      fatal: true
    });
  });

  it("round-trips the generic contract through host/client ownership", async () => {
    const { clientPort, workerPort } = createPortPair();
    let decoder: FakeVideoDecoder | undefined;
    const host = new DecoderWorkerHost(workerPort, {
      supportProbe: async (config) => ({ supported: true, config }),
      decoderFactory: (init) => {
        decoder = new FakeVideoDecoder(init);
        return decoder;
      },
      chunkFactory: (init) =>
        new FakeEncodedVideoChunk(init) as unknown as EncodedVideoChunk
    });
    const client = new DecoderWorkerClient(clientPort, {
      disposeTimeoutMs: 100,
      requestTimeoutMs: 100
    });

    await expect(client.probeConfig(decoderConfig(CODECS.av1))).resolves.toBe(true);
    await client.configure({
      config: decoderConfig(CODECS.av1),
      videoProfile: videoProfile("av1", 10),
      expectedOutput: expectedOutput(),
      limits: limits()
    });
    await client.activateGeneration(1);
    await client.submit(1, [sample()]);
    if (decoder === undefined) throw new Error("decoder was not constructed");
    decoder.emit(0);
    decoder.resolveFlush(0);
    await client.waitForFrames(1, { timeoutMs: 100 });

    const managed = client.takeFrame();
    expect(managed).toMatchObject({
      ordinal: 0,
      unitFrame: 0,
      decodeIndex: 0,
      timestamp: 0
    });
    managed?.close();
    await settle();
    await expect(client.snapshotMetrics()).resolves.toMatchObject({
      releasedFrames: 1,
      leasedFrames: 0
    });

    await client.dispose();
    host.detach();
    expect(clientPort.terminateCalls).toBe(1);
  });
});

interface Fixture {
  readonly core: DecoderWorkerCore;
  readonly decoder: FakeVideoDecoder;
  readonly events: DecoderWorkerEvent[];
  configure(requestId: number): Promise<void>;
  activate(requestId: number, generation: number): Promise<void>;
  submit(
    requestId: number,
    generation: number,
    samples: readonly DecoderWorkerSample[]
  ): Promise<void>;
  handle(command: DecoderWorkerCommand): Promise<void>;
}

function createFixture(
  family: keyof typeof CODECS,
  bitDepth: 8 | 10,
  workerLimits = limits()
): Fixture {
  const events: DecoderWorkerEvent[] = [];
  let decoder: FakeVideoDecoder | undefined;
  const emit: DecoderWorkerEventSink = (event) => {
    events.push(event);
  };
  const core = new DecoderWorkerCore({
    emit,
    supportProbe: async (config) => ({ supported: true, config }),
    decoderFactory: (init) => {
      decoder = new FakeVideoDecoder(init);
      return decoder;
    },
    chunkFactory: (init) =>
      new FakeEncodedVideoChunk(init) as unknown as EncodedVideoChunk
  });
  const handle = (command: DecoderWorkerCommand) => core.handle(command);
  return {
    core,
    events,
    get decoder(): FakeVideoDecoder {
      if (decoder === undefined) throw new Error("decoder is not configured");
      return decoder;
    },
    configure: (requestId) => handle({
      type: "configure",
      protocolVersion: DECODER_WORKER_PROTOCOL_VERSION,
      requestId,
      config: decoderConfig(CODECS[family]),
      videoProfile: videoProfile(family, bitDepth),
      expectedOutput: expectedOutput(),
      limits: workerLimits
    }),
    activate: (requestId, generation) => handle({
      type: "activate-generation",
      protocolVersion: DECODER_WORKER_PROTOCOL_VERSION,
      requestId,
      generation
    }),
    submit: (requestId, generation, samples) => handle({
      type: "submit",
      protocolVersion: DECODER_WORKER_PROTOCOL_VERSION,
      requestId,
      generation,
      samples
    }),
    handle
  };
}

function decoderConfig(codec: string): VideoDecoderConfig {
  return {
    codec,
    codedWidth: 2,
    codedHeight: 2,
    displayAspectWidth: 2,
    displayAspectHeight: 2,
    colorSpace: {
      primaries: "bt709",
      transfer: "bt709",
      matrix: "bt709",
      fullRange: false
    }
  };
}

function videoProfile(
  codecFamily: DecoderWorkerVideoProfile["codecFamily"],
  bitDepth: 8 | 10
): DecoderWorkerVideoProfile {
  return {
    codecFamily,
    bitDepth,
    codedWidth: 2,
    codedHeight: 2,
    frameRate: { numerator: 1_000, denominator: 1 },
    requireBt709LimitedRange: true
  };
}

function expectedOutput() {
  return {
    codedWidth: 2,
    codedHeight: 2,
    displayWidth: 2,
    displayHeight: 2,
    visibleRect: { x: 0, y: 0, width: 2, height: 2 },
    colorSpace: null
  } as const;
}

function decodedFrame(colorSpace: VideoColorSpaceInit): VideoFrame {
  return {
    timestamp: 0,
    duration: 1_000,
    codedWidth: 2,
    codedHeight: 2,
    displayWidth: 2,
    displayHeight: 2,
    visibleRect: { x: 0, y: 0, width: 2, height: 2 },
    colorSpace
  } as unknown as VideoFrame;
}

function limits(
  overrides: Partial<DecoderWorkerLimits> = {}
): DecoderWorkerLimits {
  const maxOutstandingFrames = overrides.maxOutstandingFrames ?? 4;
  return {
    maxDecodeQueueSize: 4,
    maxPendingSamples: 8,
    maxOutstandingFrames,
    maxDecodedBytes: 16 * maxOutstandingFrames,
    ...overrides
  };
}

function sample(
  overrides: Partial<DecoderWorkerSample> = {}
): DecoderWorkerSample {
  return {
    unitId: "unit",
    unitInstance: 0,
    decodeIndex: 0,
    unitChunkCount: 1,
    unitFrameCount: 1,
    presentationOrdinalBase: 0,
    presentationIndices: [0],
    presentationTimestamp: 0,
    duration: 1_000,
    randomAccess: true,
    displayedFrameCount: 1,
    data: buffer(0),
    ...overrides
  };
}

function unitChunk(
  decodeIndex: number,
  unitChunkCount: number,
  unitFrameCount: number,
  presentationIndex: number,
  tag: number
): DecoderWorkerSample {
  return sample({
    decodeIndex,
    unitChunkCount,
    unitFrameCount,
    presentationIndices: [presentationIndex],
    presentationTimestamp: presentationIndex * 1_000,
    randomAccess: decodeIndex === 0,
    data: buffer(tag)
  });
}

function release(frameId: number): DecoderWorkerCommand {
  return {
    type: "release-frame",
    protocolVersion: DECODER_WORKER_PROTOCOL_VERSION,
    frameId
  };
}

function buffer(tag: number): ArrayBuffer {
  return new Uint8Array([tag]).buffer;
}

function frameEvents(
  events: readonly DecoderWorkerEvent[]
): Array<Extract<DecoderWorkerEvent, { readonly type: "frame" }>> {
  return events.filter(
    (event): event is Extract<DecoderWorkerEvent, { readonly type: "frame" }> =>
      event.type === "frame"
  );
}

function lastEvent(events: readonly DecoderWorkerEvent[]): DecoderWorkerEvent {
  const event = events.at(-1);
  if (event === undefined) throw new Error("no worker event was emitted");
  return event;
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

class FakeEncodedVideoChunk {
  public readonly type: EncodedVideoChunkType;
  public readonly timestamp: number;
  public readonly duration: number | null;
  public readonly data: Uint8Array;

  public constructor(init: EncodedVideoChunkInit) {
    this.type = init.type;
    this.timestamp = init.timestamp;
    this.duration = init.duration ?? null;
    const source = ArrayBuffer.isView(init.data)
      ? new Uint8Array(init.data.buffer, init.data.byteOffset, init.data.byteLength)
      : new Uint8Array(init.data);
    this.data = new Uint8Array(source);
  }
}

class FakeVideoFrame {
  public readonly timestamp: number;
  public readonly duration: number;
  public readonly codedWidth = 2;
  public readonly codedHeight = 2;
  public readonly displayWidth = 2;
  public readonly displayHeight = 2;
  public readonly visibleRect = { x: 0, y: 0, width: 2, height: 2 };
  public readonly colorSpace = {
    fullRange: null,
    matrix: null,
    primaries: null,
    transfer: null
  };
  public closeCalls = 0;

  public constructor(timestamp: number, duration: number) {
    this.timestamp = timestamp;
    this.duration = duration;
  }

  public close(): void {
    this.closeCalls += 1;
  }
}

class FakeVideoDecoder implements WorkerVideoDecoderAdapter {
  public decodeQueueSize = 0;
  public configureCalls = 0;
  public flushCalls = 0;
  public closeCalls = 0;
  public readonly decoded: FakeEncodedVideoChunk[] = [];
  readonly #init: VideoDecoderInit;
  readonly #flushes: Array<{
    readonly resolve: () => void;
    readonly reject: (reason: unknown) => void;
  }> = [];
  #dequeue: (() => void) | undefined;

  public constructor(init: VideoDecoderInit) {
    this.#init = init;
  }

  public setDequeueCallback(callback: () => void): void {
    this.#dequeue = callback;
  }

  public configure(_config: VideoDecoderConfig): void {
    this.configureCalls += 1;
  }

  public decode(chunk: EncodedVideoChunk): void {
    this.decoded.push(chunk as unknown as FakeEncodedVideoChunk);
  }

  public flush(): Promise<void> {
    this.flushCalls += 1;
    return new Promise<void>((resolve, reject) => {
      this.#flushes.push({ resolve, reject });
    });
  }

  public resolveFlush(index: number): void {
    const flush = this.#flushes[index];
    if (flush === undefined) throw new Error("flush is unavailable");
    flush.resolve();
  }

  public emit(timestamp: number, chunkIndex?: number): FakeVideoFrame {
    const chunk = chunkIndex === undefined
      ? this.decoded.find((candidate) => candidate.timestamp === timestamp)
      : this.decoded[chunkIndex];
    if (chunk === undefined) throw new Error("decoded chunk is unavailable");
    const frame = new FakeVideoFrame(
      timestamp,
      chunk.duration ?? 0
    );
    this.#init.output(frame as unknown as VideoFrame);
    return frame;
  }

  public close(): void {
    this.closeCalls += 1;
    this.#dequeue = undefined;
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
  public addEventListener(
    type: "error",
    listener: (event: ErrorEvent) => void
  ): void;
  public addEventListener(
    type: "message" | "messageerror" | "error",
    listener:
      | ((event: MessageEvent<unknown>) => void)
      | ((event: ErrorEvent) => void)
  ): void {
    if (type === "message") {
      this.#messageListeners.add(
        listener as (event: MessageEvent<unknown>) => void
      );
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
  public removeEventListener(
    type: "error",
    listener: (event: ErrorEvent) => void
  ): void;
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

  public terminateFromPeer(): void {
    this.#terminated = true;
  }
}
