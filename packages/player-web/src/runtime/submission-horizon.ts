import {
  findFinishBoundary,
  findNextPortalBoundary,
  type GraphBodyDefinition,
  type GraphEdgeDefinition,
  type GraphStartPolicy
} from "@rendered-motion/graph";

import { planEdgeLead, type EdgeLeadPlan } from "./edge-lead.js";
import { validatePresentationRingCapacity } from "./presentation-ring.js";

export interface SourceBodyCursor {
  readonly occurrence: bigint;
  readonly frame: number;
}

export interface SourceBoundary {
  readonly type: "portal" | "finish" | "cut";
  readonly occurrence: bigint;
  readonly frame: number;
  readonly wraps: boolean;
}

export interface SubmissionHorizonInput {
  readonly body: GraphBodyDefinition;
  readonly edge: GraphEdgeDefinition;
  readonly displayed: SourceBodyCursor;
  /** Furthest source access unit already submitted, inclusive. */
  readonly submitted: SourceBodyCursor;
  readonly ringCapacity: number;
  readonly availableConsecutiveEdgeFrames: number;
  /** Content ticks already charged to this request. */
  readonly elapsedWaitFrames: number;
}

export type SubmissionHorizonDecision =
  | {
      readonly kind: "continue-source";
      readonly boundary: Readonly<SourceBoundary>;
      readonly waitFrames: number;
      readonly totalWaitFrames: number;
      readonly lead: Readonly<EdgeLeadPlan> | null;
    }
  | {
      readonly kind: "select-portal";
      readonly reason:
        | "authored-boundary"
        | "submitted-horizon"
        | "lead-unavailable";
      readonly boundary: Readonly<SourceBoundary>;
      readonly waitFrames: number;
      readonly totalWaitFrames: number;
      readonly lead: Readonly<EdgeLeadPlan> | null;
    }
  | {
      readonly kind: "wait-held";
      readonly boundary: Readonly<SourceBoundary>;
      readonly elapsedWaitFrames: number;
      readonly remainingWaitFrames: number;
      readonly lead: Readonly<EdgeLeadPlan>;
    }
  | {
      readonly kind: "commit-edge";
      readonly boundary: Readonly<SourceBoundary>;
      readonly totalWaitFrames: number;
      readonly lead: Readonly<EdgeLeadPlan> | null;
    }
  | {
      readonly kind: "restart-generation";
      readonly reason: "cut";
      readonly responseFrames: 1;
      readonly totalWaitFrames: number;
    }
  | {
      readonly kind: "reject-readiness";
      readonly reason: "max-wait-exceeded" | "no-reachable-boundary";
      readonly requiredWaitFrames: bigint;
      readonly maxWaitFrames: number;
      readonly lead: Readonly<EdgeLeadPlan> | null;
    };

export interface UnresolvedSubmissionHorizonInput {
  readonly body: GraphBodyDefinition;
  readonly displayed: SourceBodyCursor;
  readonly submitted: SourceBodyCursor;
  readonly outgoingStarts: readonly GraphStartPolicy[];
  readonly ringCapacity: number;
}

export interface UnresolvedSubmissionHorizon {
  readonly earliestBoundary: Readonly<SourceBoundary>;
  readonly maximumSubmitted: Readonly<SourceBodyCursor>;
  readonly submittedWithinHorizon: boolean;
  readonly framesBeyondEarliestBoundary: bigint;
}

/**
 * Free-running source submission may pass the earliest unresolved boundary by
 * at most one presentation-ring capacity.
 */
export function planUnresolvedSubmissionHorizon(
  input: UnresolvedSubmissionHorizonInput
): Readonly<UnresolvedSubmissionHorizon> {
  validatePresentationRingCapacity(input.ringCapacity);
  validateBody(input.body);
  validateCursor(input.body, input.displayed, "displayed cursor");
  validateCursor(input.body, input.submitted, "submitted cursor");
  const displayedAbsolute = cursorAbsolute(input.body, input.displayed);
  const submittedAbsolute = cursorAbsolute(input.body, input.submitted);
  if (submittedAbsolute < displayedAbsolute) {
    throw new RangeError("submitted cursor cannot be behind displayed cursor");
  }
  if (input.outgoingStarts.length < 1) {
    throw new RangeError("unresolved horizon requires an outgoing start policy");
  }

  let earliest: SourceBoundary | null = null;
  let earliestAbsolute: bigint | null = null;
  for (const start of input.outgoingStarts) {
    const boundary = boundaryForStart(input.body, input.displayed, start);
    const absolute = cursorAbsolute(input.body, boundary);
    if (
      earliestAbsolute === null ||
      absolute < earliestAbsolute ||
      absolute === earliestAbsolute && boundary.type < (earliest?.type ?? "")
    ) {
      earliest = boundary;
      earliestAbsolute = absolute;
    }
  }
  if (earliest === null || earliestAbsolute === null) {
    throw new RangeError("unresolved horizon has no reachable boundary");
  }

  let maximumAbsolute = earliestAbsolute + BigInt(input.ringCapacity);
  if (input.body.kind !== "loop") {
    maximumAbsolute = minimumBigInt(
      maximumAbsolute,
      BigInt(input.body.frameCount - 1)
    );
  }
  const framesBeyondEarliestBoundary = submittedAbsolute > earliestAbsolute
    ? submittedAbsolute - earliestAbsolute
    : 0n;
  return Object.freeze({
    earliestBoundary: freezeBoundary(earliest),
    maximumSubmitted: freezeCursor(
      cursorFromAbsolute(input.body, maximumAbsolute)
    ),
    submittedWithinHorizon: submittedAbsolute <= maximumAbsolute,
    framesBeyondEarliestBoundary
  });
}

/** Sole pure owner of selected-route source horizon and boundary decisions. */
export function planSubmissionHorizon(
  input: SubmissionHorizonInput
): Readonly<SubmissionHorizonDecision> {
  validatePresentationRingCapacity(input.ringCapacity);
  validateBody(input.body);
  validateCursor(input.body, input.displayed, "displayed cursor");
  validateCursor(input.body, input.submitted, "submitted cursor");
  validateNonNegativeSafeInteger(
    input.elapsedWaitFrames,
    "elapsed wait frame count"
  );
  validateNonNegativeSafeInteger(
    input.edge.start.maxWaitFrames,
    "edge maxWaitFrames"
  );
  validateNonNegativeSafeInteger(
    input.availableConsecutiveEdgeFrames,
    "available consecutive frame count"
  );
  if (input.availableConsecutiveEdgeFrames > input.ringCapacity) {
    throw new RangeError(
      "available consecutive frame count exceeds the presentation ring"
    );
  }

  const displayedAbsolute = cursorAbsolute(input.body, input.displayed);
  const submittedAbsolute = cursorAbsolute(input.body, input.submitted);
  if (submittedAbsolute < displayedAbsolute) {
    throw new RangeError("submitted cursor cannot be behind displayed cursor");
  }
  const maxWaitFrames = input.edge.start.maxWaitFrames;
  const elapsed = BigInt(input.elapsedWaitFrames);

  if (input.edge.start.type === "cut") {
    const totalWait = elapsed + 1n;
    if (totalWait > BigInt(maxWaitFrames)) {
      return rejectMaxWait(totalWait, maxWaitFrames, null);
    }
    return Object.freeze({
      kind: "restart-generation",
      reason: "cut",
      responseFrames: 1,
      totalWaitFrames: Number(totalWait)
    });
  }

  const lead = createLeadPlan(input);
  if (input.edge.start.type === "finish") {
    return planFinish({
      body: input.body,
      displayed: input.displayed,
      elapsed,
      maxWaitFrames,
      lead
    });
  }

  return planPortal({
    body: input.body,
    sourcePort: input.edge.start.sourcePort,
    displayed: input.displayed,
    displayedAbsolute,
    submittedAbsolute,
    elapsed,
    maxWaitFrames,
    lead
  });
}

function planFinish(input: {
  readonly body: GraphBodyDefinition;
  readonly displayed: SourceBodyCursor;
  readonly elapsed: bigint;
  readonly maxWaitFrames: number;
  readonly lead: Readonly<EdgeLeadPlan> | null;
}): Readonly<SubmissionHorizonDecision> {
  const search = findFinishBoundary(input.body, input.displayed.frame);
  const boundary = freezeBoundary({
    type: "finish",
    occurrence: input.displayed.occurrence,
    frame: search.boundaryFrame,
    wraps: false
  });
  const wait = BigInt(search.waitFrames);
  const totalWait = input.elapsed + wait;
  if (totalWait > BigInt(input.maxWaitFrames)) {
    return rejectMaxWait(totalWait, input.maxWaitFrames, input.lead);
  }
  if (wait > 0n) {
    return Object.freeze({
      kind: "continue-source",
      boundary,
      waitFrames: Number(wait),
      totalWaitFrames: Number(totalWait),
      lead: input.lead
    });
  }
  if (leadReady(input.lead)) {
    return Object.freeze({
      kind: "commit-edge",
      boundary,
      totalWaitFrames: Number(totalWait),
      lead: input.lead
    });
  }
  if (input.lead === null) {
    throw new Error("resident edge lead invariant failed");
  }
  if (input.elapsed >= BigInt(input.maxWaitFrames)) {
    return rejectMaxWait(
      input.elapsed + 1n,
      input.maxWaitFrames,
      input.lead
    );
  }
  return Object.freeze({
    kind: "wait-held",
    boundary,
    elapsedWaitFrames: Number(input.elapsed),
    remainingWaitFrames: input.maxWaitFrames - Number(input.elapsed),
    lead: input.lead
  });
}

function planPortal(input: {
  readonly body: GraphBodyDefinition;
  readonly sourcePort: string;
  readonly displayed: SourceBodyCursor;
  readonly displayedAbsolute: bigint;
  readonly submittedAbsolute: bigint;
  readonly elapsed: bigint;
  readonly maxWaitFrames: number;
  readonly lead: Readonly<EdgeLeadPlan> | null;
}): Readonly<SubmissionHorizonDecision> {
  const graphSearch = findNextPortalBoundary(
    input.body,
    input.sourcePort,
    input.displayed.frame
  );
  const graphBoundaryOccurrence = input.displayed.occurrence +
    (graphSearch.wraps ? 1n : 0n);
  const graphBoundaryAbsolute =
    graphBoundaryOccurrence * BigInt(input.body.frameCount) +
    BigInt(graphSearch.boundaryFrame);

  // A reversible transition is already resident (`lead === null`), so source
  // frames submitted beyond the visible authored portal can be discarded.
  // Streamed transitions still have to select at/after their submitted debt.
  const minimumAbsolute = input.lead === null
    ? input.displayedAbsolute
    : maximumBigInt(input.displayedAbsolute, input.submittedAbsolute);
  let candidate = findPortalAtOrAfter(
    input.body,
    input.sourcePort,
    minimumAbsolute,
    input.displayed.occurrence
  );
  if (candidate === null) {
    return rejectNoBoundary(input.maxWaitFrames, input.lead);
  }

  let reason: Extract<SubmissionHorizonDecision, {
    readonly kind: "select-portal";
  }>["reason"] = candidate.absolute > graphBoundaryAbsolute
    ? "submitted-horizon"
    : "authored-boundary";

  if (
    candidate.absolute === input.displayedAbsolute &&
    leadReady(input.lead)
  ) {
    if (input.elapsed > BigInt(input.maxWaitFrames)) {
      return rejectMaxWait(input.elapsed, input.maxWaitFrames, input.lead);
    }
    return Object.freeze({
      kind: "commit-edge",
      boundary: candidate.boundary,
      totalWaitFrames: Number(input.elapsed),
      lead: input.lead
    });
  }

  if (candidate.absolute === input.displayedAbsolute) {
    const later = findPortalAtOrAfter(
      input.body,
      input.sourcePort,
      input.displayedAbsolute + 1n,
      input.displayed.occurrence
    );
    if (later === null) {
      if (
        input.body.kind !== "loop" &&
        input.displayed.frame === input.body.frameCount - 1 &&
        input.lead !== null
      ) {
        if (input.elapsed >= BigInt(input.maxWaitFrames)) {
          return rejectMaxWait(
            input.elapsed + 1n,
            input.maxWaitFrames,
            input.lead
          );
        }
        return Object.freeze({
          kind: "wait-held",
          boundary: candidate.boundary,
          elapsedWaitFrames: Number(input.elapsed),
          remainingWaitFrames:
            input.maxWaitFrames - Number(input.elapsed),
          lead: input.lead
        });
      }
      return rejectNoBoundary(input.maxWaitFrames, input.lead);
    }
    candidate = later;
    reason = "lead-unavailable";
  }

  const wait = candidate.absolute - input.displayedAbsolute;
  const totalWait = input.elapsed + wait;
  if (totalWait > BigInt(input.maxWaitFrames)) {
    return rejectMaxWait(totalWait, input.maxWaitFrames, input.lead);
  }
  return Object.freeze({
    kind: "select-portal",
    reason,
    boundary: candidate.boundary,
    waitFrames: Number(wait),
    totalWaitFrames: Number(totalWait),
    lead: input.lead
  });
}

function createLeadPlan(
  input: SubmissionHorizonInput
): Readonly<EdgeLeadPlan> | null {
  const transition = input.edge.transition;
  if (transition?.kind === "reversible") {
    return null;
  }
  return planEdgeLead({
    transitionFrames: transition?.frameCount ?? 0,
    ringCapacity: input.ringCapacity,
    availableConsecutiveFrames: input.availableConsecutiveEdgeFrames
  });
}

function leadReady(lead: Readonly<EdgeLeadPlan> | null): boolean {
  return lead === null || lead.ready;
}

function boundaryForStart(
  body: GraphBodyDefinition,
  displayed: SourceBodyCursor,
  start: GraphStartPolicy
): SourceBoundary {
  if (start.type === "cut") {
    return {
      type: "cut",
      occurrence: displayed.occurrence,
      frame: displayed.frame,
      wraps: false
    };
  }
  if (start.type === "finish") {
    const search = findFinishBoundary(body, displayed.frame);
    return {
      type: "finish",
      occurrence: displayed.occurrence,
      frame: search.boundaryFrame,
      wraps: false
    };
  }
  const search = findNextPortalBoundary(body, start.sourcePort, displayed.frame);
  return {
    type: "portal",
    occurrence: displayed.occurrence + (search.wraps ? 1n : 0n),
    frame: search.boundaryFrame,
    wraps: search.wraps
  };
}

function findPortalAtOrAfter(
  body: GraphBodyDefinition,
  sourcePort: string,
  minimumAbsolute: bigint,
  displayedOccurrence: bigint
): { readonly absolute: bigint; readonly boundary: Readonly<SourceBoundary> } |
  null {
  // Invoke graph's owner first for complete body/port geometry validation.
  findNextPortalBoundary(body, sourcePort, 0);
  const port = body.ports.find((candidate) => candidate.id === sourcePort);
  if (port === undefined) {
    return null;
  }

  const frameCount = BigInt(body.frameCount);
  if (body.kind !== "loop") {
    const minimumFrame = Number(minimumAbsolute);
    const frame = port.portalFrames.find((portal) => portal >= minimumFrame);
    if (frame === undefined) {
      return null;
    }
    return {
      absolute: BigInt(frame),
      boundary: freezeBoundary({
        type: "portal",
        occurrence: 0n,
        frame,
        wraps: false
      })
    };
  }

  let occurrence = minimumAbsolute / frameCount;
  const minimumFrame = Number(minimumAbsolute % frameCount);
  let frame = port.portalFrames.find((portal) => portal >= minimumFrame);
  if (frame === undefined) {
    occurrence += 1n;
    frame = port.portalFrames[0];
  }
  if (frame === undefined) {
    return null;
  }
  const absolute = occurrence * frameCount + BigInt(frame);
  return {
    absolute,
    boundary: freezeBoundary({
      type: "portal",
      occurrence,
      frame,
      wraps: occurrence > displayedOccurrence
    })
  };
}

function validateBody(body: GraphBodyDefinition): void {
  if (!Number.isSafeInteger(body.frameCount) || body.frameCount <= 0) {
    throw new RangeError("source body frameCount must be a positive safe integer");
  }
  if (body.kind !== "loop" && body.kind !== "finite" && body.kind !== "held") {
    throw new RangeError("source body kind is invalid");
  }
  if (body.kind === "held" && body.frameCount !== 1) {
    throw new RangeError("held source body must contain one frame");
  }
}

function validateCursor(
  body: GraphBodyDefinition,
  cursor: SourceBodyCursor,
  label: string
): void {
  if (typeof cursor.occurrence !== "bigint" || cursor.occurrence < 0n) {
    throw new RangeError(`${label} occurrence must be a non-negative bigint`);
  }
  if (
    !Number.isSafeInteger(cursor.frame) ||
    cursor.frame < 0 ||
    cursor.frame >= body.frameCount
  ) {
    throw new RangeError(`${label} frame is out of range`);
  }
  if (body.kind !== "loop" && cursor.occurrence !== 0n) {
    throw new RangeError(`${label} must remain in occurrence zero`);
  }
}

function cursorAbsolute(
  body: GraphBodyDefinition,
  cursor: Pick<SourceBodyCursor, "occurrence" | "frame">
): bigint {
  return cursor.occurrence * BigInt(body.frameCount) + BigInt(cursor.frame);
}

function cursorFromAbsolute(
  body: GraphBodyDefinition,
  absolute: bigint
): SourceBodyCursor {
  if (body.kind !== "loop") {
    return { occurrence: 0n, frame: Number(absolute) };
  }
  const frameCount = BigInt(body.frameCount);
  return {
    occurrence: absolute / frameCount,
    frame: Number(absolute % frameCount)
  };
}

function freezeBoundary(boundary: SourceBoundary): Readonly<SourceBoundary> {
  return Object.freeze({
    type: boundary.type,
    occurrence: boundary.occurrence,
    frame: boundary.frame,
    wraps: boundary.wraps
  });
}

function freezeCursor(cursor: SourceBodyCursor): Readonly<SourceBodyCursor> {
  return Object.freeze({
    occurrence: cursor.occurrence,
    frame: cursor.frame
  });
}

function rejectMaxWait(
  requiredWaitFrames: bigint,
  maxWaitFrames: number,
  lead: Readonly<EdgeLeadPlan> | null
): Readonly<SubmissionHorizonDecision> {
  return Object.freeze({
    kind: "reject-readiness",
    reason: "max-wait-exceeded",
    requiredWaitFrames,
    maxWaitFrames,
    lead
  });
}

function rejectNoBoundary(
  maxWaitFrames: number,
  lead: Readonly<EdgeLeadPlan> | null
): Readonly<SubmissionHorizonDecision> {
  return Object.freeze({
    kind: "reject-readiness",
    reason: "no-reachable-boundary",
    requiredWaitFrames: BigInt(maxWaitFrames) + 1n,
    maxWaitFrames,
    lead
  });
}

function validateNonNegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
}

function maximumBigInt(left: bigint, right: bigint): bigint {
  return left > right ? left : right;
}

function minimumBigInt(left: bigint, right: bigint): bigint {
  return left < right ? left : right;
}
