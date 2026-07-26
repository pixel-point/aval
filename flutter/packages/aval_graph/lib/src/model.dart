/// Public data model for the AVAL motion graph.
///
/// This is a direct, field-for-field port of `packages/graph/src/model.ts`.
/// TypeScript discriminated unions become Dart sealed class hierarchies (one
/// concrete subclass per `kind`/`type` tag); TypeScript interfaces become
/// immutable Dart classes with `final` fields; TypeScript `readonly T[]`
/// becomes a `List<T>` defensively copied into an unmodifiable list by the
/// constructor. TypeScript `number` frame/sequence counters become Dart
/// `int`; the TypeScript `bigint` content ordinal becomes Dart `BigInt`.
library;

/// A state's stable identifier. Alias kept for readability parity with the
/// TypeScript `GraphStateId` type alias.
typedef GraphStateId = String;

/// An edge's stable identifier.
typedef GraphEdgeId = String;

/// A body, transition, or intro clip's stable identifier.
typedef GraphUnitId = String;

/// A facing / locomotion ring's stable identifier.
typedef GraphRingId = String;

/// Which arc a ring prefers when both directions are equally long.
enum GraphRingTieBreak {
  forward,
  backward;
}

/// One signed step along a ring: `1` walks forward, `-1` walks backward.
typedef GraphTurnStep = int;

/// How a multi-step ring request is served.
///
/// [chain] walks every intermediate state (frame continuity). [direct]
/// collapses the arc into its departure boundary for reduced-motion hosts.
enum MotionGraphTurnPolicy {
  chain,
  direct;
}

/// Direction of travel for a reversible transition or its live presentation.
enum TransitionDirection {
  forward,
  reverse;
}

/// One authored departure/arrival handoff frame on a body.
class GraphPortDefinition {
  GraphPortDefinition({required this.id, required List<int> portalFrames})
      : portalFrames = List.unmodifiable(portalFrames);

  final String id;

  /// Always `0`; ports enter at the first authored frame of their body.
  int get entryFrame => 0;

  final List<int> portalFrames;

  @override
  String toString() =>
      'GraphPortDefinition(id: $id, entryFrame: 0, portalFrames: $portalFrames)';
}

/// Kind of content a state's body loops, finishes, or holds.
enum GraphBodyKind {
  loop,
  finite,
  held;
}

/// The looping/finite/held clip a state presents while stable.
class GraphBodyDefinition {
  GraphBodyDefinition({
    required this.unitId,
    required this.kind,
    required this.frameCount,
    required List<GraphPortDefinition> ports,
  }) : ports = List.unmodifiable(ports);

  final GraphUnitId unitId;
  final GraphBodyKind kind;
  final int frameCount;
  final List<GraphPortDefinition> ports;
}

/// A one-shot clip authored to precede the initial state's body exactly once.
class GraphInitialUnitDefinition {
  const GraphInitialUnitDefinition({
    required this.unitId,
    required this.frameCount,
  });

  final GraphUnitId unitId;
  final int frameCount;
}

/// One node of the graph: an identity, its body, and an optional intro.
class GraphStateDefinition {
  const GraphStateDefinition({
    required this.id,
    required this.body,
    this.initialUnit,
  });

  final GraphStateId id;
  final GraphBodyDefinition body;
  final GraphInitialUnitDefinition? initialUnit;
}

/// The authored geometry used to decide when an edge may begin departure.
sealed class GraphStartPolicy {
  const GraphStartPolicy();

  int get maxWaitFrames;

  /// The port an edge arrives at on its target state. Common to every
  /// variant (portal, finish, cut) so validation and routing code can read
  /// it without a `switch`.
  String get targetPort;
}

/// Depart from a named port at or after its next eligible portal frame.
class GraphStartPolicyPortal extends GraphStartPolicy {
  const GraphStartPolicyPortal({
    required this.sourcePort,
    required this.targetPort,
    required this.maxWaitFrames,
  });

  final String sourcePort;
  @override
  final String targetPort;

  @override
  final int maxWaitFrames;
}

/// Depart only once the source body reaches its final authored frame.
class GraphStartPolicyFinish extends GraphStartPolicy {
  const GraphStartPolicyFinish({
    required this.targetPort,
    required this.maxWaitFrames,
  });

  @override
  final String targetPort;

  @override
  final int maxWaitFrames;
}

/// Depart immediately on the next tick, bypassing all body geometry.
class GraphStartPolicyCut extends GraphStartPolicy {
  const GraphStartPolicyCut({required this.targetPort});

  @override
  final String targetPort;

  /// Always `1`; a cut has no geometric wait.
  @override
  int get maxWaitFrames => 1;
}

/// The unit (and its geometry) an edge owns while actively transitioning.
sealed class GraphTransitionDefinition {
  const GraphTransitionDefinition({
    required this.unitId,
    required this.frameCount,
  });

  final GraphUnitId unitId;
  final int frameCount;
}

/// A one-directional transition clip that always plays to completion.
class GraphTransitionLocked extends GraphTransitionDefinition {
  const GraphTransitionLocked({
    required super.unitId,
    required super.frameCount,
  });
}

/// A transition clip shared by an authored/inverse edge pair.
class GraphTransitionReversible extends GraphTransitionDefinition {
  const GraphTransitionReversible({
    required super.unitId,
    required super.frameCount,
    required this.direction,
    this.reverseOf,
  });

  final TransitionDirection direction;

  /// The edge ID this edge is the authored inverse of, if it declares one.
  final GraphEdgeId? reverseOf;
}

/// What causes an edge to become eligible for routing.
sealed class GraphEdgeTrigger {
  const GraphEdgeTrigger();
}

/// The edge is only selectable by an explicit `send(event)` call.
class GraphEdgeTriggerEvent extends GraphEdgeTrigger {
  const GraphEdgeTriggerEvent(this.name);

  final String name;
}

/// The edge fires automatically when its source state's body finishes.
class GraphEdgeTriggerCompletion extends GraphEdgeTrigger {
  const GraphEdgeTriggerCompletion();
}

/// How visual continuity is preserved across an edge's departure/arrival.
enum GraphContinuity {
  exactAuthored('exact-authored'),
  exactReverse('exact-reverse'),
  cut('cut');

  const GraphContinuity(this.wireValue);

  final String wireValue;
}

/// One authored connection between two states.
class GraphEdgeDefinition {
  const GraphEdgeDefinition({
    required this.id,
    required this.from,
    required this.to,
    required this.start,
    required this.continuity,
    this.trigger,
    this.transition,
    this.ring,
    this.step,
  });

  final GraphEdgeId id;
  final GraphStateId from;
  final GraphStateId to;
  final GraphEdgeTrigger? trigger;
  final GraphStartPolicy start;
  final GraphTransitionDefinition? transition;
  final GraphContinuity continuity;

  /// Ring this edge steps along. Present on turn edges only.
  final GraphRingId? ring;

  /// Signed adjacency offset inside [ring]. Present on turn edges only (`1` or `-1`).
  final GraphTurnStep? step;
}

/// An ordered set of states along one axis. Adjacent members are joined by turn
/// edges so multi-step requests chain single steps rather than authoring every pair.
class GraphRingDefinition {
  GraphRingDefinition({
    required this.id,
    required List<GraphStateId> states,
    required this.cyclic,
    required this.tieBreak,
    required this.maxChainedSteps,
  }) : states = List.unmodifiable(states);

  final GraphRingId id;
  final List<GraphStateId> states;
  final bool cyclic;
  final GraphRingTieBreak tieBreak;
  final int maxChainedSteps;
}

/// An untrusted, author-supplied graph definition.
class MotionGraphDefinition {
  MotionGraphDefinition({
    required this.initialState,
    required List<GraphStateDefinition> states,
    required List<GraphEdgeDefinition> edges,
    List<GraphRingDefinition>? rings,
  })  : states = List.unmodifiable(states),
        edges = List.unmodifiable(edges),
        rings = rings == null ? null : List.unmodifiable(rings);

  final GraphStateId initialState;
  final List<GraphStateDefinition> states;
  final List<GraphEdgeDefinition> edges;
  final List<GraphRingDefinition>? rings;
}

/// A definition that has passed [validateMotionGraphDefinition].
///
/// Unlike the TypeScript original — where `ValidatedMotionGraph` carries a
/// compile-time-only `unique symbol` brand with *no* runtime enforcement —
/// Dart has no equivalent nominal-typing trick, so this class is a plain,
/// publicly constructible wrapper. The actual trust boundary lives where it
/// always lived at runtime in the TypeScript version too:
/// `getValidatedGraphIndexes` looks the instance up by identity in an
/// `Expando` populated only by `validateMotionGraphDefinition`, and throws
/// `MotionGraphValidationError` for any instance that was not produced by
/// it (see `validate.dart`).
class ValidatedMotionGraph {
  const ValidatedMotionGraph(this.definition);

  final MotionGraphDefinition definition;
}

/// Coarse lifecycle stage of the engine, independent of routing detail.
enum MotionGraphReadiness {
  unready,
  preparing,
  animated,
  static,
  disposed,
  error;
}

/// Fine-grained tick behavior of the engine.
enum MotionGraphPhase {
  unready,
  preparing,
  intro,
  stable,
  waiting,
  locked,
  reversible,
  static,
  disposed,
  error;
}

/// The exact frame the host should draw right now.
sealed class GraphPresentation {
  const GraphPresentation();
}

class GraphPresentationStatic extends GraphPresentation {
  const GraphPresentationStatic({required this.state});

  final GraphStateId state;

  @override
  bool operator ==(Object other) =>
      other is GraphPresentationStatic && other.state == state;

  @override
  int get hashCode => Object.hash(GraphPresentationStatic, state);

  @override
  String toString() => 'GraphPresentation.static(state: $state)';
}

class GraphPresentationIntro extends GraphPresentation {
  const GraphPresentationIntro({
    required this.state,
    required this.unitId,
    required this.frameIndex,
  });

  final GraphStateId state;
  final GraphUnitId unitId;
  final int frameIndex;

  @override
  bool operator ==(Object other) =>
      other is GraphPresentationIntro &&
      other.state == state &&
      other.unitId == unitId &&
      other.frameIndex == frameIndex;

  @override
  int get hashCode => Object.hash(GraphPresentationIntro, state, unitId, frameIndex);

  @override
  String toString() =>
      'GraphPresentation.intro(state: $state, unitId: $unitId, frameIndex: $frameIndex)';
}

class GraphPresentationBody extends GraphPresentation {
  const GraphPresentationBody({
    required this.state,
    required this.unitId,
    required this.frameIndex,
  });

  final GraphStateId state;
  final GraphUnitId unitId;
  final int frameIndex;

  @override
  bool operator ==(Object other) =>
      other is GraphPresentationBody &&
      other.state == state &&
      other.unitId == unitId &&
      other.frameIndex == frameIndex;

  @override
  int get hashCode => Object.hash(GraphPresentationBody, state, unitId, frameIndex);

  @override
  String toString() =>
      'GraphPresentation.body(state: $state, unitId: $unitId, frameIndex: $frameIndex)';
}

class GraphPresentationLocked extends GraphPresentation {
  const GraphPresentationLocked({
    required this.edgeId,
    required this.unitId,
    required this.frameIndex,
  });

  final GraphEdgeId edgeId;
  final GraphUnitId unitId;
  final int frameIndex;

  @override
  bool operator ==(Object other) =>
      other is GraphPresentationLocked &&
      other.edgeId == edgeId &&
      other.unitId == unitId &&
      other.frameIndex == frameIndex;

  @override
  int get hashCode => Object.hash(GraphPresentationLocked, edgeId, unitId, frameIndex);

  @override
  String toString() =>
      'GraphPresentation.locked(edgeId: $edgeId, unitId: $unitId, frameIndex: $frameIndex)';
}

class GraphPresentationReversible extends GraphPresentation {
  const GraphPresentationReversible({
    required this.edgeId,
    required this.unitId,
    required this.frameIndex,
    required this.direction,
  });

  final GraphEdgeId edgeId;
  final GraphUnitId unitId;
  final int frameIndex;
  final TransitionDirection direction;

  @override
  bool operator ==(Object other) =>
      other is GraphPresentationReversible &&
      other.edgeId == edgeId &&
      other.unitId == unitId &&
      other.frameIndex == frameIndex &&
      other.direction == direction;

  @override
  int get hashCode =>
      Object.hash(GraphPresentationReversible, edgeId, unitId, frameIndex, direction);

  @override
  String toString() =>
      'GraphPresentation.reversible(edgeId: $edgeId, unitId: $unitId, '
      'frameIndex: $frameIndex, direction: $direction)';
}

/// Why a request's settlement resolved.
enum GraphSettlementResolveReason {
  stableNoop('stable-noop'),
  targetCommitted('target-committed'),
  staticRecovery('static-recovery');

  const GraphSettlementResolveReason(this.wireValue);

  final String wireValue;
}

/// The rejection classification exposed by a settled request.
enum GraphSettlementError {
  notReadyError('NotReadyError'),
  routeError('RouteError'),
  inputOverflowError('InputOverflowError'),
  abortError('AbortError'),
  playbackFallbackError('PlaybackFallbackError');

  const GraphSettlementError(this.wireValue);

  final String wireValue;
}

/// The host is always expected to apply this timing to a settlement; there
/// is currently exactly one value, mirroring the TypeScript literal type
/// `"microtask"`.
enum SettlementTiming {
  microtask;
}

/// The outcome of a settled request-completion group.
sealed class GraphSettlement {
  const GraphSettlement();

  SettlementTiming get timing => SettlementTiming.microtask;
}

class GraphSettlementResolve extends GraphSettlement {
  const GraphSettlementResolve(this.reason);

  final GraphSettlementResolveReason reason;

  @override
  bool operator ==(Object other) =>
      other is GraphSettlementResolve && other.reason == reason;

  @override
  int get hashCode => Object.hash(GraphSettlementResolve, reason);

  @override
  String toString() => 'GraphSettlement.resolve(reason: $reason)';
}

class GraphSettlementReject extends GraphSettlement {
  const GraphSettlementReject(this.error);

  final GraphSettlementError error;

  @override
  bool operator ==(Object other) =>
      other is GraphSettlementReject && other.error == error;

  @override
  int get hashCode => Object.hash(GraphSettlementReject, error);

  @override
  String toString() => 'GraphSettlement.reject(error: $error)';
}

/// One observable side effect emitted by an engine operation, in the exact
/// order the engine produced it.
sealed class MotionGraphEffect {
  const MotionGraphEffect();
}

class MotionGraphEffectReadinessChange extends MotionGraphEffect {
  const MotionGraphEffectReadinessChange({
    required this.from,
    required this.to,
    this.reason,
  });

  final MotionGraphReadiness from;
  final MotionGraphReadiness to;
  final String? reason;

  @override
  bool operator ==(Object other) =>
      other is MotionGraphEffectReadinessChange &&
      other.from == from &&
      other.to == to &&
      other.reason == reason;

  @override
  int get hashCode =>
      Object.hash(MotionGraphEffectReadinessChange, from, to, reason);

  @override
  String toString() =>
      'MotionGraphEffect.readinessChange(from: $from, to: $to, reason: $reason)';
}

class MotionGraphEffectRequestedStateChange extends MotionGraphEffect {
  const MotionGraphEffectRequestedStateChange({
    required this.from,
    required this.to,
    required this.sequence,
  });

  final GraphStateId from;
  final GraphStateId to;
  final int sequence;

  @override
  bool operator ==(Object other) =>
      other is MotionGraphEffectRequestedStateChange &&
      other.from == from &&
      other.to == to &&
      other.sequence == sequence;

  @override
  int get hashCode =>
      Object.hash(MotionGraphEffectRequestedStateChange, from, to, sequence);

  @override
  String toString() =>
      'MotionGraphEffect.requestedStateChange(from: $from, to: $to, sequence: $sequence)';
}

class MotionGraphEffectTransitionStart extends MotionGraphEffect {
  const MotionGraphEffectTransitionStart({
    required this.edgeId,
    required this.from,
    required this.to,
    required this.sequence,
  });

  final GraphEdgeId edgeId;
  final GraphStateId from;
  final GraphStateId to;
  final int sequence;

  @override
  bool operator ==(Object other) =>
      other is MotionGraphEffectTransitionStart &&
      other.edgeId == edgeId &&
      other.from == from &&
      other.to == to &&
      other.sequence == sequence;

  @override
  int get hashCode =>
      Object.hash(MotionGraphEffectTransitionStart, edgeId, from, to, sequence);

  @override
  String toString() =>
      'MotionGraphEffect.transitionStart(edgeId: $edgeId, from: $from, to: $to, '
      'sequence: $sequence)';
}

class MotionGraphEffectVisualStateChange extends MotionGraphEffect {
  const MotionGraphEffectVisualStateChange({
    required this.from,
    required this.to,
  });

  final GraphStateId from;
  final GraphStateId to;

  @override
  bool operator ==(Object other) =>
      other is MotionGraphEffectVisualStateChange &&
      other.from == from &&
      other.to == to;

  @override
  int get hashCode => Object.hash(MotionGraphEffectVisualStateChange, from, to);

  @override
  String toString() =>
      'MotionGraphEffect.visualStateChange(from: $from, to: $to)';
}

class MotionGraphEffectTransitionEnd extends MotionGraphEffect {
  const MotionGraphEffectTransitionEnd({
    required this.edgeId,
    required this.from,
    required this.to,
  });

  final GraphEdgeId edgeId;
  final GraphStateId from;
  final GraphStateId to;

  @override
  bool operator ==(Object other) =>
      other is MotionGraphEffectTransitionEnd &&
      other.edgeId == edgeId &&
      other.from == from &&
      other.to == to;

  @override
  int get hashCode =>
      Object.hash(MotionGraphEffectTransitionEnd, edgeId, from, to);

  @override
  String toString() =>
      'MotionGraphEffect.transitionEnd(edgeId: $edgeId, from: $from, to: $to)';
}

class MotionGraphEffectFallback extends MotionGraphEffect {
  const MotionGraphEffectFallback({required this.reason});

  final String reason;

  @override
  bool operator ==(Object other) =>
      other is MotionGraphEffectFallback && other.reason == reason;

  @override
  int get hashCode => Object.hash(MotionGraphEffectFallback, reason);

  @override
  String toString() => 'MotionGraphEffect.fallback(reason: $reason)';
}

class MotionGraphEffectSettle extends MotionGraphEffect {
  MotionGraphEffectSettle({
    required List<int> requestIds,
    required this.outcome,
  }) : requestIds = List.unmodifiable(requestIds);

  final List<int> requestIds;
  final GraphSettlement outcome;

  @override
  bool operator ==(Object other) =>
      other is MotionGraphEffectSettle &&
      listEquals(other.requestIds, requestIds) &&
      other.outcome == outcome;

  @override
  int get hashCode =>
      Object.hash(MotionGraphEffectSettle, Object.hashAll(requestIds), outcome);

  @override
  String toString() =>
      'MotionGraphEffect.settle(requestIds: $requestIds, outcome: $outcome)';
}

/// Immutable snapshot of every observable engine field at one instant.
class MotionGraphSnapshot {
  const MotionGraphSnapshot({
    required this.readiness,
    required this.phase,
    required this.initialUnitPending,
    required this.requestedState,
    required this.visualState,
    required this.prospectiveState,
    required this.isTransitioning,
    required this.presentation,
    required this.pendingEdgeId,
    required this.activeEdgeId,
    required this.followOnEdgeId,
    required this.direction,
    required this.contentOrdinal,
    required this.inputSequence,
    required this.pendingRequestCount,
    required this.inputsSinceTick,
    required this.routeOperationsLastTick,
  });

  final MotionGraphReadiness readiness;
  final MotionGraphPhase phase;

  /// Whether the authored initial unit remains eligible before the initial
  /// body.
  final bool initialUnitPending;
  final GraphStateId? requestedState;
  final GraphStateId? visualState;
  final GraphStateId? prospectiveState;
  final bool isTransitioning;
  final GraphPresentation? presentation;
  final GraphEdgeId? pendingEdgeId;
  final GraphEdgeId? activeEdgeId;
  final GraphEdgeId? followOnEdgeId;
  final TransitionDirection? direction;
  final BigInt? contentOrdinal;
  final int inputSequence;
  final int pendingRequestCount;
  final int inputsSinceTick;
  final int routeOperationsLastTick;

  @override
  bool operator ==(Object other) =>
      other is MotionGraphSnapshot &&
      other.readiness == readiness &&
      other.phase == phase &&
      other.initialUnitPending == initialUnitPending &&
      other.requestedState == requestedState &&
      other.visualState == visualState &&
      other.prospectiveState == prospectiveState &&
      other.isTransitioning == isTransitioning &&
      other.presentation == presentation &&
      other.pendingEdgeId == pendingEdgeId &&
      other.activeEdgeId == activeEdgeId &&
      other.followOnEdgeId == followOnEdgeId &&
      other.direction == direction &&
      other.contentOrdinal == contentOrdinal &&
      other.inputSequence == inputSequence &&
      other.pendingRequestCount == pendingRequestCount &&
      other.inputsSinceTick == inputsSinceTick &&
      other.routeOperationsLastTick == routeOperationsLastTick;

  @override
  int get hashCode => Object.hash(
        readiness,
        phase,
        initialUnitPending,
        requestedState,
        visualState,
        prospectiveState,
        isTransitioning,
        presentation,
        pendingEdgeId,
        Object.hash(
          activeEdgeId,
          followOnEdgeId,
          direction,
          contentOrdinal,
          inputSequence,
          pendingRequestCount,
          inputsSinceTick,
          routeOperationsLastTick,
        ),
      );

  @override
  String toString() =>
      'MotionGraphSnapshot(readiness: $readiness, phase: $phase, '
      'requestedState: $requestedState, visualState: $visualState, '
      'prospectiveState: $prospectiveState, presentation: $presentation)';
}

/// Which public engine method produced a [MotionGraphResult].
enum MotionGraphOperation {
  install('install'),
  beginAnimated('begin-animated'),
  resumeAnimated('resume-animated'),
  beginStatic('begin-static'),
  recoverStatic('recover-static'),
  failStatic('fail-static'),
  request('request'),
  send('send'),
  tick('tick'),
  dispose('dispose');

  const MotionGraphOperation(this.wireValue);

  final String wireValue;
}

/// The full, immutable outcome of one engine operation.
class MotionGraphResult {
  MotionGraphResult({
    required this.operation,
    required this.presentation,
    required List<MotionGraphEffect> effects,
    required this.snapshot,
    this.accepted,
    this.joined,
    this.sequence,
    this.requestId,
  }) : effects = List.unmodifiable(effects);

  final MotionGraphOperation operation;
  final bool? accepted;
  final bool? joined;
  final int? sequence;
  final int? requestId;
  final GraphPresentation? presentation;
  final List<MotionGraphEffect> effects;
  final MotionGraphSnapshot snapshot;

  @override
  bool operator ==(Object other) =>
      other is MotionGraphResult &&
      other.operation == operation &&
      other.accepted == accepted &&
      other.joined == joined &&
      other.sequence == sequence &&
      other.requestId == requestId &&
      other.presentation == presentation &&
      listEquals(other.effects, effects) &&
      other.snapshot == snapshot;

  @override
  int get hashCode => Object.hash(
        operation,
        accepted,
        joined,
        sequence,
        requestId,
        presentation,
        Object.hashAll(effects),
        snapshot,
      );

  @override
  String toString() =>
      'MotionGraphResult(operation: $operation, accepted: $accepted, '
      'presentation: $presentation, effects: $effects)';
}

/// Per-tick content clock supplied by the host.
class MotionGraphTickOptions {
  const MotionGraphTickOptions({required this.contentOrdinal, this.routeReady});

  final BigInt contentOrdinal;
  final bool? routeReady;
}

/// Host-supplied last successful draw identity for a failed presentation.
class MotionGraphStaticFailureOptions {
  const MotionGraphStaticFailureOptions({this.retainedVisualState});

  final GraphStateId? retainedVisualState;
}

/// Last pixels actually drawn when an animated graph tick failed mid-barrier.
class MotionGraphRecoveryOptions {
  const MotionGraphRecoveryOptions({this.retainedVisualState});

  final GraphStateId? retainedVisualState;
}

/// Host-supplied last successful draw identity for terminal disposal.
class MotionGraphDisposeOptions {
  const MotionGraphDisposeOptions({this.retainedVisualState});

  final GraphStateId? retainedVisualState;
}

/// One retained entry of the engine's bounded operation trace.
class MotionGraphTraceRecord {
  const MotionGraphTraceRecord({required this.index, required this.result});

  final int index;
  final MotionGraphResult result;

  @override
  bool operator ==(Object other) =>
      other is MotionGraphTraceRecord &&
      other.index == index &&
      other.result == result;

  @override
  int get hashCode => Object.hash(index, result);

  @override
  String toString() => 'MotionGraphTraceRecord(index: $index, result: $result)';
}

/// Structural equality for two lists, comparing elements with `==`.
///
/// Dart classes do not receive automatic structural equality the way plain
/// TypeScript objects do, and this package intentionally has no dependency
/// beyond the Dart SDK and `package:test` (so `package:collection`'s
/// `ListEquality` is unavailable). This tiny helper is shared by every
/// `List`-carrying value type in this library.
bool listEquals<T>(List<T> a, List<T> b) {
  if (identical(a, b)) return true;
  if (a.length != b.length) return false;
  for (var index = 0; index < a.length; index += 1) {
    if (a[index] != b[index]) return false;
  }
  return true;
}
