import type {
  GraphSettlement,
  GraphStateId,
  MotionGraphEffect
} from "./model.js";

export type RequestSettleEffect = Readonly<
  Extract<MotionGraphEffect, { readonly type: "settle" }>
>;

export interface RequestAdmission {
  readonly requestId: number;
  readonly target: GraphStateId;
  readonly joined: boolean;
  readonly superseded: RequestSettleEffect | null;
}

export interface StandaloneSettlement {
  readonly requestId: number;
  readonly effect: RequestSettleEffect;
}

interface PendingRequestGroup {
  readonly target: GraphStateId;
  readonly requestIds: number[];
}

export interface RequestLedgerCheckpoint {
  readonly nextRequestId: number;
  readonly pending: Readonly<{
    readonly target: GraphStateId;
    readonly requestIds: readonly number[];
  }> | null;
}

/**
 * Tracks request completion groups without owning promises or scheduling work.
 *
 * Duplicate destinations join the current group. A different destination
 * atomically supersedes that group and returns its one AbortError effect to
 * the caller. Effects describe microtask timing, but the host remains
 * responsible for applying that timing.
 */
export class RequestLedger {
  #nextRequestId = 1;
  #pending: PendingRequestGroup | null = null;

  public get pendingRequestCount(): number {
    return this.#pending?.requestIds.length ?? 0;
  }

  public get pendingTarget(): GraphStateId | null {
    return this.#pending?.target ?? null;
  }

  /**
   * Adds a request to the surviving completion group for `target`.
   */
  public request(target: GraphStateId): Readonly<RequestAdmission> {
    const requestId = this.#allocateRequestId();
    const pending = this.#pending;

    if (pending?.target === target) {
      pending.requestIds.push(requestId);
      return freezeAdmission({
        requestId,
        target,
        joined: true,
        superseded: null
      });
    }

    const superseded =
      pending === null
        ? null
        : createSettleEffect(pending.requestIds, {
            type: "reject",
            timing: "microtask",
            error: "AbortError"
          });

    this.#pending = {
      target,
      requestIds: [requestId]
    };

    return freezeAdmission({
      requestId,
      target,
      joined: false,
      superseded
    });
  }

  /**
   * Settles and clears the surviving group. Repeated settlement is a no-op.
   */
  public settlePending(outcome: GraphSettlement): RequestSettleEffect | null {
    const pending = this.#pending;
    if (pending === null) {
      return null;
    }

    this.#pending = null;
    return createSettleEffect(pending.requestIds, outcome);
  }

  /**
   * Allocates and settles one request without replacing the surviving group.
   * This is used for stable no-ops and requests rejected before admission.
   */
  public settleNew(outcome: GraphSettlement): Readonly<StandaloneSettlement> {
    const requestId = this.#allocateRequestId();
    return Object.freeze({
      requestId,
      effect: createSettleEffect([requestId], outcome)
    });
  }

  public checkpoint(): Readonly<RequestLedgerCheckpoint> {
    return Object.freeze({
      nextRequestId: this.#nextRequestId,
      pending: this.#pending === null
        ? null
        : Object.freeze({
            target: this.#pending.target,
            requestIds: Object.freeze([...this.#pending.requestIds])
          })
    });
  }

  public restore(checkpoint: Readonly<RequestLedgerCheckpoint>): void {
    this.#nextRequestId = checkpoint.nextRequestId;
    this.#pending = checkpoint.pending === null
      ? null
      : {
          target: checkpoint.pending.target,
          requestIds: [...checkpoint.pending.requestIds]
        };
  }

  #allocateRequestId(): number {
    const requestId = this.#nextRequestId;
    if (!Number.isSafeInteger(requestId)) {
      throw new RangeError("request ID exceeds the safe-integer range");
    }

    this.#nextRequestId += 1;
    return requestId;
  }
}

function freezeAdmission(
  admission: RequestAdmission
): Readonly<RequestAdmission> {
  return Object.freeze(admission);
}

function createSettleEffect(
  requestIds: readonly number[],
  outcome: GraphSettlement
): RequestSettleEffect {
  const frozenRequestIds = Object.freeze([...requestIds].sort((a, b) => a - b));
  const frozenOutcome = Object.freeze({ ...outcome }) as Readonly<GraphSettlement>;

  return Object.freeze({
    type: "settle",
    requestIds: frozenRequestIds,
    outcome: frozenOutcome
  });
}
