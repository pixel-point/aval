import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  captureDecoderFrameMetadata,
  createDecoderFailureDiagnostic,
  isDecoderFailureDiagnostic,
  type DecoderExpectedOutputMetadata,
  type DecoderFailureDiagnostic,
  type DecoderFrameMetadata,
  type DecoderObservedFrameMetadata,
  type DecoderOutputFailure
} from "../src/decoder-diagnostics.js";
import {
  isDecoderCommand,
  isDecoderWorkerEvent,
  type DecoderCommand,
  type DecoderWorkerEvent
} from "../src/decoder-protocol.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("decoder worker protocol", () => {
  it("accepts plain structured records delivered from another realm", () => {
    class Frame {}
    const VideoFrameConstructor = Frame as unknown as typeof VideoFrame;
    const configured = runInNewContext("({ t: 'configured', supported: true })");
    const diagnostic = runInNewContext(`({
      phase: 'probe',
      code: 'unsupported-config',
      run: null,
      decodeOrdinal: null,
      exception: { name: 'NotSupportedError', message: 'unsupported' },
      firstFrame: null,
      lastGoodFrame: null,
      outputFailure: null
    })`);

    expect(isDecoderWorkerEvent(configured, VideoFrameConstructor)).toBe(true);
    expect(isDecoderFailureDiagnostic(diagnostic)).toBe(true);
    expect(isDecoderWorkerEvent(
      runInNewContext("({ t: 'error', diagnostic })", { diagnostic }),
      VideoFrameConstructor
    )).toBe(true);
  });

  it("accepts only exact command and event shapes", () => {
    class Frame {}
    const VideoFrameConstructor = Frame as unknown as typeof VideoFrame;

    expect(isDecoderCommand({ t: "close", run: 1 })).toBe(true);
    expect(isDecoderCommand({ t: "close", run: 1, extra: true })).toBe(false);
    const hiddenCommand = { t: "close", run: 1 };
    Object.defineProperty(hiddenCommand, "hidden", { value: true });
    expect(isDecoderCommand(hiddenCommand)).toBe(false);
    const symbolCommand = { t: "close", run: 1 };
    Object.defineProperty(symbolCommand, Symbol("hidden"), { value: true });
    expect(isDecoderCommand(symbolCommand)).toBe(false);
    const customPrototypeCommand = Object.assign(
      Object.create({ inherited: true }) as Record<string, unknown>,
      { t: "close", run: 1 }
    );
    expect(isDecoderCommand(customPrototypeCommand)).toBe(false);
    expect(isDecoderCommand({
      t: "decode",
      run: 1,
      chunks: new Array(1)
    })).toBe(false);
    const inheritedCommand = Object.assign(
      Object.create({ t: "close", run: 1 }) as Record<string, unknown>,
      { unrelated: true, alsoUnrelated: true }
    );
    expect(isDecoderCommand(inheritedCommand)).toBe(false);
    expect(isDecoderCommand({
      t: "decode",
      run: 1,
      chunks: [{
        data: new Uint8Array([1]).buffer,
        timestamp: 0,
        duration: 1,
        key: true,
        extra: true
      }]
    })).toBe(false);
    expect(isDecoderWorkerEvent({ t: "error" }, VideoFrameConstructor)).toBe(false);
    const validDiagnostic = failureDiagnostic();
    const validError = { t: "error", diagnostic: validDiagnostic };
    expect(isDecoderWorkerEvent(validError, VideoFrameConstructor)).toBe(true);
    expect(Object.isFrozen(validError)).toBe(true);
    expect(Object.isFrozen(validDiagnostic)).toBe(true);
    expect(Object.isFrozen(validDiagnostic.exception)).toBe(true);
    expect(Object.isFrozen(validDiagnostic.firstFrame)).toBe(true);
    expect(Object.isFrozen(validDiagnostic.firstFrame.visibleRect)).toBe(true);
    expect(Object.isFrozen(validDiagnostic.firstFrame.colorSpace)).toBe(true);
    expect(Object.isFrozen(validDiagnostic.lastGoodFrame)).toBe(true);
    expect(Object.isFrozen(validDiagnostic.lastGoodFrame.visibleRect)).toBe(true);
    expect(Object.isFrozen(validDiagnostic.lastGoodFrame.colorSpace)).toBe(true);
    expect(Object.isFrozen(validDiagnostic.outputFailure)).toBe(true);
    expect(Object.isFrozen(validDiagnostic.outputFailure.expected)).toBe(true);
    expect(Object.isFrozen(
      validDiagnostic.outputFailure.expected.visibleRect
    )).toBe(true);
    expect(Object.isFrozen(
      validDiagnostic.outputFailure.expected.colorSpace
    )).toBe(true);
    expect(Object.isFrozen(validDiagnostic.outputFailure.actual)).toBe(true);
    expect(Object.isFrozen(
      validDiagnostic.outputFailure.actual.visibleRect
    )).toBe(true);
    expect(Object.isFrozen(
      validDiagnostic.outputFailure.actual.colorSpace
    )).toBe(true);
    expect(Reflect.ownKeys(validDiagnostic)).toEqual([
      "phase",
      "code",
      "run",
      "decodeOrdinal",
      "exception",
      "firstFrame",
      "lastGoodFrame",
      "outputFailure"
    ]);
    expect(Reflect.ownKeys(validDiagnostic.lastGoodFrame)).toEqual([
      "timestamp",
      "duration",
      "codedWidth",
      "codedHeight",
      "displayWidth",
      "displayHeight",
      "visibleRect",
      "colorSpace"
    ]);
    expect(Reflect.ownKeys(validDiagnostic.outputFailure)).toEqual([
      "kind",
      "validationLayer",
      "field",
      "expected",
      "actual"
    ]);
    expect(Reflect.ownKeys(validDiagnostic.outputFailure.expected)).toEqual([
      "timestamp",
      "duration",
      "codedWidth",
      "codedHeight",
      "displayAspectWidth",
      "displayAspectHeight",
      "visibleRect",
      "colorSpace",
      "frameCount"
    ]);
    expect(Reflect.ownKeys(validDiagnostic.outputFailure.actual)).toEqual([
      "timestamp",
      "duration",
      "codedWidth",
      "codedHeight",
      "displayWidth",
      "displayHeight",
      "visibleRect",
      "colorSpace",
      "receivedFrameCount"
    ]);
    const inheritedEvent = Object.assign(
      Object.create({ t: "error" }) as Record<string, unknown>,
      { unrelated: true }
    );
    expect(isDecoderWorkerEvent(inheritedEvent, VideoFrameConstructor)).toBe(false);
    expect(isDecoderWorkerEvent(
      { t: "error", diagnostic: validDiagnostic, run: 1 },
      VideoFrameConstructor
    )).toBe(false);
    expect(isDecoderWorkerEvent(
      { t: "closed", run: 1, extra: true },
      VideoFrameConstructor
    )).toBe(false);
    const hiddenEvent = { t: "closed", run: 1 };
    Object.defineProperty(hiddenEvent, "hidden", { value: true });
    expect(isDecoderWorkerEvent(hiddenEvent, VideoFrameConstructor)).toBe(false);
    const symbolEvent = { t: "closed", run: 1 };
    Object.defineProperty(symbolEvent, Symbol("hidden"), { value: true });
    expect(isDecoderWorkerEvent(symbolEvent, VideoFrameConstructor)).toBe(false);
    const customPrototypeEvent = Object.assign(
      Object.create({ inherited: true }) as Record<string, unknown>,
      { t: "closed", run: 1 }
    );
    expect(isDecoderWorkerEvent(
      customPrototypeEvent,
      VideoFrameConstructor
    )).toBe(false);
  });

  it("rejects unsafe, unbounded, or media-bearing diagnostics", () => {
    class Frame {}
    const VideoFrameConstructor = Frame as unknown as typeof VideoFrame;
    const valid = failureDiagnostic();
    const exceptionWithHiddenStack = { ...valid.exception };
    Object.defineProperty(exceptionWithHiddenStack, "stack", {
      value: "private stack",
      enumerable: false
    });
    const outputFailureWithHidden = { ...valid.outputFailure };
    Object.defineProperty(outputFailureWithHidden, "hidden", {
      value: true,
      enumerable: false
    });
    const expectedWithSymbol = { ...valid.outputFailure.expected };
    Object.defineProperty(expectedWithSymbol, Symbol("hidden"), {
      value: true,
      enumerable: false
    });
    const actualWithCustomPrototype = Object.assign(
      Object.create({ inherited: true }) as Record<string, unknown>,
      valid.outputFailure.actual
    );
    const candidates: unknown[] = [
      { ...valid, extra: true },
      { ...valid, run: Number.MAX_SAFE_INTEGER + 1 },
      { ...valid, decodeOrdinal: -1 },
      { ...valid, exception: { ...valid.exception, stack: "private stack" } },
      { ...valid, exception: exceptionWithHiddenStack },
      { ...valid, exception: { name: "n".repeat(65), message: "failure" } },
      { ...valid, exception: { name: "Error", message: "m".repeat(513) } },
      { ...valid, exception: { name: "Error\n", message: "failure" } },
      { ...valid, exception: { name: "Error", message: "https://private.invalid/a" } },
      { ...valid, exception: { name: "Error", message: "ftp://private.invalid/a" } },
      {
        ...valid,
        exception: { name: "Error", message: "chrome-extension://private/page" }
      },
      { ...valid, exception: { name: "Error", message: "//private.invalid/a" } },
      { ...valid, exception: { name: "Error", message: "aval-preview://private/a" } },
      { ...valid, exception: { name: "Error", message: "/private/media.av1?token=x" } },
      { ...valid, exception: { name: "Error", message: "private.example/media.av1" } },
      { ...valid, exception: { name: "Error", message: "/Users/alex/private.av1" } },
      { ...valid, exception: { name: "Error", message: "C:\\Users\\alex\\private.av1" } },
      { ...valid, exception: { name: "Error", message: "assets/private.av1" } },
      {
        ...valid,
        exception: {
          name: "Error",
          message: "failed [/private/media.av1?token=SECRET(LEAK)]"
        }
      },
      {
        ...valid,
        exception: {
          name: "Error",
          message: "\\\\server\\share\\media.av1?token=SECRET"
        }
      },
      {
        ...valid,
        exception: { name: "Error", message: "192.168.1.10?token=SECRET" }
      },
      {
        ...valid,
        exception: { name: "Error", message: "private.xn--p1ai?token=SECRET" }
      },
      {
        ...valid,
        exception: { name: "Error", message: "[2001:db8::1]?token=SECRET" }
      },
      { ...valid, firstFrame: new Uint8Array([1, 2, 3]) },
      { ...valid, firstFrame: { config: { codec: "avc1.42E020" } } },
      { ...valid, firstFrame: new Frame() },
      { ...valid, firstFrame: { ...valid.firstFrame, timestamp: Number.NaN } },
      {
        ...valid,
        firstFrame: {
          ...valid.firstFrame,
          visibleRect: { ...valid.firstFrame.visibleRect, private: true }
        }
      },
      {
        ...valid,
        firstFrame: {
          ...valid.firstFrame,
          colorSpace: ["bt709", "bt709", "bt709", false, "extra"]
        }
      },
      { ...valid, lastGoodFrame: new Uint8Array([1, 2, 3]) },
      { ...valid, lastGoodFrame: { config: { codec: "avc1.42E020" } } },
      { ...valid, lastGoodFrame: new Frame() },
      {
        ...valid,
        lastGoodFrame: { ...valid.lastGoodFrame, private: true }
      },
      {
        ...valid,
        lastGoodFrame: {
          ...valid.lastGoodFrame,
          duration: Number.POSITIVE_INFINITY
        }
      },
      {
        ...valid,
        lastGoodFrame: {
          ...valid.lastGoodFrame,
          visibleRect: { ...valid.lastGoodFrame.visibleRect, private: true }
        }
      },
      {
        ...valid,
        lastGoodFrame: {
          ...valid.lastGoodFrame,
          colorSpace: ["bt709", "bt709", "bt709", false, "extra"]
        }
      },
      { ...valid, outputFailure: new Uint8Array([1, 2, 3]) },
      { ...valid, outputFailure: new Frame() },
      { ...valid, outputFailure: { ...valid.outputFailure, extra: true } },
      { ...valid, outputFailure: outputFailureWithHidden },
      {
        ...valid,
        outputFailure: { ...valid.outputFailure, kind: "private-output" }
      },
      {
        ...valid,
        outputFailure: { ...valid.outputFailure, validationLayer: "renderer" }
      },
      {
        ...valid,
        outputFailure: { ...valid.outputFailure, field: "config" }
      },
      {
        ...valid,
        outputFailure: {
          ...valid.outputFailure,
          expected: new Uint8Array([1, 2, 3])
        }
      },
      {
        ...valid,
        outputFailure: {
          ...valid.outputFailure,
          expected: { ...valid.outputFailure.expected, private: true }
        }
      },
      {
        ...valid,
        outputFailure: {
          ...valid.outputFailure,
          expected: expectedWithSymbol
        }
      },
      {
        ...valid,
        outputFailure: {
          ...valid.outputFailure,
          expected: {
            ...valid.outputFailure.expected,
            codedWidth: Number.MAX_SAFE_INTEGER + 1
          }
        }
      },
      {
        ...valid,
        outputFailure: {
          ...valid.outputFailure,
          expected: {
            ...valid.outputFailure.expected,
            visibleRect: {
              ...valid.outputFailure.expected.visibleRect,
              data: new Uint8Array([1])
            }
          }
        }
      },
      {
        ...valid,
        outputFailure: {
          ...valid.outputFailure,
          expected: {
            ...valid.outputFailure.expected,
            colorSpace: ["bt709", "bt709", "private.example", false]
          }
        }
      },
      {
        ...valid,
        outputFailure: {
          ...valid.outputFailure,
          expected: {
            ...valid.outputFailure.expected,
            frameCount: -1
          }
        }
      },
      {
        ...valid,
        outputFailure: {
          ...valid.outputFailure,
          actual: new Frame()
        }
      },
      {
        ...valid,
        outputFailure: {
          ...valid.outputFailure,
          actual: { ...valid.outputFailure.actual, private: true }
        }
      },
      {
        ...valid,
        outputFailure: {
          ...valid.outputFailure,
          actual: actualWithCustomPrototype
        }
      },
      {
        ...valid,
        outputFailure: {
          ...valid.outputFailure,
          actual: {
            ...valid.outputFailure.actual,
            timestamp: Number.NaN
          }
        }
      },
      {
        ...valid,
        outputFailure: {
          ...valid.outputFailure,
          actual: {
            ...valid.outputFailure.actual,
            visibleRect: new Uint8Array([1, 2, 3])
          }
        }
      },
      {
        ...valid,
        outputFailure: {
          ...valid.outputFailure,
          actual: {
            ...valid.outputFailure.actual,
            colorSpace: ["bt709", "bt709", "bt709", false, "extra"]
          }
        }
      },
      {
        ...valid,
        outputFailure: {
          ...valid.outputFailure,
          actual: {
            ...valid.outputFailure.actual,
            receivedFrameCount: Number.MAX_SAFE_INTEGER + 1
          }
        }
      }
    ];

    for (const diagnostic of candidates) {
      expect(isDecoderFailureDiagnostic(diagnostic)).toBe(false);
      expect(isDecoderWorkerEvent(
        { t: "error", diagnostic },
        VideoFrameConstructor
      )).toBe(false);
    }
  });

  it("sanitizes exceptions and captures only bounded first-frame metadata", () => {
    const frame = metadataFrame(41);
    Object.defineProperties(frame, {
      data: { get: () => { throw new Error("encoded bytes were read"); } },
      config: { get: () => { throw new Error("decoder config was read"); } },
      stack: { get: () => { throw new Error("frame stack was read"); } }
    });
    const firstFrame = captureDecoderFrameMetadata(frame as unknown as VideoFrame);
    const diagnostic = createDecoderFailureDiagnostic({
      phase: "decode",
      code: "decoder-operation",
      run: 7,
      decodeOrdinal: 3,
      reason: {
        name: `Encoding\u0000Error${"n".repeat(100)}`,
        message: "Decoder\nfailed at https://private.invalid/media.av1 " +
          "ftp://private.invalid/archive " +
          "chrome-extension://private/page " +
          "//private.invalid/cdn aval-preview://private/asset " +
          "/media.av1?token=SECRET private.example/asset " +
          "/Users/alex/private.av1 C:\\Users\\alex\\private.av1 " +
          "assets/private.av1 failed [/private/media.av1?token=SECRET(LEAK)] " +
          "\\\\server\\share\\media.av1?token=SECRET " +
          "192.168.1.10?token=SECRET private.xn--p1ai?token=SECRET " +
          "[2001:db8::1]?token=SECRET " +
          "m".repeat(700),
        stack: "private stack",
        cause: new Error("private cause"),
        data: new Uint8Array([1, 2, 3]),
        config: { codec: "av01.0.08M.08.0.110.01.01.01.0" },
        frame
      },
      firstFrame
    });

    expect(diagnostic.exception?.name).toHaveLength(64);
    expect(diagnostic.exception?.name).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/u);
    expect(diagnostic.exception?.message.length).toBeLessThanOrEqual(512);
    expect(diagnostic.exception?.message).toContain("[redacted-url]");
    expect(diagnostic.exception?.message).not.toContain("private.invalid");
    expect(diagnostic.exception?.message).not.toContain("chrome-extension");
    expect(diagnostic.exception?.message).not.toContain("aval-preview");
    expect(diagnostic.exception?.message).not.toContain("SECRET");
    expect(diagnostic.exception?.message).not.toContain("Users");
    expect(diagnostic.exception?.message).not.toContain("token=");
    expect(diagnostic.exception?.message).not.toContain("LEAK");
    expect(diagnostic.exception?.message).not.toContain("server");
    expect(diagnostic.exception?.message).not.toContain("192.168");
    expect(diagnostic.exception?.message).not.toContain("xn--");
    expect(diagnostic.exception?.message).not.toContain("2001:db8");
    expect(diagnostic.exception?.message.match(/\[redacted-url\]/gu)).toHaveLength(15);
    expect(Object.keys(diagnostic.exception ?? {})).toEqual(["name", "message"]);
    expect(diagnostic.firstFrame).toEqual({
      timestamp: 41,
      duration: 33_333,
      codedWidth: 1920,
      codedHeight: 1080,
      displayWidth: 960,
      displayHeight: 540,
      visibleRect: { x: 4, y: 2, width: 1280, height: 720 },
      colorSpace: ["bt709", "bt709", "bt709", false]
    });
    expect(isDecoderFailureDiagnostic(diagnostic)).toBe(true);
    expect(Object.isFrozen(diagnostic)).toBe(true);
    expect(Object.isFrozen(diagnostic.firstFrame)).toBe(true);
  });
});

describe("decoder worker run isolation", () => {
  it("configures with an exact clone of every recognized requested member", async () => {
    const worker = await fakeDecoderWorker();
    const requested = requestedDecoderConfig();

    worker.command({ t: "configure", config: requested });
    await Promise.resolve();

    expect(worker.supportRequests).toEqual([requested]);
    expect(worker.posted).toEqual([ifConfigured()]);

    worker.command({ t: "start", run: 1 });

    expect(worker.configuredConfigs).toEqual([requested]);
    expect(worker.configuredConfigs[0]).not.toBe(requested);
    expect(worker.configuredConfigs[0]?.colorSpace).not.toBe(
      requested.colorSpace
    );
    expect(Object.isFrozen(worker.configuredConfigs[0])).toBe(true);
    expect(Object.isFrozen(worker.configuredConfigs[0]?.colorSpace)).toBe(true);
  });

  it("accepts only browser defaults for unrequested decoder hints", async () => {
    const requested = requestedDecoderConfig();
    Reflect.deleteProperty(requested, "hardwareAcceleration");
    Reflect.deleteProperty(requested, "optimizeForLatency");
    const worker = await fakeDecoderWorker({
      supportResult: (config) => ({
        supported: true,
        config: {
          ...config,
          hardwareAcceleration: "no-preference",
          optimizeForLatency: false
        }
      })
    });

    worker.command({ t: "configure", config: requested });
    await Promise.resolve();
    worker.command({ t: "start", run: 1 });

    expect(worker.configuredConfigs).toEqual([requested]);
    expect(worker.posted).toEqual([
      ifConfigured(),
      { t: "started", run: 1 }
    ]);
  });

  it.each([
    ["non-default hardwareAcceleration", {
      hardwareAcceleration: "prefer-hardware" as const,
      optimizeForLatency: false
    }],
    ["non-default optimizeForLatency", {
      hardwareAcceleration: "no-preference" as const,
      optimizeForLatency: true
    }]
  ])(
    "rejects %s when decoder hints were not requested",
    async (_name, defaults) => {
      const requested = requestedDecoderConfig();
      Reflect.deleteProperty(requested, "hardwareAcceleration");
      Reflect.deleteProperty(requested, "optimizeForLatency");
      const worker = await fakeDecoderWorker({
        supportResult: (config) => ({
          supported: true,
          config: { ...config, ...defaults }
        })
      });

      worker.command({ t: "configure", config: requested });
      await Promise.resolve();
      worker.command({ t: "start", run: 1 });

      expect(worker.decoders).toEqual([]);
      expect(worker.posted.at(-1)).toEqual({
        t: "error",
        diagnostic: {
          phase: "probe",
          code: "unsupported-config",
          run: null,
          decodeOrdinal: null,
          exception: null,
          firstFrame: null,
          lastGoodFrame: null,
          outputFailure: null
        }
      });
    }
  );

  it.each(supportEchoFailures())(
    "rejects a positive support result with %s before decoder construction",
    async (_name, supportResult) => {
      const worker = await fakeDecoderWorker({ supportResult });

      worker.command({ t: "configure", config: requestedDecoderConfig() });
      await Promise.resolve();
      worker.command({ t: "start", run: 1 });

      expect(worker.decoders).toEqual([]);
      expect(worker.configuredConfigs).toEqual([]);
      expect(worker.posted).toEqual([{
        t: "error",
        diagnostic: {
          phase: "probe",
          code: "unsupported-config",
          run: null,
          decodeOrdinal: null,
          exception: null,
          firstFrame: null,
          lastGoodFrame: null,
          outputFailure: null
        }
      }]);
    }
  );

  it("closes a late retired-run frame instead of relabeling it as the next run", async () => {
    const worker = await fakeDecoderWorker();

    worker.command({ t: "configure", config: { codec: "avc1.42E020" } });
    await Promise.resolve();
    worker.command({ t: "start", run: 1 });
    const retired = worker.decoders[0]!;
    worker.command({ t: "close", run: 1 });
    retired.resolveFlush();
    await Promise.resolve();
    worker.command({ t: "start", run: 2 });

    const late = { timestamp: 7, closed: false, close() { this.closed = true; } };
    retired.callbacks.output(late as unknown as VideoFrame);
    retired.callbacks.error(new DOMException("Retired failure", "EncodingError"));

    expect(late.closed).toBe(true);
    expect(worker.posted.filter((event) => event.t === "frame")).toEqual([]);
    expect(worker.posted.filter((event) => event.t === "error")).toEqual([]);
    expect(worker.posted).toContainEqual({ t: "closed", run: 1 });
    expect(worker.posted).toContainEqual({ t: "started", run: 2 });
  });

  it("ignores a close command after that run's flush already resolved", async () => {
    const worker = await fakeDecoderWorker();

    worker.command({ t: "configure", config: { codec: "avc1.42E020" } });
    await Promise.resolve();
    worker.command({ t: "start", run: 1 });
    const retired = worker.decoders[0]!;
    worker.command({ t: "flush", run: 1 });
    retired.resolveFlush();
    await Promise.resolve();
    expect(worker.posted).toContainEqual({ t: "flushed", run: 1 });

    worker.command({ t: "close", run: 1 });
    worker.command({ t: "start", run: 2 });

    expect(worker.posted.filter((event) => event.t === "error")).toEqual([]);
    expect(worker.posted).toContainEqual({ t: "started", run: 2 });
  });

  it("reuses an in-flight flush when close wins the terminal race", async () => {
    const worker = await fakeDecoderWorker();

    worker.command({ t: "configure", config: { codec: "avc1.42E020" } });
    await Promise.resolve();
    worker.command({ t: "start", run: 1 });
    const closing = worker.decoders[0]!;
    worker.command({ t: "flush", run: 1 });
    expect(closing.flushCalls).toBe(1);

    worker.command({ t: "close", run: 1 });
    expect(closing.flushCalls).toBe(1);
    closing.resolveFlush();
    await Promise.resolve();

    expect(worker.posted).toContainEqual({ t: "closed", run: 1 });
    expect(worker.posted).not.toContainEqual({ t: "flushed", run: 1 });
    worker.command({ t: "start", run: 2 });
    expect(worker.posted).toContainEqual({ t: "started", run: 2 });
  });

  it("reports a close-initiated flush rejection instead of closing", async () => {
    const worker = await fakeDecoderWorker();

    worker.command({ t: "configure", config: { codec: "avc1.42E020" } });
    await Promise.resolve();
    worker.command({ t: "start", run: 1 });
    const closing = worker.decoders[0]!;
    worker.command({ t: "close", run: 1 });
    closing.rejectFlush(new DOMException("Close flush rejected", "OperationError"));
    await Promise.resolve();

    expect(worker.posted).not.toContainEqual({ t: "closed", run: 1 });
    expect(worker.posted.at(-1)).toMatchObject({
      t: "error",
      diagnostic: {
        phase: "flush",
        code: "decoder-operation",
        run: 1,
        decodeOrdinal: null,
        exception: { name: "OperationError", message: "Close flush rejected" }
      }
    });
  });

  it("reports rejection when close takes ownership of an in-flight flush", async () => {
    const worker = await fakeDecoderWorker();

    worker.command({ t: "configure", config: { codec: "avc1.42E020" } });
    await Promise.resolve();
    worker.command({ t: "start", run: 1 });
    const closing = worker.decoders[0]!;
    worker.command({ t: "flush", run: 1 });
    worker.command({ t: "close", run: 1 });
    expect(closing.flushCalls).toBe(1);
    closing.rejectFlush(new DOMException("Raced flush rejected", "OperationError"));
    await Promise.resolve();

    expect(worker.posted).not.toContainEqual({ t: "closed", run: 1 });
    expect(worker.posted).not.toContainEqual({ t: "flushed", run: 1 });
    expect(worker.posted.at(-1)).toMatchObject({
      t: "error",
      diagnostic: {
        phase: "flush",
        code: "decoder-operation",
        run: 1,
        decodeOrdinal: null,
        exception: { name: "OperationError", message: "Raced flush rejected" }
      }
    });
  });

  it("keeps every older close idempotent and rejects future generations", async () => {
    const worker = await fakeDecoderWorker();

    worker.command({ t: "configure", config: { codec: "avc1.42E020" } });
    await Promise.resolve();
    for (const run of [1, 2]) {
      worker.command({ t: "start", run });
      const decoder = worker.decoders[run - 1]!;
      worker.command({ t: "flush", run });
      decoder.resolveFlush();
      await Promise.resolve();
    }

    worker.command({ t: "close", run: 1 });
    expect(worker.posted.filter((event) => event.t === "error")).toEqual([]);
    worker.command({ t: "start", run: 3 });
    expect(worker.posted).toContainEqual({ t: "started", run: 3 });

    worker.command({ t: "close", run: 4 });
    expect(worker.posted.at(-1)).toMatchObject({
      t: "error",
      diagnostic: { phase: "flush", code: "decoder-operation", run: 4 }
    });
  });

  it("reuses one worker for 64 complete 24-frame generations", async () => {
    const worker = await fakeDecoderWorker();
    worker.command({ t: "configure", config: { codec: "avc1.42E01E" } });
    await Promise.resolve();

    for (let run = 1; run <= 64; run += 1) {
      worker.command({ t: "start", run });
      const decoder = worker.decoders[run - 1]!;
      for (let batch = 0; batch < 2; batch += 1) {
        const first = batch * 12;
        worker.command({
          t: "decode",
          run,
          chunks: Array.from({ length: 12 }, (_unused, offset) =>
            decoderChunk((first + offset) * 33_333))
        });
        for (let offset = 0; offset < 12; offset += 1) {
          decoder.callbacks.output(
            metadataFrame((first + offset) * 33_333) as unknown as VideoFrame
          );
        }
      }
      worker.command({ t: "flush", run });
      decoder.resolveFlush();
      await Promise.resolve();
    }

    expect(worker.decoders).toHaveLength(64);
    expect(worker.decoders.every(({ state }) => state === "closed")).toBe(true);
    expect(worker.posted.filter(({ t }) => t === "started")).toHaveLength(64);
    expect(worker.posted.filter(({ t }) => t === "flushed")).toHaveLength(64);
    expect(worker.posted.filter(({ t }) => t === "frame")).toHaveLength(1_536);
    expect(worker.posted.filter(({ t }) => t === "error")).toEqual([]);
    expect(worker.posted.at(-1)).toEqual({ t: "flushed", run: 64 });
  });

  it("terminalizes generation 21 on its first invalid output", async () => {
    const worker = await fakeDecoderWorker();
    worker.command({ t: "configure", config: { codec: "avc1.42E01E" } });
    await Promise.resolve();

    for (let run = 1; run <= 20; run += 1) {
      worker.command({ t: "start", run });
      const decoder = worker.decoders[run - 1]!;
      for (let batch = 0; batch < 2; batch += 1) {
        const first = batch * 12;
        worker.command({
          t: "decode",
          run,
          chunks: Array.from({ length: 12 }, (_unused, offset) =>
            decoderChunk((first + offset) * 33_333))
        });
        for (let offset = 0; offset < 12; offset += 1) {
          decoder.callbacks.output(
            metadataFrame((first + offset) * 33_333) as unknown as VideoFrame
          );
        }
      }
      worker.command({ t: "flush", run });
      decoder.resolveFlush();
      await Promise.resolve();
    }

    worker.command({ t: "start", run: 21 });
    worker.command({
      t: "decode",
      run: 21,
      chunks: [decoderChunk(0)]
    });
    const invalid = metadataFrame(0);
    invalid.duration = Number.NaN;
    worker.decoders[20]!.callbacks.output(invalid as unknown as VideoFrame);
    worker.command({ t: "start", run: 22 });

    expect(worker.decoders).toHaveLength(21);
    expect(worker.decoders.every(({ state }) => state === "closed")).toBe(true);
    expect(invalid.closed).toBe(true);
    expect(worker.posted.filter(({ t }) => t === "error")).toHaveLength(1);
    expect(worker.posted.at(-1)).toMatchObject({
      t: "error",
      diagnostic: {
        phase: "output-validation",
        code: "invalid-output",
        run: 21,
        decodeOrdinal: 0,
        firstFrame: null,
        lastGoodFrame: null,
        outputFailure: {
          kind: "metadata-shape",
          validationLayer: "worker-shape",
          field: "duration",
          expected: null,
          actual: { timestamp: 0, duration: null, receivedFrameCount: null }
        }
      }
    });
  });

  it("turns a malformed transport command into a global failure", async () => {
    const worker = await fakeDecoderWorker();

    worker.send(null);

    expect(worker.posted).toEqual([{
      t: "error",
      diagnostic: {
        phase: "probe",
        code: "transport",
        run: null,
        decodeOrdinal: null,
        exception: null,
        firstFrame: null,
        lastGoodFrame: null,
        outputFailure: null
      }
    }]);
  });

  it("preserves an isConfigSupported rejection as probe evidence", async () => {
    const worker = await fakeDecoderWorker({ supportRejects: true });

    worker.command({
      t: "configure",
      config: { codec: "av01.0.08M.08.0.110.01.01.01.0" }
    });
    await Promise.resolve();

    expect(worker.posted).toEqual([{
      t: "error",
      diagnostic: {
        phase: "probe",
        code: "decoder-operation",
        run: null,
        decodeOrdinal: null,
        exception: {
          name: "NotSupportedError",
          message: "Probe rejected [redacted-url]"
        },
        firstFrame: null,
        lastGoodFrame: null,
        outputFailure: null
      }
    }]);
  });

  it("preserves a decoder configuration failure with its run", async () => {
    const worker = await fakeDecoderWorker({ configureThrows: true });

    worker.command({ t: "configure", config: { codec: "avc1.42E020" } });
    await Promise.resolve();
    worker.command({ t: "start", run: 1 });

    expect(worker.posted.at(-1)).toMatchObject({
      t: "error",
      diagnostic: {
        phase: "configure",
        code: "decoder-operation",
        run: 1,
        decodeOrdinal: null,
        exception: {
          name: "NotSupportedError",
          message: "Configuration rejected"
        },
        firstFrame: null
      }
    });
  });

  it("retains first-frame metadata when the decoder callback fails", async () => {
    const worker = await fakeDecoderWorker();

    worker.command({ t: "configure", config: { codec: "avc1.42E020" } });
    await Promise.resolve();
    worker.command({ t: "start", run: 1 });
    worker.command({
      t: "decode",
      run: 1,
      chunks: [decoderChunk(0), decoderChunk(20)]
    });
    const frame = metadataFrame(0);
    worker.decoders[0]!.callbacks.output(frame as unknown as VideoFrame);
    worker.decoders[0]!.callbacks.error(
      new DOMException("Decoder failed", "EncodingError")
    );
    worker.decoders[0]!.callbacks.error(
      new DOMException("Later failure", "OperationError")
    );

    expect(worker.posted.at(-1)).toMatchObject({
      t: "error",
      diagnostic: {
        phase: "decode",
        code: "decoder-operation",
        run: 1,
        decodeOrdinal: null,
        exception: { name: "EncodingError", message: "Decoder failed" },
        firstFrame: { timestamp: 0, codedWidth: 1920, codedHeight: 1080 }
      }
    });
    expect(worker.posted.filter((event) => event.t === "error")).toHaveLength(1);
  });

  it("maps invalid output metadata to its timestamp ordinal", async () => {
    const worker = await fakeDecoderWorker();

    worker.command({ t: "configure", config: { codec: "avc1.42E020" } });
    await Promise.resolve();
    worker.command({ t: "start", run: 1 });
    worker.command({
      t: "decode",
      run: 1,
      chunks: [decoderChunk(10), decoderChunk(20)]
    });
    const frame = metadataFrame(10);
    frame.duration = Number.NaN;
    Object.defineProperties(frame, {
      data: { get: () => { throw new Error("encoded bytes were read"); } },
      config: { get: () => { throw new Error("decoder config was read"); } },
      stack: { get: () => { throw new Error("frame stack was read"); } },
      url: { get: () => { throw new Error("frame URL was read"); } }
    });
    worker.decoders[0]!.callbacks.output(frame as unknown as VideoFrame);

    expect(frame.closed).toBe(true);
    expect(worker.posted).toEqual([ifConfigured(), { t: "started", run: 1 }, {
      t: "accepted",
      run: 1
    }, {
      t: "error",
      diagnostic: {
        phase: "output-validation",
        code: "invalid-output",
        run: 1,
        decodeOrdinal: 0,
        exception: {
          name: "TypeError",
          message: "invalid decoder output metadata"
        },
        firstFrame: null,
        lastGoodFrame: null,
        outputFailure: {
          kind: "metadata-shape",
          validationLayer: "worker-shape",
          field: "duration",
          expected: null,
          actual: {
            timestamp: 10,
            duration: null,
            codedWidth: 1920,
            codedHeight: 1080,
            displayWidth: 960,
            displayHeight: 540,
            visibleRect: { x: 4, y: 2, width: 1280, height: 720 },
            colorSpace: ["bt709", "bt709", "bt709", false],
            receivedFrameCount: null
          }
        }
      }
    }]);
    const error = worker.posted.at(-1);
    if (error?.t !== "error") throw new Error("expected worker error event");
    expect(Reflect.ownKeys(error)).toEqual(["t", "diagnostic"]);
    expect(Reflect.ownKeys(error.diagnostic)).toEqual([
      "phase",
      "code",
      "run",
      "decodeOrdinal",
      "exception",
      "firstFrame",
      "lastGoodFrame",
      "outputFailure"
    ]);
    expect(Reflect.ownKeys(error.diagnostic.outputFailure ?? {})).toEqual([
      "kind",
      "validationLayer",
      "field",
      "expected",
      "actual"
    ]);
    expect(Reflect.ownKeys(
      error.diagnostic.outputFailure?.actual ?? {}
    )).toEqual([
      "timestamp",
      "duration",
      "codedWidth",
      "codedHeight",
      "displayWidth",
      "displayHeight",
      "visibleRect",
      "colorSpace",
      "receivedFrameCount"
    ]);
    expect(Object.isFrozen(error.diagnostic)).toBe(true);
    expect(Object.isFrozen(error.diagnostic.outputFailure)).toBe(true);
    expect(Object.isFrozen(error.diagnostic.outputFailure?.actual)).toBe(true);
    expect(Object.isFrozen(
      error.diagnostic.outputFailure?.actual?.visibleRect
    )).toBe(true);
    expect(Object.isFrozen(
      error.diagnostic.outputFailure?.actual?.colorSpace
    )).toBe(true);
  });

  it("preserves flush rejection evidence", async () => {
    const worker = await fakeDecoderWorker();

    worker.command({ t: "configure", config: { codec: "avc1.42E020" } });
    await Promise.resolve();
    worker.command({ t: "start", run: 1 });
    worker.command({ t: "flush", run: 1 });
    worker.decoders[0]!.rejectFlush(
      new DOMException("Flush rejected", "OperationError")
    );
    await Promise.resolve();

    expect(worker.posted.at(-1)).toMatchObject({
      t: "error",
      diagnostic: {
        phase: "flush",
        code: "decoder-operation",
        run: 1,
        exception: { name: "OperationError", message: "Flush rejected" }
      }
    });
  });

  it("maps a multi-chunk transfer failure to the output timestamp ordinal", async () => {
    const worker = await fakeDecoderWorker({ frameTransferThrows: true });

    worker.command({ t: "configure", config: { codec: "avc1.42E020" } });
    await Promise.resolve();
    worker.command({ t: "start", run: 1 });
    worker.command({
      t: "decode",
      run: 1,
      chunks: [decoderChunk(10), decoderChunk(20)]
    });
    const frame = metadataFrame(10);
    worker.decoders[0]!.callbacks.output(frame as unknown as VideoFrame);

    expect(frame.closed).toBe(true);
    expect(worker.transferredMessages).toHaveLength(1);
    expect(worker.posted).toEqual([ifConfigured(), { t: "started", run: 1 }, {
      t: "accepted",
      run: 1
    }, {
      t: "error",
      diagnostic: {
        phase: "frame-transfer",
        code: "transport",
        run: 1,
        decodeOrdinal: 0,
        exception: {
          name: "DataCloneError",
          message: "Frame transfer rejected"
        },
        firstFrame: expect.objectContaining({ timestamp: 10 }),
        lastGoodFrame: null,
        outputFailure: null
      }
    }]);
  });
});

interface FakeDecoderInstance {
  readonly callbacks: VideoDecoderInit;
  readonly state: CodecState;
  readonly flushCalls: number;
  resolveFlush(): void;
  rejectFlush(reason: unknown): void;
}

interface FakeDecoderWorkerOptions {
  readonly supportRejects?: boolean;
  readonly configureThrows?: boolean;
  readonly frameTransferThrows?: boolean;
  readonly supportResult?: (
    config: Readonly<VideoDecoderConfig>
  ) => VideoDecoderSupport;
}

async function fakeDecoderWorker(
  options: Readonly<FakeDecoderWorkerOptions> = {}
): Promise<Readonly<{
  command(data: DecoderCommand): void;
  send(data: unknown): void;
  decoders: readonly FakeDecoderInstance[];
  posted: readonly DecoderWorkerEvent[];
  transferredMessages: readonly unknown[];
  supportRequests: readonly VideoDecoderConfig[];
  configuredConfigs: readonly VideoDecoderConfig[];
}>> {
  let receive!: (event: MessageEvent<unknown>) => void;
  const posted: DecoderWorkerEvent[] = [];
  const transferredMessages: unknown[] = [];
  const decoders: FakeDecoderInstance[] = [];
  const supportRequests: VideoDecoderConfig[] = [];
  const configuredConfigs: VideoDecoderConfig[] = [];
  class FakeDecoder implements FakeDecoderInstance {
    public static isConfigSupported(config: VideoDecoderConfig) {
      supportRequests.push(config);
      if (options.supportRejects === true) {
        return Promise.reject(new DOMException(
          "Probe rejected https://private.invalid/config",
          "NotSupportedError"
        ));
      }
      if (options.supportResult !== undefined) {
        return Promise.resolve(options.supportResult(config));
      }
      return Promise.resolve({ supported: true, config });
    }
    public state: CodecState = "unconfigured";
    public readonly decodeQueueSize = 0;
    public readonly callbacks: VideoDecoderInit;
    readonly #flushes: Array<Readonly<{
      resolve(): void;
      reject(reason: unknown): void;
    }>> = [];
    public flushCalls = 0;
    public constructor(callbacks: VideoDecoderInit) {
      this.callbacks = callbacks;
      decoders.push(this);
    }
    public addEventListener(): void {}
    public configure(config: VideoDecoderConfig): void {
      configuredConfigs.push(config);
      if (options.configureThrows === true) {
        throw new DOMException("Configuration rejected", "NotSupportedError");
      }
      this.state = "configured";
    }
    public decode(): void {}
    public flush(): Promise<void> {
      this.flushCalls += 1;
      return new Promise((resolve, reject) => this.#flushes.push({ resolve, reject }));
    }
    public resolveFlush(): void { this.#flushes.shift()?.resolve(); }
    public rejectFlush(reason: unknown): void { this.#flushes.shift()?.reject(reason); }
    public close(): void { this.state = "closed"; }
  }
  vi.stubGlobal("addEventListener", (_type: string, listener: typeof receive) => {
    receive = listener;
  });
  vi.stubGlobal("postMessage", (
    message: DecoderWorkerEvent,
    transfer?: Transferable[]
  ) => {
    if (transfer !== undefined) {
      transferredMessages.push(message);
      if (options.frameTransferThrows === true) {
        throw new DOMException("Frame transfer rejected", "DataCloneError");
      }
    }
    posted.push(message);
  });
  vi.stubGlobal("VideoDecoder", FakeDecoder);
  vi.stubGlobal("EncodedVideoChunk", class {});
  await import("../src/decoder-worker.js");
  const send = (data: unknown): void => {
    receive({ data } as MessageEvent<unknown>);
  };
  return Object.freeze({
    command: send,
    send,
    decoders,
    posted,
    transferredMessages,
    supportRequests,
    configuredConfigs
  });
}

function decoderChunk(timestamp = 0): Readonly<{
  data: ArrayBuffer;
  timestamp: number;
  duration: number;
  key: boolean;
}> {
  return Object.freeze({
    data: new Uint8Array([1]).buffer,
    timestamp,
    duration: 33_333,
    key: true
  });
}

function metadataFrame(timestamp: number): {
  timestamp: number;
  duration: number;
  codedWidth: number;
  codedHeight: number;
  displayWidth: number;
  displayHeight: number;
  visibleRect: Readonly<{ x: number; y: number; width: number; height: number }>;
  colorSpace: Readonly<{
    primaries: string;
    transfer: string;
    matrix: string;
    fullRange: boolean;
  }>;
  closed: boolean;
  close(): void;
} {
  return {
    timestamp,
    duration: 33_333,
    codedWidth: 1920,
    codedHeight: 1080,
    displayWidth: 960,
    displayHeight: 540,
    visibleRect: { x: 4, y: 2, width: 1280, height: 720 },
    colorSpace: {
      primaries: "bt709",
      transfer: "bt709",
      matrix: "bt709",
      fullRange: false
    },
    closed: false,
    close(): void { this.closed = true; }
  };
}

type RichFailureDiagnostic = DecoderFailureDiagnostic & Readonly<{
  firstFrame: Readonly<DecoderFrameMetadata>;
  lastGoodFrame: Readonly<DecoderFrameMetadata>;
  outputFailure: Readonly<DecoderOutputFailure> & Readonly<{
    expected: Readonly<DecoderExpectedOutputMetadata>;
    actual: Readonly<DecoderObservedFrameMetadata>;
  }>;
}>;

function failureDiagnostic(): RichFailureDiagnostic {
  return {
    phase: "decode",
    code: "decoder-operation",
    run: 1,
    decodeOrdinal: 0,
    exception: { name: "EncodingError", message: "Decode failed" },
    firstFrame: {
      timestamp: 0,
      duration: 33_333,
      codedWidth: 1920,
      codedHeight: 1080,
      displayWidth: 960,
      displayHeight: 540,
      visibleRect: { x: 0, y: 0, width: 1920, height: 1080 },
      colorSpace: ["bt709", "bt709", "bt709", false]
    },
    lastGoodFrame: {
      timestamp: 33_333,
      duration: 33_333,
      codedWidth: 1920,
      codedHeight: 1080,
      displayWidth: 960,
      displayHeight: 540,
      visibleRect: { x: 0, y: 0, width: 1920, height: 1080 },
      colorSpace: ["bt709", "bt709", "bt709", false]
    },
    outputFailure: {
      kind: "timing",
      validationLayer: "host-expectation",
      field: "duration",
      expected: {
        timestamp: 66_666,
        duration: 33_333,
        codedWidth: 1920,
        codedHeight: 1080,
        displayAspectWidth: 16,
        displayAspectHeight: 9,
        visibleRect: { x: 0, y: 0, width: 1920, height: 1080 },
        colorSpace: ["bt709", "bt709", "bt709", false],
        frameCount: 3
      },
      actual: {
        timestamp: 66_666,
        duration: 16_667,
        codedWidth: 1920,
        codedHeight: 1080,
        displayWidth: 960,
        displayHeight: 540,
        visibleRect: { x: 0, y: 0, width: 1920, height: 1080 },
        colorSpace: ["bt709", "bt709", "bt709", false],
        receivedFrameCount: 2
      }
    }
  };
}

type SupportEchoFailure = readonly [
  name: string,
  supportResult: (
    config: Readonly<VideoDecoderConfig>
  ) => VideoDecoderSupport
];

function supportEchoFailures(): readonly SupportEchoFailure[] {
  const omit = (
    key: keyof VideoDecoderConfig
  ): SupportEchoFailure => [
    `omitted ${key}`,
    (config) => ({
      supported: true,
      config: withoutOwnKey(config, key) as unknown as VideoDecoderConfig
    })
  ];
  const change = (
    name: string,
    member: Partial<VideoDecoderConfig>
  ): SupportEchoFailure => [
    `changed ${name}`,
    (config) => ({ supported: true, config: { ...config, ...member } })
  ];
  const omitColor = (
    key: keyof VideoColorSpaceInit
  ): SupportEchoFailure => [
    `omitted colorSpace.${key}`,
    (config) => ({
      supported: true,
      config: {
        ...config,
        colorSpace: withoutOwnKey(config.colorSpace ?? {}, key)
      }
    })
  ];
  const changeColor = (
    name: string,
    member: Partial<VideoColorSpaceInit>
  ): SupportEchoFailure => [
    `changed colorSpace.${name}`,
    (config) => ({
      supported: true,
      config: {
        ...config,
        colorSpace: { ...config.colorSpace, ...member }
      }
    })
  ];
  return [
    ["missing config", () => ({ supported: true })],
    omit("codec"),
    change("codec", { codec: "vp09.00.10.08.01.01.01.01.00" }),
    omit("codedWidth"),
    change("codedWidth", { codedWidth: 641 }),
    omit("codedHeight"),
    change("codedHeight", { codedHeight: 369 }),
    omit("displayAspectWidth"),
    change("displayAspectWidth", { displayAspectWidth: 641 }),
    omit("displayAspectHeight"),
    change("displayAspectHeight", { displayAspectHeight: 361 }),
    omit("colorSpace"),
    omitColor("primaries"),
    changeColor("primaries", { primaries: "bt470bg" }),
    omitColor("transfer"),
    changeColor("transfer", { transfer: "iec61966-2-1" }),
    omitColor("matrix"),
    changeColor("matrix", { matrix: "rgb" }),
    omitColor("fullRange"),
    changeColor("fullRange", { fullRange: true }),
    omit("hardwareAcceleration"),
    change("hardwareAcceleration", { hardwareAcceleration: "prefer-hardware" }),
    omit("optimizeForLatency"),
    change("optimizeForLatency", { optimizeForLatency: false })
  ];
}

function requestedDecoderConfig(): VideoDecoderConfig {
  return {
    codec: "avc1.42E01E",
    codedWidth: 640,
    codedHeight: 368,
    displayAspectWidth: 640,
    displayAspectHeight: 360,
    colorSpace: {
      primaries: "bt709",
      transfer: "bt709",
      matrix: "bt709",
      fullRange: false
    },
    hardwareAcceleration: "no-preference",
    optimizeForLatency: true
  };
}

function withoutOwnKey<Value extends object>(
  value: Value,
  key: keyof Value
): Partial<Value> {
  const clone = { ...value };
  Reflect.deleteProperty(clone, key);
  return clone;
}

function ifConfigured(): DecoderWorkerEvent {
  return { t: "configured", supported: true };
}
