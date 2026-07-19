import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { canonicalJsonBytes, DEFAULT_CANONICAL_LIMITS } from "../src/canonical-json.js";
import { evaluateDisplayEvidence } from "../src/display-evidence.js";
import { validateDisplayReportBundle, validateRuntimeReportBundle } from "../src/report-bundle.js";
import { deriveRuntimeDisplaySchedule, evaluateRuntimeScenarioLedger } from "../src/runtime-scenario-ledger.js";
import { REQUIRED_DISPLAY_CRITERION_IDS } from "../src/scenario-contract.js";
import { validRuntimeReport } from "./test-report.js";
import { createRawScenarioLedger, TEST_FIXTURE_DIGEST, TEST_RUNTIME_FIXTURE } from "./runtime-scenario-support.js";
import { createDisplayCaptureLedger, TEST_DISPLAY_PATTERN, TEST_DISPLAY_PATTERN_DIGEST } from "./display-evidence-support.js";
import {
  TEST_FATAL_ERROR_BOUNDARY_ATTACHMENT_ID,
  TEST_FATAL_ERROR_BOUNDARY_FIXTURE_DIGEST,
  TEST_FATAL_ERROR_BOUNDARY_HARNESS_DIGEST,
  validFatalErrorBoundaryLedger
} from "./fatal-error-boundary-support.js";

const policy = {
  maximumAttachmentBytes: 16 * 1024 * 1024,
  allowedMediaTypes: new Set(["application/json", "text/csv", "video/mp4"]),
  allowedFixtureDigests: new Set([TEST_FIXTURE_DIGEST]),
  allowedFixtureModels: new Map([[TEST_FIXTURE_DIGEST, TEST_RUNTIME_FIXTURE]]),
  allowedFatalBoundaryFixtureDigests: new Set([TEST_FATAL_ERROR_BOUNDARY_FIXTURE_DIGEST]),
  allowedCertificationHarnessDigests: new Set([TEST_FATAL_ERROR_BOUNDARY_HARNESS_DIGEST]),
  allowedDisplayPatterns: new Map([[TEST_DISPLAY_PATTERN_DIGEST, TEST_DISPLAY_PATTERN]]),
  allowedDisplayCaptureExtractors: new Map([["aval-display-extractor", "1.0.0"]]),
  allowedDisplayCaptureOperatorRoles: new Set(["qualified-display-capture-operator"]),
  allowedDisplayCaptureReviewerIds: new Set(["display-reviewer-1", "display-reviewer-2"])
};

describe("report bundle validation", () => {
  it("binds report attachment length and digest to actual bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "aval-report-"));
    try {
      const evidence = new Map<string, Uint8Array>();
      const attached = await materializeRuntimeBundle(evidence);
      await expect(validateRuntimeReportBundle(root, attached, memoryPolicy(evidence))).resolves.toMatchObject({ reportId: attached.reportId });
      await expect(validateRuntimeReportBundle(root, {
        ...attached,
        attachments: attached.attachments.map((item: any, index: number) => index === 0 ? { ...item, byteLength: 1 } : item)
      }, memoryPolicy(evidence))).rejects.toThrow(/byte length mismatch/u);

      const reads = new Map<string, number>();
      await expect(validateRuntimeReportBundle(root, attached, {
        ...policy,
        readAttachment: async (_root: string, path: string) => {
          reads.set(path, (reads.get(path) ?? 0) + 1);
          return evidence.get(path)!;
        }
      })).resolves.toMatchObject({ reportId: attached.reportId });
      expect([...reads.values()].every((count) => count === 1)).toBe(true);

      let oversizedRead = false;
      const oversized = structuredClone(attached) as any;
      oversized.attachments[0].byteLength = 16 * 1024 * 1024 + 1;
      await expect(validateRuntimeReportBundle(root, oversized, {
        ...policy,
        maximumAttachmentBytes: 128 * 1024 * 1024,
        readAttachment: async () => { oversizedRead = true; return new Uint8Array(0); }
      })).rejects.toThrow(/structured attachment exceeds/u);
      expect(oversizedRead).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("requires exact recomputable fatal error-boundary evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "aval-error-boundary-"));
    try {
      const evidence = new Map<string, Uint8Array>();
      const report = await materializeRuntimeBundle(evidence);
      const unrelatedEvidence = report.attachments.find(({ id }: { id: string }) => id.startsWith("scenario-"))!.id;

      const missing = structuredClone(report) as any;
      missing.attachments = missing.attachments.filter(({ id }: { id: string }) => id !== TEST_FATAL_ERROR_BOUNDARY_ATTACHMENT_ID);
      missing.criteria.find(({ id }: { id: string }) => id === "runtime-fatal-error-boundary").evidence = [unrelatedEvidence];
      await expect(validateRuntimeReportBundle(root, missing, memoryPolicy(evidence))).rejects.toThrow(/fatal error-boundary attachment is missing/u);

      const unbound = structuredClone(report) as any;
      unbound.criteria.find(({ id }: { id: string }) => id === "runtime-fatal-error-boundary").evidence = [unrelatedEvidence];
      await expect(validateRuntimeReportBundle(root, unbound, memoryPolicy(evidence))).rejects.toThrow(/fatal error-boundary criterion is not bound/u);

      const forgedEvidence = new Map(evidence);
      const forged = rebindFatalErrorBoundaryLedger(report, forgedEvidence, (ledger) => {
        ledger.errorEventCount = 2;
      });
      await expect(validateRuntimeReportBundle(root, forged, memoryPolicy(forgedEvidence))).rejects.toThrow(/error-event-count-not-one/u);

      const replayedAcrossEnvironment = structuredClone(report) as any;
      replayedAcrossEnvironment.environment.browser.build = "20600.1.3";
      await expect(validateRuntimeReportBundle(root, replayedAcrossEnvironment, memoryPolicy(evidence))).rejects.toThrow(/environment-digest-mismatch|profile-id-mismatch/u);

      const replayedAcrossRun = { ...report, reportId: "runtime-macos-safari-replay" };
      await expect(validateRuntimeReportBundle(root, replayedAcrossRun, memoryPolicy(evidence))).rejects.toThrow(/run-id-mismatch/u);

      await expect(validateRuntimeReportBundle(root, report, {
        ...memoryPolicy(evidence),
        allowedFatalBoundaryFixtureDigests: new Set(["d".repeat(64)])
      })).rejects.toThrow(/exact candidate fault source/u);
      await expect(validateRuntimeReportBundle(root, report, {
        ...memoryPolicy(evidence),
        allowedCertificationHarnessDigests: new Set(["d".repeat(64)])
      })).rejects.toThrow(/harness is not present/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects fabricated throughput counts and callback timings despite passed report flags", async () => {
    const root = await mkdtemp(join(tmpdir(), "aval-throughput-"));
    try {
      const evidence = new Map<string, Uint8Array>();
      const report = await materializeRuntimeBundle(evidence);
      const throughputIndex = report.scenarios.findIndex(({ id }: { id: string }) => id === "decoder-throughput-300");
      const fabricated = structuredClone(report) as any;
      fabricated.scenarios[throughputIndex]!.frameCount = 999;
      await expect(validateRuntimeReportBundle(root, fabricated, memoryPolicy(evidence))).rejects.toThrow(/does not match raw ledger/u);

      const attachment = report.attachments.find(({ id }: { id: string }) => id === "scenario-decoder-throughput-300-1")!;
      const slow = throughputLedger(1) as any;
      slow.outputs.forEach((output: any) => { output.callbackMicroseconds = output.outputOrdinal * 30_000; });
      slow.events.filter((event: any) => event.outputOrdinal !== null).forEach((event: any) => { event.atMicroseconds = event.outputOrdinal * 30_000; });
      slow.events.at(-1).atMicroseconds = 324 * 30_000;
      const bytes = canonicalJsonBytes(slow);
      evidence.set(attachment.path, bytes);
      const digest = createHash("sha256").update(bytes).digest("hex");
      const rebound = {
        ...report,
        scenarios: report.scenarios.map((scenario: any) => scenario.id === "decoder-throughput-300" && scenario.repetition === 1 ? { ...scenario, ledgerDigest: digest } : scenario),
        attachments: report.attachments.map((item: any) => item.id === attachment.id ? { ...item, sha256: digest, byteLength: bytes.byteLength } : item)
      };
      await expect(validateRuntimeReportBundle(root, rebound, memoryPolicy(evidence))).rejects.toThrow(/throughput-below-1.5x/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects fabricated boundary counts and raw content/terminal mutations", async () => {
    const root = await mkdtemp(join(tmpdir(), "aval-scenarios-"));
    try {
      const evidence = new Map<string, Uint8Array>();
      const report = await materializeRuntimeBundle(evidence);
      const fabricated = structuredClone(report) as any;
      fabricated.scenarios.find((scenario: any) => scenario.id === "loop-1000" && scenario.repetition === 1).boundaryCount += 1;
      await expect(validateRuntimeReportBundle(root, fabricated, memoryPolicy(evidence))).rejects.toThrow(/counts do not match raw ledger/u);

      const attachment = report.attachments.find(({ id }: any) => id === "scenario-loop-1000-1")!;
      const ledger = createRawScenarioLedger(report.scenarios.find((scenario: any) => scenario.id === "loop-1000" && scenario.repetition === 1));
      ledger.frames[500].graphContentOrdinal += 1;
      ledger.cleanupReceipt.openFrames = 1;
      const bytes = attachmentBytes(ledger);
      evidence.set(attachment.path, bytes);
      const digest = createHash("sha256").update(bytes).digest("hex");
      const rebound = {
        ...report,
        scenarios: report.scenarios.map((scenario: any) => scenario.id === "loop-1000" && scenario.repetition === 1 ? { ...scenario, ledgerDigest: digest } : scenario),
        attachments: report.attachments.map((item: any) => item.id === attachment.id ? { ...item, sha256: digest, byteLength: bytes.byteLength } : item)
      };
      await expect(validateRuntimeReportBundle(root, rebound, memoryPolicy(evidence))).rejects.toThrow(/content-identity|terminal-resource/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("binds observed-display evidence to the exact passed runtime report bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "aval-display-"));
    try {
      const evidence = new Map<string, Uint8Array>();
      const runtime = await materializeRuntimeBundle(evidence);
      const runtimeBytes = canonicalJsonBytes(runtime);
      const runtimeDigest = createHash("sha256").update(runtimeBytes).digest("hex");
      const scenario = runtime.scenarios.find(({ id, repetition }: any) => id === "rapid-input-10000" && repetition === 1)!;
      const scenarioAttachment = runtime.attachments.find(({ id }: any) => id === "scenario-rapid-input-10000-1")!;
      const runtimeLedger = JSON.parse(new TextDecoder().decode(evidence.get(scenarioAttachment.path)!));
      const runtimeEvaluation = evaluateRuntimeScenarioLedger(runtimeLedger, { candidateManifestDigest: runtime.candidateManifestDigest, fixtureDigest: TEST_FIXTURE_DIGEST, fixture: TEST_RUNTIME_FIXTURE, scenarioId: scenario.id, repetition: 1, seed: scenario.seed });
      const schedule = deriveRuntimeDisplaySchedule(runtimeEvaluation.ledger, TEST_RUNTIME_FIXTURE);
      const rawVideo = createTestIsoCapture();
      const rawVideoDigest = createHash("sha256").update(rawVideo).digest("hex");
      const captureProvenance = {
        rawCaptureDigest: rawVideoDigest,
        extractor: { tool: "aval-display-extractor", version: "1.0.0" },
        operatorRole: "qualified-display-capture-operator",
        reviewerIds: ["display-reviewer-1", "display-reviewer-2"]
      };
      const bindings = {
        candidateManifestDigest: runtime.candidateManifestDigest,
        runtimeReportDigest: runtimeDigest,
        runtimeScenarioId: scenario.id,
        runtimeScenarioRepetition: scenario.repetition,
        runtimeScenarioLedgerDigest: scenario.ledgerDigest,
        patternDigest: TEST_DISPLAY_PATTERN_DIGEST,
        captureProvenance
      };
      const captureLedger = createDisplayCaptureLedger(schedule, bindings);
      const captureEvaluation = evaluateDisplayEvidence(captureLedger, TEST_DISPLAY_PATTERN, schedule, {
        ...bindings,
        method: "external-high-speed-capture",
        captureRateMilliHz: 240_000,
        measuredRefreshMilliHz: 60_000,
        minimumConfidenceMillionths: 990_000,
        idealContentFrameIntervalMicroseconds: 33_333
      }).evaluation;
      expect(captureEvaluation.status).toBe("passed");
      const captureBytes = attachmentBytes(captureLedger);
      const capturePath = "display/capture.json";
      const videoPath = "display/raw.mp4";
      evidence.set(capturePath, captureBytes);
      evidence.set(videoPath, rawVideo);
      const display = {
        schemaVersion: "1.0", reportKind: "observed-display", reportId: "display-1", status: "passed",
        candidateManifestDigest: runtime.candidateManifestDigest,
        runtimeReportId: runtime.reportId,
        runtimeReportDigest: runtimeDigest,
        runtimeReportStatus: "passed", method: "external-high-speed-capture",
        captureRateMilliHz: 240000, measuredRefreshMilliHz: 60000,
        minimumConfidenceMillionths: 990_000,
        runtimeScenarioId: scenario.id,
        runtimeScenarioRepetition: scenario.repetition,
        runtimeScenarioLedgerDigest: scenario.ledgerDigest,
        patternDigest: TEST_DISPLAY_PATTERN_DIGEST,
        startedAt: "2026-07-12T12:00:00.000Z", endedAt: "2026-07-12T12:01:00.000Z",
        observationCount: captureEvaluation.observationCount,
        refreshCount: captureEvaluation.refreshCount,
        distinctAppearanceCount: captureEvaluation.distinctAppearanceCount,
        thresholdMicroseconds: captureEvaluation.thresholdMicroseconds,
        firstFailingRefreshOrdinal: captureEvaluation.firstFailingRefreshOrdinal,
        observationLedgerDigest: createHash("sha256").update(captureBytes).digest("hex"),
        captureProvenance,
        criteria: REQUIRED_DISPLAY_CRITERION_IDS.map((id) => ({ id, status: captureEvaluation.criteria[id], evidence: ["display-observation-ledger", "display-raw-capture"] })),
        attachments: [
          { id: "display-observation-ledger", path: capturePath, sha256: createHash("sha256").update(captureBytes).digest("hex"), byteLength: captureBytes.byteLength, mediaType: "application/json" },
          { id: "display-raw-capture", path: videoPath, sha256: rawVideoDigest, byteLength: rawVideo.byteLength, mediaType: "video/mp4" }
        ]
      };
      const boundPolicy = memoryPolicy(evidence);
      await expect(validateDisplayReportBundle({ root, display, runtimeReportBytes: runtimeBytes, policy: boundPolicy })).resolves.toMatchObject({ reportId: "display-1" });
      await expect(validateDisplayReportBundle({ root, display: { ...display, runtimeReportDigest: "0".repeat(64) }, runtimeReportBytes: runtimeBytes, policy: boundPolicy })).rejects.toThrow(/digest mismatch/u);
      await expect(validateDisplayReportBundle({ root, display: { ...display, observationCount: display.observationCount + 1 }, runtimeReportBytes: runtimeBytes, policy: boundPolicy })).rejects.toThrow(/summary does not match/u);

      const stub = new Uint8Array([0, 0, 0, 12, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
      const stubDigest = createHash("sha256").update(stub).digest("hex");
      evidence.set(videoPath, stub);
      const stubDisplay = {
        ...display,
        captureProvenance: { ...captureProvenance, rawCaptureDigest: stubDigest },
        attachments: display.attachments.map((attachment) => attachment.id === "display-raw-capture" ? { ...attachment, sha256: stubDigest, byteLength: stub.byteLength } : attachment)
      };
      await expect(validateDisplayReportBundle({ root, display: stubDisplay, runtimeReportBytes: runtimeBytes, policy: boundPolicy })).rejects.toThrow(/too small/u);
      evidence.set(videoPath, rawVideo);

      const substitutedProvenance = { ...captureProvenance, operatorRole: "alternate-qualified-operator" };
      await expect(validateDisplayReportBundle({
        root,
        display: { ...display, captureProvenance: substitutedProvenance },
        runtimeReportBytes: runtimeBytes,
        policy: { ...boundPolicy, allowedDisplayCaptureOperatorRoles: new Set([captureProvenance.operatorRole, substitutedProvenance.operatorRole]) }
      })).rejects.toThrow(/capture provenance binding mismatch/u);

      const traceEnvelope = {
        schemaVersion: "1.0",
        traceKind: "qualified-scanout-trace",
        candidateManifestDigest: runtime.candidateManifestDigest,
        provider: "qualified-test-provider",
        providerVersion: "1.0.0",
        extractor: captureProvenance.extractor,
        operatorRole: captureProvenance.operatorRole,
        reviewerIds: captureProvenance.reviewerIds,
        recordCount: captureLedger.samples.length,
        records: captureLedger.samples
      };
      const traceBytes = attachmentBytes(traceEnvelope);
      const traceDigest = createHash("sha256").update(traceBytes).digest("hex");
      const qualifiedLedger = structuredClone(captureLedger);
      qualifiedLedger.method = "qualified-scanout-trace";
      qualifiedLedger.captureProvenance.rawCaptureDigest = traceDigest;
      const qualifiedLedgerBytes = attachmentBytes(qualifiedLedger);
      const qualifiedLedgerDigest = createHash("sha256").update(qualifiedLedgerBytes).digest("hex");
      evidence.set(capturePath, qualifiedLedgerBytes);
      evidence.set(videoPath, traceBytes);
      const qualifiedDisplay = {
        ...display,
        method: "qualified-scanout-trace",
        captureProvenance: qualifiedLedger.captureProvenance,
        observationLedgerDigest: qualifiedLedgerDigest,
        attachments: [
          { ...display.attachments[0], sha256: qualifiedLedgerDigest, byteLength: qualifiedLedgerBytes.byteLength },
          { ...display.attachments[1], sha256: traceDigest, byteLength: traceBytes.byteLength, mediaType: "application/json" }
        ]
      };
      const qualifiedPolicy = {
        ...boundPolicy,
        allowedQualifiedScanoutProviders: new Map([["qualified-test-provider", "1.0.0"]])
      };
      await expect(validateDisplayReportBundle({ root, display: qualifiedDisplay, runtimeReportBytes: runtimeBytes, policy: qualifiedPolicy })).resolves.toMatchObject({ method: "qualified-scanout-trace" });

      const substitutedTrace = { ...traceEnvelope, records: traceEnvelope.records.map((record: any, index: number) => index === 0 ? { ...record, contentValue: (record.contentValue + 1) % 65_535 } : record) };
      const substitutedTraceBytes = attachmentBytes(substitutedTrace);
      const substitutedTraceDigest = createHash("sha256").update(substitutedTraceBytes).digest("hex");
      evidence.set(videoPath, substitutedTraceBytes);
      await expect(validateDisplayReportBundle({
        root,
        display: {
          ...qualifiedDisplay,
          captureProvenance: { ...qualifiedDisplay.captureProvenance, rawCaptureDigest: substitutedTraceDigest },
          attachments: qualifiedDisplay.attachments.map((attachment) => attachment.id === "display-raw-capture" ? { ...attachment, sha256: substitutedTraceDigest, byteLength: substitutedTraceBytes.byteLength } : attachment)
        },
        runtimeReportBytes: runtimeBytes,
        policy: qualifiedPolicy
      })).rejects.toThrow(/do not reconstruct/u);

      const dummyTraceBytes = attachmentBytes({ ...traceEnvelope, recordCount: 1, records: [{}] });
      const dummyTraceDigest = createHash("sha256").update(dummyTraceBytes).digest("hex");
      evidence.set(videoPath, dummyTraceBytes);
      await expect(validateDisplayReportBundle({
        root,
        display: {
          ...qualifiedDisplay,
          captureProvenance: { ...qualifiedDisplay.captureProvenance, rawCaptureDigest: dummyTraceDigest },
          attachments: qualifiedDisplay.attachments.map((attachment) => attachment.id === "display-raw-capture" ? { ...attachment, sha256: dummyTraceDigest, byteLength: dummyTraceBytes.byteLength } : attachment)
        },
        runtimeReportBytes: runtimeBytes,
        policy: qualifiedPolicy
      })).rejects.toThrow(/required|must be/u);

      evidence.set(capturePath, captureBytes);
      evidence.set(videoPath, rawVideo);

      const forgedLedger = structuredClone(captureLedger);
      forgedLedger.samples[0].contentComplement ^= 1;
      const forgedBytes = attachmentBytes(forgedLedger);
      evidence.set(capturePath, forgedBytes);
      const forgedDigest = createHash("sha256").update(forgedBytes).digest("hex");
      const rebound = { ...display, observationLedgerDigest: forgedDigest, attachments: display.attachments.map((attachment) => attachment.id === "display-observation-ledger" ? { ...attachment, sha256: forgedDigest, byteLength: forgedBytes.byteLength } : attachment) };
      await expect(validateDisplayReportBundle({ root, display: rebound, runtimeReportBytes: runtimeBytes, policy: boundPolicy })).rejects.toThrow(/status does not match/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);
});

async function materializeRuntimeBundle(evidence: Map<string, Uint8Array>) {
  const report = structuredClone(validRuntimeReport()) as any;
  const digestById = new Map<string, string>();
  for (const attachment of report.attachments) {
    if (attachment.id === TEST_FATAL_ERROR_BOUNDARY_ATTACHMENT_ID) {
      const bytes = attachmentBytes(validFatalErrorBoundaryLedger());
      evidence.set(attachment.path, bytes);
      attachment.sha256 = createHash("sha256").update(bytes).digest("hex");
      attachment.byteLength = bytes.byteLength;
      attachment.mediaType = "application/json";
      continue;
    }
    const match = /^scenario-decoder-throughput-300-([1-3])$/u.exec(attachment.id);
    const scenario = report.scenarios.find((candidate: any) => attachment.id === `scenario-${candidate.id}-${String(candidate.repetition)}`)!;
    const value = match === null ? createRawScenarioLedger(scenario) : throughputLedger(Number(match[1]));
    const bytes = attachmentBytes(value);
    evidence.set(attachment.path, bytes);
    attachment.sha256 = createHash("sha256").update(bytes).digest("hex");
    attachment.byteLength = bytes.byteLength;
    attachment.mediaType = "application/json";
    digestById.set(attachment.id, attachment.sha256);
  }
  for (const scenario of report.scenarios) {
    scenario.ledgerDigest = digestById.get(`scenario-${scenario.id}-${String(scenario.repetition)}`)!;
    if (scenario.id !== "decoder-throughput-300") {
      const value = createRawScenarioLedger(scenario);
      const recomputed = (await import("../src/runtime-scenario-ledger.js")).evaluateRuntimeScenarioLedger(value, { fixture: TEST_RUNTIME_FIXTURE, fixtureDigest: TEST_FIXTURE_DIGEST });
      scenario.boundaryCount = recomputed.evaluation.boundaryCount;
      scenario.frameCount = recomputed.evaluation.frameCount;
      if (recomputed.evaluation.operationCount > 0) {
        scenario.operationCount = recomputed.evaluation.operationCount;
        scenario.headedOperationCount = recomputed.evaluation.headedOperationCount;
      } else {
        delete scenario.operationCount;
        delete scenario.headedOperationCount;
      }
    }
  }
  return report;
}

function rebindFatalErrorBoundaryLedger(
  report: any,
  evidence: Map<string, Uint8Array>,
  mutate: (ledger: any) => void
): any {
  const rebound = structuredClone(report) as any;
  const attachment = rebound.attachments.find(({ id }: { id: string }) => id === TEST_FATAL_ERROR_BOUNDARY_ATTACHMENT_ID)!;
  const ledger = validFatalErrorBoundaryLedger() as any;
  mutate(ledger);
  const bytes = attachmentBytes(ledger);
  evidence.set(attachment.path, bytes);
  attachment.sha256 = createHash("sha256").update(bytes).digest("hex");
  attachment.byteLength = bytes.byteLength;
  return rebound;
}

function attachmentBytes(value: unknown): Uint8Array {
  return canonicalJsonBytes(value, { ...DEFAULT_CANONICAL_LIMITS, maxNodes: 20_000_000, maxBytes: 16 * 1024 * 1024 });
}

function memoryPolicy(evidence: ReadonlyMap<string, Uint8Array>) {
  return { ...policy, readAttachment: async (_root: string, path: string) => {
    const bytes = evidence.get(path);
    if (bytes === undefined) throw new Error(`missing in-memory attachment: ${path}`);
    return bytes;
  } };
}

function throughputLedger(repetition: number): unknown {
  const count = 324;
  return {
    schemaVersion: "1.0",
    ledgerKind: "decoder-output-throughput",
    candidateManifestDigest: "a".repeat(64),
    fixtureDigest: "b".repeat(64),
    selectedRendition: {
      id: "alpha.1x", codecFamily: "av1", codec: "av01.0.00M.10.0.110.01.01.01.0", bitDepth: 10,
      codedWidth: 64, codedHeight: 72,
      alphaLayout: { type: "stacked", colorRect: [0, 0, 64, 32], alphaRect: [0, 40, 64, 32] },
      frameRateNumerator: 30, frameRateDenominator: 1
    },
    outputs: Array.from({ length: count }, (_, outputOrdinal) => ({
      outputOrdinal,
      phase: outputOrdinal < 24 ? "warmup" : "measured",
      mediaTimestampMicroseconds: outputOrdinal * 33_333,
      mediaDurationMicroseconds: 33_333,
      callbackMicroseconds: outputOrdinal * 10_000 + repetition,
      renditionId: "alpha.1x", unitId: "idle-body", unitInstance: Math.floor(outputOrdinal / 2), localFrame: outputOrdinal % 2
    })),
    events: [
      { eventOrdinal: 0, kind: "configure", atMicroseconds: 0, outputOrdinal: null },
      ...Array.from({ length: count }, (_, outputOrdinal) => [
        { eventOrdinal: outputOrdinal * 2 + 1, kind: "output-callback", atMicroseconds: outputOrdinal * 10_000 + repetition, outputOrdinal },
        { eventOrdinal: outputOrdinal * 2 + 2, kind: "frame-close", atMicroseconds: outputOrdinal * 10_000 + repetition, outputOrdinal }
      ]).flat(),
      { eventOrdinal: count * 2 + 1, kind: "terminal", atMicroseconds: count * 10_000 + repetition, outputOrdinal: null }
    ],
    terminal: {
      decoderClosed: true, configureCalls: 1, resetCalls: 0, flushCalls: 0, boundaryFlushCalls: 0,
      acceptedSamples: count, submittedChunks: count, outputFrames: count, deliveredFrames: count, releasedFrames: count,
      staleFrames: 0, workerClosedFrames: 0, errors: 0, openFrames: 0, pendingFrames: 0, decodeQueueSize: 0
    }
  };
}

function createTestIsoCapture(): Uint8Array {
  const ftyp = isoBox("ftyp", new TextEncoder().encode("isom\0\0\0\0isomiso2"));
  const stsd = isoBox("stsd", fullBoxPayload(1, 4));
  const stts = isoBox("stts", fullBoxPayload(1, 4));
  const stsc = isoBox("stsc", fullBoxPayload(1, 4));
  const stsz = isoBox("stsz", fullBoxPayload(1, 8));
  const stco = isoBox("stco", fullBoxPayload(1, 4));
  const stbl = isoBox("stbl", concatenate([stsd, stts, stsc, stsz, stco]));
  const minf = isoBox("minf", stbl);
  const mdia = isoBox("mdia", minf);
  const trak = isoBox("trak", mdia);
  const moov = isoBox("moov", trak);
  const mdat = isoBox("mdat", new Uint8Array(4096));
  const result = new Uint8Array(ftyp.byteLength + moov.byteLength + mdat.byteLength);
  result.set(ftyp, 0);
  result.set(moov, ftyp.byteLength);
  result.set(mdat, ftyp.byteLength + moov.byteLength);
  return result;
}

function fullBoxPayload(count: number, countOffset: number): Uint8Array {
  const result = new Uint8Array(countOffset + 4);
  new DataView(result.buffer).setUint32(countOffset, count, false);
  return result;
}

function concatenate(values: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(values.reduce((total, value) => total + value.byteLength, 0));
  let offset = 0;
  for (const value of values) { result.set(value, offset); offset += value.byteLength; }
  return result;
}

function isoBox(type: string, payload: Uint8Array): Uint8Array {
  const result = new Uint8Array(payload.byteLength + 8);
  new DataView(result.buffer).setUint32(0, result.byteLength, false);
  result.set(new TextEncoder().encode(type), 4);
  result.set(payload, 8);
  return result;
}
