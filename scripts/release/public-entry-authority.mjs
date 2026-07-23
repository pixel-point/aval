import { PRODUCTION_PUBLIC_ENTRIES, RELEASE_PACKAGE_NAMES } from "./release-set-model.mjs";

const EXPECTED = Object.freeze(PRODUCTION_PUBLIC_ENTRIES.map((entry) => Object.freeze({
  package: entry.package,
  export: entry.export,
  path: entry.path
})));

export function reconcileProductionPublicEntryManifest(input, packageInspection) {
  if (input === null || typeof input !== "object" || Array.isArray(input) || Object.keys(input).sort().join(",") !== "entries,manifestKind,schemaVersion" || input.schemaVersion !== "1.0" || input.manifestKind !== "production-public-entry-identity" || !Array.isArray(input.entries) || input.entries.length !== EXPECTED.length) throw new Error("production public-entry manifest identity is invalid");
  if (packageInspection === null || typeof packageInspection !== "object" || !Array.isArray(packageInspection.packages) || packageInspection.packages.length !== RELEASE_PACKAGE_NAMES.length) throw new Error("package inspection cannot authorize production public entries");
  const packages = new Map(packageInspection.packages.map((entry) => [entry?.name, entry]));
  if (packages.size !== RELEASE_PACKAGE_NAMES.length || RELEASE_PACKAGE_NAMES.some((name) => !packages.has(name))) throw new Error("package inspection contains duplicate or unknown public package identities");
  for (const [index, entry] of input.entries.entries()) {
    const expected = EXPECTED[index];
    if (entry === null || typeof entry !== "object" || Array.isArray(entry) || Object.keys(entry).sort().join(",") !== "byteLength,export,package,path,sha256" || expected === undefined || entry.package !== expected.package || entry.export !== expected.export || entry.path !== expected.path || !Number.isSafeInteger(entry.byteLength) || entry.byteLength < 1 || entry.byteLength > 8 * 1024 * 1024 || typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(entry.sha256)) throw new Error(`production public-entry manifest entry ${String(index)} is invalid`);
    const inspected = packages.get(entry.package);
    if (inspected === undefined || !Array.isArray(inspected.fileRecords)) throw new Error(`package inspection lacks file records for ${entry.package}`);
    const matches = inspected.fileRecords.filter((record) => record?.path === entry.path);
    if (matches.length !== 1 || matches[0].byteLength !== entry.byteLength || matches[0].sha256 !== entry.sha256) throw new Error(`production public entry does not match inspected tarball bytes: ${entry.package} ${entry.export}`);
  }
  return input;
}

export const PRODUCTION_PUBLIC_ENTRY_IDENTITIES = EXPECTED;
