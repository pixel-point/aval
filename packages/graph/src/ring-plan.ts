import type {
  GraphEdgeDefinition,
  GraphRingDefinition,
  GraphStateId
} from "./model.js";
import type { ValidatedGraphIndexes } from "./validate.js";

/** One resolved arc along a ring, excluding the state it departs from. */
export interface RingArc {
  readonly direction: "forward" | "backward";
  /** Ordered landings; the last entry is the requested target. */
  readonly states: readonly GraphStateId[];
}

/**
 * A ring route resolved against authored edges.
 *
 * `none` means the pair shares no ring, or a step between two ring neighbours
 * has no authored edge. `too-long` separates a reachable-but-refused arc from an
 * unreachable one so callers can report the ring which refused it.
 */
export type RingRoute =
  | { readonly kind: "none" }
  | {
      readonly kind: "too-long";
      readonly ring: Readonly<GraphRingDefinition>;
      readonly distance: number;
    }
  | {
      readonly kind: "arc";
      readonly ring: Readonly<GraphRingDefinition>;
      readonly direction: "forward" | "backward";
      readonly states: readonly GraphStateId[];
      readonly steps: readonly Readonly<GraphEdgeDefinition>[];
    };

/**
 * Choose the shorter arc between two members of one ring.
 *
 * Distances are measured in steps, wrapping only on cyclic rings. Equal-length
 * arcs resolve through the ring's `tieBreak`, which keeps a half-turn on an
 * even cyclic ring deterministic. The `maxChainedSteps` ceiling is not applied
 * here: callers decide whether a long arc is refused or merely reported.
 */
export function planRingArc(
  ring: Readonly<GraphRingDefinition>,
  from: GraphStateId,
  to: GraphStateId
): Readonly<RingArc> | null {
  const length = ring.states.length;
  const fromIndex = ring.states.indexOf(from);
  const toIndex = ring.states.indexOf(to);
  if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return null;

  const forward = ring.cyclic
    ? (toIndex - fromIndex + length) % length
    : toIndex > fromIndex
      ? toIndex - fromIndex
      : Number.POSITIVE_INFINITY;
  const backward = ring.cyclic
    ? (fromIndex - toIndex + length) % length
    : fromIndex > toIndex
      ? fromIndex - toIndex
      : Number.POSITIVE_INFINITY;
  if (!Number.isFinite(forward) && !Number.isFinite(backward)) return null;

  const direction = forward < backward
    ? "forward"
    : backward < forward
      ? "backward"
      : ring.tieBreak;
  const distance = direction === "forward" ? forward : backward;
  const offset = direction === "forward" ? 1 : -1;
  const states: GraphStateId[] = [];
  for (let step = 1; step <= distance; step += 1) {
    const index = (((fromIndex + step * offset) % length) + length) % length;
    states.push(ring.states[index]!);
  }
  return Object.freeze({ direction, states: Object.freeze(states) });
}

/**
 * Resolve the authored step edges which walk `from` to `to` along one ring.
 *
 * Rings are consulted in validated (ascending id) order and the first ring that
 * can serve the whole arc wins, so a state which belongs to two rings routes
 * deterministically.
 */
export function resolveRingRoute(
  indexes: ValidatedGraphIndexes,
  from: GraphStateId,
  to: GraphStateId
): Readonly<RingRoute> {
  let refused: Readonly<RingRoute> | null = null;
  for (const ring of indexes.ringsByState.get(from) ?? []) {
    const arc = planRingArc(ring, from, to);
    if (arc === null) continue;
    if (arc.states.length > ring.maxChainedSteps) {
      refused ??= Object.freeze({
        kind: "too-long" as const,
        ring,
        distance: arc.states.length
      });
      continue;
    }
    const steps = collectSteps(indexes, from, arc.states);
    if (steps === null) continue;
    return Object.freeze({
      kind: "arc" as const,
      ring,
      direction: arc.direction,
      states: arc.states,
      steps
    });
  }
  return refused ?? Object.freeze({ kind: "none" as const });
}

function collectSteps(
  indexes: ValidatedGraphIndexes,
  from: GraphStateId,
  states: readonly GraphStateId[]
): readonly Readonly<GraphEdgeDefinition>[] | null {
  const steps: Readonly<GraphEdgeDefinition>[] = [];
  let cursor = from;
  for (const state of states) {
    const edge = indexes.directEdgesByState.get(cursor)?.get(state);
    if (edge === undefined) return null;
    steps.push(edge);
    cursor = state;
  }
  return Object.freeze(steps);
}
