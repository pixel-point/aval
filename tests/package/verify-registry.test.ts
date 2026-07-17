import { describe, expect, it, vi } from "vitest";

import { verifyRegistryReleaseSet } from "../../scripts/release/verify-registry.mjs";
import { RELEASE_PACKAGE_NAMES } from "../../scripts/release/release-set.mjs";

const integrity = `sha512-${Buffer.alloc(64, 4).toString("base64")}`;
const names = [...RELEASE_PACKAGE_NAMES];
const releaseSet = { packages: names.map((name) => ({ name, registryIntegrity: integrity })) };

describe("exact registry release verification", () => {
  it("requires all five exact integrities and the requested tag", () => {
    const readState = vi.fn((name: string) => ({ name, version: "1.0.0", integrity, tags: { next: "1.0.0" } }));
    expect(verifyRegistryReleaseSet({ releaseSet, tag: "next", readState })).toHaveLength(5);
    expect(readState).toHaveBeenCalledTimes(5);
    expect(() => verifyRegistryReleaseSet({ releaseSet: { packages: [] }, tag: "next", readState })).toThrow(/exact five/u);
    expect(() => verifyRegistryReleaseSet({ releaseSet: { packages: [releaseSet.packages[1]!, releaseSet.packages[0]!, ...releaseSet.packages.slice(2)] }, tag: "next", readState })).toThrow(/identity\/order/u);
    expect(() => verifyRegistryReleaseSet({ releaseSet, tag: "latest", readState })).toThrow(/latest tag mismatch/u);
  });

  it("fails closed on one substituted immutable version", () => {
    const readState = (name: string) => ({ name, version: "1.0.0", integrity: name.endsWith("element") ? "sha512-substituted" : integrity, tags: { next: "1.0.0" } });
    expect(() => verifyRegistryReleaseSet({ releaseSet, tag: "next", readState })).toThrow(/integrity mismatch/u);
  });
});
