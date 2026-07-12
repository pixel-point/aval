import { describe, expect, it } from "vitest";

import type {
  GraphBodyDefinition,
  GraphEdgeDefinition,
  GraphStartPolicy
} from "@rendered-motion/graph";

import {
  planSubmissionHorizon,
  planUnresolvedSubmissionHorizon,
  type SourceBodyCursor
} from "./submission-horizon.js";

describe("unresolved source submission horizon", () => {
  it("allows at most one ring capacity beyond the earliest unresolved portal", () => {
    const input = {
      body: loop(12, {
        first: [4, 10],
        second: [7]
      }),
      displayed: cursor(0, 2),
      outgoingStarts: [portalStart("first"), portalStart("second")],
      ringCapacity: 6
    } as const;

    expect(planUnresolvedSubmissionHorizon({
      ...input,
      submitted: cursor(0, 10)
    })).toEqual({
      earliestBoundary: boundary("portal", 0, 4, false),
      maximumSubmitted: cursor(0, 10),
      submittedWithinHorizon: true,
      framesBeyondEarliestBoundary: 6n
    });
    expect(planUnresolvedSubmissionHorizon({
      ...input,
      submitted: cursor(0, 11)
    })).toMatchObject({
      maximumSubmitted: cursor(0, 10),
      submittedWithinHorizon: false,
      framesBeyondEarliestBoundary: 7n
    });
  });

  it("caps finite and held horizons at the final authored frame", () => {
    expect(planUnresolvedSubmissionHorizon({
      body: finite(4, { exit: [3] }),
      displayed: cursor(0, 1),
      submitted: cursor(0, 3),
      outgoingStarts: [finishStart()],
      ringCapacity: 12
    })).toMatchObject({
      earliestBoundary: boundary("finish", 0, 3, false),
      maximumSubmitted: cursor(0, 3),
      submittedWithinHorizon: true
    });
    expect(planUnresolvedSubmissionHorizon({
      body: held(),
      displayed: cursor(0, 0),
      submitted: cursor(0, 0),
      outgoingStarts: [portalStart("exit")],
      ringCapacity: 6
    })).toMatchObject({ maximumSubmitted: cursor(0, 0) });
  });
});

describe("selected portal submission planning", () => {
  it("discards speculative source debt only for a resident reversible portal", () => {
    const body = loop(8, { exit: [7] });
    const common = {
      body,
      displayed: cursor(0, 0),
      submitted: cursor(1, 5),
      ringCapacity: 6,
      availableConsecutiveEdgeFrames: 0,
      elapsedWaitFrames: 0
    } as const;

    expect(planSubmissionHorizon({
      ...common,
      edge: reversibleEdge(portalStart("exit", 12))
    })).toMatchObject({
      kind: "select-portal",
      reason: "authored-boundary",
      boundary: boundary("portal", 0, 7, false),
      waitFrames: 7,
      totalWaitFrames: 7
    });

    expect(planSubmissionHorizon({
      ...common,
      edge: edge(portalStart("exit", 12)),
      availableConsecutiveEdgeFrames: 2
    })).toMatchObject({
      kind: "reject-readiness",
      reason: "max-wait-exceeded",
      requiredWaitFrames: 15n,
      maxWaitFrames: 12
    });
  });

  it("selects a later portal when source submission has passed an early one", () => {
    const decision = planSubmissionHorizon({
      body: loop(12, { exit: [2, 6, 9] }),
      edge: edge(portalStart("exit", 8)),
      displayed: cursor(0, 3),
      submitted: cursor(0, 7),
      ringCapacity: 6,
      availableConsecutiveEdgeFrames: 2,
      elapsedWaitFrames: 0
    });

    expect(decision).toMatchObject({
      kind: "select-portal",
      reason: "submitted-horizon",
      boundary: boundary("portal", 0, 9, false),
      waitFrames: 6,
      totalWaitFrames: 6
    });
  });

  it("searches a loop circularly without inventing a finite wrap", () => {
    expect(planSubmissionHorizon({
      body: loop(12, { exit: [0, 4, 9] }),
      edge: edge(portalStart("exit", 4)),
      displayed: cursor(0, 10),
      submitted: cursor(0, 11),
      ringCapacity: 6,
      availableConsecutiveEdgeFrames: 2,
      elapsedWaitFrames: 0
    })).toMatchObject({
      kind: "select-portal",
      boundary: boundary("portal", 1, 0, true),
      waitFrames: 2,
      totalWaitFrames: 2
    });
  });

  it("commits a transitionless portal only with its two-frame lead", () => {
    const input = {
      body: loop(6, { exit: [0, 3] }),
      edge: edge(portalStart("exit", 3)),
      displayed: cursor(0, 0),
      submitted: cursor(0, 0),
      ringCapacity: 6,
      elapsedWaitFrames: 0
    } as const;

    expect(planSubmissionHorizon({
      ...input,
      availableConsecutiveEdgeFrames: 2
    })).toMatchObject({
      kind: "commit-edge",
      boundary: boundary("portal", 0, 0, false),
      lead: { requiredConsecutiveFrames: 2, ready: true }
    });
    expect(planSubmissionHorizon({
      ...input,
      availableConsecutiveEdgeFrames: 1
    })).toMatchObject({
      kind: "select-portal",
      reason: "lead-unavailable",
      boundary: boundary("portal", 0, 3, false),
      waitFrames: 3
    });
  });

  it("requires one bridge frame followed by target frame zero", () => {
    const locked = edge(portalStart("exit", 3), 1);
    const base = {
      body: loop(4, { exit: [0, 2] }),
      edge: locked,
      displayed: cursor(0, 0),
      submitted: cursor(0, 0),
      ringCapacity: 6,
      elapsedWaitFrames: 0
    } as const;

    expect(planSubmissionHorizon({
      ...base,
      availableConsecutiveEdgeFrames: 1
    })).toMatchObject({
      kind: "select-portal",
      reason: "lead-unavailable",
      lead: {
        targetEntryOffset: 1,
        requiredConsecutiveFrames: 2,
        ready: false
      }
    });
    expect(planSubmissionHorizon({
      ...base,
      availableConsecutiveEdgeFrames: 2
    })).toMatchObject({
      kind: "commit-edge",
      lead: { targetEntryOffset: 1, ready: true }
    });
  });

  it.each([
    [0, 0],
    [1, 2],
    [2, 1],
    [3, 0],
    [4, 2],
    [5, 1]
  ] as const)(
    "matches graph loop portal geometry from body frame %s",
    (displayedFrame, waitFrames) => {
      const decision = planSubmissionHorizon({
        body: loop(6, { exit: [0, 3] }),
        edge: edge(portalStart("exit", 3)),
        displayed: cursor(0, displayedFrame),
        submitted: cursor(0, displayedFrame),
        ringCapacity: 6,
        availableConsecutiveEdgeFrames: 2,
        elapsedWaitFrames: 0
      });
      expect(decision.kind).toBe(waitFrames === 0
        ? "commit-edge"
        : "select-portal");
      expect("waitFrames" in decision ? decision.waitFrames : 0).toBe(
        waitFrames
      );
    }
  );
});

describe("finite, held, finish, and max-wait planning", () => {
  it("selects only forward finite portals and holds the final portal", () => {
    const base = {
      body: finite(4, { exit: [1, 3] }),
      edge: edge(portalStart("exit", 4)),
      ringCapacity: 6,
      elapsedWaitFrames: 0
    } as const;

    expect(planSubmissionHorizon({
      ...base,
      displayed: cursor(0, 2),
      submitted: cursor(0, 2),
      availableConsecutiveEdgeFrames: 2
    })).toMatchObject({
      kind: "select-portal",
      boundary: boundary("portal", 0, 3, false),
      waitFrames: 1
    });
    expect(planSubmissionHorizon({
      ...base,
      displayed: cursor(0, 3),
      submitted: cursor(0, 3),
      availableConsecutiveEdgeFrames: 1
    })).toMatchObject({
      kind: "wait-held",
      boundary: boundary("portal", 0, 3, false)
    });
  });

  it.each([0, 1, 2, 3] as const)(
    "matches finite finish geometry from frame %s",
    (frame) => {
      const decision = planSubmissionHorizon({
        body: finite(4, { exit: [3] }),
        edge: edge(finishStart(3)),
        displayed: cursor(0, frame),
        submitted: cursor(0, frame),
        ringCapacity: 6,
        availableConsecutiveEdgeFrames: 2,
        elapsedWaitFrames: 0
      });
      expect(decision.kind).toBe(frame === 3
        ? "commit-edge"
        : "continue-source");
      expect("waitFrames" in decision ? decision.waitFrames : 0).toBe(
        3 - frame
      );
    }
  );

  it("holds a finite/held final boundary when lead is missing", () => {
    for (const body of [finite(4, { exit: [3] }), held()]) {
      const frame = body.frameCount - 1;
      expect(planSubmissionHorizon({
        body,
        edge: edge(finishStart(4)),
        displayed: cursor(0, frame),
        submitted: cursor(0, frame),
        ringCapacity: 6,
        availableConsecutiveEdgeFrames: 1,
        elapsedWaitFrames: 2
      })).toMatchObject({
        kind: "wait-held",
        boundary: boundary("finish", 0, frame, false),
        remainingWaitFrames: 2,
        lead: { ready: false }
      });
    }
  });

  it("allows the exact maxWaitFrames boundary and rejects one frame beyond", () => {
    const base = {
      body: loop(4, { exit: [0, 2] }),
      displayed: cursor(0, 1),
      submitted: cursor(0, 1),
      ringCapacity: 6,
      availableConsecutiveEdgeFrames: 2,
      elapsedWaitFrames: 1
    } as const;

    expect(planSubmissionHorizon({
      ...base,
      edge: edge(portalStart("exit", 2))
    })).toMatchObject({
      kind: "select-portal",
      waitFrames: 1,
      totalWaitFrames: 2
    });
    expect(planSubmissionHorizon({
      ...base,
      edge: edge(portalStart("exit", 1))
    })).toMatchObject({
      kind: "reject-readiness",
      reason: "max-wait-exceeded",
      requiredWaitFrames: 2n,
      maxWaitFrames: 1
    });
  });

  it("restarts a generation for a one-tick cut", () => {
    expect(planSubmissionHorizon({
      body: loop(4, { exit: [0] }),
      edge: edge({
        type: "cut",
        targetPort: "entry",
        maxWaitFrames: 1
      }),
      displayed: cursor(0, 2),
      submitted: cursor(0, 3),
      ringCapacity: 6,
      availableConsecutiveEdgeFrames: 0,
      elapsedWaitFrames: 0
    })).toEqual({
      kind: "restart-generation",
      reason: "cut",
      responseFrames: 1,
      totalWaitFrames: 1
    });
  });
});

describe("submission planner validation", () => {
  it("rejects malformed cursors, backwards submission, and invalid ring lead", () => {
    const base = {
      body: loop(4, { exit: [0, 2] }),
      edge: edge(portalStart("exit", 3)),
      ringCapacity: 6,
      availableConsecutiveEdgeFrames: 2,
      elapsedWaitFrames: 0
    } as const;

    expect(() => planSubmissionHorizon({
      ...base,
      displayed: cursor(1, 0),
      submitted: cursor(0, 3)
    })).toThrow("behind");
    expect(() => planSubmissionHorizon({
      ...base,
      displayed: cursor(0, 4),
      submitted: cursor(0, 4)
    })).toThrow("out of range");
    expect(() => planSubmissionHorizon({
      ...base,
      displayed: cursor(0, 0),
      submitted: cursor(0, 0),
      availableConsecutiveEdgeFrames: 7
    })).toThrow("available consecutive");
    expect(() => planSubmissionHorizon({
      ...base,
      body: finite(4, { exit: [3] }),
      displayed: cursor(1, 0),
      submitted: cursor(1, 0)
    })).toThrow("occurrence zero");

    expect(planSubmissionHorizon({
      ...base,
      displayed: cursor(0, 0),
      submitted: {
        occurrence: BigInt(Number.MAX_SAFE_INTEGER) * 1_000_000n,
        frame: 0
      }
    })).toMatchObject({
      kind: "reject-readiness",
      reason: "max-wait-exceeded"
    });
  });

  it("returns frozen decisions and nested boundaries", () => {
    const decision = planSubmissionHorizon({
      body: loop(4, { exit: [0, 2] }),
      edge: edge(portalStart("exit", 3)),
      displayed: cursor(0, 1),
      submitted: cursor(0, 1),
      ringCapacity: 6,
      availableConsecutiveEdgeFrames: 2,
      elapsedWaitFrames: 0
    });
    expect(Object.isFrozen(decision)).toBe(true);
    if ("boundary" in decision) {
      expect(Object.isFrozen(decision.boundary)).toBe(true);
    }
  });
});

function cursor(occurrence: number, frame: number): SourceBodyCursor {
  return { occurrence: BigInt(occurrence), frame };
}

function boundary(
  type: "portal" | "finish" | "cut",
  occurrence: number,
  frame: number,
  wraps: boolean
) {
  return { type, occurrence: BigInt(occurrence), frame, wraps } as const;
}

function loop(
  frameCount: number,
  ports: Readonly<Record<string, readonly number[]>>
): GraphBodyDefinition {
  return body("loop", frameCount, ports);
}

function finite(
  frameCount: number,
  ports: Readonly<Record<string, readonly number[]>>
): GraphBodyDefinition {
  return body("finite", frameCount, ports);
}

function held(): GraphBodyDefinition {
  return body("held", 1, { exit: [0] });
}

function body(
  kind: GraphBodyDefinition["kind"],
  frameCount: number,
  ports: Readonly<Record<string, readonly number[]>>
): GraphBodyDefinition {
  return {
    unitId: `${kind}-body`,
    kind,
    frameCount,
    ports: Object.entries(ports).map(([id, portalFrames]) => ({
      id,
      entryFrame: 0,
      portalFrames
    }))
  };
}

function portalStart(
  sourcePort: string,
  maxWaitFrames = 12
): Extract<GraphStartPolicy, { readonly type: "portal" }> {
  return {
    type: "portal",
    sourcePort,
    targetPort: "entry",
    maxWaitFrames
  };
}

function finishStart(
  maxWaitFrames = 12
): Extract<GraphStartPolicy, { readonly type: "finish" }> {
  return { type: "finish", targetPort: "entry", maxWaitFrames };
}

function edge(
  start: GraphStartPolicy,
  lockedFrames?: number
): GraphEdgeDefinition {
  const definition = {
    id: "edge",
    from: "source",
    to: "target",
    start,
    continuity: start.type === "cut" ? "cut" : "exact-authored"
  } as const;
  return lockedFrames === undefined
    ? definition
    : {
        ...definition,
        transition: {
          kind: "locked",
          unitId: "bridge",
          frameCount: lockedFrames
        }
      };
}

function reversibleEdge(start: GraphStartPolicy): GraphEdgeDefinition {
  return {
    id: "reversible-edge",
    from: "source",
    to: "target",
    start,
    transition: {
      kind: "reversible",
      unitId: "resident-shift",
      frameCount: 6,
      direction: "forward"
    },
    continuity: "exact-authored"
  };
}
