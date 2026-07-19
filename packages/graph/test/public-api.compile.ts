import type {
  GraphSettlementError,
  MotionGraphEffect,
  MotionGraphErrorCode,
  MotionGraphOperation,
  MotionGraphPlaybackFailureOptions,
  MotionGraphStaticReason
} from "@pixel-point/aval-graph";
import {
  MOTION_GRAPH_STATIC_REASONS,
  MotionGraphEngine
} from "@pixel-point/aval-graph";

declare const engine: MotionGraphEngine;

const options: MotionGraphPlaybackFailureOptions = {
  retainedVisualState: "idle"
};
const settlementError: GraphSettlementError = "PlaybackError";
const operation: MotionGraphOperation = "fail-playback";
const errorCode: MotionGraphErrorCode = "PLAYBACK_ERROR";
const staticReason: MotionGraphStaticReason = "decoder-queued";

engine.failPlayback("renderer stopped", options);
engine.beginStatic(staticReason);
engine.recoverStatic("visibility-suspended");
MOTION_GRAPH_STATIC_REASONS satisfies readonly [
  "reduced-motion",
  "visibility-suspended",
  "decoder-queued"
];
void settlementError;
void operation;
void errorCode;
void staticReason;

// @ts-expect-error terminal failures are not graph static policy reasons
engine.beginStatic("codec-unsupported");
// @ts-expect-error arbitrary recovery strings are rejected by the public contract
engine.recoverStatic("visibility-hidden");

const fallbackEffect: MotionGraphEffect = {
  // @ts-expect-error fallback effects are not part of the graph contract
  type: "fallback",
  reason: "renderer stopped"
};
void fallbackEffect;

// @ts-expect-error terminal playback failure is no longer static-specific
engine.failStatic("renderer stopped", options);
// @ts-expect-error the settlement name is generic playback failure
const removedSettlementError: GraphSettlementError = "PlaybackFallbackError";
void removedSettlementError;
// @ts-expect-error the operation name is generic playback failure
const removedOperation: MotionGraphOperation = "fail-static";
void removedOperation;
// @ts-expect-error the error code is generic playback failure
const removedErrorCode: MotionGraphErrorCode = "PLAYBACK_FALLBACK";
void removedErrorCode;
// @ts-expect-error the old failure-options name is not exported
export type { MotionGraphStaticFailureOptions } from "@pixel-point/aval-graph";
