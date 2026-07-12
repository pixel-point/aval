import type {
  GraphEdgeDefinition,
  GraphPresentation,
  MotionGraphResult,
  MotionGraphSnapshot
} from "@rendered-motion/graph";

import type {
  IntegratedPlaybackSession,
  IntegratedPlaybackTickContext,
  IntegratedPlaybackTraceState,
  IntegratedPreparedContentTick
} from "./integrated-player-contracts.js";
import {
  assertIntegratedPresentationIdentity,
  sameGraphPresentation
} from "./integrated-player-support.js";
import type {
  OpaqueCandidateActivationInput,
  OpaqueCandidateReadinessSessionInput
} from "./opaque-candidate-factory.js";
import type { PreparedReversiblePresentation } from "./reversible-presentation.js";
import type { CutResidentHandoff } from "./cut-presentation-coordinator.js";
import type { BrowserOpaquePlaybackSnapshot } from "./browser-opaque-candidate-contracts.js";
import {
  BrowserOpaqueCandidateHub,
  type BrowserTrackedPlayback
} from "./browser-opaque-candidate-hub.js";
import {
  RuntimePlaybackError,
  normalizeRuntimeFailure
} from "./errors.js";
import {
  BrowserMediaOperationLane,
  isBrowserMediaSuperseded
} from "./browser-media-operation-lane.js";
import { BrowserNormalRouteOwner } from "./browser-normal-route-owner.js";
import { BrowserResidentRouteOwner } from "./browser-resident-route-owner.js";
import {
  browserCompletionEdge,
  browserMediaTag,
  requireBrowserEdge,
  requireBrowserState,
  type BrowserFrameMedia,
  type BrowserNormalReady
} from "./browser-playback-types.js";
import { RUNTIME_TRACE_CAPACITY } from "./model.js";

type BrowserPreparedTick = IntegratedPreparedContentTick & {
  readonly browserToken: true;
  readonly owner: BrowserOpaquePlaybackSession;
  readonly predicted: Readonly<MotionGraphResult>;
  readonly delegate:
    | { readonly kind: "normal"; readonly value: Readonly<BrowserNormalReady> }
    | {
        readonly kind: "cut";
        readonly value: Readonly<IntegratedPreparedContentTick>;
      }
    | {
        readonly kind: "reversible";
        readonly value: Readonly<PreparedReversiblePresentation>;
      };
};

/** Browser composition orchestrator; route owners contain all media mutation. */
export class BrowserOpaquePlaybackSession
  implements IntegratedPlaybackSession, BrowserTrackedPlayback {
  readonly #candidate: Readonly<OpaqueCandidateReadinessSessionInput>;
  readonly #activation: Readonly<OpaqueCandidateActivationInput>;
  readonly #hub: BrowserOpaqueCandidateHub;
  readonly #runtime = new AbortController();
  readonly #lane: BrowserMediaOperationLane;
  readonly #normal: BrowserNormalRouteOwner;
  readonly #resident: BrowserResidentRouteOwner;
  readonly #presentationTags: string[] = [];

  #graphSnapshot: Readonly<MotionGraphSnapshot>;
  #initial: Readonly<BrowserNormalReady> | null = null;
  #ready: Readonly<BrowserNormalReady> | null = null;
  #prepared: Readonly<BrowserPreparedTick> | null = null;
  #background: Promise<void> | null = null;
  #pendingBackgroundRebuild = false;
  #mediaEpoch = 0;
  #pendingEdge: Readonly<GraphEdgeDefinition> | null = null;
  #followOnEdge: Readonly<GraphEdgeDefinition> | null = null;
  #deferredIntroCut: Readonly<GraphEdgeDefinition> | null = null;
  #pendingResidentCheckpoint: Readonly<CutResidentHandoff> | null = null;
  #fatal: RuntimePlaybackError | null = null;
  #disposed = false;

  private constructor(options: {
    readonly candidate: Readonly<OpaqueCandidateReadinessSessionInput>;
    readonly activation: Readonly<OpaqueCandidateActivationInput>;
    readonly hub: BrowserOpaqueCandidateHub;
  }) {
    this.#candidate = options.candidate;
    this.#activation = options.activation;
    this.#hub = options.hub;
    this.#graphSnapshot = options.activation.graphSnapshot;
    this.#lane = new BrowserMediaOperationLane({
      signal: this.#runtime.signal,
      track: (operation) => options.hub.track(operation)
    });
    this.#normal = new BrowserNormalRouteOwner({
      candidate: options.candidate,
      activation: options.activation
    });
    this.#resident = new BrowserResidentRouteOwner({
      candidate: options.candidate,
      lane: this.#lane,
      scheduler: () => this.#normal.scheduler,
      protectedStreamingSlot: () => this.#normal.retainedStreamingSlot,
      onFatal: (error) => this.#latchFatal(error),
      runtimeSignal: this.#runtime.signal
    });
    const initialEdge = options.activation.graphSnapshot.pendingEdgeId ??
      options.activation.graphSnapshot.activeEdgeId;
    this.#pendingEdge = initialEdge === null
      ? null
      : requireBrowserEdge(options.candidate, initialEdge);
    this.#followOnEdge = options.activation.graphSnapshot.followOnEdgeId === null
      ? null
      : requireBrowserEdge(
          options.candidate,
          options.activation.graphSnapshot.followOnEdgeId
        );
  }

  public static async create(options: {
    readonly candidate: Readonly<OpaqueCandidateReadinessSessionInput>;
    readonly activation: Readonly<OpaqueCandidateActivationInput>;
    readonly hub: BrowserOpaqueCandidateHub;
  }): Promise<BrowserOpaquePlaybackSession> {
    const session = new BrowserOpaquePlaybackSession(options);
    session.#initial = await session.#normal.prepareInitial(
      options.activation.expectedPresentation,
      session.#runtime.signal
    );
    return session;
  }

  public drawInitial(): void {
    this.#assertUsable();
    const initial = this.#initial;
    if (initial === null) throw new Error("initial browser media is unavailable");
    this.#candidate.renderer.draw(initial.handle);
    this.#normal.commitPrepared(initial);
    this.#recordPresentation(initial.media);
    this.#initial = null;
  }

  public prepareContentTick(
    context: Readonly<IntegratedPlaybackTickContext>
  ): Readonly<IntegratedPreparedContentTick> | null {
    this.#assertUsable();
    assertBrowserGraphSnapshot(
      context.graphSnapshot,
      this.#graphSnapshot,
      "browser playback tick context"
    );
    if (this.#prepared !== null) return this.#prepared;

    if (this.#resident.cutReady) {
      const delegated = this.#resident.prepareCut(context);
      if (delegated === null) return null;
      const routeReady = this.#resident.cutRouteReady;
      const prepared = Object.freeze({ ...delegated, routeReady });
      return this.#storeToken(
        context.previewTick({
          contentOrdinal: context.presentationOrdinal - 1n,
          routeReady
        }),
        prepared,
        { kind: "cut", value: delegated }
      );
    }

    const graph = this.#graphSnapshot;
    if (graph.phase === "reversible") {
      const predicted = context.previewTick({
        contentOrdinal: context.presentationOrdinal - 1n,
        routeReady: true
      });
      return this.#prepareReversibleToken(predicted, context.presentationOrdinal);
    }

    const ready = this.#ready;
    if (ready === null) return null;
    this.#ready = null;
    const pendingReversible = this.#pendingEdge;
    const residentRouteReady =
      pendingReversible?.transition?.kind === "reversible" &&
      graph.presentation?.kind === "body" &&
      this.#resident.canEnterReversible(
        pendingReversible,
        graph.presentation
      );
    const previewRouteReady = ready.routeReady || residentRouteReady;
    const predicted = context.previewTick({
      contentOrdinal: context.presentationOrdinal - 1n,
      routeReady: previewRouteReady
    });
    if (predicted.presentation?.kind === "reversible") {
      // Entry frame zero must pass through the reversible owner so adjacency
      // and inverse-direction state are initialized before frame one.
      // The normal source pixels were already uploaded, but their scheduler
      // reservation is obsolete once this tick selects the resident clip.
      // Releasing it here is required before endpoint-runway generation
      // replacement can claim the scheduler after the clip completes.
      this.#normal.discardPrepared(ready);
      return this.#prepareReversibleToken(
        predicted,
        context.presentationOrdinal,
        previewRouteReady
      );
    }
    if (predicted.presentation === null) return null;
    assertIntegratedPresentationIdentity(
      predicted.presentation,
      ready.media,
      context.presentationOrdinal
    );
    return this.#storeToken(
      predicted,
      Object.freeze({
        ...this.traceState(),
        routeReady: ready.routeReady,
        media: ready.media
      }),
      { kind: "normal", value: ready }
    );
  }

  public drawContentTick(
    prepared: Readonly<IntegratedPreparedContentTick>,
    presentation: Readonly<GraphPresentation>
  ): string | null {
    const token = this.#requireToken(prepared);
    if (!sameGraphPresentation(token.predicted.presentation, presentation)) {
      throw new Error("browser playback prediction diverged at draw");
    }
    switch (token.delegate.kind) {
      case "normal":
        this.#candidate.renderer.draw(token.delegate.value.handle);
        break;
      case "cut":
        this.#resident.drawCut(token.delegate.value, presentation);
        break;
      case "reversible":
        if (presentation.kind !== "reversible") {
          throw new Error("reversible draw received another graph kind");
        }
        this.#resident.drawReversible(token.delegate.value, presentation);
        break;
    }
    this.#recordPresentation(prepared.media as BrowserFrameMedia);
    return this.#presentationTags.at(-1) ?? null;
  }

  public synchronizeGraph(result: Readonly<MotionGraphResult>): void {
    this.#assertUsable();
    if (result.operation === "tick") {
      const prepared = this.#prepared;
      if (prepared === null) {
        throw new Error("browser playback tick has no prepared presentation");
      }
      assertExactBrowserGraphResult(
        prepared.predicted,
        result,
        "browser playback tick"
      );
      this.#graphSnapshot = result.snapshot;
      if (prepared.delegate.kind === "cut") {
        const firstResidentCommit =
          prepared.media.kind === "frame" &&
          prepared.media.drawSource === "resident" &&
          this.#resident.residentFramesPresented === 0;
        if (firstResidentCommit) {
          // Release a normal scheduler reservation before the resident draw
          // barrier atomically installs its staged generation transaction.
          if (this.#ready !== null) this.#normal.discardPrepared(this.#ready);
          this.#ready = null;
        }
        this.#resident.synchronizeCut(result);
        this.#synchronizePendingEdge(result);
        if (firstResidentCommit) {
          this.#mediaEpoch = checkedBrowserIncrement(this.#mediaEpoch);
          const followOn = this.#followOnEdge ?? this.#pendingEdge;
          const completionStaged = prepared.media.kind === "frame" &&
            this.#stageVisibleCompletionCut(prepared.media, result);
          if (completionStaged) {
            // The next graph tick is an authored completion cut; starting the
            // just-finished runway's continuation would mutate obsolete state.
          } else if (
            this.#resident.endpointEntryCommitted &&
            followOn !== null
          ) {
            const checkpoint = this.#resident.takeResidentHandoff();
            this.#resident.retireCutAndSupersede();
            if (followOn.start.type === "cut") {
              this.#resident.activateCut(
                followOn,
                (result.snapshot.contentOrdinal ?? -1n) + 2n
              );
            } else {
              if (checkpoint === null) {
                throw new Error("endpoint body checkpoint was not committed");
              }
              this.#pendingResidentCheckpoint = checkpoint;
            }
          } else {
            this.#resident.startStagedContinuation();
          }
        }
        if (prepared.media.kind === "frame" &&
          prepared.media.drawSource === "streaming") {
          if (prepared.media.state === null) {
            throw new Error("cut continuation has no target state");
          }
          const handoff = this.#resident.takeStreamingHandoff();
          if (handoff === null) {
            throw new Error("cut streaming handoff was not committed");
          }
          this.#normal.adoptStreamingHandoff(
            handoff.media,
            handoff.handle
          );
          this.#normal.promoteTargetToSource(prepared.media.state);
          // The first decoded continuation is the ownership handoff back to
          // normal streaming. Leaving the cut owner active would shadow the
          // graph forever and prefetch another independent continuation.
          this.#resident.retireCutAndSupersede();
        }
        if (prepared.media.kind === "frame" && !firstResidentCommit) {
          this.#stageVisibleCompletionCut(prepared.media, result);
        }
      } else if (prepared.delegate.kind === "normal") {
        this.#normal.commitPrepared(prepared.delegate.value);
      }
      if (prepared.delegate.kind !== "cut") {
        this.#synchronizePendingEdge(result);
      }
      this.#prepared = null;
      if (
        this.#deferredIntroCut !== null &&
        result.snapshot.phase !== "intro" &&
        result.presentation?.kind === "body" &&
        result.presentation.state === this.#deferredIntroCut.from
      ) {
        const cut = this.#deferredIntroCut;
        this.#deferredIntroCut = null;
        this.#resident.activateCut(
          cut,
          (result.snapshot.contentOrdinal ?? -1n) + 2n
        );
      }
      this.#activatePendingCut(result);
      this.#scheduleBackground();
      return;
    }

    this.#graphSnapshot = result.snapshot;
    if (
      (result.operation === "request" || result.operation === "send") &&
      result.accepted === true &&
      this.#isMaterialRouteIntent(result)
    ) {
      if (result.snapshot.phase === "locked") {
        // Follow-on intent is graph-owned while the committed bridge remains
        // the only valid media path. Never discard its prepared next frame.
        this.#synchronizePendingEdge(result);
      } else {
        this.#observeRouteIntent(result);
      }
    }
    if (result.operation === "begin-animated") {
      this.#synchronizePendingEdge(result);
      this.#activatePendingCut(result);
      this.#scheduleBackground();
    }
    if (result.operation === "dispose") void this.dispose();
  }

  public traceState(): Readonly<IntegratedPlaybackTraceState> {
    const scheduler = this.#normal.snapshot();
    return Object.freeze({
      scheduler,
      submitted: scheduler.submittedCursor === null
        ? Object.freeze([])
        : Object.freeze([scheduler.submittedCursor]),
      selectedBoundary: this.#pendingEdge?.id ?? null,
      decodeLeadFrames: this.#activation.finalResourcePlan.ringCapacity - 1
    });
  }

  public async settled(): Promise<void> {
    this.#scheduleBackground();
    for (;;) {
      const background = this.#background;
      await this.#resident.settled();
      await this.#lane.settled();
      if (background === this.#background && this.#lane.pending === 0) return;
    }
  }

  public snapshot(): Readonly<BrowserOpaquePlaybackSnapshot> {
    const resident = this.#resident.snapshot();
    return Object.freeze({
      scheduler: this.#normal.snapshot(),
      cut: resident.cut,
      reversible: resident.reversible,
      pendingCallbacks: 0,
      pendingPromises: this.#lane.pending,
      readbackTags: Object.freeze([...this.#presentationTags])
    });
  }

  public async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#hub.deactivate(this);
    this.#resident.dispose();
    this.#runtime.abort(new DOMException(
      "browser playback disposed",
      "AbortError"
    ));
    await Promise.allSettled([
      this.#resident.settled(),
      this.#lane.dispose()
    ]);
    await this.#normal.dispose();
  }

  #prepareReversibleToken(
    predicted: Readonly<MotionGraphResult>,
    ordinal: bigint,
    routeReady = true
  ): Readonly<BrowserPreparedTick> {
    if (predicted.presentation?.kind !== "reversible") {
      throw new Error("reversible endpoint recovery was not prepared");
    }
    const resident = this.#resident.prepareReversible(
      predicted.presentation,
      this.#normal.generation,
      ordinal
    );
    return this.#storeToken(
      predicted,
      Object.freeze({
        ...this.traceState(),
        routeReady,
        media: resident.media
      }),
      { kind: "reversible", value: resident.token }
    );
  }

  #observeRouteIntent(result: Readonly<MotionGraphResult>): void {
    this.#synchronizePendingEdge(result);
    if (this.#graphSnapshot.phase === "intro") {
      this.#deferredIntroCut = this.#pendingEdge?.start.type === "cut"
        ? this.#pendingEdge
        : null;
      return;
    }
    this.#deferredIntroCut = null;
    if (this.#pendingEdge?.start.type === "cut") {
      this.#resident.activateCut(
        this.#pendingEdge,
        (result.snapshot.contentOrdinal ?? -1n) + 2n
      );
      return;
    }
    if (this.#resident.hasCut) {
      const snapshot = this.#graphSnapshot;
      if (
        this.#resident.hasUncommittedEndpoint &&
        snapshot.requestedState !== this.#resident.stagedEndpointState &&
        snapshot.followOnEdgeId === null
      ) {
        // Endpoint body zero has not crossed the draw barrier, so the
        // reversible clip is still authoritative. Cancel only the staged
        // runway and let the inverse prediction consume the adjacent frame.
        this.#resident.retireCutAndSupersede();
        this.#scheduleBackground();
        return;
      }
      if (
        this.#resident.visibleEndpoint &&
        this.#pendingEdge?.transition?.kind === "reversible"
      ) {
        const checkpoint = this.#resident.takeResidentHandoff();
        if (checkpoint === null) {
          throw new Error("visible endpoint checkpoint is unavailable");
        }
        this.#resident.retireCutAndSupersede();
        this.#pendingResidentCheckpoint = checkpoint;
        this.#scheduleBackground();
        return;
      }
      if (
        this.#resident.hasUncommittedCut &&
        snapshot.pendingEdgeId !== this.#resident.activeCutEdge
      ) {
        this.#resident.retireCutAndSupersede();
        this.#scheduleBackground();
        return;
      }
      // A route requested during an already-visible runway belongs after that
      // runway. Keep the resident owner alive through its first decoded
      // continuation; routeReady remains false after the cut's entry frame,
      // so the graph cannot commit this follow-on before normal streaming has
      // adopted the exact handoff pixels.
      this.#scheduleBackground();
      return;
    }
    let rebuild = false;
    const readyIsStableSource = this.#ready !== null &&
      this.#ready.purpose === "source" &&
      this.#ready.media.graphKind === "body" &&
      this.#ready.media.edge === null;
    if (
      this.#ready !== null &&
      !readyIsStableSource &&
      this.#ready.media.edge !== this.#pendingEdge?.id
    ) {
      this.#normal.discardPrepared(this.#ready);
      this.#ready = null;
      this.#mediaEpoch = checkedBrowserIncrement(this.#mediaEpoch);
      rebuild = true;
    }
    // A normal route consumes the exact source frame already prepared before
    // the request. Route planning starts after that frame is drawn.
    this.#scheduleBackground(rebuild);
  }

  #scheduleBackground(rebuild = false): void {
    if (this.#disposed) return;
    this.#pendingBackgroundRebuild ||= rebuild;
    if (this.#background !== null) return;
    const operationRebuild = this.#pendingBackgroundRebuild;
    this.#pendingBackgroundRebuild = false;
    const operationEpoch = this.#mediaEpoch;
    const operation = this.#lane.enqueue(async (signal) => {
      if (this.#disposed || this.#prepared !== null) return;
      const checkpoint = this.#pendingResidentCheckpoint;
      if (checkpoint !== null) {
        await this.#normal.adoptResidentBodyCheckpoint(
          checkpoint.media,
          checkpoint.handle,
          signal
        );
        if (this.#pendingResidentCheckpoint === checkpoint) {
          this.#pendingResidentCheckpoint = null;
        }
      }
      if (this.#ready !== null) return;
      await this.#advanceBackground(
        operationRebuild,
        operationEpoch,
        signal
      );
    });
    this.#background = operation;
    void operation.finally(() => {
      if (this.#background === operation) this.#background = null;
      if (
        (this.#pendingBackgroundRebuild ||
          this.#pendingResidentCheckpoint !== null) &&
        !this.#disposed
      ) {
        this.#scheduleBackground();
      }
    }).catch((error: unknown) => {
      if (!isBrowserMediaSuperseded(error)) this.#latchFatal(error);
    });
  }

  async #advanceBackground(
    rebuild: boolean,
    epoch: number,
    signal: AbortSignal
  ): Promise<void> {
    const snapshot = this.#graphSnapshot;
    const presentation = snapshot.presentation;
    if (presentation === null) return;
    if (presentation.kind === "intro") {
      const ready = await this.#normal.prepareAfterIntro(presentation, signal);
      this.#publishReady(ready, epoch, signal);
      return;
    }
    if (this.#resident.cutReady) return;
    if (presentation.kind === "reversible") {
      const edge = requireBrowserEdge(this.#candidate, presentation.edgeId);
      this.#resident.activateEndpointIfComplete(
        presentation,
        edge,
        snapshot.requestedState,
        snapshot.followOnEdgeId,
        (snapshot.contentOrdinal ?? -1n) + 2n
      );
      return;
    }
    if (presentation.kind === "locked") {
      const ready = await this.#normal.prepareStreamingContinuation(signal);
      this.#publishReady(ready, epoch, signal);
      return;
    }
    if (presentation.kind !== "body") return;
    let edge = this.#pendingEdge ?? browserCompletionEdge(
      this.#candidate,
      presentation.state
    );
    if (edge?.start.type === "cut") {
      const state = requireBrowserState(this.#candidate, presentation.state);
      const completionReady = edge.trigger?.type !== "completion" ||
        presentation.frameIndex === state.body.frameCount - 1;
      if (completionReady && !this.#resident.hasCut) {
        this.#resident.activateCut(
          edge,
          (snapshot.contentOrdinal ?? -1n) + 2n
        );
        return;
      }
      // A dormant completion cut must not suppress ordinary adjacent source
      // preparation before the finite terminal frame is actually visible.
      edge = null;
    }
    if (
      edge?.transition?.kind === "reversible" &&
      this.#resident.canEnterReversible(edge, presentation)
    ) {
      if (this.#normal.snapshot().pendingEdge !== null) {
        await this.#normal.cancelPreparedRoute(
          `reversible:${edge.id}`,
          signal
        );
      }
      const ready = this.#resident.reversibleEntryReady(
        edge,
        this.#normal.generation,
        (snapshot.contentOrdinal ?? -1n) + 2n
      );
      this.#publishReady(ready, epoch, signal);
      return;
    }
    const preparedReady = await this.#normal.prepareBodyNext({
      presentation,
      contentOrdinal: snapshot.contentOrdinal,
      edge,
      rebuild,
      signal
    });
    const ready = await this.#normal.reconcilePreparedSourceRoute(
      preparedReady,
      this.#pendingEdge,
      signal
    );
    this.#publishReady(ready, epoch, signal);
  }

  #publishReady(
    ready: Readonly<BrowserNormalReady>,
    epoch: number,
    signal: AbortSignal
  ): void {
    if (signal.aborted || epoch !== this.#mediaEpoch || this.#disposed) {
      this.#normal.discardPrepared(ready);
      return;
    }
    const presentation = this.#graphSnapshot.presentation;
    const desiredEdge = this.#pendingEdge ?? (
      this.#graphSnapshot.phase === "stable" &&
      presentation?.kind === "body"
        ? browserCompletionEdge(this.#candidate, presentation.state)
        : null
    );
    if (
      ready.routeReady &&
      ready.media.edge !== desiredEdge?.id
    ) {
      this.#normal.discardPrepared(ready);
      this.#scheduleBackground(true);
      return;
    }
    this.#ready = ready;
  }

  #storeToken(
    predicted: Readonly<MotionGraphResult>,
    prepared: Readonly<IntegratedPreparedContentTick>,
    delegate: BrowserPreparedTick["delegate"]
  ): Readonly<BrowserPreparedTick> {
    const token = Object.freeze({
      ...prepared,
      browserToken: true as const,
      owner: this,
      predicted,
      delegate
    });
    this.#prepared = token;
    return token;
  }

  #requireToken(
    value: Readonly<IntegratedPreparedContentTick>
  ): Readonly<BrowserPreparedTick> {
    if (
      value !== this.#prepared ||
      !("browserToken" in value) ||
      (value as Partial<BrowserPreparedTick>).owner !== this
    ) throw new Error("browser playback token is stale or foreign");
    return value as Readonly<BrowserPreparedTick>;
  }

  #synchronizePendingEdge(result: Readonly<MotionGraphResult>): void {
    const id = result.snapshot.pendingEdgeId ?? result.snapshot.activeEdgeId;
    this.#pendingEdge = id === null
      ? null
      : requireBrowserEdge(this.#candidate, id);
    this.#followOnEdge = result.snapshot.followOnEdgeId === null
      ? null
      : requireBrowserEdge(
          this.#candidate,
          result.snapshot.followOnEdgeId
        );
  }

  #isMaterialRouteIntent(result: Readonly<MotionGraphResult>): boolean {
    const next = result.snapshot.pendingEdgeId ?? result.snapshot.activeEdgeId;
    return result.effects.some((effect) =>
      effect.type === "requestedstatechange" ||
      effect.type === "transitionstart"
    ) || next !== (this.#pendingEdge?.id ?? null);
  }

  #recordPresentation(media: Readonly<BrowserFrameMedia>): void {
    this.#presentationTags.push(browserMediaTag(media));
    if (this.#presentationTags.length > RUNTIME_TRACE_CAPACITY) {
      this.#presentationTags.splice(
        0,
        this.#presentationTags.length - RUNTIME_TRACE_CAPACITY
      );
    }
  }

  #activatePendingCut(result: Readonly<MotionGraphResult>): void {
    const edge = this.#pendingEdge;
    if (
      edge?.start.type !== "cut" ||
      this.#resident.hasCut ||
      result.presentation?.kind !== "body" ||
      result.presentation.state !== edge.from
    ) return;
    this.#resident.activateCut(
      edge,
      (result.snapshot.contentOrdinal ?? -1n) + 2n
    );
  }

  #stageVisibleCompletionCut(
    media: Readonly<BrowserFrameMedia>,
    result: Readonly<MotionGraphResult>
  ): boolean {
    if (
      media.kind !== "frame" ||
      media.graphKind !== "body" ||
      media.state === null ||
      result.snapshot.phase !== "stable" ||
      result.snapshot.pendingEdgeId !== null ||
      result.snapshot.followOnEdgeId !== null ||
      result.snapshot.visualState !== media.state
    ) return false;
    const state = requireBrowserState(this.#candidate, media.state);
    if (media.frame.localFrame !== state.body.frameCount - 1) return false;
    const completion = browserCompletionEdge(this.#candidate, state.id);
    if (completion?.start.type !== "cut") return false;
    this.#resident.activateCut(
      completion,
      (result.snapshot.contentOrdinal ?? -1n) + 2n
    );
    return true;
  }

  #latchFatal(error: unknown): void {
    if (this.#disposed || this.#fatal !== null) return;
    this.#fatal = error instanceof RuntimePlaybackError
      ? error
      : new RuntimePlaybackError(normalizeRuntimeFailure(
          "worker-decode-failure",
          error,
          { operation: "browser-playback" }
        ));
    this.#hub.diagnose(this.#fatal.failure);
  }

  #assertUsable(): void {
    if (this.#disposed) throw new Error("browser playback session is disposed");
    if (this.#fatal !== null) throw this.#fatal;
  }
}

function checkedBrowserIncrement(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 ||
    value >= Number.MAX_SAFE_INTEGER) {
    throw new RangeError("browser media epoch exceeded the safe range");
  }
  return value + 1;
}

function assertExactBrowserGraphResult(
  preview: Readonly<MotionGraphResult>,
  actual: Readonly<MotionGraphResult>,
  label: string
): void {
  if (!sameBrowserGraphValue(preview, actual)) {
    throw new Error(`${label} diverged`);
  }
}

function assertBrowserGraphSnapshot(
  context: Readonly<MotionGraphSnapshot>,
  synchronized: Readonly<MotionGraphSnapshot>,
  label: string
): void {
  if (!sameBrowserGraphValue(context, synchronized)) {
    throw new Error(`${label} diverged`);
  }
}

function sameBrowserGraphValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== typeof right || left === null || right === null) {
    return false;
  }
  if (typeof left !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (
      !Array.isArray(left) ||
      !Array.isArray(right) ||
      left.length !== right.length
    ) return false;
    return left.every((value, index) =>
      sameBrowserGraphValue(value, right[index])
    );
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) =>
    Object.prototype.hasOwnProperty.call(rightRecord, key) &&
    sameBrowserGraphValue(leftRecord[key], rightRecord[key])
  );
}
