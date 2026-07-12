import type {
  GraphEdgeDefinition,
  GraphStateId
} from "./model.js";

/** An authored edge and the input sequence which selected it. */
export interface SequencedEdge {
  readonly edge: Readonly<GraphEdgeDefinition>;
  readonly sequence: number;
}

/**
 * Read-only route topology consumed by intent routing and snapshots.
 *
 * The slot priority is significant: a follow-on is the final prospective
 * destination, followed by a queued reversal, the active edge, and finally a
 * pending edge waiting for its authored departure boundary.
 */
export interface RoutePlanView {
  readonly pending: Readonly<SequencedEdge> | null;
  readonly active: Readonly<SequencedEdge> | null;
  readonly followOn: Readonly<SequencedEdge> | null;
  readonly reversal: Readonly<SequencedEdge> | null;

  recoveryCandidate(): Readonly<SequencedEdge> | null;
  prospectiveState(visualState: GraphStateId | null): GraphStateId | null;
  hasRoute(): boolean;
}

export interface ActiveRouteCompletion {
  readonly completed: Readonly<SequencedEdge>;
  readonly promoted: Readonly<SequencedEdge> | null;
}

export interface RoutePlanCheckpoint {
  readonly pending: Readonly<SequencedEdge> | null;
  readonly active: Readonly<SequencedEdge> | null;
  readonly followOn: Readonly<SequencedEdge> | null;
  readonly reversal: Readonly<SequencedEdge> | null;
}

/**
 * Owns the engine's small route plan and its cross-slot mutations.
 *
 * Graph lookup remains outside this class. Callers supply validated edges;
 * RoutePlan keeps each edge and its selecting sequence in one frozen value so
 * the two cannot drift apart during promotion or reversal.
 */
export class RoutePlan implements RoutePlanView {
  #pending: Readonly<SequencedEdge> | null = null;
  #active: Readonly<SequencedEdge> | null = null;
  #followOn: Readonly<SequencedEdge> | null = null;
  #reversal: Readonly<SequencedEdge> | null = null;

  public get pending(): Readonly<SequencedEdge> | null {
    return this.#pending;
  }

  public get active(): Readonly<SequencedEdge> | null {
    return this.#active;
  }

  public get followOn(): Readonly<SequencedEdge> | null {
    return this.#followOn;
  }

  public get reversal(): Readonly<SequencedEdge> | null {
    return this.#reversal;
  }

  /** Replace a waiting route and discard queued continuations. */
  public replacePending(
    edge: Readonly<GraphEdgeDefinition>,
    sequence: number
  ): Readonly<SequencedEdge> {
    if (this.#active !== null) {
      throw new Error("an active route must complete or clear before replacement");
    }
    const pending = freezeSequencedEdge(edge, sequence);
    this.#pending = pending;
    this.#followOn = null;
    this.#reversal = null;
    return pending;
  }

  /** Cancel only the edge which is still waiting to depart. */
  public cancelPending(): Readonly<SequencedEdge> | null {
    const cancelled = this.#pending;
    this.#pending = null;
    return cancelled;
  }

  /**
   * Make an edge active. A matching pending slot is consumed atomically;
   * completion edges may activate directly when there is no pending slot.
   */
  public activate(
    edge: Readonly<GraphEdgeDefinition>,
    sequence: number
  ): Readonly<SequencedEdge> {
    if (this.#active !== null) {
      throw new Error("a route is already active");
    }
    if (
      this.#pending !== null &&
      (this.#pending.edge.id !== edge.id || this.#pending.sequence !== sequence)
    ) {
      throw new Error("activated route does not match the pending route");
    }
    if (this.#followOn !== null || this.#reversal !== null) {
      throw new Error("queued routes require an active route");
    }

    const active = this.#pending ?? freezeSequencedEdge(edge, sequence);
    this.#pending = null;
    this.#active = active;
    return active;
  }

  /** Queue or replace the one direct continuation after the effective edge. */
  public queueFollowOn(
    edge: Readonly<GraphEdgeDefinition>,
    sequence: number
  ): Readonly<SequencedEdge> {
    const active = this.#requireActive();
    const effective = this.#reversal ?? active;
    if (edge.from !== effective.edge.to) {
      throw new Error("follow-on source must match the effective route target");
    }
    const followOn = freezeSequencedEdge(edge, sequence);
    this.#followOn = followOn;
    return followOn;
  }

  public clearFollowOn(): Readonly<SequencedEdge> | null {
    const cleared = this.#followOn;
    this.#followOn = null;
    return cleared;
  }

  /** Queue an inverse edge and cancel any continuation it supersedes. */
  public queueReversal(
    edge: Readonly<GraphEdgeDefinition>,
    sequence: number
  ): Readonly<SequencedEdge> {
    const active = this.#requireActive();
    if (edge.from !== active.edge.to || edge.to !== active.edge.from) {
      throw new Error("reversal must invert the active route");
    }
    const reversal = freezeSequencedEdge(edge, sequence);
    this.#followOn = null;
    this.#reversal = reversal;
    return reversal;
  }

  public clearReversal(): Readonly<SequencedEdge> | null {
    const cleared = this.#reversal;
    this.#reversal = null;
    return cleared;
  }

  /** Promote a queued reversal to active without disturbing its follow-on. */
  public activateReversal(): Readonly<SequencedEdge> {
    this.#requireActive();
    if (this.#reversal === null) {
      throw new Error("route plan has no queued reversal");
    }
    const reversal = this.#reversal;
    this.#active = reversal;
    this.#reversal = null;
    return reversal;
  }

  /** Complete the active edge and promote its continuation to pending. */
  public completeActive(): Readonly<ActiveRouteCompletion> {
    const completed = this.#requireActive();
    if (
      this.#followOn !== null &&
      this.#followOn.edge.from !== completed.edge.to
    ) {
      throw new Error("follow-on source must match the completed route target");
    }

    const promoted = this.#followOn;
    this.#active = null;
    this.#reversal = null;
    this.#followOn = null;
    this.#pending = promoted;
    return Object.freeze({ completed, promoted });
  }

  /** Select the authored route which best represents recovery intent. */
  public recoveryCandidate(): Readonly<SequencedEdge> | null {
    return this.#followOn ?? this.#reversal ?? this.#active ?? this.#pending;
  }

  /** Return the final state implied by the current route topology. */
  public prospectiveState(
    visualState: GraphStateId | null
  ): GraphStateId | null {
    return (
      this.#followOn?.edge.to ??
      this.#reversal?.edge.to ??
      this.#active?.edge.to ??
      this.#pending?.edge.to ??
      visualState
    );
  }

  public hasRoute(): boolean {
    return (
      this.#pending !== null ||
      this.#active !== null ||
      this.#followOn !== null ||
      this.#reversal !== null
    );
  }

  public clear(): void {
    this.#pending = null;
    this.#active = null;
    this.#followOn = null;
    this.#reversal = null;
  }

  public checkpoint(): Readonly<RoutePlanCheckpoint> {
    return Object.freeze({
      pending: this.#pending,
      active: this.#active,
      followOn: this.#followOn,
      reversal: this.#reversal
    });
  }

  public restore(checkpoint: Readonly<RoutePlanCheckpoint>): void {
    this.#pending = checkpoint.pending;
    this.#active = checkpoint.active;
    this.#followOn = checkpoint.followOn;
    this.#reversal = checkpoint.reversal;
  }

  #requireActive(): Readonly<SequencedEdge> {
    if (this.#active === null) {
      throw new Error("route plan has no active route");
    }
    return this.#active;
  }
}

function freezeSequencedEdge(
  edge: Readonly<GraphEdgeDefinition>,
  sequence: number
): Readonly<SequencedEdge> {
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new RangeError("route sequence must be a non-negative safe integer");
  }
  return Object.freeze({ edge, sequence });
}
