import type {
  RuntimeSuspensionState,
  RuntimeVisibilitySnapshot,
  RuntimeVisibilityState
} from "./model.js";

export type VisibilityPolicyTransitionKind = "suspend" | "resume";

export interface VisibilityPolicyTransition {
  readonly kind: VisibilityPolicyTransitionKind;
  readonly generation: number;
  readonly signal: AbortSignal;
}

export interface VisibilityPolicyCoordinatorOptions {
  readonly initialVisibility?: RuntimeVisibilityState;
}

interface OwnedVisibilityTransition extends VisibilityPolicyTransition {
  readonly controller: AbortController;
}

/** Sole owner of host visibility intent and stale rebuild invalidation. */
export class VisibilityPolicyCoordinator {
  #visibility: RuntimeVisibilityState;
  #suspension: RuntimeSuspensionState;
  #generation = 0;
  #frozenPresentationOrdinal: bigint | null = null;
  #rebuildPending = false;
  #transition: OwnedVisibilityTransition | null = null;
  #disposed = false;

  public constructor(options: VisibilityPolicyCoordinatorOptions = {}) {
    if (typeof options !== "object" || options === null) {
      throw new TypeError("visibility policy options must be an object");
    }
    this.#visibility = validateVisibility(
      options.initialVisibility ?? "visible"
    );
    this.#suspension = this.#visibility === "visible"
      ? "active"
      : "suspended";
  }

  public snapshot(): Readonly<RuntimeVisibilitySnapshot> {
    return Object.freeze({
      generation: this.#generation,
      visibility: this.#visibility,
      suspension: this.#suspension,
      frozenPresentationOrdinal: this.#frozenPresentationOrdinal,
      rebuildPending: this.#rebuildPending
    });
  }

  public setVisibility(
    visibility: RuntimeVisibilityState
  ): Readonly<RuntimeVisibilitySnapshot> {
    this.#assertUsable();
    const checked = validateVisibility(visibility);
    if (checked === this.#visibility) return this.snapshot();
    const previousSuspension = this.#suspension;
    this.#abortTransition();
    this.#advanceGeneration();
    this.#visibility = checked;
    if (checked === "hidden") {
      this.#rebuildPending = false;
      if (previousSuspension === "active") this.#suspension = "suspending";
    } else if (previousSuspension === "suspending") {
      this.#suspension = "active";
      this.#frozenPresentationOrdinal = null;
      this.#rebuildPending = false;
    } else if (previousSuspension === "suspended") {
      if (this.#frozenPresentationOrdinal === null) {
        this.#suspension = "active";
        this.#rebuildPending = false;
      } else {
        this.#rebuildPending = true;
      }
    }
    return this.snapshot();
  }

  public nextTransition(): Readonly<VisibilityPolicyTransition> | null {
    if (this.#disposed) return null;
    if (this.#transition !== null) return this.#transition;
    let kind: VisibilityPolicyTransitionKind | null = null;
    if (this.#visibility === "hidden" && this.#suspension === "suspending") {
      kind = "suspend";
    } else if (
      this.#visibility === "visible" &&
      this.#suspension === "suspended" &&
      this.#rebuildPending
    ) {
      kind = "resume";
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

  public commitSuspended(
    transition: Readonly<VisibilityPolicyTransition>,
    frozenPresentationOrdinal: bigint
  ): boolean {
    requireOrdinal(frozenPresentationOrdinal);
    if (
      this.#disposed ||
      transition !== this.#transition ||
      transition.kind !== "suspend" ||
      transition.signal.aborted ||
      this.#visibility !== "hidden" ||
      this.#suspension !== "suspending"
    ) {
      return false;
    }
    this.#transition = null;
    this.#suspension = "suspended";
    this.#frozenPresentationOrdinal = frozenPresentationOrdinal;
    this.#rebuildPending = false;
    return true;
  }

  public installInitialSuspended(frozenPresentationOrdinal: bigint): void {
    this.#assertUsable();
    requireOrdinal(frozenPresentationOrdinal);
    if (this.#visibility !== "hidden" || this.#suspension !== "suspended") {
      throw new RangeError("initial visibility is not suspended");
    }
    this.#frozenPresentationOrdinal = frozenPresentationOrdinal;
  }

  public commitActive(
    transition: Readonly<VisibilityPolicyTransition>
  ): boolean {
    if (
      this.#disposed ||
      transition !== this.#transition ||
      transition.kind !== "resume" ||
      transition.signal.aborted ||
      this.#visibility !== "visible" ||
      this.#suspension !== "suspended" ||
      !this.#rebuildPending
    ) {
      return false;
    }
    this.#transition = null;
    this.#suspension = "active";
    this.#frozenPresentationOrdinal = null;
    this.#rebuildPending = false;
    return true;
  }

  public failResume(
    transition: Readonly<VisibilityPolicyTransition>
  ): boolean {
    if (
      this.#disposed ||
      transition !== this.#transition ||
      transition.kind !== "resume"
    ) {
      return false;
    }
    this.#transition = null;
    this.#rebuildPending = false;
    return true;
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#abortTransition();
    this.#advanceGeneration();
    this.#rebuildPending = false;
  }

  #abortTransition(): void {
    const transition = this.#transition;
    this.#transition = null;
    try {
      transition?.controller.abort(new DOMException(
        "visibility transition superseded",
        "AbortError"
      ));
    } catch {
      // Generation ownership is already invalidated.
    }
  }

  #advanceGeneration(): void {
    if (this.#generation >= Number.MAX_SAFE_INTEGER) {
      throw new RangeError("visibility generation exceeds safe range");
    }
    this.#generation += 1;
  }

  #assertUsable(): void {
    if (this.#disposed) throw new RangeError("visibility policy is disposed");
  }
}

function validateVisibility(value: RuntimeVisibilityState): RuntimeVisibilityState {
  if (value !== "visible" && value !== "hidden") {
    throw new TypeError("visibility must be visible or hidden");
  }
  return value;
}

function requireOrdinal(value: bigint): void {
  if (typeof value !== "bigint" || value < 0n) {
    throw new TypeError("frozen presentation ordinal must be non-negative");
  }
}
