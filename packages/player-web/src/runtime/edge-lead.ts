import { validatePresentationRingCapacity } from "./presentation-ring.js";

export interface RequiredEdgeLeadInput {
  /** Zero for a transitionless edge; otherwise the complete locked bridge. */
  readonly transitionFrames: number;
  readonly ringCapacity: number;
}

export interface EdgeLeadInput extends RequiredEdgeLeadInput {
  readonly availableConsecutiveFrames: number;
}

export interface EdgeLeadPlan {
  readonly transitionFrames: number;
  /** Number of presentations before target body frame zero. */
  readonly targetEntryOffset: number;
  readonly firstPresentation: "bridge" | "target-body";
  readonly requiredConsecutiveFrames: number;
  readonly availableConsecutiveFrames: number;
  readonly missingConsecutiveFrames: number;
  readonly ready: boolean;
}

/** Sole owner of the M5.5 locked/transitionless consecutive-lead formula. */
export function calculateRequiredEdgeLeadFrames(
  input: RequiredEdgeLeadInput
): number {
  validatePresentationRingCapacity(input.ringCapacity);
  validateNonNegativeSafeInteger(
    input.transitionFrames,
    "transition frame count"
  );
  if (input.transitionFrames >= Number.MAX_SAFE_INTEGER) {
    throw new RangeError("transition frame count leaves no safe successor");
  }

  const sequenceThroughTargetEntry = input.transitionFrames + 1;
  return sequenceThroughTargetEntry <= input.ringCapacity
    ? Math.max(2, sequenceThroughTargetEntry)
    : input.ringCapacity;
}

export function planEdgeLead(input: EdgeLeadInput): Readonly<EdgeLeadPlan> {
  const requiredConsecutiveFrames = calculateRequiredEdgeLeadFrames(input);
  validateNonNegativeSafeInteger(
    input.availableConsecutiveFrames,
    "available consecutive frame count"
  );
  if (input.availableConsecutiveFrames > input.ringCapacity) {
    throw new RangeError(
      "available consecutive frame count exceeds the presentation ring"
    );
  }

  const missingConsecutiveFrames = Math.max(
    0,
    requiredConsecutiveFrames - input.availableConsecutiveFrames
  );
  return Object.freeze({
    transitionFrames: input.transitionFrames,
    targetEntryOffset: input.transitionFrames,
    firstPresentation:
      input.transitionFrames === 0 ? "target-body" : "bridge",
    requiredConsecutiveFrames,
    availableConsecutiveFrames: input.availableConsecutiveFrames,
    missingConsecutiveFrames,
    ready: missingConsecutiveFrames === 0
  });
}

function validateNonNegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
}
