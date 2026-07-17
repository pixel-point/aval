import { afterEach, describe, expect, it, vi } from "vitest";

const selection = vi.hoisted(() => ({
  opens: 0,
  rendererCreations: 0,
  rejectHighResources: false,
  rejectResourceCreations: 0,
  invalidPlan: false,
  rendererConstructionError: false,
  presentations: [] as Array<readonly [number, number, number, string]>
}));

vi.mock("../src/asset.js", () => {
  const rendition = (id: string, codec: string, width: number) => ({
    id,
    codec,
    bitDepth: 8,
    codedWidth: width,
    codedHeight: 16,
    bitrate: { average: 1_000, peak: 1_000 },
    alphaLayout: { type: "opaque", colorRect: [0, 0, width, 16] }
  });
  const renditions = [
    rendition("high", "avc1.640028", 32),
    rendition("low", "avc1.640020", 16)
  ];
  class Asset {
    public readonly manifest = {
      codec: "h264",
      canvas: { width: 16, height: 16, fit: "contain", pixelAspect: [1, 1] },
      frameRate: { numerator: 30, denominator: 1 },
      renditions,
      units: [{
        id: "idle-body",
        kind: "body",
        frameCount: 1,
        playback: "loop",
        ports: [{ id: "entry", entryFrame: 0, portalFrames: [0] }],
        chunks: renditions.map(({ id }) => ({
          rendition: id,
          chunkStart: id === "high" ? 0 : 1,
          chunkCount: 1
        }))
      }],
      initialState: "idle",
      states: [{ id: "idle", bodyUnit: "idle-body" }],
      edges: [],
      bindings: [],
      readiness: { bootstrapUnits: [], immediateEdges: [] },
      limits: {
        maxRuntimeBytes: 16_000_000,
        decodedPixelBytes: 2_048,
        persistentCacheBytes: 0,
        runtimeWorkingSetBytes: selection.invalidPlan ? 0 : 1_000_000
      }
    };
    public readonly blobs = renditions.map(({ id }, index) => ({
      rendition: id,
      unit: "idle-body",
      offset: 1_000 + index,
      length: 1,
      chunkStart: index,
      chunkCount: 1
    }));
    public readonly records = [];
    public async dispose(): Promise<void> {}
    public snapshot() {
      return {
        mode: "range",
        disposed: false,
        declaredFileBytes: 2_000,
        metadataBytes: 1_000,
        verifiedBytes: 0,
        residentBlobBytes: 0,
        activeTransportBodies: 0,
        pendingLoads: 0,
        interestedWaiters: 0
      };
    }
  }
  return {
    Asset: class {
      public static async open() {
        selection.opens += 1;
        return new Asset();
      }
    }
  };
});

vi.mock("../src/renderer.js", () => ({
  Renderer: class {
    readonly #codedWidth: number;
    readonly #canvas: { width: number; height: number };
    public constructor(
      canvas: { width: number; height: number },
      layout: { codedWidth: number },
      limits: { initialPresentation: {
        width: number;
        height: number;
        dpr: number;
        fit: string;
      } }
    ) {
      selection.rendererCreations += 1;
      if (selection.rendererConstructionError) throw new Error("WebGL construction failed");
      this.#codedWidth = layout.codedWidth;
      this.#canvas = canvas;
      const initial = limits.initialPresentation;
      selection.presentations.push([
        initial.width,
        initial.height,
        initial.dpr,
        initial.fit
      ]);
      canvas.width = Math.max(1, Math.round(initial.width * initial.dpr));
      canvas.height = Math.max(1, Math.round(initial.height * initial.dpr));
    }
    public snapshot() {
      return {
        cssWidth: 0,
        cssHeight: 0,
        backingWidth: 1,
        backingHeight: 1,
        effectiveDprX: 0,
        effectiveDprY: 0,
        contextLossCount: 0,
        contextRecoveryCount: 0,
        stagingBytes: 1,
        residentBytes: 0,
        textureBytes: 1,
        runtimeBytes: 3,
        pendingOperations: 0,
        sourceCopiesInFlight: 0,
        resourceCount: 4,
        contextListenerCount: 2
      };
    }
    public admit() {
      if (selection.rejectHighResources && this.#codedWidth === 32) {
        throw new RangeError("renderer resource byte cap exceeded");
      }
      if (selection.rendererCreations <= selection.rejectResourceCreations) {
        throw new RangeError("renderer resource byte cap exceeded");
      }
      return { textureBytes: 1, runtimeBytes: 3 };
    }
    public resize(): void {}
    public settled(): Promise<void> { return Promise.resolve(); }
    public dispose(): void { this.#canvas.width = 0; this.#canvas.height = 0; }
  }
}));

import { createPlayer } from "../src/player.js";

afterEach(() => {
  vi.unstubAllGlobals();
  selection.opens = 0;
  selection.rendererCreations = 0;
  selection.rejectHighResources = false;
  selection.rejectResourceCreations = 0;
  selection.invalidPlan = false;
  selection.rendererConstructionError = false;
  selection.presentations.length = 0;
});

describe("player rendition selection", () => {
  it("selects the second authored rendition when the first decoder pair is unsupported", async () => {
    const Worker = fakeWorker([
      [false, false],
      [true, true]
    ]);
    vi.stubGlobal("Worker", Worker);
    vi.stubGlobal("VideoDecoder", class {});
    const controller = new AbortController();
    const canvas = new EventTarget() as HTMLCanvasElement;
    const player = await createPlayer({
      canvas,
      platform: testPlatform(),
      initialPresentation: { width: 16, height: 16, dpr: 1, fit: null },
      baseUrl: "https://example.test/",
      sources: [{
        src: "motion.avl",
        codec: "avc1.640028",
        integrity: ""
      }],
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
      onFailure: () => undefined
    });
    player.activate();

    expect(player.snapshot(false).selectedRendition).toBe("low");
    expect(selection.opens).toBe(1);
    expect(Worker.instances()).toHaveLength(4);
    expect(selection.rendererCreations).toBe(1);
    await player.dispose();
  });

  it("never reports a state ready while visibility-suspended static", async () => {
    const controller = new AbortController();
    const player = await createPlayer({
      canvas: new EventTarget() as HTMLCanvasElement,
      platform: testPlatform(),
      initialPresentation: { width: 16, height: 16, dpr: 1, fit: null },
      baseUrl: "https://example.test/",
      sources: [{ src: "motion.avl", codec: "avc1.640028", integrity: "" }],
      credentials: "same-origin",
      signal: controller.signal,
      preparationTimeoutMs: 5_000,
      motion: "full",
      reduced: false,
      initialState: null,
      initialBody: false,
      visible: false,
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

    await expect(player.prepare()).resolves.toMatchObject({ mode: "static" });
    expect(player.readyFor("idle")).toBe(false);
    await player.dispose();
  });

  it("publishes recovery effects in graph order before resource retirement", async () => {
    const Worker = fakeWorker([[true, true]]);
    vi.stubGlobal("Worker", Worker);
    vi.stubGlobal("VideoDecoder", class {});
    const observed: string[] = [];
    let readiness = "metadataReady";
    let mode = "pending";
    const player = await createPlayer({
      canvas: new EventTarget() as HTMLCanvasElement,
      platform: testPlatform(),
      initialPresentation: { width: 16, height: 16, dpr: 1, fit: null },
      baseUrl: "https://example.test/",
      sources: [{ src: "motion.avl", codec: "avc1.640028", integrity: "" }],
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
      onReadiness: (value) => {
        readiness = value;
        if (value === "staticReady") mode = "static";
        if (value === "staticReady") observed.push(`readiness:${readiness}:${mode}`);
      },
      onAnimationResourcesRetired: () => {
        observed.push(`retired:${readiness}:${mode}`);
      },
      onDraw: () => undefined,
      onRestart: () => undefined,
      onEvent: (type) => {
        if (type === "fallback") observed.push(`fallback:${readiness}:${mode}`);
      },
      onFailure: () => undefined
    });
    player.activate();
    observed.length = 0;

    await expect(player.suspend("visibility-suspended")).resolves.toMatchObject({
      mode: "static",
      reason: "visibility-suspended"
    });
    expect(observed).toEqual([
      "readiness:staticReady:static",
      "fallback:staticReady:static",
      "retired:staticReady:static"
    ]);
    expect(Worker.instances()).toHaveLength(2);
    await player.dispose();
  });

  it("selects the lower rendition when the high plan cannot fit renderer resources", async () => {
    selection.rejectHighResources = true;
    const Worker = fakeWorker([
      [true, true],
      [true, true]
    ]);
    vi.stubGlobal("Worker", Worker);
    vi.stubGlobal("VideoDecoder", class {});
    const controller = new AbortController();
    const player = await createPlayer({
      canvas: new EventTarget() as HTMLCanvasElement,
      platform: testPlatform(),
      initialPresentation: { width: 16, height: 16, dpr: 1, fit: null },
      baseUrl: "https://example.test/",
      sources: [{ src: "motion.avl", codec: "avc1.640028", integrity: "" }],
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
      onFailure: () => undefined
    });
    player.activate();

    expect(player.snapshot(false).selectedRendition).toBe("low");
    expect(selection.opens).toBe(1);
    expect(Worker.instances()).toHaveLength(4);
    expect(selection.rendererCreations).toBe(2);
    expect(selection.presentations).toEqual([
      [16, 16, 1, "contain"],
      [16, 16, 1, "contain"]
    ]);
    await player.dispose();
  });

  it("reports every authored rendition rejection in ladder order", async () => {
    const Worker = fakeWorker([
      [false, false],
      [false, false]
    ]);
    vi.stubGlobal("Worker", Worker);
    vi.stubGlobal("VideoDecoder", class {});
    const controller = new AbortController();
    const player = await createPlayer({
      canvas: new EventTarget() as HTMLCanvasElement,
      platform: testPlatform(),
      initialPresentation: { width: 16, height: 16, dpr: 1, fit: null },
      baseUrl: "https://example.test/",
      sources: [{ src: "motion.avl", codec: "avc1.640028", integrity: "" }],
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
      onFailure: () => undefined
    });
    player.activate();

    const result = await player.prepare();
    expect(result).toMatchObject({
      mode: "static",
      report: {
        candidates: [
          { rendition: "high", rank: 0, outcome: "rejected" },
          { rendition: "low", rank: 1, outcome: "rejected" }
        ]
      }
    });
    expect(selection.opens).toBe(1);
    expect(Worker.instances()).toHaveLength(4);
    await player.dispose();
  });

  it("treats a decoder support-probe exception as terminal for source selection", async () => {
    const Worker = fakeWorker([["error", true]]);
    vi.stubGlobal("Worker", Worker);
    vi.stubGlobal("VideoDecoder", class {});
    const controller = new AbortController();
    const creation = createPlayer({
      canvas: new EventTarget() as HTMLCanvasElement,
      platform: testPlatform(),
      initialPresentation: { width: 16, height: 16, dpr: 1, fit: null },
      baseUrl: "https://example.test/",
      sources: [
        { src: "first.avl", codec: "avc1.640028", integrity: "" },
        { src: "second.avl", codec: "avc1.640028", integrity: "" }
      ],
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
      onFailure: () => undefined
    });

    await expect(creation).rejects.toThrow("AVAL decoder failed");
    expect(selection.opens).toBe(1);
    expect(Worker.instances()).toHaveLength(2);
  });

  it("treats asset-wide readiness declaration failure as terminal", async () => {
    selection.invalidPlan = true;
    const Worker = fakeWorker([[true, true]]);
    vi.stubGlobal("Worker", Worker);
    vi.stubGlobal("VideoDecoder", class {});
    await expect(createPlayer(selectionInput([
      { src: "first.avl", codec: "avc1.640028", integrity: "" },
      { src: "second.avl", codec: "avc1.640028", integrity: "" }
    ]))).rejects.toThrow(/resource declarations/u);
    expect(selection.opens).toBe(1);
    expect(Worker.instances()).toHaveLength(0);
  });

  it("treats a general renderer construction exception as source-terminal", async () => {
    selection.rendererConstructionError = true;
    const Worker = fakeWorker([[true, true]]);
    vi.stubGlobal("Worker", Worker);
    vi.stubGlobal("VideoDecoder", class {});
    await expect(createPlayer(selectionInput([
      { src: "first.avl", codec: "avc1.640028", integrity: "" },
      { src: "second.avl", codec: "avc1.640028", integrity: "" }
    ]))).rejects.toThrow("WebGL construction failed");
    expect(selection.opens).toBe(1);
    expect(Worker.instances()).toHaveLength(2);
  });

  it("opens the next source after every boolean codec probe is unsupported", async () => {
    const Worker = fakeWorker([
      [false, false],
      [false, false],
      [true, true]
    ]);
    vi.stubGlobal("Worker", Worker);
    vi.stubGlobal("VideoDecoder", class {});
    const player = await createPlayer(selectionInput([
      { src: "first.avl", codec: "avc1.640028", integrity: "" },
      { src: "second.avl", codec: "avc1.640028", integrity: "" }
    ]));
    expect(selection.opens).toBe(2);
    expect(player.snapshot(false).selectedRendition).toBe("high");
    expect(Worker.instances()).toHaveLength(6);
    await player.dispose();
  });

  it("opens the next source only after all pure renderer admissions reject", async () => {
    selection.rejectResourceCreations = 2;
    const Worker = fakeWorker([
      [true, true],
      [true, true],
      [true, true]
    ]);
    vi.stubGlobal("Worker", Worker);
    vi.stubGlobal("VideoDecoder", class {});
    const player = await createPlayer(selectionInput([
      { src: "first.avl", codec: "avc1.640028", integrity: "" },
      { src: "second.avl", codec: "avc1.640028", integrity: "" }
    ]));
    expect(selection.opens).toBe(2);
    expect(player.snapshot(false).selectedRendition).toBe("high");
    expect(Worker.instances()).toHaveLength(6);
    await player.dispose();
  });
});

function selectionInput(sources: readonly { src: string; codec: string; integrity: string }[]) {
  return {
    canvas: new EventTarget() as HTMLCanvasElement,
    platform: testPlatform(),
    initialPresentation: { width: 16, height: 16, dpr: 1, fit: null },
    baseUrl: "https://example.test/",
    sources,
    credentials: "same-origin" as const,
    signal: new AbortController().signal,
    preparationTimeoutMs: 5_000,
    motion: "full" as const,
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
  };
}

type WorkerSupport = boolean | "error";
type DecoderPairSupport = readonly [WorkerSupport, WorkerSupport];

function fakeWorker(support: readonly DecoderPairSupport[]) {
  const all: FakeWorker[] = [];
  class FakeWorker extends EventTarget {
    public constructor() {
      super();
      all.push(this);
    }
    public postMessage(message: unknown): void {
      if ((message as { t?: string }).t !== "configure") return;
      const index = all.indexOf(this);
      const supported = support[Math.floor(index / 2)]?.[index % 2] ?? false;
      queueMicrotask(() => {
        if (supported === "error") this.dispatchEvent(new Event("error"));
        else this.dispatchEvent(new MessageEvent("message", {
          data: { t: "configured", supported }
        }));
      });
    }
    public terminate(): void {}
  }
  return Object.assign(FakeWorker, { instances: () => [...all] });
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
