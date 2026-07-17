import { afterEach, describe, expect, it, vi } from "vitest";

import {
  Decoder,
  type DecoderLimits
} from "../src/decoder.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Decoder output certification", () => {
  it("accepts the browser sRGB transfer normalization of limited BT.709", async () => {
    const Worker = fakeWorker();
    const VideoFrame = fakeVideoFrame({
      fullRange: false,
      matrix: "bt709",
      primaries: "bt709",
      transfer: "iec61966-2-1"
    });
    vi.stubGlobal("Worker", Worker);
    vi.stubGlobal("VideoFrame", VideoFrame);
    const decoder = configuredDecoder();
    const worker = Worker.latest();
    worker.emit({ t: "configured", supported: true });
    await decoder.supported();
    const run = oneFrameRun(decoder);
    worker.emit({ t: "started", run: run.generation });
    worker.emit({ t: "accepted", run: run.generation });
    worker.emit({
      t: "frame",
      run: run.generation,
      timestamp: 0,
      frame: new VideoFrame(32, 34)
    });

    const frame = await run.take(0);
    run.release(frame);
    decoder.dispose();
  });

  it("rejects contradictory browser color metadata", async () => {
    const Worker = fakeWorker();
    const VideoFrame = fakeVideoFrame({
      fullRange: false,
      matrix: "bt709",
      primaries: "smpte170m",
      transfer: "iec61966-2-1"
    });
    vi.stubGlobal("Worker", Worker);
    vi.stubGlobal("VideoFrame", VideoFrame);
    const decoder = configuredDecoder();
    const worker = Worker.latest();
    worker.emit({ t: "configured", supported: true });
    await decoder.supported();
    const run = oneFrameRun(decoder);
    worker.emit({ t: "started", run: run.generation });
    worker.emit({ t: "accepted", run: run.generation });
    worker.emit({
      t: "frame",
      run: run.generation,
      timestamp: 0,
      frame: new VideoFrame(32, 34)
    });

    await expect(run.take(0)).rejects.toThrow(
      "AVAL decoder returned an invalid frame"
    );
    decoder.dispose();
  });

  it("accepts frames from the generation-captured realm constructor", async () => {
    const Worker = fakeWorker();
    const CapturedVideoFrame = fakeVideoFrame();
    vi.stubGlobal("Worker", Worker);
    vi.stubGlobal("VideoFrame", fakeVideoFrame());
    const decoder = configuredDecoder({
      VideoFrame: CapturedVideoFrame as unknown as typeof VideoFrame
    });
    const worker = Worker.latest();
    worker.emit({ t: "configured", supported: true });
    await decoder.supported();
    const run = oneFrameRun(decoder);
    worker.emit({ t: "started", run: run.generation });
    worker.emit({ t: "accepted", run: run.generation });
    worker.emit({
      t: "frame",
      run: run.generation,
      timestamp: 0,
      frame: new CapturedVideoFrame(32, 34)
    });

    const frame = await run.take(0);
    run.release(frame);
    decoder.dispose();
  });

  it("accepts UA coded-allocation padding around the exact visible rendition", async () => {
    const Worker = fakeWorker();
    const VideoFrame = fakeVideoFrame();
    const decodedBytes: number[] = [];
    vi.stubGlobal("Worker", Worker);
    vi.stubGlobal("VideoFrame", VideoFrame);

    const decoder = configuredDecoder({
      maxDecodedBytes: 5_000,
      onDecodedBytes: (bytes) => decodedBytes.push(bytes)
    });
    const worker = Worker.latest();
    worker.emit({ t: "configured", supported: true });
    await decoder.supported();

    const run = oneFrameRun(decoder);
    worker.emit({ t: "started", run: run.generation });
    worker.emit({ t: "accepted", run: run.generation });
    worker.emit({
      t: "frame",
      run: run.generation,
      timestamp: 0,
      frame: new VideoFrame(32, 34)
    });

    expect(decoder.snapshot()).toEqual({
      workerCount: 1,
      openFrames: 1,
      openFrameBytes: 4_352
    });
    expect(decodedBytes).toEqual([4_352]);
    const frame = await run.take(0);
    expect(decoder.snapshot().openFrameBytes).toBe(4_352);
    run.release(frame);
    expect(decoder.snapshot()).toEqual({
      workerCount: 1,
      openFrames: 0,
      openFrameBytes: 0
    });
    expect(decodedBytes).toEqual([4_352, 0]);
    worker.emit({ t: "flushed", run: run.generation });
    await run.complete();
    expect(worker.terminated).toBe(false);
    run.close();
    decoder.dispose();
  });

  it("enforces the decoded-byte ceiling across all live frames", async () => {
    const Worker = fakeWorker();
    const VideoFrame = fakeVideoFrame();
    vi.stubGlobal("Worker", Worker);
    vi.stubGlobal("VideoFrame", VideoFrame);

    const decoder = configuredDecoder({ maxDecodedBytes: 8_000 });
    const worker = Worker.latest();
    worker.emit({ t: "configured", supported: true });
    await decoder.supported();

    const run = twoFrameRun(decoder);
    worker.emit({ t: "started", run: run.generation });
    worker.emit({ t: "accepted", run: run.generation });
    worker.emit({
      t: "frame",
      run: run.generation,
      timestamp: 0,
      frame: new VideoFrame(32, 34, 0)
    });
    expect(decoder.snapshot().openFrameBytes).toBe(4_352);

    worker.emit({
      t: "frame",
      run: run.generation,
      timestamp: 1,
      frame: new VideoFrame(32, 34, 1)
    });

    await expect(run.take(0)).rejects.toThrow(
      "AVAL decoded surfaces exceed their byte ceiling"
    );
    expect(decoder.snapshot()).toEqual({
      workerCount: 0,
      openFrames: 0,
      openFrameBytes: 0
    });
    expect(worker.terminated).toBe(true);
    decoder.dispose();
  });

  it("accepts multiple mature-UA padded surfaces under the runtime ceiling", async () => {
    const Worker = fakeWorker();
    const VideoFrame = fakeVideoFrame();
    vi.stubGlobal("Worker", Worker);
    vi.stubGlobal("VideoFrame", VideoFrame);

    // Six 128x104 UA surfaces exceed a 12 * 48x104 authored-surface estimate,
    // but remain inside the runtime budget supplied as the decoder ceiling.
    const decoder = configuredDecoder({ maxDecodedBytes: 400_000 });
    const worker = Worker.latest();
    worker.emit({ t: "configured", supported: true });
    await decoder.supported();

    const run = frameRun(decoder, 6);
    worker.emit({ t: "started", run: run.generation });
    worker.emit({ t: "accepted", run: run.generation });
    for (let timestamp = 0; timestamp < 6; timestamp += 1) {
      worker.emit({
        t: "frame",
        run: run.generation,
        timestamp,
        frame: new VideoFrame(128, 104, timestamp)
      });
    }
    expect(decoder.snapshot()).toEqual({
      workerCount: 1,
      openFrames: 6,
      openFrameBytes: 319_488
    });

    for (let index = 0; index < 6; index += 1) run.release(await run.take(index));
    worker.emit({ t: "flushed", run: run.generation });
    await run.complete();
    run.close();
    decoder.dispose();
  });

  it("rejects a non-safe UA coded allocation", async () => {
    const Worker = fakeWorker();
    const VideoFrame = fakeVideoFrame();
    vi.stubGlobal("Worker", Worker);
    vi.stubGlobal("VideoFrame", VideoFrame);

    const decoder = configuredDecoder();
    const worker = Worker.latest();
    worker.emit({ t: "configured", supported: true });
    await expect(decoder.supported()).resolves.toBe(true);

    const run = oneFrameRun(decoder);
    worker.emit({ t: "started", run: run.generation });
    worker.emit({ t: "accepted", run: run.generation });
    worker.emit({
      t: "frame",
      run: run.generation,
      timestamp: 0,
      frame: new VideoFrame(Number.MAX_VALUE, 16)
    });

    await expect(run.take(0)).rejects.toThrow(
      "AVAL decoder returned an invalid frame"
    );
    expect(decoder.snapshot()).toEqual({
      workerCount: 0,
      openFrames: 0,
      openFrameBytes: 0
    });
    expect(worker.terminated).toBe(true);
    decoder.dispose();
  });

  it("times out an active run after two seconds and wakes every waiter", async () => {
    vi.useFakeTimers();
    const Worker = fakeWorker();
    const VideoFrame = fakeVideoFrame();
    vi.stubGlobal("Worker", Worker);
    vi.stubGlobal("VideoFrame", VideoFrame);

    const decoder = configuredDecoder();
    const worker = Worker.latest();
    worker.emit({ t: "configured", supported: true });
    await decoder.supported();

    const run = oneFrameRun(decoder);
    const assertions = [run.ready(), run.take(0), run.complete()].map((promise) =>
      expect(promise).rejects.toMatchObject({ name: "TimeoutError" })
    );

    await vi.advanceTimersByTimeAsync(1_999);
    expect(worker.terminated).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await Promise.all(assertions);
    expect(vi.getTimerCount()).toBe(0);
    expect(decoder.snapshot()).toEqual({
      workerCount: 0,
      openFrames: 0,
      openFrameBytes: 0
    });
    expect(worker.terminated).toBe(true);
    decoder.dispose();
  });

  it("refreshes the watchdog on worker progress and clears it on flush", async () => {
    vi.useFakeTimers();
    const Worker = fakeWorker();
    const VideoFrame = fakeVideoFrame();
    vi.stubGlobal("Worker", Worker);
    vi.stubGlobal("VideoFrame", VideoFrame);

    const decoder = configuredDecoder();
    const worker = Worker.latest();
    worker.emit({ t: "configured", supported: true });
    await decoder.supported();
    const run = oneFrameRun(decoder);

    await vi.advanceTimersByTimeAsync(1_500);
    worker.emit({ t: "started", run: run.generation });
    await vi.advanceTimersByTimeAsync(1_500);
    expect(worker.terminated).toBe(false);
    worker.emit({ t: "accepted", run: run.generation });
    await vi.advanceTimersByTimeAsync(1_500);
    expect(worker.terminated).toBe(false);
    worker.emit({
      t: "frame",
      run: run.generation,
      timestamp: 0,
      frame: new VideoFrame(32, 34)
    });
    const frame = await run.take(0);
    run.release(frame);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(worker.terminated).toBe(false);

    worker.emit({ t: "flushed", run: run.generation });
    await run.complete();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(worker.terminated).toBe(false);
    run.close();
    decoder.dispose();
  });
});

function configuredDecoder(limits: Readonly<DecoderLimits> = {}): Decoder {
  return new Decoder({
    codec: "avc1.640020",
    codedWidth: 16,
    codedHeight: 16,
    displayAspectWidth: 2,
    displayAspectHeight: 2
  }, undefined, limits);
}

function oneFrameRun(decoder: Decoder) {
  return frameRun(decoder, 1);
}

function frameRun(decoder: Decoder, displayedFrames: number) {
  return decoder.createRun([{
    data: new Uint8Array([1]).buffer,
    timestamp: 0,
    duration: 1,
    key: true,
    displayedFrames
  }]);
}

function twoFrameRun(decoder: Decoder) {
  return decoder.createRun([{
    data: new Uint8Array([1]).buffer,
    timestamp: 0,
    duration: 1,
    key: true,
    displayedFrames: 2
  }]);
}

interface FakeWorkerInstance {
  readonly terminated: boolean;
  emit(value: unknown): void;
}

function fakeWorker(): {
  new(): Worker;
  latest(): FakeWorkerInstance;
} {
  type Listener = (event: MessageEvent<unknown>) => void;
  let latest: (Worker & FakeWorkerInstance) | null = null;
  class StubWorker {
    readonly #messages = new Set<Listener>();
    public terminated = false;

    public constructor() { latest = this as unknown as Worker & FakeWorkerInstance; }
    public addEventListener(type: string, listener: EventListener): void {
      if (type === "message") this.#messages.add(listener as Listener);
    }
    public postMessage(): void { /* Commands are driven explicitly by the test. */ }
    public terminate(): void { this.terminated = true; }
    public emit(value: unknown): void {
      for (const listener of this.#messages) {
        listener({ data: value } as MessageEvent<unknown>);
      }
    }
  }
  return Object.assign(StubWorker as unknown as { new(): Worker }, {
    latest: (): FakeWorkerInstance => {
      if (latest === null) throw new Error("worker was not constructed");
      return latest;
    }
  });
}

function fakeVideoFrame(colorSpace: Readonly<VideoColorSpaceInit> = {
  fullRange: false,
  matrix: "bt709",
  primaries: "bt709",
  transfer: "bt709"
}): {
  new(codedWidth: number, codedHeight: number, timestamp?: number): VideoFrame;
} {
  const normalizedColorSpace = Object.freeze({ ...colorSpace });
  return class StubVideoFrame {
    public readonly duration = 1;
    public readonly displayWidth = 2;
    public readonly displayHeight = 2;
    public readonly visibleRect = {
      x: 0,
      y: 0,
      width: 2,
      height: 2
    };
    public readonly colorSpace = normalizedColorSpace;

    public constructor(
      public readonly codedWidth: number,
      public readonly codedHeight: number,
      public readonly timestamp = 0
    ) {}

    public close(): void { /* Ownership is asserted through decoder state. */ }
  } as unknown as {
    new(codedWidth: number, codedHeight: number, timestamp?: number): VideoFrame;
  };
}
