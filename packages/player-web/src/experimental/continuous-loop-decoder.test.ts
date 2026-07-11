import { describe, expect, it } from "vitest";

import {
  ContinuousLoopDecoder,
  type EncodedVideoChunkFactory,
  type VideoDecoderAdapter,
  type VideoDecoderFactory
} from "./continuous-loop-decoder.js";
import { createEncodedLoopUnit, type EncodedLoopUnit } from "./encoded-loop.js";
import {
  STRESS_LOOP_OUTPUT_FRAMES,
  STRESS_LOOP_SEAMS,
  runContinuousLoopStress
} from "./stress-loop.js";

describe("ContinuousLoopDecoder", () => {
  it("replays one unit without boundary codec operations", async () => {
    const fixture = createFakeCodecFixture();
    const decoder = new ContinuousLoopDecoder(createUnit(), {
      maxInFlight: 4,
      decoderFactory: fixture.decoderFactory,
      chunkFactory: fixture.chunkFactory
    });

    const stopBefore = 10n;
    decoder.fillToAhead(4, stopBefore);
    for (let ordinal = 0; ordinal < 10; ordinal += 1) {
      await decoder.waitForFrames(1, { timeoutMs: 1_000 });
      const decoded = decoder.takeFrame();
      expect(decoded?.virtualFrame).toBe(BigInt(ordinal));
      expect(decoded?.contentFrame).toBe(ordinal % 2);
      decoded?.close();
      decoder.fillToAhead(4, stopBefore);
    }

    await decoder.terminalFlush();
    const metrics = decoder.snapshotMetrics();
    expect(metrics).toMatchObject({
      configureCalls: 1,
      resetCalls: 0,
      boundaryFlushCalls: 0,
      terminalFlushCalls: 1,
      submittedChunks: 10,
      outputFrames: 10,
      closedFrames: 10,
      openFrames: 0,
      queuedFrames: 0,
      errors: 0
    });
    expect(fixture.decoder.configureCalls).toBe(1);
    expect(fixture.decoder.flushCalls).toBe(1);

    decoder.dispose();
    decoder.dispose();
    expect(fixture.decoder.closeCalls).toBe(1);
  });

  it("passes the fixed 1,000-seam stress gate", async () => {
    const fixture = createFakeCodecFixture();
    const report = await runContinuousLoopStress(createUnit(), {
      decoderFactory: fixture.decoderFactory,
      chunkFactory: fixture.chunkFactory,
      readTag: (frame) => (frame as unknown as FakeVideoFrame).tag
    });

    expect(report.outputFrames).toBe(STRESS_LOOP_OUTPUT_FRAMES);
    expect(report.seams).toBe(STRESS_LOOP_SEAMS);
    expect(report.validatedTags).toBe(STRESS_LOOP_OUTPUT_FRAMES);
    expect(report.metrics).toMatchObject({
      configureCalls: 1,
      terminalFlushCalls: 1,
      resetCalls: 0,
      boundaryFlushCalls: 0,
      openFrames: 0,
      disposed: true
    });
  });

  it("rejects and closes decoder output with unexpected dimensions", async () => {
    const fixture = createFakeCodecFixture(4);
    const decoder = new ContinuousLoopDecoder(createUnit(), {
      decoderFactory: fixture.decoderFactory,
      chunkFactory: fixture.chunkFactory
    });

    decoder.fillToAhead(1, 1);
    await expect(
      decoder.waitForFrames(1, { timeoutMs: 1_000 })
    ).rejects.toThrow("does not match the encoded loop unit");
    expect(decoder.snapshotMetrics()).toMatchObject({
      outputFrames: 1,
      closedFrames: 1,
      openFrames: 0,
      inFlightFrames: 0,
      errors: 1
    });
    expect(fixture.decoder.closeCalls).toBe(1);

    decoder.dispose();
  });
});

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
    frameRate: { numerator: 60, denominator: 1 },
    frames: [
      { type: "key", data: new Uint8Array([0]) },
      { type: "delta", data: new Uint8Array([1]) }
    ]
  });
}

function createFakeCodecFixture(frameWidth = 2): {
  readonly decoder: FakeVideoDecoder;
  readonly decoderFactory: VideoDecoderFactory;
  readonly chunkFactory: EncodedVideoChunkFactory;
} {
  let decoder: FakeVideoDecoder | undefined;
  const decoderFactory: VideoDecoderFactory = (init) => {
    decoder = new FakeVideoDecoder(init, frameWidth);
    return decoder;
  };
  const chunkFactory: EncodedVideoChunkFactory = (init) =>
    new FakeEncodedVideoChunk(init) as unknown as EncodedVideoChunk;

  // Construction is lazy, so expose the eventual instance through getters.
  return {
    get decoder(): FakeVideoDecoder {
      if (decoder === undefined) {
        throw new Error("fake decoder has not been constructed");
      }
      return decoder;
    },
    decoderFactory,
    chunkFactory
  };
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
      ? new Uint8Array(
          init.data.buffer,
          init.data.byteOffset,
          init.data.byteLength
        )
      : new Uint8Array(init.data);
    this.data = new Uint8Array(source);
  }
}

class FakeVideoFrame {
  public readonly timestamp: number;
  public readonly duration: number | null;
  public readonly tag: number;
  public readonly codedWidth: number;
  public readonly codedHeight = 2;
  public readonly displayWidth: number;
  public readonly displayHeight = 2;
  public readonly visibleRect = { x: 0, y: 0, width: 2, height: 2 };
  public closed = false;

  public constructor(chunk: FakeEncodedVideoChunk, width: number) {
    this.timestamp = chunk.timestamp;
    this.duration = chunk.duration;
    this.tag = chunk.data[0] ?? -1;
    this.codedWidth = width;
    this.displayWidth = width;
  }

  public close(): void {
    this.closed = true;
  }
}

class FakeVideoDecoder implements VideoDecoderAdapter {
  public decodeQueueSize = 0;
  public configureCalls = 0;
  public flushCalls = 0;
  public closeCalls = 0;
  readonly #init: VideoDecoderInit;
  readonly #frameWidth: number;

  public constructor(init: VideoDecoderInit, frameWidth: number) {
    this.#init = init;
    this.#frameWidth = frameWidth;
  }

  public configure(_config: VideoDecoderConfig): void {
    this.configureCalls += 1;
  }

  public decode(chunk: EncodedVideoChunk): void {
    this.decodeQueueSize += 1;
    const fakeChunk = chunk as unknown as FakeEncodedVideoChunk;
    queueMicrotask(() => {
      this.decodeQueueSize -= 1;
      this.#init.output(
        new FakeVideoFrame(fakeChunk, this.#frameWidth) as unknown as VideoFrame
      );
    });
  }

  public async flush(): Promise<void> {
    this.flushCalls += 1;
    await Promise.resolve();
  }

  public close(): void {
    this.closeCalls += 1;
  }
}
