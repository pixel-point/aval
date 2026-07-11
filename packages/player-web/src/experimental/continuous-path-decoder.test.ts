import { describe, expect, it } from "vitest";

import {
  ContinuousPathDecoder,
  PathDecoderDisposedError,
  PathDecoderSupersededError,
  type ContinuousPathUnit
} from "./continuous-path-decoder.js";
import {
  type EncodedVideoChunkFactory,
  type VideoDecoderAdapter,
  type VideoDecoderFactory
} from "./continuous-loop-decoder.js";
import { createEncodedLoopUnit, type EncodedLoopUnit } from "./encoded-loop.js";
import { timestampForFrame } from "./rational-time.js";

describe("ContinuousPathDecoder", () => {
  it("keeps one configuration and monotonic timestamps across path generations", async () => {
    const fixture = createControlledCodec();
    const decoder = createDecoder(fixture, 2);

    const sourceGeneration = decoder.startPath("source", {
      aheadFrames: 2
    });
    expect(sourceGeneration).toBe(1);
    expect(fixture.decoder.chunks.map((chunk) => chunk.tag)).toEqual([10, 11]);

    const targetGeneration = decoder.startPath("target", {
      cachedRunwayFrames: 1,
      aheadFrames: 1
    });
    expect(targetGeneration).toBe(2);
    expect(fixture.decoder.chunks).toHaveLength(2);

    const staleZero = fixture.decoder.emitNext();
    expect(staleZero.closeCalls).toBe(1);
    expect(fixture.decoder.chunks).toHaveLength(2);

    const staleOne = fixture.decoder.emitNext();
    expect(staleOne.closeCalls).toBe(1);
    expect(fixture.decoder.chunks.map((chunk) => chunk.tag)).toEqual([
      10,
      11,
      20
    ]);

    const cachedRunway = fixture.decoder.emitNext();
    expect(cachedRunway.closeCalls).toBe(1);
    expect(fixture.decoder.chunks.map((chunk) => chunk.tag)).toEqual([
      10,
      11,
      20,
      21
    ]);

    const continuation = fixture.decoder.emitNext();
    await decoder.waitForFrames(1, { timeoutMs: 100 });
    const managed = decoder.takeFrame();
    expect(managed).toMatchObject({
      decodeOrdinal: 3n,
      pathGeneration: 2,
      unitId: "target",
      pathFrame: 1n,
      contentFrame: 1,
      purpose: "continuation"
    });
    expect(managed?.frame).toBe(continuation as unknown as VideoFrame);
    managed?.close();
    managed?.close();
    expect(continuation.closeCalls).toBe(1);

    expect(fixture.decoder.chunks.map((chunk) => chunk.timestamp)).toEqual(
      fixture.decoder.chunks.map((_chunk, ordinal) =>
        timestampForFrame(ordinal, { numerator: 30, denominator: 1 })
      )
    );
    expect(fixture.decoder.configureCalls).toBe(1);
    expect(fixture.decoder.flushCalls).toBe(0);
    expect(decoder.snapshotMetrics()).toMatchObject({
      configureCalls: 1,
      resetCalls: 0,
      flushCalls: 0,
      boundaryFlushCalls: 0,
      pathStarts: 2,
      outputFrames: 4,
      continuationOutputFrames: 1,
      cachedRunwayOutputs: 1,
      staleOutputs: 2,
      closedFrames: 4,
      openFrames: 0,
      maxInFlightFrames: 2,
      errors: 0,
      activeGeneration: 2,
      activeUnitId: "target"
    });

    decoder.dispose();
  });

  it("never exceeds the configured horizon while stale work drains", () => {
    const fixture = createControlledCodec();
    const decoder = createDecoder(fixture, 3);

    decoder.startPath("source", { aheadFrames: 3 });
    expect(fixture.decoder.pendingCount).toBe(3);
    decoder.startPath("target", { aheadFrames: 3 });
    expect(fixture.decoder.pendingCount).toBe(3);

    for (let index = 0; index < 3; index += 1) {
      fixture.decoder.emitNext();
      expect(fixture.decoder.pendingCount).toBe(3);
      expect(decoder.snapshotMetrics().inFlightFrames).toBe(3);
    }

    for (let index = 0; index < 3; index += 1) {
      fixture.decoder.emitNext();
      expect(fixture.decoder.pendingCount).toBe(2 - index);
      expect(decoder.snapshotMetrics().inFlightFrames).toBe(3);
    }

    expect(decoder.snapshotMetrics()).toMatchObject({
      submittedChunks: 6,
      outputFrames: 6,
      staleOutputs: 3,
      queuedFrames: 3,
      inFlightFrames: 3,
      maxInFlightFrames: 3
    });
    decoder.dispose();
  });

  it("closes queued and reordered outputs when a generation is superseded", () => {
    const fixture = createControlledCodec();
    const decoder = createDecoder(fixture, 3);

    decoder.startPath("source", { aheadFrames: 3 });
    const reordered = fixture.decoder.emitAt(1);
    expect(decoder.snapshotMetrics()).toMatchObject({
      reorderBufferedFrames: 1,
      queuedFrames: 0,
      openFrames: 1
    });
    const queued = fixture.decoder.emitNext();
    expect(decoder.snapshotMetrics()).toMatchObject({
      reorderBufferedFrames: 0,
      queuedFrames: 2,
      openFrames: 2
    });

    decoder.startPath("target", { aheadFrames: 3 });
    expect(reordered.closeCalls).toBe(1);
    expect(queued.closeCalls).toBe(1);
    expect(decoder.snapshotMetrics()).toMatchObject({
      staleOutputs: 2,
      queuedFrames: 0,
      reorderBufferedFrames: 0,
      openFrames: 0,
      inFlightFrames: 3
    });

    decoder.dispose();
  });

  it("skips every cached-runway duplicate and exposes frame R", async () => {
    const fixture = createControlledCodec();
    const decoder = createDecoder(fixture, 3);

    decoder.startPath("target", {
      cachedRunwayFrames: 2,
      aheadFrames: 3
    });
    const cachedZero = fixture.decoder.emitNext();
    const cachedOne = fixture.decoder.emitNext();
    const continuation = fixture.decoder.emitNext();

    expect(cachedZero.closeCalls).toBe(1);
    expect(cachedOne.closeCalls).toBe(1);
    expect(continuation.closeCalls).toBe(0);
    await decoder.waitForFrames(1, { timeoutMs: 100 });

    const frame = decoder.takeFrame();
    expect(frame).toMatchObject({
      pathFrame: 2n,
      contentFrame: 2,
      purpose: "continuation"
    });
    expect(decoder.snapshotMetrics()).toMatchObject({
      cachedRunwayOutputs: 2,
      continuationOutputFrames: 1,
      queuedFrames: 0
    });
    frame?.close();
    decoder.dispose();
  });

  it("rejects generation-specific waiters when their path is replaced", async () => {
    const fixture = createControlledCodec();
    const decoder = createDecoder(fixture, 1);

    decoder.startPath("source", { aheadFrames: 1 });
    const waiting = decoder.waitForFrames(1, { timeoutMs: 100 });
    decoder.startPath("target", { aheadFrames: 1 });

    await expect(waiting).rejects.toBeInstanceOf(PathDecoderSupersededError);
    decoder.dispose();
  });

  it("keeps transferred frames consumer-owned after a fatal decoder error", async () => {
    const fixture = createControlledCodec();
    const decoder = createDecoder(fixture, 3);

    decoder.startPath("source", { aheadFrames: 3 });
    const first = fixture.decoder.emitNext();
    const second = fixture.decoder.emitNext();
    const transferred = decoder.takeFrame();
    expect(transferred?.frame).toBe(first as unknown as VideoFrame);
    const waiting = decoder.waitForFrames(2, { timeoutMs: 100 });

    fixture.decoder.fail(new Error("synthetic decoder failure"));

    await expect(waiting).rejects.toThrow("synthetic decoder failure");
    expect(first.closeCalls).toBe(0);
    expect(second.closeCalls).toBe(1);
    expect(transferred?.closed).toBe(false);
    expect(decoder.snapshotMetrics()).toMatchObject({
      errors: 1,
      openFrames: 1,
      queuedFrames: 0,
      reorderBufferedFrames: 0,
      inFlightFrames: 0,
      decodeQueueSize: 0
    });
    expect(fixture.decoder.closeCalls).toBe(1);
    expect(() => decoder.fillToAhead()).toThrow("synthetic decoder failure");

    const late = fixture.decoder.emitNext();
    expect(late.closeCalls).toBe(1);
    expect(decoder.snapshotMetrics()).toMatchObject({
      outputFrames: 3,
      closedFrames: 2,
      openFrames: 1,
      errors: 1
    });

    transferred?.close();
    expect(first.closeCalls).toBe(1);
    expect(decoder.snapshotMetrics()).toMatchObject({
      closedFrames: 3,
      openFrames: 0
    });
    decoder.dispose();
  });

  it("does not close a transferred frame while an async consumer is copying it", async () => {
    const fixture = createControlledCodec();
    const decoder = createDecoder(fixture, 1);

    decoder.startPath("source", { aheadFrames: 1 });
    const output = fixture.decoder.emitNext();
    const transferred = decoder.takeFrame();
    if (transferred === undefined) {
      throw new Error("expected a continuation frame");
    }

    const copy = transferred.frame.copyTo(new Uint8Array(16));
    expect(output.pendingCopies).toBe(1);

    decoder.dispose();
    expect(output.closeCalls).toBe(0);
    expect(transferred.closed).toBe(false);
    expect(decoder.snapshotMetrics()).toMatchObject({
      disposed: true,
      openFrames: 1,
      closedFrames: 0
    });

    output.completeNextCopy();
    await copy;
    expect(output.closeCalls).toBe(0);

    transferred.close();
    expect(output.closeCalls).toBe(1);
    expect(decoder.snapshotMetrics()).toMatchObject({
      disposed: true,
      openFrames: 0,
      closedFrames: 1
    });
  });

  it("disposes queued and pending ownership idempotently without flushing", () => {
    const fixture = createControlledCodec();
    const decoder = createDecoder(fixture, 2);

    decoder.startPath("source", { aheadFrames: 2 });
    const queued = fixture.decoder.emitNext();
    decoder.dispose();
    decoder.dispose();

    expect(queued.closeCalls).toBe(1);
    expect(fixture.decoder.closeCalls).toBe(1);
    expect(fixture.decoder.flushCalls).toBe(0);
    expect(decoder.snapshotMetrics()).toMatchObject({
      disposed: true,
      openFrames: 0,
      queuedFrames: 0,
      inFlightFrames: 0,
      flushCalls: 0
    });
    expect(() => decoder.startPath("target")).toThrow(
      PathDecoderDisposedError
    );

    const late = fixture.decoder.emitNext();
    expect(late.closeCalls).toBe(1);
    expect(decoder.snapshotMetrics()).toMatchObject({
      outputFrames: 2,
      closedFrames: 2,
      openFrames: 0
    });
  });

  it("rejects incompatible units before allocating a decoder", () => {
    const fixture = createControlledCodec();
    const incompatible = createUnit(30, [30, 31], "vp8", 24);

    expect(
      () =>
        new ContinuousPathDecoder(
          [
            { id: "source", unit: createUnit(10) },
            { id: "incompatible", unit: incompatible }
          ],
          {
            decoderFactory: fixture.decoderFactory,
            chunkFactory: fixture.chunkFactory
          }
        )
    ).toThrow("not decoder-compatible");
    expect(fixture.created).toBe(false);
  });

  it("rejects a cached runway beyond the M2 resident bound", () => {
    const fixture = createControlledCodec();
    const decoder = createDecoder(fixture, 3);

    expect(() =>
      decoder.startPath("source", {
        cachedRunwayFrames: 13,
        aheadFrames: 3
      })
    ).toThrow("from 0 through 12");
    expect(decoder.snapshotMetrics()).toMatchObject({
      pathStarts: 0,
      submittedChunks: 0,
      inFlightFrames: 0
    });
    decoder.dispose();
  });
});

function createDecoder(
  fixture: ControlledCodecFixture,
  maxInFlight: number
): ContinuousPathDecoder {
  return new ContinuousPathDecoder(createUnits(), {
    maxInFlight,
    decoderFactory: fixture.decoderFactory,
    chunkFactory: fixture.chunkFactory
  });
}

function createUnits(): readonly ContinuousPathUnit[] {
  return [
    { id: "source", unit: createUnit(10) },
    { id: "target", unit: createUnit(20) }
  ];
}

function createUnit(
  firstTag: number,
  tags = [firstTag, firstTag + 1, firstTag + 2, firstTag + 3],
  codec = "vp8",
  frameRate = 30
): EncodedLoopUnit {
  return createEncodedLoopUnit({
    config: {
      codec,
      codedWidth: 2,
      codedHeight: 2,
      displayAspectWidth: 2,
      displayAspectHeight: 2
    },
    codedWidth: 2,
    codedHeight: 2,
    displayWidth: 2,
    displayHeight: 2,
    frameRate: { numerator: frameRate, denominator: 1 },
    frames: tags.map((tag, index) => ({
      type: index === 0 ? "key" : "delta",
      data: new Uint8Array([tag])
    }))
  });
}

interface ControlledCodecFixture {
  readonly created: boolean;
  readonly decoder: ControlledVideoDecoder;
  readonly decoderFactory: VideoDecoderFactory;
  readonly chunkFactory: EncodedVideoChunkFactory;
}

function createControlledCodec(): ControlledCodecFixture {
  let decoder: ControlledVideoDecoder | null = null;
  return {
    get created(): boolean {
      return decoder !== null;
    },
    get decoder(): ControlledVideoDecoder {
      if (decoder === null) {
        throw new Error("controlled decoder has not been created");
      }
      return decoder;
    },
    decoderFactory: (init) => {
      decoder = new ControlledVideoDecoder(init);
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

  public get tag(): number {
    return this.data[0] ?? -1;
  }
}

class FakeVideoFrame {
  public readonly timestamp: number;
  public readonly duration: number | null;
  public readonly codedWidth: number;
  public readonly codedHeight = 2;
  public readonly displayWidth: number;
  public readonly displayHeight = 2;
  public readonly visibleRect = { x: 0, y: 0, width: 2, height: 2 };
  public closeCalls = 0;
  readonly #copyResolvers: Array<() => void> = [];

  public constructor(chunk: FakeEncodedVideoChunk, width = 2) {
    this.timestamp = chunk.timestamp;
    this.duration = chunk.duration;
    this.codedWidth = width;
    this.displayWidth = width;
  }

  public close(): void {
    this.closeCalls += 1;
  }

  public get pendingCopies(): number {
    return this.#copyResolvers.length;
  }

  public copyTo(_destination: Uint8Array): Promise<readonly []> {
    return new Promise((resolve) => {
      this.#copyResolvers.push(() => {
        resolve([]);
      });
    });
  }

  public completeNextCopy(): void {
    const resolve = this.#copyResolvers.shift();
    if (resolve === undefined) {
      throw new Error("no pending frame copy to complete");
    }
    resolve();
  }
}

class ControlledVideoDecoder implements VideoDecoderAdapter {
  public configureCalls = 0;
  public flushCalls = 0;
  public closeCalls = 0;
  public readonly chunks: FakeEncodedVideoChunk[] = [];
  readonly #pending: FakeEncodedVideoChunk[] = [];
  readonly #init: VideoDecoderInit;

  public constructor(init: VideoDecoderInit) {
    this.#init = init;
  }

  public get decodeQueueSize(): number {
    return this.closeCalls > 0 ? 0 : this.#pending.length;
  }

  public get pendingCount(): number {
    return this.#pending.length;
  }

  public configure(_config: VideoDecoderConfig): void {
    this.configureCalls += 1;
  }

  public decode(chunk: EncodedVideoChunk): void {
    const fake = chunk as unknown as FakeEncodedVideoChunk;
    this.chunks.push(fake);
    this.#pending.push(fake);
  }

  public flush(): Promise<void> {
    this.flushCalls += 1;
    return Promise.resolve();
  }

  public close(): void {
    this.closeCalls += 1;
  }

  public emitNext(width = 2): FakeVideoFrame {
    return this.emitAt(0, width);
  }

  public emitAt(index: number, width = 2): FakeVideoFrame {
    const [chunk] = this.#pending.splice(index, 1);
    if (chunk === undefined) {
      throw new Error(`no pending decoder chunk at index ${String(index)}`);
    }
    const frame = new FakeVideoFrame(chunk, width);
    this.#init.output(frame as unknown as VideoFrame);
    return frame;
  }

  public fail(error: Error): void {
    this.#init.error(error as DOMException);
  }
}
