import type { RuntimeEntityIdentity } from "./model.js";
import type { BoundedBodyResult } from "./bounded-body-reader.js";
import {
  formatInclusiveByteRange,
  type RuntimeInclusiveByteRange
} from "./http-content-range.js";
import { RuntimePlaybackError, normalizeRuntimeFailure } from "./errors.js";

export interface CapturedRuntimePayloadOptions {
  readonly signal: AbortSignal | null;
  readonly overallSignal: AbortSignal | null;
}

export interface RuntimeRangeBodyResult {
  readonly mode: "range";
  readonly range: Readonly<RuntimeInclusiveByteRange>;
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly released: boolean;
  release(): void;
}

export function captureRuntimePayloadOptions(
  options: Readonly<{
    readonly signal?: AbortSignal;
    readonly overallSignal?: AbortSignal;
  }>
): Readonly<CapturedRuntimePayloadOptions> {
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw runtimeError("load-failure");
  }
  let signal: AbortSignal | undefined;
  let overallSignal: AbortSignal | undefined;
  try {
    signal = options.signal;
    overallSignal = options.overallSignal;
  } catch {
    throw runtimeError("load-failure");
  }
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw runtimeError("load-failure");
  }
  if (overallSignal !== undefined && !(overallSignal instanceof AbortSignal)) {
    throw runtimeError("load-failure");
  }
  return Object.freeze({
    signal: signal ?? null,
    overallSignal: overallSignal ?? null
  });
}

export function validateRuntimePayloadRange(
  range: Readonly<RuntimeInclusiveByteRange>,
  identity: Extract<RuntimeEntityIdentity, { readonly mode: "range" }>,
  frontIndexEnd: number,
  maximumRangeBytes: number
): Readonly<RuntimeInclusiveByteRange> {
  let start: number;
  let end: number;
  try {
    start = range.start;
    end = range.end;
  } catch {
    throw runtimeError("range-response-invalid");
  }
  const snapshot = Object.freeze({ start, end });
  try { formatInclusiveByteRange(snapshot); } catch {
    throw runtimeError("range-response-invalid");
  }
  const length = end - start + 1;
  if (
    start < frontIndexEnd || end >= identity.declaredTotalBytes ||
    length > maximumRangeBytes
  ) {
    throw runtimeError("range-response-invalid");
  }
  return snapshot;
}

export function createRuntimeRangeBodyResult(
  range: Readonly<RuntimeInclusiveByteRange>,
  body: Readonly<BoundedBodyResult>
): Readonly<RuntimeRangeBodyResult> {
  let released = false;
  return Object.freeze({
    mode: "range" as const,
    range: Object.freeze({ start: range.start, end: range.end }),
    bytes: body.bytes,
    get released() { return released; },
    release(): void {
      if (released) return;
      released = true;
      body.release();
    }
  });
}

function runtimeError(
  code: "load-failure" | "range-response-invalid"
): RuntimePlaybackError {
  return new RuntimePlaybackError(normalizeRuntimeFailure(code));
}
