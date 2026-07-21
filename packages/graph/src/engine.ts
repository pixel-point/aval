import { MotionGraphError } from "./errors.js";
import { MOTION_GRAPH_STATIC_REASONS } from "./model.js";
import type {
  GraphEdgeDefinition,
  GraphStateId,
  MotionGraphDefinition,
  MotionGraphDisposeOptions,
  MotionGraphEffect,
  MotionGraphPlaybackFailureOptions,
  MotionGraphReadiness,
  MotionGraphRecoveryOptions,
  MotionGraphResult,
  MotionGraphSnapshot,
  MotionGraphStaticReason,
  MotionGraphTickOptions,
  MotionGraphTraceRecord,
  ValidatedMotionGraph
} from "./model.js";
import {
  freezeGraphPresentation,
  MotionGraphEngineState
} from "./engine-state.js";
import {
  planEventIntent,
  planStateIntent,
  type EventIntentPlan,
  type IntentContext,
  type StateIntentPlan
} from "./intent-router.js";
import {
  findFinishBoundary,
  findNextPortalBoundary,
  nextBodyFrame
} from "./portal-search.js";
import type { RequestAdmission } from "./request-ledger.js";

function assertStaticReason(
  reason: unknown
): asserts reason is MotionGraphStaticReason {
  if (!MOTION_GRAPH_STATIC_REASONS.some((candidate) => candidate === reason)) {
    throw new MotionGraphError(
      "GRAPH_VALIDATION",
      `motion graph static reason must be one of: ${MOTION_GRAPH_STATIC_REASONS.join(", ")}`
    );
  }
}

/**
 * Pure version-0 graph reducer. It owns authored cursors and emits abstract
 * presentations/effects; hosts own promises, clocks, codecs, and rendering.
 */
export class MotionGraphEngine {
  readonly #runtime = new MotionGraphEngineState();

  public install(
    definition: MotionGraphDefinition | ValidatedMotionGraph
  ): Readonly<MotionGraphResult> {
    if (this.#runtime.readiness !== "unready") {
      throw new MotionGraphError(
        "GRAPH_VALIDATION",
        "graph metadata can only be installed once"
      );
    }
    const initial = this.#runtime.installMetadata(definition);
    this.#runtime.requestedState = initial;
    this.#runtime.visualState = initial;
    this.#runtime.presentation = freezeGraphPresentation({
      kind: "static",
      state: initial
    });
    const effects: MotionGraphEffect[] = [];
    this.#changeReadiness("preparing", effects);
    this.#runtime.phase = "preparing";
    return this.#runtime.record("install", effects);
  }

  public beginAnimated(): Readonly<MotionGraphResult> {
    this.#runtime.assertPhase("preparing", "beginAnimated");
    const effects: MotionGraphEffect[] = [];
    this.#changeReadiness("animated", effects);
    const initial = this.#runtime.definition().initialState;
    const state = this.#runtime.state(initial);

    if (state.initialUnit !== undefined) {
      this.#runtime.phase = "intro";
      this.#runtime.presentation = freezeGraphPresentation({
        kind: "intro",
        state: initial,
        unitId: state.initialUnit.unitId,
        frameIndex: 0
      });
    } else {
      this.#runtime.presentation = this.#runtime.bodyPresentation(initial, 0);
      this.#runtime.phase = this.#runtime.routes.pending === null ? "stable" : "waiting";
    }
    return this.#runtime.record("begin-animated", effects);
  }

  public resumeAnimated(): Readonly<MotionGraphResult> {
    this.#runtime.assertPhase("static", "resumeAnimated");
    if (this.#runtime.readiness !== "static") {
      throw new MotionGraphError(
        "NOT_READY",
        "resumeAnimated requires static readiness"
      );
    }
    const presentation = this.#runtime.presentation;
    const requested = this.#runtime.requireRequestedState();
    const visual = this.#runtime.requireVisualState();
    if (
      presentation?.kind !== "static" ||
      presentation.state !== visual ||
      requested !== visual ||
      this.#runtime.routes.hasRoute() ||
      this.#runtime.ledger.pendingRequestCount !== 0
    ) {
      throw new MotionGraphError(
        "NOT_READY",
        "resumeAnimated requires one settled static state"
      );
    }
    const effects: MotionGraphEffect[] = [];
    this.#changeReadiness("animated", effects);
    const state = this.#runtime.state(visual);
    const firstAnimatedActivation =
      this.#runtime.initialUnitPending;
    if (
      firstAnimatedActivation &&
      visual === this.#runtime.definition().initialState &&
      state.initialUnit !== undefined
    ) {
      this.#runtime.presentation = freezeGraphPresentation({
        kind: "intro",
        state: visual,
        unitId: state.initialUnit.unitId,
        frameIndex: 0
      });
      this.#runtime.phase = "intro";
    } else {
      this.#runtime.presentation = this.#runtime.bodyPresentation(visual, 0);
      this.#runtime.phase = "stable";
    }
    return this.#runtime.record("resume-animated", effects);
  }

  public beginStatic(
    reason: MotionGraphStaticReason
  ): Readonly<MotionGraphResult> {
    this.#runtime.assertPhase("preparing", "beginStatic");
    assertStaticReason(reason);
    const effects: MotionGraphEffect[] = [];
    this.#changeReadiness("static", effects, reason);
    this.#runtime.phase = "static";

    const visual = this.#runtime.requireVisualState();
    const requested = this.#runtime.requireRequestedState();
    if (visual !== requested) {
      const edge = this.#runtime.edgeDirect(visual, requested);
      if (edge === null) {
        throw new MotionGraphError(
          "ROUTE_NOT_FOUND",
          `prepared target ${requested} has no direct route from ${visual}`
        );
      }
      this.#commitStaticEdge(
        edge,
        this.#runtime.routes.pending?.sequence ?? this.#runtime.journal.inputSequence,
        effects,
        true
      );
    } else {
      this.#runtime.presentation = this.#runtime.staticPresentation(visual);
      this.#runtime.routes.clear();
    }
    return this.#runtime.record("begin-static", effects);
  }

  public recoverStatic(
    reason: MotionGraphStaticReason,
    options: Readonly<MotionGraphRecoveryOptions> = {}
  ): Readonly<MotionGraphResult> {
    this.#runtime.assertInstalled("recoverStatic");
    if (this.#runtime.readiness === "disposed" || this.#runtime.readiness === "error") {
      throw new MotionGraphError("DISPOSED", "graph cannot recover after termination");
    }
    assertStaticReason(reason);
    if (options === null || typeof options !== "object") {
      throw new MotionGraphError(
        "GRAPH_VALIDATION",
        "static recovery options must be an object"
      );
    }
    if (
      options.retainedVisualState !== undefined &&
      !this.#runtime.hasState(options.retainedVisualState)
    ) {
      throw new MotionGraphError(
        "GRAPH_VALIDATION",
        "retained recovery visual state is not installed"
      );
    }
    const effects: MotionGraphEffect[] = [];
    this.#changeReadiness("static", effects, reason);
    const graphVisual = this.#runtime.requireVisualState();
    const retainedVisual = options.retainedVisualState;
    if (retainedVisual !== undefined) this.#runtime.visualState = retainedVisual;
    const visual = this.#runtime.requireVisualState();
    const requested = this.#runtime.requireRequestedState();

    if (visual !== requested || this.#runtime.routes.hasRoute()) {
      const recovery = this.#runtime.routes.recoveryCandidate();
      const retainedOverride = retainedVisual !== undefined &&
        retainedVisual !== graphVisual;
      const edge = retainedOverride
        ? this.#runtime.edgeDirect(visual, requested)
        : recovery?.edge ?? this.#runtime.edgeDirect(visual, requested);
      if (edge !== null) {
        const hadStarted = !retainedOverride &&
          this.#runtime.routes.active?.edge.id === edge.id;
        if (!hadStarted) {
          effects.push(
            this.#transitionStart(
              edge,
              recovery?.sequence ?? this.#runtime.journal.inputSequence
            )
          );
        }
        this.#runtime.presentation = this.#runtime.staticPresentation(requested);
        this.#setVisualState(requested, effects);
        effects.push(this.#transitionEnd(edge));
      } else {
        this.#runtime.presentation = this.#runtime.staticPresentation(requested);
        this.#setVisualState(requested, effects);
      }
      const settlement = this.#runtime.ledger.settlePending({
        type: "resolve",
        timing: "microtask",
        reason: "static-recovery"
      });
      if (settlement !== null) {
        effects.push(settlement);
      }
    } else {
      this.#runtime.presentation = this.#runtime.staticPresentation(visual);
    }
    this.#runtime.routes.clear();
    this.#runtime.phase = "static";
    return this.#runtime.record("recover-static", effects);
  }

  public failPlayback(
    message = "playback could not continue",
    options: Readonly<MotionGraphPlaybackFailureOptions> = {}
  ):
    Readonly<MotionGraphResult> {
    this.#runtime.assertInstalled("failPlayback");
    if (this.#runtime.readiness === "disposed") {
      throw new MotionGraphError("DISPOSED", "disposed graph cannot fail playback");
    }
    if (options === null || typeof options !== "object") {
      throw new MotionGraphError(
        "GRAPH_VALIDATION",
        "playback failure options must be an object"
      );
    }
    if (
      options.retainedVisualState !== undefined &&
      !this.#runtime.hasState(options.retainedVisualState)
    ) {
      throw new MotionGraphError(
        "GRAPH_VALIDATION",
        "retained visual state is not installed"
      );
    }
    const effects: MotionGraphEffect[] = [];
    this.#changeReadiness("error", effects, message);
    if (options.retainedVisualState !== undefined) {
      this.#runtime.visualState = options.retainedVisualState;
      this.#runtime.presentation = this.#runtime.staticPresentation(options.retainedVisualState);
    }
    const settlement = this.#runtime.ledger.settlePending({
      type: "reject",
      timing: "microtask",
      error: "PlaybackError"
    });
    if (settlement !== null) {
      effects.push(settlement);
    }
    this.#runtime.routes.clear();
    this.#runtime.phase = "error";
    return this.#runtime.record("fail-playback", effects);
  }

  public request(target: GraphStateId): Readonly<MotionGraphResult> {
    const input = this.#runtime.journal.beginInput();
    if (!input.withinLimit) {
      const standalone = this.#runtime.ledger.settleNew({
        type: "reject",
        timing: "microtask",
        error: "InputOverflowError"
      });
      return this.#runtime.record("request", [standalone.effect], {
        accepted: false,
        joined: false,
        sequence: input.sequence,
        requestId: standalone.requestId
      });
    }

    if (this.#runtime.readiness === "unready") {
      return this.#rejectedRequest(target, input.sequence, "NotReadyError");
    }
    if (this.#runtime.readiness === "disposed" || this.#runtime.readiness === "error") {
      return this.#rejectedRequest(target, input.sequence, "AbortError");
    }
    if (!this.#runtime.hasState(target)) {
      return this.#rejectedRequest(target, input.sequence, "RouteError");
    }

    return this.#applyStateIntent(
      planStateIntent(this.#intentContext(), target),
      target,
      input.sequence
    );
  }

  public send(event: string): Readonly<MotionGraphResult> {
    const input = this.#runtime.journal.beginInput();
    if (!input.withinLimit || this.#runtime.readiness === "unready") {
      return this.#runtime.record("send", [], {
        accepted: false,
        sequence: input.sequence
      });
    }
    if (this.#runtime.readiness === "disposed" || this.#runtime.readiness === "error") {
      return this.#runtime.record("send", [], {
        accepted: false,
        sequence: input.sequence
      });
    }

    const plan = planEventIntent(this.#intentContext(), event);
    if (plan.kind === "reject") {
      return this.#runtime.record("send", [], {
        accepted: false,
        sequence: input.sequence
      });
    }
    const effects: MotionGraphEffect[] = [];
    this.#applyEventIntent(plan, input.sequence, effects);
    return this.#runtime.record("send", effects, {
      accepted: true,
      sequence: input.sequence
    });
  }

  /** Whether send(event) would be accepted now, without allocating an input. */
  public canSend(event: string): boolean {
    if (
      typeof event !== "string" ||
      !this.#runtime.journal.canBeginInput() ||
      this.#runtime.readiness === "unready" ||
      this.#runtime.readiness === "disposed" ||
      this.#runtime.readiness === "error"
    ) return false;
    return planEventIntent(this.#intentContext(), event).kind !== "reject";
  }

  public tick(options: MotionGraphTickOptions): Readonly<MotionGraphResult> {
    this.#runtime.assertInstalled("tick");
    if (this.#runtime.readiness === "disposed" || this.#runtime.readiness === "error") {
      throw new MotionGraphError("DISPOSED", "terminated graph cannot tick");
    }
    this.#runtime.journal.beginTick(options.contentOrdinal);
    const effects: MotionGraphEffect[] = [];
    const routeReady = options.routeReady ?? true;

    switch (this.#runtime.phase) {
      case "preparing":
      case "static":
        break;
      case "intro":
        this.#tickIntro();
        break;
      case "stable":
        this.#tickStable(routeReady, effects);
        break;
      case "waiting":
        this.#tickWaiting(routeReady, effects);
        break;
      case "locked":
        this.#tickLocked(effects);
        break;
      case "reversible":
        this.#tickReversible(effects);
        break;
      case "unready":
      case "disposed":
      case "error":
        throw new MotionGraphError("NOT_READY", "graph is not tickable");
    }
    this.#runtime.journal.completeTick();
    return this.#runtime.record("tick", effects);
  }

  /**
   * Runs the exact tick reducer and rolls every mutation back before return.
   * The immutable result can be used to prepare media; only `tick` commits it.
   */
  public previewTick(
    options: MotionGraphTickOptions
  ): Readonly<MotionGraphResult> {
    const checkpoint = this.#runtime.checkpoint();
    try {
      return this.tick(options);
    } finally {
      this.#runtime.restore(checkpoint);
    }
  }

  public dispose(
    options: Readonly<MotionGraphDisposeOptions> = {}
  ): Readonly<MotionGraphResult> {
    if (this.#runtime.readiness === "disposed") {
      return this.#runtime.record("dispose", []);
    }
    if (options === null || typeof options !== "object") {
      throw new MotionGraphError(
        "GRAPH_VALIDATION",
        "graph disposal options must be an object"
      );
    }
    if (
      options.retainedVisualState !== undefined &&
      !this.#runtime.hasState(options.retainedVisualState)
    ) {
      throw new MotionGraphError(
        "GRAPH_VALIDATION",
        "retained visual state is not installed"
      );
    }
    if (options.retainedVisualState !== undefined) {
      this.#runtime.visualState = options.retainedVisualState;
    }
    const effects: MotionGraphEffect[] = [];
    const settlement = this.#runtime.ledger.settlePending({
      type: "reject",
      timing: "microtask",
      error: "AbortError"
    });
    if (settlement !== null) {
      effects.push(settlement);
    }
    this.#changeReadiness("disposed", effects);
    this.#runtime.phase = "disposed";
    this.#runtime.presentation = null;
    this.#runtime.routes.clear();
    return this.#runtime.record("dispose", effects);
  }

  public snapshot(): Readonly<MotionGraphSnapshot> {
    return this.#runtime.snapshot();
  }

  public getTrace(): readonly Readonly<MotionGraphTraceRecord>[] {
    return this.#runtime.getTrace();
  }

  #applyStateIntent(
    plan: Readonly<StateIntentPlan>,
    target: GraphStateId,
    sequence: number
  ): Readonly<MotionGraphResult> {
    if (plan.kind === "reject") {
      return this.#rejectedRequest(target, sequence, "RouteError");
    }
    if (plan.kind === "standalone-noop") return this.#noopRequest(sequence);

    const effects: MotionGraphEffect[] = [];
    const admission = this.#runtime.ledger.request(target);
    if (plan.kind === "join-pending") {
      return this.#acceptedRequest(admission, sequence, effects);
    }

    this.#setRequestedState(target, sequence, effects);
    this.#appendSuperseded(admission, effects);

    if (plan.kind === "cancel-before-stable" || plan.kind === "cancel-pending") {
      this.#runtime.routes.cancelPending();
      if (plan.kind === "cancel-pending") this.#runtime.phase = "stable";
      const settled = this.#runtime.ledger.settlePending({
        type: "resolve",
        timing: "microtask",
        reason: "stable-noop"
      });
      if (settled !== null) effects.push(settled);
      return this.#acceptedRequest(admission, sequence, effects, false);
    }

    switch (plan.kind) {
      case "replace-pending":
        this.#runtime.routes.replacePending(plan.edge, sequence);
        if (this.#runtime.phase !== "preparing" && this.#runtime.phase !== "intro") {
          this.#runtime.phase = "waiting";
        }
        break;
      case "continue-active-target":
        this.#runtime.routes.clearFollowOn();
        this.#runtime.routes.clearReversal();
        break;
      case "continue-reversal-target":
        this.#runtime.routes.clearFollowOn();
        break;
      case "queue-reversal":
        this.#runtime.routes.queueReversal(plan.edge, sequence);
        break;
      case "queue-follow-on":
        this.#runtime.routes.queueFollowOn(plan.edge, sequence);
        break;
      case "static-commit":
        this.#commitStaticEdge(plan.edge, sequence, effects, false);
        break;
    }
    return this.#acceptedRequest(admission, sequence, effects);
  }

  #applyEventIntent(
    plan: Exclude<Readonly<EventIntentPlan>, { readonly kind: "reject" }>,
    sequence: number,
    effects: MotionGraphEffect[]
  ): void {
    if (plan.kind === "accept-noop") return;

    if (plan.kind === "cancel-pending") {
      this.#setRequestedState(plan.edge.to, sequence, effects);
      this.#abortPendingForEvent(effects);
      this.#runtime.routes.cancelPending();
      if (this.#runtime.phase === "waiting") this.#runtime.phase = "stable";
      return;
    }

    this.#setRequestedState(plan.edge.to, sequence, effects);
    this.#abortPendingForEvent(effects);
    switch (plan.kind) {
      case "replace-pending":
        this.#runtime.routes.replacePending(plan.edge, sequence);
        if (this.#runtime.phase !== "preparing" && this.#runtime.phase !== "intro") {
          this.#runtime.phase = "waiting";
        }
        break;
      case "continue-active-target":
        this.#runtime.routes.clearFollowOn();
        this.#runtime.routes.clearReversal();
        break;
      case "queue-reversal":
        this.#runtime.routes.queueReversal(plan.edge, sequence);
        break;
      case "queue-follow-on":
        this.#runtime.routes.queueFollowOn(plan.edge, sequence);
        break;
      case "static-commit":
        this.#commitStaticEdge(plan.edge, sequence, effects, false);
        break;
    }
  }

  #acceptedRequest(
    admission: Readonly<RequestAdmission>,
    sequence: number,
    effects: readonly MotionGraphEffect[],
    joined = admission.joined
  ): Readonly<MotionGraphResult> {
    return this.#runtime.record("request", effects, {
      accepted: true,
      joined,
      sequence,
      requestId: admission.requestId
    });
  }

  #intentContext(): Readonly<IntentContext> {
    const phase = this.#runtime.phase;
    if (phase === "unready" || phase === "disposed" || phase === "error") {
      throw new Error(`phase ${phase} cannot route intent`);
    }
    return Object.freeze({
      phase,
      visualState: this.#runtime.requireVisualState(),
      routes: this.#runtime.routes,
      indexes: this.#runtime.indexes(),
      hasPendingRequests: this.#runtime.ledger.pendingRequestCount > 0
    });
  }

  #tickIntro(): void {
    const presentation = this.#runtime.presentation;
    if (presentation?.kind !== "intro") {
      throw new Error("intro phase has no intro presentation");
    }
    const state = this.#runtime.state(presentation.state);
    const initial = state.initialUnit;
    if (initial === undefined) throw new Error("intro state has no initial unit");
    if (presentation.frameIndex + 1 < initial.frameCount) {
      this.#runtime.presentation = freezeGraphPresentation({
        ...presentation,
        frameIndex: presentation.frameIndex + 1
      });
      return;
    }
    this.#runtime.presentation = this.#runtime.bodyPresentation(state.id, 0);
    // Consumption is a graph-timeline decision at the authored join. Hosts
    // that fail to draw this result recover through their static-failure lane;
    // they do not partially rewind an already committed graph tick.
    this.#runtime.initialUnitPending = false;
    this.#runtime.phase = this.#runtime.routes.pending === null ? "stable" : "waiting";
  }

  #tickStable(routeReady: boolean, effects: MotionGraphEffect[]): void {
    const presentation = this.#runtime.bodyPresentationOrThrow();
    const completion = this.#runtime.indexes().completionEdgesByState.get(
      presentation.state
    );
    const state = this.#runtime.state(presentation.state);
    if (
      completion !== undefined &&
      presentation.frameIndex === state.body.frameCount - 1 &&
      (routeReady || completion.start.type === "cut")
    ) {
      const sequence = this.#runtime.journal.allocateInternalSequence();
      this.#setRequestedState(completion.to, sequence, effects);
      this.#runtime.journal.incrementRouteOperations();
      this.#startEdge(completion, sequence, effects);
      return;
    }
    const next = nextBodyFrame(state.body, presentation.frameIndex);
    this.#runtime.presentation = this.#runtime.bodyPresentation(state.id, next.frameIndex);
  }

  #tickWaiting(routeReady: boolean, effects: MotionGraphEffect[]): void {
    const pending = this.#runtime.requirePendingRoute();
    const edge = pending.edge;
    const presentation = this.#runtime.bodyPresentationOrThrow();
    const state = this.#runtime.state(presentation.state);
    if (edge.from !== state.id) {
      throw new Error("pending edge source does not match body presentation");
    }

    if (edge.start.type === "cut") {
      this.#runtime.journal.incrementRouteOperations();
      this.#startEdge(edge, pending.sequence, effects);
      return;
    }

    const boundary = edge.start.type === "portal"
      ? findNextPortalBoundary(
          state.body,
          edge.start.sourcePort,
          presentation.frameIndex
        )
      : findFinishBoundary(state.body, presentation.frameIndex);

    if (boundary.eligibleNow && routeReady) {
      this.#runtime.journal.incrementRouteOperations();
      this.#startEdge(edge, pending.sequence, effects);
      return;
    }

    const next = nextBodyFrame(state.body, presentation.frameIndex);
    this.#runtime.presentation = this.#runtime.bodyPresentation(state.id, next.frameIndex);
  }

  #tickLocked(effects: MotionGraphEffect[]): void {
    const edge = this.#runtime.requireActiveRoute().edge;
    const transition = edge.transition;
    const presentation = this.#runtime.presentation;
    if (transition?.kind !== "locked" || presentation?.kind !== "locked") {
      throw new Error("locked phase has inconsistent transition state");
    }
    if (presentation.frameIndex + 1 < transition.frameCount) {
      this.#runtime.presentation = freezeGraphPresentation({
        ...presentation,
        frameIndex: presentation.frameIndex + 1
      });
      return;
    }
    this.#commitActiveEdge(edge, effects);
  }

  #tickReversible(effects: MotionGraphEffect[]): void {
    let active = this.#runtime.requireActiveRoute();
    let edge = active.edge;
    const presentation = this.#runtime.presentation;
    if (presentation?.kind !== "reversible") {
      throw new Error("reversible phase has no reversible presentation");
    }

    if (this.#runtime.routes.reversal !== null) {
      active = this.#runtime.routes.activateReversal();
      edge = active.edge;
      effects.push(this.#transitionStart(edge, active.sequence));
    }

    const transition = edge.transition;
    if (transition?.kind !== "reversible") {
      throw new Error("active reversible edge has no reversible transition");
    }
    const next = transition.direction === "forward"
      ? presentation.frameIndex + 1
      : presentation.frameIndex - 1;
    if (next < 0 || next >= transition.frameCount) {
      this.#commitActiveEdge(edge, effects);
      return;
    }
    this.#runtime.presentation = freezeGraphPresentation({
      kind: "reversible",
      edgeId: edge.id,
      unitId: transition.unitId,
      frameIndex: next,
      direction: transition.direction
    });
  }

  #startEdge(
    edge: GraphEdgeDefinition,
    sequence: number,
    effects: MotionGraphEffect[]
  ): void {
    this.#runtime.routes.activate(edge, sequence);
    effects.push(this.#transitionStart(edge, sequence));
    const transition = edge.transition;
    if (transition === undefined) {
      this.#commitActiveEdge(edge, effects);
      return;
    }
    if (transition.kind === "locked") {
      this.#runtime.phase = "locked";
      this.#runtime.presentation = freezeGraphPresentation({
        kind: "locked",
        edgeId: edge.id,
        unitId: transition.unitId,
        frameIndex: 0
      });
      return;
    }
    this.#runtime.phase = "reversible";
    this.#runtime.presentation = freezeGraphPresentation({
      kind: "reversible",
      edgeId: edge.id,
      unitId: transition.unitId,
      frameIndex:
        transition.direction === "forward" ? 0 : transition.frameCount - 1,
      direction: transition.direction
    });
  }

  #commitActiveEdge(
    edge: GraphEdgeDefinition,
    effects: MotionGraphEffect[]
  ): void {
    this.#runtime.presentation = this.#runtime.bodyPresentation(edge.to, 0);
    this.#setVisualState(edge.to, effects);
    effects.push(this.#transitionEnd(edge));
    const completion = this.#runtime.routes.completeActive();

    if (completion.promoted !== null) {
      this.#runtime.phase = "waiting";
      return;
    }

    this.#runtime.phase = "stable";
    if (this.#runtime.requestedState === this.#runtime.visualState) {
      const settlement = this.#runtime.ledger.settlePending({
        type: "resolve",
        timing: "microtask",
        reason: "target-committed"
      });
      if (settlement !== null) effects.push(settlement);
    }
  }

  #commitStaticEdge(
    edge: GraphEdgeDefinition,
    sequence: number,
    effects: MotionGraphEffect[],
    preparationCommit: boolean
  ): void {
    effects.push(this.#transitionStart(edge, sequence));
    this.#runtime.presentation = this.#runtime.staticPresentation(edge.to);
    this.#setVisualState(edge.to, effects);
    effects.push(this.#transitionEnd(edge));
    const settlement = this.#runtime.ledger.settlePending({
      type: "resolve",
      timing: "microtask",
      reason: preparationCommit ? "static-recovery" : "target-committed"
    });
    if (settlement !== null) effects.push(settlement);
    this.#runtime.routes.clear();
    this.#runtime.phase = "static";
  }

  #setRequestedState(
    target: GraphStateId,
    sequence: number,
    effects: MotionGraphEffect[]
  ): void {
    const previous = this.#runtime.requireRequestedState();
    if (previous === target) return;
    this.#runtime.requestedState = target;
    effects.push(freezeEffect({
      type: "requestedstatechange",
      from: previous,
      to: target,
      sequence
    }));
  }

  #setVisualState(
    target: GraphStateId,
    effects: MotionGraphEffect[]
  ): void {
    if (
      this.#runtime.readiness === "static" &&
      target !== this.#runtime.definition().initialState
    ) {
      // A deliberate static-state commit must not leave an intro armed to
      // replay later if the host returns to the initial state before re-entry.
      this.#runtime.initialUnitPending = false;
    }
    const previous = this.#runtime.requireVisualState();
    if (previous === target) return;
    this.#runtime.visualState = target;
    effects.push(freezeEffect({
      type: "visualstatechange",
      from: previous,
      to: target
    }));
  }

  #transitionStart(
    edge: GraphEdgeDefinition,
    sequence: number
  ): Readonly<MotionGraphEffect> {
    return freezeEffect({
      type: "transitionstart",
      edgeId: edge.id,
      from: edge.from,
      to: edge.to,
      sequence
    });
  }

  #transitionEnd(edge: GraphEdgeDefinition): Readonly<MotionGraphEffect> {
    return freezeEffect({
      type: "transitionend",
      edgeId: edge.id,
      from: edge.from,
      to: edge.to
    });
  }

  #noopRequest(sequence: number): Readonly<MotionGraphResult> {
    const standalone = this.#runtime.ledger.settleNew({
      type: "resolve",
      timing: "microtask",
      reason: "stable-noop"
    });
    return this.#runtime.record("request", [standalone.effect], {
      accepted: true,
      joined: false,
      sequence,
      requestId: standalone.requestId
    });
  }

  #rejectedRequest(
    _target: GraphStateId,
    sequence: number,
    error: "NotReadyError" | "RouteError" | "AbortError"
  ): Readonly<MotionGraphResult> {
    const standalone = this.#runtime.ledger.settleNew({
      type: "reject",
      timing: "microtask",
      error
    });
    return this.#runtime.record("request", [standalone.effect], {
      accepted: false,
      joined: false,
      sequence,
      requestId: standalone.requestId
    });
  }

  #appendSuperseded(
    admission: Readonly<RequestAdmission>,
    effects: MotionGraphEffect[]
  ): void {
    if (admission.superseded !== null) effects.push(admission.superseded);
  }

  #abortPendingForEvent(effects: MotionGraphEffect[]): void {
    const settlement = this.#runtime.ledger.settlePending({
      type: "reject",
      timing: "microtask",
      error: "AbortError"
    });
    if (settlement !== null) effects.push(settlement);
  }

  #changeReadiness(
    next: MotionGraphReadiness,
    effects: MotionGraphEffect[],
    reason?: string
  ): void {
    const previous = this.#runtime.readiness;
    if (previous === next) return;
    this.#runtime.readiness = next;
    effects.push(freezeEffect({
      type: "readinesschange",
      from: previous,
      to: next,
      ...(reason === undefined ? {} : { reason })
    }));
  }

}

function freezeEffect<T extends MotionGraphEffect>(effect: T): Readonly<T> {
  return Object.freeze(effect);
}
