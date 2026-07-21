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

const BT709_LIMITED_COLOR = Object.freeze({
  fullRange: false,
  matrix: "bt709",
  primaries: "bt709",
  transfer: "bt709"
} as const);
const ANDROID_BT709_COLOR = Object.freeze({
  fullRange: false,
  matrix: "bt709",
  primaries: "bt709",
  transfer: "smpte170m"
} as const);
const DEFAULT_EXPECTATION = Object.freeze({
  codedWidth: 16,
  codedHeight: 16,
  displayWidth: 2,
  displayHeight: 2,
  visibleRect: Object.freeze({ x: 0, y: 0, width: 2, height: 2 }),
  colorSpace: BT709_LIMITED_COLOR
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Decoder output certification", () => {
  it.each([0, null])(
    "repairs Safari's missing %s duration after converting AVAL frame ticks",
    async (missingDuration) => {
      const Worker = fakeWorker();
      const VideoFrame = fakeVideoFrame();
      vi.stubGlobal("Worker", Worker);
      vi.stubGlobal("VideoFrame", VideoFrame);

      const decoder = configuredDecoder({
        sampleFrameRate: { numerator: 30, denominator: 1 }
      });
      const worker = Worker.latest();
      worker.emit({ t: "configured", supported: true });
      await decoder.supported();

      const run = decoder.createRun([{
        data: new Uint8Array([1]).buffer,
        timestamp: 7,
        duration: 1,
        key: true,
        displayedFrames: 1
      }]);
      worker.emit({ t: "started", run: run.generation });

      expect(worker.posted).toContainEqual({
        t: "decode",
        run: run.generation,
        chunks: [{
          data: expect.any(ArrayBuffer),
          timestamp: 233_333,
          duration: 33_334,
          key: true
        }]
      });

      worker.emit({ t: "accepted", run: run.generation });
      const frame = new VideoFrame(32, 34, 233_333);
      Object.defineProperty(frame, "duration", { value: missingDuration });
      worker.emit({
        t: "frame",
        run: run.generation,
        timestamp: 233_333,
        frame
      });

      const repaired = await run.take(0);
      expect(repaired).not.toBe(frame);
      expect(repaired.timestamp).toBe(233_333);
      expect(repaired.duration).toBe(33_334);
      expect((frame as unknown as { closed: boolean }).closed).toBe(true);
      expect(decoder.snapshot().diagnostic).toBeNull();
      run.release(repaired);
      decoder.dispose();
    }
  );

  it("still rejects a wrong positive duration after tick conversion", async () => {
    const Worker = fakeWorker();
    const VideoFrame = fakeVideoFrame();
    vi.stubGlobal("Worker", Worker);
    vi.stubGlobal("VideoFrame", VideoFrame);

    const decoder = configuredDecoder({
      sampleFrameRate: { numerator: 30, denominator: 1 }
    });
    const worker = Worker.latest();
    worker.emit({ t: "configured", supported: true });
    await decoder.supported();

    const run = decoder.createRun([{
      data: new Uint8Array([1]).buffer,
      timestamp: 7,
      duration: 1,
      key: true,
      displayedFrames: 1
    }]);
    worker.emit({ t: "started", run: run.generation });
    worker.emit({ t: "accepted", run: run.generation });
    const frame = new VideoFrame(32, 34, 233_333);
    Object.defineProperty(frame, "duration", { value: 33_333 });
    worker.emit({
      t: "frame",
      run: run.generation,
      timestamp: 233_333,
      frame
    });

    await expect(run.take(0)).rejects.toThrow(
      "AVAL decoder returned an invalid frame"
    );
    expect(decoder.snapshot().diagnostic?.outputFailure).toMatchObject({
      kind: "timing",
      field: "duration",
      expected: { timestamp: 233_333, duration: 33_334 },
      actual: { timestamp: 233_333, duration: 33_333 }
    });
    decoder.dispose();
  });

  it("rejects fractional multi-frame chunk timing that WebCodecs cannot represent exactly", async () => {
    const Worker = fakeWorker();
    const VideoFrame = fakeVideoFrame();
    vi.stubGlobal("Worker", Worker);
    vi.stubGlobal("VideoFrame", VideoFrame);

    const decoder = configuredDecoder({
      sampleFrameRate: { numerator: 60, denominator: 1 }
    });
    const worker = Worker.latest();
    worker.emit({ t: "configured", supported: true });
    await decoder.supported();

    expect(() => decoder.createRun([{
      data: new Uint8Array([1]).buffer,
      timestamp: 0,
      duration: 1,
      key: true,
      displayedFrames: 3
    }])).toThrow(
      "multi-frame decoder timing cannot be represented by one WebCodecs chunk"
    );
    decoder.dispose();
  });

  it("counts only acknowledged native and logical lifecycle successes", async () => {
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
    const frame = await first.take(0);
    first.release(frame);
    worker.emit({ t: "flushed", run: first.generation });
    await first.complete();
    first.close();

    const second = oneFrameRun(decoder);
    worker.emit({ t: "started", run: second.generation });
    second.close();
    worker.emit({ t: "closed", run: second.generation });

    expect(decoder.snapshot().lifecycle).toEqual({
      outputsAccepted: 1,
      runsClosed: 2,
      nativeDecoderCreates: 2,
      nativeDecoderCloses: 2
    });
    expect(Object.isFrozen(decoder.snapshot().lifecycle)).toBe(true);
    decoder.dispose();
    expect(decoder.snapshot().lifecycle).toEqual({
      outputsAccepted: 1,
      runsClosed: 2,
      nativeDecoderCreates: 2,
      nativeDecoderCloses: 2
    });
  });

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

  it.each([
    ["limited-range sRGB", "avc1.42E020", false],
    ["captured WebKit H.264", "avc1.42E020", true],
    ["captured WebKit HEVC", "hvc1.1.6.L93.B0", true]
  ] as const)(
    "accepts the %s transfer normalization of limited BT.709",
    async (_label, codec, fullRange) => {
      const Worker = fakeWorker();
      const VideoFrame = fakeVideoFrame({
        fullRange,
        matrix: "bt709",
        primaries: "bt709",
        transfer: "iec61966-2-1"
      });
      vi.stubGlobal("Worker", Worker);
      vi.stubGlobal("VideoFrame", VideoFrame);
      const decoder = strictBt709Decoder(codec);
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
    }
  );

  it.each([
    ["AV1", "av01.0.01M.08.0.110.01.01.01.0"],
    ["VP9", "vp09.00.21.08.01.01.01.01.00"]
  ] as const)(
    "accepts the captured Android %s BT.709 transfer tuple",
    async (_label, codec) => {
      const Worker = fakeWorker();
      const VideoFrame = fakeVideoFrame(ANDROID_BT709_COLOR);
      vi.stubGlobal("Worker", Worker);
      vi.stubGlobal("VideoFrame", VideoFrame);
      const decoder = strictBt709Decoder(codec);
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
      expect(decoder.snapshot().diagnostic).toBeNull();
      run.release(frame);
      decoder.dispose();
    }
  );

  it("retains frozen raw tuples for a WebKit color-space near miss", async () => {
    const Worker = fakeWorker();
    const VideoFrame = fakeVideoFrame({
      fullRange: true,
      matrix: "smpte170m",
      primaries: "bt709",
      transfer: "iec61966-2-1"
    });
    vi.stubGlobal("Worker", Worker);
    vi.stubGlobal("VideoFrame", VideoFrame);
    const decoder = strictBt709Decoder("av01.0.01M.08.0.110.01.01.01.0");
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
    const diagnostic = decoder.snapshot().diagnostic;
    expect(diagnostic?.outputFailure).toMatchObject({
      kind: "color-space",
      validationLayer: "host-expectation",
      field: "color-space",
      expected: {
        colorSpace: ["bt709", "bt709", "bt709", false]
      },
      actual: {
        colorSpace: ["bt709", "iec61966-2-1", "smpte170m", true]
      }
    });
    const expectedColor = diagnostic?.outputFailure?.expected?.colorSpace;
    const actualColor = diagnostic?.outputFailure?.actual?.colorSpace;
    expect(Object.isFrozen(diagnostic)).toBe(true);
    expect(Object.isFrozen(diagnostic?.outputFailure)).toBe(true);
    expect(Object.isFrozen(expectedColor)).toBe(true);
    expect(Object.isFrozen(actualColor)).toBe(true);
    decoder.dispose();
  });

  it.each([
    ["color", "color-space", "color-space", (frame: VideoFrame) => {
      Object.defineProperty(frame, "colorSpace", {
        value: Object.freeze({
          fullRange: false,
          matrix: "bt709",
          primaries: "smpte170m",
          transfer: "iec61966-2-1"
        })
      });
    }],
    ["geometry", "visible-rect", "visible-rect", (frame: VideoFrame) => {
      Object.defineProperty(frame, "visibleRect", {
        value: Object.freeze({ x: 31, y: 0, width: 2, height: 2 })
      });
    }],
    ["timing", "timing", "duration", (frame: VideoFrame) => {
      Object.defineProperty(frame, "duration", { value: 2 });
    }]
  ] as const)("retains local %s output-validation evidence", async (
    _label,
    kind,
    field,
    mutate
  ) => {
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
      firstFrame: null,
      lastGoodFrame: null,
      outputFailure: {
        kind,
        validationLayer: "host-expectation",
        field,
        expected: { timestamp: 0, duration: 1 },
        actual: { timestamp: 0, codedWidth: 32, codedHeight: 34 }
      }
    });
    expect(Object.isFrozen(decoder.snapshot().diagnostic)).toBe(true);
    expect(Object.isFrozen(decoder.snapshot().diagnostic?.outputFailure)).toBe(true);
    decoder.dispose();
  });

  it("retains the last good frame and the exact later rejected output", async () => {
    const Worker = fakeWorker();
    const VideoFrame = fakeVideoFrame();
    vi.stubGlobal("Worker", Worker);
    vi.stubGlobal("VideoFrame", VideoFrame);
    const decoder = configuredDecoder();
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
    const rejected = new VideoFrame(32, 34, 1);
    Object.defineProperties(rejected, {
      displayWidth: { value: 3 },
      displayHeight: { value: 2 }
    });
    worker.emit({
      t: "frame",
      run: run.generation,
      timestamp: 1,
      frame: rejected
    });

    await expect(run.take(1)).rejects.toThrow(
      "AVAL decoder returned an invalid frame"
    );
    expect(decoder.snapshot().diagnostic).toMatchObject({
      phase: "output-validation",
      code: "invalid-output",
      run: run.generation,
      decodeOrdinal: 1,
      firstFrame: { timestamp: 0, displayWidth: 2, displayHeight: 2 },
      lastGoodFrame: { timestamp: 0, displayWidth: 2, displayHeight: 2 },
      outputFailure: {
        kind: "display-aspect",
        validationLayer: "host-expectation",
        field: "display-aspect",
        expected: {
          timestamp: 1,
          duration: 1,
          displayAspectWidth: 2,
          displayAspectHeight: 2
        },
        actual: {
          timestamp: 1,
          duration: 1,
          codedWidth: 32,
          codedHeight: 34,
          displayWidth: 3,
          displayHeight: 2
        }
      }
    });
    expect(Object.isFrozen(decoder.snapshot().diagnostic?.outputFailure)).toBe(true);
    expect(Object.isFrozen(decoder.snapshot().diagnostic?.lastGoodFrame)).toBe(true);
    decoder.dispose();
  });

  it.each([
    [640, 360, 1_280, 720, 640, 360],
    [48, 104, 96, 208, 48, 112]
  ] as const)(
    "accepts aspect-equivalent %i×%i storage as %i×%i display",
    async (
      storageWidth,
      storageHeight,
      displayWidth,
      displayHeight,
      codedWidth,
      codedHeight
    ) => {
      const Worker = fakeWorker();
      const VideoFrame = fakeVideoFrame();
      vi.stubGlobal("Worker", Worker);
      vi.stubGlobal("VideoFrame", VideoFrame);
      const decoder = new Decoder({
        codec: "avc1.42E020",
        codedWidth,
        codedHeight,
        displayAspectWidth: storageWidth,
        displayAspectHeight: storageHeight
      }, {
        codedWidth,
        codedHeight,
        displayWidth: storageWidth,
        displayHeight: storageHeight,
        visibleRect: { x: 0, y: 0, width: storageWidth, height: storageHeight },
        colorSpace: BT709_LIMITED_COLOR
      }, {
        Worker,
        VideoFrame: VideoFrame as unknown as typeof globalThis.VideoFrame
      });
      const worker = Worker.latest();
      worker.emit({ t: "configured", supported: true });
      await decoder.supported();
      const run = oneFrameRun(decoder);
      worker.emit({ t: "started", run: run.generation });
      worker.emit({ t: "accepted", run: run.generation });
      const decoded = new VideoFrame(codedWidth, codedHeight);
      Object.defineProperties(decoded, {
        displayWidth: { value: displayWidth },
        displayHeight: { value: displayHeight },
        visibleRect: {
          value: Object.freeze({
            x: 0,
            y: 0,
            width: storageWidth,
            height: storageHeight
          })
        }
      });
      worker.emit({
        t: "frame",
        run: run.generation,
        timestamp: 0,
        frame: decoded
      });

      const accepted = await run.take(0);
      run.release(accepted);
      expect(decoder.snapshot().diagnostic).toBeNull();
      decoder.dispose();
    }
  );

  it("classifies an unauthored timestamp as unknown output", async () => {
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
    worker.emit({
      t: "frame",
      run: run.generation,
      timestamp: 99,
      frame: new VideoFrame(32, 34, 99)
    });

    await expect(run.complete()).rejects.toThrow(
      "AVAL decoder returned an unknown frame"
    );
    expect(decoder.snapshot().diagnostic).toMatchObject({
      phase: "output-validation",
      code: "invalid-output",
      run: run.generation,
      decodeOrdinal: null,
      firstFrame: null,
      lastGoodFrame: null,
      outputFailure: {
        kind: "unknown-output",
        validationLayer: "host-expectation",
        field: "timestamp",
        expected: null,
        actual: {
          timestamp: 99,
          duration: 1,
          codedWidth: 32,
          codedHeight: 34,
          displayWidth: 2,
          displayHeight: 2,
          receivedFrameCount: null
        }
      }
    });
    decoder.dispose();
  });

  it("classifies a repeated accepted timestamp as duplicate output", async () => {
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
    worker.emit({
      t: "frame",
      run: run.generation,
      timestamp: 0,
      frame: new VideoFrame(32, 34, 0)
    });
    worker.emit({
      t: "frame",
      run: run.generation,
      timestamp: 0,
      frame: new VideoFrame(32, 34, 0)
    });

    await expect(run.complete()).rejects.toThrow("duplicate decoded frame");
    expect(decoder.snapshot().diagnostic).toMatchObject({
      phase: "output-validation",
      code: "invalid-output",
      run: run.generation,
      decodeOrdinal: 0,
      firstFrame: { timestamp: 0 },
      lastGoodFrame: { timestamp: 0 },
      outputFailure: {
        kind: "duplicate-output",
        validationLayer: "host-expectation",
        field: "ordinal",
        expected: {
          timestamp: 0,
          duration: 1,
          frameCount: null
        },
        actual: {
          timestamp: 0,
          duration: 1,
          receivedFrameCount: null
        }
      }
    });
    decoder.dispose();
  });

  it("classifies an early flush as incomplete output", async () => {
    const Worker = fakeWorker();
    const VideoFrame = fakeVideoFrame();
    vi.stubGlobal("Worker", Worker);
    vi.stubGlobal("VideoFrame", VideoFrame);
    const decoder = configuredDecoder();
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
    worker.emit({ t: "flushed", run: run.generation });

    await expect(run.complete()).rejects.toThrow(
      "AVAL decoder output is incomplete"
    );
    expect(decoder.snapshot().diagnostic).toMatchObject({
      phase: "output-validation",
      code: "invalid-output",
      run: run.generation,
      decodeOrdinal: 1,
      firstFrame: { timestamp: 0 },
      lastGoodFrame: { timestamp: 0 },
      outputFailure: {
        kind: "incomplete-output",
        validationLayer: "host-expectation",
        field: "frame-count",
        expected: {
          timestamp: null,
          duration: null,
          frameCount: 2
        },
        actual: {
          timestamp: null,
          duration: null,
          receivedFrameCount: 1
        }
      }
    });
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
      firstFrame: null,
      lastGoodFrame: null,
      outputFailure: null
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

    expect(decoder.snapshot()).toMatchObject({
      workerCount: 1,
      openFrames: 1,
      openFrameBytes: 4_352,
      diagnostic: null
    });
    expect(decodedBytes).toEqual([4_352]);
    const frame = await run.take(0);
    expect(decoder.snapshot().openFrameBytes).toBe(4_352);
    run.release(frame);
    expect(decoder.snapshot()).toMatchObject({
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
    expect(decoder.snapshot()).toMatchObject({
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
    expect(decoder.snapshot()).toMatchObject({
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
      frame: new VideoFrame(Number.MAX_SAFE_INTEGER, 2)
    });

    await expect(run.take(0)).rejects.toThrow(
      "AVAL decoder returned an unsafe coded allocation"
    );
    expect(decoder.snapshot()).toMatchObject({
      workerCount: 0,
      openFrames: 0,
      openFrameBytes: 0,
      diagnostic: expect.objectContaining({
        phase: "output-validation",
        code: "invalid-output",
        outputFailure: expect.objectContaining({
          kind: "coded-allocation",
          field: "allocation"
        })
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
    expect(decoder.snapshot()).toMatchObject({
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

  it("retains structured invalid-output evidence for a frame emitted after flush", async () => {
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
    worker.emit({ t: "started", run: run.generation });
    worker.emit({ t: "accepted", run: run.generation });
    worker.emit({
      t: "frame",
      run: run.generation,
      timestamp: 0,
      frame: new VideoFrame(32, 34)
    });
    const accepted = await run.take(0);
    run.release(accepted);
    worker.emit({ t: "flushed", run: run.generation });
    await run.complete();

    const late = new VideoFrame(32, 34);
    worker.emit({
      t: "frame",
      run: run.generation,
      timestamp: 0,
      frame: late
    });

    await expect(failure).rejects.toThrow("AVAL decoder emitted after flush");
    expect((late as unknown as { closed: boolean }).closed).toBe(true);
    expect(decoder.snapshot().diagnostic).toMatchObject({
      phase: "output-validation",
      code: "invalid-output",
      run: run.generation,
      decodeOrdinal: 0,
      lastGoodFrame: { timestamp: 0 },
      outputFailure: {
        kind: "duplicate-output",
        validationLayer: "host-expectation",
        field: "ordinal",
        expected: null,
        actual: { timestamp: 0 }
      }
    });
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
    expect(decoder.snapshot()).toMatchObject({
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
    codec: "avc1.42E020",
    codedWidth: 16,
    codedHeight: 16,
    displayAspectWidth: 2,
    displayAspectHeight: 2
  }, DEFAULT_EXPECTATION, limits);
}

function strictBt709Decoder(
  codec: string,
  limits: Readonly<DecoderLimits> = {}
): Decoder {
  return new Decoder({
    codec,
    codedWidth: 16,
    codedHeight: 16,
    displayAspectWidth: 2,
    displayAspectHeight: 2,
    colorSpace: BT709_LIMITED_COLOR
  }, {
    codedWidth: 16,
    codedHeight: 16,
    displayWidth: 2,
    displayHeight: 2,
    visibleRect: { x: 0, y: 0, width: 2, height: 2 },
    colorSpace: BT709_LIMITED_COLOR
  }, limits);
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
    public readonly codedWidth: number;
    public readonly codedHeight: number;
    public readonly timestamp: number;
    public readonly duration: number;
    public readonly displayWidth: number;
    public readonly displayHeight: number;
    public readonly visibleRect: Readonly<{
      x: number;
      y: number;
      width: number;
      height: number;
    }>;
    public readonly colorSpace: Readonly<VideoColorSpaceInit>;
    public closed = false;

    public constructor(
      codedWidthOrSource: number | VideoFrame,
      codedHeightOrInit: number | VideoFrameInit,
      timestamp = 0
    ) {
      if (typeof codedWidthOrSource === "number") {
        this.codedWidth = codedWidthOrSource;
        this.codedHeight = codedHeightOrInit as number;
        this.timestamp = timestamp;
        this.duration = 1;
        this.displayWidth = 2;
        this.displayHeight = 2;
        this.visibleRect = Object.freeze({ x: 0, y: 0, width: 2, height: 2 });
        this.colorSpace = normalizedColorSpace;
        return;
      }
      const init = codedHeightOrInit as VideoFrameInit;
      this.codedWidth = codedWidthOrSource.codedWidth;
      this.codedHeight = codedWidthOrSource.codedHeight;
      this.timestamp = init.timestamp ?? codedWidthOrSource.timestamp;
      this.duration = init.duration ?? codedWidthOrSource.duration ?? 0;
      this.displayWidth = codedWidthOrSource.displayWidth;
      this.displayHeight = codedWidthOrSource.displayHeight;
      this.visibleRect = Object.freeze({ ...codedWidthOrSource.visibleRect! });
      this.colorSpace = normalizedColorSpace;
    }

    public close(): void { this.closed = true; }
  } as unknown as {
    new(codedWidth: number, codedHeight: number, timestamp?: number): VideoFrame;
  };
}
