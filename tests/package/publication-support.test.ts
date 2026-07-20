import { createHash } from "node:crypto";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import * as certification from "../../packages/certification/src/index.js";
import { loadBoundLedger, loadMitigationEvidence, loadRegistryConsumerEvidence } from "../../scripts/release/publication-support.mjs";

const order = [...certification.PUBLIC_RELEASE_PACKAGES];
const integrity = `sha512-${Buffer.alloc(64, 9).toString("base64")}`;
const authorization = {
  digest: "a".repeat(64),
  releaseDigest: "b".repeat(64),
  releaseSet: { releaseSetDigest: "c".repeat(64), order },
  policy: { registry: { url: "https://registry.npmjs.org/" } }
};

describe("bounded immutable publication inputs", () => {
  it("loads one canonical release-bound ledger and rejects symlink/oversized substitutions before parsing", async () => {
    const root = await mkdtemp(join(tmpdir(), "aval-publication-input-"));
    try {
      const operations = order.map((packageName, index) => certification.planExactPublication({
        packageName,
        version: "1.0.0",
        tarballSha256: (index + 1).toString(16).repeat(64),
        registryIntegrity: integrity,
        desiredTag: "next",
        registry: { name: packageName, version: "1.0.0", integrity: null, tags: {} },
        sequence: index + 1,
        timestamp: "2026-07-12T13:00:00.000Z",
        approvalId: "dry-run-approval"
      }));
      const registryUrl = authorization.policy.registry.url;
      const ledger = {
        schemaVersion: "1.0", releaseVersion: "1.0.0", phase: "publish-next", mode: "dry-run", status: "planned",
        candidateManifestDigest: authorization.digest, releaseManifestDigest: authorization.releaseDigest,
        releaseSetDigest: authorization.releaseSet.releaseSetDigest, registryUrl,
        registryUrlSha256: sha256(Buffer.from(registryUrl)), previousLedgerDigest: null, phaseEvidenceDigest: null,
        createdAt: "2026-07-12T13:00:00.000Z", operations
      };
      const bytes = certification.canonicalJsonBytes(ledger);
      const path = join(root, "ledger.json");
      await writeFile(path, bytes);
      await expect(loadBoundLedger({ path, expectedDigest: sha256(bytes), authorization, certification })).resolves.toMatchObject({ ledger: { phase: "publish-next" } });
      const link = join(root, "ledger-link.json");
      await symlink(path, link);
      await expect(loadBoundLedger({ path: link, expectedDigest: sha256(bytes), authorization, certification })).rejects.toThrow(/bounded stable regular file/u);
      const oversized = join(root, "oversized.json");
      await writeFile(oversized, Buffer.alloc(1024 * 1024 + 1, 0x20));
      await expect(loadBoundLedger({ path: oversized, expectedDigest: "0".repeat(64), authorization, certification })).rejects.toThrow(/bounded stable regular file/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("binds registry-consumer and mitigation evidence to exact stable bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "aval-publication-evidence-"));
    try {
      const evidence = {
        schemaVersion: "1.0", evidenceKind: "registry-consumers", status: "passed",
        candidateManifestDigest: authorization.digest, releaseManifestDigest: authorization.releaseDigest,
        releaseSetDigest: authorization.releaseSet.releaseSetDigest, registryUrl: authorization.policy.registry.url,
        tag: "next", packages: order
      };
      const evidenceBytes = certification.canonicalJsonBytes(evidence);
      const evidencePath = join(root, "evidence.json");
      await writeFile(evidencePath, evidenceBytes);
      await expect(loadRegistryConsumerEvidence({ path: evidencePath, expectedDigest: sha256(evidenceBytes), authorization, certification })).resolves.toMatchObject({ evidence: { status: "passed" } });
      const mitigationBytes = Buffer.from("# Withdraw 1.0.0\n\nRollback mitigation and static-mode instructions.\n");
      const mitigationPath = join(root, "mitigation.md");
      await writeFile(mitigationPath, mitigationBytes);
      await expect(loadMitigationEvidence({ path: mitigationPath, expectedDigest: sha256(mitigationBytes) })).resolves.toMatchObject({ digest: sha256(mitigationBytes) });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function sha256(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
