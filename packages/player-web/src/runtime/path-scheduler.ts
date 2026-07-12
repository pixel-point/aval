import type {
  GraphBodyDefinition,
  GraphEdgeDefinition,
  GraphStartPolicy
} from "@rendered-motion/graph";

import type { DecoderWorkerLimits } from "../decoder-worker/protocol.js";
import type { RuntimeMediaPresentation } from "./model.js";
import { planEdgeLead } from "./edge-lead.js";
import {
  validatePresentationRingCapacity
} from "./presentation-ring.js";
import {
  planUnresolvedSubmissionHorizon,
  type SourceBodyCursor,
  type SubmissionHorizonDecision
} from "./submission-horizon.js";
import type { WorkerSampleFactory } from "./worker-samples.js";
import {
  buildNextPathFrame,
  promoteTargetSequenceToSource,
  type PathSequenceState,
  type ResidentPathTarget
} from "./path-sequence.js";
import {
  PathSchedulerGeneration,
  abortablePathSchedulerActivation,
  checkedPathSchedulerSerial
} from "./path-scheduler-generation.js";
import { PathSchedulerCursorLedger } from "./path-scheduler-cursor-ledger.js";
import {
  PathSchedulerOutput,
  type PathSchedulerExpectedOutput,
  type PathSchedulerOutputDrainReport
} from "./path-scheduler-output.js";
import { pumpPathScheduler } from "./path-scheduler-pump.js";
import { PathSchedulerRoute } from "./path-scheduler-route.js";
import { PathSchedulerResidentRunwayOwner } from "./path-scheduler-resident-runway.js";
import {
  PathSchedulerReservationOwner,
  sameSchedulerMediaIdentity
} from "./path-scheduler-reservation.js";
import {
  validateScheduledBody,
  validateSchedulerId,
  validateSchedulerLimits
} from "./path-scheduler-validation.js";
import {
  PathSchedulerTraceLog
} from "./path-scheduler-trace.js";
import type {
  PathSchedulerClock,
  CommitResidentRunwayOptions,
  PathSchedulerOptions,
  PathSchedulerPumpOptions,
  PathSchedulerPumpReport,
  PathSchedulerResidentRunwayTransaction,
  PathSchedulerSnapshot,
  PathSchedulerStatus,
  PathSchedulerTakeResult,
  PathSchedulerTraceRecord,
  PathSchedulerWorkerActivation,
  PathSchedulerWorkerAdapter,
  PrepareScheduledRouteInput,
  StartResidentRunwayInput,
  StartScheduledBodyInput
} from "./path-scheduler-model.js";

export type {
  PathSchedulerClock,
  CommitResidentRunwayOptions,
  PathSchedulerFramePurpose,
  PathSchedulerOptions,
  PathSchedulerPumpOptions,
  PathSchedulerPumpReport,
  PathSchedulerResidentRunwayTransaction,
  PathSchedulerResidentFrame,
  PathSchedulerSnapshot,
  PathSchedulerStatus,
  PathSchedulerTakeResult,
  PathSchedulerTraceRecord,
  PathSchedulerWorkerActivation,
  PathSchedulerWorkerAdapter,
  PrepareScheduledRouteInput,
  StartResidentRunwayInput,
  StartScheduledBodyInput
} from "./path-scheduler-model.js";

/**
 * Owns one sequential decoder path. Graph routing and promise settlement stay
 * outside this class; callers supply the already-selected edge.
 */
export class PathScheduler {
  readonly #samples: WorkerSampleFactory;
  readonly #worker: PathSchedulerWorkerAdapter;
  readonly #ringCapacity: number;
  readonly #limits: Readonly<DecoderWorkerLimits>;
  readonly #maxBatchSamples: number;
  readonly #traceLog = new PathSchedulerTraceLog();
  readonly #output: PathSchedulerOutput;
  readonly #generationOwner: PathSchedulerGeneration;
  readonly #routeOwner = new PathSchedulerRoute();
  readonly #cursorLedger = new PathSchedulerCursorLedger();
  readonly #reservationOwner = new PathSchedulerReservationOwner();
  readonly #residentRunwayOwner: PathSchedulerResidentRunwayOwner;

  #status: PathSchedulerStatus = "idle";
  #smoothSession = true;
  #build: PathSequenceState | null = null;
  #replacementSerial = 0;

  public constructor(options: PathSchedulerOptions) {
    validatePresentationRingCapacity(options.ringCapacity);
    validateSchedulerLimits(options.limits);
    const maxBatchSamples = options.maxBatchSamples ??
      Math.min(
        options.limits.maxPendingSamples,
        options.limits.maxOutstandingFrames
      );
    if (
      !Number.isSafeInteger(maxBatchSamples) ||
      maxBatchSamples < 1 ||
      maxBatchSamples > options.limits.maxPendingSamples ||
      maxBatchSamples > options.limits.maxOutstandingFrames
    ) {
      throw new RangeError("path scheduler batch limit is invalid");
    }
    validateSchedulerId(options.rendition, "scheduler rendition");
    this.#samples = options.samples;
    this.#worker = options.worker;
    this.#ringCapacity = options.ringCapacity;
    this.#limits = Object.freeze({ ...options.limits });
    this.#maxBatchSamples = maxBatchSamples;
    this.#output = new PathSchedulerOutput({
      worker: options.worker,
      rendition: options.rendition,
      ringCapacity: options.ringCapacity,
      clock: options.clock,
      onTrace: (operation, output, reason) => {
        this.#trace(operation, output, reason);
      }
    });
    this.#generationOwner = new PathSchedulerGeneration({
      timeline: options.timeline,
      worker: options.worker,
      output: this.#output
    });
    this.#residentRunwayOwner = new PathSchedulerResidentRunwayOwner({
      rendition: options.rendition,
      generation: this.#generationOwner,
      output: this.#output,
      route: this.#routeOwner,
      cursors: this.#cursorLedger,
      reservation: this.#reservationOwner
    });
  }

  public async startBody(input: StartScheduledBodyInput): Promise<void> {
    this.#requireStatus("idle");
    validateSchedulerId(input.state, "source state");
    validateSchedulerId(input.path, "scheduler path");
    validateScheduledBody(input.body);
    const firstPresentationOrdinal = input.firstPresentationOrdinal ?? 0n;
    if (firstPresentationOrdinal < 0n) {
      throw new RangeError("first presentation ordinal must be non-negative");
    }

    this.#build = this.#cursorLedger.startSource({
      state: input.state,
      body: input.body,
      outgoingStarts: input.outgoingStarts,
      firstPresentationOrdinal
    });
    try {
      await this.#generationOwner.start(input.path);
      this.#status = "active";
      this.#trace("activate", null, null);
    } catch (error) {
      this.#status = "error";
      this.#smoothSession = false;
      throw error;
    }
  }

  public async prepareRoute(
    input: PrepareScheduledRouteInput
  ): Promise<Readonly<SubmissionHorizonDecision>> {
    this.#requireActive();
    if (
      this.#cursorLedger.displayedSource === null ||
      this.#cursorLedger.sourceBody === null
    ) {
      throw new RangeError("a source frame must be displayed before routing");
    }
    if (input.edge.transition?.kind === "reversible") {
      throw new RangeError(
        "resident reversible motion is not a streaming path segment"
      );
    }
    validateScheduledBody(input.targetBody);
    validateSchedulerId(input.targetState, "target state");
    if (this.#routeOwner.committed) {
      throw new RangeError("a committed path cannot be replaced");
    }

    if (this.#routeOwner.current?.edge.id === input.edge.id) {
      const current = this.routeDecision();
      if (current === null) {
        throw new Error("pending route decision disappeared");
      }
      return current;
    }
    if (this.#routeOwner.current !== null) {
      await this.#restartForReplacement(
        input.replacementPath ?? input.edge.id,
        input.signal,
        input.preserveReservedSource === true
      );
    }

    const decision = this.#calculateRouteDecision(input.edge);
    if (decision.kind === "reject-readiness") {
      return decision;
    }
    if (decision.kind === "restart-generation") {
      return decision;
    }
    const boundary = decision.boundary;
    this.#routeOwner.prepare({
      edge: input.edge,
      targetState: input.targetState,
      targetBody: input.targetBody,
      boundary
    });
    const build = this.#requireBuild();
    if (build.phase === "done") {
      build.phase = "source";
      build.sourceNext = null;
    }
    build.sourceStop = {
      occurrence: boundary.occurrence,
      frame: boundary.frame
    };
    this.#trace("route-select", null, input.edge.id);
    return decision;
  }

  /** Cancels only an uncommitted route and retains the displayed source. */
  public async cancelPreparedRoute(
    replacementPath: string,
    signal?: AbortSignal,
    preserveReservedSource = false
  ): Promise<void> {
    this.#requireActive();
    if (this.#routeOwner.current === null) return;
    if (this.#routeOwner.committed) {
      throw new RangeError("a committed path cannot be cancelled");
    }
    await this.#restartForReplacement(
      replacementPath,
      signal,
      preserveReservedSource
    );
  }

  /** Adopts a resident body pixel only after its successful draw barrier. */
  public async adoptResidentBodyCheckpoint(input: {
    readonly state: string;
    readonly body: Readonly<GraphBodyDefinition>;
    readonly outgoingStarts: readonly GraphStartPolicy[];
    readonly frame: number;
    readonly unitInstance: number;
    readonly presentationOrdinal: bigint;
    readonly path: string;
    readonly signal?: AbortSignal;
  }): Promise<void> {
    this.#requireActive();
    validateSchedulerId(input.state, "resident checkpoint state");
    validateScheduledBody(input.body);
    if (
      !Number.isSafeInteger(input.frame) ||
      input.frame < 0 ||
      input.frame >= input.body.frameCount ||
      input.presentationOrdinal < 0n
    ) {
      throw new RangeError("resident body checkpoint is invalid");
    }
    await this.#activateReplacementGeneration(input.path, input.signal);
    this.#routeOwner.clear();
    this.#residentTarget = null;
    this.#build = this.#cursorLedger.replaceSource({
      kind: "resident-checkpoint",
      state: input.state,
      body: input.body,
      outgoingStarts: input.outgoingStarts,
      frame: input.frame,
      unitInstance: input.unitInstance,
      presentationOrdinal: input.presentationOrdinal,
      path: input.path,
    });
  }

  public routeDecision(): Readonly<SubmissionHorizonDecision> | null {
    this.#requireActive();
    const route = this.#routeOwner.current;
    if (route === null) return null;
    const decision = this.#calculateRouteDecision(route.edge);
    const boundary = this.#routeOwner.reconcileBoundary(
      decision,
      this.#requireBuild().edgeSubmissionStarted
    );
    if (boundary !== null) {
      this.#requireBuild().sourceStop = {
        occurrence: boundary.occurrence,
        frame: boundary.frame
      };
    }
    return decision;
  }

  public commitPreparedRoute(): void {
    this.#requireActive();
    const decision = this.routeDecision();
    if (decision?.kind !== "commit-edge") {
      throw new RangeError("route cannot commit without its exact prepared lead");
    }
    this.#routeOwner.commit();
    this.#trace("route-commit", null, this.#routeOwner.pendingEdge);
  }

  /**
   * Reserves exact generation and resident metadata without replacing the
   * currently visible source. The returned token is the sole commit key.
   */
  public stageResidentRunway(
    input: Readonly<StartResidentRunwayInput>
  ): Readonly<PathSchedulerResidentRunwayTransaction> {
    this.#requireActive();
    return this.#residentRunwayOwner.stage(input);
  }

  /**
   * Installs a staged runway synchronously at the draw barrier. Only the
   * worker acknowledgement remains asynchronous and is returned to the lane.
   */
  public commitResidentRunway(
    transaction: Readonly<PathSchedulerResidentRunwayTransaction>,
    options: Readonly<CommitResidentRunwayOptions> = {}
  ): PathSchedulerWorkerActivation {
    this.#requireActive();
    const committed = this.#residentRunwayOwner.commit(transaction, options);
    this.#build = committed.build;
    this.#residentTarget = committed.residentTarget;
    if (committed.firstPresented !== null) {
      this.#trace("resident-present", null, null, committed.firstPresented);
    }
    this.#trace(
      "generation-retire",
      null,
      String(committed.retiredGeneration)
    );
    this.#trace("activate", null, null);
    return committed.activateWorker;
  }

  /** Invalidates only the matching uncommitted transaction. */
  public rollbackResidentRunway(
    transaction: Readonly<PathSchedulerResidentRunwayTransaction>
  ): boolean {
    return this.#residentRunwayOwner.rollback(transaction);
  }

  public async startResidentRunway(
    input: StartResidentRunwayInput
  ): Promise<void> {
    const transaction = this.stageResidentRunway(input);
    const activateWorker = this.commitResidentRunway(transaction);
    await abortablePathSchedulerActivation(activateWorker(), input.signal);
  }

  public async pump(
    options: PathSchedulerPumpOptions = {}
  ): Promise<Readonly<PathSchedulerPumpReport>> {
    this.#requireActive();
    try {
      return await pumpPathScheduler({
        options,
        ringCapacity: this.#ringCapacity,
        limits: this.#limits,
        maxBatchSamples: this.#maxBatchSamples,
        worker: this.#worker,
        samples: this.#samples,
        output: this.#output,
        build: this.#requireBuild(),
        buildFrame: (state) => buildNextPathFrame(state, {
          sourceState: this.#cursorLedger.sourceState,
          sourceBody: this.#cursorLedger.sourceBody,
          route: this.#routeOwner.current,
          residentTarget: this.#residentTarget,
          canSubmitSource: (cursor) =>
            this.#sourceWithinUnresolvedHorizon(cursor)
        }),
        commitBuild: (state) => {
          this.#build = state;
        },
        recordSubmitted: (outputs) => this.#recordSubmitted(outputs),
        onDrain: (report) => this.#recordDrain(report)
      });
    } catch (error) {
      if (options.signal?.aborted) {
        throw options.signal.reason;
      }
      await this.#fail(error);
      throw error;
    }
  }

  public takeNext(): Readonly<PathSchedulerTakeResult> {
    const result = this.reserveNext();
    if (result.kind === "frame" || result.kind === "resident") {
      this.commitPreparedPresentation(result.media);
    }
    return result;
  }

  /** Removes one ready frame from the ring without claiming it was drawn. */
  public reserveNext(
    allowPreparedRoute = false
  ): Readonly<PathSchedulerTakeResult> {
    this.#requireActive();
    this.#reservationOwner.requireEmpty();
    const resident = this.#output.takeResident();
    if (resident !== undefined) {
      this.#reservationOwner.reserve({
        media: resident,
        output: null,
        commitRoute: false
      });
      return Object.freeze({ kind: "resident", media: resident });
    }

    return this.#reserveNextStreaming(allowPreparedRoute);
  }

  /**
   * Reserves the decoded continuation behind a resident runway without
   * consuming its presentation queue. Resident coordinators own those pixels.
   */
  public takeStreamingContinuation(): Readonly<PathSchedulerTakeResult> {
    this.#requireActive();
    this.#reservationOwner.requireEmpty();
    return this.#reserveNextStreaming(false);
  }

  /** Commits the sole reserved frame only after its successful draw barrier. */
  public commitPreparedPresentation(
    media: Readonly<Extract<
      RuntimeMediaPresentation,
      { readonly kind: "frame" }
    >>
  ): void {
    this.#requireActive();
    const reserved = this.#reservationOwner.consume(media);
    if (reserved.commitRoute) {
      this.#routeOwner.commit();
      this.#trace("route-commit", null, this.#routeOwner.pendingEdge);
    }
    if (reserved.output === null) {
      this.#cursorLedger.recordResidentDisplayed(media);
      this.#trace("resident-present", null, null, media);
    } else {
      this.#recordDisplayed(reserved.output, media);
      this.#trace("present", reserved.output, null, media);
    }
  }

  /** Consumes matching resident metadata drawn by a persistent cache owner. */
  public commitResidentPresentation(
    media: Readonly<Extract<
      RuntimeMediaPresentation,
      { readonly kind: "frame" }
    >>
  ): void {
    this.#requireActive();
    const resident = this.#output.takeResident();
    if (resident === undefined || !sameSchedulerMediaIdentity(resident, media)) {
      throw new RangeError("scheduler resident presentation diverged");
    }
    this.#cursorLedger.recordResidentDisplayed(media);
    this.#trace("resident-present", null, null, media);
  }

  /** Atomically adopts a completed target as the next routable source. */
  public promoteTargetToSource(input: {
    readonly state: string;
    readonly body: GraphBodyDefinition;
    readonly outgoingStarts: readonly GraphStartPolicy[];
  }): void {
    this.#requireActive();
    this.#reservationOwner.requireEmpty();
    const routeTarget = this.#routeOwner.current;
    const targetState = routeTarget?.targetState ??
      this.#residentTarget?.targetState;
    const targetBody = routeTarget?.targetBody ??
      this.#residentTarget?.targetBody;
    if (
      targetState !== input.state ||
      targetBody?.unitId !== input.body.unitId ||
      this.#cursorLedger.displayedTarget === null
    ) {
      throw new RangeError("scheduler target cannot be promoted to this source");
    }
    this.#output.promoteTargetToSource(input.state, input.body);
    promoteTargetSequenceToSource(this.#requireBuild(), input.body);
    this.#cursorLedger.promoteTargetToSource(input);
    this.#residentTarget = null;
    this.#routeOwner.clear();
  }

  public discardPreparedPresentation(): void {
    this.#reservationOwner.discard();
  }

  /** Records a held-body repeat that reuses the last uploaded pixels. */
  public commitHeldPresentation(ordinal: bigint): void {
    this.#requireActive();
    this.#reservationOwner.requireEmpty();
    this.#cursorLedger.recordHeld(ordinal);
    this.#requireBuild().nextPresentationOrdinal = ordinal + 1n;
  }

  #reserveNextStreaming(
    allowPreparedRoute: boolean
  ): Readonly<PathSchedulerTakeResult> {

    const next = this.#output.peekRingOutput();
    if (next !== undefined) {
      let commitRoute = false;
      if (
        next.plan.purpose !== "source" &&
        this.#routeOwner.current !== null &&
        !this.#routeOwner.committed
      ) {
        if (
          !allowPreparedRoute ||
          this.routeDecision()?.kind !== "commit-edge"
        ) return Object.freeze({ kind: "route-blocked" });
        commitRoute = true;
      }
      if (
        next.plan.purpose === "bridge" &&
        !this.#lockedBridgeLeadReady()
      ) {
        return this.#underflow();
      }
      const result = this.#output.takeRingOutput();
      if (result.kind === "underflow") {
        return this.#underflow();
      }
      const media = this.#output.mediaFor(result.output);
      this.#reservationOwner.reserve({
        media,
        output: result.output,
        commitRoute
      });
      return Object.freeze({
        kind: "frame",
        purpose: next.plan.purpose,
        media,
        frame: result.frame
      });
    }

    if (this.#output.hasExpected() || this.#buildHasMoreFrames()) {
      return this.#underflow();
    }
    return Object.freeze({ kind: "held" });
  }

  public snapshot(): Readonly<PathSchedulerSnapshot> {
    const cursors = this.#cursorLedger.snapshot();
    return Object.freeze({
      generation: this.#generationOwner.current,
      activePath: this.#generationOwner.path,
      sourceCursor: cursors.sourceCursor === null
        ? null
        : Object.freeze({
            ...cursors.sourceCursor,
            path: this.#generationOwner.path ?? ""
          }),
      submittedCursor: cursors.submittedCursor,
      decodedCursor: cursors.decodedCursor,
      displayedCursor: cursors.displayedCursor,
      ringSize: this.#output.ringSize,
      ringCapacity: this.#ringCapacity,
      smoothSession: this.#smoothSession,
      status: this.#status,
      pendingEdge: this.#routeOwner.pendingEdge,
      expectedOutputs: this.#output.expectedCount,
      residentFrames: this.#output.residentCount,
      discardedDependencyFrames: this.#output.discardedDependencyFrames,
      staleFrames: this.#output.staleFrames,
      nextDecodeOrdinal: this.#generationOwner.nextDecodeOrdinal,
      submittedSource: cursors.submittedSource,
      displayedSource: cursors.displayedSource,
      unresolvedMaximumSubmitted: this.#unresolvedMaximumSubmitted()
    });
  }

  public trace(): readonly Readonly<PathSchedulerTraceRecord>[] {
    return this.#traceLog.snapshot();
  }

  public async dispose(): Promise<void> {
    if (this.#status === "disposed") return;
    this.#residentRunwayOwner.clear();
    this.#reservationOwner.discard();
    this.#output.dispose();
    await this.#generationOwner.dispose();
    this.#status = "disposed";
    this.#trace("dispose", null, null);
  }

  // Resident recovery is a target path without a graph-owned streaming edge.
  #residentTarget: ResidentPathTarget | null = null;

  #recordSubmitted(
    outputs: readonly Readonly<PathSchedulerExpectedOutput>[]
  ): void {
    this.#cursorLedger.recordSubmitted(outputs, this.#requirePath());
    for (const output of outputs) {
      this.#trace("submit", output, null);
    }
  }

  #recordDrain(report: Readonly<PathSchedulerOutputDrainReport>): void {
    this.#cursorLedger.recordDrain(report);
  }

  #calculateRouteDecision(edge: GraphEdgeDefinition): SubmissionHorizonDecision {
    const body = this.#cursorLedger.sourceBody;
    const displayed = this.#cursorLedger.displayedSource;
    if (body === null || displayed === null) {
      throw new RangeError("route decision requires a displayed source cursor");
    }
    return this.#routeOwner.decide(edge, {
      body,
      displayed,
      submitted: this.#cursorLedger.submittedSource ?? displayed,
      ringCapacity: this.#ringCapacity,
      availableConsecutiveEdgeFrames: this.#availableEdgeLead()
    });
  }

  #availableEdgeLead(): number {
    return this.#output.availableEdgeLead();
  }

  #lockedBridgeLeadReady(): boolean {
    const transition = this.#routeOwner.current?.edge.transition;
    if (transition?.kind !== "locked") return true;
    return planEdgeLead({
      transitionFrames: transition.frameCount,
      ringCapacity: this.#ringCapacity,
      availableConsecutiveFrames: this.#availableEdgeLead()
    }).ready;
  }

  #recordDisplayed(
    output: Readonly<PathSchedulerExpectedOutput>,
    media: Extract<RuntimeMediaPresentation, { readonly kind: "frame" }>
  ): void {
    if (this.#cursorLedger.recordDisplayed(output, media)) {
      this.#routeOwner.noteDisplayedSource();
    }
  }

  async #restartForReplacement(
    path: string,
    signal?: AbortSignal,
    preserveReservedSource = false
  ): Promise<void> {
    const body = this.#cursorLedger.sourceBody;
    const displayed = this.#cursorLedger.displayedSource;
    if (body === null || displayed === null) {
      throw new RangeError("route replacement requires a displayed source");
    }
    const reserved = preserveReservedSource
      ? this.#reservationOwner.current
      : null;
    const reservedSource = reserved?.output?.plan.sourceCursor ?? null;
    if (
      preserveReservedSource &&
      (reserved === null ||
        reserved.output?.plan.purpose !== "source" ||
        reservedSource === null)
    ) {
      throw new RangeError(
        "route replacement can preserve only a source reservation"
      );
    }
    const checkpoint = reservedSource ?? displayed;
    await this.#activateReplacementGeneration(
      path,
      signal,
      preserveReservedSource
    );
    this.#routeOwner.clear();
    const firstPresentationOrdinal = reserved === null
      ? (this.#cursorLedger.lastDisplayedOrdinal ?? -1n) + 1n
      : reserved.media.intendedPresentationOrdinal + 1n;
    this.#build = this.#cursorLedger.replaceSource({
      kind: "route-restart",
      checkpoint,
      firstPresentationOrdinal
    });
  }

  async #activateReplacementGeneration(
    path: string,
    signal?: AbortSignal,
    preserveReservation = false
  ): Promise<number> {
    if (signal?.aborted === true) throw signal.reason;
    if (this.#residentRunwayOwner.locked) {
      throw new RangeError(
        "path scheduler generation is locked by a staged resident runway"
      );
    }
    validateSchedulerId(path, "replacement path");
    const oldGeneration = this.#requireGeneration();
    if (!preserveReservation) this.#reservationOwner.discard();
    const serial = checkedPathSchedulerSerial(this.#replacementSerial);
    this.#replacementSerial = serial;
    const activation = this.#generationOwner.replace(path);
    const generation = this.#generationOwner.current;
    if (generation === null) {
      throw new RangeError("replacement generation was not installed");
    }
    await abortablePathSchedulerActivation(activation, signal);
    if (
      serial !== this.#replacementSerial ||
      generation !== this.#generationOwner.current
    ) {
      throw new DOMException(
        "path scheduler activation was superseded",
        "AbortError"
      );
    }
    this.#trace("generation-retire", null, String(oldGeneration));
    this.#trace("activate", null, null);
    return generation;
  }

  async #fail(error: unknown): Promise<void> {
    if (this.#status !== "active") return;
    this.#smoothSession = false;
    this.#status = "error";
    try {
      this.#output.clear();
    } catch {
      // Preserve the initiating failure; managed handles are close-once.
    }
    try {
      await this.#generationOwner.abortActive();
    } catch {
      // Preserve the initiating failure.
    }
    const failureName = error instanceof Error ? error.name : "unknown-failure";
    this.#trace(
      failureName.includes("Watchdog") ? "watchdog" : "failure",
      null,
      failureName
    );
  }

  #underflow(): Readonly<PathSchedulerTakeResult> {
    this.#smoothSession = false;
    this.#trace("underflow", this.#output.peekRingOutput() ?? null, null);
    return Object.freeze({ kind: "underflow" });
  }

  #sourceWithinUnresolvedHorizon(proposed: SourceBodyCursor): boolean {
    const body = this.#cursorLedger.sourceBody;
    const outgoingStarts = this.#cursorLedger.outgoingStarts;
    if (outgoingStarts.length === 0 || body === null) {
      return true;
    }
    const displayed = this.#cursorLedger.displayedSource ?? {
      occurrence: 0n,
      frame: 0
    };
    const result = planUnresolvedSubmissionHorizon({
      body,
      displayed,
      submitted: proposed,
      outgoingStarts,
      ringCapacity: this.#ringCapacity
    });
    return result.submittedWithinHorizon;
  }

  #unresolvedMaximumSubmitted(): Readonly<SourceBodyCursor> | null {
    const body = this.#cursorLedger.sourceBody;
    const outgoingStarts = this.#cursorLedger.outgoingStarts;
    if (
      body === null ||
      outgoingStarts.length === 0 ||
      this.#routeOwner.current !== null
    ) {
      return null;
    }
    const displayed = this.#cursorLedger.displayedSource ?? {
      occurrence: 0n,
      frame: 0
    };
    const submitted = this.#cursorLedger.submittedSource ?? displayed;
    try {
      return planUnresolvedSubmissionHorizon({
        body,
        displayed,
        submitted,
        outgoingStarts,
        ringCapacity: this.#ringCapacity
      }).maximumSubmitted;
    } catch {
      return null;
    }
  }

  #buildHasMoreFrames(): boolean {
    const build = this.#build;
    return build !== null && build.phase !== "done";
  }

  #trace(
    operation: PathSchedulerTraceRecord["operation"],
    output: Readonly<PathSchedulerExpectedOutput> | null,
    reason: string | null,
    media: Extract<RuntimeMediaPresentation, { readonly kind: "frame" }> |
      null = null
  ): void {
    this.#traceLog.append({
      operation,
      generation: this.#generationOwner.current,
      path: this.#generationOwner.path,
      unit: output?.sample.unitId ?? media?.frame.unit ?? null,
      unitInstance: output?.sample.unitInstance ?? media?.unitInstance ?? null,
      unitFrame: output?.sample.unitFrame ?? media?.frame.localFrame ?? null,
      decodeOrdinal: output?.sample.ordinal ?? media?.decodeOrdinal ?? null,
      intendedPresentationOrdinal:
        output?.plan.intendedPresentationOrdinal ??
        media?.intendedPresentationOrdinal ?? null,
      ringSize: this.#output.ringSize,
      expectedOutputs: this.#output.expectedCount,
      reason
    });
  }

  #requireStatus(expected: PathSchedulerStatus): void {
    if (this.#status !== expected) {
      throw new RangeError(`path scheduler must be ${expected}`);
    }
  }

  #requireActive(): void {
    this.#requireStatus("active");
  }

  #requireGeneration(): number {
    return this.#generationOwner.requireGeneration();
  }

  #requirePath(): string {
    return this.#generationOwner.requirePath();
  }

  #requireBuild(): PathSequenceState {
    if (this.#build === null) {
      throw new RangeError("path scheduler has no active build state");
    }
    return this.#build;
  }
}
