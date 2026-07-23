import { constants as fsConstants } from "node:fs";
import { createHash } from "node:crypto";
import { open, readdir, realpath } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";

import { inspectTarballBytes } from "./inspect-tarball.mjs";
import { validatePublishManifest } from "./publish-manifest.mjs";
import { PRODUCTION_PUBLIC_ENTRIES, RELEASE_PACKAGE_NAMES, RELEASE_PACKAGE_SPECS, RELEASE_VERSION, releaseArchiveFilename, releasePackageDirectory, releasePackageSpecification, topologicalPackageOrder } from "./release-set-model.mjs";

export { PRODUCTION_PUBLIC_ENTRIES, RELEASE_PACKAGE_NAMES, RELEASE_PACKAGE_SPECS, RELEASE_VERSION, releaseArchiveFilename, releasePackageDirectory, releasePackageSpecification, topologicalPackageOrder };

export function validateReleasePolicy(policy) {
  if (policy === null || typeof policy !== "object") throw new TypeError("release policy is invalid");
  if (policy.releaseVersion !== RELEASE_VERSION) throw new Error(`release policy version must be ${RELEASE_VERSION}`);
  if (!Array.isArray(policy.publicPackages) || !sameArray(policy.publicPackages, RELEASE_PACKAGE_NAMES)) {
    throw new Error(`release policy package order must be the derived topological order: ${RELEASE_PACKAGE_NAMES.join(" -> ")}`);
  }
  return policy;
}

export function validateReleasePackageManifests(manifests) {
  if (!Array.isArray(manifests) || manifests.length !== RELEASE_PACKAGE_NAMES.length) throw new Error(`release set must contain exactly ${String(RELEASE_PACKAGE_NAMES.length)} package manifests`);
  const byName = new Map();
  for (const manifest of manifests) {
    if (manifest === null || typeof manifest !== "object" || typeof manifest.name !== "string") throw new TypeError("release package manifest is invalid");
    if (byName.has(manifest.name)) throw new Error(`duplicate release package manifest: ${manifest.name}`);
    byName.set(manifest.name, manifest);
    validatePublishManifest(manifest);
  }
  for (const specification of RELEASE_PACKAGE_SPECS) {
    const manifest = byName.get(specification.name);
    if (manifest === undefined) throw new Error(`release set is missing ${specification.name}`);
    if (manifest.version !== RELEASE_VERSION || manifest.private !== false) throw new Error(`${specification.name} is not an exact publishable ${RELEASE_VERSION} package`);
    const internal = Object.entries(manifest.dependencies ?? {});
    const expected = [...specification.dependencies].sort(compareText);
    const actual = internal.map(([name]) => name).sort(compareText);
    if (!sameArray(actual, expected)) throw new Error(`${specification.name} internal dependency graph drifted: expected ${expected.join(", ") || "none"}; received ${actual.join(", ") || "none"}`);
    for (const [name, version] of internal) if (version !== RELEASE_VERSION) throw new Error(`${specification.name} internal dependency ${name} must be exactly ${RELEASE_VERSION}`);
  }
  for (const name of byName.keys()) if (!RELEASE_PACKAGE_NAMES.includes(name)) throw new Error(`release set contains an unknown package: ${name}`);
  return RELEASE_PACKAGE_NAMES.map((name) => byName.get(name));
}

/** Open every archive without following links, read it once, and reconcile the exact public-package DAG. */
export async function loadVerifiedReleaseSet({ directory, policy, packageIndex } = {}) {
  validateReleasePolicy(policy);
  const root = await realpath(resolve(directory));
  const directoryEntries = await readdir(root, { withFileTypes: true });
  if (directoryEntries.some((entry) => !entry.isFile() || !entry.name.endsWith(".tgz"))) throw new Error("release package directory contains a non-tarball entry");
  if (directoryEntries.length !== RELEASE_PACKAGE_NAMES.length) throw new Error(`release package directory must contain exactly ${String(RELEASE_PACKAGE_NAMES.length)} tarballs`);
  const packages = [];
  for (const entry of directoryEntries.sort((left, right) => compareText(left.name, right.name))) {
    const path = join(root, entry.name);
    const bytes = await readExactRegularFile(path, root);
    const inspected = inspectTarballBytes(bytes, { label: entry.name });
    const expectedFilename = releaseArchiveFilename(inspected.name);
    if (entry.name !== expectedFilename) throw new Error(`${inspected.name} archive filename must be ${expectedFilename}`);
    packages.push(Object.freeze({ ...inspected, filename: entry.name, path, bytes }));
  }
  const orderedManifests = validateReleasePackageManifests(packages.map(({ manifest }) => manifest));
  const byName = new Map(packages.map((entry) => [entry.name, entry]));
  const ordered = RELEASE_PACKAGE_NAMES.map((name) => byName.get(name));
  if (packageIndex !== undefined) reconcilePackageIndex(packageIndex, ordered);
  const releaseSetDigest = computeReleaseSetDigest(ordered);
  return Object.freeze({
    schemaVersion: "1.0",
    releaseVersion: RELEASE_VERSION,
    order: RELEASE_PACKAGE_NAMES,
    packages: Object.freeze(ordered),
    manifests: Object.freeze(orderedManifests),
    releaseSetDigest
  });
}

export function computeReleaseSetDigest(packages) {
  return createHash("sha256").update(Buffer.from(`${JSON.stringify({
    schemaVersion: "1.0",
    releaseVersion: RELEASE_VERSION,
    packages: packages.map((entry) => ({
      name: entry.name,
      version: entry.version,
      filename: entry.filename,
      byteLength: entry.byteLength,
      sha256: entry.tarballSha256,
      registryIntegrity: entry.registryIntegrity,
      fileListSha256: entry.fileListSha256,
      dependencies: [...RELEASE_PACKAGE_SPECS.find(({ name }) => name === entry.name).dependencies]
    }))
  })}\n`)).digest("hex");
}

export function reconcilePackageIndex(input, packages) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new TypeError("package index is invalid");
  if (input.schemaVersion !== "1.0" || input.releaseVersion !== RELEASE_VERSION || !Array.isArray(input.packages)) throw new Error("package index identity is invalid");
  const expectedReleaseSetDigest = computeReleaseSetDigest(packages);
  if (input.releaseSetDigest !== expectedReleaseSetDigest) throw new Error("package index release-set digest does not match archive bytes");
  if (input.packages.length !== RELEASE_PACKAGE_NAMES.length) throw new Error("package index does not contain the exact release set");
  const byName = new Map();
  for (const item of input.packages) {
    if (item === null || typeof item !== "object" || typeof item.name !== "string") throw new TypeError("package index entry is invalid");
    if (byName.has(item.name)) throw new Error(`package index duplicates ${item.name}`);
    byName.set(item.name, item);
  }
  for (const actual of packages) {
    const expected = byName.get(actual.name);
    if (expected === undefined) throw new Error(`package index is missing ${actual.name}`);
    const fields = {
      version: actual.version,
      filename: actual.filename,
      byteLength: actual.byteLength,
      unpackedSize: actual.unpackedSize,
      sha256: actual.tarballSha256,
      registryIntegrity: actual.registryIntegrity,
      fileListSha256: actual.fileListSha256
    };
    for (const [field, value] of Object.entries(fields)) if (expected[field] !== value) throw new Error(`package index ${actual.name} ${field} does not match archive bytes`);
    if (!sameArray(expected.files, actual.files)) throw new Error(`package index ${actual.name} file list does not match archive bytes`);
    if (JSON.stringify(expected.fileRecords) !== JSON.stringify(actual.fileRecords)) throw new Error(`package index ${actual.name} file records do not match archive bytes`);
    if (JSON.stringify(expected.entryPoints) !== JSON.stringify(actual.manifest.exports)) throw new Error(`package index ${actual.name} exports do not match archive package.json`);
    if (JSON.stringify(expected.bin) !== JSON.stringify(actual.manifest.bin)) throw new Error(`package index ${actual.name} bin does not match archive package.json`);
  }
  for (const name of byName.keys()) if (!RELEASE_PACKAGE_NAMES.includes(name)) throw new Error(`package index contains unknown package ${name}`);
}

export function reconcilePackageInspection(input, releaseSet) {
  if (input === null || typeof input !== "object" || Array.isArray(input) || input.status !== "passed") throw new Error("package inspection did not pass");
  if (input.releaseSetDigest !== releaseSet.releaseSetDigest) throw new Error("package inspection release-set digest does not match archive bytes");
  reconcilePackageIndex(input, releaseSet.packages);
}

export function releaseSetSummary(releaseSet) {
  return Object.freeze({
    schemaVersion: "1.0",
    releaseVersion: RELEASE_VERSION,
    releaseSetDigest: releaseSet.releaseSetDigest,
    packages: Object.freeze(releaseSet.packages.map((entry) => Object.freeze({
      name: entry.name,
      version: entry.version,
      filename: entry.filename,
      byteLength: entry.byteLength,
      unpackedSize: entry.unpackedSize,
      sha256: entry.tarballSha256,
      registryIntegrity: entry.registryIntegrity,
      fileListSha256: entry.fileListSha256,
      entryPoints: entry.manifest.exports,
      ...(entry.manifest.bin === undefined ? {} : { bin: entry.manifest.bin }),
      files: entry.files,
      fileRecords: entry.fileRecords
    })))
  });
}

async function readExactRegularFile(path, root) {
  const canonical = await realpath(path);
  const within = relative(root, canonical);
  if (within === ".." || within.startsWith(`..${sep}`)) throw new Error(`release archive escapes package root: ${basename(path)}`);
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const handle = await open(path, fsConstants.O_RDONLY | noFollow);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size < 1 || before.size > 64 * 1024 * 1024) throw new Error(`release archive is not a bounded regular file: ${basename(path)}`);
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || bytes.byteLength !== before.size) throw new Error(`release archive changed while being read: ${basename(path)}`);
    return bytes;
  } finally {
    await handle.close();
  }
}

function sameArray(left, right) {
  return Array.isArray(left) && left.length === right.length && left.every((value, index) => value === right[index]);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
