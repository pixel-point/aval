import type {
  GraphEdgeDefinition,
  GraphEdgeId,
  GraphRingId,
  GraphStateId,
  MotionGraphPhase
} from "./model.js";
import { resolveRingRoute } from "./ring-plan.js";
import type { RoutePlanView } from "./route-plan.js";
import type { ValidatedGraphIndexes } from "./validate.js";

type RoutablePhase = Exclude<
  MotionGraphPhase,
  "unready" | "disposed" | "error"
>;

export interface IntentContext {
  readonly phase: RoutablePhase;
  readonly visualState: GraphStateId;
  readonly routes: RoutePlanView;
  readonly indexes: ValidatedGraphIndexes;
  readonly hasPendingRequests: boolean;
  /** Whether a chained turn is in flight, which makes pending routes provisional. */
  readonly turnInFlight: boolean;
}

/**
 * The steps a chained turn still owes after the routed edge.
 *
 * A plan carries the whole remainder so the engine never has to re-derive an arc
 * it already chose; every step boundary can still replan from what actually
 * landed.
 */
export interface TurnChainPlan {
  readonly ring: GraphRingId;
  /** Edge the remainder continues from; it identifies the chain's own landing. */
  readonly after: GraphEdgeId;
  readonly remaining: readonly Readonly<GraphEdgeDefinition>[];
}

export type StateIntentPlan =
  | { readonly kind: "reject" }
  | { readonly kind: "standalone-noop" }
  | { readonly kind: "cancel-before-stable" }
  | { readonly kind: "join-pending" }
  | { readonly kind: "cancel-pending" }
  | {
      readonly kind: "replace-pending";
      readonly edge: Readonly<GraphEdgeDefinition>;
      readonly turn?: Readonly<TurnChainPlan>;
    }
  | { readonly kind: "continue-active-target" }
  | { readonly kind: "continue-reversal-target" }
  | {
      readonly kind: "queue-reversal";
      readonly edge: Readonly<GraphEdgeDefinition>;
    }
  | {
      readonly kind: "queue-follow-on";
      readonly edge: Readonly<GraphEdgeDefinition>;
      readonly turn?: Readonly<TurnChainPlan>;
    }
  | {
      readonly kind: "static-commit";
      readonly edge: Readonly<GraphEdgeDefinition>;
    };

export type EventIntentPlan =
  | { readonly kind: "reject" }
  | { readonly kind: "accept-noop" }
  | {
      readonly kind: "cancel-pending";
      readonly edge: Readonly<GraphEdgeDefinition>;
    }
  | {
      readonly kind: "replace-pending";
      readonly edge: Readonly<GraphEdgeDefinition>;
    }
  | {
      readonly kind: "continue-active-target";
      readonly edge: Readonly<GraphEdgeDefinition>;
    }
  | {
      readonly kind: "queue-reversal";
      readonly edge: Readonly<GraphEdgeDefinition>;
    }
  | {
      readonly kind: "queue-follow-on";
      readonly edge: Readonly<GraphEdgeDefinition>;
    }
  | {
      readonly kind: "static-commit";
      readonly edge: Readonly<GraphEdgeDefinition>;
    };

/** Decide state intent without mutating routes, effects, or request groups. */
export function planStateIntent(
  context: Readonly<IntentContext>,
  target: GraphStateId
): Readonly<StateIntentPlan> {
  const { phase, visualState } = context;

  if (phase === "preparing" || phase === "intro") {
    if (target === visualState) {
      return freezePlan(
        context.routes.pending !== null || context.hasPendingRequests
          ? { kind: "cancel-before-stable" }
          : { kind: "standalone-noop" }
      );
    }
    return pendingOrReject(context, visualState, target);
  }

  if (phase === "stable") {
    if (target === visualState) return freezePlan({ kind: "standalone-noop" });
    return pendingOrReject(context, visualState, target);
  }

  if (phase === "waiting") {
    const pending = requireSlot(context.routes.pending, "waiting pending edge");
    // A pending step of a chained turn is an intermediate landing, never the
    // caller's intent, so it cannot absorb a new request by joining it.
    if (target === pending.edge.to && !context.turnInFlight) {
      return freezePlan({ kind: "join-pending" });
    }
    if (target === visualState) return freezePlan({ kind: "cancel-pending" });
    return pendingOrReject(context, visualState, target);
  }

  if (phase === "static") {
    if (target === visualState) return freezePlan({ kind: "standalone-noop" });
    const edge = directEdge(context.indexes, visualState, target);
    return edge === null
      ? freezePlan({ kind: "reject" })
      : freezePlan({ kind: "static-commit", edge });
  }

  const active = requireSlot(context.routes.active, "active transition edge");
  const effective = context.routes.reversal ?? active;
  if (target === active.edge.to) {
    return freezePlan({ kind: "continue-active-target" });
  }
  if (target === effective.edge.to) {
    return freezePlan({ kind: "continue-reversal-target" });
  }
  if (phase === "reversible") {
    const inverse = inverseEdge(context.indexes, active.edge);
    if (inverse !== null && target === inverse.to) {
      return freezePlan({ kind: "queue-reversal", edge: inverse });
    }
  }
  const followOn = directEdge(context.indexes, effective.edge.to, target);
  if (followOn !== null) {
    return freezePlan({ kind: "queue-follow-on", edge: followOn });
  }
  // Replanning happens from the landing state, so an in-flight step always
  // completes before the newly chosen arc begins.
  const turn = turnPlan(context, effective.edge.to, target);
  return turn === null
    ? freezePlan({ kind: "reject" })
    : freezePlan({ kind: "queue-follow-on", edge: turn.edge, turn: turn.turn });
}

/** Resolve and decide an event without mutating semantic state. */
export function planEventIntent(
  context: Readonly<IntentContext>,
  event: string
): Readonly<EventIntentPlan> {
  const edge = resolveEventEdge(context, event);
  if (edge === null) return freezePlan({ kind: "reject" });

  if (context.phase === "static") {
    return freezePlan({ kind: "static-commit", edge });
  }
  if (
    (context.phase === "preparing" ||
      context.phase === "intro" ||
      context.phase === "waiting") &&
    context.routes.pending !== null &&
    edge.to === context.visualState
  ) {
    return freezePlan({ kind: "cancel-pending", edge });
  }
  if (context.phase === "waiting") {
    const pending = requireSlot(context.routes.pending, "waiting pending edge");
    if (edge.id === pending.edge.id) return freezePlan({ kind: "accept-noop" });
  }

  if (context.phase === "locked" || context.phase === "reversible") {
    const active = requireSlot(context.routes.active, "active transition edge");
    const effective = context.routes.reversal ?? active;
    if (edge.id === effective.edge.id && context.routes.followOn === null) {
      return freezePlan({ kind: "accept-noop" });
    }
    if (edge.id === active.edge.id) {
      return freezePlan({ kind: "continue-active-target", edge });
    }
    const inverse = context.phase === "reversible"
      ? inverseEdge(context.indexes, active.edge)
      : null;
    if (inverse?.id === edge.id) {
      return freezePlan({ kind: "queue-reversal", edge });
    }
    if (edge.id === context.routes.followOn?.edge.id) {
      return freezePlan({ kind: "accept-noop" });
    }
    return freezePlan({ kind: "queue-follow-on", edge });
  }

  if (
    (context.phase === "preparing" || context.phase === "intro") &&
    edge.id === context.routes.pending?.edge.id
  ) {
    return freezePlan({ kind: "accept-noop" });
  }
  return freezePlan({ kind: "replace-pending", edge });
}

function resolveEventEdge(
  context: Readonly<IntentContext>,
  event: string
): Readonly<GraphEdgeDefinition> | null {
  if (
    context.phase === "preparing" ||
    context.phase === "intro" ||
    context.phase === "waiting"
  ) {
    const pending = context.routes.pending;
    if (pending === null) {
      if (context.phase === "waiting") {
        throw new Error("graph invariant missing waiting pending edge");
      }
      return eventEdge(context.indexes, context.visualState, event);
    }
    const inverse = inverseEdge(context.indexes, pending.edge);
    if (hasEventTrigger(inverse, event)) return inverse;
    return eventEdge(context.indexes, context.visualState, event);
  }

  if (context.phase === "locked" || context.phase === "reversible") {
    const active = requireSlot(context.routes.active, "active transition edge");
    const inverse = context.phase === "reversible"
      ? inverseEdge(context.indexes, active.edge)
      : null;
    if (hasEventTrigger(inverse, event)) return inverse;
    if (hasEventTrigger(active.edge, event)) return active.edge;
    const effective = context.routes.reversal ?? active;
    return eventEdge(context.indexes, effective.edge.to, event);
  }

  return eventEdge(context.indexes, context.visualState, event);
}

function pendingOrReject(
  context: Readonly<IntentContext>,
  from: GraphStateId,
  target: GraphStateId
): Readonly<StateIntentPlan> {
  const edge = directEdge(context.indexes, from, target);
  if (edge !== null) return freezePlan({ kind: "replace-pending", edge });
  const turn = turnPlan(context, from, target);
  return turn === null
    ? freezePlan({ kind: "reject" })
    : freezePlan({ kind: "replace-pending", edge: turn.edge, turn: turn.turn });
}

/**
 * Resolve a multi-step ring arc into its first step plus the queued remainder.
 *
 * An arc longer than the ring's `maxChainedSteps` resolves to no plan, which the
 * caller reports as a route failure rather than silently walking further than
 * the ring allows.
 */
function turnPlan(
  context: Readonly<IntentContext>,
  from: GraphStateId,
  target: GraphStateId
): Readonly<{
  edge: Readonly<GraphEdgeDefinition>;
  turn: Readonly<TurnChainPlan>;
}> | null {
  const route = resolveRingRoute(context.indexes, from, target);
  if (route.kind !== "arc") return null;
  const first = route.steps[0];
  if (first === undefined) return null;
  return Object.freeze({
    edge: first,
    turn: Object.freeze({
      ring: route.ring.id,
      after: first.id,
      remaining: Object.freeze(route.steps.slice(1))
    })
  });
}

function directEdge(
  indexes: ValidatedGraphIndexes,
  from: GraphStateId,
  to: GraphStateId
): Readonly<GraphEdgeDefinition> | null {
  return indexes.directEdgesByState.get(from)?.get(to) ?? null;
}

function eventEdge(
  indexes: ValidatedGraphIndexes,
  from: GraphStateId,
  event: string
): Readonly<GraphEdgeDefinition> | null {
  return indexes.eventEdgesByState.get(from)?.get(event) ?? null;
}

function inverseEdge(
  indexes: ValidatedGraphIndexes,
  edge: Readonly<GraphEdgeDefinition>
): Readonly<GraphEdgeDefinition> | null {
  return indexes.inverseEdgesById.get(edge.id) ?? null;
}

function hasEventTrigger(
  edge: Readonly<GraphEdgeDefinition> | null,
  event: string
): edge is Readonly<GraphEdgeDefinition> {
  return edge?.trigger?.type === "event" && edge.trigger.name === event;
}

function requireSlot<T>(value: T | null, label: string): T {
  if (value === null) throw new Error(`graph invariant missing ${label}`);
  return value;
}

function freezePlan<T extends StateIntentPlan | EventIntentPlan>(plan: T): Readonly<T> {
  return Object.freeze(plan);
}
