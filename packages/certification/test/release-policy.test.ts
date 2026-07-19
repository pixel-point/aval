import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { PUBLIC_RELEASE_PACKAGES } from "../src/compatibility.js";
import { evaluateNamedProfileMatrix, type NamedProfileMatrixPolicy } from "../src/report-index-criteria.js";

describe("release policy", () => {
  it("pins the candidate and trusted-publishing toolchains without conflating them", async () => {
    const policy = JSON.parse(await readFile("config/release/release-policy.json", "utf8")) as {
      publicPackages: readonly string[];
      registry: { url: string };
      toolchain: Record<string, string>;
      trustedPublishing: { minimumNode: string; minimumNpm: string; oidcOperations: readonly string[]; distTagPromotionRequiresSeparateShortLivedAuthorization: boolean };
      ci: { playwrightBrowserManifestSha256: string };
      namedProfiles: NamedProfileMatrixPolicy;
    };
    expect(policy.publicPackages).toEqual(PUBLIC_RELEASE_PACKAGES);
    expect(policy.registry.url).toBe("https://registry.npmjs.org/");
    expect(Object.values(policy.toolchain).every((version) => /^\d+\.\d+\.\d+$/u.test(version))).toBe(true);
    expect(policy.toolchain).toMatchObject({
      minimumNode: "22.12.0",
      minimumNpm: "10.9.0",
      candidateNode: "22.12.0",
      candidateNpm: "10.9.0"
    });
    expect(policy.trustedPublishing.minimumNode).toBe("22.14.0");
    expect(policy.trustedPublishing.minimumNpm).toBe("11.5.1");
    expect(policy.trustedPublishing.oidcOperations).not.toContain("dist-tag");
    expect(policy.trustedPublishing.distTagPromotionRequiresSeparateShortLivedAuthorization).toBe(true);
    const browsers = await readFile("node_modules/playwright-core/browsers.json");
    expect(createHash("sha256").update(browsers).digest("hex")).toBe(policy.ci.playwrightBrowserManifestSha256);
    expect(() => evaluateNamedProfileMatrix([], policy.namedProfiles)).not.toThrow();
    expect(policy.namedProfiles.requiredPlatformClasses).toEqual(expect.arrayContaining([
      "windows-11-uhd620-or-better",
      "ios-26-iphone-real-device",
      "ios-18-iphone-real-device",
      "android-15-samsung-midrange-real-device"
    ]));
    expect(policy.namedProfiles.requiredBrowsersByPlatform["windows-11-uhd620-or-better"])
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ browserProduct: "Chrome", browserVersion: "150", browserChannel: "stable", osProduct: "Windows", osVersion: "11" }),
        expect.objectContaining({ browserProduct: "Chrome", browserVersion: "149", browserChannel: "stable", osProduct: "Windows", osVersion: "11" }),
        expect.objectContaining({ browserProduct: "Chrome", browserVersion: "148", browserChannel: "stable", osProduct: "Windows", osVersion: "11" }),
        expect.objectContaining({ browserProduct: "Chrome", browserVersion: "127", browserChannel: "stable", osProduct: "Windows", osVersion: "11" })
      ]));
    expect(policy.namedProfiles.requiredBrowsersByPlatform["ios-26-iphone-real-device"])
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ browserProduct: "Mobile Safari", browserVersion: "26.5", osProduct: "iOS", osVersion: "26.5", virtualization: "none" }),
        expect.objectContaining({ browserProduct: "Mobile Safari", browserVersion: "26.4", osProduct: "iOS", osVersion: "26.4", virtualization: "none" }),
        expect.objectContaining({ browserProduct: "Mobile Safari", browserVersion: "26.0", osProduct: "iOS", osVersion: "26.0", virtualization: "none" })
      ]));
    expect(policy.namedProfiles.requiredBrowsersByPlatform["android-15-samsung-midrange-real-device"])
      .toContainEqual(expect.objectContaining({ browserProduct: "Chrome", browserVersion: "145", browserChannel: "stable", osProduct: "Android", osVersion: "15", deviceClass: "Samsung-midrange-real-device", virtualization: "none" }));
    expect(policy.namedProfiles.requiredBrowsersByPlatform["android-16-flagship-real-device"]).toBeUndefined();
  });
});
