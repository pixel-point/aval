import { dirname, resolve } from "node:path";

export const BROWSER_CERTIFICATION_POLICY_PATH =
  "config/release/browser-certification-policy.json";

/** Derives the release matrix without copying browser/OS rows into release policy. */
export function deriveNamedProfileMatrixPolicy(namedProfiles, browserPolicy) {
  requireNamedProfiles(namedProfiles);
  const slots = requireSlots(browserPolicy);
  const byId = new Map();
  const playback = new Set();
  for (const slot of slots) {
    const id = text(slot?.id, "browser certification slot ID is invalid");
    if (byId.has(id)) throw new Error(`browser certification policy duplicates slot: ${id}`);
    requireSlotAuthority(slot, id);
    byId.set(id, slot);
    if (slot.expectation === "playback") playback.add(id);
  }

  const assigned = new Set();
  const requiredPlatformClasses = [];
  const requiredBrowsersByPlatform = {};
  for (const [platformClass, group] of Object.entries(namedProfiles.platformGroups)) {
    text(platformClass, "named profile platform class is invalid");
    requireExactKeys(group, ["slotIds", "deviceClass", "virtualization"],
      `named profile platform group is invalid: ${platformClass}`);
    if (!Array.isArray(group.slotIds) || group.slotIds.length === 0) {
      throw new TypeError(`named profile platform slots are invalid: ${platformClass}`);
    }
    const deviceClass = text(group.deviceClass,
      `named profile device class is invalid: ${platformClass}`);
    const virtualization = group.virtualization;
    if (!["none", "virtualized", "unknown"].includes(virtualization)) {
      throw new TypeError(`named profile virtualization is invalid: ${platformClass}`);
    }
    const requirements = [];
    const identities = new Set();
    for (const value of group.slotIds) {
      const id = text(value, `named profile slot ID is invalid: ${platformClass}`);
      if (assigned.has(id)) throw new Error(`named profile slot is assigned more than once: ${id}`);
      const slot = byId.get(id);
      if (slot === undefined) throw new Error(`named profile slot is unknown: ${id}`);
      if (slot.expectation !== "playback") {
        throw new Error(`named profile slot is not a playback slot: ${id}`);
      }
      assigned.add(id);
      const requirement = Object.freeze({
        browserProduct: slot.browser.brand,
        browserVersion: slot.browser.version,
        browserChannel: slot.browser.channel,
        osProduct: slot.os.name,
        osVersion: slot.os.version,
        deviceClass,
        virtualization
      });
      const identity = JSON.stringify(requirement);
      if (identities.has(identity)) {
        throw new Error(`named profile platform derives a duplicate browser: ${platformClass}`);
      }
      identities.add(identity);
      requirements.push(requirement);
    }
    requiredPlatformClasses.push(platformClass);
    requiredBrowsersByPlatform[platformClass] = Object.freeze(requirements);
  }
  const missing = [...playback].filter((id) => !assigned.has(id)).sort();
  if (missing.length > 0) {
    throw new Error(`named profile policy omits playback slots: ${missing.join(", ")}`);
  }
  return Object.freeze({
    requiredPlatformClasses: Object.freeze(requiredPlatformClasses),
    requiredBrowsersByPlatform: Object.freeze(requiredBrowsersByPlatform),
    requiredRefreshMilliHz: Object.freeze([...namedProfiles.requiredRefreshMilliHz]),
    conditionalRefreshMilliHz: namedProfiles.conditionalRefreshMilliHz
  });
}

/** Selects the manifest-bound candidate authority when one is supplied. */
export function resolveBrowserCertificationPolicyPath(
  namedProfiles,
  { candidateManifestPath, repositoryRoot = process.cwd() } = {}
) {
  requireAuthorityPath(namedProfiles);
  const root = candidateManifestPath === undefined
    ? resolve(repositoryRoot)
    : dirname(resolve(candidateManifestPath));
  return resolve(root, BROWSER_CERTIFICATION_POLICY_PATH);
}

function requireNamedProfiles(value) {
  requireExactKeys(value, [
    "browserCertificationPolicy",
    "platformGroups",
    "requiredRefreshMilliHz",
    "conditionalRefreshMilliHz",
    "requiredScenarioIds",
    "repetitions",
    "minimumThroughputMillionths"
  ], "named profile release policy is invalid");
  requireAuthorityPath(value);
  if (!record(value.platformGroups) || Object.keys(value.platformGroups).length === 0) {
    throw new TypeError("named profile platform groups are invalid");
  }
  if (!positiveIntegerArray(value.requiredRefreshMilliHz) ||
      new Set(value.requiredRefreshMilliHz).size !== value.requiredRefreshMilliHz.length ||
      !positiveInteger(value.conditionalRefreshMilliHz) ||
      value.requiredRefreshMilliHz.includes(value.conditionalRefreshMilliHz)) {
    throw new TypeError("named profile refresh policy is invalid");
  }
  if (!Array.isArray(value.requiredScenarioIds) ||
      value.requiredScenarioIds.length === 0 ||
      new Set(value.requiredScenarioIds).size !== value.requiredScenarioIds.length ||
      value.requiredScenarioIds.some((id) => typeof id !== "string" || id.length === 0) ||
      !positiveInteger(value.repetitions) ||
      !positiveInteger(value.minimumThroughputMillionths)) {
    throw new TypeError("named profile scenario policy is invalid");
  }
}

function requireAuthorityPath(value) {
  if (!record(value) ||
      value.browserCertificationPolicy !== BROWSER_CERTIFICATION_POLICY_PATH) {
    throw new Error("named profile browser certification policy path is invalid");
  }
}

function requireSlots(value) {
  if (!record(value) || !Array.isArray(value.slots) || value.slots.length === 0) {
    throw new TypeError("browser certification policy slots are invalid");
  }
  return value.slots;
}

function requireSlotAuthority(slot, id) {
  if (!record(slot) || !["playback", "unsupported-sentinel"].includes(slot.expectation) ||
      !record(slot.browser) || !record(slot.os)) {
    throw new TypeError(`browser certification slot is invalid: ${id}`);
  }
  for (const [value, field] of [
    [slot.browser.brand, "browser brand"],
    [slot.browser.version, "browser version"],
    [slot.browser.channel, "browser channel"],
    [slot.os.name, "OS name"],
    [slot.os.version, "OS version"]
  ]) text(value, `browser certification slot ${field} is invalid: ${id}`);
}

function requireExactKeys(value, keys, message) {
  if (!record(value) || Object.keys(value).sort().join("\0") !==
      [...keys].sort().join("\0")) throw new TypeError(message);
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value, message) {
  if (typeof value !== "string" || value.length === 0 || value.length > 256 ||
      /[\u0000-\u001f\u007f]/u.test(value)) throw new TypeError(message);
  return value;
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function positiveIntegerArray(value) {
  return Array.isArray(value) && value.length > 0 && value.every(positiveInteger);
}
