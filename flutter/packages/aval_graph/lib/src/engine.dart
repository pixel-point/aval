/// Pure version-0 graph reducer, ported from
/// `packages/graph/src/engine.ts`.
///
/// It owns authored cursors and emits abstract presentations/effects; hosts
/// own timers, codecs, and rendering.
library;

import 'errors.dart';
import 'engine_state.dart';
import 'intent_router.dart';
import 'model.dart';
import 'operation_journal.dart';
import 'portal_search.dart';
import 'request_ledger.dart';
import 'ring_plan.dart';

class MotionGraphEngine {
  MotionGraphEngine({MotionGraphTurnPolicy turnPolicy = MotionGraphTurnPolicy.chain})
      : _turnPolicy = turnPolicy;

  final MotionGraphEngineState _runtime = MotionGraphEngineState();
  final MotionGraphTurnPolicy _turnPolicy;

  MotionGraphTurnPolicy get turnPolicy => _turnPolicy;

  /// Installs a graph definition. [definition] may be raw, untrusted data
  /// (validated internally — see `validate.dart`) or an already-validated
  /// [ValidatedMotionGraph].
  MotionGraphResult install(Object? definition) {
    if (_runtime.readiness != MotionGraphReadiness.unready) {
      throw const MotionGraphError(
        MotionGraphErrorCode.graphValidation,
        'graph metadata can only be installed once',
      );
    }
    final initial = _runtime.installMetadata(definition);
    _runtime.requestedState = initial;
    _runtime.visualState = initial;
    _runtime.presentation = GraphPresentationStatic(state: initial);
    final effects = <MotionGraphEffect>[];
    _changeReadiness(MotionGraphReadiness.preparing, effects);
    _runtime.phase = MotionGraphPhase.preparing;
    return _runtime.record(MotionGraphOperation.install, effects);
  }

  MotionGraphResult beginAnimated() {
    _runtime.assertPhase(MotionGraphPhase.preparing, 'beginAnimated');
    final effects = <MotionGraphEffect>[];
    _changeReadiness(MotionGraphReadiness.animated, effects);
    final initial = _runtime.definition().initialState;
    final state = _runtime.state(initial);

    final initialUnit = state.initialUnit;
    if (initialUnit != null) {
      _runtime.phase = MotionGraphPhase.intro;
      _runtime.presentation = GraphPresentationIntro(
        state: initial,
        unitId: initialUnit.unitId,
        frameIndex: 0,
      );
    } else {
      _runtime.presentation = _runtime.bodyPresentation(initial, 0);
      _runtime.phase =
          _runtime.routes.pending == null ? MotionGraphPhase.stable : MotionGraphPhase.waiting;
    }
    return _runtime.record(MotionGraphOperation.beginAnimated, effects);
  }

  MotionGraphResult resumeAnimated() {
    _runtime.assertPhase(MotionGraphPhase.static, 'resumeAnimated');
    if (_runtime.readiness != MotionGraphReadiness.static) {
      throw const MotionGraphError(
        MotionGraphErrorCode.notReady,
        'resumeAnimated requires static readiness',
      );
    }
    final presentation = _runtime.presentation;
    final requested = _runtime.requireRequestedState();
    final visual = _runtime.requireVisualState();
    if (presentation is! GraphPresentationStatic ||
        presentation.state != visual ||
        requested != visual ||
        _runtime.routes.hasRoute() ||
        _runtime.ledger.pendingRequestCount != 0) {
      throw const MotionGraphError(
        MotionGraphErrorCode.notReady,
        'resumeAnimated requires one settled static state',
      );
    }
    final effects = <MotionGraphEffect>[];
    _changeReadiness(MotionGraphReadiness.animated, effects);
    final state = _runtime.state(visual);
    final firstAnimatedActivation = _runtime.initialUnitPending;
    final initialUnit = state.initialUnit;
    if (firstAnimatedActivation &&
        visual == _runtime.definition().initialState &&
        initialUnit != null) {
      _runtime.presentation = GraphPresentationIntro(
        state: visual,
        unitId: initialUnit.unitId,
        frameIndex: 0,
      );
      _runtime.phase = MotionGraphPhase.intro;
    } else {
      _runtime.presentation = _runtime.bodyPresentation(visual, 0);
      _runtime.phase = MotionGraphPhase.stable;
    }
    return _runtime.record(MotionGraphOperation.resumeAnimated, effects);
  }

  MotionGraphResult beginStatic(String reason) {
    _runtime.assertPhase(MotionGraphPhase.preparing, 'beginStatic');
    final effects = <MotionGraphEffect>[];
    _changeReadiness(MotionGraphReadiness.static, effects, reason: reason);
    effects.add(MotionGraphEffectFallback(reason: reason));
    _runtime.phase = MotionGraphPhase.static;

    final visual = _runtime.requireVisualState();
    final requested = _runtime.requireRequestedState();
    if (visual != requested) {
      final edge = _runtime.edgeDirect(visual, requested);
      if (edge == null) {
        throw MotionGraphError(
          MotionGraphErrorCode.routeNotFound,
          'prepared target $requested has no direct route from $visual',
        );
      }
      _commitStaticEdge(
        edge,
        _runtime.routes.pending?.sequence ?? _runtime.journal.inputSequence,
        effects,
        true,
      );
    } else {
      _runtime.presentation = _runtime.staticPresentation(visual);
      _runtime.routes.clear();
    }
    return _runtime.record(MotionGraphOperation.beginStatic, effects);
  }

  MotionGraphResult recoverStatic(
    String reason, [
    MotionGraphRecoveryOptions options = const MotionGraphRecoveryOptions(),
  ]) {
    _runtime.assertInstalled('recoverStatic');
    if (_runtime.readiness == MotionGraphReadiness.disposed ||
        _runtime.readiness == MotionGraphReadiness.error) {
      throw const MotionGraphError(
        MotionGraphErrorCode.disposed,
        'graph cannot recover after termination',
      );
    }
    final retainedVisualState = options.retainedVisualState;
    if (retainedVisualState != null && !_runtime.hasState(retainedVisualState)) {
      throw const MotionGraphError(
        MotionGraphErrorCode.graphValidation,
        'retained recovery visual state is not installed',
      );
    }
    final effects = <MotionGraphEffect>[];
    _changeReadiness(MotionGraphReadiness.static, effects, reason: reason);
    effects.add(MotionGraphEffectFallback(reason: reason));
    final graphVisual = _runtime.requireVisualState();
    if (retainedVisualState != null) _runtime.visualState = retainedVisualState;
    final visual = _runtime.requireVisualState();
    final requested = _runtime.requireRequestedState();

    if (visual != requested || _runtime.routes.hasRoute()) {
      final recovery = _runtime.routes.recoveryCandidate();
      final retainedOverride =
          retainedVisualState != null && retainedVisualState != graphVisual;
      final edge = retainedOverride
          ? _runtime.edgeDirect(visual, requested)
          : recovery?.edge ?? _runtime.edgeDirect(visual, requested);
      if (edge != null) {
        final hadStarted =
            !retainedOverride && _runtime.routes.active?.edge.id == edge.id;
        if (!hadStarted) {
          effects.add(
            _transitionStart(edge, recovery?.sequence ?? _runtime.journal.inputSequence),
          );
        }
        _runtime.presentation = _runtime.staticPresentation(requested);
        _setVisualState(requested, effects);
        effects.add(_transitionEnd(edge));
      } else {
        _runtime.presentation = _runtime.staticPresentation(requested);
        _setVisualState(requested, effects);
      }
      final settlement = _runtime.ledger.settlePending(
        const GraphSettlementResolve(GraphSettlementResolveReason.staticRecovery),
      );
      if (settlement != null) effects.add(settlement);
    } else {
      _runtime.presentation = _runtime.staticPresentation(visual);
    }
    _runtime.routes.clear();
    _runtime.phase = MotionGraphPhase.static;
    return _runtime.record(MotionGraphOperation.recoverStatic, effects);
  }

  MotionGraphResult failStatic([
    String message = 'static fallback could not be installed',
    MotionGraphStaticFailureOptions options = const MotionGraphStaticFailureOptions(),
  ]) {
    _runtime.assertInstalled('failStatic');
    if (_runtime.readiness == MotionGraphReadiness.disposed) {
      throw const MotionGraphError(
        MotionGraphErrorCode.disposed,
        'disposed graph cannot fail static',
      );
    }
    final retainedVisualState = options.retainedVisualState;
    if (retainedVisualState != null && !_runtime.hasState(retainedVisualState)) {
      throw const MotionGraphError(
        MotionGraphErrorCode.graphValidation,
        'retained visual state is not installed',
      );
    }
    final effects = <MotionGraphEffect>[];
    _changeReadiness(MotionGraphReadiness.error, effects, reason: message);
    if (retainedVisualState != null) {
      _runtime.visualState = retainedVisualState;
      _runtime.presentation = _runtime.staticPresentation(retainedVisualState);
    }
    final settlement = _runtime.ledger.settlePending(
      const GraphSettlementReject(GraphSettlementError.playbackFallbackError),
    );
    if (settlement != null) effects.add(settlement);
    _runtime.routes.clear();
    _runtime.phase = MotionGraphPhase.error;
    return _runtime.record(MotionGraphOperation.failStatic, effects);
  }

  MotionGraphResult request(GraphStateId target) {
    final input = _runtime.journal.beginInput();
    if (!input.withinLimit) {
      final standalone = _runtime.ledger.settleNew(
        const GraphSettlementReject(GraphSettlementError.inputOverflowError),
      );
      return _runtime.record(
        MotionGraphOperation.request,
        [standalone.effect],
        metadata: OperationResultMetadata(
          accepted: false,
          joined: false,
          sequence: input.sequence,
          requestId: standalone.requestId,
        ),
      );
    }

    if (_runtime.readiness == MotionGraphReadiness.unready) {
      return _rejectedRequest(target, input.sequence, GraphSettlementError.notReadyError);
    }
    if (_runtime.readiness == MotionGraphReadiness.disposed ||
        _runtime.readiness == MotionGraphReadiness.error) {
      return _rejectedRequest(target, input.sequence, GraphSettlementError.abortError);
    }
    if (!_runtime.hasState(target)) {
      return _rejectedRequest(target, input.sequence, GraphSettlementError.routeError);
    }

    return _applyStateIntent(planStateIntent(_intentContext(), target), target, input.sequence);
  }

  MotionGraphResult send(String event) {
    final input = _runtime.journal.beginInput();
    if (!input.withinLimit || _runtime.readiness == MotionGraphReadiness.unready) {
      return _runtime.record(
        MotionGraphOperation.send,
        const [],
        metadata: OperationResultMetadata(accepted: false, sequence: input.sequence),
      );
    }
    if (_runtime.readiness == MotionGraphReadiness.disposed ||
        _runtime.readiness == MotionGraphReadiness.error) {
      return _runtime.record(
        MotionGraphOperation.send,
        const [],
        metadata: OperationResultMetadata(accepted: false, sequence: input.sequence),
      );
    }

    final plan = planEventIntent(_intentContext(), event);
    if (plan is EventIntentPlanReject) {
      return _runtime.record(
        MotionGraphOperation.send,
        const [],
        metadata: OperationResultMetadata(accepted: false, sequence: input.sequence),
      );
    }
    final effects = <MotionGraphEffect>[];
    _applyEventIntent(plan, input.sequence, effects);
    return _runtime.record(
      MotionGraphOperation.send,
      effects,
      metadata: OperationResultMetadata(accepted: true, sequence: input.sequence),
    );
  }

  /// Whether `send(event)` would be accepted now, without allocating an
  /// input.
  bool canSend(String event) {
    if (!_runtime.journal.canBeginInput() ||
        _runtime.readiness == MotionGraphReadiness.unready ||
        _runtime.readiness == MotionGraphReadiness.disposed ||
        _runtime.readiness == MotionGraphReadiness.error) {
      return false;
    }
    return planEventIntent(_intentContext(), event) is! EventIntentPlanReject;
  }

  /// Landings [request] would visit now, in order, or `null` when unreachable.
  /// An empty plan means the target is already held. Does not advance the graph.
  List<GraphStateId>? planFor(GraphStateId target) {
    if (_runtime.readiness == MotionGraphReadiness.unready ||
        _runtime.readiness == MotionGraphReadiness.disposed ||
        _runtime.readiness == MotionGraphReadiness.error ||
        !_runtime.hasState(target)) {
      return null;
    }
    final source = _departureState();
    if (source == null) return null;
    if (source == target) return const <GraphStateId>[];
    if (_runtime.edgeDirect(source, target) != null) {
      return List<GraphStateId>.unmodifiable(<GraphStateId>[target]);
    }
    final route = resolveRingRoute(_runtime.indexes(), source, target);
    if (route is! RingRouteArc) return null;
    if (_turnPolicy == MotionGraphTurnPolicy.direct) {
      return List<GraphStateId>.unmodifiable(<GraphStateId>[target]);
    }
    return List<GraphStateId>.unmodifiable(route.states);
  }

  GraphStateId? _departureState() {
    final visual = _runtime.visualState;
    if (visual == null) return null;
    final pending = _runtime.routes.pending;
    if (pending != null) return pending.edge.to;
    final followOn = _runtime.routes.followOn;
    if (followOn != null) return followOn.edge.to;
    final reversal = _runtime.routes.reversal;
    if (reversal != null) return reversal.edge.to;
    final active = _runtime.routes.active;
    if (active != null) return active.edge.to;
    return visual;
  }

  MotionGraphResult tick(MotionGraphTickOptions options) {
    _runtime.assertInstalled('tick');
    if (_runtime.readiness == MotionGraphReadiness.disposed ||
        _runtime.readiness == MotionGraphReadiness.error) {
      throw const MotionGraphError(MotionGraphErrorCode.disposed, 'terminated graph cannot tick');
    }
    _runtime.journal.beginTick(options.contentOrdinal);
    final effects = <MotionGraphEffect>[];
    final routeReady = options.routeReady ?? true;

    switch (_runtime.phase) {
      case MotionGraphPhase.preparing:
      case MotionGraphPhase.static:
        break;
      case MotionGraphPhase.intro:
        _tickIntro();
        break;
      case MotionGraphPhase.stable:
        _tickStable(routeReady, effects);
        break;
      case MotionGraphPhase.waiting:
        _tickWaiting(routeReady, effects);
        break;
      case MotionGraphPhase.locked:
        _tickLocked(effects);
        break;
      case MotionGraphPhase.reversible:
        _tickReversible(effects);
        break;
      case MotionGraphPhase.unready:
      case MotionGraphPhase.disposed:
      case MotionGraphPhase.error:
        throw const MotionGraphError(MotionGraphErrorCode.notReady, 'graph is not tickable');
    }
    _runtime.journal.completeTick();
    return _runtime.record(MotionGraphOperation.tick, effects);
  }

  /// Runs the exact tick reducer and rolls every mutation back before
  /// return. The immutable result can be used to prepare media; only [tick]
  /// commits it.
  MotionGraphResult previewTick(MotionGraphTickOptions options) {
    final checkpoint = _runtime.checkpoint();
    try {
      return tick(options);
    } finally {
      _runtime.restore(checkpoint);
    }
  }

  MotionGraphResult dispose([
    MotionGraphDisposeOptions options = const MotionGraphDisposeOptions(),
  ]) {
    if (_runtime.readiness == MotionGraphReadiness.disposed) {
      return _runtime.record(MotionGraphOperation.dispose, const []);
    }
    final retainedVisualState = options.retainedVisualState;
    if (retainedVisualState != null && !_runtime.hasState(retainedVisualState)) {
      throw const MotionGraphError(
        MotionGraphErrorCode.graphValidation,
        'retained visual state is not installed',
      );
    }
    if (retainedVisualState != null) {
      _runtime.visualState = retainedVisualState;
    }
    final effects = <MotionGraphEffect>[];
    final settlement = _runtime.ledger.settlePending(
      const GraphSettlementReject(GraphSettlementError.abortError),
    );
    if (settlement != null) effects.add(settlement);
    _changeReadiness(MotionGraphReadiness.disposed, effects);
    _runtime.phase = MotionGraphPhase.disposed;
    _runtime.presentation = null;
    _runtime.routes.clear();
    return _runtime.record(MotionGraphOperation.dispose, effects);
  }

  MotionGraphSnapshot snapshot() => _runtime.snapshot();

  List<MotionGraphTraceRecord> getTrace() => _runtime.getTrace();

  MotionGraphResult _applyStateIntent(
    StateIntentPlan plan,
    GraphStateId target,
    int sequence,
  ) {
    if (plan is StateIntentPlanReject) {
      return _rejectedRequest(target, sequence, GraphSettlementError.routeError);
    }
    if (plan is StateIntentPlanStandaloneNoop) {
      return _noopRequest(sequence);
    }

    final effects = <MotionGraphEffect>[];
    final admission = _runtime.ledger.request(target);
    if (plan is StateIntentPlanJoinPending) {
      return _acceptedRequest(admission, sequence, effects);
    }

    _setRequestedState(target, sequence, effects);
    _appendSuperseded(admission, effects);

    if (plan is StateIntentPlanCancelBeforeStable || plan is StateIntentPlanCancelPending) {
      _runtime.routes.cancelPending();
      if (plan is StateIntentPlanCancelPending) _runtime.phase = MotionGraphPhase.stable;
      final settled = _runtime.ledger.settlePending(
        const GraphSettlementResolve(GraphSettlementResolveReason.stableNoop),
      );
      if (settled != null) effects.add(settled);
      return _acceptedRequest(admission, sequence, effects, joined: false);
    }

    if (plan is StateIntentPlanReplacePending) {
      _runtime.routes.replacePending(plan.edge, sequence);
      if (_runtime.phase != MotionGraphPhase.preparing && _runtime.phase != MotionGraphPhase.intro) {
        _runtime.phase = MotionGraphPhase.waiting;
      }
    } else if (plan is StateIntentPlanContinueActiveTarget) {
      _runtime.routes.clearFollowOn();
      _runtime.routes.clearReversal();
    } else if (plan is StateIntentPlanContinueReversalTarget) {
      _runtime.routes.clearFollowOn();
    } else if (plan is StateIntentPlanQueueReversal) {
      _runtime.routes.queueReversal(plan.edge, sequence);
    } else if (plan is StateIntentPlanQueueFollowOn) {
      _runtime.routes.queueFollowOn(plan.edge, sequence);
    } else if (plan is StateIntentPlanStaticCommit) {
      _commitStaticEdge(plan.edge, sequence, effects, false);
    }
    return _acceptedRequest(admission, sequence, effects);
  }

  void _applyEventIntent(
    EventIntentPlan plan,
    int sequence,
    List<MotionGraphEffect> effects,
  ) {
    if (plan is EventIntentPlanAcceptNoop) return;

    if (plan is EventIntentPlanCancelPending) {
      _setRequestedState(plan.edge.to, sequence, effects);
      _abortPendingForEvent(effects);
      _runtime.routes.cancelPending();
      if (_runtime.phase == MotionGraphPhase.waiting) _runtime.phase = MotionGraphPhase.stable;
      return;
    }

    final GraphEdgeDefinition edge;
    if (plan is EventIntentPlanReplacePending) {
      edge = plan.edge;
    } else if (plan is EventIntentPlanContinueActiveTarget) {
      edge = plan.edge;
    } else if (plan is EventIntentPlanQueueReversal) {
      edge = plan.edge;
    } else if (plan is EventIntentPlanQueueFollowOn) {
      edge = plan.edge;
    } else if (plan is EventIntentPlanStaticCommit) {
      edge = plan.edge;
    } else {
      // EventIntentPlanReject: unreachable — send() filters it out first.
      return;
    }

    _setRequestedState(edge.to, sequence, effects);
    _abortPendingForEvent(effects);

    if (plan is EventIntentPlanReplacePending) {
      _runtime.routes.replacePending(edge, sequence);
      if (_runtime.phase != MotionGraphPhase.preparing && _runtime.phase != MotionGraphPhase.intro) {
        _runtime.phase = MotionGraphPhase.waiting;
      }
    } else if (plan is EventIntentPlanContinueActiveTarget) {
      _runtime.routes.clearFollowOn();
      _runtime.routes.clearReversal();
    } else if (plan is EventIntentPlanQueueReversal) {
      _runtime.routes.queueReversal(edge, sequence);
    } else if (plan is EventIntentPlanQueueFollowOn) {
      _runtime.routes.queueFollowOn(edge, sequence);
    } else if (plan is EventIntentPlanStaticCommit) {
      _commitStaticEdge(edge, sequence, effects, false);
    }
  }

  MotionGraphResult _acceptedRequest(
    RequestAdmission admission,
    int sequence,
    List<MotionGraphEffect> effects, {
    bool? joined,
  }) {
    return _runtime.record(
      MotionGraphOperation.request,
      effects,
      metadata: OperationResultMetadata(
        accepted: true,
        joined: joined ?? admission.joined,
        sequence: sequence,
        requestId: admission.requestId,
      ),
    );
  }

  IntentContext _intentContext() {
    final phase = _runtime.phase;
    if (phase == MotionGraphPhase.unready ||
        phase == MotionGraphPhase.disposed ||
        phase == MotionGraphPhase.error) {
      throw StateError('phase ${phase.name} cannot route intent');
    }
    return IntentContext(
      phase: phase,
      visualState: _runtime.requireVisualState(),
      routes: _runtime.routes,
      indexes: _runtime.indexes(),
      hasPendingRequests: _runtime.ledger.pendingRequestCount > 0,
    );
  }

  void _tickIntro() {
    final presentation = _runtime.presentation;
    if (presentation is! GraphPresentationIntro) {
      throw StateError('intro phase has no intro presentation');
    }
    final state = _runtime.state(presentation.state);
    final initial = state.initialUnit;
    if (initial == null) throw StateError('intro state has no initial unit');
    if (presentation.frameIndex + 1 < initial.frameCount) {
      _runtime.presentation = GraphPresentationIntro(
        state: presentation.state,
        unitId: presentation.unitId,
        frameIndex: presentation.frameIndex + 1,
      );
      return;
    }
    _runtime.presentation = _runtime.bodyPresentation(state.id, 0);
    // Consumption is a graph-timeline decision at the authored join. Hosts
    // that fail to draw this result recover through their static-failure
    // lane; they do not partially rewind an already committed graph tick.
    _runtime.initialUnitPending = false;
    _runtime.phase =
        _runtime.routes.pending == null ? MotionGraphPhase.stable : MotionGraphPhase.waiting;
  }

  void _tickStable(bool routeReady, List<MotionGraphEffect> effects) {
    final presentation = _runtime.bodyPresentationOrThrow();
    final completion = _runtime.indexes().completionEdgesByState[presentation.state];
    final state = _runtime.state(presentation.state);
    if (completion != null &&
        presentation.frameIndex == state.body.frameCount - 1 &&
        (routeReady || completion.start is GraphStartPolicyCut)) {
      final sequence = _runtime.journal.allocateInternalSequence();
      _setRequestedState(completion.to, sequence, effects);
      _runtime.journal.incrementRouteOperations();
      _startEdge(completion, sequence, effects);
      return;
    }
    final next = nextBodyFrame(state.body, presentation.frameIndex);
    _runtime.presentation = _runtime.bodyPresentation(state.id, next.frameIndex);
  }

  void _tickWaiting(bool routeReady, List<MotionGraphEffect> effects) {
    final pending = _runtime.requirePendingRoute();
    final edge = pending.edge;
    final presentation = _runtime.bodyPresentationOrThrow();
    final state = _runtime.state(presentation.state);
    if (edge.from != state.id) {
      throw StateError('pending edge source does not match body presentation');
    }

    final start = edge.start;
    if (start is GraphStartPolicyCut) {
      _runtime.journal.incrementRouteOperations();
      _startEdge(edge, pending.sequence, effects);
      return;
    }

    final boundary = start is GraphStartPolicyPortal
        ? findNextPortalBoundary(state.body, start.sourcePort, presentation.frameIndex)
        : findFinishBoundary(state.body, presentation.frameIndex);

    if (boundary.eligibleNow && routeReady) {
      _runtime.journal.incrementRouteOperations();
      _startEdge(edge, pending.sequence, effects);
      return;
    }

    final next = nextBodyFrame(state.body, presentation.frameIndex);
    _runtime.presentation = _runtime.bodyPresentation(state.id, next.frameIndex);
  }

  void _tickLocked(List<MotionGraphEffect> effects) {
    final edge = _runtime.requireActiveRoute().edge;
    final transition = edge.transition;
    final presentation = _runtime.presentation;
    if (transition is! GraphTransitionLocked || presentation is! GraphPresentationLocked) {
      throw StateError('locked phase has inconsistent transition state');
    }
    if (presentation.frameIndex + 1 < transition.frameCount) {
      _runtime.presentation = GraphPresentationLocked(
        edgeId: presentation.edgeId,
        unitId: presentation.unitId,
        frameIndex: presentation.frameIndex + 1,
      );
      return;
    }
    _commitActiveEdge(edge, effects);
  }

  void _tickReversible(List<MotionGraphEffect> effects) {
    var active = _runtime.requireActiveRoute();
    var edge = active.edge;
    final presentation = _runtime.presentation;
    if (presentation is! GraphPresentationReversible) {
      throw StateError('reversible phase has no reversible presentation');
    }

    if (_runtime.routes.reversal != null) {
      active = _runtime.routes.activateReversal();
      edge = active.edge;
      effects.add(_transitionStart(edge, active.sequence));
    }

    final transition = edge.transition;
    if (transition is! GraphTransitionReversible) {
      throw StateError('active reversible edge has no reversible transition');
    }
    final next = transition.direction == TransitionDirection.forward
        ? presentation.frameIndex + 1
        : presentation.frameIndex - 1;
    if (next < 0 || next >= transition.frameCount) {
      _commitActiveEdge(edge, effects);
      return;
    }
    _runtime.presentation = GraphPresentationReversible(
      edgeId: edge.id,
      unitId: transition.unitId,
      frameIndex: next,
      direction: transition.direction,
    );
  }

  void _startEdge(GraphEdgeDefinition edge, int sequence, List<MotionGraphEffect> effects) {
    _runtime.routes.activate(edge, sequence);
    effects.add(_transitionStart(edge, sequence));
    final transition = edge.transition;
    if (transition == null) {
      _commitActiveEdge(edge, effects);
      return;
    }
    if (transition is GraphTransitionLocked) {
      _runtime.phase = MotionGraphPhase.locked;
      _runtime.presentation =
          GraphPresentationLocked(edgeId: edge.id, unitId: transition.unitId, frameIndex: 0);
      return;
    }
    final reversible = transition as GraphTransitionReversible;
    _runtime.phase = MotionGraphPhase.reversible;
    _runtime.presentation = GraphPresentationReversible(
      edgeId: edge.id,
      unitId: reversible.unitId,
      frameIndex: reversible.direction == TransitionDirection.forward
          ? 0
          : reversible.frameCount - 1,
      direction: reversible.direction,
    );
  }

  void _commitActiveEdge(GraphEdgeDefinition edge, List<MotionGraphEffect> effects) {
    _runtime.presentation = _runtime.bodyPresentation(edge.to, 0);
    _setVisualState(edge.to, effects);
    effects.add(_transitionEnd(edge));
    final completion = _runtime.routes.completeActive();

    if (completion.promoted != null) {
      _runtime.phase = MotionGraphPhase.waiting;
      return;
    }

    _runtime.phase = MotionGraphPhase.stable;
    if (_runtime.requestedState == _runtime.visualState) {
      final settlement = _runtime.ledger.settlePending(
        const GraphSettlementResolve(GraphSettlementResolveReason.targetCommitted),
      );
      if (settlement != null) effects.add(settlement);
    }
  }

  void _commitStaticEdge(
    GraphEdgeDefinition edge,
    int sequence,
    List<MotionGraphEffect> effects,
    bool preparationCommit,
  ) {
    effects.add(_transitionStart(edge, sequence));
    _runtime.presentation = _runtime.staticPresentation(edge.to);
    _setVisualState(edge.to, effects);
    effects.add(_transitionEnd(edge));
    final settlement = _runtime.ledger.settlePending(
      GraphSettlementResolve(
        preparationCommit
            ? GraphSettlementResolveReason.staticRecovery
            : GraphSettlementResolveReason.targetCommitted,
      ),
    );
    if (settlement != null) effects.add(settlement);
    _runtime.routes.clear();
    _runtime.phase = MotionGraphPhase.static;
  }

  void _setRequestedState(GraphStateId target, int sequence, List<MotionGraphEffect> effects) {
    final previous = _runtime.requireRequestedState();
    if (previous == target) return;
    _runtime.requestedState = target;
    effects.add(
      MotionGraphEffectRequestedStateChange(from: previous, to: target, sequence: sequence),
    );
  }

  void _setVisualState(GraphStateId target, List<MotionGraphEffect> effects) {
    if (_runtime.readiness == MotionGraphReadiness.static &&
        target != _runtime.definition().initialState) {
      // A deliberate static-state commit must not leave an intro armed to
      // replay later if the host returns to the initial state before
      // re-entry.
      _runtime.initialUnitPending = false;
    }
    final previous = _runtime.requireVisualState();
    if (previous == target) return;
    _runtime.visualState = target;
    effects.add(MotionGraphEffectVisualStateChange(from: previous, to: target));
  }

  MotionGraphEffect _transitionStart(GraphEdgeDefinition edge, int sequence) {
    return MotionGraphEffectTransitionStart(
      edgeId: edge.id,
      from: edge.from,
      to: edge.to,
      sequence: sequence,
    );
  }

  MotionGraphEffect _transitionEnd(GraphEdgeDefinition edge) {
    return MotionGraphEffectTransitionEnd(edgeId: edge.id, from: edge.from, to: edge.to);
  }

  MotionGraphResult _noopRequest(int sequence) {
    final standalone = _runtime.ledger.settleNew(
      const GraphSettlementResolve(GraphSettlementResolveReason.stableNoop),
    );
    return _runtime.record(
      MotionGraphOperation.request,
      [standalone.effect],
      metadata: OperationResultMetadata(
        accepted: true,
        joined: false,
        sequence: sequence,
        requestId: standalone.requestId,
      ),
    );
  }

  MotionGraphResult _rejectedRequest(
    GraphStateId target,
    int sequence,
    GraphSettlementError error,
  ) {
    final standalone = _runtime.ledger.settleNew(GraphSettlementReject(error));
    return _runtime.record(
      MotionGraphOperation.request,
      [standalone.effect],
      metadata: OperationResultMetadata(
        accepted: false,
        joined: false,
        sequence: sequence,
        requestId: standalone.requestId,
      ),
    );
  }

  void _appendSuperseded(RequestAdmission admission, List<MotionGraphEffect> effects) {
    final superseded = admission.superseded;
    if (superseded != null) effects.add(superseded);
  }

  void _abortPendingForEvent(List<MotionGraphEffect> effects) {
    final settlement = _runtime.ledger.settlePending(
      const GraphSettlementReject(GraphSettlementError.abortError),
    );
    if (settlement != null) effects.add(settlement);
  }

  void _changeReadiness(
    MotionGraphReadiness next,
    List<MotionGraphEffect> effects, {
    String? reason,
  }) {
    final previous = _runtime.readiness;
    if (previous == next) return;
    _runtime.readiness = next;
    effects.add(MotionGraphEffectReadinessChange(from: previous, to: next, reason: reason));
  }
}
