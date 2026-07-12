export interface RuntimeHeadersView {
  get(name: string): string | null;
}

export type RuntimeExpectedHttpStatus = 200 | 206 | "range-or-full";

export interface RuntimeHttpResponseContractInput {
  readonly status: number;
  readonly expectedStatus: RuntimeExpectedHttpStatus;
  readonly responseType: string;
  readonly finalUrl: string;
  readonly pinnedFinalUrl?: string;
  readonly bodyAvailable: boolean;
  readonly headers: RuntimeHeadersView;
  readonly expectedBodyBytes?: number;
  readonly maximumBodyBytes: number;
}

export interface ValidatedRuntimeHttpResponse {
  readonly status: 200 | 206;
  readonly finalUrl: string;
  readonly contentLength: number | null;
}

/** Invoke a Headers-like accessor once and normalize hostile access failures. */
export function readRuntimeHeader(
  headers: RuntimeHeadersView,
  name: string
): string | null {
  let value: unknown;
  try {
    const get = headers.get;
    if (typeof get !== "function") {
      throw new TypeError("missing header getter");
    }
    value = get.call(headers, name);
  } catch {
    throw new RangeError("response header access failed");
  }
  if (value !== null && typeof value !== "string") {
    throw new RangeError("response header value is invalid");
  }
  return value;
}

export function parseCanonicalContentLength(value: string | null): number | null {
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new RangeError("Content-Length must be a string");
  }
  const match = /^[\t ]*([0-9]+)[\t ]*$/.exec(value);
  if (match === null || !/^(?:0|[1-9][0-9]*)$/.test(match[1]!)) {
    throw new RangeError("Content-Length is not canonical");
  }
  const parsed = Number(match[1]);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < 0 ||
    String(parsed) !== match[1]
  ) {
    throw new RangeError("Content-Length is outside the safe range");
  }
  return parsed;
}

export function validateIdentityContentEncoding(
  value: string | null
): "identity" | null {
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new RangeError("Content-Encoding must be a string");
  }
  const match = /^[\t ]*([^\t ]+)[\t ]*$/.exec(value);
  if (match === null || match[1]!.toLowerCase() !== "identity") {
    throw new RangeError("Content-Encoding must be absent or identity");
  }
  return "identity";
}

/** Validate response metadata without retaining the Response or raw headers. */
export function validateRuntimeHttpResponse(
  input: Readonly<RuntimeHttpResponseContractInput>
): Readonly<ValidatedRuntimeHttpResponse> {
  const values = readContractInput(input);
  validatePositiveSafeInteger(values.maximumBodyBytes, "maximum body bytes");
  if (values.expectedBodyBytes !== undefined) {
    validateNonNegativeSafeInteger(
      values.expectedBodyBytes,
      "expected body bytes"
    );
    if (values.expectedBodyBytes > values.maximumBodyBytes) {
      throw new RangeError("expected body bytes exceed the active cap");
    }
  }
  validateStatus(values.status, values.expectedStatus);
  if (
    values.responseType !== "basic" &&
    values.responseType !== "cors" &&
    values.responseType !== "default"
  ) {
    throw new RangeError("response type is unusable");
  }
  validateFinalHttpUrl(values.finalUrl);
  if (
    values.pinnedFinalUrl !== undefined &&
    values.finalUrl !== values.pinnedFinalUrl
  ) {
    throw new RangeError("response final URL changed");
  }
  if (values.bodyAvailable !== true) {
    throw new RangeError("response body is unavailable");
  }

  validateIdentityContentEncoding(
    readRuntimeHeader(values.headers, "Content-Encoding")
  );
  const contentLength = parseCanonicalContentLength(
    readRuntimeHeader(values.headers, "Content-Length")
  );
  if (contentLength !== null) {
    if (contentLength > values.maximumBodyBytes) {
      throw new RangeError("Content-Length exceeds the active cap");
    }
    if (
      values.expectedBodyBytes !== undefined &&
      contentLength !== values.expectedBodyBytes
    ) {
      throw new RangeError("Content-Length does not match the expected body");
    }
  }

  return Object.freeze({
    status: values.status,
    finalUrl: values.finalUrl,
    contentLength
  });
}

function readContractInput(
  input: Readonly<RuntimeHttpResponseContractInput>
): RuntimeHttpResponseContractInput {
  try {
    const status = input.status;
    const expectedStatus = input.expectedStatus;
    const responseType = input.responseType;
    const finalUrl = input.finalUrl;
    const pinnedFinalUrl = input.pinnedFinalUrl;
    const bodyAvailable = input.bodyAvailable;
    const headers = input.headers;
    const expectedBodyBytes = input.expectedBodyBytes;
    const maximumBodyBytes = input.maximumBodyBytes;
    return {
      status,
      expectedStatus,
      responseType,
      finalUrl,
      ...(pinnedFinalUrl === undefined
        ? {}
        : { pinnedFinalUrl }),
      bodyAvailable,
      headers,
      ...(expectedBodyBytes === undefined
        ? {}
        : { expectedBodyBytes }),
      maximumBodyBytes
    };
  } catch {
    throw new RangeError("response contract access failed");
  }
}

function validateStatus(
  status: unknown,
  expected: RuntimeExpectedHttpStatus
): asserts status is 200 | 206 {
  if (status !== 200 && status !== 206) {
    throw new RangeError("response status is unusable");
  }
  if (expected !== "range-or-full" && status !== expected) {
    throw new RangeError("response status does not match the request contract");
  }
}

function validateFinalHttpUrl(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length < 1) {
    throw new RangeError("response final URL is unavailable");
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x20 || code === 0x7f) {
      throw new RangeError("response final URL is invalid");
    }
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new RangeError("response final URL is invalid");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new RangeError("response final URL is not HTTP");
  }
}

function validateNonNegativeSafeInteger(
  value: unknown,
  label: string
): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
}

function validatePositiveSafeInteger(
  value: unknown,
  label: string
): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
}
