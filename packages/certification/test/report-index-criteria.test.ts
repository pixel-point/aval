import { describe, expect, it } from "vitest";
import { evaluateNamedProfileMatrix, type NamedBrowserMatrixRequirement, type NamedProfileIndexInput } from "../src/report-index-criteria.js";

const testEnvironment = {
  browserChannel: "stable",
  osProduct: "Test OS",
  osVersion: "1.0.0",
  deviceClass: "test-device",
  virtualization: "none" as const
};

function requirement(
  browserProduct: string,
  browserVersion: string,
  environment: Partial<typeof testEnvironment> = {}
): NamedBrowserMatrixRequirement {
  return { browserProduct, browserVersion, ...testEnvironment, ...environment };
}

function slot(platform: string, browser: NamedBrowserMatrixRequirement, refreshMilliHz: number): string {
  return JSON.stringify([platform, browser.browserProduct, browser.browserVersion, browser.browserChannel, browser.osProduct, browser.osVersion, browser.deviceClass, browser.virtualization, refreshMilliHz]);
}

const policy = {
  requiredPlatformClasses: ["mac", "windows"],
  requiredBrowsersByPlatform: {
    mac: [
      requirement("Safari", "1.0.0"),
      requirement("Chrome", "1.0.0")
    ],
    windows: [
      requirement("Chrome", "1.0.0"),
      requirement("Edge", "1.0.0")
    ]
  },
  requiredRefreshMilliHz: [60_000],
  conditionalRefreshMilliHz: 120_000
} as const;

function profile(
  platformClass: string,
  browserProduct: string,
  refreshMilliHz: number,
  animationSupported = true,
  browserVersion = "1.0.0",
  environment: Partial<typeof testEnvironment> & { readonly browserBuild?: string } = {}
): NamedProfileIndexInput {
  const { browserBuild = `${browserVersion}.1`, ...environmentOverrides } = environment;
  const exactEnvironment = { ...testEnvironment, ...environmentOverrides };
  return {
    profileId: `${platformClass}-${browserProduct}-${browserVersion}-${exactEnvironment.osProduct}-${exactEnvironment.osVersion}-${exactEnvironment.deviceClass}-${exactEnvironment.virtualization}-${String(refreshMilliHz)}`.toLowerCase().replace(/[^a-z0-9._-]+/gu, "-"),
    platformClass, browserProduct, browserVersion, browserBuild, ...exactEnvironment,
    refreshMilliHz, refresh120Available: false,
    animationSupported,
    runtimeScheduling: animationSupported ? "passed" : "unsupported",
    fatalErrorBoundary: "passed"
  };
}

describe("named certification matrix", () => {
  it("passes only complete declared slots with at least one animated pass per platform", () => {
    const profiles = [profile("mac", "Safari", 60_000), profile("mac", "Chrome", 60_000, false), profile("windows", "Chrome", 60_000), profile("windows", "Edge", 60_000, false)];
    expect(evaluateNamedProfileMatrix(profiles, policy)).toMatchObject({ status: "passed", failures: [], missingSlots: [] });
  });

  it("blocks a supported failure even when another profile passes", () => {
    const failed = { ...profile("mac", "Chrome", 60_000), runtimeScheduling: "failed" as const };
    const profiles = [profile("mac", "Safari", 60_000), failed, profile("windows", "Chrome", 60_000), profile("windows", "Edge", 60_000, false)];
    expect(evaluateNamedProfileMatrix(profiles, policy)).toMatchObject({ status: "failed", failures: expect.arrayContaining([expect.stringContaining("supported-runtime")]) });
  });

  it("requires the fatal error boundary even when animation is unsupported", () => {
    const failedBoundary = { ...profile("mac", "Chrome", 60_000, false), fatalErrorBoundary: "failed" as const };
    const profiles = [profile("mac", "Safari", 60_000), failedBoundary, profile("windows", "Chrome", 60_000), profile("windows", "Edge", 60_000, false)];
    expect(evaluateNamedProfileMatrix(profiles, policy)).toMatchObject({
      status: "failed",
      failures: expect.arrayContaining([`fatal-error-boundary:${failedBoundary.profileId}:failed`])
    });
  });

  it("requires 120 Hz slots whenever the platform records that mode as available", () => {
    const profiles = [{ ...profile("mac", "Safari", 60_000), refresh120Available: true }, { ...profile("mac", "Chrome", 60_000, false), refresh120Available: true }, profile("windows", "Chrome", 60_000), profile("windows", "Edge", 60_000, false)];
    const result = evaluateNamedProfileMatrix(profiles, policy);
    expect(result.status).toBe("inconclusive");
    expect(result.missingSlots).toEqual(expect.arrayContaining([
      slot("mac", policy.requiredBrowsersByPlatform.mac[0]!, 120_000),
      slot("mac", policy.requiredBrowsersByPlatform.mac[1]!, 120_000)
    ]));
  });

  it("requires and accepts multiple exact browser versions on one OS refresh", () => {
    const versionedPolicy = {
      requiredPlatformClasses: ["windows"],
      requiredBrowsersByPlatform: {
        windows: [
          requirement("Chrome", "150"),
          requirement("Chrome", "149"),
          requirement("Chrome", "148"),
          requirement("Chrome", "127")
        ]
      },
      requiredRefreshMilliHz: [60_000],
      conditionalRefreshMilliHz: 120_000
    } as const;
    const profiles = [
      profile("windows", "Chrome", 60_000, true, "150"),
      profile("windows", "Chrome", 60_000, true, "149"),
      profile("windows", "Chrome", 60_000, true, "148"),
      profile("windows", "Chrome", 60_000, true, "127")
    ];
    expect(evaluateNamedProfileMatrix(profiles, versionedPolicy)).toMatchObject({ status: "passed", failures: [], missingSlots: [] });

    const incomplete = evaluateNamedProfileMatrix(profiles.slice(0, 3), versionedPolicy);
    expect(incomplete.status).toBe("inconclusive");
    expect(incomplete.missingSlots).toContain(slot("windows", versionedPolicy.requiredBrowsersByPlatform.windows[3]!, 60_000));
  });

  it("accepts required iOS Safari and Android Chrome profiles", () => {
    const mobilePolicy = {
      requiredPlatformClasses: ["ios-26-iphone-real-device", "android-15-samsung-midrange-real-device"],
      requiredBrowsersByPlatform: {
        "ios-26-iphone-real-device": [requirement("Mobile Safari", "26.5", {
          osProduct: "iOS", osVersion: "26.5", deviceClass: "iPhone-real-device"
        })],
        "android-15-samsung-midrange-real-device": [requirement("Chrome", "145", {
          osProduct: "Android", osVersion: "15", deviceClass: "Samsung-midrange-real-device"
        })]
      },
      requiredRefreshMilliHz: [60_000],
      conditionalRefreshMilliHz: 120_000
    } as const;
    expect(evaluateNamedProfileMatrix([
      profile("ios-26-iphone-real-device", "Mobile Safari", 60_000, true, "26.5", {
        osProduct: "iOS", osVersion: "26.5", deviceClass: "iPhone-real-device"
      }),
      profile("android-15-samsung-midrange-real-device", "Chrome", 60_000, true, "145", {
        osProduct: "Android", osVersion: "15", deviceClass: "Samsung-midrange-real-device"
      })
    ], mobilePolicy)).toMatchObject({ status: "passed", failures: [], missingSlots: [] });

    const android = profile("android-15-samsung-midrange-real-device", "Chrome", 60_000, true, "145", {
      osProduct: "Android", osVersion: "15", deviceClass: "Samsung-midrange-real-device"
    });
    expect(evaluateNamedProfileMatrix([{ ...android, osVersion: "14" }], mobilePolicy).failures)
      .toContain(`unknown-os-version:${android.profileId}`);
    expect(evaluateNamedProfileMatrix([{ ...android, deviceClass: "Android-emulator" }], mobilePolicy).failures)
      .toContain(`unknown-device-class:${android.profileId}`);
    expect(evaluateNamedProfileMatrix([{ ...android, virtualization: "virtualized" }], mobilePolicy).failures)
      .toContain(`unknown-virtualization:${android.profileId}`);
  });

  it("keeps exact duplicates fatal while allowing adjacent browser versions", () => {
    const versionedPolicy = {
      requiredPlatformClasses: ["windows"],
      requiredBrowsersByPlatform: {
        windows: [
          requirement("Chrome", "149"),
          requirement("Chrome", "148")
        ]
      },
      requiredRefreshMilliHz: [60_000],
      conditionalRefreshMilliHz: 120_000
    } as const;
    const current = profile("windows", "Chrome", 60_000, true, "149");
    const previous = profile("windows", "Chrome", 60_000, true, "148");
    expect(evaluateNamedProfileMatrix([current, previous], versionedPolicy).failures).toEqual([]);
    expect(evaluateNamedProfileMatrix([current, current, previous], versionedPolicy).failures)
      .toContain(`duplicate-slot:${slot("windows", versionedPolicy.requiredBrowsersByPlatform.windows[0]!, 60_000)}`);
  });

  it("does not collapse distinct slots whose display labels contain separators", () => {
    const separatorPolicy = {
      requiredPlatformClasses: ["windows"],
      requiredBrowsersByPlatform: {
        windows: [
          requirement("Chrome", "149", { osProduct: "Android/16", osVersion: "16", deviceClass: "Device" }),
          requirement("Chrome", "149", { osProduct: "Android", osVersion: "16", deviceClass: "16/Device" })
        ]
      },
      requiredRefreshMilliHz: [60_000],
      conditionalRefreshMilliHz: 120_000
    } as const;
    const first = profile("windows", "Chrome", 60_000, true, "149", { osProduct: "Android/16", osVersion: "16", deviceClass: "Device" });
    const second = profile("windows", "Chrome", 60_000, true, "149", { osProduct: "Android", osVersion: "16", deviceClass: "16/Device" });
    expect(evaluateNamedProfileMatrix([first, second], separatorPolicy).failures).toEqual([]);
    const missingFirst = evaluateNamedProfileMatrix([second], separatorPolicy).missingSlots;
    const missingSecond = evaluateNamedProfileMatrix([first], separatorPolicy).missingSlots;
    expect(missingFirst).toEqual([slot("windows", separatorPolicy.requiredBrowsersByPlatform.windows[0]!, 60_000)]);
    expect(missingSecond).toEqual([slot("windows", separatorPolicy.requiredBrowsersByPlatform.windows[1]!, 60_000)]);
    expect(missingFirst[0]).not.toBe(missingSecond[0]);
  });

  it("rejects duplicate and undeclared matrix slots", () => {
    const duplicate = profile("mac", "Safari", 60_000);
    const result = evaluateNamedProfileMatrix([duplicate, duplicate, profile("linux", "Chrome", 60_000)], policy);
    expect(result.status).toBe("failed");
    expect(result.failures.join("\n")).toMatch(/duplicate-slot|unknown-platform/u);
  });

  it("rejects undeclared refresh rates and incoherent conditional availability", () => {
    const unknown = profile("mac", "Safari", 75_000);
    expect(evaluateNamedProfileMatrix([unknown], policy).failures).toContain(`unknown-refresh:${unknown.profileId}:75000`);
    const incoherent = [{ ...profile("mac", "Safari", 60_000), refresh120Available: true }, profile("mac", "Chrome", 60_000)];
    expect(evaluateNamedProfileMatrix(incoherent, policy).failures).toContain("incoherent-conditional-refresh:mac");
    const unproven120 = profile("mac", "Safari", 120_000);
    expect(evaluateNamedProfileMatrix([unproven120], policy).failures).toContain(`conditional-refresh-without-availability:${unproven120.profileId}`);
  });

  it("rejects an undeclared browser version independently of the product", () => {
    const unknown = profile("mac", "Safari", 60_000, true, "2.0.0");
    expect(evaluateNamedProfileMatrix([unknown], policy).failures)
      .toContain(`unknown-browser-version:${unknown.profileId}`);
  });

  it("rejects beta or custom channels for a stable browser slot", () => {
    const beta = profile("windows", "Chrome", 60_000, true, "1.0.0", {
      browserChannel: "beta"
    });
    expect(evaluateNamedProfileMatrix([beta], policy).failures)
      .toContain(`unknown-browser-channel:${beta.profileId}`);
  });

  it("rejects non-exact and cross-major browser build evidence", () => {
    const moving = profile("windows", "Chrome", 60_000, true, "1.0.0", {
      browserBuild: "latest"
    });
    expect(evaluateNamedProfileMatrix([moving], policy).failures)
      .toContain(`invalid-browser-build:${moving.profileId}`);

    const mismatched = profile("windows", "Chrome", 60_000, true, "1.0.0", {
      browserBuild: "2.0.0.1"
    });
    expect(evaluateNamedProfileMatrix([mismatched], policy).failures)
      .toContain(`browser-build-version-mismatch:${mismatched.profileId}`);
  });

  it("rejects moving aliases and duplicate requirements in policy authority", () => {
    for (const alias of ["current", "latest-1", ">=149", "149.x", "149 or newer"]) {
      const movingAlias = structuredClone(policy) as any;
      movingAlias.requiredBrowsersByPlatform.mac[0].browserVersion = alias;
      expect(() => evaluateNamedProfileMatrix([], movingAlias)).toThrow(/version policy/u);
    }

    const duplicate = structuredClone(policy) as any;
    duplicate.requiredBrowsersByPlatform.mac.push(duplicate.requiredBrowsersByPlatform.mac[0]);
    expect(() => evaluateNamedProfileMatrix([], duplicate)).toThrow(/duplicate/u);
  });
});
