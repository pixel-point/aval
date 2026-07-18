import { afterEach, describe, expect, it, vi } from "vitest";

import {
  Decoder,
  type DecoderLimits
} from "../src/decoder.js";
import {
  createDecoderFailureDiagnostic,
  type DecoderFailureDiagnostic
} from "../src/decoder-diagnostics.js";
import {
  isDecoderCommand,
  type DecoderCommand,
  type DecoderWorkerEvent
} from "../src/decoder-protocol.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Decoder output certification", () => {
  it("admits runs only after configuration and acknowledged lane retirement", async () => {
    const Worker = fakeWorker();
    const VideoFrame = fakeVideoFrame();
    vi.stubGlobal("Worker", Worker);
    vi.stubGlobal("VideoFrame", VideoFrame);

    const decoder = configuredDecoder();
    const worker = Worker.latest();
    expect(decoder.available).toBe(false);
    expect(() => oneFrameRun(decoder)).toThrow("decoder lane is unavailable");

    worker.emit({ t: "configured", supported: true });
    await decoder.supported();
    expect(decoder.available).toBe(true);

    const first = oneFrameRun(decoder);
    expect(decoder.available).toBe(false);
    expect(() => oneFrameRun(decoder)).toThrow("decoder lane is unavailable");
    first.close();
    expect(decoder.available).toBe(false);
    worker.emit({ t: "closed", run: first.generation });
    expect(decoder.available).toBe(true);

    const second = oneFrameRun(decoder);
    expect(worker.posted).toContainEqual({ t: "start", run: second.generation });
    second.close();
    decoder.dispose();
  });

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

  it.each([
    ["color", (frame: VideoFrame) => {
      Object.defineProperty(frame, "colorSpace", {
        value: Object.freeze({
          fullRange: false,
          matrix: "bt709",
          primaries: "smpte170m",
          transfer: "iec61966-2-1"
        })
      });
    }],
    ["geometry", (frame: VideoFrame) => {
      Object.defineProperty(frame, "visibleRect", {
        value: Object.freeze({ x: 31, y: 0, width: 2, height: 2 })
      });
    }],
    ["timing", (frame: VideoFrame) => {
      Object.defineProperty(frame, "duration", { value: 2 });
    }]
  ] as const)("retains local %s output-validation evidence", async (_kind, mutate) => {
    const Worker = fakeWorker();
    const VideoFrame = fakeVideoFrame();
    vi.stubGlobal("Worker", Worker);
    vi.stubGlobal("VideoFrame", VideoFrame);
    const decoder = configuredDecoder();
    const worker = Worker.latest();
    worker.emit({ t: "configured", supported: true });
    await decoder.supported();
    const run = oneFrameRun(decoder);
    worker.emit({ t: "started", run: run.generation });
    worker.emit({ t: "accepted", run: run.generation });
    const frame = new VideoFrame(32, 34);
    mutate(frame);
    worker.emit({
      t: "frame",
      run: run.generation,
      timestamp: 0,
      frame
    });

    await expect(run.take(0)).rejects.toThrow(
      "AVAL decoder returned an invalid frame"
    );
    expect(decoder.snapshot().diagnostic).toMatchObject({
      phase: "output-validation",
      code: "invalid-output",
      run: run.generation,
      decodeOrdinal: 0,
      exception: {
        name: "Error",
        message: "AVAL decoder returned an invalid frame"
      },
      firstFrame: {
        timestamp: 0,
        codedWidth: 32,
        codedHeight: 34,
        displayWidth: 2,
        displayHeight: 2
      }
    });
    expect(Object.isFrozen(decoder.snapshot().diagnostic)).toBe(true);
    expect(Object.isFrozen(decoder.snapshot().diagnostic?.firstFrame)).toBe(true);
    decoder.dispose();
  });

  it("retains the exact first structured worker diagnostic through teardown", async () => {
    const Worker = fakeWorker();
    const VideoFrame = fakeVideoFrame();
    vi.stubGlobal("Worker", Worker);
    vi.stubGlobal("VideoFrame", VideoFrame);
    const decoder = configuredDecoder();
    const failure = decoder.failure();
    const worker = Worker.latest();
    worker.emit({ t: "configured", supported: true });
    await decoder.supported();
    const diagnostic = structuredClone(workerDiagnostic({
      phase: "decode",
      code: "decoder-operation",
      run: 4,
      decodeOrdinal: 2,
      reason: new DOMException(
        "Decode failed at https://private.invalid/media.av1 " + "x".repeat(700),
        "EncodingError"
      )
    })) as DecoderFailureDiagnostic;
    expect(Object.isFrozen(diagnostic)).toBe(false);

    worker.emit({ t: "error", diagnostic });

    await expect(failure).rejects.toThrow("AVAL decoder failed");
    expect(decoder.snapshot().diagnostic).toBe(diagnostic);
    expect(Object.isFrozen(diagnostic)).toBe(true);
    expect(Object.isFrozen(diagnostic.exception)).toBe(true);
    expect(diagnostic.exception?.message).toContain("[redacted-url]");
    expect(diagnostic.exception?.message).not.toContain("private.invalid");
    expect(diagnostic.exception?.message.length).toBeLessThanOrEqual(512);
    decoder.dispose();
    expect(decoder.snapshot().diagnostic).toBe(diagnostic);

    worker.emitTransport("messageerror");
    expect(decoder.snapshot().diagnostic).toBe(diagnostic);
  });

  it("synthesizes bounded transport evidence for messageerror", async () => {
    const Worker = fakeWorker();
    const VideoFrame = fakeVideoFrame();
    vi.stubGlobal("Worker", Worker);
    vi.stubGlobal("VideoFrame", VideoFrame);
    const decoder = configuredDecoder();
    const failure = decoder.failure();
    const worker = Worker.latest();
    worker.emit({ t: "configured", supported: true });
    await decoder.supported();
    const run = oneFrameRun(decoder);

    worker.emitTransport("messageerror");

    await expect(failure).rejects.toThrow("AVAL decoder message transport failed");
    expect(decoder.snapshot().diagnostic).toEqual({
      phase: "frame-transfer",
      code: "transport",
      run: run.generation,
      decodeOrdinal: null,
      exception: {
        name: "Error",
        message: "AVAL decoder message transport failed"
      },
      firstFrame: null
    });
    const retained = decoder.snapshot().diagnostic;
    decoder.dispose();
    expect(decoder.snapshot().diagnostic).toBe(retained);
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
      openFrameBytes: 4_352,
      diagnostic: null
    });
    expect(decodedBytes).toEqual([4_352]);
    const frame = await run.take(0);
    expect(decoder.snapshot().openFrameBytes).toBe(4_352);
    run.release(frame);
    expect(decoder.snapshot()).toEqual({
      workerCount: 1,
      openFrames: 0,
      openFrameBytes: 0,
      diagnostic: null
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
      openFrameBytes: 0,
      diagnostic: expect.objectContaining({
        phase: "decode",
        code: "decoder-operation"
      })
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
      openFrameBytes: 319_488,
      diagnostic: null
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
      openFrameBytes: 0,
      diagnostic: expect.objectContaining({
        phase: "output-validation",
        code: "invalid-output"
      })
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
      openFrameBytes: 0,
      diagnostic: expect.objectContaining({
        phase: "decode",
        code: "watchdog-timeout",
        run: run.generation
      })
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

  it.each(["flushed", "closed"] as const)(
    "releases a locally closed active run on a late %s acknowledgement",
    async (terminal) => {
      const Worker = fakeWorker();
      const VideoFrame = fakeVideoFrame();
      vi.stubGlobal("Worker", Worker);
      vi.stubGlobal("VideoFrame", VideoFrame);

      const decoder = configuredDecoder();
      const worker = Worker.latest();
      worker.emit({ t: "configured", supported: true });
      await decoder.supported();
      const first = oneFrameRun(decoder);
      expect(worker.posted).toContainEqual({ t: "start", run: first.generation });
      expect(() => oneFrameRun(decoder)).toThrow("decoder lane is unavailable");

      worker.emit({ t: "started", run: first.generation });
      worker.emit({ t: "accepted", run: first.generation });
      expect(worker.posted).toContainEqual({ t: "flush", run: first.generation });
      first.close();
      expect(worker.posted).toContainEqual({ t: "close", run: first.generation });

      worker.emit({ t: terminal, run: first.generation });
      const second = oneFrameRun(decoder);
      expect(worker.posted).toContainEqual({ t: "start", run: second.generation });

      // Duplicate terminal messages from the retired generation are stale and
      // must not interfere with the new active owner.
      worker.emit({ t: "flushed", run: first.generation });
      worker.emit({ t: "closed", run: first.generation });
      expect(worker.terminated).toBe(false);
      worker.emit({ t: "started", run: second.generation });
      expect(worker.posted).toContainEqual(expect.objectContaining({
        t: "decode",
        run: second.generation
      }));

      second.close();
      decoder.dispose();
    }
  );

  it("retains a flushed run as the lane's sole owner until it closes", async () => {
    const Worker = fakeWorker();
    const VideoFrame = fakeVideoFrame();
    vi.stubGlobal("Worker", Worker);
    vi.stubGlobal("VideoFrame", VideoFrame);

    const decoder = configuredDecoder();
    const worker = Worker.latest();
    worker.emit({ t: "configured", supported: true });
    await decoder.supported();
    const first = oneFrameRun(decoder);
    worker.emit({ t: "started", run: first.generation });
    worker.emit({ t: "accepted", run: first.generation });
    worker.emit({
      t: "frame",
      run: first.generation,
      timestamp: 0,
      frame: new VideoFrame(32, 34)
    });
    worker.emit({ t: "flushed", run: first.generation });
    await first.complete();

    expect(decoder.available).toBe(false);
    expect(() => oneFrameRun(decoder)).toThrow("decoder lane is unavailable");
    first.close();
    expect(decoder.available).toBe(true);
    expect(() => oneFrameRun(decoder)).not.toThrow();
    decoder.dispose();
  });

  it("treats a worker error as globally fatal after a local close", async () => {
    const Worker = fakeWorker();
    const VideoFrame = fakeVideoFrame();
    vi.stubGlobal("Worker", Worker);
    vi.stubGlobal("VideoFrame", VideoFrame);

    const decoder = configuredDecoder();
    const failure = decoder.failure();
    const worker = Worker.latest();
    worker.emit({ t: "configured", supported: true });
    await decoder.supported();
    const first = oneFrameRun(decoder);
    worker.emit({ t: "started", run: first.generation });
    worker.emit({ t: "accepted", run: first.generation });
    first.close();

    const diagnostic = workerDiagnostic({
      phase: "flush",
      code: "decoder-operation",
      run: first.generation,
      decodeOrdinal: null,
      reason: new Error("flush failed")
    });
    worker.emit({ t: "error", diagnostic });

    await expect(failure).rejects.toThrow("AVAL decoder failed");
    expect(worker.terminated).toBe(true);
    expect(decoder.snapshot()).toEqual({
      workerCount: 0,
      openFrames: 0,
      openFrameBytes: 0,
      diagnostic
    });
    decoder.dispose();
  });

  it("discards in-flight run events until a locally closing run is acknowledged", async () => {
    const Worker = fakeWorker();
    const VideoFrame = fakeVideoFrame();
    vi.stubGlobal("Worker", Worker);
    vi.stubGlobal("VideoFrame", VideoFrame);

    const decoder = configuredDecoder();
    const worker = Worker.latest();
    worker.emit({ t: "configured", supported: true });
    await decoder.supported();
    const first = oneFrameRun(decoder);
    worker.emit({ t: "started", run: first.generation });
    first.close();

    const frame = new VideoFrame(32, 34);
    worker.emit({ t: "accepted", run: first.generation });
    worker.emit({
      t: "frame",
      run: first.generation,
      timestamp: 0,
      frame
    });

    expect((frame as unknown as { closed: boolean }).closed).toBe(true);
    expect(worker.terminated).toBe(false);
    worker.emit({ t: "closed", run: first.generation });
    const second = oneFrameRun(decoder);
    expect(worker.posted).toContainEqual({ t: "start", run: second.generation });
    second.close();
    decoder.dispose();
  });

  it.each(["started", "accepted"] as const)(
    "rejects a stale nonterminal %s event",
    async (kind) => {
      const Worker = fakeWorker();
      const VideoFrame = fakeVideoFrame();
      vi.stubGlobal("Worker", Worker);
      vi.stubGlobal("VideoFrame", VideoFrame);

      const decoder = configuredDecoder();
      const worker = Worker.latest();
      worker.emit({ t: "configured", supported: true });
      await decoder.supported();
      const first = oneFrameRun(decoder);
      first.close();
      worker.emit({ t: "closed", run: first.generation });
      const second = oneFrameRun(decoder);
      expect(worker.posted).toContainEqual({ t: "start", run: second.generation });

      worker.emit({ t: kind, run: first.generation });

      expect(worker.terminated).toBe(true);
      expect(worker.posted).not.toContainEqual({ t: "decode", run: second.generation });
      decoder.dispose();
    }
  );

  it("closes and rejects a stale transferred frame", async () => {
    const Worker = fakeWorker();
    const VideoFrame = fakeVideoFrame();
    vi.stubGlobal("Worker", Worker);
    vi.stubGlobal("VideoFrame", VideoFrame);

    const decoder = configuredDecoder();
    const worker = Worker.latest();
    worker.emit({ t: "configured", supported: true });
    await decoder.supported();
    const first = oneFrameRun(decoder);
    first.close();
    worker.emit({ t: "closed", run: first.generation });
    oneFrameRun(decoder);
    const frame = new VideoFrame(32, 34);

    worker.emit({
      t: "frame",
      run: first.generation,
      timestamp: 0,
      frame
    });

    expect((frame as unknown as { closed: boolean }).closed).toBe(true);
    expect(worker.terminated).toBe(true);
    decoder.dispose();
  });

  it("does not time out a ready prefetched run while its reordered frames are parked", async () => {
    vi.useFakeTimers();
    const Worker = fakeWorker();
    const VideoFrame = fakeVideoFrame();
    vi.stubGlobal("Worker", Worker);
    vi.stubGlobal("VideoFrame", VideoFrame);

    const decoder = configuredDecoder();
    const worker = Worker.latest();
    worker.emit({ t: "configured", supported: true });
    await decoder.supported();
    const run = frameRun(decoder, 12);
    worker.emit({ t: "started", run: run.generation });
    worker.emit({ t: "accepted", run: run.generation });
    for (let timestamp = 0; timestamp < 10; timestamp += 1) {
      worker.emit({
        t: "frame",
        run: run.generation,
        timestamp,
        frame: new VideoFrame(32, 34, timestamp)
      });
    }

    await run.ready();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(worker.terminated).toBe(false);

    const missingFrame = expect(run.take(11)).rejects.toMatchObject({
      name: "TimeoutError"
    });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(worker.terminated).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await missingFrame;
    expect(worker.terminated).toBe(true);
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
  readonly posted: readonly DecoderCommand[];
  readonly terminated: boolean;
  emit(value: DecoderWorkerEvent): void;
  emitTransport(type: "error" | "messageerror"): void;
}

function fakeWorker(): {
  new(): Worker;
  latest(): FakeWorkerInstance;
} {
  type Listener = EventListener;
  let latest: (Worker & FakeWorkerInstance) | null = null;
  class StubWorker {
    readonly #listeners = new Map<string, Set<Listener>>();
    public readonly posted: DecoderCommand[] = [];
    public terminated = false;

    public constructor() { latest = this as unknown as Worker & FakeWorkerInstance; }
    public addEventListener(type: string, listener: EventListener): void {
      const listeners = this.#listeners.get(type) ?? new Set<Listener>();
      listeners.add(listener);
      this.#listeners.set(type, listeners);
    }
    public postMessage(value: unknown): void {
      if (!isDecoderCommand(value)) throw new Error("invalid decoder command");
      this.posted.push(value);
    }
    public terminate(): void { this.terminated = true; }
    public emit(value: DecoderWorkerEvent): void {
      for (const listener of this.#listeners.get("message") ?? []) {
        listener({ data: value } as MessageEvent<unknown>);
      }
    }
    public emitTransport(type: "error" | "messageerror"): void {
      for (const listener of this.#listeners.get(type) ?? []) {
        listener(new Event(type));
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

function workerDiagnostic(input: Readonly<{
  phase: DecoderFailureDiagnostic["phase"];
  code: DecoderFailureDiagnostic["code"];
  run: number | null;
  decodeOrdinal: number | null;
  reason: unknown;
}>): Readonly<DecoderFailureDiagnostic> {
  return createDecoderFailureDiagnostic({
    ...input,
    firstFrame: null
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
    public closed = false;

    public constructor(
      public readonly codedWidth: number,
      public readonly codedHeight: number,
      public readonly timestamp = 0
    ) {}

    public close(): void { this.closed = true; }
  } as unknown as {
    new(codedWidth: number, codedHeight: number, timestamp?: number): VideoFrame;
  };
}
