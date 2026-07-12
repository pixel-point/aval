import type {
  GraphEdgeDefinition,
  GraphPresentation,
  MotionGraphResult
} from "@rendered-motion/graph";
import { findFinishBoundary, findNextPortalBoundary } from "@rendered-motion/graph";

import {
  CutPresentationCoordinator,
  CutPresentationSupersededError
} from "./cut-presentation-coordinator.js";
import type {
  IntegratedPlaybackTickContext,
  IntegratedPreparedContentTick
} from "./integrated-player-contracts.js";
import type { OpaqueCandidateReadinessSessionInput } from "./opaque-candidate-factory.js";
import type { PathScheduler } from "./path-scheduler.js";
import {
  ReversiblePresentationCoordinator,
  type PreparedReversiblePresentation
} from "./reversible-presentation.js";
import { RuntimePlaybackError } from "./errors.js";
import type { BrowserMediaOperationLane } from "./browser-media-operation-lane.js";
import {
  BROWSER_RUNTIME_MEDIA_TIMEOUT_MS,
  browserMediaTag,
  browserResidentMedia,
  requireBrowserState,
  type BrowserFrameMedia,
  type BrowserNormalReady
} from "./browser-playback-types.js";

export interface BrowserPreparedReversible {
  readonly token: Readonly<PreparedReversiblePresentation>;
  readonly media: Readonly<BrowserFrameMedia>;
}

interface BrowserStagedEndpoint {
  readonly edge: string;
  readonly unit: string;
  readonly state: string;
  readonly port: string;
}

/** Owns every resident cut and reversible presentation state machine. */
export class BrowserResidentRouteOwner {
  readonly #candidate: Readonly<OpaqueCandidateReadinessSessionInput>;
  readonly #lane: BrowserMediaOperationLane;
  readonly #scheduler: () => PathScheduler;
  readonly #protectedStreamingSlot: () => number | null;
  readonly #onFatal: (error: unknown) => void;
  readonly #runtimeSignal: AbortSignal;
  readonly #reversible: ReversiblePresentationCoordinator;
  #cut: CutPresentationCoordinator | null = null;
  #cutEntryMode: "cut" | "endpoint" | null = null;
  #priorVisibleCut: Readonly<{
    readonly cut: CutPresentationCoordinator;
    readonly entryMode: "cut" | "endpoint";
    readonly stagedEndpoint: Readonly<BrowserStagedEndpoint> | null;
  }> | null = null;
  #stagedEndpoint: Readonly<BrowserStagedEndpoint> | null = null;
  #disposed = false;

  public constructor(options: {
    readonly candidate: Readonly<OpaqueCandidateReadinessSessionInput>;
    readonly lane: BrowserMediaOperationLane;
    readonly scheduler: () => PathScheduler;
    readonly protectedStreamingSlot: () => number | null;
    readonly onFatal: (error: unknown) => void;
    readonly runtimeSignal: AbortSignal;
  }) {
    this.#candidate = options.candidate;
    this.#lane = options.lane;
    this.#scheduler = options.scheduler;
    this.#protectedStreamingSlot = options.protectedStreamingSlot;
    this.#onFatal = options.onFatal;
    this.#runtimeSignal = options.runtimeSignal;
    this.#reversible = new ReversiblePresentationCoordinator(
      options.candidate.interactionCache,
      options.candidate.renderer
    );
  }

  public get cutReady(): boolean {
    return this.#cut?.snapshot().status === "ready";
  }

  public get hasCut(): boolean {
    return this.#cut !== null;
  }

  public get cutRouteReady(): boolean {
    return this.#cutEntryMode === "cut" &&
      this.#cut?.snapshot().residentFramesPresented === 0;
  }

  public get hasUncommittedEndpoint(): boolean {
    return this.#stagedEndpoint !== null;
  }

  public get stagedEndpointEdge(): string | null {
    return this.#stagedEndpoint?.edge ?? null;
  }

  public get stagedEndpointState(): string | null {
    return this.#stagedEndpoint?.state ?? null;
  }

  public get hasUncommittedCut(): boolean {
    return this.#cutEntryMode === "cut" &&
      this.#cut?.snapshot().residentFramesPresented === 0;
  }

  public get activeCutEdge(): string | null {
    return this.#cut?.snapshot().edge ?? null;
  }

  public get firstResidentCommitted(): boolean {
    return this.#cut?.snapshot().residentFramesPresented === 1;
  }

  public get residentFramesPresented(): number {
    return this.#cut?.snapshot().residentFramesPresented ?? 0;
  }

  public get endpointEntryCommitted(): boolean {
    return this.#cutEntryMode === "endpoint" &&
      this.#stagedEndpoint === null &&
      this.firstResidentCommitted;
  }

  public get visibleEndpoint(): boolean {
    return this.#cutEntryMode === "endpoint" &&
      (this.#cut?.snapshot().residentFramesPresented ?? 0) > 0;
  }

  public prepareCut(
    context: Readonly<IntegratedPlaybackTickContext>
  ): Readonly<IntegratedPreparedContentTick> | null {
    return this.#cut?.prepareContentTick(context) ?? null;
  }

  public drawCut(
    prepared: Readonly<IntegratedPreparedContentTick>,
    presentation: Readonly<GraphPresentation>
  ): void {
    const cut = this.#cut;
    if (cut === null) throw new Error("browser cut owner is inactive");
    cut.drawContentTick(prepared, presentation);
  }

  public synchronizeCut(result: Readonly<MotionGraphResult>): void {
    const cut = this.#cut;
    if (cut === null) throw new Error("browser cut owner is inactive");
    const before = cut.snapshot().residentFramesPresented;
    cut.synchronizeGraph(result);
    const endpoint = this.#stagedEndpoint;
    if (
      endpoint !== null &&
      before === 0 &&
      cut.snapshot().residentFramesPresented === 1 &&
      result.presentation?.kind === "body" &&
      result.presentation.state === endpoint.state &&
      result.presentation.frameIndex === 0
    ) {
      this.#reversible.commitEndpoint(
        endpoint.unit,
        endpoint.state,
        endpoint.port
      );
      this.#stagedEndpoint = null;
    }
  }

  public takeStreamingHandoff() {
    return this.#cut?.takeStreamingHandoff() ?? null;
  }

  public takeResidentHandoff() {
    return this.#cut?.takeResidentHandoff() ?? null;
  }

  public prepareReversible(
    presentation: Extract<GraphPresentation, { readonly kind: "reversible" }>,
    generation: number,
    ordinal: bigint
  ): Readonly<BrowserPreparedReversible> {
    const token = this.#reversible.prepare(presentation);
    return Object.freeze({
      token,
      media: browserResidentMedia(
        token.presentation,
        token.frame,
        generation,
        ordinal
      )
    });
  }

  public drawReversible(
    prepared: Readonly<PreparedReversiblePresentation>,
    presentation: Extract<GraphPresentation, { readonly kind: "reversible" }>
  ): void {
    this.#reversible.draw(prepared, presentation);
  }

  public activateCut(
    edge: Readonly<GraphEdgeDefinition>,
    firstPresentationOrdinal: bigint
  ): void {
    const runway = this.#candidate.interactionCache.cutRunways.find(
      (candidate) => candidate.edge === edge.id
    );
    if (runway === undefined) throw new Error("browser cut runway is absent");
    this.#stageRunway(
      edge,
      "cut",
      runway.frames.map((frame, index) => ({
        frame,
        layer: runway.layers[index]!
      })),
      firstPresentationOrdinal
    );
  }

  public canEnterReversible(
    edge: Readonly<GraphEdgeDefinition>,
    presentation: Extract<GraphPresentation, { readonly kind: "body" }>
  ): boolean {
    const state = requireBrowserState(this.#candidate, edge.from);
    return edge.start.type === "portal"
      ? findNextPortalBoundary(
          state.body,
          edge.start.sourcePort,
          presentation.frameIndex
        ).eligibleNow
      : edge.start.type === "finish"
        ? findFinishBoundary(state.body, presentation.frameIndex).eligibleNow
        : true;
  }

  public reversibleEntryReady(
    edge: Readonly<GraphEdgeDefinition>,
    generation: number,
    ordinal: bigint
  ): Readonly<BrowserNormalReady> {
    const transition = edge.transition;
    if (transition?.kind !== "reversible") {
      throw new Error("browser edge is not reversible");
    }
    const frameIndex = transition.direction === "forward"
      ? 0
      : transition.frameCount - 1;
    const clip = this.#candidate.interactionCache.reversibleClips.find(
      (candidate) => candidate.unit === transition.unitId
    );
    if (clip === undefined) throw new Error("resident reversible clip is absent");
    const frame = clip.clip.frames[frameIndex];
    const layer = clip.clip.layers[frameIndex];
    if (frame === undefined || layer === undefined) {
      throw new Error("resident reversible clip is sparse");
    }
    return Object.freeze({
      media: Object.freeze({
        kind: "frame",
        graphKind: "reversible",
        state: null,
        edge: edge.id,
        path: `reversible:${edge.id}`,
        frame,
        drawSource: "resident",
        generation,
        unitInstance: 0,
        decodeOrdinal: frameIndex,
        timestamp: frameIndex,
        intendedPresentationOrdinal: ordinal
      }),
      handle: this.#candidate.renderer.residentHandle(layer),
      routeReady: true,
      purpose: "source",
      schedulerReservation: false,
      heldPresentation: false,
      scheduler: null
    });
  }

  public activateEndpointIfComplete(
    presentation: Extract<GraphPresentation, { readonly kind: "reversible" }>,
    edge: Readonly<GraphEdgeDefinition>,
    requestedState: string | null,
    followOnEdgeId: string | null,
    firstPresentationOrdinal: bigint
  ): boolean {
    const transition = edge.transition;
    if (transition?.kind !== "reversible") return false;
    const complete =
      (presentation.direction === "forward" &&
        presentation.frameIndex === transition.frameCount - 1) ||
      (presentation.direction === "reverse" &&
        presentation.frameIndex === 0);
    if (
      !complete ||
      (requestedState !== edge.to && followOnEdgeId === null)
    ) return false;
    // The graph switches edge identity when an active reversible traversal is
    // inverted, so edge.to/targetPort is the destination in both directions.
    const endpointState = edge.to;
    const endpointPort = edge.start.targetPort;
    const runway = this.#reversible.prepareEndpointRunway(
      transition.unitId,
      endpointState,
      endpointPort
    );
    this.#stageRunway(
      edge,
      "endpoint",
      runway,
      firstPresentationOrdinal,
      endpointState
    );
    this.#stagedEndpoint = Object.freeze({
      edge: edge.id,
      unit: transition.unitId,
      state: endpointState,
      port: endpointPort
    });
    return true;
  }

  public retireCutAndSupersede(): boolean {
    const retired = this.#cut !== null;
    if (
      this.#cut !== null &&
      this.#cut.snapshot().residentFramesPresented === 0 &&
      this.#priorVisibleCut !== null
    ) {
      this.#cut.dispose();
      this.#cut = this.#priorVisibleCut.cut;
      this.#cutEntryMode = this.#priorVisibleCut.entryMode;
      this.#stagedEndpoint = this.#priorVisibleCut.stagedEndpoint;
      this.#priorVisibleCut = null;
      return true;
    }
    this.#cut?.dispose();
    this.#priorVisibleCut?.cut.dispose();
    this.#priorVisibleCut = null;
    this.#cut = null;
    this.#cutEntryMode = null;
    this.#stagedEndpoint = null;
    if (retired) this.#lane.supersede();
    return retired;
  }

  public startStagedContinuation(): void {
    const cut = this.#cut;
    if (cut === null) throw new Error("browser cut owner is inactive");
    this.#priorVisibleCut?.cut.dispose();
    this.#priorVisibleCut = null;
    this.#lane.supersede();
    const operation = cut.startStagedContinuation();
    void operation.catch((error: unknown) => {
      if (error instanceof CutPresentationSupersededError) return;
      this.#onFatal(error);
    });
  }

  public snapshot() {
    return Object.freeze({
      cut: this.#cut?.snapshot() ?? null,
      reversible: this.#reversible.snapshot()
    });
  }

  public async settled(): Promise<void> {
    await Promise.all([
      this.#cut?.settled() ?? Promise.resolve(),
      this.#priorVisibleCut?.cut.settled() ?? Promise.resolve()
    ]);
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#cut?.dispose();
    this.#priorVisibleCut?.cut.dispose();
    this.#priorVisibleCut = null;
    this.#reversible.dispose();
    this.#stagedEndpoint = null;
  }

  #stageRunway(
    edge: Readonly<GraphEdgeDefinition>,
    entryMode: "cut" | "endpoint",
    planned: readonly Readonly<{
      readonly frame: BrowserFrameMedia["frame"];
      readonly layer: number;
    }>[],
    firstPresentationOrdinal: bigint,
    endpointState?: string
  ): void {
    if (this.#disposed) throw new Error("browser resident owner is disposed");
    // A staged resident runway becomes the sole generation authority. Abort
    // queued and in-flight normal reconciliation before installing its lock
    // so obsolete work observes cancellation instead of a terminal conflict.
    this.#lane.supersede();
    const current = this.#cut;
    const replacedVisible =
      (current?.snapshot().residentFramesPresented ?? 0) > 0;
    if (replacedVisible && current !== null && this.#cutEntryMode !== null) {
      this.#priorVisibleCut?.cut.dispose();
      this.#priorVisibleCut = Object.freeze({
        cut: current,
        entryMode: this.#cutEntryMode,
        stagedEndpoint: this.#stagedEndpoint
      });
    } else {
      current?.dispose();
    }
    this.#stagedEndpoint = null;
    const target = requireBrowserState(
      this.#candidate,
      endpointState ?? edge.to
    );
    const cut = new CutPresentationCoordinator({
      scheduler: this.#scheduler(),
      renderer: this.#candidate.renderer,
      firstStreamingSlot: nextCutStreamingSlot(
        this.#protectedStreamingSlot()
      ),
      handoffAfterFirstStreaming: true,
      enqueueMediaOperation: (operation) =>
        this.#lane.enqueue((signal) => operation(signal)),
      onStaticRecovery: (failure) =>
        this.#onFatal(new RuntimePlaybackError(failure)),
      readbackTag: (media) => browserMediaTag(media)
    });
    this.#cut = cut;
    this.#cutEntryMode = entryMode;
    cut.stageCut({
      edge,
      targetState: target.id,
      targetBody: target.body,
      runway: planned.map(({ frame, layer }, index) => Object.freeze({
        frame,
        layer,
        unitInstance: Math.floor(index / target.body.frameCount),
        decodeOrdinal: index,
        timestamp: index
      })),
      path: `${entryMode}:${edge.id}`,
      entryMode,
      firstPresentationOrdinal,
      completionStart: edge.trigger?.type === "completion",
      signal: this.#runtimeSignal,
      timeoutMs: BROWSER_RUNTIME_MEDIA_TIMEOUT_MS
    });
  }
}

function nextCutStreamingSlot(protectedSlot: number | null): number {
  return protectedSlot === null ? 0 : (protectedSlot + 1) % 3;
}
