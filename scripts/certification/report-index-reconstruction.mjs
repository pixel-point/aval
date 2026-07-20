import { createHash } from "node:crypto";
import { basename, dirname, resolve } from "node:path";
import { loadCandidateFixtureAuthority } from "./candidate-fixtures.mjs";
import { displayQualificationPolicy } from "./display-qualification.mjs";

/** Reloads every byte referenced by an index and reconstructs its semantic profiles. */
export async function reconstructReportIndex({ indexPath, candidatePath, referenceRoot = process.cwd(), certification, policy }) {
  const indexBytes = await boundedRead(indexPath, policy.limits.maximumReportBytes, "report index", certification);
  const index = certification.validateReportIndex(parseJson(indexBytes, "report index"), policy.namedProfiles);
  requireCanonical(indexBytes, index, certification, "report index");
  let candidate = null; let candidateDigest = null; let fixtureAuthority = Object.freeze({ digests: new Set(), models: new Map(), displayPatterns: new Map(), fatalBoundaryFixtureDigests: new Set(), harnessDigests: new Set() });
  if (candidatePath !== undefined) {
    const candidateBytes = await boundedRead(candidatePath, policy.limits.maximumReportBytes, "candidate manifest", certification);
    candidate = certification.validateCandidateManifest(parseJson(candidateBytes, "candidate manifest"));
    requireCanonical(candidateBytes, candidate, certification, "candidate manifest");
    candidateDigest = sha256(candidateBytes);
    fixtureAuthority = await loadCandidateFixtureAuthority(candidate, candidatePath, certification, { maximumArtifactBytes: policy.limits.maximumAttachmentBytes });
  }
  if (index.candidateManifestDigest !== candidateDigest) throw new Error("report index candidate digest mismatch");
  const runtimes = new Map(); const displayInputs = [];
  for (const reference of index.reports) {
    const bytes = await referenceBytes(reference, policy.limits.maximumReportBytes, referenceRoot, certification);
    const parsed = parseJson(bytes, `report ${reference.id}`);
    if (parsed.reportKind === "runtime-scheduling") {
      if (candidate === null || candidateDigest === null) throw new Error("candidate is required for indexed runtime reports");
      const path = resolve(referenceRoot, reference.path);
      const report = await certification.validateRuntimeReportBundle(dirname(path), parsed, {
        maximumAttachmentBytes: policy.limits.maximumAttachmentBytes,
        allowedMediaTypes: new Set(policy.allowedAttachmentMediaTypes),
        allowedFixtureDigests: fixtureAuthority.digests,
        allowedFixtureModels: fixtureAuthority.models,
        allowedFatalBoundaryFixtureDigests: fixtureAuthority.fatalBoundaryFixtureDigests,
        allowedCertificationHarnessDigests: fixtureAuthority.harnessDigests
      });
      requireCanonical(bytes, report, certification, `runtime report ${report.reportId}`);
      if (reference.id !== report.reportId || report.candidateManifestDigest !== candidateDigest || report.commit !== candidate.commit || report.tree !== candidate.tree) throw new Error(`runtime report identity mismatch: ${reference.id}`);
      if (Date.parse(report.startedAt) < Date.parse(candidate.createdAt)) throw new Error(`runtime report predates its candidate: ${report.reportId}`);
      const profileId = certification.createPublicProfileId(report.environment);
      if (basename(dirname(path)) !== profileId || runtimes.has(report.reportId) || [...runtimes.values()].some((value) => value.profileId === profileId)) throw new Error(`runtime profile identity is duplicate or misplaced: ${report.reportId}`);
      runtimes.set(report.reportId, { report, bytes, path, profileId });
    } else if (parsed.reportKind === "observed-display") {
      displayInputs.push({ reference, parsed, bytes, path: resolve(referenceRoot, reference.path) });
    } else throw new Error(`indexed report kind is invalid: ${reference.id}`);
  }
  const displaysByRuntime = new Map();
  for (const input of displayInputs) {
    const runtime = runtimes.get(input.parsed.runtimeReportId);
    if (runtime === undefined) throw new Error(`display report references absent runtime: ${input.reference.id}`);
    const display = await certification.validateDisplayReportBundle({
      root: dirname(input.path), display: input.parsed, runtimeReportBytes: runtime.bytes,
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
    requireCanonical(input.bytes, display, certification, `display report ${display.reportId}`);
    if (input.reference.id !== display.reportId || dirname(input.path) !== dirname(runtime.path) || displaysByRuntime.has(runtime.report.reportId)) throw new Error(`display report identity is duplicate or misplaced: ${display.reportId}`);
    if (Date.parse(display.startedAt) < Date.parse(runtime.report.endedAt)) throw new Error(`display report predates its referenced completed runtime report: ${display.reportId}`);
    displaysByRuntime.set(runtime.report.reportId, { display, digest: sha256(input.bytes) });
  }
  const reconstructedProfiles = [...runtimes.values()].map(({ report, bytes, profileId }) => {
    const coverageFailures = certification.validateScenarioCoverage(report.scenarios.map((scenario) => ({ id: scenario.id, repetition: scenario.repetition, boundaryCount: scenario.boundaryCount, frameCount: scenario.frameCount, operationCount: scenario.operationCount, headedOperationCount: scenario.headedOperationCount })));
    const display = displaysByRuntime.get(report.reportId);
    return {
      profileId, platformClass: report.environment.platformClass, browserProduct: report.environment.browser.product, browserVersion: report.environment.browser.version,
      browserBuild: report.environment.browser.build, browserChannel: report.environment.browser.channel,
      osProduct: report.environment.os.product, osVersion: report.environment.os.version,
      deviceClass: report.environment.hardware.deviceClass, virtualization: report.environment.hardware.virtualization,
      refreshMilliHz: report.environment.display.refreshMilliHz, refresh120Available: report.environment.capabilities.refresh120Available === true,
      animated: report.environment.capabilities.productionAnimationSupported === true,
      fatalErrorBoundary: report.criteria.find((criterion) => criterion.id === "runtime-fatal-error-boundary")?.status ?? "not-run",
      runtimeScheduling: report.status === "passed" && coverageFailures.length === 0 ? "passed" : report.status === "passed" ? "failed" : report.status,
      coverageFailures, observedDisplay: display?.display.status ?? "not-run", runtimeReportId: report.reportId, runtimeReportDigest: sha256(bytes),
      observedDisplayReportId: display?.display.reportId ?? null, observedDisplayReportDigest: display?.digest ?? null
    };
  }).sort((left, right) => left.profileId < right.profileId ? -1 : left.profileId > right.profileId ? 1 : 0);
  if (!sameCanonical(reconstructedProfiles, index.profiles, certification)) throw new Error("report index profiles do not reconstruct from referenced report bytes");
  let validatedReviewEntries = [];
  if (index.reviewRecord === null) {
    if (index.reviews.length !== 0) throw new Error("report index reviews lack evidence");
  } else {
    const reviewBytes = await referenceBytes(index.reviewRecord, policy.limits.maximumReportBytes, referenceRoot, certification);
    const reviewInput = parseJson(reviewBytes, "review record"); requireCanonical(reviewBytes, reviewInput, certification, "review record");
    const validatedReviews = certification.validateReviewRecord(reviewInput, candidateDigest, [...runtimes.keys()].sort(), new Map([...runtimes].map(([id, value]) => [id, value.report.endedAt])));
    validatedReviewEntries = validatedReviews.reviews;
    const summaries = validatedReviews.summaries;
    const reviewerIds = validatedReviews.reviews.map(({ id }) => id).sort();
    for (const { report } of runtimes.values()) if (JSON.stringify([...report.reviewerIds].sort()) !== JSON.stringify(reviewerIds)) throw new Error(`runtime report reviewer IDs do not match the verified review record: ${report.reportId}`);
    if (!sameCanonical(summaries, index.reviews, certification)) throw new Error("report index review summaries do not match review bytes");
  }
  const chronology = [
    candidate?.createdAt,
    ...[...runtimes.values()].flatMap(({ report }) => [report.startedAt, report.endedAt]),
    ...[...displaysByRuntime.values()].flatMap(({ display }) => [display.startedAt, display.endedAt]),
    ...validatedReviewEntries.map(({ reviewedAt }) => reviewedAt)
  ].filter((value) => typeof value === "string");
  const latestEvidenceAt = chronology.length === 0 ? null : chronology.reduce((latest, value) => Date.parse(value) > Date.parse(latest) ? value : latest);
  return Object.freeze({ index, indexBytes, candidate, candidateDigest, profiles: Object.freeze(reconstructedProfiles), latestEvidenceAt });
}

async function referenceBytes(reference, maximumBytes, referenceRoot, certification) {
  if (reference.mediaType !== "application/json") throw new Error(`indexed reference is not JSON: ${reference.id}`);
  const bytes = await boundedRead(resolve(referenceRoot, reference.path), maximumBytes, `reference ${reference.id}`, certification);
  if (bytes.byteLength !== reference.byteLength || sha256(bytes) !== reference.sha256) throw new Error(`indexed reference bytes mismatch: ${reference.id}`);
  return bytes;
}
async function boundedRead(path, maximumBytes, label, certification) { try { return await certification.readStableBoundedFile(path, maximumBytes); } catch (error) { throw new Error(`${label} failed stable bounded read`, { cause: error }); } }
function parseJson(bytes, label) { try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw new Error(`${label} is not strict UTF-8 JSON`); } }
function requireCanonical(bytes, value, certification, label) { if (Buffer.compare(bytes, certification.canonicalJsonBytes(value)) !== 0) throw new Error(`${label} is not canonical JSON`); }
function sameCanonical(left, right, certification) { return Buffer.compare(certification.canonicalJsonBytes(left), certification.canonicalJsonBytes(right)) === 0; }
function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
