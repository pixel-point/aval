import { describe, expect, it } from "vitest";
import { validateReportIndex } from "../src/report-index-model.js";
import type { NamedBrowserMatrixRequirement } from "../src/report-index-criteria.js";

const testEnvironment = {
  browserChannel: "stable", osProduct: "Test OS", osVersion: "1.0.0", deviceClass: "test-device", virtualization: "none" as const
};
function requirement(browserProduct: string, browserVersion: string): NamedBrowserMatrixRequirement {
  return { browserProduct, browserVersion, ...testEnvironment };
}

const policy = {
  requiredPlatformClasses: ["mac", "windows"],
  requiredBrowsersByPlatform: {
    mac: [
      requirement("Safari", "1.0.0"),
      requirement("Chrome", "1.0.0")
    ],
    windows: [
      requirement("Chrome", "1.0.0"),
      requirement("Edge", "1.0.0")
    ]
  },
  requiredRefreshMilliHz: [60_000], conditionalRefreshMilliHz: 120_000
} as const;
const digest = "a".repeat(64);

function validIndex(): any {
  const profiles = [
    profile("mac", "Chrome", false), profile("mac", "Safari", true),
    profile("windows", "Chrome", true), profile("windows", "Edge", false)
  ].sort((left, right) => left.profileId < right.profileId ? -1 : 1);
  return {
    schemaVersion: "1.0", releaseVersion: "1.0.0", candidateManifestDigest: digest,
    releaseStatus: "passed", runtimeScheduling: "passed", observedDisplay: "not-run",
    matrixFailures: [], missingMatrixSlots: [], profiles,
    reports: profiles.map((value: any) => ({ id: value.runtimeReportId, path: `reports/${value.runtimeReportId}.json`, sha256: value.runtimeReportDigest, byteLength: 10, mediaType: "application/json" })).sort((left: any, right: any) => left.path < right.path ? -1 : 1),
    reviewRecord: { id: "certification-review-record", path: "reports/reviews.json", sha256: "b".repeat(64), byteLength: 10, mediaType: "application/json" },
    reviews: [{ id: "reviewer-a", decision: "approved", evidenceDigest: "c".repeat(64) }, { id: "reviewer-b", decision: "approved", evidenceDigest: "d".repeat(64) }]
  };
}

function profile(platformClass: string, browserProduct: string, animated: boolean, browserVersion = "1.0.0"): any {
  const profileId = `${platformClass}-${browserProduct}-${browserVersion}`.toLowerCase().replace(/[^a-z0-9._-]+/gu, "-");
  const runtimeReportId = `runtime-${profileId}`;
  return { profileId, platformClass, browserProduct, browserVersion, browserBuild: `${browserVersion}.1`, ...testEnvironment, refreshMilliHz: 60_000, refresh120Available: false, animated, fatalErrorBoundary: "passed", runtimeScheduling: animated ? "passed" : "unsupported", coverageFailures: [], observedDisplay: "not-run", runtimeReportId, runtimeReportDigest: digest, observedDisplayReportId: null, observedDisplayReportDigest: null };
}

describe("canonical certification report index", () => {
  it("recomputes the complete matrix, report bindings, and release gate", () => {
    expect(validateReportIndex(validIndex(), policy)).toMatchObject({ releaseStatus: "passed", runtimeScheduling: "passed", observedDisplay: "not-run" });
  });

  it("rejects forged summaries and duplicate matrix/report identities", () => {
    const forged = validIndex(); forged.runtimeScheduling = "failed";
    expect(() => validateReportIndex(forged, policy)).toThrow(/matrix summary/u);
    const duplicate = validIndex(); duplicate.profiles[1].profileId = duplicate.profiles[0].profileId;
    expect(() => validateReportIndex(duplicate, policy)).toThrow(/duplicates/u);
    const reportDuplicate = validIndex(); reportDuplicate.reports[1].id = reportDuplicate.reports[0].id;
    expect(() => validateReportIndex(reportDuplicate, policy)).toThrow(/duplicates/u);
  });

  it.each(["latest", "latest-1", ">=149", "149.x", "149 or newer"])("rejects moving/range browser alias %s in the canonical index", (alias) => {
    const index = validIndex(); index.profiles[0].browserVersion = alias;
    expect(() => validateReportIndex(index, policy)).toThrow(/exact browser version/u);
  });

  it("rejects range syntax in the canonical OS version", () => {
    const index = validIndex(); index.profiles[0].osVersion = "1.x";
    expect(() => validateReportIndex(index, policy)).toThrow(/exact OS version/u);
  });

  it("keeps exact browser build and stable channel evidence in the index", () => {
    const index = validIndex();
    expect(validateReportIndex(index, policy).profiles[0]).toMatchObject({
      browserBuild: expect.any(String),
      browserChannel: "stable"
    });
    index.profiles[0].browserChannel = "beta";
    expect(() => validateReportIndex(index, policy)).toThrow(/matrix summary/u);
  });

  it("rejects moving or cross-major browser build evidence", () => {
    const moving = validIndex(); moving.profiles[0].browserBuild = "latest";
    expect(() => validateReportIndex(moving, policy)).toThrow(/exact browser build/u);

    const mismatched = validIndex();
    const chrome = mismatched.profiles.find((candidate: any) => candidate.browserProduct === "Chrome");
    chrome.browserBuild = "2.0.0.1";
    expect(() => validateReportIndex(mismatched, policy)).toThrow(/browserBuild.*version/u);
  });

  it("passes distinct required browser versions through matrix recomputation", () => {
    const index = validIndex();
    const previous = profile("windows", "Chrome", true, "0.9.0");
    index.profiles.push(previous);
    index.profiles.sort((left: any, right: any) => left.profileId < right.profileId ? -1 : 1);
    index.reports.push({ id: previous.runtimeReportId, path: `reports/${previous.runtimeReportId}.json`, sha256: previous.runtimeReportDigest, byteLength: 10, mediaType: "application/json" });
    index.reports.sort((left: any, right: any) => left.path < right.path ? -1 : 1);
    const versionedPolicy = {
      ...policy,
      requiredBrowsersByPlatform: {
        ...policy.requiredBrowsersByPlatform,
        windows: [
          requirement("Chrome", "1.0.0"),
          requirement("Chrome", "0.9.0"),
          requirement("Edge", "1.0.0")
        ]
      }
    } as const;
    expect(validateReportIndex(index, versionedPolicy)).toMatchObject({ releaseStatus: "passed", runtimeScheduling: "passed" });
  });

  it("does not allow a platform label to substitute for OS/device evidence", () => {
    const index = validIndex();
    index.profiles[0].osVersion = "14";
    expect(() => validateReportIndex(index, policy)).toThrow(/matrix summary/u);
  });

  it("rejects unclaimed and digest-substituted report references", () => {
    const substituted = validIndex(); substituted.profiles[0].runtimeReportDigest = "f".repeat(64);
    expect(() => validateReportIndex(substituted, policy)).toThrow(/reference mismatch/u);
    const unclaimed = validIndex(); unclaimed.reports.push({ id: "runtime-unclaimed", path: "reports/zz.json", sha256: digest, byteLength: 1, mediaType: "application/json" });
    expect(() => validateReportIndex(unclaimed, policy)).toThrow(/unclaimed/u);
  });

  it("keeps observed display independently report-bound", () => {
    const index = validIndex(); index.profiles[0].observedDisplay = "passed";
    expect(() => validateReportIndex(index, policy)).toThrow(/observed display binding/u);
  });

  it("rejects passed runtime coverage gaps and non-JSON report media", () => {
    const coverage = validIndex(); coverage.profiles.find((profile: any) => profile.runtimeScheduling === "passed").coverageFailures = ["missing-scenario"];
    expect(() => validateReportIndex(coverage, policy)).toThrow(/coverage failures/u);
    const media = validIndex(); media.reports[0].mediaType = "text/plain";
    expect(() => validateReportIndex(media, policy)).toThrow(/application\/json/u);
  });

  it("recomputes the release gate from fatal error-boundary evidence", () => {
    const index = validIndex(); index.profiles[0].fatalErrorBoundary = "failed";
    index.runtimeScheduling = "failed"; index.releaseStatus = "failed";
    index.matrixFailures = [`fatal-error-boundary:${index.profiles[0].profileId}:failed`];
    expect(validateReportIndex(index, policy)).toMatchObject({ releaseStatus: "failed", runtimeScheduling: "failed" });
  });

  it("marks partially measured display coverage inconclusive instead of globally passed", () => {
    const index = validIndex(); const profile = index.profiles[0];
    profile.observedDisplay = "passed"; profile.observedDisplayReportId = "display-one"; profile.observedDisplayReportDigest = "e".repeat(64);
    index.reports.push({ id: "display-one", path: "reports/display-one.json", sha256: profile.observedDisplayReportDigest, byteLength: 10, mediaType: "application/json" });
    index.reports.sort((left: any, right: any) => left.path < right.path ? -1 : 1); index.observedDisplay = "inconclusive";
    expect(validateReportIndex(index, policy).observedDisplay).toBe("inconclusive");
  });
});
