import { describe, expect, it } from "vitest";

import { applyApprovedPublicationMetadata, reconcilePublicationMetadata, validateApprovedPublicationMetadata } from "../../scripts/release/publication-metadata.mjs";

const approved = {
  schemaVersion: "1.0",
  releaseVersion: "1.0.0",
  status: "approved",
  reviewId: "metadata-review-001",
  reviewerRole: "qualified-publication-metadata-reviewer",
  reviewedAt: "2026-07-12T13:00:00.000Z",
  repositoryUrl: "https://github.com/acme/aval.git",
  homepageUrl: "https://github.com/acme/aval",
  bugsUrl: "https://github.com/acme/aval/issues",
  registryScopeAuthority: {
    scope: "@pixel-point",
    registryUrl: "https://registry.npmjs.org/",
    owner: "acme-motion",
    evidenceId: "scope-evidence-001"
  },
  note: "Synthetic test authority; never used for the real release candidate."
} as const;

describe("publication metadata authority", () => {
  it("injects one reviewed authority into every package-specific repository path", () => {
    expect(validateApprovedPublicationMetadata(approved)).toBe(approved);
    const manifests = ["graph", "format", "player-web", "element", "compiler", "react"].map((name) => applyApprovedPublicationMetadata({ name: `@pixel-point/aval-${name}` }, approved));
    expect(manifests[2]?.repository).toEqual({ type: "git", url: approved.repositoryUrl, directory: "packages/player-web" });
    expect(reconcilePublicationMetadata(manifests, approved)).toBe(approved);
  });

  it("fails closed while pending and rejects placeholder, credential, or scope substitutions", () => {
    expect(() => validateApprovedPublicationMetadata({ ...approved, status: "pending", reviewId: null })).toThrow(/approved publication metadata/u);
    expect(() => validateApprovedPublicationMetadata({ ...approved, repositoryUrl: "https://example.test/repository.git" })).toThrow(/canonical public HTTPS/u);
    expect(() => validateApprovedPublicationMetadata({ ...approved, bugsUrl: "https://user:secret@github.com/acme/aval/issues" })).toThrow(/canonical public HTTPS/u);
    expect(() => validateApprovedPublicationMetadata({ ...approved, registryScopeAuthority: { ...approved.registryScopeAuthority, scope: "@substituted" } })).toThrow(/scope authority/u);
    expect(() => validateApprovedPublicationMetadata({ ...approved, reviewedAt: "2026-02-30T13:00:00.000Z" })).toThrow(/reviewedAt/u);
    expect(() => applyApprovedPublicationMetadata({ name: "@pixel-point/aval-unknown" }, approved)).toThrow(/package source/u);
    const manifests = ["graph", "format", "player-web", "element", "compiler", "react"].map((name) => applyApprovedPublicationMetadata({ name: `@pixel-point/aval-${name}` }, approved));
    expect(() => reconcilePublicationMetadata([{ ...manifests[0], homepage: "https://github.com/substituted" }, ...manifests.slice(1)], approved)).toThrow(/does not match/u);
  });
});
