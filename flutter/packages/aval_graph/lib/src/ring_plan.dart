/// Ring arc selection, ported from `packages/graph/src/ring-plan.ts`.
library;

import 'model.dart';
import 'validate.dart';

/// One resolved arc along a ring, excluding the state it departs from.
class RingArc {
  const RingArc({
    required this.direction,
    required this.states,
  });

  final GraphRingTieBreak direction;

  /// Ordered landings; the last entry is the requested target.
  final List<GraphStateId> states;

  @override
  bool operator ==(Object other) =>
      other is RingArc &&
      other.direction == direction &&
      listEquals(other.states, states);

  @override
  int get hashCode => Object.hash(direction, Object.hashAll(states));

  @override
  String toString() => 'RingArc(direction: $direction, states: $states)';
}

/// A ring route resolved against authored edges.
sealed class RingRoute {
  const RingRoute();
}

class RingRouteNone extends RingRoute {
  const RingRouteNone();
}

class RingRouteTooLong extends RingRoute {
  const RingRouteTooLong({required this.ring, required this.distance});

  final GraphRingDefinition ring;
  final int distance;
}

class RingRouteArc extends RingRoute {
  const RingRouteArc({
    required this.ring,
    required this.direction,
    required this.states,
    required this.steps,
  });

  final GraphRingDefinition ring;
  final GraphRingTieBreak direction;
  final List<GraphStateId> states;
  final List<GraphEdgeDefinition> steps;
}

/// Choose the shorter arc between two members of one ring.
///
/// Distances are measured in steps, wrapping only on cyclic rings. Equal-length
/// arcs resolve through the ring's [GraphRingDefinition.tieBreak]. The
/// `maxChainedSteps` ceiling is not applied here.
RingArc? planRingArc(
  GraphRingDefinition ring,
  GraphStateId from,
  GraphStateId to,
) {
  final length = ring.states.length;
  final fromIndex = ring.states.indexOf(from);
  final toIndex = ring.states.indexOf(to);
  if (fromIndex < 0 || toIndex < 0 || fromIndex == toIndex) return null;

  final double forward;
  final double backward;
  if (ring.cyclic) {
    forward = ((toIndex - fromIndex + length) % length).toDouble();
    backward = ((fromIndex - toIndex + length) % length).toDouble();
  } else {
    forward = toIndex > fromIndex
        ? (toIndex - fromIndex).toDouble()
        : double.infinity;
    backward = fromIndex > toIndex
        ? (fromIndex - toIndex).toDouble()
        : double.infinity;
  }
  if (!forward.isFinite && !backward.isFinite) return null;

  final GraphRingTieBreak direction;
  if (forward < backward) {
    direction = GraphRingTieBreak.forward;
  } else if (backward < forward) {
    direction = GraphRingTieBreak.backward;
  } else {
    direction = ring.tieBreak;
  }
  final distance =
      direction == GraphRingTieBreak.forward ? forward.toInt() : backward.toInt();
  final offset = direction == GraphRingTieBreak.forward ? 1 : -1;
  final states = <GraphStateId>[];
  for (var step = 1; step <= distance; step += 1) {
    final index = ((fromIndex + step * offset) % length + length) % length;
    states.add(ring.states[index]);
  }
  return RingArc(direction: direction, states: List.unmodifiable(states));
}

/// Resolve the authored step edges which walk [from] to [to] along one ring.
///
/// Rings are consulted in validated (ascending id) order and the first ring
/// that can serve the whole arc wins.
RingRoute resolveRingRoute(
  ValidatedGraphIndexes indexes,
  GraphStateId from,
  GraphStateId to,
) {
  RingRouteTooLong? refused;
  for (final ring in indexes.ringsByState[from] ?? const <GraphRingDefinition>[]) {
    final arc = planRingArc(ring, from, to);
    if (arc == null) continue;
    if (arc.states.length > ring.maxChainedSteps) {
      refused ??= RingRouteTooLong(ring: ring, distance: arc.states.length);
      continue;
    }
    final steps = _collectSteps(indexes, from, arc.states);
    if (steps == null) continue;
    return RingRouteArc(
      ring: ring,
      direction: arc.direction,
      states: arc.states,
      steps: steps,
    );
  }
  return refused ?? const RingRouteNone();
}

List<GraphEdgeDefinition>? _collectSteps(
  ValidatedGraphIndexes indexes,
  GraphStateId from,
  List<GraphStateId> states,
) {
  final steps = <GraphEdgeDefinition>[];
  var cursor = from;
  for (final state in states) {
    final edge = indexes.directEdgesByState[cursor]?[state];
    if (edge == null) return null;
    steps.add(edge);
    cursor = state;
  }
  return List.unmodifiable(steps);
}
