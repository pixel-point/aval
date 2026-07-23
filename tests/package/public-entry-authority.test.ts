import { describe, expect, it } from "vitest";

import { PRODUCTION_PUBLIC_ENTRY_IDENTITIES, reconcileProductionPublicEntryManifest } from "../../scripts/release/public-entry-authority.mjs";
import { PRODUCTION_PUBLIC_ENTRIES, RELEASE_PACKAGE_SPECS } from "../../scripts/release/release-set-model.mjs";

const entries = PRODUCTION_PUBLIC_ENTRY_IDENTITIES.map((identity, index) => ({ ...identity, byteLength: index + 100, sha256: (index + 1).toString(16).repeat(64) }));
const inspection = {
  packages: RELEASE_PACKAGE_SPECS.map(({ name }) => ({
    name,
    fileRecords: entries.filter((entry) => entry.package === name).map(({ path, byteLength, sha256 }) => ({ path, byteLength, sha256, mode: 0o644 }))
  }))
};
const manifest = { schemaVersion: "1.0", manifestKind: "production-public-entry-identity", entries };

describe("production public-entry candidate authority", () => {
  it("binds the exact ordered public exports to inspected archive file bytes", () => {
    expect(PRODUCTION_PUBLIC_ENTRY_IDENTITIES).toEqual(PRODUCTION_PUBLIC_ENTRIES.map(({ package: packageName, export: exportName, path }) => ({ package: packageName, export: exportName, path })));
    expect(PRODUCTION_PUBLIC_ENTRIES.some(({ package: packageName }) => packageName === "@pixel-point/aval-compiler")).toBe(false);
    expect(reconcileProductionPublicEntryManifest(manifest, inspection)).toBe(manifest);
  });

  it("rejects entry reordering, source paths, digest substitution, and missing archive records", () => {
    expect(() => reconcileProductionPublicEntryManifest({ ...manifest, entries: [entries[1], entries[0], ...entries.slice(2)] }, inspection)).toThrow(/entry 0/u);
    expect(() => reconcileProductionPublicEntryManifest({ ...manifest, entries: [{ ...entries[0], path: "src/index.ts" }, ...entries.slice(1)] }, inspection)).toThrow(/entry 0/u);
    expect(() => reconcileProductionPublicEntryManifest({ ...manifest, entries: [{ ...entries[0], sha256: "f".repeat(64) }, ...entries.slice(1)] }, inspection)).toThrow(/tarball bytes/u);
    expect(() => reconcileProductionPublicEntryManifest(manifest, { packages: inspection.packages.map((value, index) => index === 0 ? { ...value, fileRecords: [] } : value) })).toThrow(/tarball bytes/u);
  });
});
