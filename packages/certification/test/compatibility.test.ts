import { describe, expect, it } from "vitest";
import { PUBLIC_RELEASE_PACKAGE_CONTRACTS, PUBLIC_RELEASE_PACKAGES, validateApiClassifications, validateSynchronizedReleaseSet, type ReleasePackageManifest } from "../src/compatibility.js";
import { FORMAT_VERSION_MAJOR, FORMAT_VERSION_MINOR } from "../../format/src/index.js";
import { COMPILER_PROJECT_VERSION } from "../../compiler/src/index.js";

describe("compatibility policy", () => {
  it("keeps package, wire, and project version spaces independent", () => {
    expect([FORMAT_VERSION_MAJOR, FORMAT_VERSION_MINOR]).toEqual([1, 1]);
    expect(COMPILER_PROJECT_VERSION).toBe("1.0");
  });
  it("requires synchronized public ESM packages and exact internal dependencies", () => {
    const manifests: ReleasePackageManifest[] = PUBLIC_RELEASE_PACKAGES.map(packageManifest);
    expect(validateSynchronizedReleaseSet(manifests)).toEqual([]);
    expect(validateSynchronizedReleaseSet(manifests.map((manifest) => manifest.name === "@pixel-point/aval-format" ? { ...manifest, version: "1.0.1" } : manifest))).toContain("@pixel-point/aval-format: version must be 1.0.0");
    expect(validateSynchronizedReleaseSet(manifests.map((manifest) => manifest.name === "@pixel-point/aval-graph" ? { ...manifest, dependencies: { "@pixel-point/aval-unknown": "1.0.0" } } : manifest))).toContain("@pixel-point/aval-graph: internal dependencies must be exactly none");
    expect(validateSynchronizedReleaseSet(manifests.map((manifest) => manifest.name === "@pixel-point/aval-react" ? { ...manifest, peerDependencies: { react: "^19.0.0" } } : manifest))).toContain("@pixel-point/aval-react: peer dependencies must match the reviewed public contract");
    expect(validateSynchronizedReleaseSet([...manifests, manifests[0]!])).toEqual(expect.arrayContaining([expect.stringMatching(/exactly 6/u), "@pixel-point/aval-graph: duplicate manifest"]));
  });

  it("keeps every package-specific publication field exact and immutable", () => {
    expect(Object.isFrozen(PUBLIC_RELEASE_PACKAGE_CONTRACTS)).toBe(true);
    for (const contract of Object.values(PUBLIC_RELEASE_PACKAGE_CONTRACTS)) expect(Object.isFrozen(contract)).toBe(true);
    const manifests = PUBLIC_RELEASE_PACKAGES.map(packageManifest);
    expect(validateSynchronizedReleaseSet(manifests.map((manifest) => manifest.name === "@pixel-point/aval-element" ? { ...manifest, exports: { ".": { import: "./dist/index.js", types: "./dist/index.d.ts" } } } : manifest))).toContain("@pixel-point/aval-element: exports must match the reviewed public contract");
    expect(validateSynchronizedReleaseSet(manifests.map((manifest) => manifest.name === "@pixel-point/aval-compiler" ? withoutBin(manifest) : manifest))).toContain("@pixel-point/aval-compiler: bin must match the reviewed public contract");
  });

  it("rejects unclassified exports when no reviewed package default exists", () => {
    expect(validateApiClassifications(["Player", "PlayerOptions"], { Player: "stable" })).toEqual(["PlayerOptions: missing API classification"]);
    expect(validateApiClassifications(["Player"], {}, "stable")).toEqual([]);
  });
});

function packageManifest(name: (typeof PUBLIC_RELEASE_PACKAGES)[number]): ReleasePackageManifest {
  const contract = PUBLIC_RELEASE_PACKAGE_CONTRACTS[name];
  return {
    name,
    version: "1.0.0",
    private: false,
    type: "module",
    exports: contract.exports,
    files: ["dist", "README.md", "LICENSE", "THIRD_PARTY_NOTICES.md"],
    license: "MIT",
    sideEffects: contract.sideEffects,
    engines: { node: ">=22.12.0" },
    dependencies: Object.fromEntries(contract.dependencies.map((dependency) => [dependency, "1.0.0"])),
    ...(contract.peerDependencies === undefined ? {} : { peerDependencies: contract.peerDependencies }),
    ...(contract.bin === undefined ? {} : { bin: contract.bin })
  };
}

function withoutBin(manifest: ReleasePackageManifest): ReleasePackageManifest {
  const { bin: _bin, ...rest } = manifest;
  return rest;
}
