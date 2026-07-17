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
      12
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
      12
    );
    const followOn = planRoutePrefetch(
      manifest,
      snapshot({
        requestedState: "exiting",
        isTransitioning: true,
        followOnEdgeId: "entering.exiting"
      }),
      stream("entering-body"),
      12
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
      12
    );

    expect(reasons(plan)).toEqual([
      ["entering-body", "intro-body"],
      ["exit-body", "pending-route"]
    ]);
  });

  it("prioritizes a detached body restart ahead of its pending route", () => {
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
      "entering-body"
    );

    expect(reasons(plan)).toEqual([
      ["entering-body", "resume-body"],
      ["exit-body", "pending-route"]
    ]);
  });
});

describe("route prefetch ownership", () => {
  it("admits in plan order when lower-priority bytes load first", async () => {
    const harness = queueHarness();
    harness.queue.reconcile([
      harness.intent("entering-body", "pending-route"),
      harness.intent("hover-loop", "completion")
    ]);
    await eventually(() => harness.loads.length === 2);

    harness.releaseLoad("hover-loop");
    await microtasks();
    expect(harness.admitted).toEqual([]);

    harness.releaseLoad("entering-body");
    await eventually(() => harness.admitted.length === 2);
    expect(harness.admitted).toEqual(["entering-body", "hover-loop"]);
    await harness.queue.retire();
    expect(harness.failures).toEqual([]);
  });

  it("reorders from [A, B] to [B] while A is still loading", async () => {
    const harness = queueHarness();
    harness.queue.reconcile([
      harness.intent("entering-body", "pending-route"),
      harness.intent("hover-loop", "completion")
    ]);
    await eventually(() => harness.loads.length === 2);
    harness.releaseLoad("hover-loop");

    harness.queue.reconcile([
      harness.intent("hover-loop", "pending-route")
    ]);
    await eventually(() => harness.loadCount("hover-loop") === 2);
    harness.releaseLoad("hover-loop", 1);
    await eventually(() => harness.admitted.length === 1);

    expect(harness.admitted).toEqual(["hover-loop"]);
    await harness.queue.retire();
    expect(harness.failures).toEqual([]);
  });

  it("closes an admitted A before replacing [A, B] with [B]", async () => {
    const harness = queueHarness();
    harness.queue.reconcile([
      harness.intent("entering-body", "pending-route"),
      harness.intent("hover-loop", "completion")
    ]);
    await eventually(() => harness.loads.length === 2);
    harness.releaseLoad("entering-body");
    await eventually(() => harness.admitted.length === 1);
    const first = harness.runs[0]!;

    harness.queue.reconcile([
      harness.intent("hover-loop", "pending-route")
    ]);
    await eventually(() => harness.loadCount("hover-loop") === 2);
    harness.releaseLoad("hover-loop", 1);
    await eventually(() => harness.admitted.length === 2);

    expect(first.closed).toBe(true);
    expect(harness.admitted).toEqual(["entering-body", "hover-loop"]);
    await harness.queue.retire();
    expect(harness.failures).toEqual([]);
  });

  it("transfers a head claim atomically and preserves its admission priority", async () => {
    const harness = queueHarness();
    harness.queue.reconcile([
      harness.intent("entering-body", "pending-route")
    ]);
    await eventually(() => harness.loads.length === 1);
    const claimed = harness.queue.claim("entering-body")!;

    harness.queue.reconcile([
      harness.intent("hover-loop", "completion")
    ]);
    await eventually(() => harness.loads.length === 2);
    harness.releaseLoad("hover-loop");
    await microtasks();
    expect(harness.admitted).toEqual([]);

    harness.releaseLoad("entering-body");
    await eventually(() => harness.admitted.length === 2);
    const entering = harness.runs.find(({ unit }) => unit === "entering-body")!;
    entering.releaseReady();
    await expect(claimed.ready).resolves.toBe(entering);
    expect(entering.closed).toBe(false);
    expect(harness.admitted).toEqual(["entering-body", "hover-loop"]);
    await harness.queue.retire();
  });

  it("transfers an admitted not-ready claim to a cancellable owner", async () => {
    const harness = queueHarness();
    harness.queue.reconcile([
      harness.intent("entering-body", "pending-route")
    ]);
    await eventually(() => harness.loads.length === 1);
    harness.releaseLoad("entering-body");
    await eventually(() => harness.runs.length === 1);
    const run = harness.runs[0]!;
    const claimed = harness.queue.claim("entering-body")!;

    claimed.cancel();
    await expect(claimed.ready).rejects.toMatchObject({ name: "AbortError" });
    await expect(harness.queue.retire()).resolves.toBeUndefined();
    expect(run.closed).toBe(true);
    expect(harness.failures).toEqual([]);
  });

  it("admits a successor after a claimed predecessor is canceled", async () => {
    const harness = queueHarness();
    harness.queue.reconcile([
      harness.intent("entering-body", "pending-route"),
      harness.intent("hover-loop", "completion")
    ]);
    await eventually(() => harness.loads.length === 2);
    const predecessor = harness.queue.claim("entering-body")!;
    predecessor.cancel();
    await expect(predecessor.ready).rejects.toMatchObject({ name: "AbortError" });

    harness.releaseLoad("hover-loop");
    await eventually(() => harness.admitted.includes("hover-loop"));
    const successor = harness.queue.claim("hover-loop")!;
    const run = harness.runs.find(({ unit }) => unit === "hover-loop")!;
    run.releaseReady();
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

    expect(() => harness.queue.claim("hover-loop")).toThrow(/claim invariant/u);
    await harness.queue.retire();
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
  public closed = false;

  public constructor(public readonly unit: string) {}

  public async ready(): Promise<void> { await this.#readiness.promise; }
  public releaseReady(): void { this.#readiness.resolve(); }
  public fail(error: unknown): void { this.#readiness.reject(error); }
  public close(): void {
    if (this.closed) return;
    this.closed = true;
    this.#readiness.reject(abortError());
  }
}

function queueHarness() {
  const manifest = fixture();
  const loads: Array<Readonly<{ unit: string; gate: Deferred<void> }>> = [];
  const runs: FakeRun[] = [];
  const admitted: string[] = [];
  const failures: unknown[] = [];
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
      const run = new FakeRun(value.id);
      runs.push(run);
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
