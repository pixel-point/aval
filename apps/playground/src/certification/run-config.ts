import {
  FUNCTIONAL_FIXTURE_DIGEST,
  FUNCTIONAL_SOURCE_URL
} from "./functional-fixture.js";

const SHA256 = /^[0-9a-f]{64}$/u;
const IDENTIFIER = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const MAX_CONFIG_BYTES = 256 * 1024;
const FETCH_WATCHDOG_MS = 20_000;
const CANDIDATE_RUN_CONFIG_PATH = "/__aval_certification__/run-config.json";

export type CertificationRunMode = "functional" | "named";
export type CertificationRunProfile = "pull-request" | "release" | "named";

export interface CertificationRunConfig {
  readonly schemaVersion: "1.0";
  readonly runId: string;
  readonly mode: CertificationRunMode;
  readonly profile: CertificationRunProfile;
  readonly candidateManifestDigest: string;
  readonly fixtureDigest: string;
  readonly harnessDigest: string;
  readonly commit: string;
  readonly tree: string;
  readonly operatorRole: string;
  readonly sourceUrl: string;
  readonly profileClean: boolean;
  readonly expectedRepetitions: number;
  readonly environment: Readonly<Record<string, unknown>>;
}

export function createFunctionalRunConfig(): CertificationRunConfig {
  return Object.freeze({
    schemaVersion: "1.0",
    runId: "playwright-functional-engine",
    mode: "functional",
    profile: "pull-request",
    candidateManifestDigest: "0".repeat(64),
    fixtureDigest: FUNCTIONAL_FIXTURE_DIGEST,
    harnessDigest: "0".repeat(64),
    commit: "functional-engine-run",
    tree: "functional-engine-run",
    operatorRole: "automated-functional-check",
    sourceUrl: FUNCTIONAL_SOURCE_URL,
    profileClean: false,
    expectedRepetitions: 1,
    environment: Object.freeze({
      evidenceClass: "playwright-functional-engine",
      brandedBrowserCertification: false,
      observedDisplayEvidence: false
    })
  });
}

export async function loadRunConfig(): Promise<CertificationRunConfig> {
  const query = new URL(location.href).searchParams.get("run-config");
  if (query === null) {
    return await loadCandidateRunConfig() ?? createFunctionalRunConfig();
  }
  const url = new URL(query, location.href);
  if (url.origin !== location.origin || url.username !== "" || url.password !== "") {
    throw new Error("run config must be a same-origin public path");
  }
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(new DOMException("run config watchdog expired", "TimeoutError")), FETCH_WATCHDOG_MS);
  try {
    const response = await fetch(url, {
      cache: "no-store",
      credentials: "same-origin",
      redirect: "error",
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`run config fetch failed with ${String(response.status)}`);
    const bytes = await readBoundedResponseBytes(response, MAX_CONFIG_BYTES, "run config");
    return validateRunConfig(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown);
  } finally {
    window.clearTimeout(timeout);
  }
}

async function loadCandidateRunConfig(): Promise<CertificationRunConfig | null> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(new DOMException("candidate run config watchdog expired", "TimeoutError")), FETCH_WATCHDOG_MS);
  try {
    const response = await fetch(CANDIDATE_RUN_CONFIG_PATH, {
      cache: "no-store",
      credentials: "same-origin",
      redirect: "error",
      signal: controller.signal
    });
    if (response.headers.get("x-aval-candidate-run-config") !== "1") {
      await response.body?.cancel();
      return null;
    }
    if (!response.ok) throw new Error(`candidate run config fetch failed with ${String(response.status)}`);
    const expectedDigest = response.headers.get("x-aval-candidate-manifest-sha256");
    if (expectedDigest === null || !SHA256.test(expectedDigest)) throw new Error("candidate run config response has no valid candidate identity");
    const bytes = await readBoundedResponseBytes(response, MAX_CONFIG_BYTES, "candidate run config");
    const config = validateRunConfig(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown);
    if (config.candidateManifestDigest !== expectedDigest) throw new Error("candidate run config identity does not match its serving candidate");
    return config;
  } finally {
    window.clearTimeout(timeout);
  }
}

export function validateRunConfig(value: unknown): CertificationRunConfig {
  const input = record(value, "run config");
  const allowed = new Set([
    "schemaVersion", "runId", "mode", "profile", "candidateManifestDigest",
    "fixtureDigest", "harnessDigest", "commit", "tree", "operatorRole",
    "sourceUrl", "profileClean", "expectedRepetitions", "environment",
    "createdAt"
  ]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw new TypeError(`run config contains unsupported field ${key}`);
  }
  if (input.schemaVersion !== "1.0") throw new TypeError("run config schemaVersion must be 1.0");
  const mode = enumeration(input.mode, ["functional", "named"] as const, "mode");
  const profile = enumeration(input.profile, ["pull-request", "release", "named"] as const, "profile");
  if (mode === "named" && profile !== "named") throw new TypeError("named mode requires the named profile");
  const source = new URL(text(input.sourceUrl, "sourceUrl", 1, 1024), location.href);
  if (source.origin !== location.origin || source.username !== "" || source.password !== "") {
    throw new TypeError("sourceUrl must be same-origin and credential-free");
  }
  const environment = record(input.environment, "environment");
  return Object.freeze({
    schemaVersion: "1.0",
    runId: matchingText(input.runId, IDENTIFIER, "runId"),
    mode,
    profile,
    candidateManifestDigest: matchingText(input.candidateManifestDigest, SHA256, "candidateManifestDigest"),
    fixtureDigest: matchingText(input.fixtureDigest, SHA256, "fixtureDigest"),
    harnessDigest: matchingText(input.harnessDigest, SHA256, "harnessDigest"),
    commit: text(input.commit, "commit", 1, 128),
    tree: text(input.tree, "tree", 1, 128),
    operatorRole: text(input.operatorRole, "operatorRole", 1, 128),
    sourceUrl: `${source.pathname}${source.search}`,
    profileClean: boolean(input.profileClean, "profileClean"),
    expectedRepetitions: integer(input.expectedRepetitions, "expectedRepetitions", 1, 3),
    environment: Object.freeze(structuredClone(environment))
  });
}

export async function verifySourceDigest(
  sourceUrl: string,
  expectedSha256: string,
  maximumBytes = 16 * 1024 * 1024
): Promise<Readonly<{ sha256: string; byteLength: number; matched: boolean }>> {
  const loaded = await fetchVerifiedSource(sourceUrl, expectedSha256, maximumBytes);
  return loaded.evidence;
}

export async function fetchVerifiedSource(
  sourceUrl: string,
  expectedSha256: string,
  maximumBytes = 16 * 1024 * 1024
): Promise<Readonly<{
  evidence: Readonly<{ sha256: string; byteLength: number; matched: boolean }>;
  bytes: Uint8Array;
}>> {
  if (!SHA256.test(expectedSha256)) throw new TypeError("expected source digest is invalid");
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 256 * 1024 * 1024) {
    throw new RangeError("source byte limit is invalid");
  }
  const url = new URL(sourceUrl, location.href);
  if (url.origin !== location.origin) throw new TypeError("certification source must be same-origin");
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(new DOMException("certification source watchdog expired", "TimeoutError")), FETCH_WATCHDOG_MS);
  let bytes: Uint8Array;
  try {
    const response = await fetch(url, {
      cache: "no-store",
      credentials: "same-origin",
      redirect: "error",
      signal: controller.signal,
      headers: { Accept: "application/vnd.aval, application/octet-stream" }
    });
    if (!response.ok) throw new Error(`certification source fetch failed with ${String(response.status)}`);
    bytes = await readBoundedResponseBytes(response, maximumBytes, "source");
  } finally {
    window.clearTimeout(timeout);
  }
  const digestInput = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(digestInput).set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", digestInput);
  const sha256 = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return Object.freeze({
    evidence: Object.freeze({ sha256, byteLength: bytes.byteLength, matched: sha256 === expectedSha256 }),
    bytes
  });
}

/** Reads at most max+1 bytes and cancels the stream immediately on overflow. */
export async function readBoundedResponseBytes(response: Response, maximumBytes: number, label: string): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 256 * 1024 * 1024) throw new RangeError("response byte limit is invalid");
  const declaredText = response.headers.get("content-length");
  if (declaredText !== null) {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(declaredText)) throw new TypeError(`${label} content-length is invalid`);
    const declared = Number(declaredText);
    if (!Number.isSafeInteger(declared) || declared > maximumBytes) throw new RangeError(`${label} exceeds byte limit`);
  }
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error(`${label} response has no bounded readable body`);
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array) || value.byteLength === 0) continue;
      total += value.byteLength;
      if (!Number.isSafeInteger(total) || total > maximumBytes) {
        await reader.cancel(`${label} exceeded byte limit`).catch(() => undefined);
        throw new RangeError(`${label} exceeds byte limit`);
      }
      chunks.push(value.slice());
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

export function externalIntegrityFromSha256(sha256: string): string {
  if (!SHA256.test(sha256)) throw new TypeError("source digest is invalid");
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = Number.parseInt(sha256.slice(index * 2, index * 2 + 2), 16);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `sha256-${btoa(binary)}`;
}

export function assertRunnableForeground(
  config: CertificationRunConfig,
  sourceMatched: boolean
): void {
  if (config.mode !== "named") return;
  if (document.visibilityState !== "visible") throw new Error("certification document is hidden");
  if (!document.hasFocus()) throw new Error("certification document is not focused");
  if (!config.profileClean) throw new Error("named certification requires a clean browser profile");
  if (!sourceMatched) throw new Error("candidate source digest does not match");
  if (import.meta.env.DEV) throw new Error("named certification refuses a Vite development build");
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, name: string, minimum: number, maximum: number): string {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum) throw new TypeError(`${name} is invalid`);
  return value;
}

function matchingText(value: unknown, pattern: RegExp, name: string): string {
  const checked = text(value, name, 1, 128);
  if (!pattern.test(checked)) throw new TypeError(`${name} is invalid`);
  return checked;
}

function enumeration<const T extends readonly string[]>(value: unknown, values: T, name: string): T[number] {
  if (typeof value !== "string" || !values.includes(value)) throw new TypeError(`${name} is invalid`);
  return value as T[number];
}

function boolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${name} must be boolean`);
  return value;
}

function integer(value: unknown, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) throw new RangeError(`${name} is invalid`);
  return value as number;
}
