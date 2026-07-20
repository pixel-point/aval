import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PUBLIC_RELEASE_PACKAGES } from "../src/compatibility.js";
import {
  assertPromotionAllowed,
  completePublicationOperation,
  failPublicationOperation,
  markPublicationOperationAmbiguous,
  planDeprecation,
  planExactPublication,
  planExactTag,
  planTagCompensation,
  publicationLedgerDigest,
  registryStateDigest,
  rollbackOrder,
  simulatePublication,
  validatePublicationLedger
} from "../src/publication-ledger.js";

const integrity = `sha512-${Buffer.alloc(64, 1).toString("base64")}`;
const registryUrl = "https://registry.npmjs.org/";
const registryUrlSha256 = createHash("sha256").update(registryUrl).digest("hex");

describe("publication ledger", () => {
  it("is read-before-write and accepts only an exact immutable existing version", () => {
    const operation = planExactPublication({
      packageName: "@pixel-point/aval-graph",
      version: "1.0.0",
      tarballSha256: "a".repeat(64),
      registryIntegrity: integrity,
      desiredTag: "next",
      registry: { name: "@pixel-point/aval-graph", version: "1.0.0", integrity, tags: { next: "1.0.0" } },
      sequence: 1,
      timestamp: "2026-07-12T13:00:00.000Z",
      approvalId: "approval-1"
    });
    expect(operation.result).toBe("already-exact");
    expect(() => planExactPublication({
      packageName: "@pixel-point/aval-graph",
      version: "1.0.0",
      tarballSha256: "a".repeat(64),
      registryIntegrity: integrity,
      desiredTag: "next",
      registry: { name: "@pixel-point/aval-graph", version: "1.0.0", integrity: `sha512-${Buffer.alloc(64, 2).toString("base64")}`, tags: {} },
      sequence: 1,
      timestamp: "2026-07-12T13:00:00.000Z",
      approvalId: "approval-1"
    })).toThrow(/different bytes/u);

    const tagPlan = planExactPublication({
      packageName: "@pixel-point/aval-graph",
      version: "1.0.0",
      tarballSha256: "a".repeat(64),
      registryIntegrity: integrity,
      desiredTag: "next",
      registry: { name: "@pixel-point/aval-graph", version: "1.0.0", integrity, tags: {} },
      sequence: 1,
      timestamp: "2026-07-12T13:00:00.000Z",
      approvalId: "approval-1"
    });
    expect(tagPlan).toMatchObject({ action: "tag", result: "planned" });
    expect(completePublicationOperation(tagPlan, {
      name: "@pixel-point/aval-graph",
      version: "1.0.0",
      integrity,
      tags: { next: "1.0.0" }
    }).result).toBe("applied");
    expect(failPublicationOperation(tagPlan).result).toBe("failed");
    expect(markPublicationOperationAmbiguous(tagPlan).result).toBe("ambiguous");
    expect(tagPlan.beforeStateDigest).toBe(registryStateDigest({ name: "@pixel-point/aval-graph", version: "1.0.0", integrity, tags: {} }));
  });

  it("blocks latest promotion after a partial next publication and rolls back in reverse dependency order", () => {
    const planned = planExactPublication({
      packageName: "@pixel-point/aval-graph", version: "1.0.0", tarballSha256: "a".repeat(64), registryIntegrity: integrity,
      desiredTag: "next", registry: { name: "@pixel-point/aval-graph", version: "1.0.0", integrity: null, tags: {} },
      sequence: 1, timestamp: "2026-07-12T13:00:00.000Z", approvalId: "approval"
    });
    expect(() => assertPromotionAllowed(ledger([failPublicationOperation(planned)], { status: "failed" }), ["@pixel-point/aval-graph"])).toThrow(/passed executed/u);
    expect(rollbackOrder(["graph", "format", "compiler"])).toEqual(["compiler", "format", "graph"]);
  });

  it("plans promotion, rollback, and deprecation from exact registry reads", () => {
    const identity = {
      packageName: "@pixel-point/aval-graph",
      version: "1.0.0" as const,
      tarballSha256: "a".repeat(64),
      registryIntegrity: integrity,
      sequence: 1,
      timestamp: "2026-07-12T13:00:00.000Z",
      approvalId: "approval-1"
    };
    const registry = { name: identity.packageName, version: identity.version, integrity, tags: { next: "1.0.0", latest: "0.9.0" }, deprecation: null };
    expect(planExactTag({ ...identity, action: "tag", desiredTag: "latest", targetVersion: "1.0.0", registry, requiredSourceTag: { tag: "next", version: "1.0.0" } })).toMatchObject({ before: "0.9.0", after: "1.0.0", result: "planned" });
    expect(planExactTag({ ...identity, action: "rollback-tag", desiredTag: "latest", targetVersion: "0.9.0", targetVersionAvailable: true, registry })).toMatchObject({ action: "rollback-tag", after: "0.9.0" });
    expect(() => planExactTag({ ...identity, action: "rollback-tag", desiredTag: "latest", targetVersion: "0.9.0", targetVersionAvailable: false, registry })).toThrow(/unavailable/u);
    expect(planDeprecation({ ...identity, registry, message: "Withdrawn" })).toMatchObject({ action: "deprecate", before: null, after: "Withdrawn", result: "planned" });
    const written = { ...registry, tags: { next: "1.0.0", latest: "1.0.0" } };
    const compensation = planTagCompensation({ ...identity, desiredTag: "latest", targetVersion: null, requiredCurrentTag: "1.0.0", registry: written });
    expect(compensation).toMatchObject({ action: "rollback-tag", before: "1.0.0", after: null, result: "planned" });
    expect(completePublicationOperation(compensation, { ...registry, tags: { next: "1.0.0" } })).toMatchObject({ result: "applied", after: null });
    expect(planTagCompensation({ ...identity, desiredTag: "latest", targetVersion: "0.9.0", requiredCurrentTag: "1.0.0", registry: { ...registry, tags: { latest: "1.0.1" } } })).toMatchObject({ result: "conflict" });
  });

  it("validates dry-run/executed ledger truth and rejects unknown substitutions", () => {
    const planned = plannedReleaseSet();
    const dry = ledger(planned, { mode: "dry-run", status: "planned" });
    expect(validatePublicationLedger(dry)).toBe(dry);
    expect(() => validatePublicationLedger({ ...dry, unexpected: true })).toThrow(/unknown/u);
    expect(() => validatePublicationLedger({ ...dry, operations: planned.map((operation) => ({ ...operation, result: "applied", afterStateDigest: operation.beforeStateDigest })) })).toThrow(/dry-run/u);
    expect(publicationLedgerDigest(dry)).toMatch(/^[0-9a-f]{64}$/u);
    expect(() => validatePublicationLedger({ ...dry, registryUrlSha256: "0".repeat(64) })).toThrow(/URL digest/u);
    expect(() => validatePublicationLedger({ ...dry, candidateManifestDigest: "0".repeat(64), unexpected: true })).toThrow(/unknown/u);
  });

  it("closes integrity, approval, registry-tag, and phase semantics", () => {
    const planned = plannedReleaseSet();
    const applied = planned.map((operation) => completePublicationOperation(operation, {
      name: operation.packageName,
      version: "1.0.0",
      integrity,
      tags: { next: "1.0.0" }
    }));
    expect(validatePublicationLedger(ledger(applied))).toBeTruthy();
    expect(() => validatePublicationLedger(ledger([applied[1]!, applied[0]!, ...applied.slice(2)].map((operation, index) => ({ ...operation, sequence: index + 1 }))))).toThrow(/ordered release/u);
    expect(() => validatePublicationLedger(ledger(applied.slice(0, 4)))).toThrow(/exact release set/u);
    expect(() => validatePublicationLedger(ledger(applied, { status: "failed" }))).toThrow(/lacks a failed/u);
    expect(() => planExactPublication({
      packageName: "@pixel-point/aval-graph", version: "1.0.0", tarballSha256: "a".repeat(64), registryIntegrity: "sha512-ZA==",
      desiredTag: "next", registry: { name: "@pixel-point/aval-graph", version: "1.0.0", integrity: null, tags: {} },
      sequence: 1, timestamp: "2026-07-12T13:00:00.000Z", approvalId: "approval-1"
    })).toThrow(/canonical SHA-512/u);
    expect(() => planExactPublication({
      packageName: "@pixel-point/aval-graph", version: "1.0.0", tarballSha256: "a".repeat(64), registryIntegrity: integrity,
      desiredTag: "next", registry: { name: "@pixel-point/aval-graph", version: "1.0.0", integrity: null, tags: {} },
      sequence: 1, timestamp: "2026-07-12T13:00:00.000Z", approvalId: "approval\n1"
    })).toThrow(/approval ID/u);
    expect(() => registryStateDigest({
      name: "@pixel-point/aval-graph", version: "1.0.0", integrity,
      tags: Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`tag${String(index)}`, "1.0.0"]))
    })).toThrow(/too many dist-tags/u);
  });

  it("blocks latest after network failure before every package and after consumer failure", () => {
    const packages = [...PUBLIC_RELEASE_PACKAGES];
    for (let failBeforeIndex = 0; failBeforeIndex < packages.length; failBeforeIndex += 1) {
      const result = simulatePublication({ packageNames: packages, failBeforeIndex, registryConsumerPassed: true });
      expect(result.promotedLatest).toEqual([]);
      expect(result.rollback).toEqual(packages.slice(0, failBeforeIndex).reverse());
    }
    expect(simulatePublication({ packageNames: packages, registryConsumerPassed: false }).promotedLatest).toEqual([]);
    expect(simulatePublication({ packageNames: packages, registryConsumerPassed: true }).promotedLatest).toEqual(packages);
  });

  it("records an exact initial-release rollback as latest/next removal plus deprecation", () => {
    const operations = initialReleaseRollbackOperations();
    const rollback = ledger(operations, { phase: "rollback", status: "passed" });
    expect(validatePublicationLedger(rollback)).toBe(rollback);
    expect(operations).toHaveLength(15);
    expect(operations.map(({ packageName, action, tag, after }) => ({ packageName, action, tag, after })).slice(0, 3)).toEqual([
      { packageName: "@pixel-point/aval-compiler", action: "rollback-tag", tag: "latest", after: null },
      { packageName: "@pixel-point/aval-compiler", action: "rollback-tag", tag: "next", after: null },
      { packageName: "@pixel-point/aval-compiler", action: "deprecate", tag: "deprecated", after: "Withdrawn" }
    ]);
    expect(() => validatePublicationLedger({ ...rollback, operations: operations.slice(0, -1) })).toThrow(/exact release set/u);
    expect(() => validatePublicationLedger({ ...rollback, operations: operations.map((operation, index) => index === 4 ? { ...operation, tag: "latest" } : operation) })).toThrow(/exact authorized reverse-order shape/u);
  });
});

function ledger(
  operations: readonly ReturnType<typeof planExactPublication>[],
  overrides: Partial<{
    phase: "publish-next" | "promote-latest" | "cleanup-next" | "rollback";
    mode: "dry-run" | "executed";
    status: "planned" | "passed" | "failed" | "inconclusive";
  }> = {}
) {
  return {
    schemaVersion: "1.0" as const,
    releaseVersion: "1.0.0" as const,
    phase: overrides.phase ?? "publish-next",
    mode: overrides.mode ?? "executed",
    status: overrides.status ?? "passed",
    candidateManifestDigest: "b".repeat(64),
    releaseManifestDigest: "c".repeat(64),
    releaseSetDigest: "d".repeat(64),
    registryUrl,
    registryUrlSha256,
    previousLedgerDigest: null,
    phaseEvidenceDigest: overrides.phase === "promote-latest" || overrides.phase === "rollback" ? "e".repeat(64) : null,
    createdAt: "2026-07-12T13:00:00.000Z",
    operations
  };
}

function plannedReleaseSet() {
  return PUBLIC_RELEASE_PACKAGES.map((packageName, index) => planExactPublication({
    packageName,
    version: "1.0.0",
    tarballSha256: String(index + 1).repeat(64),
    registryIntegrity: integrity,
    desiredTag: "next",
    registry: { name: packageName, version: "1.0.0", integrity: null, tags: {} },
    sequence: index + 1,
    timestamp: "2026-07-12T13:00:00.000Z",
    approvalId: "dry-run-approval"
  }));
}

function initialReleaseRollbackOperations() {
  const operations: ReturnType<typeof planTagCompensation>[] = [];
  for (const packageName of [...PUBLIC_RELEASE_PACKAGES].reverse()) {
    const base = {
      packageName,
      version: "1.0.0" as const,
      tarballSha256: "a".repeat(64),
      registryIntegrity: integrity,
      timestamp: "2026-07-12T13:00:00.000Z",
      approvalId: "rollback-approval"
    };
    const initial = { name: packageName, version: "1.0.0", integrity, tags: { latest: "1.0.0", next: "1.0.0" }, deprecation: null };
    const latest = planTagCompensation({ ...base, sequence: operations.length + 1, desiredTag: "latest", targetVersion: null, requiredCurrentTag: "1.0.0", registry: initial });
    operations.push(completePublicationOperation(latest, { ...initial, tags: { next: "1.0.0" } }));
    const next = planTagCompensation({ ...base, sequence: operations.length + 1, desiredTag: "next", targetVersion: null, requiredCurrentTag: "1.0.0", registry: { ...initial, tags: { next: "1.0.0" } } });
    operations.push(completePublicationOperation(next, { ...initial, tags: {} }));
    const deprecation = planDeprecation({ ...base, sequence: operations.length + 1, registry: { ...initial, tags: {} }, message: "Withdrawn" });
    operations.push(completePublicationOperation(deprecation, { ...initial, tags: {}, deprecation: "Withdrawn" }));
  }
  return operations;
}
