import {
  BrowserContextRecovery,
  type BrowserContextRecoveryEventTarget,
  type BrowserContextRecoverySnapshot,
  type BrowserContextRebuildInput,
  type BrowserContextRetirementInput
} from "./browser-context-recovery.js";
import type { RuntimeFailure } from "./errors.js";
import type { IntegratedPlayerActivationCoordinator } from "./integrated-player-activation-coordinator.js";
import type { IntegratedAnimatedPreparation } from "./integrated-animated-preparation.js";
import type {
  IntegratedCandidateAttempt,
  IntegratedPrepareOptions
} from "./integrated-player-contracts.js";
import type { IntegratedPlayerMotion } from "./integrated-player-motion.js";
import type { IntegratedPlayerVisibility } from "./integrated-player-visibility.js";
import type { RuntimeReadinessResult } from "./model.js";

export interface IntegratedPlayerContextOptions {
  readonly target: BrowserContextRecoveryEventTarget;
  readonly coverCurrent: () => void;
  /** Returns whether realtime was running before the synchronous freeze. */
  readonly freezeRealtime: () => boolean;
  readonly retireCandidate: (
    input: Readonly<BrowserContextRetirementInput & {
      readonly reason: "context-loss";
    }>
  ) => void | PromiseLike<void>;
  readonly canRebuild: () => boolean;
  /** Fresh candidate/GL readiness ending with current-state body frame zero. */
  readonly rebuildCurrentBodyZero: (
    input: Readonly<BrowserContextRebuildInput>
  ) => boolean | PromiseLike<boolean>;
  readonly revealAnimated: () => void;
  readonly resumeRealtime: (wasRunning: boolean) => void;
  readonly onFailure?: (failure: Readonly<RuntimeFailure>) => void;
}

export interface IntegratedPlayerContextSnapshot
  extends BrowserContextRecoverySnapshot {
  readonly resumeOnRestore: boolean;
}

/**
 * Narrow player adapter for the browser context owner. It composes callbacks
 * from the existing static, realtime, candidate, visibility, and motion
 * authorities without becoming a second owner of any of them.
 */
export class IntegratedPlayerContext {
  readonly #recovery: BrowserContextRecovery;
  #resumeOnRestore = false;

  public constructor(options: Readonly<IntegratedPlayerContextOptions>) {
    const captured = captureOptions(options);
    this.#recovery = new BrowserContextRecovery({
      target: captured.target,
      coverStatic: captured.coverCurrent,
      freeze: () => {
        this.#resumeOnRestore = captured.freezeRealtime();
      },
      retireAnimated: (input) => captured.retireCandidate(Object.freeze({
        ...input,
        reason: "context-loss" as const
      })),
      canRestore: captured.canRebuild,
      rebuild: captured.rebuildCurrentBodyZero,
      revealAnimated: () => {
        captured.revealAnimated();
        const resume = this.#resumeOnRestore;
        this.#resumeOnRestore = false;
        captured.resumeRealtime(resume);
      },
      onFailure: (failure) => {
        this.#resumeOnRestore = false;
        captured.onFailure?.(failure);
      }
    });
  }

  public requestRestore(): void {
    this.#recovery.requestRestore();
  }

  public snapshot(): Readonly<IntegratedPlayerContextSnapshot> {
    return Object.freeze({
      ...this.#recovery.snapshot(),
      resumeOnRestore: this.#resumeOnRestore
    });
  }

  public settled(): Promise<void> {
    return this.#recovery.settled();
  }

  public dispose(): Promise<void> {
    this.#resumeOnRestore = false;
    return this.#recovery.dispose();
  }
}

interface IntegratedPlayerContextBindingOptions {
  readonly target: BrowserContextRecoveryEventTarget;
  readonly activation: IntegratedPlayerActivationCoordinator;
  readonly animatedPreparation: IntegratedAnimatedPreparation;
  readonly motion: IntegratedPlayerMotion;
  readonly visibility: IntegratedPlayerVisibility;
  readonly isDisposed: () => boolean;
  readonly getActiveCandidate: () => IntegratedCandidateAttempt | null;
  readonly getReadyResult: () => Readonly<RuntimeReadinessResult> | null;
  readonly getPreparePromise: () => Promise<RuntimeReadinessResult> | null;
  readonly invalidateInitialPreparation: () => void;
  readonly reportFailure: (failure: Readonly<RuntimeFailure>) => void;
}

/** Concrete adapter that binds context recovery to existing player owners. */
export class IntegratedPlayerContextBinding {
  readonly #options: Readonly<IntegratedPlayerContextBindingOptions>;
  readonly #context: IntegratedPlayerContext;
  #blocked = false;
  #coveredState: string | null = null;

  public constructor(options: Readonly<IntegratedPlayerContextBindingOptions>) {
    this.#options = options;
    this.#context = new IntegratedPlayerContext({
      target: options.target,
      coverCurrent: () => {
        this.#coveredState = options.activation.coverContextSurface();
      },
      freezeRealtime: () => this.#freeze(),
      retireCandidate: ({ signal }) => options.visibility.serializeContext(
        () => this.#retire(signal)
      ),
      canRebuild: () => this.#canRebuild(),
      rebuildCurrentBodyZero: ({ signal }) => options.visibility.serializeContext(
        () => this.#rebuild(signal)
      ),
      revealAnimated: () => {
        this.#blocked = false;
        this.#coveredState = null;
      },
      resumeRealtime: () => undefined,
      onFailure: (failure) => {
        this.#blocked = true;
        options.motion.failContextRecovery();
        options.reportFailure(failure);
      }
    });
  }

  public get blocked(): boolean { return this.#blocked; }
  public canVisibilityResume(): boolean { return !this.#blocked; }
  public snapshot(): Readonly<IntegratedPlayerContextSnapshot> {
    return this.#context.snapshot();
  }
  public reconcile(): void { this.#context.requestRestore(); }
  public settled(): Promise<void> { return this.#context.settled(); }
  public dispose(): Promise<void> { return this.#context.dispose(); }

  public async prepareStatic(
    options: IntegratedPrepareOptions
  ): Promise<Readonly<RuntimeReadinessResult>> {
    const result = await this.#options.visibility.prepareContextStatic(options);
    this.#options.motion.stageContextSuspended();
    return result;
  }

  #freeze(): boolean {
    this.#blocked = true;
    const wasRunning = this.#options.activation.pauseForVisibility();
    this.#options.motion.suspendForVisibility(wasRunning);
    this.#options.animatedPreparation.abort();
    this.#options.invalidateInitialPreparation();
    return wasRunning;
  }

  async #retire(signal: AbortSignal): Promise<void> {
    await this.#options.getPreparePromise()?.catch(() => undefined);
    if (this.#options.isDisposed() || signal.aborted) return;
    if (this.#options.getActiveCandidate() !== null) {
      await this.#options.activation.commitContextSuspended(
        this.#coveredState
      );
    } else if (this.#options.getReadyResult() === null) {
      await this.prepareStatic({ signal });
    }
  }

  #canRebuild(): boolean {
    const visibility = this.#options.visibility.snapshot();
    const motion = this.#options.motion.snapshot();
    return !this.#options.isDisposed() && this.#blocked &&
      visibility.visibility === "visible" &&
      visibility.suspension === "active" &&
      motion.desiredMode === "full" &&
      !motion.stickyFailure;
  }

  async #rebuild(signal: AbortSignal): Promise<boolean> {
    if (signal.aborted || !this.#canRebuild()) return false;
    if (this.#options.motion.snapshot().actualMode === "animated") return true;
    const motion = await this.#options.motion.resumeAfterVisibility();
    return !signal.aborted && motion.actualMode === "animated";
  }
}

function captureOptions(
  options: Readonly<IntegratedPlayerContextOptions>
): Readonly<{
  target: BrowserContextRecoveryEventTarget;
  coverCurrent: () => void;
  freezeRealtime: () => boolean;
  retireCandidate: IntegratedPlayerContextOptions["retireCandidate"];
  canRebuild: () => boolean;
  rebuildCurrentBodyZero: IntegratedPlayerContextOptions[
    "rebuildCurrentBodyZero"
  ];
  revealAnimated: () => void;
  resumeRealtime: (wasRunning: boolean) => void;
  onFailure: ((failure: Readonly<RuntimeFailure>) => void) | null;
}> {
  if (options === null || typeof options !== "object") {
    throw new TypeError("integrated player context options must be an object");
  }
  const names = [
    "coverCurrent",
    "freezeRealtime",
    "retireCandidate",
    "canRebuild",
    "rebuildCurrentBodyZero",
    "revealAnimated",
    "resumeRealtime"
  ] as const;
  for (const name of names) {
    if (typeof options[name] !== "function") {
      throw new TypeError(`integrated player context ${name} is unavailable`);
    }
  }
  if (options.onFailure !== undefined && typeof options.onFailure !== "function") {
    throw new TypeError("integrated player context failure observer is invalid");
  }
  return Object.freeze({
    target: options.target,
    coverCurrent: options.coverCurrent,
    freezeRealtime: options.freezeRealtime,
    retireCandidate: options.retireCandidate,
    canRebuild: options.canRebuild,
    rebuildCurrentBodyZero: options.rebuildCurrentBodyZero,
    revealAnimated: options.revealAnimated,
    resumeRealtime: options.resumeRealtime,
    onFailure: options.onFailure ?? null
  });
}
