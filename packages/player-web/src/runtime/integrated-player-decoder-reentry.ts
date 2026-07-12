import { normalizeRuntimeFailure, type RuntimeFailure } from "./errors.js";
import type { IntegratedPlayerMotion } from "./integrated-player-motion.js";
import type { IntegratedPlayerParticipantController } from "./integrated-player-participant-controller.js";
import type { RuntimeReadinessResult, RuntimeVisibilityState } from "./model.js";

/** One-shot bridge from a retained FIFO grant into fresh body-zero readiness. */
export class IntegratedPlayerDecoderReentry {
  readonly #participant: IntegratedPlayerParticipantController;
  readonly #motion: () => IntegratedPlayerMotion;
  readonly #visibility: () => RuntimeVisibilityState;
  readonly #ready: () => Readonly<RuntimeReadinessResult> | null;
  readonly #disposed: () => boolean;
  readonly #report: (failure: Readonly<RuntimeFailure>) => void;
  #pending = false;

  public constructor(options: Readonly<{
    participant: IntegratedPlayerParticipantController;
    motion: () => IntegratedPlayerMotion;
    visibility: () => RuntimeVisibilityState;
    ready: () => Readonly<RuntimeReadinessResult> | null;
    disposed: () => boolean;
    report: (failure: Readonly<RuntimeFailure>) => void;
  }>) {
    this.#participant = options.participant;
    this.#motion = options.motion;
    this.#visibility = options.visibility;
    this.#ready = options.ready;
    this.#disposed = options.disposed;
    this.#report = options.report;
  }

  public granted(): boolean {
    if (this.#disposed()) return false;
    this.#pending = true;
    this.readyChanged();
    return true;
  }

  public readyChanged(): void {
    const ready = this.#ready();
    if (
      !this.#pending || this.#disposed() || this.#visibility() !== "visible" ||
      ready?.mode !== "static" || ready.reason !== "decoder-queued"
    ) return;
    this.#pending = false;
    this.#participant.markPreparing();
    void this.#motion().retryTransientStatic().then(() => {
      this.syncEligibility();
      const current = this.#ready();
      if (current !== null) this.#participant.markReady(current);
    }).catch((error: unknown) => {
      this.syncEligibility();
      this.#report(normalizeRuntimeFailure(
        "readiness-failure",
        error,
        { operation: "decoder-grant-reentry" }
      ));
    });
  }

  public syncEligibility(): void {
    const motion = this.#motion().snapshot();
    this.#participant.setEligible(
      motion.desiredMode === "full" && !motion.stickyFailure
    );
  }
}
