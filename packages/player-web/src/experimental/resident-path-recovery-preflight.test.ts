import { describe, expect, it } from "vitest";

import type {
  EncodedVideoChunkFactory,
  VideoDecoderAdapter,
  VideoDecoderFactory
} from "./continuous-loop-decoder.js";
import { createEncodedLoopUnit, type EncodedLoopUnit } from "./encoded-loop.js";
import {
  preflightResidentPathRecovery,
  ResidentPathRecoveryReadinessError,
  type ResidentPathRecoveryEndpoint
} from "./resident-path-recovery-preflight.js";

describe("preflightResidentPathRecovery", () => {
  it("sequentially measures frame R with a fresh decoder per endpoint", async () => {
    const fixture = createAutoCodec();
    const now = clock([100, 140, 200, 281]);
    const uploads: string[] = [];

    const reports = await preflightResidentPathRecovery(
      [
        endpoint("resting", "source-body", 6),
        endpoint("engaged", "target-body", 8)
      ],
      {
        decoderFactory: fixture.decoderFactory,
        chunkFactory: fixture.chunkFactory,
        uploadContinuation: async (frame) => {
          uploads.push(`${frame.unitId}:${String(frame.pathFrame)}`);
        },
        now,
        timeoutMs: 100
      }
    );

    expect(reports).toEqual([
      {
        endpoint: "resting",
        unitId: "source-body",
        cachedRunwayFrames: 6,
        pathGeneration: 1,
        firstContinuationPathFrame: 6,
        elapsedMs: 40,
        frameDurationMs: 40,
        requiredContentFrames: 2,
        ready: true
      },
      {
        endpoint: "engaged",
        unitId: "target-body",
        cachedRunwayFrames: 8,
        pathGeneration: 1,
        firstContinuationPathFrame: 8,
        elapsedMs: 81,
        frameDurationMs: 40,
        requiredContentFrames: 4,
        ready: true
      }
    ]);
    expect(Object.isFrozen(reports)).toBe(true);
    expect(reports.every(Object.isFrozen)).toBe(true);
    expect(fixture.events).toEqual([
      "create:1",
      "configure:1",
      "close:1",
      "create:2",
      "configure:2",
      "close:2"
    ]);
    expect(fixture.maximumActiveDecoders).toBe(1);
    expect(uploads).toEqual(["source-body:6", "target-body:8"]);
    expect(fixture.decoders).toHaveLength(2);
    expect(
      fixture.decoders.every(
        (decoder) =>
          decoder.closeCalls === 1 &&
          decoder.frames.every((frame) => frame.closeCalls === 1)
      )
    ).toBe(true);
    expect(() => now()).toThrow("no clock samples remain");
  });

  it("accepts recovery exactly at the runway limit including safety", async () => {
    const fixture = createAutoCodec();

    const [report] = await preflightResidentPathRecovery(
      [endpoint("resting", "source-body", 6)],
      {
        decoderFactory: fixture.decoderFactory,
        chunkFactory: fixture.chunkFactory,
        uploadContinuation: async () => undefined,
        now: clock([0, 200]),
        timeoutMs: 100
      }
    );

    expect(report).toMatchObject({
      elapsedMs: 200,
      frameDurationMs: 40,
      requiredContentFrames: 6,
      ready: true
    });
  });

  it("fails readiness, freezes diagnostics, and stops measuring endpoints", async () => {
    const fixture = createAutoCodec();
    let failure: unknown;

    try {
      await preflightResidentPathRecovery(
        [
          endpoint("resting", "source-body", 6),
          endpoint("engaged", "target-body", 8)
        ],
        {
          decoderFactory: fixture.decoderFactory,
          chunkFactory: fixture.chunkFactory,
          uploadContinuation: async () => undefined,
          now: clock([0, 201]),
          timeoutMs: 100
        }
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(ResidentPathRecoveryReadinessError);
    const readiness = failure as ResidentPathRecoveryReadinessError;
    expect(readiness.message).toContain(
      "requires 7 content frames but its runway contains 6"
    );
    expect(readiness.endpointReport).toMatchObject({
      endpoint: "resting",
      firstContinuationPathFrame: 6,
      elapsedMs: 201,
      requiredContentFrames: 7,
      ready: false
    });
    expect(readiness.reports).toEqual([readiness.endpointReport]);
    expect(Object.isFrozen(readiness.endpointReport)).toBe(true);
    expect(Object.isFrozen(readiness.reports)).toBe(true);
    expect(fixture.decoders).toHaveLength(1);
    expect(fixture.decoders[0]?.closeCalls).toBe(1);
  });

  it("rejects invalid descriptors before allocating a decoder", async () => {
    const fixture = createAutoCodec();
    const invalid = {
      ...endpoint("resting", "source-body", 6),
      cachedRunwayFrames: 5
    };

    await expect(
      preflightResidentPathRecovery([invalid], {
        decoderFactory: fixture.decoderFactory,
        chunkFactory: fixture.chunkFactory,
        uploadContinuation: async () => undefined
      })
    ).rejects.toThrow("must be an integer from 6 through 12");
    expect(fixture.decoders).toHaveLength(0);
  });

  it("includes asynchronous continuation upload in the readiness budget", async () => {
    const fixture = createAutoCodec();
    let resolveUpload!: () => void;
    const upload = new Promise<void>((resolve) => {
      resolveUpload = resolve;
    });
    let clockValue = 0;
    const measured = preflightResidentPathRecovery(
      [endpoint("resting", "source-body", 6)],
      {
        decoderFactory: fixture.decoderFactory,
        chunkFactory: fixture.chunkFactory,
        uploadContinuation: async () => upload,
        now: () => clockValue,
        timeoutMs: 100
      }
    );
    await Promise.resolve();
    await Promise.resolve();
    clockValue = 80;
    resolveUpload();

    await expect(measured).resolves.toMatchObject([
      {
        elapsedMs: 80,
        frameDurationMs: 40,
        requiredContentFrames: 3,
        ready: true
      }
    ]);
  });
});

function endpoint(
  name: string,
  unitId: string,
  cachedRunwayFrames: number
): ResidentPathRecoveryEndpoint<string> {
  return {
    endpoint: name,
    unitId,
    unit: createUnit(),
    cachedRunwayFrames
  };
}

function createUnit(): EncodedLoopUnit {
  return createEncodedLoopUnit({
    config: {
      codec: "vp8",
      codedWidth: 2,
      codedHeight: 2,
      displayAspectWidth: 2,
      displayAspectHeight: 2
    },
    codedWidth: 2,
    codedHeight: 2,
    displayWidth: 2,
    displayHeight: 2,
    frameRate: { numerator: 25, denominator: 1 },
    frames: Array.from({ length: 16 }, (_, index) => ({
      type: index === 0 ? ("key" as const) : ("delta" as const),
      data: new Uint8Array([index])
    }))
  });
}

function clock(samples: readonly number[]): () => number {
  const remaining = [...samples];
  return () => {
    const sample = remaining.shift();
    if (sample === undefined) {
      throw new Error("no clock samples remain");
    }
    return sample;
  };
}

interface AutoCodecFixture {
  readonly events: string[];
  readonly decoders: AutoVideoDecoder[];
  readonly maximumActiveDecoders: number;
  readonly decoderFactory: VideoDecoderFactory;
  readonly chunkFactory: EncodedVideoChunkFactory;
}

function createAutoCodec(): AutoCodecFixture {
  const events: string[] = [];
  const decoders: AutoVideoDecoder[] = [];
  let activeDecoders = 0;
  let maximumActiveDecoders = 0;

  return {
    events,
    decoders,
    get maximumActiveDecoders(): number {
      return maximumActiveDecoders;
    },
    decoderFactory: (init) => {
      activeDecoders += 1;
      maximumActiveDecoders = Math.max(maximumActiveDecoders, activeDecoders);
      const ordinal = decoders.length + 1;
      events.push(`create:${String(ordinal)}`);
      const decoder = new AutoVideoDecoder(init, ordinal, events, () => {
        activeDecoders -= 1;
      });
      decoders.push(decoder);
      return decoder;
    },
    chunkFactory: (init) =>
      new FakeEncodedVideoChunk(init) as unknown as EncodedVideoChunk
  };
}

class FakeEncodedVideoChunk {
  public readonly type: EncodedVideoChunkType;
  public readonly timestamp: number;
  public readonly duration: number | null;

  public constructor(init: EncodedVideoChunkInit) {
    this.type = init.type;
    this.timestamp = init.timestamp;
    this.duration = init.duration ?? null;
  }
}

class FakeVideoFrame {
  public readonly timestamp: number;
  public readonly duration: number | null;
  public readonly codedWidth = 2;
  public readonly codedHeight = 2;
  public readonly displayWidth = 2;
  public readonly displayHeight = 2;
  public readonly visibleRect = { x: 0, y: 0, width: 2, height: 2 };
  public closeCalls = 0;

  public constructor(chunk: FakeEncodedVideoChunk) {
    this.timestamp = chunk.timestamp;
    this.duration = chunk.duration;
  }

  public close(): void {
    this.closeCalls += 1;
  }
}

class AutoVideoDecoder implements VideoDecoderAdapter {
  public configureCalls = 0;
  public closeCalls = 0;
  public readonly frames: FakeVideoFrame[] = [];
  readonly #init: VideoDecoderInit;
  readonly #ordinal: number;
  readonly #events: string[];
  readonly #onClose: () => void;
  #closed = false;
  #decodeQueueSize = 0;

  public constructor(
    init: VideoDecoderInit,
    ordinal: number,
    events: string[],
    onClose: () => void
  ) {
    this.#init = init;
    this.#ordinal = ordinal;
    this.#events = events;
    this.#onClose = onClose;
  }

  public get decodeQueueSize(): number {
    return this.#closed ? 0 : this.#decodeQueueSize;
  }

  public configure(_config: VideoDecoderConfig): void {
    this.configureCalls += 1;
    this.#events.push(`configure:${String(this.#ordinal)}`);
  }

  public decode(chunk: EncodedVideoChunk): void {
    const fake = chunk as unknown as FakeEncodedVideoChunk;
    this.#decodeQueueSize += 1;
    queueMicrotask(() => {
      this.#decodeQueueSize -= 1;
      if (this.#closed) {
        return;
      }
      const frame = new FakeVideoFrame(fake);
      this.frames.push(frame);
      this.#init.output(frame as unknown as VideoFrame);
    });
  }

  public flush(): Promise<void> {
    return Promise.resolve();
  }

  public close(): void {
    this.closeCalls += 1;
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#events.push(`close:${String(this.#ordinal)}`);
    this.#onClose();
  }
}
