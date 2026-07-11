import { describe, expect, it } from "vitest";

import type {
  EncodedVideoChunkFactory,
  VideoDecoderAdapter,
  VideoDecoderFactory
} from "./continuous-loop-decoder.js";
import { createEncodedLoopUnit, type EncodedLoopUnit } from "./encoded-loop.js";
import {
  prepareResidentFrames,
  type ResidentFrameUploadTarget,
  type ResidentPreparationUnit
} from "./resident-frame-preparation.js";
import {
  createResidentFramePlan,
  type ResidentFrameKey
} from "./resident-frame-plan.js";
import type { ResidentFrameHandle } from "./webgl-frame-renderer.js";

describe("prepareResidentFrames", () => {
  it("decodes only required prefixes, uploads unique layers, and closes dependencies", async () => {
    const plan = createPlan();
    const codec = createFakeCodec();
    const uploader = new FakeUploader();

    const report = await prepareResidentFrames(plan, createUnits(), uploader, {
      decoderOptions: {
        decoderFactory: codec.decoderFactory,
        chunkFactory: codec.chunkFactory
      }
    });

    expect(report).toEqual({
      decoderCount: 3,
      decodedFrames: 9,
      uploadedFrames: plan.layerCount,
      dependencyFramesClosed: 3,
      sourceFramesClosed: 9,
      resourceGeneration: 4
    });
    expect(uploader.uploads).toEqual([
      [0, 0],
      [1, 2],
      [2, 0],
      [3, 2],
      [4, 0],
      [5, 2]
    ]);
    expect(codec.frames).toHaveLength(9);
    expect(codec.frames.every((frame) => frame.closed)).toBe(true);
    expect(codec.decoders).toHaveLength(3);
    expect(codec.decoders.every((decoder) => decoder.closeCalls === 1)).toBe(
      true
    );
  });

  it("rejects a missing or out-of-range encoded identity before allocating a decoder", async () => {
    const codec = createFakeCodec();
    const uploader = new FakeUploader();
    const plan = createPlan();

    await expect(
      prepareResidentFrames(plan, createUnits().slice(0, 2), uploader, {
        decoderOptions: {
          decoderFactory: codec.decoderFactory,
          chunkFactory: codec.chunkFactory
        }
      })
    ).rejects.toThrow(/has no encoded unit/);
    expect(codec.decoders).toHaveLength(0);

    const shortTarget = createUnits().map((descriptor) =>
      descriptor.id === "target"
        ? { ...descriptor, unit: createUnit(2) }
        : descriptor
    );
    await expect(
      prepareResidentFrames(plan, shortTarget, uploader, {
        decoderOptions: {
          decoderFactory: codec.decoderFactory,
          chunkFactory: codec.chunkFactory
        }
      })
    ).rejects.toThrow(/exceeds its encoded unit/);
    expect(codec.decoders).toHaveLength(0);
  });

  it("closes every transferred and decoder-owned frame when resource generation is stale", async () => {
    const codec = createFakeCodec();
    const uploader = new FakeUploader(1);

    await expect(
      prepareResidentFrames(createPlan(), createUnits(), uploader, {
        decoderOptions: {
          decoderFactory: codec.decoderFactory,
          chunkFactory: codec.chunkFactory
        }
      })
    ).rejects.toMatchObject({ name: "AbortError" });
    await Promise.resolve();
    await Promise.resolve();

    expect(codec.frames.length).toBeGreaterThan(0);
    expect(codec.frames.every((frame) => frame.closed)).toBe(true);
    expect(codec.decoders[0]?.closeCalls).toBe(1);
  });

  it("honors an already-aborted signal without constructing a decoder", async () => {
    const codec = createFakeCodec();
    const controller = new AbortController();
    controller.abort();

    await expect(
      prepareResidentFrames(createPlan(), createUnits(), new FakeUploader(), {
        signal: controller.signal,
        decoderOptions: {
          decoderFactory: codec.decoderFactory,
          chunkFactory: codec.chunkFactory
        }
      })
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(codec.decoders).toHaveLength(0);
  });

  it("terminally drains a finite prefix when the codec retains all outputs", async () => {
    const codec = createFakeCodec(true);
    const plan = createPlan();

    const report = await prepareResidentFrames(
      plan,
      createUnits(),
      new FakeUploader(),
      {
        decoderOptions: {
          decoderFactory: codec.decoderFactory,
          chunkFactory: codec.chunkFactory
        }
      }
    );

    expect(report.uploadedFrames).toBe(plan.layerCount);
    expect(codec.decoders).toHaveLength(3);
    expect(codec.decoders.every(({ flushCalls }) => flushCalls === 1)).toBe(true);
    expect(codec.frames.every(({ closed }) => closed)).toBe(true);
  });

  it("submits and terminally drains the advertised 24-frame clip", async () => {
    const codec = createFakeCodec(true);
    const plan = createResidentFramePlan({
      width: 2,
      height: 2,
      sourceRunway: repeatedRunway("source"),
      clip: Array.from({ length: 24 }, (_, frame) => key("clip", frame)),
      targetRunway: repeatedRunway("target"),
      deviceLimits: {
        maxArrayTextureLayers: 128,
        maxTextureSize: 4_096
      }
    });
    const units = [
      { rendition: "main", id: "source", unit: createUnit(3) },
      { rendition: "main", id: "clip", unit: createUnit(24) },
      { rendition: "main", id: "target", unit: createUnit(3) }
    ];

    const report = await prepareResidentFrames(plan, units, new FakeUploader(), {
      decoderOptions: {
        decoderFactory: codec.decoderFactory,
        chunkFactory: codec.chunkFactory
      }
    });

    expect(report.uploadedFrames).toBe(plan.layerCount);
    expect(report.decodedFrames).toBe(30);
    expect(codec.decoders).toHaveLength(3);
    expect(codec.decoders[1]?.flushCalls).toBe(1);
    expect(codec.frames).toHaveLength(30);
    expect(codec.frames.every(({ closed }) => closed)).toBe(true);
  });
});

function createPlan() {
  return createResidentFramePlan({
    width: 2,
    height: 2,
    sourceRunway: repeatedRunway("source"),
    clip: [key("clip", 0), key("clip", 2)],
    targetRunway: repeatedRunway("target"),
    deviceLimits: {
      maxArrayTextureLayers: 128,
      maxTextureSize: 4_096
    }
  });
}

function repeatedRunway(unit: string): readonly ResidentFrameKey[] {
  return [0, 2, 0, 2, 0, 2].map((localFrame) => key(unit, localFrame));
}

function key(unit: string, localFrame: number): ResidentFrameKey {
  return { rendition: "main", unit, localFrame };
}

function createUnits(): readonly ResidentPreparationUnit[] {
  return ["source", "clip", "target"].map((id) => ({
    rendition: "main",
    id,
    unit: createUnit(3)
  }));
}

function createUnit(frameCount: number): EncodedLoopUnit {
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
    frameRate: { numerator: 30, denominator: 1 },
    frames: Array.from({ length: frameCount }, (_, index) => ({
      type: index === 0 ? ("key" as const) : ("delta" as const),
      data: new Uint8Array([index])
    }))
  });
}

class FakeUploader implements ResidentFrameUploadTarget {
  public readonly resourceGeneration = 4;
  public readonly uploads: Array<[number, number]> = [];
  readonly #nullAtUpload: number | null;

  public constructor(nullAtUpload: number | null = null) {
    this.#nullAtUpload = nullAtUpload;
  }

  public async uploadResident(
    layer: number,
    source: Parameters<ResidentFrameUploadTarget["uploadResident"]>[1]
  ): Promise<ResidentFrameHandle | null> {
    const fake = source.frame as unknown as FakeVideoFrame;
    this.uploads.push([layer, fake.tag]);
    source.close();
    if (this.#nullAtUpload === this.uploads.length) {
      return null;
    }
    return {
      kind: "resident",
      layer,
      resourceGeneration: this.resourceGeneration
    };
  }
}

function createFakeCodec(holdOutputsUntilFlush = false): {
  readonly decoders: FakeVideoDecoder[];
  readonly frames: FakeVideoFrame[];
  readonly decoderFactory: VideoDecoderFactory;
  readonly chunkFactory: EncodedVideoChunkFactory;
} {
  const decoders: FakeVideoDecoder[] = [];
  const frames: FakeVideoFrame[] = [];
  return {
    decoders,
    frames,
    decoderFactory(init) {
      const decoder = new FakeVideoDecoder(init, frames, holdOutputsUntilFlush);
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
  public readonly codedWidth = 2;
  public readonly codedHeight = 2;
  public readonly displayWidth = 2;
  public readonly displayHeight = 2;
  public readonly visibleRect = { x: 0, y: 0, width: 2, height: 2 };
  public closed = false;

  public constructor(chunk: FakeEncodedVideoChunk) {
    this.timestamp = chunk.timestamp;
    this.duration = chunk.duration;
    this.tag = chunk.data[0] ?? -1;
  }

  public close(): void {
    if (this.closed) {
      throw new Error("fake VideoFrame closed more than once");
    }
    this.closed = true;
  }
}

class FakeVideoDecoder implements VideoDecoderAdapter {
  public decodeQueueSize = 0;
  public closeCalls = 0;
  public flushCalls = 0;
  readonly #init: VideoDecoderInit;
  readonly #frames: FakeVideoFrame[];
  readonly #holdOutputsUntilFlush: boolean;
  readonly #pending: FakeVideoFrame[] = [];

  public constructor(
    init: VideoDecoderInit,
    frames: FakeVideoFrame[],
    holdOutputsUntilFlush: boolean
  ) {
    this.#init = init;
    this.#frames = frames;
    this.#holdOutputsUntilFlush = holdOutputsUntilFlush;
  }

  public configure(_config: VideoDecoderConfig): void {}

  public decode(chunk: EncodedVideoChunk): void {
    this.decodeQueueSize += 1;
    const frame = new FakeVideoFrame(
      chunk as unknown as FakeEncodedVideoChunk
    );
    this.#frames.push(frame);
    if (this.#holdOutputsUntilFlush) {
      this.#pending.push(frame);
      return;
    }
    queueMicrotask(() => {
      this.#emit(frame);
    });
  }

  public async flush(): Promise<void> {
    this.flushCalls += 1;
    for (const frame of this.#pending.splice(0)) {
      this.#emit(frame);
    }
    await Promise.resolve();
  }

  public close(): void {
    this.closeCalls += 1;
  }

  #emit(frame: FakeVideoFrame): void {
    this.decodeQueueSize -= 1;
    this.#init.output(frame as unknown as VideoFrame);
  }
}
