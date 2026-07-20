import { SHA256_PATTERN } from "./model.js";

const ROOT_KEYS = Object.freeze([
  "schemaVersion", "ledgerKind", "candidateManifestDigest", "fixtureDigest",
  "harnessDigest", "runId", "profileId", "environmentDigest", "sourceGeneration",
  "errorEventCount", "errorEventFatal", "errorEventGeneration",
  "rejectedErrorName", "rejectedErrorGeneration", "failureCode",
  "failureOperation", "readiness", "eventFailureIsRejectedFailure",
  "diagnosticsFailureIsRejectedFailure", "repeatedPrepareRejected",
  "repeatedPrepareErrorIsRejectedError", "sourceCleanup", "outstanding"
] as const);

const SOURCE_CLEANUP_KEYS = Object.freeze([
  "elementGeneration", "sourceGeneration", "completed", "failureCount",
  "playerDisposed", "participantDisposed", "participantRegistered",
  "participantLogicalBytes", "participantActiveLeaseCount",
  "participantRegisteredCleanupCount", "participantTrackedWorkCount",
  "participantPendingWaitCount", "participantDecoderTicketCount",
  "participantDecoderState", "workerCount", "openFrames",
  "pendingRuntimeOperations", "sourceCopiesInFlight", "rendererStagingBytes",
  "pendingLoads", "activeTransportBodies", "interestedWaiters",
  "rendererResourceCount", "contextListenerCount"
] as const);

const OUTSTANDING_KEYS = Object.freeze(["player", "decoder", "bytes"] as const);

const FATAL_FAILURE_CODES = Object.freeze([
  "invalid-asset",
  "load-failure",
  "range-response-invalid",
  "entity-changed",
  "integrity-mismatch",
  "unsupported-profile",
  "resource-rejection",
  "readiness-failure",
  "worker-decode-failure",
  "renderer-failure",
  "context-loss",
  "watchdog-timeout",
  "underflow",
  "invalid-configuration",
  "unsupported-browser",
  "interaction-target-unavailable",
  "element-cleanup-incomplete"
] as const);

type FatalFailureCode = typeof FATAL_FAILURE_CODES[number];

export interface FatalErrorBoundarySourceCleanup {
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

export interface FatalErrorBoundaryLedger {
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
  readonly rejectedErrorName: string;
  readonly rejectedErrorGeneration: number;
  readonly failureCode: FatalFailureCode;
  readonly failureOperation: string;
  readonly readiness: string;
  readonly eventFailureIsRejectedFailure: boolean;
  readonly diagnosticsFailureIsRejectedFailure: boolean;
  readonly repeatedPrepareRejected: boolean;
  readonly repeatedPrepareErrorIsRejectedError: boolean;
  readonly sourceCleanup: Readonly<FatalErrorBoundarySourceCleanup>;
  readonly outstanding: Readonly<{
    readonly player: number;
    readonly decoder: number;
    readonly bytes: number;
  }>;
}

export interface FatalErrorBoundaryEvaluation {
  readonly passed: boolean;
  readonly failures: readonly string[];
}

/** Parse and independently evaluate the raw browser witness for the public terminal boundary. */
export function evaluateFatalErrorBoundaryLedger(
  input: unknown,
  expected: Readonly<{
    readonly candidateManifestDigest?: string;
    readonly fixtureDigest?: string;
    readonly harnessDigest?: string;
    readonly runId?: string;
    readonly profileId?: string;
    readonly environmentDigest?: string;
  }> = {}
): Readonly<{
  readonly ledger: FatalErrorBoundaryLedger;
  readonly evaluation: FatalErrorBoundaryEvaluation;
}> {
  const root = exactRecord(input, ROOT_KEYS, "$fatalBoundary");
  literal(root.schemaVersion, "1.0", "$fatalBoundary.schemaVersion");
  literal(root.ledgerKind, "runtime-fatal-error-boundary", "$fatalBoundary.ledgerKind");
  const sourceGeneration = positiveInteger(root.sourceGeneration, "$fatalBoundary.sourceGeneration");
  const cleanupInput = exactRecord(root.sourceCleanup, SOURCE_CLEANUP_KEYS, "$fatalBoundary.sourceCleanup");
  const outstandingInput = exactRecord(root.outstanding, OUTSTANDING_KEYS, "$fatalBoundary.outstanding");
  const sourceCleanup = Object.freeze({
    elementGeneration: positiveInteger(cleanupInput.elementGeneration, "$fatalBoundary.sourceCleanup.elementGeneration"),
    sourceGeneration: positiveInteger(cleanupInput.sourceGeneration, "$fatalBoundary.sourceCleanup.sourceGeneration"),
    completed: boolean(cleanupInput.completed, "$fatalBoundary.sourceCleanup.completed"),
    failureCount: nonnegativeInteger(cleanupInput.failureCount, "$fatalBoundary.sourceCleanup.failureCount"),
    playerDisposed: boolean(cleanupInput.playerDisposed, "$fatalBoundary.sourceCleanup.playerDisposed"),
    participantDisposed: boolean(cleanupInput.participantDisposed, "$fatalBoundary.sourceCleanup.participantDisposed"),
    participantRegistered: boolean(cleanupInput.participantRegistered, "$fatalBoundary.sourceCleanup.participantRegistered"),
    participantLogicalBytes: nonnegativeInteger(cleanupInput.participantLogicalBytes, "$fatalBoundary.sourceCleanup.participantLogicalBytes"),
    participantActiveLeaseCount: nonnegativeInteger(cleanupInput.participantActiveLeaseCount, "$fatalBoundary.sourceCleanup.participantActiveLeaseCount"),
    participantRegisteredCleanupCount: nonnegativeInteger(cleanupInput.participantRegisteredCleanupCount, "$fatalBoundary.sourceCleanup.participantRegisteredCleanupCount"),
    participantTrackedWorkCount: nonnegativeInteger(cleanupInput.participantTrackedWorkCount, "$fatalBoundary.sourceCleanup.participantTrackedWorkCount"),
    participantPendingWaitCount: nonnegativeInteger(cleanupInput.participantPendingWaitCount, "$fatalBoundary.sourceCleanup.participantPendingWaitCount"),
    participantDecoderTicketCount: nonnegativeInteger(cleanupInput.participantDecoderTicketCount, "$fatalBoundary.sourceCleanup.participantDecoderTicketCount"),
    participantDecoderState: cleanupInput.participantDecoderState === null
      ? null
      : boundedToken(cleanupInput.participantDecoderState, "$fatalBoundary.sourceCleanup.participantDecoderState"),
    workerCount: nonnegativeInteger(cleanupInput.workerCount, "$fatalBoundary.sourceCleanup.workerCount"),
    openFrames: nonnegativeInteger(cleanupInput.openFrames, "$fatalBoundary.sourceCleanup.openFrames"),
    pendingRuntimeOperations: nonnegativeInteger(cleanupInput.pendingRuntimeOperations, "$fatalBoundary.sourceCleanup.pendingRuntimeOperations"),
    sourceCopiesInFlight: nonnegativeInteger(cleanupInput.sourceCopiesInFlight, "$fatalBoundary.sourceCleanup.sourceCopiesInFlight"),
    rendererStagingBytes: nonnegativeInteger(cleanupInput.rendererStagingBytes, "$fatalBoundary.sourceCleanup.rendererStagingBytes"),
    pendingLoads: nonnegativeInteger(cleanupInput.pendingLoads, "$fatalBoundary.sourceCleanup.pendingLoads"),
    activeTransportBodies: nonnegativeInteger(cleanupInput.activeTransportBodies, "$fatalBoundary.sourceCleanup.activeTransportBodies"),
    interestedWaiters: nonnegativeInteger(cleanupInput.interestedWaiters, "$fatalBoundary.sourceCleanup.interestedWaiters"),
    rendererResourceCount: nonnegativeInteger(cleanupInput.rendererResourceCount, "$fatalBoundary.sourceCleanup.rendererResourceCount"),
    contextListenerCount: nonnegativeInteger(cleanupInput.contextListenerCount, "$fatalBoundary.sourceCleanup.contextListenerCount")
  });
  const ledger: FatalErrorBoundaryLedger = Object.freeze({
    schemaVersion: "1.0",
    ledgerKind: "runtime-fatal-error-boundary",
    candidateManifestDigest: digest(root.candidateManifestDigest, "$fatalBoundary.candidateManifestDigest"),
    fixtureDigest: digest(root.fixtureDigest, "$fatalBoundary.fixtureDigest"),
    harnessDigest: digest(root.harnessDigest, "$fatalBoundary.harnessDigest"),
    runId: identifier(root.runId, "$fatalBoundary.runId"),
    profileId: publicProfileId(root.profileId, "$fatalBoundary.profileId"),
    environmentDigest: digest(root.environmentDigest, "$fatalBoundary.environmentDigest"),
    sourceGeneration,
    errorEventCount: nonnegativeInteger(root.errorEventCount, "$fatalBoundary.errorEventCount"),
    errorEventFatal: boolean(root.errorEventFatal, "$fatalBoundary.errorEventFatal"),
    errorEventGeneration: positiveInteger(root.errorEventGeneration, "$fatalBoundary.errorEventGeneration"),
    rejectedErrorName: boundedToken(root.rejectedErrorName, "$fatalBoundary.rejectedErrorName"),
    rejectedErrorGeneration: positiveInteger(root.rejectedErrorGeneration, "$fatalBoundary.rejectedErrorGeneration"),
    failureCode: enumeration(root.failureCode, FATAL_FAILURE_CODES, "$fatalBoundary.failureCode"),
    failureOperation: boundedToken(root.failureOperation, "$fatalBoundary.failureOperation"),
    readiness: boundedToken(root.readiness, "$fatalBoundary.readiness"),
    eventFailureIsRejectedFailure: boolean(root.eventFailureIsRejectedFailure, "$fatalBoundary.eventFailureIsRejectedFailure"),
    diagnosticsFailureIsRejectedFailure: boolean(root.diagnosticsFailureIsRejectedFailure, "$fatalBoundary.diagnosticsFailureIsRejectedFailure"),
    repeatedPrepareRejected: boolean(root.repeatedPrepareRejected, "$fatalBoundary.repeatedPrepareRejected"),
    repeatedPrepareErrorIsRejectedError: boolean(root.repeatedPrepareErrorIsRejectedError, "$fatalBoundary.repeatedPrepareErrorIsRejectedError"),
    sourceCleanup,
    outstanding: Object.freeze({
      player: nonnegativeInteger(outstandingInput.player, "$fatalBoundary.outstanding.player"),
      decoder: nonnegativeInteger(outstandingInput.decoder, "$fatalBoundary.outstanding.decoder"),
      bytes: nonnegativeInteger(outstandingInput.bytes, "$fatalBoundary.outstanding.bytes")
    })
  });
  const failures = evaluateParsedLedger(ledger, expected);
  return Object.freeze({
    ledger,
    evaluation: Object.freeze({ passed: failures.length === 0, failures: Object.freeze(failures) })
  });
}

function evaluateParsedLedger(
  ledger: FatalErrorBoundaryLedger,
  expected: Readonly<{
    readonly candidateManifestDigest?: string;
    readonly fixtureDigest?: string;
    readonly harnessDigest?: string;
    readonly runId?: string;
    readonly profileId?: string;
    readonly environmentDigest?: string;
  }>
): string[] {
  const failures: string[] = [];
  if (expected.candidateManifestDigest !== undefined && ledger.candidateManifestDigest !== expected.candidateManifestDigest) failures.push("candidate-manifest-digest-mismatch");
  if (expected.fixtureDigest !== undefined && ledger.fixtureDigest !== expected.fixtureDigest) failures.push("fixture-digest-mismatch");
  if (expected.harnessDigest !== undefined && ledger.harnessDigest !== expected.harnessDigest) failures.push("harness-digest-mismatch");
  if (expected.runId !== undefined && ledger.runId !== expected.runId) failures.push("run-id-mismatch");
  if (expected.profileId !== undefined && ledger.profileId !== expected.profileId) failures.push("profile-id-mismatch");
  if (expected.environmentDigest !== undefined && ledger.environmentDigest !== expected.environmentDigest) failures.push("environment-digest-mismatch");
  if (ledger.errorEventCount !== 1) failures.push("error-event-count-not-one");
  if (!ledger.errorEventFatal) failures.push("error-event-not-fatal");
  if (ledger.errorEventGeneration !== ledger.sourceGeneration) failures.push("error-event-generation-mismatch");
  if (ledger.rejectedErrorName !== "AvalPlaybackError") failures.push("rejected-error-name");
  if (ledger.rejectedErrorGeneration !== ledger.sourceGeneration) failures.push("rejected-error-generation-mismatch");
  if (ledger.readiness !== "error") failures.push("readiness-not-error");
  if (!ledger.eventFailureIsRejectedFailure) failures.push("event-failure-identity");
  if (!ledger.diagnosticsFailureIsRejectedFailure) failures.push("diagnostics-failure-identity");
  if (!ledger.repeatedPrepareRejected) failures.push("repeated-prepare-not-rejected");
  if (!ledger.repeatedPrepareErrorIsRejectedError) failures.push("repeated-prepare-error-identity");
  const cleanup = ledger.sourceCleanup;
  if (cleanup.sourceGeneration !== ledger.sourceGeneration) failures.push("source-cleanup-generation-mismatch");
  if (!cleanup.completed) failures.push("source-cleanup-incomplete");
  if (cleanup.failureCount !== 0) failures.push("source-cleanup-failure-count");
  if (!cleanup.playerDisposed) failures.push("source-cleanup-player-not-disposed");
  if (!cleanup.participantDisposed) failures.push("source-cleanup-participant-not-disposed");
  if (cleanup.participantRegistered) failures.push("source-cleanup-participant-registered");
  if (cleanup.participantDecoderState !== null) failures.push("source-cleanup-participant-decoder-state");
  for (const field of SOURCE_ZERO_FIELDS) {
    if (cleanup[field] !== 0) failures.push(`source-cleanup-${camelToKebab(field)}`);
  }
  for (const field of OUTSTANDING_KEYS) {
    if (ledger.outstanding[field] !== 0) failures.push(`outstanding-${field}`);
  }
  return failures;
}

const SOURCE_ZERO_FIELDS = Object.freeze([
  "participantLogicalBytes", "participantActiveLeaseCount",
  "participantRegisteredCleanupCount", "participantTrackedWorkCount",
  "participantPendingWaitCount", "participantDecoderTicketCount", "workerCount",
  "openFrames", "pendingRuntimeOperations", "sourceCopiesInFlight",
  "rendererStagingBytes", "pendingLoads", "activeTransportBodies",
  "interestedWaiters", "rendererResourceCount", "contextListenerCount"
] as const satisfies readonly (keyof FatalErrorBoundarySourceCleanup)[]);

function exactRecord(value: unknown, keys: readonly string[], path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${path} must be an object`);
  const record = value as Record<string, unknown>;
  const expected = new Set(keys);
  for (const key of Object.keys(record)) if (!expected.has(key)) throw new TypeError(`${path}.${key} is an unknown field`);
  for (const key of keys) if (!(key in record)) throw new TypeError(`${path}.${key} is required`);
  return record;
}

function literal<const T extends string>(value: unknown, expected: T, path: string): asserts value is T {
  if (value !== expected) throw new TypeError(`${path} must be ${expected}`);
}

function enumeration<const T extends readonly string[]>(value: unknown, values: T, path: string): T[number] {
  if (typeof value !== "string" || !values.includes(value)) throw new TypeError(`${path} is invalid`);
  return value as T[number];
}

function digest(value: unknown, path: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) throw new TypeError(`${path} is invalid`);
  return value;
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${path} must be boolean`);
  return value;
}

function boundedToken(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 128 || !/^[A-Za-z][A-Za-z0-9._-]*$/u.test(value)) {
    throw new TypeError(`${path} is invalid`);
  }
  return value;
}

function identifier(value: unknown, path: string): string {
  if (typeof value !== "string" || !/^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/u.test(value)) throw new TypeError(`${path} is invalid`);
  return value;
}

function publicProfileId(value: unknown, path: string): string {
  if (typeof value !== "string" || !/^profile-[0-9a-f]{20}$/u.test(value)) throw new TypeError(`${path} is invalid`);
  return value;
}

function nonnegativeInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new RangeError(`${path} must be a nonnegative safe integer`);
  return value as number;
}

function positiveInteger(value: unknown, path: string): number {
  const checked = nonnegativeInteger(value, path);
  if (checked === 0) throw new RangeError(`${path} must be positive`);
  return checked;
}

function camelToKebab(value: string): string {
  return value.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`);
}
