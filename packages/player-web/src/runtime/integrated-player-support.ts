import type {
  GraphPresentation,
  MotionGraphSnapshot,
  ValidatedMotionGraph
} from "@rendered-motion/graph";

import {
  RuntimePlaybackError,
  normalizeRuntimeFailure,
  type RuntimeFailure
} from "./errors.js";
import {
  IntegratedPlaybackInvariantError,
  PlaybackFallbackError,
  type IntegratedCandidateAttempt,
  type IntegratedContentTickContext,
  type IntegratedPlaybackTraceState,
  type IntegratedPreparedActivation,
  type IntegratedPreparedContentTick,
  type IntegratedPlayerOptions,
  type IntegratedStaticSurfaceStore,
  type IntegratedTimerHost
} from "./integrated-player-contracts.js";
import type { RuntimeMediaPresentation } from "./model.js";

export const DEFAULT_INTEGRATED_TIMERS: IntegratedTimerHost = Object.freeze({
  setTimeout(callback: () => void, milliseconds: number): number {
    return globalThis.setTimeout(callback, milliseconds);
  },
  clearTimeout(handle: number): void {
    globalThis.clearTimeout(handle);
  }
});

export function validateIntegratedPlayerOptions(
  options: IntegratedPlayerOptions
): void {
  if (options === null || typeof options !== "object") {
    throw new TypeError("integrated player options must be an object");
  }
  if (!(options.bytes instanceof Uint8Array)) {
    throw new TypeError("integrated player bytes must be a Uint8Array");
  }
  if (typeof options.createStaticStore !== "function") {
    throw new TypeError("integrated player requires a static-store factory");
  }
  if (
    options.candidateFactory === null ||
    typeof options.candidateFactory !== "object" ||
    typeof options.candidateFactory.create !== "function" ||
    options.candidateFactory.availability === null ||
    typeof options.candidateFactory.availability !== "object" ||
    typeof options.candidateFactory.availability.workerAvailable !== "boolean" ||
    typeof options.candidateFactory.availability.rendererAvailable !== "boolean"
  ) {
    throw new TypeError("integrated player requires a candidate factory");
  }
  if (options.now !== undefined && typeof options.now !== "function") {
    throw new TypeError("integrated player clock must be a function");
  }
  if (
    options.eventSink !== undefined &&
    typeof options.eventSink !== "function"
  ) {
    throw new TypeError("integrated player event sink must be a function");
  }
  if (
    options.diagnosticsSink !== undefined &&
    typeof options.diagnosticsSink !== "function"
  ) {
    throw new TypeError("integrated player diagnostics sink must be a function");
  }
  if (options.timers !== undefined) {
    if (
      typeof options.timers.setTimeout !== "function" ||
      typeof options.timers.clearTimeout !== "function"
    ) {
      throw new TypeError("integrated player timer host is malformed");
    }
  }
  if (options.realtime !== undefined) {
    if (
      options.realtime === null ||
      typeof options.realtime !== "object" ||
      typeof options.realtime.requestFrame !== "function" ||
      typeof options.realtime.cancelFrame !== "function" ||
      (
        options.realtime.now !== undefined &&
        typeof options.realtime.now !== "function"
      ) ||
      (
        options.realtime.onUnderflow !== undefined &&
        typeof options.realtime.onUnderflow !== "function"
      )
    ) {
      throw new TypeError("integrated realtime driver options are malformed");
    }
  }
}

export function validateIntegratedStaticStore(
  store: IntegratedStaticSurfaceStore
): void {
  if (store === null || typeof store !== "object") {
    throw new TypeError("static-store factory returned no store");
  }
  for (const method of [
    "installInitial",
    "validateAll",
    "presentState",
    "coverCurrent",
    "revealAnimated",
    "settled",
    "dispose"
  ] as const) {
    if (typeof store[method] !== "function") {
      throw new TypeError(`integrated static store is missing ${method}`);
    }
  }
}

export function validateIntegratedCandidateAttempt(
  attempt: IntegratedCandidateAttempt
): void {
  if (attempt === null || typeof attempt !== "object") {
    throw new TypeError("candidate factory returned no attempt");
  }
  if (
    typeof attempt.prepare !== "function" ||
    typeof attempt.prepareActivation !== "function" ||
    typeof attempt.drawInitial !== "function" ||
    typeof attempt.dispose !== "function" ||
    attempt.playback === null ||
    typeof attempt.playback !== "object" ||
    typeof attempt.playback.prepareContentTick !== "function" ||
    typeof attempt.playback.drawContentTick !== "function" ||
    typeof attempt.playback.synchronizeGraph !== "function" ||
    typeof attempt.playback.traceState !== "function"
  ) {
    throw new TypeError("candidate attempt is malformed");
  }
}

export function validateIntegratedPreparedActivation(
  activation: Readonly<IntegratedPreparedActivation>,
  expected: Readonly<GraphPresentation>
): void {
  if (
    activation === null ||
    typeof activation !== "object" ||
    !sameGraphPresentation(activation.expectedPresentation, expected)
  ) {
    throw new IntegratedPlaybackInvariantError(
      "candidate activation token did not match the latest graph snapshot"
    );
  }
}

export function createIntegratedActivationPresentation(
  graph: Readonly<ValidatedMotionGraph>,
  snapshot: Readonly<MotionGraphSnapshot>
): Readonly<GraphPresentation> {
  if (
    snapshot.readiness !== "preparing" ||
    snapshot.visualState === null ||
    snapshot.requestedState === null
  ) {
    throw new IntegratedPlaybackInvariantError(
      "animated activation requires the latest preparing graph snapshot"
    );
  }
  const definition = graph.definition;
  const initial = definition.initialState;
  const state = definition.states.find(({ id }) => id === initial);
  if (state === undefined || snapshot.visualState !== initial) {
    throw new IntegratedPlaybackInvariantError(
      "animated activation initial state identity diverged"
    );
  }
  if (snapshot.requestedState === initial && state.initialUnit !== undefined) {
    return Object.freeze({
      kind: "intro",
      state: initial,
      unitId: state.initialUnit.unitId,
      frameIndex: 0
    });
  }
  return Object.freeze({
    kind: "body",
    state: initial,
    unitId: state.body.unitId,
    frameIndex: 0
  });
}

export function assertIntegratedPresentationIdentity(
  graph: Readonly<GraphPresentation>,
  media: Readonly<RuntimeMediaPresentation>,
  presentationOrdinal: bigint
): void {
  if (media.kind !== "frame" || graph.kind === "static") {
    throw new IntegratedPlaybackInvariantError(
      "animated graph/media presentation kinds diverged"
    );
  }
  if (media.intendedPresentationOrdinal !== presentationOrdinal) {
    throw new IntegratedPlaybackInvariantError(
      "prepared media presentation ordinal diverged"
    );
  }
  const state = graph.kind === "body" || graph.kind === "intro"
    ? graph.state
    : null;
  const edge = graph.kind === "locked" || graph.kind === "reversible"
    ? graph.edgeId
    : null;
  if (
    media.graphKind !== graph.kind ||
    media.state !== state ||
    (edge !== null && media.edge !== edge) ||
    media.frame.unit !== graph.unitId ||
    media.frame.localFrame !== graph.frameIndex
  ) {
    throw new IntegratedPlaybackInvariantError(
      "prepared media identity did not match the graph presentation"
    );
  }
}

export function sameGraphPresentation(
  left: Readonly<GraphPresentation> | null,
  right: Readonly<GraphPresentation> | null
): boolean {
  if (left === null || right === null) return left === right;
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case "static":
      return right.kind === "static" &&
        left.state === right.state &&
        left.staticFrameId === right.staticFrameId;
    case "intro":
    case "body":
      return right.kind === left.kind &&
        left.state === right.state &&
        left.unitId === right.unitId &&
        left.frameIndex === right.frameIndex;
    case "locked":
      return right.kind === "locked" &&
        left.edgeId === right.edgeId &&
        left.unitId === right.unitId &&
        left.frameIndex === right.frameIndex;
    case "reversible":
      return right.kind === "reversible" &&
        left.edgeId === right.edgeId &&
        left.unitId === right.unitId &&
        left.frameIndex === right.frameIndex &&
        left.direction === right.direction;
  }
}

export function validateIntegratedContentTickContext(
  context: IntegratedContentTickContext
): void {
  if (
    context === null ||
    typeof context !== "object" ||
    typeof context.presentationOrdinal !== "bigint" ||
    context.presentationOrdinal < 1n
  ) {
    throw new IntegratedPlaybackInvariantError(
      "content presentation ordinal must be a positive bigint"
    );
  }
  if (
    context.rationalDeadlineUs !== null &&
    (!Number.isSafeInteger(context.rationalDeadlineUs) ||
      context.rationalDeadlineUs < 0)
  ) {
    throw new IntegratedPlaybackInvariantError(
      "content rational deadline must be a non-negative safe integer"
    );
  }
}

export function validateIntegratedPlaybackTraceState(
  state: Readonly<IntegratedPlaybackTraceState>
): void {
  if (
    state === null ||
    typeof state !== "object" ||
    state.scheduler === null ||
    typeof state.scheduler !== "object" ||
    !Array.isArray(state.submitted) ||
    (state.selectedBoundary !== null &&
      typeof state.selectedBoundary !== "string") ||
    (state.decodeLeadFrames !== null &&
      (!Number.isSafeInteger(state.decodeLeadFrames) ||
        state.decodeLeadFrames < 0))
  ) {
    throw new IntegratedPlaybackInvariantError(
      "playback trace state is malformed"
    );
  }
}

export function validateIntegratedPreparedContentTick(
  prepared: Readonly<IntegratedPreparedContentTick>
): void {
  validateIntegratedPlaybackTraceState(prepared);
  if (
    typeof prepared.routeReady !== "boolean" ||
    prepared.media === null ||
    typeof prepared.media !== "object"
  ) {
    throw new IntegratedPlaybackInvariantError(
      "prepared content tick is malformed"
    );
  }
}

export function normalizeIntegratedCandidateFailure(
  error: unknown,
  rendition: string,
  rank: number
): Readonly<RuntimeFailure> {
  if (error instanceof RuntimePlaybackError) {
    return normalizeRuntimeFailure(
      error.code,
      error,
      { ...error.failure.context, rendition, rank }
    );
  }
  return normalizeRuntimeFailure("readiness-failure", error, {
    rendition,
    rank
  });
}

export function assertIntegratedStaticPresentation(
  presentation: Readonly<GraphPresentation>,
  state: string
): void {
  if (presentation.kind !== "static" || presentation.state !== state) {
    throw new PlaybackFallbackError(
      "graph/static presentation identity did not match"
    );
  }
}

export function validatePreparationTimeout(value: number): number {
  if (!Number.isFinite(value) || value <= 0 || value > Number.MAX_SAFE_INTEGER) {
    throw new RangeError("preparation timeout must be finite and positive");
  }
  return value;
}

export function validateIntegratedClock(value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError("integrated player clock must be finite and non-negative");
  }
}

export function defaultIntegratedNow(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

export function integratedAbortError(): DOMException {
  return new DOMException("integrated player operation aborted", "AbortError");
}

export function integratedDisposedError(): DOMException {
  return new DOMException("integrated player is disposed", "AbortError");
}

export function integratedAbortReason(signal: AbortSignal): DOMException {
  return signal.reason instanceof DOMException
    ? signal.reason
    : integratedAbortError();
}

export function isIntegratedAbortError(error: unknown): boolean {
  return error instanceof DOMException &&
    (error.name === "AbortError" || error.name === "TimeoutError");
}

export function throwIfIntegratedAborted(signal: AbortSignal): void {
  if (signal.aborted) throw integratedAbortReason(signal);
}

export function neverAbortedIntegratedSignal(): AbortSignal {
  return new AbortController().signal;
}

export async function raceIntegratedAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal
): Promise<T> {
  if (signal.aborted) throw integratedAbortReason(signal);
  let remove = (): void => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    const listener = (): void => reject(integratedAbortReason(signal));
    signal.addEventListener("abort", listener, { once: true });
    remove = () => signal.removeEventListener("abort", listener);
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    remove();
  }
}
