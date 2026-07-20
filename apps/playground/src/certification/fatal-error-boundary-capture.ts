import {
  AvalPlaybackError,
  type AvalDiagnostics,
  type AvalPublicFailure
} from "@pixel-point/aval-element";

const SHA256 = /^[0-9a-f]{64}$/u;
const BOUNDED_TOKEN = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/u;
const FATAL_FAILURE_CODES = new Set([
  "invalid-asset", "load-failure", "range-response-invalid", "entity-changed",
  "integrity-mismatch", "unsupported-profile", "resource-rejection",
  "readiness-failure", "worker-decode-failure", "renderer-failure",
  "context-loss", "watchdog-timeout", "underflow", "invalid-configuration",
  "unsupported-browser", "interaction-target-unavailable",
  "element-cleanup-incomplete"
]);

export interface CapturedFatalErrorEvent {
  readonly generation: number;
  readonly fatal: boolean;
  readonly failure: Readonly<AvalPublicFailure>;
}

export type CapturedPrepareOutcome =
  | Readonly<{ readonly status: "ready" | "timeout"; readonly error: null }>
  | Readonly<{ readonly status: "rejected"; readonly error: unknown }>;

export interface CapturedSourceCleanup {
  readonly elementGeneration: number;
  readonly sourceGeneration: number;
  readonly completed: boolean;
  readonly failureCount: number;
  readonly playerDisposed: boolean;
  readonly participantDisposed: boolean;
  readonly participantRegistered: boolean;
  readonly participantLogicalBytes: number;
  readonly participantActiveLeaseCount: number;
  readonly participantRegisteredCleanupCount: number;
  readonly participantTrackedWorkCount: number;
  readonly participantPendingWaitCount: number;
  readonly participantDecoderTicketCount: number;
  readonly participantDecoderState: string | null;
  readonly workerCount: number;
  readonly openFrames: number;
  readonly pendingRuntimeOperations: number;
  readonly sourceCopiesInFlight: number;
  readonly rendererStagingBytes: number;
  readonly pendingLoads: number;
  readonly activeTransportBodies: number;
  readonly interestedWaiters: number;
  readonly rendererResourceCount: number;
  readonly contextListenerCount: number;
}

export interface FatalErrorBoundaryObservation {
  readonly candidateManifestDigest: string;
  readonly fixtureDigest: string;
  readonly harnessDigest: string;
  readonly runId: string;
  readonly profileId: string;
  readonly environmentDigest: string;
  readonly sourceGeneration: number;
  readonly errorEventCount: number;
  readonly errorEventFatal: boolean;
  readonly errorEventGeneration: number | null;
  readonly rejectedErrorName: string | null;
  readonly rejectedErrorGeneration: number | null;
  readonly failureCode: string | null;
  readonly failureOperation: string | null;
  readonly readiness: string;
  readonly eventFailureIsRejectedFailure: boolean;
  readonly diagnosticsFailureIsRejectedFailure: boolean;
  readonly repeatedPrepareRejected: boolean;
  readonly repeatedPrepareErrorIsRejectedError: boolean;
  readonly sourceCleanup: Readonly<CapturedSourceCleanup> | null;
  readonly outstanding: Readonly<{
    readonly player: number | null;
    readonly decoder: number | null;
    readonly bytes: number | null;
  }>;
}

/**
 * Exact attachment material accepted by the certification package's independent
 * evaluator. The functional harness exports this object but does not assemble,
 * digest-bind, or promote a runtime certification report itself.
 */
export interface FatalErrorBoundaryLedgerInput {
  readonly schemaVersion: "1.0";
  readonly ledgerKind: "runtime-fatal-error-boundary";
  readonly candidateManifestDigest: string;
  readonly fixtureDigest: string;
  readonly harnessDigest: string;
  readonly runId: string;
  readonly profileId: string;
  readonly environmentDigest: string;
  readonly sourceGeneration: number;
  readonly errorEventCount: number;
  readonly errorEventFatal: boolean;
  readonly errorEventGeneration: number;
  readonly rejectedErrorName: "AvalPlaybackError";
  readonly rejectedErrorGeneration: number;
  readonly failureCode: string;
  readonly failureOperation: string;
  readonly readiness: "error";
  readonly eventFailureIsRejectedFailure: true;
  readonly diagnosticsFailureIsRejectedFailure: true;
  readonly repeatedPrepareRejected: true;
  readonly repeatedPrepareErrorIsRejectedError: true;
  readonly sourceCleanup: Readonly<CapturedSourceCleanup>;
  readonly outstanding: Readonly<{
    readonly player: 0;
    readonly decoder: 0;
    readonly bytes: 0;
  }>;
}

export interface FatalErrorBoundaryCaptureResult {
  readonly passed: boolean;
  readonly failures: readonly string[];
  readonly observation: Readonly<FatalErrorBoundaryObservation>;
  readonly ledger: Readonly<FatalErrorBoundaryLedgerInput> | null;
}

export function captureFatalErrorBoundaryEvidence(input: Readonly<{
  readonly candidateManifestDigest: string;
  readonly fixtureDigest: string;
  readonly harnessDigest: string;
  readonly runId: string;
  readonly profileId: string;
  readonly environmentDigest: string;
  readonly errorEvents: readonly Readonly<CapturedFatalErrorEvent>[];
  readonly rejectedPrepare: CapturedPrepareOutcome;
  readonly repeatedPrepare: CapturedPrepareOutcome;
  readonly diagnostics: Readonly<AvalDiagnostics>;
}>): Readonly<FatalErrorBoundaryCaptureResult> {
  if (!SHA256.test(input.candidateManifestDigest)) throw new TypeError("candidate manifest digest is invalid");
  if (!SHA256.test(input.fixtureDigest)) throw new TypeError("fixture digest is invalid");
  if (!SHA256.test(input.harnessDigest)) throw new TypeError("harness digest is invalid");
  if (!/^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/u.test(input.runId)) throw new TypeError("run ID is invalid");
  if (!/^profile-[0-9a-f]{20}$/u.test(input.profileId)) throw new TypeError("profile ID is invalid");
  if (!SHA256.test(input.environmentDigest)) throw new TypeError("environment digest is invalid");
  if (input.errorEvents.length > 128) throw new RangeError("fatal error event capture exceeds the bound");
  const rejectedError = input.rejectedPrepare.status === "rejected"
    ? input.rejectedPrepare.error
    : null;
  const playbackError = rejectedError instanceof AvalPlaybackError
    ? rejectedError
    : null;
  const firstEvent = input.errorEvents[0] ?? null;
  const sourceCleanup = captureSourceCleanup(input.diagnostics.cleanup);
  const outstanding = Object.freeze({
    player: nonnegativeIntegerOrNull(input.diagnostics.outstanding.player),
    decoder: nonnegativeIntegerOrNull(input.diagnostics.outstanding.decoder),
    bytes: nonnegativeIntegerOrNull(input.diagnostics.outstanding.bytes)
  });
  const observation: FatalErrorBoundaryObservation = Object.freeze({
    candidateManifestDigest: input.candidateManifestDigest,
    fixtureDigest: input.fixtureDigest,
    harnessDigest: input.harnessDigest,
    runId: input.runId,
    profileId: input.profileId,
    environmentDigest: input.environmentDigest,
    sourceGeneration: input.diagnostics.sourceGeneration,
    errorEventCount: input.errorEvents.length,
    errorEventFatal: firstEvent?.fatal === true,
    errorEventGeneration: firstEvent === null ? null : firstEvent.generation,
    rejectedErrorName: errorName(rejectedError),
    rejectedErrorGeneration: playbackError?.generation ?? null,
    failureCode: playbackError?.failure.code ?? null,
    failureOperation: playbackError?.failure.operation ?? null,
    readiness: input.diagnostics.readiness,
    eventFailureIsRejectedFailure: playbackError !== null && firstEvent?.failure === playbackError.failure,
    diagnosticsFailureIsRejectedFailure: playbackError !== null && input.diagnostics.lastFailure === playbackError.failure,
    repeatedPrepareRejected: input.repeatedPrepare.status === "rejected",
    repeatedPrepareErrorIsRejectedError: input.repeatedPrepare.status === "rejected" && input.repeatedPrepare.error === rejectedError,
    sourceCleanup,
    outstanding
  });
  const failures = evaluateObservation(observation, input.rejectedPrepare.status);
  const ledger = failures.length === 0
    ? materializeLedger(observation)
    : null;
  return Object.freeze({
    passed: failures.length === 0,
    failures: Object.freeze(failures),
    observation,
    ledger
  });
}

function evaluateObservation(
  observation: FatalErrorBoundaryObservation,
  prepareStatus: CapturedPrepareOutcome["status"]
): string[] {
  const failures: string[] = [];
  if (prepareStatus !== "rejected") failures.push("prepare-not-rejected");
  if (!Number.isSafeInteger(observation.sourceGeneration) || observation.sourceGeneration < 1) failures.push("source-generation-invalid");
  if (observation.errorEventCount !== 1) failures.push("error-event-count-not-one");
  if (!observation.errorEventFatal) failures.push("error-event-not-fatal");
  if (observation.errorEventGeneration !== observation.sourceGeneration) failures.push("error-event-generation-mismatch");
  if (observation.rejectedErrorName !== "AvalPlaybackError") failures.push("rejected-error-name");
  if (observation.rejectedErrorGeneration !== observation.sourceGeneration) failures.push("rejected-error-generation-mismatch");
  if (observation.failureCode === null || !FATAL_FAILURE_CODES.has(observation.failureCode)) failures.push("failure-code-invalid");
  if (observation.failureOperation === null || !BOUNDED_TOKEN.test(observation.failureOperation)) failures.push("failure-operation-invalid");
  if (observation.readiness !== "error") failures.push("readiness-not-error");
  if (!observation.eventFailureIsRejectedFailure) failures.push("event-failure-identity");
  if (!observation.diagnosticsFailureIsRejectedFailure) failures.push("diagnostics-failure-identity");
  if (!observation.repeatedPrepareRejected) failures.push("repeated-prepare-not-rejected");
  if (!observation.repeatedPrepareErrorIsRejectedError) failures.push("repeated-prepare-error-identity");
  const cleanup = observation.sourceCleanup;
  if (cleanup === null) {
    failures.push("source-cleanup-missing");
  } else {
    if (!Number.isSafeInteger(cleanup.elementGeneration) || cleanup.elementGeneration < 1) failures.push("source-cleanup-element-generation-invalid");
    if (cleanup.sourceGeneration !== observation.sourceGeneration) failures.push("source-cleanup-generation-mismatch");
    if (!cleanup.completed) failures.push("source-cleanup-incomplete");
    if (cleanup.failureCount !== 0) failures.push("source-cleanup-failure-count");
    if (!cleanup.playerDisposed) failures.push("source-cleanup-player-not-disposed");
    if (!cleanup.participantDisposed) failures.push("source-cleanup-participant-not-disposed");
    if (cleanup.participantRegistered) failures.push("source-cleanup-participant-registered");
    if (cleanup.participantDecoderState !== null) failures.push("source-cleanup-participant-decoder-state");
    for (const field of SOURCE_ZERO_FIELDS) {
      if (cleanup[field] !== 0) failures.push(`source-cleanup-${camelToKebab(field)}`);
    }
  }
  for (const field of OUTSTANDING_FIELDS) {
    if (observation.outstanding[field] !== 0) failures.push(`outstanding-${field}`);
  }
  return failures;
}

function materializeLedger(
  observation: FatalErrorBoundaryObservation
): Readonly<FatalErrorBoundaryLedgerInput> {
  const cleanup = observation.sourceCleanup;
  if (
    cleanup === null ||
    observation.errorEventGeneration === null ||
    observation.rejectedErrorGeneration === null ||
    observation.failureCode === null ||
    observation.failureOperation === null ||
    observation.rejectedErrorName !== "AvalPlaybackError" ||
    observation.readiness !== "error" ||
    !observation.eventFailureIsRejectedFailure ||
    !observation.diagnosticsFailureIsRejectedFailure ||
    !observation.repeatedPrepareRejected ||
    !observation.repeatedPrepareErrorIsRejectedError ||
    observation.outstanding.player !== 0 ||
    observation.outstanding.decoder !== 0 ||
    observation.outstanding.bytes !== 0
  ) throw new Error("fatal error-boundary ledger materialization invariant failed");
  return Object.freeze({
    schemaVersion: "1.0",
    ledgerKind: "runtime-fatal-error-boundary",
    candidateManifestDigest: observation.candidateManifestDigest,
    fixtureDigest: observation.fixtureDigest,
    harnessDigest: observation.harnessDigest,
    runId: observation.runId,
    profileId: observation.profileId,
    environmentDigest: observation.environmentDigest,
    sourceGeneration: observation.sourceGeneration,
    errorEventCount: observation.errorEventCount,
    errorEventFatal: observation.errorEventFatal,
    errorEventGeneration: observation.errorEventGeneration,
    rejectedErrorName: observation.rejectedErrorName,
    rejectedErrorGeneration: observation.rejectedErrorGeneration,
    failureCode: observation.failureCode,
    failureOperation: observation.failureOperation,
    readiness: observation.readiness,
    eventFailureIsRejectedFailure: true,
    diagnosticsFailureIsRejectedFailure: true,
    repeatedPrepareRejected: true,
    repeatedPrepareErrorIsRejectedError: true,
    sourceCleanup: cleanup,
    outstanding: Object.freeze({ player: 0, decoder: 0, bytes: 0 })
  });
}

function captureSourceCleanup(
  cleanup: Readonly<AvalDiagnostics["cleanup"]>
): Readonly<CapturedSourceCleanup> | null {
  if (cleanup === null) return null;
  return Object.freeze({
    elementGeneration: cleanup.elementGeneration,
    sourceGeneration: cleanup.sourceGeneration,
    completed: cleanup.completed,
    failureCount: cleanup.failureCount,
    playerDisposed: cleanup.playerDisposed,
    participantDisposed: cleanup.participantDisposed,
    participantRegistered: cleanup.participantRegistered,
    participantLogicalBytes: cleanup.participantLogicalBytes,
    participantActiveLeaseCount: cleanup.participantActiveLeaseCount,
    participantRegisteredCleanupCount: cleanup.participantRegisteredCleanupCount,
    participantTrackedWorkCount: cleanup.participantTrackedWorkCount,
    participantPendingWaitCount: cleanup.participantPendingWaitCount,
    participantDecoderTicketCount: cleanup.participantDecoderTicketCount,
    participantDecoderState: cleanup.participantDecoderState,
    workerCount: cleanup.workerCount,
    openFrames: cleanup.openFrames,
    pendingRuntimeOperations: cleanup.pendingRuntimeOperations,
    sourceCopiesInFlight: cleanup.sourceCopiesInFlight,
    rendererStagingBytes: cleanup.rendererStagingBytes,
    pendingLoads: cleanup.pendingLoads,
    activeTransportBodies: cleanup.activeTransportBodies,
    interestedWaiters: cleanup.interestedWaiters,
    rendererResourceCount: cleanup.rendererResourceCount,
    contextListenerCount: cleanup.contextListenerCount
  });
}

const SOURCE_ZERO_FIELDS = Object.freeze([
  "participantLogicalBytes", "participantActiveLeaseCount",
  "participantRegisteredCleanupCount", "participantTrackedWorkCount",
  "participantPendingWaitCount", "participantDecoderTicketCount", "workerCount",
  "openFrames", "pendingRuntimeOperations", "sourceCopiesInFlight",
  "rendererStagingBytes", "pendingLoads", "activeTransportBodies",
  "interestedWaiters", "rendererResourceCount", "contextListenerCount"
] as const satisfies readonly (keyof CapturedSourceCleanup)[]);

const OUTSTANDING_FIELDS = Object.freeze(["player", "decoder", "bytes"] as const);

function errorName(value: unknown): string | null {
  if (value === null || typeof value !== "object") return null;
  const name = (value as Readonly<{ name?: unknown }>).name;
  return typeof name === "string" && name.length > 0 ? name.slice(0, 128) : null;
}

function nonnegativeIntegerOrNull(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null;
}

function camelToKebab(value: string): string {
  return value.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`);
}
