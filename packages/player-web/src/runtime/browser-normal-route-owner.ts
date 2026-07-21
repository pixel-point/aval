import type { GraphEdgeDefinition, GraphPresentation } from "@pixel-point/aval-graph";
import {
  FRAME_STREAMING_SLOT_COUNT,
  type RenderFrameHandle,
  type StreamingFrameHandle
} from "./frame-renderer.js";
import type { BrowserFrameMedia } from "./browser-playback-types.js";

import type {
  VideoCandidateActivationInput,
  VideoCandidateReadinessSessionInput
} from "./video-candidate-factory.js";
import {
  type PathScheduler,
  type PathSchedulerSnapshot
} from "./path-scheduler.js";
import {
  BROWSER_RUNTIME_MEDIA_TIMEOUT_MS,
  assertBrowserFrame,
  browserOutgoingStarts,
  requireBrowserState,
  safeBrowserSchedulerSnapshot,
  type BrowserNormalReady
} from "./browser-playback-types.js";
import {
  integratedActivationPresentationOrdinal
} from "./integrated-player-support.js";
import {
  planWorkerSampleGroupCredit,
  type WorkerSampleGroupRequirement,
  type WorkerSampleOutput
} from "./worker-samples.js";

/** Owns the sole streaming scheduler and all normal/intro media preparation. */
export class BrowserNormalRouteOwner {
  readonly #candidate: Readonly<VideoCandidateReadinessSessionInput>;
  readonly #activation: Readonly<VideoCandidateActivationInput>;
  #scheduler: PathScheduler;
  #lastSnapshot: Readonly<PathSchedulerSnapshot>;
  #prefix: BrowserInitialPrefix | null = null;
  #lastPresented: Readonly<BrowserNormalReady> | null = null;
  #disposed = false;

  public constructor(options: {
    readonly candidate: Readonly<VideoCandidateReadinessSessionInput>;
    readonly activation: Readonly<VideoCandidateActivationInput>;
  }) {
    this.#candidate = options.candidate;
    this.#activation = options.activation;
    this.#scheduler = options.activation.scheduler;
    this.#lastSnapshot = this.#scheduler.snapshot();
  }

  public get scheduler(): PathScheduler {
    return this.#scheduler;
  }

  public get generation(): number {
    return this.#scheduler.snapshot().generation ?? 1;
  }

  public get retainedStreamingSlot(): number | null {
    const handle = this.#lastPresented?.handle;
    return handle?.kind === "stream" ? handle.slot : null;
  }

  public snapshot(): Readonly<PathSchedulerSnapshot> {
    const current = safeBrowserSchedulerSnapshot(this.#scheduler);
    if (current !== null) this.#lastSnapshot = current;
    return this.#lastSnapshot;
  }

  public commitPrepared(ready: Readonly<BrowserNormalReady>): void {
    if (ready.schedulerReservation) {
      const scheduler = ready.scheduler;
      if (scheduler === null) {
        throw new Error("browser scheduler reservation has no owner");
      }
      scheduler.commitPreparedPresentation(ready.media);
      if (ready.purpose === "target" && ready.media.state !== null) {
        this.#promoteTargetToSource(ready.media.state, scheduler);
      }
    } else if (ready.heldPresentation) {
      (ready.scheduler ?? this.#scheduler).commitHeldPresentation(
        ready.media.intendedPresentationOrdinal
      );
    }
    this.#lastPresented = ready;
  }

  public promoteTargetToSource(stateId: string): void {
    this.#promoteTargetToSource(stateId, this.#scheduler);
  }

  public adoptStreamingHandoff(
    media: Readonly<BrowserFrameMedia>,
    handle: Readonly<StreamingFrameHandle>
  ): void {
    this.#lastPresented = Object.freeze({
      media,
      handle,
      routeReady: false,
      purpose: "source",
      schedulerReservation: false,
      heldPresentation: false,
      scheduler: this.#scheduler
    });
  }

  public async adoptResidentBodyCheckpoint(
    media: Readonly<BrowserFrameMedia>,
    handle: Readonly<RenderFrameHandle>,
    signal: AbortSignal
  ): Promise<void> {
    if (
      media.kind !== "frame" ||
      media.graphKind !== "body" ||
      media.state === null ||
      handle.kind !== "resident"
    ) {
      throw new Error("browser resident body checkpoint is invalid");
    }
    const state = requireBrowserState(this.#candidate, media.state);
    await this.#scheduler.adoptResidentBodyCheckpoint({
      state: state.id,
      body: state.body,
      outgoingStarts: browserOutgoingStarts(this.#candidate, state.id),
      frame: media.frame.localFrame,
      unitInstance: media.unitInstance,
      presentationOrdinal: media.intendedPresentationOrdinal,
      path: `resident:${state.id}`,
      signal
    });
    this.#lastPresented = Object.freeze({
      media,
      handle,
      routeReady: false,
      purpose: "source",
      schedulerReservation: false,
      heldPresentation: false,
      scheduler: this.#scheduler
    });
  }

  #promoteTargetToSource(
    stateId: string,
    scheduler: PathScheduler
  ): void {
    if (scheduler !== this.#scheduler) {
      throw new Error("browser target promotion belongs to a retired scheduler");
    }
    const state = requireBrowserState(this.#candidate, stateId);
    scheduler.promoteTargetToSource({
      state: state.id,
      body: state.body,
      outgoingStarts: browserOutgoingStarts(this.#candidate, state.id)
    });
  }

  public discardPrepared(ready: Readonly<BrowserNormalReady>): void {
    if (ready.schedulerReservation) {
      ready.scheduler?.discardPreparedPresentation();
    }
  }

  public async prepareInitial(
    expected: Readonly<GraphPresentation>,
    signal: AbortSignal
  ): Promise<Readonly<BrowserNormalReady>> {
    this.#assertActive();
    const activationOrdinal = integratedActivationPresentationOrdinal(
      this.#activation.graphSnapshot
    );
    if (expected.kind === "intro") {
      const prefix = new BrowserInitialPrefix({
        candidate: this.#candidate,
        state: expected.state,
        unit: expected.unitId
      });
      this.#prefix = prefix;
      return prefix.prepare(expected.frameIndex, activationOrdinal, signal);
    }
    if (expected.kind !== "body") {
      throw new Error("video activation requires intro or body frame zero");
    }
    await this.#startBody(expected.state, activationOrdinal);
    return this.#takeAndUpload(false, signal);
  }

  public async prepareAfterIntro(
    presentation: Extract<GraphPresentation, { readonly kind: "intro" }>,
    signal: AbortSignal
  ): Promise<Readonly<BrowserNormalReady>> {
    this.#assertActive();
    const prefix = this.#prefix;
    if (prefix === null) throw new Error("browser initial prefix is absent");
    const state = requireBrowserState(this.#candidate, presentation.state);
    if (presentation.frameIndex + 1 < state.initialUnit!.frameCount) {
      return prefix.prepare(
        presentation.frameIndex + 1,
        integratedActivationPresentationOrdinal(
          this.#activation.graphSnapshot
        ) +
          BigInt(presentation.frameIndex + 1),
        signal
      );
    }
    prefix.dispose();
    this.#prefix = null;
    await this.#startBody(
      presentation.state,
      integratedActivationPresentationOrdinal(
        this.#activation.graphSnapshot
      ) +
        BigInt(presentation.frameIndex + 1)
    );
    return this.#takeAndUpload(false, signal);
  }

  public async prepareBodyNext(options: {
    readonly presentation: Extract<GraphPresentation, { readonly kind: "body" }>;
    readonly contentOrdinal: bigint | null;
    readonly edge: Readonly<GraphEdgeDefinition> | null;
    readonly rebuild: boolean;
    readonly signal: AbortSignal;
  }): Promise<Readonly<BrowserNormalReady>> {
    this.#assertActive();
    const edge = options.edge;
    if (
      options.rebuild &&
      edge === null &&
      this.#scheduler.snapshot().pendingEdge !== null
    ) {
      await this.#scheduler.cancelPreparedRoute(
        `cancel:${options.presentation.state}`,
        options.signal
      );
    }
    if (
      edge !== null &&
      edge.start.type !== "cut" &&
      edge.transition?.kind !== "reversible" &&
      this.#scheduler.snapshot().pendingEdge !== edge.id
    ) {
      const target = requireBrowserState(this.#candidate, edge.to);
      await this.#scheduler.prepareRoute({
        edge,
        targetState: target.id,
        targetBody: target.body,
        replacementPath: `route:${edge.id}`,
        signal: options.signal
      });
    }
    return this.#takeAndUpload(
      true,
      options.signal,
      (options.contentOrdinal ?? -1n) + 2n
    );
  }

  /** Continues an already-committed bridge/target path without rerouting. */
  public prepareStreamingContinuation(
    signal: AbortSignal
  ): Promise<Readonly<BrowserNormalReady>> {
    this.#assertActive();
    return this.#takeAndUpload(false, signal);
  }

  public cancelPreparedRoute(
    replacementPath: string,
    signal: AbortSignal
  ): Promise<void> {
    this.#assertActive();
    return this.#scheduler.cancelPreparedRoute(replacementPath, signal);
  }

  /** Reconciles a route selected while this exact source upload was pending. */
  public async reconcilePreparedSourceRoute(
    ready: Readonly<BrowserNormalReady>,
    edge: Readonly<GraphEdgeDefinition> | null,
    signal: AbortSignal
  ): Promise<Readonly<BrowserNormalReady>> {
    if (
      !ready.schedulerReservation ||
      ready.purpose !== "source" ||
      ready.scheduler !== this.#scheduler
    ) return ready;
    const current = this.#scheduler.snapshot().pendingEdge;
    const desiredStreaming = edge !== null &&
      edge.start.type !== "cut" &&
      edge.transition?.kind !== "reversible"
      ? edge
      : null;
    if (current === (desiredStreaming?.id ?? null)) return ready;
    if (desiredStreaming === null) {
      await this.#scheduler.cancelPreparedRoute(
        `cancel:${ready.media.state ?? "source"}`,
        signal,
        true
      );
    } else {
      const target = requireBrowserState(this.#candidate, desiredStreaming.to);
      await this.#scheduler.prepareRoute({
        edge: desiredStreaming,
        targetState: target.id,
        targetBody: target.body,
        replacementPath: `route:${desiredStreaming.id}`,
        signal,
        preserveReservedSource: true
      });
    }
    return Object.freeze({
      ...ready,
      routeReady: false,
      scheduler: this.#scheduler
    });
  }

  public async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#prefix?.dispose();
    this.#prefix = null;
    await this.#scheduler.dispose();
  }

  async #takeAndUpload(
    allowRoute: boolean,
    signal: AbortSignal,
    heldOrdinal?: bigint
  ): Promise<Readonly<BrowserNormalReady>> {
    await this.#scheduler.pump({
      targetRingFrames: this.#activation.finalResourcePlan.ringCapacity,
      signal,
      timeoutMs: BROWSER_RUNTIME_MEDIA_TIMEOUT_MS
    });
    let routeReady = false;
    if (allowRoute && this.#scheduler.snapshot().pendingEdge !== null) {
      const decision = this.#scheduler.routeDecision();
      routeReady = decision?.kind === "commit-edge";
    }
    const next = this.#scheduler.reserveNext(routeReady);
    if (next.kind === "held") {
      if (heldOrdinal === undefined) {
        throw new Error("browser held presentation has no graph ordinal");
      }
      const previous = this.#lastPresented;
      if (previous?.media.graphKind !== "body") {
        throw new Error("browser held presentation has no retained body frame");
      }
      return Object.freeze({
        ...previous,
        media: Object.freeze({
          ...previous.media,
          intendedPresentationOrdinal: heldOrdinal
        }),
        routeReady: false,
        purpose: "source",
        schedulerReservation: false,
        heldPresentation: true,
        scheduler: this.#scheduler
      });
    }
    if (next.kind !== "frame") {
      throw new Error(`browser scheduler produced ${next.kind}`);
    }
    let handle: Readonly<StreamingFrameHandle> | null;
    try {
      handle = await this.#candidate.renderer.uploadStreaming(
        this.#selectStreamingSlot(next.media.intendedPresentationOrdinal),
        next.media.generation,
        next.frame
      );
    } catch (error) {
      this.#scheduler.discardPreparedPresentation();
      if (!next.frame.closed) next.frame.close();
      throw error;
    }
    if (handle === null) {
      this.#scheduler.discardPreparedPresentation();
      if (!next.frame.closed) next.frame.close();
      throw new Error("browser streaming upload became stale");
    }
    return Object.freeze({
      media: next.media,
      handle,
      routeReady: routeReady && next.purpose !== "source",
      purpose: next.purpose,
      schedulerReservation: true,
      heldPresentation: false,
      scheduler: this.#scheduler
    });
  }

  /** Keeps the last committed stream pixels valid across discarded uploads. */
  #selectStreamingSlot(ordinal: bigint): number {
    const preferred = Number(
      ordinal % BigInt(FRAME_STREAMING_SLOT_COUNT)
    );
    const retained = this.#lastPresented?.handle;
    if (retained?.kind !== "stream" || retained.slot !== preferred) {
      return preferred;
    }
    return (preferred + 1) % FRAME_STREAMING_SLOT_COUNT;
  }

  async #startBody(stateId: string, firstOrdinal: bigint): Promise<void> {
    const state = requireBrowserState(this.#candidate, stateId);
    await this.#scheduler.startBody({
      state: state.id,
      body: state.body,
      outgoingStarts: browserOutgoingStarts(this.#candidate, state.id),
      path: `body:${state.id}`,
      firstPresentationOrdinal: firstOrdinal
    });
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error("browser normal route owner is disposed");
  }
}

class BrowserInitialPrefix {
  readonly #candidate: Readonly<VideoCandidateReadinessSessionInput>;
  readonly #state: string;
  readonly #unit: string;
  readonly #unitFrameCount: number;
  readonly #generation: number;
  #slot = 0;
  #nextRequestedFrame = 0;
  #nextSubmissionFrame = 0;
  readonly #expected: Readonly<WorkerSampleOutput>[] = [];
  #disposed = false;

  public constructor(options: {
    readonly candidate: Readonly<VideoCandidateReadinessSessionInput>;
    readonly state: string;
    readonly unit: string;
  }) {
    this.#candidate = options.candidate;
    this.#state = options.state;
    this.#unit = options.unit;
    const initialUnit = requireBrowserState(
      options.candidate,
      options.state
    ).initialUnit;
    if (initialUnit === undefined || initialUnit.unitId !== options.unit) {
      throw new Error("initial prefix unit disagrees with the graph state");
    }
    this.#unitFrameCount = initialUnit.frameCount;
    this.#generation = options.candidate.timeline.activateNextGeneration();
  }

  public async prepare(
    frameIndex: number,
    ordinal: bigint,
    signal: AbortSignal
  ): Promise<Readonly<BrowserNormalReady>> {
    if (this.#disposed) throw new Error("initial prefix is disposed");
    if (frameIndex !== this.#nextRequestedFrame) {
      throw new Error("initial prefix presentation order diverged");
    }
    if (this.#candidate.worker.activeGeneration !== this.#generation) {
      await this.#candidate.worker.activateGeneration(this.#generation);
    }
    for (;;) {
      const frame = this.#candidate.worker.takeFrame();
      if (frame !== undefined) {
        const output = this.#expected.shift();
        if (output === undefined) {
          frame.close();
          throw new Error("initial prefix produced an unexpected frame");
        }
        try {
          assertBrowserFrame(frame, output, this.#generation);
        } catch (error) {
          frame.close();
          throw error;
        }
        if (output.unitFrame !== frameIndex) {
          frame.close();
          throw new Error("initial prefix presentation order diverged");
        }
        const handle = await this.#candidate.renderer.uploadStreaming(
          this.#slot,
          this.#generation,
          frame
        );
        if (handle === null) {
          throw new Error("initial prefix upload became stale");
        }
        this.#slot = (this.#slot + 1) % FRAME_STREAMING_SLOT_COUNT;
        this.#nextRequestedFrame += 1;
        return this.#ready(frameIndex, ordinal, output, handle);
      }
      if (this.#candidate.worker.queuedFrames > 0) {
        throw new Error("initial prefix frame queue is inconsistent");
      }

      const metrics = await this.#candidate.worker.snapshotMetrics();
      const requirement = this.#nextRequirement();
      const outstanding = checkedInitialOutstanding(
        metrics.submittedFrames,
        metrics.leasedFrames
      );
      if (
        requirement !== null &&
        planWorkerSampleGroupCredit(
          requirement,
          {
            pendingSamples: metrics.pendingSamples,
            outstandingFrames: outstanding
          },
          this.#candidate.limits
        ).fits
      ) {
        const batch = this.#candidate.samples.createBatch({
          frames: Array.from(
            { length: requirement.frameCount },
            (_, index) => ({
              unitId: this.#unit,
              unitFrame: requirement.firstUnitFrame + index
            })
          ),
          pendingSamples: metrics.pendingSamples,
          outstandingFrames: outstanding
        });
        try {
          await this.#candidate.worker.submit(this.#generation, batch.samples);
        } finally {
          batch.release?.();
        }
        this.#expected.push(...batch.outputs);
        this.#nextSubmissionFrame += requirement.frameCount;
        continue;
      }

      if (this.#expected.length === 0) {
        throw new Error("initial prefix cannot make bounded decode progress");
      }
      const queuedBefore = this.#candidate.worker.queuedFrames;
      await this.#candidate.worker.waitForFrames(1, {
        signal,
        timeoutMs: BROWSER_RUNTIME_MEDIA_TIMEOUT_MS
      });
      if (
        this.#candidate.worker.queuedFrames <= queuedBefore &&
        this.#candidate.worker.queuedFrames === 0
      ) {
        throw new Error("initial prefix frame wait resolved without output");
      }
    }
  }

  #nextRequirement(): Readonly<WorkerSampleGroupRequirement> | null {
    if (this.#nextSubmissionFrame >= this.#unitFrameCount) return null;
    const requirement = this.#candidate.samples.nextGroupRequirement({
      unitId: this.#unit,
      unitFrame: this.#nextSubmissionFrame
    });
    if (
      requirement.unitId !== this.#unit ||
      requirement.firstUnitFrame !== this.#nextSubmissionFrame ||
      !Number.isSafeInteger(requirement.frameCount) ||
      requirement.frameCount < 1 ||
      !Number.isSafeInteger(requirement.chunkCount) ||
      requirement.chunkCount < 1 ||
      requirement.frameCount >
        this.#unitFrameCount - this.#nextSubmissionFrame ||
      requirement.frameCount > this.#candidate.limits.maxOutstandingFrames ||
      requirement.chunkCount > this.#candidate.limits.maxPendingSamples
    ) {
      throw new RangeError("initial codec group exceeds configured limits");
    }
    return requirement;
  }

  #ready(
    frameIndex: number,
    ordinal: bigint,
    sample: Readonly<{
      readonly ordinal: number;
      readonly unitInstance: number;
      readonly timestamp: number;
    }>,
    handle: StreamingFrameHandle
  ): Readonly<BrowserNormalReady> {
    return Object.freeze({
      media: Object.freeze({
        kind: "frame",
        graphKind: "intro",
        state: this.#state,
        edge: null,
        path: `intro:${this.#state}`,
        frame: Object.freeze({
          rendition: this.#candidate.context.candidate.rendition.id,
          unit: this.#unit,
          localFrame: frameIndex
        }),
        drawSource: "streaming",
        generation: this.#generation,
        unitInstance: sample.unitInstance,
        decodeOrdinal: sample.ordinal,
        timestamp: sample.timestamp,
        intendedPresentationOrdinal: ordinal
      }),
      handle,
      routeReady: false,
      purpose: "intro",
      schedulerReservation: false,
      heldPresentation: false,
      scheduler: null
    });
  }

  public dispose(): void {
    this.#disposed = true;
    this.#expected.length = 0;
  }
}

function checkedInitialOutstanding(
  submittedFrames: number,
  leasedFrames: number
): number {
  if (
    !Number.isSafeInteger(submittedFrames) ||
    submittedFrames < 0 ||
    !Number.isSafeInteger(leasedFrames) ||
    leasedFrames < 0 ||
    submittedFrames > Number.MAX_SAFE_INTEGER - leasedFrames
  ) {
    throw new RangeError("initial prefix outstanding frames are invalid");
  }
  return submittedFrames + leasedFrames;
}
