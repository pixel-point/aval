import type { IntegratedPrepareOptions } from "./integrated-player-contracts.js";
import type { RuntimePlaybackError } from "./errors.js";
import type { IntegratedPlayerMotion } from "./integrated-player-motion.js";
import {
  DEFAULT_INTEGRATED_PREPARATION_TIMEOUT_MS,
  integratedAbortReason,
  integratedReadinessError,
  integratedDisposedError,
  isIntegratedAbortError,
  validatePreparationTimeout
} from "./integrated-player-support.js";
import {
  IntegratedStaticPreparation,
  type IntegratedPreparationControl
} from "./integrated-player-static-preparation.js";
import type {
  RuntimeReadinessResult,
  RuntimeVisibilitySnapshot,
  RuntimeVisibilityState
} from "./model.js";
import {
  VisibilityPolicyCoordinator,
  type VisibilityPolicyTransition
} from "./visibility-policy.js";

interface IntegratedPlayerVisibilityOptions {
  readonly initialVisibility: RuntimeVisibilityState;
  readonly staticPreparation: IntegratedStaticPreparation;
  readonly motion: IntegratedPlayerMotion;
  readonly isDisposed: () => boolean;
  readonly isPrepared: () => boolean;
  readonly getPresentationOrdinal: () => bigint;
  readonly invalidateInitialPreparation: () => void;
  readonly abortAnimatedPreparation: () => void;
  readonly pauseForVisibility: () => boolean;
  readonly resumeCancelledVisibility: (wasRunning: boolean) => void;
  readonly assertVisibilityState: (state: string) => void;
  readonly commitVisibilitySuspended: (state: string) => Promise<void>;
  readonly reportFailure: (
    error: unknown,
    operation: string
  ) => RuntimePlaybackError;
  readonly canResumeAnimated: () => boolean;
}

/** Serializes host-set visibility with preparation and motion ownership. */
export class IntegratedPlayerVisibility {
  readonly #policy: VisibilityPolicyCoordinator;
  readonly #staticPreparation: IntegratedStaticPreparation;
  readonly #motion: IntegratedPlayerMotion;
  readonly #isDisposed: () => boolean;
  readonly #isPrepared: () => boolean;
  readonly #getPresentationOrdinal: () => bigint;
  readonly #invalidateInitialPreparation: () => void;
  readonly #abortAnimatedPreparation: () => void;
  readonly #pauseForVisibility: () => boolean;
  readonly #resumeCancelledVisibility: (wasRunning: boolean) => void;
  readonly #assertVisibilityState: (state: string) => void;
  readonly #commitVisibilitySuspended: (state: string) => Promise<void>;
  readonly #reportFailure: IntegratedPlayerVisibilityOptions["reportFailure"];
  readonly #canResumeAnimated: () => boolean;

  #control: IntegratedPreparationControl | null = null;
  #tail: Promise<void> = Promise.resolve();
  #wasRunning = false;

  public constructor(options: Readonly<IntegratedPlayerVisibilityOptions>) {
    this.#policy = new VisibilityPolicyCoordinator({
      initialVisibility: options.initialVisibility
    });
    this.#staticPreparation = options.staticPreparation;
    this.#motion = options.motion;
    this.#isDisposed = options.isDisposed;
    this.#isPrepared = options.isPrepared;
    this.#getPresentationOrdinal = options.getPresentationOrdinal;
    this.#invalidateInitialPreparation = options.invalidateInitialPreparation;
    this.#abortAnimatedPreparation = options.abortAnimatedPreparation;
    this.#pauseForVisibility = options.pauseForVisibility;
    this.#resumeCancelledVisibility = options.resumeCancelledVisibility;
    this.#assertVisibilityState = options.assertVisibilityState;
    this.#commitVisibilitySuspended = options.commitVisibilitySuspended;
    this.#reportFailure = options.reportFailure;
    this.#canResumeAnimated = options.canResumeAnimated;
    if (options.initialVisibility === "hidden") {
      this.#motion.suspendForVisibility(false);
    }
  }

  public snapshot(): Readonly<RuntimeVisibilitySnapshot> {
    return this.#policy.snapshot();
  }

  public shouldPrepareHidden(): boolean {
    return this.#policy.snapshot().visibility === "hidden" &&
      this.#motion.snapshot().actualMode === "unprepared";
  }

  public setVisibility(
    visibility: RuntimeVisibilityState
  ): Promise<Readonly<RuntimeVisibilitySnapshot>> {
    if (this.#isDisposed()) return Promise.reject(integratedDisposedError());
    const before = this.#policy.snapshot();
    const after = this.#policy.setVisibility(visibility);
    if (after.generation === before.generation) {
      return Promise.resolve(after);
    }

    this.#abortInitialControl();
    if (after.visibility === "hidden") {
      if (before.suspension === "active") {
        this.#wasRunning = this.#pauseForVisibility();
      }
      this.#motion.suspendForVisibility(this.#wasRunning);
      this.#abortAnimatedPreparation();
      this.#invalidateInitialPreparation();
    } else if (
      before.suspension === "suspending" &&
      after.suspension === "active"
    ) {
      this.#motion.resumeAfterVisibility().catch((error: unknown) => {
        this.#reportFailure(error, "visibility-cancelled-motion-resume");
      });
      this.#resumeCancelledVisibility(this.#wasRunning);
      this.#wasRunning = false;
    } else if (!this.#isPrepared()) {
      this.#abortAnimatedPreparation();
      this.#invalidateInitialPreparation();
      void this.#motion.resumeAfterVisibility().catch((error: unknown) => {
        this.#reportFailure(error, "visibility-initial-motion-resume");
      });
    }
    return this.#schedule().then(() => this.#policy.snapshot());
  }

  public async prepareHidden(
    options: IntegratedPrepareOptions
  ): Promise<Readonly<RuntimeReadinessResult>> {
    if (!this.shouldPrepareHidden()) {
      throw new RangeError(
        "hidden preparation requires unprepared hidden visibility"
      );
    }
    return this.#prepareTransientStatic(options, true);
  }

  public prepareContextStatic(
    options: IntegratedPrepareOptions
  ): Promise<Readonly<RuntimeReadinessResult>> {
    if (this.#motion.snapshot().actualMode !== "unprepared") {
      throw new RangeError(
        "context static preparation requires unprepared motion mode"
      );
    }
    return this.#prepareTransientStatic(options, false);
  }

  async #prepareTransientStatic(
    options: IntegratedPrepareOptions,
    commitVisibility: boolean
  ): Promise<Readonly<RuntimeReadinessResult>> {
    const timeoutMs = validatePreparationTimeout(
      options.timeoutMs ?? DEFAULT_INTEGRATED_PREPARATION_TIMEOUT_MS
    );
    const control = this.#staticPreparation.createControl(
      options.signal,
      timeoutMs
    );
    if (this.#control !== null) {
      this.#staticPreparation.releaseControl(control);
      throw new RangeError("hidden preparation already owns a control");
    }
    this.#control = control;
    const commitBeforeReady = commitVisibility
      ? () => this.#commitPreparedSuspension()
      : undefined;
    try {
      await this.#staticPreparation.ensure(control.controller.signal);
      const result = await this.#staticPreparation.finish(
        "visibility-suspended",
        [],
        control.controller.signal,
        commitBeforeReady
      );
      return result;
    } catch (error) {
      if (this.#isDisposed()) throw integratedDisposedError();
      if (control.externalSignal?.aborted === true) {
        throw integratedAbortReason(control.externalSignal);
      }
      if (control.timedOut) {
        const terminal = integratedReadinessError(
          "hidden static readiness did not complete before timeout",
          "hidden-static-readiness-timeout"
        );
        throw this.#staticPreparation.fail(terminal);
      }
      if (isIntegratedAbortError(error)) throw error;
      const terminal = integratedReadinessError(
        error,
        "hidden-static-readiness"
      );
      throw this.#staticPreparation.fail(terminal);
    } finally {
      this.#staticPreparation.releaseControl(control);
      if (this.#control === control) this.#control = null;
    }
  }

  public supersedePresentation(requestedState: string | null): void {
    if (this.#policy.snapshot().suspension !== "active") {
      this.#staticPreparation.supersedePresentation(requestedState);
    }
  }

  public async settled(): Promise<void> {
    await this.#tail;
  }

  public serializeContext<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation);
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }

  public dispose(): Promise<void> {
    this.#abortInitialControl();
    this.#policy.dispose();
    return this.#tail;
  }

  #commitPreparedSuspension(): void {
    const snapshot = this.#policy.snapshot();
    const ordinal = this.#getPresentationOrdinal();
    if (snapshot.suspension === "suspended") {
      this.#policy.installInitialSuspended(ordinal);
      return;
    }
    const transition = this.#policy.nextTransition();
    if (
      transition === null ||
      transition.kind !== "suspend" ||
      !this.#policy.commitSuspended(transition, ordinal)
    ) {
      throw new DOMException(
        "hidden preparation was superseded",
        "AbortError"
      );
    }
  }

  #schedule(): Promise<void> {
    const operation = this.#tail.then(() => this.#drain());
    this.#tail = operation.catch(() => undefined);
    return operation;
  }

  async #drain(): Promise<void> {
    while (!this.#isDisposed()) {
      const transition = this.#policy.nextTransition();
      if (transition === null) return;
      if (transition.kind === "suspend") {
        if (!this.#isPrepared()) return;
        await this.#suspend(transition);
      } else {
        await this.#resume(transition);
      }
    }
  }

  async #suspend(
    transition: Readonly<VisibilityPolicyTransition>
  ): Promise<void> {
    try {
      const state = await this.#staticPreparation.stageLatest(
        transition.signal
      );
      if (transition.signal.aborted) return;
      this.#assertVisibilityState(state);
      if (transition.signal.aborted) return;
      const cleanup = this.#commitVisibilitySuspended(state);
      if (!this.#policy.commitSuspended(
        transition,
        this.#getPresentationOrdinal()
      )) {
        await cleanup;
        return;
      }
      await cleanup;
    } catch (error) {
      if (transition.signal.aborted || isIntegratedAbortError(error)) return;
      throw this.#reportFailure(error, "visibility-suspension");
    }
  }

  async #resume(
    transition: Readonly<VisibilityPolicyTransition>
  ): Promise<void> {
    try {
      const before = this.#motion.snapshot();
      if (before.desiredMode === "reduce" || !this.#canResumeAnimated()) {
        if (before.desiredMode === "reduce") {
          await this.#motion.resumeAfterVisibility();
        }
        if (transition.signal.aborted) return;
        this.#policy.commitActive(transition);
        return;
      }
      const motion = await this.#motion.resumeAfterVisibility();
      if (transition.signal.aborted) return;
      if (motion.actualMode === "animated" || motion.desiredMode === "reduce") {
        this.#policy.commitActive(transition);
        this.#wasRunning = false;
        return;
      }
      this.#policy.failResume(transition);
    } catch (error) {
      if (transition.signal.aborted || isIntegratedAbortError(error)) return;
      this.#policy.failResume(transition);
      throw this.#reportFailure(error, "visibility-rebuild");
    }
  }

  #abortInitialControl(): void {
    const control = this.#control;
    if (control !== null && !control.controller.signal.aborted) {
      control.controller.abort(new DOMException(
        "hidden preparation was superseded",
        "AbortError"
      ));
    }
  }
}
