import type {
  GraphBodyDefinition,
  GraphEdgeDefinition
} from "@rendered-motion/graph";

import type { ScheduledPathRoute } from "./path-sequence.js";
import {
  planSubmissionHorizon,
  type SourceBodyCursor,
  type SourceBoundary,
  type SubmissionHorizonDecision
} from "./submission-horizon.js";

export interface PathSchedulerRouteDecisionInput {
  readonly body: GraphBodyDefinition;
  readonly displayed: Readonly<SourceBodyCursor>;
  readonly submitted: Readonly<SourceBodyCursor>;
  readonly ringCapacity: number;
  readonly availableConsecutiveEdgeFrames: number;
}

/** Owns pending-route identity, boundary reconciliation, and wait accounting. */
export class PathSchedulerRoute {
  #current: ScheduledPathRoute | null = null;
  #committed = false;
  #elapsedWaitFrames = 0;

  public get current(): ScheduledPathRoute | null {
    return this.#current;
  }

  public get committed(): boolean {
    return this.#committed;
  }

  public get pendingEdge(): string | null {
    return this.#current?.edge.id ?? null;
  }

  public decide(
    edge: GraphEdgeDefinition,
    input: PathSchedulerRouteDecisionInput
  ): Readonly<SubmissionHorizonDecision> {
    return planSubmissionHorizon({
      body: input.body,
      edge,
      displayed: input.displayed,
      submitted: input.submitted,
      ringCapacity: input.ringCapacity,
      availableConsecutiveEdgeFrames:
        input.availableConsecutiveEdgeFrames,
      elapsedWaitFrames: this.#elapsedWaitFrames
    });
  }

  public prepare(input: {
    readonly edge: GraphEdgeDefinition;
    readonly targetState: string;
    readonly targetBody: GraphBodyDefinition;
    readonly boundary: Readonly<SourceBoundary>;
  }): void {
    this.#current = Object.freeze({ ...input });
    this.#committed = false;
    this.#elapsedWaitFrames = 0;
  }

  public reconcileBoundary(
    decision: Readonly<SubmissionHorizonDecision>,
    edgeSubmissionStarted: boolean
  ): Readonly<SourceBoundary> | null {
    const route = this.#current;
    if (
      route === null ||
      decision.kind !== "select-portal" ||
      sameBoundary(decision.boundary, route.boundary)
    ) {
      return null;
    }
    if (edgeSubmissionStarted) {
      throw new RangeError(
        "prepared edge lead cannot move after edge submission began"
      );
    }
    this.#current = Object.freeze({
      ...route,
      boundary: decision.boundary
    });
    return decision.boundary;
  }

  public commit(): void {
    if (this.#current === null) {
      throw new RangeError("path scheduler has no route to commit");
    }
    this.#committed = true;
  }

  public noteDisplayedSource(): void {
    if (this.#current !== null) this.#elapsedWaitFrames += 1;
  }

  public clear(): void {
    this.#current = null;
    this.#committed = false;
    this.#elapsedWaitFrames = 0;
  }

  public activateResident(): void {
    this.#current = null;
    this.#committed = true;
    this.#elapsedWaitFrames = 0;
  }
}

function sameBoundary(
  left: Pick<SourceBodyCursor, "occurrence" | "frame">,
  right: Pick<SourceBodyCursor, "occurrence" | "frame">
): boolean {
  return left.occurrence === right.occurrence && left.frame === right.frame;
}
