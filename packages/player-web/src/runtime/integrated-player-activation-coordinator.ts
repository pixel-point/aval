import {
  sameGraphPresentation,
  type MotionGraphEngine,
  type MotionGraphResult
} from "@pixel-point/aval-graph";

import type { EffectHost } from "./effect-host.js";
import {
  IntegratedPlaybackInvariantError,
  type IntegratedCandidateAttempt
} from "./integrated-player-contracts.js";
import type { IntegratedStateStore } from "./state-store.js";
import type { IntegratedAnimatedActivationCommit } from "./integrated-animated-preparation.js";
import type { IntegratedOperationGate } from "./integrated-operation-gate.js";
import type { IntegratedPlayerMotion } from "./integrated-player-motion.js";
import {
  assertIntegratedStaticPresentation,
  throwIfIntegratedAborted,
  validateIntegratedPlaybackTraceState
} from "./integrated-player-support.js";
import type { IntegratedTraceHarness } from "./integrated-trace-harness.js";
import {
  RuntimePlaybackError,
  normalizeRuntimeFailure,
  type RuntimeFailure
} from "./errors.js";
import {
  createRuntimeCandidateReport,
  createRuntimeReadinessReport,
  type RuntimeReadinessResult
} from "./model.js";
import type { RealtimeDriver } from "./realtime-driver.js";
import { listenForBrowserPlaybackTerminal } from "./browser-playback-terminal-listener.js";

interface IntegratedPlayerActivationState {
  readonly isDisposed: () => boolean;
  readonly getActiveCandidate: () => IntegratedCandidateAttempt | null;
  readonly setActiveCandidate: (
    candidate: IntegratedCandidateAttempt | null
  ) => void;
  readonly getReadyResult: () => Readonly<RuntimeReadinessResult> | null;
  readonly getSelectedRendition: () => string | null;
  readonly setReadyResult: (
    result: Readonly<RuntimeReadinessResult> | null
  ) => void;
  readonly setSelectedRendition: (renditionId: string | null) => void;
}

interface IntegratedPlayerActivationCoordinatorOptions {
  readonly graph: MotionGraphEngine;
  readonly effects: EffectHost;
  readonly stateStore: IntegratedStateStore;
  readonly trace: IntegratedTraceHarness;
  readonly operationGate: IntegratedOperationGate;
  readonly state: Readonly<IntegratedPlayerActivationState>;
  readonly getMotion: () => IntegratedPlayerMotion;
  readonly getRealtime: () => RealtimeDriver | null;
  readonly startRecovery: (
    failure: Readonly<RuntimeFailure>
  ) => RuntimePlaybackError;
  readonly startTerminalPlayback: (
    error: RuntimePlaybackError
  ) => RuntimePlaybackError;
  readonly settleRecovery: () => Promise<void>;
  readonly reportFailure: (failure: Readonly<RuntimeFailure>) => void;
  readonly releaseCandidateResidency: (rendition: string) => void;
}

/**
 * Coordinates activation and motion-mode transactions without owning playback
 * state. The player remains the sole authority for candidate and readiness
 * fields through the explicit state accessors supplied here.
 */
export class IntegratedPlayerActivationCoordinator {
  readonly #graph: MotionGraphEngine;
  readonly #effects: EffectHost;
  readonly #stateStore: IntegratedStateStore;
  readonly #trace: IntegratedTraceHarness;
  readonly #operationGate: IntegratedOperationGate;
  readonly #state: Readonly<IntegratedPlayerActivationState>;
  readonly #getMotion: () => IntegratedPlayerMotion;
  readonly #getRealtime: () => RealtimeDriver | null;
  readonly #startRecovery: (
    failure: Readonly<RuntimeFailure>
  ) => RuntimePlaybackError;
  readonly #startTerminalPlayback: (
    error: RuntimePlaybackError
  ) => RuntimePlaybackError;
  readonly #settleRecovery: () => Promise<void>;
  readonly #reportFailure: (failure: Readonly<RuntimeFailure>) => void;
  readonly #releaseCandidateResidency: (rendition: string) => void;

  public constructor(
    options: Readonly<IntegratedPlayerActivationCoordinatorOptions>
  ) {
    this.#graph = options.graph;
    this.#effects = options.effects;
    this.#stateStore = options.stateStore;
    this.#trace = options.trace;
    this.#operationGate = options.operationGate;
    this.#state = options.state;
    this.#getMotion = options.getMotion;
    this.#getRealtime = options.getRealtime;
    this.#startRecovery = options.startRecovery;
    this.#startTerminalPlayback = options.startTerminalPlayback;
    this.#settleRecovery = options.settleRecovery;
    this.#reportFailure = options.reportFailure;
    this.#releaseCandidateResidency = options.releaseCandidateResidency;
  }

  public commitAnimatedActivation(
    commit: Readonly<IntegratedAnimatedActivationCommit>
  ): Readonly<RuntimeReadinessResult> {
    return this.#operationGate.run(() => {
      throwIfIntegratedAborted(commit.signal);

      // Listener-visible readiness state is staged before graph effects.
      this.#state.setActiveCandidate(commit.attempt);
      this.#state.setSelectedRendition(commit.renditionId);
      this.#state.setReadyResult(commit.result);
      this.#getMotion().stageReadyResult(commit.result);
      this.#listenForPlaybackTerminal(commit.attempt);
      const animated = this.#graph.beginAnimated();
      if (!sameGraphPresentation(
        animated.presentation,
        commit.expectedPresentation
      )) {
        throw new IntegratedPlaybackInvariantError(
          "committed activation diverged from its prepared presentation"
        );
      }
      commit.attempt.playback.synchronizeGraph(animated);
      this.#effects.apply(animated, (presentation) => {
        if (!sameGraphPresentation(
          presentation,
          commit.expectedPresentation
        )) {
          throw new IntegratedPlaybackInvariantError(
            "activation draw diverged from its prepared presentation"
          );
        }
        commit.attempt.drawInitial(commit.activation, presentation);
      });
      throwIfIntegratedAborted(commit.signal);
      this.#recordOperation(animated, commit.attempt);
      return commit.result;
    });
  }

  public commitAnimatedReentry(
    commit: Readonly<IntegratedAnimatedActivationCommit>
  ): Readonly<RuntimeReadinessResult> {
    return this.#operationGate.run(() => {
      throwIfIntegratedAborted(commit.signal);
      this.#state.setActiveCandidate(commit.attempt);
      this.#state.setSelectedRendition(commit.renditionId);
      this.#state.setReadyResult(commit.result);
      this.#listenForPlaybackTerminal(commit.attempt);
      const animated = this.#graph.resumeAnimated();
      if (!sameGraphPresentation(
        animated.presentation,
        commit.expectedPresentation
      )) {
        throw new IntegratedPlaybackInvariantError(
          "re-entry activation diverged from its prepared presentation"
        );
      }
      commit.attempt.playback.synchronizeGraph(animated);
      this.#effects.apply(animated, (presentation) => {
        if (!sameGraphPresentation(
          presentation,
          commit.expectedPresentation
        )) {
          throw new IntegratedPlaybackInvariantError(
            "re-entry draw diverged from its prepared presentation"
          );
        }
        commit.attempt.drawInitial(commit.activation, presentation);
      });
      if (!this.#getMotion().commitReentry()) {
        throw new IntegratedPlaybackInvariantError(
          "animated re-entry motion transition became stale"
        );
      }
      this.#recordOperation(animated, commit.attempt);
      return commit.result;
    });
  }

  public rollbackAnimatedActivation(attempt: IntegratedCandidateAttempt): void {
    // A precommit attempt never made animated pixels authoritative. Rollback
    // only detaches runtime state; alternate presentation is consumer-owned.
    if (this.#state.getActiveCandidate() === attempt) {
      this.#state.setActiveCandidate(null);
      this.#state.setSelectedRendition(null);
      this.#state.setReadyResult(null);
    }
  }

  #listenForPlaybackTerminal(attempt: IntegratedCandidateAttempt): void {
    listenForBrowserPlaybackTerminal(attempt.playback, (error) => {
      this.#operationGate.run(() => {
        if (
          this.#state.isDisposed() ||
          this.#state.getActiveCandidate() !== attempt
        ) return;
        this.#startTerminalPlayback(error);
      });
    });
  }

  public pauseForMotionPolicy(): boolean {
    const realtime = this.#getRealtime();
    const wasRunning = realtime?.snapshot().running ?? false;
    try {
      realtime?.pauseForPolicy();
    } catch (error) {
      // RealtimeDriver clears running/pending ownership before invoking the
      // hostile cancellation host. A cancellation exception therefore cannot
      // unwind the serialized reduction and strand its transition; report it
      // observationally and continue to the logical-state commit barrier.
      this.#reportFailure(normalizeRuntimeFailure(
        "readiness-failure",
        error,
        { operation: "motion-policy-realtime-pause" }
      ));
    }
    return wasRunning;
  }

  public pauseForVisibility(): boolean {
    const realtime = this.#getRealtime();
    const wasRunning = realtime?.snapshot().running ?? false;
    try {
      realtime?.pauseForVisibility();
    } catch (error) {
      this.#reportFailure(normalizeRuntimeFailure(
        "readiness-failure",
        error,
        { operation: "visibility-realtime-pause" }
      ));
    }
    return wasRunning;
  }

  public resumeAfterCancelledReduction(wasRunning: boolean): void {
    if (
      this.#state.isDisposed() ||
      this.#state.getActiveCandidate() === null
    ) return;
    // stageLatest used cover:false and cancellation is checked before the
    // first cover, so animated pixels never stopped being authoritative.
    if (wasRunning) {
      try {
        this.#getRealtime()?.start();
      } catch (error) {
        this.#reportFailure(normalizeRuntimeFailure(
          "readiness-failure",
          error,
          { operation: "cancelled-reduction-realtime-resume" }
        ));
      }
    }
  }

  public resumeRealtimeAfterReentry(wasRunning: boolean): void {
    if (wasRunning && !this.#state.isDisposed()) {
      try {
        this.#getRealtime()?.start();
      } catch (error) {
        // Re-entry is already graph-, candidate-, draw-, and visibility-
        // committed. A hostile RAF host is observational here: report it and
        // leave the coherent animated state paused for an explicit retry.
        this.#reportFailure(normalizeRuntimeFailure(
          "readiness-failure",
          error,
          { operation: "reentry-realtime-resume" }
        ));
      }
    }
  }

  public resumeRealtimeAfterVisibilityReentry(wasRunning: boolean): void {
    if (this.#state.isDisposed()) return;
    try {
      this.#getRealtime()?.resumeAfterVisibility(wasRunning);
    } catch (error) {
      this.#reportFailure(normalizeRuntimeFailure(
        "readiness-failure",
        error,
        { operation: "visibility-reentry-realtime-resume" }
      ));
    }
  }

  public assertReducedState(state: string): void {
    this.#assertStagedState(state, "reduced-motion");
  }

  public assertVisibilityState(state: string): void {
    this.#assertStagedState(state, "visibility");
  }

  public captureContextState(): string {
    return this.#operationGate.run(() => {
      const state = this.#stateStore.currentState();
      if (state === null) {
        throw new RuntimePlaybackError(normalizeRuntimeFailure(
          "context-loss",
          "context loss has no retained logical state",
          { operation: "context-loss-state" }
        ));
      }
      return state;
    });
  }

  #assertStagedState(state: string, operation: string): void {
    this.#operationGate.run(() => {
      const snapshot = this.#graph.snapshot();
      if (snapshot.requestedState !== state) {
        throw new IntegratedPlaybackInvariantError(
          `staged ${operation} surface became stale`
        );
      }
      if (this.#stateStore.currentState() !== state) {
        throw new IntegratedPlaybackInvariantError(
          `staged ${operation} surface has the wrong state identity`
        );
      }
    });
  }

  public async commitVisibilitySuspended(state: string): Promise<void> {
    let rendition: string | null = null;
    const candidate = this.#operationGate.run(() => {
      rendition = this.#state.getSelectedRendition();
      const reports = (
        this.#state.getReadyResult()?.report.candidates ?? []
      ).map((report) => createRuntimeCandidateReport({
        ...report,
        outcome: report.outcome === "selected" ? "eligible" : report.outcome,
        failure: report.outcome === "selected" ? null : report.failure
      }));
      const ready = Object.freeze({
        mode: "static" as const,
        reason: "visibility-suspended" as const,
        report: createRuntimeReadinessReport({
          readiness: "staticReady",
          selectedRendition: null,
          candidates: reports
        })
      });
      const suspended = this.#graph.recoverStatic("visibility-suspended");
      this.#state.setSelectedRendition(null);
      this.#state.setReadyResult(ready);
      this.#getMotion().stageReadyResult(ready);
      this.#effects.applyRecovery(suspended, (presentation) => {
        assertIntegratedStaticPresentation(presentation, state);
      });
      const active = this.#state.getActiveCandidate();
      if (active !== null) {
        this.#recordOperationBestEffort(
          suspended,
          active,
          "visibility-suspension-trace"
        );
        this.#state.setActiveCandidate(null);
      }
      return active;
    });
    await this.#disposeCandidate(
      candidate,
      "visibility-suspension-candidate-cleanup",
      rendition
    );
  }

  public async commitContextSuspended(state: string | null): Promise<void> {
    let rendition: string | null = null;
    const candidate = this.#operationGate.run(() => {
      rendition = this.#state.getSelectedRendition();
      const active = this.#state.getActiveCandidate();
      if (active === null) return null;
      if (state === null) {
        this.#startRecovery(normalizeRuntimeFailure(
          "context-loss",
          "context loss has no usable logical state",
          { operation: "context-static-failure" }
        ));
        // Recovery now owns terminal publication, retained error identity,
        // trace capture, candidate detachment, and asynchronous cleanup.
        return null;
      }
      const reports = (
        this.#state.getReadyResult()?.report.candidates ?? []
      ).map((report) => createRuntimeCandidateReport({
        ...report,
        outcome: report.outcome === "selected" ? "eligible" : report.outcome,
        failure: report.outcome === "selected" ? null : report.failure
      }));
      const ready = Object.freeze({
        mode: "static" as const,
        reason: "visibility-suspended" as const,
        report: createRuntimeReadinessReport({
          readiness: "staticReady",
          selectedRendition: null,
          candidates: reports
        })
      });
      const suspended = this.#graph.recoverStatic(
        "visibility-suspended",
        { retainedVisualState: state }
      );
      this.#state.setSelectedRendition(null);
      this.#state.setReadyResult(ready);
      this.#getMotion().stageContextSuspended();
      this.#effects.applyRecovery(suspended, (presentation) => {
        assertIntegratedStaticPresentation(presentation, state);
      });
      this.#recordOperationBestEffort(
        suspended,
        active,
        "context-suspension-trace"
      );
      this.#state.setActiveCandidate(null);
      return active;
    });
    await this.#disposeCandidate(
      candidate,
      "context-suspension-cleanup",
      rendition
    );
  }

  public async commitReducedState(state: string): Promise<void> {
    let rendition: string | null = null;
    const candidate = this.#operationGate.run(() => {
      rendition = this.#state.getSelectedRendition();
      const reports = (
        this.#state.getReadyResult()?.report.candidates ?? []
      ).map((report) => createRuntimeCandidateReport({
        ...report,
        outcome: report.outcome === "selected" ? "eligible" : report.outcome,
        failure: report.outcome === "selected" ? null : report.failure
      }));
      const ready = Object.freeze({
        mode: "static" as const,
        reason: "reduced-motion" as const,
        report: createRuntimeReadinessReport({
          readiness: "staticReady",
          selectedRendition: null,
          candidates: reports
        })
      });
      const reduced = this.#graph.recoverStatic("reduced-motion");
      this.#state.setSelectedRendition(null);
      this.#state.setReadyResult(ready);
      this.#getMotion().stageReadyResult(ready);
      this.#effects.applyRecovery(reduced, (presentation) => {
        assertIntegratedStaticPresentation(presentation, state);
        // The logical state was validated before the mode commit. This
        // callback orders graph effects without owning presentation UI.
      });
      const active = this.#state.getActiveCandidate();
      if (active !== null) {
        this.#recordOperationBestEffort(
          reduced,
          active,
          "reduced-motion-trace"
        );
        this.#state.setActiveCandidate(null);
      }
      return active;
    });
    await this.#disposeCandidate(
      candidate,
      "reduced-motion-candidate-cleanup",
      rendition
    );
  }

  public async failReduction(error: unknown): Promise<never> {
    const terminal = this.#startRecovery(normalizeRuntimeFailure(
      "renderer-failure",
      error,
      { operation: "reduced-motion-state-transition" }
    ));
    try {
      await this.#settleRecovery();
    } catch (settledError) {
      if (settledError === terminal) throw terminal;
      throw settledError;
    }
    throw terminal;
  }

  public rejectAnimatedReentry(
    _error: unknown,
    result: Readonly<RuntimeReadinessResult> | null
  ): void {
    // The visible surface remains intact, while readiness records the failed
    // attempt and its deterministic candidate reports.
    this.#state.setSelectedRendition(null);
    if (result?.mode === "static") this.#state.setReadyResult(result);
  }

  public async recoverAnimatedActivation(
    failure: Readonly<RuntimeFailure>
  ): Promise<never> {
    const terminal = this.#startRecovery(failure);
    try {
      await this.#settleRecovery();
    } catch (error) {
      if (error === terminal) throw terminal;
      throw error;
    }
    throw terminal;
  }

  #recordOperation(
    result: Readonly<MotionGraphResult>,
    candidate: IntegratedCandidateAttempt
  ): void {
    const traceState = candidate.playback.traceState();
    validateIntegratedPlaybackTraceState(traceState);
    this.#trace.recordOperation({
      result,
      playback: traceState,
      readiness: this.#effects.readiness
    });
  }

  #recordOperationBestEffort(
    result: Readonly<MotionGraphResult>,
    candidate: IntegratedCandidateAttempt,
    operation: string
  ): void {
    try {
      this.#recordOperation(result, candidate);
    } catch (error) {
      this.#reportFailure(normalizeRuntimeFailure(
        "readiness-failure",
        error,
        { operation }
      ));
    }
  }

  async #disposeCandidate(
    candidate: IntegratedCandidateAttempt | null,
    operation: string,
    rendition: string | null
  ): Promise<void> {
    if (candidate === null) return;
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
}
