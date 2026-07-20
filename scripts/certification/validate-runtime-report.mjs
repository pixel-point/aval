#!/usr/bin/env node
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { loadCandidateFixtureAuthority } from "./candidate-fixtures.mjs";

const path = process.argv[2];
const candidateIndex = process.argv.indexOf("--candidate");
const candidatePath = process.argv[candidateIndex + 1];
if (path === undefined || candidateIndex < 0 || candidatePath === undefined) throw new Error("usage: validate-runtime-report.mjs <runtime-report.json> --candidate <candidate-manifest.json>");
const module = await import(resolve("packages/certification/dist/index.js"));
const policy = JSON.parse(new TextDecoder().decode(await module.readStableBoundedFile("config/release/release-policy.json", 1024 * 1024)));
const [bytes, candidateBytes] = await Promise.all([module.readStableBoundedFile(path, policy.limits.maximumReportBytes), module.readStableBoundedFile(candidatePath, policy.limits.maximumReportBytes)]);
const candidate = module.validateCandidateManifest(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(candidateBytes)));
if (Buffer.compare(candidateBytes, module.canonicalJsonBytes(candidate)) !== 0) throw new Error("candidate manifest is not canonical JSON");
const candidateDigest = createHash("sha256").update(candidateBytes).digest("hex");
const fixtureAuthority = await loadCandidateFixtureAuthority(candidate, candidatePath, module);
const report = await module.validateRuntimeReportBundle(dirname(resolve(path)), JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), {
  maximumAttachmentBytes: policy.limits.maximumAttachmentBytes,
  allowedMediaTypes: new Set(policy.allowedAttachmentMediaTypes),
  allowedFixtureDigests: fixtureAuthority.digests,
  allowedFixtureModels: fixtureAuthority.models,
  allowedFatalBoundaryFixtureDigests: fixtureAuthority.fatalBoundaryFixtureDigests,
  allowedCertificationHarnessDigests: fixtureAuthority.harnessDigests
});
if (candidateDigest !== report.candidateManifestDigest) throw new Error("runtime report candidate manifest digest mismatch");
if (candidate.commit !== report.commit || candidate.tree !== report.tree) throw new Error("runtime report source identity mismatch");
if (Date.parse(report.startedAt) < Date.parse(candidate.createdAt)) throw new Error("runtime report predates the candidate");
process.stdout.write(`${JSON.stringify({ status: "passed", reportId: report.reportId, sha256: createHash("sha256").update(bytes).digest("hex") })}\n`);
