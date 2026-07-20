#!/usr/bin/env node
import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const BRAVE_VERSIONS_URL =
  "https://versions.brave.com/latest/brave-versions.json";
export const BRAVE_RELEASES_API =
  "https://api.github.com/repos/brave/brave-browser/releases";
export const MAX_REDIRECTS = 3;

const VERSION_PATTERN = /^[0-9]+(?:\.[0-9]+){1,3}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const RELEASE_TAG_PATTERN = /^v([0-9]+(?:\.[0-9]+){2})$/u;
const PLATFORM_ASSET_NAMES = Object.freeze({
  "macos-arm64": "Brave-Browser-arm64.dmg",
  "windows-x64": "BraveBrowserStandaloneSetup.exe"
});
const BOUNDARY_ADJACENT_STABLE_RELEASES = Object.freeze({
  "2024-07-19": Object.freeze({
    previous: "1.67.123",
    selected: "1.67.134",
    next: "1.68.128"
  })
});
const OFFICIAL_HOSTS = Object.freeze({
  versions: new Set(["versions.brave.com"]),
  api: new Set(["api.github.com"]),
  release: new Set(["github.com"]),
  asset: new Set([
    "github.com",
    "release-assets.githubusercontent.com",
    "objects.githubusercontent.com",
    "github-releases.githubusercontent.com"
  ])
});

export function assertOfficialHttpsUrl(value, purpose = "asset") {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`brave-url-invalid:${String(value)}`);
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
    throw new Error(`brave-url-not-official-https:${url.href}`);
  }
  const allowed = OFFICIAL_HOSTS[purpose];
  if (!(allowed instanceof Set) || !allowed.has(url.hostname)) {
    throw new Error(`brave-url-wrong-host:${url.hostname}`);
  }
  if (purpose === "api" &&
      !url.pathname.startsWith("/repos/brave/brave-browser/releases")) {
    throw new Error(`brave-url-wrong-repository:${url.pathname}`);
  }
  if (purpose === "asset" && url.hostname === "github.com" &&
      !url.pathname.startsWith("/brave/brave-browser/releases/download/")) {
    throw new Error(`brave-url-wrong-repository:${url.pathname}`);
  }
  if (purpose === "release" &&
      !url.pathname.startsWith("/brave/brave-browser/releases/tag/")) {
    throw new Error(`brave-url-wrong-repository:${url.pathname}`);
  }
  return url;
}

export async function fetchWithBoundedRedirects(
  value,
  { fetchImpl = fetch, maxRedirects = MAX_REDIRECTS, purpose = "asset", headers = {} } = {}
) {
  if (!Number.isInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > MAX_REDIRECTS) {
    throw new Error("brave-redirect-limit-invalid");
  }
  let url = assertOfficialHttpsUrl(value, purpose);
  for (let redirects = 0; ; redirects += 1) {
    const response = await fetchImpl(url, {
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(30_000)
    });
    if (response.status >= 300 && response.status < 400) {
      if (redirects >= maxRedirects) throw new Error("brave-redirect-limit-exceeded");
      const location = response.headers.get("location");
      if (location === null) throw new Error("brave-redirect-missing-location");
      url = assertOfficialHttpsUrl(new URL(location, url).href, purpose);
      continue;
    }
    if (!response.ok) throw new Error(`brave-http-${String(response.status)}`);
    return Object.freeze({ response, finalUrl: url.href, redirects });
  }
}

export async function resolveOfficialBuilds({
  versionsResponse,
  releases,
  boundaryDate,
  readChecksum = defaultChecksumReader
}) {
  const boundaryInstant = parseBoundaryDate(boundaryDate);
  const inventory = normalizeVersionsInventory(versionsResponse);
  const stableInventory = inventory
    .filter((entry) => entry.channel === "release")
    .sort(comparePublishedThenVersion);
  if (stableInventory.length === 0) throw new Error("brave-current-stable-missing");
  const currentInventory = stableInventory.at(-1);
  const stableReleases = releases.filter(isOfficialStableRelease);
  const currentRelease = stableReleases.find(
    (release) => releaseVersion(release) === currentInventory.version
  );
  if (currentRelease === undefined) {
    throw new Error(`brave-current-release-metadata-missing:${currentInventory.version}`);
  }
  const boundaryRelease = selectNearestBoundaryRelease(stableReleases, boundaryInstant);
  const current = await releaseToBuild(
    "current",
    currentRelease,
    readChecksum,
    currentInventory.chromiumVersion
  );
  const boundary = await releaseToBuild(
    "boundary",
    boundaryRelease,
    readChecksum,
    null
  );
  if (current.version === boundary.version) {
    throw new Error("brave-current-and-boundary-identical");
  }
  return Object.freeze({ current, boundary });
}

export function normalizeVersionsInventory(value) {
  let candidates;
  if (Array.isArray(value)) candidates = value;
  else if (Array.isArray(value?.versions)) candidates = value.versions;
  else if (value !== null && typeof value === "object" &&
      (typeof value.tag === "string" || typeof value.version === "string" ||
       typeof value.name === "string")) candidates = [value];
  else if (value !== null && typeof value === "object") candidates = Object.values(value);
  else throw new Error("brave-versions-response-invalid");

  return candidates.flatMap((candidate) => {
    if (candidate === null || typeof candidate !== "object") return [];
    const rawVersion = candidate.version ?? candidate.name ?? candidate.tag;
    const version = normalizeVersion(rawVersion);
    const channelValue = String(candidate.channel ?? candidate.stability ?? "").toLowerCase();
    const channel = channelValue === "stable" ? "release" : channelValue;
    const published = candidate.published ?? candidate.published_at ?? candidate.releaseDate;
    const chromiumVersion = candidate.dependencies?.chrome ??
      candidate.chromiumVersion ?? candidate.chromium_version ?? null;
    if (version === null || !isDateTime(published) ||
        (channel !== "release" && channel !== "beta" && channel !== "nightly")) return [];
    if (chromiumVersion !== null && !VERSION_PATTERN.test(String(chromiumVersion))) {
      throw new Error(`brave-chromium-version-invalid:${String(chromiumVersion)}`);
    }
    return [{
      channel,
      chromiumVersion: chromiumVersion === null ? null : String(chromiumVersion),
      published: new Date(published).toISOString(),
      version
    }];
  });
}

export function isOfficialStableRelease(release) {
  if (release === null || typeof release !== "object" || release.draft === true ||
      release.prerelease === true || !isDateTime(release.published_at)) return false;
  const version = releaseVersion(release);
  if (version === null) return false;
  const text = `${String(release.name ?? "")}\n${String(release.body ?? "")}`;
  return new RegExp(`(?:^|\\n)Release v${escapeRegExp(version)} \\(Chromium `, "u").test(text) &&
    !/(?:not the release \(stable\)|\bbeta\b|\bnightly\b)/iu.test(text);
}

export function selectNearestBoundaryRelease(releases, boundaryInstant) {
  const candidates = releases.filter(isOfficialStableRelease);
  if (candidates.length === 0) throw new Error("brave-boundary-release-missing");
  return [...candidates].sort((left, right) => {
    const leftTime = Date.parse(left.published_at);
    const rightTime = Date.parse(right.published_at);
    const distance = Math.abs(leftTime - boundaryInstant) -
      Math.abs(rightTime - boundaryInstant);
    if (distance !== 0) return distance;
    const leftAfter = leftTime > boundaryInstant ? 1 : 0;
    const rightAfter = rightTime > boundaryInstant ? 1 : 0;
    if (leftAfter !== rightAfter) return leftAfter - rightAfter;
    if (leftTime !== rightTime) return rightTime - leftTime;
    return compareVersions(releaseVersion(right), releaseVersion(left));
  })[0];
}

export function assertBoundaryReleaseProof(
  releases,
  boundaryDate,
  pinnedBoundaryVersion
) {
  const expected = BOUNDARY_ADJACENT_STABLE_RELEASES[boundaryDate];
  if (expected === undefined || pinnedBoundaryVersion !== expected.selected) {
    throw new Error("brave-policy-boundary-proof-missing");
  }
  const byVersion = new Map(releases.filter(isOfficialStableRelease)
    .map((release) => [releaseVersion(release), release]));
  const previous = byVersion.get(expected.previous);
  const selected = byVersion.get(expected.selected);
  const next = byVersion.get(expected.next);
  if (previous === undefined || selected === undefined || next === undefined) {
    throw new Error("brave-policy-boundary-adjacent-release-missing");
  }
  const previousTime = Date.parse(previous.published_at);
  const selectedTime = Date.parse(selected.published_at);
  const nextTime = Date.parse(next.published_at);
  if (!(previousTime < selectedTime && selectedTime < nextTime)) {
    throw new Error("brave-policy-boundary-adjacent-release-order-invalid");
  }
  const nearest = selectNearestBoundaryRelease(
    [previous, selected, next],
    parseBoundaryDate(boundaryDate)
  );
  if (releaseVersion(nearest) !== pinnedBoundaryVersion) {
    throw new Error("brave-policy-boundary-release-not-nearest");
  }
  return Object.freeze({
    previous: expected.previous,
    selected: expected.selected,
    next: expected.next
  });
}

export function parseSha256(value, expectedName = null, acceptedAliases = []) {
  if (typeof value !== "string" || value.length > 4_096) {
    throw new Error("brave-checksum-invalid");
  }
  const match = /^([a-fA-F0-9]{64})(?:\s+[*]?([^\r\n]+))?\s*$/u.exec(value);
  if (match === null) throw new Error("brave-checksum-invalid");
  if (expectedName !== null && match[2] !== undefined) {
    const supplied = match[2].trim();
    const acceptedNames = new Set([expectedName, ...acceptedAliases]);
    if (!acceptedNames.has(supplied)) {
      throw new Error(`brave-checksum-wrong-asset:${supplied}`);
    }
  }
  return match[1].toLowerCase();
}

export function updatePolicyWithBraveBuilds(policy, braveBuilds, resolvedAt) {
  if (policy === null || typeof policy !== "object" || !Array.isArray(policy.slots)) {
    throw new Error("brave-policy-invalid");
  }
  const copy = structuredClone(policy);
  copy.inventoryResolvedAt = new Date(resolvedAt).toISOString();
  copy.braveBuilds = structuredClone(braveBuilds);
  for (const slot of copy.slots) {
    if (slot?.browser?.brand !== "Brave") continue;
    const role = slot.braveBuild;
    const build = braveBuilds[role];
    if (build === undefined) throw new Error(`brave-slot-role-invalid:${String(role)}`);
    slot.browser.version = build.version;
    slot.browser.engineVersion = build.chromiumVersion;
    slot.provider.browserVersionLabel = build.version;
    const marker = String(slot.id).lastIndexOf("-brave-");
    if (marker <= 0) throw new Error(`brave-slot-id-invalid:${String(slot.id)}`);
    slot.id = `${String(slot.id).slice(0, marker)}-brave-${build.version.replaceAll(".", "-")}`;
  }
  assertUniqueSlotIds(copy.slots);
  assertCertificationPolicyIntegrity(copy);
  return copy;
}

export function assertPolicyFinalized(policy) {
  assertCertificationPolicyIntegrity(policy);
  if (policy?.inventoryState !== "resolved" ||
      !Array.isArray(policy.unresolvedProductVersionSlotIds) ||
      policy.unresolvedProductVersionSlotIds.length !== 0) {
    throw new Error("certification-policy-inventory-unresolved");
  }
  for (const slot of policy.slots ?? []) {
    if (!VERSION_PATTERN.test(String(slot?.browser?.version ?? ""))) {
      throw new Error(`certification-policy-browser-version-unresolved:${String(slot?.id)}`);
    }
  }
  return policy;
}

export function assertCertificationPolicyIntegrity(policy) {
  if (policy === null || typeof policy !== "object" || !Array.isArray(policy.slots)) {
    throw new Error("certification-policy-invalid");
  }
  const current = policy.braveBuilds?.current?.version;
  const boundary = policy.braveBuilds?.boundary?.version;
  if (!/^[0-9]+(?:\.[0-9]+){2}$/u.test(String(current)) ||
      !/^[0-9]+(?:\.[0-9]+){2}$/u.test(String(boundary))) {
    throw new Error("certification-policy-brave-builds-invalid");
  }
  const braveSuffixes = [current, boundary].map((version) =>
    String(version).replaceAll(".", "-")
  );
  const desktopBrowserIds = (prefix, safariVersions = []) => [
    ...safariVersions.map((version) => `${prefix}-safari-${version}`),
    ...["150", "149", "148", "127"].map((version) => `${prefix}-chrome-${version}`),
    ...["152", "151", "150", "130"].map((version) => `${prefix}-firefox-${version}`),
    `${prefix}-firefox-129-sentinel`,
    `${prefix}-firefox-128-sentinel`
  ];
  const expected = [
    ...desktopBrowserIds("windows-11"),
    ...braveSuffixes.map((version) => `windows-server-2025-brave-${version}`),
    ...desktopBrowserIds("macos-26-4", ["26-4"]),
    ...braveSuffixes.map((version) => `macos-26-4-brave-${version}`),
    ...desktopBrowserIds("macos-15-4", ["18-4"]),
    ...braveSuffixes.map((version) => `macos-15-4-brave-${version}`),
    "ios-26-5-iphone-17-safari",
    "ios-26-4-iphone-17-safari",
    "ios-26-0-iphone-17-safari",
    "ios-18-6-iphone-16-safari",
    "android-17-pixel-9-chrome",
    "android-16-pixel-9-chrome",
    "android-15-galaxy-s25-chrome"
  ];
  const actual = policy.slots.map(({ id }) => id);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    const expectedSet = new Set(expected);
    const actualSet = new Set(actual);
    const missing = expected.find((id) => !actualSet.has(id));
    const extra = actual.find((id) => !expectedSet.has(id));
    throw new Error(
      `certification-policy-slot-set-invalid:${String(missing ?? "none")}:${String(extra ?? "none")}`
    );
  }
  return policy;
}

async function releaseToBuild(role, release, readChecksum, expectedChromiumVersion) {
  const version = releaseVersion(release);
  if (version === null) throw new Error("brave-release-version-invalid");
  const chromiumVersion = parseChromiumVersion(release);
  if (chromiumVersion === null) throw new Error(`brave-chromium-version-missing:${version}`);
  if (expectedChromiumVersion !== null && expectedChromiumVersion !== chromiumVersion) {
    throw new Error(`brave-chromium-version-mismatch:${version}`);
  }
  const releaseUrl = assertOfficialReleaseUrl(release.html_url, version);
  const assets = {};
  for (const [platform, expectedName] of Object.entries(PLATFORM_ASSET_NAMES)) {
    assets[platform] = await resolveAsset(
      release,
      version,
      chromiumVersion,
      expectedName,
      readChecksum
    );
  }
  return Object.freeze({
    role,
    channel: "stable",
    version,
    chromiumVersion,
    releaseDate: new Date(release.published_at).toISOString(),
    releaseUrl,
    assets: Object.freeze(assets)
  });
}

async function resolveAsset(release, version, chromiumVersion, expectedName, readChecksum) {
  const matches = (release.assets ?? []).filter((asset) => asset?.name === expectedName);
  if (matches.length !== 1) {
    throw new Error(`brave-asset-count:${version}:${expectedName}:${String(matches.length)}`);
  }
  const asset = matches[0];
  const url = assertVersionedAssetUrl(asset.browser_download_url, version, expectedName);
  if (!Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > 536_870_912) {
    throw new Error(`brave-asset-size-invalid:${expectedName}`);
  }
  let sha256 = directAssetDigest(asset.digest);
  if (sha256 === null) {
    const checksumName = `${expectedName}.sha256`;
    const checksumMatches = (release.assets ?? []).filter((candidate) => candidate?.name === checksumName);
    if (checksumMatches.length !== 1) {
      throw new Error(`brave-asset-unsigned:${version}:${expectedName}`);
    }
    const checksumUrl = assertVersionedAssetUrl(
      checksumMatches[0].browser_download_url,
      version,
      checksumName
    );
    const acceptedAliases = expectedName === "BraveBrowserStandaloneSetup.exe"
      ? [`BraveBrowserStandaloneSetup_${chromiumVersion.split(".")[0]}_${version.replaceAll(".", "_")}.exe`]
      : [];
    sha256 = parseSha256(
      await readChecksum(checksumMatches[0], checksumUrl),
      expectedName,
      acceptedAliases
    );
  }
  return Object.freeze({ name: expectedName, url, sha256, size: asset.size });
}

function directAssetDigest(value) {
  if (value === null || value === undefined || value === "") return null;
  const match = /^sha256:([a-f0-9]{64})$/u.exec(String(value));
  if (match === null) throw new Error("brave-asset-digest-invalid");
  return match[1];
}

async function defaultChecksumReader(_asset, url) {
  const { response } = await fetchWithBoundedRedirects(url, { purpose: "asset" });
  return response.text();
}

function assertOfficialReleaseUrl(value, version) {
  const url = assertOfficialHttpsUrl(value, "release");
  const expected = `/brave/brave-browser/releases/tag/v${version}`;
  if (url.hostname !== "github.com" || url.pathname !== expected || url.search !== "" ||
      url.hash !== "") throw new Error(`brave-release-url-invalid:${url.href}`);
  return url.href;
}

function assertVersionedAssetUrl(value, version, name) {
  const url = assertOfficialHttpsUrl(value, "asset");
  const expected = `/brave/brave-browser/releases/download/v${version}/${encodeURIComponent(name).replaceAll("%2F", "/")}`;
  if (url.hostname !== "github.com" || url.pathname !== expected || url.search !== "" ||
      url.hash !== "") throw new Error(`brave-asset-wrong-version:${url.href}`);
  return url.href;
}

function parseChromiumVersion(release) {
  const text = `${String(release.name ?? "")}\n${String(release.body ?? "")}`;
  const match = /\bChromium ([0-9]+(?:\.[0-9]+){3})\b/u.exec(text);
  return match === null ? null : match[1];
}

function releaseVersion(release) {
  const match = RELEASE_TAG_PATTERN.exec(String(release?.tag_name ?? ""));
  return match === null ? null : match[1];
}

function normalizeVersion(value) {
  if (typeof value !== "string") return null;
  const normalized = value.startsWith("v") ? value.slice(1) : value;
  return /^[0-9]+(?:\.[0-9]+){2}$/u.test(normalized) ? normalized : null;
}

function parseBoundaryDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(String(value))) {
    throw new Error(`brave-boundary-date-invalid:${String(value)}`);
  }
  const instant = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(instant)) throw new Error(`brave-boundary-date-invalid:${String(value)}`);
  return instant;
}

function isDateTime(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function comparePublishedThenVersion(left, right) {
  const time = Date.parse(left.published) - Date.parse(right.published);
  return time === 0 ? compareVersions(left.version, right.version) : time;
}

function compareVersions(left, right) {
  const leftParts = String(left).split(".").map(Number);
  const rightParts = String(right).split(".").map(Number);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function assertUniqueSlotIds(slots) {
  const ids = new Set();
  for (const slot of slots) {
    if (ids.has(slot.id)) throw new Error(`certification-policy-duplicate-slot:${slot.id}`);
    ids.add(slot.id);
  }
}

async function fetchJson(url, purpose, options = {}) {
  const { response } = await fetchWithBoundedRedirects(url, { purpose, ...options });
  return response.json();
}

async function fetchLiveResolutionInputs(boundaryDate, pinnedBoundaryVersion) {
  const githubHeaders = {
    Accept: "application/vnd.github+json",
    "User-Agent": "aval-browser-certification"
  };
  if (process.env.GITHUB_TOKEN) githubHeaders.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const versionsResponse = await fetchJson(BRAVE_VERSIONS_URL, "versions");
  const normalized = normalizeVersionsInventory(versionsResponse)
    .filter((entry) => entry.channel === "release")
    .sort(comparePublishedThenVersion);
  const current = normalized.at(-1);
  if (current === undefined) throw new Error("brave-current-stable-missing");
  const currentRelease = await fetchJson(
    `${BRAVE_RELEASES_API}/tags/v${current.version}`,
    "api",
    { headers: githubHeaders }
  );
  if (!/^[0-9]+(?:\.[0-9]+){2}$/u.test(String(pinnedBoundaryVersion))) {
    throw new Error("brave-policy-boundary-version-invalid");
  }
  const expected = BOUNDARY_ADJACENT_STABLE_RELEASES[boundaryDate];
  if (expected === undefined || pinnedBoundaryVersion !== expected.selected) {
    throw new Error("brave-policy-boundary-proof-missing");
  }
  const [previousRelease, boundaryRelease, nextRelease] = await Promise.all(
    [expected.previous, expected.selected, expected.next].map((version) => fetchJson(
      `${BRAVE_RELEASES_API}/tags/v${version}`,
      "api",
      { headers: githubHeaders }
    ))
  );
  assertBoundaryReleaseProof(
    [previousRelease, boundaryRelease, nextRelease],
    boundaryDate,
    pinnedBoundaryVersion
  );
  return {
    versionsResponse,
    releases: [currentRelease, previousRelease, boundaryRelease, nextRelease]
  };
}

function parseArguments(values) {
  const parsed = { boundaryDate: null, check: false, policy: null };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--check") parsed.check = true;
    else if (value === "--boundary-date") parsed.boundaryDate = values[++index] ?? null;
    else if (value === "--policy") parsed.policy = values[++index] ?? null;
    else throw new Error(`unknown argument: ${String(value)}`);
  }
  if (parsed.boundaryDate === null || parsed.policy === null) {
    throw new Error("usage: resolve-builds.mjs --boundary-date YYYY-MM-DD --policy FILE [--check]");
  }
  return parsed;
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const policyPath = resolve(args.policy);
  const policy = JSON.parse(await readFile(policyPath, "utf8"));
  if (policy.boundaryDate !== args.boundaryDate) {
    throw new Error(`brave-policy-boundary-mismatch:${String(policy.boundaryDate)}`);
  }
  const inputs = await fetchLiveResolutionInputs(
    args.boundaryDate,
    policy.braveBuilds?.boundary?.version
  );
  const builds = await resolveOfficialBuilds({ ...inputs, boundaryDate: args.boundaryDate });
  const resolvedPolicy = updatePolicyWithBraveBuilds(
    policy,
    builds,
    args.check ? policy.inventoryResolvedAt : new Date().toISOString()
  );
  if (args.check) {
    if (JSON.stringify(policy) !== JSON.stringify(resolvedPolicy)) {
      throw new Error("brave-policy-builds-stale");
    }
  } else {
    const temporaryPath = resolve(dirname(policyPath), `.${fileURLToPath(import.meta.url).split("/").at(-1)}.${String(process.pid)}.tmp`);
    await writeFile(temporaryPath, `${JSON.stringify(resolvedPolicy, null, 2)}\n`, { flag: "wx" });
    await rename(temporaryPath, policyPath);
  }
  process.stdout.write(`${JSON.stringify({
    boundary: builds.boundary.version,
    current: builds.current.version,
    policy: policyPath,
    status: args.check ? "verified" : "updated"
  })}\n`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
