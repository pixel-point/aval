import 'package:aval_graph/aval_graph.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rings_climbing/climbing_graph.dart';

void main() {
  late ValidatedMotionGraph graph;
  late MotionGraphEngine engine;

  setUp(() {
    graph = buildClimbingGraph();
    engine = MotionGraphEngine();
    engine.install(graph);
    engine.beginAnimated();
  });

  test('climbing graph validates with stamina ring', () {
    expect(graph.definition.states.length, kAllStates.length);
    expect(graph.definition.rings, isNotNull);
    expect(graph.definition.rings!.single.id, 'stamina');
    expect(graph.definition.rings!.single.states, [
      kHangSecure,
      kHangStrained,
      kHangFailing,
    ]);
  });

  test('planFor walks stamina ring', () {
    expect(engine.planFor(kHangSecure), isEmpty);
    expect(engine.planFor(kHangStrained), [kHangStrained]);
    // 3-state cyclic: secure→failing is one step backward (shorter arc).
    expect(engine.planFor(kHangFailing), [kHangFailing]);
  });

  test('planFor reaches action spokes', () {
    expect(engine.planFor(kShakeOut), [kShakeOut]);
    expect(engine.planFor(kFall), [kFall]);
  });

  /// PRD v3 AC12: pivot pairs share unitId, opposite dirs, one reverseOf.
  test('AC12 pivot-symmetric reversible pairs', () {
    final byUnit = <String, List<GraphEdgeDefinition>>{};
    for (final edge in graph.definition.edges) {
      final t = edge.transition;
      if (t is! GraphTransitionReversible) continue;
      (byUnit[t.unitId] ??= []).add(edge);
    }

    expect(byUnit, isNotEmpty, reason: 'expected pivot units');
    // 3 stamina + 3 action + 3 jump coils = 9 pivot units.
    expect(countReversiblePivotUnits(graph), 9);

    for (final entry in byUnit.entries) {
      final pair = entry.value;
      expect(
        pair.length,
        2,
        reason: 'unit ${entry.key} must have exactly 2 edges',
      );
      final a = pair[0].transition! as GraphTransitionReversible;
      final b = pair[1].transition! as GraphTransitionReversible;
      expect(a.frameCount, b.frameCount);
      expect(
        {a.direction, b.direction},
        {TransitionDirection.forward, TransitionDirection.reverse},
      );

      final withRev = pair
          .where(
            (e) =>
                (e.transition! as GraphTransitionReversible).reverseOf != null,
          )
          .toList();
      expect(withRev.length, 1, reason: 'exactly one reverseOf');
      final inverse = withRev.single;
      final invT = inverse.transition! as GraphTransitionReversible;
      final base = pair.singleWhere((e) => e.id == invT.reverseOf);
      expect(base.from, inverse.to);
      expect(base.to, inverse.from);
      expect(base.continuity, GraphContinuity.exactAuthored);
      expect(inverse.continuity, GraphContinuity.exactReverse);
      expect(
        (base.transition! as GraphTransitionReversible).direction,
        TransitionDirection.forward,
      );
      expect(invT.direction, TransitionDirection.reverse);
    }
  });

  /// PRD v3 AC15: hard-cut / one-shot edges have no inverse.
  test('AC15 one-shots have no reversible inverse', () {
    final oneShotIds = {
      'action.secure.reach',
      'action.reach.secure',
      'action.secure.fall',
      'action.failing.fall',
      'action.fall.secure',
    };
    for (final edge in graph.definition.edges) {
      if (!oneShotIds.contains(edge.id)) continue;
      expect(edge.transition, isNull, reason: edge.id);
      expect(edge.continuity, GraphContinuity.cut);
      expect(edge.start, isA<GraphStartPolicyCut>());
    }
  });

  test('every reverseOf points at a real base edge id', () {
    final byId = {
      for (final e in graph.definition.edges) e.id: e,
    };
    var inverseCount = 0;
    for (final edge in graph.definition.edges) {
      final t = edge.transition;
      if (t is! GraphTransitionReversible || t.reverseOf == null) continue;
      inverseCount++;
      expect(byId.containsKey(t.reverseOf), isTrue, reason: edge.id);
      final base = byId[t.reverseOf!]!;
      expect(base.from, edge.to);
      expect(base.to, edge.from);
    }
    expect(inverseCount, 9); // one inverse per pivot unit
  });

  test('planFor jump left/right/up from secure', () {
    expect(engine.planFor(kJumpLeft), [kJumpLeft]);
    expect(engine.planFor(kJumpRight), [kJumpRight]);
    expect(engine.planFor(kJumpUp), [kJumpUp]);
    expect(engine.planFor(kJumpLeftCharge), [kJumpLeftCharge]);
    expect(engine.planFor(kJumpUpCharge), [kJumpUpCharge]);
  });
}
