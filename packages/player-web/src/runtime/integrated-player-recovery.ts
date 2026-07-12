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
  readonly registerRequest: (requestId: number) => Promise<void>;
  readonly stageReadyResult: (
    result: Readonly<RuntimeReadinessResult> | null
  ) => void;
  readonly reportFailure: (failure: Readonly<RuntimeFailure>) => void;
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
  readonly #registerRequest: (requestId: number) => Promise<void>;
  readonly #stageReadyResult: (
    result: Readonly<RuntimeReadinessResult> | null
  ) => void;
  readonly #reportFailure: (failure: Readonly<RuntimeFailure>) => void;
  readonly #operations = new StaticOperationQueue();

  #recovery: Promise<void> | null = null;
  #recoveryPresentation: {
    readonly state: string;
    readonly controller: AbortController;
  } | null = null;

  public constructor(options: Readonly<IntegratedRecoveryCoordinatorOptions>) {
    this.#catalog = options.catalog;
    this.#graph = options.graph;
    this.#effects = options.effects;
    this.#staticStore = options.staticStore;
    this.#trace = options.trace;
    this.#getActiveCandidate = options.getActiveCandidate;
    this.#detachActiveCandidate = options.detachActiveCandidate;
    this.#getReadyResult = options.getReadyResult;
    this.#registerRequest = options.registerRequest;
    this.#stageReadyResult = options.stageReadyResult;
    this.#reportFailure = options.reportFailure;
  }

  public get active(): boolean {
    return this.#recovery !== null;
  }

  public get promise(): Promise<void> | null {
    return this.#recovery;
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
      this.#detachActiveCandidate(candidate);
      try {
        await candidate.dispose();
      } catch (error) {
        this.#reportFailure(normalizeRuntimeFailure(
          "readiness-failure",
          error,
          { operation: "animated-recovery-cleanup" }
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
              signal: controller.signal
            }),
            controller.signal
          );
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
      try {
        this.#staticStore.coverCurrent();
      } catch {
        // Preserve the original static installation failure.
      }
      this.#stageReadyResult(null);
      const retainedVisualState = this.#effects.visualState;
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
    const recoveredForHost = this.#effects.applyRecovery(
      recovered,
      (presentation) => {
        assertIntegratedStaticPresentation(presentation, requested);
        this.#staticStore.coverCurrent();
      }
    );
    if (traceState !== null) {
      this.#trace.recordOperation({
        result: recoveredForHost,
        playback: traceState,
        readiness: this.#effects.readiness
      });
    }
  }

  async #requestStatic(target: string, signal: AbortSignal): Promise<void> {
    throwIfIntegratedAborted(signal);
    const prePresent = this.#canPrePresent(target);
    if (prePresent) {
      try {
        await raceIntegratedAbort(
          this.#staticStore.presentState(target, { signal }),
          signal
        );
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
        this.#staticStore.coverCurrent();
      });
    } else {
      this.#effects.apply(result);
    }
    return request;
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
