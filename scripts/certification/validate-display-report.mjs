#!/usr/bin/env node
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { loadCandidateFixtureAuthority } from "./candidate-fixtures.mjs";
import { displayQualificationPolicy } from "./display-qualification.mjs";

const displayPath = process.argv[2];
const runtimePath = option("--runtime");
const candidatePath = option("--candidate");
if (displayPath === undefined || runtimePath === undefined || candidatePath === undefined) throw new Error("usage: validate-display-report.mjs <display-report.json> --runtime <runtime-report.json> --candidate <candidate-manifest.json>");
if (dirname(resolve(displayPath)) !== dirname(resolve(runtimePath))) throw new Error("display and runtime reports must share one evidence directory");

const certification = await import(resolve("packages/certification/dist/index.js"));
const policy = parseJson(await boundedRead("config/release/release-policy.json", 1024 * 1024, "release policy"), "release policy");
const [displayBytes, runtimeBytes, candidateBytes] = await Promise.all([
  boundedRead(displayPath, policy.limits.maximumReportBytes, "display report"),
  boundedRead(runtimePath, policy.limits.maximumReportBytes, "runtime report"),
  boundedRead(candidatePath, policy.limits.maximumReportBytes, "candidate manifest")
]);
const candidateInput = parseJson(candidateBytes, "candidate manifest");
const candidate = certification.validateCandidateManifest(candidateInput);
requireCanonical(candidateBytes, candidate, "candidate manifest");
const candidateDigest = sha256(candidateBytes);
const fixtureAuthority = await loadCandidateFixtureAuthority(candidate, candidatePath, certification, {
  maximumArtifactBytes: policy.limits.maximumAttachmentBytes
});
const runtimeInput = parseJson(runtimeBytes, "runtime report");
const runtime = certification.validateRuntimeReport(runtimeInput);
requireCanonical(runtimeBytes, runtime, "runtime report");
if (runtime.candidateManifestDigest !== candidateDigest || runtime.commit !== candidate.commit || runtime.tree !== candidate.tree) throw new Error("display/runtime evidence candidate or source identity mismatch");
const displayInput = parseJson(displayBytes, "display report");
const report = await certification.validateDisplayReportBundle({
  root: dirname(resolve(displayPath)),
  display: displayInput,
  runtimeReportBytes: runtimeBytes,
  policy: {
    maximumAttachmentBytes: policy.limits.maximumAttachmentBytes,
    allowedMediaTypes: new Set(policy.allowedAttachmentMediaTypes),
    allowedFixtureDigests: fixtureAuthority.digests,
    allowedFixtureModels: fixtureAuthority.models,
    allowedFatalBoundaryFixtureDigests: fixtureAuthority.fatalBoundaryFixtureDigests,
    allowedCertificationHarnessDigests: fixtureAuthority.harnessDigests,
    allowedDisplayPatterns: fixtureAuthority.displayPatterns,
    ...displayQualificationPolicy(policy)
  }
});
requireCanonical(displayBytes, report, "display report");
if (report.candidateManifestDigest !== candidateDigest) throw new Error("display report candidate identity mismatch");
process.stdout.write(`${JSON.stringify({ status: report.status, reportId: report.reportId, sha256: sha256(displayBytes) })}\n`);

function option(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

async function boundedRead(path, maximumBytes, label) {
  try { return await certification.readStableBoundedFile(path, maximumBytes); }
  catch (error) { throw new Error(`${label} failed stable bounded read`, { cause: error }); }
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new Error(`${label} is not strict UTF-8 JSON`, { cause: error });
  }
}

function requireCanonical(bytes, value, label) {
  if (Buffer.compare(bytes, certification.canonicalJsonBytes(value)) !== 0) throw new Error(`${label} is not canonical JSON`);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
