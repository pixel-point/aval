import { describe, expect, it } from "vitest";

import type { Manifest, Unit } from "../src/asset.js";
import type { MotionGraphSnapshot } from "@pixel-point/aval-graph";
import {
  planRoutePrefetch,
  RoutePrefetchQueue,
  type PrefetchIntent,
  type PrefetchReason
} from "../src/route-prefetch.js";

describe("route prefetch planning", () => {
  it("omits completion speculation for pending and follow-on intent", () => {
    const manifest = fixture();
    const completion = planRoutePrefetch(
      manifest,
      snapshot(),
      stream("entering-body"),
      12,
      false
    );
    const pending = planRoutePrefetch(
      manifest,
      snapshot({
        phase: "waiting",
        requestedState: "exiting",
        isTransitioning: true,
        pendingEdgeId: "entering.exiting"
      }),
      stream("entering-body"),
      12,
      false
    );
    const followOn = planRoutePrefetch(
      manifest,
      snapshot({
        requestedState: "exiting",
        isTransitioning: true,
        followOnEdgeId: "entering.exiting"
      }),
      stream("entering-body"),
      12,
      false
    );

    expect(reasons(completion)).toEqual([["hover-loop", "completion"]]);
    expect(reasons(pending)).toEqual([["exit-body", "pending-route"]]);
    expect(reasons(followOn)).toEqual([["exit-body", "follow-on-route"]]);
  });

  it("orders the current intro body before its deferred pending route", () => {
    const plan = planRoutePrefetch(
      fixture(),
      snapshot({
        phase: "intro",
        requestedState: "exiting",
        isTransitioning: true,
        presentation: {
          kind: "intro",
          state: "entering",
          unitId: "entering-intro",
          frameIndex: 0
        },
        pendingEdgeId: "entering.exiting"
      }),
      stream("entering-intro"),
      12,
      false
    );

    expect(reasons(plan)).toEqual([
      ["entering-body", "intro-body"],
      ["exit-body", "pending-route"]
    ]);
  });

  it("does not synthesize a detached-body resume lane", () => {
    const plan = planRoutePrefetch(
      fixture(),
      snapshot({
        phase: "waiting",
        requestedState: "exiting",
        isTransitioning: true,
        pendingEdgeId: "entering.exiting"
      }),
      null,
      12,
      false
    );

    expect(reasons(plan)).toEqual([["exit-body", "pending-route"]]);
  });

  it("protects a loop wrap when the final portal route is not ready", () => {
    const manifest = loopPortalFixture();
    const beforeLead = planRoutePrefetch(
      manifest,
      snapshot({
        phase: "waiting",
        requestedState: "exiting",
        isTransitioning: true,
        presentation: {
          kind: "body",
          state: "entering",
          unitId: "entering-body",
          frameIndex: 16
        },
        pendingEdgeId: "entering.exiting"
      }),
      stream("entering-body"),
      12,
      false
    );
    const atLead = planRoutePrefetch(
      manifest,
      snapshot({
        phase: "waiting",
        requestedState: "exiting",
        isTransitioning: true,
        presentation: {
          kind: "body",
          state: "entering",
          unitId: "entering-body",
          frameIndex: 17
        },
        pendingEdgeId: "entering.exiting"
      }),
      stream("entering-body"),
      12,
      false
    );
    const readyAtPortal = planRoutePrefetch(
      manifest,
      snapshot({
        phase: "waiting",
        requestedState: "exiting",
        isTransitioning: true,
        presentation: {
          kind: "body",
          state: "entering",
          unitId: "entering-body",
          frameIndex: 23
        },
        pendingEdgeId: "entering.exiting"
      }),
      stream("entering-body"),
      12,
      true
    );

    expect(reasons(beforeLead)).toEqual([
      ["exit-body", "pending-route"],
      ["entering-body", "presentation-continuation"]
    ]);
    expect(reasons(atLead)).toEqual([
      ["entering-body", "presentation-continuation"],
      ["exit-body", "pending-route"]
    ]);
    expect(reasons(readyAtPortal)).toEqual([
      ["exit-body", "pending-route"],
      ["entering-body", "presentation-continuation"]
    ]);
  });
});

describe("route prefetch ownership", () => {
  it("loads while admission is gated and wakes when the lane retires", async () => {
    let available = false;
    let admissions = 0;
    const manifest = fixture();
    const queue = new RoutePrefetchQueue<FakeRun>({
      signal: new AbortController().signal,
      preload: async () => undefined,
      admit: (value) => {
        admissions += 1;
        return new FakeRun(value.id);
      },
      canAdmit: () => available,
      onFailure: () => undefined
    });

    queue.reconcile([intent(unit(manifest, "entering-body"), "pending-route")]);
    await microtasks();
    expect(admissions).toBe(0);

    available = true;
    queue.wake();
    await eventually(() => admissions === 1);
    await queue.retire();
  });

  it("loads every intent but admits only the current head", async () => {
    const harness = queueHarness();
    const entering = harness.intent("entering-body", "pending-route");
    const hover = harness.intent("hover-loop", "completion");
    harness.queue.reconcile([entering, hover]);
    await eventually(() => harness.loads.length === 2);

    harness.releaseLoad("hover-loop");
    await microtasks();
    expect(harness.admitted).toEqual([]);

    harness.releaseLoad("entering-body");
    await eventually(() => harness.admitted.length === 1);
    expect(harness.admitted).toEqual(["entering-body"]);

    harness.runs[0]!.releaseReady();
    await eventually(() => harness.queue.isReady("entering-body"));
    const claimed = harness.claim("entering-body")!;
    harness.queue.reconcile([hover]);
    await eventually(() => harness.admitted.length === 2);
    expect(harness.admitted).toEqual(["entering-body", "hover-loop"]);
    claimed.cancel();
    await harness.queue.retire();
    expect(harness.failures).toEqual([]);
  });

  it("reuses loaded B when reordering from [A, B] to [B]", async () => {
    const harness = queueHarness();
    const entering = harness.intent("entering-body", "pending-route");
    const hover = harness.intent("hover-loop", "completion");
    harness.queue.reconcile([entering, hover]);
    await eventually(() => harness.loads.length === 2);
    harness.releaseLoad("hover-loop");

    harness.queue.reconcile([hover]);
    await eventually(() => harness.admitted.length === 1);

    expect(harness.admitted).toEqual(["hover-loop"]);
    expect(harness.loadCount("hover-loop")).toBe(1);
    await harness.queue.retire();
    expect(harness.failures).toEqual([]);
  });

  it("closes an admitted A before replacing [A, B] with [B]", async () => {
    const harness = queueHarness();
    const entering = harness.intent("entering-body", "pending-route");
    const hover = harness.intent("hover-loop", "completion");
    harness.queue.reconcile([entering, hover]);
    await eventually(() => harness.loads.length === 2);
    harness.releaseLoad("entering-body");
    await eventually(() => harness.admitted.length === 1);
    const first = harness.runs[0]!;

    harness.releaseLoad("hover-loop");
    harness.queue.reconcile([hover]);
    await eventually(() => harness.admitted.length === 2);

    expect(first.closed).toBe(true);
    expect(harness.admitted).toEqual(["entering-body", "hover-loop"]);
    expect(harness.loadCount("hover-loop")).toBe(1);
    await harness.queue.retire();
    expect(harness.failures).toEqual([]);
  });

  it("cancels the admitted head before rotating [A, B] to [B, A]", async () => {
    const harness = queueHarness();
    const entering = harness.intent("entering-body", "pending-route");
    const hover = harness.intent("hover-loop", "completion");
    harness.queue.reconcile([entering, hover]);
    await eventually(() => harness.loads.length === 2);
    harness.releaseLoad("entering-body");
    harness.releaseLoad("hover-loop");
    await eventually(() => harness.admitted.length === 1);
    const first = harness.runs[0]!;

    harness.queue.reconcile([hover, entering]);
    await eventually(() => harness.admitted.length === 2);

    expect(first.closed).toBe(true);
    expect(harness.admitted).toEqual(["entering-body", "hover-loop"]);
    expect(harness.loadCount("entering-body")).toBe(2);
    expect(harness.loadCount("hover-loop")).toBe(1);
    expect(harness.unpromotedCount).toBe(1);
    expect(harness.maximumUnpromoted).toBe(1);
    await harness.queue.retire();
    expect(harness.failures).toEqual([]);
  });

  it("deduplicates shared media into one physical candidate", async () => {
    const manifest = fixture();
    const plan = planRoutePrefetch(
      manifest,
      snapshot({
        phase: "waiting",
        requestedState: "exiting",
        isTransitioning: true,
        pendingEdgeId: "entering.exiting",
        followOnEdgeId: "hover.exiting"
      }),
      stream("entering-body"),
      12,
      false
    );
    expect(plan.decode).toHaveLength(1);
    expect(plan.decode[0]).toMatchObject({
      unit: { id: "exit-body" }
    });

    const harness = queueHarness(manifest);
    harness.queue.reconcile(plan.decode);
    await eventually(() => harness.loads.length === 1);
    harness.releaseLoad("exit-body");
    await eventually(() => harness.admitted.length === 1);

    expect(harness.loadCount("exit-body")).toBe(1);
    expect(harness.admitted).toEqual(["exit-body"]);
    expect(harness.maximumUnpromoted).toBe(1);
    await harness.queue.retire();
    expect(harness.failures).toEqual([]);
  });

  it("transfers a head claim atomically and preserves its admission priority", async () => {
    const harness = queueHarness();
    const enteringIntent = harness.intent("entering-body", "pending-route");
    const hoverIntent = harness.intent("hover-loop", "completion");
    harness.queue.reconcile([enteringIntent]);
    await eventually(() => harness.loads.length === 1);
    harness.releaseLoad("entering-body");
    await eventually(() => harness.admitted.length === 1);
    const entering = harness.runs.find(({ unit }) => unit === "entering-body")!;
    entering.releaseReady();
    await eventually(() => harness.queue.isReady("entering-body"));
    const claimed = harness.claim("entering-body")!;
    await expect(claimed.ready).resolves.toBe(entering);
    expect(entering.closed).toBe(false);

    harness.queue.reconcile([hoverIntent]);
    await eventually(() => harness.loads.length === 2);
    harness.releaseLoad("hover-loop");
    await eventually(() => harness.admitted.length === 2);
    expect(harness.admitted).toEqual(["entering-body", "hover-loop"]);
    claimed.cancel();
    await harness.queue.retire();
  });

  it("does not transfer an admitted candidate before it is ready", async () => {
    const harness = queueHarness();
    harness.queue.reconcile([
      harness.intent("entering-body", "pending-route")
    ]);
    await eventually(() => harness.loads.length === 1);
    harness.releaseLoad("entering-body");
    await eventually(() => harness.runs.length === 1);
    const run = harness.runs[0]!;
    expect(harness.claim("entering-body")).toBeUndefined();
    await expect(harness.queue.retire()).resolves.toBeUndefined();
    expect(run.closed).toBe(true);
    expect(harness.failures).toEqual([]);
  });

  it("admits a successor after a claimed predecessor is canceled", async () => {
    const harness = queueHarness();
    const entering = harness.intent("entering-body", "pending-route");
    const hover = harness.intent("hover-loop", "completion");
    harness.queue.reconcile([entering, hover]);
    await eventually(() => harness.loads.length === 2);
    harness.releaseLoad("entering-body");
    await eventually(() => harness.runs.length === 1);
    harness.runs[0]!.releaseReady();
    await eventually(() => harness.queue.isReady("entering-body"));
    const predecessor = harness.claim("entering-body")!;
    predecessor.cancel();
    await expect(predecessor.ready).resolves.toBe(harness.runs[0]);
    expect(harness.runs[0]!.closed).toBe(true);

    harness.queue.reconcile([hover]);
    harness.releaseLoad("hover-loop");
    await eventually(() => harness.admitted.includes("hover-loop"));
    const run = harness.runs.find(({ unit }) => unit === "hover-loop")!;
    run.releaseReady();
    await eventually(() => harness.queue.isReady("hover-loop"));
    const successor = harness.claim("hover-loop")!;
    await expect(successor.ready).resolves.toBe(run);
    successor.cancel();
    await harness.queue.retire();
    expect(harness.failures).toEqual([]);
  });

  it("rejects a non-head claim instead of silently violating plan order", async () => {
    const harness = queueHarness();
    harness.queue.reconcile([
      harness.intent("entering-body", "pending-route"),
      harness.intent("hover-loop", "completion")
    ]);

    expect(() => harness.claim("hover-loop")).toThrow(/claim invariant/u);
    await harness.queue.retire();
  });

  it("returns no claim when the requested unit is absent from the queue", async () => {
    const harness = queueHarness();
    harness.queue.reconcile([
      harness.intent("entering-body", "pending-route"),
      harness.intent("hover-loop", "completion")
    ]);

    expect(harness.claim("exit-body")).toBeUndefined();
    await harness.queue.retire();
    expect(harness.failures).toEqual([]);
  });

  it("never admits more than one unpromoted candidate", async () => {
    const harness = queueHarness();
    const entering = harness.intent("entering-body", "pending-route");
    const hover = harness.intent("hover-loop", "completion");
    harness.queue.reconcile([entering, hover]);
    await eventually(() => harness.loads.length === 2);
    harness.releaseLoad("entering-body");
    harness.releaseLoad("hover-loop");
    await eventually(() => harness.admitted.length === 1);
    await microtasks();

    expect(harness.admitted).toEqual(["entering-body"]);
    expect(harness.unpromotedCount).toBe(1);
    const enteringRun = harness.runs[0]!;
    enteringRun.releaseReady();
    await eventually(() => harness.queue.isReady("entering-body"));
    const claimedEntering = harness.claim("entering-body")!;
    expect(harness.unpromotedCount).toBe(0);

    harness.queue.reconcile([hover]);
    await eventually(() => harness.admitted.length === 2);
    expect(harness.unpromotedCount).toBe(1);
    expect(harness.maximumUnpromoted).toBe(1);
    const hoverRun = harness.runs[1]!;
    hoverRun.releaseReady();
    await eventually(() => harness.queue.isReady("hover-loop"));
    const claimedHover = harness.claim("hover-loop")!;
    expect(harness.unpromotedCount).toBe(0);

    claimedEntering.cancel();
    claimedHover.cancel();
    await harness.queue.retire();
    expect(harness.failures).toEqual([]);
  });

  it("waits for canceled operations removed from the owned registry", async () => {
    const gate = deferred<void>();
    const queue = new RoutePrefetchQueue<FakeRun>({
      signal: new AbortController().signal,
      preload: () => gate.promise,
      admit: () => new FakeRun("entering-body"),
      onFailure: () => undefined
    });
    queue.reconcile([intent(unit(fixture(), "entering-body"), "pending-route")]);
    await microtasks();
    queue.reconcile([]);
    let settled = false;
    const retirement = queue.retire().then(() => { settled = true; });
    await microtasks();
    expect(settled).toBe(false);

    gate.resolve();
    await retirement;
    expect(settled).toBe(true);
  });

  it("reports an unexpected AbortError from a run", async () => {
    const harness = queueHarness();
    harness.queue.reconcile([
      harness.intent("entering-body", "pending-route")
    ]);
    await eventually(() => harness.loads.length === 1);
    harness.releaseLoad("entering-body");
    await eventually(() => harness.runs.length === 1);
    harness.runs[0]!.fail(abortError());

    await eventually(() => harness.failures.length === 1);
    expect(harness.failures[0]).toMatchObject({ name: "AbortError" });
    await harness.queue.retire();
  });
});

class FakeRun {
  readonly #readiness = deferred<void>();
  readonly #onClose: () => void;
  public closed = false;

  public constructor(
    public readonly unit: string,
    onClose: () => void = () => undefined
  ) {
    this.#onClose = onClose;
  }

  public async ready(): Promise<void> { await this.#readiness.promise; }
  public releaseReady(): void { this.#readiness.resolve(); }
  public fail(error: unknown): void { this.#readiness.reject(error); }
  public close(): void {
    if (this.closed) return;
    this.closed = true;
    this.#onClose();
    this.#readiness.reject(abortError());
  }
}

function queueHarness(manifest = fixture()) {
  const loads: Array<Readonly<{ unit: string; gate: Deferred<void> }>> = [];
  const runs: FakeRun[] = [];
  const admitted: string[] = [];
  const failures: unknown[] = [];
  const unpromoted = new Set<FakeRun>();
  let maximumUnpromoted = 0;
  const queue = new RoutePrefetchQueue<FakeRun>({
    signal: new AbortController().signal,
    preload: (value, signal) => {
      const gate = deferred<void>();
      loads.push({ unit: value.id, gate });
      if (signal.aborted) gate.reject(signal.reason);
      else signal.addEventListener("abort", () => gate.reject(signal.reason), { once: true });
      return gate.promise;
    },
    admit: (value) => {
      admitted.push(value.id);
      let run!: FakeRun;
      run = new FakeRun(value.id, () => unpromoted.delete(run));
      runs.push(run);
      unpromoted.add(run);
      maximumUnpromoted = Math.max(maximumUnpromoted, unpromoted.size);
      return run;
    },
    onFailure: (error) => failures.push(error)
  });
  return {
    queue,
    loads,
    runs,
    admitted,
    failures,
    intent: (id: string, reason: PrefetchReason) =>
      intent(unit(manifest, id), reason),
    claim: (id: string) => {
      const claimed = queue.claim(id);
      if (claimed === undefined) return undefined;
      const candidates = [...unpromoted].filter(({ unit: value }) => value === id);
      if (candidates.length !== 1) {
        throw new Error("test candidate ownership invariant failed");
      }
      unpromoted.delete(candidates[0]!);
      return claimed;
    },
    get unpromotedCount() { return unpromoted.size; },
    get maximumUnpromoted() { return maximumUnpromoted; },
    loadCount: (id: string) => loads.filter(({ unit: value }) => value === id).length,
    releaseLoad: (id: string, occurrence = 0) => {
      const load = loads.filter(({ unit: value }) => value === id)[occurrence];
      if (load === undefined) throw new Error(`missing ${id} load`);
      load.gate.resolve();
    }
  };
}

function reasons(plan: Readonly<{ decode: readonly Readonly<PrefetchIntent>[] }>) {
  return plan.decode.map(({ unit: value, reason }) => [value.id, reason]);
}

function stream(unitId: string) {
  return { unitId, mode: "stream" as const };
}

function intent(value: Unit, reason: PrefetchReason): Readonly<PrefetchIntent> {
  return { unit: value, reason };
}

function snapshot(
  overrides: Partial<MotionGraphSnapshot> = {}
): Readonly<MotionGraphSnapshot> {
  return {
    readiness: "animated",
    phase: "stable",
    initialUnitPending: false,
    requestedState: "entering",
    visualState: "entering",
    prospectiveState: "entering",
    isTransitioning: false,
    presentation: {
      kind: "body",
      state: "entering",
      unitId: "entering-body",
      frameIndex: 0
    },
    pendingEdgeId: null,
    activeEdgeId: null,
    followOnEdgeId: null,
    direction: null,
    contentOrdinal: 0n,
    inputSequence: 0,
    pendingRequestCount: 0,
    inputsSinceTick: 0,
    routeOperationsLastTick: 0,
    ...overrides
  };
}

function fixture(): Manifest {
  return {
    formatVersion: "1.0",
    generator: "route-prefetch-test",
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
      alphaLayout: { type: "opaque", colorRect: [0, 0, 16, 16] },
      bitrate: { average: 1_000, peak: 2_000 }
    }],
    units: [
      body("entering-body", 12, "finite"),
      oneShot("entering-intro", 2),
      body("hover-loop", 24, "loop"),
      body("exit-body", 12, "finite")
    ],
    initialState: "entering",
    states: [
      { id: "entering", bodyUnit: "entering-body", initialUnit: "entering-intro" },
      { id: "hover", bodyUnit: "hover-loop" },
      { id: "exiting", bodyUnit: "exit-body" }
    ],
    edges: [
      {
        id: "entering.hover",
        from: "entering",
        to: "hover",
        start: { type: "finish", targetPort: "default", maxWaitFrames: 11 },
        trigger: { type: "completion" },
        continuity: "exact-authored"
      },
      {
        id: "entering.exiting",
        from: "entering",
        to: "exiting",
        start: { type: "finish", targetPort: "default", maxWaitFrames: 11 },
        trigger: { type: "event", name: "leave" },
        continuity: "exact-authored"
      },
      {
        id: "hover.exiting",
        from: "hover",
        to: "exiting",
        start: { type: "finish", targetPort: "default", maxWaitFrames: 11 },
        trigger: { type: "event", name: "leave-hover" },
        continuity: "exact-authored"
      }
    ],
    bindings: [],
    readiness: { policy: "all-routes", bootstrapUnits: [], immediateEdges: [] },
    limits: {
      maxCompiledBytes: Number.MAX_SAFE_INTEGER,
      maxRuntimeBytes: Number.MAX_SAFE_INTEGER,
      decodedPixelBytes: 16 * 16 * 4,
      persistentCacheBytes: 0,
      runtimeWorkingSetBytes: Number.MAX_SAFE_INTEGER
    }
  };
}

function loopPortalFixture(): Manifest {
  const manifest = fixture();
  return {
    ...manifest,
    units: manifest.units.map((value) => value.id !== "entering-body"
      ? value
      : {
          ...value,
          kind: "body" as const,
          playback: "loop" as const,
          frameCount: 24,
          ports: [{
            id: "default",
            entryFrame: 0 as const,
            portalFrames: [1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23]
          }]
        }),
    edges: manifest.edges.map((value) => value.id !== "entering.exiting"
      ? value
      : {
          id: "entering.exiting",
          from: "entering",
          to: "exiting",
          start: {
            type: "portal" as const,
            sourcePort: "default",
            targetPort: "default",
            maxWaitFrames: 11
          },
          trigger: { type: "event" as const, name: "leave" },
          continuity: "exact-authored" as const
        })
  };
}

function body(
  id: string,
  frameCount: number,
  playback: "loop" | "finite"
): Unit {
  return {
    id,
    kind: "body",
    playback,
    frameCount,
    ports: [{ id: "default", entryFrame: 0, portalFrames: [0] }],
    chunks: [span(id, frameCount)]
  };
}

function oneShot(id: string, frameCount: number): Unit {
  return { id, kind: "one-shot", frameCount, chunks: [span(id, frameCount)] };
}

function span(unit: string, frameCount: number) {
  return {
    rendition: "main",
    chunkStart: 0,
    chunkCount: 1,
    frameCount,
    sha256: unit.padEnd(64, "0").slice(0, 64)
  };
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

async function microtasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
  }
  throw new Error("condition did not become true");
}

function unit(manifest: Readonly<Manifest>, id: string): Unit {
  const value = manifest.units.find((candidate) => candidate.id === id);
  if (value === undefined) throw new Error(`missing ${id}`);
  return value;
}

function abortError(): DOMException {
  return new DOMException("test operation was aborted", "AbortError");
}
