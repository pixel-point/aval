/// Untrusted-definition validator, ported from
/// `packages/graph/src/validate.ts`.
///
/// [validateMotionGraphDefinition] accepts genuinely untrusted, dynamically
/// shaped input — typically a `Map`/`List` tree decoded from JSON, exactly
/// like the TypeScript original, which walks its input as `unknown` rather
/// than trusting its nominal `MotionGraphDefinition` parameter type (nothing
/// stops a caller from handing TypeScript plain JSON at runtime either).
/// Dart cannot express "trust this type only after a runtime check" via a
/// compile-time brand the way the TypeScript source's `unique symbol` brand
/// pretends to (that brand has zero runtime effect in the original either —
/// see the doc comment on `ValidatedMotionGraph` in `model.dart`), so the
/// trust boundary here, too, is enforced entirely by [getValidatedGraphIndexes]
/// checking an [Expando] populated only by this function.
library;

import 'dart:convert';

import 'errors.dart';
import 'limits.dart';
import 'model.dart';
import 'portal_search.dart';

/// Package-private engine access to the indexes associated with a validated
/// clone.
class ValidatedGraphIndexes {
  const ValidatedGraphIndexes({
    required this.statesById,
    required this.edgesById,
    required this.portsByState,
    required this.directEdgesByState,
    required this.eventEdgesByState,
    required this.completionEdgesByState,
    required this.inverseEdgesById,
    required this.ringsById,
    required this.ringsByState,
  });

  final Map<GraphStateId, GraphStateDefinition> statesById;
  final Map<GraphEdgeId, GraphEdgeDefinition> edgesById;
  final Map<GraphStateId, Map<String, GraphPortDefinition>> portsByState;
  final Map<GraphStateId, Map<GraphStateId, GraphEdgeDefinition>>
      directEdgesByState;
  final Map<GraphStateId, Map<String, GraphEdgeDefinition>> eventEdgesByState;
  final Map<GraphStateId, GraphEdgeDefinition> completionEdgesByState;
  final Map<GraphEdgeId, GraphEdgeDefinition> inverseEdgesById;
  final Map<GraphRingId, GraphRingDefinition> ringsById;

  /// Rings a state belongs to, in ascending ring-id order.
  final Map<GraphStateId, List<GraphRingDefinition>> ringsByState;
}

final Expando<ValidatedGraphIndexes> _indexesByGraph =
    Expando<ValidatedGraphIndexes>('validatedGraphIndexes');

/// Clones and validates an untrusted graph definition. The returned
/// definition shares no lists or objects with the caller.
///
/// [value] is expected to be a `Map<String, Object?>` (or any `Map`) whose
/// entries mirror the TypeScript `MotionGraphDefinition` shape, with nested
/// `List`s for `states`/`edges`/`ports`/`portalFrames`. Anything else — the
/// wrong runtime type, a missing field, an out-of-range number — throws
/// [MotionGraphValidationError] with a path-qualified message.
ValidatedMotionGraph validateMotionGraphDefinition(Object? value) {
  final input = _expectRecord(value, 'definition');
  final initialState = _expectIdentifier(input['initialState'], 'initialState');
  final stateInputs = _expectArray(input['states'], 'states');
  final edgeInputs = _expectArray(input['edges'], 'edges');

  if (stateInputs.isEmpty || stateInputs.length > GraphLimits.maxStates) {
    _invalid(
      'states must contain between 1 and ${GraphLimits.maxStates} entries',
    );
  }
  if (edgeInputs.length > GraphLimits.maxEdges) {
    _invalid('edges must contain at most ${GraphLimits.maxEdges} entries');
  }

  final stateIds = <String>{};
  final reservedUnitIds = <String>{};
  final states = <GraphStateDefinition>[
    for (var index = 0; index < stateInputs.length; index += 1)
      _cloneState(stateInputs[index], index, initialState, stateIds, reservedUnitIds),
  ];

  final statesById = <GraphStateId, GraphStateDefinition>{
    for (final state in states) state.id: state,
  };
  if (!statesById.containsKey(initialState)) {
    _invalid('initialState ${_quote(initialState)} does not reference a state');
  }

  final edgeIds = <String>{};
  final transitionUnitKinds = <String, String>{};
  final edges = <GraphEdgeDefinition>[
    for (var index = 0; index < edgeInputs.length; index += 1)
      _cloneEdge(edgeInputs[index], index, edgeIds, reservedUnitIds, transitionUnitKinds),
  ];

  final edgesById = <GraphEdgeId, GraphEdgeDefinition>{
    for (final edge in edges) edge.id: edge,
  };
  final portsByState = <GraphStateId, Map<String, GraphPortDefinition>>{};
  for (final state in states) {
    portsByState[state.id] = <String, GraphPortDefinition>{
      for (final port in state.body.ports) port.id: port,
    };
  }

  final directMutable = <GraphStateId, Map<GraphStateId, GraphEdgeDefinition>>{};
  final eventMutable = <GraphStateId, Map<String, GraphEdgeDefinition>>{};
  final completionEdgesByState = <GraphStateId, GraphEdgeDefinition>{};

  for (final edge in edges) {
    _validateEdgeReferencesAndGeometry(
      edge,
      statesById,
      portsByState,
      directMutable,
      eventMutable,
      completionEdgesByState,
    );
  }

  final inverseEdgesById = _validateReversiblePairs(edges, edgesById);
  _validateImmediateCompletionCycles(completionEdgesByState, statesById);

  final rings = _cloneRings(input['rings'], statesById);
  final ringsById = <GraphRingId, GraphRingDefinition>{
    for (final ring in rings) ring.id: ring,
  };
  final ringsByState = _indexRingsByState(rings);
  _validateRingStepOwnership(rings, directMutable);
  for (final edge in edges) {
    _validateTurnEdge(edge, ringsById);
  }

  final definition = MotionGraphDefinition(
    initialState: initialState,
    states: states,
    edges: edges,
    rings: rings.isEmpty ? null : rings,
  );
  final validated = ValidatedMotionGraph(definition);
  final indexes = ValidatedGraphIndexes(
    statesById: statesById,
    edgesById: edgesById,
    portsByState: portsByState,
    directEdgesByState: directMutable,
    eventEdgesByState: eventMutable,
    completionEdgesByState: completionEdgesByState,
    inverseEdgesById: inverseEdgesById,
    ringsById: ringsById,
    ringsByState: ringsByState,
  );

  _indexesByGraph[validated] = indexes;
  return validated;
}

/// Internal engine access to the indexes associated with a validated clone.
ValidatedGraphIndexes getValidatedGraphIndexes(ValidatedMotionGraph graph) {
  final indexes = _indexesByGraph[graph];
  if (indexes == null) {
    throw const MotionGraphValidationError(
      'graph was not produced by validateMotionGraphDefinition()',
    );
  }
  return indexes;
}

GraphStateDefinition _cloneState(
  Object? value,
  int index,
  String initialState,
  Set<String> stateIds,
  Set<String> reservedUnitIds,
) {
  final path = 'states[$index]';
  final input = _expectRecord(value, path);
  final id = _expectIdentifier(input['id'], '$path.id');
  _addUnique(stateIds, id, '$path.id', 'state ID');

  final body = _cloneBody(input['body'], '$path.body');
  _reserveUnit(reservedUnitIds, body.unitId, '$path.body.unitId');

  if (input['initialUnit'] == null) {
    return GraphStateDefinition(id: id, body: body);
  }
  if (id != initialState) {
    _invalid('$path.initialUnit is allowed only on the initial state');
  }

  final initialInput = _expectRecord(input['initialUnit'], '$path.initialUnit');
  final unitId = _expectIdentifier(
    initialInput['unitId'],
    '$path.initialUnit.unitId',
  );
  final frameCount = _expectPositiveSafeInteger(
    initialInput['frameCount'],
    '$path.initialUnit.frameCount',
  );
  _reserveUnit(reservedUnitIds, unitId, '$path.initialUnit.unitId');
  final initialUnit = GraphInitialUnitDefinition(unitId: unitId, frameCount: frameCount);
  return GraphStateDefinition(id: id, body: body, initialUnit: initialUnit);
}

GraphBodyDefinition _cloneBody(Object? value, String path) {
  final input = _expectRecord(value, path);
  final unitId = _expectIdentifier(input['unitId'], '$path.unitId');
  final kindValue = input['kind'];
  GraphBodyKind kind;
  if (kindValue == 'loop') {
    kind = GraphBodyKind.loop;
  } else if (kindValue == 'finite') {
    kind = GraphBodyKind.finite;
  } else if (kindValue == 'held') {
    kind = GraphBodyKind.held;
  } else {
    _invalid('$path.kind must be loop, finite, or held');
  }
  final frameCount = _expectPositiveSafeInteger(input['frameCount'], '$path.frameCount');
  if (kind == GraphBodyKind.held && frameCount != 1) {
    _invalid('$path.frameCount must be 1 for a held body');
  }

  final portInputs = _expectArray(input['ports'], '$path.ports');
  if (portInputs.length > GraphLimits.maxPortsPerBody) {
    _invalid(
      '$path.ports must contain at most ${GraphLimits.maxPortsPerBody} entries',
    );
  }
  final portIds = <String>{};
  final ports = <GraphPortDefinition>[
    for (var index = 0; index < portInputs.length; index += 1)
      _clonePort(portInputs[index], '$path.ports[$index]', frameCount, portIds),
  ];
  return GraphBodyDefinition(
    unitId: unitId,
    kind: kind,
    frameCount: frameCount,
    ports: ports,
  );
}

GraphPortDefinition _clonePort(
  Object? value,
  String path,
  int frameCount,
  Set<String> portIds,
) {
  final input = _expectRecord(value, path);
  final id = _expectIdentifier(input['id'], '$path.id');
  _addUnique(portIds, id, '$path.id', 'port ID in one body');
  if (input['entryFrame'] != 0) {
    _invalid('$path.entryFrame must be 0');
  }

  final portalInputs = _expectArray(input['portalFrames'], '$path.portalFrames');
  if (portalInputs.isEmpty) {
    _invalid('$path.portalFrames must contain at least one frame');
  }
  final portalFrames = <int>[];
  var previous = -1;
  for (var index = 0; index < portalInputs.length; index += 1) {
    final frame = _expectNonNegativeSafeInteger(
      portalInputs[index],
      '$path.portalFrames[$index]',
    );
    if (frame >= frameCount) {
      _invalid('$path.portalFrames[$index] must be less than frameCount');
    }
    if (frame <= previous) {
      _invalid('$path.portalFrames must be sorted and unique');
    }
    portalFrames.add(frame);
    previous = frame;
  }

  return GraphPortDefinition(id: id, portalFrames: portalFrames);
}

GraphEdgeDefinition _cloneEdge(
  Object? value,
  int index,
  Set<String> edgeIds,
  Set<String> reservedUnitIds,
  Map<String, String> transitionUnitKinds,
) {
  final path = 'edges[$index]';
  final input = _expectRecord(value, path);
  final id = _expectIdentifier(input['id'], '$path.id');
  _addUnique(edgeIds, id, '$path.id', 'edge ID');
  final from = _expectIdentifier(input['from'], '$path.from');
  final to = _expectIdentifier(input['to'], '$path.to');
  if (from == to) {
    _invalid('$path must connect distinct states');
  }

  final triggerValue = input['trigger'];
  final trigger = triggerValue == null ? null : _cloneTrigger(triggerValue, '$path.trigger');
  final start = _cloneStart(input['start'], '$path.start');
  final transitionValue = input['transition'];
  final transition =
      transitionValue == null ? null : _cloneTransition(transitionValue, '$path.transition');

  final continuityValue = input['continuity'];
  GraphContinuity continuity;
  if (continuityValue == 'exact-authored') {
    continuity = GraphContinuity.exactAuthored;
  } else if (continuityValue == 'exact-reverse') {
    continuity = GraphContinuity.exactReverse;
  } else if (continuityValue == 'cut') {
    continuity = GraphContinuity.cut;
  } else {
    _invalid('$path.continuity is invalid');
  }

  if (transition != null) {
    if (reservedUnitIds.contains(transition.unitId)) {
      _invalid(
        '$path.transition.unitId ${_quote(transition.unitId)} is already used by a body or initial unit',
      );
    }
    final existingKind = transitionUnitKinds[transition.unitId];
    if (transition is GraphTransitionLocked) {
      if (existingKind != null) {
        _invalid(
          '$path.transition.unitId ${_quote(transition.unitId)} is already used by another transition',
        );
      }
      transitionUnitKinds[transition.unitId] = 'locked';
    } else {
      if (existingKind == 'locked') {
        _invalid(
          '$path.transition.unitId ${_quote(transition.unitId)} is already used by a locked transition',
        );
      }
      transitionUnitKinds[transition.unitId] = 'reversible';
    }
  }

  final turn = _cloneTurnMembership(input, path);

  return GraphEdgeDefinition(
    id: id,
    from: from,
    to: to,
    start: start,
    continuity: continuity,
    trigger: trigger,
    transition: transition,
    ring: turn.ring,
    step: turn.step,
  );
}

({GraphRingId? ring, GraphTurnStep? step}) _cloneTurnMembership(
  Map<String, Object?> input,
  String path,
) {
  if (input['ring'] == null && input['step'] == null) {
    return (ring: null, step: null);
  }
  final ring = _expectIdentifier(input['ring'], '$path.ring');
  final step = _asInteger(input['step']);
  if (step != 1 && step != -1) {
    _invalid('$path.step must be 1 or -1');
  }
  return (ring: ring, step: step);
}

GraphEdgeTrigger _cloneTrigger(Object? value, String path) {
  final input = _expectRecord(value, path);
  final type = input['type'];
  if (type == 'completion') return const GraphEdgeTriggerCompletion();
  if (type == 'event') {
    return GraphEdgeTriggerEvent(_expectIdentifier(input['name'], '$path.name'));
  }
  _invalid('$path.type must be event or completion');
}

GraphStartPolicy _cloneStart(Object? value, String path) {
  final input = _expectRecord(value, path);
  final type = input['type'];
  if (type == 'portal') {
    return GraphStartPolicyPortal(
      sourcePort: _expectIdentifier(input['sourcePort'], '$path.sourcePort'),
      targetPort: _expectIdentifier(input['targetPort'], '$path.targetPort'),
      maxWaitFrames: _expectNonNegativeSafeInteger(
        input['maxWaitFrames'],
        '$path.maxWaitFrames',
      ),
    );
  }
  if (type == 'finish') {
    return GraphStartPolicyFinish(
      targetPort: _expectIdentifier(input['targetPort'], '$path.targetPort'),
      maxWaitFrames: _expectNonNegativeSafeInteger(
        input['maxWaitFrames'],
        '$path.maxWaitFrames',
      ),
    );
  }
  if (type == 'cut') {
    if (input['maxWaitFrames'] != 1) {
      _invalid('$path.maxWaitFrames must be 1 for a cut');
    }
    return GraphStartPolicyCut(
      targetPort: _expectIdentifier(input['targetPort'], '$path.targetPort'),
    );
  }
  _invalid('$path.type must be portal, finish, or cut');
}

GraphTransitionDefinition _cloneTransition(Object? value, String path) {
  final input = _expectRecord(value, path);
  final unitId = _expectIdentifier(input['unitId'], '$path.unitId');
  final frameCount = _expectPositiveSafeInteger(input['frameCount'], '$path.frameCount');
  if (input['kind'] == 'locked') {
    return GraphTransitionLocked(unitId: unitId, frameCount: frameCount);
  }
  if (input['kind'] == 'reversible') {
    final directionValue = input['direction'];
    TransitionDirection direction;
    if (directionValue == 'forward') {
      direction = TransitionDirection.forward;
    } else if (directionValue == 'reverse') {
      direction = TransitionDirection.reverse;
    } else {
      _invalid('$path.direction must be forward or reverse');
    }
    final reverseOfValue = input['reverseOf'];
    final reverseOf =
        reverseOfValue == null ? null : _expectIdentifier(reverseOfValue, '$path.reverseOf');
    return GraphTransitionReversible(
      unitId: unitId,
      frameCount: frameCount,
      direction: direction,
      reverseOf: reverseOf,
    );
  }
  _invalid('$path.kind must be locked or reversible');
}

void _validateEdgeReferencesAndGeometry(
  GraphEdgeDefinition edge,
  Map<GraphStateId, GraphStateDefinition> statesById,
  Map<GraphStateId, Map<String, GraphPortDefinition>> portsByState,
  Map<GraphStateId, Map<GraphStateId, GraphEdgeDefinition>> directEdgesByState,
  Map<GraphStateId, Map<String, GraphEdgeDefinition>> eventEdgesByState,
  Map<GraphStateId, GraphEdgeDefinition> completionEdgesByState,
) {
  final sourceLookup = statesById[edge.from];
  final targetLookup = statesById[edge.to];
  if (sourceLookup == null) {
    _invalid('${_edgePath(edge)}.from does not reference a state');
  }
  if (targetLookup == null) {
    _invalid('${_edgePath(edge)}.to does not reference a state');
  }
  final source = sourceLookup;
  final target = targetLookup;

  final direct = _getOrCreate(directEdgesByState, edge.from);
  final duplicateDirect = direct[edge.to];
  if (duplicateDirect != null) {
    _invalid(
      '${_edgePath(edge)} duplicates direct route ${_quote(duplicateDirect.id)} from ${_quote(edge.from)} to ${_quote(edge.to)}',
    );
  }
  direct[edge.to] = edge;

  final trigger = edge.trigger;
  if (trigger is GraphEdgeTriggerEvent) {
    final events = _getOrCreate(eventEdgesByState, edge.from);
    final duplicateEvent = events[trigger.name];
    if (duplicateEvent != null) {
      _invalid(
        '${_edgePath(edge)} duplicates event ${_quote(trigger.name)} from ${_quote(edge.from)}',
      );
    }
    events[trigger.name] = edge;
  } else if (trigger is GraphEdgeTriggerCompletion) {
    if (source.body.kind == GraphBodyKind.loop) {
      _invalid('${_edgePath(edge)} completion trigger cannot originate from a loop');
    }
    final duplicateCompletion = completionEdgesByState[edge.from];
    if (duplicateCompletion != null) {
      _invalid(
        '${_edgePath(edge)} duplicates completion route ${_quote(duplicateCompletion.id)} from ${_quote(edge.from)}',
      );
    }
    completionEdgesByState[edge.from] = edge;
  }

  final targetPorts = portsByState[target.id];
  if (targetPorts?.containsKey(edge.start.targetPort) != true) {
    _invalid(
      '${_edgePath(edge)} target port ${_quote(edge.start.targetPort)} does not exist on ${_quote(target.id)}',
    );
  }

  final start = edge.start;
  if (start is GraphStartPolicyPortal) {
    final sourcePorts = portsByState[source.id];
    final port = sourcePorts?[start.sourcePort];
    if (port == null) {
      _invalid(
        '${_edgePath(edge)} source port ${_quote(start.sourcePort)} does not exist on ${_quote(source.id)}',
      );
    }
    if (source.body.kind != GraphBodyKind.loop &&
        port.portalFrames.last != source.body.frameCount - 1) {
      _invalid('${_edgePath(edge)} finite/held source port must include the held final frame');
    }
    final minimum = greatestPortalWaitFrames(source.body, start.sourcePort);
    if (start.maxWaitFrames < minimum) {
      _invalid(
        '${_edgePath(edge)} maxWaitFrames ${start.maxWaitFrames} is below the geometric minimum $minimum',
      );
    }
  } else if (start is GraphStartPolicyFinish) {
    if (source.body.kind == GraphBodyKind.loop) {
      _invalid('${_edgePath(edge)} finish cannot originate from a loop');
    }
    final minimum = greatestFinishWaitFrames(source.body);
    if (start.maxWaitFrames < minimum) {
      _invalid(
        '${_edgePath(edge)} maxWaitFrames ${start.maxWaitFrames} is below the finish minimum $minimum',
      );
    }
  } else {
    if (edge.transition != null) {
      _invalid('${_edgePath(edge)} cut cannot own a transition unit');
    }
    if (edge.continuity != GraphContinuity.cut) {
      _invalid('${_edgePath(edge)} cut must declare continuity cut');
    }
  }

  if (start is! GraphStartPolicyCut && edge.continuity == GraphContinuity.cut) {
    _invalid('${_edgePath(edge)} continuity cut requires start policy cut');
  }
  final transition = edge.transition;
  if (edge.continuity == GraphContinuity.exactReverse &&
      (transition is! GraphTransitionReversible || transition.reverseOf == null)) {
    _invalid(
      '${_edgePath(edge)} exact-reverse requires a reversible transition with reverseOf',
    );
  }
}

Map<GraphEdgeId, GraphEdgeDefinition> _validateReversiblePairs(
  List<GraphEdgeDefinition> edges,
  Map<GraphEdgeId, GraphEdgeDefinition> edgesById,
) {
  final groups = <String, List<GraphEdgeDefinition>>{};
  for (final edge in edges) {
    final transition = edge.transition;
    if (transition is! GraphTransitionReversible) continue;
    final group = groups[transition.unitId];
    if (group == null) {
      groups[transition.unitId] = [edge];
    } else {
      group.add(edge);
    }
  }

  final inverseEdgesById = <GraphEdgeId, GraphEdgeDefinition>{};
  for (final entry in groups.entries) {
    final unitId = entry.key;
    final group = entry.value;
    if (group.length != 2) {
      _invalid('reversible unit ${_quote(unitId)} must be used by exactly two inverse edges');
    }
    final first = group[0];
    final second = group[1];
    final firstTransition = first.transition;
    final secondTransition = second.transition;
    if (firstTransition is! GraphTransitionReversible ||
        secondTransition is! GraphTransitionReversible) {
      _invalid('reversible unit ${_quote(unitId)} has an invalid inverse pair');
    }
    if (first.from != second.to || first.to != second.from) {
      _invalid('reversible unit ${_quote(unitId)} must reverse its endpoints');
    }
    if (firstTransition.frameCount != secondTransition.frameCount) {
      _invalid('reversible unit ${_quote(unitId)} must use one frame count');
    }
    if (firstTransition.direction == secondTransition.direction) {
      _invalid('reversible unit ${_quote(unitId)} must use opposite directions');
    }

    final declaring = <GraphEdgeDefinition>[first, second].where((candidate) {
      final t = candidate.transition;
      return t is GraphTransitionReversible && t.reverseOf != null;
    }).toList();
    if (declaring.length != 1) {
      _invalid(
        'reversible unit ${_quote(unitId)} must have exactly one inverse edge with reverseOf',
      );
    }
    final inverse = declaring[0];
    final inverseTransition = inverse.transition;
    if (inverseTransition is! GraphTransitionReversible) {
      _invalid('reversible unit ${_quote(unitId)} has no inverse declaration');
    }
    final base = identical(inverse, first) ? second : first;
    if (inverseTransition.reverseOf != base.id) {
      _invalid(
        '${_edgePath(inverse)}.transition.reverseOf must reference ${_quote(base.id)}',
      );
    }
    if (edgesById[inverseTransition.reverseOf] != base) {
      _invalid('${_edgePath(inverse)}.transition.reverseOf is invalid');
    }
    if (inverse.continuity != GraphContinuity.exactReverse) {
      _invalid('${_edgePath(inverse)} must declare continuity exact-reverse');
    }
    if (base.continuity == GraphContinuity.exactReverse) {
      _invalid('${_edgePath(base)} cannot declare exact-reverse without reverseOf');
    }
    inverseEdgesById[first.id] = second;
    inverseEdgesById[second.id] = first;
  }
  return inverseEdgesById;
}

void _validateImmediateCompletionCycles(
  Map<GraphStateId, GraphEdgeDefinition> completionEdgesByState,
  Map<GraphStateId, GraphStateDefinition> statesById,
) {
  final immediate = <GraphStateId, GraphStateId>{};
  for (final entry in completionEdgesByState.entries) {
    final source = statesById[entry.key];
    if (source != null &&
        _isImmediateCompletionSource(source) &&
        entry.value.transition == null) {
      immediate[entry.key] = entry.value.to;
    }
  }

  for (final start in immediate.keys) {
    final path = <GraphStateId>{};
    GraphStateId? cursor = start;
    while (cursor != null) {
      if (path.contains(cursor)) {
        _invalid('completion routes contain an immediate cycle at ${_quote(cursor)}');
      }
      path.add(cursor);
      cursor = immediate[cursor];
    }
  }
}

bool _isImmediateCompletionSource(GraphStateDefinition state) {
  return state.body.kind == GraphBodyKind.held ||
      (state.body.kind == GraphBodyKind.finite && state.body.frameCount == 1);
}

Map<String, Object?> _expectRecord(Object? value, String path) {
  if (value is! Map) {
    _invalid('$path must be an object');
  }
  return Map<String, Object?>.from(value);
}

List<Object?> _expectArray(Object? value, String path) {
  if (value is! List) {
    _invalid('$path must be an array');
  }
  return value;
}

String _expectIdentifier(Object? value, String path) {
  if (value is! String || !graphIdentifierPattern.hasMatch(value)) {
    _invalid('$path must match ${graphIdentifierPattern.pattern}');
  }
  return value;
}

int _expectPositiveSafeInteger(Object? value, String path) {
  final asInt = _asInteger(value);
  if (asInt == null || asInt <= 0) {
    _invalid('$path must be a positive safe integer');
  }
  return asInt;
}

int _expectNonNegativeSafeInteger(Object? value, String path) {
  final asInt = _asInteger(value);
  if (asInt == null || asInt < 0) {
    _invalid('$path must be a nonnegative safe integer');
  }
  return asInt;
}

/// Accepts a Dart `int` directly, or a whole-valued `double` (as produced by
/// some JSON decoders for integral literals), mirroring how the TypeScript
/// original treats any `Number.isSafeInteger` value the same regardless of
/// whether the source was authored as `4` or `4.0`.
int? _asInteger(Object? value) {
  if (value is int) return value;
  if (value is double && value.isFinite && value == value.truncateToDouble()) {
    return value.toInt();
  }
  return null;
}

void _addUnique(Set<String> values, String value, String path, String label) {
  if (values.contains(value)) {
    _invalid('$path duplicates $label ${_quote(value)}');
  }
  values.add(value);
}

void _reserveUnit(Set<String> reservedUnitIds, String unitId, String path) {
  if (reservedUnitIds.contains(unitId)) {
    _invalid('$path duplicates unit ID ${_quote(unitId)}');
  }
  reservedUnitIds.add(unitId);
}

Map<V, GraphEdgeDefinition> _getOrCreate<K, V>(
  Map<K, Map<V, GraphEdgeDefinition>> map,
  K key,
) {
  final current = map[key];
  if (current != null) return current;
  final created = <V, GraphEdgeDefinition>{};
  map[key] = created;
  return created;
}

String _edgePath(GraphEdgeDefinition edge) => 'edge ${_quote(edge.id)}';

String _quote(String value) => jsonEncode(value);

List<GraphRingDefinition> _cloneRings(
  Object? value,
  Map<GraphStateId, GraphStateDefinition> statesById,
) {
  if (value == null) return const <GraphRingDefinition>[];
  final inputs = _expectArray(value, 'rings');
  if (inputs.length > GraphLimits.maxRings) {
    _invalid('rings must contain at most ${GraphLimits.maxRings} entries');
  }
  final rings = <GraphRingDefinition>[
    for (var index = 0; index < inputs.length; index += 1)
      _cloneRing(inputs[index], index, statesById),
  ];
  for (var index = 1; index < rings.length; index += 1) {
    if (rings[index - 1].id.compareTo(rings[index].id) >= 0) {
      _invalid('rings must be sorted and unique by id');
    }
  }
  return rings;
}

GraphRingDefinition _cloneRing(
  Object? value,
  int index,
  Map<GraphStateId, GraphStateDefinition> statesById,
) {
  final path = 'rings[$index]';
  final input = _expectRecord(value, path);
  final id = _expectIdentifier(input['id'], '$path.id');
  final cyclic = input['cyclic'];
  if (cyclic is! bool) {
    _invalid('ring ${_quote(id)} cyclic must be a boolean');
  }
  final tieBreakRaw = input['tieBreak'];
  if (tieBreakRaw != 'forward' && tieBreakRaw != 'backward') {
    _invalid('ring ${_quote(id)} tieBreak must be forward or backward');
  }
  final tieBreak = tieBreakRaw == 'forward'
      ? GraphRingTieBreak.forward
      : GraphRingTieBreak.backward;
  final stateInputs = _expectArray(input['states'], '$path.states');
  if (stateInputs.length > GraphLimits.maxRingStates) {
    _invalid(
      'ring ${_quote(id)} must contain at most ${GraphLimits.maxRingStates} states',
    );
  }
  final seen = <String>{};
  final states = <GraphStateId>[
    for (var stateIndex = 0; stateIndex < stateInputs.length; stateIndex += 1)
      () {
        final stateId = _expectIdentifier(
          stateInputs[stateIndex],
          '$path.states[$stateIndex]',
        );
        if (seen.contains(stateId)) {
          _invalid('ring ${_quote(id)} duplicates state ${_quote(stateId)}');
        }
        seen.add(stateId);
        if (!statesById.containsKey(stateId)) {
          _invalid(
            'ring ${_quote(id)} references unknown state ${_quote(stateId)}',
          );
        }
        return stateId;
      }(),
  ];
  if (states.length < 2) {
    _invalid('ring ${_quote(id)} must contain at least 2 states');
  }
  if (cyclic && states.length < 3) {
    _invalid('cyclic ring ${_quote(id)} must contain at least 3 states');
  }
  final maxChainedSteps =
      _expectPositiveSafeInteger(input['maxChainedSteps'], '$path.maxChainedSteps');
  if (maxChainedSteps > GraphLimits.maxChainedSteps) {
    _invalid(
      'ring ${_quote(id)} maxChainedSteps must be at most ${GraphLimits.maxChainedSteps}',
    );
  }
  return GraphRingDefinition(
    id: id,
    states: states,
    cyclic: cyclic,
    tieBreak: tieBreak,
    maxChainedSteps: maxChainedSteps,
  );
}

Map<GraphStateId, List<GraphRingDefinition>> _indexRingsByState(
  List<GraphRingDefinition> rings,
) {
  final byState = <GraphStateId, List<GraphRingDefinition>>{};
  for (final ring in rings) {
    for (final state in ring.states) {
      (byState[state] ??= <GraphRingDefinition>[]).add(ring);
    }
  }
  return byState;
}

void _validateRingStepOwnership(
  List<GraphRingDefinition> rings,
  Map<GraphStateId, Map<GraphStateId, GraphEdgeDefinition>> directEdgesByState,
) {
  final owners = <String, ({GraphRingId ring, GraphStateId from, GraphStateId to})>{};
  for (final ring in rings) {
    for (final pair in _ringNeighbourPairs(ring)) {
      final key = '${pair.$1}\u0000${pair.$2}';
      final owner = owners[key];
      if (owner != null) {
        _invalid(
          'rings ${_quote(owner.ring)} and ${_quote(ring.id)} both step from '
          '${_quote(pair.$1)} to ${_quote(pair.$2)}',
        );
      }
      owners[key] = (ring: ring.id, from: pair.$1, to: pair.$2);
    }
  }
  for (final owner in owners.values) {
    final edge = directEdgesByState[owner.from]?[owner.to];
    if (edge?.ring != null && edge!.ring != owner.ring) {
      _invalid(
        'edge ${_quote(edge.id)} declares ring ${_quote(edge.ring!)} but steps '
        'inside ring ${_quote(owner.ring)}',
      );
    }
  }
}

Iterable<(GraphStateId, GraphStateId)> _ringNeighbourPairs(GraphRingDefinition ring) sync* {
  final states = ring.states;
  for (var i = 0; i < states.length - 1; i += 1) {
    yield (states[i], states[i + 1]);
    yield (states[i + 1], states[i]);
  }
  if (ring.cyclic && states.length >= 2) {
    yield (states.last, states.first);
    yield (states.first, states.last);
  }
}

void _validateTurnEdge(
  GraphEdgeDefinition edge,
  Map<GraphRingId, GraphRingDefinition> ringsById,
) {
  if (edge.ring == null && edge.step == null) return;
  if (edge.ring == null || edge.step == null) {
    _invalid('edge ${_quote(edge.id)} turn membership requires both ring and step');
  }
  final ring = ringsById[edge.ring];
  if (ring == null) {
    _invalid(
      'edge ${_quote(edge.id)} references unknown ring ${_quote(edge.ring!)}',
    );
  }
}

Never _invalid(String message) => throw MotionGraphValidationError(message);
