import {
  PlaybackFallbackError,
  type IntegratedPrepareOptions
} from "./integrated-player-contracts.js";
import {
  DEFAULT_INTEGRATED_PREPARATION_TIMEOUT_MS,
  integratedAbortReason,
  integratedDisposedError,
  isIntegratedAbortError,
  validatePreparationTimeout
} from "./integrated-player-support.js";
import {
  IntegratedStaticPreparation,
  type IntegratedPreparationControl
} from "./integrated-player-static-preparation.js";
import type { RuntimeReadinessResult } from "./model.js";
import {
  MotionPolicyCoordinator,
  type MotionPolicy,
  type MotionPolicyTransition,
  type MotionPolicyTransitionKind,
  type MotionPolicySnapshot
} from "./motion-policy.js";

interface IntegratedPlayerMotionOptions {
  readonly policy: MotionPolicy;
  readonly hostReducedMotion: boolean;
  readonly staticPreparation: IntegratedStaticPreparation;
  readonly isDisposed: () => boolean;
  readonly invalidateInitialPreparation: () => void;
  readonly pauseForPolicy: () => boolean;
  readonly resumeAfterCancelledReduction: (wasRunning: boolean) => void;
  readonly resumeAfterReentry: (wasRunning: boolean) => void;
  readonly resumeAfterVisibilityReentry: (wasRunning: boolean) => void;
  readonly coverReducedSurface: (state: string) => void;
  readonly commitReducedState: (state: string) => Promise<void>;
  readonly commitResourcePressureState: (state: string) => Promise<void>;
  readonly failReduction: (error: unknown) => Promise<void>;
  readonly prepareFull: (
    signal: AbortSignal
  ) => Promise<Readonly<RuntimeReadinessResult> | null>;
  readonly rejectReentry: (
    error: unknown,
    result: Readonly<RuntimeReadinessResult> | null
  ) => void;
  readonly reportTransitionFailure: (
    error: unknown,
    transition: MotionPolicyTransitionKind
  ) => void;
}

/** Player integration for initial motion policy and later transition ownership. */
export class IntegratedPlayerMotion {
  readonly #coordinator: MotionPolicyCoordinator;
  readonly #staticPreparation: IntegratedStaticPreparation;
  readonly #isDisposed: () => boolean;
  readonly #invalidateInitialPreparation: () => void;
  readonly #pauseForPolicy: () => boolean;
  readonly #resumeAfterCancelledReduction: (wasRunning: boolean) => void;
  readonly #resumeAfterReentry: (wasRunning: boolean) => void;
  readonly #resumeAfterVisibilityReentry: (wasRunning: boolean) => void;
  readonly #coverReducedSurface: (state: string) => void;
  readonly #commitReducedState: (state: string) => Promise<void>;
  readonly #commitResourcePressureState: (state: string) => Promise<void>;
  readonly #failReduction: (error: unknown) => Promise<void>;
  readonly #prepareFull: IntegratedPlayerMotionOptions["prepareFull"];
  readonly #rejectReentry: IntegratedPlayerMotionOptions["rejectReentry"];
  readonly #reportTransitionFailure: IntegratedPlayerMotionOptions[
    "reportTransitionFailure"
  ];
  #control: IntegratedPreparationControl | null = null;
  #tail: Promise<void> = Promise.resolve();
  #activeReentry: Readonly<MotionPolicyTransition> | null = null;
  #resumeRealtimeOnReentry = false;
  #transitionsEnabled: boolean;

  public constructor(options: Readonly<IntegratedPlayerMotionOptions>) {
    this.#coordinator = new MotionPolicyCoordinator({
      policy: options.policy,
      hostReducedMotion: options.hostReducedMotion
    });
    this.#staticPreparation = options.staticPreparation;
    this.#isDisposed = options.isDisposed;
    this.#invalidateInitialPreparation =
      options.invalidateInitialPreparation;
    this.#pauseForPolicy = options.pauseForPolicy;
    this.#resumeAfterCancelledReduction =
      options.resumeAfterCancelledReduction;
    this.#resumeAfterReentry = options.resumeAfterReentry;
    this.#resumeAfterVisibilityReentry =
      options.resumeAfterVisibilityReentry;
    this.#coverReducedSurface = options.coverReducedSurface;
    this.#commitReducedState = options.commitReducedState;
    this.#commitResourcePressureState = options.commitResourcePressureState;
    this.#failReduction = options.failReduction;
    this.#prepareFull = options.prepareFull;
    this.#rejectReentry = options.rejectReentry;
    this.#reportTransitionFailure = options.reportTransitionFailure;
    this.#transitionsEnabled = true;
  }

  public snapshot(): Readonly<MotionPolicySnapshot> {
    return this.#coordinator.snapshot();
  }

  public shouldPrepareReduced(): boolean {
    const snapshot = this.#coordinator.snapshot();
    return snapshot.actualMode === "unprepared" &&
      snapshot.desiredMode === "reduce";
  }

  public stageReadyResult(result: Readonly<RuntimeReadinessResult>): void {
    const actual = this.#coordinator.snapshot().actualMode;
    if (actual === "unprepared") {
      if (result.mode === "animated") this.#coordinator.installAnimated();
      else this.#coordinator.installStatic(result.reason);
      if (
        result.mode === "animated" ||
        result.reason === "reduced-motion"
      ) {
        void this.#scheduleTransitions().catch((error: unknown) => {
          this.#reportTransitionFailure(error, result.mode === "animated"
            ? "enter-reduced"
            : "enter-full");
        });
      }
      return;
    }
    if (result.mode === "static") {
      if (result.reason === "reduced-motion") {
        if (actual === "static") return;
        throw new RangeError(
          "reduced-motion commit requires an owned policy transition"
        );
      }
      const snapshot = this.#coordinator.snapshot();
      if (
        snapshot.actualMode === "static" &&
        snapshot.staticOrigin === result.reason
      ) return;
      this.#coordinator.failToStatic(result.reason);
    }
  }

  public setPolicy(policy: MotionPolicy): Promise<Readonly<MotionPolicySnapshot>> {
    const before = this.#coordinator.snapshot();
    this.#coordinator.setPolicy(policy);
    this.#invalidateContradictedInitialPreparation(before);
    return this.#scheduleTransitions();
  }

  public setHostReducedMotion(
    reduced: boolean
  ): Promise<Readonly<MotionPolicySnapshot>> {
    const before = this.#coordinator.snapshot();
    this.#coordinator.setHostReducedMotion(reduced);
    this.#invalidateContradictedInitialPreparation(before);
    return this.#scheduleTransitions();
  }

  /** Called by the player's hidden activation commit after body frame zero. */
  public commitReentry(): boolean {
    const transition = this.#activeReentry;
    return transition !== null && this.#coordinator.commitAnimated(transition);
  }

  public async settled(): Promise<void> {
    await this.#tail;
  }

  public abort(): void {
    const control = this.#control;
    if (control !== null && !control.controller.signal.aborted) {
      control.controller.abort(new DOMException(
        "motion preparation aborted",
        "AbortError"
      ));
    }
  }

  /** Visibility owns transition invalidation until its strict cover retires. */
  public suspendForVisibility(wasRunning: boolean): void {
    this.#transitionsEnabled = false;
    this.#resumeRealtimeOnReentry = wasRunning;
    this.abort();
    this.#coordinator.cancelTransition();
  }

  /** Re-enables policy work and performs any transient body-zero re-entry. */
  public resumeAfterVisibility(): Promise<Readonly<MotionPolicySnapshot>> {
    this.#transitionsEnabled = true;
    return this.#scheduleTransitions();
  }

  /** A retained FIFO decoder ticket became grantable for transient static. */
  public retryTransientStatic(): Promise<Readonly<MotionPolicySnapshot>> {
    return this.#scheduleTransitions();
  }

  /** Strict-static pressure fallback without mutating the host motion policy. */
  public reclaimForResourcePressure(): Promise<boolean> {
    const operation = this.#tail.then(() => this.#enterResourcePressure());
    this.#tail = operation.then(
      () => undefined,
      () => undefined
    );
    return operation;
  }

  public stageContextSuspended(): void {
    const actual = this.#coordinator.snapshot().actualMode;
    if (actual === "unprepared") this.#coordinator.installStatic("context-loss");
    else if (actual !== "disposed") this.#coordinator.failToStatic("context-loss");
  }

  public failContextRecovery(): void {
    this.#transitionsEnabled = false;
    this.abort();
    const actual = this.#coordinator.snapshot().actualMode;
    if (actual !== "unprepared" && actual !== "disposed") {
      this.#coordinator.failToStatic("animation-failure");
    }
  }

  public async prepareReduced(
    options: IntegratedPrepareOptions
  ): Promise<Readonly<RuntimeReadinessResult>> {
    if (!this.shouldPrepareReduced()) {
      throw new RangeError(
        "reduced preparation requires unprepared reduced motion mode"
      );
    }
    const timeoutMs = validatePreparationTimeout(
      options.timeoutMs ?? DEFAULT_INTEGRATED_PREPARATION_TIMEOUT_MS
    );
    const control = this.#staticPreparation.createControl(
      options.signal,
      timeoutMs
    );
    if (this.#control !== null) {
      this.#staticPreparation.releaseControl(control);
      throw new RangeError("reduced preparation already owns a control");
    }
    this.#control = control;
    try {
      await this.#staticPreparation.ensure(control.controller.signal);
      return await this.#staticPreparation.finish(
        "reduced-motion",
        [],
        control.controller.signal
      );
    } catch (error) {
      if (this.#isDisposed()) throw integratedDisposedError();
      if (control.externalSignal?.aborted === true) {
        throw integratedAbortReason(control.externalSignal);
      }
      if (control.timedOut) {
        if (this.#staticPreparation.staticReady) {
          return await this.#staticPreparation.finishBounded(
            "preparation-timeout",
            [],
            timeoutMs
          );
        }
        this.#staticPreparation.fail(
          "static readiness did not complete before timeout"
        );
        throw new PlaybackFallbackError(
          "static readiness did not complete before preparation timeout"
        );
      }
      if (isIntegratedAbortError(error)) throw error;
      if (!this.#staticPreparation.staticReady) {
        this.#staticPreparation.fail("static readiness failed");
        throw new PlaybackFallbackError("static readiness failed");
      }
      return await this.#staticPreparation.finishBounded(
        "readiness-failed",
        [],
        timeoutMs
      );
    } finally {
      this.#staticPreparation.releaseControl(control);
      if (this.#control === control) this.#control = null;
    }
  }

  /**
   * Cancels motion ownership and returns the already-scheduled operation tail.
   * Callers must abort any async media producer before awaiting this promise.
   */
  public dispose(): Promise<void> {
    this.abort();
    this.#coordinator.dispose();
    return this.#tail;
  }

  #invalidateContradictedInitialPreparation(
    before: Readonly<MotionPolicySnapshot>
  ): void {
    const after = this.#coordinator.snapshot();
    if (
      before.actualMode !== "unprepared" ||
      after.actualMode !== "unprepared" ||
      before.desiredMode === after.desiredMode
    ) {
      return;
    }
    const control = this.#control;
    if (control !== null && !control.controller.signal.aborted) {
      control.controller.abort(new DOMException(
        "initial motion preparation was superseded",
        "AbortError"
      ));
    }
    this.#invalidateInitialPreparation();
  }

  #scheduleTransitions(): Promise<Readonly<MotionPolicySnapshot>> {
    const operation = this.#tail.then(() => this.#drainTransitions());
    this.#tail = operation.catch(() => undefined);
    return operation.then(() => this.#coordinator.snapshot());
  }

  async #drainTransitions(): Promise<void> {
    while (!this.#isDisposed()) {
      if (!this.#transitionsEnabled) return;
      const transition = this.#coordinator.nextTransition();
      if (transition === null) return;
      if (transition.kind === "enter-reduced") {
        await this.#enterReduced(transition);
      } else {
        await this.#enterFull(transition);
      }
    }
  }

  async #enterReduced(
    transition: Readonly<MotionPolicyTransition>
  ): Promise<void> {
    const wasRunning = this.#pauseForPolicy();
    try {
      const state = await this.#staticPreparation.stageLatest(
        transition.signal
      );
      if (transition.signal.aborted) {
        this.#resumeAfterCancelledReduction(wasRunning);
        return;
      }
      this.#coverReducedSurface(state);
      if (!this.#coordinator.commitStatic(transition)) {
        this.#resumeAfterCancelledReduction(wasRunning);
        return;
      }
      this.#resumeRealtimeOnReentry = wasRunning;
      await this.#commitReducedState(state);
    } catch (error) {
      if (transition.signal.aborted || isIntegratedAbortError(error)) {
        this.#resumeAfterCancelledReduction(wasRunning);
        return;
      }
      this.#reportTransitionFailure(error, transition.kind);
      this.#resumeRealtimeOnReentry = false;
      try {
        await this.#failReduction(error);
      } finally {
        this.#coordinator.failToStatic("png-failure");
      }
    }
  }

  async #enterResourcePressure(): Promise<boolean> {
    if (this.#isDisposed()) return false;
    const snapshot = this.#coordinator.snapshot();
    if (snapshot.actualMode === "static") return true;
    if (snapshot.actualMode !== "animated") return false;
    this.abort();
    this.#coordinator.cancelTransition();
    const wasRunning = this.#pauseForPolicy();
    let covered = false;
    try {
      const state = await this.#staticPreparation.stageLatest(
        new AbortController().signal
      );
      if (this.#isDisposed()) return false;
      this.#coverReducedSurface(state);
      covered = true;
      this.#coordinator.failToStatic("resource-budget");
      await this.#commitResourcePressureState(state);
      return true;
    } catch (error) {
      if (!covered) this.#resumeAfterCancelledReduction(wasRunning);
      throw error;
    }
  }

  async #enterFull(
    transition: Readonly<MotionPolicyTransition>
  ): Promise<void> {
    const staticOrigin = this.#coordinator.snapshot().staticOrigin;
    const visibilityReentry = staticOrigin === "visibility-suspended" ||
      staticOrigin === "context-loss";
    this.#activeReentry = transition;
    try {
      const result = await this.#prepareFull(transition.signal);
      if (transition.signal.aborted) return;
      if (
        result?.mode === "animated" &&
        this.#coordinator.snapshot().actualMode === "animated"
      ) {
        if (visibilityReentry) {
          this.#resumeAfterVisibilityReentry(this.#resumeRealtimeOnReentry);
        } else {
          this.#resumeAfterReentry(this.#resumeRealtimeOnReentry);
        }
        this.#resumeRealtimeOnReentry = false;
        return;
      }
      const failure = new PlaybackFallbackError(
        "animated re-entry exhausted every candidate"
      );
      const reason = result?.mode === "static" && result.reason !== "reduced-motion"
        ? result.reason
        : "readiness-failed";
      this.#coordinator.failToStatic(reason);
      this.#resumeRealtimeOnReentry = false;
      this.#rejectReentry(failure, result);
      this.#reportTransitionFailure(failure, transition.kind);
    } catch (error) {
      if (transition.signal.aborted || isIntegratedAbortError(error)) return;
      this.#coordinator.failToStatic("readiness-failed");
      this.#resumeRealtimeOnReentry = false;
      this.#rejectReentry(error, null);
      this.#reportTransitionFailure(error, transition.kind);
    } finally {
      if (this.#activeReentry === transition) this.#activeReentry = null;
    }
  }
}
