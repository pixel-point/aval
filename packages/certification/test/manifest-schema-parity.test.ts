import { describe, expect, it } from "vitest";
import { validateCandidateManifest, validateReleaseManifest } from "../src/release-manifest.js";
import { candidateArtifactFixture } from "./candidate-manifest-fixture.js";
import { loadCertificationSchema } from "./schema-test-support.js";

const candidate = {
  schemaVersion: "1.0", manifestKind: "candidate", releaseVersion: "1.0.0",
  releaseSetDigest: "9".repeat(64),
  commit: "1".repeat(40), tree: "2".repeat(40), cleanTree: true,
  createdAt: "2026-07-12T12:00:00.000Z",
  tools: { node: "22.12.0", npm: "10.9.0", typescript: "7.0.2", vitest: "4.1.10", playwright: "1.61.1", apiExtractor: "7.58.9" },
  browserPin: {
    playwrightBrowserManifestSha256: "a".repeat(64),
    browsers: {
      chromium: { revision: "1228", engineVersion: "149.0.7827.55" },
      firefox: { revision: "1532", engineVersion: "151.0" },
      webkit: { revision: "2311", engineVersion: "26.5" }
    }
  },
  artifacts: candidateArtifactFixture()
};

describe("manifest JSON-schema/manual-validator parity", () => {
  it("pins the candidate fields, Git IDs, semantic tools, and browser structure in both authorities", async () => {
    const schema = await loadCertificationSchema("candidate-manifest.schema.json") as any;
    expect(schema.required).toEqual(expect.arrayContaining(["tools", "browserPin", "commit", "tree", "releaseSetDigest"]));
    expect(schema.properties.tools.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties.tools.properties).sort()).toEqual(["apiExtractor", "node", "npm", "playwright", "typescript", "vitest"]);
    expect(schema.properties.commit.pattern).toContain("{40}");
    expect(schema.properties.browserPin.properties.browsers.required).toEqual(["chromium", "firefox", "webkit"]);
    expect(validateCandidateManifest(candidate)).toBe(candidate);
    expect(() => validateCandidateManifest({ ...candidate, browserPin: undefined })).toThrow(/browserPin/u);
  });

  it("requires two approved, strictly identified reviews in both authorities", async () => {
    const schema = await loadCertificationSchema("release-manifest.schema.json") as any;
    expect(schema.properties.reviews.minItems).toBe(2);
    expect(schema.properties.reviews.items.properties.decision.const).toBe("approved");
    expect(schema.properties.reviews.items.required).toContain("evidenceDigest");
    const release = {
      schemaVersion: "1.0", manifestKind: "release", releaseVersion: "1.0.0",
      candidateManifestDigest: "a".repeat(64), releaseSetDigest: "f".repeat(64), createdAt: "2026-07-12T13:00:00.000Z",
      reports: [{ id: "runtime-1", path: "reports/runtime.json", sha256: "b".repeat(64), byteLength: 1, mediaType: "application/json" }],
      artifacts: [{ id: "index", path: "reports/index.json", sha256: "c".repeat(64), byteLength: 1, mediaType: "application/json" }],
      reviews: [{ id: "reviewer-a", decision: "approved", evidenceDigest: "d".repeat(64) }, { id: "reviewer-b", decision: "approved", evidenceDigest: "e".repeat(64) }],
      previousKnownGood: "none", rollbackTag: "latest"
    };
    expect(validateReleaseManifest(release)).toBe(release);
    expect(() => validateReleaseManifest({ ...release, reviews: release.reviews.slice(0, 1) })).toThrow(/2\.\.32/u);
  });
});
