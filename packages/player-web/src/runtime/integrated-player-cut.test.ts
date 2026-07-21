import {
  MotionGraphEngine,
  type GraphBodyDefinition,
  type GraphEdgeDefinition,
  type GraphPresentation,
  type MotionGraphResult
} from "@pixel-point/aval-graph";
import type {
  DecoderWorkerMetrics,
  DecoderWorkerSample
} from "../decoder-worker/protocol.js";
import type {
  DecoderWorkerWaitOptions,
  ManagedDecoderWorkerFrame
} from "../decoder-worker/client.js";
import { describe, expect, it } from "vitest";

import { installRuntimeAssetCatalog } from "./asset-catalog.js";
import { createIntegratedTestAsset } from "./asset-test-support.js";
import {
  CutPresentationCoordinator,
  CutPresentationSupersededError,
  type CutActivationInput,
  type CutPresentationRenderer
} from "./cut-presentation-coordinator.js";
import { DecodeTimeline } from "./decode-timeline.js";
import { EffectHost } from "./effect-host.js";
import { RuntimePlaybackError, type RuntimeFailure } from "./errors.js";
import type {
  IntegratedPlaybackTickContext,
  IntegratedPreparedContentTick
} from "./integrated-player-contracts.js";
import type {
  BorrowedVideoFrame,
  RenderFrameHandle,
  ResidentFrameHandle,
  StreamingFrameHandle
} from "./frame-renderer.js";
import {
  PathScheduler,
  type PathSchedulerWorkerAdapter
} from "./path-scheduler.js";
import { RequestPromises } from "./request-promises.js";
import { WorkerSampleFactory } from "./worker-samples.js";
import { inspectSelectedVideoRendition } from "./video-rendition-inspection.js";
import { selectIntegratedTestVideoRendition } from "./integrated-player-video-test-support.js";

const LIMITS = Object.freeze({
  maxDecodeQueueSize: 8,
  maxPendingSamples: 12,
  maxOutstandingFrames: 12,
  maxDecodedBytes: 12 * 64 * 64 * 4
});

describe("integrated resident cut presentation", () => {
  it.each([0, 1])(
    "cuts from source frame %i and draws target zero on the next eligible tick",
    async (sourceFrame) => {
      const fixture = await createFixture({ sourceFrame: sourceFrame as 0 | 1 });
      const request = requestCut(fixture);
      fixture.coordinator.stageCut(fixture.cut);
      const prepared = requirePrepared(fixture.coordinator.prepareContentTick(
        tickContext(fixture)
      ));
      // No microtask or worker-generation acknowledgement may stand between
      // the accepted cut request and resident target frame zero.
      expect(fixture.coordinator.snapshot().status).toBe("ready");

      expect(prepared.media).toMatchObject({
        kind: "frame",
        graphKind: "body",
        state: "hover",
        edge: "idle-hover",
        frame: { unit: "hover-body", localFrame: 0 },
        drawSource: "resident",
        generation: fixture.coordinator.snapshot().generation,
        intendedPresentationOrdinal: fixture.nextPresentationOrdinal
      });

      const result = fixture.graph.tick({
        contentOrdinal: fixture.nextPresentationOrdinal - 1n,
        routeReady: true
      });
      fixture.order.length = 0;
      fixture.effects.apply(result, (presentation) => {
        fixture.coordinator.drawContentTick(prepared, presentation);
      });
      fixture.coordinator.synchronizeGraph(result);
      const activation = await fixture.coordinator.startStagedContinuation();

      expect(result.presentation).toEqual({
        kind: "body",
        state: "hover",
        unitId: "hover-body",
        frameIndex: 0
      });
      expect(fixture.order).toEqual([
        "effect:transitionstart",
        "draw:resident:0",
        "effect:visualstatechange",
        "effect:transitionend"
      ]);
      await request;
      expect(fixture.coordinator.snapshot()).toMatchObject({
        generation: activation.generation,
        residentFramesPresented: 1,
        status: "ready"
      });
    }
  );

  it("uses one shared target runway, discards decoded duplicates, and continues exactly at its length", async () => {
    const fixture = await createFixture({
      sourceFrame: 1,
      retainOneStaleOutput: true
    });
    requestCut(fixture);
    fixture.coordinator.stageCut(fixture.cut);
    const handles = fixture.renderer.residentHandles.slice();
    const presentations: Array<{
      readonly ordinal: bigint;
      readonly localFrame: number;
      readonly source: string;
    }> = [];

    for (let index = 0; index < fixture.cut.runway.length; index += 1) {
      const ordinal = fixture.nextPresentationOrdinal + BigInt(index);
      const prepared = requirePrepared(fixture.coordinator.prepareContentTick({
        ...tickContext(fixture),
        presentationOrdinal: ordinal,
        graphSnapshot: fixture.graph.snapshot()
      }));
      const result = fixture.graph.tick({
        contentOrdinal: ordinal - 1n,
        routeReady: true
      });
      drawAndSynchronize(fixture, prepared, result);
      if (index === 0) {
        await fixture.coordinator.startStagedContinuation();
      }
      if (prepared.media.kind !== "frame") throw new Error("expected frame");
      presentations.push({
        ordinal,
        localFrame: prepared.media.frame.localFrame,
        source: prepared.media.drawSource
      });
    }

    const continuationOrdinal =
      fixture.nextPresentationOrdinal + BigInt(fixture.cut.runway.length);
    const continuation = requirePrepared(fixture.coordinator.prepareContentTick({
      ...tickContext(fixture),
      presentationOrdinal: continuationOrdinal,
      graphSnapshot: fixture.graph.snapshot()
    }));
    const continuationResult = fixture.graph.tick({
      contentOrdinal: continuationOrdinal - 1n,
      routeReady: true
    });
    drawAndSynchronize(fixture, continuation, continuationResult);
    if (continuation.media.kind !== "frame") throw new Error("expected frame");

    expect(presentations).toEqual(Array.from({ length: 6 }, (_, index) => ({
      ordinal: fixture.nextPresentationOrdinal + BigInt(index),
      localFrame: index % 2,
      source: "resident"
    })));
    const activation = fixture.coordinator.snapshot();
    expect(continuation.media).toMatchObject({
      drawSource: "streaming",
      frame: { unit: "hover-body", localFrame: 0 },
      generation: activation.generation,
      intendedPresentationOrdinal: continuationOrdinal
    });
    expect(fixture.renderer.drawn.map(({ kind }) => kind)).toEqual([
      "resident", "resident", "resident", "resident", "resident", "resident",
      "stream"
    ]);
    expect(fixture.renderer.residentHandles).toEqual(handles);
    expect(fixture.scheduler.snapshot()).toMatchObject({
      generation: activation.generation,
      discardedDependencyFrames: 6,
      staleFrames: 1
    });
    expect(fixture.worker.openFrames).toBe(0);
    expect(await fixture.worker.snapshotMetrics()).toMatchObject({
      configureCalls: 1,
      resetCalls: 0,
      flushCalls: 0,
      boundaryFlushCalls: 0
    });
  });

  it("rejects a superseded prepared frame without fallback", async () => {
    const failures: RuntimeFailure[] = [];
    const fixture = await createFixture({ failures });
    requestCut(fixture);
    fixture.coordinator.stageCut(fixture.cut);
    const old = requirePrepared(fixture.coordinator.prepareContentTick(
      tickContext(fixture)
    ));
    fixture.coordinator.stageCut({
      ...fixture.cut,
      path: "cut:hover:replacement"
    });

    expect(() => fixture.coordinator.drawContentTick(
      old,
      bodyPresentation("hover", "hover-body", 0)
    )).toThrow(CutPresentationSupersededError);
    expect(failures).toEqual([]);

    const replacement = requirePrepared(fixture.coordinator.prepareContentTick(
      tickContext(fixture)
    ));
    expect(replacement.media).toMatchObject({
      frame: { unit: "hover-body", localFrame: 0 },
      generation: fixture.coordinator.snapshot().generation,
      intendedPresentationOrdinal: fixture.nextPresentationOrdinal
    });
    const result = fixture.graph.tick({
      contentOrdinal: fixture.nextPresentationOrdinal - 1n,
      routeReady: true
    });
    drawAndSynchronize(fixture, replacement, result);
    await fixture.coordinator.startStagedContinuation();
    expect(fixture.renderer.drawn).toEqual([
      fixture.renderer.residentHandles[0]
    ]);
  });

  it("signals static recovery for a missing resident resource", async () => {
    const failures: RuntimeFailure[] = [];
    const fixture = await createFixture({ failures });
    fixture.renderer.missingLayer = 3;
    requestCut(fixture);

    expect(() => fixture.coordinator.stageCut(fixture.cut))
      .toThrowError(expect.objectContaining({ code: "resource-rejection" }));
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      code: "resource-rejection",
      context: { operation: "bind-resident-runway" }
    });
    expect(fixture.coordinator.snapshot().status).toBe("error");
  });

  it("signals static recovery when the draw barrier rejects a resource", async () => {
    const failures: RuntimeFailure[] = [];
    const fixture = await createFixture({ failures });
    requestCut(fixture);
    fixture.coordinator.stageCut(fixture.cut);
    const prepared = requirePrepared(fixture.coordinator.prepareContentTick(
      tickContext(fixture)
    ));
    const result = fixture.graph.tick({
      contentOrdinal: fixture.nextPresentationOrdinal - 1n,
      routeReady: true
    });
    fixture.renderer.failDraw = true;

    expect(() => fixture.effects.apply(result, (presentation) => {
      fixture.coordinator.drawContentTick(prepared, presentation);
    })).toThrow(RuntimePlaybackError);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      code: "renderer-failure",
      context: { operation: "draw-cut-frame", edge: "idle-hover" }
    });
    expect(fixture.order).not.toContain("effect:visualstatechange");
    expect(fixture.coordinator.snapshot().status).toBe("error");
  });
});

interface FixtureOptions {
  readonly sourceFrame?: 0 | 1;
  readonly retainOneStaleOutput?: boolean;
  readonly failures?: RuntimeFailure[];
}

interface CutFixture {
  readonly graph: MotionGraphEngine;
  readonly effects: EffectHost;
  readonly requests: RequestPromises;
  readonly scheduler: PathScheduler;
  readonly worker: FakeWorker;
  readonly renderer: FakeRenderer;
  readonly coordinator: CutPresentationCoordinator;
  readonly cut: Readonly<CutActivationInput>;
  readonly order: string[];
  readonly nextPresentationOrdinal: bigint;
}

async function createFixture(options: FixtureOptions = {}): Promise<CutFixture> {
  const catalog = installRuntimeAssetCatalog(createIntegratedTestAsset());
  const definition = catalog.graph.definition;
  const idle = requireState(definition.states, "idle");
  const hover = requireState(definition.states, "hover");
  const edge = requireEdge(definition.edges, "idle-hover");
  const graph = new MotionGraphEngine();
  const install = graph.install(catalog.graph);
  const order: string[] = [];
  const requests = new RequestPromises();
  const effects = new EffectHost({
    initialGraphSnapshot: install.snapshot,
    requestPromises: requests,
    eventSink: (event) => order.push(`effect:${event.type}`)
  });
  effects.publishMetadataReady();
  effects.apply(install, () => undefined);
  effects.publishVisualReady();
  const begin = graph.beginAnimated();
  effects.apply(begin, () => undefined);
  // Initial intro frame zero is activation-owned. Content ordinals 1 and 2
  // advance through intro one and source body zero.
  effects.apply(graph.tick({ contentOrdinal: 0n }), () => undefined);
  effects.apply(graph.tick({ contentOrdinal: 1n }), () => undefined);

  const timeline = new DecodeTimeline(catalog.manifest.frameRate);
  const selected = selectIntegratedTestVideoRendition(catalog);
  const inspection = inspectSelectedVideoRendition(catalog, selected).inspection;
  const worker = new FakeWorker({
    retainOneStaleOutput: options.retainOneStaleOutput === true
  });
  const samples = new WorkerSampleFactory({
    catalog,
    timeline,
    rendition: "opaque-high",
    inspection,
    limits: LIMITS
  });
  let now = 0;
  const scheduler = new PathScheduler({
    timeline,
    samples,
    worker,
    rendition: "opaque-high",
    ringCapacity: 6,
    limits: LIMITS,
    clock: { now: () => ++now }
  });
  await scheduler.startBody({
    state: idle.id,
    body: idle.body,
    outgoingStarts: [edge.start],
    path: "source:idle",
    firstPresentationOrdinal: 2n
  });
  await scheduler.pump({ targetRingFrames: 1 });
  closeScheduledFrame(scheduler.takeNext());

  let nextPresentationOrdinal = 3n;
  if (options.sourceFrame === 1) {
    effects.apply(graph.tick({ contentOrdinal: 2n }), () => undefined);
    await scheduler.pump({ targetRingFrames: 1 });
    closeScheduledFrame(scheduler.takeNext());
    nextPresentationOrdinal = 4n;
  }

  const renderer = new FakeRenderer(order, 6);
  const failures = options.failures ?? [];
  const coordinator = new CutPresentationCoordinator({
    scheduler,
    renderer,
    enqueueMediaOperation: (operation) => operation(),
    onStaticRecovery: (failure) => failures.push(failure),
    readbackTag: (media) =>
      `${media.frame.unit}:${String(media.frame.localFrame)}`
  });
  const cut = Object.freeze({
    edge,
    targetState: hover.id,
    targetBody: hover.body,
    runway: Object.freeze(Array.from({ length: 6 }, (_, index) =>
      Object.freeze({
        frame: Object.freeze({
          rendition: "opaque-high",
          unit: hover.body.unitId,
          localFrame: index % hover.body.frameCount
        }),
        unitInstance: Math.floor(index / hover.body.frameCount),
        decodeOrdinal: index,
        timestamp: index * 33_333,
        layer: index
      })
    )),
    path: "cut:hover"
  });
  order.length = 0;
  return {
    graph,
    effects,
    requests,
    scheduler,
    worker,
    renderer,
    coordinator,
    cut,
    order,
    nextPresentationOrdinal
  };
}

function requestCut(fixture: CutFixture): Promise<void> {
  const result = fixture.graph.request("hover");
  if (result.requestId === undefined) throw new Error("cut request has no ID");
  const promise = fixture.requests.register(result.requestId);
  fixture.coordinator.synchronizeGraph(result);
  fixture.effects.apply(result);
  return promise;
}

function tickContext(fixture: CutFixture): IntegratedPlaybackTickContext {
  return {
    presentationOrdinal: fixture.nextPresentationOrdinal,
    rationalDeadlineUs: Number(fixture.nextPresentationOrdinal) * 33_333,
    graphSnapshot: fixture.graph.snapshot(),
    previewTick: (input) => fixture.graph.previewTick(input)
  };
}

function drawAndSynchronize(
  fixture: CutFixture,
  prepared: Readonly<IntegratedPreparedContentTick>,
  result: Readonly<MotionGraphResult>
): void {
  fixture.effects.apply(result, (presentation) => {
    fixture.coordinator.drawContentTick(prepared, presentation);
  });
  fixture.coordinator.synchronizeGraph(result);
}

function requirePrepared(
  prepared: Readonly<IntegratedPreparedContentTick> | null
): Readonly<IntegratedPreparedContentTick> {
  if (prepared === null) throw new Error("cut frame was not prepared");
  return prepared;
}

function closeScheduledFrame(result: ReturnType<PathScheduler["takeNext"]>): void {
  if (result.kind !== "frame") {
    throw new Error(`expected source frame, received ${result.kind}`);
  }
  result.frame.close();
}

function requireState(
  states: readonly Readonly<{
    readonly id: string;
    readonly body: Readonly<GraphBodyDefinition>;
  }>[],
  id: string
) {
  const state = states.find((candidate) => candidate.id === id);
  if (state === undefined) throw new Error(`missing state ${id}`);
  return state;
}

function requireEdge(
  edges: readonly Readonly<GraphEdgeDefinition>[],
  id: string
): Readonly<GraphEdgeDefinition> {
  const edge = edges.find((candidate) => candidate.id === id);
  if (edge === undefined) throw new Error(`missing edge ${id}`);
  return edge;
}

function bodyPresentation(
  state: string,
  unitId: string,
  frameIndex: number
): Readonly<GraphPresentation> {
  return Object.freeze({ kind: "body", state, unitId, frameIndex });
}

class FakeRenderer implements CutPresentationRenderer {
  public readonly resourceGeneration = 1;
  public readonly residentHandles: ResidentFrameHandle[];
  public readonly drawn: RenderFrameHandle[] = [];
  public missingLayer: number | null = null;
  public failDraw = false;
  readonly #order: string[];
  #uploadSerial = 0;

  public constructor(order: string[], residentLayers: number) {
    this.#order = order;
    this.residentHandles = Array.from({ length: residentLayers }, (_, layer) =>
      Object.freeze({
        kind: "resident" as const,
        layer,
        resourceGeneration: this.resourceGeneration
      })
    );
  }

  public residentHandle(layer: number): ResidentFrameHandle {
    if (layer === this.missingLayer) throw new Error("resident layer is missing");
    const handle = this.residentHandles[layer];
    if (handle === undefined) throw new RangeError("resident layer is invalid");
    return handle;
  }

  public async uploadStreaming(
    slot: number,
    pathGeneration: number,
    source: BorrowedVideoFrame,
    resourceGeneration = this.resourceGeneration
  ): Promise<StreamingFrameHandle> {
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

  public draw(handle: RenderFrameHandle): void {
    if (this.failDraw) throw new Error("injected draw failure");
    this.drawn.push(handle);
    const index = handle.kind === "resident" ? handle.layer : handle.slot;
    this.#order.push(`draw:${handle.kind}:${String(index)}`);
  }
}

interface PendingSample {
  readonly generation: number;
  readonly sample: Omit<DecoderWorkerSample, "data">;
}

class FakeWorker implements PathSchedulerWorkerAdapter {
  public activeGeneration: number | null = null;
  readonly #retainOneStaleOutput: boolean;
  readonly #pending: PendingSample[] = [];
  readonly #ready: FakeManagedFrame[] = [];
  readonly #open = new Set<FakeManagedFrame>();
  #acceptedSamples = 0;
  #releasedFrames = 0;
  #staleRetained = false;
  #lastSubmitted: PendingSample | null = null;

  public constructor(options: { readonly retainOneStaleOutput: boolean }) {
    this.#retainOneStaleOutput = options.retainOneStaleOutput;
  }

  public get queuedFrames(): number {
    return this.#ready.length;
  }

  public get openFrames(): number {
    return this.#open.size;
  }

  public async activateGeneration(generation: number): Promise<void> {
    const previous = this.activeGeneration;
    this.activeGeneration = generation;
    for (const frame of this.#ready) {
      if (frame.generation !== generation) frame.close();
    }
    this.#ready.splice(0, this.#ready.length,
      ...this.#ready.filter((frame) => !frame.closed));
    if (
      previous !== null &&
      this.#retainOneStaleOutput &&
      !this.#staleRetained &&
      this.#lastSubmitted?.generation === previous
    ) {
      this.#pending.splice(0, this.#pending.length, this.#lastSubmitted);
      this.#staleRetained = true;
    } else {
      this.#pending.length = 0;
    }
  }

  public async submit(
    generation: number,
    samples: readonly DecoderWorkerSample[]
  ): Promise<void> {
    if (generation !== this.activeGeneration) {
      throw new Error("fake worker generation mismatch");
    }
    for (const sample of samples) {
      const { data, ...metadata } = sample;
      structuredClone(data, { transfer: [data] });
      const pending = { generation, sample: metadata };
      this.#pending.push(pending);
      this.#lastSubmitted = pending;
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
    _options: DecoderWorkerWaitOptions = {}
  ): Promise<void> {
    while (this.#pending.length > 0 && this.#ready.length < minimum) {
      const pending = this.#pending.shift()!;
      const frame = new FakeManagedFrame(pending, () => {
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
      pendingSamples: 0,
      submittedFrames,
      leasedFrames,
      leasedDecodedBytes: leasedFrames * 128,
      decodeQueueSize: submittedFrames,
      activeGeneration: generation,
      nextSubmissionOrdinal: this.#acceptedSamples,
      nextOutputOrdinal: this.#acceptedSamples - this.#pending.length,
      errors: 0,
      disposed: false
    };
  }
}

class FakeManagedFrame implements ManagedDecoderWorkerFrame {
  public readonly frame = { close() {} } as unknown as VideoFrame;
  public readonly frameId: number;
  public readonly generation: number;
  public readonly ordinal: number;
  public readonly unitId: string;
  public readonly unitInstance: number;
  public readonly unitFrame: number;
  public readonly decodeIndex: number;
  public readonly timestamp: number;
  public readonly duration: number;
  public readonly decodedBytes = 128;
  readonly #release: () => void;
  #closed = false;

  public constructor(pending: PendingSample, release: () => void) {
    const unitFrame = pending.sample.presentationIndices[0];
    if (unitFrame === undefined) {
      throw new Error("fake integrated cut worker requires a displayed chunk");
    }
    const ordinal = pending.sample.presentationOrdinalBase + unitFrame;
    this.frameId = ordinal + 1;
    this.generation = pending.generation;
    this.ordinal = ordinal;
    this.unitId = pending.sample.unitId;
    this.unitInstance = pending.sample.unitInstance;
    this.unitFrame = unitFrame;
    this.decodeIndex = pending.sample.decodeIndex;
    this.timestamp = pending.sample.presentationTimestamp;
    this.duration = pending.sample.duration;
    this.#release = release;
  }

  public get closed(): boolean {
    return this.#closed;
  }

  public close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.frame.close();
    this.#release();
  }
}
