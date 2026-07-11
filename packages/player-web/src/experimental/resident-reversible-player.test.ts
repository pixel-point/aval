import { describe, expect, it } from "vitest";

import { ContinuousPathDecoder } from "./continuous-path-decoder.js";
import type {
  EncodedVideoChunkFactory,
  VideoDecoderAdapter,
  VideoDecoderFactory
} from "./continuous-loop-decoder.js";
import { createEncodedLoopUnit } from "./encoded-loop.js";
import { ResidentReversiblePlayer } from "./resident-reversible-player.js";
import { createResidentFramePlan } from "./resident-frame-plan.js";
import {
  WebGlFrameRenderer,
  type BackendTextureKind,
  type BorrowedVideoFrame,
  type CopyableVideoFrame,
  type FrameRendererBackend,
  type FrameTextureLayout
} from "./webgl-frame-renderer.js";

type Endpoint = "resting" | "engaged";

describe("ResidentReversiblePlayer", () => {
  it("joins cached target runway to streamed body frame R without underflow", async () => {
    const harness = await createHarness();
    const { player } = harness;
    player.request("engaged");

    const presentations: string[] = [];
    for (let step = 0; step < 16; step += 1) {
      const tick = player.tickOnce();
      presentations.push(describePresentation(tick.controller.presentation));
      await settleAsync();
      if (
        tick.controller.snapshot.phase === "stable" &&
        tick.controller.snapshot.visualEndpoint === "engaged"
      ) {
        break;
      }
    }

    expect(presentations).toContain("clip:0:forward");
    expect(presentations).toContain("clip:3:forward");
    expect(presentations).toContain("runway:engaged:0");
    expect(presentations).toContain("runway:engaged:5");
    expect(presentations.at(-1)).toBe("stable:engaged");
    expect(player.snapshot()).toMatchObject({
      visualState: "engaged",
      phase: "stable",
      underflows: 0,
      lastBodyPathFrame: "6",
      lastBodyContentFrame: 6,
      recoveryMisses: 0,
      decoder: {
        configureCalls: 1,
        resetCalls: 0,
        flushCalls: 0,
        boundaryFlushCalls: 0,
        cachedRunwayOutputs: 6
      }
    });
    expect(player.snapshot().recovery).toMatchObject({
      endpoint: "engaged",
      firstContinuationPathFrame: "6",
      recoveredBeforeRunwayEnd: true
    });

    player.dispose();
    expect(player.snapshot()).toMatchObject({
      state: "disposed",
      decoder: { openFrames: 0, disposed: true },
      renderer: { state: "disposed", allocatedLayers: 0 }
    });
  });

  it("changes direction on the next tick and supersedes target decode generation", async () => {
    const { player } = await createHarness();
    player.request("engaged");
    let tick = player.tickOnce();
    await settleAsync();
    while (
      tick.controller.presentation.kind !== "clip" ||
      tick.controller.presentation.frameIndex < 2
    ) {
      tick = player.tickOnce();
      await settleAsync();
    }
    const targetGeneration = tick.pathGeneration;

    player.request("resting");
    const reversed = player.tickOnce();
    await settleAsync();

    expect(reversed.controller.presentation).toEqual({
      kind: "clip",
      frameIndex: 1,
      direction: "reverse"
    });
    expect(reversed.pathGeneration).toBeGreaterThan(targetGeneration);
    expect(player.snapshot()).toMatchObject({
      requestedState: "resting",
      visualState: "resting",
      direction: "reverse",
      directionChanges: 1,
      activePathEndpoint: "resting",
      underflows: 0,
      decoder: {
        configureCalls: 1,
        resetCalls: 0,
        boundaryFlushCalls: 0
      }
    });
    player.dispose();
  });

  it("counts only a direction that is still active after one content tick", async () => {
    const { player } = await createHarness();
    player.request("engaged");
    let tick = player.tickOnce();
    await settleAsync();
    while (
      tick.controller.presentation.kind !== "clip" ||
      tick.controller.presentation.frameIndex < 2
    ) {
      tick = player.tickOnce();
      await settleAsync();
    }

    player.request("resting");
    player.request("engaged");
    const unchanged = player.tickOnce();

    expect(unchanged.controller.snapshot.direction).toBe("forward");
    expect(player.snapshot().directionChanges).toBe(0);
    player.dispose();
  });

  it("keeps drawing the remaining resident runway while inverse recovery waits", async () => {
    const uploadGate = deferred<void>();
    const { player, plan } = await createHarness({
      portalFrames: [4],
      targetUploadGate: uploadGate.promise
    });
    player.request("engaged");

    let tick = player.tickOnce();
    while (
      tick.controller.presentation.kind !== "runway" ||
      tick.controller.presentation.frameIndex !== 1
    ) {
      await settleAsync();
      tick = player.tickOnce();
    }

    player.request("resting");
    const fallbackLayers: number[] = [];
    for (const expectedFrame of [2, 3, 4]) {
      const fallback = player.tickOnce();
      expect(fallback.controller.presentation.kind).toBe("stable");
      expect(fallback.draw).toMatchObject({
        kind: "resident",
        layer: plan.targetRunwayLayers[expectedFrame]
      });
      if (fallback.draw.kind === "resident") {
        fallbackLayers.push(fallback.draw.layer);
      }
    }

    const reversed = player.tickOnce();
    expect(reversed.controller.presentation).toEqual({
      kind: "clip",
      frameIndex: 3,
      direction: "reverse"
    });
    expect(fallbackLayers).toEqual(
      [2, 3, 4].map((frame) => plan.targetRunwayLayers[frame])
    );
    expect(player.snapshot()).toMatchObject({
      requestedState: "resting",
      underflows: 0
    });

    uploadGate.resolve();
    await settleAsync();
    player.dispose();
  });

  it("keeps the runway tail when a same-tick inverse burst cancels", async () => {
    const { player, plan } = await createHarness({ portalFrames: [4] });
    player.request("engaged");

    let tick = player.tickOnce();
    while (
      tick.controller.presentation.kind !== "runway" ||
      tick.controller.presentation.frameIndex !== 1
    ) {
      await settleAsync();
      tick = player.tickOnce();
    }

    player.request("resting");
    player.request("engaged");
    const cancelled = player.tickOnce();
    expect(cancelled.controller.requests.map(({ outcome }) => outcome)).toEqual([
      "begin",
      "cancel"
    ]);
    expect(cancelled.controller.snapshot.phase).toBe("stable");
    expect(cancelled.draw).toMatchObject({
      kind: "resident",
      layer: plan.targetRunwayLayers[2]
    });
    expect(player.tickOnce().draw).toMatchObject({
      kind: "resident",
      layer: plan.targetRunwayLayers[3]
    });
    expect(player.snapshot().underflows).toBe(0);
    player.dispose();
  });

  it("cancels inverse intent while waiting without drawing a resident clip layer", async () => {
    const { player } = await createHarness({ portalFrames: [6] });
    player.request("engaged");
    const waiting = player.tickOnce();
    await settleAsync();
    expect(waiting.controller.snapshot.phase).toBe("waiting");

    player.request("resting");
    const cancelled = player.tickOnce();
    await settleAsync();
    expect(cancelled.controller.requests.at(-1)?.outcome).toBe("cancel");
    expect(cancelled.controller.presentation).toEqual({
      kind: "stable",
      endpoint: "resting"
    });
    expect(player.snapshot()).toMatchObject({
      phase: "stable",
      visualState: "resting",
      requestedState: "resting",
      directionChanges: 0,
      decoder: { pathStarts: 1 }
    });
    player.dispose();
  });

  it("freezes logical time while hidden and resumes only after visibility returns", async () => {
    const clock = new FakeAnimationClock();
    const visibility = new FakeVisibility();
    const { player } = await createHarness({ clock, visibility });
    await player.start();
    const before = player.snapshot().contentTicks;

    visibility.setHidden(true);
    clock.run(1_000);
    expect(player.snapshot()).toMatchObject({
      state: "paused",
      contentTicks: before
    });

    visibility.setHidden(false);
    await settleAsync();
    expect(player.state).toBe("running");
    clock.run(1_100);
    expect(player.snapshot().contentTicks).toBe(before + 1);
    player.dispose();
  });

  it("does not auto-resume after an explicit pause while hidden", async () => {
    const clock = new FakeAnimationClock();
    const visibility = new FakeVisibility();
    const { player } = await createHarness({ clock, visibility });
    await player.start();

    visibility.setHidden(true);
    player.pause();
    visibility.setHidden(false);
    await settleAsync();

    expect(player.state).toBe("paused");
    clock.run(1_000);
    expect(player.snapshot().contentTicks).toBe(0);
    player.dispose();
  });

  it("auto-resumes when start was requested while already hidden", async () => {
    const visibility = new FakeVisibility();
    visibility.hidden = true;
    const { player } = await createHarness({ visibility });

    await player.start();
    expect(player.state).toBe("paused");

    visibility.setHidden(false);
    await settleAsync();
    expect(player.state).toBe("running");
    player.dispose();
  });

  it("re-anchors realtime playback after accelerated manual ticks", async () => {
    const clock = new FakeAnimationClock();
    const { player } = await createHarness({ clock });
    player.pause();
    player.tickOnce();
    clock.now = 100;

    await player.resume();
    const before = player.snapshot().contentTicks;
    clock.run(100);

    expect(player.snapshot().contentTicks).toBe(before + 1);
    player.dispose();
  });

  it("does not enter running after pause wins an in-flight start", async () => {
    const { player } = await createHarness();
    const start = player.start();
    player.pause();
    await start;

    expect(player.state).toBe("paused");
    expect(player.snapshot().contentTicks).toBe(0);
    player.dispose();
  });
});

interface HarnessOptions {
  readonly portalFrames?: readonly number[];
  readonly clock?: FakeAnimationClock;
  readonly visibility?: FakeVisibility;
  readonly targetUploadGate?: Promise<void>;
}

async function createHarness(options: HarnessOptions = {}) {
  return createHarnessInternal(options);
}

async function createHarnessInternal(options: HarnessOptions) {
  const plan = createPlan();
  const backend = new FakeBackend();
  const renderer = new WebGlFrameRenderer(backend, plan, {
    streamingSlots: 3
  });
  for (let layer = 0; layer < plan.layerCount; layer += 1) {
    await renderer.uploadResident(
      layer,
      createBorrowedFrame(layer),
      renderer.resourceGeneration
    );
  }

  const codec = createFakeCodec(options.targetUploadGate);
  const decoder = new ContinuousPathDecoder(
    [
      { id: "source-body", unit: createBodyUnit(0x10) },
      { id: "target-body", unit: createBodyUnit(0xb0) }
    ],
    {
      maxInFlight: 8,
      decoderFactory: codec.decoderFactory,
      chunkFactory: codec.chunkFactory
    }
  );
  const clock = options.clock ?? new FakeAnimationClock();
  const visibility = options.visibility ?? new FakeVisibility();
  const player = new ResidentReversiblePlayer<Endpoint>({
    plan,
    frameRate: { numerator: 30, denominator: 1 },
    source: {
      endpoint: "resting",
      bodyUnitId: "source-body",
      bodyFrameCount: 8,
      portalFrames: options.portalFrames ?? [2, 6]
    },
    target: {
      endpoint: "engaged",
      bodyUnitId: "target-body",
      bodyFrameCount: 8,
      portalFrames: options.portalFrames ?? [2, 6]
    },
    decoder,
    renderer,
    requestFrame: clock.request,
    cancelFrame: clock.cancel,
    now: () => clock.now,
    visibilitySource: visibility
  });
  await player.prepare();
  await settleAsync();
  return { player, renderer, decoder, backend, clock, visibility, codec, plan };
}

function createPlan() {
  return createResidentFramePlan({
    width: 2,
    height: 2,
    sourceRunway: keys("source-body", 6),
    clip: keys("clip", 4),
    targetRunway: keys("target-body", 6),
    deviceLimits: {
      maxArrayTextureLayers: 128,
      maxTextureSize: 4_096
    }
  });
}

function keys(unit: string, count: number) {
  return Array.from({ length: count }, (_, localFrame) => ({
    rendition: "main",
    unit,
    localFrame
  }));
}

function createBodyUnit(tagBase: number) {
  return createEncodedLoopUnit({
    config: {
      codec: "vp8",
      codedWidth: 2,
      codedHeight: 2,
      displayAspectWidth: 2,
      displayAspectHeight: 2
    },
    codedWidth: 2,
    codedHeight: 2,
    displayWidth: 2,
    displayHeight: 2,
    frameRate: { numerator: 30, denominator: 1 },
    frames: Array.from({ length: 8 }, (_, index) => ({
      type: index === 0 ? ("key" as const) : ("delta" as const),
      data: new Uint8Array([tagBase + index])
    }))
  });
}

function describePresentation(
  presentation: ReturnType<ResidentReversiblePlayer<Endpoint>["tickOnce"]>["controller"]["presentation"]
): string {
  if (presentation.kind === "stable") {
    return `stable:${presentation.endpoint}`;
  }
  if (presentation.kind === "clip") {
    return `clip:${String(presentation.frameIndex)}:${presentation.direction}`;
  }
  return `runway:${presentation.endpoint}:${String(presentation.frameIndex)}`;
}

class FakeBackend implements FrameRendererBackend {
  public readonly limits = Object.freeze({
    maxTextureSize: 4_096,
    maxArrayTextureLayers: 128
  });
  public readonly draws: Array<[BackendTextureKind, number]> = [];
  public disposeCalls = 0;

  public allocate(_layout: FrameTextureLayout, _streamingSlots: number): void {}
  public upload(_kind: BackendTextureKind, _index: number, _pixels: Uint8Array): void {}
  public draw(kind: BackendTextureKind, index: number): void {
    this.draws.push([kind, index]);
  }
  public dispose(): void {
    this.disposeCalls += 1;
  }
}

function createBorrowedFrame(value: number, gate?: Promise<void>): BorrowedVideoFrame {
  const frame = createCopyableFrame(value, 0);
  return {
    frame: {
      ...frame,
      async copyTo(destination, copyOptions) {
        await gate;
        return frame.copyTo(destination, copyOptions);
      }
    },
    close() {}
  };
}

function createCopyableFrame(
  value: number,
  timestamp: number,
  copyGate?: Promise<void>
): CopyableVideoFrame & {
  readonly timestamp: number;
  readonly duration: number;
  close(): void;
} {
  let closed = false;
  return {
    timestamp,
    duration: 33_333,
    codedWidth: 2,
    codedHeight: 2,
    displayWidth: 2,
    displayHeight: 2,
    visibleRect: { x: 0, y: 0, width: 2, height: 2 } as DOMRectReadOnly,
    async copyTo(destination) {
      await copyGate;
      if (closed) {
        throw new Error("copyTo used a closed fake frame");
      }
      const bytes = ArrayBuffer.isView(destination)
        ? new Uint8Array(
            destination.buffer,
            destination.byteOffset,
            destination.byteLength
          )
        : new Uint8Array(destination);
      bytes.fill(value);
      return [{ offset: 0, stride: 8 }];
    },
    close() {
      closed = true;
    }
  };
}

function createFakeCodec(targetUploadGate?: Promise<void>): {
  readonly decoderFactory: VideoDecoderFactory;
  readonly chunkFactory: EncodedVideoChunkFactory;
} {
  return {
    decoderFactory: (init) => new FakeVideoDecoder(init, targetUploadGate),
    chunkFactory: (init) =>
      new FakeEncodedVideoChunk(init) as unknown as EncodedVideoChunk
  };
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
      ? new Uint8Array(
          init.data.buffer,
          init.data.byteOffset,
          init.data.byteLength
        )
      : new Uint8Array(init.data);
    this.data = new Uint8Array(source);
  }
}

class FakeVideoDecoder implements VideoDecoderAdapter {
  public decodeQueueSize = 0;
  readonly #init: VideoDecoderInit;
  readonly #targetUploadGate: Promise<void> | undefined;

  public constructor(init: VideoDecoderInit, targetUploadGate?: Promise<void>) {
    this.#init = init;
    this.#targetUploadGate = targetUploadGate;
  }
  public configure(_config: VideoDecoderConfig): void {}
  public decode(chunk: EncodedVideoChunk): void {
    this.decodeQueueSize += 1;
    const encoded = chunk as unknown as FakeEncodedVideoChunk;
    queueMicrotask(() => {
      this.decodeQueueSize -= 1;
      this.#init.output(
        createCopyableFrame(
          encoded.data[0] ?? 0,
          encoded.timestamp,
          (encoded.data[0] ?? 0) >= 0xb0
            ? this.#targetUploadGate
            : undefined
        ) as unknown as VideoFrame
      );
    });
  }
  public async flush(): Promise<void> {}
  public close(): void {}
}

class FakeAnimationClock {
  public now = 0;
  readonly #callbacks = new Map<number, FrameRequestCallback>();
  #nextId = 1;

  public readonly request = (callback: FrameRequestCallback): number => {
    const id = this.#nextId++;
    this.#callbacks.set(id, callback);
    return id;
  };
  public readonly cancel = (id: number): void => {
    this.#callbacks.delete(id);
  };
  public run(now: number): void {
    this.now = now;
    const callbacks = [...this.#callbacks.values()];
    this.#callbacks.clear();
    for (const callback of callbacks) {
      callback(now);
    }
  }
}

class FakeVisibility {
  public hidden = false;
  readonly #listeners = new Set<() => void>();
  public addEventListener(_type: "change", listener: () => void): void {
    this.#listeners.add(listener);
  }
  public removeEventListener(_type: "change", listener: () => void): void {
    this.#listeners.delete(listener);
  }
  public setHidden(hidden: boolean): void {
    this.hidden = hidden;
    for (const listener of this.#listeners) {
      listener();
    }
  }
}

async function settleAsync(): Promise<void> {
  for (let step = 0; step < 16; step += 1) {
    await Promise.resolve();
  }
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}
