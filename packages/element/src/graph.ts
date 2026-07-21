import {
  MotionGraphEngine,
  type GraphEdgeDefinition,
  type GraphStateDefinition,
  type GraphTransitionDefinition,
  type MotionGraphDefinition
} from "@pixel-point/aval-graph";

import type {
  CompiledManifest as Manifest,
  Edge,
  Unit
} from "@pixel-point/aval-format";

type GraphManifest = Pick<
  Manifest,
  "initialState" | "states" | "edges" | "units"
>;

/**
 * Install the canonical graph reducer over an already validated AVAL
 * manifest. Keeping routing in the canonical reducer preserves request
 * joining, supersession, and transition semantics.
 */
export function createGraphEngine(
  manifest: Readonly<GraphManifest>,
  initialState = manifest.initialState,
  initialBody = false
): MotionGraphEngine {
  const engine = new MotionGraphEngine();
  engine.install(toGraphDefinition(manifest, initialState, initialBody));
  return engine;
}

function toGraphDefinition(
  manifest: Readonly<GraphManifest>,
  initialState: string,
  initialBody: boolean
): MotionGraphDefinition {
  const units = new Map(manifest.units.map((unit) => [unit.id, unit]));
  if (!manifest.states.some((state) => state.id === initialState)) {
    throw new RangeError("Unknown initial AVAL state");
  }
  const states = manifest.states.map((state): GraphStateDefinition => {
    const body = bodyUnit(units, state.bodyUnit);
    const base: GraphStateDefinition = {
      id: state.id,
      body: {
        unitId: body.id,
        kind: body.playback,
        frameCount: body.frameCount,
        ports: body.ports
      }
    };
    if (initialBody || state.id !== initialState || state.initialUnit === undefined) return base;
    const intro = unit(units, state.initialUnit);
    return {
      ...base,
      initialUnit: { unitId: intro.id, frameCount: intro.frameCount }
    };
  });
  return {
    initialState,
    states,
    edges: manifest.edges.map((edge) => graphEdge(edge, units))
  };
}

function graphEdge(
  edge: Readonly<Edge>,
  units: ReadonlyMap<string, Unit>
): GraphEdgeDefinition {
  const common = {
    id: edge.id,
    from: edge.from,
    to: edge.to,
    ...(edge.trigger === undefined ? {} : { trigger: edge.trigger }),
    start: edge.start,
    continuity: edge.continuity
  };
  return edge.transition === undefined
    ? common
    : { ...common, transition: graphTransition(edge.transition, units) };
}

function graphTransition(
  transition: NonNullable<Edge["transition"]>,
  units: ReadonlyMap<string, Unit>
): GraphTransitionDefinition {
  const media = unit(units, transition.unit);
  if (transition.kind === "locked") {
    return { kind: "locked", unitId: media.id, frameCount: media.frameCount };
  }
  return {
    kind: "reversible",
    unitId: media.id,
    frameCount: media.frameCount,
    direction: transition.direction,
    ...(transition.reverseOf === undefined
      ? {}
      : { reverseOf: transition.reverseOf })
  };
}

function bodyUnit(
  units: ReadonlyMap<string, Unit>,
  id: string
): Extract<Unit, { readonly kind: "body" }> {
  const value = unit(units, id);
  if (value.kind !== "body") throw new Error("Invalid AVAL asset");
  return value;
}

function unit(
  units: ReadonlyMap<string, Unit>,
  id: string
): Unit {
  const value = units.get(id);
  if (value === undefined) throw new Error("Invalid AVAL asset");
  return value;
}
