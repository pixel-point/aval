import { assessDisplayCapture, type DisplayRefreshObservation } from "./display-capture-assessment.js";
import { validateDisplayCaptureLedger, type DisplayCaptureLedger } from "./display-evidence-model.js";
import { displayMarkerFields, type DisplayPatternDefinition } from "./display-pattern.js";
import { quantileNearestRank } from "./runtime-criteria.js";
import type { RuntimeDisplayScheduleEntry } from "./runtime-scenario-grader.js";
import type { DisplayCaptureProvenance } from "./model.js";
import type { CertificationStatus } from "./status.js";

export type { DisplayCaptureLedger, DisplayCaptureSample } from "./display-evidence-model.js";
export { DISPLAY_CAPTURE_SAMPLE_KEYS, validateDisplayCaptureLedger } from "./display-evidence-model.js";

export interface DisplayEvidenceEvaluation {
  readonly status: CertificationStatus;
  readonly observationCount: number;
  readonly refreshCount: number;
  readonly distinctAppearanceCount: number;
  readonly thresholdMicroseconds: number;
  readonly firstFailingRefreshOrdinal: number | null;
  readonly failures: readonly string[];
  readonly inconclusiveReasons: readonly string[];
  readonly criteria: Readonly<Record<"display-content-identity" | "display-boundary-interval" | "display-capture-calibration" | "display-capture-completeness", CertificationStatus>>;
}

export interface DisplayEvidenceExpectation {
  readonly candidateManifestDigest: string;
  readonly runtimeReportDigest: string;
  readonly runtimeScenarioId: string;
  readonly runtimeScenarioRepetition: number;
  readonly runtimeScenarioLedgerDigest: string;
  readonly patternDigest: string;
  readonly method: DisplayCaptureLedger["method"];
  readonly captureRateMilliHz: number;
  readonly measuredRefreshMilliHz: number;
  readonly minimumConfidenceMillionths: number;
  readonly captureProvenance: DisplayCaptureProvenance;
  readonly idealContentFrameIntervalMicroseconds: number;
}

interface Appearance {
  readonly refreshOrdinal: number;
  readonly timestampMicroseconds: number;
  readonly scheduleIndex: number;
  readonly boundary: boolean;
}

export function evaluateDisplayEvidence(
  input: unknown,
  pattern: DisplayPatternDefinition,
  schedule: readonly RuntimeDisplayScheduleEntry[],
  expected: DisplayEvidenceExpectation
): Readonly<{ readonly ledger: DisplayCaptureLedger; readonly evaluation: DisplayEvidenceEvaluation }> {
  const ledger = validateDisplayCaptureLedger(input);
  assertExactBindings(ledger, expected);
  if (ledger.method === "external-high-speed-capture" && ledger.captureRateMilliHz / ledger.measuredRefreshMilliHz < 4) throw new TypeError("external capture rate is below four times refresh");
  if (!Number.isSafeInteger(expected.idealContentFrameIntervalMicroseconds) || expected.idealContentFrameIntervalMicroseconds <= 0) throw new TypeError("ideal content frame interval is invalid");
  const capture = assessDisplayCapture(ledger, pattern);
  const failures = [...capture.failures];
  const inconclusive = [...capture.inconclusiveReasons];
  if (schedule.length < 2) inconclusive.push("runtime-schedule-insufficient");
  if (!schedule.some(({ boundary }) => boundary)) inconclusive.push("runtime-schedule-boundary-empty");
  const mapped = mapRefreshes(capture.refreshes, schedule, pattern, failures, inconclusive);
  const intervals = mapped.appearances.slice(1).map((appearance, index) => ({
    appearance,
    interval: appearance.timestampMicroseconds - mapped.appearances[index]!.timestampMicroseconds
  }));
  const nonBoundary = intervals.filter(({ appearance }) => !appearance.boundary).map(({ interval }) => interval);
  if (mapped.appearances.length > 1 && nonBoundary.length === 0) inconclusive.push("non-boundary-display-baseline-empty");
  const thresholdMicroseconds = Math.ceil(Math.max(
    expected.idealContentFrameIntervalMicroseconds * 1.5,
    quantileNearestRank(nonBoundary, 99, 100) + expected.idealContentFrameIntervalMicroseconds * 0.5
  ));
  let firstFailingRefreshOrdinal = mapped.firstFailingRefreshOrdinal;
  for (const { appearance, interval } of intervals) {
    if (appearance.boundary && interval > thresholdMicroseconds) {
      failures.push(`display-boundary-interval:${String(appearance.refreshOrdinal)}`);
      firstFailingRefreshOrdinal ??= appearance.refreshOrdinal;
    }
  }
  const uniqueFailures = Object.freeze([...new Set(failures)]);
  const uniqueInconclusive = Object.freeze([...new Set(inconclusive)]);
  const status: CertificationStatus = uniqueInconclusive.length > 0 ? "inconclusive" : uniqueFailures.length > 0 ? "failed" : "passed";
  const completenessUncertain = uniqueInconclusive.some((reason) => /^(?:capture-|refresh-|observations-|runtime-schedule-coverage)/u.test(reason));
  const baselineUncertain = completenessUncertain || uniqueInconclusive.some((reason) => reason === "runtime-schedule-insufficient" || reason === "runtime-schedule-boundary-empty" || reason === "non-boundary-display-baseline-empty");
  const criteria = Object.freeze({
    "display-content-identity": completenessUncertain ? "inconclusive" as const : statusForFailures(uniqueFailures, ["display-content-identity", "display-content-skip", "display-content-regression", "display-black", "display-transparent-uninitialized"]),
    "display-boundary-interval": baselineUncertain ? "inconclusive" as const : statusForFailures(uniqueFailures, ["display-boundary-interval"]),
    "display-capture-calibration": uniqueInconclusive.some((reason) => reason.startsWith("calibration-")) ? "inconclusive" as const : "passed" as const,
    "display-capture-completeness": completenessUncertain ? "inconclusive" as const : "passed" as const
  });
  return Object.freeze({
    ledger,
    evaluation: Object.freeze({
      status,
      observationCount: ledger.samples.length,
      refreshCount: capture.refreshes.length,
      distinctAppearanceCount: mapped.appearances.length,
      thresholdMicroseconds,
      firstFailingRefreshOrdinal,
      failures: uniqueFailures,
      inconclusiveReasons: uniqueInconclusive,
      criteria
    })
  });
}

function mapRefreshes(
  refreshes: readonly DisplayRefreshObservation[],
  schedule: readonly RuntimeDisplayScheduleEntry[],
  pattern: DisplayPatternDefinition,
  failures: string[],
  inconclusive: string[]
): Readonly<{ readonly appearances: readonly Appearance[]; readonly firstFailingRefreshOrdinal: number | null }> {
  const appearances: Appearance[] = [];
  let cursor = -1;
  let firstFailingRefreshOrdinal: number | null = null;
  for (const refresh of refreshes) {
    if (refresh.blackDetected) {
      failures.push(`display-black:${String(refresh.ordinal)}`);
      firstFailingRefreshOrdinal ??= refresh.ordinal;
    }
    if (refresh.transparentUninitializedDetected) {
      failures.push(`display-transparent-uninitialized:${String(refresh.ordinal)}`);
      firstFailingRefreshOrdinal ??= refresh.ordinal;
    }
    if (refresh.contentValue === null || refresh.occurrenceValue === null || schedule.length === 0) continue;
    const current = cursor < 0 ? undefined : schedule[cursor];
    if (current !== undefined && matches(refresh, current, pattern)) continue;
    const next = schedule[cursor + 1];
    if (next !== undefined && matches(refresh, next, pattern)) {
      cursor += 1;
      appearances.push(appearance(refresh, cursor, next));
      continue;
    }
    const laterIndex = schedule.findIndex((entry, index) => index > cursor + 1 && matches(refresh, entry, pattern));
    if (laterIndex >= 0) {
      failures.push(`display-content-skip:${String(refresh.ordinal)}`);
      firstFailingRefreshOrdinal ??= refresh.ordinal;
      cursor = laterIndex;
      appearances.push(appearance(refresh, cursor, schedule[cursor]!));
      continue;
    }
    const earlier = schedule.some((entry, index) => index < cursor && matches(refresh, entry, pattern));
    failures.push(`${earlier ? "display-content-regression" : "display-content-identity"}:${String(refresh.ordinal)}`);
    firstFailingRefreshOrdinal ??= refresh.ordinal;
  }
  if (schedule.length > 0 && (appearances[0]?.scheduleIndex !== 0 || cursor !== schedule.length - 1 || appearances.some((value, index) => index > 0 && value.scheduleIndex !== appearances[index - 1]!.scheduleIndex + 1))) inconclusive.push("runtime-schedule-coverage-incomplete");
  return Object.freeze({ appearances: Object.freeze(appearances), firstFailingRefreshOrdinal });
}

function matches(refresh: DisplayRefreshObservation, schedule: RuntimeDisplayScheduleEntry, pattern: DisplayPatternDefinition): boolean {
  return refresh.contentValue === displayMarkerFields(schedule.contentOrdinal, pattern).value && refresh.occurrenceValue === displayMarkerFields(schedule.occurrenceOrdinal, pattern).value;
}

function appearance(refresh: DisplayRefreshObservation, scheduleIndex: number, schedule: RuntimeDisplayScheduleEntry): Appearance {
  return Object.freeze({ refreshOrdinal: refresh.ordinal, timestampMicroseconds: refresh.timestampMicroseconds, scheduleIndex, boundary: schedule.boundary });
}

function statusForFailures(failures: readonly string[], prefixes: readonly string[]): CertificationStatus {
  return failures.some((failure) => prefixes.some((prefix) => failure.startsWith(prefix))) ? "failed" : "passed";
}

function assertExactBindings(ledger: DisplayCaptureLedger, expected: DisplayEvidenceExpectation): void {
  const bindings = [
    [ledger.candidateManifestDigest, expected.candidateManifestDigest, "candidate manifest"],
    [ledger.runtimeReportDigest, expected.runtimeReportDigest, "runtime report"],
    [ledger.runtimeScenarioId, expected.runtimeScenarioId, "runtime scenario"],
    [ledger.runtimeScenarioLedgerDigest, expected.runtimeScenarioLedgerDigest, "runtime scenario ledger"],
    [ledger.patternDigest, expected.patternDigest, "display pattern"],
    [ledger.method, expected.method, "capture method"],
    [ledger.captureRateMilliHz, expected.captureRateMilliHz, "capture rate"],
    [ledger.measuredRefreshMilliHz, expected.measuredRefreshMilliHz, "measured refresh"],
    [ledger.minimumConfidenceMillionths, expected.minimumConfidenceMillionths, "confidence threshold"]
  ] as const;
  for (const [actual, wanted, name] of bindings) if (actual !== wanted) throw new TypeError(`${name} binding mismatch`);
  if (ledger.runtimeScenarioRepetition !== expected.runtimeScenarioRepetition) throw new TypeError("runtime scenario repetition binding mismatch");
  if (
    ledger.captureProvenance.rawCaptureDigest !== expected.captureProvenance.rawCaptureDigest ||
    ledger.captureProvenance.extractor.tool !== expected.captureProvenance.extractor.tool ||
    ledger.captureProvenance.extractor.version !== expected.captureProvenance.extractor.version ||
    ledger.captureProvenance.operatorRole !== expected.captureProvenance.operatorRole ||
    ledger.captureProvenance.reviewerIds.length !== expected.captureProvenance.reviewerIds.length ||
    ledger.captureProvenance.reviewerIds.some((reviewer, index) => reviewer !== expected.captureProvenance.reviewerIds[index])
  ) throw new TypeError("capture provenance binding mismatch");
}
