import {
  MotionGraphEngine,
  type GraphEdgeDefinition,
  type GraphStateDefinition,
  type MotionGraphDefinition,
  type MotionGraphResult
} from "@pixel-point/aval-graph";
import { describe, expect, it } from "vitest";

import type {
  CompiledManifest as Manifest,
  Edge,
  Unit
} from "@pixel-point/aval-format";
import { createGraphEngine } from "../src/graph.js";

type GraphManifest = Pick<
  Manifest,
  "initialState" | "states" | "edges" | "units"
>;

describe("graph adapter", () => {
  it("matches canonical pending replacement, joining, cancellation, and intro effects", () => {
    const definition: MotionGraphDefinition = {
      initialState: "idle",
      states: [
        {
          ...state("idle"),
          initialUnit: { unitId: "idle-intro", frameCount: 2 }
        },
        state("hover"),
        state("loading")
      ],
      edges: [
        portalEdge("idle-hover", "idle", "hover"),
        portalEdge("idle-loading", "idle", "loading")
      ]
    };
    const [actual, canonical] = engines(definition);
    same(actual, canonical, (engine) => engine.beginAnimated());
    same(actual, canonical, (engine) => engine.request("hover"));
    same(actual, canonical, (engine) => engine.request("hover"));
    same(actual, canonical, (engine) => engine.request("loading"));
    same(actual, canonical, (engine) => engine.request("idle"));
    same(actual, canonical, (engine) => engine.tick({ contentOrdinal: 0n }));
    same(actual, canonical, (engine) => engine.tick({ contentOrdinal: 1n }));
    same(actual, canonical, (engine) => engine.request("missing"));
  });

  it("matches adjacent reversible inversion and latest-wins follow-on routing", () => {
    const definition = reversibleGraph(true);
    const [actual, canonical] = animatedEngines(definition);
    same(actual, canonical, (engine) => engine.request("hover"));
    same(actual, canonical, (engine) => engine.tick({ contentOrdinal: 0n }));
    same(actual, canonical, (engine) => engine.tick({ contentOrdinal: 1n }));
    same(actual, canonical, (engine) => engine.request("idle"));
    same(actual, canonical, (engine) => engine.request("error"));
    same(actual, canonical, (engine) => engine.tick({ contentOrdinal: 2n }));
    same(actual, canonical, (engine) => engine.tick({ contentOrdinal: 3n }));
    same(actual, canonical, (engine) => engine.tick({ contentOrdinal: 4n }));
  });

  it("matches locked continuation, cut readiness bypass, and completion edges", () => {
    const locked: MotionGraphDefinition = {
      initialState: "idle",
      states: [state("idle"), state("loading"), state("success")],
      edges: [
        {
          ...portalEdge("idle-loading", "idle", "loading", [0, 2]),
          transition: {
            kind: "locked",
            unitId: "loading-bridge",
            frameCount: 3
          }
        },
        cutEdge("loading-success", "loading", "success")
      ]
    };
    const [actual, canonical] = animatedEngines(locked);
    same(actual, canonical, (engine) => engine.request("loading"));
    same(actual, canonical, (engine) => engine.tick({ contentOrdinal: 0n }));
    same(actual, canonical, (engine) => engine.request("idle"));
    same(actual, canonical, (engine) => engine.request("success"));
    same(actual, canonical, (engine) => engine.tick({ contentOrdinal: 1n }));
    same(actual, canonical, (engine) => engine.tick({ contentOrdinal: 2n }));
    same(actual, canonical, (engine) => engine.tick({ contentOrdinal: 3n }));
    same(actual, canonical, (engine) =>
      engine.tick({ contentOrdinal: 4n, routeReady: false }));

    const completion: MotionGraphDefinition = {
      initialState: "idle",
      states: [state("idle", "finite", 2, [1]), state("done")],
      edges: [{
        ...cutEdge("idle-done", "idle", "done"),
        trigger: { type: "completion" }
      }]
    };
    const [actualCompletion, canonicalCompletion] = animatedEngines(completion);
    same(actualCompletion, canonicalCompletion, (engine) =>
      engine.tick({ contentOrdinal: 0n }));
    same(actualCompletion, canonicalCompletion, (engine) =>
      engine.tick({ contentOrdinal: 1n, routeReady: false }));
  });
});

function engines(
  definition: MotionGraphDefinition
): readonly [MotionGraphEngine, MotionGraphEngine] {
  const actual = createGraphEngine(testManifest(definition));
  const canonical = new MotionGraphEngine();
  canonical.install(definition);
  expect(actual.snapshot()).toEqual(canonical.snapshot());
  return [actual, canonical];
}

function animatedEngines(
  definition: MotionGraphDefinition
): readonly [MotionGraphEngine, MotionGraphEngine] {
  const pair = engines(definition);
  same(pair[0], pair[1], (engine) => engine.beginAnimated());
  return pair;
}

function same(
  actual: MotionGraphEngine,
  canonical: MotionGraphEngine,
  operation: (engine: MotionGraphEngine) => Readonly<MotionGraphResult>
): void {
  expect(operation(actual)).toEqual(operation(canonical));
  expect(actual.snapshot()).toEqual(canonical.snapshot());
}

function testManifest(definition: MotionGraphDefinition): GraphManifest {
  const units: Unit[] = definition.states.flatMap((value) => {
    const body: Unit = {
      id: value.body.unitId,
      kind: "body",
      playback: value.body.kind === "loop" ? "loop" : "finite",
      frameCount: value.body.frameCount,
      ports: value.body.ports,
      chunks: []
    };
    return value.initialUnit === undefined
      ? [body]
      : [
          body,
          {
            id: value.initialUnit.unitId,
            kind: "one-shot" as const,
            frameCount: value.initialUnit.frameCount,
            chunks: []
          }
        ];
  });
  const transitionUnits = new Set<string>();
  for (const edge of definition.edges) {
    const transition = edge.transition;
    if (transition === undefined || transitionUnits.has(transition.unitId)) continue;
    transitionUnits.add(transition.unitId);
    if (transition.kind === "locked") {
      units.push({
        id: transition.unitId,
        kind: "bridge",
        frameCount: transition.frameCount,
        chunks: []
      });
    } else {
      const pair = definition.edges.filter((candidate) =>
        candidate.transition?.unitId === transition.unitId);
      const first = pair[0]!;
      units.push({
        id: transition.unitId,
        kind: "reversible",
        frameCount: transition.frameCount,
        chunks: [],
        residency: {
          endpoints: [
            { state: first.from, port: "handoff", frames: 1 },
            { state: first.to, port: "handoff", frames: 1 }
          ]
        }
      });
    }
  }
  return {
    initialState: definition.initialState,
    states: definition.states.map((value) => ({
      id: value.id,
      bodyUnit: value.body.unitId,
      ...(value.initialUnit === undefined
        ? {}
        : { initialUnit: value.initialUnit.unitId })
    })),
    edges: definition.edges.map(testEdge),
    units
  };
}

function testEdge(edge: GraphEdgeDefinition): Edge {
  const trigger = edge.trigger === undefined ? {} : { trigger: edge.trigger };
  if (edge.start.type === "cut") {
    return {
      id: edge.id,
      from: edge.from,
      to: edge.to,
      ...trigger,
      start: edge.start,
      continuity: "cut",
      targetRunwayFrames: 6
    };
  }
  const transition = edge.transition === undefined
    ? {}
    : edge.transition.kind === "locked"
      ? { transition: { kind: "locked" as const, unit: edge.transition.unitId } }
      : {
          transition: {
            kind: "reversible" as const,
            unit: edge.transition.unitId,
            direction: edge.transition.direction,
            ...(edge.transition.reverseOf === undefined
              ? {}
              : { reverseOf: edge.transition.reverseOf })
          }
        };
  return {
    id: edge.id,
    from: edge.from,
    to: edge.to,
    ...trigger,
    start: edge.start,
    ...transition,
    continuity: edge.continuity as "exact-authored" | "exact-reverse"
  };
}

function reversibleGraph(includeFollowOn: boolean): MotionGraphDefinition {
  return {
    initialState: "idle",
    states: [state("idle"), state("hover"), state("error")],
    edges: [
      reversibleEdge("idle-hover", "idle", "hover", "forward", "enter"),
      reversibleEdge("hover-idle", "hover", "idle", "reverse", "leave", "idle-hover"),
      ...(includeFollowOn ? [cutEdge("idle-error", "idle", "error")] : [])
    ]
  };
}

function state(
  id: string,
  kind: "loop" | "finite" = "loop",
  frameCount = 4,
  portals: readonly number[] = [0, 2]
): GraphStateDefinition {
  return {
    id,
    body: {
      unitId: `${id}-body`,
      kind,
      frameCount,
      ports: [{ id: "handoff", entryFrame: 0, portalFrames: portals }]
    }
  };
}

function portalEdge(
  id: string,
  from: string,
  to: string,
  portals: readonly number[] = [2]
): GraphEdgeDefinition {
  return {
    id,
    from,
    to,
    start: {
      type: "portal",
      sourcePort: "handoff",
      targetPort: "handoff",
      maxWaitFrames: portals.length === 1 ? 3 : 1
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
    ...portalEdge(id, from, to, [0, 2]),
    trigger: { type: "event", name: event },
    transition: {
      kind: "reversible",
      unitId: "hover-clip",
      frameCount: 3,
      direction,
      ...(reverseOf === undefined ? {} : { reverseOf })
    },
    continuity: reverseOf === undefined ? "exact-authored" : "exact-reverse"
  };
}

function cutEdge(id: string, from: string, to: string): GraphEdgeDefinition {
  return {
    id,
    from,
    to,
    start: { type: "cut", targetPort: "handoff", maxWaitFrames: 1 },
    continuity: "cut"
  };
}
