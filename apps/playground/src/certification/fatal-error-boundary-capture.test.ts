import { describe, expect, it } from "vitest";

import {
  AvalPlaybackError,
  type AvalDiagnostics,
  type AvalPublicFailure
} from "@pixel-point/aval-element";
import { evaluateFatalErrorBoundaryLedger } from "../../../../packages/certification/src/fatal-error-boundary-ledger.js";

import { captureFatalErrorBoundaryEvidence } from "./fatal-error-boundary-capture.js";

describe("fatal error-boundary capture", () => {
  it("materializes strict ledger input from one canonical terminal generation", () => {
    const failure = Object.freeze({
      code: "worker-decode-failure" as const,
      message: "AVAL operation failed (worker-decode-failure)",
      operation: "prepare"
    });
    const error = new AvalPlaybackError(failure, 7);
    const result = captureFatalErrorBoundaryEvidence({
      candidateManifestDigest: "a".repeat(64),
      fixtureDigest: "b".repeat(64),
      harnessDigest: "c".repeat(64),
      runId: "runtime-test-run",
      profileId: `profile-${"d".repeat(20)}`,
      environmentDigest: "e".repeat(64),
      errorEvents: [Object.freeze({ generation: 7, fatal: true, failure })],
      rejectedPrepare: Object.freeze({ status: "rejected", error }),
      repeatedPrepare: Object.freeze({ status: "rejected", error }),
      diagnostics: diagnostics(failure)
    });

    expect(result).toMatchObject({
      passed: true,
      failures: [],
      ledger: {
        schemaVersion: "1.0",
        ledgerKind: "runtime-fatal-error-boundary",
        candidateManifestDigest: "a".repeat(64),
        fixtureDigest: "b".repeat(64),
        harnessDigest: "c".repeat(64),
        runId: "runtime-test-run",
        profileId: `profile-${"d".repeat(20)}`,
        environmentDigest: "e".repeat(64),
        sourceGeneration: 7,
        errorEventCount: 1,
        errorEventFatal: true,
        errorEventGeneration: 7,
        rejectedErrorName: "AvalPlaybackError",
        rejectedErrorGeneration: 7,
        failureCode: "worker-decode-failure",
        failureOperation: "prepare",
        readiness: "error",
        eventFailureIsRejectedFailure: true,
        diagnosticsFailureIsRejectedFailure: true,
        repeatedPrepareRejected: true,
        repeatedPrepareErrorIsRejectedError: true,
        sourceCleanup: {
          sourceGeneration: 7,
          completed: true,
          participantActiveLeaseCount: 0,
          pendingRuntimeOperations: 0,
          openFrames: 0
        },
        outstanding: { player: 0, decoder: 0, bytes: 0 }
      }
    });
    expect(JSON.stringify(result)).not.toMatch(/alternate|fallback/iu);
    expect(evaluateFatalErrorBoundaryLedger(result.ledger, {
      candidateManifestDigest: "a".repeat(64),
      fixtureDigest: "b".repeat(64),
      harnessDigest: "c".repeat(64),
      runId: "runtime-test-run",
      profileId: `profile-${"d".repeat(20)}`,
      environmentDigest: "e".repeat(64)
    }).evaluation).toEqual({ passed: true, failures: [] });
  });

  it("retains exact failed observations without manufacturing ledger input", () => {
    const failure = Object.freeze({
      code: "worker-decode-failure" as const,
      message: "AVAL operation failed (worker-decode-failure)",
      operation: "prepare"
    });
    const error = new AvalPlaybackError(failure, 7);
    const copiedFailure = Object.freeze({ ...failure });
    const repeatedError = new AvalPlaybackError(failure, 7);
    const result = captureFatalErrorBoundaryEvidence({
      candidateManifestDigest: "a".repeat(64),
      fixtureDigest: "b".repeat(64),
      harnessDigest: "c".repeat(64),
      runId: "runtime-test-run",
      profileId: `profile-${"d".repeat(20)}`,
      environmentDigest: "e".repeat(64),
      errorEvents: [
        Object.freeze({ generation: 7, fatal: true, failure: copiedFailure }),
        Object.freeze({ generation: 7, fatal: true, failure: copiedFailure })
      ],
      rejectedPrepare: Object.freeze({ status: "rejected", error }),
      repeatedPrepare: Object.freeze({ status: "rejected", error: repeatedError }),
      diagnostics: diagnostics(copiedFailure, { pendingRuntimeOperations: 1 })
    });

    expect(result.passed).toBe(false);
    expect(result.ledger).toBeNull();
    expect(result.failures).toEqual(expect.arrayContaining([
      "error-event-count-not-one",
      "event-failure-identity",
      "diagnostics-failure-identity",
      "repeated-prepare-error-identity",
      "source-cleanup-pending-runtime-operations"
    ]));
    expect(result.observation).toMatchObject({
      errorEventCount: 2,
      rejectedErrorName: "AvalPlaybackError",
      failureCode: "worker-decode-failure",
      failureOperation: "prepare",
      sourceCleanup: { pendingRuntimeOperations: 1 }
    });
  });
});

function diagnostics(
  lastFailure: Readonly<AvalPublicFailure>,
  cleanupOverrides: Readonly<Record<string, unknown>> = {}
): Readonly<AvalDiagnostics> {
  return {
    sourceGeneration: 7,
    readiness: "error",
    lastFailure,
    cleanup: {
      elementGeneration: 1,
      sourceGeneration: 7,
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
      contextListenerCount: 0,
      stalePublicationCount: 0,
      pagePhysicalBytes: 0,
      pageParticipantCount: 0,
      pageActiveDecoderSlotCount: 0,
      pageQueuedDecoderTicketCount: 0,
      pageParkedDecoderTicketCount: 0,
      ...cleanupOverrides
    },
    outstanding: { player: 0, decoder: 0, bytes: 0 }
  } as unknown as Readonly<AvalDiagnostics>;
}
