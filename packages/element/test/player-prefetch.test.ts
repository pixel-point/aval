import { afterEach, describe, expect, it, vi } from "vitest";
import { AvalPlaybackError } from "../src/errors.js";

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
  decoderFailures: [] as Array<{
    promise: Promise<never>;
    reject: (reason: unknown) => void;
  }>,
  decoderDiagnostics: [] as unknown[]
}));

vi.mock("../src/asset.js", () => {
  const units = [
    body("idle-body", 0, 16),
    { id: "idle-intro", kind: "one-shot", frameCount: 2, chunks: [span(1)] },
    body("hover-body", 2, 16),
    { id: "idle-hover", kind: "bridge", frameCount: 16, chunks: [span(3)] },
    body("other-body", 4, 16),
    { id: "idle-other", kind: "bridge", frameCount: 16, chunks: [span(5)] },
    body("later-body", 6, 16),
    { id: "idle-later", kind: "bridge", frameCount: 16, chunks: [span(7)] },
    body("last-body", 8, 16),
    { id: "idle-last", kind: "bridge", frameCount: 16, chunks: [span(9)] }
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
      codec: "h264",
      canvas: { width: 16, height: 16, fit: "contain", pixelAspect: [1, 1] },
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
            maxWaitFrames: 16
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
            maxWaitFrames: 16
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
            maxWaitFrames: 16
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
            maxWaitFrames: 16
          },
          transition: { kind: "locked", unit: "idle-last" },
          trigger: { type: "event", name: "last" },
          continuity: "exact-authored"
        }
      ],
      bindings: [],
      readiness: { policy: "all-routes", bootstrapUnits: [], immediateEdges: [] },
      limits: {
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

  function span(chunkStart: number) {
    return { rendition: "main", chunkStart, chunkCount: 1 };
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
      chunks: [span(chunkStart)]
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
    public admit() { return { textureBytes: 3, runtimeBytes: 5 }; }
    public snapshot() {
      return {
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
        contextListenerCount: 2
      };
    }
    public async draw(frame: { index: number; runId: number }): Promise<void> {
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
  media.decoderFailures.length = 0;
  media.decoderDiagnostics.length = 0;
  vi.unstubAllGlobals();
});

describe("player multi-route prefetch", () => {
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
    (player as unknown as { contextChanged(state: "error"): void }).contextChanged("error");

    await expect(request).rejects.toBe(terminal);
    expect(retired).toBe(true);
    expect(playbackFailures).toEqual(["worker-decode-failure:playback"]);
    await expect(player.prepare()).rejects.toBe(terminal);
    expect(player.snapshot(false)).toMatchObject({ workerCount: 0, openFrames: 0 });
    await player.dispose();
  });

  it.each(["setState", "resume"] as const)(
    "rejects a %s continuation when terminal work starts after prepare resolves",
    async (operation) => {
      const { player, terminal, observations } = await createReadyTerminalPlayer(
        "context-loss",
        "render"
      );
      if (operation === "resume") player.pause();
      const pending = operation === "setState"
        ? player.setState("hover")
        : player.resume();
      void pending.catch(() => undefined);

      (player as unknown as {
        contextChanged(state: "error"): void;
      }).contextChanged("error");

      await expect(pending).rejects.toBe(terminal);
      await expect(player.prepare()).rejects.toBe(terminal);
      await player.settled();
      expect(observations.playbackFailures).toEqual([
        "context-loss:render"
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
      contextChanged(state: "error"): void;
    }).contextChanged("error");
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
    await driveFrames(frames, () => originalBody.taken.includes(9), 20);
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

    await driveFrames(frames, () => originalBody.taken.includes(15), 24);
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

  it("buffers initial publications until activated with an authoritative graph", async () => {
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

    expect(observed).toEqual([]);
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
  operation: string
) {
  vi.stubGlobal("Worker", class {});
  vi.stubGlobal("VideoDecoder", class {});
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
  const terminal = new AvalPlaybackError(Object.freeze({
    code,
    message: "Playback could not continue.",
    operation
  }), 1);
  const observations = {
    playbackFailures: [] as string[],
    retirements: 0
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
    onRestart: () => undefined,
    onEvent: () => undefined,
    onFailure: () => undefined,
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
