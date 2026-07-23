import { createHash } from "node:crypto";

import { releasePackageDirectory } from "../release/release-set-model.mjs";

const SPDX_ID = /^SPDXRef-[A-Za-z0-9.-]{1,200}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const SHA512 = /^[0-9a-f]{128}$/u;

export function validateSpdxDocument(input, { maximumPackages = 4096, maximumFiles = 16384, maximumRelationships = 65536 } = {}) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new TypeError("SPDX document must be an object");
  const required = ["spdxVersion", "dataLicense", "SPDXID", "name", "documentNamespace", "creationInfo", "packages", "files", "relationships"];
  if (Object.keys(input).sort().join(",") !== [...required].sort().join(",")) throw new Error("SPDX document fields are invalid");
  if (input.spdxVersion !== "SPDX-2.3" || input.dataLicense !== "CC0-1.0" || input.SPDXID !== "SPDXRef-DOCUMENT") throw new Error("SPDX 2.3 identity is invalid");
  if (typeof input.name !== "string" || input.name.length < 1 || input.name.length > 256) throw new Error("SPDX document name is invalid");
  exactPublicNamespace(input.documentNamespace);
  if (input.creationInfo === null || typeof input.creationInfo !== "object" || Array.isArray(input.creationInfo) || Object.keys(input.creationInfo).sort().join(",") !== "created,creators" || typeof input.creationInfo.created !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(input.creationInfo.created) || Number.isNaN(Date.parse(input.creationInfo.created)) || !Array.isArray(input.creationInfo.creators) || input.creationInfo.creators.length !== 1 || !/^Tool: aval-(?:workspace|package)-sbom-v1$/u.test(input.creationInfo.creators[0])) throw new Error("SPDX creationInfo is invalid");
  if (!Array.isArray(input.packages) || input.packages.length < 1 || input.packages.length > maximumPackages) throw new Error("SPDX package count is invalid");
  if (!Array.isArray(input.files) || input.files.length > maximumFiles) throw new Error("SPDX file count is invalid");
  if (!Array.isArray(input.relationships) || input.relationships.length < 1 || input.relationships.length > maximumRelationships) throw new Error("SPDX relationship count is invalid");
  const ids = new Set(["SPDXRef-DOCUMENT"]);
  const fileNames = new Set();
  for (const item of [...input.packages, ...input.files]) {
    if (item === null || typeof item !== "object" || Array.isArray(item) || !SPDX_ID.test(item.SPDXID) || ids.has(item.SPDXID)) throw new Error("SPDX element ID is invalid or duplicated");
    ids.add(item.SPDXID);
    validateChecksums(item.checksums ?? []);
  }
  for (const pkg of input.packages) {
    const keys = ["SPDXID", "name", "versionInfo", "downloadLocation", "filesAnalyzed", "licenseConcluded", "licenseDeclared", "checksums"];
    if (Object.keys(pkg).sort().join(",") !== [...keys].sort().join(",")) throw new Error("SPDX package fields are invalid");
    if (typeof pkg.name !== "string" || pkg.name.length < 1 || pkg.name.length > 256 || typeof pkg.versionInfo !== "string" || pkg.versionInfo.length < 1 || pkg.versionInfo.length > 128 || pkg.downloadLocation !== "NOASSERTION" || typeof pkg.filesAnalyzed !== "boolean" || typeof pkg.licenseConcluded !== "string" || pkg.licenseConcluded.length > 128 || typeof pkg.licenseDeclared !== "string" || pkg.licenseDeclared.length > 128) throw new Error("SPDX package identity is incomplete");
  }
  for (const file of input.files) {
    const keys = ["SPDXID", "fileName", "checksums", "licenseInfoInFiles"];
    if (Object.keys(file).sort().join(",") !== [...keys].sort().join(",") || typeof file.fileName !== "string" || file.fileName.length > 1024 || !file.fileName.startsWith("./") || file.fileName.includes("..") || fileNames.has(file.fileName) || JSON.stringify(file.licenseInfoInFiles) !== JSON.stringify(["NOASSERTION"])) throw new Error("SPDX file identity is invalid or duplicated");
    fileNames.add(file.fileName);
  }
  for (const relationship of input.relationships) {
    if (relationship === null || typeof relationship !== "object" || Array.isArray(relationship) || Object.keys(relationship).sort().join(",") !== "relatedSpdxElement,relationshipType,spdxElementId" || !ids.has(relationship.spdxElementId) || !ids.has(relationship.relatedSpdxElement) || !new Set(["DESCRIBES", "DEPENDS_ON", "CONTAINS"]).has(relationship.relationshipType)) throw new Error("SPDX relationship is invalid");
  }
  return input;
}

export function reconcilePackageSbom(document, archive) {
  validateSpdxDocument(document);
  const main = document.packages.find(({ SPDXID }) => SPDXID === "SPDXRef-Package");
  if (main === undefined || main.name !== archive.name || main.versionInfo !== archive.version || main.licenseDeclared !== archive.manifest.license || main.filesAnalyzed !== true) throw new Error(`${archive.name} SBOM package identity mismatch`);
  const checksums = checksumMap(main.checksums);
  if (checksums.get("SHA256") !== archive.tarballSha256 || checksums.get("SHA512") !== Buffer.from(archive.registryIntegrity.slice("sha512-".length), "base64").toString("hex")) throw new Error(`${archive.name} SBOM archive checksum mismatch`);
  const expectedFiles = new Map(archive.fileRecords.map((file) => [`./${file.path}`, file]));
  if (document.files.length !== expectedFiles.size) throw new Error(`${archive.name} SBOM file count mismatch`);
  for (const file of document.files) {
    const expected = expectedFiles.get(file.fileName);
    if (expected === undefined || file.checksums.length !== 1 || checksumMap(file.checksums).get("SHA256") !== expected.sha256) throw new Error(`${archive.name} SBOM file digest mismatch: ${file.fileName}`);
  }
  const expectedDependencies = Object.entries(archive.manifest.dependencies ?? {}).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  const dependencyPackages = document.packages.filter(({ SPDXID }) => SPDXID !== "SPDXRef-Package").sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  if (dependencyPackages.length !== expectedDependencies.length) throw new Error(`${archive.name} SBOM dependency count mismatch`);
  for (const [index, [name, version]] of expectedDependencies.entries()) {
    const dependency = dependencyPackages[index];
    if (dependency?.name !== name || dependency.versionInfo !== version || dependency.filesAnalyzed !== false || dependency.licenseDeclared !== "NOASSERTION" || dependency.licenseConcluded !== "NOASSERTION" || dependency.downloadLocation !== "NOASSERTION" || dependency.checksums.length !== 0) throw new Error(`${archive.name} SBOM dependency edge mismatch`);
  }
  const expectedRelationships = [
    relationship("SPDXRef-DOCUMENT", "DESCRIBES", "SPDXRef-Package"),
    ...dependencyPackages.map(({ SPDXID }) => relationship("SPDXRef-Package", "DEPENDS_ON", SPDXID)),
    ...document.files.map(({ SPDXID }) => relationship("SPDXRef-Package", "CONTAINS", SPDXID))
  ];
  if (!sameRelationships(document.relationships, expectedRelationships)) throw new Error(`${archive.name} SBOM relationship coverage mismatch`);
}

export function reconcileReleaseSbomSet({ documentsByPath, releaseSet, workspaceLockBytes }) {
  const expectedPaths = new Set(["sbom/workspace.spdx.json", ...releaseSet.packages.map(({ name }) => `sbom/${releasePackageDirectory(name)}.spdx.json`)]);
  if (documentsByPath.size !== expectedPaths.size || [...documentsByPath.keys()].some((path) => !expectedPaths.has(path))) throw new Error("candidate SBOM set is not exactly workspace plus the public packages");
  for (const archive of releaseSet.packages) reconcilePackageSbom(documentsByPath.get(`sbom/${releasePackageDirectory(archive.name)}.spdx.json`), archive);
  reconcileWorkspaceSbom(documentsByPath.get("sbom/workspace.spdx.json"), workspaceLockBytes);
}

export function reconcileWorkspaceSbom(document, lockBytes) {
  validateSpdxDocument(document);
  const lock = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(lockBytes));
  const expected = workspacePackageRecords(lock);
  if (!document.documentNamespace.endsWith(createHash("sha256").update(lockBytes).digest("hex"))) throw new Error("workspace SBOM lockfile digest mismatch");
  if (document.packages.length !== expected.length) throw new Error("workspace SBOM package count mismatch");
  for (const [index, record] of expected.entries()) {
    const actual = document.packages[index];
    if (actual?.name !== record.name || actual.versionInfo !== record.version || actual.licenseDeclared !== record.license) throw new Error(`workspace SBOM package mismatch at ${record.path}`);
  }
  const expectedRelationships = document.packages.map(({ SPDXID }) => relationship("SPDXRef-DOCUMENT", "DESCRIBES", SPDXID));
  if (!sameRelationships(document.relationships, expectedRelationships) || document.files.length !== 0) throw new Error("workspace SBOM relationship coverage mismatch");
}

export function workspacePackageRecords(lock) {
  return Object.entries(lock.packages ?? {}).filter(([, entry]) => !entry.link).map(([path, entry]) => ({
    path,
    name: entry.name ?? (path === "" ? lock.name : path.split("node_modules/").at(-1) ?? path),
    version: entry.version,
    license: entry.license ?? "NOASSERTION",
    integrity: entry.integrity ?? null
  })).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

function validateChecksums(values) {
  if (!Array.isArray(values) || values.length > 4) throw new Error("SPDX checksums are invalid");
  const algorithms = new Set();
  for (const value of values) {
    if (value === null || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== "algorithm,checksumValue" || !new Set(["SHA256", "SHA512"]).has(value.algorithm) || algorithms.has(value.algorithm)) throw new Error("SPDX checksum entry is invalid");
    if ((value.algorithm === "SHA256" && !SHA256.test(value.checksumValue)) || (value.algorithm === "SHA512" && !SHA512.test(value.checksumValue))) throw new Error("SPDX checksum value is invalid");
    algorithms.add(value.algorithm);
  }
}
function checksumMap(values) { return new Map(values.map(({ algorithm, checksumValue }) => [algorithm, checksumValue])); }
function relationship(spdxElementId, relationshipType, relatedSpdxElement) { return { spdxElementId, relationshipType, relatedSpdxElement }; }
function sameRelationships(left, right) { const normalize = (values) => values.map((value) => `${value.spdxElementId}\0${value.relationshipType}\0${value.relatedSpdxElement}`).sort(); return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right)); }
function exactPublicNamespace(value) { if (typeof value !== "string" || value.length > 1024) throw new Error("SPDX document namespace is invalid"); const url = new URL(value); if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "" || url.href !== value) throw new Error("SPDX namespace must be canonical public HTTPS"); }
