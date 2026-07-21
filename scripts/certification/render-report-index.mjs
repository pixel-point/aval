#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { loadCandidateFixtureAuthority } from "./candidate-fixtures.mjs";
import { displayQualificationPolicy } from "./display-qualification.mjs";
import {
  deriveNamedProfileMatrixPolicy,
  resolveBrowserCertificationPolicyPath
} from "./named-profile-policy.mjs";

const args = parse(process.argv.slice(2));
const reportsRoot = resolve(required(args, "reports"));
const outputJson = resolve(required(args, "output-json"));
const outputMarkdown = resolve(required(args, "output-markdown"));
const referenceRoot = resolve(args["path-root"] ?? process.cwd());
const certification = await import(resolve("packages/certification/dist/index.js"));
const policy = parseJson(
  await stableRead("config/release/release-policy.json", 1024 * 1024, "release policy"),
  "release policy"
);
const candidatePath = args.candidate === undefined
  ? undefined : resolve(args.candidate);
const browserPolicyPath = resolveBrowserCertificationPolicyPath(
  policy.namedProfiles,
  { candidateManifestPath: candidatePath, repositoryRoot: process.cwd() }
);
const namedProfilePolicy = deriveNamedProfileMatrixPolicy(
  policy.namedProfiles,
  parseJson(
    await stableRead(
      browserPolicyPath,
      policy.limits.maximumReportBytes,
      "browser certification policy"
    ),
    "browser certification policy"
  )
);
let candidate = null;
let candidateDigest = null;
let fixtureAuthority = Object.freeze({ digests: new Set(), models: new Map(), displayPatterns: new Map(), fatalBoundaryFixtureDigests: new Set(), harnessDigests: new Set() });
if (args.candidate !== undefined) {
  const candidateBytes = await stableRead(candidatePath, policy.limits.maximumReportBytes, "candidate manifest");
  candidate = certification.validateCandidateManifest(parseJson(candidateBytes, "candidate manifest"));
  if (Buffer.compare(candidateBytes, certification.canonicalJsonBytes(candidate)) !== 0) throw new Error("candidate manifest is not canonical JSON");
  candidateDigest = createHash("sha256").update(candidateBytes).digest("hex");
  fixtureAuthority = await loadCandidateFixtureAuthority(candidate, candidatePath, certification, { maximumArtifactBytes: policy.limits.maximumAttachmentBytes });
}
const profiles = [];
const reportReferences = [];
const runtimeReviewAuthority = new Map();
for (const entry of await readdir(reportsRoot, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const profileRoot = join(reportsRoot, entry.name);
  const runtimePath = join(profileRoot, "runtime-scheduling.json");
  let runtimeBytes;
  try {
    runtimeBytes = await stableRead(runtimePath, policy.limits.maximumReportBytes, `runtime report ${runtimePath}`);
  } catch (error) {
    if (error?.code === "ENOENT") continue;
    throw error;
  }
  const runtime = await certification.validateRuntimeReportBundle(profileRoot, parseJson(runtimeBytes, `runtime report ${runtimePath}`), {
    maximumAttachmentBytes: policy.limits.maximumAttachmentBytes,
    allowedMediaTypes: new Set(policy.allowedAttachmentMediaTypes),
    allowedFixtureDigests: fixtureAuthority.digests,
    allowedFixtureModels: fixtureAuthority.models,
    allowedFatalBoundaryFixtureDigests: fixtureAuthority.fatalBoundaryFixtureDigests,
    allowedCertificationHarnessDigests: fixtureAuthority.harnessDigests
  });
  requireCanonical(runtimeBytes, runtime, `runtime report ${runtime.reportId}`);
  if (candidate === null || candidateDigest === null) throw new Error("--candidate is required when runtime reports are present");
  if (runtime.candidateManifestDigest !== candidateDigest || runtime.commit !== candidate.commit || runtime.tree !== candidate.tree) throw new Error(`${runtime.reportId}: candidate/source identity mismatch`);
  const expectedProfileId = certification.createPublicProfileId(runtime.environment);
  if (entry.name !== expectedProfileId) throw new Error(`${runtime.reportId}: profile directory must be ${expectedProfileId}`);
  runtimeReviewAuthority.set(runtime.reportId, Object.freeze({ endedAt: runtime.endedAt, reviewerIds: runtime.reviewerIds }));
  const runtimeDigest = createHash("sha256").update(runtimeBytes).digest("hex");
  const coverageFailures = certification.validateScenarioCoverage(runtime.scenarios.map((scenario) => ({
    id: scenario.id,
    repetition: scenario.repetition,
    boundaryCount: scenario.boundaryCount,
    frameCount: scenario.frameCount,
    operationCount: scenario.operationCount,
    headedOperationCount: scenario.headedOperationCount
  })));
  const fatalErrorBoundary = criterionStatus(runtime, "runtime-fatal-error-boundary");
  let observedDisplay = "not-run";
  let observedDisplayReportId = null;
  let observedDisplayReportDigest = null;
  const displayPath = join(profileRoot, "observed-display.json");
  try {
    const displayBytes = await stableRead(displayPath, policy.limits.maximumReportBytes, `display report ${displayPath}`);
    const display = await certification.validateDisplayReportBundle({
      root: profileRoot,
      display: parseJson(displayBytes, `display report ${displayPath}`),
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
    requireCanonical(displayBytes, display, `display report ${display.reportId}`);
    observedDisplay = display.status;
    observedDisplayReportId = display.reportId;
    observedDisplayReportDigest = createHash("sha256").update(displayBytes).digest("hex");
    reportReferences.push(reference(displayPath, displayBytes, display.reportId));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  profiles.push({
    profileId: entry.name,
    platformClass: runtime.environment.platformClass,
    browserProduct: runtime.environment.browser.product,
    browserVersion: runtime.environment.browser.version,
    browserBuild: runtime.environment.browser.build,
    browserChannel: runtime.environment.browser.channel,
    osProduct: runtime.environment.os.product,
    osVersion: runtime.environment.os.version,
    deviceClass: runtime.environment.hardware.deviceClass,
    virtualization: runtime.environment.hardware.virtualization,
    refreshMilliHz: runtime.environment.display.refreshMilliHz,
    refresh120Available: runtime.environment.capabilities.refresh120Available === true,
    animated: runtime.environment.capabilities.productionAnimationSupported === true,
    fatalErrorBoundary,
    runtimeScheduling: runtime.status === "passed" && coverageFailures.length === 0 ? "passed" : runtime.status === "passed" ? "failed" : runtime.status,
    coverageFailures,
    observedDisplay,
    runtimeReportId: runtime.reportId,
    runtimeReportDigest: runtimeDigest,
    observedDisplayReportId,
    observedDisplayReportDigest
  });
  reportReferences.push(reference(runtimePath, runtimeBytes, runtime.reportId));
}
profiles.sort((left, right) => left.profileId < right.profileId ? -1 : left.profileId > right.profileId ? 1 : 0);
const matrix = certification.evaluateNamedProfileMatrix(profiles.map((profile) => ({
  profileId: profile.profileId,
  platformClass: profile.platformClass,
  browserProduct: profile.browserProduct,
  browserVersion: profile.browserVersion,
  browserBuild: profile.browserBuild,
  browserChannel: profile.browserChannel,
  osProduct: profile.osProduct,
  osVersion: profile.osVersion,
  deviceClass: profile.deviceClass,
  virtualization: profile.virtualization,
  refreshMilliHz: profile.refreshMilliHz,
  refresh120Available: profile.refresh120Available,
  animationSupported: profile.animated,
  runtimeScheduling: profile.runtimeScheduling,
  fatalErrorBoundary: profile.fatalErrorBoundary
})), namedProfilePolicy);
let reviews = [];
let reviewRecord = null;
try {
  const reviewPath = join(reportsRoot, "reviews.json");
  const reviewBytes = await stableRead(reviewPath, policy.limits.maximumReportBytes, "review record");
  const reviewInput = parseJson(reviewBytes, "review record");
  requireCanonical(reviewBytes, reviewInput, "review record");
  const validatedReviews = certification.validateReviewRecord(
    reviewInput,
    candidateDigest,
    profiles.map(({ runtimeReportId }) => runtimeReportId).sort(),
    new Map([...runtimeReviewAuthority].map(([id, authority]) => [id, authority.endedAt]))
  );
  const reviewerIds = validatedReviews.reviews.map(({ id }) => id).sort();
  for (const [reportId, authority] of runtimeReviewAuthority) {
    if (!sameStringSet(authority.reviewerIds, reviewerIds)) throw new Error(`runtime report reviewer IDs do not match the verified review record: ${reportId}`);
  }
  reviews = [...validatedReviews.summaries].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  reviewRecord = reference(reviewPath, reviewBytes, "certification-review-record");
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
const reviewsPassed = reviews.length >= 2 && reviews.every(({ decision }) => decision === "approved");
const releaseStatus = profiles.length === 0
  ? "not-run"
  : matrix.status === "failed" ? "failed"
    : matrix.status === "passed" && reviewsPassed ? "passed" : "inconclusive";
const index = {
  schemaVersion: "1.0",
  releaseVersion: "1.0.0",
  candidateManifestDigest: candidateDigest,
  releaseStatus,
  runtimeScheduling: matrix.status,
  observedDisplay: certification.aggregateObservedDisplayStatus(profiles.map(({ observedDisplay }) => observedDisplay)),
  matrixFailures: matrix.failures,
  missingMatrixSlots: matrix.missingSlots,
  profiles,
  reports: reportReferences.sort((left, right) => left.path < right.path ? -1 : 1),
  reviewRecord,
  reviews
};
const validatedIndex = certification.validateReportIndex(index, namedProfilePolicy);
await writeFile(outputJson, certification.canonicalJsonBytes(validatedIndex), { flag: "wx" });
await writeFile(outputMarkdown, render(validatedIndex), { flag: "wx" });
process.stdout.write(`${JSON.stringify({ status: "passed", releaseStatus: validatedIndex.releaseStatus, profiles: profiles.length })}\n`);

function criterionStatus(report, id) { return report.criteria.find((criterion) => criterion.id === id)?.status ?? "not-run"; }
function reference(path, bytes, id) {
  const referencePath = relative(referenceRoot, path).split("\\").join("/");
  if (referencePath === "" || referencePath === ".." || referencePath.startsWith("../")) throw new Error(`report reference escapes --path-root: ${path}`);
  return { id, path: referencePath, sha256: createHash("sha256").update(bytes).digest("hex"), byteLength: bytes.byteLength, mediaType: "application/json" };
}
function render(index) {
  const rows = index.profiles.length === 0 ? ["| No named profiles | not run | not run | not measured |"] : index.profiles.map((profile) => `| ${escapeCell(profile.profileId)} | ${profile.fatalErrorBoundary} | ${profile.runtimeScheduling} | ${profile.observedDisplay === "not-run" ? "not measured" : profile.observedDisplay} |`);
  return ["# AVAL 1.0.0 certification index", "", `Release status: **${index.releaseStatus}**`, "", "| Profile | Fatal error boundary | Runtime scheduling | Observed display |", "| --- | --- | --- | --- |", ...rows, "", "The fatal error boundary, runtime scheduling, and observed-display evidence are separate claim layers.", ""].join("\n");
}
function requireCanonical(bytes, value, label) {
  if (Buffer.compare(bytes, certification.canonicalJsonBytes(value)) !== 0) throw new Error(`${label} is not canonical JSON`);
}
async function stableRead(path, maximumBytes, label) {
  try { return await certification.readStableBoundedFile(path, maximumBytes); }
  catch (error) {
    if (error?.code === "ENOENT") throw error;
    throw new Error(`${label} failed stable bounded read`, { cause: error });
  }
}
function parseJson(bytes, label) {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch (error) { throw new Error(`${label} is not strict UTF-8 JSON`, { cause: error }); }
}
function sameStringSet(left, right) {
  const leftSorted = [...left].sort();
  const rightSorted = [...right].sort();
  return leftSorted.length === rightSorted.length && leftSorted.every((value, index) => value === rightSorted[index]);
}
function escapeCell(value) { return String(value).replaceAll("|", "\\|").replace(/[\r\n]+/gu, " "); }
function parse(values) { const result = {}; for (let index = 0; index < values.length; index += 2) result[String(values[index]).replace(/^--/u, "")] = values[index + 1]; return result; }
function required(values, key) { if (values[key] === undefined) throw new Error(`--${key} is required`); return values[key]; }
