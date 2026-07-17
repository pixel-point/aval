import { afterEach, describe, expect, it, vi } from "vitest";

const media = vi.hoisted(() => ({
  runs: [] as Array<{
    label: number;
    closed: boolean;
    ready: boolean;
    taken: number[];
  }>,
  holding: null as {
    label: number;
    closed: boolean;
    ready: boolean;
    taken: number[];
  } | null,
  releaseBlocked: [] as Array<() => void>,
  autoReleaseBlocked: true,
  forceBlockedTransitions: false
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
    { id: "idle-later", kind: "bridge", frameCount: 16, chunks: [span(7)] }
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
        { id: "later", bodyUnit: "later-body" }
      ],
      edges: [
        {
          id: "idle-hover-edge",
          from: "idle",
          to: "hover",
          start: {
            type: "portal",
            sourcePort: "entry",
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
    public async dispose(): Promise<void> {}
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
        { id: "later", entryFrame: 0, portalFrames: [8] }
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
    public async supported(): Promise<boolean> { return true; }
    public createRun(samples: readonly { timestamp: number; displayedFrames: number }[]) {
      const label = samples[0]!.timestamp;
      const holds = label === 0 && media.holding === null;
      const block = (label === 300 || label === 500 || label === 700) && (
        media.forceBlockedTransitions || media.holding?.closed === false
      );
      const tracked = { label, closed: false, ready: false, taken: [] as number[] };
      media.runs.push(tracked);
      if (holds) media.holding = tracked;
      let rejectReadiness: ((reason?: unknown) => void) | undefined;
      const readiness = block
        ? new Promise<void>((resolve, reject) => {
            rejectReadiness = reject;
            media.releaseBlocked.push(() => {
              tracked.ready = true;
              resolve();
            });
          })
        : Promise.resolve().then(() => { tracked.ready = true; });
      return {
        generation: media.runs.length,
        frameCount: samples[0]!.displayedFrames,
        openFrames: 0,
        outstanding: 0,
        closed: false,
        ready: () => readiness,
        take: async (index: number) => {
          tracked.taken.push(index);
          return { index };
        },
        release: () => undefined,
        complete: async () => undefined,
        close: () => {
          if (tracked.closed) return;
          tracked.closed = true;
          rejectReadiness?.(new DOMException("closed", "AbortError"));
          if (media.holding === tracked) {
            media.holding = null;
            if (media.autoReleaseBlocked) {
              for (const release of media.releaseBlocked.splice(0)) release();
            }
          }
        }
      };
    }
    public snapshot() { return { workerCount: 1, openFrames: 0, openFrameBytes: 0 }; }
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
    public async draw(): Promise<void> {}
    public async store(): Promise<void> {}
    public async drawStored(): Promise<void> {}
    public resize(): void {}
    public settled(): Promise<void> { return Promise.resolve(); }
    public dispose(): void {}
  }
}));

import { createPlayer } from "../src/player.js";

afterEach(() => {
  media.runs.length = 0;
  media.holding = null;
  media.releaseBlocked.length = 0;
  media.autoReleaseBlocked = true;
  media.forceBlockedTransitions = false;
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
      onFailure: () => undefined
    });
    player.activate();
    await player.prepare();
    await eventually(() => lastRun(0) !== undefined);

    expect(media.runs.map(({ label }) => label)).toEqual([100, 0]);
    expect(lastRun(200)).toBeUndefined();
    expect(lastRun(300)).toBeUndefined();
    await player.dispose();
  });

  it("preempts and restarts a >RING intro body behind a pending departure", async () => {
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
      onFailure: (code) => events.push(`failure:${code}`)
    });
    player.activate();
    await player.prepare();
    await eventually(() => lastRun(0) !== undefined);
    const originalBody = lastRun(0)!;
    const bridgeRuns = media.runs.filter(({ label }) => label === 300).length;
    const request = player.setState("hover");
    await eventually(() =>
      media.runs.filter(({ label }) => label === 300).length > bridgeRuns
    );

    const prioritizedBridge = lastRun(300)!;
    expect(originalBody.closed).toBe(false);
    expect(prioritizedBridge.ready).toBe(false);
    expect(prioritizedBridge.closed).toBe(false);
    expect(media.runs.indexOf(originalBody)).toBeLessThan(
      media.runs.indexOf(prioritizedBridge)
    );
    expect(frames.length, JSON.stringify(player.snapshot(false))).toBeGreaterThan(0);
    await driveFrames(frames, () => transitionStarted);
    expect(originalBody.closed).toBe(true);
    expect(prioritizedBridge.ready).toBe(true);
    expect(
      transitionStarted,
      `${events.join(",")}:${JSON.stringify(player.snapshot(true))}`
    ).toBe(true);
    expect(events.some((event) => event.startsWith("failure:"))).toBe(false);
    expect(events).not.toContain("underflow");

    await player.dispose();
    await expect(request).rejects.toMatchObject({ name: "AbortError" });
  });

  it("holds same-boundary replacement and resumes before a later route", async () => {
    vi.stubGlobal("Worker", class {});
    vi.stubGlobal("VideoDecoder", class {});
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    media.autoReleaseBlocked = false;
    media.forceBlockedTransitions = true;
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
      onFailure: (code) => events.push(`failure:${code}`)
    });
    player.activate();
    await player.prepare();
    await eventually(() => lastRun(0) !== undefined);
    const originalBody = lastRun(0)!;
    const outgoing = player.setState("hover");
    void outgoing.catch(() => undefined);
    await eventually(() => lastRun(300) !== undefined);
    await driveFrames(frames, () => originalBody.closed);
    expect(originalBody.closed).toBe(true);
    expect(lastRun(300)?.ready).toBe(false);
    await driveFrames(frames, () => false, 4);
    expect(events).not.toContain("underflow");

    const replacement = player.setState("other");
    void replacement.catch(() => undefined);
    await eventually(() => lastRun(500) !== undefined);
    await driveFrames(frames, () => false, 4);
    expect(lastRun(500)?.ready).toBe(false);
    expect(media.runs.filter(({ label }) => label === 0)).toHaveLength(1);
    expect(events.some((event) => event.startsWith("failure:"))).toBe(false);
    expect(events).not.toContain("underflow");

    const laterReplacement = player.setState("later");
    void laterReplacement.catch(() => undefined);
    await eventually(() => lastRun(700) !== undefined);
    await driveFrames(frames, () => (
      media.runs.filter(({ label }) => label === 0).length >= 2 &&
      (lastRun(0)?.taken.length ?? 0) >= 2
    ));
    const resumed = lastRun(0)!;
    expect(resumed).not.toBe(originalBody);
    expect(resumed.taken.slice(0, 2)).toEqual([0, 1]);
    expect(lastRun(700)?.ready).toBe(false);
    expect(events.some((event) => event.startsWith("failure:"))).toBe(false);
    expect(events).not.toContain("underflow");

    const returnToIdle = player.setState("idle");
    await driveFrames(frames, () => false, 4);
    await player.dispose();
    const outcomes = await Promise.allSettled([
      outgoing,
      replacement,
      laterReplacement,
      returnToIdle
    ]);
    expect(outcomes.map(({ status }) => status)).toEqual([
      "rejected",
      "rejected",
      "rejected",
      "fulfilled"
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
      onFailure: () => observed.push("failure")
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
