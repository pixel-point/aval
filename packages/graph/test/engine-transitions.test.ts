import { describe, expect, it } from "vitest";

import { MotionGraphEngine } from "../src/engine.js";
import type {
  GraphEdgeDefinition,
  GraphStateDefinition,
  MotionGraphDefinition,
  MotionGraphEffect,
  MotionGraphResult
} from "../src/model.js";

describe("MotionGraphEngine transition routing", () => {
  it("reverses an active resident clip to the adjacent frame on the next tick", () => {
    const engine = animatedEngine(reversibleGraph());

    const forward = engine.request("hover");
    expect(forward).toMatchObject({ accepted: true, joined: false });
    expect(engine.tick({ contentOrdinal: 0n }).presentation).toEqual(
      reversiblePresentation("idle-to-hover", 0, "forward")
    );
    expect(engine.tick({ contentOrdinal: 1n }).presentation).toEqual(
      reversiblePresentation("idle-to-hover", 1, "forward")
    );

    const inverse = engine.request("idle");
    expect(inverse).toMatchObject({ accepted: true, joined: false });
    expect(inverse.snapshot).toMatchObject({
      phase: "reversible",
      requestedState: "idle",
      visualState: "idle",
      prospectiveState: "idle"
    });

    const reversed = engine.tick({ contentOrdinal: 2n });
    expect(reversed.presentation).toEqual(
      reversiblePresentation("hover-to-idle", 0, "reverse")
    );
    expect(reversed.effects).toContainEqual({
      type: "transitionstart",
      edgeId: "hover-to-idle",
      from: "hover",
      to: "idle",
      sequence: inverse.sequence
    });
  });

  it("previews a reversible tick exactly without advancing its active route", () => {
    const engine = animatedEngine(reversibleGraph());
    engine.request("hover");
    engine.tick({ contentOrdinal: 0n });
    const beforeSnapshot = engine.snapshot();
    const beforeTrace = engine.getTrace();

    const firstPreview = engine.previewTick({ contentOrdinal: 1n });
    const secondPreview = engine.previewTick({ contentOrdinal: 1n });

    expect(firstPreview).toEqual(secondPreview);
    expect(firstPreview.presentation).toEqual(
      reversiblePresentation("idle-to-hover", 1, "forward")
    );
    expect(engine.snapshot()).toEqual(beforeSnapshot);
    expect(engine.getTrace()).toEqual(beforeTrace);
    expect(engine.tick({ contentOrdinal: 1n })).toEqual(firstPreview);
  });

  it("reverses an active reverse clip forward to the adjacent frame", () => {
    const engine = animatedEngine(reversibleGraph());
    engine.request("hover");
    engine.tick({ contentOrdinal: 0n });
    engine.tick({ contentOrdinal: 1n });
    engine.tick({ contentOrdinal: 2n });
    engine.tick({ contentOrdinal: 3n });

    engine.request("idle");
    expect(engine.tick({ contentOrdinal: 4n }).presentation).toEqual(
      reversiblePresentation("hover-to-idle", 2, "reverse")
    );
    expect(engine.tick({ contentOrdinal: 5n }).presentation).toEqual(
      reversiblePresentation("hover-to-idle", 1, "reverse")
    );

    const forward = engine.request("hover");
    const adjacent = engine.tick({ contentOrdinal: 6n });
    expect(adjacent.presentation).toEqual(
      reversiblePresentation("idle-to-hover", 2, "forward")
    );
    expect(adjacent.effects).toContainEqual({
      type: "transitionstart",
      edgeId: "idle-to-hover",
      from: "idle",
      to: "hover",
      sequence: forward.sequence
    });
  });

  it("cancels a portal-waiting edge when its source state is requested", () => {
    const engine = animatedEngine(reversibleGraph());
    const pending = engine.request("hover");

    expect(pending.snapshot).toMatchObject({
      phase: "waiting",
      pendingEdgeId: "idle-to-hover",
      requestedState: "hover"
    });

    const cancelled = engine.request("idle");
    expect(cancelled).toMatchObject({ accepted: true, joined: false });
    expect(cancelled.snapshot).toMatchObject({
      phase: "stable",
      pendingEdgeId: null,
      requestedState: "idle",
      visualState: "idle",
      isTransitioning: false
    });
    expect(settleEffects(cancelled)).toEqual([
      settle([pending.requestId!], "reject", "AbortError"),
      settle([cancelled.requestId!], "resolve", "stable-noop")
    ]);

    const next = engine.tick({ contentOrdinal: 0n });
    expect(next.presentation).toEqual(bodyPresentation("idle", 1));
    expect(effectTypes(next)).not.toContain("transitionstart");
  });

  it("uses the pending edge's inverse event before normal visual-state lookup", () => {
    const engine = animatedEngine(reversibleGraph());

    expect(engine.send("hover.enter")).toMatchObject({ accepted: true });
    const cancelled = engine.send("hover.leave");

    expect(cancelled).toMatchObject({ accepted: true });
    expect(cancelled.snapshot).toMatchObject({
      phase: "stable",
      pendingEdgeId: null,
      requestedState: "idle",
      visualState: "idle",
      isTransitioning: false
    });
    expect(engine.tick({ contentOrdinal: 0n }).presentation).toEqual(
      bodyPresentation("idle", 1)
    );
    expect(
      engine
        .getTrace()
        .some(({ result }) => result.presentation?.kind === "reversible")
    ).toBe(false);
  });

  it("lets a source request cancel an event-owned route during preparation", () => {
    const engine = new MotionGraphEngine();
    engine.install(reversibleGraph());
    expect(engine.send("hover.enter")).toMatchObject({ accepted: true });

    const source = engine.request("idle");
    expect(source.snapshot).toMatchObject({
      phase: "preparing",
      requestedState: "idle",
      visualState: "idle",
      pendingEdgeId: null,
      isTransitioning: false
    });
    expect(settleEffects(source)).toEqual([
      settle([source.requestId!], "resolve", "stable-noop")
    ]);
    expect(engine.beginAnimated().snapshot.phase).toBe("stable");
  });

  it("lets an inverse event cancel a pending route while the intro continues", () => {
    const definition = reversibleGraph();
    const initial = definition.states[0]!;
    const engine = new MotionGraphEngine();
    engine.install({
      ...definition,
      states: [
        {
          ...initial,
          initialUnit: { unitId: "idle-intro", frameCount: 2 }
        },
        ...definition.states.slice(1)
      ]
    });
    engine.beginAnimated();

    expect(engine.send("hover.enter")).toMatchObject({ accepted: true });
    const cancelled = engine.send("hover.leave");
    expect(cancelled).toMatchObject({ accepted: true });
    expect(cancelled.snapshot).toMatchObject({
      phase: "intro",
      requestedState: "idle",
      visualState: "idle",
      pendingEdgeId: null,
      isTransitioning: false
    });
    expect(engine.tick({ contentOrdinal: 0n }).presentation).toEqual({
      kind: "intro",
      state: "idle",
      unitId: "idle-intro",
      frameIndex: 1
    });
  });

  it("converges a same-tick mixed burst to its newest valid intent", () => {
    const engine = animatedEngine(reversibleGraph());

    const first = engine.request("hover");
    const inverseEvent = engine.send("hover.leave");
    const latest = engine.request("hover");

    expect([first.sequence, inverseEvent.sequence, latest.sequence]).toEqual([
      1,
      2,
      3
    ]);
    expect(first.accepted).toBe(true);
    expect(inverseEvent.accepted).toBe(true);
    expect(latest.accepted).toBe(true);
    expect(latest.snapshot).toMatchObject({
      phase: "waiting",
      requestedState: "hover",
      prospectiveState: "hover",
      pendingEdgeId: "idle-to-hover",
      inputsSinceTick: 3
    });

    const tick = engine.tick({ contentOrdinal: 0n });
    expect(tick.presentation).toEqual(
      reversiblePresentation("idle-to-hover", 0, "forward")
    );
    expect(tick.snapshot).toMatchObject({
      phase: "reversible",
      requestedState: "hover",
      inputsSinceTick: 0
    });
  });

  it("joins duplicate requests and supersedes the whole group in request order", () => {
    const engine = animatedEngine(reversibleGraph({ includeIdleError: true }));

    const first = engine.request("hover");
    const duplicate = engine.request("hover");
    expect(first).toMatchObject({ accepted: true, joined: false, requestId: 1 });
    expect(duplicate).toMatchObject({
      accepted: true,
      joined: true,
      requestId: 2
    });
    expect(duplicate.snapshot.pendingRequestCount).toBe(2);

    const replacement = engine.request("error");
    expect(replacement).toMatchObject({
      accepted: true,
      joined: false,
      requestId: 3
    });
    expect(settleEffects(replacement)).toEqual([
      settle([first.requestId!, duplicate.requestId!], "reject", "AbortError")
    ]);
    expect(replacement.snapshot).toMatchObject({
      phase: "waiting",
      requestedState: "error",
      prospectiveState: "error",
      pendingEdgeId: "idle-to-error",
      pendingRequestCount: 1
    });
  });

  it("retains a valid reversible follow-on and rejects an invalid route without mutation", () => {
    const engine = animatedEngine(reversibleGraph({ includeFollowOn: true }));
    const initial = engine.request("hover");
    engine.tick({ contentOrdinal: 0n });
    engine.tick({ contentOrdinal: 1n });

    const followOn = engine.request("success");
    expect(followOn).toMatchObject({ accepted: true, joined: false });
    expect(followOn.snapshot).toMatchObject({
      phase: "reversible",
      requestedState: "success",
      prospectiveState: "success",
      activeEdgeId: "idle-to-hover",
      followOnEdgeId: "hover-to-success"
    });
    expect(settleEffects(followOn)).toEqual([
      settle([initial.requestId!], "reject", "AbortError")
    ]);

    const beforeInvalid = followOn.snapshot;
    const invalid = engine.request("error");
    expect(invalid).toMatchObject({ accepted: false, joined: false });
    expect(settleEffects(invalid)).toEqual([
      settle([invalid.requestId!], "reject", "RouteError")
    ]);
    expect(invalid.snapshot).toMatchObject({
      phase: beforeInvalid.phase,
      requestedState: beforeInvalid.requestedState,
      prospectiveState: beforeInvalid.prospectiveState,
      activeEdgeId: beforeInvalid.activeEdgeId,
      followOnEdgeId: beforeInvalid.followOnEdgeId,
      pendingRequestCount: beforeInvalid.pendingRequestCount
    });

    expect(engine.tick({ contentOrdinal: 2n }).presentation).toEqual(
      reversiblePresentation("idle-to-hover", 2, "forward")
    );
    const intermediate = engine.tick({ contentOrdinal: 3n });
    expect(intermediate).toMatchObject({
      presentation: bodyPresentation("hover", 0),
      snapshot: {
        phase: "waiting",
        visualState: "hover",
        requestedState: "success",
        pendingEdgeId: "hover-to-success"
      }
    });

    const committed = engine.tick({ contentOrdinal: 4n });
    expect(committed).toMatchObject({
      presentation: bodyPresentation("success", 0),
      snapshot: {
        phase: "stable",
        visualState: "success",
        requestedState: "success",
        isTransitioning: false
      }
    });
    expect(settleEffects(committed)).toEqual([
      settle([followOn.requestId!], "resolve", "target-committed")
    ]);
  });

  it("lets a repeated inverse event cancel a queued follow-on", () => {
    const engine = animatedEngine(reversibleGraph({ includeIdleError: true }));
    engine.request("hover");
    engine.tick({ contentOrdinal: 0n });
    engine.tick({ contentOrdinal: 1n });

    expect(engine.send("hover.leave")).toMatchObject({ accepted: true });
    const followOn = engine.request("error");
    expect(followOn.snapshot).toMatchObject({
      requestedState: "error",
      activeEdgeId: "idle-to-hover",
      followOnEdgeId: "idle-to-error",
      prospectiveState: "error"
    });

    const reiteratedInverse = engine.send("hover.leave");
    expect(reiteratedInverse).toMatchObject({ accepted: true });
    expect(reiteratedInverse.snapshot).toMatchObject({
      requestedState: "idle",
      activeEdgeId: "idle-to-hover",
      followOnEdgeId: null,
      prospectiveState: "idle"
    });
    expect(settleEffects(reiteratedInverse)).toEqual([
      settle([followOn.requestId!], "reject", "AbortError")
    ]);
  });

  it("finishes every locked bridge frame before routing its latest valid follow-on", () => {
    const engine = animatedEngine(lockedFollowOnGraph());
    const loading = engine.request("loading");

    expect(engine.tick({ contentOrdinal: 0n }).presentation).toEqual(
      lockedPresentation("idle-to-loading", 0)
    );
    const success = engine.request("success");
    expect(success).toMatchObject({ accepted: true, joined: false });
    expect(success.snapshot).toMatchObject({
      phase: "locked",
      requestedState: "success",
      prospectiveState: "success",
      activeEdgeId: "idle-to-loading",
      followOnEdgeId: "loading-to-success"
    });
    expect(settleEffects(success)).toEqual([
      settle([loading.requestId!], "reject", "AbortError")
    ]);

    expect(engine.tick({ contentOrdinal: 1n }).presentation).toEqual(
      lockedPresentation("idle-to-loading", 1)
    );
    expect(engine.tick({ contentOrdinal: 2n }).presentation).toEqual(
      lockedPresentation("idle-to-loading", 2)
    );

    const intermediate = engine.tick({ contentOrdinal: 3n });
    expect(intermediate).toMatchObject({
      presentation: bodyPresentation("loading", 0),
      snapshot: {
        phase: "waiting",
        visualState: "loading",
        requestedState: "success",
        pendingEdgeId: "loading-to-success"
      }
    });
    expect(effectTypes(intermediate)).toEqual([
      "visualstatechange",
      "transitionend"
    ]);

    const committed = engine.tick({ contentOrdinal: 4n });
    expect(committed).toMatchObject({
      presentation: bodyPresentation("success", 0),
      snapshot: {
        phase: "stable",
        visualState: "success",
        requestedState: "success",
        isTransitioning: false
      }
    });
    expect(effectTypes(committed)).toEqual([
      "transitionstart",
      "visualstatechange",
      "transitionend",
      "settle"
    ]);
    expect(settleEffects(committed)).toEqual([
      settle([success.requestId!], "resolve", "target-committed")
    ]);
  });

  it("previews a locked tick exactly without advancing its active route", () => {
    const engine = animatedEngine(lockedFollowOnGraph());
    engine.request("loading");
    engine.tick({ contentOrdinal: 0n });
    const beforeSnapshot = engine.snapshot();
    const beforeTrace = engine.getTrace();

    const firstPreview = engine.previewTick({ contentOrdinal: 1n });
    const secondPreview = engine.previewTick({ contentOrdinal: 1n });

    expect(firstPreview).toEqual(secondPreview);
    expect(firstPreview.presentation).toEqual(
      lockedPresentation("idle-to-loading", 1)
    );
    expect(engine.snapshot()).toEqual(beforeSnapshot);
    expect(engine.getTrace()).toEqual(beforeTrace);
    expect(engine.tick({ contentOrdinal: 1n })).toEqual(firstPreview);
  });
});

function animatedEngine(definition: MotionGraphDefinition): MotionGraphEngine {
  const engine = new MotionGraphEngine();
  engine.install(definition);
  engine.beginAnimated();
  return engine;
}

function reversibleGraph(
  options: {
    readonly includeFollowOn?: boolean;
    readonly includeIdleError?: boolean;
  } = {}
): MotionGraphDefinition {
  const states = [state("idle"), state("hover")];
  const edges: GraphEdgeDefinition[] = [
    reversibleEdge(
      "idle-to-hover",
      "idle",
      "hover",
      "forward",
      "hover.enter"
    ),
    reversibleEdge(
      "hover-to-idle",
      "hover",
      "idle",
      "reverse",
      "hover.leave",
      "idle-to-hover"
    )
  ];

  if (options.includeFollowOn === true) {
    states.push(state("success"), state("error"));
    edges.push(cutEdge("hover-to-success", "hover", "success"));
  } else if (options.includeIdleError === true) {
    states.push(state("error"));
    edges.push(cutEdge("idle-to-error", "idle", "error"));
  }

  return { initialState: "idle", states, edges };
}

function lockedFollowOnGraph(): MotionGraphDefinition {
  return {
    initialState: "idle",
    states: [state("idle"), state("loading"), state("success")],
    edges: [
      {
        ...portalEdge("idle-to-loading", "idle", "loading"),
        transition: {
          kind: "locked",
          unitId: "loading-bridge",
          frameCount: 3
        }
      },
      cutEdge("loading-to-success", "loading", "success")
    ]
  };
}

function state(id: string): GraphStateDefinition {
  return {
    id,
    staticFrameId: `${id}-static`,
    body: {
      unitId: `${id}-body`,
      kind: "loop",
      frameCount: 4,
      ports: [
        {
          id: "handoff",
          entryFrame: 0,
          portalFrames: [0, 2]
        }
      ]
    }
  };
}

function portalEdge(
  id: string,
  from: string,
  to: string
): GraphEdgeDefinition {
  return {
    id,
    from,
    to,
    start: {
      type: "portal",
      sourcePort: "handoff",
      targetPort: "handoff",
      maxWaitFrames: 1
    },
    continuity: "exact-authored"
  };
}

function reversibleEdge(
  id: string,
  from: string,
  to: string,
  direction: "forward" | "reverse",
  event: string,
  reverseOf?: string
): GraphEdgeDefinition {
  return {
    ...portalEdge(id, from, to),
    trigger: { type: "event", name: event },
    transition:
      reverseOf === undefined
        ? {
            kind: "reversible",
            unitId: "hover-clip",
            frameCount: 3,
            direction
          }
        : {
            kind: "reversible",
            unitId: "hover-clip",
            frameCount: 3,
            direction,
            reverseOf
          },
    continuity: reverseOf === undefined ? "exact-authored" : "exact-reverse"
  };
}

function cutEdge(
  id: string,
  from: string,
  to: string
): GraphEdgeDefinition {
  return {
    id,
    from,
    to,
    start: { type: "cut", targetPort: "handoff", maxWaitFrames: 1 },
    continuity: "cut"
  };
}

function reversiblePresentation(
  edgeId: string,
  frameIndex: number,
  direction: "forward" | "reverse"
): object {
  return {
    kind: "reversible",
    edgeId,
    unitId: "hover-clip",
    frameIndex,
    direction
  };
}

function lockedPresentation(edgeId: string, frameIndex: number): object {
  return {
    kind: "locked",
    edgeId,
    unitId: "loading-bridge",
    frameIndex
  };
}

function bodyPresentation(stateId: string, frameIndex: number): object {
  return {
    kind: "body",
    state: stateId,
    unitId: `${stateId}-body`,
    frameIndex
  };
}

function effectTypes(result: Readonly<MotionGraphResult>): string[] {
  return result.effects.map(({ type }) => type);
}

function settleEffects(
  result: Readonly<MotionGraphResult>
): Extract<MotionGraphEffect, { type: "settle" }>[] {
  return result.effects.filter(
    (effect): effect is Extract<MotionGraphEffect, { type: "settle" }> =>
      effect.type === "settle"
  );
}

function settle(
  requestIds: readonly number[],
  outcome: "resolve" | "reject",
  reasonOrError:
    | "stable-noop"
    | "target-committed"
    | "AbortError"
    | "RouteError"
): object {
  return {
    type: "settle",
    requestIds,
    outcome:
      outcome === "resolve"
        ? {
            type: "resolve",
            timing: "microtask",
            reason: reasonOrError
          }
        : {
            type: "reject",
            timing: "microtask",
            error: reasonOrError
          }
  };
}
