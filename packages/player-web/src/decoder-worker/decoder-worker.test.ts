import { describe, expect, it } from "vitest";

import {
  DecoderWorkerClient,
  DecoderWorkerGenerationAbortedError,
  DecoderWorkerRemoteError,
  DecoderWorkerTransportError
} from "./client.js";
import {
  type WorkerEncodedVideoChunkFactory,
  type WorkerVideoDecoderAdapter,
  type WorkerVideoDecoderFactory
} from "./core.js";
import { DecoderWorkerHost } from "./host.js";
import {
  createDecoderWorkerClient,
  resolveDecoderWorkerEntryUrl
} from "./factory.js";
import {
  DECODER_WORKER_PROTOCOL_VERSION,
  type DecoderWorkerClientPort,
  type DecoderWorkerLimits,
  type DecoderWorkerMessagePort,
  type DecoderWorkerSample
} from "./protocol.js";

describe("dedicated decoder worker boundary", () => {
  it("creates and owns the packaged module-worker entry", async () => {
    const { clientPort, workerPort } = createPortPair();
    const host = new DecoderWorkerHost(workerPort, {
      decoderFactory: () => {
        throw new Error("decoder should not be constructed");
      },
      supportProbe: async (config) => ({ supported: true, config }),
      inspectorFactory: () => new FakeAvcInspector(undefined)
    });
    let observedUrl: URL | undefined;
    let observedOptions: WorkerOptions | undefined;
    const client = createDecoderWorkerClient({
      workerName: "rma-test-decoder",
      disposeTimeoutMs: 100,
      workerFactory: (url, options) => {
        observedUrl = url;
        observedOptions = options;
        return clientPort;
      }
    });
    expect(observedUrl?.href).toBe(resolveDecoderWorkerEntryUrl().href);
    expect(observedUrl?.pathname).toMatch(/decoder-worker\/entry\.ts$/u);
    expect(observedOptions).toEqual({
      type: "module",
      name: "rma-test-decoder"
    });
    await client.dispose();
    expect(clientPort.terminateCalls).toBe(1);
    host.detach();
  });

  it("terminates a module Worker when client construction fails", () => {
    const { clientPort } = createPortPair();
    expect(() =>
      createDecoderWorkerClient({
        disposeTimeoutMs: 0,
        workerFactory: () => clientPort
      })
    ).toThrow("disposeTimeoutMs");
    expect(clientPort.terminateCalls).toBe(1);
  });

  it("bounds every request and rejects an unexpected disposed event", async () => {
    const silent = createPortPair();
    const timed = new DecoderWorkerClient(silent.clientPort, {
      requestTimeoutMs: 5,
      disposeTimeoutMs: 20
    });
    await expect(timed.snapshotMetrics()).rejects.toMatchObject({
      name: "DecoderWorkerWatchdogError"
    });
    expect(silent.clientPort.terminateCalls).toBe(1);
    await timed.dispose();

    const unexpected = createPortPair();
    const client = new DecoderWorkerClient(unexpected.clientPort, {
      requestTimeoutMs: 100,
      disposeTimeoutMs: 20
    });
    const pending = client.snapshotMetrics();
    unexpected.workerPort.postMessage({
      type: "disposed",
      protocolVersion: DECODER_WORKER_PROTOCOL_VERSION,
      requestId: 1
    });
    await expect(pending).rejects.toBeInstanceOf(DecoderWorkerTransportError);
    expect(unexpected.clientPort.terminateCalls).toBe(1);
    await client.dispose();
  });

  it("closes queued frames that arrive after a fatal transport failure", async () => {
    const { clientPort } = createPortPair();
    const client = new DecoderWorkerClient(clientPort, {
      requestTimeoutMs: 100,
      disposeTimeoutMs: 20
    });
    const pending = client.snapshotMetrics();
    clientPort.emitMessage({
      type: "disposed",
      protocolVersion: DECODER_WORKER_PROTOCOL_VERSION,
      requestId: 1
    });
    await expect(pending).rejects.toBeInstanceOf(DecoderWorkerTransportError);

    const frame = {
      closeCalls: 0,
      close(): void {
        this.closeCalls += 1;
      }
    };
    clientPort.emitMessage({
      type: "frame",
      protocolVersion: DECODER_WORKER_PROTOCOL_VERSION,
      frameId: 1,
      generation: 1,
      ordinal: 0,
      unitId: "idle",
      unitInstance: 0,
      unitFrame: 0,
      timestamp: 0,
      duration: 1,
      decodedBytes: 16,
      frame
    });
    expect(frame.closeCalls).toBe(1);
    expect(client.openFrames).toBe(0);
    await client.dispose();
  });

  it("probes WebCodecs support before constructing the sole decoder", async () => {
    const fixture = createFixture({}, { supported: false });
    await expect(fixture.configure()).rejects.toMatchObject({
      code: "DECODER_CONFIGURE_FAILED",
      fatal: true
    });
    expect(fixture.clientPort.terminateCalls).toBe(1);
    await fixture.client.dispose();
    fixture.host.detach();
  });

  it("accepts standard browser defaults but configures the closed request", async () => {
    const fixture = createFixture({}, {
      supportConfig: (config) => ({
        ...config,
        flip: false,
        rotation: 0
      }) as VideoDecoderConfig
    });
    await fixture.configure();
    expect(fixture.decoder.configuredWith).toEqual({
      codec: "avc1.42E020",
      codedWidth: 2,
      codedHeight: 2,
      hardwareAcceleration: "no-preference",
      optimizeForLatency: true
    });
    await fixture.dispose();
  });

  it("rejects a support result that changes a requested configuration", async () => {
    const fixture = createFixture({}, {
      supportConfig: (config) => ({
        ...config,
        flip: true,
        rotation: 0
      }) as VideoDecoderConfig
    });
    await expect(fixture.configure()).rejects.toMatchObject({
      code: "DECODER_CONFIGURE_FAILED",
      fatal: true
    });
    expect(fixture.clientPort.terminateCalls).toBe(1);
    await fixture.client.dispose();
    fixture.host.detach();
  });

  it("rejects configured limits above the closed worker hard caps", async () => {
    const fixture = createFixture({ maxDecodeQueueSize: 13 });
    await expect(fixture.configure()).rejects.toMatchObject({
      code: "PROTOCOL_ERROR",
      fatal: true
    });
    expect(fixture.clientPort.terminateCalls).toBe(1);
    await fixture.client.dispose();
    fixture.host.detach();
  });

  it("treats unknown protocol fields as a fatal session error", async () => {
    const fixture = createFixture();
    await fixture.configure();
    fixture.clientPort.postMessage({
      type: "activate-generation",
      protocolVersion: DECODER_WORKER_PROTOCOL_VERSION,
      requestId: 2,
      generation: 1,
      unknown: true
    });
    await drainMessages();
    expect(fixture.decoder.closeCalls).toBe(1);
    expect(fixture.clientPort.terminateCalls).toBe(1);
    await fixture.dispose();
  });

  it("fails before WebCodecs when strict AVC inspection rejects a sample", async () => {
    const fixture = createFixture({}, { inspectorRejectTag: 0 });
    await fixture.configure();
    await fixture.client.activateGeneration(1);
    await expect(
      fixture.client.submit(1, createUnitSamples(0, 0, 1))
    ).rejects.toMatchObject({
      code: "DECODER_SUBMIT_FAILED",
      fatal: true
    });
    expect(fixture.decoder.pendingCount).toBe(0);
    expect(fixture.decoder.closeCalls).toBe(1);
    await fixture.dispose();
  });

  it("keeps one decoder configuration and performs no boundary flush or reset", async () => {
    const fixture = createFixture({ maxOutstandingFrames: 4 });
    await fixture.configure();
    await fixture.client.activateGeneration(1);
    await fixture.client.submit(1, createUnitSamples(0, 0, 2));
    const first = fixture.decoder.emitNext();
    const second = fixture.decoder.emitNext();
    await fixture.client.waitForFrames(2, { timeoutMs: 100 });
    const managedFirst = fixture.client.takeFrame();
    const managedSecond = fixture.client.takeFrame();
    expect(managedFirst).toMatchObject({
      generation: 1,
      ordinal: 0,
      unitFrame: 0
    });
    expect(managedSecond).toMatchObject({
      generation: 1,
      ordinal: 1,
      unitFrame: 1
    });
    managedFirst?.close();
    managedSecond?.close();
    await drainMessages();
    await fixture.client.activateGeneration(2);
    await fixture.client.submit(2, createUnitSamples(2, 1, 2));
    const third = fixture.decoder.emitNext();
    const fourth = fixture.decoder.emitNext();
    await fixture.client.waitForFrames(2, { timeoutMs: 100 });
    fixture.client.takeFrame()?.close();
    fixture.client.takeFrame()?.close();
    await drainMessages();
    const metrics = await fixture.client.snapshotMetrics();
    expect(metrics).toMatchObject({
      configureCalls: 1,
      resetCalls: 0,
      flushCalls: 0,
      boundaryFlushCalls: 0,
      acceptedSamples: 4,
      submittedChunks: 4,
      outputFrames: 4,
      deliveredFrames: 4,
      releasedFrames: 4,
      staleFrames: 0,
      leasedFrames: 0,
      leasedDecodedBytes: 0,
      errors: 0
    });
    expect(fixture.decoder).toMatchObject({
      configureCalls: 1,
      resetCalls: 0,
      flushCalls: 0,
      closeCalls: 0
    });
    expect([first, second, third, fourth].map((frame) => frame.closeCalls)).toEqual([
      1,
      1,
      1,
      1
    ]);

    await fixture.dispose();
    expect(fixture.decoder.closeCalls).toBe(1);
  });

  it("closes stale outputs and drains a new generation without codec boundary operations", async () => {
    const fixture = createFixture({
      maxDecodeQueueSize: 1,
      maxOutstandingFrames: 4
    });
    await fixture.configure();
    await fixture.client.activateGeneration(1);
    await fixture.client.submit(1, createUnitSamples(0, 0, 4));
    expect(fixture.decoder.pendingCount).toBe(1);
    await fixture.client.activateGeneration(2);
    await fixture.client.submit(2, createUnitSamples(4, 0, 2));
    expect(fixture.decoder.pendingCount).toBe(1);
    const staleZero = fixture.decoder.emitNext();
    expect(staleZero.closeCalls).toBe(1);
    expect(fixture.decoder.pendingOrdinals).toEqual([4]);
    const currentZero = fixture.decoder.emitNext();
    expect(fixture.decoder.pendingOrdinals).toEqual([5]);
    const currentOne = fixture.decoder.emitNext();
    await fixture.client.waitForFrames(2, { timeoutMs: 100 });
    expect(fixture.client.takeFrame()?.ordinal).toBe(4);
    expect(fixture.client.takeFrame()?.ordinal).toBe(5);
    expect(currentZero.closeCalls).toBe(0);
    expect(currentOne.closeCalls).toBe(0);
    await fixture.client.abortGeneration(2);
    expect(currentZero.closeCalls).toBe(1);
    expect(currentOne.closeCalls).toBe(1);
    await drainMessages();
    const metrics = await fixture.client.snapshotMetrics();
    expect(metrics).toMatchObject({
      activeGeneration: null,
      staleFrames: 1,
      deliveredFrames: 2,
      releasedFrames: 2,
      resetCalls: 0,
      flushCalls: 0,
      boundaryFlushCalls: 0
    });
    expect(fixture.decoder).toMatchObject({
      configureCalls: 1,
      resetCalls: 0,
      flushCalls: 0
    });

    await fixture.dispose();
  });

  it("holds input credits until transferred frames are explicitly closed", async () => {
    const fixture = createFixture({
      maxDecodeQueueSize: 4,
      maxOutstandingFrames: 2
    });
    await fixture.configure();
    await fixture.client.activateGeneration(1);
    await fixture.client.submit(1, createUnitSamples(0, 0, 2));
    expect(fixture.decoder.pendingOrdinals).toEqual([0, 1]);

    fixture.decoder.emitNext();
    fixture.decoder.emitNext();
    await fixture.client.waitForFrames(2, { timeoutMs: 100 });
    expect(fixture.decoder.pendingCount).toBe(0);

    const first = fixture.client.takeFrame();
    const second = fixture.client.takeFrame();
    const submitPostsBeforeRejection = fixture.clientPort.postedTypes.filter(
      (type) => type === "submit"
    ).length;
    await expect(
      fixture.client.submit(1, createUnitSamples(2, 1, 2))
    ).rejects.toMatchObject({ code: "BACKPRESSURE_LIMIT" });
    expect(
      fixture.clientPort.postedTypes.filter((type) => type === "submit").length
    ).toBe(submitPostsBeforeRejection);
    first?.close();
    await drainMessages();
    await fixture.client.submit(1, createUnitSamples(2, 1, 1));
    expect(fixture.decoder.pendingOrdinals).toEqual([2]);

    second?.close();
    await drainMessages();
    await fixture.client.submit(1, createUnitSamples(3, 2, 1));
    expect(fixture.decoder.pendingOrdinals).toEqual([2, 3]);

    fixture.decoder.emitNext();
    fixture.decoder.emitNext();
    await fixture.client.waitForFrames(2, { timeoutMs: 100 });
    fixture.client.takeFrame()?.close();
    fixture.client.takeFrame()?.close();
    await drainMessages();
    const metrics = await fixture.client.snapshotMetrics();
    expect(metrics).toMatchObject({
      submittedChunks: 4,
      deliveredFrames: 4,
      releasedFrames: 4,
      leasedFrames: 0,
      pendingSamples: 0
    });

    await fixture.dispose();
  });

  it("pumps pending input when WebCodecs dequeues before producing output", async () => {
    const fixture = createFixture({
      maxDecodeQueueSize: 1,
      maxOutstandingFrames: 4
    });
    await fixture.configure();
    await fixture.client.activateGeneration(1);
    await fixture.client.submit(1, createUnitSamples(0, 0, 3));
    expect(fixture.decoder.pendingOrdinals).toEqual([0]);

    fixture.decoder.dequeueOneWithoutOutput();
    expect(fixture.decoder.pendingOrdinals).toEqual([1]);
    fixture.decoder.dequeueOneWithoutOutput();
    expect(fixture.decoder.pendingOrdinals).toEqual([2]);

    fixture.decoder.emitNext();
    fixture.decoder.emitNext();
    fixture.decoder.emitNext();
    await fixture.client.waitForFrames(3, { timeoutMs: 100 });
    fixture.client.takeFrame()?.close();
    fixture.client.takeFrame()?.close();
    fixture.client.takeFrame()?.close();
    await drainMessages();
    expect(await fixture.client.snapshotMetrics()).toMatchObject({
      submittedChunks: 3,
      outputFrames: 3,
      pendingSamples: 0,
      submittedFrames: 0,
      errors: 0
    });
    await fixture.dispose();
  });

  it("rejects detached and oversized sample buffers before posting submit", async () => {
    const fixture = createFixture();
    await fixture.configure();
    await fixture.client.activateGeneration(1);
    const submitsBefore = fixture.clientPort.postedTypes.filter(
      (type) => type === "submit"
    ).length;

    const detachedLike = createUnitSamples(0, 0, 1);
    const first = detachedLike[0];
    if (first === undefined) {
      throw new Error("sample fixture is missing");
    }
    await expect(
      fixture.client.submit(1, [{ ...first, data: new ArrayBuffer(0) }])
    ).rejects.toThrow("worker cap");
    const oversized = createUnitSamples(0, 0, 1);
    const oversizedFirst = oversized[0];
    if (oversizedFirst === undefined) {
      throw new Error("sample fixture is missing");
    }
    await expect(
      fixture.client.submit(1, [
        { ...oversizedFirst, data: new ArrayBuffer(2 * 1024 * 1024 + 1) }
      ])
    ).rejects.toThrow("worker cap");
    expect(
      fixture.clientPort.postedTypes.filter((type) => type === "submit").length
    ).toBe(submitsBefore);

    await fixture.dispose();
  });

  it("closes every owned frame and rejects waiters after invalid decoder output", async () => {
    const fixture = createFixture({ maxOutstandingFrames: 2 });
    await fixture.configure();
    await fixture.client.activateGeneration(1);
    await fixture.client.submit(1, createUnitSamples(0, 0, 2));
    const waiting = fixture.client.waitForFrames(2, { timeoutMs: 100 });

    const valid = fixture.decoder.emitNext();
    await drainMessages();
    expect(fixture.client.openFrames).toBe(1);
    const invalid = fixture.decoder.emitNext({ codedWidth: 3, displayWidth: 3 });

    await expect(waiting).rejects.toBeInstanceOf(DecoderWorkerRemoteError);
    expect(valid.closeCalls).toBe(1);
    expect(invalid.closeCalls).toBe(1);
    expect(fixture.client.openFrames).toBe(0);
    expect(fixture.decoder.closeCalls).toBe(1);
    expect(fixture.clientPort.terminateCalls).toBe(1);

    await fixture.dispose();
  });

  it("accepts bounded decoder-surface padding and accounts its actual RGBA size", async () => {
    const fixture = createFixture({
      maxOutstandingFrames: 1,
      maxDecodedBytes: 24
    });
    await fixture.configure();
    await fixture.client.activateGeneration(1);
    await fixture.client.submit(1, createUnitSamples(0, 0, 1));
    fixture.decoder.emitNext({ codedWidth: 3, displayWidth: 2 });
    await fixture.client.waitForFrames(1, { timeoutMs: 100 });
    expect(await fixture.client.snapshotMetrics()).toMatchObject({
      leasedFrames: 1,
      leasedDecodedBytes: 24
    });
    fixture.client.takeFrame()?.close();
    await drainMessages();
    await fixture.dispose();
  });

  it("closes over-budget decoded output before it crosses the worker boundary", async () => {
    const fixture = createFixture({
      maxOutstandingFrames: 1,
      maxDecodedBytes: 8
    });
    await fixture.configure();
    await fixture.client.activateGeneration(1);
    await fixture.client.submit(1, createUnitSamples(0, 0, 1));
    const waiting = fixture.client.waitForFrames(1, { timeoutMs: 100 });

    const frame = fixture.decoder.emitNext();
    await expect(waiting).rejects.toMatchObject({
      code: "DECODED_BYTE_BUDGET_EXCEEDED",
      fatal: true
    });
    expect(frame.closeCalls).toBe(1);
    expect(fixture.client.openFrames).toBe(0);
    expect(fixture.decoder.closeCalls).toBe(1);

    await fixture.dispose();
  });

  it("rejects reordered output for the no-B-frame AVC profile", async () => {
    const fixture = createFixture({ maxOutstandingFrames: 2 });
    await fixture.configure();
    await fixture.client.activateGeneration(1);
    await fixture.client.submit(1, createUnitSamples(0, 0, 2));
    const waiting = fixture.client.waitForFrames(1, { timeoutMs: 100 });

    const reordered = fixture.decoder.emitAt(1);
    await expect(waiting).rejects.toMatchObject({
      code: "DECODER_OUTPUT_INVALID",
      fatal: true
    });
    expect(reordered.closeCalls).toBe(1);
    const late = fixture.decoder.emitNext();
    expect(late.closeCalls).toBe(1);
    expect(fixture.decoder.closeCalls).toBe(1);

    await fixture.dispose();
  });

  it("fails closed on a contradictory full-range output color space", async () => {
    const fixture = createFixture({ maxOutstandingFrames: 1 });
    await fixture.configure();
    await fixture.client.activateGeneration(1);
    await fixture.client.submit(1, createUnitSamples(0, 0, 1));
    const waiting = fixture.client.waitForFrames(1, { timeoutMs: 100 });

    const frame = fixture.decoder.emitNext({
      codedWidth: 2,
      displayWidth: 2,
      fullRange: true
    });
    await expect(waiting).rejects.toMatchObject({
      code: "DECODER_OUTPUT_INVALID",
      fatal: true
    });
    expect(frame.closeCalls).toBe(1);
    expect(fixture.decoder.closeCalls).toBe(1);

    await fixture.dispose();
  });

  it("closes the decoder when decode() throws and settles the client failure", async () => {
    const fixture = createFixture({}, { decoderRejectTag: 0 });
    await fixture.configure();
    await fixture.client.activateGeneration(1);
    await fixture.client.submit(1, createUnitSamples(0, 0, 1)).catch(() => undefined);
    await drainMessages();

    await expect(
      fixture.client.waitForFrames(1, { timeoutMs: 100 })
    ).rejects.toMatchObject({
      code: "DECODER_SUBMIT_FAILED",
      fatal: true
    });
    expect(fixture.decoder.closeCalls).toBe(1);
    expect(fixture.client.openFrames).toBe(0);
    await fixture.dispose();
  });

  it("settles pending waits on an asynchronous decoder error", async () => {
    const fixture = createFixture({ maxOutstandingFrames: 1 });
    await fixture.configure();
    await fixture.client.activateGeneration(1);
    await fixture.client.submit(1, createUnitSamples(0, 0, 1));
    const waiting = fixture.client.waitForFrames(1, { timeoutMs: 100 });

    fixture.decoder.fail(new DOMException("synthetic decoder error", "EncodingError"));
    await expect(waiting).rejects.toMatchObject({
      code: "DECODER_OUTPUT_INVALID",
      fatal: true
    });
    expect(fixture.decoder.closeCalls).toBe(1);
    await fixture.dispose();
  });

  it("treats double release as fatal ownership corruption", async () => {
    const fixture = createFixture({ maxOutstandingFrames: 1 });
    await fixture.configure();
    await fixture.client.activateGeneration(1);
    await fixture.client.submit(1, createUnitSamples(0, 0, 1));
    fixture.decoder.emitNext();
    await fixture.client.waitForFrames(1, { timeoutMs: 100 });
    const frame = fixture.client.takeFrame();
    frame?.close();
    await drainMessages();

    fixture.clientPort.postMessage({
      type: "release-frame",
      protocolVersion: DECODER_WORKER_PROTOCOL_VERSION,
      frameId: frame?.frameId ?? 1
    });
    await drainMessages();
    expect(fixture.decoder.closeCalls).toBe(1);
    expect(fixture.clientPort.terminateCalls).toBe(1);
    await fixture.dispose();
  });

  it("closes a frame exactly once when transferable delivery fails", async () => {
    const fixture = createFixture({ maxOutstandingFrames: 1 });
    await fixture.configure();
    await fixture.client.activateGeneration(1);
    await fixture.client.submit(1, createUnitSamples(0, 0, 1));
    const waiting = fixture.client.waitForFrames(1, { timeoutMs: 100 });
    fixture.workerPort.failNextFrameTransfer();

    const frame = fixture.decoder.emitNext();
    await expect(waiting).rejects.toMatchObject({
      code: "TRANSPORT_FAILED",
      fatal: true
    });
    expect(frame.closeCalls).toBe(1);
    expect(fixture.decoder.closeCalls).toBe(1);
    expect(fixture.client.openFrames).toBe(0);

    await fixture.dispose();
  });

  it("clears all core state when a non-frame transport post fails", async () => {
    const fixture = createFixture({ maxOutstandingFrames: 1 });
    fixture.workerPort.failNextPost("ack");
    await expect(fixture.configure()).rejects.toMatchObject({
      code: "TRANSPORT_FAILED",
      fatal: true
    });
    expect(fixture.host.core.snapshotMetrics()).toMatchObject({
      activeGeneration: null,
      pendingSamples: 0,
      submittedFrames: 0,
      leasedFrames: 0,
      errors: 1
    });
    expect(fixture.decoder.closeCalls).toBe(1);
    await fixture.dispose();
  });

  it("supports abortable waits and generation abort without leaking frames", async () => {
    const fixture = createFixture({ maxOutstandingFrames: 2 });
    await fixture.configure();
    await fixture.client.activateGeneration(1);
    await fixture.client.submit(1, createUnitSamples(0, 0, 2));

    const controller = new AbortController();
    const abortedWait = fixture.client.waitForFrames(1, {
      signal: controller.signal,
      timeoutMs: 100
    });
    controller.abort(new Error("synthetic abort"));
    await expect(abortedWait).rejects.toThrow("synthetic abort");

    const first = fixture.decoder.emitNext();
    await fixture.client.waitForFrames(1, { timeoutMs: 100 });
    const generationWait = fixture.client.waitForFrames(2, { timeoutMs: 100 });
    await fixture.client.abortGeneration(1);
    await expect(generationWait).rejects.toBeInstanceOf(
      DecoderWorkerGenerationAbortedError
    );
    expect(first.closeCalls).toBe(1);

    const late = fixture.decoder.emitNext();
    expect(late.closeCalls).toBe(1);
    await drainMessages();
    expect(fixture.client.openFrames).toBe(0);

    await fixture.dispose();
  });

  it("times out a wait without flushing, resetting, or closing the decoder", async () => {
    const fixture = createFixture({ maxOutstandingFrames: 1 });
    await fixture.configure();
    await fixture.client.activateGeneration(1);
    await fixture.client.submit(1, createUnitSamples(0, 0, 1));

    await expect(
      fixture.client.waitForFrames(1, { timeoutMs: 5 })
    ).rejects.toMatchObject({
      name: "DecoderWorkerWatchdogError"
    });
    expect(fixture.decoder.closeCalls).toBe(0);
    expect(fixture.decoder.flushCalls).toBe(0);
    expect(fixture.decoder.resetCalls).toBe(0);
    expect(fixture.client.openFrames).toBe(0);

    await fixture.dispose();
  });

  it("disposal closes client frames, rejects pending waits, and is idempotent", async () => {
    const fixture = createFixture({ maxOutstandingFrames: 2 });
    await fixture.configure();
    await fixture.client.activateGeneration(1);
    await fixture.client.submit(1, createUnitSamples(0, 0, 2));
    const frame = fixture.decoder.emitNext();
    await fixture.client.waitForFrames(1, { timeoutMs: 100 });
    const waiting = fixture.client.waitForFrames(2, { timeoutMs: 1_000 });

    const firstDispose = fixture.client.dispose();
    const secondDispose = fixture.client.dispose();
    expect(firstDispose).toBe(secondDispose);
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    await firstDispose;

    expect(frame.closeCalls).toBe(1);
    expect(fixture.client.openFrames).toBe(0);
    expect(fixture.decoder.closeCalls).toBe(1);
    expect(fixture.decoder.flushCalls).toBe(0);
    expect(fixture.decoder.resetCalls).toBe(0);
    expect(fixture.clientPort.terminateCalls).toBe(1);
    fixture.host.detach();
  });

  it("serializes disposal behind an in-flight support probe and aborts the caller", async () => {
    let releaseProbe: (() => void) | undefined;
    const supportGate = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    const fixture = createFixture({}, { supportGate });
    const configuring = fixture.configure();
    await drainMessages();

    const disposing = fixture.client.dispose();
    await expect(configuring).rejects.toMatchObject({ name: "AbortError" });
    releaseProbe?.();
    await disposing;

    expect(fixture.decoder.configureCalls).toBe(1);
    expect(fixture.decoder.closeCalls).toBe(1);
    expect(fixture.clientPort.terminateCalls).toBe(1);
    fixture.host.detach();
  });
});

interface Fixture {
  readonly client: DecoderWorkerClient;
  readonly clientPort: FakeDuplexPort;
  readonly workerPort: FakeDuplexPort;
  readonly host: DecoderWorkerHost;
  readonly decoder: FakeVideoDecoder;
  configure(): Promise<void>;
  dispose(): Promise<void>;
}

function createFixture(
  overrides: Partial<DecoderWorkerLimits> = {},
  options: {
    readonly supported?: boolean;
    readonly supportGate?: Promise<void>;
    readonly inspectorRejectTag?: number;
    readonly decoderRejectTag?: number;
    readonly supportConfig?: (
      config: VideoDecoderConfig
    ) => VideoDecoderConfig;
  } = {}
): Fixture {
  const { clientPort, workerPort } = createPortPair();
  let decoder: FakeVideoDecoder | undefined;
  const decoderFactory: WorkerVideoDecoderFactory = (init) => {
    decoder = new FakeVideoDecoder(init, options.decoderRejectTag);
    return decoder;
  };
  const chunkFactory: WorkerEncodedVideoChunkFactory = (init) =>
    new FakeEncodedVideoChunk(init) as unknown as EncodedVideoChunk;
  const host = new DecoderWorkerHost(workerPort, {
    decoderFactory,
    chunkFactory,
    supportProbe: async (config) => {
      await options.supportGate;
      return {
        supported: options.supported ?? true,
        config: options.supportConfig?.(config) ?? config
      };
    },
    inspectorFactory: () => new FakeAvcInspector(options.inspectorRejectTag)
  });
  const client = new DecoderWorkerClient(clientPort, { disposeTimeoutMs: 100 });
  const limits: DecoderWorkerLimits = {
    maxDecodeQueueSize: 4,
    maxPendingSamples: 16,
    maxOutstandingFrames: 4,
    maxDecodedBytes: 1_024,
    ...overrides
  };

  return {
    client,
    clientPort,
    workerPort,
    host,
    get decoder(): FakeVideoDecoder {
      if (decoder === undefined) {
        throw new Error("fake decoder has not been configured");
      }
      return decoder;
    },
    configure: () =>
      client.configure({
        config: {
          codec: "avc1.42E020",
          codedWidth: 2,
          codedHeight: 2,
          hardwareAcceleration: "no-preference",
          optimizeForLatency: true
        },
        avcProfile: {
          codedWidth: 2,
          codedHeight: 2,
          frameRate: { numerator: 60, denominator: 1 },
          averageBitrate: 100_000,
          peakBitrate: 200_000,
          cpbBufferBits: 200_000,
          requireBt709LimitedRange: true
        },
        expectedOutput: {
          codedWidth: 2,
          codedHeight: 2,
          displayWidth: 2,
          displayHeight: 2,
          visibleRect: { x: 0, y: 0, width: 2, height: 2 },
          colorSpace: null
        },
        limits
      }),
    dispose: async () => {
      await client.dispose();
      host.detach();
    }
  };
}

function createUnitSamples(
  firstOrdinal: number,
  unitInstance: number,
  count: number
): DecoderWorkerSample[] {
  return Array.from({ length: count }, (_unused, index) => ({
    ordinal: firstOrdinal + index,
    unitId: `unit-${String(unitInstance)}`,
    unitInstance,
    unitFrame: index,
    unitFrameCount: count,
    type: index === 0 ? "key" : "delta",
    timestamp: (firstOrdinal + index) * 16_667,
    duration: 16_667,
    data: new Uint8Array([firstOrdinal + index]).buffer
  }));
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

class FakeAvcInspector {
  readonly #rejectTag: number | undefined;

  public constructor(rejectTag: number | undefined) {
    this.#rejectTag = rejectTag;
  }

  public inspect(input: {
    readonly key: boolean;
    readonly bytes: Uint8Array;
  }): {
    readonly chunkType: EncodedVideoChunkType;
  } {
    if (input.bytes[0] === this.#rejectTag) {
      throw new Error("synthetic AVC rejection");
    }
    return { chunkType: input.key ? "key" : "delta" };
  }

  public resetUnitSequence(): void {}
}

class FakeVideoFrame {
  public readonly timestamp: number;
  public readonly duration: number | null;
  public readonly codedWidth: number;
  public readonly codedHeight: number;
  public readonly displayWidth: number;
  public readonly displayHeight: number;
  public readonly visibleRect = { x: 0, y: 0, width: 2, height: 2 };
  public readonly colorSpace: {
    readonly fullRange: boolean | null;
    readonly matrix: null;
    readonly primaries: null;
    readonly transfer: null;
  };
  public closeCalls = 0;

  public constructor(
    chunk: FakeEncodedVideoChunk,
    geometry: {
      readonly codedWidth: number;
      readonly displayWidth: number;
      readonly fullRange?: boolean;
    }
  ) {
    this.timestamp = chunk.timestamp;
    this.duration = chunk.duration;
    this.codedWidth = geometry.codedWidth;
    this.codedHeight = 2;
    this.displayWidth = geometry.displayWidth;
    this.displayHeight = 2;
    this.colorSpace = {
      fullRange: geometry.fullRange ?? null,
      matrix: null,
      primaries: null,
      transfer: null
    };
  }

  public close(): void {
    this.closeCalls += 1;
    if (this.closeCalls > 1) {
      throw new Error("fake VideoFrame closed more than once");
    }
  }
}

class FakeVideoDecoder implements WorkerVideoDecoderAdapter {
  public decodeQueueSize = 0;
  public configureCalls = 0;
  public resetCalls = 0;
  public flushCalls = 0;
  public closeCalls = 0;
  public configuredWith: VideoDecoderConfig | null = null;
  #dequeueCallback: (() => void) | undefined;
  readonly #init: VideoDecoderInit;
  readonly #rejectTag: number | undefined;
  readonly #pending: FakeEncodedVideoChunk[] = [];
  readonly #buffered: FakeEncodedVideoChunk[] = [];

  public constructor(init: VideoDecoderInit, rejectTag: number | undefined) {
    this.#init = init;
    this.#rejectTag = rejectTag;
  }

  public get pendingCount(): number {
    return this.#pending.length;
  }

  public get pendingOrdinals(): number[] {
    return this.#pending.map((chunk) => chunk.data[0] ?? -1);
  }

  public configure(config: VideoDecoderConfig): void {
    this.configureCalls += 1;
    this.configuredWith = { ...config };
  }

  public setDequeueCallback(callback: () => void): void {
    this.#dequeueCallback = callback;
  }

  public decode(chunk: EncodedVideoChunk): void {
    const fake = chunk as unknown as FakeEncodedVideoChunk;
    if (fake.data[0] === this.#rejectTag) {
      throw new DOMException("synthetic quota", "QuotaExceededError");
    }
    this.#pending.push(fake);
    this.decodeQueueSize = this.#pending.length;
  }

  public close(): void {
    this.closeCalls += 1;
    this.#dequeueCallback = undefined;
  }

  public dequeueOneWithoutOutput(): void {
    const chunk = this.#pending.shift();
    if (chunk === undefined) {
      throw new Error("fake decoder has no queued input");
    }
    this.#buffered.push(chunk);
    this.decodeQueueSize = this.#pending.length;
    this.#dequeueCallback?.();
  }

  public emitNext(
    geometry: {
      readonly codedWidth: number;
      readonly displayWidth: number;
      readonly fullRange?: boolean;
    } = {
      codedWidth: 2,
      displayWidth: 2
    }
  ): FakeVideoFrame {
    const chunk = this.#buffered.shift() ?? this.#pending.shift();
    if (chunk === undefined) {
      throw new Error("fake decoder has no pending chunk");
    }
    this.decodeQueueSize = this.#pending.length;
    const frame = new FakeVideoFrame(chunk, geometry);
    this.#init.output(frame as unknown as VideoFrame);
    return frame;
  }

  public emitAt(index: number): FakeVideoFrame {
    const [chunk] = this.#pending.splice(index, 1);
    if (chunk === undefined) {
      throw new Error("fake decoder has no chunk at that index");
    }
    this.decodeQueueSize = this.#pending.length;
    const frame = new FakeVideoFrame(chunk, {
      codedWidth: 2,
      displayWidth: 2
    });
    this.#init.output(frame as unknown as VideoFrame);
    return frame;
  }

  public fail(error: DOMException): void {
    this.#init.error(error);
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
  #failNextFrame = false;
  #failNextType: string | null = null;
  public terminateCalls = 0;
  public readonly postedTypes: string[] = [];

  public connect(peer: FakeDuplexPort): void {
    this.#peer = peer;
  }

  public postMessage(message: unknown, _transfer?: Transferable[]): void {
    if (this.#terminated || this.#peer === null) {
      throw new Error("fake worker port is terminated");
    }
    this.postedTypes.push(
      typeof message === "object" &&
        message !== null &&
        typeof (message as { readonly type?: unknown }).type === "string"
        ? ((message as { readonly type: string }).type)
        : "unknown"
    );
    if (
      (this.#failNextFrame || this.#failNextType !== null) &&
      typeof message === "object" &&
      message !== null &&
      (message as { readonly type?: unknown }).type ===
        (this.#failNextType ?? "frame")
    ) {
      this.#failNextFrame = false;
      this.#failNextType = null;
      throw new Error("synthetic transferable failure");
    }
    const peer = this.#peer;
    queueMicrotask(() => {
      if (peer.#terminated) {
        return;
      }
      const event = { data: message } as MessageEvent<unknown>;
      for (const listener of [...peer.#messageListeners]) {
        listener(event);
      }
    });
  }

  public addEventListener(
    type: "message",
    listener: (event: MessageEvent<unknown>) => void
  ): void;
  public addEventListener(
    type: "error",
    listener: (event: ErrorEvent) => void
  ): void;
  public addEventListener(
    type: "messageerror",
    listener: (event: MessageEvent<unknown>) => void
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
    type: "error",
    listener: (event: ErrorEvent) => void
  ): void;
  public removeEventListener(
    type: "messageerror",
    listener: (event: MessageEvent<unknown>) => void
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
    if (this.#terminated) {
      return;
    }
    this.#terminated = true;
    const peer = this.#peer;
    if (peer !== null) {
      peer.#terminateFromPeer();
    }
    this.terminateCalls += 1;
  }

  public failNextFrameTransfer(): void {
    this.#failNextFrame = true;
  }

  public failNextPost(type: string): void {
    this.#failNextType = type;
  }

  /** Simulate a task already queued by the browser before terminate(). */
  public emitMessage(message: unknown): void {
    const event = { data: message } as MessageEvent<unknown>;
    for (const listener of [...this.#messageListeners]) listener(event);
  }

  #terminateFromPeer(): void {
    this.#terminated = true;
  }
}

async function drainMessages(turns = 8): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    await Promise.resolve();
  }
}
