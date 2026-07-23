import { createHash } from "node:crypto";
import { canonicalJsonBytes } from "./canonical-json.js";
import { PUBLIC_RELEASE_PACKAGES } from "./compatibility.js";
import {
  SHA256_PATTERN,
  type CandidateManifest,
  type ReleaseManifest
} from "./model.js";
import { CertificationValidationError } from "./status.js";

const ID = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const TOOL = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/u;
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/u;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const MAX_REFERENCE_BYTES = 1024 * 1024 * 1024;
const PACKAGE_ARTIFACT_PATHS = new Set(PUBLIC_RELEASE_PACKAGES.map((name) => `packages/${name.slice(1).replace("/", "-")}-1.0.0.tgz`));
const REQUIRED_CANDIDATE_ROLES = new Set([
  "package", "package-index", "package-inspection", "sbom", "api-report",
  "schema", "fixture", "documentation", "example", "browser-harness",
  "release-policy", "legal-review", "license-report", "candidate-layout"
]);
const ALLOWED_CANDIDATE_ROLES = new Set([...REQUIRED_CANDIDATE_ROLES, "project-metadata"]);
const RELEASE_PACKAGE_DIRECTORIES = PUBLIC_RELEASE_PACKAGES.map((name) => name.slice("@pixel-point/aval-".length));
const REQUIRED_SBOM_PATHS = new Set(["workspace", ...RELEASE_PACKAGE_DIRECTORIES].map((name) => `sbom/${name}.spdx.json`));
const REQUIRED_API_PATHS = new Set(RELEASE_PACKAGE_DIRECTORIES.map((name) => `etc/api/${name}.api.md`));

export function candidateManifestDigest(manifest: CandidateManifest): string {
  validateCandidateManifest(manifest);
  return createHash("sha256").update(canonicalJsonBytes(manifest)).digest("hex");
}

export function validateCandidateManifest(input: unknown): CandidateManifest {
  const candidate = object(input, "candidate");
  exactKeys(candidate, "candidate", [
    "schemaVersion", "manifestKind", "releaseVersion", "releaseSetDigest", "commit", "tree",
    "cleanTree", "createdAt", "tools", "browserPin", "artifacts"
  ]);
  literal(candidate.schemaVersion, "1.0", "candidate.schemaVersion");
  literal(candidate.manifestKind, "candidate", "candidate.manifestKind");
  literal(candidate.releaseVersion, "1.0.0", "candidate.releaseVersion");
  digest(candidate.releaseSetDigest, "candidate.releaseSetDigest");
  if (candidate.cleanTree !== true) fail("candidate.cleanTree", "candidate must come from a clean tree");
  gitObjectId(candidate.commit, "candidate.commit");
  gitObjectId(candidate.tree, "candidate.tree");
  timestamp(candidate.createdAt, "candidate.createdAt");

  const tools = object(candidate.tools, "candidate.tools");
  exactKeys(tools, "candidate.tools", ["node", "npm", "typescript", "vitest", "playwright", "apiExtractor"]);
  const toolEntries = Object.entries(tools);
  for (const [tool, value] of toolEntries) {
    if (!TOOL.test(tool)) fail(`candidate.tools.${tool}`, "invalid tool identifier");
    const version = boundedString(value, `candidate.tools.${tool}`, 128);
    if (!/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u.test(version)) fail(`candidate.tools.${tool}`, "exact semantic tool version is required");
  }

  validateBrowserPin(candidate.browserPin);

  const artifacts = array(candidate.artifacts, "candidate.artifacts", 1, 4096);
  validateCandidateArtifacts(artifacts);
  return input as CandidateManifest;
}

function validateBrowserPin(input: unknown): void {
  const pin = object(input, "candidate.browserPin");
  exactKeys(pin, "candidate.browserPin", ["playwrightBrowserManifestSha256", "browsers"]);
  digest(pin.playwrightBrowserManifestSha256, "candidate.browserPin.playwrightBrowserManifestSha256");
  const browsers = object(pin.browsers, "candidate.browserPin.browsers");
  exactKeys(browsers, "candidate.browserPin.browsers", ["chromium", "firefox", "webkit"]);
  for (const name of ["chromium", "firefox", "webkit"] as const) {
    const browser = object(browsers[name], `candidate.browserPin.browsers.${name}`);
    exactKeys(browser, `candidate.browserPin.browsers.${name}`, ["revision", "engineVersion"]);
    const revision = boundedString(browser.revision, `candidate.browserPin.browsers.${name}.revision`, 32);
    if (!/^(?:0|[1-9][0-9]*)$/u.test(revision)) fail(`candidate.browserPin.browsers.${name}.revision`, "exact numeric browser revision is required");
    const engine = boundedString(browser.engineVersion, `candidate.browserPin.browsers.${name}.engineVersion`, 64);
    if (!/^(?:0|[1-9][0-9]*)(?:\.(?:0|[1-9][0-9A-Za-z-]*)){1,3}$/u.test(engine)) fail(`candidate.browserPin.browsers.${name}.engineVersion`, "exact browser engine version is required");
  }
}

export function validateReleaseManifest(
  input: unknown,
  expectedCandidateDigest?: string
): ReleaseManifest {
  const release = object(input, "release");
  exactKeys(release, "release", [
    "schemaVersion", "manifestKind", "releaseVersion", "candidateManifestDigest", "releaseSetDigest",
    "createdAt", "reports", "artifacts", "reviews", "previousKnownGood", "rollbackTag"
  ]);
  literal(release.schemaVersion, "1.0", "release.schemaVersion");
  literal(release.manifestKind, "release", "release.manifestKind");
  literal(release.releaseVersion, "1.0.0", "release.releaseVersion");
  const candidateDigest = digest(release.candidateManifestDigest, "release.candidateManifestDigest");
  digest(release.releaseSetDigest, "release.releaseSetDigest");
  if (expectedCandidateDigest !== undefined) {
    digest(expectedCandidateDigest, "expectedCandidateDigest");
    if (candidateDigest !== expectedCandidateDigest) fail("release.candidateManifestDigest", "candidate substitution detected");
  }
  timestamp(release.createdAt, "release.createdAt");
  const reports = array(release.reports, "release.reports", 1, 256);
  const artifacts = array(release.artifacts, "release.artifacts", 1, 256);
  validateReferences(reports, "release.reports");
  validateReferences(artifacts, "release.artifacts");

  const reviews = array(release.reviews, "release.reviews", 2, 32);
  const reviewIds = new Set<string>();
  for (const [index, value] of reviews.entries()) {
    const review = object(value, `release.reviews[${index}]`);
    exactKeys(review, `release.reviews[${index}]`, ["id", "decision", "evidenceDigest"]);
    const id = identifier(review.id, `release.reviews[${index}].id`);
    literal(review.decision, "approved", `release.reviews[${index}].decision`);
    digest(review.evidenceDigest, `release.reviews[${index}].evidenceDigest`);
    if (reviewIds.has(id)) fail(`release.reviews[${index}].id`, "duplicate reviewer");
    reviewIds.add(id);
  }
  boundedString(release.previousKnownGood, "release.previousKnownGood", 128);
  identifier(release.rollbackTag, "release.rollbackTag");
  return input as ReleaseManifest;
}

function validateCandidateArtifacts(values: readonly unknown[]): void {
  const ids = new Set<string>();
  const paths = new Set<string>();
  const roles = new Set<string>();
  const packagePaths = new Set<string>();
  const sbomPaths = new Set<string>();
  const apiPaths = new Set<string>();
  for (const [index, value] of values.entries()) {
    const path = `candidate.artifacts[${index}]`;
    const artifact = object(value, path);
    exactKeys(artifact, path, ["id", "role", "path", "sha256", "byteLength", "mediaType"]);
    const id = identifier(artifact.id, `${path}.id`);
    const artifactPath = safePath(artifact.path, `${path}.path`);
    if (ids.has(id)) fail(`${path}.id`, "duplicate ID");
    if (paths.has(artifactPath)) fail(`${path}.path`, "duplicate path");
    ids.add(id);
    paths.add(artifactPath);
    const role = boundedString(artifact.role, `${path}.role`, 128);
    if (!ALLOWED_CANDIDATE_ROLES.has(role)) fail(`${path}.role`, "unknown candidate artifact role");
    roles.add(role);
    if (role === "package") {
      if (!PACKAGE_ARTIFACT_PATHS.has(artifactPath)) fail(`${path}.path`, "unknown release package artifact path");
      packagePaths.add(artifactPath);
      if (artifact.mediaType !== "application/gzip") fail(`${path}.mediaType`, "package artifact must use application/gzip");
    }
    if (role === "sbom") sbomPaths.add(artifactPath);
    if (role === "api-report") apiPaths.add(artifactPath);
    if (role === "package-index" && artifactPath !== "package-index.json") fail(`${path}.path`, "package index path must be package-index.json");
    if (role === "package-inspection" && artifactPath !== "package-inspection.json") fail(`${path}.path`, "package inspection path must be package-inspection.json");
    if (role === "release-policy" && !artifactPath.startsWith("config/release/")) fail(`${path}.path`, "release policy path is invalid");
    if (role === "legal-review" && artifactPath !== "config/release/legal-review.json") fail(`${path}.path`, "legal review path is invalid");
    if (role === "license-report" && artifactPath !== "license-report.json") fail(`${path}.path`, "license report path is invalid");
    if (role === "candidate-layout" && artifactPath !== "candidate-layout.json") fail(`${path}.path`, "candidate layout path is invalid");
    digest(artifact.sha256, `${path}.sha256`);
    boundedInteger(artifact.byteLength, `${path}.byteLength`, 0, MAX_REFERENCE_BYTES);
    if (mediaType(artifact.mediaType, `${path}.mediaType`) !== artifact.mediaType) fail(`${path}.mediaType`, "media type must be lowercase canonical text");
  }
  if (packagePaths.size !== PACKAGE_ARTIFACT_PATHS.size) fail("candidate.artifacts", "candidate must bind the exact public-package release set");
  for (const required of REQUIRED_CANDIDATE_ROLES) if (!roles.has(required)) fail("candidate.artifacts", `candidate is missing required artifact role ${required}`);
  for (const requiredPath of ["package-index.json", "package-inspection.json", "config/release/release-policy.json", "config/release/publication-metadata.json", "config/release/legal-review.json", "license-report.json", "candidate-layout.json", "package-lock.json", "certification.html", "assets/public-entry-manifest.json"]) {
    if (!paths.has(requiredPath)) fail("candidate.artifacts", `candidate is missing required artifact path ${requiredPath}`);
  }
  for (const path of REQUIRED_SBOM_PATHS) if (!sbomPaths.has(path)) fail("candidate.artifacts", `candidate is missing required SBOM ${path}`);
  for (const path of REQUIRED_API_PATHS) if (!apiPaths.has(path)) fail("candidate.artifacts", `candidate is missing required API report ${path}`);
}

function validateReferences(values: readonly unknown[], path: string): void {
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const [index, value] of values.entries()) {
    const itemPath = `${path}[${index}]`;
    const reference = object(value, itemPath);
    exactKeys(reference, itemPath, ["id", "path", "sha256", "byteLength", "mediaType"]);
    const id = identifier(reference.id, `${itemPath}.id`);
    const referencePath = safePath(reference.path, `${itemPath}.path`);
    if (ids.has(id)) fail(`${itemPath}.id`, "duplicate report/artifact ID");
    if (paths.has(referencePath)) fail(`${itemPath}.path`, "duplicate report/artifact path");
    ids.add(id);
    paths.add(referencePath);
    digest(reference.sha256, `${itemPath}.sha256`);
    boundedInteger(reference.byteLength, `${itemPath}.byteLength`, 0, MAX_REFERENCE_BYTES);
    if (mediaType(reference.mediaType, `${itemPath}.mediaType`) !== reference.mediaType) fail(`${itemPath}.mediaType`, "media type must be lowercase canonical text");
  }
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(path, "expected object");
  return value as Record<string, unknown>;
}

function array(value: unknown, path: string, minimum: number, maximum: number): readonly unknown[] {
  if (!Array.isArray(value)) fail(path, "expected array");
  if (value.length < minimum || value.length > maximum) fail(path, `array length must be ${String(minimum)}..${String(maximum)}`);
  return value;
}

function exactKeys(value: Record<string, unknown>, path: string, allowed: readonly string[]): void {
  const names = Object.keys(value);
  const set = new Set(allowed);
  for (const name of names) if (!set.has(name)) fail(`${path}.${name}`, "unknown field");
  for (const name of allowed) if (!(name in value)) fail(`${path}.${name}`, "required field is missing");
}

function boundedString(value: unknown, path: string, maximum: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum) fail(path, `string length must be 1..${String(maximum)}`);
  return value;
}

function identifier(value: unknown, path: string): string {
  const checked = boundedString(value, path, 128);
  if (!ID.test(checked)) fail(path, "invalid identifier");
  return checked;
}

function digest(value: unknown, path: string): string {
  const checked = boundedString(value, path, 64);
  if (!SHA256_PATTERN.test(checked)) fail(path, "invalid digest");
  return checked;
}

function gitObjectId(value: unknown, path: string): string {
  const checked = boundedString(value, path, 64);
  if (!GIT_OBJECT_ID.test(checked)) fail(path, "full lowercase Git object ID is required");
  return checked;
}

function safePath(value: unknown, path: string): string {
  const checked = boundedString(value, path, 1024);
  if (checked.startsWith("/") || checked.includes("\\") || checked.includes("?") || checked.split("/").some((part) => part === "" || part === "." || part === "..")) fail(path, "unsafe path");
  return checked;
}

function mediaType(value: unknown, path: string): string {
  const checked = boundedString(value, path, 128).toLowerCase();
  if (!MEDIA_TYPE.test(checked)) fail(path, "invalid media type");
  return checked;
}

function boundedInteger(value: unknown, path: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) fail(path, `integer must be ${String(minimum)}..${String(maximum)}`);
  return value as number;
}

function timestamp(value: unknown, path: string): string {
  const checked = boundedString(value, path, 32);
  const milliseconds = Date.parse(checked);
  if (!ISO_UTC.test(checked) || !Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== checked) fail(path, "expected canonical real UTC timestamp");
  return checked;
}

function literal<T extends string>(value: unknown, expected: T, path: string): asserts value is T {
  if (value !== expected) fail(path, `expected ${expected}`);
}

function fail(path: string, message: string): never {
  throw new CertificationValidationError(path, message);
}
