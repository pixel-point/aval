import { afterEach, describe, expect, it, vi } from "vitest";
import { AvalPlaybackError } from "../src/errors.js";
import {
  createRendererFailureDiagnostic,
  RendererFailureError,
  type RendererFailureDiagnostic
} from "../src/renderer-diagnostics.js";
import type { RendererContextChange } from "../src/renderer.js";
import type { PlayerRendererDiagnostic } from "../src/player-contract.js";

const media = vi.hoisted(() => ({
  runs: [] as Array<{
    id: number;
    lane: number;
    label: number;
    closed: boolean;
    ready: boolean;
    taken: number[];
  }>,
  blocked: new Set<number>(),
  releaseBlocked: [] as Array<{ runId: number; release: () => void }>,
  operations: [] as string[],
  decoderCount: 0,
  assetDisposeCalls: 0,
  assetDisposeFailures: 0,
  assetDisposeHold: null as Promise<void> | null,
  assetDisposeReached: null as (() => void) | null,
  rendererDisposeCalls: 0,
  rendererSettlementHold: null as Promise<void> | null,
  rendererSettlementReached: null as (() => void) | null,
  rendererContextChange: null as
    ((change: Readonly<RendererContextChange>) => void) | null,
  rendererFailureError: null as RendererFailureError | null,
  rendererConstructionFailureError: null as RendererFailureError | null,
  rendererDiagnostic: null as Readonly<RendererFailureDiagnostic> | null,
  rendererBackend: "webgl2" as "webgl2" | "canvas2d",
  decoderFailures: [] as Array<{
    promise: Promise<never>;
    reject: (reason: unknown) => void;
  }>,
  decoderDiagnostics: [] as unknown[]
}));

vi.mock("../src/asset.js", () => {
  const units = [
    body("idle-body", 0, 24),
    { id: "idle-intro", kind: "one-shot", frameCount: 2, chunks: [span(1, 2)] },
    body("hover-body", 2, 16),
    { id: "idle-hover", kind: "bridge", frameCount: 16, chunks: [span(3, 16)] },
    body("other-body", 4, 16),
    { id: "idle-other", kind: "bridge", frameCount: 16, chunks: [span(5, 16)] },
    body("later-body", 6, 16),
    { id: "idle-later", kind: "bridge", frameCount: 16, chunks: [span(7, 16)] },
    body("last-body", 8, 16),
    { id: "idle-last", kind: "bridge", frameCount: 16, chunks: [span(9, 16)] }
  ];
  const records = units.map((unit, index) => ({
    offset: 1_000 + index,
    length: 1,
    presentationTimestamp: index * 100,
    duration: 1,
    randomAccess: true,
    displayedFrameCount: unit.frameCount
  }));
  const blobs = units.map((unit, index) => ({
    rendition: "main",
    unit: unit.id,
    offset: 1_000 + index,
    length: 1,
    chunkStart: index,
    chunkCount: 1
  }));
  class Asset {
    public readonly manifest = {
      formatVersion: "1.1",
      generator: "player-prefetch-test",
      codec: "h264",
      bitstream: "annex-b",
      layout: "opaque",
      canvas: {
        width: 16,
        height: 16,
        fit: "contain",
        pixelAspect: [1, 1],
        colorSpace: "srgb"
      },
      frameRate: { numerator: 30, denominator: 1 },
      renditions: [{
        id: "main",
        codec: "avc1.640020",
        bitDepth: 8,
        codedWidth: 16,
        codedHeight: 16,
        bitrate: { average: 1_000, peak: 1_000 },
        alphaLayout: { type: "opaque", colorRect: [0, 0, 16, 16] }
      }],
      units,
      initialState: "idle",
      states: [
        { id: "idle", bodyUnit: "idle-body", initialUnit: "idle-intro" },
        { id: "hover", bodyUnit: "hover-body" },
        { id: "other", bodyUnit: "other-body" },
        { id: "later", bodyUnit: "later-body" },
        { id: "last", bodyUnit: "last-body" }
      ],
      edges: [
        {
          id: "idle-hover-edge",
          from: "idle",
          to: "hover",
          start: {
            type: "portal",
            sourcePort: "later",
            targetPort: "entry",
            maxWaitFrames: 24
          },
          transition: { kind: "locked", unit: "idle-hover" },
          trigger: { type: "event", name: "hover" },
          continuity: "exact-authored"
        },
        {
          id: "idle-other-edge",
          from: "idle",
          to: "other",
          start: {
            type: "portal",
            sourcePort: "entry",
            targetPort: "entry",
            maxWaitFrames: 24
          },
          transition: { kind: "locked", unit: "idle-other" },
          trigger: { type: "event", name: "other" },
          continuity: "exact-authored"
        },
        {
          id: "idle-later-edge",
          from: "idle",
          to: "later",
          start: {
            type: "portal",
            sourcePort: "later",
            targetPort: "entry",
            maxWaitFrames: 24
          },
          transition: { kind: "locked", unit: "idle-later" },
          trigger: { type: "event", name: "later" },
          continuity: "exact-authored"
        },
        {
          id: "idle-last-edge",
          from: "idle",
          to: "last",
          start: {
            type: "portal",
            sourcePort: "last",
            targetPort: "entry",
            maxWaitFrames: 24
          },
          transition: { kind: "locked", unit: "idle-last" },
          trigger: { type: "event", name: "last" },
          continuity: "exact-authored"
        }
      ],
      bindings: [],
      readiness: {
        policy: "all-routes",
        bootstrapUnits: units.map(({ id }) => id),
        immediateEdges: [
          "idle-hover-edge",
          "idle-last-edge",
          "idle-later-edge",
          "idle-other-edge"
        ]
      },
      limits: {
        maxCompiledBytes: 16_000_000,
        maxRuntimeBytes: 16_000_000,
        decodedPixelBytes: 2_048,
        persistentCacheBytes: 0,
        runtimeWorkingSetBytes: 1_000_000
      }
    };
    public readonly blobs = blobs;
    public readonly records = records;
    public async unitBytes(): Promise<Uint8Array<ArrayBuffer>> {
      return new Uint8Array(1);
    }
    public chunkBytes(_rendition: string, unit: string): ArrayBuffer {
      const index = units.findIndex(({ id }) => id === unit);
      return new Uint8Array([index]).buffer;
    }
    public async dispose(): Promise<void> {
      media.assetDisposeCalls += 1;
      media.assetDisposeReached?.();
      if (media.assetDisposeHold !== null) await media.assetDisposeHold;
      if (media.assetDisposeFailures > 0) {
        media.assetDisposeFailures -= 1;
        throw new Error("synthetic asset cleanup failure");
      }
    }
    public snapshot() {
      return {
        mode: "range",
        disposed: false,
        declaredFileBytes: 2_000,
        metadataBytes: 1_000,
        verifiedBytes: 4,
        residentBlobBytes: 4,
        activeTransportBodies: 0,
        pendingLoads: 0,
        interestedWaiters: 0
      };
    }
  }
  return { Asset: class { public static async open() { return new Asset(); } } };

  function span(chunkStart: number, frameCount: number) {
    return {
      rendition: "main",
      chunkStart,
      chunkCount: 1,
      frameCount,
      sha256: "0".repeat(64)
    };
  }
  function body(id: string, chunkStart = 0, frameCount = 2) {
    return {
      id,
      kind: "body",
      playback: "loop",
      frameCount,
      ports: [
        { id: "entry", entryFrame: 0, portalFrames: [0] },
        { id: "later", entryFrame: 0, portalFrames: [8] },
        { id: "last", entryFrame: 0, portalFrames: [frameCount - 1] }
      ],
      chunks: [span(chunkStart, frameCount)]
    };
  }
});

vi.mock("../src/codec-validator.js", () => ({
  createCodecValidator: () => ({
    validate: () => undefined,
    complete: () => undefined
  })
}));

vi.mock("../src/decoder.js", () => ({
  Decoder: class {
    public encodedBytes = 0;
    public readonly lane = media.decoderCount++;
    readonly #failure: Promise<never>;
    #runSequence = 0;
    #activeRun: number | null = null;
    public constructor() {
      let rejectFailure!: (reason: unknown) => void;
      this.#failure = new Promise<never>((_resolve, reject) => {
        rejectFailure = reject;
      });
      media.decoderFailures[this.lane] = {
        promise: this.#failure,
        reject: (reason) => {
          media.decoderDiagnostics[this.lane] = Object.freeze({
            phase: "decode",
            code: "decoder-operation",
            run: this.#activeRun,
            decodeOrdinal: 0,
            exception: Object.freeze({
              name: "Error",
              message: reason instanceof Error ? reason.message : String(reason)
            }),
            firstFrame: null
          });
          rejectFailure(reason);
        }
      };
      void this.#failure.catch(() => undefined);
    }
    public get available(): boolean { return true; }
    public async supported(): Promise<boolean> { return true; }
    public failure(): Promise<never> { return this.#failure; }
    public terminalError(): Error | null { return null; }
    public createRun(samples: readonly { timestamp: number; displayedFrames: number }[]) {
      const generation = ++this.#runSequence;
      this.#activeRun = generation;
      const label = samples[0]!.timestamp;
      const tracked = {
        id: media.runs.length + 1,
        lane: this.lane,
        label,
        closed: false,
        ready: false,
        taken: [] as number[]
      };
      media.runs.push(tracked);
      media.operations.push(`create:${String(tracked.id)}:${String(label)}`);
      let settled = false;
      let resolveReadiness!: () => void;
      let rejectReadiness!: (reason?: unknown) => void;
      const readiness = new Promise<void>((resolve, reject) => {
        resolveReadiness = resolve;
        rejectReadiness = reject;
      });
      const releaseReadiness = () => {
        if (settled) return;
        settled = true;
        tracked.ready = true;
        media.operations.push(`ready:${String(tracked.id)}`);
        resolveReadiness();
      };
      if (media.blocked.has(label)) {
        media.releaseBlocked.push({ runId: tracked.id, release: releaseReadiness });
      } else {
        queueMicrotask(releaseReadiness);
      }
      return {
        generation,
        frameCount: samples[0]!.displayedFrames,
        openFrames: 0,
        outstanding: 0,
        get closed() { return tracked.closed; },
        ready: () => readiness,
        take: async (index: number) => {
          tracked.taken.push(index);
          return { index, runId: tracked.id };
        },
        release: () => undefined,
        complete: async () => undefined,
        close: () => {
          if (tracked.closed) return;
          tracked.closed = true;
          media.operations.push(`close:${String(tracked.id)}`);
          if (!settled) {
            settled = true;
            rejectReadiness(new DOMException("closed", "AbortError"));
          }
        }
      };
    }
    public snapshot() {
      return {
        workerCount: 1,
        openFrames: 0,
        openFrameBytes: 0,
        diagnostic: media.decoderDiagnostics[this.lane] ?? null
      };
    }
    public dispose(): void {}
  }
}));

vi.mock("../src/renderer.js", () => ({
  Renderer: class {
    public constructor(
      _canvas: HTMLCanvasElement,
      _layout: unknown,
      limits: Readonly<{
        onContextChange?: (change: Readonly<RendererContextChange>) => void;
      }> = {}
    ) {
      media.rendererContextChange = limits.onContextChange ?? null;
      const failure = media.rendererConstructionFailureError;
      if (failure !== null) {
        media.rendererConstructionFailureError = null;
        media.rendererDiagnostic = failure.diagnostic;
        throw failure;
      }
    }
    public admit() { return { textureBytes: 3, runtimeBytes: 5 }; }
    public snapshot() {
      return {
        backendDetails: media.rendererBackend === "canvas2d"
          ? Object.freeze({ kind: "canvas2d" as const })
          : Object.freeze({
              kind: "webgl2" as const,
              uploadMode: "native-probing" as const,
              nativeProbeAttempts: 0,
              probeReadbackBytes: 0,
              nativeProbeInFlight: false
            }),
        cssWidth: 16,
        cssHeight: 16,
        backingWidth: 16,
        backingHeight: 16,
        effectiveDprX: 1,
        effectiveDprY: 1,
        contextLossCount: 0,
        contextRecoveryCount: 0,
        stagingBytes: 1,
        residentBytes: 0,
        textureBytes: 3,
        runtimeBytes: 5,
        pendingOperations: 0,
        sourceCopiesInFlight: 0,
        resourceCount: 4,
        contextListenerCount: 2,
        failure: media.rendererDiagnostic
      };
    }
    public async draw(frame: { index: number; runId: number }): Promise<void> {
      const failure = media.rendererFailureError;
      if (failure !== null) {
        media.rendererFailureError = null;
        media.rendererDiagnostic = failure.diagnostic;
        queueMicrotask(() => media.rendererContextChange?.(Object.freeze({
          state: "error",
          error: failure
        })));
        throw failure;
      }
      media.operations.push(
        `draw:${String(frame.runId)}:${String(frame.index)}`
      );
    }
    public async store(): Promise<void> {}
    public async drawStored(): Promise<void> {}
    public resize(): void {}
    public settled(): Promise<void> {
      media.rendererSettlementReached?.();
      return media.rendererSettlementHold ?? Promise.resolve();
    }
    public dispose(): void { media.rendererDisposeCalls += 1; }
  }
}));

import { createPlayer } from "../src/player.js";

afterEach(() => {
  media.runs.length = 0;
  media.blocked.clear();
  media.releaseBlocked.length = 0;
  media.operations.length = 0;
  media.decoderCount = 0;
  media.assetDisposeCalls = 0;
  media.assetDisposeFailures = 0;
  media.assetDisposeHold = null;
  media.assetDisposeReached = null;
  media.rendererDisposeCalls = 0;
  media.rendererSettlementHold = null;
  media.rendererSettlementReached = null;
  media.rendererContextChange = null;
  media.rendererFailureError = null;
  media.rendererConstructionFailureError = null;
  media.rendererDiagnostic = null;
  media.rendererBackend = "webgl2";
  media.decoderFailures.length = 0;
  media.decoderDiagnostics.length = 0;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("player multi-route prefetch", () => {
  it("reports the selected renderer backend independently from the codec", async () => {
    media.rendererBackend = "canvas2d";
    const { player } = await createReadyTerminalPlayer(
      "renderer-failure",
      "render"
    );

    expect(player.snapshot(false)).toMatchObject({
      selectedCodec: "avc1.640020",
      rendererBackend: "canvas2d"
    });

    await player.dispose();
  });

  it("prepares only the initial live path instead of rehearsing every route", async () => {
    vi.stubGlobal("Worker", class {});
    vi.stubGlobal("VideoDecoder", class {});
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    const player = await createPlayer({
      canvas: new EventTarget() as HTMLCanvasElement,
      platform: testPlatform(),
      initialPresentation: { width: 16, height: 16, dpr: 1, fit: null },
      baseUrl: "https://example.test/",
      sources: [{ src: "motion.avl", codec: "avc1.640020", integrity: "" }],
      credentials: "same-origin",
      signal: new AbortController().signal,
      preparationTimeoutMs: 5_000,
      motion: "full",
      reduced: false,
      initialState: null,
      initialBody: false,
      visible: true,
      decoderReady: () => true,
      onResourceBytes: () => undefined,
      onMetadata: () => undefined,
      onReadiness: () => undefined,
      onAnimationResourcesRetired: () => undefined,
      onDraw: () => undefined,
      onRestart: () => undefined,
      onEvent: () => undefined,
      onFailure: () => undefined,
      onPlaybackFailure: defaultPlaybackFailure
    });
    player.activate();
    await player.prepare();
    await eventually(() => lastRun(0) !== undefined);

    expect(media.runs.map(({ label }) => label)).toEqual([100, 0]);
    expect(lastRun(200)).toBeUndefined();
    expect(lastRun(300)).toBeUndefined();
    await player.dispose();
  });

  it("holds intro exhaustion for readiness and terminates on a decoder-lane failure", async () => {
    vi.stubGlobal("Worker", class {});
    vi.stubGlobal("VideoDecoder", class {});
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    media.blocked.add(0);
    const events: string[] = [];
    const readiness: string[] = [];
    const terminal = new AvalPlaybackError(Object.freeze({
      code: "worker-decode-failure",
      message: "Playback could not continue.",
      operation: "playback"
    }), 1);
    const playbackFailures: Array<Readonly<{
      code: string;
      operation: string;
    }>> = [];
    const player = await createPlayer({
      canvas: new EventTarget() as HTMLCanvasElement,
      platform: testPlatform(),
      initialPresentation: { width: 16, height: 16, dpr: 1, fit: null },
      baseUrl: "https://example.test/",
      sources: [{ src: "motion.avl", codec: "avc1.640020", integrity: "" }],
      credentials: "same-origin",
      signal: new AbortController().signal,
      preparationTimeoutMs: 5_000,
      motion: "full",
      reduced: false,
      initialState: null,
      initialBody: false,
      visible: true,
      decoderReady: () => true,
      onResourceBytes: () => undefined,
      onMetadata: () => undefined,
      onReadiness: (value) => readiness.push(value),
      onAnimationResourcesRetired: () => events.push("retired"),
      onDraw: () => undefined,
      onRestart: () => undefined,
      onEvent: (type) => events.push(type),
      onFailure: (code) => events.push(`failure:${code}`),
      onPlaybackFailure: (code, operation) => {
        expect(events).toContain("retired");
        playbackFailures.push({ code, operation });
        return terminal;
      }
    });
    player.activate();
    await player.prepare();
    await eventually(() => lastRun(0) !== undefined);
    const intro = lastRun(100)!;
    const body = lastRun(0)!;
    const bodyDraw = `draw:${String(body.id)}:0`;

    await driveFrames(frames, () => intro.taken.includes(1));
    expect(intro.taken).toEqual([0, 1]);
    const committedTicks = player.snapshot(true).trace.length;
    await driveFrames(frames, () => false, 3);

    expect(player.snapshot(true).trace).toHaveLength(committedTicks);
    expect(body.ready).toBe(false);
    expect(body.taken).toEqual([]);
    expect(media.operations).not.toContain(bodyDraw);
    expect(intro.closed).toBe(false);

    releaseRun(body);
    await driveFrames(frames, () => media.operations.includes(bodyDraw), 2);

    expect(media.operations, JSON.stringify(media.operations)).toContain(bodyDraw);
    expect(intro.closed).toBe(true);
    expect(player.snapshot(true).trace).toHaveLength(committedTicks + 1);
    expect(media.operations.indexOf(`ready:${String(body.id)}`)).toBeLessThan(
      media.operations.indexOf(bodyDraw)
    );
    expect(media.operations.indexOf(bodyDraw)).toBeLessThan(
      media.operations.indexOf(`close:${String(intro.id)}`)
    );
    expect(events.some((event) => event.startsWith("failure:"))).toBe(false);

    media.assetDisposeFailures = 1;
    media.decoderFailures[intro.lane]!.reject(new Error("AVAL decoder failed"));
    await eventually(() => events.includes("retired"));
    await expect(player.prepare()).rejects.toBe(terminal);
    expect(playbackFailures).toEqual([{
      code: "worker-decode-failure",
      operation: "playback"
    }]);
    expect(readiness).not.toContain("staticReady");
    expect(events.some((event) => event.startsWith("failure:"))).toBe(false);
    expect(events).toContain("retired");
    expect(player.snapshot(false)).toMatchObject({
      selectedRendition: "main",
      workerCount: 0,
      cleanupFailureCount: 1
    });
    const [diagnostic] = player.snapshot(false).decoderDiagnostics;
    expect(diagnostic).toMatchObject({
      sourceIndex: 0,
      rendition: "main",
      codec: "avc1.640020",
      unit: "idle-intro",
      lane: intro.lane,
      phase: "decode",
      code: "decoder-operation",
      run: 1,
      decodeOrdinal: 0,
      exception: {
        name: "Error",
        message: "AVAL decoder failed"
      },
      firstFrame: null
    });
    expect(Object.isFrozen(diagnostic)).toBe(true);
    expect(Object.isFrozen(diagnostic?.exception)).toBe(true);

    await player.dispose();
  });

  it("rejects pending state work with the canonical error when a candidate decoder fails", async () => {
    vi.stubGlobal("Worker", class {});
    vi.stubGlobal("VideoDecoder", class {});
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    media.blocked.add(300);
    const terminal = new AvalPlaybackError(Object.freeze({
      code: "worker-decode-failure",
      message: "Playback could not continue.",
      operation: "playback"
    }), 2);
    const playbackFailures: string[] = [];
    let retired = false;
    const player = await createPlayer({
      canvas: new EventTarget() as HTMLCanvasElement,
      platform: testPlatform(),
      initialPresentation: { width: 16, height: 16, dpr: 1, fit: null },
      baseUrl: "https://example.test/",
      sources: [{ src: "motion.avl", codec: "avc1.640020", integrity: "" }],
      credentials: "same-origin",
      signal: new AbortController().signal,
      preparationTimeoutMs: 5_000,
      motion: "full",
      reduced: false,
      initialState: null,
      initialBody: false,
      visible: true,
      decoderReady: () => true,
      onResourceBytes: () => undefined,
      onMetadata: () => undefined,
      onReadiness: () => undefined,
      onAnimationResourcesRetired: () => { retired = true; },
      onDraw: () => undefined,
      onRestart: () => undefined,
      onEvent: () => undefined,
      onFailure: () => undefined,
      onPlaybackFailure: (code, operation) => {
        expect(retired).toBe(true);
        playbackFailures.push(`${code}:${operation}`);
        return terminal;
      }
    });
    player.activate();
    await player.prepare();
    await eventually(() => lastRun(0) !== undefined);
    const originalBody = lastRun(0)!;
    await driveFrames(
      frames,
      () => media.operations.includes(`draw:${String(originalBody.id)}:0`)
    );

    const request = player.setState("hover");
    void request.catch(() => undefined);
    await eventually(() => lastRun(300) !== undefined);
    const candidate = lastRun(300)!;
    media.decoderFailures[candidate.lane]!.reject(new Error("candidate decode failed"));
    await eventually(() => playbackFailures.length === 1);
    (player as unknown as {
      contextChanged(change: Readonly<RendererContextChange>): void;
    }).contextChanged(Object.freeze({
      state: "error",
      error: rendererFailureError()
    }));

    await expect(request).rejects.toBe(terminal);
    expect(retired).toBe(true);
    expect(playbackFailures).toEqual(["worker-decode-failure:playback"]);
    await expect(player.prepare()).rejects.toBe(terminal);
    expect(player.snapshot(false)).toMatchObject({ workerCount: 0, openFrames: 0 });
    const [diagnostic] = player.snapshot(false).decoderDiagnostics;
    expect(diagnostic).toMatchObject({
      sourceIndex: 0,
      rendition: "main",
      codec: "avc1.640020",
      unit: "idle-hover",
      lane: candidate.lane,
      logicalRunId: 3,
      role: "candidate",
      graph: {
        requestedState: "hover",
        visualState: "idle",
        activeUnit: "idle-body",
        pendingUnit: "idle-hover"
      }
    });
    expect(Object.isFrozen(diagnostic?.graph)).toBe(true);
    await player.dispose();
  });

  it("publishes a typed renderer constructor cause before cleanup", async () => {
    vi.stubGlobal("Worker", class {});
    vi.stubGlobal("VideoDecoder", class {});
    const failure = rendererFailureError("context-create", "construct");
    media.rendererConstructionFailureError = failure;
    const terminal = new AvalPlaybackError(Object.freeze({
      code: "renderer-failure",
      message: "Playback could not continue.",
      operation: "prepare"
    }), 2);
    const playbackFailures: string[] = [];
    const rendererDiagnostics: Readonly<PlayerRendererDiagnostic>[] = [];

    await expect(createPlayer({
      canvas: new EventTarget() as HTMLCanvasElement,
      platform: testPlatform(),
      initialPresentation: { width: 16, height: 16, dpr: 1, fit: null },
      baseUrl: "https://example.test/",
      sources: [{ src: "motion.avl", codec: "avc1.640020", integrity: "" }],
      credentials: "same-origin",
      signal: new AbortController().signal,
      preparationTimeoutMs: 5_000,
      motion: "full",
      reduced: false,
      initialState: null,
      initialBody: false,
      visible: true,
      decoderReady: () => true,
      onResourceBytes: () => undefined,
      onMetadata: () => undefined,
      onReadiness: () => undefined,
      onAnimationResourcesRetired: () => undefined,
      onDraw: () => undefined,
      onRestart: () => undefined,
      onEvent: () => undefined,
      onFailure: () => undefined,
      onPlaybackFailure: (code, operation) => {
        playbackFailures.push(`${code}:${operation}`);
        return terminal;
      },
      onRendererDiagnostics: (diagnostics) => {
        rendererDiagnostics.push(...diagnostics);
      }
    })).rejects.toBe(terminal);

    expect(playbackFailures).toEqual(["renderer-failure:prepare"]);
    expect(rendererDiagnostics).toHaveLength(1);
    expect(rendererDiagnostics[0]).toMatchObject({
      sourceIndex: 0,
      rendition: "main",
      codec: "avc1.640020",
      backend: "webgl2",
      phase: "context-create",
      operation: "construct"
    });
    expect(Object.isFrozen(rendererDiagnostics[0])).toBe(true);
    expect(Object.isFrozen(rendererDiagnostics[0]?.layout)).toBe(true);
  });

  it("retains one renderer cause when callback and draw rejection race", async () => {
    const frames: FrameRequestCallback[] = [];
    const { player, terminal, observations } = await createReadyTerminalPlayer(
      "renderer-failure",
      "render",
      frames
    );
    const failure = rendererFailureError();
    media.rendererFailureError = failure;

    await driveFrames(frames, () => observations.playbackFailures.length === 1);

    expect(observations.playbackFailures).toEqual(["renderer-failure:render"]);
    expect(observations.rendererDiagnostics).toHaveLength(1);
    const [published] = observations.rendererDiagnostics;
    expect(published).toMatchObject({
      sourceIndex: 0,
      rendition: "main",
      codec: "avc1.640020",
      backend: "webgl2",
      phase: "rgba-copy",
      operation: "runtime",
      operationOrdinal: 4,
      exception: {
        name: "EncodingError",
        message: "synthetic renderer copy failed"
      },
      glError: null,
      contextLost: false,
      uploadPath: "rgba-copy"
    });
    expect(Object.isFrozen(published)).toBe(true);
    expect(Object.isFrozen(published?.layout)).toBe(true);
    expect(Object.isFrozen(published?.bytes)).toBe(true);
    await expect(player.prepare()).rejects.toBe(terminal);
    await player.settled();
    expect(player.snapshot(false).rendererDiagnostics).toHaveLength(1);
    expect(player.snapshot(false).rendererDiagnostics[0]).toBe(published);
    expect(observations.retirements).toBe(1);
    await player.dispose();
  });

  it("keeps renderer context loss recoverable until restoration", async () => {
    const { player, observations } = await createReadyTerminalPlayer(
      "renderer-failure",
      "render"
    );

    (player as unknown as {
      contextChanged(change: Readonly<RendererContextChange>): void;
    }).contextChanged(Object.freeze({ state: "lost", error: null }));

    expect(observations.playbackFailures).toEqual([]);
    expect(observations.failures).toEqual(["context-loss:render:false"]);
    expect(observations.rendererDiagnostics).toEqual([]);
    expect(player.snapshot(false)).toMatchObject({
      contextLossCount: 1,
      contextRecoveryCount: 0
    });

    (player as unknown as {
      contextChanged(change: Readonly<RendererContextChange>): void;
    }).contextChanged(Object.freeze({ state: "restored", error: null }));

    expect(observations.playbackFailures).toEqual([]);
    expect(observations.restarts).toHaveLength(1);
    expect(player.snapshot(false)).toMatchObject({
      contextLossCount: 1,
      contextRecoveryCount: 1
    });
    await player.dispose();
  });

  it("terminates a real context loss when bounded restoration expires", async () => {
    vi.useFakeTimers();
    const { player, observations } = await createReadyTerminalPlayer(
      "context-loss",
      "render"
    );

    (player as unknown as {
      contextChanged(change: Readonly<RendererContextChange>): void;
    }).contextChanged(Object.freeze({ state: "lost", error: null }));
    await vi.advanceTimersByTimeAsync(5_000);
    await eventually(() => observations.playbackFailures.length === 1);

    expect(observations.failures).toEqual(["context-loss:render:false"]);
    expect(observations.playbackFailures).toEqual(["context-loss:render"]);
    expect(observations.rendererDiagnostics).toEqual([]);
    await player.settled();
    await player.dispose();
  });

  it.each(["setState", "resume"] as const)(
    "rejects a %s continuation when terminal work starts after prepare resolves",
    async (operation) => {
      const { player, terminal, observations } = await createReadyTerminalPlayer(
        "renderer-failure",
        "render"
      );
      if (operation === "resume") player.pause();
      const pending = operation === "setState"
        ? player.setState("hover")
        : player.resume();
      void pending.catch(() => undefined);

      (player as unknown as {
        contextChanged(change: Readonly<RendererContextChange>): void;
      }).contextChanged(Object.freeze({
        state: "error",
        error: rendererFailureError()
      }));

      await expect(pending).rejects.toBe(terminal);
      await expect(player.prepare()).rejects.toBe(terminal);
      await player.settled();
      expect(observations.playbackFailures).toEqual([
        "renderer-failure:render"
      ]);
      expect(observations.retirements).toBe(1);
      expect(media.assetDisposeCalls).toBe(1);
      expect(media.rendererDisposeCalls).toBe(1);
      expect(player.snapshot(false)).toMatchObject({
        workerCount: 0,
        openFrames: 0
      });
      await player.dispose();
    }
  );

  it("terminalizes a queued decoder failure during static-policy retirement", async () => {
    const { player, terminal, observations } = await createReadyTerminalPlayer(
      "worker-decode-failure",
      "playback"
    );
    let releaseRenderer!: () => void;
    let markRendererReached!: () => void;
    const rendererReached = new Promise<void>((resolve) => {
      markRendererReached = resolve;
    });
    media.rendererSettlementReached = markRendererReached;
    media.rendererSettlementHold = new Promise<void>((resolve) => {
      releaseRenderer = resolve;
    });

    const suspension = player.suspend("visibility-suspended");
    void suspension.catch(() => undefined);
    await rendererReached;
    media.decoderFailures[0]!.reject(new Error("queued decoder failure"));
    await settleMicrotasks();
    releaseRenderer();

    await expect(suspension).rejects.toBe(terminal);
    await expect(player.prepare()).rejects.toBe(terminal);
    await player.settled();
    expect(observations.playbackFailures).toEqual([
      "worker-decode-failure:playback"
    ]);
    expect(observations.retirements).toBe(1);
    expect(media.assetDisposeCalls).toBe(1);
    expect(media.rendererDisposeCalls).toBe(1);
    expect(player.snapshot(false)).toMatchObject({
      workerCount: 0,
      openFrames: 0
    });
    await player.dispose();
  });

  it("ignores an expected decoder abort during static-policy retirement", async () => {
    const { player, observations } = await createReadyTerminalPlayer(
      "worker-decode-failure",
      "playback"
    );
    let releaseRenderer!: () => void;
    let markRendererReached!: () => void;
    const rendererReached = new Promise<void>((resolve) => {
      markRendererReached = resolve;
    });
    media.rendererSettlementReached = markRendererReached;
    media.rendererSettlementHold = new Promise<void>((resolve) => {
      releaseRenderer = resolve;
    });

    const suspension = player.suspend("visibility-suspended");
    await rendererReached;
    media.decoderFailures[0]!.reject(
      new DOMException("decoder retired", "AbortError")
    );
    await settleMicrotasks();
    releaseRenderer();

    await expect(suspension).resolves.toMatchObject({
      mode: "static",
      reason: "visibility-suspended"
    });
    expect(observations.playbackFailures).toEqual([]);
    expect(observations.retirements).toBe(1);
    expect(media.assetDisposeCalls).toBe(1);
    expect(media.rendererDisposeCalls).toBe(1);
    await player.dispose();
  });

  it("terminalizes an unexpected decoder AbortError during active playback", async () => {
    const { player, terminal, observations } = await createReadyTerminalPlayer(
      "worker-decode-failure",
      "playback"
    );

    media.decoderFailures[0]!.reject(
      new DOMException("active decoder failed", "AbortError")
    );
    await settleMicrotasks();

    await expect(player.prepare()).rejects.toBe(terminal);
    await player.settled();
    expect(observations.playbackFailures).toEqual([
      "worker-decode-failure:playback"
    ]);
    expect(observations.retirements).toBe(1);
    expect(media.assetDisposeCalls).toBe(1);
    expect(media.rendererDisposeCalls).toBe(1);
    expect(player.snapshot(false)).toMatchObject({
      workerCount: 0,
      openFrames: 0
    });
    await player.dispose();
  });

  it("lets source supersession win while terminal cleanup is pending", async () => {
    vi.stubGlobal("Worker", class {});
    vi.stubGlobal("VideoDecoder", class {});
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    const controller = new AbortController();
    const playbackFailures: string[] = [];
    const terminal = new AvalPlaybackError(Object.freeze({
      code: "renderer-failure",
      message: "Playback could not continue.",
      operation: "render"
    }), 3);
    const player = await createPlayer({
      canvas: new EventTarget() as HTMLCanvasElement,
      platform: testPlatform(),
      initialPresentation: { width: 16, height: 16, dpr: 1, fit: null },
      baseUrl: "https://example.test/",
      sources: [{ src: "motion.avl", codec: "avc1.640020", integrity: "" }],
      credentials: "same-origin",
      signal: controller.signal,
      preparationTimeoutMs: 5_000,
      motion: "full",
      reduced: false,
      initialState: null,
      initialBody: false,
      visible: true,
      decoderReady: () => true,
      onResourceBytes: () => undefined,
      onMetadata: () => undefined,
      onReadiness: () => undefined,
      onAnimationResourcesRetired: () => undefined,
      onDraw: () => undefined,
      onRestart: () => undefined,
      onEvent: () => undefined,
      onFailure: () => undefined,
      onPlaybackFailure: (code, operation) => {
        playbackFailures.push(`${code}:${operation}`);
        return terminal;
      }
    });
    player.activate();
    await player.prepare();
    await player.settled();

    let releaseCleanup!: () => void;
    let markCleanupReached!: () => void;
    const cleanupReached = new Promise<void>((resolve) => {
      markCleanupReached = resolve;
    });
    media.assetDisposeReached = markCleanupReached;
    media.assetDisposeHold = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    (player as unknown as {
      contextChanged(change: Readonly<RendererContextChange>): void;
    }).contextChanged(Object.freeze({
      state: "error",
      error: rendererFailureError()
    }));
    await cleanupReached;
    const pending = player.prepare();
    controller.abort(new DOMException("source replaced", "AbortError"));
    releaseCleanup();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(playbackFailures).toHaveLength(0);
    media.assetDisposeHold = null;
    await player.dispose();
  });

  it("reprioritizes loop wrap after a pending route misses its last portal", async () => {
    vi.stubGlobal("Worker", class {});
    vi.stubGlobal("VideoDecoder", class {});
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    const events: string[] = [];
    const player = await createPlayer({
      canvas: new EventTarget() as HTMLCanvasElement,
      platform: testPlatform(),
      initialPresentation: { width: 16, height: 16, dpr: 1, fit: null },
      baseUrl: "https://example.test/",
      sources: [{ src: "motion.avl", codec: "avc1.640020", integrity: "" }],
      credentials: "same-origin",
      signal: new AbortController().signal,
      preparationTimeoutMs: 5_000,
      motion: "full",
      reduced: false,
      initialState: null,
      initialBody: false,
      visible: true,
      decoderReady: () => true,
      onResourceBytes: () => undefined,
      onMetadata: () => undefined,
      onReadiness: () => undefined,
      onAnimationResourcesRetired: () => undefined,
      onDraw: () => undefined,
      onRestart: () => undefined,
      onEvent: (type) => events.push(type),
      onFailure: (code) => events.push(`failure:${code}`),
      onPlaybackFailure: defaultPlaybackFailure
    });
    player.activate();
    await player.prepare();
    await eventually(() => lastRun(0) !== undefined);
    const originalBody = lastRun(0)!;
    await driveFrames(
      frames,
      () => media.operations.includes(`draw:${String(originalBody.id)}:0`)
    );
    expect(originalBody.closed).toBe(false);

    media.blocked.add(300);
    const request = player.setState("hover");
    void request.catch(() => undefined);
    await eventually(() => lastRun(300) !== undefined);
    const staleTransition = lastRun(300)!;
    const originalBodyRuns = media.runs.filter(({ label }) => label === 0).length;
    await driveFrames(frames, () => staleTransition.closed, 32);
    expect(originalBody.taken).toContain(8);
    expect(originalBody.taken).toContain(9);
    expect(staleTransition.ready).toBe(false);
    expect(staleTransition.closed).toBe(true);
    expect(events).not.toContain("transitionstart");

    await driveFrames(
      frames,
      () => media.runs.filter(({ label }) => label === 0).length > originalBodyRuns,
      20
    );
    const freshBody = lastRun(0)!;
    const freshDraw = `draw:${String(freshBody.id)}:0`;

    expect(freshBody).not.toBe(originalBody);
    expect(staleTransition.closed).toBe(true);
    expect(originalBody.closed).toBe(false);
    expect(freshBody.ready).toBe(true);
    expect(freshBody.taken).toEqual([]);
    expect(media.operations).not.toContain(freshDraw);
    expect(media.runs.filter(({ label }) => label === 300)).toEqual([
      staleTransition
    ]);
    expect(
      media.runs.filter((run) => run.lane === freshBody.lane && !run.closed)
    ).toEqual([freshBody]);
    expect(media.operations.indexOf(`close:${String(staleTransition.id)}`)).toBeLessThan(
      media.operations.indexOf(`create:${String(freshBody.id)}:0`)
    );

    await driveFrames(frames, () => media.operations.includes(freshDraw), 12);

    expect(media.operations, JSON.stringify(media.operations)).toContain(freshDraw);
    expect(originalBody.closed).toBe(true);
    expect(media.operations.indexOf(`ready:${String(freshBody.id)}`)).toBeLessThan(
      media.operations.indexOf(freshDraw)
    );
    expect(media.operations.indexOf(freshDraw)).toBeLessThan(
      media.operations.indexOf(`close:${String(originalBody.id)}`)
    );
    expect(events).not.toContain("transitionstart");
    expect(events.some((event) => event.startsWith("failure:"))).toBe(false);

    await player.dispose();
    await expect(request).rejects.toBeInstanceOf(Error);
  });

  it("completes exactly 60 wraps across 1,440 content ticks", async () => {
    vi.stubGlobal("Worker", class {});
    vi.stubGlobal("VideoDecoder", class {});
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    const events: string[] = [];
    const player = await createPlayer({
      canvas: new EventTarget() as HTMLCanvasElement,
      platform: testPlatform(),
      initialPresentation: { width: 16, height: 16, dpr: 1, fit: null },
      baseUrl: "https://example.test/",
      sources: [{ src: "motion.avl", codec: "avc1.640020", integrity: "" }],
      credentials: "same-origin",
      signal: new AbortController().signal,
      preparationTimeoutMs: 5_000,
      motion: "full",
      reduced: false,
      initialState: null,
      initialBody: false,
      visible: true,
      decoderReady: () => true,
      onResourceBytes: () => undefined,
      onMetadata: () => undefined,
      onReadiness: () => undefined,
      onAnimationResourcesRetired: () => undefined,
      onDraw: () => undefined,
      onRestart: () => undefined,
      onEvent: (type) => events.push(type),
      onFailure: (code) => events.push(`failure:${code}`),
      onPlaybackFailure: defaultPlaybackFailure
    });
    player.activate();
    await player.prepare();
    await eventually(() => lastRun(0) !== undefined);
    const initialBody = lastRun(0)!;
    await driveFrames(
      frames,
      () => media.operations.includes(`draw:${String(initialBody.id)}:0`),
      12
    );
    const baseline = player.snapshot(false).playbackLifecycle;
    const targetDraws = baseline.drawsCompleted + 1_440;

    for (let attempt = 0; attempt < 1_600; attempt += 1) {
      if (player.snapshot(false).playbackLifecycle.drawsCompleted === targetDraws) {
        break;
      }
      await Promise.resolve();
      const frame = frames.shift();
      frame?.(performance.now() + 20_000 + attempt * 100);
      await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
    }

    const snapshot = player.snapshot(true);
    expect(snapshot.playbackLifecycle.drawsCompleted).toBe(targetDraws);
    expect(snapshot.playbackLifecycle.loopCrossings - baseline.loopCrossings).toBe(60);
    expect(snapshot.playbackLifecycle.candidateCommits).toBeGreaterThanOrEqual(60);
    expect(snapshot.playbackLifecycle.logicalRunsCreated).toBeLessThanOrEqual(66);
    expect(snapshot.playbackLifecycle.runsClosed).toBeLessThanOrEqual(
      snapshot.playbackLifecycle.logicalRunsCreated
    );
    expect(new Set(media.runs.filter(({ label }) => label === 0).map(({ lane }) => lane)))
      .toEqual(new Set([0, 1]));
    expect(media.runs.filter(({ closed }) => !closed)).toHaveLength(1);
    expect(snapshot.openFrames).toBe(0);
    expect(snapshot.requestedState).toBe("idle");
    expect(snapshot.visualState).toBe("idle");
    expect(snapshot.transitioning).toBe(false);
    expect(snapshot.decoderDiagnostics).toEqual([]);
    expect(snapshot.rendererDiagnostics).toEqual([]);
    expect(snapshot.trace).toHaveLength(512);
    expect(snapshot.trace.slice(-24).map((record) =>
      record.scheduler.displayedCursor?.localFrame
    )).toEqual([
      ...Array.from({ length: 23 }, (_unused, index) => index + 1),
      0
    ]);
    expect(events).not.toContain("underflow");
    expect(events.some((event) => event.startsWith("failure:"))).toBe(false);

    await player.dispose();
  });

  it("prepares loop continuation before an unready final-frame portal wraps", async () => {
    vi.stubGlobal("Worker", class {});
    vi.stubGlobal("VideoDecoder", class {});
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    const events: string[] = [];
    const player = await createPlayer({
      canvas: new EventTarget() as HTMLCanvasElement,
      platform: testPlatform(),
      initialPresentation: { width: 16, height: 16, dpr: 1, fit: null },
      baseUrl: "https://example.test/",
      sources: [{ src: "motion.avl", codec: "avc1.640020", integrity: "" }],
      credentials: "same-origin",
      signal: new AbortController().signal,
      preparationTimeoutMs: 5_000,
      motion: "full",
      reduced: false,
      initialState: null,
      initialBody: false,
      visible: true,
      decoderReady: () => true,
      onResourceBytes: () => undefined,
      onMetadata: () => undefined,
      onReadiness: () => undefined,
      onAnimationResourcesRetired: () => undefined,
      onDraw: () => undefined,
      onRestart: () => undefined,
      onEvent: (type) => events.push(type),
      onFailure: (code) => events.push(`failure:${code}`),
      onPlaybackFailure: defaultPlaybackFailure
    });
    player.activate();
    await player.prepare();
    await eventually(() => lastRun(0) !== undefined);
    const originalBody = lastRun(0)!;
    await driveFrames(
      frames,
      () => media.operations.includes(`draw:${String(originalBody.id)}:0`)
    );

    media.blocked.add(900);
    const request = player.setState("last");
    void request.catch(() => undefined);
    await eventually(() => lastRun(900) !== undefined);
    const blockedTarget = lastRun(900)!;
    const bodyRuns = media.runs.filter(({ label }) => label === 0).length;

    await driveFrames(frames, () => originalBody.taken.includes(23), 32);
    await driveFrames(
      frames,
      () => media.runs.filter(({ label }) => label === 0).length > bodyRuns,
      4
    );
    const continuation = lastRun(0)!;
    const continuationDraw = `draw:${String(continuation.id)}:0`;
    await driveFrames(frames, () => media.operations.includes(continuationDraw), 4);

    expect(continuation).not.toBe(originalBody);
    expect(blockedTarget.closed).toBe(true);
    expect(media.operations).toContain(continuationDraw);
    expect(media.operations.indexOf(`ready:${String(continuation.id)}`)).toBeLessThan(
      media.operations.indexOf(continuationDraw)
    );
    expect(media.operations.indexOf(continuationDraw)).toBeLessThan(
      media.operations.indexOf(`close:${String(originalBody.id)}`)
    );
    expect(events).not.toContain("underflow");
    expect(events.some((event) => event.startsWith("failure:"))).toBe(false);

    await player.dispose();
    await expect(request).rejects.toBeInstanceOf(Error);
  });

  it("keeps the foreground running until a ready candidate draws", async () => {
    vi.stubGlobal("Worker", class {});
    vi.stubGlobal("VideoDecoder", class {});
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    let transitionStarted = false;
    const events: string[] = [];
    const player = await createPlayer({
      canvas: new EventTarget() as HTMLCanvasElement,
      platform: testPlatform(),
      initialPresentation: { width: 16, height: 16, dpr: 1, fit: null },
      baseUrl: "https://example.test/",
      sources: [{ src: "motion.avl", codec: "avc1.640020", integrity: "" }],
      credentials: "same-origin",
      signal: new AbortController().signal,
      preparationTimeoutMs: 5_000,
      motion: "full",
      reduced: false,
      initialState: null,
      initialBody: false,
      visible: true,
      decoderReady: () => true,
      onResourceBytes: () => undefined,
      onMetadata: () => undefined,
      onReadiness: () => undefined,
      onAnimationResourcesRetired: () => undefined,
      onDraw: () => undefined,
      onRestart: () => undefined,
      onEvent: (type) => {
        events.push(type);
        if (type === "transitionstart") transitionStarted = true;
      },
      onFailure: (code) => events.push(`failure:${code}`),
      onPlaybackFailure: defaultPlaybackFailure
    });
    player.activate();
    await player.prepare();
    await eventually(() => lastRun(0) !== undefined);
    const originalBody = lastRun(0)!;
    await driveFrames(
      frames,
      () => media.operations.includes(`draw:${String(originalBody.id)}:0`)
    );
    expect(originalBody.closed).toBe(false);
    const originalTaken = originalBody.taken.length;
    media.blocked.add(300);
    const bridgeRuns = media.runs.filter(({ label }) => label === 300).length;
    const request = player.setState("hover");
    await eventually(() =>
      media.runs.filter(({ label }) => label === 300).length > bridgeRuns
    );

    const prioritizedBridge = lastRun(300)!;
    const bridgeDraw = `draw:${String(prioritizedBridge.id)}:0`;
    expect(originalBody.closed).toBe(false);
    expect(prioritizedBridge.ready).toBe(false);
    expect(prioritizedBridge.closed).toBe(false);
    expect(prioritizedBridge.lane).not.toBe(originalBody.lane);
    expect(media.runs.indexOf(originalBody)).toBeLessThan(
      media.runs.indexOf(prioritizedBridge)
    );
    expect(frames.length, JSON.stringify(player.snapshot(false))).toBeGreaterThan(0);
    await driveFrames(
      frames,
      () => originalBody.taken.length >= originalTaken + 3,
      12
    );
    expect(originalBody.taken.length).toBeGreaterThanOrEqual(originalTaken + 3);
    expect(originalBody.closed).toBe(false);
    expect(media.operations).not.toContain(bridgeDraw);
    expect(transitionStarted).toBe(false);

    releaseRun(prioritizedBridge);
    await driveFrames(frames, () => media.operations.includes(bridgeDraw));
    expect(prioritizedBridge.ready).toBe(true);
    expect(originalBody.closed).toBe(true);
    expect(
      transitionStarted,
      `${events.join(",")}:${JSON.stringify(player.snapshot(true))}`
    ).toBe(true);
    expect(media.operations, JSON.stringify(media.operations)).toContain(bridgeDraw);
    expect(media.operations.indexOf(`ready:${String(prioritizedBridge.id)}`)).toBeLessThan(
      media.operations.indexOf(bridgeDraw)
    );
    expect(media.operations.indexOf(bridgeDraw)).toBeLessThan(
      media.operations.indexOf(`close:${String(originalBody.id)}`)
    );
    expect(events.some((event) => event.startsWith("failure:"))).toBe(false);
    expect(events).not.toContain("underflow");

    await player.dispose();
    await expect(request).rejects.toMatchObject({ name: "AbortError" });
  });

  it("cancels stale rapid routes and promotes only the latest candidate", async () => {
    vi.stubGlobal("Worker", class {});
    vi.stubGlobal("VideoDecoder", class {});
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    media.blocked.add(300);
    media.blocked.add(500);
    media.blocked.add(700);
    const events: string[] = [];
    const transitions: string[] = [];
    const player = await createPlayer({
      canvas: new EventTarget() as HTMLCanvasElement,
      platform: testPlatform(),
      initialPresentation: { width: 16, height: 16, dpr: 1, fit: null },
      baseUrl: "https://example.test/",
      sources: [{ src: "motion.avl", codec: "avc1.640020", integrity: "" }],
      credentials: "same-origin",
      signal: new AbortController().signal,
      preparationTimeoutMs: 5_000,
      motion: "full",
      reduced: false,
      initialState: null,
      initialBody: false,
      visible: true,
      decoderReady: () => true,
      onResourceBytes: () => undefined,
      onMetadata: () => undefined,
      onReadiness: () => undefined,
      onAnimationResourcesRetired: () => undefined,
      onDraw: () => undefined,
      onRestart: () => undefined,
      onEvent: (type, detail) => {
        events.push(type);
        if (type === "transitionstart") {
          transitions.push(String((detail as { edge: string }).edge));
        }
      },
      onFailure: (code) => events.push(`failure:${code}`),
      onPlaybackFailure: defaultPlaybackFailure
    });
    player.activate();
    await player.prepare();
    await eventually(() => lastRun(0) !== undefined);
    const originalBody = lastRun(0)!;
    await driveFrames(
      frames,
      () => media.operations.includes(`draw:${String(originalBody.id)}:0`)
    );
    expect(originalBody.closed).toBe(false);
    const originalTaken = originalBody.taken.length;
    const outgoing = player.setState("hover");
    void outgoing.catch(() => undefined);
    await eventually(() => lastRun(300) !== undefined);
    const hoverBridge = lastRun(300)!;
    expect(hoverBridge.ready).toBe(false);

    const replacement = player.setState("other");
    void replacement.catch(() => undefined);
    await eventually(() => lastRun(500) !== undefined);
    const otherBridge = lastRun(500)!;
    expect(hoverBridge.closed).toBe(true);
    expect(otherBridge.ready).toBe(false);

    const laterReplacement = player.setState("later");
    void laterReplacement.catch(() => undefined);
    await eventually(() => lastRun(700) !== undefined);
    const laterBridge = lastRun(700)!;
    const laterDraw = `draw:${String(laterBridge.id)}:0`;
    expect(otherBridge.closed).toBe(true);
    expect(laterBridge.ready).toBe(false);
    await driveFrames(
      frames,
      () => originalBody.taken.length >= originalTaken + 3,
      12
    );
    expect(originalBody.taken.length).toBeGreaterThanOrEqual(originalTaken + 3);
    expect(originalBody.closed).toBe(false);
    expect(media.operations).not.toContain(`draw:${String(hoverBridge.id)}:0`);
    expect(media.operations).not.toContain(`draw:${String(otherBridge.id)}:0`);
    expect(media.operations).not.toContain(laterDraw);

    let latestSettled = false;
    void laterReplacement.then(() => { latestSettled = true; });
    releaseRun(laterBridge);
    await driveFrames(frames, () => media.operations.includes(laterDraw));
    expect(media.operations, JSON.stringify(media.operations)).toContain(laterDraw);
    expect(originalBody.closed).toBe(true);
    expect(media.operations.indexOf(laterDraw)).toBeLessThan(
      media.operations.indexOf(`close:${String(originalBody.id)}`)
    );
    await driveFrames(frames, () => latestSettled, 60);
    await expect(laterReplacement).resolves.toBeUndefined();
    expect(player.snapshot(false)).toMatchObject({
      requestedState: "later",
      visualState: "later"
    });
    expect(transitions).toEqual(["idle-later-edge"]);
    expect(events.some((event) => event.startsWith("failure:"))).toBe(false);
    expect(events).not.toContain("underflow");

    await player.dispose();
    const outcomes = await Promise.allSettled([outgoing, replacement]);
    expect(outcomes.map(({ status }) => status)).toEqual([
      "rejected",
      "rejected"
    ]);
  });

  it("accounts resources immediately but buffers public state until activation", async () => {
    vi.stubGlobal("Worker", class {});
    vi.stubGlobal("VideoDecoder", class {});
    const observed: string[] = [];
    let player!: Awaited<ReturnType<typeof createPlayer>>;
    player = await createPlayer({
      canvas: new EventTarget() as HTMLCanvasElement,
      platform: testPlatform(),
      initialPresentation: { width: 16, height: 16, dpr: 1, fit: null },
      baseUrl: "https://example.test/",
      sources: [{ src: "motion.avl", codec: "avc1.640020", integrity: "" }],
      credentials: "same-origin",
      signal: new AbortController().signal,
      preparationTimeoutMs: 5_000,
      motion: "full",
      reduced: false,
      initialState: null,
      initialBody: false,
      visible: true,
      decoderReady: () => true,
      onResourceBytes: () => observed.push("resource"),
      onMetadata: () => observed.push("metadata"),
      onReadiness: (value) => {
        observed.push(`readiness:${value}`);
        if (value === "metadataReady") {
          observed.push(`canSend:${String(player.canSend("hover"))}`);
          observed.push(`send:${String(player.send("hover"))}`);
        }
      },
      onAnimationResourcesRetired: () => observed.push("retired"),
      onDraw: () => observed.push("draw"),
      onRestart: () => observed.push("restart"),
      onEvent: (type, detail) => observed.push(`${type}:${String(detail.to ?? "")}`),
      onFailure: () => observed.push("failure"),
      onPlaybackFailure: defaultPlaybackFailure
    });

    expect(observed.length).toBeGreaterThan(0);
    expect(new Set(observed)).toEqual(new Set(["resource"]));
    player.activate();
    player.activate();
    expect(observed).toContain("canSend:true");
    expect(observed).toContain("send:true");
    expect(observed.indexOf("requestedstatechange:idle")).toBeLessThan(
      observed.indexOf("requestedstatechange:hover")
    );
    await expect(player.prepare()).resolves.toMatchObject({ mode: "animated" });
    expect(observed).not.toContain("failure");
    await player.dispose();
  });
});

function lastRun(label: number) {
  return [...media.runs].reverse().find((run) => run.label === label);
}

function releaseRun(run: { id: number; label: number }): void {
  media.blocked.delete(run.label);
  for (let index = media.releaseBlocked.length - 1; index >= 0; index -= 1) {
    const blocked = media.releaseBlocked[index]!;
    if (blocked.runId !== run.id) continue;
    media.releaseBlocked.splice(index, 1);
    blocked.release();
  }
}

async function driveFrames(
  frames: FrameRequestCallback[],
  complete: () => boolean,
  maximum = 40
): Promise<void> {
  for (let attempt = 0; attempt < maximum && !complete(); attempt += 1) {
    await Promise.resolve();
    const frame = frames.shift();
    if (frame !== undefined) frame(performance.now() + 10_000 + attempt * 100);
    await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
  }
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error("condition did not become true");
}

function testPlatform() {
  return {
    fetch: globalThis.fetch.bind(globalThis),
    Worker: globalThis.Worker ?? null,
    VideoDecoder: globalThis.VideoDecoder ?? null,
    VideoFrame: globalThis.VideoFrame ?? class {} as unknown as typeof VideoFrame,
    requestAnimationFrame: globalThis.requestAnimationFrame?.bind(globalThis) ?? (() => 1),
    cancelAnimationFrame: globalThis.cancelAnimationFrame?.bind(globalThis) ?? (() => undefined),
    now: () => performance.now(),
    setTimeout: (callback: () => void, delay: number) =>
      globalThis.setTimeout(callback, delay) as unknown as number,
    clearTimeout: (handle: number) => globalThis.clearTimeout(handle),
    crypto: globalThis.crypto
  };
}

function rendererFailureError(
  phase: Readonly<RendererFailureDiagnostic>["phase"] = "rgba-copy",
  operation: Readonly<RendererFailureDiagnostic>["operation"] = "runtime"
): RendererFailureError {
  return new RendererFailureError(createRendererFailureDiagnostic({
    phase,
    operation,
    operationOrdinal: 4,
    reason: new DOMException("synthetic renderer copy failed", "EncodingError"),
    glError: null,
    contextLost: false,
    uploadPath: phase === "rgba-copy" ? "rgba-copy" : null,
    textureOrdinal: null,
    layout: {
      codedWidth: 16,
      codedHeight: 16,
      storageWidth: 16,
      storageHeight: 16,
      logicalWidth: 16,
      logicalHeight: 16
    },
    backing: { width: 16, height: 16 },
    bytes: {
      stagingBytes: 1_024,
      residentBytes: 0,
      textureBytes: 3_840,
      backingBytes: 1_280,
      runtimeBytes: 6_144,
      maxTextureBytes: 16_000_000,
      maxBackingBytes: 16_000_000,
      maxRuntimeBytes: 16_000_000
    },
    limits: {
      maxTextureSize: 8_192,
      maxViewportWidth: 8_192,
      maxViewportHeight: 8_192,
      maxResidentTextures: 4_096
    },
    contextAttributes: {
      alpha: true,
      antialias: false,
      depth: false,
      desynchronized: true,
      failIfMajorPerformanceCaveat: false,
      powerPreference: "default",
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
      stencil: false,
      xrCompatible: false
    },
    vendor: "Synthetic Vendor",
    renderer: "Synthetic Renderer"
  }));
}

function defaultPlaybackFailure(
  code: ConstructorParameters<typeof AvalPlaybackError>[0]["code"],
  operation: string
): AvalPlaybackError {
  return new AvalPlaybackError(Object.freeze({
    code,
    message: "Playback could not continue.",
    operation
  }), 1);
}

async function createReadyTerminalPlayer(
  code: ConstructorParameters<typeof AvalPlaybackError>[0]["code"],
  operation: string,
  frames?: FrameRequestCallback[]
) {
  vi.stubGlobal("Worker", class {});
  vi.stubGlobal("VideoDecoder", class {});
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    if (frames !== undefined) frames.push(callback);
    return frames?.length ?? 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
  const terminal = new AvalPlaybackError(Object.freeze({
    code,
    message: "Playback could not continue.",
    operation
  }), 1);
  const observations = {
    playbackFailures: [] as string[],
    failures: [] as string[],
    retirements: 0,
    restarts: [] as string[],
    rendererDiagnostics: [] as Readonly<PlayerRendererDiagnostic>[]
  };
  const player = await createPlayer({
    canvas: new EventTarget() as HTMLCanvasElement,
    platform: testPlatform(),
    initialPresentation: { width: 16, height: 16, dpr: 1, fit: null },
    baseUrl: "https://example.test/",
    sources: [{ src: "motion.avl", codec: "avc1.640020", integrity: "" }],
    credentials: "same-origin",
    signal: new AbortController().signal,
    preparationTimeoutMs: 5_000,
    motion: "full",
    reduced: false,
    initialState: null,
    initialBody: false,
    visible: true,
    decoderReady: () => true,
    onResourceBytes: () => undefined,
    onMetadata: () => undefined,
    onReadiness: () => undefined,
    onAnimationResourcesRetired: () => { observations.retirements += 1; },
    onDraw: () => undefined,
    onRestart: (state) => { observations.restarts.push(state); },
    onEvent: () => undefined,
    onFailure: (actualCode, actualOperation, fatal) => {
      observations.failures.push(
        `${actualCode}:${actualOperation}:${String(fatal)}`
      );
    },
    onRendererDiagnostics: (diagnostics) => {
      observations.rendererDiagnostics.push(...diagnostics);
    },
    onPlaybackFailure: (actualCode, actualOperation) => {
      observations.playbackFailures.push(`${actualCode}:${actualOperation}`);
      return terminal;
    }
  });
  player.activate();
  await player.prepare();
  return { player, terminal, observations };
}

async function settleMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}
