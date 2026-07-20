import { FATAL_ERROR_BOUNDARY_ATTACHMENT_ID } from "../src/scenario-contract.js";
import { createPublicProfileId, runtimeEnvironmentDigest } from "../src/environment-validation.js";
import { validRuntimeReport } from "./test-report.js";

export const TEST_FATAL_ERROR_BOUNDARY_ATTACHMENT_ID = FATAL_ERROR_BOUNDARY_ATTACHMENT_ID;
export const TEST_FATAL_ERROR_BOUNDARY_FIXTURE_DIGEST = "b".repeat(64);
export const TEST_FATAL_ERROR_BOUNDARY_HARNESS_DIGEST = "c".repeat(64);
export const TEST_FATAL_ERROR_BOUNDARY_RUN_ID = "runtime-macos-safari-1";

export function testFatalErrorBoundaryEnvironmentIdentity(): Readonly<{
  profileId: string;
  environmentDigest: string;
}> {
  const environment = validRuntimeReport().environment;
  return Object.freeze({
    profileId: createPublicProfileId(environment),
    environmentDigest: runtimeEnvironmentDigest(environment)
  });
}

export function validFatalErrorBoundaryLedger(): Record<string, unknown> {
  const identity = testFatalErrorBoundaryEnvironmentIdentity();
  return {
    schemaVersion: "1.0",
    ledgerKind: "runtime-fatal-error-boundary",
    candidateManifestDigest: "a".repeat(64),
    fixtureDigest: TEST_FATAL_ERROR_BOUNDARY_FIXTURE_DIGEST,
    harnessDigest: TEST_FATAL_ERROR_BOUNDARY_HARNESS_DIGEST,
    runId: TEST_FATAL_ERROR_BOUNDARY_RUN_ID,
    profileId: identity.profileId,
    environmentDigest: identity.environmentDigest,
    sourceGeneration: 1,
    errorEventCount: 1,
    errorEventFatal: true,
    errorEventGeneration: 1,
    rejectedErrorName: "AvalPlaybackError",
    rejectedErrorGeneration: 1,
    failureCode: "worker-decode-failure",
    failureOperation: "prepare",
    readiness: "error",
    eventFailureIsRejectedFailure: true,
    diagnosticsFailureIsRejectedFailure: true,
    repeatedPrepareRejected: true,
    repeatedPrepareErrorIsRejectedError: true,
    sourceCleanup: {
      elementGeneration: 1,
      sourceGeneration: 1,
      completed: true,
      failureCount: 0,
      playerDisposed: true,
      participantDisposed: true,
      participantRegistered: false,
      participantLogicalBytes: 0,
      participantActiveLeaseCount: 0,
      participantRegisteredCleanupCount: 0,
      participantTrackedWorkCount: 0,
      participantPendingWaitCount: 0,
      participantDecoderTicketCount: 0,
      participantDecoderState: null,
      workerCount: 0,
      openFrames: 0,
      pendingRuntimeOperations: 0,
      sourceCopiesInFlight: 0,
      rendererStagingBytes: 0,
      pendingLoads: 0,
      activeTransportBodies: 0,
      interestedWaiters: 0,
      rendererResourceCount: 0,
      contextListenerCount: 0
    },
    outstanding: {
      player: 0,
      decoder: 0,
      bytes: 0
    }
  };
}
