import type { RenditionV01, UnitV01 } from "@rendered-motion/format";
import { describe, expect, it } from "vitest";

import type {
  DecoderWorkerLimits,
  DecoderWorkerMetrics,
  DecoderWorkerSample
} from "../decoder-worker/protocol.js";
import type {
  DecoderWorkerWaitOptions,
  ManagedDecoderWorkerFrame
} from "../decoder-worker/client.js";
import type { RuntimeCatalogAccessUnit } from "./asset-catalog.js";
import { DecodeTimeline } from "./decode-timeline.js";
import {
  InteractionCachePreparationTimeoutError,
  prepareInteractionCache,
  type InteractionCachePreparationUnitCatalog,
  type InteractionCachePreparationWorker
} from "./interaction-cache-preparation.js";
import {
  createInteractionCachePlanFromSemanticSequences,
  type InteractionCachePlan
} from "./interaction-cache-plan.js";
import {
  OpaqueFrameRenderer,
  type CopyableVideoFrame,
  type OpaqueFrameRendererBackend,
  type OpaqueFrameTextureLayout,
  type OpaqueTextureKind
} from "./opaque-frame-renderer.js";
import {
  WorkerSampleFactory,
  type WorkerSampleCatalog
} from "./worker-samples.js";

const LIMITS = Object.freeze({
  maxDecodeQueueSize: 3,
  maxPendingSamples: 3,
  maxOutstandingFrames: 3,
  maxDecodedBytes: 3 * 2 * 2 * 4
});

describe("worker-backed interaction cache preparation", () => {
  it("deduplicates edges, decodes complete occurrences, and reports every release", async () => {
    const fixture = createFixture({ injectStaleFrame: true });

    const report = await prepareInteractionCache(fixture.input);

    expect(report).toEqual({
      generation: 2,
      resourceGeneration: 1,
      unitOccurrences: 2,
      submittedFrames: 7,
      decodedFrames: 7,
      uploadedFrames: 3,
      dependencyFramesClosed: 4,
      staleFrames: 1,
      releasedFrames: 8
    });
    expect(fixture.plan.layerCount).toBe(3);
    expect(fixture.worker.submittedIdentities()).toEqual([
      ["alpha", 0, 0],
      ["alpha", 0, 1],
      ["alpha", 0, 2],
      ["alpha", 0, 3],
      ["beta", 1, 0],
      ["beta", 1, 1],
      ["beta", 1, 2]
    ]);
    expect(fixture.worker.maximumOutstanding).toBeLessThanOrEqual(3);
    expect(fixture.backend.uploads).toEqual([
      [0, 0],
      [1, 2],
      [2, 18]
    ]);
    expect(fixture.worker.frames.every(({ closed }) => closed)).toBe(true);
    expect(fixture.worker.openFrames).toBe(0);
    expect(fixture.worker.pendingFrames).toBe(0);
    await expect(fixture.worker.snapshotMetrics()).resolves.toMatchObject({
      resetCalls: 0,
      flushCalls: 0,
      boundaryFlushCalls: 0,
      releasedFrames: 8,
      leasedFrames: 0,
      pendingSamples: 0,
      submittedFrames: 0
    });
  });

  it("streams a long dependency prefix through lower worker credit", async () => {
    const plan = singleFramePlan("long", 23);
    const fixture = createFixture({
      plan,
      units: { long: 24 },
      limits: { ...LIMITS, maxOutstandingFrames: 2, maxPendingSamples: 2 }
    });

    const report = await prepareInteractionCache(fixture.input, {
      maxBatchSamples: 2
    });

    expect(report).toMatchObject({
      unitOccurrences: 1,
      submittedFrames: 24,
      decodedFrames: 24,
      uploadedFrames: 1,
      dependencyFramesClosed: 23,
      staleFrames: 0,
      releasedFrames: 24
    });
    expect(fixture.worker.maximumSubmittedBatch).toBeLessThanOrEqual(2);
    expect(fixture.worker.maximumOutstanding).toBeLessThanOrEqual(2);
    expect(fixture.worker.submittedIdentities()).toEqual(
      Array.from({ length: 24 }, (_, frame) => ["long", 0, frame])
    );
    expect(fixture.worker.frames.every(({ closed }) => closed)).toBe(true);
  });

  it("retires the generation after a partial submission transfer failure", async () => {
    const fixture = createFixture({
      failSubmitCall: 2,
      limits: { ...LIMITS, maxOutstandingFrames: 2, maxPendingSamples: 2 }
    });

    await expect(prepareInteractionCache(fixture.input, {
      maxBatchSamples: 2
    })).rejects.toThrow("injected sample transfer failure");

    expect(fixture.worker.abortCalls).toBe(1);
    expect(fixture.worker.openFrames).toBe(0);
    expect(fixture.worker.pendingFrames).toBe(0);
    expect(fixture.worker.frames.every(({ closed }) => closed)).toBe(true);
  });

  it("releases the current and queued outputs after an upload failure", async () => {
    const fixture = createFixture();
    fixture.backend.failUpload = true;

    await expect(prepareInteractionCache(fixture.input))
      .rejects.toThrow("injected resident upload failure");

    expect(fixture.worker.abortCalls).toBe(1);
    expect(fixture.worker.openFrames).toBe(0);
    expect(fixture.worker.pendingFrames).toBe(0);
    expect(fixture.worker.frames.every(({ closed }) => closed)).toBe(true);
    expect(fixture.renderer.snapshot()).toMatchObject({
      state: "error",
      closedSourceFrames: 1
    });
  });

  it("closes and rejects an unexpected worker output identity", async () => {
    const fixture = createFixture({ corruptFirstOutput: true });

    await expect(prepareInteractionCache(fixture.input))
      .rejects.toThrow("worker output did not match submitted cache identity");

    expect(fixture.backend.uploads).toEqual([]);
    expect(fixture.worker.abortCalls).toBe(1);
    expect(fixture.worker.openFrames).toBe(0);
    expect(fixture.worker.pendingFrames).toBe(0);
    expect(fixture.worker.frames.every(({ closed }) => closed)).toBe(true);
  });

  it.each(["snapshot", "submit", "wait", "upload"] as const)(
    "honors cancellation at the %s await boundary",
    async (stage) => {
      const gate = new Gate();
      const fixture = createFixture({ gateStage: stage, gate });
      const controller = new AbortController();
      const operation = prepareInteractionCache(fixture.input, {
        signal: controller.signal,
        timeoutMs: 10_000
      });
      await gate.entered;
      controller.abort(new DOMException("test cancellation", "AbortError"));
      gate.open();

      await expect(operation).rejects.toMatchObject({ name: "AbortError" });
      expect(fixture.worker.abortCalls).toBe(stage === "snapshot" ? 0 : 1);
      expect(fixture.worker.openFrames).toBe(0);
      expect(fixture.worker.pendingFrames).toBe(0);
      expect(fixture.worker.frames.every(({ closed }) => closed)).toBe(true);
      await fixture.renderer.settled();
    }
  );

  it("turns the preparation deadline into a cleaned timeout failure", async () => {
    const gate = new Gate();
    const fixture = createFixture({ gateStage: "wait", gate });
    const operation = prepareInteractionCache(fixture.input, { timeoutMs: 5 });
    await gate.entered;

    await expect(operation).rejects.toBeInstanceOf(
      InteractionCachePreparationTimeoutError
    );
    expect(fixture.worker.abortCalls).toBe(1);
    expect(fixture.worker.openFrames).toBe(0);
    expect(fixture.worker.pendingFrames).toBe(0);
  });

  it("detects worker generation supersession without aborting the replacement", async () => {
    const fixture = createFixture({ supersedeOnWait: 2 });

    await expect(prepareInteractionCache(fixture.input))
      .rejects.toMatchObject({ name: "AbortError" });

    expect(fixture.worker.activeGeneration).toBe(2);
    expect(fixture.worker.abortCalls).toBe(0);
    expect(fixture.worker.openFrames).toBe(0);
    expect(fixture.worker.pendingFrames).toBe(0);
  });

  it("does not consume replacement output when superseded during upload", async () => {
    const gate = new Gate();
    const fixture = createFixture({ gateStage: "upload", gate });
    const operation = prepareInteractionCache(fixture.input);
    await gate.entered;
    fixture.worker.supersede(2);
    gate.open();

    await expect(operation).rejects.toMatchObject({ name: "AbortError" });
    expect(fixture.worker.activeGeneration).toBe(2);
    expect(fixture.worker.abortCalls).toBe(0);
    expect(fixture.worker.openFrames).toBe(0);
    expect(fixture.worker.pendingFrames).toBe(0);
  });

  it("accepts a zero-layer plan without submitting or touching the renderer", async () => {
    const plan = createInteractionCachePlanFromSemanticSequences({
      rendition: "opaque",
      width: 2,
      height: 2,
      reversibleClips: [],
      cutRunways: [],
      deviceLimits: { maxTextureSize: 4_096, maxArrayTextureLayers: 128 }
    });
    const fixture = createFixture({ plan });

    await expect(prepareInteractionCache(fixture.input)).resolves.toEqual({
      generation: 1,
      resourceGeneration: 1,
      unitOccurrences: 0,
      submittedFrames: 0,
      decodedFrames: 0,
      uploadedFrames: 0,
      dependencyFramesClosed: 0,
      staleFrames: 0,
      releasedFrames: 0
    });
    expect(fixture.worker.submitCalls).toBe(0);
    expect(fixture.backend.uploads).toEqual([]);
  });
});

type AwaitStage = "snapshot" | "submit" | "wait" | "upload";

interface FixtureOptions {
  readonly plan?: Readonly<InteractionCachePlan>;
  readonly units?: Readonly<Record<string, number>>;
  readonly limits?: DecoderWorkerLimits;
  readonly injectStaleFrame?: boolean;
  readonly failSubmitCall?: number;
  readonly corruptFirstOutput?: boolean;
  readonly supersedeOnWait?: number;
  readonly gateStage?: AwaitStage;
  readonly gate?: Gate;
}

function createFixture(options: FixtureOptions = {}) {
  const plan = options.plan ?? defaultPlan();
  const units = options.units ?? { alpha: 4, beta: 3 };
  const limits = options.limits ?? LIMITS;
  const catalog = new FakeCatalog(units);
  const timeline = new DecodeTimeline({ numerator: 30, denominator: 1 });
  let generation = timeline.activateNextGeneration();
  if (options.injectStaleFrame === true) {
    generation = timeline.activateNextGeneration();
  }
  const samples = new WorkerSampleFactory({
    catalog,
    timeline,
    rendition: "opaque",
    limits
  });
  const worker = new FakeWorker(generation, plan.bytesPerFrame, options);
  const backend = new FakeBackend();
  const renderer = new OpaqueFrameRenderer(backend, {
    codedWidth: plan.width,
    codedHeight: plan.height,
    logicalWidth: plan.width,
    logicalHeight: plan.height,
    residentLayerCount: plan.layerCount
  });
  const input = {
    plan,
    catalog,
    samples,
    worker,
    renderer,
    limits
  } as const;
  return { plan, catalog, timeline, samples, worker, backend, renderer, input };
}

function defaultPlan(): Readonly<InteractionCachePlan> {
  return createInteractionCachePlanFromSemanticSequences({
    rendition: "opaque",
    width: 2,
    height: 2,
    reversibleClips: [],
    cutRunways: [
      cut("a-alpha", "alpha", [0, 2, 0, 2, 0, 2]),
      cut("b-alpha-shared", "alpha", [2, 0, 2, 0, 2, 0]),
      cut("c-beta", "beta", [2, 2, 2, 2, 2, 2])
    ],
    deviceLimits: { maxTextureSize: 4_096, maxArrayTextureLayers: 128 }
  });
}

function singleFramePlan(
  unit: string,
  localFrame: number
): Readonly<InteractionCachePlan> {
  return createInteractionCachePlanFromSemanticSequences({
    rendition: "opaque",
    width: 2,
    height: 2,
    reversibleClips: [],
    cutRunways: [cut("only", unit, Array(6).fill(localFrame) as number[])],
    deviceLimits: { maxTextureSize: 4_096, maxArrayTextureLayers: 128 }
  });
}

function cut(edge: string, unit: string, frames: readonly number[]) {
  return {
    edge,
    state: `${unit}-state`,
    port: "default",
    frames: frames.map((localFrame) => ({
      rendition: "opaque",
      unit,
      localFrame
    }))
  };
}

class FakeCatalog
implements WorkerSampleCatalog, InteractionCachePreparationUnitCatalog {
  readonly #units: ReadonlyMap<string, Readonly<UnitV01>>;
  readonly #unitOrdinals: ReadonlyMap<string, number>;

  public readonly renditions = {
    require: (id: string): Readonly<RenditionV01> => {
      if (id !== "opaque") throw new RangeError("unknown rendition");
      return {
        id,
        profile: "avc-annexb-opaque-v0",
        codec: "avc1.42E020",
        codedWidth: 2,
        codedHeight: 2,
        alphaLayout: { type: "opaque-v0", colorRect: [0, 0, 2, 2] },
        bitrate: { average: 1, peak: 1 },
        capabilities: ["webcodecs", "webgl2"]
      };
    }
  };

  public readonly units = {
    require: (id: string): Readonly<UnitV01> => {
      const unit = this.#units.get(id);
      if (unit === undefined) throw new RangeError(`unknown unit ${id}`);
      return unit;
    }
  };

  public readonly records = {
    require: (
      rendition: string,
      unit: string,
      localFrame: number
    ): Readonly<RuntimeCatalogAccessUnit> => {
      const descriptor = this.units.require(unit);
      const unitIndex = this.#unitOrdinals.get(unit);
      if (
        rendition !== "opaque" ||
        unitIndex === undefined ||
        localFrame < 0 ||
        localFrame >= descriptor.frameCount
      ) {
        throw new RangeError("unknown access unit");
      }
      return {
        rendition,
        unit,
        localFrame,
        ordinal: localFrame,
        range: { offset: 0, length: 1 },
        record: {
          payloadOffset: 0,
          payloadLength: 1,
          unitIndex,
          renditionIndex: 0,
          key: localFrame === 0,
          frameIndex: localFrame
        }
      };
    }
  };

  public constructor(units: Readonly<Record<string, number>>) {
    const entries = Object.entries(units).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0
    );
    this.#unitOrdinals = new Map(entries.map(([id], index) => [id, index]));
    this.#units = new Map(entries.map(([id, frameCount]) => [id, {
      id,
      kind: "one-shot" as const,
      frameCount,
      samples: [{
        rendition: "opaque",
        sampleStart: 0,
        sampleCount: frameCount,
        sha256: "0".repeat(64)
      }]
    }]));
  }

  public copySample(
    _rendition: string,
    unit: string,
    localFrame: number
  ): ArrayBuffer {
    const unitIndex = this.#unitOrdinals.get(unit);
    if (unitIndex === undefined) throw new RangeError("unknown unit");
    return Uint8Array.of(unitIndex * 16 + localFrame).buffer;
  }
}

interface PendingSample {
  readonly generation: number;
  readonly sample: Omit<DecoderWorkerSample, "data">;
  readonly tag: number;
}

class FakeWorker implements InteractionCachePreparationWorker {
  public activeGeneration: number | null;
  public readonly frames: FakeManagedFrame[] = [];
  public abortCalls = 0;
  public submitCalls = 0;
  public maximumSubmittedBatch = 0;
  public maximumOutstanding = 0;

  readonly #decodedBytes: number;
  readonly #options: FixtureOptions;
  readonly #pending: PendingSample[] = [];
  readonly #ready: FakeManagedFrame[] = [];
  readonly #open = new Set<FakeManagedFrame>();
  readonly #submitted: PendingSample[] = [];
  #acceptedSamples = 0;
  #deliveredFrames = 0;
  #releasedFrames = 0;
  #staleInjected = false;
  #corrupted = false;
  #nextFrameId = 1;

  public constructor(
    generation: number,
    decodedBytes: number,
    options: FixtureOptions
  ) {
    this.activeGeneration = generation;
    this.#decodedBytes = decodedBytes;
    this.#options = options;
  }

  public get queuedFrames(): number {
    return this.#ready.length;
  }

  public get openFrames(): number {
    return this.#open.size;
  }

  public get pendingFrames(): number {
    return this.#pending.length;
  }

  public submittedIdentities(): readonly (readonly [string, number, number])[] {
    return this.#submitted.map(({ sample }) => [
      sample.unitId,
      sample.unitInstance,
      sample.unitFrame
    ]);
  }

  public async submit(
    generation: number,
    samples: readonly DecoderWorkerSample[]
  ): Promise<void> {
    this.submitCalls += 1;
    if (this.#options.gateStage === "submit") {
      await this.#options.gate?.wait();
    }
    if (this.submitCalls === this.#options.failSubmitCall) {
      throw new Error("injected sample transfer failure");
    }
    if (generation !== this.activeGeneration) {
      throw new Error("fake worker generation mismatch");
    }
    this.maximumSubmittedBatch = Math.max(
      this.maximumSubmittedBatch,
      samples.length
    );
    for (const sample of samples) {
      const tag = new Uint8Array(sample.data)[0] ?? -1;
      const { data, ...metadata } = sample;
      structuredClone(data, { transfer: [data] });
      const pending = { generation, sample: metadata, tag };
      this.#pending.push(pending);
      this.#submitted.push(pending);
      this.#acceptedSamples += 1;
    }
    this.#trackOutstanding();
  }

  public async abortGeneration(generation: number): Promise<void> {
    this.abortCalls += 1;
    this.#pending.splice(0, this.#pending.length,
      ...this.#pending.filter((item) => item.generation !== generation));
    for (const frame of [...this.#open]) {
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
    if (this.#options.gateStage === "wait") {
      await this.#options.gate?.wait(options.signal);
    }
    if (this.#options.supersedeOnWait !== undefined) {
      this.supersede(this.#options.supersedeOnWait);
      return;
    }
    if (options.signal?.aborted === true) throw options.signal.reason;
    if (this.#options.injectStaleFrame === true && !this.#staleInjected) {
      this.#staleInjected = true;
      const first = this.#pending[0];
      if (first !== undefined) {
        this.#enqueueFrame({
          ...first,
          generation: first.generation - 1,
          tag: 255
        });
      }
    }
    while (this.#ready.length < minimum && this.#pending.length > 0) {
      this.#enqueueFrame(this.#pending.shift()!);
    }
  }

  public async snapshotMetrics(): Promise<DecoderWorkerMetrics> {
    if (this.#options.gateStage === "snapshot") {
      await this.#options.gate?.wait();
    }
    return {
      configureCalls: 1,
      resetCalls: 0,
      flushCalls: 0,
      boundaryFlushCalls: 0,
      acceptedSamples: this.#acceptedSamples,
      submittedChunks: this.#acceptedSamples,
      outputFrames: this.#deliveredFrames,
      deliveredFrames: this.#deliveredFrames,
      releasedFrames: this.#releasedFrames,
      staleFrames: Number(this.#staleInjected),
      closedFrames: this.#releasedFrames,
      pendingSamples: 0,
      submittedFrames: this.#pending.length,
      leasedFrames: this.#open.size,
      leasedDecodedBytes: this.#open.size * this.#decodedBytes,
      decodeQueueSize: this.#pending.length,
      activeGeneration: this.activeGeneration,
      nextSubmissionOrdinal: this.#acceptedSamples,
      nextOutputOrdinal: this.#deliveredFrames,
      errors: 0,
      disposed: false
    };
  }

  #enqueueFrame(pending: PendingSample): void {
    const metadata = this.#options.corruptFirstOutput === true && !this.#corrupted
      ? { ...pending.sample, unitFrame: pending.sample.unitFrame + 1 }
      : pending.sample;
    this.#corrupted = true;
    let frame: FakeManagedFrame;
    frame = new FakeManagedFrame({
      frameId: this.#nextFrameId,
      generation: pending.generation,
      sample: metadata,
      decodedBytes: this.#decodedBytes,
      tag: pending.tag,
      uploadGate: this.#options.gateStage === "upload"
        ? this.#options.gate
        : undefined,
      release: () => {
        this.#open.delete(frame);
        this.#releasedFrames += 1;
      }
    });
    this.#nextFrameId += 1;
    this.frames.push(frame);
    this.#open.add(frame);
    this.#ready.push(frame);
    this.#deliveredFrames += 1;
    this.#trackOutstanding();
  }

  public supersede(generation: number): void {
    this.activeGeneration = generation;
    this.#pending.length = 0;
    for (const frame of [...this.#open]) frame.close();
    this.#ready.length = 0;
  }

  #trackOutstanding(): void {
    const generation = this.activeGeneration;
    this.maximumOutstanding = Math.max(
      this.maximumOutstanding,
      this.#pending.filter((item) => item.generation === generation).length +
        [...this.#open].filter((frame) => frame.generation === generation).length
    );
  }
}

class FakeManagedFrame implements ManagedDecoderWorkerFrame {
  public readonly frame: VideoFrame;
  public readonly frameId: number;
  public readonly generation: number;
  public readonly ordinal: number;
  public readonly unitId: string;
  public readonly unitInstance: number;
  public readonly unitFrame: number;
  public readonly timestamp: number;
  public readonly duration: number;
  public readonly decodedBytes: number;
  readonly #release: () => void;
  #closed = false;

  public constructor(input: {
    readonly frameId: number;
    readonly generation: number;
    readonly sample: Omit<DecoderWorkerSample, "data">;
    readonly decodedBytes: number;
    readonly tag: number;
    readonly uploadGate: Gate | undefined;
    readonly release: () => void;
  }) {
    this.frameId = input.frameId;
    this.generation = input.generation;
    this.ordinal = input.sample.ordinal;
    this.unitId = input.sample.unitId;
    this.unitInstance = input.sample.unitInstance;
    this.unitFrame = input.sample.unitFrame;
    this.timestamp = input.sample.timestamp;
    this.duration = input.sample.duration;
    this.decodedBytes = input.decodedBytes;
    this.frame = new FakeVideoFrame(
      input.tag,
      input.uploadGate
    ) as unknown as VideoFrame;
    this.#release = input.release;
  }

  public get closed(): boolean {
    return this.#closed;
  }

  public close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.frame.close();
    } finally {
      this.#release();
    }
  }
}

class FakeVideoFrame implements CopyableVideoFrame {
  public readonly codedWidth = 2;
  public readonly codedHeight = 2;
  public readonly displayWidth = 2;
  public readonly displayHeight = 2;
  public readonly visibleRect = {
    x: 0,
    y: 0,
    width: 2,
    height: 2
  } as DOMRectReadOnly;
  public closed = false;
  readonly #tag: number;
  readonly #uploadGate: Gate | undefined;

  public constructor(tag: number, uploadGate: Gate | undefined) {
    this.#tag = tag;
    this.#uploadGate = uploadGate;
  }

  public async copyTo(
    destination: AllowSharedBufferSource
  ): Promise<readonly PlaneLayout[]> {
    await this.#uploadGate?.wait();
    const bytes = ArrayBuffer.isView(destination)
      ? new Uint8Array(
          destination.buffer,
          destination.byteOffset,
          destination.byteLength
        )
      : new Uint8Array(destination);
    bytes.fill(this.#tag);
    return [{ offset: 0, stride: 8 }];
  }

  public close(): void {
    if (this.closed) throw new Error("fake VideoFrame closed twice");
    this.closed = true;
  }
}

class FakeBackend implements OpaqueFrameRendererBackend {
  public readonly limits = Object.freeze({
    maxTextureSize: 4_096,
    maxArrayTextureLayers: 128
  });
  public readonly uploads: Array<readonly [number, number]> = [];
  public failUpload = false;

  public allocate(
    _layout: OpaqueFrameTextureLayout,
    _streamingSlots: number
  ): void {}

  public upload(
    kind: OpaqueTextureKind,
    layer: number,
    pixels: Uint8Array
  ): void {
    if (this.failUpload) throw new Error("injected resident upload failure");
    if (kind !== "resident") throw new Error("unexpected streaming upload");
    this.uploads.push([layer, pixels[0] ?? -1]);
  }

  public draw(): void {}
  public dispose(): void {}
}

class Gate {
  readonly entered: Promise<void>;
  readonly #resume: Promise<void>;
  #markEntered!: () => void;
  #open!: () => void;

  public constructor() {
    this.entered = new Promise((resolve) => {
      this.#markEntered = resolve;
    });
    this.#resume = new Promise((resolve) => {
      this.#open = resolve;
    });
  }

  public open(): void {
    this.#open();
  }

  public async wait(signal?: AbortSignal): Promise<void> {
    this.#markEntered();
    if (signal === undefined) {
      await this.#resume;
      return;
    }
    if (signal.aborted) throw signal.reason;
    await new Promise<void>((resolve, reject) => {
      const abort = (): void => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      void this.#resume.then(() => {
        signal.removeEventListener("abort", abort);
        resolve();
      });
    });
  }
}
