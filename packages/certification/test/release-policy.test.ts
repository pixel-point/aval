import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { PUBLIC_RELEASE_PACKAGES } from "../src/compatibility.js";
import { evaluateNamedProfileMatrix } from "../src/report-index-criteria.js";
import {
  BROWSER_CERTIFICATION_POLICY_PATH,
  deriveNamedProfileMatrixPolicy,
  resolveBrowserCertificationPolicyPath
} from "../../../scripts/certification/named-profile-policy.mjs";

describe("release policy", () => {
  it("pins the candidate and trusted-publishing toolchains without conflating them", async () => {
    const policy = JSON.parse(await readFile("config/release/release-policy.json", "utf8")) as {
      releaseStage: string;
      wireFormatVersion: string;
      projectSchemaVersion: string;
      publicPackages: readonly string[];
      registry: { url: string };
      toolchain: Record<string, string>;
      trustedPublishing: { minimumNode: string; minimumNpm: string; oidcOperations: readonly string[]; distTagPromotionRequiresSeparateShortLivedAuthorization: boolean };
      ci: { playwrightBrowserManifestSha256: string };
      namedProfiles: RawNamedProfilePolicy;
    };
    expect(policy.releaseStage).toBe("technical-preview");
    expect(policy.wireFormatVersion).toBe("1.1");
    expect(policy.projectSchemaVersion).toBe("1.0");
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
    const compatibility = JSON.parse(await readFile(
      "config/release/browser-certification-policy.json",
      "utf8"
    )) as BrowserPolicy;
    const matrix = deriveNamedProfileMatrixPolicy(
      policy.namedProfiles,
      compatibility
    );
    expect(policy.namedProfiles.browserCertificationPolicy).toBe(
      BROWSER_CERTIFICATION_POLICY_PATH
    );
    expect(() => evaluateNamedProfileMatrix([], matrix)).not.toThrow();
    expect(Object.values(matrix.requiredBrowsersByPlatform).flat()).toHaveLength(
      compatibility.slots.filter(({ expectation }) => expectation === "playback").length
    );
    expect(matrix.requiredBrowsersByPlatform["ios-26-iphone-real-device"])
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          browserProduct: "Safari",
          browserVersion: "26.5",
          osProduct: "iOS",
          osVersion: "26.5",
          deviceClass: "iPhone-real-device",
          virtualization: "none"
        })
      ]));
    expect(resolveBrowserCertificationPolicyPath(policy.namedProfiles, {
      candidateManifestPath: "/candidate/candidate-manifest.json",
      repositoryRoot: "/ignored"
    })).toBe(`/candidate/${BROWSER_CERTIFICATION_POLICY_PATH}`);
  });

  it.each([
    ["duplicate", (named: RawNamedProfilePolicy, browser: BrowserPolicy) => {
      named.platformGroups["ios-18-iphone-real-device"]!.slotIds.push(
        named.platformGroups["ios-26-iphone-real-device"]!.slotIds[0]!
      );
    }, /assigned more than once/u],
    ["unknown", (named: RawNamedProfilePolicy) => {
      named.platformGroups["ios-18-iphone-real-device"]!.slotIds[0] = "absent-slot";
    }, /slot is unknown/u],
    ["non-playback", (named: RawNamedProfilePolicy, browser: BrowserPolicy) => {
      const sentinel = browser.slots.find(({ expectation }) =>
        expectation !== "playback"
      );
      expect(sentinel).toBeDefined();
      named.platformGroups["ios-18-iphone-real-device"]!.slotIds[0] = sentinel!.id;
    }, /not a playback slot/u]
  ])("rejects a %s browser-slot assignment", async (
    _label,
    mutate,
    message
  ) => {
    const named = structuredClone((JSON.parse(await readFile(
      "config/release/release-policy.json", "utf8"
    )) as { namedProfiles: RawNamedProfilePolicy }).namedProfiles);
    const browser = structuredClone(JSON.parse(await readFile(
      "config/release/browser-certification-policy.json", "utf8"
    )) as BrowserPolicy);
    mutate(named, browser);
    expect(() => deriveNamedProfileMatrixPolicy(named, browser)).toThrow(message);
  });

  it("rejects a named profile that omits a playback slot", async () => {
    const { named, browser } = await loadPolicies();
    const omitted = named.platformGroups["ios-26-iphone-real-device"]!
      .slotIds.pop();
    expect(omitted).toBeDefined();

    expect(() => deriveNamedProfileMatrixPolicy(named, browser)).toThrow(
      new RegExp(`omits playback slots: ${omitted}`, "u")
    );
  });

  it("rejects a malformed named-profile platform group", async () => {
    const { named, browser } = await loadPolicies();
    Object.assign(named.platformGroups["ios-18-iphone-real-device"]!, {
      copiedBrowserRows: []
    });

    expect(() => deriveNamedProfileMatrixPolicy(named, browser)).toThrow(
      /named profile platform group is invalid/u
    );
  });

  it("rejects a non-canonical browser-policy authority path", async () => {
    const { named, browser } = await loadPolicies();
    named.browserCertificationPolicy = "config/release/copied-browser-policy.json";

    expect(() => deriveNamedProfileMatrixPolicy(named, browser)).toThrow(
      /browser certification policy path is invalid/u
    );
    expect(() => resolveBrowserCertificationPolicyPath(named, {
      repositoryRoot: "/repository"
    })).toThrow(/browser certification policy path is invalid/u);
  });
});

async function loadPolicies(): Promise<{
  named: RawNamedProfilePolicy;
  browser: BrowserPolicy;
}> {
  const named = structuredClone((JSON.parse(await readFile(
    "config/release/release-policy.json", "utf8"
  )) as { namedProfiles: RawNamedProfilePolicy }).namedProfiles);
  const browser = structuredClone(JSON.parse(await readFile(
    "config/release/browser-certification-policy.json", "utf8"
  )) as BrowserPolicy);
  return { named, browser };
}

interface RawNamedProfilePolicy {
  browserCertificationPolicy: string;
  platformGroups: Record<string, {
    slotIds: string[];
    deviceClass: string;
    virtualization: string;
  }>;
  requiredRefreshMilliHz: number[];
  conditionalRefreshMilliHz: number;
  requiredScenarioIds: string[];
  repetitions: number;
  minimumThroughputMillionths: number;
}

interface BrowserPolicy {
  slots: Array<{
    id: string;
    expectation: string;
    browser: { brand: string; version: string; channel: string };
    os: { name: string; version: string };
  }>;
}
