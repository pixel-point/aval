import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";

import { readVerifiedRegularFile } from "./candidate-artifacts.mjs";
import { canonicalRegistryUrl } from "./registry-client.mjs";
import { loadReleaseAuthorization } from "./release-authorization.mjs";

export async function loadPublicationAuthorization({ releaseRoot, expectedCandidateDigest, expectedReleaseDigest, expectedReleaseSetDigest, expectedCommit, certification }) {
  const authorization = await loadReleaseAuthorization({ releaseRoot, expectedCandidateDigest, expectedReleaseDigest, expectedCommit, certification });
  if (expectedReleaseSetDigest !== undefined && authorization.releaseSet.releaseSetDigest !== expectedReleaseSetDigest) throw new Error("authorized release-set digest does not match protected publication intent");
  return authorization;
}

export function publicationLedgerEnvelope(authorization, { phase, mode, status, previousLedgerDigest, phaseEvidenceDigest = null, createdAt, operations }) {
  const registryUrl = canonicalRegistryUrl(authorization.policy.registry.url);
  return {
    schemaVersion: "1.0",
    releaseVersion: "1.0.0",
    phase,
    mode,
    status,
    candidateManifestDigest: authorization.digest,
    releaseManifestDigest: authorization.releaseDigest,
    releaseSetDigest: authorization.releaseSet.releaseSetDigest,
    registryUrl,
    registryUrlSha256: sha256(Buffer.from(registryUrl)),
    previousLedgerDigest,
    phaseEvidenceDigest,
    createdAt,
    operations
  };
}

export async function loadBoundLedger({ path, expectedDigest, authorization, certification }) {
  const bytes = await readBoundedStable(path, 1024 * 1024, "publication ledger");
  const digest = sha256(bytes);
  if (digest !== expectedDigest) throw new Error("source publication ledger digest mismatch");
  let ledger;
  try { ledger = certification.validatePublicationLedger(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))); }
  catch (error) { throw new Error("source publication ledger is invalid", { cause: error }); }
  if (Buffer.compare(bytes, certification.canonicalJsonBytes(ledger)) !== 0) throw new Error("source publication ledger is not canonical JSON");
  for (const [key, expected] of Object.entries({
    candidateManifestDigest: authorization.digest,
    releaseManifestDigest: authorization.releaseDigest,
    releaseSetDigest: authorization.releaseSet.releaseSetDigest,
    registryUrl: authorization.policy.registry.url
  })) if (ledger[key] !== expected) throw new Error(`source publication ledger ${key} does not match authorized release`);
  return Object.freeze({ bytes, digest, ledger });
}

export async function writePublicationLedger({ output, ledger, certification }) {
  certification.validatePublicationLedger(ledger);
  const bytes = certification.canonicalJsonBytes(ledger);
  await writeFile(output, bytes, { flag: "wx" });
  return Object.freeze({ bytes, digest: sha256(bytes) });
}

export async function loadRegistryConsumerEvidence({ path, expectedDigest, authorization, certification }) {
  const bytes = await readBoundedStable(path, 1024 * 1024, "registry-consumer evidence");
  if (sha256(bytes) !== expectedDigest) throw new Error("registry-consumer evidence digest mismatch");
  let evidence;
  try { evidence = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch (error) { throw new Error("registry-consumer evidence is not strict JSON", { cause: error }); }
  if (certification === undefined || Buffer.compare(bytes, certification.canonicalJsonBytes(evidence)) !== 0) throw new Error("registry-consumer evidence is not canonical JSON");
  const allowed = ["schemaVersion", "evidenceKind", "status", "candidateManifestDigest", "releaseManifestDigest", "releaseSetDigest", "registryUrl", "tag", "packages"];
  if (evidence === null || typeof evidence !== "object" || Array.isArray(evidence) || Object.keys(evidence).sort().join(",") !== [...allowed].sort().join(",")) throw new Error("registry-consumer evidence fields are invalid");
  if (evidence.schemaVersion !== "1.0" || evidence.evidenceKind !== "registry-consumers" || evidence.status !== "passed" || evidence.tag !== "next") throw new Error("registry-consumer evidence has not passed next-tag consumers");
  for (const [key, expected] of Object.entries({ candidateManifestDigest: authorization.digest, releaseManifestDigest: authorization.releaseDigest, releaseSetDigest: authorization.releaseSet.releaseSetDigest, registryUrl: authorization.policy.registry.url })) if (evidence[key] !== expected) throw new Error(`registry-consumer evidence ${key} mismatch`);
  if (!Array.isArray(evidence.packages) || evidence.packages.length !== authorization.releaseSet.order.length || evidence.packages.some((name, index) => name !== authorization.releaseSet.order[index])) throw new Error("registry-consumer evidence package set/order mismatch");
  return Object.freeze({ bytes, digest: expectedDigest, evidence });
}

export async function loadMitigationEvidence({ path, expectedDigest }) {
  const bytes = await readBoundedStable(path, 1024 * 1024, "rollback mitigation evidence");
  if (bytes.byteLength < 1 || bytes.byteLength > 1024 * 1024 || sha256(bytes) !== expectedDigest) throw new Error("rollback mitigation evidence identity mismatch");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (!/^#\s+.+/mu.test(text) || !/mitigation|rollback|withdraw/iu.test(text)) throw new Error("rollback mitigation evidence is incomplete");
  return Object.freeze({ bytes, digest: expectedDigest });
}

export function terminalLedgerStatus(operations, error) {
  if (error === null && operations.every(({ result }) => result === "applied" || result === "already-exact")) return "passed";
  if (operations.some(({ result }) => result === "ambiguous" || result === "conflict")) return "inconclusive";
  return "failed";
}

export function validPublicationApproval(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{7,219}$/u.test(value);
}

async function readBoundedStable(path, maximumBytes, label) {
  try { return await readVerifiedRegularFile(basename(path), dirname(path), maximumBytes); }
  catch (error) { throw new Error(`${label} is not a bounded stable regular file`, { cause: error }); }
}
function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
