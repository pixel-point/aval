import { describe, expect, it } from "vitest";

import { evaluateFatalErrorBoundaryLedger } from "../src/fatal-error-boundary-ledger.js";
import {
  TEST_FATAL_ERROR_BOUNDARY_FIXTURE_DIGEST,
  TEST_FATAL_ERROR_BOUNDARY_HARNESS_DIGEST,
  TEST_FATAL_ERROR_BOUNDARY_RUN_ID,
  testFatalErrorBoundaryEnvironmentIdentity,
  validFatalErrorBoundaryLedger
} from "./fatal-error-boundary-support.js";

describe("fatal error-boundary ledger", () => {
  it("accepts one canonical terminal failure with settled source ownership", () => {
    const identity = testFatalErrorBoundaryEnvironmentIdentity();
    const result = evaluateFatalErrorBoundaryLedger(validFatalErrorBoundaryLedger(), {
      candidateManifestDigest: "a".repeat(64),
      fixtureDigest: TEST_FATAL_ERROR_BOUNDARY_FIXTURE_DIGEST,
      harnessDigest: TEST_FATAL_ERROR_BOUNDARY_HARNESS_DIGEST,
      runId: TEST_FATAL_ERROR_BOUNDARY_RUN_ID,
      profileId: identity.profileId,
      environmentDigest: identity.environmentDigest
    });

    expect(result.evaluation).toEqual({ passed: true, failures: [] });
  });

  it.each([
    ["candidate binding", (ledger: any) => { ledger.candidateManifestDigest = "c".repeat(64); }, "candidate-manifest-digest-mismatch"],
    ["fixture binding", (ledger: any) => { ledger.fixtureDigest = "d".repeat(64); }, "fixture-digest-mismatch"],
    ["harness binding", (ledger: any) => { ledger.harnessDigest = "d".repeat(64); }, "harness-digest-mismatch"],
    ["run binding", (ledger: any) => { ledger.runId = "runtime-other-profile"; }, "run-id-mismatch"],
    ["profile binding", (ledger: any) => { ledger.profileId = `profile-${"d".repeat(20)}`; }, "profile-id-mismatch"],
    ["environment binding", (ledger: any) => { ledger.environmentDigest = "d".repeat(64); }, "environment-digest-mismatch"],
    ["one error event", (ledger: any) => { ledger.errorEventCount = 2; }, "error-event-count-not-one"],
    ["fatal event", (ledger: any) => { ledger.errorEventFatal = false; }, "error-event-not-fatal"],
    ["event generation", (ledger: any) => { ledger.errorEventGeneration = 2; }, "error-event-generation-mismatch"],
    ["canonical error name", (ledger: any) => { ledger.rejectedErrorName = "Error"; }, "rejected-error-name"],
    ["rejected generation", (ledger: any) => { ledger.rejectedErrorGeneration = 2; }, "rejected-error-generation-mismatch"],
    ["error readiness", (ledger: any) => { ledger.readiness = "staticReady"; }, "readiness-not-error"],
    ["event failure identity", (ledger: any) => { ledger.eventFailureIsRejectedFailure = false; }, "event-failure-identity"],
    ["diagnostics lastFailure identity", (ledger: any) => { ledger.diagnosticsFailureIsRejectedFailure = false; }, "diagnostics-failure-identity"],
    ["repeated prepare rejection", (ledger: any) => { ledger.repeatedPrepareRejected = false; }, "repeated-prepare-not-rejected"],
    ["repeated prepare error identity", (ledger: any) => { ledger.repeatedPrepareErrorIsRejectedError = false; }, "repeated-prepare-error-identity"],
    ["cleanup generation", (ledger: any) => { ledger.sourceCleanup.sourceGeneration = 2; }, "source-cleanup-generation-mismatch"],
    ["completed cleanup", (ledger: any) => { ledger.sourceCleanup.completed = false; }, "source-cleanup-incomplete"],
    ["cleanup failure count", (ledger: any) => { ledger.sourceCleanup.failureCount = 1; }, "source-cleanup-failure-count"],
    ["participant ownership", (ledger: any) => { ledger.sourceCleanup.participantActiveLeaseCount = 1; }, "source-cleanup-participant-active-lease-count"],
    ["pending source work", (ledger: any) => { ledger.sourceCleanup.pendingRuntimeOperations = 1; }, "source-cleanup-pending-runtime-operations"],
    ["outstanding player", (ledger: any) => { ledger.outstanding.player = 1; }, "outstanding-player"]
  ])("rejects a forged %s witness", (_name, mutate, expectedFailure) => {
    const ledger = validFatalErrorBoundaryLedger();
    mutate(ledger);
    const identity = testFatalErrorBoundaryEnvironmentIdentity();

    const result = evaluateFatalErrorBoundaryLedger(ledger, {
      candidateManifestDigest: "a".repeat(64),
      fixtureDigest: TEST_FATAL_ERROR_BOUNDARY_FIXTURE_DIGEST,
      harnessDigest: TEST_FATAL_ERROR_BOUNDARY_HARNESS_DIGEST,
      runId: TEST_FATAL_ERROR_BOUNDARY_RUN_ID,
      profileId: identity.profileId,
      environmentDigest: identity.environmentDigest
    });

    expect(result.evaluation.passed).toBe(false);
    expect(result.evaluation.failures).toContain(expectedFailure);
  });

  it("rejects unknown fields and undocumented failure codes", () => {
    expect(() => evaluateFatalErrorBoundaryLedger({
      ...validFatalErrorBoundaryLedger(),
      consumerFallbackVisible: true
    })).toThrow(/unknown field/u);

    expect(() => evaluateFatalErrorBoundaryLedger({
      ...validFatalErrorBoundaryLedger(),
      failureCode: "invented-failure"
    })).toThrow(/failureCode/u);

    expect(() => evaluateFatalErrorBoundaryLedger({
      ...validFatalErrorBoundaryLedger(),
      failureOperation: ""
    })).toThrow(/failureOperation/u);
  });
});
