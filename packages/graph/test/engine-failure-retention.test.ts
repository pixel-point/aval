import { describe, expect, it } from "vitest";

import { MotionGraphEngine } from "../src/engine.js";

describe("MotionGraphEngine failed presentation retention", () => {
  it("restores the host's last drawn state when a committed cut cannot recover", () => {
    const engine = new MotionGraphEngine();
    engine.install({
      initialState: "idle",
      states: [state("idle"), state("hover")],
      edges: [{
        id: "idle-hover",
        from: "idle",
        to: "hover",
        start: { type: "cut", targetPort: "default", maxWaitFrames: 1 },
        continuity: "cut"
      }]
    });
    engine.beginAnimated();
    engine.request("hover");
    const committed = engine.tick({ contentOrdinal: 0n });
    expect(committed.snapshot.visualState).toBe("hover");

    const failed = engine.failPlayback("recovery failed", {
      retainedVisualState: "idle"
    });
    expect(failed).toMatchObject({
      presentation: {
        kind: "static",
        state: "idle"
      },
      snapshot: {
        readiness: "error",
        phase: "error",
        requestedState: "hover",
        visualState: "idle",
        isTransitioning: false
      }
    });
    const failedSnapshot = engine.snapshot();
    const failedTrace = engine.getTrace();
    expect(() => engine.resumeAnimated()).toThrowError(/requires phase static/);
    expect(engine.snapshot()).toEqual(failedSnapshot);
    expect(engine.getTrace()).toEqual(failedTrace);
    expect(() => engine.failPlayback("again", {
      retainedVisualState: "missing"
    })).toThrow("retained visual state");
  });

  it("retains the pixels actually drawn after a superseded animation failure", () => {
    const engine = new MotionGraphEngine();
    engine.install({
      initialState: "idle",
      states: [state("idle"), state("hover")],
      edges: [
        cut("idle-hover", "idle", "hover"),
        cut("hover-idle", "hover", "idle")
      ]
    });
    engine.beginAnimated();
    engine.request("hover");
    engine.tick({ contentOrdinal: 0n });
    const latest = engine.request("idle");
    expect(latest.accepted).toBe(true);

    const failed = engine.failPlayback("animation-failure", {
      retainedVisualState: "idle"
    });

    expect(failed.presentation).toMatchObject({
      kind: "static",
      state: "idle"
    });
    expect(failed.snapshot).toMatchObject({
      readiness: "error",
      phase: "error",
      requestedState: "idle",
      visualState: "idle",
      isTransitioning: false,
      pendingRequestCount: 0
    });
    expect(failed.effects).toEqual([
      {
        type: "readinesschange",
        from: "animated",
        to: "error",
        reason: "animation-failure"
      },
      {
        type: "settle",
        requestIds: [latest.requestId],
        outcome: {
          type: "reject",
          timing: "microtask",
          error: "PlaybackError"
        }
      }
    ]);
    expect(() => engine.resumeAnimated()).toThrowError(/requires phase static/);
  });

  it("does not resume or clear a disposed terminal graph", () => {
    const engine = new MotionGraphEngine();
    engine.install({
      initialState: "idle",
      states: [state("idle")],
      edges: []
    });
    engine.beginStatic("reduced-motion");
    engine.dispose();
    const snapshot = engine.snapshot();
    const trace = engine.getTrace();

    expect(() => engine.resumeAnimated()).toThrowError(/requires phase static/);
    expect(engine.snapshot()).toEqual(snapshot);
    expect(engine.getTrace()).toEqual(trace);
  });
});

function cut(id: string, from: string, to: string) {
  return {
    id,
    from,
    to,
    start: {
      type: "cut" as const,
      targetPort: "default",
      maxWaitFrames: 1 as const
    },
    continuity: "cut" as const
  };
}

function state(id: string) {
  return {
    id,
    body: {
      unitId: `${id}-body`,
      kind: "loop" as const,
      frameCount: 2,
      ports: [{ id: "default", entryFrame: 0 as const, portalFrames: [0, 1] }]
    }
  };
}
