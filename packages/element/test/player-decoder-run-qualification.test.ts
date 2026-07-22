import { afterEach, describe, expect, it, vi } from "vitest";
import { AvalPlaybackError } from "../src/errors.js";

const runtime = vi.hoisted(() => ({
  runs: [] as Array<{
    id: number;
    label: number;
    closed: boolean;
    taken: number[];
  }>,
  stores: [] as Array<{
    group: string;
    index: number;
    runId: number;
    newDecoderRun: boolean;
  }>,
  draws: [] as Array<{
    index: number;
    runId: number;
    newDecoderRun: boolean;
  }>
}));

vi.mock("../src/asset.js", () => {
  const units = [
    body("idle-body", 0),
    body("hover-body", 1)
  ];
  class Asset {
    public readonly manifest = {
      formatVersion: "1.1",
      generator: "decoder-run-qualification-test",
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
        codec: "avc1.42E020",
        bitDepth: 8,
        codedWidth: 16,
        codedHeight: 16,
        bitrate: { average: 1_000, peak: 1_000 },
        alphaLayout: { type: "opaque", colorRect: [0, 0, 16, 16] }
      }],
      units,
      initialState: "idle",
      states: [
        { id: "idle", bodyUnit: "idle-body" },
        { id: "hover", bodyUnit: "hover-body" }
      ],
      edges: [{
        id: "idle-hover-cut",
        from: "idle",
        to: "hover",
        start: { type: "cut", targetPort: "entry", maxWaitFrames: 1 },
        targetRunwayFrames: 2,
        trigger: { type: "event", name: "hover" },
        continuity: "cut"
      }],
      bindings: [],
      readiness: {
        policy: "all-routes",
        bootstrapUnits: ["idle-body", "hover-body"],
        immediateEdges: ["idle-hover-cut"]
      },
      limits: {
        maxCompiledBytes: 16_000_000,
        maxRuntimeBytes: 16_000_000,
        decodedPixelBytes: 2_048,
        persistentCacheBytes: 2_048,
        runtimeWorkingSetBytes: 1_000_000
      }
    };
    public readonly blobs = units.map((unit, index) => ({
      rendition: "main",
      unit: unit.id,
      offset: 1_000 + index,
      length: 1,
      chunkStart: index,
      chunkCount: 1
    }));
    public readonly records = units.map((_unit, index) => ({
      byteOffset: 1_000 + index,
      byteLength: 1,
      presentationTimestamp: index * 100,
      duration: 1,
      randomAccess: true,
      displayedFrameCount: 4
    }));
    public async unitBytes(): Promise<Uint8Array<ArrayBuffer>> {
      return new Uint8Array(1);
    }
    public chunkBytes(_rendition: string, unit: string): ArrayBuffer {
      return new Uint8Array([unit === "idle-body" ? 0 : 1]).buffer;
    }
    public async dispose(): Promise<void> {}
    public snapshot() {
      return {
        mode: "range",
        disposed: false,
        declaredFileBytes: 2_000,
        metadataBytes: 1_000,
        verifiedBytes: 2,
        residentBlobBytes: 2,
        activeTransportBodies: 0,
        pendingLoads: 0,
        interestedWaiters: 0
      };
    }
  }
  return { Asset: class { public static async open() { return new Asset(); } } };

  function body(id: string, chunkStart: number) {
    return {
      id,
      kind: "body",
      playback: "loop",
      frameCount: 4,
      ports: [{ id: "entry", entryFrame: 0, portalFrames: [0] }],
      chunks: [{
        rendition: "main",
        chunkStart,
        chunkCount: 1,
        frameCount: 4,
        sha256: "0".repeat(64)
      }]
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
    #run = 0;
    public get available(): boolean { return true; }
    public async supported(): Promise<boolean> { return true; }
    public failure(): Promise<never> {
      return new Promise<never>(() => undefined);
    }
    public terminalError(): Error | null { return null; }
    public createRun(samples: readonly {
      timestamp: number;
      displayedFrames: number;
    }[]) {
      const generation = ++this.#run;
      const tracked = {
        id: runtime.runs.length + 1,
        label: samples[0]!.timestamp,
        closed: false,
        taken: [] as number[]
      };
      runtime.runs.push(tracked);
      return {
        generation,
        frameCount: samples[0]!.displayedFrames,
        openFrames: 0,
        outstanding: 0,
        get closed() { return tracked.closed; },
        ready: async () => undefined,
        take: async (index: number) => {
          tracked.taken.push(index);
          return { index, runId: tracked.id };
        },
        release: () => undefined,
        complete: async () => undefined,
        close: () => { tracked.closed = true; }
      };
    }
    public snapshot() {
      return {
        workerCount: 1,
        openFrames: 0,
        openFrameBytes: 0,
        diagnostic: null
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
        backendDetails: {
          kind: "webgl2" as const,
          uploadMode: "native-probing" as const,
          nativeProbeAttempts: 0,
          probeReadbackBytes: 0,
          nativeProbeInFlight: false
        },
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
        failure: null
      };
    }
    public async draw(
      frame: { index: number; runId: number },
      newDecoderRun: boolean
    ): Promise<void> {
      runtime.draws.push({
        index: frame.index,
        runId: frame.runId,
        newDecoderRun
      });
    }
    public async store(
      group: string,
      index: number,
      frame: { runId: number },
      newDecoderRun: boolean
    ): Promise<void> {
      runtime.stores.push({ group, index, runId: frame.runId, newDecoderRun });
    }
    public async drawStored(): Promise<void> {}
    public resize(): void {}
    public settled(): Promise<void> { return Promise.resolve(); }
    public dispose(): void {}
  }
}));

import { createPlayer } from "../src/player.js";

afterEach(() => {
  runtime.runs.length = 0;
  runtime.stores.length = 0;
  runtime.draws.length = 0;
  vi.unstubAllGlobals();
});

describe("player decoder-run qualification", () => {
  it("survives a replacement presented first from resident cut frames", async () => {
    vi.stubGlobal("Worker", class {});
    vi.stubGlobal("VideoDecoder", class {});
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    const player = await createPlayer({
      canvas: new EventTarget() as HTMLCanvasElement,
      platform: platform(),
      initialPresentation: { width: 16, height: 16, dpr: 1, fit: null },
      baseUrl: "https://example.test/",
      sources: [{ src: "motion.avl", codec: "h264", integrity: "" }],
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
      onPlaybackFailure: (code, operation) => new AvalPlaybackError({
        code,
        message: "Playback could not continue.",
        operation
      }, 1)
    });
    player.activate();
    await player.prepare();

    expect(runtime.stores.map(({ index, newDecoderRun }) => ({
      index,
      newDecoderRun
    }))).toEqual([
      { index: 0, newDecoderRun: true },
      { index: 1, newDecoderRun: false }
    ]);

    const idle = runtime.runs.find(({ label, closed }) =>
      label === 0 && !closed
    )!;
    await drive(frames, () => runtime.draws.some(
      ({ runId, index }) => runId === idle.id && index === 0
    ));
    const request = player.setState("hover");
    await eventually(() => runtime.runs.some(
      ({ label, closed }) => label === 100 && !closed
    ));
    const hover = runtime.runs.findLast(({ label, closed }) =>
      label === 100 && !closed
    )!;
    await drive(frames, () => runtime.draws.filter(
      ({ runId }) => runId === hover.id
    ).length >= 2);

    expect(runtime.draws.filter(({ runId }) => runId === hover.id).slice(0, 2))
      .toEqual([
        { index: 2, runId: hover.id, newDecoderRun: true },
        { index: 3, runId: hover.id, newDecoderRun: false }
      ]);
    await expect(request).resolves.toBeUndefined();
    await player.dispose();
  });
});

async function drive(
  frames: FrameRequestCallback[],
  complete: () => boolean
): Promise<void> {
  for (let attempt = 0; attempt < 40 && !complete(); attempt += 1) {
    await Promise.resolve();
    frames.shift()?.(performance.now() + 10_000 + attempt * 100);
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

function platform() {
  return {
    fetch: globalThis.fetch.bind(globalThis),
    Worker: globalThis.Worker ?? null,
    VideoDecoder: globalThis.VideoDecoder ?? null,
    VideoFrame: globalThis.VideoFrame ?? class {} as unknown as typeof VideoFrame,
    requestAnimationFrame: globalThis.requestAnimationFrame.bind(globalThis),
    cancelAnimationFrame: globalThis.cancelAnimationFrame.bind(globalThis),
    now: () => performance.now(),
    setTimeout: (callback: () => void, delay: number) =>
      globalThis.setTimeout(callback, delay) as unknown as number,
    clearTimeout: (handle: number) => globalThis.clearTimeout(handle),
    crypto: globalThis.crypto
  };
}
