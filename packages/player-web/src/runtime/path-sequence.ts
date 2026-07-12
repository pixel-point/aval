import type {
  GraphBodyDefinition,
  GraphEdgeDefinition
} from "@rendered-motion/graph";

import type { PathSchedulerFramePurpose } from "./path-scheduler-model.js";
import type {
  SourceBodyCursor,
  SourceBoundary
} from "./submission-horizon.js";

export interface ScheduledPathRoute {
  readonly edge: GraphEdgeDefinition;
  readonly targetState: string;
  readonly targetBody: GraphBodyDefinition;
  readonly boundary: Readonly<SourceBoundary>;
}

export interface ResidentPathTarget {
  readonly edgeId: string;
  readonly targetState: string;
  readonly targetBody: GraphBodyDefinition;
}

export interface PathSequenceState {
  phase: "source" | "bridge" | "target" | "done";
  sourceNext: SourceBodyCursor | null;
  sourceStop: SourceBodyCursor | null;
  sourceDiscardBefore: SourceBodyCursor | null;
  bridgeNextFrame: number;
  targetNext: SourceBodyCursor | null;
  targetDiscardRemaining: number;
  nextPresentationOrdinal: bigint;
  edgeSubmissionStarted: boolean;
}

export interface PathFramePlan {
  readonly purpose: PathSchedulerFramePurpose;
  readonly unitId: string;
  readonly unitFrame: number;
  readonly state: string | null;
  readonly edge: string | null;
  readonly graphKind: "body" | "locked";
  readonly sourceCursor: Readonly<SourceBodyCursor> | null;
  readonly targetCursor: Readonly<SourceBodyCursor> | null;
  readonly discard: boolean;
  readonly intendedPresentationOrdinal: bigint | null;
}

export interface PathSequenceContext {
  readonly sourceState: string | null;
  readonly sourceBody: GraphBodyDefinition | null;
  readonly route: ScheduledPathRoute | null;
  readonly residentTarget: ResidentPathTarget | null;
  readonly canSubmitSource: (cursor: Readonly<SourceBodyCursor>) => boolean;
}

export function createSourcePathSequence(
  firstPresentationOrdinal: bigint
): PathSequenceState {
  return {
    phase: "source",
    sourceNext: { occurrence: 0n, frame: 0 },
    sourceStop: null,
    sourceDiscardBefore: null,
    bridgeNextFrame: 0,
    targetNext: null,
    targetDiscardRemaining: 0,
    nextPresentationOrdinal: firstPresentationOrdinal,
    edgeSubmissionStarted: false
  };
}

export function createReplacementPathSequence(input: {
  readonly nextSource: Readonly<SourceBodyCursor>;
  readonly firstPresentationOrdinal: bigint;
}): PathSequenceState {
  return {
    phase: "source",
    sourceNext: { occurrence: input.nextSource.occurrence, frame: 0 },
    sourceStop: null,
    sourceDiscardBefore: { ...input.nextSource },
    bridgeNextFrame: 0,
    targetNext: null,
    targetDiscardRemaining: 0,
    nextPresentationOrdinal: input.firstPresentationOrdinal,
    edgeSubmissionStarted: false
  };
}

export function createResidentContinuationSequence(input: {
  readonly runwayFrames: number;
  readonly targetBody: Readonly<GraphBodyDefinition>;
  readonly firstStreamingPresentationOrdinal: bigint;
}): PathSequenceState {
  return {
    phase: "target",
    sourceNext: null,
    sourceStop: null,
    sourceDiscardBefore: null,
    bridgeNextFrame: 0,
    targetNext: { occurrence: 0n, frame: 0 },
    targetDiscardRemaining: input.targetBody.kind === "loop"
      ? input.runwayFrames
      : Math.min(input.runwayFrames, input.targetBody.frameCount - 1),
    nextPresentationOrdinal: input.firstStreamingPresentationOrdinal,
    edgeSubmissionStarted: false
  };
}

export function clonePathSequenceState(
  state: PathSequenceState
): PathSequenceState {
  return {
    phase: state.phase,
    sourceNext: cloneSourceCursor(state.sourceNext),
    sourceStop: cloneSourceCursor(state.sourceStop),
    sourceDiscardBefore: cloneSourceCursor(state.sourceDiscardBefore),
    bridgeNextFrame: state.bridgeNextFrame,
    targetNext: cloneSourceCursor(state.targetNext),
    targetDiscardRemaining: state.targetDiscardRemaining,
    nextPresentationOrdinal: state.nextPresentationOrdinal,
    edgeSubmissionStarted: state.edgeSubmissionStarted
  };
}

export function buildNextPathFrame(
  state: PathSequenceState,
  context: PathSequenceContext
): Readonly<PathFramePlan> | null {
  while (true) {
    if (state.phase === "source") {
      const body = context.sourceBody;
      const current = state.sourceNext;
      if (body === null) {
        state.phase = "done";
        continue;
      }
      if (current === null) {
        if (context.route !== null && state.sourceStop !== null) {
          switchToEdge(state, context.route);
        } else {
          state.phase = "done";
        }
        continue;
      }
      if (
        state.sourceStop !== null &&
        compareSourceCursor(body, current, state.sourceStop) > 0
      ) {
        switchToEdge(state, context.route);
        continue;
      }
      const discard = state.sourceDiscardBefore !== null &&
        compareSourceCursor(body, current, state.sourceDiscardBefore) < 0;
      if (
        context.route === null &&
        !discard &&
        !context.canSubmitSource(current)
      ) {
        return null;
      }
      const intended = discard ? null : state.nextPresentationOrdinal;
      if (!discard) state.nextPresentationOrdinal += 1n;
      const plan = freezePathFramePlan({
        purpose: "source",
        unitId: body.unitId,
        unitFrame: current.frame,
        state: context.sourceState,
        edge: null,
        graphKind: "body",
        sourceCursor: current,
        targetCursor: null,
        discard,
        intendedPresentationOrdinal: intended
      });
      state.sourceNext = nextBodyCursor(body, current);
      return plan;
    }

    if (state.phase === "bridge") {
      const route = context.route;
      const transition = route?.edge.transition;
      if (route === null || transition?.kind !== "locked") {
        state.phase = "target";
        continue;
      }
      if (state.bridgeNextFrame >= transition.frameCount) {
        state.phase = "target";
        state.targetNext = { occurrence: 0n, frame: 0 };
        continue;
      }
      const frame = state.bridgeNextFrame;
      state.bridgeNextFrame += 1;
      const intended = state.nextPresentationOrdinal;
      state.nextPresentationOrdinal += 1n;
      state.edgeSubmissionStarted = true;
      return freezePathFramePlan({
        purpose: "bridge",
        unitId: transition.unitId,
        unitFrame: frame,
        state: null,
        edge: route.edge.id,
        graphKind: "locked",
        sourceCursor: null,
        targetCursor: null,
        discard: false,
        intendedPresentationOrdinal: intended
      });
    }

    if (state.phase === "target") {
      const target = context.route === null
        ? context.residentTarget
        : {
            edgeId: context.route.edge.id,
            targetState: context.route.targetState,
            targetBody: context.route.targetBody
          };
      const cursor = state.targetNext;
      if (target === null || cursor === null) {
        state.phase = "done";
        continue;
      }
      const discard = state.targetDiscardRemaining > 0;
      if (discard) state.targetDiscardRemaining -= 1;
      const intended = discard ? null : state.nextPresentationOrdinal;
      if (!discard) state.nextPresentationOrdinal += 1n;
      const plan = freezePathFramePlan({
        purpose: "target",
        unitId: target.targetBody.unitId,
        unitFrame: cursor.frame,
        state: target.targetState,
        edge: target.edgeId,
        graphKind: "body",
        sourceCursor: null,
        targetCursor: cursor,
        discard,
        intendedPresentationOrdinal: intended
      });
      state.targetNext = nextBodyCursor(target.targetBody, cursor);
      if (state.targetNext === null) {
        if (target.targetBody.frameCount === 1) {
          state.targetNext = {
            occurrence: cursor.occurrence + 1n,
            frame: 0
          };
        } else {
          state.phase = "done";
        }
      }
      return plan;
    }

    return null;
  }
}

export function nextBodyCursor(
  body: GraphBodyDefinition,
  cursor: Readonly<SourceBodyCursor>
): SourceBodyCursor | null {
  if (body.kind === "loop") {
    return cursor.frame + 1 < body.frameCount
      ? { occurrence: cursor.occurrence, frame: cursor.frame + 1 }
      : { occurrence: cursor.occurrence + 1n, frame: 0 };
  }
  return cursor.frame + 1 < body.frameCount
    ? { occurrence: 0n, frame: cursor.frame + 1 }
    : null;
}

export function promoteTargetSequenceToSource(
  state: PathSequenceState,
  body: Readonly<GraphBodyDefinition>
): void {
  if (state.phase !== "target" && state.phase !== "done") {
    throw new RangeError("only a target sequence can become a source sequence");
  }
  // A finite target may already be fully prefetched. Keep a terminal source
  // phase so a completion/finish route can still switch at exhaustion.
  state.phase = "source";
  state.sourceNext = body.kind === "loop"
    ? cloneSourceCursor(state.targetNext)
    : body.kind === "finite" && state.targetNext !== null
      ? { occurrence: 0n, frame: state.targetNext.frame }
      : null;
  state.sourceStop = null;
  state.sourceDiscardBefore = null;
  state.targetNext = null;
  state.targetDiscardRemaining = 0;
  state.edgeSubmissionStarted = false;
}

export function sameSourceCursor(
  left: Pick<SourceBodyCursor, "occurrence" | "frame">,
  right: Pick<SourceBodyCursor, "occurrence" | "frame">
): boolean {
  return left.occurrence === right.occurrence && left.frame === right.frame;
}

function switchToEdge(
  state: PathSequenceState,
  route: ScheduledPathRoute | null
): void {
  const transition = route?.edge.transition;
  if (transition?.kind === "locked") {
    state.phase = "bridge";
    state.bridgeNextFrame = 0;
    return;
  }
  state.phase = "target";
  state.targetNext = { occurrence: 0n, frame: 0 };
}

function compareSourceCursor(
  body: GraphBodyDefinition,
  left: Pick<SourceBodyCursor, "occurrence" | "frame">,
  right: Pick<SourceBodyCursor, "occurrence" | "frame">
): number {
  const frameCount = BigInt(body.frameCount);
  const leftAbsolute = left.occurrence * frameCount + BigInt(left.frame);
  const rightAbsolute = right.occurrence * frameCount + BigInt(right.frame);
  return leftAbsolute < rightAbsolute ? -1 : leftAbsolute > rightAbsolute ? 1 : 0;
}

function cloneSourceCursor(cursor: SourceBodyCursor | null): SourceBodyCursor | null {
  return cursor === null
    ? null
    : { occurrence: cursor.occurrence, frame: cursor.frame };
}

function freezePathFramePlan(plan: PathFramePlan): Readonly<PathFramePlan> {
  return Object.freeze({
    ...plan,
    sourceCursor: plan.sourceCursor === null
      ? null
      : Object.freeze({ ...plan.sourceCursor }),
    targetCursor: plan.targetCursor === null
      ? null
      : Object.freeze({ ...plan.targetCursor })
  });
}
