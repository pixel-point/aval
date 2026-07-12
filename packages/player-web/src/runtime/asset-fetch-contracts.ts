import { FORMAT_DEFAULT_BUDGETS } from "@rendered-motion/format";

import type { RuntimeBodyReader } from "./bounded-body-reader.js";
import { parseExternalIntegrity, type NormalizedExternalIntegrity } from "./external-integrity.js";
import { readRuntimeHeader, type RuntimeHeadersView } from "./http-response-contract.js";
import {
  DEFAULT_FIRST_BYTE_TIMEOUT_MS,
  DEFAULT_IDLE_BODY_TIMEOUT_MS,
  DEFAULT_LOAD_OVERALL_TIMEOUT_MS
} from "./load-watchdogs.js";
import type { RuntimeAssetRequest, RuntimeLoaderPolicy } from "./model.js";

export const DEFAULT_MAXIMUM_RANGE_BYTES = 4 * 1024 * 1024;
export const DEFAULT_MAXIMUM_CONCURRENT_PAYLOAD_BODIES = 4;
export const DEFAULT_ASSET_LOAD_TIMEOUT_MS = DEFAULT_LOAD_OVERALL_TIMEOUT_MS;
export const DEFAULT_ASSET_FIRST_BYTE_TIMEOUT_MS = DEFAULT_FIRST_BYTE_TIMEOUT_MS;
export const DEFAULT_ASSET_IDLE_BODY_TIMEOUT_MS = DEFAULT_IDLE_BODY_TIMEOUT_MS;

const REQUEST_FIELDS = new Set([
  "url",
  "integrity",
  "signal",
  "timeoutMs",
  "credentials"
]);

export interface NormalizedRuntimeAssetRequest {
  readonly url: string;
  readonly integrity: Readonly<NormalizedExternalIntegrity> | null;
  readonly signal: AbortSignal | null;
  readonly credentials: "omit" | "same-origin" | "include";
  readonly policy: Readonly<RuntimeLoaderPolicy>;
}

/** Internal one-read snapshot used by page-generation signal composition. */
export interface CapturedRuntimeAssetRequest {
  readonly url: string | URL;
  readonly integrity: string | undefined;
  readonly signal: AbortSignal | undefined;
  readonly timeoutMs: number | undefined;
  readonly credentials: "omit" | "same-origin" | "include" | undefined;
}

export interface RuntimeFetchInit {
  readonly method: "GET";
  readonly credentials: "omit" | "same-origin" | "include";
  readonly signal: AbortSignal;
  readonly headers: Readonly<Record<string, string>>;
}

export interface RuntimeFetchResponseView {
  readonly status: number;
  readonly type: string;
  readonly url: string;
  readonly headers: RuntimeHeadersView;
  readonly body: {
    getReader(): RuntimeBodyReader;
  } | null;
}

export interface RuntimeFetchAdapter {
  fetch(
    url: string,
    init: Readonly<RuntimeFetchInit>
  ): PromiseLike<RuntimeFetchResponseView>;
}

export interface RuntimeResponseHeadersSnapshot {
  readonly contentEncoding: string | null;
  readonly contentLength: string | null;
  readonly contentRange: string | null;
  readonly entityTag: string | null;
}

export interface RuntimeFetchResponseSnapshot {
  readonly status: number;
  readonly type: string;
  readonly finalUrl: string;
  readonly headers: Readonly<RuntimeResponseHeadersSnapshot>;
  readonly bodyReader: RuntimeBodyReader;
}

/** Close and normalize the host request before any Fetch operation begins. */
export function normalizeRuntimeAssetRequest(
  request: Readonly<RuntimeAssetRequest>,
  limits: Readonly<{ readonly maximumFileBytes?: number }> = {}
): Readonly<NormalizedRuntimeAssetRequest> {
  const captured = captureRuntimeAssetRequest(request);
  const url = normalizeHttpUrl(captured.url);
  const integrity = captured.integrity === undefined
    ? null
    : parseExternalIntegrity(captured.integrity);
  const signal = captured.signal ?? null;
  const credentials = captured.credentials ?? "same-origin";
  const overallTimeoutMs = captured.timeoutMs ?? DEFAULT_ASSET_LOAD_TIMEOUT_MS;

  let maximumFileBytes = FORMAT_DEFAULT_BUDGETS.maxFileBytes;
  try {
    if (limits.maximumFileBytes !== undefined) {
      maximumFileBytes = limits.maximumFileBytes;
    }
  } catch {
    throw new TypeError("runtime asset limits are inaccessible");
  }
  requirePositiveSafeInteger(maximumFileBytes, "maximum asset file bytes");
  if (maximumFileBytes > FORMAT_DEFAULT_BUDGETS.maxFileBytes) {
    throw new RangeError("maximum asset file bytes exceed the format cap");
  }

  const policy: Readonly<RuntimeLoaderPolicy> = Object.freeze({
    maximumFileBytes,
    maximumRangeBytes: Math.min(DEFAULT_MAXIMUM_RANGE_BYTES, maximumFileBytes),
    maximumConcurrentPayloadBodies: DEFAULT_MAXIMUM_CONCURRENT_PAYLOAD_BODIES,
    overallTimeoutMs,
    firstByteTimeoutMs: Math.min(
      DEFAULT_ASSET_FIRST_BYTE_TIMEOUT_MS,
      overallTimeoutMs
    ),
    idleBodyTimeoutMs: Math.min(
      DEFAULT_ASSET_IDLE_BODY_TIMEOUT_MS,
      overallTimeoutMs
    )
  });
  return Object.freeze({ url, integrity, signal, credentials, policy });
}

/** Reject unknown fields and snapshot every request capability exactly once. */
export function captureRuntimeAssetRequest(
  request: Readonly<RuntimeAssetRequest>
): Readonly<CapturedRuntimeAssetRequest> {
  if (typeof request !== "object" || request === null || Array.isArray(request)) {
    throw new TypeError("runtime asset request must be an object");
  }
  let fields: string[];
  try {
    fields = Object.keys(request);
  } catch {
    throw new TypeError("runtime asset request fields are inaccessible");
  }
  for (const field of fields) {
    if (!REQUEST_FIELDS.has(field)) {
      throw new TypeError("runtime asset request contains an unknown field");
    }
  }

  let urlValue: string | URL;
  let integrityValue: string | undefined;
  let signalValue: AbortSignal | undefined;
  let timeoutValue: number | undefined;
  let credentialsValue: "omit" | "same-origin" | "include" | undefined;
  try {
    urlValue = request.url;
    integrityValue = request.integrity;
    signalValue = request.signal;
    timeoutValue = request.timeoutMs;
    credentialsValue = request.credentials;
  } catch {
    throw new TypeError("runtime asset request values are inaccessible");
  }

  if (!(typeof urlValue === "string" || urlValue instanceof URL)) {
    throw new TypeError("runtime asset URL is invalid");
  }
  if (integrityValue !== undefined && typeof integrityValue !== "string") {
    throw new TypeError("runtime asset integrity is invalid");
  }
  const signal = signalValue === undefined
    ? undefined
    : requireAbortSignal(signalValue);
  if (
    credentialsValue !== undefined &&
    credentialsValue !== "omit" &&
    credentialsValue !== "same-origin" &&
    credentialsValue !== "include"
  ) {
    throw new TypeError("runtime asset credentials are invalid");
  }
  if (timeoutValue !== undefined) {
    requirePositiveSafeInteger(timeoutValue, "asset load timeout");
  }
  return Object.freeze({
    url: urlValue,
    integrity: integrityValue,
    signal,
    timeoutMs: timeoutValue,
    credentials: credentialsValue
  });
}

/**
 * Snapshot the only response metadata M7 accepts and detach one body reader.
 * The Response and Headers objects need not survive this call.
 */
export async function snapshotRuntimeFetchResponse(
  response: RuntimeFetchResponseView
): Promise<Readonly<RuntimeFetchResponseSnapshot>> {
  let body: unknown;
  try {
    body = Reflect.get(response, "body");
  } catch {
    throw new TypeError("fetch response access failed");
  }
  if (body === null || typeof body !== "object") {
    throw new TypeError("fetch response body is unavailable");
  }

  let getReader: unknown;
  let bodyReader: unknown;
  try {
    getReader = Reflect.get(body, "getReader");
    if (typeof getReader !== "function") {
      throw new TypeError("missing reader factory");
    }
    bodyReader = Reflect.apply(getReader, body, []);
  } catch {
    throw new TypeError("fetch response body reader is unavailable");
  }
  if (typeof bodyReader !== "object" || bodyReader === null) {
    throw new TypeError("fetch response body reader is invalid");
  }

  let status: unknown;
  let type: unknown;
  let finalUrl: unknown;
  let headers: unknown;
  try {
    status = Reflect.get(response, "status");
    type = Reflect.get(response, "type");
    finalUrl = Reflect.get(response, "url");
    headers = Reflect.get(response, "headers");
  } catch {
    await retireRuntimeBodyReader(bodyReader as RuntimeBodyReader);
    throw new TypeError("fetch response access failed");
  }
  if (
    typeof status !== "number" ||
    typeof type !== "string" ||
    typeof finalUrl !== "string" ||
    typeof headers !== "object" ||
    headers === null
  ) {
    await retireRuntimeBodyReader(bodyReader as RuntimeBodyReader);
    throw new TypeError("fetch response metadata is invalid");
  }

  let headerSnapshot: Readonly<RuntimeResponseHeadersSnapshot>;
  try {
    const headerView = headers as RuntimeHeadersView;
    headerSnapshot = Object.freeze({
      contentEncoding: readRuntimeHeader(headerView, "Content-Encoding"),
      contentLength: readRuntimeHeader(headerView, "Content-Length"),
      contentRange: readRuntimeHeader(headerView, "Content-Range"),
      entityTag: readRuntimeHeader(headerView, "ETag")
    });
  } catch (cause) {
    await retireRuntimeBodyReader(bodyReader as RuntimeBodyReader);
    throw cause;
  }

  return Object.freeze({
    status,
    type,
    finalUrl,
    headers: headerSnapshot,
    bodyReader: bodyReader as RuntimeBodyReader
  });
}

/** Best-effort terminal retirement for a detached but unconsumed body reader. */
export async function retireRuntimeBodyReader(
  reader: RuntimeBodyReader
): Promise<void> {
  let cancel: unknown;
  let releaseLock: unknown;
  try {
    cancel = Reflect.get(reader, "cancel");
  } catch {
    cancel = null;
  }
  try {
    releaseLock = Reflect.get(reader, "releaseLock");
  } catch {
    releaseLock = null;
  }
  if (typeof cancel === "function") {
    try {
      await Promise.resolve(Reflect.apply(cancel, reader, []));
    } catch {
      // Continue to release the lock after cancellation failure.
    }
  }
  if (typeof releaseLock === "function") {
    try {
      Reflect.apply(releaseLock, reader, []);
    } catch {
      // Logical retirement is complete even if the host unlock throws.
    }
  }
}

/** Adapt the browser Fetch function without granting request-init authority. */
export function createBrowserRuntimeFetchAdapter(
  fetchFunction: typeof fetch
): Readonly<RuntimeFetchAdapter> {
  if (typeof fetchFunction !== "function") {
    throw new TypeError("browser Fetch function is unavailable");
  }
  return Object.freeze({
    fetch(
      url: string,
      init: Readonly<RuntimeFetchInit>
    ): PromiseLike<RuntimeFetchResponseView> {
      return Reflect.apply(fetchFunction, undefined, [url, init]) as Promise<Response>;
    }
  });
}

function normalizeHttpUrl(value: string | URL): string {
  let text: string;
  try {
    text = typeof value === "string" ? value : value.href;
  } catch {
    throw new TypeError("runtime asset URL is inaccessible");
  }
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw new TypeError("runtime asset URL must be absolute");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new TypeError("runtime asset URL must use HTTP or HTTPS");
  }
  return parsed.href;
}

function requireAbortSignal(signal: AbortSignal): AbortSignal {
  if (typeof signal !== "object" || signal === null) {
    throw new TypeError("runtime asset signal must be an AbortSignal");
  }
  let aborted: unknown;
  let add: unknown;
  let remove: unknown;
  try {
    aborted = Reflect.get(signal, "aborted");
    add = Reflect.get(signal, "addEventListener");
    remove = Reflect.get(signal, "removeEventListener");
  } catch {
    throw new TypeError("runtime asset signal is inaccessible");
  }
  if (
    typeof aborted !== "boolean" ||
    typeof add !== "function" ||
    typeof remove !== "function"
  ) {
    throw new TypeError("runtime asset signal must be an AbortSignal");
  }
  return signal;
}

function requirePositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
}
