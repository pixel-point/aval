import { SHA256_PATTERN, type DigestReference } from "./model.js";
import {
  browserBuildMatchesProductVersion,
  isExactBrowserBuild,
  isExactProductVersion
} from "./exact-version.js";
import { evaluateNamedProfileMatrix, type NamedProfileMatrixPolicy } from "./report-index-criteria.js";
import type { CertificationReviewSummary } from "./review-record.js";
import { assertCertificationStatus, type CertificationStatus } from "./status.js";

export interface CertificationIndexProfile {
  readonly profileId: string;
  readonly platformClass: string;
  readonly browserProduct: string;
  readonly browserVersion: string;
  readonly browserBuild: string;
  readonly browserChannel: string;
  readonly osProduct: string;
  readonly osVersion: string;
  readonly deviceClass: string;
  readonly virtualization: "none" | "virtualized" | "unknown";
  readonly refreshMilliHz: number;
  readonly refresh120Available: boolean;
  readonly animated: boolean;
  readonly fatalErrorBoundary: CertificationStatus;
  readonly runtimeScheduling: CertificationStatus;
  readonly coverageFailures: readonly string[];
  readonly observedDisplay: CertificationStatus;
  readonly runtimeReportId: string;
  readonly runtimeReportDigest: string;
  readonly observedDisplayReportId: string | null;
  readonly observedDisplayReportDigest: string | null;
}

export interface CertificationReportIndex {
  readonly schemaVersion: "1.0";
  readonly releaseVersion: "1.0.0";
  readonly candidateManifestDigest: string | null;
  readonly releaseStatus: "passed" | "failed" | "inconclusive" | "not-run";
  readonly runtimeScheduling: "passed" | "failed" | "inconclusive" | "not-run";
  readonly observedDisplay: CertificationStatus;
  readonly matrixFailures: readonly string[];
  readonly missingMatrixSlots: readonly string[];
  readonly profiles: readonly CertificationIndexProfile[];
  readonly reports: readonly DigestReference[];
  readonly reviewRecord: DigestReference | null;
  readonly reviews: readonly CertificationReviewSummary[];
}

const ROOT_KEYS = ["schemaVersion", "releaseVersion", "candidateManifestDigest", "releaseStatus", "runtimeScheduling", "observedDisplay", "matrixFailures", "missingMatrixSlots", "profiles", "reports", "reviewRecord", "reviews"] as const;
const PROFILE_KEYS = ["profileId", "platformClass", "browserProduct", "browserVersion", "browserBuild", "browserChannel", "osProduct", "osVersion", "deviceClass", "virtualization", "refreshMilliHz", "refresh120Available", "animated", "fatalErrorBoundary", "runtimeScheduling", "coverageFailures", "observedDisplay", "runtimeReportId", "runtimeReportDigest", "observedDisplayReportId", "observedDisplayReportDigest"] as const;
const REFERENCE_KEYS = ["id", "path", "sha256", "byteLength", "mediaType"] as const;

/** Validates the canonical index model and independently recomputes its matrix/release summaries. */
export function validateReportIndex(input: unknown, policy: NamedProfileMatrixPolicy): CertificationReportIndex {
  const root = exactRecord(input, ROOT_KEYS, "$index");
  literal(root.schemaVersion, "1.0", "$index.schemaVersion");
  literal(root.releaseVersion, "1.0.0", "$index.releaseVersion");
  const candidateManifestDigest = root.candidateManifestDigest === null ? null : digest(root.candidateManifestDigest, "$index.candidateManifestDigest");
  const profiles = boundedArray(root.profiles, "$index.profiles", 256).map(parseProfile);
  requireSortedUnique(profiles.map(({ profileId }) => profileId), "$index.profiles.profileId");
  const reports = boundedArray(root.reports, "$index.reports", 512).map((value, index) => parseReference(value, `$index.reports[${String(index)}]`));
  requireSortedUnique(reports.map(({ path }) => path), "$index.reports.path");
  requireUnique(reports.map(({ id }) => id), "$index.reports.id");
  const reviewRecord = root.reviewRecord === null ? null : parseReference(root.reviewRecord, "$index.reviewRecord");
  if (reviewRecord !== null && (reviewRecord.id !== "certification-review-record" || reviewRecord.mediaType !== "application/json")) throw new TypeError("$index.reviewRecord is not canonical review evidence");
  const reviews = boundedArray(root.reviews, "$index.reviews", 32).map((value, index) => parseReview(value, `$index.reviews[${String(index)}]`));
  requireSortedUnique(reviews.map(({ id }) => id), "$index.reviews.id");
  const matrixFailures = stringArray(root.matrixFailures, "$index.matrixFailures", 4_096);
  const missingMatrixSlots = stringArray(root.missingMatrixSlots, "$index.missingMatrixSlots", 4_096);
  const runtimeIds = new Set<string>();
  const displayIds = new Set<string>();
  const referenceById = new Map(reports.map((reference) => [reference.id, reference]));
  for (const profile of profiles) {
    if (profile.runtimeScheduling === "passed" && profile.coverageFailures.length !== 0) throw new TypeError(`$index passed runtime has coverage failures: ${profile.profileId}`);
    if (runtimeIds.has(profile.runtimeReportId)) throw new TypeError(`$index duplicate runtime report: ${profile.runtimeReportId}`);
    runtimeIds.add(profile.runtimeReportId);
    const runtimeReference = referenceById.get(profile.runtimeReportId);
    if (runtimeReference === undefined || runtimeReference.sha256 !== profile.runtimeReportDigest) throw new TypeError(`$index runtime report reference mismatch: ${profile.runtimeReportId}`);
    const displayAbsent = profile.observedDisplayReportId === null && profile.observedDisplayReportDigest === null;
    if ((profile.observedDisplayReportId === null) !== (profile.observedDisplayReportDigest === null) || displayAbsent !== (profile.observedDisplay === "not-run")) throw new TypeError(`$index observed display binding mismatch: ${profile.profileId}`);
    if (!displayAbsent) {
      if (displayIds.has(profile.observedDisplayReportId!)) throw new TypeError(`$index duplicate display report: ${profile.observedDisplayReportId!}`);
      displayIds.add(profile.observedDisplayReportId!);
      const displayReference = referenceById.get(profile.observedDisplayReportId!);
      if (displayReference === undefined || displayReference.sha256 !== profile.observedDisplayReportDigest) throw new TypeError(`$index display report reference mismatch: ${profile.observedDisplayReportId!}`);
    }
  }
  const claimed = new Set([...runtimeIds, ...displayIds]);
  if (reports.some(({ id }) => !claimed.has(id))) throw new TypeError("$index contains an unclaimed report reference");
  if (reports.some(({ mediaType }) => mediaType !== "application/json")) throw new TypeError("$index report references must use application/json");
  if (profiles.length > 0 && candidateManifestDigest === null) throw new TypeError("$index candidate digest is required when reports exist");
  const matrix = evaluateNamedProfileMatrix(profiles.map((profile) => ({
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
  })), policy);
  if (root.runtimeScheduling !== matrix.status || !sameStrings(matrixFailures, matrix.failures) || !sameStrings(missingMatrixSlots, matrix.missingSlots)) throw new TypeError("$index matrix summary was not derived from profiles");
  const observedDisplay = aggregateObservedDisplayStatus(profiles.map((profile) => profile.observedDisplay));
  if (root.observedDisplay !== observedDisplay) throw new TypeError("$index observed-display summary was not derived from profiles");
  const reviewsPassed = reviews.length >= 2 && reviews.every(({ decision }) => decision === "approved");
  const releaseStatus = profiles.length === 0 ? "not-run" : matrix.status === "failed" ? "failed" : matrix.status === "passed" && reviewsPassed && reviewRecord !== null ? "passed" : "inconclusive";
  if (root.releaseStatus !== releaseStatus) throw new TypeError("$index release status was not derived from matrix and reviews");
  if (releaseStatus === "passed" && (candidateManifestDigest === null || reports.length === 0)) throw new TypeError("$index passed without candidate-bound reports");
  return Object.freeze({
    schemaVersion: "1.0", releaseVersion: "1.0.0", candidateManifestDigest, releaseStatus, runtimeScheduling: matrix.status,
    observedDisplay, matrixFailures: Object.freeze(matrixFailures), missingMatrixSlots: Object.freeze(missingMatrixSlots),
    profiles: Object.freeze(profiles), reports: Object.freeze(reports), reviewRecord, reviews: Object.freeze(reviews)
  });
}

export function aggregateObservedDisplayStatus(values: readonly CertificationStatus[]): CertificationStatus {
  const measured = values.filter((value) => value !== "not-run");
  if (measured.length === 0) return "not-run";
  for (const status of ["failed", "inconclusive", "unsupported", "withdrawn"] as const) if (measured.includes(status)) return status;
  return values.every((value) => value === "passed") ? "passed" : "inconclusive";
}

function parseProfile(value: unknown, index: number): CertificationIndexProfile {
  const path = `$index.profiles[${String(index)}]`;
  const profile = exactRecord(value, PROFILE_KEYS, path);
  assertCertificationStatus(profile.fatalErrorBoundary, `${path}.fatalErrorBoundary`);
  assertCertificationStatus(profile.runtimeScheduling, `${path}.runtimeScheduling`);
  assertCertificationStatus(profile.observedDisplay, `${path}.observedDisplay`);
  const browserProduct = boundedText(profile.browserProduct, `${path}.browserProduct`, 128);
  const browserVersion = exactProductVersion(profile.browserVersion, `${path}.browserVersion`, "browser");
  const browserBuild = exactBrowserBuild(profile.browserBuild, `${path}.browserBuild`);
  if (!browserBuildMatchesProductVersion(browserProduct, browserVersion, browserBuild)) throw new TypeError(`${path}.browserBuild does not match browser version`);
  return Object.freeze({
    profileId: identifier(profile.profileId, `${path}.profileId`), platformClass: identifier(profile.platformClass, `${path}.platformClass`),
    browserProduct, browserVersion,
    browserBuild, browserChannel: boundedText(profile.browserChannel, `${path}.browserChannel`, 64),
    osProduct: boundedText(profile.osProduct, `${path}.osProduct`, 128), osVersion: exactProductVersion(profile.osVersion, `${path}.osVersion`, "OS"),
    deviceClass: boundedText(profile.deviceClass, `${path}.deviceClass`, 128), virtualization: virtualization(profile.virtualization, `${path}.virtualization`),
    refreshMilliHz: positiveInteger(profile.refreshMilliHz, `${path}.refreshMilliHz`), refresh120Available: boolean(profile.refresh120Available, `${path}.refresh120Available`), animated: boolean(profile.animated, `${path}.animated`),
    fatalErrorBoundary: profile.fatalErrorBoundary, runtimeScheduling: profile.runtimeScheduling, coverageFailures: Object.freeze(stringArray(profile.coverageFailures, `${path}.coverageFailures`, 256)),
    observedDisplay: profile.observedDisplay, runtimeReportId: identifier(profile.runtimeReportId, `${path}.runtimeReportId`), runtimeReportDigest: digest(profile.runtimeReportDigest, `${path}.runtimeReportDigest`),
    observedDisplayReportId: profile.observedDisplayReportId === null ? null : identifier(profile.observedDisplayReportId, `${path}.observedDisplayReportId`),
    observedDisplayReportDigest: profile.observedDisplayReportDigest === null ? null : digest(profile.observedDisplayReportDigest, `${path}.observedDisplayReportDigest`)
  });
}

function parseReference(value: unknown, path: string): DigestReference {
  const reference = exactRecord(value, REFERENCE_KEYS, path);
  const referencePath = boundedText(reference.path, `${path}.path`, 1_024);
  if (referencePath.startsWith("/") || referencePath.includes("\\") || referencePath.split("/").some((part) => part === "" || part === "." || part === "..")) throw new TypeError(`${path}.path is unsafe`);
  return Object.freeze({ id: identifier(reference.id, `${path}.id`), path: referencePath, sha256: digest(reference.sha256, `${path}.sha256`), byteLength: positiveInteger(reference.byteLength, `${path}.byteLength`), mediaType: boundedText(reference.mediaType, `${path}.mediaType`, 128) });
}

function parseReview(value: unknown, path: string): CertificationReviewSummary {
  const review = exactRecord(value, ["id", "decision", "evidenceDigest"], path);
  if (review.decision !== "approved" && review.decision !== "rejected") throw new TypeError(`${path}.decision is invalid`);
  return Object.freeze({ id: identifier(review.id, `${path}.id`), decision: review.decision, evidenceDigest: digest(review.evidenceDigest, `${path}.evidenceDigest`) });
}

function exactRecord(value: unknown, keys: readonly string[], path: string): Record<string, unknown> { if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${path} must be an object`); const result = value as Record<string, unknown>; const allowed = new Set(keys); for (const key of Object.keys(result)) if (!allowed.has(key)) throw new TypeError(`${path}.${key} is unknown`); for (const key of keys) if (!(key in result)) throw new TypeError(`${path}.${key} is required`); return result; }
function boundedArray(value: unknown, path: string, maximum: number): readonly unknown[] { if (!Array.isArray(value) || value.length > maximum) throw new TypeError(`${path} must be an array of at most ${String(maximum)} items`); return value; }
function stringArray(value: unknown, path: string, maximum: number): string[] { return boundedArray(value, path, maximum).map((item, index) => boundedText(item, `${path}[${String(index)}]`, 1_024)); }
function boundedText(value: unknown, path: string, maximum: number): string { if (typeof value !== "string" || value.length < 1 || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) throw new TypeError(`${path} is invalid`); return value; }
function exactProductVersion(value: unknown, path: string, product: "browser" | "OS"): string { const version = boundedText(value, path, 128); if (!isExactProductVersion(version)) throw new TypeError(`${path} must be an exact ${product} version`); return version; }
function exactBrowserBuild(value: unknown, path: string): string { const build = boundedText(value, path, 128); if (!isExactBrowserBuild(build)) throw new TypeError(`${path} must be an exact browser build`); return build; }
function virtualization(value: unknown, path: string): "none" | "virtualized" | "unknown" { if (value !== "none" && value !== "virtualized" && value !== "unknown") throw new TypeError(`${path} is invalid`); return value; }
function identifier(value: unknown, path: string): string { if (typeof value !== "string" || !/^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/u.test(value)) throw new TypeError(`${path} is invalid`); return value; }
function digest(value: unknown, path: string): string { if (typeof value !== "string" || !SHA256_PATTERN.test(value)) throw new TypeError(`${path} is invalid`); return value; }
function positiveInteger(value: unknown, path: string): number { if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new TypeError(`${path} must be a positive safe integer`); return value as number; }
function boolean(value: unknown, path: string): boolean { if (typeof value !== "boolean") throw new TypeError(`${path} must be boolean`); return value; }
function literal(value: unknown, expected: string, path: string): void { if (value !== expected) throw new TypeError(`${path} must be ${expected}`); }
function requireUnique(values: readonly string[], path: string): void { if (new Set(values).size !== values.length) throw new TypeError(`${path} contains duplicates`); }
function requireSortedUnique(values: readonly string[], path: string): void { requireUnique(values, path); const sorted = [...values].sort(compareAscii); if (!sameStrings(values, sorted)) throw new TypeError(`${path} must use canonical ASCII order`); }
function sameStrings(left: readonly string[], right: readonly string[]): boolean { return left.length === right.length && left.every((value, index) => value === right[index]); }
function compareAscii(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
