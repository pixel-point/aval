import { MotionGraphError } from "./errors.js";
import type {
  GraphEdgeDefinition,
  GraphPresentation,
  GraphStateDefinition,
  GraphStateId,
  MotionGraphDefinition,
  MotionGraphEffect,
  MotionGraphOperation,
  MotionGraphReadiness,
  MotionGraphResult,
  MotionGraphSnapshot,
  MotionGraphTraceRecord,
  ValidatedMotionGraph
} from "./model.js";
import {
  OperationJournal,
  type OperationJournalCheckpoint,
  type OperationResultMetadata
} from "./operation-journal.js";
import {
  RequestLedger,
  type RequestLedgerCheckpoint
} from "./request-ledger.js";
import {
  RoutePlan,
  type RoutePlanCheckpoint,
  type SequencedEdge
} from "./route-plan.js";
import {
  getValidatedGraphIndexes,
  validateMotionGraphDefinition,
  type ValidatedGraphIndexes
} from "./validate.js";

interface MotionGraphEngineCheckpoint {
  readonly readiness: MotionGraphReadiness;
  readonly phase: MotionGraphSnapshot["phase"];
  readonly requestedState: GraphStateId | null;
  readonly visualState: GraphStateId | null;
  readonly presentation: Readonly<GraphPresentation> | null;
  readonly ledger: Readonly<RequestLedgerCheckpoint>;
  readonly journal: Readonly<OperationJournalCheckpoint>;
  readonly routes: Readonly<RoutePlanCheckpoint>;
}

/** Package-private mechanical storage for the canonical graph reducer. */
export class MotionGraphEngineState {
  readonly ledger = new RequestLedger();
  readonly journal = new OperationJournal();
  readonly routes = new RoutePlan();

  public readiness: MotionGraphReadiness = "unready";
  public phase: MotionGraphSnapshot["phase"] = "unready";
  public requestedState: GraphStateId | null = null;
  public visualState: GraphStateId | null = null;
  public presentation: Readonly<GraphPresentation> | null = null;

  #graph: ValidatedMotionGraph | null = null;
  #indexes: ValidatedGraphIndexes | null = null;

  public installMetadata(
    definition: MotionGraphDefinition | ValidatedMotionGraph
  ): GraphStateId {
    const graph = isValidatedGraph(definition)
      ? definition
      : validateMotionGraphDefinition(definition);
    this.#graph = graph;
    this.#indexes = getValidatedGraphIndexes(graph);
    return graph.definition.initialState;
  }

  public snapshot(): Readonly<MotionGraphSnapshot> {
    return Object.freeze({
      readiness: this.readiness,
      phase: this.phase,
      requestedState: this.requestedState,
      visualState: this.visualState,
      prospectiveState: this.routes.prospectiveState(this.visualState),
      isTransitioning: this.#isTransitioning(),
      presentation: this.presentation,
      pendingEdgeId: this.routes.pending?.edge.id ?? null,
      activeEdgeId: this.routes.active?.edge.id ?? null,
      followOnEdgeId: this.routes.followOn?.edge.id ?? null,
      direction:
        this.presentation?.kind === "reversible"
          ? this.presentation.direction
          : null,
      contentOrdinal: this.journal.contentOrdinal,
      inputSequence: this.journal.inputSequence,
      pendingRequestCount: this.ledger.pendingRequestCount,
      inputsSinceTick: this.journal.inputsSinceTick,
      routeOperationsLastTick: this.journal.routeOperationsLastTick
    });
  }

  public checkpoint(): Readonly<MotionGraphEngineCheckpoint> {
    return Object.freeze({
      readiness: this.readiness,
      phase: this.phase,
      requestedState: this.requestedState,
      visualState: this.visualState,
      presentation: this.presentation,
      ledger: this.ledger.checkpoint(),
      journal: this.journal.checkpoint(),
      routes: this.routes.checkpoint()
    });
  }

  public restore(checkpoint: Readonly<MotionGraphEngineCheckpoint>): void {
    this.readiness = checkpoint.readiness;
    this.phase = checkpoint.phase;
    this.requestedState = checkpoint.requestedState;
    this.visualState = checkpoint.visualState;
    this.presentation = checkpoint.presentation;
    this.ledger.restore(checkpoint.ledger);
    this.journal.restore(checkpoint.journal);
    this.routes.restore(checkpoint.routes);
  }

  public record(
    operation: MotionGraphOperation,
    effects: readonly MotionGraphEffect[],
    metadata: OperationResultMetadata = {}
  ): Readonly<MotionGraphResult> {
    return this.journal.record({
      operation,
      metadata,
      presentation: this.presentation,
      effects,
      snapshot: this.snapshot()
    });
  }

  public getTrace(): readonly Readonly<MotionGraphTraceRecord>[] {
    return this.journal.getTrace();
  }

  public bodyPresentation(
    stateId: GraphStateId,
    frameIndex: number
  ): Readonly<GraphPresentation> {
    const state = this.state(stateId);
    return freezeGraphPresentation({
      kind: "body",
      state: stateId,
      unitId: state.body.unitId,
      frameIndex
    });
  }

  public staticPresentation(
    stateId: GraphStateId
  ): Readonly<GraphPresentation> {
    const state = this.state(stateId);
    return freezeGraphPresentation({
      kind: "static",
      state: stateId,
      staticFrameId: state.staticFrameId
    });
  }

  public bodyPresentationOrThrow(): Extract<
    GraphPresentation,
    { kind: "body" }
  > {
    if (this.presentation?.kind !== "body") {
      throw new Error("graph phase requires a body presentation");
    }
    return this.presentation;
  }

  public requirePendingRoute(): Readonly<SequencedEdge> {
    const pending = this.routes.pending;
    if (pending === null) throw new Error("graph has no pending edge");
    return pending;
  }

  public requireActiveRoute(): Readonly<SequencedEdge> {
    const active = this.routes.active;
    if (active === null) throw new Error("graph has no active edge");
    return active;
  }

  public edgeDirect(
    from: GraphStateId,
    to: GraphStateId
  ): GraphEdgeDefinition | null {
    return this.indexes().directEdgesByState.get(from)?.get(to) ?? null;
  }

  public state(id: GraphStateId): GraphStateDefinition {
    const state = this.indexes().statesById.get(id);
    if (state === undefined) {
      throw new Error(`validated graph has no state ${id}`);
    }
    return state;
  }

  public hasState(id: GraphStateId): boolean {
    return this.indexes().statesById.has(id);
  }

  public definition(): Readonly<MotionGraphDefinition> {
    if (this.#graph === null) throw new Error("graph metadata is unavailable");
    return this.#graph.definition;
  }

  public indexes(): ValidatedGraphIndexes {
    if (this.#indexes === null) throw new Error("graph indexes are unavailable");
    return this.#indexes;
  }

  public requireVisualState(): GraphStateId {
    if (this.visualState === null) throw new Error("visual state is unavailable");
    return this.visualState;
  }

  public requireRequestedState(): GraphStateId {
    if (this.requestedState === null) {
      throw new Error("requested state is unavailable");
    }
    return this.requestedState;
  }

  public assertInstalled(operation: string): void {
    if (this.#graph === null) {
      throw new MotionGraphError(
        "NOT_READY",
        `${operation} requires graph metadata`
      );
    }
  }

  public assertPhase(
    expected: MotionGraphSnapshot["phase"],
    operation: string
  ): void {
    this.assertInstalled(operation);
    if (this.phase !== expected) {
      throw new MotionGraphError(
        "NOT_READY",
        `${operation} requires phase ${expected}, not ${this.phase}`
      );
    }
  }

  #isTransitioning(): boolean {
    if (this.phase === "disposed" || this.phase === "error") return false;
    return (
      this.phase === "waiting" ||
      this.phase === "locked" ||
      this.phase === "reversible" ||
      this.requestedState !== this.visualState
    );
  }
}

export function freezeGraphPresentation<T extends GraphPresentation>(
  presentation: T
): Readonly<T> {
  return Object.freeze(presentation);
}

function isValidatedGraph(
  value: MotionGraphDefinition | ValidatedMotionGraph
): value is ValidatedMotionGraph {
  return (
    value !== null &&
    typeof value === "object" &&
    "definition" in value &&
    !Array.isArray(value)
  );
}
