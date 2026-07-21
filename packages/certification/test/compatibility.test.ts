import { describe, expect, it } from "vitest";
import { PUBLIC_RELEASE_DEPENDENCIES, PUBLIC_RELEASE_PACKAGES, validateApiClassifications, validateSynchronizedReleaseSet } from "../src/compatibility.js";
import { FORMAT_VERSION_MAJOR, FORMAT_VERSION_MINOR } from "../../format/src/index.js";
import { COMPILER_PROJECT_VERSION } from "../../compiler/src/index.js";

describe("compatibility policy", () => {
  it("keeps package, wire, and project version spaces independent", () => {
    expect([FORMAT_VERSION_MAJOR, FORMAT_VERSION_MINOR]).toEqual([1, 1]);
    expect(COMPILER_PROJECT_VERSION).toBe("1.0");
  });
  it("requires synchronized public ESM packages and exact internal dependencies", () => {
    const manifests = PUBLIC_RELEASE_PACKAGES.map((name) => ({
      name,
      version: "1.0.0",
      private: false,
      type: "module",
      exports: { ".": "./dist/index.js" },
      files: ["dist", "README.md", "LICENSE", "THIRD_PARTY_NOTICES.md"],
      license: "MIT",
      sideEffects: false,
      engines: { node: ">=22.12.0" },
      dependencies: Object.fromEntries(PUBLIC_RELEASE_DEPENDENCIES[name].map((dependency) => [dependency, "1.0.0"]))
    }));
    expect(validateSynchronizedReleaseSet(manifests)).toEqual([]);
    expect(validateSynchronizedReleaseSet(manifests.map((manifest) => manifest.name === "@pixel-point/aval-format" ? { ...manifest, version: "1.0.1" } : manifest))).toContain("@pixel-point/aval-format: version must be 1.0.0");
    expect(validateSynchronizedReleaseSet(manifests.map((manifest) => manifest.name === "@pixel-point/aval-graph" ? { ...manifest, dependencies: { "@pixel-point/aval-unknown": "1.0.0" } } : manifest))).toContain("@pixel-point/aval-graph: internal dependencies must be exactly none");
    expect(validateSynchronizedReleaseSet([...manifests, manifests[0]!])).toEqual(expect.arrayContaining([expect.stringMatching(/exactly 5/u), "@pixel-point/aval-graph: duplicate manifest"]));
  });

  it("rejects unclassified exports when no reviewed package default exists", () => {
    expect(validateApiClassifications(["Player", "PlayerOptions"], { Player: "stable" })).toEqual(["PlayerOptions: missing API classification"]);
    expect(validateApiClassifications(["Player"], {}, "stable")).toEqual([]);
  });
});
