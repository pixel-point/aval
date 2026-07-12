import type { GraphPresentation } from "@rendered-motion/graph";

import {
  RuntimePlaybackError,
  normalizeRuntimeFailure,
  type RuntimeFailureCode
} from "./errors.js";
import {
  IntegratedPlaybackInvariantError,
  type IntegratedCandidateAttemptContext
} from "./integrated-player-contracts.js";
import type {
  OpaqueCandidatePreparedMedia,
  OpaqueCandidateReadinessSession,
  OpaqueCandidateRendererReservation,
  OpaqueCandidateWorker
} from "./opaque-candidate-factory-model.js";
import { OpaqueCandidateOperationControl } from "./opaque-candidate-factory-support.js";
import type { OpaqueFrameRenderer } from "./opaque-frame-renderer.js";

export function validateOpaqueCandidateAttemptContext(
  context: Readonly<IntegratedCandidateAttemptContext>
): void {
  if (
    context === null ||
    typeof context !== "object" ||
    context.catalog === null ||
    typeof context.catalog !== "object" ||
    context.candidate === null ||
    typeof context.candidate !== "object" ||
    context.inspection === null ||
    typeof context.inspection !== "object" ||
    context.graphSnapshot === null ||
    typeof context.graphSnapshot !== "object"
  ) {
    throw new TypeError("opaque candidate attempt context is malformed");
  }
}

export function validateOpaqueCandidateWorker(
  worker: OpaqueCandidateWorker
): void {
  const methods = [
    "configure",
    "activateGeneration",
    "submit",
    "abortGeneration",
    "takeFrame",
    "waitForFrames",
    "snapshotMetrics",
    "dispose"
  ] as const;
  if (worker === null || typeof worker !== "object") {
    throw new TypeError("opaque candidate worker factory returned no worker");
  }
  for (const method of methods) {
    if (typeof worker[method] !== "function") {
      throw new TypeError(`opaque candidate worker is missing ${method}`);
    }
  }
}

export function validateOpaqueRendererReservation(
  reservation: OpaqueCandidateRendererReservation
): void {
  if (
    reservation === null ||
    typeof reservation !== "object" ||
    reservation.limits === null ||
    typeof reservation.limits !== "object" ||
    typeof reservation.allocate !== "function" ||
    typeof reservation.dispose !== "function"
  ) {
    throw new TypeError("opaque candidate renderer reservation is malformed");
  }
}

export function validateOpaqueCandidateRenderer(
  renderer: OpaqueFrameRenderer
): void {
  if (
    renderer === null ||
    typeof renderer !== "object" ||
    typeof renderer.uploadResident !== "function" ||
    typeof renderer.uploadStreaming !== "function" ||
    typeof renderer.draw !== "function" ||
    typeof renderer.dispose !== "function" ||
    typeof renderer.settled !== "function"
  ) {
    throw new TypeError("opaque candidate renderer factory returned no renderer");
  }
}

export function validateOpaqueReadinessSession(
  readiness: OpaqueCandidateReadinessSession
): void {
  if (
    readiness === null ||
    typeof readiness !== "object" ||
    readiness.adapters === null ||
    typeof readiness.adapters !== "object" ||
    typeof readiness.prepareActivation !== "function" ||
    typeof readiness.dispose !== "function" ||
    (readiness.observeResult !== undefined &&
      typeof readiness.observeResult !== "function")
  ) {
    throw new TypeError("opaque candidate readiness session is malformed");
  }
}

export function validateOpaquePreparedMedia(
  prepared: OpaqueCandidatePreparedMedia
): void {
  if (
    prepared === null ||
    typeof prepared !== "object" ||
    prepared.playback === null ||
    typeof prepared.playback !== "object" ||
    typeof prepared.drawInitial !== "function" ||
    typeof prepared.dispose !== "function"
  ) {
    throw new TypeError("opaque candidate prepared media is malformed");
  }
}

export function runOpaqueResourcePhase<T>(
  operation: () => T,
  context: Readonly<IntegratedCandidateAttemptContext>
): T {
  try {
    return operation();
  } catch (error) {
    throw opaquePhaseFailure("resource-rejection", error, context);
  }
}

export function stoppedOrOpaquePhaseFailure(
  control: OpaqueCandidateOperationControl,
  code: RuntimeFailureCode,
  error: unknown,
  context: Readonly<IntegratedCandidateAttemptContext>
): unknown {
  try {
    control.throwIfStopped();
  } catch (stopped) {
    return stopped;
  }
  return opaquePhaseFailure(code, error, context);
}

export function opaquePhaseFailure(
  code: RuntimeFailureCode,
  error: unknown,
  context: Readonly<IntegratedCandidateAttemptContext>
): RuntimePlaybackError {
  if (error instanceof RuntimePlaybackError) return error;
  return new RuntimePlaybackError(normalizeRuntimeFailure(
    code,
    error,
    opaqueCandidateFailureContext(context)
  ));
}

export function opaqueCandidateFailureContext(
  context: Readonly<IntegratedCandidateAttemptContext>
): Readonly<{ readonly rendition: string; readonly rank: number }> {
  return Object.freeze({
    rendition: context.candidate.rendition.id,
    rank: context.candidate.rank
  });
}

export function requireOpaqueOwner<T>(value: T | null, label: string): T {
  if (value === null) {
    throw new IntegratedPlaybackInvariantError(
      `opaque candidate lost its ${label}`
    );
  }
  return value;
}

export function cloneOpaquePresentation(
  presentation: Readonly<GraphPresentation>
): Readonly<GraphPresentation> {
  switch (presentation.kind) {
    case "static":
      return Object.freeze({
        kind: "static",
        state: presentation.state,
        staticFrameId: presentation.staticFrameId
      });
    case "intro":
    case "body":
      return Object.freeze({
        kind: presentation.kind,
        state: presentation.state,
        unitId: presentation.unitId,
        frameIndex: presentation.frameIndex
      });
    case "locked":
      return Object.freeze({
        kind: "locked",
        edgeId: presentation.edgeId,
        unitId: presentation.unitId,
        frameIndex: presentation.frameIndex
      });
    case "reversible":
      return Object.freeze({
        kind: "reversible",
        edgeId: presentation.edgeId,
        unitId: presentation.unitId,
        frameIndex: presentation.frameIndex,
        direction: presentation.direction
      });
  }
}
