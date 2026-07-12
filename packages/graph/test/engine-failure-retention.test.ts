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

    const failed = engine.failStatic("recovery failed", {
      retainedVisualState: "idle"
    });
    expect(failed).toMatchObject({
      presentation: {
        kind: "static",
        state: "idle",
        staticFrameId: "idle-static"
      },
      snapshot: {
        readiness: "error",
        phase: "error",
        requestedState: "hover",
        visualState: "idle",
        isTransitioning: false
      }
    });
    expect(() => engine.failStatic("again", {
      retainedVisualState: "missing"
    })).toThrow("retained visual state");
  });

  it("recovers from the pixels actually retained after a superseded failed cut", () => {
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

    const recovered = engine.recoverStatic("animation-failure", {
      retainedVisualState: "idle"
    });

    expect(recovered.presentation).toMatchObject({
      kind: "static",
      state: "idle"
    });
    expect(recovered.snapshot).toMatchObject({
      readiness: "static",
      requestedState: "idle",
      visualState: "idle",
      isTransitioning: false
    });
    expect(recovered.effects.map(({ type }) => type)).toEqual([
      "readinesschange",
      "fallback",
      "settle"
    ]);
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
    staticFrameId: `${id}-static`,
    body: {
      unitId: `${id}-body`,
      kind: "loop" as const,
      frameCount: 2,
      ports: [{ id: "default", entryFrame: 0 as const, portalFrames: [0, 1] }]
    }
  };
}
