import { MotionGraphEngine, type MotionGraphResult } from "@rendered-motion/graph";
import { RuntimeAssetCatalog } from "./asset-catalog.js";
import { IntegratedPlayerAssetBinding } from "./integrated-player-asset-session.js";
import { IntegratedPlayerParticipantController } from "./integrated-player-participant-controller.js";
import { IntegratedPlayerDecoderReentry } from "./integrated-player-decoder-reentry.js";
import type { IntegratedPlayerParticipantSnapshot } from "./integrated-player-participant.js";
import { EffectHost } from "./effect-host.js";
import { normalizeRuntimeFailure, type RuntimeFailure } from "./errors.js";
import { IntegratedPlaybackInvariantError, PlaybackFallbackError,
  type IntegratedCandidateAttempt, type IntegratedContentTickContext,
  type IntegratedContentTickResult, type IntegratedPlaybackTraceState,
  type IntegratedPlayerTrace, type IntegratedPlayerOptions,
  type IntegratedRealtimeDriverOptions, type IntegratedPlayerSnapshot,
  type IntegratedPrepareOptions, type IntegratedStaticSurfaceStore,
  type IntegratedTimerHost } from "./integrated-player-contracts.js";
import {
  DEFAULT_INTEGRATED_TIMERS, defaultIntegratedNow,
  disposeInvalidIntegratedStaticStore, snapshotIntegratedRealtimeOptions,
  integratedRealtimeDeadlineUs as realtimeDeadlineUs,
  integratedAbortError as abortError, integratedDisposedError as disposedError,
  validateIntegratedPlayerOptions as validateOptions,
  validateIntegratedPlaybackTraceState as validatePlaybackTraceState,
  validateIntegratedStaticStore as validateStaticStore
} from "./integrated-player-support.js";
import { IntegratedAnimatedPreparation } from "./integrated-animated-preparation.js";
import { IntegratedPlayerActivationCoordinator } from "./integrated-player-activation-coordinator.js";
import { IntegratedTraceHarness } from "./integrated-trace-harness.js";
import { IntegratedRecoveryCoordinator } from "./integrated-player-recovery.js";
import { IntegratedOperationGate } from "./integrated-operation-gate.js";
import { IntegratedStaticPreparation } from "./integrated-player-static-preparation.js";
import { IntegratedPlayerMotion } from "./integrated-player-motion.js";
import { IntegratedPlayerVisibility } from "./integrated-player-visibility.js";
import { IntegratedPlayerContextBinding,
  type IntegratedPlayerContextSnapshot } from "./integrated-player-context.js";
import type { RuntimeReadinessResult, RuntimeVisibilitySnapshot,
  RuntimeVisibilityState } from "./model.js";
import type { MotionPolicy, MotionPolicySnapshot } from "./motion-policy.js";
import { RealtimeDriver, type RealtimeDriverSnapshot } from "./realtime-driver.js";
import { RequestPromises } from "./request-promises.js";
import { admitIntegratedPlayerAssetSource } from "./integrated-player-resource-admission.js";
import type { RuntimeCanvasResourceLease } from "./static-resource-plan.js";
import { IntegratedContentTicker } from "./integrated-content-ticker.js";
export * from "./integrated-player-contracts.js";
export type { RuntimeVisibilitySnapshot, RuntimeVisibilityState } from "./model.js";
/**
 * Internal playback facade. Concrete preparation, worker, renderer, cache,
 * and readiness owners are composed behind narrow collaborators; this class
 * retains graph staging, host effects/promises, recovery, and lifecycle.
 */
export class IntegratedPlayer {
  readonly #catalog: RuntimeAssetCatalog;
  readonly #assetBinding: IntegratedPlayerAssetBinding;
  readonly #participant: IntegratedPlayerParticipantController;
  readonly #decoderReentry: IntegratedPlayerDecoderReentry;
  readonly #graph = new MotionGraphEngine();
  readonly #requests = new RequestPromises();
  readonly #effects: EffectHost;
  readonly #staticStore: IntegratedStaticSurfaceStore;
  readonly #diagnostics: (failure: Readonly<RuntimeFailure>) => void;
  readonly #now: () => number;
  readonly #timers: IntegratedTimerHost;
  readonly #installResult: Readonly<MotionGraphResult>;
  readonly #trace = new IntegratedTraceHarness();
  readonly #lifecycleController = new AbortController();
  readonly #recovery: IntegratedRecoveryCoordinator;
  readonly #staticPreparation: IntegratedStaticPreparation;
  readonly #activation: IntegratedPlayerActivationCoordinator;
  readonly #animatedPreparation: IntegratedAnimatedPreparation;
  readonly #motion: IntegratedPlayerMotion;
  readonly #visibility: IntegratedPlayerVisibility;
  readonly #context: IntegratedPlayerContextBinding | null;
  readonly #realtime: RealtimeDriver | null;
  readonly #operationGate = new IntegratedOperationGate();
  readonly #contentTicker: IntegratedContentTicker;
  readonly #staticResourceLease: RuntimeCanvasResourceLease | null;
  #selectedRendition: string | null = null;
  #activeCandidate: IntegratedCandidateAttempt | null = null;
  #preparePromise: Promise<RuntimeReadinessResult> | null = null;
  #initialPreparationGeneration = 0n;
  #readyResult: Readonly<RuntimeReadinessResult> | null = null;
  #disposePromise: Promise<void> | null = null;
  #terminalOwnerCallbackDepth = 0;
  #lastPresentationOrdinal = 0n;
  #manuallyPaused = true;
  #disposed = false;
  public constructor(options: IntegratedPlayerOptions) {
    const assetSource = validateOptions(options);
    // Host option objects are capability boundaries. Snapshot every value the
    // constructor will need before acquiring catalog, canvas, or static-store
    // ownership so a hostile or time-varying getter cannot strand them.
    const createStaticStore = options.createStaticStore;
    const candidateFactory = options.candidateFactory;
    const candidateAvailability = candidateFactory.availability;
    const contextTarget = candidateFactory.contextTarget;
    const availability = Object.freeze({
      workerAvailable: candidateAvailability.workerAvailable,
      rendererAvailable: candidateAvailability.rendererAvailable
    });
    const eventSink = options.eventSink;
    const diagnosticsSink = options.diagnosticsSink;
    const hostMaxRuntimeBytesOption = options.hostMaxRuntimeBytes;
    const motionPolicy = options.motionPolicy;
    const hostReducedMotion = options.hostReducedMotion;
    const initialVisibility = options.initialVisibility;
    const participantBinding = options.participantBinding;
    const now = options.now;
    const timers = options.timers;
    const realtimeSource = options.realtime;
    const realtime = realtimeSource === undefined
      ? undefined
      : snapshotIntegratedRealtimeOptions(realtimeSource);
    const sourceAdmission = admitIntegratedPlayerAssetSource({
      source: assetSource,
      candidateFactory,
      ...(hostMaxRuntimeBytesOption === undefined
        ? {}
        : { hostMaxRuntimeBytes: hostMaxRuntimeBytesOption })
    });
    const admission = sourceAdmission.resources;
    this.#catalog = admission.catalog;
    this.#assetBinding = sourceAdmission.binding;
    const hostMaxRuntimeBytes = admission.hostMaxRuntimeBytes;
    const staticResourceLease = admission.staticResourceLease;
    let staticStoreCandidate: unknown = null;
    let contextCandidate: IntegratedPlayerContextBinding | null = null;
    let participantCandidate: IntegratedPlayerParticipantController | null = null;
    try {
      this.#installResult = this.#graph.install(this.#catalog.graph);
      this.#effects = new EffectHost({
        requestPromises: this.#requests,
        initialGraphSnapshot: this.#installResult.snapshot,
        ...(eventSink === undefined
          ? {}
          : {
              eventSink: (event) => this.#operationGate.run(() => {
                eventSink(event);
              })
            })
      });
      staticStoreCandidate = createStaticStore.call(options, this.#catalog);
      this.#staticStore = staticStoreCandidate as IntegratedStaticSurfaceStore;
      validateStaticStore(this.#staticStore);
      this.#staticResourceLease = staticResourceLease;
      this.#diagnostics = diagnosticsSink ?? (() => undefined);
      this.#now = now ?? defaultIntegratedNow;
      this.#timers = timers ?? DEFAULT_INTEGRATED_TIMERS;
      participantCandidate = new IntegratedPlayerParticipantController({
        ...(participantBinding === undefined ? {} : { binding: participantBinding }),
        initialVisibility: initialVisibility ?? "visible",
        onDecoderGrant: () => this.#decoderReentry.granted()
      });
      this.#participant = participantCandidate;
      this.#staticPreparation = new IntegratedStaticPreparation({
        catalog: this.#catalog,
        graph: this.#graph,
        effects: this.#effects,
        staticStore: this.#staticStore,
        installResult: this.#installResult,
        lifecycleSignal: this.#lifecycleController.signal,
        now: this.#now,
        timers: this.#timers,
        residency: this.#assetBinding,
        stageReadyResult: (result) => this.#stageStaticReadyResult(result)
      });
      this.#recovery = new IntegratedRecoveryCoordinator({
        catalog: this.#catalog,
        graph: this.#graph,
        effects: this.#effects,
        staticStore: this.#staticStore,
        trace: this.#trace,
        getActiveCandidate: () => this.#activeCandidate,
        detachActiveCandidate: (candidate) => {
          if (this.#activeCandidate === candidate) this.#activeCandidate = null;
        },
        getReadyResult: () => this.#readyResult,
        getSelectedRendition: () => this.#selectedRendition,
        registerRequest: (requestId) => this.#requests.register(requestId),
        stageReadyResult: (result) => this.#stageStaticReadyResult(result),
        reportFailure: (failure) => this.#reportFailure(failure),
        releaseCandidateResidency: (rendition) =>
          this.#releaseCandidateResidency(rendition)
      });
      this.#activation = new IntegratedPlayerActivationCoordinator({
        graph: this.#graph,
        effects: this.#effects,
        staticStore: this.#staticStore,
        trace: this.#trace,
        operationGate: this.#operationGate,
        state: {
          isDisposed: () => this.#disposed,
          getActiveCandidate: () => this.#activeCandidate,
          setActiveCandidate: (candidate) => {
            this.#activeCandidate = candidate;
          },
          getReadyResult: () => this.#readyResult,
          getSelectedRendition: () => this.#selectedRendition,
          setReadyResult: (result) => {
            this.#readyResult = result;
            if (result !== null) this.#participant.markReady(result);
          },
          setSelectedRendition: (renditionId) => {
            this.#selectedRendition = renditionId;
          }
        },
        getMotion: () => this.#motion,
        getRealtime: () => this.#realtime,
        startRecovery: (failure) => this.#startRecovery(failure),
        settleRecovery: () => this.#recovery.settled(),
        reportFailure: (failure) => this.#reportFailure(failure),
        releaseCandidateResidency: (rendition) =>
          this.#releaseCandidateResidency(rendition)
      });
      this.#animatedPreparation = new IntegratedAnimatedPreparation({
        catalog: this.#catalog,
        graph: this.#graph,
        staticPreparation: this.#staticPreparation,
        candidateFactory,
        availability,
        hostMaxRuntimeBytes,
        residency: this.#assetBinding,
        isDisposed: () => this.#disposed,
        commitActivation: (commit) =>
          this.#activation.commitAnimatedActivation(commit),
        commitReentryActivation: (commit) =>
          this.#activation.commitAnimatedReentry(commit),
        rollbackActivation: (attempt) =>
          this.#activation.rollbackAnimatedActivation(attempt),
        recoverActivation: (failure) =>
          this.#activation.recoverAnimatedActivation(failure),
        reportFailure: (failure) => this.#reportFailure(failure)
      });
      this.#motion = new IntegratedPlayerMotion({
        policy: motionPolicy ?? "auto",
        hostReducedMotion: hostReducedMotion ?? false,
        staticPreparation: this.#staticPreparation,
        isDisposed: () => this.#disposed,
        invalidateInitialPreparation: () =>
          this.#invalidateInitialPreparation(),
        pauseForPolicy: () => this.#activation.pauseForMotionPolicy(),
        resumeAfterCancelledReduction: (wasRunning) =>
          this.#activation.resumeAfterCancelledReduction(wasRunning),
        resumeAfterReentry: (wasRunning) =>
          this.#activation.resumeRealtimeAfterReentry(wasRunning),
        resumeAfterVisibilityReentry: (wasRunning) =>
          this.#activation.resumeRealtimeAfterVisibilityReentry(wasRunning),
        coverReducedSurface: (state) =>
          this.#activation.coverReducedSurface(state),
        commitReducedState: (state) =>
          this.#activation.commitReducedState(state),
        commitResourcePressureState: (state) =>
          this.#activation.commitResourcePressureState(state),
        failReduction: (error) => this.#activation.failReduction(error),
        prepareFull: (signal) => this.#animatedPreparation.reenter({ signal }),
        rejectReentry: (error, result) =>
          this.#activation.rejectAnimatedReentry(error, result),
        reportTransitionFailure: (error, transition) =>
          this.#reportFailure(normalizeRuntimeFailure(
            "readiness-failure",
            error,
            { operation: `motion-policy-${transition}` }
          ))
      });
      this.#decoderReentry = new IntegratedPlayerDecoderReentry({
        participant: this.#participant,
        motion: () => this.#motion,
        visibility: () => this.#visibility.snapshot().visibility,
        ready: () => this.#readyResult,
        disposed: () => this.#disposed,
        report: (failure) => this.#reportFailure(failure)
      });
      this.#decoderReentry.syncEligibility();
      this.#visibility = new IntegratedPlayerVisibility({
        initialVisibility: initialVisibility ?? "visible",
        staticPreparation: this.#staticPreparation,
        motion: this.#motion,
        isDisposed: () => this.#disposed,
        isPrepared: () => this.#readyResult !== null,
        getPresentationOrdinal: () => this.#lastPresentationOrdinal,
        invalidateInitialPreparation: () =>
          this.#invalidateInitialPreparation(),
        abortAnimatedPreparation: () => this.#animatedPreparation.abort(),
        pauseForVisibility: () => this.#activation.pauseForVisibility(),
        resumeCancelledVisibility: (wasRunning) =>
          this.#activation.resumeRealtimeAfterVisibilityReentry(wasRunning),
        coverVisibilitySurface: (state) =>
          this.#activation.coverVisibilitySurface(state),
        commitVisibilitySuspended: (state) =>
          this.#activation.commitVisibilitySuspended(state),
        reportFailure: (error, operation) =>
          this.#reportFailure(normalizeRuntimeFailure(
            "readiness-failure",
            error,
            { operation }
          )),
        canResumeAnimated: () =>
          this.#context?.canVisibilityResume() ?? true
      });
      this.#realtime = realtime === undefined
        ? null
        : this.#createRealtimeDriver(realtime);
      contextCandidate = contextTarget === undefined
        ? null
        : new IntegratedPlayerContextBinding({
            target: contextTarget,
            activation: this.#activation,
            animatedPreparation: this.#animatedPreparation,
            motion: this.#motion,
            visibility: this.#visibility,
            isDisposed: () => this.#disposed,
            getActiveCandidate: () => this.#activeCandidate,
            getReadyResult: () => this.#readyResult,
            getPreparePromise: () => this.#preparePromise,
            invalidateInitialPreparation: () =>
              this.#invalidateInitialPreparation(),
            reportFailure: (failure) => this.#reportFailure(failure)
          });
      this.#context = contextCandidate;
      this.#contentTicker = new IntegratedContentTicker({
        graph: this.#graph, effects: this.#effects, trace: this.#trace,
        operationGate: this.#operationGate,
        isDisposed: () => this.#disposed,
        isBlocked: () => this.#context?.blocked === true,
        isVisibilityActive: () =>
          this.#visibility.snapshot().suspension === "active",
        isRecoveryActive: () => this.#recovery.active,
        hasRealtime: () => this.#realtime !== null,
        getPresentationOrdinal: () => this.#lastPresentationOrdinal,
        setPresentationOrdinal: (value) => { this.#lastPresentationOrdinal = value; },
        getActiveCandidate: () => this.#activeCandidate,
        touch: () => { this.#participant.touch(); },
        startRecovery: (failure) => this.#startRecovery(failure),
        now: this.#now
      });
      this.#effects.publishMetadataReady();
    } catch (error) {
      void contextCandidate?.dispose();
      participantCandidate?.dispose();
      disposeInvalidIntegratedStaticStore(staticStoreCandidate);
      try {
        staticResourceLease?.release();
      } catch {
        // Resource-host cleanup cannot replace the constructor failure.
      }
      void this.#assetBinding.dispose();
      throw error;
    }
  }
  public get catalog(): RuntimeAssetCatalog {
    return this.#catalog;
  }
  public snapshot(): Readonly<IntegratedPlayerSnapshot> {
    const mirror = this.#effects.snapshot();
    return Object.freeze({
      readiness: mirror.readiness,
      requestedState: mirror.requestedState,
      visualState: mirror.visualState,
      isTransitioning: mirror.isTransitioning,
      selectedRendition: this.#selectedRendition,
      preparing: this.#preparePromise !== null && this.#readyResult === null,
      disposed: this.#disposed
    });
  }
  public getTrace(): IntegratedPlayerTrace {
    return this.#trace.getTrace();
  }
  public motionSnapshot(): Readonly<MotionPolicySnapshot> {
    return this.#motion.snapshot();
  }
  public visibilitySnapshot(): Readonly<RuntimeVisibilitySnapshot> {
    return this.#visibility.snapshot();
  }
  public contextSnapshot(): Readonly<IntegratedPlayerContextSnapshot> | null {
    return this.#context?.snapshot() ?? null;
  }
  public participantSnapshot(): Readonly<IntegratedPlayerParticipantSnapshot> | null {
    return this.#participant.snapshot();
  }
  public setVisibility(
    visibility: RuntimeVisibilityState
  ): Promise<Readonly<RuntimeVisibilitySnapshot>> {
    if (this.#disposed) return Promise.reject(disposedError());
    this.#participant.setVisibility(visibility);
    if (this.#recovery.busy) {
      return this.#reconcileContextAfter(this.#recovery.settled().then(() => {
        if (this.#disposed) throw disposedError();
        return this.#operationGate.active
          ? this.#operationGate.enqueue(() =>
              this.#visibility.setVisibility(visibility)
            )
          : this.#visibility.setVisibility(visibility);
      }));
    }
    if (this.#operationGate.active) {
      return this.#reconcileContextAfter(this.#operationGate.enqueue(() =>
        this.setVisibility(visibility)
      ));
    }
    return this.#reconcileContextAfter(
      this.#visibility.setVisibility(visibility)
    );
  }
  public setMotionPolicy(
    policy: MotionPolicy
  ): Promise<Readonly<MotionPolicySnapshot>> {
    if (this.#disposed) return Promise.reject(disposedError());
    if (this.#recovery.active) {
      return this.#reconcileContextAfter(this.#recovery.settled().then(() => {
        if (this.#disposed) throw disposedError();
        return this.#operationGate.active
          ? this.#operationGate.enqueue(() =>
              this.#setMotionPolicyNow(policy)
            )
          : this.#setMotionPolicyNow(policy);
      }));
    }
    if (this.#operationGate.active) {
      return this.#reconcileContextAfter(
        this.#operationGate.enqueue(() => this.setMotionPolicy(policy))
      );
    }
    return this.#reconcileContextAfter(this.#setMotionPolicyNow(policy));
  }
  public setHostReducedMotion(
    reduced: boolean
  ): Promise<Readonly<MotionPolicySnapshot>> {
    if (this.#disposed) return Promise.reject(disposedError());
    if (this.#recovery.active) {
      return this.#reconcileContextAfter(this.#recovery.settled().then(() => {
        if (this.#disposed) throw disposedError();
        return this.#operationGate.active
          ? this.#operationGate.enqueue(() =>
              this.#setHostReducedMotionNow(reduced)
            )
          : this.#setHostReducedMotionNow(reduced);
      }));
    }
    if (this.#operationGate.active) {
      return this.#reconcileContextAfter(this.#operationGate.enqueue(() =>
        this.setHostReducedMotion(reduced)
      ));
    }
    return this.#reconcileContextAfter(
      this.#setHostReducedMotionNow(reduced)
    );
  }

  /** Commit a strict-static resource fallback without changing host policy. */
  public reclaimForPagePressure(): Promise<boolean> {
    if (this.#disposed) return Promise.reject(disposedError());
    const operation = this.#motion.reclaimForResourcePressure();
    return operation.then((covered) => {
      this.#decoderReentry.syncEligibility();
      return covered;
    });
  }
  /** Starts the player-owned M5.5 presentation clock after animated readiness. */
  public startRealtime(): void {
    if (this.#disposed) throw disposedError();
    if (this.#operationGate.active) {
      throw new IntegratedPlaybackInvariantError(
        "realtime playback cannot start inside an effect transaction"
      );
    }
    if (this.#realtime === null) {
      throw new IntegratedPlaybackInvariantError(
        "no realtime presentation source is configured"
      );
    }
    if (this.#effects.readiness !== "interactiveReady") {
      throw new IntegratedPlaybackInvariantError(
        "realtime presentation requires interactive readiness"
      );
    }
    if (this.#context?.blocked === true) {
      throw new IntegratedPlaybackInvariantError(
        "realtime presentation requires a restored rendering context"
      );
    }
    if (this.#visibility.snapshot().suspension !== "active") {
      throw new IntegratedPlaybackInvariantError(
        "realtime presentation requires visible active ownership"
      );
    }
    this.#realtime.start();
  }
  public realtimeSnapshot(): Readonly<RealtimeDriverSnapshot> | null {
    return this.#realtime?.snapshot() ?? null;
  }
  /** Synchronous adapter used by both the realtime driver and proof harness. */
  public tryContentTick(
    context: IntegratedContentTickContext
  ): Readonly<IntegratedContentTickResult> {
    return this.#contentTicker.try(context);
  }

  public prepare(
    options: IntegratedPrepareOptions = {}
  ): Promise<RuntimeReadinessResult> {
    if (this.#disposed) {
      return Promise.reject(disposedError());
    }
    if (this.#recovery.promise !== null) {
      return this.#recovery.promise.then(() => {
        if (this.#readyResult === null) {
          throw new PlaybackFallbackError(
            "animation recovery completed without a ready result"
          );
        }
        return this.#readyResult;
      });
    }
    if (this.#readyResult !== null) {
      return Promise.resolve(this.#readyResult);
    }
    if (this.#preparePromise !== null) return this.#preparePromise;

    this.#participant.markPreparing();
    const operation = Promise.resolve().then(() =>
      this.#prepareLatestMotionMode(options)
    );
    this.#preparePromise = operation;
    void operation.finally(() => {
      if (this.#preparePromise === operation && this.#readyResult === null) {
        this.#preparePromise = null;
        this.#participant.markLoading();
      }
    }).catch(() => undefined);
    return operation;
  }

  async #prepareLatestMotionMode(
    options: IntegratedPrepareOptions
  ): Promise<Readonly<RuntimeReadinessResult>> {
    for (;;) {
      if (this.#disposed) throw disposedError();
      const generation = this.#initialPreparationGeneration;
      try {
        if (this.#context?.blocked === true) {
          return await this.#context.prepareStatic(options);
        }
        return this.#visibility.shouldPrepareHidden()
          ? await this.#visibility.prepareHidden(options)
          : this.#motion.shouldPrepareReduced()
          ? await this.#motion.prepareReduced(options)
          : await this.#animatedPreparation.run(options);
      } catch (error) {
        if (
          this.#disposed ||
          options.signal?.aborted === true ||
          generation === this.#initialPreparationGeneration
        ) {
          throw error;
        }
        // A policy change aborted this generation. Candidate/static owners
        // settle their exact resources before the same public prepare promise
        // starts the newest effective mode.
      }
    }
  }

  #invalidateInitialPreparation(): void {
    if (this.#readyResult !== null || this.#preparePromise === null) return;
    this.#initialPreparationGeneration += 1n;
    this.#animatedPreparation.abort();
  }

  #setMotionPolicyNow(
    policy: MotionPolicy
  ): Promise<Readonly<MotionPolicySnapshot>> {
    const initialPreparation = this.#readyResult === null
      ? this.#preparePromise
      : null;
    const operation = this.#motion.setPolicy(policy);
    this.#decoderReentry.syncEligibility();
    return operation.then(async () => {
      if (initialPreparation !== null) await initialPreparation;
      return this.#motion.snapshot();
    });
  }

  #setHostReducedMotionNow(
    reduced: boolean
  ): Promise<Readonly<MotionPolicySnapshot>> {
    const initialPreparation = this.#readyResult === null
      ? this.#preparePromise
      : null;
    const operation = this.#motion.setHostReducedMotion(reduced);
    this.#decoderReentry.syncEligibility();
    return operation.then(async () => {
      if (initialPreparation !== null) await initialPreparation;
      return this.#motion.snapshot();
    });
  }

  public requestState(target: string): Promise<void> {
    if (this.#operationGate.active) {
      return this.#operationGate.enqueue(() => this.requestState(target));
    }
    return this.#operationGate.run(() => this.#requestStateNow(target));
  }

  /** Route one authored host event through the sole installed graph. */
  public send(event: string): boolean {
    if (typeof event !== "string") return false;
    if (this.#disposed || this.#operationGate.active) return false;
    this.#participant.touch();
    if (this.#effects.readiness === "staticReady") {
      const visualState = this.#effects.visualState;
      if (visualState === null) return false;
      const edge = this.#catalog.graph.definition.edges.find((candidate) =>
        candidate.from === visualState &&
        candidate.trigger?.type === "event" &&
        candidate.trigger.name === event
      );
      if (edge === undefined) return false;
      const operation = this.#visibility.snapshot().visibility === "hidden"
        ? this.#recovery.requestLatestStaticState(edge.to)
        : this.#recovery.requestStaticState(edge.to);
      void operation.catch(() => undefined);
      return true;
    }
    return this.#operationGate.run(() => this.#sendNow(event));
  }

  /** Whether the currently animated graph has a direct ready route. */
  public readyFor(target: string): boolean {
    if (
      this.#disposed ||
      typeof target !== "string" ||
      this.#effects.readiness !== "interactiveReady"
    ) return false;
    const snapshot = this.#graph.snapshot();
    const source = snapshot.requestedState ?? snapshot.visualState;
    if (source === null) return false;
    if (source === target) return true;
    return this.#catalog.graph.definition.edges.some((edge) =>
      edge.from === source && edge.to === target
    );
  }

  /** Public M8 clock seam; logical presentation time is retained. */
  public pauseRealtime(): void {
    if (this.#disposed) throw disposedError();
    this.#manuallyPaused = true;
    if (this.#realtime?.snapshot().running === true) {
      this.#realtime.pauseForVisibility();
    }
  }

  /** Resume only when animated, visible ownership is currently usable. */
  public async resumeRealtime(): Promise<void> {
    if (this.#disposed) throw disposedError();
    this.#manuallyPaused = false;
    await this.settled();
    if (
      this.#realtime === null ||
      this.#effects.readiness !== "interactiveReady" ||
      this.#visibility.snapshot().suspension !== "active" ||
      this.#context?.blocked === true
    ) return;
    const snapshot = this.#realtime.snapshot();
    if (snapshot.running) return;
    if (snapshot.nextDeadlineMs === null) this.#realtime.start();
    else this.#realtime.resumeAfterVisibility(true);
  }

  #sendNow(event: string): boolean {
    const result = this.#graph.send(event);
    if (result.accepted !== true) return false;
    const playback = this.#activeCandidate?.playback ?? null;
    if (this.#recovery.active) {
      this.#effects.applyRecoveryIntent(result);
      this.#recovery.supersedeRecoveryPresentation(
        result.snapshot.requestedState
      );
      return true;
    }
    try {
      playback?.synchronizeGraph(result);
    } catch (error) {
      this.#effects.apply(result);
      this.#startRecovery(normalizeRuntimeFailure(
        "readiness-failure",
        error,
        { operation: "send-synchronization" }
      ));
      return true;
    }
    this.#effects.apply(result);
    this.#visibility.supersedePresentation(result.snapshot.requestedState);
    if (playback === null && this.#readyResult === null) {
      this.#staticPreparation.supersedePresentation(
        result.snapshot.requestedState
      );
    }
    return true;
  }

  #requestStateNow(target: string): Promise<void> {
    if (this.#disposed) return Promise.reject(disposedError());
    this.#participant.touch();
    if (this.#effects.readiness === "staticReady") {
      return this.#visibility.snapshot().visibility === "hidden"
        ? this.#recovery.requestLatestStaticState(target)
        : this.#recovery.requestStaticState(target);
    }
    const result = this.#graph.request(target);
    const request = result.requestId === undefined
      ? Promise.resolve()
      : this.#requests.register(result.requestId);

    const playback = this.#activeCandidate?.playback ?? null;
    if (this.#recovery.active) {
      this.#effects.applyRecoveryIntent(result);
      this.#recovery.supersedeRecoveryPresentation(
        result.snapshot.requestedState
      );
      return request;
    }
    try {
      playback?.synchronizeGraph(result);
    } catch (error) {
      // The graph intent is already admitted. Mirror it before recovering so
      // the returned graph-issued promise remains the only public outcome.
      this.#effects.apply(result);
      this.#startRecovery(normalizeRuntimeFailure(
        "readiness-failure",
        error,
        { state: target, operation: "request-synchronization" }
      ));
      return request;
    }
    this.#effects.apply(result);
    this.#visibility.supersedePresentation(
      result.snapshot.requestedState
    );
    if (playback === null && this.#readyResult === null) {
      this.#staticPreparation.supersedePresentation(
        result.snapshot.requestedState
      );
    }
    if (playback !== null) {
      try {
        const traceState = playback.traceState();
        validatePlaybackTraceState(traceState);
        this.#trace.recordOperation({
          result,
          playback: traceState,
          readiness: this.#effects.readiness
        });
      } catch (error) {
        this.#startRecovery(normalizeRuntimeFailure(
          "readiness-failure",
          error,
          { state: target, operation: "request-trace" }
        ));
      }
    }
    return request;
  }

  /** Await all recovery/static presentation work currently owned by the player. */
  public async settled(): Promise<void> {
    await this.#recovery.settled();
    await this.#context?.settled();
    await this.#visibility.settled();
    await this.#motion.settled();
  }

  public dispose(): Promise<void> {
    if (this.#terminalOwnerCallbackDepth > 0) {
      // This owner is already being retired by the active player transaction.
      // Joining that transaction from inside its callback would self-await.
      return Promise.resolve();
    }
    if (this.#disposePromise !== null) return this.#disposePromise;
    const operation = this.#operationGate.active
      ? Promise.resolve().then(() => this.#disposeInternal())
      : this.#disposeInternal();
    this.#disposePromise = operation;
    return operation;
  }

  #reportFailure(failure: Readonly<RuntimeFailure>): void {
    try {
      this.#diagnostics(failure);
    } catch {
      // Diagnostics are observational and never own playback lifecycle.
    }
  }

  async #disposeInternal(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    // Capture the serialized motion tail after invalidating its transition.
    // Await it only after aborting the media/recovery producers below: a
    // reduced-to-full re-entry can otherwise be waiting on their work.
    const contextDisposal = this.#context?.dispose() ?? Promise.resolve();
    const visibilityDisposal = this.#visibility.dispose();
    const motionDisposal = this.#motion.dispose();
    try {
      this.#realtime?.dispose();
    } catch (error) {
      this.#reportFailure(normalizeRuntimeFailure(
        "disposed",
        error,
        { operation: "realtime-driver-disposal" }
      ));
    }
    this.#lifecycleController.abort(abortError());
    this.#animatedPreparation.abort();
    const recoveryDisposal = this.#recovery.dispose();
    await this.#preparePromise?.catch(() => undefined);
    await recoveryDisposal;
    await contextDisposal;
    await visibilityDisposal;
    await motionDisposal;

    let traceState: Readonly<IntegratedPlaybackTraceState> | null = null;
    if (this.#activeCandidate !== null) {
      try {
        traceState = this.#activeCandidate.playback.traceState();
        validatePlaybackTraceState(traceState);
      } catch (error) {
        traceState = null;
        this.#reportFailure(normalizeRuntimeFailure(
          "readiness-failure",
          error,
          { operation: "player-disposal-trace" }
        ));
      }
    }

    const candidates = new Set<IntegratedCandidateAttempt>();
    const selectedRendition = this.#selectedRendition;
    if (this.#activeCandidate !== null) candidates.add(this.#activeCandidate);
    this.#activeCandidate = null;
    for (const candidate of candidates) {
      try {
        await this.#invokeTerminalOwner(() => candidate.dispose());
        if (selectedRendition !== null) {
          this.#releaseCandidateResidency(selectedRendition);
        }
      } catch (error) {
        this.#reportFailure(normalizeRuntimeFailure(
          "readiness-failure",
          error,
          { operation: "player-disposal" }
        ));
      }
    }

    try {
      const retainedVisualState = this.#effects.visualState;
      const result = this.#graph.dispose(
        retainedVisualState === null ? {} : { retainedVisualState }
      );
      const resultForHost = this.#effects.applyDisposal(result);
      if (traceState !== null) {
        this.#trace.recordOperation({
          result: resultForHost,
          playback: traceState,
          readiness: this.#effects.readiness
        });
      }
    } finally {
      try {
        this.#requests.dispose();
      } catch (error) {
        this.#reportFailure(normalizeRuntimeFailure(
          "disposed",
          error,
          { operation: "request-ledger-disposal" }
        ));
      }
      try {
        this.#staticStore.dispose();
      } catch (error) {
        this.#reportFailure(normalizeRuntimeFailure(
          "disposed",
          error,
          { operation: "static-store-disposal" }
        ));
      }
      try {
        await this.#invokeTerminalOwner(() => this.#staticStore.settled());
      } catch (error) {
        this.#reportFailure(normalizeRuntimeFailure(
          "disposed",
          error,
          { operation: "static-store-settlement" }
        ));
      }
      try {
        this.#staticResourceLease?.release();
      } catch {
        this.#reportFailure(normalizeRuntimeFailure(
          "disposed",
          undefined,
          { operation: "static-resource-release" }
        ));
      }
      try {
        this.#participant.dispose();
      } catch {
        this.#reportFailure(normalizeRuntimeFailure(
          "disposed",
          undefined,
          { operation: "participant-detachment" }
        ));
      }
      try {
        await this.#assetBinding.dispose();
      } catch (error) {
        this.#reportFailure(normalizeRuntimeFailure(
          "disposed",
          error,
          { operation: "catalog-disposal" }
        ));
      }
    }
  }

  #invokeTerminalOwner(operation: () => unknown): unknown {
    this.#terminalOwnerCallbackDepth += 1;
    try {
      return operation();
    } finally {
      this.#terminalOwnerCallbackDepth -= 1;
    }
  }
  #reconcileContextAfter<T>(operation: Promise<T>): Promise<T> {
    return operation.then((result) => {
      this.#context?.reconcile();
      return result;
    });
  }
  #createRealtimeDriver(
    options: Readonly<IntegratedRealtimeDriverOptions>
  ): RealtimeDriver {
    return new RealtimeDriver({
      frameRate: this.#catalog.manifest.frameRate,
      requestFrame: options.requestFrame,
      cancelFrame: options.cancelFrame,
      now: options.now ?? this.#now,
      tryContentTick: (context) => this.#contentTicker.tryRealtime({
        presentationOrdinal: context.presentationOrdinal,
        rationalDeadlineUs: realtimeDeadlineUs(context.deadlineMs),
        callbackStartMicroseconds: realtimeDeadlineUs(context.callbackStartMs),
        ...(context.eligibleAnimationFrameOrdinal === null
          ? {}
          : { eligibleAnimationFrameOrdinal: context.eligibleAnimationFrameOrdinal })
      }),
      ...(options.onUnderflow === undefined
        ? {}
        : { onUnderflow: options.onUnderflow })
    });
  }

  #startRecovery(failure: Readonly<RuntimeFailure>): void {
    try {
      this.#realtime?.stopAfterFailure();
    } catch (error) {
      this.#reportFailure(normalizeRuntimeFailure(
        "disposed",
        error,
        { operation: "realtime-recovery-stop" }
      ));
    }
    this.#recovery.start(failure);
  }

  #stageStaticReadyResult(
    result: Readonly<RuntimeReadinessResult> | null
  ): void {
    this.#selectedRendition = null;
    this.#readyResult = result;
    if (result !== null) {
      this.#motion.stageReadyResult(result);
      this.#participant.markReady(result);
      this.#decoderReentry.readyChanged();
    }
  }

  #releaseCandidateResidency(rendition: string): void {
    try {
      this.#assetBinding.releaseFailedCandidate(rendition);
    } catch (error) {
      this.#reportFailure(normalizeRuntimeFailure(
        "resource-rejection",
        error,
        { rendition, operation: "retired-candidate-eviction" }
      ));
    }
  }

}
