import {
  writeCanonicalAsset,
  type CanonicalAssetInputV01,
  type RenditionV01
} from "@rendered-motion/format";
import {
  MotionGraphEngine,
  type MotionGraphResult
} from "@rendered-motion/graph";
import { afterEach, describe, expect, it } from "vitest";

import type {
  DecoderWorkerConfigureOptions,
  DecoderWorkerWaitOptions,
  ManagedDecoderWorkerFrame
} from "../decoder-worker/client.js";
import type {
  DecoderWorkerLimits,
  DecoderWorkerMetrics,
  DecoderWorkerSample
} from "../decoder-worker/protocol.js";
import {
  installRuntimeAssetCatalog,
  type RuntimeAssetCatalog
} from "./asset-catalog.js";
import { BrowserOpaqueCandidateHub } from "./browser-opaque-candidate-hub.js";
import { BrowserOpaquePlaybackSession } from "./browser-opaque-playback-session.js";
import { DecodeTimeline } from "./decode-timeline.js";
import type { IntegratedCandidateAttemptContext } from "./integrated-player-contracts.js";
import { createIntegratedActivationPresentation } from "./integrated-player-support.js";
import { createInteractionCachePlan } from "./interaction-cache-plan.js";
import type {
  OpaqueCandidateActivationInput,
  OpaqueCandidateReadinessSessionInput,
  OpaqueCandidateWorker
} from "./opaque-candidate-factory.js";
import type {
  OpaqueFrameRenderer,
  RenderFrameHandle,
  ResidentFrameHandle,
  StreamingFrameHandle
} from "./opaque-frame-renderer.js";
import {
  PathScheduler,
  type PathSchedulerSnapshot
} from "./path-scheduler.js";
import {
  createOpaqueRenditionCandidates,
  inspectOpaqueRenditionCandidate
} from "./rendition-selection.js";
import { createRuntimeResourcePlan } from "./resource-plan.js";
import { evaluateAllRoutesReadiness } from "./readiness-evaluator.js";
import {
  passingEvidence,
  readinessFixture
} from "./readiness-test-fixture.js";
import { WorkerSampleFactory } from "./worker-samples.js";

const LIMITS: Readonly<DecoderWorkerLimits> = Object.freeze({
  maxDecodeQueueSize: 8,
  maxPendingSamples: 12,
  maxOutstandingFrames: 12,
  maxDecodedBytes: 12 * 32 * 32 * 4
});

const openHarnesses = new Set<BrowserSessionHarness>();

afterEach(async () => {
  for (const harness of openHarnesses) {
    await harness.dispose();
    expect(harness.worker.openFrames).toBe(0);
    expect(harness.playbackSnapshot().pendingPromises).toBe(0);
  }
  openHarnesses.clear();
});

describe("browser playback phase ownership", () => {
  it("keeps intro/body identity adjacent in the real browser composition harness", async () => {
    const harness = await BrowserSessionHarness.create();

    await harness.tick();
    await harness.tick();
    await harness.tick();

    expect(harness.tags()).toEqual([
      "intro:idle:intro:0",
      "intro:idle:intro:1",
      "intro:idle:intro:2",
      "body:idle:idle-body:0"
    ]);
    expect(harness.worker.openFrames).toBeLessThanOrEqual(6);
    expect(harness.renderer.draws).toHaveLength(4);
    await harness.dispose();
    expect(harness.worker.openFrames).toBe(0);
  });

  it("retires an in-flight normal route without stealing its source reservation", async () => {
    const harness = await BrowserSessionHarness.createAtBodyZero();
    await harness.request("loading");
    const upload = harness.renderer.gateNextUpload();

    const sourceOne = await harness.tick({ settleAfter: false });
    expect(sourceOne.presentation).toMatchObject({
      kind: "body",
      state: "idle",
      frameIndex: 1
    });
    await upload.entered;
    const cancellation = harness.request("idle", { settle: false });
    upload.release();
    await cancellation;
    await harness.settle();

    expect(harness.schedulerSnapshot()).toMatchObject({
      pendingEdge: null,
      displayedSource: { occurrence: 0n, frame: 1 }
    });
    const adjacent = await harness.tick();
    expect(adjacent.presentation).toMatchObject({
      kind: "body",
      state: "idle",
      frameIndex: 2
    });
    expect(harness.tags().some((tag) => tag.startsWith("locked:"))).toBe(false);
  });

  it("coalesces an in-flight normal replacement to the latest edge", async () => {
    const harness = await BrowserSessionHarness.createAtBodyZero();
    await harness.request("loading");
    const upload = harness.renderer.gateNextUpload();

    await harness.tick({ settleAfter: false });
    await upload.entered;
    const replacement = harness.request("hover", { settle: false });
    upload.release();
    await replacement;
    await harness.settle();

    // The obsolete reservation is retired first. The latest route is rebuilt
    // only after the already-valid adjacent source frame crosses its barrier.
    expect(harness.schedulerSnapshot().pendingEdge).toBeNull();
    const next = await harness.tick();
    expect(next.presentation).toMatchObject({
      kind: "body",
      state: "idle",
      frameIndex: 2
    });
    await harness.advanceUntil("reversible:idle-hover:hover-shift:0", 4);
    expect(harness.tags().some((tag) => tag.startsWith("locked:"))).toBe(false);
  });

  it("cancels a fully staged cut before frame zero without mutating the source path", async () => {
    const harness = await BrowserSessionHarness.createAtLoadingZero();
    const source = harness.schedulerSnapshot();
    const activations = harness.worker.activationCalls;

    await harness.request("idle");
    expect(harness.playbackSnapshot().cut).toMatchObject({
      status: "ready",
      residentFramesPresented: 0
    });
    expect(harness.worker.activationCalls).toBe(activations);
    expect(harness.schedulerSnapshot()).toMatchObject({
      generation: source.generation,
      ringSize: source.ringSize,
      displayedSource: source.displayedSource
    });

    await harness.request("loading");
    expect(harness.playbackSnapshot().cut).toBeNull();
    expect(harness.worker.activationCalls).toBe(activations);
    expect(harness.schedulerSnapshot()).toMatchObject({
      generation: source.generation,
      ringSize: source.ringSize,
      displayedSource: source.displayedSource
    });
    const adjacent = await harness.tick();
    expect(adjacent.presentation).toMatchObject({
      kind: "body",
      state: "loading",
      frameIndex: 1
    });
  });

  it("replaces an uncommitted cut with a non-cut route and preserves source adjacency", async () => {
    const harness = await BrowserSessionHarness.createAtLoadingZero();
    const activations = harness.worker.activationCalls;

    await harness.request("idle");
    await harness.request("hover");

    expect(harness.playbackSnapshot().cut).toBeNull();
    expect(harness.worker.activationCalls).toBe(activations);
    const adjacent = await harness.tick();
    expect(adjacent.presentation).toMatchObject({
      kind: "body",
      state: "loading",
      frameIndex: 1
    });
    expect(harness.tags().at(-1)).toBe("body:loading:loading-body:1");
  });

  it("replaces cut A with cut B before frame zero and commits only B", async () => {
    const harness = await BrowserSessionHarness.createAtLoadingZero();
    const activations = harness.worker.activationCalls;

    await harness.request("idle");
    await harness.request("third");
    expect(harness.playbackSnapshot().cut).toMatchObject({
      edge: "loading-third",
      status: "ready",
      residentFramesPresented: 0
    });
    expect(harness.worker.activationCalls).toBe(activations);

    const committed = await harness.tick();
    expect(committed.presentation).toMatchObject({
      kind: "body",
      state: "third",
      frameIndex: 0
    });
    expect(harness.tags().at(-1)).toBe("body:third:third-body:0");
    expect(harness.worker.activationCalls).toBe(activations + 1);
  });

  it("keeps a non-cut follow-on route unready through the visible cut runway", async () => {
    const harness = await BrowserSessionHarness.createAtLoadingZero();
    await harness.request("idle");
    const entry = await harness.tick();
    expect(entry.presentation).toMatchObject({
      kind: "body",
      state: "idle",
      frameIndex: 0
    });
    expect(harness.routeReady.at(-1)).toBe(true);

    await harness.request("loading");
    const runwayResults: Readonly<MotionGraphResult>[] = [];
    for (let index = 0; index < 6; index += 1) {
      runwayResults.push(await harness.tick());
    }

    expect(harness.routeReady.slice(-6)).toEqual([
      false, false, false, false, false, false
    ]);
    expect(runwayResults.map((result) => result.presentation)).toMatchObject([
      { kind: "body", state: "idle", frameIndex: 1 },
      { kind: "body", state: "idle", frameIndex: 2 },
      { kind: "body", state: "idle", frameIndex: 3 },
      { kind: "body", state: "idle", frameIndex: 0 },
      { kind: "body", state: "idle", frameIndex: 1 },
      { kind: "body", state: "idle", frameIndex: 2 }
    ]);
    expect(harness.tags().slice(-6)).toEqual([
      "body:idle:idle-body:1",
      "body:idle:idle-body:2",
      "body:idle:idle-body:3",
      "body:idle:idle-body:0",
      "body:idle:idle-body:1",
      "body:idle:idle-body:2"
    ]);
    expect(harness.playbackSnapshot().cut).toBeNull();
  });

  it("restores cut A after staging and cancelling cut B before B frame zero", async () => {
    const harness = await BrowserSessionHarness.createAtLoadingZero();
    await harness.request("idle");
    await harness.tick();
    expect(harness.tags().at(-1)).toBe("body:idle:idle-body:0");

    await harness.request("third");
    expect(harness.playbackSnapshot().cut).toMatchObject({
      edge: "idle-third",
      residentFramesPresented: 0
    });
    await harness.request("idle");
    const adjacent = await harness.tick();

    expect(adjacent.presentation).toMatchObject({
      kind: "body",
      state: "idle",
      frameIndex: 1
    });
    expect(harness.tags().at(-1)).toBe("body:idle:idle-body:1");
  });

  it("reverses adjacently when inverse intent supersedes a staged endpoint", async () => {
    const harness = await BrowserSessionHarness.createAtReversibleEndpoint();
    const activations = harness.worker.activationCalls;
    expect(harness.playbackSnapshot().cut).toMatchObject({
      status: "ready",
      residentFramesPresented: 0
    });

    await harness.request("idle");
    const inverse = await harness.tick();

    expect(inverse.presentation).toMatchObject({
      kind: "reversible",
      edgeId: "hover-idle",
      direction: "reverse",
      frameIndex: 4
    });
    expect(harness.tags().at(-1)).toBe(
      "reversible:hover-idle:hover-shift:4"
    );
    expect(harness.worker.activationCalls).toBe(activations);
  });

  it("releases a prepared source reservation before resident reversible entry", async () => {
    const harness = await BrowserSessionHarness.createAtBodyZero();

    for (let frame = 1; frame <= 7; frame += 1) {
      const result = await harness.tick();
      expect(result.presentation).toMatchObject({
        kind: "body",
        state: "idle",
        frameIndex: frame % 4
      });
    }
    await harness.request("hover");

    const entry = await harness.tick();
    expect(entry.presentation).toMatchObject({
      kind: "reversible",
      edgeId: "idle-hover",
      direction: "forward",
      frameIndex: 0
    });
    await harness.advanceUntil("body:hover:hover-body:0", 8);
    expect(harness.playbackSnapshot().cut).toMatchObject({
      targetState: "hover"
    });
  });

  it("draws endpoint body zero before a queued third-state non-cut follow-on", async () => {
    const harness = await BrowserSessionHarness.createAtReversibleEndpoint();

    await harness.request("third");
    const endpoint = await harness.tick();
    expect(endpoint.presentation).toMatchObject({
      kind: "body",
      state: "hover",
      frameIndex: 0
    });
    expect(harness.tags().at(-1)).toBe("body:hover:hover-body:0");

    await harness.advanceUntil("body:third:third-body:0", 12);
    expect(harness.tags().filter((tag) =>
      tag === "body:hover:hover-body:0"
    )).toHaveLength(1);
  });

  it("draws endpoint body zero before a queued cut follow-on", async () => {
    const harness = await BrowserSessionHarness.createAtReversibleEndpoint();

    await harness.request("loading");
    const endpoint = await harness.tick();
    expect(endpoint.presentation).toMatchObject({
      kind: "body",
      state: "hover",
      frameIndex: 0
    });
    expect(harness.tags().at(-1)).toBe("body:hover:hover-body:0");

    const cut = await harness.tick();
    expect(cut.presentation).toMatchObject({
      kind: "body",
      state: "loading",
      frameIndex: 0
    });
    expect(harness.tags().at(-1)).toBe("body:loading:loading-body:0");
  });

  it("enters the inverse clip on the tick after endpoint body zero", async () => {
    const harness = await BrowserSessionHarness.createAtReversibleEndpoint();
    await harness.tick();
    expect(harness.tags().at(-1)).toBe("body:hover:hover-body:0");

    await harness.request("idle");
    const inverse = await harness.tick();

    expect(inverse.presentation).toMatchObject({
      kind: "reversible",
      edgeId: "hover-idle",
      direction: "reverse",
      frameIndex: 5
    });
    expect(harness.tags().at(-1)).toBe(
      "reversible:hover-idle:hover-shift:5"
    );
  });

  it("promotes a finite target longer than the ring and reaches its terminal hold", async () => {
    const harness = await BrowserSessionHarness.createAtBodyZero();
    await harness.request("long");
    await harness.advanceUntil("body:long:long-body:0", 8);

    for (let frame = 1; frame < 10; frame += 1) {
      const result = await harness.tick();
      expect(result.presentation).toMatchObject({
        kind: "body",
        state: "long",
        frameIndex: frame
      });
    }
    const held = await harness.tick();

    expect(held.presentation).toMatchObject({
      kind: "body",
      state: "long",
      frameIndex: 9
    });
    expect(harness.tags().slice(-11)).toEqual(
      Array.from({ length: 10 }, (_, frame) =>
        `body:long:long-body:${String(frame)}`
      ).concat("body:long:long-body:9")
    );
    expect(harness.schedulerSnapshot()).toMatchObject({
      displayedSource: { occurrence: 0n, frame: 9 },
      status: "active"
    });
  });

  it("hands a finite body4 runway6 to terminal streaming ownership", async () => {
    const harness = await BrowserSessionHarness.createAtReversibleEndpoint();
    await harness.request("finite");
    await harness.tick();
    await harness.tick();
    expect(harness.tags().at(-1)).toBe("body:finite:finite-body:0");

    for (let index = 0; index < 6; index += 1) await harness.tick();

    expect(harness.tags().slice(-7)).toEqual([
      "body:finite:finite-body:0",
      "body:finite:finite-body:1",
      "body:finite:finite-body:2",
      "body:finite:finite-body:3",
      "body:finite:finite-body:3",
      "body:finite:finite-body:3",
      "body:finite:finite-body:3"
    ]);
    expect(harness.playbackSnapshot().cut).toBeNull();
    expect(harness.schedulerSnapshot()).toMatchObject({
      displayedSource: { occurrence: 0n, frame: 3 },
      status: "active"
    });
    expect(harness.worker.openFrames).toBeLessThanOrEqual(6);
  });

  it("stages a completion cut at the final frame of a visible finite runway", async () => {
    const harness = await BrowserSessionHarness.createAtReversibleEndpoint();
    await harness.request("loading");
    await harness.tick();
    await harness.tick();
    expect(harness.tags().at(-1)).toBe("body:loading:loading-body:0");

    for (const frame of [1, 2, 3]) {
      const source = await harness.tick();
      expect(source.presentation).toMatchObject({
        kind: "body",
        state: "loading",
        frameIndex: frame
      });
    }
    expect(harness.playbackSnapshot().cut).toMatchObject({
      edge: "loading-done",
      status: "ready",
      residentFramesPresented: 0
    });

    const completion = await harness.tick();
    expect(completion.presentation).toMatchObject({
      kind: "body",
      state: "done",
      frameIndex: 0
    });
    expect(harness.tags().at(-1)).toBe("body:done:done-body:0");
  });

  it("publishes an implicit non-cut completion route at the finite terminal", async () => {
    const harness = await BrowserSessionHarness.createAtLoadingZero({
      completionStart: "finish"
    });
    let terminal: Readonly<MotionGraphResult> | null = null;
    for (let count = 0; count < 6; count += 1) {
      const result = await harness.tick();
      if (
        result.presentation?.kind === "body" &&
        result.presentation.state === "done"
      ) {
        terminal = result;
        break;
      }
    }

    expect(terminal?.presentation).toMatchObject({
      kind: "body",
      state: "done",
      frameIndex: 0
    });
    expect(harness.tags().at(-1)).toBe("body:done:done-body:0");
    expect(harness.schedulerSnapshot()).toMatchObject({
      pendingEdge: null,
      smoothSession: true
    });
  });

  it("lets an explicit non-cut request supersede a staged completion cut at the final frame", async () => {
    const harness = await BrowserSessionHarness.createAtReversibleEndpoint();
    await harness.request("loading");
    await harness.tick();
    await harness.tick();
    await harness.tick();
    await harness.tick();
    const final = await harness.tick();
    expect(final.presentation).toMatchObject({
      kind: "body",
      state: "loading",
      frameIndex: 3
    });
    expect(harness.playbackSnapshot().cut).toMatchObject({
      edge: "loading-done",
      residentFramesPresented: 0
    });

    await harness.request("hover");
    expect(harness.playbackSnapshot().cut?.edge).not.toBe("loading-done");
    await harness.advanceUntil("body:hover:hover-body:0", 10);
    expect(harness.tags().some((tag) =>
      tag.startsWith("body:done:")
    )).toBe(false);
  });

  it("rejects recovery that consumes the frame-zero draw from the whole runway", () => {
    const fixture = readinessFixture();
    const passing = passingEvidence();
    const evidence = Object.freeze({
      ...passing,
      cuts: Object.freeze(passing.cuts.map((cut) => Object.freeze({
        ...cut,
        recoveryFrames: cut.runwayFrames
      }))),
      endpoints: Object.freeze(passing.endpoints.map((endpoint) =>
        Object.freeze({
          ...endpoint,
          recoveryFrames: endpoint.runwayFrames
        })
      ))
    });
    const report = evaluateAllRoutesReadiness({ ...fixture, evidence });

    expect(report.passed).toBe(false);
    expect(report.failures.map(({ code }) => code)).toEqual(
      expect.arrayContaining(["cut-runway", "endpoint-recovery"])
    );
  });

  it("keeps the scheduler active when a caller aborts an in-flight pump", async () => {
    const fixture = createStandaloneScheduler();
    const idle = fixture.catalog.graph.definition.states.find(({ id }) =>
      id === "idle"
    );
    if (idle === undefined) throw new Error("phase idle state is absent");
    await fixture.scheduler.startBody({
      state: idle.id,
      body: idle.body,
      outgoingStarts: fixture.catalog.graph.definition.edges
        .filter(({ from }) => from === idle.id)
        .map(({ start }) => start),
      path: "caller-abort"
    });
    const gate = fixture.worker.gateNextWait();
    const controller = new AbortController();
    const pump = fixture.scheduler.pump({
      targetRingFrames: 2,
      signal: controller.signal
    });
    await gate.entered;
    controller.abort(new DOMException("caller cancelled pump", "AbortError"));

    await expect(pump).rejects.toMatchObject({ name: "AbortError" });
    gate.release();
    expect(fixture.scheduler.snapshot()).toMatchObject({
      status: "active",
      smoothSession: true
    });
    await expect(fixture.scheduler.pump({ targetRingFrames: 2 }))
      .resolves.toMatchObject({ ringSize: 2 });

    await fixture.scheduler.dispose();
    await fixture.worker.dispose();
    fixture.catalog.dispose();
    expect(fixture.worker.openFrames).toBe(0);
  });
});

class BrowserSessionHarness {
  public readonly graph: MotionGraphEngine;
  public readonly worker: PhaseWorker;
  public readonly renderer: PhaseRenderer;
  public readonly routeReady: boolean[] = [];

  readonly #catalog: RuntimeAssetCatalog;
  readonly #session: BrowserOpaquePlaybackSession;
  #nextOrdinal = 1n;
  #disposed = false;

  private constructor(options: {
    readonly catalog: RuntimeAssetCatalog;
    readonly session: BrowserOpaquePlaybackSession;
    readonly graph: MotionGraphEngine;
    readonly worker: PhaseWorker;
    readonly renderer: PhaseRenderer;
  }) {
    this.#catalog = options.catalog;
    this.#session = options.session;
    this.graph = options.graph;
    this.worker = options.worker;
    this.renderer = options.renderer;
  }

  public static async create(options: {
    readonly completionStart?: "cut" | "finish";
  } = {}): Promise<BrowserSessionHarness> {
    const catalog = installRuntimeAssetCatalog(createBrowserPhaseAsset(options));
    const graph = new MotionGraphEngine();
    const installed = graph.install(catalog.graph);
    const candidate = createOpaqueRenditionCandidates(
      catalog.renditions.values()
    )[0];
    if (candidate === undefined) throw new Error("all-routes candidate is absent");
    const inspected = inspectOpaqueRenditionCandidate(catalog, candidate);
    if (!inspected.ok) throw new Error("all-routes candidate inspection failed");

    const worker = new PhaseWorker();
    const renderer = new PhaseRenderer();
    const timeline = new DecodeTimeline(catalog.manifest.frameRate);
    const samples = new WorkerSampleFactory({
      catalog,
      timeline,
      rendition: candidate.rendition.id,
      limits: LIMITS
    });
    const cache = createInteractionCachePlan({
      manifest: catalog.manifest,
      rendition: candidate.rendition.id,
      deviceLimits: {
        maxArrayTextureLayers: 256,
        maxTextureSize: 4096
      }
    });
    const resourcePlan = createRuntimeResourcePlan({
      catalog,
      rendition: candidate.rendition.id,
      interactionCache: cache,
      ringCapacity: 6
    });
    const context: Readonly<IntegratedCandidateAttemptContext> = Object.freeze({
      catalog,
      candidate,
      inspection: inspected.inspection,
      graphSnapshot: installed.snapshot,
      hostMaxRuntimeBytes: null
    });
    const runtime = new AbortController();
    let now = 0;
    const input: Readonly<OpaqueCandidateReadinessSessionInput> = Object.freeze({
      context,
      worker,
      renderer: renderer.asOpaqueRenderer(),
      interactionCache: cache,
      provisionalResourcePlan: resourcePlan,
      timeline,
      samples,
      limits: LIMITS,
      clock: { now: () => ++now },
      signal: runtime.signal,
      deadlineMs: 10_000
    });
    const scheduler = new PathScheduler({
      timeline,
      samples,
      worker,
      rendition: candidate.rendition.id,
      ringCapacity: resourcePlan.ringCapacity,
      limits: LIMITS,
      clock: input.clock
    });
    const activation: Readonly<OpaqueCandidateActivationInput> = Object.freeze({
      graphSnapshot: installed.snapshot,
      expectedPresentation: createIntegratedActivationPresentation(
        catalog.graph,
        installed.snapshot
      ),
      scheduler,
      finalResourcePlan: resourcePlan,
      signal: runtime.signal,
      deadlineMs: 10_000
    });
    const hub = new BrowserOpaqueCandidateHub({
      width: catalog.manifest.canvas.width,
      height: catalog.manifest.canvas.height
    } as HTMLCanvasElement);
    const session = await BrowserOpaquePlaybackSession.create({
      candidate: input,
      activation,
      hub
    });
    const harness = new BrowserSessionHarness({
      catalog,
      session,
      graph,
      worker,
      renderer
    });
    session.synchronizeGraph(graph.beginAnimated());
    session.drawInitial();
    await session.settled();
    openHarnesses.add(harness);
    return harness;
  }

  public static async createAtBodyZero(options: {
    readonly completionStart?: "cut" | "finish";
  } = {}): Promise<BrowserSessionHarness> {
    const harness = await BrowserSessionHarness.create(options);
    await harness.tick();
    await harness.tick();
    await harness.tick();
    expect(harness.tags().at(-1)).toBe("body:idle:idle-body:0");
    return harness;
  }

  public static async createAtLoadingZero(options: {
    readonly completionStart?: "cut" | "finish";
  } = {}): Promise<BrowserSessionHarness> {
    const harness = await BrowserSessionHarness.createAtBodyZero(options);
    await harness.request("loading");
    await harness.advanceUntil("body:loading:loading-body:0", 12);
    return harness;
  }

  public static async createAtReversibleEndpoint(): Promise<BrowserSessionHarness> {
    const harness = await BrowserSessionHarness.createAtBodyZero();
    await harness.request("hover");
    await harness.advanceUntil(
      "reversible:idle-hover:hover-shift:0",
      6
    );
    for (let frame = 1; frame < 6; frame += 1) {
      const result = await harness.tick();
      expect(result.presentation).toMatchObject({
        kind: "reversible",
        edgeId: "idle-hover",
        direction: "forward",
        frameIndex: frame
      });
    }
    expect(harness.tags().at(-1)).toBe(
      "reversible:idle-hover:hover-shift:5"
    );
    return harness;
  }

  public async tick(options: {
    readonly settleBefore?: boolean;
    readonly settleAfter?: boolean;
  } = {}): Promise<Readonly<MotionGraphResult>> {
    if (options.settleBefore !== false) await this.#session.settled();
    const prepared = this.#session.prepareContentTick({
      presentationOrdinal: this.#nextOrdinal,
      rationalDeadlineUs: Number(this.#nextOrdinal) * 33_333,
      graphSnapshot: this.graph.snapshot(),
      previewTick: (input) => this.graph.previewTick(input)
    });
    if (prepared === null) throw new Error("browser phase tick underflowed");
    const result = this.graph.tick({
      contentOrdinal: this.#nextOrdinal - 1n,
      routeReady: prepared.routeReady
    });
    this.routeReady.push(prepared.routeReady);
    const presentation = result.presentation;
    if (presentation === null) throw new Error("graph tick has no presentation");
    this.#session.drawContentTick(prepared, presentation);
    this.#session.synchronizeGraph(result);
    this.#nextOrdinal += 1n;
    if (options.settleAfter !== false) await this.#session.settled();
    return result;
  }

  public async request(
    state: string,
    options: { readonly settle?: boolean } = {}
  ): Promise<Readonly<MotionGraphResult>> {
    const result = this.graph.request(state);
    this.#session.synchronizeGraph(result);
    if (options.settle !== false) await this.#session.settled();
    return result;
  }

  public async advanceUntil(tag: string, limit: number): Promise<void> {
    for (let index = 0; index < limit; index += 1) {
      if (this.tags().at(-1) === tag) return;
      await this.tick();
    }
    expect(this.tags().at(-1)).toBe(tag);
  }

  public settle(): Promise<void> {
    return this.#session.settled();
  }

  public schedulerSnapshot(): Readonly<PathSchedulerSnapshot> {
    const scheduler = this.#session.snapshot().scheduler;
    if (scheduler === null) throw new Error("browser scheduler snapshot is absent");
    return scheduler;
  }

  public playbackSnapshot() {
    return this.#session.snapshot();
  }

  public tags(): readonly string[] {
    return this.#session.snapshot().readbackTags;
  }

  public async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    await this.#session.dispose();
    await this.worker.dispose();
    this.#catalog.dispose();
  }
}

class PhaseRenderer {
  public readonly resourceGeneration = 1;
  public readonly draws: RenderFrameHandle[] = [];
  #uploadSerial = 0;
  #uploadGate: {
    readonly entered: () => void;
    readonly released: Promise<void>;
  } | null = null;

  public gateNextUpload(): {
    readonly entered: Promise<void>;
    readonly release: () => void;
  } {
    if (this.#uploadGate !== null) {
      throw new Error("phase renderer upload is already gated");
    }
    let entered!: () => void;
    let release!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const released = new Promise<void>((resolve) => { release = resolve; });
    this.#uploadGate = { entered, released };
    return Object.freeze({ entered: enteredPromise, release });
  }

  public residentHandle(layer: number): Readonly<ResidentFrameHandle> {
    return Object.freeze({
      kind: "resident",
      layer,
      resourceGeneration: this.resourceGeneration
    });
  }

  public async uploadStreaming(
    slot: number,
    pathGeneration: number,
    source: ManagedDecoderWorkerFrame,
    resourceGeneration = this.resourceGeneration
  ): Promise<Readonly<StreamingFrameHandle>> {
    const gate = this.#uploadGate;
    if (gate !== null) {
      this.#uploadGate = null;
      gate.entered();
      await gate.released;
    }
    source.close();
    this.#uploadSerial += 1;
    return Object.freeze({
      kind: "stream",
      slot,
      pathGeneration,
      uploadSerial: this.#uploadSerial,
      resourceGeneration
    });
  }

  public draw(handle: Readonly<RenderFrameHandle>): void {
    this.draws.push(handle);
  }

  public asOpaqueRenderer(): OpaqueFrameRenderer {
    return this as unknown as OpaqueFrameRenderer;
  }
}

interface PendingSample {
  readonly generation: number;
  readonly sample: Omit<DecoderWorkerSample, "data">;
}

class PhaseWorker implements OpaqueCandidateWorker {
  public activeGeneration: number | null = null;
  readonly #pending: PendingSample[] = [];
  readonly #ready: PhaseManagedFrame[] = [];
  readonly #open = new Set<PhaseManagedFrame>();
  #acceptedSamples = 0;
  #releasedFrames = 0;
  #disposed = false;
  #activationGate: {
    readonly entered: () => void;
    readonly released: Promise<void>;
  } | null = null;
  #waitGate: {
    readonly entered: () => void;
    readonly released: Promise<void>;
  } | null = null;
  public activationCalls = 0;

  public get queuedFrames(): number {
    return this.#ready.length;
  }

  public get openFrames(): number {
    return this.#open.size;
  }

  public async configure(_options: DecoderWorkerConfigureOptions): Promise<void> {
    // The direct activation harness starts from an already configured worker.
  }

  public gateNextActivation(): {
    readonly entered: Promise<void>;
    readonly release: () => void;
  } {
    if (this.#activationGate !== null) {
      throw new Error("phase worker activation is already gated");
    }
    let entered!: () => void;
    let release!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const released = new Promise<void>((resolve) => { release = resolve; });
    this.#activationGate = { entered, released };
    return Object.freeze({ entered: enteredPromise, release });
  }

  public gateNextWait(): {
    readonly entered: Promise<void>;
    readonly release: () => void;
  } {
    if (this.#waitGate !== null) {
      throw new Error("phase worker wait is already gated");
    }
    let entered!: () => void;
    let release!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const released = new Promise<void>((resolve) => { release = resolve; });
    this.#waitGate = { entered, released };
    return Object.freeze({ entered: enteredPromise, release });
  }

  public async activateGeneration(generation: number): Promise<void> {
    this.activationCalls += 1;
    const gate = this.#activationGate;
    if (gate !== null) {
      this.#activationGate = null;
      gate.entered();
      await gate.released;
    }
    this.activeGeneration = generation;
    this.#pending.length = 0;
    for (const frame of this.#ready) frame.close();
    this.#ready.length = 0;
  }

  public async submit(
    generation: number,
    samples: readonly DecoderWorkerSample[]
  ): Promise<void> {
    if (generation !== this.activeGeneration) {
      throw new Error("phase worker generation mismatch");
    }
    for (const sample of samples) {
      const { data: _data, ...metadata } = sample;
      this.#pending.push({ generation, sample: metadata });
      this.#acceptedSamples += 1;
    }
  }

  public async abortGeneration(generation: number): Promise<void> {
    this.#pending.splice(0, this.#pending.length,
      ...this.#pending.filter((item) => item.generation !== generation));
    for (const frame of this.#open) {
      if (frame.generation === generation) frame.close();
    }
    this.#ready.splice(0, this.#ready.length,
      ...this.#ready.filter((frame) => !frame.closed));
    if (this.activeGeneration === generation) this.activeGeneration = null;
  }

  public takeFrame(): ManagedDecoderWorkerFrame | undefined {
    return this.#ready.shift();
  }

  public async waitForFrames(
    minimum = 1,
    options: DecoderWorkerWaitOptions = {}
  ): Promise<void> {
    throwIfPhaseAborted(options.signal);
    const gate = this.#waitGate;
    if (gate !== null) {
      this.#waitGate = null;
      gate.entered();
      await waitForPhaseGate(gate.released, options.signal);
    }
    throwIfPhaseAborted(options.signal);
    while (this.#pending.length > 0 && this.#ready.length < minimum) {
      const pending = this.#pending.shift()!;
      const frame = new PhaseManagedFrame(pending, () => {
        this.#open.delete(frame);
        this.#releasedFrames += 1;
      });
      this.#open.add(frame);
      this.#ready.push(frame);
    }
  }

  public async snapshotMetrics(): Promise<DecoderWorkerMetrics> {
    const generation = this.activeGeneration;
    const submittedFrames = this.#pending.filter((item) =>
      item.generation === generation
    ).length;
    const leasedFrames = [...this.#open].filter((frame) =>
      frame.generation === generation
    ).length;
    return {
      configureCalls: 1,
      resetCalls: 0,
      flushCalls: 0,
      boundaryFlushCalls: 0,
      acceptedSamples: this.#acceptedSamples,
      submittedChunks: this.#acceptedSamples,
      outputFrames: this.#acceptedSamples - this.#pending.length,
      deliveredFrames: this.#acceptedSamples - this.#pending.length,
      releasedFrames: this.#releasedFrames,
      staleFrames: 0,
      closedFrames: this.#releasedFrames,
      pendingSamples: this.#pending.length,
      submittedFrames,
      leasedFrames,
      leasedDecodedBytes: leasedFrames * 128,
      decodeQueueSize: submittedFrames,
      activeGeneration: generation,
      nextSubmissionOrdinal: this.#acceptedSamples,
      nextOutputOrdinal: this.#acceptedSamples - this.#pending.length,
      errors: 0,
      disposed: this.#disposed
    };
  }

  public async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.activeGeneration !== null) {
      await this.abortGeneration(this.activeGeneration);
    }
    for (const frame of this.#open) frame.close();
    this.#pending.length = 0;
    this.#ready.length = 0;
  }
}

function createStandaloneScheduler(): {
  readonly catalog: RuntimeAssetCatalog;
  readonly worker: PhaseWorker;
  readonly scheduler: PathScheduler;
} {
  const catalog = installRuntimeAssetCatalog(createBrowserPhaseAsset());
  const candidate = createOpaqueRenditionCandidates(
    catalog.renditions.values()
  )[0];
  if (candidate === undefined) throw new Error("phase candidate is absent");
  const timeline = new DecodeTimeline(catalog.manifest.frameRate);
  const worker = new PhaseWorker();
  const samples = new WorkerSampleFactory({
    catalog,
    timeline,
    rendition: candidate.rendition.id,
    limits: LIMITS
  });
  let now = 0;
  const scheduler = new PathScheduler({
    timeline,
    samples,
    worker,
    rendition: candidate.rendition.id,
    ringCapacity: 6,
    limits: LIMITS,
    clock: { now: () => ++now }
  });
  return { catalog, worker, scheduler };
}

async function waitForPhaseGate(
  released: Promise<void>,
  signal: AbortSignal | undefined
): Promise<void> {
  if (signal === undefined) return released;
  if (signal.aborted) throw signal.reason;
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => rejectAbort(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    await Promise.race([released, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function throwIfPhaseAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw signal.reason;
}

class PhaseManagedFrame implements ManagedDecoderWorkerFrame {
  public readonly frame = {} as VideoFrame;
  public readonly frameId: number;
  public readonly generation: number;
  public readonly ordinal: number;
  public readonly unitId: string;
  public readonly unitInstance: number;
  public readonly unitFrame: number;
  public readonly timestamp: number;
  public readonly duration: number;
  public readonly decodedBytes = 128;
  readonly #release: () => void;
  #closed = false;

  public constructor(pending: PendingSample, release: () => void) {
    this.frameId = pending.sample.ordinal + 1;
    this.generation = pending.generation;
    this.ordinal = pending.sample.ordinal;
    this.unitId = pending.sample.unitId;
    this.unitInstance = pending.sample.unitInstance;
    this.unitFrame = pending.sample.unitFrame;
    this.timestamp = pending.sample.timestamp;
    this.duration = pending.sample.duration;
    this.#release = release;
  }

  public get closed(): boolean {
    return this.#closed;
  }

  public close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#release();
  }
}

function createBrowserPhaseAsset(options: {
  readonly completionStart?: "cut" | "finish";
} = {}): Uint8Array {
  const digest = "0".repeat(64);
  const rendition: Extract<
    RenditionV01,
    { readonly profile: "avc-annexb-opaque-v0" }
  > = {
    id: "opaque-phase",
    profile: "avc-annexb-opaque-v0",
    codec: "avc1.42E020",
    codedWidth: 64,
    codedHeight: 64,
    alphaLayout: {
      type: "opaque-v0",
      colorRect: [0, 0, 64, 64]
    },
    bitrate: { average: 1_000_000, peak: 2_000_000 },
    capabilities: ["webcodecs", "webgl2"]
  };
  const samples = [{ rendition: rendition.id, sha256: digest }];
  const units: CanonicalAssetInputV01["manifest"]["units"] = [
    oneShotUnit("intro", "one-shot", 3, samples),
    bodyUnit("idle-body", "loop", 4, [0, 3], samples),
    {
      id: "hover-shift",
      kind: "reversible",
      frameCount: 6,
      samples,
      residency: {
        endpoints: [
          { state: "idle", port: "default", frames: 6 },
          { state: "hover", port: "default", frames: 6 }
        ]
      }
    },
    bodyUnit("hover-body", "loop", 4, [0, 3], samples),
    oneShotUnit("loading-bridge", "bridge", 1, samples),
    bodyUnit("loading-body", "finite", 4, [3], samples),
    bodyUnit("third-body", "loop", 4, [0, 3], samples),
    bodyUnit("long-body", "finite", 10, [9], samples),
    bodyUnit("done-body", "finite", 1, [0], samples),
    bodyUnit("finite-body", "finite", 4, [3], samples)
  ];
  const stateIds = [
    "idle",
    "hover",
    "loading",
    "third",
    "long",
    "done",
    "finite"
  ];
  const accessUnits: CanonicalAssetInputV01["accessUnits"] = units.flatMap(
    (unit) => Array.from({ length: unit.frameCount }, (_, frameIndex) => ({
      rendition: rendition.id,
      unit: unit.id,
      frameIndex,
      key: frameIndex === 0,
      bytes: new Uint8Array(
        frameIndex === 0 ? PHASE_KEY_ACCESS_UNIT : phaseDeltaAccessUnit(frameIndex)
      )
    }))
  );
  return writeCanonicalAsset({
    manifest: {
      formatVersion: "0.1",
      generator: "player-web-browser-phase-tests",
      canvas: {
        width: 64,
        height: 64,
        fit: "contain",
        pixelAspect: [1, 1],
        colorSpace: "srgb"
      },
      frameRate: { numerator: 30, denominator: 1 },
      renditions: [rendition],
      units,
      staticFrames: stateIds.map((id) => ({
        id: `${id}-static`,
        width: 64,
        height: 64,
        sha256: digest
      })),
      initialState: "idle",
      states: stateIds.map((id) => ({
        id,
        bodyUnit: `${id}-body`,
        ...(id === "idle" ? { initialUnit: "intro" } : {}),
        staticFrame: `${id}-static`
      })),
      edges: [
        {
          ...phasePortalEdge("idle-hover", "idle", "hover"),
          transition: {
            kind: "reversible",
            unit: "hover-shift",
            direction: "forward"
          }
        },
        {
          ...phasePortalEdge("hover-idle", "hover", "idle"),
          transition: {
            kind: "reversible",
            unit: "hover-shift",
            direction: "reverse",
            reverseOf: "idle-hover"
          },
          continuity: "exact-reverse"
        },
        {
          ...phasePortalEdge("idle-loading", "idle", "loading"),
          transition: { kind: "locked", unit: "loading-bridge" }
        },
        phasePortalEdge("idle-long", "idle", "long"),
        phaseCutEdge("idle-third", "idle", "third"),
        phaseCutEdge("loading-idle", "loading", "idle"),
        phaseCutEdge("loading-third", "loading", "third"),
        phaseFinishEdge("loading-hover", "loading", "hover"),
        options.completionStart === "finish"
          ? {
              ...phaseFinishEdge("loading-done", "loading", "done"),
              trigger: { type: "completion" as const }
            }
          : {
              ...phaseCutEdge("loading-done", "loading", "done"),
              trigger: { type: "completion" as const }
            },
        phasePortalEdge("hover-third", "hover", "third"),
        phaseCutEdge("hover-loading", "hover", "loading"),
        phaseCutEdge("hover-finite", "hover", "finite"),
        phasePortalEdge("third-idle", "third", "idle"),
        phaseFinishEdge("long-idle", "long", "idle"),
        phasePortalEdge("done-idle", "done", "idle")
      ],
      bindings: [],
      readiness: {
        policy: "all-routes",
        bootstrapUnits: units.map(({ id }) => id),
        immediateEdges: [
          "idle-hover",
          "idle-loading",
          "idle-long",
          "idle-third"
        ]
      },
      fallback: {
        unsupported: "per-state-static",
        reducedMotion: "per-state-static"
      },
      limits: {
        maxCompiledBytes: 512 * 1024,
        maxRuntimeBytes: 32 * 1024 * 1024,
        decodedPixelBytes: 64 * 64 * 4,
        persistentCacheBytes: 128 * 64 * 64 * 4,
        runtimeWorkingSetBytes: 8 * 1024 * 1024
      }
    },
    accessUnits,
    staticPayloads: stateIds.map((id) => ({
      staticFrame: `${id}-static`,
      bytes: phaseShallowPng(64, 64)
    }))
  });
}

function oneShotUnit(
  id: string,
  kind: "one-shot" | "bridge",
  frameCount: number,
  samples: readonly { readonly rendition: string; readonly sha256: string }[]
) {
  return { id, kind, frameCount, samples } as const;
}

function bodyUnit(
  id: string,
  playback: "loop" | "finite",
  frameCount: number,
  portalFrames: readonly number[],
  samples: readonly { readonly rendition: string; readonly sha256: string }[]
) {
  return {
    id,
    kind: "body" as const,
    playback,
    frameCount,
    ports: [{ id: "default", entryFrame: 0 as const, portalFrames }],
    samples
  };
}

function phasePortalEdge(id: string, from: string, to: string) {
  return {
    id,
    from,
    to,
    start: {
      type: "portal" as const,
      sourcePort: "default",
      targetPort: "default",
      maxWaitFrames: 24
    },
    continuity: "exact-authored" as const
  };
}

function phaseFinishEdge(id: string, from: string, to: string) {
  return {
    id,
    from,
    to,
    start: {
      type: "finish" as const,
      targetPort: "default",
      maxWaitFrames: 24
    },
    continuity: "exact-authored" as const
  };
}

function phaseCutEdge(id: string, from: string, to: string) {
  return {
    id,
    from,
    to,
    start: {
      type: "cut" as const,
      targetPort: "default",
      maxWaitFrames: 1 as const
    },
    continuity: "cut" as const,
    targetRunwayFrames: 6
  };
}

const PHASE_KEY_ACCESS_UNIT = Object.freeze([
  0, 0, 0, 1, 9, 16, 0, 0, 0, 1, 103, 66, 224, 32, 218, 16, 154,
  106, 2, 2, 2, 128, 0, 0, 3, 0, 128, 0, 0, 30, 70, 208, 68, 35,
  80, 0, 0, 1, 104, 206, 50, 200, 0, 0, 1, 101, 184, 79, 192
] as const);

function phaseDeltaAccessUnit(frameNumber: number): readonly number[] {
  const bits: number[] = [];
  const bit = (value: boolean | number): void => { bits.push(value ? 1 : 0); };
  const fixed = (value: number, width: number): void => {
    for (let shift = width - 1; shift >= 0; shift -= 1) {
      bit(Math.floor(value / 2 ** shift) % 2);
    }
  };
  const unsignedExpGolomb = (value: number): void => {
    const code = value + 1;
    const width = Math.floor(Math.log2(code)) + 1;
    for (let index = 1; index < width; index += 1) bit(0);
    fixed(code, width);
  };
  unsignedExpGolomb(0);
  unsignedExpGolomb(0);
  unsignedExpGolomb(0);
  fixed(frameNumber, 4);
  bit(false);
  bit(false);
  bit(false);
  unsignedExpGolomb(0);
  unsignedExpGolomb(0);
  unsignedExpGolomb(0);
  unsignedExpGolomb(0);
  bit(true);
  bit(true);
  while (bits.length % 8 !== 0) bit(false);
  const slice = new Array<number>(bits.length / 8).fill(0);
  for (let index = 0; index < bits.length; index += 1) {
    if (bits[index] === 1) {
      const byte = Math.floor(index / 8);
      slice[byte] = slice[byte]! | (1 << (7 - (index % 8)));
    }
  }
  return [0, 0, 0, 1, 9, 48, 0, 0, 1, 97, ...slice];
}

function phaseShallowPng(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  phaseWriteUint32Be(bytes, 8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  phaseWriteUint32Be(bytes, 16, width);
  phaseWriteUint32Be(bytes, 20, height);
  bytes.set([8, 6, 0, 0, 0], 24);
  bytes.set([0xde, 0xad, 0xbe, 0xef], 29);
  return bytes;
}

function phaseWriteUint32Be(
  bytes: Uint8Array,
  offset: number,
  value: number
): void {
  bytes[offset] = Math.floor(value / 0x100_0000) & 0xff;
  bytes[offset + 1] = Math.floor(value / 0x1_0000) & 0xff;
  bytes[offset + 2] = Math.floor(value / 0x100) & 0xff;
  bytes[offset + 3] = value & 0xff;
}
