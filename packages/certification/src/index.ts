export { canonicalJson, canonicalJsonBytes, DEFAULT_CANONICAL_LIMITS } from "./canonical-json.js";
export type { CanonicalJsonLimits, CanonicalValue } from "./canonical-json.js";
export { browserBuildMatchesProductVersion, EXACT_BROWSER_BUILD_PATTERN_SOURCE, EXACT_PRODUCT_VERSION_PATTERN_SOURCE, isExactBrowserBuild, isExactProductVersion } from "./exact-version.js";
export { loadCertificationSchema } from "./schema-loader.js";
export { validateDisplayReport, validateRuntimeEnvironment, validateRuntimeReport } from "./schema-validation.js";
export { validateDisplayReportBundle, validateRuntimeReportBundle } from "./report-bundle.js";
export type { ReportBundlePolicy } from "./report-bundle.js";
export { PUBLIC_RELEASE_DEPENDENCIES, PUBLIC_RELEASE_PACKAGES, validateApiClassifications, validateSynchronizedReleaseSet } from "./compatibility.js";
export type { ApiClassification, ReleasePackageManifest } from "./compatibility.js";
export { runConformance } from "./conformance-runner.js";
export type { ConformanceCaseResult, ConformanceRun, ConformanceTask, ConformanceTaskContext } from "./conformance-runner.js";
export { CertificationFrameLedger } from "./frame-ledger.js";
export type { CertificationFrameLedgerEntry } from "./frame-ledger.js";
export { CertificationResourceLedger } from "./resource-ledger.js";
export type { CertificationResourceSnapshot } from "./resource-ledger.js";
export { readStableBoundedFile, readVerifiedArtifactReferences, sha256File, verifyArtifactReferences } from "./artifact-verifier.js";
export { functionalEngineResult } from "./automation-profile.js";
export type { FunctionalEngineResult } from "./automation-profile.js";
export type { ArtifactReadOptions, ArtifactVerificationOptions, VerifiedArtifact } from "./artifact-verifier.js";
export { capabilityOutcome, REQUIRED_ANIMATED_CAPABILITY_PROBES } from "./capability-record.js";
export type { CapabilityProbeRecord } from "./capability-record.js";
export { summarizeBenchmark } from "./benchmark-statistics.js";
export { renderBenchmarkMarkdown } from "./benchmark-report.js";
export type { BenchmarkSampleSet, BenchmarkStatistics } from "./benchmark-statistics.js";
export type { BenchmarkRecord } from "./benchmark-model.js";
export { DISPLAY_CAPTURE_SAMPLE_KEYS, evaluateDisplayEvidence, validateDisplayCaptureLedger } from "./display-evidence.js";
export type { DisplayCaptureLedger, DisplayCaptureSample, DisplayEvidenceEvaluation, DisplayEvidenceExpectation } from "./display-evidence.js";
export { displayMarkerFields, validateDisplayPattern } from "./display-pattern.js";
export type { DisplayPatternDefinition } from "./display-pattern.js";
export { evaluateDecoderThroughputLedger } from "./decoder-throughput-ledger.js";
export type { DecoderThroughputEvaluation, DecoderThroughputEvent, DecoderThroughputLedger, DecoderThroughputOutput } from "./decoder-throughput-ledger.js";
export { evaluateFatalErrorBoundaryLedger } from "./fatal-error-boundary-ledger.js";
export type { FatalErrorBoundaryEvaluation, FatalErrorBoundaryLedger, FatalErrorBoundarySourceCleanup } from "./fatal-error-boundary-ledger.js";
export { renderDisplayReportMarkdown } from "./display-report.js";
export { assertForegroundEnvironment, createPublicProfileId, runtimeEnvironmentDigest } from "./environment-validation.js";
export { evaluateOwnershipSettlement } from "./ownership-criteria.js";
export type { OwnershipCounters, OwnershipCriteriaResult } from "./ownership-criteria.js";
export { evaluateRuntimeCriteria, quantileNearestRank } from "./runtime-criteria.js";
export { renderRuntimeReportMarkdown } from "./runtime-report.js";
export { deriveRuntimeDisplaySchedule, evaluateRuntimeScenarioLedger, REQUIRED_ROUTE_CLASSES, runtimeFixtureModelFromManifest } from "./runtime-scenario-ledger.js";
export type { RawRuntimeCursor, RawRuntimeGraphEffect, RawRuntimeGraphEvent, RawRuntimeOperationEvent, RawRuntimeResourceEvent, RawRuntimeScenarioFrame, RuntimeDisplayScheduleEntry, RuntimeFixtureModel, RuntimeScenarioLedger, RuntimeScenarioLedgerEvaluation, RuntimeScenarioLedgerExpectation } from "./runtime-scenario-ledger.js";
export { assertApprovedReviews, validateReviewRecord } from "./review-record.js";
export type { CertificationReviewEntry, CertificationReviewSummary } from "./review-record.js";
export { evaluateNamedProfileMatrix } from "./report-index-criteria.js";
export type { NamedBrowserMatrixRequirement, NamedProfileIndexInput, NamedProfileMatrixPolicy, NamedProfileMatrixResult } from "./report-index-criteria.js";
export { aggregateObservedDisplayStatus, validateReportIndex } from "./report-index-model.js";
export type { CertificationIndexProfile, CertificationReportIndex } from "./report-index-model.js";
export { evaluateRouteCriteria } from "./route-criteria.js";
export type { RouteCriteriaResult, RouteLedgerEntry } from "./route-criteria.js";
export type { RuntimeCounterSnapshot, RuntimeCounterWindow, RuntimeCriteriaInput, RuntimeCriteriaResult, RuntimeFrameLedgerEntry } from "./runtime-criteria.js";
export { DISPLAY_OBSERVATION_LEDGER_ATTACHMENT_ID, DISPLAY_RAW_CAPTURE_ATTACHMENT_ID, FATAL_ERROR_BOUNDARY_ATTACHMENT_ID, RELEASE_RUNTIME_REPETITIONS, REQUIRED_DISPLAY_CRITERION_IDS, REQUIRED_RUNTIME_CRITERION_IDS, REQUIRED_RUNTIME_SCENARIOS, scenarioAttachmentId, validateScenarioCoverage } from "./scenario-contract.js";
export type { ScenarioCoverageInput } from "./scenario-contract.js";
export { candidateManifestDigest, validateCandidateManifest, validateReleaseManifest } from "./release-manifest.js";
export { compareVersions, validateCandidateToolchain } from "./toolchain-policy.js";
export type { CandidateToolchainCapture, CandidateToolchainPolicy } from "./toolchain-policy.js";
export { assertPromotionAllowed, completePublicationOperation, failPublicationOperation, markPublicationOperationAmbiguous, planDeprecation, planExactPublication, planExactTag, planTagCompensation, publicationLedgerDigest, registryStateDigest, rollbackOrder, simulatePublication, validatePublicationLedger } from "./publication-ledger.js";
export type { PublicationLedger, PublicationOperation, PublicationResult, PublicationSimulationResult, RegistryPackageState } from "./publication-ledger.js";
export { assertCertificationStatus, CERTIFICATION_STATUSES, CertificationValidationError, isCertificationStatus } from "./status.js";
export type {
  CandidateArtifact,
  CandidateBrowserPin,
  CandidateManifest,
  CriterionResult,
  DigestReference,
  DisplayCertificationReport,
  ReleaseManifest,
  RuntimeCertificationReport,
  RuntimeEnvironment,
  RuntimeScenarioResult
} from "./model.js";
export type { CertificationStatus } from "./status.js";
