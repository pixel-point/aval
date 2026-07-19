import {
  sameGraphPresentation,
  type GraphPresentation,
  type MotionGraphSnapshot,
  type ValidatedMotionGraph
} from "@pixel-point/aval-graph";

import {
  RuntimePlaybackError,
  isRuntimePlaybackError,
  normalizeRuntimeFailure,
  type RuntimeFailure,
  type RuntimeFailureCode
} from "./errors.js";
import {
  IntegratedPlaybackInvariantError,
  type IntegratedCandidateAttempt,
  type IntegratedContentTickContext,
  type IntegratedPlaybackTraceState,
  type IntegratedPreparedActivation,
  type IntegratedPreparedContentTick,
  type IntegratedPlayerOptions,
  type IntegratedRealtimeDriverOptions,
  type IntegratedTimerHost
} from "./integrated-player-contracts.js";
import type { IntegratedStateStore } from "./state-store.js";
import type { RuntimeMediaPresentation } from "./model.js";
import { MOTION_POLICIES } from "./motion-policy.js";
import {
  captureIntegratedPlayerAssetSource,
  type CapturedIntegratedPlayerAssetSource
} from "./integrated-player-asset-session.js";

export const DEFAULT_INTEGRATED_TIMERS: IntegratedTimerHost = Object.freeze({
  setTimeout(callback: () => void, milliseconds: number): number {
    return globalThis.setTimeout(callback, milliseconds) as unknown as number;
  },
  clearTimeout(handle: number): void {
    globalThis.clearTimeout(handle);
  }
});
export const DEFAULT_INTEGRATED_PREPARATION_TIMEOUT_MS = 5_000 as const;

export function disposeInvalidIntegratedStateStore(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  try {
    const dispose = Reflect.get(value, "dispose");
    if (typeof dispose === "function") dispose.call(value);
  } catch {
    // The original constructor validation/factory failure remains stable.
  }
}

export function snapshotIntegratedRealtimeOptions(
  source: Readonly<IntegratedRealtimeDriverOptions>
): Readonly<IntegratedRealtimeDriverOptions> {
  const { requestFrame, cancelFrame, now, onUnderflow } = source;
  return Object.freeze({
    requestFrame,
    cancelFrame,
    ...(now === undefined ? {} : { now }),
    ...(onUnderflow === undefined ? {} : { onUnderflow })
  });
}

export function normalizeIntegratedAnimatedFailure(
  error: unknown,
  defaultCode: RuntimeFailureCode,
  context: Readonly<IntegratedContentTickContext>
): Readonly<RuntimeFailure> {
  if (isRuntimePlaybackError(error)) return error.failure;
  const ordinal = context.presentationOrdinal <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(context.presentationOrdinal)
    : undefined;
  return normalizeRuntimeFailure(
    defaultCode,
    error,
    ordinal === undefined
      ? { operation: "content-tick" }
      : { operation: "content-tick", ordinal }
  );
}

export function integratedReadinessError(
  cause: unknown,
  operation: string
): RuntimePlaybackError {
  return new RuntimePlaybackError(normalizeRuntimeFailure(
    "readiness-failure",
    cause,
    { operation }
  ));
}

export function integratedRealtimeDeadlineUs(deadlineMs: number): number {
  const value = Math.round(deadlineMs * 1_000);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("realtime deadline exceeds integer-microsecond range");
  }
  return value;
}

export function validateIntegratedPlayerOptions(
  options: IntegratedPlayerOptions
): Readonly<CapturedIntegratedPlayerAssetSource> {
  if (options === null || typeof options !== "object") {
    throw new TypeError("integrated player options must be an object");
  }
  const assetSource = captureIntegratedPlayerAssetSource(options);
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
  if (
    options.candidateFactory.resourceHost !== undefined &&
    (
      options.candidateFactory.resourceHost === null ||
      typeof options.candidateFactory.resourceHost !== "object" ||
      typeof options.candidateFactory.resourceHost.currentCanvasBacking !== "function" ||
      typeof options.candidateFactory.resourceHost.reserveCanvasResources !== "function"
    )
  ) {
    throw new TypeError("integrated player resource host is malformed");
  }
  if (
    options.candidateFactory.contextTarget !== undefined &&
    (
      options.candidateFactory.contextTarget === null ||
      typeof options.candidateFactory.contextTarget !== "object" ||
      typeof options.candidateFactory.contextTarget.addEventListener !== "function" ||
      typeof options.candidateFactory.contextTarget.removeEventListener !== "function"
    )
  ) {
    throw new TypeError("integrated player context target is malformed");
  }
  if (options.now !== undefined && typeof options.now !== "function") {
    throw new TypeError("integrated player clock must be a function");
  }
  if (
    options.motionPolicy !== undefined &&
    !MOTION_POLICIES.includes(options.motionPolicy)
  ) {
    throw new TypeError("integrated player motion policy is invalid");
  }
  if (
    options.hostReducedMotion !== undefined &&
    typeof options.hostReducedMotion !== "boolean"
  ) {
    throw new TypeError("integrated host reduced-motion value must be boolean");
  }
  if (
    options.initialVisibility !== undefined &&
    options.initialVisibility !== "visible" &&
    options.initialVisibility !== "hidden"
  ) {
    throw new TypeError("integrated initial visibility is invalid");
  }
  if (
    options.participantBinding !== undefined &&
    (
      options.participantBinding === null ||
      typeof options.participantBinding !== "object" ||
      typeof options.participantBinding.attach !== "function"
    )
  ) {
    throw new TypeError("integrated participant binding is malformed");
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
  return assetSource;
}

export function validateIntegratedStateStore(
  store: IntegratedStateStore
): void {
  if (store === null || typeof store !== "object") {
    throw new TypeError("integrated state store is unavailable");
  }
  for (const method of [
    "installInitial",
    "validateAll",
    "presentState",
    "currentState",
    "settled",
    "dispose"
  ] as const) {
    if (typeof store[method] !== "function") {
      throw new TypeError(`integrated state store is missing ${method}`);
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
  if (state.initialUnit !== undefined) {
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

/** First playable presentation used when leaving settled static mode. */
export function createIntegratedResumePresentation(
  graph: Readonly<ValidatedMotionGraph>,
  snapshot: Readonly<MotionGraphSnapshot>
): Readonly<GraphPresentation> {
  if (
    snapshot.readiness !== "static" ||
    snapshot.phase !== "static" ||
    snapshot.visualState === null ||
    snapshot.requestedState !== snapshot.visualState ||
    snapshot.presentation?.kind !== "static" ||
    snapshot.presentation.state !== snapshot.visualState ||
    snapshot.isTransitioning
  ) {
    throw new IntegratedPlaybackInvariantError(
      "animated re-entry requires one settled static graph state"
    );
  }
  const state = graph.definition.states.find(
    ({ id }) => id === snapshot.visualState
  );
  if (state === undefined) {
    throw new IntegratedPlaybackInvariantError(
      "animated re-entry state is absent from the graph"
    );
  }
  if (
    snapshot.initialUnitPending &&
    state.id === graph.definition.initialState &&
    state.initialUnit !== undefined
  ) {
    return Object.freeze({
      kind: "intro" as const,
      state: state.id,
      unitId: state.initialUnit.unitId,
      frameIndex: 0
    });
  }
  return Object.freeze({
    kind: "body" as const,
    state: state.id,
    unitId: state.body.unitId,
    frameIndex: 0
  });
}

/** Ordinal assigned to the hidden activation draw for one graph snapshot. */
export function integratedActivationPresentationOrdinal(
  snapshot: Readonly<MotionGraphSnapshot>
): bigint {
  return snapshot.contentOrdinal === null
    ? 0n
    : snapshot.contentOrdinal + 1n;
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
  if (
    context.callbackStartMicroseconds !== undefined &&
    (!Number.isSafeInteger(context.callbackStartMicroseconds) ||
      context.callbackStartMicroseconds < 0)
  ) {
    throw new IntegratedPlaybackInvariantError(
      "content callback start must be a non-negative safe integer"
    );
  }
  if (
    context.eligibleAnimationFrameOrdinal !== undefined &&
    context.eligibleAnimationFrameOrdinal !== null &&
    (!Number.isSafeInteger(context.eligibleAnimationFrameOrdinal) ||
      context.eligibleAnimationFrameOrdinal < 1)
  ) {
    throw new IntegratedPlaybackInvariantError(
      "eligible animation-frame ordinal must be a positive safe integer"
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
    (state.readbackTag !== undefined &&
      state.readbackTag !== null &&
      typeof state.readbackTag !== "string") ||
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
    throw new IntegratedPlaybackInvariantError(
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
  if (signal.aborted) {
    // Callers create the operation before entering this helper. Observe a
    // rejection from that already-created promise even though cancellation
    // wins immediately, otherwise it escapes as an unhandled rejection.
    void operation.catch(() => undefined);
    throw integratedAbortReason(signal);
  }
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
