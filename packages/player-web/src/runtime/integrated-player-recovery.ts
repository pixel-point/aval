import {
  GRAPH_LIMITS,
  MotionGraphEngine
} from "@pixel-point/aval-graph";

import type { RuntimeAssetCatalog } from "./asset-catalog.js";
import type { EffectHost } from "./effect-host.js";
import {
  IntegratedPlaybackInvariantError,
  type IntegratedCandidateAttempt,
  type IntegratedPlaybackTraceState
} from "./integrated-player-contracts.js";
import type { IntegratedStateStore } from "./state-store.js";
import {
  assertIntegratedStaticPresentation,
  integratedAbortReason,
  raceIntegratedAbort,
  throwIfIntegratedAborted,
  validateIntegratedPlaybackTraceState
} from "./integrated-player-support.js";
import type { IntegratedTraceHarness } from "./integrated-trace-harness.js";
import {
  RuntimePlaybackError,
  normalizeRuntimeFailure,
  type RuntimeFailure
} from "./errors.js";
import type { RuntimeReadinessResult } from "./model.js";
import { StaticOperationQueue } from "./static-operation-queue.js";

interface IntegratedRecoveryCoordinatorOptions {
  readonly catalog: RuntimeAssetCatalog;
  readonly graph: MotionGraphEngine;
  readonly effects: EffectHost;
  readonly stateStore: IntegratedStateStore;
  readonly trace: IntegratedTraceHarness;
  readonly getActiveCandidate: () => IntegratedCandidateAttempt | null;
  readonly detachActiveCandidate: (
    candidate: IntegratedCandidateAttempt
  ) => void;
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
  readonly #stateStore: IntegratedStateStore;
  readonly #trace: IntegratedTraceHarness;
  readonly #getActiveCandidate: () => IntegratedCandidateAttempt | null;
  readonly #detachActiveCandidate: (
    candidate: IntegratedCandidateAttempt
  ) => void;
  readonly #getSelectedRendition: () => string | null;
  readonly #registerRequest: (requestId: number) => Promise<void>;
  readonly #stageReadyResult: (
    result: Readonly<RuntimeReadinessResult> | null
  ) => void;
  readonly #reportFailure: (failure: Readonly<RuntimeFailure>) => void;
  readonly #releaseCandidateResidency: (rendition: string) => void;
  readonly #operations = new StaticOperationQueue();

  #recovery: Promise<void> | null = null;
  #terminalError: RuntimePlaybackError | null = null;
  #latestStaticRequestGeneration = 0;
  #latestStaticPresentation: AbortController | null = null;

  public constructor(options: Readonly<IntegratedRecoveryCoordinatorOptions>) {
    this.#catalog = options.catalog;
    this.#graph = options.graph;
    this.#effects = options.effects;
    this.#stateStore = options.stateStore;
    this.#trace = options.trace;
    this.#getActiveCandidate = options.getActiveCandidate;
    this.#detachActiveCandidate = options.detachActiveCandidate;
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

  public get terminalError(): RuntimePlaybackError | null {
    return this.#terminalError;
  }

  public start(failure: Readonly<RuntimeFailure>): RuntimePlaybackError {
    if (this.#terminalError !== null) return this.#terminalError;
    return this.startTerminal(new RuntimePlaybackError(failure));
  }

  /** Retains an already-canonical terminal without reconstructing its error. */
  public startTerminal(error: RuntimePlaybackError): RuntimePlaybackError {
    if (this.#terminalError !== null) return this.#terminalError;
    if (!(error instanceof RuntimePlaybackError)) {
      throw new TypeError("terminal playback error must be RuntimePlaybackError");
    }
    this.#terminalError = error;
    const recovery = this.#recover(error);
    this.#recovery = recovery;
    // Keep the original rejection observable through promise/settled while
    // report-only call sites cannot create a process-level unhandled rejection.
    void recovery.catch(() => undefined);
    return error;
  }

  public requestStaticState(target: string): Promise<void> {
    if (this.#terminalError !== null) return Promise.reject(this.#terminalError);
    return this.#operations.enqueue(({ signal }) =>
      this.#requestStatic(target, signal)
    );
  }

  /** Hidden-time requests coalesce before spending decode/presentation work. */
  public requestLatestStaticState(target: string): Promise<void> {
    if (this.#terminalError !== null) return Promise.reject(this.#terminalError);
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

  /** Terminal recovery has no alternate presentation to supersede. */
  public supersedeRecoveryPresentation(_requestedState: string | null): void {
    // Retained for the serialized intent seam; terminal requests reject above.
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

  #recover(error: RuntimePlaybackError): Promise<void> {
    const failure = error.failure;
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
    const retainedVisualState = this.#effects.visualState;
    this.#stageReadyResult(null);
    const failed = this.#graph.failPlayback(
      failure.message,
      retainedVisualState === null ? {} : { retainedVisualState }
    );
    let failedForHost: Readonly<ReturnType<EffectHost["applyFailure"]>>;
    try {
      failedForHost = this.#effects.applyFailure(failed, error);
    } catch (terminalizationError) {
      this.#reportFailure(normalizeRuntimeFailure(
        "readiness-failure",
        terminalizationError,
        { operation: "playback-failure-publication" }
      ));
      failedForHost = failed;
    }
    if (traceState !== null) {
      this.#trace.recordOperation({
        result: failedForHost,
        playback: traceState,
        readiness: this.#effects.readiness
      });
    }
    return this.#operations.enqueue(async () => {
      if (candidate !== null) {
        await this.#retireCandidate(
          candidate,
          "terminal-playback-cleanup",
          candidateRendition
        );
      }
      throw error;
    });
  }

  async #requestStatic(target: string, signal: AbortSignal): Promise<void> {
    throwIfIntegratedAborted(signal);
    const preStage = this.#canPreStage(target);
    let stateStaged = false;
    if (preStage) {
      try {
        await raceIntegratedAbort(
          this.#stateStore.presentState(target, { signal }),
          signal
        );
        if (this.#stateStore.currentState() !== target) {
          throw new IntegratedPlaybackInvariantError(
            "static request store committed the wrong state"
          );
        }
        stateStaged = true;
      } catch (error) {
        if (signal.aborted) throw integratedAbortReason(signal);
        const failure = normalizeRuntimeFailure(
          "renderer-failure",
          error,
          { state: target, operation: "static-request" }
        );
        throw this.start(failure);
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
      if (!preStage || staticState !== target) {
        throw new IntegratedPlaybackInvariantError(
          "static graph commit was not pre-presented"
        );
      }
      this.#effects.apply(result, (presentation) => {
        assertIntegratedStaticPresentation(presentation, staticState);
        // The logical state was staged before graph commit. This callback is
        // the graph's ordering barrier only and owns no presentation UI.
        stateStaged = true;
      });
    } else {
      this.#effects.apply(result);
    }
    if (stateStaged) {
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

  #canPreStage(target: string): boolean {
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
