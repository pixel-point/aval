import { describe, expect, it } from "vitest";

import { MotionGraphEngine } from "../src/engine.js";
import { planRingArc } from "../src/ring-plan.js";
import type {
  GraphEdgeDefinition,
  GraphRingDefinition,
  GraphStateDefinition,
  MotionGraphDefinition,
  MotionGraphEffect,
  MotionGraphResult
} from "../src/model.js";

const FACINGS = Object.freeze([
  "walk_n",
  "walk_ne",
  "walk_e",
  "walk_se",
  "walk_s",
  "walk_sw",
  "walk_w",
  "walk_nw"
]);

describe("ring arc selection", () => {
  it("chooses the shorter arc and reports the states it lands on", () => {
    const ring = facingRing();

    expect(planRingArc(ring, "walk_n", "walk_e")).toEqual({
      direction: "forward",
      states: ["walk_ne", "walk_e"]
    });
    // AC3: two steps forward beats six steps backward.
    expect(planRingArc(ring, "walk_nw", "walk_ne")).toEqual({
      direction: "forward",
      states: ["walk_n", "walk_ne"]
    });
    expect(planRingArc(ring, "walk_n", "walk_w")).toEqual({
      direction: "backward",
      states: ["walk_nw", "walk_w"]
    });
  });

  it("resolves an even-length half turn through tieBreak deterministically", () => {
    const forward = facingRing();
    const backward = facingRing({ tieBreak: "backward" });

    // AC4: an exact half turn is equidistant in both directions.
    for (let attempt = 0; attempt < 100; attempt += 1) {
      expect(planRingArc(forward, "walk_n", "walk_s")).toEqual({
        direction: "forward",
        states: ["walk_ne", "walk_e", "walk_se", "walk_s"]
      });
      expect(planRingArc(backward, "walk_n", "walk_s")).toEqual({
        direction: "backward",
        states: ["walk_nw", "walk_w", "walk_sw", "walk_s"]
      });
    }
  });

  it("never wraps a non-cyclic ring", () => {
    const line = facingRing({ cyclic: false });

    expect(planRingArc(line, "walk_nw", "walk_ne")).toEqual({
      direction: "backward",
      states: ["walk_w", "walk_sw", "walk_s", "walk_se", "walk_e", "walk_ne"]
    });
    expect(planRingArc(line, "walk_n", "walk_n")).toBeNull();
    expect(planRingArc(line, "walk_n", "sit")).toBeNull();
  });
});

describe("MotionGraphEngine ring traversal", () => {
  it("plans a multi-step arc without advancing the graph", () => {
    const engine = animatedEngine();
    const before = engine.snapshot();

    // AC2: the dry run names every landing, in order.
    expect(engine.planFor("walk_e")).toEqual(["walk_ne", "walk_e"]);
    expect(engine.planFor("walk_ne")).toEqual(["walk_ne"]);
    expect(engine.planFor("walk_n")).toEqual([]);
    expect(engine.planFor("sit")).toEqual(["sit"]);
    expect(engine.planFor("unknown")).toBeNull();
    expect(engine.snapshot()).toEqual(before);
  });

  it("refuses an arc longer than the ring allows", () => {
    const engine = animatedEngine({ maxChainedSteps: 2 });

    expect(engine.planFor("walk_s")).toBeNull();
    const refused = engine.request("walk_s");
    expect(refused.accepted).toBe(false);
    expect(settleEffects(refused)).toEqual([
      settle([refused.requestId!], "reject", "RouteError")
    ]);
  });

  it("chains one step at a time and settles only on the requested landing", () => {
    const engine = animatedEngine();
    const request = engine.request("walk_e");
    expect(request.snapshot).toMatchObject({
      phase: "waiting",
      requestedState: "walk_e",
      visualState: "walk_n",
      pendingEdgeId: stepId("walk_n", "walk_ne"),
      turnRing: "facing.walk",
      turnStepsRemaining: 1
    });

    // AC2: the first step lands on the intermediate facing, and the request is
    // still outstanding there.
    const first = engine.tick({ contentOrdinal: 0n });
    expect(first.presentation).toEqual(bodyPresentation("walk_ne", 0));
    expect(first.snapshot).toMatchObject({
      phase: "waiting",
      visualState: "walk_ne",
      requestedState: "walk_e",
      pendingEdgeId: stepId("walk_ne", "walk_e"),
      turnStepsRemaining: 0
    });
    expect(effectTypes(first)).toEqual([
      "transitionstart",
      "visualstatechange",
      "transitionend",
      "turnstep"
    ]);
    expect(turnSteps(first)).toEqual([
      {
        type: "turnstep",
        ring: "facing.walk",
        from: "walk_n",
        to: "walk_ne",
        remaining: 1
      }
    ]);
    expect(settleEffects(first)).toEqual([]);

    const second = engine.tick({ contentOrdinal: 1n });
    expect(second.presentation).toEqual(bodyPresentation("walk_e", 0));
    expect(second.snapshot).toMatchObject({
      phase: "stable",
      visualState: "walk_e",
      requestedState: "walk_e",
      turnRing: null,
      turnStepsRemaining: 0,
      isTransitioning: false
    });
    expect(turnSteps(second)).toEqual([
      {
        type: "turnstep",
        ring: "facing.walk",
        from: "walk_ne",
        to: "walk_e",
        remaining: 0
      }
    ]);
    expect(settleEffects(second)).toEqual([
      settle([request.requestId!], "resolve", "target-committed")
    ]);
  });

  it("keeps every seam on a body frame across a full eight-step traversal", () => {
    const engine = animatedEngine();
    const clock = { ordinal: 0n };

    // AC8: each tick either advances a body frame or lands frame 0 of the next
    // body, so no seam ever seeks inside a unit.
    engine.request("walk_nw");
    expect(runToStable(engine, clock, "walk_n")).toEqual(["walk_nw"]);

    // Both arcs are four steps, so tieBreak "forward" decides.
    expect(engine.planFor("walk_se")).toEqual([
      "walk_n",
      "walk_ne",
      "walk_e",
      "walk_se"
    ]);
    const sweep = engine.request("walk_se");
    expect(runToStable(engine, clock, "walk_nw")).toEqual([
      "walk_n",
      "walk_ne",
      "walk_e",
      "walk_se"
    ]);
    expect(sweep.requestId).toBeTypeOf("number");

    // The whole eight-way loop, one landing per step, with no seek anywhere.
    engine.request("walk_e");
    engine.request("walk_s");
    engine.request("walk_w");
    expect(runToStable(engine, clock, "walk_se")).toEqual([
      "walk_s",
      "walk_sw",
      "walk_w"
    ]);
  });

  it("replans from the landed state and aborts the superseded request", () => {
    const engine = animatedEngine();
    const first = engine.request("walk_se");
    engine.tick({ contentOrdinal: 0n });
    expect(engine.snapshot()).toMatchObject({
      visualState: "walk_ne",
      pendingEdgeId: stepId("walk_ne", "walk_e")
    });

    // AC5: the new intent supersedes the old one without stopping the motion.
    const second = engine.request("walk_e");
    expect(second.accepted).toBe(true);
    expect(settleEffects(second)).toEqual([
      settle([first.requestId!], "reject", "AbortError")
    ]);
    expect(second.snapshot).toMatchObject({
      phase: "waiting",
      requestedState: "walk_e",
      visualState: "walk_ne",
      pendingEdgeId: stepId("walk_ne", "walk_e"),
      turnStepsRemaining: 0
    });

    const landed = engine.tick({ contentOrdinal: 1n });
    expect(landed.snapshot).toMatchObject({
      phase: "stable",
      visualState: "walk_e",
      requestedState: "walk_e"
    });
    expect(settleEffects(landed)).toEqual([
      settle([second.requestId!], "resolve", "target-committed")
    ]);
  });

  it("reverses a sweep mid-chain and keeps moving on the new arc", () => {
    const engine = animatedEngine();
    const outbound = engine.request("walk_s");
    engine.tick({ contentOrdinal: 0n });
    engine.tick({ contentOrdinal: 1n });
    expect(engine.snapshot().visualState).toBe("walk_e");

    const inbound = engine.request("walk_n");
    expect(settleEffects(inbound)).toEqual([
      settle([outbound.requestId!], "reject", "AbortError")
    ]);
    expect(inbound.snapshot).toMatchObject({
      pendingEdgeId: stepId("walk_e", "walk_ne"),
      turnStepsRemaining: 1
    });

    expect(engine.tick({ contentOrdinal: 2n }).snapshot.visualState).toBe("walk_ne");
    const home = engine.tick({ contentOrdinal: 3n });
    expect(home.snapshot).toMatchObject({
      phase: "stable",
      visualState: "walk_n"
    });
    expect(settleEffects(home)).toEqual([
      settle([inbound.requestId!], "resolve", "target-committed")
    ]);
  });

  it("collapses the arc under a direct turn policy", () => {
    const engine = animatedEngine({ turnPolicy: "direct" });

    // AC9: reduced motion lands in the target with one reported landing.
    expect(engine.planFor("walk_s")).toEqual(["walk_s"]);
    const request = engine.request("walk_s");
    expect(request.snapshot).toMatchObject({
      phase: "waiting",
      requestedState: "walk_s",
      turnRing: "facing.walk",
      turnStepsRemaining: 0
    });

    const landed = engine.tick({ contentOrdinal: 0n });
    expect(landed.presentation).toEqual(bodyPresentation("walk_s", 0));
    expect(turnSteps(landed)).toEqual([
      {
        type: "turnstep",
        ring: "facing.walk",
        from: "walk_n",
        to: "walk_s",
        remaining: 0
      }
    ]);
    expect(settleEffects(landed)).toEqual([
      settle([request.requestId!], "resolve", "target-committed")
    ]);
    expect(landed.snapshot).toMatchObject({
      phase: "stable",
      visualState: "walk_s",
      turnRing: null
    });
  });

  it("prefers an explicit edge over the derived ring step", () => {
    const definition = facingGraph();
    const engine = new MotionGraphEngine();
    engine.install({
      ...definition,
      edges: [
        ...definition.edges,
        {
          ...portalEdge("shortcut.n.s", "walk_n", "walk_s"),
          transition: { kind: "locked", unitId: "spin-bridge", frameCount: 2 }
        }
      ]
    });
    engine.beginAnimated();

    expect(engine.planFor("walk_s")).toEqual(["walk_s"]);
    expect(engine.request("walk_s").snapshot).toMatchObject({
      pendingEdgeId: "shortcut.n.s",
      turnRing: null,
      turnStepsRemaining: 0
    });
  });

  it("rejects rings whose members, length, or steps are unusable", () => {
    expect(() => install({ rings: [ring({ states: ["walk_n", "sprint"] })] }))
      .toThrow(/ring "facing.walk" references unknown state "sprint"/u);
    expect(() => install({ rings: [ring({ states: ["walk_n", "walk_n", "walk_e"] })] }))
      .toThrow(/ring "facing.walk" duplicates state "walk_n"/u);
    expect(() => install({ rings: [ring({ states: ["walk_n"] })] }))
      .toThrow(/ring "facing.walk" must contain at least 2 states/u);
    expect(() =>
      install({ rings: [ring({ states: ["walk_n", "walk_ne"], cyclic: true })] })
    ).toThrow(/cyclic ring "facing.walk" must contain at least 3 states/u);
    expect(() =>
      install({
        rings: [
          ring({ id: "facing.a", states: ["walk_n", "walk_ne", "walk_e"] }),
          ring({ id: "facing.b", states: ["walk_n", "walk_ne", "walk_e"] })
        ]
      })
    ).toThrow(
      /rings "facing.a" and "facing.b" both step from "walk_n" to "walk_ne"/u
    );
    expect(() =>
      install({
        edges: [
          {
            ...portalEdge("turn.n.e", "walk_n", "walk_e"),
            ring: "facing.walk",
            step: 1
          }
        ]
      })
    ).toThrow(/edge "turn.n.e" is not step 1 from "walk_n"/u);
    expect(() =>
      install({
        edges: [
          {
            ...portalEdge("turn.n.e", "walk_n", "walk_e"),
            ring: "facing.turn",
            step: 1
          }
        ]
      })
    ).toThrow(/edge "turn.n.e" references unknown ring "facing.turn"/u);
    expect(() => {
      const definition = facingGraph();
      const [first, ...rest] = definition.edges;
      install({
        ...definition,
        rings: [
          ring({ id: "facing.other", states: ["walk_n", "walk_ne", "walk_e"] })
        ],
        edges: [{ ...first!, ring: "facing.walk", step: 1 }, ...rest]
      });
    }).toThrow(
      /declares ring "facing.walk" but steps inside ring "facing.other"/u
    );
  });
});

/**
 * Tick until the graph settles, asserting that every visible seam is frame 0 of
 * the next body. Returns the states it landed on, in order.
 */
function runToStable(
  engine: MotionGraphEngine,
  clock: { ordinal: bigint },
  from: string
): readonly string[] {
  const landings: string[] = [];
  let cursor = from;
  for (let guard = 0; guard < 256; guard += 1) {
    const result = engine.tick({ contentOrdinal: clock.ordinal });
    clock.ordinal += 1n;
    const presentation = result.presentation;
    expect(presentation?.kind).toBe("body");
    if (presentation?.kind !== "body") throw new Error("unreachable");
    if (presentation.state !== cursor) {
      expect(presentation.frameIndex).toBe(0);
      landings.push(presentation.state);
      cursor = presentation.state;
    }
    if (result.snapshot.phase === "stable") return landings;
  }
  throw new Error("graph never settled");
}

function install(
  overrides: Partial<MotionGraphDefinition>
): MotionGraphEngine {
  const engine = new MotionGraphEngine();
  engine.install({ ...facingGraph(), ...overrides });
  return engine;
}

function animatedEngine(
  options: {
    readonly maxChainedSteps?: number;
    readonly turnPolicy?: "chain" | "direct";
  } = {}
): MotionGraphEngine {
  const engine = new MotionGraphEngine(
    options.turnPolicy === undefined ? {} : { turnPolicy: options.turnPolicy }
  );
  engine.install(
    options.maxChainedSteps === undefined
      ? facingGraph()
      : {
          ...facingGraph(),
          rings: [facingRing({ maxChainedSteps: options.maxChainedSteps })]
        }
  );
  engine.beginAnimated();
  return engine;
}

/** An eight-way facing ring plus one off-ring state reachable by a cut. */
function facingGraph(): MotionGraphDefinition {
  const edges: GraphEdgeDefinition[] = [];
  for (let index = 0; index < FACINGS.length; index += 1) {
    const from = FACINGS[index]!;
    const to = FACINGS[(index + 1) % FACINGS.length]!;
    edges.push({ ...portalEdge(stepId(from, to), from, to), ring: "facing.walk", step: 1 });
    edges.push({ ...portalEdge(stepId(to, from), to, from), ring: "facing.walk", step: -1 });
  }
  edges.push(portalEdge("walk_n.sit", "walk_n", "sit"));
  return {
    initialState: "walk_n",
    states: [...FACINGS, "sit"].map(state),
    edges,
    rings: [facingRing()]
  };
}

function facingRing(
  overrides: Partial<GraphRingDefinition> = {}
): GraphRingDefinition {
  return ring(overrides);
}

function ring(overrides: Partial<GraphRingDefinition> = {}): GraphRingDefinition {
  return {
    id: "facing.walk",
    states: FACINGS,
    cyclic: true,
    tieBreak: "forward",
    maxChainedSteps: 4,
    ...overrides
  };
}

function stepId(from: string, to: string): string {
  return `facing.walk.${from}.${to}`;
}

function state(id: string): GraphStateDefinition {
  return {
    id,
    body: {
      unitId: `${id}.body`,
      kind: "loop",
      frameCount: 4,
      ports: [{ id: "default", entryFrame: 0, portalFrames: [0, 2] }]
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
      sourcePort: "default",
      targetPort: "default",
      maxWaitFrames: 1
    },
    continuity: "exact-authored"
  };
}

function bodyPresentation(state_: string, frameIndex: number): object {
  return {
    kind: "body",
    state: state_,
    unitId: `${state_}.body`,
    frameIndex
  };
}

function effectTypes(result: Readonly<MotionGraphResult>): readonly string[] {
  return result.effects.map(({ type }) => type);
}

function turnSteps(
  result: Readonly<MotionGraphResult>
): readonly Readonly<MotionGraphEffect>[] {
  return result.effects.filter((effect) => effect.type === "turnstep");
}

function settleEffects(
  result: Readonly<MotionGraphResult>
): readonly Readonly<MotionGraphEffect>[] {
  return result.effects.filter((effect) => effect.type === "settle");
}

function settle(
  requestIds: readonly number[],
  type: "resolve" | "reject",
  detail: string
): object {
  return {
    type: "settle",
    requestIds,
    outcome: type === "resolve"
      ? { type: "resolve", timing: "microtask", reason: detail }
      : { type: "reject", timing: "microtask", error: detail }
  };
}
