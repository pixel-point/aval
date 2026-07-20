import { afterEach, describe, expect, it, vi } from "vitest";
import { AvalPlaybackError } from "../src/errors.js";

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
    alphaLayout: { type: "opaque", colorRect: [0, 0, 16, 16] }
  });
  const renditions = [
    rendition("high", "avc1.640028", 32),
    rendition("low", "avc1.640020", 16)
  ];
  class Asset {
    public readonly manifest = {
      formatVersion: "1.1",
      generator: "player-selection-test",
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
      renditions,
      units: [{
        id: "idle-body",
        kind: "body",
        frameCount: 1,
        playback: "finite",
        ports: [{ id: "entry", entryFrame: 0, portalFrames: [0] }],
        chunks: renditions.map(({ id }) => ({
          rendition: id,
          chunkStart: id === "high" ? 0 : 1,
          chunkCount: 1,
          frameCount: 1,
          sha256: "0".repeat(64)
        }))
      }],
      initialState: "idle",
      states: [{ id: "idle", bodyUnit: "idle-body" }],
      edges: [],
      bindings: [],
      readiness: {
        policy: "all-routes",
        bootstrapUnits: ["idle-body"],
        immediateEdges: []
      },
      limits: {
        maxCompiledBytes: 16_000_000,
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
    public readonly records = renditions.map((_rendition, index) => ({
      offset: 1_000 + index,
      length: 1,
      presentationTimestamp: 0,
      duration: 1,
      randomAccess: true,
      displayedFrameCount: 1
    }));
    public async unitBytes(): Promise<Uint8Array<ArrayBuffer>> {
      return new Uint8Array([1]);
    }
    public chunkBytes(): ArrayBuffer {
      return new Uint8Array([1]).buffer;
    }
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

vi.mock("../src/codec-validator.js", () => ({
  createCodecValidator: () => ({
    validate: () => undefined,
    complete: () => undefined
  })
}));

vi.mock("../src/decoder.js", () => ({
  Decoder: class {
    public encodedBytes = 0;
    readonly #worker: { readonly supported: WorkerSupport };
    #diagnostic: Readonly<Record<string, unknown>> | null = null;
    #run = 0;

    public constructor() {
      const WorkerConstructor = globalThis.Worker as unknown as new () => {
        readonly supported: WorkerSupport;
      };
      this.#worker = new WorkerConstructor();
    }

    public get available(): boolean { return true; }

    public async supported(): Promise<boolean> {
      if (this.#worker.supported === "error") {
        this.#diagnostic = Object.freeze({
          phase: "frame-transfer",
          code: "transport",
          run: null,
          decodeOrdinal: null,
          exception: Object.freeze({ name: "Error", message: "worker failed" }),
          firstFrame: null
        });
        throw new Error("worker failed");
      }
      if (!this.#worker.supported) {
        this.#diagnostic = Object.freeze({
          phase: "probe",
          code: "unsupported-config",
          run: null,
          decodeOrdinal: null,
          exception: Object.freeze({
            name: "Error",
            message: "AVAL decoder configuration is unsupported"
          }),
          firstFrame: null
        });
      }
      return this.#worker.supported;
    }

    public failure(): Promise<never> {
      return new Promise<never>(() => undefined);
    }

    public terminalError(): Error | null { return null; }

    public createRun(samples: readonly { displayedFrames: number }[]) {
      const generation = ++this.#run;
      const frameCount = samples.reduce(
        (total, sample) => total + sample.displayedFrames,
        0
      );
      return {
        generation,
        frameCount,
        openFrames: 0,
        outstanding: 0,
        closed: false,
        ready: async () => undefined,
        take: async (index: number) => ({ index }),
        release: () => undefined,
        complete: async () => undefined,
        close: () => undefined
      };
    }

    public snapshot() {
      return {
        workerCount: 1,
        openFrames: 0,
        openFrameBytes: 0,
        diagnostic: this.#diagnostic
      };
    }

    public dispose(): void {}
  }
}));

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
        backendDetails: Object.freeze({
          kind: "webgl2" as const,
          uploadMode: "native-probing" as const,
          nativeProbeAttempts: 0,
          probeReadbackBytes: 0,
          nativeProbeInFlight: false
        }),
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
    public async draw(): Promise<void> {}
    public async store(): Promise<void> {}
    public async drawStored(): Promise<void> {}
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
    const diagnosticPublications: unknown[][] = [];
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
      onFailure: () => undefined,
      onPlaybackFailure: defaultPlaybackFailure,
      onDecoderDiagnostics: (diagnostics) => {
        diagnosticPublications.push([...diagnostics]);
      }
    });
    player.activate();

    expect(player.snapshot(false).selectedRendition).toBe("low");
    expect(selection.opens).toBe(1);
    expect(Worker.instances()).toHaveLength(4);
    expect(selection.rendererCreations).toBe(1);
    expect(diagnosticPublications.some((diagnostics) =>
      diagnostics.length === 2 && diagnostics.every((diagnostic) =>
        typeof diagnostic === "object" && diagnostic !== null &&
        (diagnostic as { code?: unknown }).code === "unsupported-config" &&
        (diagnostic as { sourceIndex?: unknown }).sourceIndex === 0 &&
        (diagnostic as { rendition?: unknown }).rendition === "high"
      )
    )).toBe(true);
    expect(diagnosticPublications.at(-1)).toHaveLength(2);
    expect(player.snapshot(false).decoderDiagnostics).toEqual(
      diagnosticPublications.at(-1)
    );
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
      onFailure: () => undefined,
      onPlaybackFailure: defaultPlaybackFailure
    });
    player.activate();

    await expect(player.prepare()).resolves.toMatchObject({ mode: "static" });
    expect(player.readyFor("idle")).toBe(false);
    await player.dispose();
  });

  it("publishes policy readiness before resource retirement without a fallback event", async () => {
    const Worker = fakeWorker([[true, true]]);
    vi.stubGlobal("Worker", Worker);
    vi.stubGlobal("VideoDecoder", class {});
    const observed: string[] = [];
    let playbackFailures = 0;
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
      onEvent: () => undefined,
      onFailure: () => undefined,
      onPlaybackFailure: (code, operation) => {
        playbackFailures += 1;
        return defaultPlaybackFailure(code, operation);
      }
    });
    player.activate();
    observed.length = 0;

    await expect(player.suspend("visibility-suspended")).resolves.toMatchObject({
      mode: "static",
      reason: "visibility-suspended"
    });
    expect(observed).toEqual([
      "readiness:staticReady:static",
      "retired:staticReady:static"
    ]);
    expect(playbackFailures).toBe(0);
    expect(Worker.instances()).toHaveLength(2);
    await player.dispose();
  });

  it("keeps renderer resource admission failure terminal", async () => {
    selection.rejectHighResources = true;
    const Worker = fakeWorker([
      [true, true],
      [true, true]
    ]);
    vi.stubGlobal("Worker", Worker);
    vi.stubGlobal("VideoDecoder", class {});
    const controller = new AbortController();
    const terminal = playbackError("resource-rejection", "prepare", 7);
    const failures: string[] = [];
    const creation = createPlayer({
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
      onFailure: () => undefined,
      onPlaybackFailure: (code, operation) => {
        failures.push(`${code}:${operation}`);
        return terminal;
      }
    });

    await expect(creation).rejects.toBe(terminal);
    expect(failures).toEqual(["resource-rejection:prepare"]);
    expect(selection.opens).toBe(1);
    expect(Worker.instances()).toHaveLength(2);
    expect(selection.rendererCreations).toBe(1);
    expect(selection.presentations).toEqual([
      [16, 16, 1, "contain"]
    ]);
  });

  it("rejects an invalid source codec before opening or probing", async () => {
    const Worker = fakeWorker([[true, true]]);
    vi.stubGlobal("Worker", Worker);
    vi.stubGlobal("VideoDecoder", class {});
    const terminal = playbackError("unsupported-profile", "prepare", 8);
    const failures: string[] = [];

    await expect(createPlayer({
      ...selectionInput([
        { src: "invalid.avl", codec: "definitely-not-h264", integrity: "" },
        { src: "second.avl", codec: "avc1.640028", integrity: "" }
      ]),
      onPlaybackFailure: (code, operation) => {
        failures.push(`${code}:${operation}`);
        return terminal;
      }
    })).rejects.toBe(terminal);

    expect(failures).toEqual(["unsupported-profile:prepare"]);
    expect(selection.opens).toBe(0);
    expect(Worker.instances()).toHaveLength(0);
    expect(selection.rendererCreations).toBe(0);
  });

  it("raises one unsupported-profile failure before probing when WebCodecs is missing", async () => {
    const Worker = fakeWorker([[true, true]]);
    vi.stubGlobal("Worker", Worker);
    const terminal = playbackError("unsupported-profile", "prepare", 3);
    const failures: string[] = [];
    const input = selectionInput([
      { src: "first.avl", codec: "avc1.640028", integrity: "" },
      { src: "second.avl", codec: "avc1.640028", integrity: "" }
    ]);
    const creation = createPlayer({
      ...input,
      platform: {
        ...input.platform,
        VideoDecoder: null,
        VideoFrame: null
      },
      onPlaybackFailure: (code, operation) => {
        failures.push(`${code}:${operation}`);
        return terminal;
      }
    });

    await expect(creation).rejects.toBe(terminal);
    expect(failures).toEqual(["unsupported-profile:prepare"]);
    expect(selection.opens).toBe(1);
    expect(Worker.instances()).toHaveLength(0);
    expect(selection.rendererCreations).toBe(0);
  });

  it("raises one canonical unsupported-profile error after every rendition rejects", async () => {
    const Worker = fakeWorker([
      [false, false],
      [false, false]
    ]);
    vi.stubGlobal("Worker", Worker);
    vi.stubGlobal("VideoDecoder", class {});
    const controller = new AbortController();
    const terminal = playbackError("unsupported-profile", "prepare", 3);
    const failures: string[] = [];
    const creation = createPlayer({
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
      onFailure: () => undefined,
      onPlaybackFailure: (code, operation) => {
        failures.push(`${code}:${operation}`);
        return terminal;
      }
    });

    await expect(creation).rejects.toBe(terminal);
    expect(failures).toEqual(["unsupported-profile:prepare"]);
    expect(selection.opens).toBe(1);
    expect(Worker.instances()).toHaveLength(4);
  });

  it("treats a decoder support-probe exception as terminal for source selection", async () => {
    const Worker = fakeWorker([["error", true]]);
    vi.stubGlobal("Worker", Worker);
    vi.stubGlobal("VideoDecoder", class {});
    const controller = new AbortController();
    const terminal = playbackError("worker-decode-failure", "prepare", 4);
    const failures: string[] = [];
    const decoderDiagnostics: unknown[][] = [];
    const creation = createPlayer({
      canvas: new EventTarget() as HTMLCanvasElement,
      platform: testPlatform(),
      initialPresentation: { width: 16, height: 16, dpr: 1, fit: null },
      baseUrl: "https://example.test/",
      sources: [
        {
          src: "first.avl",
          codec: "avc1.640028",
          integrity: "",
          sourceIndex: 1
        },
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
      onFailure: () => undefined,
      onPlaybackFailure: (code, operation) => {
        failures.push(`${code}:${operation}`);
        return terminal;
      },
      onDecoderDiagnostics: (diagnostics) => {
        decoderDiagnostics.push([...diagnostics]);
      }
    });

    await expect(creation).rejects.toBe(terminal);
    expect(failures).toEqual(["worker-decode-failure:prepare"]);
    expect(selection.opens).toBe(1);
    expect(Worker.instances()).toHaveLength(2);
    expect(decoderDiagnostics.at(-1)).toMatchObject([{
      sourceIndex: 1,
      rendition: "high",
      codec: "avc1.640028",
      unit: null,
      lane: 0,
      phase: "frame-transfer",
      code: "transport",
      run: null,
      decodeOrdinal: null
    }]);
  });

  it("treats asset-wide readiness declaration failure as terminal", async () => {
    selection.invalidPlan = true;
    const Worker = fakeWorker([[true, true]]);
    vi.stubGlobal("Worker", Worker);
    vi.stubGlobal("VideoDecoder", class {});
    const terminal = playbackError("resource-rejection", "prepare", 5);
    await expect(createPlayer({ ...selectionInput([
      { src: "first.avl", codec: "avc1.640028", integrity: "" },
      { src: "second.avl", codec: "avc1.640028", integrity: "" }
    ]), onPlaybackFailure: () => terminal })).rejects.toBe(terminal);
    expect(selection.opens).toBe(1);
    expect(Worker.instances()).toHaveLength(0);
  });

  it("treats a general renderer construction exception as source-terminal", async () => {
    selection.rendererConstructionError = true;
    const Worker = fakeWorker([[true, true]]);
    vi.stubGlobal("Worker", Worker);
    vi.stubGlobal("VideoDecoder", class {});
    const terminal = playbackError("renderer-failure", "prepare", 6);
    await expect(createPlayer({ ...selectionInput([
      { src: "first.avl", codec: "avc1.640028", integrity: "" },
      { src: "second.avl", codec: "avc1.640028", integrity: "" }
    ]), onPlaybackFailure: () => terminal })).rejects.toBe(terminal);
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

  it("does not open another source after renderer admission rejects", async () => {
    selection.rejectResourceCreations = 2;
    const Worker = fakeWorker([
      [true, true],
      [true, true],
      [true, true]
    ]);
    vi.stubGlobal("Worker", Worker);
    vi.stubGlobal("VideoDecoder", class {});
    const terminal = playbackError("resource-rejection", "prepare", 9);
    await expect(createPlayer({
      ...selectionInput([
        { src: "first.avl", codec: "avc1.640028", integrity: "" },
        { src: "second.avl", codec: "avc1.640028", integrity: "" }
      ]),
      onPlaybackFailure: () => terminal
    })).rejects.toBe(terminal);
    expect(selection.opens).toBe(1);
    expect(Worker.instances()).toHaveLength(2);
    expect(selection.rendererCreations).toBe(1);
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
    onFailure: () => undefined,
    onPlaybackFailure: defaultPlaybackFailure
  };
}

function defaultPlaybackFailure(
  code: ConstructorParameters<typeof AvalPlaybackError>[0]["code"],
  operation: string
): AvalPlaybackError {
  return playbackError(code, operation, 1);
}

function playbackError(
  code: ConstructorParameters<typeof AvalPlaybackError>[0]["code"],
  operation: string,
  generation: number
): AvalPlaybackError {
  return new AvalPlaybackError(Object.freeze({
    code,
    message: "Playback could not continue.",
    operation
  }), generation);
}

type WorkerSupport = boolean | "error";
type DecoderPairSupport = readonly [WorkerSupport, WorkerSupport];

function fakeWorker(support: readonly DecoderPairSupport[]) {
  const all: FakeWorker[] = [];
  class FakeWorker extends EventTarget {
    public readonly supported: WorkerSupport;
    public constructor() {
      super();
      all.push(this);
      const index = all.length - 1;
      this.supported = support[Math.floor(index / 2)]?.[index % 2] ?? false;
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
