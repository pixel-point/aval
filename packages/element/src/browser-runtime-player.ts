import {
  normalizeRuntimeFailure,
  type BrowserVideoCandidateComposition,
  type BrowserPresentationPlanes,
  type IntegratedPlayer,
  type MotionPolicy,
  type PlayerWebPageRuntime,
  type PresentationFit,
  type RuntimeAssetSession,
  type RuntimeFailure,
  type RuntimeParticipantId,
  type RuntimeReadinessResult,
  type RuntimeVisibilityState,
  type StateFallbackStore
} from "@pixel-point/aval-player-web";

import type {
  BrowserRuntimeMetadata,
  BrowserRuntimePlayer,
  BrowserRuntimePlayerSnapshot
} from "./browser-runtime-contracts.js";
import {
  captureCleanupReceipt,
  settleCleanupOperation
} from "./cleanup-receipt.js";
import type { AvalCleanupReceipt } from "./public-types.js";
import { snapshotRuntimeTrace } from "./runtime-trace-snapshot.js";

/** Active browser player adapter and sole terminal owner after acquisition. */
export class BrowserRuntimePlayerOwner implements BrowserRuntimePlayer {
  public readonly metadata: Readonly<BrowserRuntimeMetadata>;
  readonly #pageRuntime: PlayerWebPageRuntime;
  readonly #participant: ReturnType<PlayerWebPageRuntime["createParticipant"]>;
  readonly #session: RuntimeAssetSession;
  readonly #planes: BrowserPresentationPlanes;
  readonly #composition: Readonly<BrowserVideoCandidateComposition>;
  readonly #player: IntegratedPlayer;
  readonly #releaseOwnedPlayer: () => void;
  readonly #fallbackStore: StateFallbackStore;
  readonly #elementGeneration: number;
  readonly #sourceGeneration: number;
  readonly #participantId: RuntimeParticipantId;
  readonly #cleanupSink: (receipt: Readonly<AvalCleanupReceipt>) => void;
  readonly #diagnosticsSink: (failure: Readonly<RuntimeFailure>) => void;
  readonly #activate: () => void;
  #activated = false;
  #disposal: Promise<void> | null = null;
  #disposing = false;
  #activeResize: Promise<void> | null = null;
  #pendingResize: Readonly<{
    cssWidth: number;
    cssHeight: number;
    devicePixelRatio: number;
    fit?: PresentationFit;
  }> | null = null;
  #resizeIdlePromise: Promise<void> | null = null;
  #resolveResizeIdlePromise: (() => void) | null = null;

  public constructor(input: Readonly<{
    pageRuntime: PlayerWebPageRuntime;
    participant: ReturnType<PlayerWebPageRuntime["createParticipant"]>;
    session: RuntimeAssetSession;
    planes: BrowserPresentationPlanes;
    composition: Readonly<BrowserVideoCandidateComposition>;
    player: IntegratedPlayer;
    metadata: Readonly<BrowserRuntimeMetadata>;
    releaseOwnedPlayer: () => void;
    fallbackStore: StateFallbackStore;
    elementGeneration: number;
    sourceGeneration: number;
    cleanupSink: (receipt: Readonly<AvalCleanupReceipt>) => void;
    diagnosticsSink: (failure: Readonly<RuntimeFailure>) => void;
    activate: () => void;
  }>) {
    this.#pageRuntime = input.pageRuntime;
    this.#participant = input.participant;
    this.#session = input.session;
    this.#planes = input.planes;
    this.#composition = input.composition;
    this.#player = input.player;
    this.metadata = input.metadata;
    this.#releaseOwnedPlayer = input.releaseOwnedPlayer;
    this.#fallbackStore = input.fallbackStore;
    this.#elementGeneration = input.elementGeneration;
    this.#sourceGeneration = input.sourceGeneration;
    this.#participantId = input.participant.snapshot().account.participantId;
    this.#cleanupSink = input.cleanupSink;
    this.#diagnosticsSink = input.diagnosticsSink;
    this.#activate = input.activate;
  }

  public activate(): void {
    if (this.#activated) return;
    this.#activated = true;
    this.#activate();
  }

  public prepare(options: Readonly<{ signal?: AbortSignal; timeoutMs?: number }> = {}): Promise<RuntimeReadinessResult> {
    return this.#player.prepare(options);
  }

  public requestState(state: string): Promise<void> {
    return this.#player.requestState(state);
  }

  public canSend(event: string): boolean { return this.#player.canSend(event); }
  public send(event: string): boolean { return this.#player.send(event); }
  public readyFor(state: string): boolean { return this.#player.readyFor(state); }
  public planFor(state: string): readonly string[] | null {
    return this.#player.planFor(state);
  }
  public pause(): void { this.#player.pauseRealtime(); }
  public resume(): Promise<void> { return this.#player.resumeRealtime(); }
  public setMotionPolicy(policy: MotionPolicy): Promise<unknown> {
    return this.#player.setMotionPolicy(policy);
  }
  public setHostReducedMotion(value: boolean): Promise<unknown> {
    return this.#player.setHostReducedMotion(value);
  }
  public setVisibility(value: RuntimeVisibilityState): Promise<unknown> {
    return this.#player.setVisibility(value);
  }

  public resize(input: Readonly<{
    cssWidth: number;
    cssHeight: number;
    devicePixelRatio: number;
    fit?: PresentationFit;
  }>): void {
    if (this.#disposing) return;
    this.#pendingResize = Object.freeze({ ...input });
    this.#drainResize();
  }

  public snapshot(): Readonly<BrowserRuntimePlayerSnapshot> {
    const session = this.#session.snapshot();
    const participant = this.#participant.snapshot();
    const page = this.#pageRuntime.snapshot();
    const participantSnapshot = participant.account.participant;
    const playerParticipant = this.#player.participantSnapshot();
    const player = this.#player.snapshot();
    const motion = this.#player.motionSnapshot();
    const context = this.#player.contextSnapshot();
    return Object.freeze({
      player,
      visibility: this.#player.visibilitySnapshot(),
      presentation: this.#planes.snapshot(),
      selectedRendition: player.selectedRendition,
      selectedCodec: this.metadata.renditions.find(
        ({ id }) => id === player.selectedRendition
      )?.codec ?? null,
      selectedBitDepth: this.metadata.renditions.find(
        ({ id }) => id === player.selectedRendition
      )?.bitDepth ?? null,
      transportMode: session.mode,
      declaredFileBytes: session.declaredFileBytes,
      metadataBytes: session.metadataBytes,
      verifiedBytes: session.verifiedPayloadBytes,
      residentBlobBytes: session.unitBlobs.verifiedBytes,
      activeTransportBodies: session.activeTransportBodies,
      pendingLoads: session.pendingLoads,
      interestedWaiters: session.interestedWaiters,
      pageTrackedBytes: participantSnapshot?.logicalBytes ?? 0,
      pagePhysicalBytes: page.resources.physicalBytes,
      activeLeaseCount: participant.account.activeLeaseCount,
      decoderLeaseState: playerParticipant?.decoderPending === true
        ? "queued"
        : playerParticipant?.attached === true && player.readiness === "interactiveReady"
          ? "granted"
          : null,
      reclamationCount: page.reclamation.tokenSequence,
      effectiveMotion: motion.desiredMode,
      actualMotion: motion.actualMode,
      contextLossCount: context?.lossCount ?? 0,
      contextRecoveryCount: context?.successfulRestorations ?? 0,
      runtimeTrace: snapshotRuntimeTrace(this.#player.getTrace())
    });
  }

  public async settled(): Promise<void> {
    await this.#player.settled();
    await this.#composition.controls.settled();
  }

  public dispose(): Promise<void> {
    if (this.#disposal !== null) return this.#disposal;
    this.#disposing = true;
    this.#pendingResize = null;
    const operation = (async () => {
      const failures: unknown[] = [];
      const participantDisposal = settleCleanupOperation(
        () => this.#participant.dispose(),
        failures
      );
      await participantDisposal;
      await Promise.all([
        settleCleanupOperation(() => this.#player.dispose(), failures),
        settleCleanupOperation(() => this.#composition.controls.settled(), failures),
        settleCleanupOperation(() => this.#waitForResizeIdle(), failures)
      ]);
      await settleCleanupOperation(() => this.#session.dispose(), failures);
      await Promise.all([
        settleCleanupOperation(() => this.#releaseOwnedPlayer(), failures),
        settleCleanupOperation(() => this.#fallbackStore.dispose(), failures),
        settleCleanupOperation(() => this.#planes.dispose(), failures)
      ]);
      const receipt = captureCleanupReceipt({
        elementGeneration: this.#elementGeneration,
        sourceGeneration: this.#sourceGeneration,
        participantId: this.#participantId,
        pageRuntime: this.#pageRuntime,
        participant: this.#participant,
        session: this.#session,
        planes: this.#planes,
        composition: this.#composition,
        player: this.#player,
        operationFailureCount: failures.length
      });
      try { this.#cleanupSink(receipt); } catch (error) { failures.push(error); }
      if (failures.length > 0) throw failures[0];
      if (!receipt.completed) throw new Error("aval-player runtime cleanup was incomplete");
    })();
    this.#disposal = operation;
    void operation.catch(() => {
      if (this.#disposal === operation) this.#disposal = null;
    });
    return operation;
  }

  #drainResize(): void {
    if (this.#activeResize !== null || this.#disposing) {
      if (this.#disposing && this.#activeResize === null) this.#resolveResizeIdle();
      return;
    }
    const input = this.#pendingResize;
    this.#pendingResize = null;
    if (input === null) {
      this.#resolveResizeIdle();
      return;
    }
    const operation = Promise.resolve().then(async () => {
      await this.#planes.resizeWithAdmission(input);
    });
    this.#activeResize = operation;
    void operation.catch((error: unknown) => {
      if (!this.#disposing) {
        try {
          this.#diagnosticsSink(normalizeRuntimeFailure(
            "renderer-failure",
            error,
            { operation: "resize" }
          ));
        } catch { /* diagnostics cannot interrupt the coordinator */ }
      }
    }).finally(() => {
      if (this.#activeResize === operation) this.#activeResize = null;
      this.#drainResize();
    });
  }

  #waitForResizeIdle(): Promise<void> {
    if (this.#activeResize === null && this.#pendingResize === null) return Promise.resolve();
    if (this.#resizeIdlePromise === null) {
      this.#resizeIdlePromise = new Promise((resolve) => {
        this.#resolveResizeIdlePromise = resolve;
      });
    }
    return this.#resizeIdlePromise;
  }

  #resolveResizeIdle(): void {
    if (this.#activeResize !== null || this.#pendingResize !== null) return;
    this.#resolveResizeIdlePromise?.();
    this.#resolveResizeIdlePromise = null;
    this.#resizeIdlePromise = null;
  }
}
