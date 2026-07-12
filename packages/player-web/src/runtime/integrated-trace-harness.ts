import type { MotionGraphResult } from "@rendered-motion/graph";

import type {
  IntegratedContentTickContext,
  IntegratedPlaybackTraceState,
  IntegratedPreparedContentTick
} from "./integrated-player-contracts.js";
import {
  RUNTIME_TRACE_CAPACITY,
  type RuntimeGraphTrace,
  type RuntimeReadiness,
  type RuntimeTraceCounters,
  type RuntimeTraceRecord
} from "./model.js";

interface IntegratedOperationTraceInput {
  readonly result: Readonly<MotionGraphResult>;
  readonly playback: Readonly<IntegratedPlaybackTraceState>;
  readonly readiness: RuntimeReadiness;
}

interface IntegratedContentTraceInput {
  readonly context: Readonly<IntegratedContentTickContext>;
  readonly result: Readonly<MotionGraphResult>;
  readonly prepared: Readonly<IntegratedPreparedContentTick>;
  readonly readbackTag: string | null;
  readonly callbackStartMicroseconds: number;
  readonly canvasSubmissionCompleteMicroseconds: number | null;
  readonly eligibleAnimationFrameOrdinal: number | null;
  readonly readiness: RuntimeReadiness;
}

interface IntegratedUnderflowTraceInput {
  readonly context: Readonly<IntegratedContentTickContext>;
  readonly playback: Readonly<IntegratedPlaybackTraceState>;
  readonly callbackStartMicroseconds: number;
  readonly eligibleAnimationFrameOrdinal: number | null;
  readonly readiness: RuntimeReadiness;
}

/** Exact, handle-free, bounded agreement trace for integrated operations. */
export class IntegratedTraceHarness {
  readonly #records: Readonly<RuntimeTraceRecord>[] = [];
  #nextIndex = 0;
  #underflows = 0;
  #fallbacks = 0;
  #settledRequests = 0;
  #cleanedFrames = 0;

  public recordOperation(input: IntegratedOperationTraceInput): void {
    this.#updateGraphCounters(input.result);
    this.#append({
      kind: operationKind(input.result),
      presentationOrdinal: null,
      rationalDeadlineUs: null,
      callbackStartMicroseconds: null,
      canvasSubmissionCompleteMicroseconds: null,
      eligibleAnimationFrameOrdinal: null,
      graph: graphTrace(input.result),
      routeReady: null,
      selectedBoundary: input.playback.selectedBoundary,
      scheduler: input.playback.scheduler,
      submitted: cloneSubmitted(input.playback.submitted),
      media: null,
      readbackTag: null,
      readiness: input.readiness,
      decodeLeadFrames: input.playback.decodeLeadFrames,
      settledRequestIds: settledRequestIds(input.result),
      counters: this.#counters()
    });
  }

  public recordContentTick(input: IntegratedContentTraceInput): void {
    this.#updateGraphCounters(input.result);
    this.#append({
      kind: "content-tick",
      presentationOrdinal: input.context.presentationOrdinal,
      rationalDeadlineUs: input.context.rationalDeadlineUs,
      callbackStartMicroseconds: input.callbackStartMicroseconds,
      canvasSubmissionCompleteMicroseconds: input.canvasSubmissionCompleteMicroseconds,
      eligibleAnimationFrameOrdinal: input.eligibleAnimationFrameOrdinal,
      graph: graphTrace(input.result),
      routeReady: input.prepared.routeReady,
      selectedBoundary: input.prepared.selectedBoundary,
      scheduler: input.prepared.scheduler,
      submitted: cloneSubmitted(input.prepared.submitted),
      media: input.prepared.media,
      readbackTag: input.readbackTag,
      readiness: input.readiness,
      decodeLeadFrames: input.prepared.decodeLeadFrames,
      settledRequestIds: settledRequestIds(input.result),
      counters: this.#counters()
    });
  }

  public recordUnderflow(input: IntegratedUnderflowTraceInput): void {
    this.#underflows = checkedIncrement(this.#underflows, "underflow trace count");
    this.#append({
      kind: "content-tick",
      presentationOrdinal: input.context.presentationOrdinal,
      rationalDeadlineUs: input.context.rationalDeadlineUs,
      callbackStartMicroseconds: input.callbackStartMicroseconds,
      canvasSubmissionCompleteMicroseconds: null,
      eligibleAnimationFrameOrdinal: input.eligibleAnimationFrameOrdinal,
      graph: null,
      routeReady: null,
      selectedBoundary: input.playback.selectedBoundary,
      scheduler: input.playback.scheduler,
      submitted: cloneSubmitted(input.playback.submitted),
      media: null,
      readbackTag: null,
      readiness: input.readiness,
      decodeLeadFrames: input.playback.decodeLeadFrames,
      settledRequestIds: Object.freeze([]),
      counters: this.#counters()
    });
  }

  public recordCleanedFrames(count: number): void {
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new RangeError("cleaned frame count must be a non-negative integer");
    }
    this.#cleanedFrames = checkedAdd(
      this.#cleanedFrames,
      count,
      "cleaned frame trace count"
    );
  }

  public getTrace(): readonly Readonly<RuntimeTraceRecord>[] {
    return Object.freeze([...this.#records]);
  }

  #updateGraphCounters(result: Readonly<MotionGraphResult>): void {
    for (const effect of result.effects) {
      if (effect.type === "fallback") {
        this.#fallbacks = checkedIncrement(this.#fallbacks, "fallback count");
      } else if (effect.type === "settle") {
        this.#settledRequests = checkedAdd(
          this.#settledRequests,
          effect.requestIds.length,
          "settled request count"
        );
      }
    }
  }

  #counters(): Readonly<RuntimeTraceCounters> {
    return Object.freeze({
      underflows: this.#underflows,
      fallbacks: this.#fallbacks,
      settledRequests: this.#settledRequests,
      cleanedFrames: this.#cleanedFrames
    });
  }

  #append(input: Omit<RuntimeTraceRecord, "index">): void {
    if (this.#nextIndex >= Number.MAX_SAFE_INTEGER) {
      throw new RangeError("integrated trace index leaves no safe successor");
    }
    this.#records.push(Object.freeze({ index: this.#nextIndex, ...input }));
    this.#nextIndex += 1;
    if (this.#records.length > RUNTIME_TRACE_CAPACITY) {
      this.#records.shift();
    }
  }
}

function operationKind(
  result: Readonly<MotionGraphResult>
): RuntimeTraceRecord["kind"] {
  if (result.operation === "recover-static" || result.operation === "begin-static") {
    return "fallback";
  }
  if (result.operation === "begin-animated") return "readiness";
  if (result.operation === "dispose") return "cleanup";
  return "operation";
}

function graphTrace(
  result: Readonly<MotionGraphResult>
): Readonly<RuntimeGraphTrace> {
  return Object.freeze({
    operation: result.operation,
    snapshot: result.snapshot,
    presentation: result.presentation,
    effects: result.effects
  });
}

function settledRequestIds(
  result: Readonly<MotionGraphResult>
): readonly number[] {
  const ids = result.effects.flatMap((effect) =>
    effect.type === "settle" ? effect.requestIds : []
  );
  return Object.freeze(ids);
}

function cloneSubmitted(
  submitted: readonly { readonly path: string; readonly unit: string;
    readonly unitInstance: number; readonly localFrame: number }[]
) {
  return Object.freeze(submitted.map((cursor) => Object.freeze({ ...cursor })));
}

function checkedIncrement(value: number, label: string): number {
  return checkedAdd(value, 1, label);
}

function checkedAdd(left: number, right: number, label: string): number {
  if (
    !Number.isSafeInteger(left) ||
    !Number.isSafeInteger(right) ||
    left < 0 ||
    right < 0 ||
    left > Number.MAX_SAFE_INTEGER - right
  ) {
    throw new RangeError(`${label} exceeded the safe-integer range`);
  }
  return left + right;
}
