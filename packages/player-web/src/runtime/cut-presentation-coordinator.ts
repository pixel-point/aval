import type {
  GraphBodyDefinition,
  GraphEdgeDefinition,
  GraphPresentation,
  MotionGraphResult
} from "@pixel-point/aval-graph";

import type {
  RenderFrameHandle,
  ResidentFrameHandle,
  StreamingFrameHandle
} from "./frame-renderer.js";
import {
  RuntimePlaybackError,
  normalizeRuntimeFailure,
  type RuntimeFailure,
  type RuntimeFailureCode
} from "./errors.js";
import type {
  IntegratedPlaybackSession,
  IntegratedPlaybackTickContext,
  IntegratedPlaybackTraceState,
  IntegratedPreparedContentTick
} from "./integrated-player-contracts.js";
import { assertIntegratedPresentationIdentity } from "./integrated-player-support.js";
import type {
  PathSchedulerPumpOptions,
  PathSchedulerPumpReport,
  PathSchedulerResidentRunwayTransaction,
  PathSchedulerTakeResult,
  PathSchedulerWorkerActivation
} from "./path-scheduler.js";
import {
  CutPresentationInvariantError,
  CutPresentationSupersededError,
  type CutActivationInput,
  type CutActivationReport,
  type CutFrameMedia,
  type CutPresentationCoordinatorOptions,
  type CutPresentationRenderer,
  type CutPresentationScheduler,
  type CutPresentationSnapshot,
  type CutPresentationStatus,
  type CutResidentRunwayFrame
} from "./cut-presentation-contracts.js";
import {
  DEFAULT_CUT_STREAMING_SLOTS,
  checkedCutIncrement,
  cutWorkerFailureCode,
  graphCanConsumeCut,
  rebindCutOrdinal,
  validateCutActivationInput,
  validateCutPresentationOptions,
  validateCutTickContext
} from "./cut-presentation-validation.js";

export {
  CutPresentationInvariantError,
  CutPresentationSupersededError
} from "./cut-presentation-contracts.js";
export type {
  CutActivationInput,
  CutActivationReport,
  CutFrameMedia,
  CutPresentationCoordinatorOptions,
  CutPresentationRenderer,
  CutPresentationScheduler,
  CutPresentationSnapshot,
  CutPresentationStatus,
  CutResidentRunwayFrame
} from "./cut-presentation-contracts.js";

interface ActiveCut {
  readonly serial: number;
  readonly edge: Readonly<GraphEdgeDefinition>;
  readonly targetState: string;
  readonly targetBody: Readonly<GraphBodyDefinition>;
  readonly path: string;
  readonly generation: number;
  readonly runway: readonly Readonly<CutResidentRunwayFrame>[];
  readonly handles: readonly Readonly<ResidentFrameHandle>[];
  readonly entryMode: "cut" | "endpoint";
  readonly completionStart: boolean;
  readonly transaction: Readonly<PathSchedulerResidentRunwayTransaction>;
}

interface StagedCutActivation {
  readonly serial: number;
  readonly normalized: Readonly<CutActivationInput>;
  readonly transaction: Readonly<PathSchedulerResidentRunwayTransaction>;
  readonly controller: AbortController;
  readonly unlinkInput: () => void;
}

interface CommittedCutActivation extends StagedCutActivation {
  readonly activateWorker: PathSchedulerWorkerActivation;
}

interface PreparedCutTick extends IntegratedPreparedContentTick {
  readonly cutToken: true;
  readonly activation: number;
  readonly handle: Readonly<RenderFrameHandle>;
  readonly contextOrdinal: bigint;
}

interface ReadyStreamingFrame {
  readonly activation: number;
  readonly media: Readonly<CutFrameMedia>;
  readonly handle: Readonly<StreamingFrameHandle>;
}

export interface CutStreamingHandoff {
  readonly media: Readonly<CutFrameMedia>;
  readonly handle: Readonly<StreamingFrameHandle>;
}

export interface CutResidentHandoff {
  readonly media: Readonly<CutFrameMedia>;
  readonly handle: Readonly<ResidentFrameHandle>;
}

/**
 * Joins graph identity, PathScheduler generation replacement, persistent cache
 * layers and the synchronous draw barrier. Decoder and upload work is always
 * completed ahead of `prepareContentTick`; that method never awaits.
 */
export class CutPresentationCoordinator implements IntegratedPlaybackSession {
  readonly #scheduler: CutPresentationScheduler;
  readonly #renderer: CutPresentationRenderer;
  readonly #streamingSlots: number;
  readonly #handoffAfterFirstStreaming: boolean;
  readonly #enqueueMediaOperation: <T>(
    operation: (signal?: AbortSignal) => Promise<T>
  ) => Promise<T>;
  readonly #onStaticRecovery: ((failure: Readonly<RuntimeFailure>) => void) | null;
  readonly #readbackTag: CutPresentationCoordinatorOptions["readbackTag"];

  #status: CutPresentationStatus = "idle";
  #serial = 0;
  #active: ActiveCut | null = null;
  #prepared: PreparedCutTick | null = null;
  #drawn: PreparedCutTick | null = null;
  #streamingReady: ReadyStreamingFrame | null = null;
  #uploadPromise: Promise<void> | null = null;
  readonly #operations = new Set<Promise<unknown>>();
  #residentPresented = 0;
  #streamingPresented = 0;
  #nextStreamingSlot: number;
  #recoverySignaled = false;
  #activationAbort: AbortController | null = null;
  #streamingHandoff: Readonly<CutStreamingHandoff> | null = null;
  #residentHandoff: Readonly<CutResidentHandoff> | null = null;
  #stagedActivation: Readonly<StagedCutActivation> | null = null;
  #committedActivation: Readonly<CommittedCutActivation> | null = null;
  #streamingReservation = false;

  public constructor(options: CutPresentationCoordinatorOptions) {
    validateCutPresentationOptions(options);
    this.#scheduler = options.scheduler;
    this.#renderer = options.renderer;
    this.#streamingSlots = options.streamingSlots ?? DEFAULT_CUT_STREAMING_SLOTS;
    this.#nextStreamingSlot = options.firstStreamingSlot ?? 0;
    this.#handoffAfterFirstStreaming =
      options.handoffAfterFirstStreaming ?? false;
    this.#enqueueMediaOperation = options.enqueueMediaOperation;
    this.#onStaticRecovery = options.onStaticRecovery ?? null;
    this.#readbackTag = options.readbackTag;
  }

  /** Binds persistent runway handles without mutating decoder/scheduler state. */
  public stageCut(input: Readonly<CutActivationInput>): void {
    if (this.#status === "disposed") {
      throw this.#failure("disposed", undefined, {
        operation: "activate-cut"
      }, false);
    }
    if (this.#status === "error") {
      throw this.#failure("readiness-failure", undefined, {
        operation: "activate-cut"
      }, false);
    }

    const serial = checkedCutIncrement(this.#serial, "cut activation");
    let normalized: Readonly<CutActivationInput>;
    let handles: readonly Readonly<ResidentFrameHandle>[];
    try {
      normalized = validateCutActivationInput(input);
      handles = Object.freeze(normalized.runway.map(({ layer }) => {
        const handle = this.#renderer.residentHandle(layer);
        if (
          handle.kind !== "resident" ||
          handle.layer !== layer ||
          handle.resourceGeneration !== this.#renderer.resourceGeneration
        ) {
          throw new CutPresentationInvariantError(
            "resident runway handle is stale or belongs to another layer"
          );
        }
        return handle;
      }));
    } catch (error) {
      throw this.#failure("resource-rejection", error, {
        operation: "bind-resident-runway"
      });
    }

    this.#discardStreamingReservation();
    this.#rollbackStagedActivation();
    this.#committedActivation?.unlinkInput();
    this.#committedActivation = null;
    this.#activationAbort?.abort(new CutPresentationSupersededError());
    let transaction: Readonly<PathSchedulerResidentRunwayTransaction>;
    try {
      transaction = this.#scheduler.stageResidentRunway({
        edgeId: normalized.edge.id,
        targetState: normalized.targetState,
        targetBody: normalized.targetBody,
        frames: normalized.runway,
        path: normalized.path,
        ...(normalized.firstPresentationOrdinal === undefined
          ? {}
          : {
              firstPresentationOrdinal:
                normalized.firstPresentationOrdinal
            }),
        ...(normalized.signal === undefined
          ? {}
          : { signal: normalized.signal })
      });
    } catch (error) {
      throw this.#failure(cutWorkerFailureCode(error), error, {
        edge: normalized.edge.id,
        state: normalized.targetState,
        path: normalized.path,
        operation: "stage-resident-runway"
      });
    }
    const activationAbort = new AbortController();
    const unlinkInput = forwardAbort(normalized.signal, activationAbort);
    this.#activationAbort = activationAbort;
    this.#serial = serial;
    this.#prepared = null;
    this.#drawn = null;
    this.#streamingReady = null;
    this.#residentPresented = 0;
    this.#streamingPresented = 0;
    this.#streamingHandoff = null;
    this.#residentHandoff = null;
    const active: Readonly<ActiveCut> = Object.freeze({
      serial,
      edge: normalized.edge,
      targetState: normalized.targetState,
      targetBody: normalized.targetBody,
      path: normalized.path,
      generation: transaction.generation,
      runway: normalized.runway,
      handles,
      entryMode: normalized.entryMode ?? "cut",
      completionStart: normalized.completionStart ?? false,
      transaction
    });
    // Resident pixels are already persistent: frame zero is ready before any
    // worker round trip. Decoder replacement runs behind this visible runway.
    this.#active = active;
    this.#status = "ready";
    this.#stagedActivation = Object.freeze({
      serial,
      normalized,
      transaction,
      controller: activationAbort,
      unlinkInput
    });
  }

  /** Starts the staged generation replacement after resident frame zero drew. */
  public startStagedContinuation(): Promise<Readonly<CutActivationReport>> {
    const committed = this.#committedActivation;
    if (committed === null || committed.serial !== this.#serial) {
      return Promise.reject(new CutPresentationInvariantError(
        "cut continuation has not crossed its commit barrier"
      ));
    }
    this.#committedActivation = null;
    const {
      serial,
      normalized,
      controller: activationAbort,
      unlinkInput,
      activateWorker
    } = committed;
    const active = this.#active;
    if (active === null || active.serial !== serial) {
      unlinkInput();
      return Promise.reject(new CutPresentationSupersededError());
    }
    const generation = committed.transaction.generation;
    const operation = this.#enqueueMediaOperation(async (mediaSignal) => {
      const unlinkMedia = forwardAbort(mediaSignal, activationAbort);
      try {
        if (serial !== this.#serial) throw new CutPresentationSupersededError();
        try {
          await activateWorker();
          if (activationAbort.signal.aborted) {
            throw activationAbort.signal.reason;
          }
          if (serial !== this.#serial) {
            throw new CutPresentationSupersededError();
          }
        } catch (error) {
          throw this.#activationFailure(
            serial,
            cutWorkerFailureCode(error),
            error,
            {
              edge: normalized.edge.id,
              state: normalized.targetState,
              path: normalized.path,
              generation,
              operation: "activate-resident-runway"
            }
          );
        }
        let pump: Readonly<PathSchedulerPumpReport>;
        try {
          pump = await this.#scheduler.pump({
            targetRingFrames: normalized.continuationTargetFrames ?? 1,
            signal: activationAbort.signal,
            ...(normalized.timeoutMs === undefined
              ? {}
              : { timeoutMs: normalized.timeoutMs })
          });
          if (serial !== this.#serial) {
            throw new CutPresentationSupersededError();
          }
          const next = this.#scheduler.takeStreamingContinuation();
          if (next.kind !== "frame") {
            throw new Error("cut continuation was not decoded behind the runway");
          }
          this.#streamingReservation = true;
          this.#beginStreamingUpload(active, next);
          if (this.#uploadPromise !== null) await this.#uploadPromise;
          if (serial !== this.#serial) {
            throw new CutPresentationSupersededError();
          }
        } catch (error) {
          throw this.#activationFailure(
            serial,
            cutWorkerFailureCode(error),
            error,
            {
              edge: normalized.edge.id,
              state: normalized.targetState,
              path: normalized.path,
              generation,
              operation: "pump-cut-continuation"
            }
          );
        }
        return Object.freeze({
          activation: serial,
          generation,
          runwayFrames: normalized.runway.length,
          pump
        });
      } finally {
        unlinkMedia();
      }
    });
    const tracked = this.#trackOperation(operation);
    void tracked.finally(() => {
      unlinkInput();
      if (this.#activationAbort === activationAbort) {
        this.#activationAbort = null;
      }
    }).catch(() => undefined);
    return tracked;
  }

  /** Adds decoded continuation credit outside the realtime callback. */
  public pumpContinuation(
    options: PathSchedulerPumpOptions = {}
  ): Promise<Readonly<PathSchedulerPumpReport>> {
    const operation = this.#enqueueMediaOperation(async (mediaSignal) => {
      this.#assertReady();
      try {
        return await this.#scheduler.pump({
          ...options,
          ...(mediaSignal === undefined ? {} : { signal: mediaSignal })
        });
      } catch (error) {
        const active = this.#active;
        throw this.#failure(cutWorkerFailureCode(error), error, {
          ...(active === null
            ? {}
            : {
                edge: active.edge.id,
                state: active.targetState,
                path: active.path,
                generation: active.generation
              }),
          operation: "pump-cut-continuation"
        });
      }
    });
    return this.#trackOperation(operation);
  }

  /** Waits for all currently scheduled activation, pumping and upload work. */
  public async settled(): Promise<void> {
    for (;;) {
      const operations = [...this.#operations];
      const upload = this.#uploadPromise;
      await Promise.allSettled([
        ...operations,
        ...(upload === null ? [] : [upload])
      ]);
      if (
        this.#operations.size === 0 &&
        (this.#uploadPromise === null || this.#uploadPromise === upload)
      ) return;
    }
  }

  public prepareContentTick(
    context: Readonly<IntegratedPlaybackTickContext>
  ): Readonly<IntegratedPreparedContentTick> | null {
    if (this.#status !== "ready") return null;
    const active = this.#active;
    if (active === null) return null;
    validateCutTickContext(context);
    if (this.#drawn !== null) {
      throw new CutPresentationInvariantError(
        "drawn cut presentation has not been synchronized with the graph"
      );
    }
    if (this.#prepared !== null) {
      if (this.#prepared.contextOrdinal !== context.presentationOrdinal) {
        throw new CutPresentationInvariantError(
          "a cut presentation is already prepared for another tick"
        );
      }
      return this.#prepared;
    }
    if (!graphCanConsumeCut(context, active, this.#residentPresented)) {
      return null;
    }

    if (this.#residentPresented < active.runway.length) {
      const runwayIndex = this.#residentPresented;
      const expected = active.runway[runwayIndex];
      const handle = active.handles[runwayIndex];
      const media = active.transaction.media[runwayIndex];
      if (expected === undefined || handle === undefined || media === undefined) {
        throw this.#failure("readiness-failure",
          "resident runway is sparse", {
            edge: active.edge.id,
            state: active.targetState,
            path: active.path,
            generation: active.generation,
            operation: "prepare-cut-tick"
          });
      }
      if (media.intendedPresentationOrdinal !== context.presentationOrdinal) {
        throw new CutPresentationInvariantError(
          "resident runway ordinal diverged from its scheduler transaction"
        );
      }
      return this.#prepareToken(
        context.presentationOrdinal,
        media,
        handle
      );
    }

    const ready = this.#streamingReady;
    if (ready !== null) {
      if (ready.activation !== active.serial) {
        this.#streamingReady = null;
        return null;
      }
      this.#streamingReady = null;
      return this.#prepareToken(
        context.presentationOrdinal,
        rebindCutOrdinal(ready.media, context.presentationOrdinal),
        ready.handle
      );
    }
    if (this.#uploadPromise !== null) return null;

    if (!this.#schedulerOwnsActive(active)) return null;

    const next = this.#scheduler.takeStreamingContinuation();
    if (next.kind === "frame") {
      this.#beginStreamingUpload(active, next);
    }
    return null;
  }

  public drawContentTick(
    prepared: Readonly<IntegratedPreparedContentTick>,
    presentation: Readonly<GraphPresentation>
  ): string | null {
    if (
      prepared !== this.#prepared &&
      isPreparedCutTick(prepared) &&
      prepared.activation !== this.#serial
    ) {
      throw new CutPresentationSupersededError();
    }
    this.#assertReady();
    const token = this.#requirePreparedToken(prepared);
    const active = this.#active!;
    if (token.activation !== active.serial) {
      throw new CutPresentationSupersededError();
    }
    if (token.handle.resourceGeneration !== this.#renderer.resourceGeneration) {
      throw this.#failure("renderer-failure",
        "cut frame handle belongs to a stale renderer generation", {
          edge: active.edge.id,
          state: active.targetState,
          path: active.path,
          generation: active.generation,
          operation: "draw-cut-frame"
        });
    }
    assertIntegratedPresentationIdentity(
      presentation,
      token.media,
      token.contextOrdinal
    );
    try {
      this.#renderer.draw(token.handle);
    } catch (error) {
      throw this.#failure("renderer-failure", error, {
        edge: active.edge.id,
        state: active.targetState,
        path: active.path,
        generation: active.generation,
        operation: "draw-cut-frame"
      });
    }
    this.#prepared = null;
    this.#drawn = token;
    return this.#readbackTag?.(token.media as Readonly<CutFrameMedia>, token.handle)
      ?? null;
  }

  /** Must be called only after EffectHost has completed the draw barrier. */
  public synchronizeGraph(result: Readonly<MotionGraphResult>): void {
    const drawn = this.#drawn;
    if (drawn === null) return;
    const active = this.#active;
    if (active === null || drawn.activation !== active.serial) {
      this.#drawn = null;
      throw new CutPresentationSupersededError();
    }
    const presentation = result.presentation;
    if (result.operation !== "tick" || presentation === null) {
      throw new CutPresentationInvariantError(
        "drawn cut frame requires the matching graph content tick"
      );
    }
    assertIntegratedPresentationIdentity(
      presentation,
      drawn.media,
      drawn.contextOrdinal
    );
    if (drawn.media.kind !== "frame") {
      throw new CutPresentationInvariantError(
        "cut presentation media must be a decoded frame"
      );
    }
    const media = drawn.media;
    this.#drawn = null;
    if (drawn.handle.kind === "resident") {
      if (this.#residentPresented === 0 && this.#stagedActivation !== null) {
        this.#commitStagedActivation();
      } else {
        this.#scheduler.commitResidentPresentation(media);
      }
      this.#residentPresented = checkedCutIncrement(
        this.#residentPresented,
        "resident cut presentation"
      );
      this.#residentHandoff = Object.freeze({
        media,
        handle: drawn.handle
      });
      if (this.#residentPresented === active.runway.length) {
        this.#primeStreamingContinuation(active);
      }
    } else {
      this.#scheduler.commitPreparedPresentation(media);
      this.#streamingReservation = false;
      this.#streamingHandoff = Object.freeze({
        media,
        handle: drawn.handle
      });
      this.#streamingPresented = checkedCutIncrement(
        this.#streamingPresented,
        "streaming cut presentation"
      );
      if (!this.#handoffAfterFirstStreaming) {
        this.#primeStreamingContinuation(active);
      }
    }
  }

  public traceState(): Readonly<IntegratedPlaybackTraceState> {
    const scheduler = this.#scheduler.snapshot();
    const submitted = scheduler.submittedCursor === null
      ? Object.freeze([])
      : Object.freeze([scheduler.submittedCursor]);
    return Object.freeze({
      scheduler,
      submitted,
      selectedBoundary: this.#active?.edge.id ?? null,
      decodeLeadFrames: this.#active?.runway.length ?? null
    });
  }

  public takeStreamingHandoff(): Readonly<CutStreamingHandoff> | null {
    const handoff = this.#streamingHandoff;
    this.#streamingHandoff = null;
    return handoff;
  }

  public takeResidentHandoff(): Readonly<CutResidentHandoff> | null {
    const handoff = this.#residentHandoff;
    this.#residentHandoff = null;
    return handoff;
  }

  public snapshot(): Readonly<CutPresentationSnapshot> {
    return Object.freeze({
      status: this.#status,
      activation: this.#serial,
      edge: this.#active?.edge.id ?? null,
      targetState: this.#active?.targetState ?? null,
      generation: this.#active?.generation ?? null,
      runwayFrames: this.#active?.runway.length ?? 0,
      residentFramesPresented: this.#residentPresented,
      streamingFramesPresented: this.#streamingPresented,
      uploadPending: this.#uploadPromise !== null,
      streamingReady: this.#streamingReady !== null
    });
  }

  /** The candidate owns scheduler/renderer disposal; this only seals the seam. */
  public dispose(): void {
    if (this.#status === "disposed") return;
    this.#serial = checkedCutIncrement(this.#serial, "cut disposal activation");
    this.#rollbackStagedActivation();
    this.#committedActivation?.unlinkInput();
    this.#committedActivation = null;
    this.#activationAbort?.abort(new CutPresentationSupersededError());
    this.#activationAbort = null;
    this.#status = "disposed";
    this.#active = null;
    this.#prepared = null;
    this.#drawn = null;
    this.#streamingReady = null;
    this.#streamingHandoff = null;
    this.#residentHandoff = null;
    this.#discardStreamingReservation();
  }

  #commitStagedActivation(): void {
    const staged = this.#stagedActivation;
    const active = this.#active;
    if (
      staged === null ||
      active === null ||
      staged.serial !== this.#serial ||
      active.serial !== staged.serial
    ) {
      throw new CutPresentationInvariantError(
        "cut runway has no current scheduler transaction"
      );
    }
    let activateWorker: PathSchedulerWorkerActivation;
    try {
      activateWorker = this.#scheduler.commitResidentRunway(
        staged.transaction,
        { alreadyPresented: 1 }
      );
    } catch (error) {
      this.#scheduler.rollbackResidentRunway(staged.transaction);
      throw this.#activationFailure(
        staged.serial,
        cutWorkerFailureCode(error),
        error,
        {
          edge: staged.normalized.edge.id,
          state: staged.normalized.targetState,
          path: staged.normalized.path,
          generation: staged.transaction.generation,
          operation: "commit-resident-runway"
        }
      );
    }
    this.#stagedActivation = null;
    this.#committedActivation = Object.freeze({
      ...staged,
      activateWorker
    });
  }

  #rollbackStagedActivation(): void {
    const staged = this.#stagedActivation;
    if (staged === null) return;
    this.#scheduler.rollbackResidentRunway(staged.transaction);
    staged.unlinkInput();
    this.#stagedActivation = null;
  }

  #trackOperation<T>(operation: Promise<T>): Promise<T> {
    this.#operations.add(operation);
    void operation.finally(() => {
      this.#operations.delete(operation);
    }).catch(() => undefined);
    return operation;
  }

  #prepareToken(
    ordinal: bigint,
    media: Readonly<CutFrameMedia>,
    handle: Readonly<RenderFrameHandle>
  ): Readonly<PreparedCutTick> {
    const active = this.#active!;
    const trace = this.traceState();
    const token = Object.freeze({
      ...trace,
      routeReady: true,
      media,
      cutToken: true as const,
      activation: active.serial,
      handle,
      contextOrdinal: ordinal
    });
    this.#prepared = token;
    return token;
  }

  #requirePreparedToken(
    prepared: Readonly<IntegratedPreparedContentTick>
  ): Readonly<PreparedCutTick> {
    if (prepared !== this.#prepared) {
      if (isPreparedCutTick(prepared) && prepared.activation !== this.#serial) {
        throw new CutPresentationSupersededError();
      }
      throw new CutPresentationInvariantError(
        "cut draw requires the coordinator's current prepared token"
      );
    }
    return prepared as Readonly<PreparedCutTick>;
  }

  #primeStreamingContinuation(active: Readonly<ActiveCut>): void {
    if (
      this.#status !== "ready" ||
      active.serial !== this.#serial ||
      this.#streamingReady !== null ||
      this.#uploadPromise !== null ||
      !this.#schedulerOwnsActive(active)
    ) return;
    const next = this.#scheduler.takeStreamingContinuation();
    if (next.kind === "frame") {
      this.#streamingReservation = true;
      this.#beginStreamingUpload(active, next);
    }
  }

  #discardStreamingReservation(): void {
    if (!this.#streamingReservation) return;
    this.#streamingReservation = false;
    try {
      this.#scheduler.discardPreparedPresentation();
    } catch {
      // Supersession cleanup must preserve the initiating graph transaction.
    }
  }

  #schedulerOwnsActive(active: Readonly<ActiveCut>): boolean {
    const snapshot = this.#scheduler.snapshot();
    return snapshot.generation === active.generation &&
      snapshot.activePath === active.path;
  }

  #beginStreamingUpload(
    active: Readonly<ActiveCut>,
    next: Extract<PathSchedulerTakeResult, { readonly kind: "frame" }>
  ): void {
    if (this.#uploadPromise !== null) {
      next.frame.close();
      throw new CutPresentationInvariantError(
        "only one cut continuation upload may be pending"
      );
    }
    const serial = active.serial;
    const resourceGeneration = this.#renderer.resourceGeneration;
    const slot = this.#nextStreamingSlot;
    this.#nextStreamingSlot = (slot + 1) % this.#streamingSlots;
    const operation = (async () => {
      let handle: StreamingFrameHandle | null = null;
      try {
        handle = await this.#renderer.uploadStreaming(
          slot,
          active.generation,
          next.frame,
          resourceGeneration
        );
      } catch (error) {
        throw this.#failure("renderer-failure", error, {
          edge: active.edge.id,
          state: active.targetState,
          path: active.path,
          generation: active.generation,
          ordinal: next.media.decodeOrdinal,
          operation: "upload-cut-continuation"
        });
      } finally {
        // FrameRenderer owns this closure. The guard also protects test
        // adapters and renderer failures that reject before claiming source.
        if (!next.frame.closed) next.frame.close();
      }
      if (serial !== this.#serial || this.#status !== "ready") return;
      if (
        handle === null ||
        handle.kind !== "stream" ||
        handle.pathGeneration !== active.generation ||
        handle.resourceGeneration !== this.#renderer.resourceGeneration
      ) {
        throw this.#failure("renderer-failure",
          "streaming continuation upload returned no current handle", {
            edge: active.edge.id,
            state: active.targetState,
            path: active.path,
            generation: active.generation,
            ordinal: next.media.decodeOrdinal,
            operation: "upload-cut-continuation"
          });
      }
      this.#streamingReady = Object.freeze({
        activation: serial,
        media: next.media,
        handle
      });
    })();
    this.#uploadPromise = operation;
    void operation.finally(() => {
      if (this.#uploadPromise === operation) this.#uploadPromise = null;
    }).catch(() => undefined);
  }

  #assertReady(): void {
    if (this.#status === "disposed") {
      throw this.#failure("disposed", undefined, {
        operation: "cut-presentation"
      }, false);
    }
    if (this.#status !== "ready" || this.#active === null) {
      throw new CutPresentationInvariantError(
        "cut presentation coordinator is not ready"
      );
    }
  }

  #failure(
    code: RuntimeFailureCode,
    cause: unknown,
    context: Parameters<typeof normalizeRuntimeFailure>[2],
    recover = true
  ): RuntimePlaybackError {
    const failure = normalizeRuntimeFailure(code, cause, context);
    if (recover && code !== "disposed" && code !== "abort") {
      this.#status = "error";
      if (!this.#recoverySignaled) {
        this.#recoverySignaled = true;
        try {
          this.#onStaticRecovery?.(failure);
        } catch {
          // Recovery notification must not replace the original failure.
        }
      }
    }
    return new RuntimePlaybackError(failure);
  }

  #activationFailure(
    serial: number,
    code: RuntimeFailureCode,
    cause: unknown,
    context: Parameters<typeof normalizeRuntimeFailure>[2]
  ): Error {
    return serial === this.#serial
      ? this.#failure(code, cause, context)
      : new CutPresentationSupersededError();
  }
}

function isPreparedCutTick(
  value: Readonly<IntegratedPreparedContentTick>
): value is Readonly<PreparedCutTick> {
  return "cutToken" in value && value.cutToken === true;
}

function forwardAbort(
  source: AbortSignal | undefined,
  target: AbortController
): () => void {
  if (source === undefined) return () => undefined;
  if (source.aborted) {
    target.abort(source.reason);
    return () => undefined;
  }
  const abort = () => target.abort(source.reason);
  source.addEventListener("abort", abort, { once: true });
  return () => source.removeEventListener("abort", abort);
}
