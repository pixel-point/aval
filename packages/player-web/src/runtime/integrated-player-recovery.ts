import {
  GRAPH_LIMITS,
  MotionGraphEngine
} from "@rendered-motion/graph";

import type { RuntimeAssetCatalog } from "./asset-catalog.js";
import type { EffectHost } from "./effect-host.js";
import {
  IntegratedPlaybackInvariantError,
  PlaybackFallbackError,
  type IntegratedCandidateAttempt,
  type IntegratedPlaybackTraceState,
  type IntegratedStaticSurfaceStore
} from "./integrated-player-contracts.js";
import {
  assertIntegratedStaticPresentation,
  integratedAbortReason,
  raceIntegratedAbort,
  throwIfIntegratedAborted,
  validateIntegratedPlaybackTraceState
} from "./integrated-player-support.js";
import type { IntegratedTraceHarness } from "./integrated-trace-harness.js";
import {
  normalizeRuntimeFailure,
  type RuntimeFailure
} from "./errors.js";
import {
  createRuntimeCandidateReport,
  createRuntimeReadinessReport,
  type RuntimeReadinessResult
} from "./model.js";
import { StaticOperationQueue } from "./static-operation-queue.js";

interface IntegratedRecoveryCoordinatorOptions {
  readonly catalog: RuntimeAssetCatalog;
  readonly graph: MotionGraphEngine;
  readonly effects: EffectHost;
  readonly staticStore: IntegratedStaticSurfaceStore;
  readonly trace: IntegratedTraceHarness;
  readonly getActiveCandidate: () => IntegratedCandidateAttempt | null;
  readonly detachActiveCandidate: (
    candidate: IntegratedCandidateAttempt
  ) => void;
  readonly getReadyResult: () => Readonly<RuntimeReadinessResult> | null;
  readonly getSelectedRendition: () => string | null;
  readonly registerRequest: (requestId: number) => Promise<void>;
  readonly stageReadyResult: (
    result: Readonly<RuntimeReadinessResult> | null
  ) => void;
  readonly reportFailure: (failure: Readonly<RuntimeFailure>) => void;
  readonly releaseCandidateResidency: (rendition: string) => void;
}

/** Owns the single async static/recovery lane after installation. */
export class IntegratedRecoveryCoordinator {
  readonly #catalog: RuntimeAssetCatalog;
  readonly #graph: MotionGraphEngine;
  readonly #effects: EffectHost;
  readonly #staticStore: IntegratedStaticSurfaceStore;
  readonly #trace: IntegratedTraceHarness;
  readonly #getActiveCandidate: () => IntegratedCandidateAttempt | null;
  readonly #detachActiveCandidate: (
    candidate: IntegratedCandidateAttempt
  ) => void;
  readonly #getReadyResult: () => Readonly<RuntimeReadinessResult> | null;
  readonly #getSelectedRendition: () => string | null;
  readonly #registerRequest: (requestId: number) => Promise<void>;
  readonly #stageReadyResult: (
    result: Readonly<RuntimeReadinessResult> | null
  ) => void;
  readonly #reportFailure: (failure: Readonly<RuntimeFailure>) => void;
  readonly #releaseCandidateResidency: (rendition: string) => void;
  readonly #operations = new StaticOperationQueue();

  #recovery: Promise<void> | null = null;
  #recoveryPresentation: {
    readonly state: string;
    readonly controller: AbortController;
  } | null = null;
  #latestStaticRequestGeneration = 0;
  #latestStaticPresentation: AbortController | null = null;

  public constructor(options: Readonly<IntegratedRecoveryCoordinatorOptions>) {
    this.#catalog = options.catalog;
    this.#graph = options.graph;
    this.#effects = options.effects;
    this.#staticStore = options.staticStore;
    this.#trace = options.trace;
    this.#getActiveCandidate = options.getActiveCandidate;
    this.#detachActiveCandidate = options.detachActiveCandidate;
    this.#getReadyResult = options.getReadyResult;
    this.#getSelectedRendition = options.getSelectedRendition;
    this.#registerRequest = options.registerRequest;
    this.#stageReadyResult = options.stageReadyResult;
    this.#reportFailure = options.reportFailure;
    this.#releaseCandidateResidency = options.releaseCandidateResidency;
  }

  public get active(): boolean {
    return this.#recovery !== null;
  }

  public get promise(): Promise<void> | null {
    return this.#recovery;
  }

  public get busy(): boolean {
    return this.#recovery !== null || this.#operations.snapshot().pending > 0;
  }

  public start(failure: Readonly<RuntimeFailure>): void {
    if (this.#recovery !== null) return;
    const recovery = this.#operations.enqueue(({ signal }) =>
      this.#recover(failure, signal)
    );
    this.#recovery = recovery;
    void recovery.catch(() => undefined);
  }

  public requestStaticState(target: string): Promise<void> {
    return this.#operations.enqueue(({ signal }) =>
      this.#requestStatic(target, signal)
    );
  }

  /** Hidden-time requests coalesce before spending decode/presentation work. */
  public requestLatestStaticState(target: string): Promise<void> {
    if (this.#latestStaticRequestGeneration >= Number.MAX_SAFE_INTEGER) {
      return Promise.reject(new RangeError(
        "latest static request generation exceeds safe range"
      ));
    }
    this.#latestStaticRequestGeneration += 1;
    const generation = this.#latestStaticRequestGeneration;
    this.#latestStaticPresentation?.abort(new DOMException(
      "hidden static request was superseded",
      "AbortError"
    ));
    return this.#operations.enqueue(({ signal }) =>
      this.#requestLatestStatic(target, generation, signal)
    );
  }

  /** Cancel an obsolete in-flight recovery surface before it can commit. */
  public supersedeRecoveryPresentation(requestedState: string | null): void {
    const presentation = this.#recoveryPresentation;
    if (
      presentation === null ||
      presentation.state === requestedState ||
      presentation.controller.signal.aborted
    ) {
      return;
    }
    presentation.controller.abort(new DOMException(
      "recovery presentation was superseded",
      "AbortError"
    ));
  }

  public async settled(): Promise<void> {
    if (this.#recovery !== null) await this.#recovery;
    await this.#operations.settled();
    await Promise.resolve();
  }

  public async dispose(): Promise<void> {
    this.#operations.dispose();
    await this.#recovery?.catch(() => undefined);
    await this.#operations.settled();
  }

  async #recover(
    failure: Readonly<RuntimeFailure>,
    signal: AbortSignal
  ): Promise<void> {
    this.#reportFailure(failure);
    const candidate = this.#getActiveCandidate();
    const candidateRendition = this.#getSelectedRendition();
    let traceState: Readonly<IntegratedPlaybackTraceState> | null = null;
    if (candidate !== null) {
      try {
        traceState = candidate.playback.traceState();
        validateIntegratedPlaybackTraceState(traceState);
      } catch (error) {
        this.#reportFailure(normalizeRuntimeFailure(
          "readiness-failure",
          error,
          { operation: "animated-recovery-trace" }
        ));
      }
    }
    throwIfIntegratedAborted(signal);

    let requested: string;
    try {
      for (;;) {
        const latest = this.#graph.snapshot().requestedState;
        if (latest === null) {
          throw new PlaybackFallbackError(
            "animated recovery has no requested static state"
          );
        }
        requested = latest;
        const controller = new AbortController();
        const forwardAbort = (): void => controller.abort(
          integratedAbortReason(signal)
        );
        if (signal.aborted) forwardAbort();
        else signal.addEventListener("abort", forwardAbort, { once: true });
        const presentation = Object.freeze({ state: requested, controller });
        this.#recoveryPresentation = presentation;
        try {
          await raceIntegratedAbort(
            this.#staticStore.presentState(requested, {
              signal: controller.signal,
              cover: false
            }),
            controller.signal
          );
          if (this.#staticStore.currentState() !== requested) {
            throw new IntegratedPlaybackInvariantError(
              "recovery static store committed the wrong state"
            );
          }
        } catch (error) {
          if (signal.aborted) throw integratedAbortReason(signal);
          if (controller.signal.aborted) continue;
          throw error;
        } finally {
          signal.removeEventListener("abort", forwardAbort);
          if (this.#recoveryPresentation === presentation) {
            this.#recoveryPresentation = null;
          }
        }
        throwIfIntegratedAborted(signal);
        if (controller.signal.aborted) continue;
        if (this.#graph.snapshot().requestedState === requested) break;
      }
    } catch (error) {
      if (signal.aborted) throw integratedAbortReason(signal);
      const staticFailure = normalizeRuntimeFailure(
        "renderer-failure",
        error,
        { operation: "animated-static-recovery" }
      );
      this.#reportFailure(staticFailure);
      const retainedVisualState = this.#effects.visualState;
      let retainedStaticMatches = false;
      try {
        retainedStaticMatches = retainedVisualState !== null &&
          this.#staticStore.currentState() === retainedVisualState;
      } catch {
        // The original static failure remains authoritative.
      }
      if (retainedStaticMatches) {
        try {
          this.#staticStore.coverCurrent();
        } catch {
          // Preserve the original static installation failure and candidate.
        }
      }
      this.#stageReadyResult(null);
      const failed = this.#graph.failStatic(
        staticFailure.message,
        retainedVisualState === null ? {} : { retainedVisualState }
      );
      const failedForHost = this.#effects.applyFailure(failed);
      if (traceState !== null) {
        this.#trace.recordOperation({
          result: failedForHost,
          playback: traceState,
          readiness: this.#effects.readiness
        });
      }
      // Error readiness is terminal but player disposal remains explicit. The
      // candidate is retained because motion policy still owns animated mode,
      // and an unverified/stale static must never replace its state identity.
      throw new PlaybackFallbackError(staticFailure.message);
    }

    const previousCandidates = this.#getReadyResult()?.report.candidates ?? [];
    const candidates = previousCandidates.map((candidateReport) =>
      candidateReport.outcome === "selected"
        ? createRuntimeCandidateReport({
            rendition: candidateReport.rendition,
            rank: candidateReport.rank,
            outcome: "rejected",
            failure
          })
        : candidateReport
    );
    const ready = Object.freeze({
      mode: "static" as const,
      reason: "animation-failure" as const,
      report: createRuntimeReadinessReport({
        readiness: "staticReady",
        selectedRendition: null,
        candidates
      })
    });
    this.#stageReadyResult(ready);
    const retainedVisualState = this.#effects.visualState;
    const recovered = this.#graph.recoverStatic(
      "animation-failure",
      this.#effects.interruptedBarrierSuperseded && retainedVisualState !== null
        ? { retainedVisualState }
        : {}
    );
    let recoveredForHost: Readonly<ReturnType<EffectHost["applyRecovery"]>>;
    try {
      recoveredForHost = this.#effects.applyRecovery(
        recovered,
        (presentation) => {
          assertIntegratedStaticPresentation(presentation, requested);
          try {
            this.#staticStore.coverCurrent();
          } catch {
            // A visibility host can fail before applying its side effect. One
            // bounded retry handles that transient without replaying graph
            // effects or replacing the already-staged strict surface.
            this.#staticStore.coverCurrent();
          }
        }
      );
    } catch (error) {
      const coverFailure = normalizeRuntimeFailure(
        "renderer-failure",
        error,
        { operation: "animated-recovery-cover" }
      );
      this.#reportFailure(coverFailure);
      this.#stageReadyResult(null);
      const failedVisualState = this.#effects.visualState;
      const failed = this.#graph.failStatic(
        coverFailure.message,
        failedVisualState === null ? {} : {
          retainedVisualState: failedVisualState
        }
      );
      const failedForHost = this.#effects.applyFailure(failed);
      if (traceState !== null) {
        this.#trace.recordOperation({
          result: failedForHost,
          playback: traceState,
          readiness: this.#effects.readiness
        });
      }
      throw new PlaybackFallbackError(coverFailure.message);
    }
    if (traceState !== null) {
      this.#trace.recordOperation({
        result: recoveredForHost,
        playback: traceState,
        readiness: this.#effects.readiness
      });
    }

    // The candidate owns the last usable animated pixels and its presentation
    // backend. Retire it only after the newest strict static has crossed the
    // effect host's draw barrier and is visibly covering that backend.
    if (candidate !== null) {
      await this.#retireCandidate(
        candidate,
        "animated-recovery-cleanup",
        candidateRendition
      );
    }
  }

  async #requestStatic(target: string, signal: AbortSignal): Promise<void> {
    throwIfIntegratedAborted(signal);
    const prePresent = this.#canPrePresent(target);
    let strictStaticCovered = false;
    if (prePresent) {
      try {
        await raceIntegratedAbort(
          this.#staticStore.presentState(target, { signal }),
          signal
        );
        if (this.#staticStore.currentState() !== target) {
          throw new IntegratedPlaybackInvariantError(
            "static request store committed the wrong state"
          );
        }
        // StaticPresentationPlane.present() is an atomic draw-and-cover
        // contract unless cover:false is explicitly requested.
        strictStaticCovered = true;
      } catch (error) {
        if (signal.aborted) throw integratedAbortReason(signal);
        const failure = normalizeRuntimeFailure(
          "renderer-failure",
          error,
          { state: target, operation: "static-request" }
        );
        this.#reportFailure(failure);
        const failed = this.#graph.failStatic(failure.message);
        this.#effects.apply(failed);
        throw new PlaybackFallbackError(failure.message);
      }
    }

    const result = this.#graph.request(target);
    const request = result.requestId === undefined
      ? Promise.resolve()
      : this.#registerRequest(result.requestId);
    void request.catch(() => undefined);

    if (
      result.presentation?.kind === "static" &&
      result.effects.some((effect) =>
        effect.type === "visualstatechange" || effect.type === "transitionend"
      )
    ) {
      const staticState = result.presentation.state;
      if (!prePresent || staticState !== target) {
        throw new IntegratedPlaybackInvariantError(
          "static graph commit was not pre-presented"
        );
      }
      this.#effects.apply(result, (presentation) => {
        assertIntegratedStaticPresentation(presentation, staticState);
        // The strict store already completed its atomic draw-and-cover before
        // graph commit. This callback is the graph's ordering barrier only;
        // re-running a fallible visibility host would create a partial commit.
        strictStaticCovered = true;
      });
    } else {
      this.#effects.apply(result);
    }
    if (strictStaticCovered) {
      await this.#retireCandidateAfterStaticCover();
    }
    return request;
  }

  async #requestLatestStatic(
    target: string,
    generation: number,
    signal: AbortSignal
  ): Promise<void> {
    if (generation !== this.#latestStaticRequestGeneration) return;
    const controller = new AbortController();
    const forwardAbort = (): void => controller.abort(
      integratedAbortReason(signal)
    );
    if (signal.aborted) forwardAbort();
    else signal.addEventListener("abort", forwardAbort, { once: true });
    this.#latestStaticPresentation = controller;
    try {
      await this.#requestStatic(target, controller.signal);
    } catch (error) {
      if (
        generation !== this.#latestStaticRequestGeneration &&
        controller.signal.aborted
      ) return;
      throw error;
    } finally {
      signal.removeEventListener("abort", forwardAbort);
      if (this.#latestStaticPresentation === controller) {
        this.#latestStaticPresentation = null;
      }
    }
  }

  async #retireCandidateAfterStaticCover(): Promise<void> {
    const candidate = this.#getActiveCandidate();
    if (candidate === null) return;
    await this.#retireCandidate(
      candidate,
      "static-request-candidate-cleanup",
      this.#getSelectedRendition()
    );
  }

  async #retireCandidate(
    candidate: IntegratedCandidateAttempt,
    operation: string,
    rendition: string | null
  ): Promise<void> {
    if (this.#getActiveCandidate() !== candidate) return;
    this.#detachActiveCandidate(candidate);
    try {
      await candidate.dispose();
      if (rendition !== null) this.#releaseCandidateResidency(rendition);
    } catch (error) {
      this.#reportFailure(normalizeRuntimeFailure(
        "readiness-failure",
        error,
        { operation }
      ));
    }
  }

  #canPrePresent(target: string): boolean {
    const snapshot = this.#graph.snapshot();
    if (
      snapshot.readiness !== "static" ||
      snapshot.visualState === null ||
      target === snapshot.visualState ||
      snapshot.inputsSinceTick >= GRAPH_LIMITS.maxInputsPerTick
    ) {
      return false;
    }
    const definition = this.#catalog.graph.definition;
    return definition.states.some(({ id }) => id === target) &&
      definition.edges.some(({ from, to }) =>
        from === snapshot.visualState && to === target
      );
  }
}
