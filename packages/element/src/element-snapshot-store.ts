import type {
  AvalErrorDetail,
  AvalSnapshot,
  Binding
} from "./public-types.js";

export type ElementSnapshotState = Omit<AvalSnapshot, "revision">;

interface SnapshotSubscription {
  readonly listener: () => void;
  active: boolean;
}

/** Cached semantic snapshot and isolated synchronous subscriber fan-out. */
export class ElementSnapshotStore {
  readonly #subscriptions = new Set<SnapshotSubscription>();
  #state: Readonly<ElementSnapshotState>;
  #snapshot: Readonly<AvalSnapshot>;

  public constructor(initial: Readonly<ElementSnapshotState>) {
    this.#state = freezeState(initial);
    this.#snapshot = freezeSnapshot(0, this.#state);
  }

  public getSnapshot(): Readonly<AvalSnapshot> {
    return this.#snapshot;
  }

  public subscribe(listener: () => void): () => void {
    if (typeof listener !== "function") {
      throw new TypeError("AVAL snapshot subscriber must be a function");
    }
    const subscription: SnapshotSubscription = { listener, active: true };
    this.#subscriptions.add(subscription);
    return () => {
      if (!subscription.active) return;
      subscription.active = false;
      this.#subscriptions.delete(subscription);
    };
  }

  public transition(
    update: (
      current: Readonly<ElementSnapshotState>
    ) => Readonly<ElementSnapshotState>
  ): boolean {
    const next = update(this.#state);
    if (sameState(this.#state, next)) return false;
    this.#state = freezeState(next);
    this.#snapshot = freezeSnapshot(
      this.#snapshot.revision + 1,
      this.#state
    );
    this.#notify();
    return true;
  }

  #notify(): void {
    for (const subscription of [...this.#subscriptions]) {
      if (!subscription.active) continue;
      try { subscription.listener(); }
      catch { /* subscribers are observational and cannot interrupt playback */ }
    }
  }
}

function sameState(
  current: Readonly<ElementSnapshotState>,
  next: Readonly<ElementSnapshotState>
): boolean {
  return current.generation === next.generation &&
    current.connected === next.connected &&
    current.readiness === next.readiness &&
    current.mode === next.mode &&
    current.assurance === next.assurance &&
    current.staticReason === next.staticReason &&
    current.requestedState === next.requestedState &&
    current.visualState === next.visualState &&
    current.isTransitioning === next.isTransitioning &&
    current.paused === next.paused &&
    current.effectivelyVisible === next.effectivelyVisible &&
    sameStrings(current.stateNames, next.stateNames) &&
    sameStrings(current.eventNames, next.eventNames) &&
    sameBindings(current.inputBindings, next.inputBindings) &&
    sameError(current.lastError, next.lastError);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) =>
    value === right[index]
  );
}

function sameBindings(
  left: readonly Readonly<Binding>[],
  right: readonly Readonly<Binding>[]
): boolean {
  return left.length === right.length && left.every((value, index) => {
    const candidate = right[index];
    return candidate !== undefined && value.source === candidate.source &&
      value.event === candidate.event;
  });
}

function sameError(
  left: Readonly<AvalErrorDetail> | null,
  right: Readonly<AvalErrorDetail> | null
): boolean {
  if (left === right) return true;
  if (left === null || right === null) return false;
  return left.generation === right.generation && left.fatal === right.fatal &&
    left.failure.code === right.failure.code &&
    left.failure.message === right.failure.message &&
    left.failure.operation === right.failure.operation;
}

function freezeState(
  state: Readonly<ElementSnapshotState>
): Readonly<ElementSnapshotState> {
  return Object.freeze({
    generation: state.generation,
    connected: state.connected,
    readiness: state.readiness,
    mode: state.mode,
    assurance: state.assurance,
    staticReason: state.staticReason,
    requestedState: state.requestedState,
    visualState: state.visualState,
    isTransitioning: state.isTransitioning,
    paused: state.paused,
    effectivelyVisible: state.effectivelyVisible,
    stateNames: Object.freeze([...state.stateNames]),
    eventNames: Object.freeze([...state.eventNames]),
    inputBindings: Object.freeze(state.inputBindings.map((binding) =>
      Object.freeze({ source: binding.source, event: binding.event })
    )),
    lastError: freezeError(state.lastError)
  });
}

function freezeSnapshot(
  revision: number,
  state: Readonly<ElementSnapshotState>
): Readonly<AvalSnapshot> {
  return Object.freeze({ revision, ...state });
}

function freezeError(
  detail: Readonly<AvalErrorDetail> | null
): Readonly<AvalErrorDetail> | null {
  if (detail === null) return null;
  if (Object.isFrozen(detail) && Object.isFrozen(detail.failure)) return detail;
  return Object.freeze({
    generation: detail.generation,
    fatal: detail.fatal,
    failure: Object.freeze({
      code: detail.failure.code,
      message: detail.failure.message,
      operation: detail.failure.operation
    })
  });
}
