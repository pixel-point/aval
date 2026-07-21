import { describe, expect, it } from "vitest";
import { validateDisplayReport, validateRuntimeReport } from "../src/schema-validation.js";
import { EXACT_BROWSER_BUILD_PATTERN_SOURCE, EXACT_PRODUCT_VERSION_PATTERN_SOURCE } from "../src/exact-version.js";
import { FATAL_ERROR_BOUNDARY_ATTACHMENT_ID, REQUIRED_DISPLAY_CRITERION_IDS, REQUIRED_RUNTIME_CRITERION_IDS } from "../src/scenario-contract.js";
import { validRuntimeReport } from "./test-report.js";
import { loadCertificationSchema } from "./schema-test-support.js";

const digest = "b".repeat(64);

describe("certification report validation", () => {
  it("loads only named checked schemas from the repository schema authority", async () => {
    const schema = await loadCertificationSchema("certification-runtime.schema.json") as any;
    expect(schema).toMatchObject({ title: expect.any(String) });
    expect(schema.$defs.environment.properties.browser.properties.version.pattern).toBe(EXACT_PRODUCT_VERSION_PATTERN_SOURCE);
    expect(schema.$defs.environment.properties.browser.properties.build.pattern).toBe(EXACT_BROWSER_BUILD_PATTERN_SOURCE);
    expect(schema.$defs.environment.properties.os.properties.version.pattern).toBe(EXACT_PRODUCT_VERSION_PATTERN_SOURCE);
    const browserVersion = new RegExp(EXACT_PRODUCT_VERSION_PATTERN_SOURCE, "u");
    expect(browserVersion.test("26.5")).toBe(true);
    for (const alias of ["latest", "latest-1", ">=149", "149.x", "149 or newer"]) expect(browserVersion.test(alias)).toBe(false);
    await expect(loadCertificationSchema("../package.json")).rejects.toThrow(/invalid/u);
  });
  it("accepts a complete path-free runtime report", () => {
    expect(validateRuntimeReport(validRuntimeReport())).toEqual(validRuntimeReport());
  });

  it.each([
    ["unknown status", (report: Record<string, unknown>) => { report.status = "ok"; }, /status/u],
    ["unsafe integer", (report: Record<string, unknown>) => {
      const scenarios = report.scenarios as Record<string, unknown>[];
      if (scenarios[0] !== undefined) scenarios[0].frameCount = Number.MAX_SAFE_INTEGER + 1;
    }, /safe integer/u],
    ["absolute path", (report: Record<string, unknown>) => {
      const attachments = report.attachments as Record<string, unknown>[];
      if (attachments[0] !== undefined) attachments[0].path = "/Users/operator/private.json";
    }, /absolute/u],
    ["URL query", (report: Record<string, unknown>) => {
      const environment = report.environment as { power: Record<string, unknown> };
      environment.power.backgroundLoad = "https://example.test/run?token=secret";
    }, /URL query/u],
    ["duplicate scenario", (report: Record<string, unknown>) => {
      const scenarios = report.scenarios as unknown[];
      scenarios.push(structuredClone(scenarios[0]));
    }, /duplicate/u],
    ["out-of-range repetition", (report: Record<string, unknown>) => {
      const scenarios = report.scenarios as Record<string, unknown>[];
      if (scenarios[0] !== undefined) scenarios[0].repetition = 4;
    }, /1\.\.3/u],
    ["empty passed scenarios", (report: Record<string, unknown>) => { report.scenarios = []; }, /requires scenarios/u],
    ["empty passed criteria", (report: Record<string, unknown>) => { report.criteria = []; }, /required criterion/u],
    ["empty passed attachments", (report: Record<string, unknown>) => { report.attachments = []; }, /requires evidence/u],
    ["display field", (report: Record<string, unknown>) => { report.scanoutTime = 12; }, /observed-display/u],
    ["unknown field", (report: Record<string, unknown>) => { report.extra = true; }, /unknown field/u],
    ["floating version", (report: Record<string, unknown>) => {
      const environment = report.environment as { browser: Record<string, unknown> };
      environment.browser.version = "stable";
    }, /exact version/u],
    ["floating browser build", (report: Record<string, unknown>) => {
      const environment = report.environment as { browser: Record<string, unknown> };
      environment.browser.build = "latest";
    }, /exact browser build/u],
    ["browser build from another major", (report: Record<string, unknown>) => {
      const environment = report.environment as { browser: Record<string, unknown> };
      environment.browser.product = "Chrome";
      environment.browser.version = "150";
      environment.browser.build = "149.0.7827.55";
    }, /browser build.*version/u],
    ["range OS version", (report: Record<string, unknown>) => {
      const environment = report.environment as { os: Record<string, unknown> };
      environment.os.version = "26.x";
    }, /exact version/u]
  ])("rejects %s", (_name, mutate, expected) => {
    const report = structuredClone(validRuntimeReport()) as unknown as Record<string, unknown>;
    mutate(report);
    expect(() => validateRuntimeReport(report)).toThrow(expected);
  });

  it("requires a passed runtime report and qualifying external capture", () => {
    const display = {
      schemaVersion: "1.0",
      reportKind: "observed-display",
      reportId: "display-1",
      status: "passed",
      candidateManifestDigest: "a".repeat(64),
      runtimeReportId: "runtime-1",
      runtimeReportDigest: digest,
      runtimeReportStatus: "passed",
      runtimeScenarioId: "loop-1000",
      runtimeScenarioRepetition: 1,
      runtimeScenarioLedgerDigest: "c".repeat(64),
      patternDigest: "d".repeat(64),
      method: "external-high-speed-capture",
      captureRateMilliHz: 480000,
      measuredRefreshMilliHz: 120000,
      minimumConfidenceMillionths: 990000,
      startedAt: "2026-07-12T11:00:00.000Z",
      endedAt: "2026-07-12T11:10:00.000Z",
      observationCount: 100,
      refreshCount: 25,
      distinctAppearanceCount: 10,
      thresholdMicroseconds: 50000,
      firstFailingRefreshOrdinal: null,
      observationLedgerDigest: digest,
      captureProvenance: {
        rawCaptureDigest: "e".repeat(64),
        extractor: { tool: "aval-display-extractor", version: "1.0.0" },
        operatorRole: "qualified-display-capture-operator",
        reviewerIds: ["display-reviewer-1"]
      },
      criteria: REQUIRED_DISPLAY_CRITERION_IDS.map((id) => ({ id, status: "passed" as const, evidence: ["display-observation-ledger", "display-raw-capture"] })),
      attachments: [
        { id: "display-observation-ledger", path: "capture/observations.json", sha256: digest, byteLength: 200, mediaType: "application/json" },
        { id: "display-raw-capture", path: "capture/raw.mp4", sha256: "e".repeat(64), byteLength: 1000, mediaType: "video/mp4" }
      ]
    } as const;
    expect(validateDisplayReport(display).status).toBe("passed");
    expect(() => validateDisplayReport({ ...display, runtimeReportStatus: "failed" })).toThrow(/passed/u);
    expect(() => validateDisplayReport({ ...display, captureRateMilliHz: 479999 })).toThrow(/four times/u);
    expect(() => validateDisplayReport({ ...display, rafTime: 1 })).toThrow(/runtime callback/u);
    expect(() => validateDisplayReport({ ...display, observations: [] })).toThrow(/unknown field/u);
    expect(() => validateDisplayReport({ ...display, observationCount: 0 })).toThrow(/requires observations/u);
    expect(() => validateDisplayReport({ ...display, observationLedgerDigest: "f".repeat(64) })).toThrow(/identity mismatch/u);
    expect(() => validateDisplayReport({ ...display, criteria: [] })).toThrow(/required criterion/u);
    expect(() => validateDisplayReport({ ...display, attachments: [] })).toThrow(/required attachment/u);
  });

  it("allows one scenario ID across three repetitions but rejects a duplicate pair", () => {
    const report = validRuntimeReport();
    const loop = report.scenarios.filter(({ id }) => id === "loop-1000");
    expect(loop.map(({ repetition }) => repetition)).toEqual([1, 2, 3]);
    expect(validateRuntimeReport(report).status).toBe("passed");
    expect(() => validateRuntimeReport({ ...report, scenarios: [...report.scenarios, report.scenarios[0]!] })).toThrow(/duplicate scenario\/repetition pair/u);
  });

  it("requires fatal error-boundary evidence in every passed runtime report", () => {
    expect(REQUIRED_RUNTIME_CRITERION_IDS).toContain("runtime-fatal-error-boundary");
    const report = validRuntimeReport();
    const withoutErrorBoundary = {
      ...report,
      criteria: report.criteria.filter(({ id }) => id !== "runtime-fatal-error-boundary")
    };
    expect(() => validateRuntimeReport(withoutErrorBoundary)).toThrow(/runtime-fatal-error-boundary/u);

    const unrelatedEvidence = report.attachments.find(({ id }) => id.startsWith("scenario-"))!.id;
    const withoutLedger = {
      ...report,
      criteria: report.criteria.map((criterion) => criterion.id === "runtime-fatal-error-boundary"
        ? { ...criterion, evidence: [unrelatedEvidence] }
        : criterion),
      attachments: report.attachments.filter(({ id }) => id !== FATAL_ERROR_BOUNDARY_ATTACHMENT_ID)
    };
    expect(() => validateRuntimeReport(withoutLedger)).toThrow(/fatal error-boundary attachment is missing/u);

    const unbound = {
      ...report,
      criteria: report.criteria.map((criterion) => criterion.id === "runtime-fatal-error-boundary"
        ? { ...criterion, evidence: [unrelatedEvidence] }
        : criterion)
    };
    expect(() => validateRuntimeReport(unbound)).toThrow(/fatal error-boundary criterion is not bound/u);
  });
});
