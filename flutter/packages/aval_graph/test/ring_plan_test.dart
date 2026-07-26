import 'package:aval_graph/aval_graph.dart';
import 'package:test/test.dart';

const facings = <String>[
  'walk_n',
  'walk_ne',
  'walk_e',
  'walk_se',
  'walk_s',
  'walk_sw',
  'walk_w',
  'walk_nw',
];

GraphRingDefinition facingRing({
  bool cyclic = true,
  GraphRingTieBreak tieBreak = GraphRingTieBreak.forward,
  int maxChainedSteps = 4,
}) {
  return GraphRingDefinition(
    id: 'facing.walk',
    states: facings,
    cyclic: cyclic,
    tieBreak: tieBreak,
    maxChainedSteps: maxChainedSteps,
  );
}

void main() {
  group('planRingArc', () {
    test('chooses the shorter arc and reports landing states', () {
      final ring = facingRing();
      expect(
        planRingArc(ring, 'walk_n', 'walk_e'),
        RingArc(
          direction: GraphRingTieBreak.forward,
          states: const ['walk_ne', 'walk_e'],
        ),
      );
      expect(
        planRingArc(ring, 'walk_nw', 'walk_ne'),
        RingArc(
          direction: GraphRingTieBreak.forward,
          states: const ['walk_n', 'walk_ne'],
        ),
      );
      expect(
        planRingArc(ring, 'walk_n', 'walk_w'),
        RingArc(
          direction: GraphRingTieBreak.backward,
          states: const ['walk_nw', 'walk_w'],
        ),
      );
    });

    test('resolves half turn via tieBreak', () {
      final forward = facingRing();
      final backward = facingRing(tieBreak: GraphRingTieBreak.backward);
      expect(
        planRingArc(forward, 'walk_n', 'walk_s')!.direction,
        GraphRingTieBreak.forward,
      );
      expect(
        planRingArc(forward, 'walk_n', 'walk_s')!.states,
        const ['walk_ne', 'walk_e', 'walk_se', 'walk_s'],
      );
      expect(
        planRingArc(backward, 'walk_n', 'walk_s')!.direction,
        GraphRingTieBreak.backward,
      );
      expect(
        planRingArc(backward, 'walk_n', 'walk_s')!.states,
        const ['walk_nw', 'walk_w', 'walk_sw', 'walk_s'],
      );
    });

    test('never wraps a non-cyclic ring', () {
      final line = facingRing(cyclic: false);
      expect(
        planRingArc(line, 'walk_nw', 'walk_ne')!.states,
        const [
          'walk_w',
          'walk_sw',
          'walk_s',
          'walk_se',
          'walk_e',
          'walk_ne',
        ],
      );
      expect(planRingArc(line, 'walk_n', 'walk_n'), isNull);
      expect(planRingArc(line, 'walk_n', 'sit'), isNull);
    });
  });

  group('MotionGraphEngine.planFor rings', () {
    test('plans multi-step arc without advancing the graph', () {
      final engine = _animatedFacingEngine();
      final before = engine.snapshot();
      expect(engine.planFor('walk_e'), const ['walk_ne', 'walk_e']);
      expect(engine.planFor('walk_ne'), const ['walk_ne']);
      expect(engine.planFor('walk_n'), isEmpty);
      expect(engine.planFor('unknown'), isNull);
      expect(engine.snapshot().visualState, before.visualState);
      expect(engine.snapshot().requestedState, before.requestedState);
    });

    test('refuses arcs longer than maxChainedSteps', () {
      final engine = _animatedFacingEngine(maxChainedSteps: 2);
      expect(engine.planFor('walk_s'), isNull);
      final refused = engine.request('walk_s');
      expect(refused.accepted, isFalse);
    });
  });
}

MotionGraphEngine _animatedFacingEngine({int maxChainedSteps = 4}) {
  final states = <Map<String, Object?>>[
    for (final id in facings)
      {
        'id': id,
        'body': {
          'unitId': '$id.body',
          'kind': 'loop',
          'frameCount': 8,
          'ports': [
            {
              'id': 'default',
              'entryFrame': 0,
              'portalFrames': [0, 4],
            }
          ],
        },
      },
  ];
  final edges = <Map<String, Object?>>[];
  for (var i = 0; i < facings.length; i += 1) {
    final from = facings[i];
    final toFwd = facings[(i + 1) % facings.length];
    final toBack = facings[(i - 1 + facings.length) % facings.length];
    for (final entry in [
      (toFwd, 1),
      (toBack, -1),
    ]) {
      final to = entry.$1;
      final step = entry.$2;
      final short = from.replaceFirst('walk_', '');
      final shortTo = to.replaceFirst('walk_', '');
      edges.add({
        'id': 'facing.walk.$short.$shortTo',
        'from': from,
        'to': to,
        'start': {
          'type': 'cut',
          'targetPort': 'default',
          'maxWaitFrames': 1,
        },
        'continuity': 'cut',
        'ring': 'facing.walk',
        'step': step,
      });
    }
  }
  final definition = <String, Object?>{
    'initialState': 'walk_n',
    'states': states,
    'edges': edges,
    'rings': [
      {
        'id': 'facing.walk',
        'states': facings,
        'cyclic': true,
        'tieBreak': 'forward',
        'maxChainedSteps': maxChainedSteps,
      }
    ],
  };
  final engine = MotionGraphEngine();
  engine.install(definition);
  engine.beginAnimated();
  return engine;
}
