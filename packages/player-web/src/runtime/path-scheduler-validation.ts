import type { GraphBodyDefinition } from "@rendered-motion/graph";

import type { DecoderWorkerLimits } from "../decoder-worker/protocol.js";
import type {
  PathSchedulerResidentFrame,
  StartResidentRunwayInput
} from "./path-scheduler-model.js";
import { graphBodyFrameAt } from "./body-frame-semantics.js";

const MIN_RESIDENT_RUNWAY_FRAMES = 6;
const MAX_RESIDENT_RUNWAY_FRAMES = 12;

export function validateScheduledBody(body: GraphBodyDefinition): void {
  validateSchedulerId(body.unitId, "scheduled body unit");
  if (!Number.isSafeInteger(body.frameCount) || body.frameCount < 1) {
    throw new RangeError("scheduled body frame count must be positive");
  }
  if (body.kind === "held" && body.frameCount !== 1) {
    throw new RangeError("held scheduled body must contain one frame");
  }
}

export function validateResidentRunway(
  input: Readonly<StartResidentRunwayInput>,
  rendition: string
): void {
  validateSchedulerId(input.edgeId, "resident edge");
  validateSchedulerId(input.targetState, "resident target state");
  validateSchedulerId(input.path, "resident path");
  validateScheduledBody(input.targetBody);
  if (
    input.frames.length < MIN_RESIDENT_RUNWAY_FRAMES ||
    input.frames.length > MAX_RESIDENT_RUNWAY_FRAMES
  ) {
    throw new RangeError("resident runway must contain 6-12 frames");
  }
  for (let index = 0; index < input.frames.length; index += 1) {
    const frame = input.frames[index]!;
    validateResidentFrame(frame);
    const expectedLocalFrame = graphBodyFrameAt(input.targetBody, index);
    if (
      frame.frame.rendition !== rendition ||
      frame.frame.unit !== input.targetBody.unitId ||
      frame.frame.localFrame !== expectedLocalFrame
    ) {
      throw new RangeError(
        "resident runway frame does not match the selected target body"
      );
    }
  }
}

export function validateSchedulerLimits(limits: DecoderWorkerLimits): void {
  for (const [label, value] of [
    ["decode queue", limits.maxDecodeQueueSize],
    ["pending samples", limits.maxPendingSamples],
    ["outstanding frames", limits.maxOutstandingFrames],
    ["decoded bytes", limits.maxDecodedBytes]
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new RangeError(`${label} limit must be a positive safe integer`);
    }
  }
}

export function validateSchedulerId(value: string, label: string): void {
  if (typeof value !== "string" || value.length < 1 || value.length > 128) {
    throw new RangeError(`${label} length must be 1-128`);
  }
}

function validateResidentFrame(frame: PathSchedulerResidentFrame): void {
  validateSchedulerId(frame.frame.rendition, "resident rendition");
  validateSchedulerId(frame.frame.unit, "resident unit");
  validateNonNegativeInteger(frame.frame.localFrame, "resident local frame");
  validateNonNegativeInteger(frame.unitInstance, "resident unit instance");
  validateNonNegativeInteger(frame.decodeOrdinal, "resident decode ordinal");
  validateNonNegativeInteger(frame.timestamp, "resident timestamp");
}

function validateNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
}
