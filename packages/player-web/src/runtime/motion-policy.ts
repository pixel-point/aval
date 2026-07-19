import {
  STATIC_REASONS,
  isTransientStaticReason,
  type StaticReason
} from "./model.js";

export const MOTION_POLICIES = Object.freeze([
  "auto",
  "reduce",
  "full"
] as const);

export type MotionPolicy = (typeof MOTION_POLICIES)[number];
export type EffectiveMotionMode = "reduce" | "full";
export type ActualMotionMode =
  | "unprepared"
  | "animated"
  | "static"
  | "disposed";
export type MotionPolicyTransitionKind = "enter-reduced" | "enter-full";
export type MotionStaticOrigin = StaticReason | "context-loss";

export interface MotionPolicyTransition {
  readonly kind: MotionPolicyTransitionKind;
  readonly generation: number;
  readonly signal: AbortSignal;
}

export interface MotionPolicySnapshot {
  readonly policy: MotionPolicy;
  readonly hostReducedMotion: boolean;
  readonly desiredMode: EffectiveMotionMode;
  readonly actualMode: ActualMotionMode;
  readonly generation: number;
  readonly transition: {
    readonly kind: MotionPolicyTransitionKind;
    readonly generation: number;
  } | null;
  readonly staticOrigin: MotionStaticOrigin | null;
  readonly disposed: boolean;
}

export interface MotionPolicyCoordinatorOptions {
  readonly policy?: MotionPolicy;
  readonly hostReducedMotion?: boolean;
}

interface OwnedMotionPolicyTransition extends MotionPolicyTransition {
  readonly controller: AbortController;
}

/**
 * The sole owner of desired/actual motion mode and transition invalidation.
 * It deliberately owns no media resources: IntegratedPlayerMotion executes
 * each returned transition under its serialized operation lane.
 */
export class MotionPolicyCoordinator {
  #policy: MotionPolicy;
  #hostReducedMotion: boolean;
  #actualMode: ActualMotionMode = "unprepared";
  #staticOrigin: MotionStaticOrigin | null = null;
  #generation = 0;
  #transition: OwnedMotionPolicyTransition | null = null;

  public constructor(options: MotionPolicyCoordinatorOptions = {}) {
    if (options === null || typeof options !== "object") {
      throw new TypeError("motion policy options must be an object");
    }
    this.#policy = validatePolicy(options.policy ?? "auto");
    this.#hostReducedMotion = validateHostReducedMotion(
      options.hostReducedMotion ?? false
    );
  }

  public snapshot(): Readonly<MotionPolicySnapshot> {
    const transition = this.#transition === null
      ? null
      : Object.freeze({
          kind: this.#transition.kind,
          generation: this.#transition.generation
        });
    return Object.freeze({
      policy: this.#policy,
      hostReducedMotion: this.#hostReducedMotion,
      desiredMode: this.#desiredMode(),
      actualMode: this.#actualMode,
      generation: this.#generation,
      transition,
      staticOrigin: this.#staticOrigin,
      disposed: this.#actualMode === "disposed"
    });
  }

  public setPolicy(policy: MotionPolicy): Readonly<MotionPolicySnapshot> {
    this.#assertUsable();
    const checked = validatePolicy(policy);
    if (checked === this.#policy) return this.snapshot();
    this.#policy = checked;
    this.#advanceGeneration();
    this.#cancelContradictedTransition();
    return this.snapshot();
  }

  public setHostReducedMotion(
    reduced: boolean
  ): Readonly<MotionPolicySnapshot> {
    this.#assertUsable();
    const checked = validateHostReducedMotion(reduced);
    if (checked === this.#hostReducedMotion) return this.snapshot();
    this.#hostReducedMotion = checked;
    this.#advanceGeneration();
    this.#cancelContradictedTransition();
    return this.snapshot();
  }

  /** Installs the result of initial full-motion preparation. */
  public installAnimated(): void {
    this.#assertUsable();
    this.#assertUnprepared("install animated mode");
    this.#actualMode = "animated";
    this.#staticOrigin = null;
  }

  /** Installs the result of initial static preparation. */
  public installStatic(origin: MotionStaticOrigin): void {
    this.#assertUsable();
    this.#assertUnprepared("install static mode");
    const checked = validateStaticOrigin(origin);
    this.#actualMode = "static";
    this.#staticOrigin = checked;
  }

  /**
   * Returns the one idempotent transition token required by current policy.
   * Nonfatal static policy origins may re-enter when full motion is desired.
   */
  public nextTransition(): Readonly<MotionPolicyTransition> | null {
    this.#assertUsable();
    if (this.#transition !== null) return this.#transition;
    const desired = this.#desiredMode();
    let kind: MotionPolicyTransitionKind | null = null;
    if (this.#actualMode === "animated" && desired === "reduce") {
      kind = "enter-reduced";
    } else if (
      this.#actualMode === "static" &&
      isReenterableStaticOrigin(this.#staticOrigin) &&
      desired === "full"
    ) {
      kind = "enter-full";
    }
    if (kind === null) return null;

    const controller = new AbortController();
    const transition = Object.freeze({
      kind,
      generation: this.#generation,
      signal: controller.signal,
      controller
    });
    this.#transition = transition;
    return transition;
  }

  /** Commit after the reduced-motion logical state is staged. */
  public commitStatic(
    transition: Readonly<MotionPolicyTransition>
  ): boolean {
    if (
      this.#actualMode === "disposed" ||
      transition !== this.#transition ||
      transition.kind !== "enter-reduced" ||
      transition.signal.aborted ||
      this.#actualMode !== "animated" ||
      this.#desiredMode() !== "reduce"
    ) {
      return false;
    }
    this.#transition = null;
    this.#actualMode = "static";
    this.#staticOrigin = "reduced-motion";
    return true;
  }

  /** Commit only after body frame zero has crossed the draw barrier. */
  public commitAnimated(
    transition: Readonly<MotionPolicyTransition>
  ): boolean {
    if (
      this.#actualMode === "disposed" ||
      transition !== this.#transition ||
      transition.kind !== "enter-full" ||
      transition.signal.aborted ||
      this.#actualMode !== "static" ||
      !isReenterableStaticOrigin(this.#staticOrigin) ||
      this.#desiredMode() !== "full"
    ) {
      return false;
    }
    this.#transition = null;
    this.#actualMode = "animated";
    this.#staticOrigin = null;
    return true;
  }

  /** Commit a non-motion suspension whose re-entry is still policy-controlled. */
  public suspendStatic(
    origin: Exclude<MotionStaticOrigin, "reduced-motion">
  ): void {
    this.#assertUsable();
    const checked = validateStaticOrigin(origin);
    if (checked === "reduced-motion") {
      throw new RangeError(
        "motion suspension origin must not be reduced-motion"
      );
    }
    if (this.#actualMode === "unprepared") {
      throw new RangeError(
        "motion suspension cannot replace an unprepared mode"
      );
    }
    this.#abortTransition();
    this.#advanceGeneration();
    this.#actualMode = "static";
    this.#staticOrigin = checked;
  }

  /** Invalidates owned policy work before an external lifecycle takes over. */
  public cancelTransition(): void {
    this.#assertUsable();
    if (this.#transition === null) return;
    this.#abortTransition();
    this.#advanceGeneration();
  }

  public dispose(): void {
    if (this.#actualMode === "disposed") return;
    this.#abortTransition();
    this.#advanceGeneration();
    this.#actualMode = "disposed";
    this.#staticOrigin = null;
  }

  #desiredMode(): EffectiveMotionMode {
    if (this.#policy === "full") return "full";
    if (this.#policy === "reduce") return "reduce";
    return this.#hostReducedMotion ? "reduce" : "full";
  }

  #cancelContradictedTransition(): void {
    if (this.#transition === null) return;
    const desired = this.#desiredMode();
    if (
      (this.#transition.kind === "enter-reduced" && desired === "full") ||
      (this.#transition.kind === "enter-full" && desired === "reduce")
    ) {
      this.#abortTransition();
    }
  }

  #abortTransition(): void {
    const transition = this.#transition;
    this.#transition = null;
    transition?.controller.abort(
      new DOMException("motion policy transition superseded", "AbortError")
    );
  }

  #advanceGeneration(): void {
    if (this.#generation >= Number.MAX_SAFE_INTEGER) {
      throw new RangeError("motion policy generation exceeds safe range");
    }
    this.#generation += 1;
  }

  #assertUnprepared(operation: string): void {
    if (this.#actualMode !== "unprepared" || this.#transition !== null) {
      throw new RangeError(`${operation} requires unprepared motion mode`);
    }
  }

  #assertUsable(): void {
    if (this.#actualMode === "disposed") {
      throw new RangeError("motion policy coordinator is disposed");
    }
  }
}

function validatePolicy(policy: MotionPolicy): MotionPolicy {
  if (!MOTION_POLICIES.includes(policy)) {
    throw new RangeError("motion policy is invalid");
  }
  return policy;
}

function validateHostReducedMotion(reduced: boolean): boolean {
  if (typeof reduced !== "boolean") {
    throw new TypeError("host reduced-motion value must be a boolean");
  }
  return reduced;
}

function validateStaticOrigin(origin: MotionStaticOrigin): MotionStaticOrigin {
  if (
    origin !== "context-loss" &&
    !STATIC_REASONS.includes(origin)
  ) {
    throw new RangeError("motion static origin is invalid");
  }
  return origin;
}

function isReenterableStaticOrigin(
  origin: MotionStaticOrigin | null
): boolean {
  return origin === "reduced-motion" || (
    origin === "context-loss"
  ) || (
    origin !== null &&
    isTransientStaticReason(origin)
  );
}
