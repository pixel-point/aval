import { isIP } from "node:net";

import { RELEASE_PACKAGE_NAMES, releasePackageDirectory } from "./release-set-model.mjs";

const KEYS = Object.freeze([
  "schemaVersion", "releaseVersion", "status", "reviewId", "reviewerRole",
  "reviewedAt", "repositoryUrl", "homepageUrl", "bugsUrl",
  "registryScopeAuthority", "note"
]);
const REVIEW_ID = /^[a-z0-9][a-z0-9._-]{7,127}$/u;
const ACCOUNT = /^[a-z0-9][a-z0-9-]{0,62}$/u;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export function validateApprovedPublicationMetadata(input) {
  const metadata = validatePublicationMetadataShape(input);
  if (metadata.status !== "approved") throw new Error("approved publication metadata authority is required before public packaging");
  if (typeof metadata.reviewId !== "string" || !REVIEW_ID.test(metadata.reviewId)) throw new Error("publication metadata reviewId is invalid");
  if (metadata.reviewerRole !== "qualified-publication-metadata-reviewer") throw new Error("publication metadata reviewerRole is invalid");
  if (typeof metadata.reviewedAt !== "string" || !TIMESTAMP.test(metadata.reviewedAt) || !isCanonicalTimestamp(metadata.reviewedAt)) throw new Error("publication metadata reviewedAt is invalid");
  exactPublicUrl(metadata.repositoryUrl, "repository URL");
  exactPublicUrl(metadata.homepageUrl, "homepage URL");
  exactPublicUrl(metadata.bugsUrl, "bugs URL");
  const authority = metadata.registryScopeAuthority;
  if (authority === null || typeof authority !== "object" || Array.isArray(authority) || Object.keys(authority).sort().join(",") !== "evidenceId,owner,registryUrl,scope") throw new Error("publication registry-scope authority is invalid");
  if (authority.scope !== "@pixel-point" || authority.registryUrl !== "https://registry.npmjs.org/" || typeof authority.owner !== "string" || !ACCOUNT.test(authority.owner) || typeof authority.evidenceId !== "string" || !REVIEW_ID.test(authority.evidenceId)) throw new Error("publication registry-scope authority is incomplete");
  if (typeof metadata.note !== "string" || metadata.note.length < 1 || metadata.note.length > 2048 || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(metadata.note)) throw new Error("publication metadata note is invalid");
  return metadata;
}

function isCanonicalTimestamp(value) {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

export function validatePublicationMetadataShape(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input) || Object.keys(input).sort().join(",") !== [...KEYS].sort().join(",")) throw new Error("publication metadata fields are invalid");
  if (input.schemaVersion !== "1.0" || input.releaseVersion !== "1.0.0" || (input.status !== "pending" && input.status !== "approved")) throw new Error("publication metadata identity is invalid");
  return input;
}

export function applyApprovedPublicationMetadata(source, input) {
  const metadata = validateApprovedPublicationMetadata(input);
  if (source === null || typeof source !== "object" || Array.isArray(source) || typeof source.name !== "string" || !RELEASE_PACKAGE_NAMES.includes(source.name)) throw new Error("publication metadata package source is invalid");
  const directory = releasePackageDirectory(source.name);
  return {
    ...source,
    repository: { type: "git", url: metadata.repositoryUrl, directory: `packages/${directory}` },
    homepage: metadata.homepageUrl,
    bugs: { url: metadata.bugsUrl }
  };
}

export function reconcilePublicationMetadata(manifests, input) {
  const metadata = validateApprovedPublicationMetadata(input);
  if (!Array.isArray(manifests) || manifests.length !== RELEASE_PACKAGE_NAMES.length) throw new Error("publication metadata requires the exact public package manifests");
  for (const manifest of manifests) {
    const expected = applyApprovedPublicationMetadata({ name: manifest.name }, metadata);
    if (JSON.stringify(manifest.repository) !== JSON.stringify(expected.repository) || manifest.homepage !== expected.homepage || JSON.stringify(manifest.bugs) !== JSON.stringify(expected.bugs)) throw new Error(`package publication metadata does not match reviewed authority: ${String(manifest.name)}`);
  }
  return metadata;
}

function exactPublicUrl(value, label) {
  if (typeof value !== "string" || value.length < 12 || value.length > 512) throw new Error(`publication ${label} is invalid`);
  const url = new URL(value);
  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "" || url.href !== value || url.pathname === "/" || isIP(hostname) !== 0 || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".test") || hostname.endsWith(".invalid") || hostname.endsWith(".example")) throw new Error(`publication ${label} must be canonical public HTTPS`);
  return value;
}
