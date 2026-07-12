import {
  MotionGraphValidationError,
  validateMotionGraphDefinition,
  type GraphEdgeDefinition,
  type GraphStateDefinition,
  type GraphTransitionDefinition,
  type MotionGraphDefinition
} from "@rendered-motion/graph";

import { CompilerError } from "./diagnostics.js";
import type {
  SourceProjectV01,
  SourceStateV01,
  SourceUnitV01
} from "./model.js";

/**
 * Lower the authoring graph before any media process is spawned. The compiled
 * asset is independently checked by the format adapter after encoding; this
 * early pass keeps invalid routes from doing expensive or observable work.
 */
export function preflightSourceGraph(project: SourceProjectV01): void {
  const units = new Map(project.units.map((unit) => [unit.id, unit]));
  let definition: MotionGraphDefinition;
  try {
    definition = {
      initialState: project.initialState,
      states: project.states.map((state, index) =>
        lowerState(state, units, index)
      ),
      edges: project.edges.map((edge) => {
        const transition = edge.transition === undefined
          ? undefined
          : lowerTransition(edge.transition, units);
        const base = {
          id: edge.id,
          from: edge.from,
          to: edge.to,
          start: edge.start,
          continuity: edge.continuity,
          ...(edge.trigger === undefined ? {} : { trigger: edge.trigger })
        };
        return Object.freeze(
          transition === undefined ? base : { ...base, transition }
        ) as GraphEdgeDefinition;
      })
    };
    validateMotionGraphDefinition(definition);
  } catch (error) {
    if (error instanceof CompilerError) throw error;
    if (error instanceof MotionGraphValidationError) {
      throw new CompilerError(
        "INPUT_INVALID",
        `Project graph is invalid: ${error.message}`,
        { cause: error }
      );
    }
    throw error;
  }
}

function lowerState(
  state: SourceStateV01,
  units: ReadonlyMap<string, SourceUnitV01>,
  stateIndex: number
): GraphStateDefinition {
  const body = requireUnit(units, state.bodyUnit, "body");
  const base = {
    id: state.id,
    staticFrameId: `static.${String(stateIndex).padStart(2, "0")}`,
    body: Object.freeze({
      unitId: body.id,
      kind: body.playback,
      frameCount: frameCount(body),
      ports: body.ports
    })
  };
  if (state.initialUnit === undefined) return Object.freeze(base);
  const initial = requireUnit(units, state.initialUnit, "one-shot");
  return Object.freeze({
    ...base,
    initialUnit: Object.freeze({
      unitId: initial.id,
      frameCount: frameCount(initial)
    })
  });
}

function lowerTransition(
  transition: SourceProjectV01["edges"][number]["transition"] & {},
  units: ReadonlyMap<string, SourceUnitV01>
): GraphTransitionDefinition {
  if (transition.kind === "locked") {
    const unit = requireUnit(units, transition.unit, "bridge");
    return Object.freeze({
      kind: "locked",
      unitId: unit.id,
      frameCount: frameCount(unit)
    });
  }
  const unit = requireUnit(units, transition.unit, "reversible");
  const base = {
    kind: "reversible" as const,
    unitId: unit.id,
    frameCount: frameCount(unit),
    direction: transition.direction
  };
  return transition.reverseOf === undefined
    ? Object.freeze(base)
    : Object.freeze({ ...base, reverseOf: transition.reverseOf });
}

function requireUnit<K extends SourceUnitV01["kind"]>(
  units: ReadonlyMap<string, SourceUnitV01>,
  id: string,
  kind: K
): Extract<SourceUnitV01, { readonly kind: K }> {
  const unit = units.get(id);
  if (unit?.kind !== kind) {
    throw new CompilerError(
      "INPUT_INVALID",
      `Unit ${JSON.stringify(id)} must be a ${kind} unit`
    );
  }
  return unit as Extract<SourceUnitV01, { readonly kind: K }>;
}

function frameCount(unit: SourceUnitV01): number {
  return unit.range[1] - unit.range[0];
}
