import type { GraphEdgeDefinition, GraphPresentation } from "@rendered-motion/graph";
import {
  OPAQUE_STREAMING_SLOT_COUNT,
  type RenderFrameHandle,
  type StreamingFrameHandle
} from "./opaque-frame-renderer.js";
import type { BrowserFrameMedia } from "./browser-playback-types.js";

import type {
  OpaqueCandidateActivationInput,
  OpaqueCandidateReadinessSessionInput
} from "./opaque-candidate-factory.js";
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

/** Owns the sole streaming scheduler and all normal/intro media preparation. */
export class BrowserNormalRouteOwner {
  readonly #candidate: Readonly<OpaqueCandidateReadinessSessionInput>;
  readonly #activation: Readonly<OpaqueCandidateActivationInput>;
  #scheduler: PathScheduler;
  #lastSnapshot: Readonly<PathSchedulerSnapshot>;
  #prefix: BrowserInitialPrefix | null = null;
  #lastPresented: Readonly<BrowserNormalReady> | null = null;
  #disposed = false;

  public constructor(options: {
    readonly candidate: Readonly<OpaqueCandidateReadinessSessionInput>;
    readonly activation: Readonly<OpaqueCandidateActivationInput>;
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

  public get hasInitialPrefix(): boolean {
    return this.#prefix !== null;
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
    if (expected.kind === "intro") {
      const prefix = new BrowserInitialPrefix({
        candidate: this.#candidate,
        state: expected.state,
        unit: expected.unitId
      });
      this.#prefix = prefix;
      return prefix.prepare(expected.frameIndex, 0n, signal);
    }
    if (expected.kind !== "body") {
      throw new Error("opaque activation requires intro or body frame zero");
    }
    await this.#startBody(expected.state, 0n);
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
        BigInt(presentation.frameIndex + 1),
        signal
      );
    }
    prefix.dispose();
    this.#prefix = null;
    await this.#startBody(
      presentation.state,
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
    const handle = await this.#candidate.renderer.uploadStreaming(
      this.#selectStreamingSlot(next.media.intendedPresentationOrdinal),
      next.media.generation,
      next.frame
    );
    if (handle === null) throw new Error("browser streaming upload became stale");
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
      ordinal % BigInt(OPAQUE_STREAMING_SLOT_COUNT)
    );
    const retained = this.#lastPresented?.handle;
    if (retained?.kind !== "stream" || retained.slot !== preferred) {
      return preferred;
    }
    return (preferred + 1) % OPAQUE_STREAMING_SLOT_COUNT;
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
  readonly #candidate: Readonly<OpaqueCandidateReadinessSessionInput>;
  readonly #state: string;
  readonly #unit: string;
  readonly #generation: number;
  #slot = 0;
  #disposed = false;

  public constructor(options: {
    readonly candidate: Readonly<OpaqueCandidateReadinessSessionInput>;
    readonly state: string;
    readonly unit: string;
  }) {
    this.#candidate = options.candidate;
    this.#state = options.state;
    this.#unit = options.unit;
    this.#generation = options.candidate.timeline.activateNextGeneration();
  }

  public async prepare(
    frameIndex: number,
    ordinal: bigint,
    signal: AbortSignal
  ): Promise<Readonly<BrowserNormalReady>> {
    if (this.#disposed) throw new Error("initial prefix is disposed");
    if (this.#candidate.worker.activeGeneration !== this.#generation) {
      await this.#candidate.worker.activateGeneration(this.#generation);
    }
    const metrics = await this.#candidate.worker.snapshotMetrics();
    const batch = this.#candidate.samples.createBatch({
      frames: [{ unitId: this.#unit, unitFrame: frameIndex }],
      pendingSamples: metrics.pendingSamples,
      outstandingFrames: metrics.submittedFrames + metrics.leasedFrames
    });
    await this.#candidate.worker.submit(this.#generation, batch.samples);
    await this.#candidate.worker.waitForFrames(1, {
      signal,
      timeoutMs: BROWSER_RUNTIME_MEDIA_TIMEOUT_MS
    });
    const frame = this.#candidate.worker.takeFrame();
    if (frame === undefined) throw new Error("initial prefix frame is missing");
    const sample = batch.samples[0]!;
    assertBrowserFrame(frame, sample, this.#generation);
    const handle = await this.#candidate.renderer.uploadStreaming(
      this.#slot,
      this.#generation,
      frame
    );
    this.#slot = (this.#slot + 1) % 3;
    if (handle === null) throw new Error("initial prefix upload became stale");
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
  }
}
