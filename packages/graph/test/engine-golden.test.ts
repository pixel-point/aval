import { describe, expect, it } from "vitest";

import { MotionGraphEngine } from "../src/engine.js";
import type {
  GraphBodyKind,
  GraphEdgeDefinition,
  GraphStateDefinition,
  MotionGraphDefinition
} from "../src/model.js";

describe("MotionGraphEngine golden lifecycle traces", () => {
  it("installs the initial static frame and resolves a stable no-op without state events", () => {
    const engine = new MotionGraphEngine();
    const install = engine.install(graph());

    expect(install.presentation).toEqual(staticFrame("idle"));
    expect(install.effects).toEqual([
      readiness("unready", "preparing")
    ]);
    expect(install.snapshot).toMatchObject({
      readiness: "preparing",
      phase: "preparing",
      requestedState: "idle",
      visualState: "idle",
      isTransitioning: false,
      contentOrdinal: null
    });

    const animated = engine.beginAnimated();
    expect(animated.presentation).toEqual(bodyFrame("idle", 0));
    expect(animated.effects).toEqual([
      readiness("preparing", "animated")
    ]);
    expect(animated.snapshot).toMatchObject({
      readiness: "animated",
      phase: "stable",
      requestedState: "idle",
      visualState: "idle",
      isTransitioning: false
    });

    const noop = engine.request("idle");
    expect(noop).toMatchObject({
      accepted: true,
      joined: false,
      sequence: 1,
      requestId: 1,
      presentation: bodyFrame("idle", 0)
    });
    expect(noop.effects).toEqual([
      settle([1], {
        type: "resolve",
        timing: "microtask",
        reason: "stable-noop"
      })
    ]);
    expect(noop.snapshot).toMatchObject({
      phase: "stable",
      requestedState: "idle",
      visualState: "idle",
      isTransitioning: false,
      pendingRequestCount: 0
    });
  });

  it("rejects a request before metadata with one settlement and no presentation", () => {
    const engine = new MotionGraphEngine();
    const result = engine.request("hover");

    expect(result).toMatchObject({
      accepted: false,
      joined: false,
      sequence: 1,
      requestId: 1,
      presentation: null
    });
    expect(result.effects).toEqual([
      settle([1], {
        type: "reject",
        timing: "microtask",
        error: "NotReadyError"
      })
    ]);
    expect(result.snapshot).toMatchObject({
      readiness: "unready",
      phase: "unready",
      requestedState: null,
      visualState: null,
      isTransitioning: false
    });
  });

  it("uses a later loop portal when the first portal is not route-ready", () => {
    const engine = animatedEngine(
      graph({
        sourceKind: "loop",
        sourcePortals: [1, 3],
        start: { type: "portal", maxWaitFrames: 1 }
      })
    );

    const request = engine.request("hover");
    expect(request.presentation).toEqual(bodyFrame("idle", 0));
    expect(request.effects).toEqual([
      requested("idle", "hover", 1)
    ]);
    expect(request.snapshot).toMatchObject({
      phase: "waiting",
      requestedState: "hover",
      visualState: "idle",
      prospectiveState: "hover",
      pendingEdgeId: "idle-to-hover",
      activeEdgeId: null,
      isTransitioning: true,
      pendingRequestCount: 1
    });

    const atFirstPortal = engine.tick({ contentOrdinal: 0n });
    expect(atFirstPortal.presentation).toEqual(bodyFrame("idle", 1));
    expect(atFirstPortal.effects).toEqual([]);

    const skipFirstPortal = engine.tick({
      contentOrdinal: 1n,
      routeReady: false
    });
    expect(skipFirstPortal.presentation).toEqual(bodyFrame("idle", 2));
    expect(skipFirstPortal.effects).toEqual([]);

    const atLaterPortal = engine.tick({ contentOrdinal: 2n });
    expect(atLaterPortal.presentation).toEqual(bodyFrame("idle", 3));
    expect(atLaterPortal.effects).toEqual([]);

    const commit = engine.tick({ contentOrdinal: 3n });
    expect(commit.presentation).toEqual(bodyFrame("hover", 0));
    expect(commit.effects).toEqual([
      transitionStart("idle-to-hover", "idle", "hover", 1),
      visual("idle", "hover"),
      transitionEnd("idle-to-hover", "idle", "hover"),
      settle([1], {
        type: "resolve",
        timing: "microtask",
        reason: "target-committed"
      })
    ]);
    expect(commit.snapshot).toMatchObject({
      phase: "stable",
      requestedState: "hover",
      visualState: "hover",
      prospectiveState: "hover",
      pendingEdgeId: null,
      activeEdgeId: null,
      isTransitioning: false,
      routeOperationsLastTick: 1,
      pendingRequestCount: 0
    });
  });

  it("commits a transitionless portal directly from the displayed portal to target frame zero", () => {
    const engine = animatedEngine(graph());
    engine.request("hover");

    const result = engine.tick({ contentOrdinal: 0n });
    expect(result.presentation).toEqual(bodyFrame("hover", 0));
    expect(result.effects).toEqual([
      transitionStart("idle-to-hover", "idle", "hover", 1),
      visual("idle", "hover"),
      transitionEnd("idle-to-hover", "idle", "hover"),
      settle([1], {
        type: "resolve",
        timing: "microtask",
        reason: "target-committed"
      })
    ]);
  });

  it("commits a cut on the next tick even when routeReady is false", () => {
    const engine = animatedEngine(
      graph({ start: { type: "cut", maxWaitFrames: 1 } })
    );
    engine.request("hover");

    const result = engine.tick({
      contentOrdinal: 0n,
      routeReady: false
    });
    expect(result.presentation).toEqual(bodyFrame("hover", 0));
    expect(result.effects).toEqual([
      transitionStart("idle-to-hover", "idle", "hover", 1),
      visual("idle", "hover"),
      transitionEnd("idle-to-hover", "idle", "hover"),
      settle([1], {
        type: "resolve",
        timing: "microtask",
        reason: "target-committed"
      })
    ]);
    expect(result.snapshot.routeOperationsLastTick).toBe(1);
  });

  it("searches finite portals forward, never wraps, and holds the final portal until ready", () => {
    const engine = animatedEngine(
      graph({
        sourceKind: "finite",
        sourcePortals: [1, 3],
        start: { type: "portal", maxWaitFrames: 1 }
      })
    );
    engine.request("hover");

    expect(
      engine.tick({ contentOrdinal: 0n }).presentation
    ).toEqual(bodyFrame("idle", 1));
    expect(
      engine.tick({ contentOrdinal: 1n, routeReady: false }).presentation
    ).toEqual(bodyFrame("idle", 2));
    expect(
      engine.tick({ contentOrdinal: 2n }).presentation
    ).toEqual(bodyFrame("idle", 3));

    const held = engine.tick({ contentOrdinal: 3n, routeReady: false });
    expect(held.presentation).toEqual(bodyFrame("idle", 3));
    expect(held.effects).toEqual([]);
    expect(held.snapshot).toMatchObject({
      phase: "waiting",
      visualState: "idle",
      requestedState: "hover",
      isTransitioning: true
    });

    const commit = engine.tick({ contentOrdinal: 4n });
    expect(commit.presentation).toEqual(bodyFrame("hover", 0));
    expect(commit.effects).toEqual([
      transitionStart("idle-to-hover", "idle", "hover", 1),
      visual("idle", "hover"),
      transitionEnd("idle-to-hover", "idle", "hover"),
      settle([1], {
        type: "resolve",
        timing: "microtask",
        reason: "target-committed"
      })
    ]);
  });

  it("finishes a finite body exactly once and waits at its held final frame", () => {
    const engine = animatedEngine(
      graph({
        sourceKind: "finite",
        sourcePortals: [0, 3],
        start: { type: "finish", maxWaitFrames: 3 }
      })
    );
    engine.request("hover");

    for (let ordinal = 0; ordinal < 3; ordinal += 1) {
      const tick = engine.tick({ contentOrdinal: BigInt(ordinal) });
      expect(tick.presentation).toEqual(bodyFrame("idle", ordinal + 1));
      expect(tick.effects).toEqual([]);
    }
    const held = engine.tick({ contentOrdinal: 3n, routeReady: false });
    expect(held.presentation).toEqual(bodyFrame("idle", 3));
    expect(held.effects).toEqual([]);

    const commit = engine.tick({ contentOrdinal: 4n });
    expect(commit.presentation).toEqual(bodyFrame("hover", 0));
    expect(commit.effects).toEqual([
      transitionStart("idle-to-hover", "idle", "hover", 1),
      visual("idle", "hover"),
      transitionEnd("idle-to-hover", "idle", "hover"),
      settle([1], {
        type: "resolve",
        timing: "microtask",
        reason: "target-committed"
      })
    ]);
  });

  it("runs an explicit completion cut even when route readiness is false", () => {
    const definition = graph({
      sourceKind: "held",
      sourcePortals: [0],
      start: { type: "cut", maxWaitFrames: 1 }
    });
    const baseEdge = definition.edges[0]!;
    const engine = animatedEngine({
      ...definition,
      edges: [{ ...baseEdge, trigger: { type: "completion" } }]
    });

    const completed = engine.tick({ contentOrdinal: 0n, routeReady: false });
    expect(completed.presentation).toEqual(bodyFrame("hover", 0));
    expect(completed.effects).toEqual([
      requested("idle", "hover", 1),
      transitionStart("idle-to-hover", "idle", "hover", 1),
      visual("idle", "hover"),
      transitionEnd("idle-to-hover", "idle", "hover")
    ]);
    expect(completed.snapshot).toMatchObject({
      phase: "stable",
      requestedState: "hover",
      visualState: "hover",
      routeOperationsLastTick: 1
    });
  });

  it("previews a completion-triggered tick exactly without committing it", () => {
    const definition = graph({
      sourceKind: "held",
      sourcePortals: [0],
      start: { type: "cut", maxWaitFrames: 1 }
    });
    const baseEdge = definition.edges[0]!;
    const engine = animatedEngine({
      ...definition,
      edges: [{ ...baseEdge, trigger: { type: "completion" } }]
    });
    const beforeSnapshot = engine.snapshot();
    const beforeTrace = engine.getTrace();

    const preview = engine.previewTick({
      contentOrdinal: 0n,
      routeReady: false
    });

    expect(preview.snapshot).toMatchObject({
      phase: "stable",
      visualState: "hover",
      requestedState: "hover"
    });
    expect(engine.snapshot()).toEqual(beforeSnapshot);
    expect(engine.getTrace()).toEqual(beforeTrace);
    expect(
      engine.tick({ contentOrdinal: 0n, routeReady: false })
    ).toEqual(preview);
  });

  it("previews stable ticks exactly without advancing the graph journal", () => {
    const engine = animatedEngine(graph());
    const beforeSnapshot = engine.snapshot();
    const beforeTrace = engine.getTrace();

    const preview = engine.previewTick({ contentOrdinal: 0n });

    expect(preview.snapshot).toMatchObject({
      phase: "stable",
      visualState: "idle",
      contentOrdinal: 0n
    });
    expect(engine.snapshot()).toEqual(beforeSnapshot);
    expect(engine.getTrace()).toEqual(beforeTrace);
    expect(engine.tick({ contentOrdinal: 0n })).toEqual(preview);
  });

  it("restores pending requests, counters, routes, and trace across repeated previews", () => {
    const engine = animatedEngine(graph());
    const first = engine.request("hover");
    const duplicate = engine.request("hover");
    const beforeSnapshot = engine.snapshot();
    const beforeTrace = engine.getTrace();

    const firstPreview = engine.previewTick({ contentOrdinal: 0n });
    const secondPreview = engine.previewTick({ contentOrdinal: 0n });

    expect(firstPreview).toEqual(secondPreview);
    expect(firstPreview.effects).toContainEqual(
      settle([first.requestId!, duplicate.requestId!], {
        type: "resolve",
        timing: "microtask",
        reason: "target-committed"
      })
    );
    expect(engine.snapshot()).toEqual(beforeSnapshot);
    expect(engine.snapshot()).toMatchObject({
      phase: "waiting",
      pendingEdgeId: "idle-to-hover",
      pendingRequestCount: 2,
      inputSequence: 2,
      inputsSinceTick: 2,
      contentOrdinal: null
    });
    expect(engine.getTrace()).toEqual(beforeTrace);

    expect(engine.tick({ contentOrdinal: 0n })).toEqual(firstPreview);
    expect(engine.snapshot().inputsSinceTick).toBe(0);
    expect(engine.request("hover")).toMatchObject({
      requestId: 3,
      sequence: 3
    });
  });

  it("restores the graph when preview evaluation throws after tick admission", () => {
    const engine = animatedEngine(graph());
    engine.request("hover");
    const beforeSnapshot = engine.snapshot();
    const beforeTrace = engine.getTrace();
    const throwingOptions = {
      contentOrdinal: 0n,
      get routeReady(): boolean {
        throw new Error("preview readiness failed");
      }
    };

    expect(() => engine.previewTick(throwingOptions)).toThrowError(
      "preview readiness failed"
    );
    expect(engine.snapshot()).toEqual(beforeSnapshot);
    expect(engine.getTrace()).toEqual(beforeTrace);
    expect(engine.tick({ contentOrdinal: 0n }).snapshot).toMatchObject({
      phase: "stable",
      contentOrdinal: 0n,
      inputsSinceTick: 0
    });
  });

  it("does not invent an implicit completion route for a finite body", () => {
    const engine = animatedEngine(
      graph({
        sourceKind: "finite",
        sourcePortals: [0, 3],
        start: { type: "finish", maxWaitFrames: 3 }
      })
    );

    expect(engine.tick({ contentOrdinal: 0n }).presentation).toEqual(
      bodyFrame("idle", 1)
    );
    expect(engine.tick({ contentOrdinal: 1n }).presentation).toEqual(
      bodyFrame("idle", 2)
    );
    expect(engine.tick({ contentOrdinal: 2n }).presentation).toEqual(
      bodyFrame("idle", 3)
    );
    const held = engine.tick({ contentOrdinal: 3n });
    expect(held.presentation).toEqual(bodyFrame("idle", 3));
    expect(held.effects).toEqual([]);
    expect(held.snapshot).toMatchObject({
      phase: "stable",
      requestedState: "idle",
      visualState: "idle"
    });
  });

  it("keeps a held body on frame zero until a finish route becomes ready", () => {
    const engine = animatedEngine(
      graph({
        sourceKind: "held",
        sourcePortals: [0],
        start: { type: "finish", maxWaitFrames: 0 }
      })
    );
    engine.request("hover");

    const held = engine.tick({ contentOrdinal: 0n, routeReady: false });
    expect(held.presentation).toEqual(bodyFrame("idle", 0));
    expect(held.effects).toEqual([]);
    expect(held.snapshot.phase).toBe("waiting");

    const commit = engine.tick({ contentOrdinal: 1n });
    expect(commit.presentation).toEqual(bodyFrame("hover", 0));
    expect(commit.effects).toEqual([
      transitionStart("idle-to-hover", "idle", "hover", 1),
      visual("idle", "hover"),
      transitionEnd("idle-to-hover", "idle", "hover"),
      settle([1], {
        type: "resolve",
        timing: "microtask",
        reason: "target-committed"
      })
    ]);
  });

  it("plays an intro without transition effects and joins body frame zero", () => {
    const engine = new MotionGraphEngine();
    engine.install(graph({ introFrames: 2 }));
    const begin = engine.beginAnimated();
    expect(begin.presentation).toEqual(introFrame(0));
    expect(begin.effects).toEqual([
      readiness("preparing", "animated")
    ]);
    expect(begin.snapshot).toMatchObject({
      phase: "intro",
      visualState: "idle",
      requestedState: "idle",
      isTransitioning: false
    });

    const secondIntroFrame = engine.tick({ contentOrdinal: 0n });
    expect(secondIntroFrame.presentation).toEqual(introFrame(1));
    expect(secondIntroFrame.effects).toEqual([]);

    const bodyJoin = engine.tick({ contentOrdinal: 1n });
    expect(bodyJoin.presentation).toEqual(bodyFrame("idle", 0));
    expect(bodyJoin.effects).toEqual([]);
    expect(bodyJoin.snapshot).toMatchObject({
      phase: "stable",
      visualState: "idle",
      requestedState: "idle",
      isTransitioning: false
    });
  });

  it("skips an intro for a different request accepted during preparation", () => {
    const engine = new MotionGraphEngine();
    engine.install(graph({ introFrames: 2 }));
    const request = engine.request("hover");
    expect(request.effects).toEqual([
      requested("idle", "hover", 1)
    ]);
    expect(request.snapshot.phase).toBe("preparing");

    const begin = engine.beginAnimated();
    expect(begin.presentation).toEqual(bodyFrame("idle", 0));
    expect(begin.effects).toEqual([
      readiness("preparing", "animated")
    ]);
    expect(begin.snapshot).toMatchObject({
      phase: "waiting",
      requestedState: "hover",
      visualState: "idle",
      isTransitioning: true
    });

    const commit = engine.tick({ contentOrdinal: 0n });
    expect(commit.presentation).toEqual(bodyFrame("hover", 0));
    expect(commit.effects).toEqual([
      transitionStart("idle-to-hover", "idle", "hover", 1),
      visual("idle", "hover"),
      transitionEnd("idle-to-hover", "idle", "hover"),
      settle([1], {
        type: "resolve",
        timing: "microtask",
        reason: "target-committed"
      })
    ]);
  });

  it("locks an accepted route behind a playing intro and draws body zero first", () => {
    const engine = new MotionGraphEngine();
    engine.install(graph({ introFrames: 2 }));
    engine.beginAnimated();

    const request = engine.request("hover");
    expect(request.effects).toEqual([
      requested("idle", "hover", 1)
    ]);
    expect(request.snapshot).toMatchObject({
      phase: "intro",
      requestedState: "hover",
      visualState: "idle",
      isTransitioning: true
    });

    expect(
      engine.tick({ contentOrdinal: 0n }).presentation
    ).toEqual(introFrame(1));
    const join = engine.tick({ contentOrdinal: 1n });
    expect(join.presentation).toEqual(bodyFrame("idle", 0));
    expect(join.effects).toEqual([]);
    expect(join.snapshot.phase).toBe("waiting");

    const commit = engine.tick({ contentOrdinal: 2n });
    expect(commit.presentation).toEqual(bodyFrame("hover", 0));
    expect(commit.effects).toEqual([
      transitionStart("idle-to-hover", "idle", "hover", 1),
      visual("idle", "hover"),
      transitionEnd("idle-to-hover", "idle", "hover"),
      settle([1], {
        type: "resolve",
        timing: "microtask",
        reason: "target-committed"
      })
    ]);
  });

  it("treats the initial state as a semantic no-op while its intro continues", () => {
    const engine = new MotionGraphEngine();
    engine.install(graph({ introFrames: 2 }));
    engine.beginAnimated();

    const noop = engine.request("idle");
    expect(noop.effects).toEqual([
      settle([1], {
        type: "resolve",
        timing: "microtask",
        reason: "stable-noop"
      })
    ]);
    expect(noop.snapshot).toMatchObject({
      phase: "intro",
      requestedState: "idle",
      visualState: "idle",
      isTransitioning: false
    });
    expect(engine.tick({ contentOrdinal: 0n }).presentation).toEqual(
      introFrame(1)
    );
  });

  it("begins static mode by committing the newest prepared target in normative order", () => {
    const engine = new MotionGraphEngine();
    engine.install(graph());
    engine.request("hover");

    const result = engine.beginStatic("codec-unsupported");
    expect(result.presentation).toEqual(staticFrame("hover"));
    expect(result.effects).toEqual([
      readiness("preparing", "static", "codec-unsupported"),
      fallback("codec-unsupported"),
      transitionStart("idle-to-hover", "idle", "hover", 1),
      visual("idle", "hover"),
      transitionEnd("idle-to-hover", "idle", "hover"),
      settle([1], {
        type: "resolve",
        timing: "microtask",
        reason: "static-recovery"
      })
    ]);
    expect(result.snapshot).toMatchObject({
      readiness: "static",
      phase: "static",
      requestedState: "hover",
      visualState: "hover",
      isTransitioning: false,
      pendingRequestCount: 0
    });
  });

  it("uses direct-edge validation but ignores portal timing for later static requests", () => {
    const engine = new MotionGraphEngine();
    engine.install(
      graph({
        sourcePortals: [1, 3],
        start: { type: "portal", maxWaitFrames: 1 }
      })
    );
    const begin = engine.beginStatic("reduced-motion");
    expect(begin.presentation).toEqual(staticFrame("idle"));
    expect(begin.effects).toEqual([
      readiness("preparing", "static", "reduced-motion"),
      fallback("reduced-motion")
    ]);

    const request = engine.request("hover");
    expect(request.presentation).toEqual(staticFrame("hover"));
    expect(request.effects).toEqual([
      requested("idle", "hover", 1),
      transitionStart("idle-to-hover", "idle", "hover", 1),
      visual("idle", "hover"),
      transitionEnd("idle-to-hover", "idle", "hover"),
      settle([1], {
        type: "resolve",
        timing: "microtask",
        reason: "target-committed"
      })
    ]);
    expect(request.snapshot).toMatchObject({
      readiness: "static",
      phase: "static",
      requestedState: "hover",
      visualState: "hover",
      isTransitioning: false
    });
  });

  it("recovers pending animation to the requested static state before settling", () => {
    const engine = animatedEngine(graph());
    engine.request("hover");

    const recovery = engine.recoverStatic("decode-failure");
    expect(recovery.presentation).toEqual(staticFrame("hover"));
    expect(recovery.effects).toEqual([
      readiness("animated", "static", "decode-failure"),
      fallback("decode-failure"),
      transitionStart("idle-to-hover", "idle", "hover", 1),
      visual("idle", "hover"),
      transitionEnd("idle-to-hover", "idle", "hover"),
      settle([1], {
        type: "resolve",
        timing: "microtask",
        reason: "static-recovery"
      })
    ]);
    expect(recovery.snapshot).toMatchObject({
      readiness: "static",
      phase: "static",
      requestedState: "hover",
      visualState: "hover",
      isTransitioning: false,
      pendingRequestCount: 0
    });
  });

  it("rejects the surviving request when the required static frame cannot be installed", () => {
    const engine = animatedEngine(graph());
    engine.request("hover");

    const failure = engine.failStatic("png-invalid");
    expect(failure.presentation).toEqual(bodyFrame("idle", 0));
    expect(failure.effects).toEqual([
      readiness("animated", "error", "png-invalid"),
      settle([1], {
        type: "reject",
        timing: "microtask",
        error: "PlaybackFallbackError"
      })
    ]);
    expect(failure.snapshot).toMatchObject({
      readiness: "error",
      phase: "error",
      requestedState: "hover",
      visualState: "idle",
      isTransitioning: false,
      pendingRequestCount: 0
    });
  });

  it("disposes idempotently, aborts pending requests, and remains terminal", () => {
    const engine = animatedEngine(graph());
    const pending = engine.request("hover");

    const disposed = engine.dispose();
    expect(disposed.presentation).toBeNull();
    expect(disposed.effects).toEqual([
      settle([pending.requestId!], {
        type: "reject",
        timing: "microtask",
        error: "AbortError"
      }),
      readiness("animated", "disposed")
    ]);
    expect(disposed.snapshot).toMatchObject({
      readiness: "disposed",
      phase: "disposed",
      pendingRequestCount: 0
    });

    expect(engine.dispose().effects).toEqual([]);
    expect(() => engine.failStatic()).toThrowError(/disposed graph cannot fail static/);
    expect(engine.snapshot()).toMatchObject({
      readiness: "disposed",
      phase: "disposed"
    });
  });
});

interface FixtureOptions {
  readonly sourceKind?: GraphBodyKind;
  readonly sourcePortals?: readonly number[];
  readonly introFrames?: number;
  readonly start?:
    | { readonly type: "portal"; readonly maxWaitFrames: number }
    | { readonly type: "finish"; readonly maxWaitFrames: number }
    | { readonly type: "cut"; readonly maxWaitFrames: 1 };
}

function graph(options: FixtureOptions = {}): MotionGraphDefinition {
  const sourceKind = options.sourceKind ?? "loop";
  const sourceFrameCount = sourceKind === "held" ? 1 : 4;
  const sourcePortals = options.sourcePortals ?? [0, 2];
  const initialUnit =
    options.introFrames === undefined
      ? {}
      : {
          initialUnit: {
            unitId: "idle-intro",
            frameCount: options.introFrames
          }
        };
  const idle: GraphStateDefinition = {
    id: "idle",
    staticFrameId: "idle-static",
    body: {
      unitId: "idle-body",
      kind: sourceKind,
      frameCount: sourceFrameCount,
      ports: [
        { id: "handoff", entryFrame: 0, portalFrames: sourcePortals }
      ]
    },
    ...initialUnit
  };
  const hover: GraphStateDefinition = {
    id: "hover",
    staticFrameId: "hover-static",
    body: {
      unitId: "hover-body",
      kind: "loop",
      frameCount: 4,
      ports: [
        { id: "handoff", entryFrame: 0, portalFrames: [0, 2] }
      ]
    }
  };
  const start = options.start ?? { type: "portal", maxWaitFrames: 1 };
  const edge: GraphEdgeDefinition =
    start.type === "portal"
      ? {
          id: "idle-to-hover",
          from: "idle",
          to: "hover",
          start: {
            type: "portal",
            sourcePort: "handoff",
            targetPort: "handoff",
            maxWaitFrames: start.maxWaitFrames
          },
          continuity: "exact-authored"
        }
      : start.type === "finish"
        ? {
            id: "idle-to-hover",
            from: "idle",
            to: "hover",
            start: {
              type: "finish",
              targetPort: "handoff",
              maxWaitFrames: start.maxWaitFrames
            },
            continuity: "exact-authored"
          }
        : {
            id: "idle-to-hover",
            from: "idle",
            to: "hover",
            start: {
              type: "cut",
              targetPort: "handoff",
              maxWaitFrames: 1
            },
            continuity: "cut"
          };

  return { initialState: "idle", states: [idle, hover], edges: [edge] };
}

function animatedEngine(definition: MotionGraphDefinition): MotionGraphEngine {
  const engine = new MotionGraphEngine();
  engine.install(definition);
  engine.beginAnimated();
  return engine;
}

function staticFrame(state: "idle" | "hover") {
  return { kind: "static", state, staticFrameId: `${state}-static` } as const;
}

function bodyFrame(state: "idle" | "hover", frameIndex: number) {
  return {
    kind: "body",
    state,
    unitId: `${state}-body`,
    frameIndex
  } as const;
}

function introFrame(frameIndex: number) {
  return {
    kind: "intro",
    state: "idle",
    unitId: "idle-intro",
    frameIndex
  } as const;
}

function readiness(
  from: string,
  to: string,
  reason?: string
) {
  return reason === undefined
    ? { type: "readinesschange", from, to }
    : { type: "readinesschange", from, to, reason };
}

function fallback(reason: string) {
  return { type: "fallback", reason } as const;
}

function requested(from: string, to: string, sequence: number) {
  return { type: "requestedstatechange", from, to, sequence } as const;
}

function visual(from: string, to: string) {
  return { type: "visualstatechange", from, to } as const;
}

function transitionStart(
  edgeId: string,
  from: string,
  to: string,
  sequence: number
) {
  return { type: "transitionstart", edgeId, from, to, sequence } as const;
}

function transitionEnd(edgeId: string, from: string, to: string) {
  return { type: "transitionend", edgeId, from, to } as const;
}

function settle(
  requestIds: readonly number[],
  outcome:
    | {
        readonly type: "resolve";
        readonly timing: "microtask";
        readonly reason:
          | "stable-noop"
          | "target-committed"
          | "static-recovery";
      }
    | {
        readonly type: "reject";
        readonly timing: "microtask";
        readonly error:
          | "NotReadyError"
          | "PlaybackFallbackError"
          | "AbortError";
      }
) {
  return { type: "settle", requestIds, outcome } as const;
}
