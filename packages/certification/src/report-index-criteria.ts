import type { CertificationStatus } from "./status.js";
import {
  browserBuildMatchesProductVersion,
  isExactBrowserBuild,
  isExactProductVersion
} from "./exact-version.js";

export interface NamedProfileIndexInput {
  readonly profileId: string;
  readonly platformClass: string;
  readonly browserProduct: string;
  readonly browserVersion: string;
  readonly browserBuild: string;
  readonly browserChannel: string;
  readonly osProduct: string;
  readonly osVersion: string;
  readonly deviceClass: string;
  readonly virtualization: "none" | "virtualized" | "unknown";
  readonly refreshMilliHz: number;
  readonly refresh120Available: boolean;
  readonly animationSupported: boolean;
  readonly runtimeScheduling: CertificationStatus;
  readonly fatalErrorBoundary: CertificationStatus;
}

export interface NamedBrowserMatrixRequirement {
  readonly browserProduct: string;
  readonly browserVersion: string;
  readonly browserChannel: string;
  readonly osProduct: string;
  readonly osVersion: string;
  readonly deviceClass: string;
  readonly virtualization: "none" | "virtualized" | "unknown";
}

export interface NamedProfileMatrixPolicy {
  readonly requiredPlatformClasses: readonly string[];
  readonly requiredBrowsersByPlatform: Readonly<Record<string, readonly NamedBrowserMatrixRequirement[]>>;
  readonly requiredRefreshMilliHz: readonly number[];
  readonly conditionalRefreshMilliHz: number;
}

export interface NamedProfileMatrixResult {
  readonly status: "passed" | "failed" | "inconclusive" | "not-run";
  readonly failures: readonly string[];
  readonly missingSlots: readonly string[];
}

/** Grades the entire declared matrix; one convenient passing profile is insufficient. */
export function evaluateNamedProfileMatrix(
  profiles: readonly NamedProfileIndexInput[],
  policy: NamedProfileMatrixPolicy
): NamedProfileMatrixResult {
  validatePolicy(policy);
  if (profiles.length === 0) return Object.freeze({ status: "not-run", failures: Object.freeze([]), missingSlots: Object.freeze([]) });
  const failures: string[] = [];
  const missingSlots: string[] = [];
  const slots = new Map<string, NamedProfileIndexInput>();
  const allowedPlatforms = new Set(policy.requiredPlatformClasses);
  const allowedRefresh = new Set([...policy.requiredRefreshMilliHz, policy.conditionalRefreshMilliHz]);
  const availabilityByPlatform = new Map<string, boolean>();
  for (const profile of profiles) {
    if (!allowedPlatforms.has(profile.platformClass)) failures.push(`unknown-platform:${profile.profileId}`);
    const browsers = policy.requiredBrowsersByPlatform[profile.platformClass] ?? [];
    const matchingProduct = browsers.filter(({ browserProduct }) => browserProduct === profile.browserProduct);
    const matchingVersion = matchingProduct.filter(({ browserVersion }) => browserVersion === profile.browserVersion);
    const matchingChannel = matchingVersion.filter(({ browserChannel }) => browserChannel === profile.browserChannel);
    const matchingOsProduct = matchingChannel.filter(({ osProduct }) => osProduct === profile.osProduct);
    const matchingOsVersion = matchingOsProduct.filter(({ osVersion }) => osVersion === profile.osVersion);
    const matchingDeviceClass = matchingOsVersion.filter(({ deviceClass }) => deviceClass === profile.deviceClass);
    if (matchingProduct.length === 0) failures.push(`unknown-browser:${profile.profileId}`);
    else if (matchingVersion.length === 0) failures.push(`unknown-browser-version:${profile.profileId}`);
    else if (matchingChannel.length === 0) failures.push(`unknown-browser-channel:${profile.profileId}`);
    else if (matchingOsProduct.length === 0) failures.push(`unknown-os-product:${profile.profileId}`);
    else if (matchingOsVersion.length === 0) failures.push(`unknown-os-version:${profile.profileId}`);
    else if (matchingDeviceClass.length === 0) failures.push(`unknown-device-class:${profile.profileId}`);
    else if (!matchingDeviceClass.some(({ virtualization }) => virtualization === profile.virtualization)) failures.push(`unknown-virtualization:${profile.profileId}`);
    if (!isExactBrowserBuild(profile.browserBuild)) failures.push(`invalid-browser-build:${profile.profileId}`);
    else if (!browserBuildMatchesProductVersion(profile.browserProduct, profile.browserVersion, profile.browserBuild)) failures.push(`browser-build-version-mismatch:${profile.profileId}`);
    if (!allowedRefresh.has(profile.refreshMilliHz)) failures.push(`unknown-refresh:${profile.profileId}:${String(profile.refreshMilliHz)}`);
    if (profile.refreshMilliHz === policy.conditionalRefreshMilliHz && !profile.refresh120Available) failures.push(`conditional-refresh-without-availability:${profile.profileId}`);
    const recordedAvailability = availabilityByPlatform.get(profile.platformClass);
    if (recordedAvailability !== undefined && recordedAvailability !== profile.refresh120Available) failures.push(`incoherent-conditional-refresh:${profile.platformClass}`);
    else availabilityByPlatform.set(profile.platformClass, profile.refresh120Available);
    const slot = slotKey(profile.platformClass, profile.browserProduct, profile.browserVersion, profile.browserChannel, profile.osProduct, profile.osVersion, profile.deviceClass, profile.virtualization, profile.refreshMilliHz);
    if (slots.has(slot)) failures.push(`duplicate-slot:${slotId(profile.platformClass, profile.browserProduct, profile.browserVersion, profile.browserChannel, profile.osProduct, profile.osVersion, profile.deviceClass, profile.virtualization, profile.refreshMilliHz)}`);
    else slots.set(slot, profile);
    if (profile.fatalErrorBoundary !== "passed") failures.push(`fatal-error-boundary:${profile.profileId}:${profile.fatalErrorBoundary}`);
    if (profile.animationSupported) {
      if (profile.runtimeScheduling !== "passed") failures.push(`supported-runtime:${profile.profileId}:${profile.runtimeScheduling}`);
    } else if (profile.runtimeScheduling !== "unsupported") {
      failures.push(`unsupported-runtime:${profile.profileId}:${profile.runtimeScheduling}`);
    }
  }

  for (const platform of policy.requiredPlatformClasses) {
    const browsers = policy.requiredBrowsersByPlatform[platform]!;
    const requiredRefresh = [...policy.requiredRefreshMilliHz];
    if (availabilityByPlatform.get(platform) === true) {
      requiredRefresh.push(policy.conditionalRefreshMilliHz);
    }
    for (const browser of browsers) for (const refresh of new Set(requiredRefresh)) {
      const slot = slotKey(platform, browser.browserProduct, browser.browserVersion, browser.browserChannel, browser.osProduct, browser.osVersion, browser.deviceClass, browser.virtualization, refresh);
      if (!slots.has(slot)) missingSlots.push(slotId(platform, browser.browserProduct, browser.browserVersion, browser.browserChannel, browser.osProduct, browser.osVersion, browser.deviceClass, browser.virtualization, refresh));
    }
    if (!profiles.some((profile) => profile.platformClass === platform && profile.animationSupported && profile.runtimeScheduling === "passed")) {
      failures.push(`no-supported-passing-runtime:${platform}`);
    }
  }
  const status = failures.length > 0 ? "failed" : missingSlots.length > 0 ? "inconclusive" : "passed";
  return Object.freeze({ status, failures: Object.freeze(failures), missingSlots: Object.freeze(missingSlots) });
}

function validatePolicy(policy: NamedProfileMatrixPolicy): void {
  if (!Array.isArray(policy.requiredPlatformClasses) || policy.requiredPlatformClasses.length === 0 || new Set(policy.requiredPlatformClasses).size !== policy.requiredPlatformClasses.length) throw new TypeError("named profile platform policy is invalid");
  if (!Array.isArray(policy.requiredRefreshMilliHz) || policy.requiredRefreshMilliHz.length === 0) throw new TypeError("named profile refresh policy is empty");
  for (const refresh of [...policy.requiredRefreshMilliHz, policy.conditionalRefreshMilliHz]) if (!Number.isSafeInteger(refresh) || refresh <= 0) throw new RangeError("named profile refresh policy is invalid");
  for (const platform of policy.requiredPlatformClasses) {
    const browsers = policy.requiredBrowsersByPlatform[platform];
    if (!Array.isArray(browsers) || browsers.length === 0) throw new TypeError(`named browser policy is invalid: ${platform}`);
    const identities = new Set<string>();
    for (const browser of browsers) {
      if (browser === null || typeof browser !== "object" || Array.isArray(browser)) throw new TypeError(`named browser policy is invalid: ${platform}`);
      const keys = Object.keys(browser);
      const requiredKeys = ["browserProduct", "browserVersion", "browserChannel", "osProduct", "osVersion", "deviceClass", "virtualization"];
      if (keys.length !== requiredKeys.length || requiredKeys.some((key) => !keys.includes(key))) throw new TypeError(`named browser policy is invalid: ${platform}`);
      const product = policyText(browser.browserProduct, `named browser product policy is invalid: ${platform}`);
      const version = exactBrowserVersion(browser.browserVersion, `named browser version policy is invalid: ${platform}/${product}`);
      const channel = policyText(browser.browserChannel, `named browser channel policy is invalid: ${platform}/${product}/${version}`);
      const osProduct = policyText(browser.osProduct, `named OS product policy is invalid: ${platform}/${product}/${version}`);
      const osVersion = exactBrowserVersion(browser.osVersion, `named OS version policy is invalid: ${platform}/${product}/${version}`);
      const deviceClass = policyText(browser.deviceClass, `named device-class policy is invalid: ${platform}/${product}/${version}`);
      if (browser.virtualization !== "none" && browser.virtualization !== "virtualized" && browser.virtualization !== "unknown") throw new TypeError(`named virtualization policy is invalid: ${platform}/${product}/${version}`);
      const identity = JSON.stringify([product, version, channel, osProduct, osVersion, deviceClass, browser.virtualization]);
      if (identities.has(identity)) throw new TypeError(`named browser policy contains a duplicate: ${platform}/${product}/${version}/${channel}/${osProduct}/${osVersion}/${deviceClass}/${browser.virtualization}`);
      identities.add(identity);
    }
  }
  const unknown = Object.keys(policy.requiredBrowsersByPlatform).find((platform) => !policy.requiredPlatformClasses.includes(platform));
  if (unknown !== undefined) throw new TypeError(`named browser policy has unknown platform: ${unknown}`);
}

function slotId(platform: string, browser: string, browserVersion: string, browserChannel: string, osProduct: string, osVersion: string, deviceClass: string, virtualization: string, refreshMilliHz: number): string {
  return slotKey(platform, browser, browserVersion, browserChannel, osProduct, osVersion, deviceClass, virtualization, refreshMilliHz);
}

function slotKey(platform: string, browser: string, browserVersion: string, browserChannel: string, osProduct: string, osVersion: string, deviceClass: string, virtualization: string, refreshMilliHz: number): string {
  return JSON.stringify([platform, browser, browserVersion, browserChannel, osProduct, osVersion, deviceClass, virtualization, refreshMilliHz]);
}

function policyText(value: unknown, message: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128 || /[\u0000-\u001f\u007f]/u.test(value)) throw new TypeError(message);
  return value;
}

function exactBrowserVersion(value: unknown, message: string): string {
  const version = policyText(value, message);
  if (!isExactProductVersion(version)) throw new TypeError(message);
  return version;
}
