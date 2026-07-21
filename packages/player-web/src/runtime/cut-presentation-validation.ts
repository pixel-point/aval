import type { IntegratedPlaybackTickContext } from "./integrated-player-contracts.js";
import type { RuntimeFailureCode } from "./errors.js";
import { graphBodyFrameAt } from "./body-frame-semantics.js";
import {
  CutPresentationInvariantError,
  type CutActivationInput,
  type CutFrameMedia,
  type CutPresentationCoordinatorOptions
} from "./cut-presentation-contracts.js";

const MIN_RUNWAY_FRAMES = 6;
const MAX_RUNWAY_FRAMES = 12;
export const DEFAULT_CUT_STREAMING_SLOTS = 3;

export function validateCutPresentationOptions(
  options: CutPresentationCoordinatorOptions
): void {
  if (options === null || typeof options !== "object") {
    throw new TypeError("cut presentation options must be an object");
  }
  if (
    options.scheduler === null ||
    typeof options.scheduler !== "object" ||
    typeof options.scheduler.stageResidentRunway !== "function" ||
    typeof options.scheduler.commitResidentRunway !== "function" ||
    typeof options.scheduler.rollbackResidentRunway !== "function" ||
    typeof options.scheduler.pump !== "function" ||
    typeof options.scheduler.takeNext !== "function" ||
    typeof options.scheduler.takeStreamingContinuation !== "function" ||
    typeof options.scheduler.commitResidentPresentation !== "function" ||
    typeof options.scheduler.commitPreparedPresentation !== "function" ||
    typeof options.scheduler.discardPreparedPresentation !== "function" ||
    typeof options.scheduler.snapshot !== "function"
  ) {
    throw new TypeError("cut presentation requires a path scheduler");
  }
  if (
    options.renderer === null ||
    typeof options.renderer !== "object" ||
    typeof options.renderer.resourceGeneration !== "number" ||
    typeof options.renderer.residentHandle !== "function" ||
    typeof options.renderer.uploadStreaming !== "function" ||
    typeof options.renderer.draw !== "function"
  ) {
    throw new TypeError("cut presentation requires an frame renderer");
  }
  const slots = options.streamingSlots ?? DEFAULT_CUT_STREAMING_SLOTS;
  if (!Number.isSafeInteger(slots) || slots < 1) {
    throw new RangeError("cut presentation streaming slots must be positive");
  }
  const firstSlot = options.firstStreamingSlot ?? 0;
  if (
    !Number.isSafeInteger(firstSlot) ||
    firstSlot < 0 ||
    firstSlot >= slots
  ) {
    throw new RangeError("cut first streaming slot must fit its slot count");
  }
  if (
    options.handoffAfterFirstStreaming !== undefined &&
    typeof options.handoffAfterFirstStreaming !== "boolean"
  ) {
    throw new TypeError("cut streaming handoff flag must be boolean");
  }
  if (typeof options.enqueueMediaOperation !== "function") {
    throw new TypeError("cut media-operation scheduler must be a function");
  }
  if (
    options.onStaticRecovery !== undefined &&
    typeof options.onStaticRecovery !== "function"
  ) {
    throw new TypeError("cut static-recovery sink must be a function");
  }
  if (
    options.readbackTag !== undefined &&
    typeof options.readbackTag !== "function"
  ) {
    throw new TypeError("cut readback tagger must be a function");
  }
}

export function validateCutActivationInput(
  input: Readonly<CutActivationInput>
): Readonly<CutActivationInput> {
  if (input === null || typeof input !== "object") {
    throw new TypeError("cut activation input must be an object");
  }
  if (
    input.edge === null ||
    typeof input.edge !== "object" ||
    (input.entryMode === "endpoint"
      ? input.edge.transition?.kind !== "reversible"
      : input.edge.continuity !== "cut" ||
        input.edge.start.type !== "cut" ||
        input.edge.transition !== undefined)
  ) {
    throw new RangeError(
      "resident runway activation requires a cut or reversible endpoint edge"
    );
  }
  if (
    input.entryMode !== undefined &&
    input.entryMode !== "cut" &&
    input.entryMode !== "endpoint"
  ) throw new RangeError("resident runway entry mode is invalid");
  validateId(input.edge.id, "cut edge");
  validateId(input.targetState, "cut target state");
  validateId(input.path, "cut path");
  if (
    input.entryMode === "endpoint"
      ? input.edge.to !== input.targetState &&
        input.edge.from !== input.targetState
      : input.edge.to !== input.targetState
  ) {
    throw new RangeError("cut edge target and runway target state diverged");
  }
  if (
    input.targetBody === null ||
    typeof input.targetBody !== "object" ||
    !Number.isSafeInteger(input.targetBody.frameCount) ||
    input.targetBody.frameCount < 1
  ) {
    throw new RangeError("cut target body is invalid");
  }
  if (
    !Array.isArray(input.runway) ||
    input.runway.length < MIN_RUNWAY_FRAMES ||
    input.runway.length > MAX_RUNWAY_FRAMES
  ) {
    throw new RangeError("cut resident runway must contain 6-12 frames");
  }
  for (let index = 0; index < input.runway.length; index += 1) {
    const value = input.runway[index]!;
    if (
      value === null ||
      typeof value !== "object" ||
      !Number.isSafeInteger(value.layer) ||
      value.layer < 0 ||
      !Number.isSafeInteger(value.unitInstance) ||
      value.unitInstance < 0 ||
      !Number.isSafeInteger(value.decodeOrdinal) ||
      value.decodeOrdinal < 0 ||
      !Number.isSafeInteger(value.timestamp) ||
      value.timestamp < 0
    ) {
      throw new RangeError("cut resident runway metadata is invalid");
    }
    const expected = graphBodyFrameAt(input.targetBody, index);
    if (
      value.frame.unit !== input.targetBody.unitId ||
      value.frame.localFrame !== expected
    ) {
      throw new RangeError("cut resident runway identity is not contiguous");
    }
  }
  const continuation = input.continuationTargetFrames ?? 1;
  if (!Number.isSafeInteger(continuation) || continuation < 1) {
    throw new RangeError("cut continuation target must be positive");
  }
  if (
    input.firstPresentationOrdinal !== undefined &&
    input.firstPresentationOrdinal < 0n
  ) {
    throw new RangeError("cut first presentation ordinal must be non-negative");
  }
  if (
    input.completionStart !== undefined &&
    (typeof input.completionStart !== "boolean" ||
      (input.completionStart && input.edge.trigger?.type !== "completion"))
  ) {
    throw new RangeError("cut completion-start evidence is invalid");
  }
  return Object.freeze({
    ...input,
    runway: Object.freeze([...input.runway])
  });
}

export function validateCutTickContext(
  context: Readonly<IntegratedPlaybackTickContext>
): void {
  if (
    context === null ||
    typeof context !== "object" ||
    typeof context.presentationOrdinal !== "bigint" ||
    context.presentationOrdinal < 1n
  ) {
    throw new CutPresentationInvariantError(
      "cut presentation ordinal must be a positive bigint"
    );
  }
}

export function graphCanConsumeCut(
  context: Readonly<IntegratedPlaybackTickContext>,
  active: Readonly<{
    readonly edge: { readonly id: string; readonly from: string };
    readonly targetState: string;
    readonly entryMode?: "cut" | "endpoint";
    readonly completionStart?: boolean;
  }>,
  residentPresented: number
): boolean {
  const graph = context.graphSnapshot;
  if (graph.readiness !== "animated") return false;
  if (residentPresented === 0) {
    if (
      active.completionStart &&
      graph.phase === "stable" &&
      graph.presentation?.kind === "body" &&
      graph.presentation.state === active.edge.from
    ) return true;
    if (active.entryMode === "endpoint") {
      // A downstream follow-on changes requestedState but retains this active
      // reversible edge. A true inverse changes activeEdgeId and is rejected.
      return graph.activeEdgeId === active.edge.id;
    }
    return graph.pendingEdgeId === active.edge.id &&
      graph.requestedState === active.targetState;
  }
  // Once entry has committed, a follow-on request may legitimately change
  // requestedState while this runway still owns visible target pixels.
  return graph.visualState === active.targetState;
}

export function rebindCutOrdinal(
  media: Readonly<CutFrameMedia>,
  intendedPresentationOrdinal: bigint
): Readonly<CutFrameMedia> {
  return media.intendedPresentationOrdinal === intendedPresentationOrdinal
    ? media
    : Object.freeze({ ...media, intendedPresentationOrdinal });
}

export function cutWorkerFailureCode(error: unknown): RuntimeFailureCode {
  return error instanceof Error && error.name.includes("Watchdog")
    ? "watchdog-timeout"
    : error instanceof DOMException && error.name === "AbortError"
      ? "abort"
      : "worker-decode-failure";
}

export function checkedCutIncrement(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER) {
    throw new RangeError(`${label} exhausted its safe integer range`);
  }
  return value + 1;
}

function validateId(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length < 1) {
    throw new RangeError(`${label} must be a non-empty string`);
  }
}
