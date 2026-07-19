import { createHash } from "node:crypto";
import type { VerifiedArtifact } from "./artifact-verifier.js";
import { evaluateDecoderThroughputLedger } from "./decoder-throughput-ledger.js";
import {
  requireCaptureAuthority,
  requireRawCaptureMediaType,
  validateRawCaptureEvidence
} from "./display-capture-bundle.js";
import { evaluateDisplayEvidence } from "./display-evidence.js";
import { validateDisplayCaptureLedger } from "./display-evidence-model.js";
import { evaluateFatalErrorBoundaryLedger } from "./fatal-error-boundary-ledger.js";
import { createPublicProfileId, runtimeEnvironmentDigest } from "./environment-validation.js";
import type { DisplayCertificationReport, RuntimeCertificationReport } from "./model.js";
import {
  parseCanonicalBundleJson,
  requiredVerifiedAttachment,
  requiredVerifiedBytes,
  verifyBundleAttachments
} from "./report-bundle-artifacts.js";
import type { ReportBundlePolicy } from "./report-bundle-policy.js";
import { deriveRuntimeDisplaySchedule, evaluateRuntimeScenarioLedger } from "./runtime-scenario-ledger.js";
import {
  DISPLAY_OBSERVATION_LEDGER_ATTACHMENT_ID,
  DISPLAY_RAW_CAPTURE_ATTACHMENT_ID,
  FATAL_ERROR_BOUNDARY_ATTACHMENT_ID,
  REQUIRED_DISPLAY_CRITERION_IDS,
  REQUIRED_RUNTIME_SCENARIOS,
  scenarioAttachmentId
} from "./scenario-contract.js";
import { validateDisplayReport, validateRuntimeReport } from "./schema-validation.js";
import { CertificationValidationError } from "./status.js";

export type { ReportBundlePolicy } from "./report-bundle-policy.js";

export async function validateRuntimeReportBundle(
  root: string,
  input: unknown,
  policy: ReportBundlePolicy
): Promise<RuntimeCertificationReport> {
  return (await validateRuntimeReportBundleVerified(root, input, policy)).report;
}

async function validateRuntimeReportBundleVerified(
  root: string,
  input: unknown,
  policy: ReportBundlePolicy
): Promise<Readonly<{
  report: RuntimeCertificationReport;
  attachments: ReadonlyMap<string, VerifiedArtifact>;
}>> {
  const report = validateRuntimeReport(input);
  const verifiedAttachments = await verifyBundleAttachments(root, report.attachments, policy);
  const attachmentById = new Map(report.attachments.map((attachment) => [attachment.id, attachment]));
  if (policy.allowedFixtureDigests === undefined || policy.allowedFixtureDigests.size === 0 || policy.allowedFixtureModels === undefined || policy.allowedFixtureModels.size === 0) {
    throw new CertificationValidationError("$runtime.attachments", "candidate fixture digest authority is required");
  }
  const throughputEvidenceIds: string[] = [];
  const genericEvidenceIds: string[] = [];
  for (const scenario of report.scenarios) {
    const id = scenarioAttachmentId(scenario.id, scenario.repetition);
    const attachment = attachmentById.get(id);
    if (attachment === undefined) throw new CertificationValidationError("$runtime.attachments", `scenario attachment is missing: ${id}`);
    if (attachment.mediaType !== "application/json") throw new CertificationValidationError(`$runtime.attachments.${id}.mediaType`, "scenario ledger must use application/json");
    const parsed = parseCanonicalBundleJson(requiredVerifiedBytes(verifiedAttachments, id), `$runtime.attachments.${id}`, policy.maximumAttachmentBytes);
    if (scenario.id === REQUIRED_RUNTIME_SCENARIOS.throughput.id) {
      throughputEvidenceIds.push(id);
      const evaluated = evaluateDecoderThroughputLedger(parsed, { candidateManifestDigest: report.candidateManifestDigest });
      requireAllowedFixture(evaluated.ledger.fixtureDigest, policy, id);
      if (!evaluated.evaluation.passed) throw new CertificationValidationError(`$runtime.attachments.${id}`, `throughput ledger failed recomputation: ${evaluated.evaluation.failures[0] ?? "unknown"}`);
      if (scenario.frameCount !== evaluated.evaluation.measuredOutputs) throw new CertificationValidationError(`$runtime.scenarios.${id}.frameCount`, "reported throughput frame count does not match raw ledger");
      if (scenario.boundaryCount !== 0 || scenario.formatUnderflows !== 0) throw new CertificationValidationError(`$runtime.scenarios.${id}`, "reported throughput boundary/underflow counts do not match raw ledger");
      continue;
    }
    genericEvidenceIds.push(id);
    const preliminary = evaluateRuntimeScenarioLedger(parsed, {
      candidateManifestDigest: report.candidateManifestDigest,
      scenarioId: scenario.id as never,
      repetition: scenario.repetition,
      seed: scenario.seed
    });
    requireAllowedFixture(preliminary.ledger.fixtureDigest, policy, id);
    const fixture = policy.allowedFixtureModels?.get(preliminary.ledger.fixtureDigest);
    if (fixture === undefined) throw new CertificationValidationError(`$runtime.attachments.${id}`, "trusted model extracted from the exact candidate fixture is required");
    const evaluated = evaluateRuntimeScenarioLedger(parsed, {
      candidateManifestDigest: report.candidateManifestDigest,
      fixtureDigest: preliminary.ledger.fixtureDigest,
      fixture,
      scenarioId: scenario.id as never,
      repetition: scenario.repetition,
      seed: scenario.seed
    });
    if (!evaluated.evaluation.passed) throw new CertificationValidationError(`$runtime.attachments.${id}`, `scenario ledger failed recomputation: ${evaluated.evaluation.failures[0] ?? "unknown"}`);
    if (
      scenario.boundaryCount !== evaluated.evaluation.boundaryCount ||
      scenario.frameCount !== evaluated.evaluation.frameCount ||
      (scenario.operationCount ?? 0) !== evaluated.evaluation.operationCount ||
      (scenario.headedOperationCount ?? 0) !== evaluated.evaluation.headedOperationCount ||
      scenario.formatUnderflows !== evaluated.evaluation.formatUnderflows ||
      (scenario.firstFailingOrdinal ?? null) !== evaluated.evaluation.firstFailingOrdinal
    ) throw new CertificationValidationError(`$runtime.scenarios.${id}`, "reported scenario counts do not match raw ledger");
  }
  const throughputCriterion = report.criteria.find(({ id }) => id === "runtime-throughput");
  if (report.status === "passed" && (throughputCriterion === undefined || throughputEvidenceIds.some((id) => !throughputCriterion.evidence.includes(id)))) {
    throw new CertificationValidationError("$runtime.criteria.runtime-throughput", "throughput criterion is not bound to every raw repetition ledger");
  }
  const identityCriterion = report.criteria.find(({ id }) => id === "runtime-content-identity");
  if (report.status === "passed" && (identityCriterion === undefined || genericEvidenceIds.some((id) => !identityCriterion.evidence.includes(id)))) {
    throw new CertificationValidationError("$runtime.criteria.runtime-content-identity", "content identity criterion is not bound to every raw scenario ledger");
  }
  const fatalErrorBoundaryCriterion = report.criteria.find(({ id }) => id === "runtime-fatal-error-boundary");
  if (fatalErrorBoundaryCriterion?.status === "passed") {
    const attachment = attachmentById.get(FATAL_ERROR_BOUNDARY_ATTACHMENT_ID);
    if (attachment === undefined) {
      throw new CertificationValidationError("$runtime.attachments", "fatal error-boundary attachment is missing");
    }
    if (attachment.mediaType !== "application/json") {
      throw new CertificationValidationError(`$runtime.attachments.${FATAL_ERROR_BOUNDARY_ATTACHMENT_ID}.mediaType`, "fatal error-boundary ledger must use application/json");
    }
    if (!fatalErrorBoundaryCriterion.evidence.includes(FATAL_ERROR_BOUNDARY_ATTACHMENT_ID)) {
      throw new CertificationValidationError("$runtime.criteria.runtime-fatal-error-boundary", "fatal error-boundary criterion is not bound to its raw ledger");
    }
    const parsed = parseCanonicalBundleJson(
      requiredVerifiedBytes(verifiedAttachments, FATAL_ERROR_BOUNDARY_ATTACHMENT_ID),
      `$runtime.attachments.${FATAL_ERROR_BOUNDARY_ATTACHMENT_ID}`,
      policy.maximumAttachmentBytes
    );
    const evaluated = evaluateFatalErrorBoundaryLedger(parsed, {
      candidateManifestDigest: report.candidateManifestDigest,
      runId: report.reportId,
      profileId: createPublicProfileId(report.environment),
      environmentDigest: runtimeEnvironmentDigest(report.environment)
    });
    if (
      policy.allowedFatalBoundaryFixtureDigests === undefined ||
      !policy.allowedFatalBoundaryFixtureDigests.has(evaluated.ledger.fixtureDigest)
    ) {
      throw new CertificationValidationError(
        `$runtime.attachments.${FATAL_ERROR_BOUNDARY_ATTACHMENT_ID}`,
        "fatal error-boundary fixture is not the exact candidate fault source"
      );
    }
    if (
      policy.allowedCertificationHarnessDigests === undefined ||
      !policy.allowedCertificationHarnessDigests.has(evaluated.ledger.harnessDigest)
    ) {
      throw new CertificationValidationError(
        `$runtime.attachments.${FATAL_ERROR_BOUNDARY_ATTACHMENT_ID}`,
        "fatal error-boundary harness is not present in the exact candidate manifest"
      );
    }
    if (!evaluated.evaluation.passed) {
      throw new CertificationValidationError(
        `$runtime.attachments.${FATAL_ERROR_BOUNDARY_ATTACHMENT_ID}`,
        `fatal error-boundary ledger failed recomputation: ${evaluated.evaluation.failures[0] ?? "unknown"}`
      );
    }
  }
  return Object.freeze({ report, attachments: verifiedAttachments });
}

function requireAllowedFixture(digest: string, policy: ReportBundlePolicy, id: string): void {
  if (policy.allowedFixtureDigests === undefined || !policy.allowedFixtureDigests.has(digest)) {
    throw new CertificationValidationError(`$runtime.attachments.${id}`, "scenario fixture digest is not present in the exact candidate manifest");
  }
}

export async function validateDisplayReportBundle(input: {
  readonly root: string;
  readonly display: unknown;
  readonly runtimeReportBytes: Uint8Array;
  readonly policy: ReportBundlePolicy;
}): Promise<DisplayCertificationReport> {
  const display = validateDisplayReport(input.display);
  const digest = createHash("sha256").update(input.runtimeReportBytes).digest("hex");
  if (digest !== display.runtimeReportDigest) throw new CertificationValidationError("$display.runtimeReportDigest", "referenced runtime report digest mismatch");
  const runtimeInput = parseCanonicalBundleJson(input.runtimeReportBytes, "$display.runtimeReport", input.policy.maximumAttachmentBytes);
  const runtimeBundle = await validateRuntimeReportBundleVerified(input.root, runtimeInput, input.policy);
  const runtime = runtimeBundle.report;
  if (runtime.status !== "passed") throw new CertificationValidationError("$display.runtimeReportStatus", "referenced runtime report did not pass");
  if (runtime.reportId !== display.runtimeReportId) throw new CertificationValidationError("$display.runtimeReportId", "referenced runtime report ID mismatch");
  if (runtime.candidateManifestDigest !== display.candidateManifestDigest) throw new CertificationValidationError("$display.candidateManifestDigest", "referenced runtime report candidate mismatch");
  const displayAttachments = await verifyBundleAttachments(input.root, display.attachments, input.policy);
  const scenario = runtime.scenarios.find(({ id, repetition }) => id === display.runtimeScenarioId && repetition === display.runtimeScenarioRepetition);
  if (scenario === undefined || scenario.status !== "passed") throw new CertificationValidationError("$display.runtimeScenarioId", "referenced passed runtime scenario is missing");
  if (scenario.id === REQUIRED_RUNTIME_SCENARIOS.throughput.id) throw new CertificationValidationError("$display.runtimeScenarioId", "decoder throughput scenario has no rendered display schedule");
  if (scenario.ledgerDigest !== display.runtimeScenarioLedgerDigest) throw new CertificationValidationError("$display.runtimeScenarioLedgerDigest", "referenced runtime scenario ledger mismatch");
  const runtimeAttachmentId = scenarioAttachmentId(scenario.id, scenario.repetition);
  const runtimeAttachment = runtime.attachments.find(({ id }) => id === runtimeAttachmentId);
  if (runtimeAttachment === undefined || runtimeAttachment.mediaType !== "application/json" || runtimeAttachment.sha256 !== scenario.ledgerDigest) throw new CertificationValidationError("$display.runtimeScenarioLedgerDigest", "referenced runtime scenario attachment mismatch");
  const runtimeLedgerInput = parseCanonicalBundleJson(requiredVerifiedBytes(runtimeBundle.attachments, runtimeAttachmentId), `$display.runtimeScenario.${runtimeAttachmentId}`, input.policy.maximumAttachmentBytes);
  const preliminary = evaluateRuntimeScenarioLedger(runtimeLedgerInput, {
    candidateManifestDigest: display.candidateManifestDigest,
    scenarioId: scenario.id as never,
    repetition: scenario.repetition,
    seed: scenario.seed
  });
  requireAllowedFixture(preliminary.ledger.fixtureDigest, input.policy, runtimeAttachmentId);
  const fixture = input.policy.allowedFixtureModels?.get(preliminary.ledger.fixtureDigest);
  if (fixture === undefined) throw new CertificationValidationError("$display.runtimeScenarioLedgerDigest", "trusted candidate fixture model is required");
  const runtimeEvaluation = evaluateRuntimeScenarioLedger(runtimeLedgerInput, {
    candidateManifestDigest: display.candidateManifestDigest,
    fixtureDigest: preliminary.ledger.fixtureDigest,
    fixture,
    scenarioId: scenario.id as never,
    repetition: scenario.repetition,
    seed: scenario.seed
  });
  if (!runtimeEvaluation.evaluation.passed) throw new CertificationValidationError("$display.runtimeScenarioLedgerDigest", "referenced runtime scenario failed recomputation");
  const pattern = input.policy.allowedDisplayPatterns?.get(display.patternDigest);
  if (pattern === undefined) throw new CertificationValidationError("$display.patternDigest", "display pattern is not present in exact candidate artifacts");
  const attachmentById = new Map(display.attachments.map((attachment) => [attachment.id, attachment]));
  const rawCapture = attachmentById.get(DISPLAY_RAW_CAPTURE_ATTACHMENT_ID)!;
  requireRawCaptureMediaType(display.method, rawCapture.mediaType);
  requireCaptureAuthority(display, input.policy);
  const observationInput = parseCanonicalBundleJson(requiredVerifiedBytes(displayAttachments, DISPLAY_OBSERVATION_LEDGER_ATTACHMENT_ID), "$display.observationLedger", input.policy.maximumAttachmentBytes);
  const observationLedger = validateDisplayCaptureLedger(observationInput);
  validateRawCaptureEvidence(display, requiredVerifiedAttachment(displayAttachments, DISPLAY_RAW_CAPTURE_ATTACHMENT_ID), observationLedger, input.policy);
  const evaluated = evaluateDisplayEvidence(observationInput, pattern, deriveRuntimeDisplaySchedule(runtimeEvaluation.ledger, fixture), {
    candidateManifestDigest: display.candidateManifestDigest,
    runtimeReportDigest: display.runtimeReportDigest,
    runtimeScenarioId: display.runtimeScenarioId,
    runtimeScenarioRepetition: display.runtimeScenarioRepetition,
    runtimeScenarioLedgerDigest: display.runtimeScenarioLedgerDigest,
    patternDigest: display.patternDigest,
    method: display.method,
    captureRateMilliHz: display.captureRateMilliHz,
    measuredRefreshMilliHz: display.measuredRefreshMilliHz,
    minimumConfidenceMillionths: display.minimumConfidenceMillionths,
    captureProvenance: display.captureProvenance,
    idealContentFrameIntervalMicroseconds: Math.round(fixture.frameRateDenominator * 1_000_000 / fixture.frameRateNumerator)
  }).evaluation;
  requireDisplaySummaryMatch(display, evaluated);
  return display;
}

function requireDisplaySummaryMatch(display: DisplayCertificationReport, evaluation: ReturnType<typeof evaluateDisplayEvidence>["evaluation"]): void {
  if (display.status !== evaluation.status) throw new CertificationValidationError("$display.status", "reported display status does not match raw evidence recomputation");
  for (const field of ["observationCount", "refreshCount", "distinctAppearanceCount", "thresholdMicroseconds", "firstFailingRefreshOrdinal"] as const) {
    if (display[field] !== evaluation[field]) throw new CertificationValidationError(`$display.${field}`, "reported display summary does not match raw evidence recomputation");
  }
  if (display.criteria.length !== REQUIRED_DISPLAY_CRITERION_IDS.length) throw new CertificationValidationError("$display.criteria", "display criteria must exactly match the normative set");
  const criteria = new Map(display.criteria.map((criterion) => [criterion.id, criterion]));
  for (const id of REQUIRED_DISPLAY_CRITERION_IDS) {
    const criterion = criteria.get(id);
    if (criterion === undefined || criterion.status !== evaluation.criteria[id]) throw new CertificationValidationError(`$display.criteria.${id}`, "reported criterion status does not match raw evidence recomputation");
    if (!criterion.evidence.includes(DISPLAY_OBSERVATION_LEDGER_ATTACHMENT_ID) || !criterion.evidence.includes(DISPLAY_RAW_CAPTURE_ATTACHMENT_ID)) throw new CertificationValidationError(`$display.criteria.${id}`, "criterion is not bound to both raw display artifacts");
  }
}
