/// Pure intent resolution, ported from
/// `packages/graph/src/intent-router.ts`.
///
/// Every function here only reads [IntentContext]; none of them mutate
/// routes, effects, or request groups. The engine applies the returned plan.
library;

import 'model.dart';
import 'ring_plan.dart';
import 'route_plan.dart';
import 'validate.dart';

/// Read-only view the router needs to resolve one request or event.
///
/// [phase] must never be `unready`, `disposed`, or `error` — the engine only
/// constructs an [IntentContext] after checking that itself, matching the
/// TypeScript `RoutablePhase` exclusion type.
class IntentContext {
  const IntentContext({
    required this.phase,
    required this.visualState,
    required this.routes,
    required this.indexes,
    required this.hasPendingRequests,
    this.turnInFlight = false,
  });

  final MotionGraphPhase phase;
  final GraphStateId visualState;
  final RoutePlanView routes;
  final ValidatedGraphIndexes indexes;
  final bool hasPendingRequests;

  /// Whether a chained turn is in flight (makes pending routes provisional).
  final bool turnInFlight;
}

/// The steps a chained turn still owes after the routed edge.
class TurnChainPlan {
  const TurnChainPlan({
    required this.ring,
    required this.after,
    required this.remaining,
  });

  final GraphRingId ring;

  /// Edge the remainder continues from.
  final GraphEdgeId after;
  final List<GraphEdgeDefinition> remaining;
}

sealed class StateIntentPlan {
  const StateIntentPlan();
}

class StateIntentPlanReject extends StateIntentPlan {
  const StateIntentPlanReject();

  @override
  bool operator ==(Object other) => other is StateIntentPlanReject;

  @override
  int get hashCode => (StateIntentPlanReject).hashCode;

  @override
  String toString() => 'StateIntentPlan.reject()';
}

class StateIntentPlanStandaloneNoop extends StateIntentPlan {
  const StateIntentPlanStandaloneNoop();

  @override
  bool operator ==(Object other) => other is StateIntentPlanStandaloneNoop;

  @override
  int get hashCode => (StateIntentPlanStandaloneNoop).hashCode;

  @override
  String toString() => 'StateIntentPlan.standaloneNoop()';
}

class StateIntentPlanCancelBeforeStable extends StateIntentPlan {
  const StateIntentPlanCancelBeforeStable();

  @override
  bool operator ==(Object other) => other is StateIntentPlanCancelBeforeStable;

  @override
  int get hashCode => (StateIntentPlanCancelBeforeStable).hashCode;

  @override
  String toString() => 'StateIntentPlan.cancelBeforeStable()';
}

class StateIntentPlanJoinPending extends StateIntentPlan {
  const StateIntentPlanJoinPending();

  @override
  bool operator ==(Object other) => other is StateIntentPlanJoinPending;

  @override
  int get hashCode => (StateIntentPlanJoinPending).hashCode;

  @override
  String toString() => 'StateIntentPlan.joinPending()';
}

class StateIntentPlanCancelPending extends StateIntentPlan {
  const StateIntentPlanCancelPending();

  @override
  bool operator ==(Object other) => other is StateIntentPlanCancelPending;

  @override
  int get hashCode => (StateIntentPlanCancelPending).hashCode;

  @override
  String toString() => 'StateIntentPlan.cancelPending()';
}

class StateIntentPlanReplacePending extends StateIntentPlan {
  const StateIntentPlanReplacePending(this.edge, {this.turn});

  final GraphEdgeDefinition edge;
  final TurnChainPlan? turn;

  @override
  bool operator ==(Object other) =>
      other is StateIntentPlanReplacePending &&
      other.edge == edge &&
      other.turn == turn;

  @override
  int get hashCode => Object.hash(StateIntentPlanReplacePending, edge, turn);

  @override
  String toString() => 'StateIntentPlan.replacePending(edge: ${edge.id})';
}

class StateIntentPlanContinueActiveTarget extends StateIntentPlan {
  const StateIntentPlanContinueActiveTarget();

  @override
  bool operator ==(Object other) => other is StateIntentPlanContinueActiveTarget;

  @override
  int get hashCode => (StateIntentPlanContinueActiveTarget).hashCode;

  @override
  String toString() => 'StateIntentPlan.continueActiveTarget()';
}

class StateIntentPlanContinueReversalTarget extends StateIntentPlan {
  const StateIntentPlanContinueReversalTarget();

  @override
  bool operator ==(Object other) => other is StateIntentPlanContinueReversalTarget;

  @override
  int get hashCode => (StateIntentPlanContinueReversalTarget).hashCode;

  @override
  String toString() => 'StateIntentPlan.continueReversalTarget()';
}

class StateIntentPlanQueueReversal extends StateIntentPlan {
  const StateIntentPlanQueueReversal(this.edge);

  final GraphEdgeDefinition edge;

  @override
  bool operator ==(Object other) =>
      other is StateIntentPlanQueueReversal && other.edge == edge;

  @override
  int get hashCode => Object.hash(StateIntentPlanQueueReversal, edge);

  @override
  String toString() => 'StateIntentPlan.queueReversal(edge: ${edge.id})';
}

class StateIntentPlanQueueFollowOn extends StateIntentPlan {
  const StateIntentPlanQueueFollowOn(this.edge, {this.turn});

  final GraphEdgeDefinition edge;
  final TurnChainPlan? turn;

  @override
  bool operator ==(Object other) =>
      other is StateIntentPlanQueueFollowOn &&
      other.edge == edge &&
      other.turn == turn;

  @override
  int get hashCode => Object.hash(StateIntentPlanQueueFollowOn, edge, turn);

  @override
  String toString() => 'StateIntentPlan.queueFollowOn(edge: ${edge.id})';
}

class StateIntentPlanStaticCommit extends StateIntentPlan {
  const StateIntentPlanStaticCommit(this.edge);

  final GraphEdgeDefinition edge;

  @override
  bool operator ==(Object other) =>
      other is StateIntentPlanStaticCommit && other.edge == edge;

  @override
  int get hashCode => Object.hash(StateIntentPlanStaticCommit, edge);

  @override
  String toString() => 'StateIntentPlan.staticCommit(edge: ${edge.id})';
}

sealed class EventIntentPlan {
  const EventIntentPlan();
}

class EventIntentPlanReject extends EventIntentPlan {
  const EventIntentPlanReject();

  @override
  bool operator ==(Object other) => other is EventIntentPlanReject;

  @override
  int get hashCode => (EventIntentPlanReject).hashCode;

  @override
  String toString() => 'EventIntentPlan.reject()';
}

class EventIntentPlanAcceptNoop extends EventIntentPlan {
  const EventIntentPlanAcceptNoop();

  @override
  bool operator ==(Object other) => other is EventIntentPlanAcceptNoop;

  @override
  int get hashCode => (EventIntentPlanAcceptNoop).hashCode;

  @override
  String toString() => 'EventIntentPlan.acceptNoop()';
}

class EventIntentPlanCancelPending extends EventIntentPlan {
  const EventIntentPlanCancelPending(this.edge);

  final GraphEdgeDefinition edge;

  @override
  bool operator ==(Object other) =>
      other is EventIntentPlanCancelPending && other.edge == edge;

  @override
  int get hashCode => Object.hash(EventIntentPlanCancelPending, edge);

  @override
  String toString() => 'EventIntentPlan.cancelPending(edge: ${edge.id})';
}

class EventIntentPlanReplacePending extends EventIntentPlan {
  const EventIntentPlanReplacePending(this.edge);

  final GraphEdgeDefinition edge;

  @override
  bool operator ==(Object other) =>
      other is EventIntentPlanReplacePending && other.edge == edge;

  @override
  int get hashCode => Object.hash(EventIntentPlanReplacePending, edge);

  @override
  String toString() => 'EventIntentPlan.replacePending(edge: ${edge.id})';
}

class EventIntentPlanContinueActiveTarget extends EventIntentPlan {
  const EventIntentPlanContinueActiveTarget(this.edge);

  final GraphEdgeDefinition edge;

  @override
  bool operator ==(Object other) =>
      other is EventIntentPlanContinueActiveTarget && other.edge == edge;

  @override
  int get hashCode => Object.hash(EventIntentPlanContinueActiveTarget, edge);

  @override
  String toString() => 'EventIntentPlan.continueActiveTarget(edge: ${edge.id})';
}

class EventIntentPlanQueueReversal extends EventIntentPlan {
  const EventIntentPlanQueueReversal(this.edge);

  final GraphEdgeDefinition edge;

  @override
  bool operator ==(Object other) =>
      other is EventIntentPlanQueueReversal && other.edge == edge;

  @override
  int get hashCode => Object.hash(EventIntentPlanQueueReversal, edge);

  @override
  String toString() => 'EventIntentPlan.queueReversal(edge: ${edge.id})';
}

class EventIntentPlanQueueFollowOn extends EventIntentPlan {
  const EventIntentPlanQueueFollowOn(this.edge);

  final GraphEdgeDefinition edge;

  @override
  bool operator ==(Object other) =>
      other is EventIntentPlanQueueFollowOn && other.edge == edge;

  @override
  int get hashCode => Object.hash(EventIntentPlanQueueFollowOn, edge);

  @override
  String toString() => 'EventIntentPlan.queueFollowOn(edge: ${edge.id})';
}

class EventIntentPlanStaticCommit extends EventIntentPlan {
  const EventIntentPlanStaticCommit(this.edge);

  final GraphEdgeDefinition edge;

  @override
  bool operator ==(Object other) =>
      other is EventIntentPlanStaticCommit && other.edge == edge;

  @override
  int get hashCode => Object.hash(EventIntentPlanStaticCommit, edge);

  @override
  String toString() => 'EventIntentPlan.staticCommit(edge: ${edge.id})';
}

/// Decide state intent without mutating routes, effects, or request groups.
StateIntentPlan planStateIntent(IntentContext context, GraphStateId target) {
  final phase = context.phase;
  final visualState = context.visualState;

  if (phase == MotionGraphPhase.preparing || phase == MotionGraphPhase.intro) {
    if (target == visualState) {
      return context.routes.pending != null || context.hasPendingRequests
          ? const StateIntentPlanCancelBeforeStable()
          : const StateIntentPlanStandaloneNoop();
    }
    return _pendingOrReject(context, visualState, target);
  }

  if (phase == MotionGraphPhase.stable) {
    if (target == visualState) return const StateIntentPlanStandaloneNoop();
    return _pendingOrReject(context, visualState, target);
  }

  if (phase == MotionGraphPhase.waiting) {
    final pending = _requireSlot(context.routes.pending, 'waiting pending edge');
    if (target == pending.edge.to) return const StateIntentPlanJoinPending();
    if (target == visualState) return const StateIntentPlanCancelPending();
    return _pendingOrReject(context, visualState, target);
  }

  if (phase == MotionGraphPhase.static) {
    if (target == visualState) return const StateIntentPlanStandaloneNoop();
    final edge = _directEdge(context.indexes, visualState, target);
    return edge == null
        ? const StateIntentPlanReject()
        : StateIntentPlanStaticCommit(edge);
  }

  final active = _requireSlot(context.routes.active, 'active transition edge');
  final effective = context.routes.reversal ?? active;
  if (target == active.edge.to) {
    return const StateIntentPlanContinueActiveTarget();
  }
  if (target == effective.edge.to) {
    return const StateIntentPlanContinueReversalTarget();
  }
  if (phase == MotionGraphPhase.reversible) {
    final inverse = _inverseEdge(context.indexes, active.edge);
    if (inverse != null && target == inverse.to) {
      return StateIntentPlanQueueReversal(inverse);
    }
  }
  final follow = _pendingTurnOrDirect(context, effective.edge.to, target);
  return follow == null
      ? const StateIntentPlanReject()
      : StateIntentPlanQueueFollowOn(follow.edge, turn: follow.turn);
}

/// Resolve and decide an event without mutating semantic state.
EventIntentPlan planEventIntent(IntentContext context, String event) {
  final edge = _resolveEventEdge(context, event);
  if (edge == null) return const EventIntentPlanReject();

  if (context.phase == MotionGraphPhase.static) {
    return EventIntentPlanStaticCommit(edge);
  }
  if ((context.phase == MotionGraphPhase.preparing ||
          context.phase == MotionGraphPhase.intro ||
          context.phase == MotionGraphPhase.waiting) &&
      context.routes.pending != null &&
      edge.to == context.visualState) {
    return EventIntentPlanCancelPending(edge);
  }
  if (context.phase == MotionGraphPhase.waiting) {
    final pending = _requireSlot(context.routes.pending, 'waiting pending edge');
    if (edge.id == pending.edge.id) return const EventIntentPlanAcceptNoop();
  }

  if (context.phase == MotionGraphPhase.locked ||
      context.phase == MotionGraphPhase.reversible) {
    final active = _requireSlot(context.routes.active, 'active transition edge');
    final effective = context.routes.reversal ?? active;
    if (edge.id == effective.edge.id && context.routes.followOn == null) {
      return const EventIntentPlanAcceptNoop();
    }
    if (edge.id == active.edge.id) {
      return EventIntentPlanContinueActiveTarget(edge);
    }
    final inverse = context.phase == MotionGraphPhase.reversible
        ? _inverseEdge(context.indexes, active.edge)
        : null;
    if (inverse?.id == edge.id) {
      return EventIntentPlanQueueReversal(edge);
    }
    if (edge.id == context.routes.followOn?.edge.id) {
      return const EventIntentPlanAcceptNoop();
    }
    return EventIntentPlanQueueFollowOn(edge);
  }

  if ((context.phase == MotionGraphPhase.preparing ||
          context.phase == MotionGraphPhase.intro) &&
      edge.id == context.routes.pending?.edge.id) {
    return const EventIntentPlanAcceptNoop();
  }
  return EventIntentPlanReplacePending(edge);
}

GraphEdgeDefinition? _resolveEventEdge(IntentContext context, String event) {
  if (context.phase == MotionGraphPhase.preparing ||
      context.phase == MotionGraphPhase.intro ||
      context.phase == MotionGraphPhase.waiting) {
    final pending = context.routes.pending;
    if (pending == null) {
      if (context.phase == MotionGraphPhase.waiting) {
        throw StateError('graph invariant missing waiting pending edge');
      }
      return _eventEdge(context.indexes, context.visualState, event);
    }
    final inverse = _inverseEdge(context.indexes, pending.edge);
    if (_hasEventTrigger(inverse, event)) return inverse;
    return _eventEdge(context.indexes, context.visualState, event);
  }

  if (context.phase == MotionGraphPhase.locked ||
      context.phase == MotionGraphPhase.reversible) {
    final active = _requireSlot(context.routes.active, 'active transition edge');
    final inverse = context.phase == MotionGraphPhase.reversible
        ? _inverseEdge(context.indexes, active.edge)
        : null;
    if (_hasEventTrigger(inverse, event)) return inverse;
    if (_hasEventTrigger(active.edge, event)) return active.edge;
    final effective = context.routes.reversal ?? active;
    return _eventEdge(context.indexes, effective.edge.to, event);
  }

  return _eventEdge(context.indexes, context.visualState, event);
}

StateIntentPlan _pendingOrReject(
  IntentContext context,
  GraphStateId from,
  GraphStateId target,
) {
  final routed = _pendingTurnOrDirect(context, from, target);
  return routed == null
      ? const StateIntentPlanReject()
      : StateIntentPlanReplacePending(routed.edge, turn: routed.turn);
}

/// Direct neighbour edge, or first step of a ring arc with the remainder queued.
({GraphEdgeDefinition edge, TurnChainPlan? turn})? _pendingTurnOrDirect(
  IntentContext context,
  GraphStateId from,
  GraphStateId target,
) {
  final edge = _directEdge(context.indexes, from, target);
  if (edge != null) return (edge: edge, turn: null);
  return _turnPlan(context, from, target);
}

/// Resolve a multi-step ring arc into its first step plus the queued remainder.
({GraphEdgeDefinition edge, TurnChainPlan turn})? _turnPlan(
  IntentContext context,
  GraphStateId from,
  GraphStateId target,
) {
  final route = resolveRingRoute(context.indexes, from, target);
  if (route is! RingRouteArc) return null;
  if (route.steps.isEmpty) return null;
  final first = route.steps.first;
  return (
    edge: first,
    turn: TurnChainPlan(
      ring: route.ring.id,
      after: first.id,
      remaining: List.unmodifiable(route.steps.skip(1)),
    ),
  );
}

GraphEdgeDefinition? _directEdge(
  ValidatedGraphIndexes indexes,
  GraphStateId from,
  GraphStateId to,
) {
  return indexes.directEdgesByState[from]?[to];
}

GraphEdgeDefinition? _eventEdge(
  ValidatedGraphIndexes indexes,
  GraphStateId from,
  String event,
) {
  return indexes.eventEdgesByState[from]?[event];
}

GraphEdgeDefinition? _inverseEdge(
  ValidatedGraphIndexes indexes,
  GraphEdgeDefinition edge,
) {
  return indexes.inverseEdgesById[edge.id];
}

bool _hasEventTrigger(GraphEdgeDefinition? edge, String event) {
  final trigger = edge?.trigger;
  return trigger is GraphEdgeTriggerEvent && trigger.name == event;
}

SequencedEdge _requireSlot(SequencedEdge? value, String label) {
  if (value == null) throw StateError('graph invariant missing $label');
  return value;
}
