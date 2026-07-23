import { createHash } from "node:crypto";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { verifyArtifactReferences } from "../src/artifact-verifier.js";
import { candidateManifestDigest, validateCandidateManifest, validateReleaseManifest } from "../src/release-manifest.js";
import type { CandidateManifest, ReleaseManifest } from "../src/model.js";
import { candidateArtifactFixture } from "./candidate-manifest-fixture.js";

describe("immutable release manifests", () => {
  it("changes the candidate digest for any artifact substitution", () => {
    const manifest: CandidateManifest = {
      schemaVersion: "1.0",
      manifestKind: "candidate",
      releaseVersion: "1.0.0",
      releaseSetDigest: "9".repeat(64),
      commit: "1".repeat(40),
      tree: "2".repeat(40),
      cleanTree: true,
      createdAt: "2026-07-12T12:00:00.000Z",
      tools: { node: "22.12.0", npm: "10.9.0", typescript: "7.0.2", vitest: "4.1.10", playwright: "1.61.1", apiExtractor: "7.58.9" },
      browserPin: {
        playwrightBrowserManifestSha256: "f".repeat(64),
        browsers: {
          chromium: { revision: "1228", engineVersion: "149.0.7827.55" },
          firefox: { revision: "1532", engineVersion: "151.0" },
          webkit: { revision: "2311", engineVersion: "26.5" }
        }
      },
      artifacts: candidateArtifactFixture()
    };
    const original = candidateManifestDigest(manifest);
    const changed = candidateManifestDigest({ ...manifest, artifacts: manifest.artifacts.map((artifact, index) => index === 0 ? { ...artifact, sha256: "b".repeat(64) } : artifact) });
    expect(changed).not.toBe(original);
    expect(() => validateCandidateManifest({ ...manifest, unknown: true })).toThrow(/unknown field/u);
    expect(() => validateCandidateManifest({
      ...manifest,
      artifacts: manifest.artifacts.map((artifact, index) => index === 0 ? { ...artifact, executable: true } : artifact)
    })).toThrow(/unknown field/u);
    expect(() => validateCandidateManifest({ ...manifest, artifacts: manifest.artifacts.filter(({ role }) => role !== "license-report") })).toThrow(/license-report/u);
    expect(() => validateCandidateManifest({ ...manifest, artifacts: manifest.artifacts.filter(({ role }) => role !== "package").concat(manifest.artifacts.filter(({ role }) => role === "package").slice(0, 1)) })).toThrow(/public-package/u);
    expect(() => validateCandidateManifest({ ...manifest, artifacts: manifest.artifacts.filter(({ path }) => path !== "sbom/compiler.spdx.json") })).toThrow(/required SBOM/u);
    expect(() => validateCandidateManifest({ ...manifest, artifacts: manifest.artifacts.filter(({ path }) => path !== "etc/api/compiler.api.md") })).toThrow(/required API report/u);
    expect(() => validateCandidateManifest({ ...manifest, artifacts: manifest.artifacts.filter(({ path }) => path !== "sbom/react.spdx.json") })).toThrow(/required SBOM/u);
    expect(() => validateCandidateManifest({ ...manifest, artifacts: manifest.artifacts.filter(({ path }) => path !== "etc/api/react.api.md") })).toThrow(/required API report/u);
    expect(() => validateCandidateManifest({ ...manifest, artifacts: manifest.artifacts.filter(({ role }) => role !== "candidate-layout") })).toThrow(/candidate-layout/u);
    expect(() => validateCandidateManifest({ ...manifest, tools: { ...manifest.tools, node: "latest" } })).toThrow(/semantic tool/u);
    expect(() => validateCandidateManifest({ ...manifest, tools: { ...manifest.tools, playwrightBrowserManifestSha256: "f".repeat(64) } })).toThrow(/unknown field/u);
    expect(() => validateCandidateManifest({ ...manifest, browserPin: { ...manifest.browserPin, extra: true } })).toThrow(/unknown field/u);
    expect(() => validateCandidateManifest({ ...manifest, artifacts: manifest.artifacts.map((artifact) => artifact.role === "documentation" ? { ...artifact, mediaType: "Text/Markdown" } : artifact) })).toThrow(/lowercase canonical/u);
    expect(() => validateCandidateManifest({ ...manifest, commit: "HEAD" })).toThrow(/full lowercase Git/u);
    expect(() => validateCandidateManifest({ ...manifest, tree: "abc123" })).toThrow(/full lowercase Git/u);
    expect(() => validateCandidateManifest({ ...manifest, createdAt: "2026-02-30T12:00:00.000Z" })).toThrow(/canonical real UTC/u);
  });

  it("requires the exact candidate digest and two independent reviews", () => {
    const release: ReleaseManifest = {
      schemaVersion: "1.0",
      manifestKind: "release",
      releaseVersion: "1.0.0",
      candidateManifestDigest: "a".repeat(64),
      releaseSetDigest: "f".repeat(64),
      createdAt: "2026-07-12T13:00:00.000Z",
      reports: [{ id: "runtime-1", path: "reports/runtime.json", sha256: "b".repeat(64), byteLength: 20, mediaType: "application/json" }],
      artifacts: [{ id: "report-index", path: "reports/index.json", sha256: "c".repeat(64), byteLength: 20, mediaType: "application/json" }],
      reviews: [{ id: "reviewer-a", decision: "approved", evidenceDigest: "d".repeat(64) }, { id: "reviewer-b", decision: "approved", evidenceDigest: "e".repeat(64) }],
      previousKnownGood: "none",
      rollbackTag: "latest"
    };
    expect(validateReleaseManifest(release, "a".repeat(64))).toBe(release);
    expect(() => validateReleaseManifest(release, "c".repeat(64))).toThrow(/substitution/u);
    expect(() => validateReleaseManifest({ ...release, reviews: [release.reviews[0]!] })).toThrow(/2\.\.32/u);
    expect(() => validateReleaseManifest({ ...release, unexpected: true })).toThrow(/unknown field/u);
    expect(() => validateReleaseManifest({
      ...release,
      reviews: [{ ...release.reviews[0]!, role: "owner" }, release.reviews[1]!]
    })).toThrow(/unknown field/u);
    expect(() => validateReleaseManifest({
      ...release,
      reports: [release.reports[0]!, { ...release.reports[0]!, path: "reports/other.json" }]
    })).toThrow(/duplicate report\/artifact ID/u);
    expect(() => validateReleaseManifest({ ...release, createdAt: "2026-07-12T13:00:00Z" })).toThrow(/canonical real UTC/u);
  });

  it("verifies digest, length, containment, media policy, and symlink rejection", async () => {
    const root = await mkdtemp(join(tmpdir(), "aval-artifact-"));
    try {
      await writeFile(join(root, "artifact.json"), "{}\n");
      const sha256 = createHash("sha256").update("{}\n").digest("hex");
      const reference = { id: "artifact", path: "artifact.json", sha256, byteLength: 3, mediaType: "application/json" };
      await expect(verifyArtifactReferences(root, [reference], { maximumBytes: 4, allowedMediaTypes: new Set(["application/json"]) })).resolves.toBeUndefined();
      await expect(verifyArtifactReferences(root, [{ ...reference, byteLength: 2 }], { maximumBytes: 2 })).rejects.toThrow(/physical artifact/u);
      await expect(verifyArtifactReferences(root, [{ ...reference, sha256: "0".repeat(64) }], { maximumBytes: 4 })).rejects.toThrow(/digest/u);
      await symlink("artifact.json", join(root, "link.json"));
      await expect(verifyArtifactReferences(root, [{ ...reference, path: "link.json" }], { maximumBytes: 4 })).rejects.toThrow(/symbolic/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
