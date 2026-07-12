/** Maximum UTF-16 code units retained from a runtime failure message. */
export const MAX_RUNTIME_FAILURE_MESSAGE_LENGTH = 512 as const;
/** Maximum UTF-16 code units retained from one structured diagnostic string. */
export const MAX_RUNTIME_DIAGNOSTIC_TEXT_LENGTH = 128 as const;

export const RUNTIME_FAILURE_CODES = Object.freeze([
  "invalid-asset",
  "unsupported-profile",
  "resource-rejection",
  "readiness-failure",
  "worker-decode-failure",
  "renderer-failure",
  "watchdog-timeout",
  "underflow",
  "abort",
  "disposed"
] as const);

export type RuntimeFailureCode = (typeof RUNTIME_FAILURE_CODES)[number];

/**
 * IDs and counters stay structured so diagnostics never need to interpolate
 * untrusted asset data into a message or markup.
 */
export interface RuntimeFailureContext {
  readonly rendition?: string;
  readonly profile?: string;
  readonly codec?: string;
  readonly unit?: string;
  readonly state?: string;
  readonly edge?: string;
  readonly staticFrame?: string;
  readonly path?: string;
  readonly operation?: string;
  readonly sourceCode?: string;
  readonly sourcePath?: string;
  readonly offset?: number;
  readonly generation?: number;
  readonly ordinal?: number;
  readonly localFrame?: number;
  readonly rank?: number;
}

export interface RuntimeFailure {
  readonly code: RuntimeFailureCode;
  readonly message: string;
  readonly context: Readonly<RuntimeFailureContext>;
}

const DEFAULT_FAILURE_MESSAGES: Readonly<Record<RuntimeFailureCode, string>> =
  Object.freeze({
    "invalid-asset": "installed animation asset is invalid",
    "unsupported-profile": "opaque animation profile is unsupported",
    "resource-rejection": "animation resource budget was rejected",
    "readiness-failure": "animation readiness failed",
    "worker-decode-failure": "animation decoder worker failed",
    "renderer-failure": "animation renderer failed",
    "watchdog-timeout": "animation watchdog expired",
    underflow: "animation presentation underflowed",
    abort: "animation operation was aborted",
    disposed: "animation player is disposed"
  });

/** A stable thrown form of a normalized runtime failure. */
export class RuntimePlaybackError extends Error {
  public declare readonly code: RuntimeFailureCode;
  public declare readonly failure: Readonly<RuntimeFailure>;

  public constructor(failure: Readonly<RuntimeFailure>) {
    super(failure.message);

    Object.defineProperties(this, {
      name: {
        value: "RuntimePlaybackError",
        enumerable: false,
        configurable: false,
        writable: false
      },
      code: {
        value: failure.code,
        enumerable: true,
        configurable: false,
        writable: false
      },
      failure: {
        value: failure,
        enumerable: true,
        configurable: false,
        writable: false
      }
    });

    Object.freeze(this);
  }
}

export function isRuntimePlaybackError(
  error: unknown
): error is RuntimePlaybackError {
  return error instanceof RuntimePlaybackError;
}

/**
 * Convert an unknown boundary failure into a bounded immutable value. Hostile
 * objects are not stringified and their accessors are never inspected.
 */
export function normalizeRuntimeFailure(
  code: RuntimeFailureCode,
  cause?: unknown,
  context: Readonly<RuntimeFailureContext> = {}
): Readonly<RuntimeFailure> {
  if (
    cause instanceof RuntimePlaybackError &&
    cause.code === code &&
    hasNoContext(context)
  ) {
    return cause.failure;
  }

  const message = boundedMessage(
    messageFrom(cause),
    DEFAULT_FAILURE_MESSAGES[code]
  );
  return Object.freeze({
    code,
    message,
    context: normalizeContext(context)
  });
}

function messageFrom(cause: unknown): string | null {
  if (typeof cause === "string") {
    return cause;
  }
  if (!(cause instanceof Error)) {
    return null;
  }

  // Native Error instances store message as an own data property. Refuse an
  // inherited or accessor-backed message rather than executing hostile code.
  const descriptor = Object.getOwnPropertyDescriptor(cause, "message");
  return descriptor !== undefined && typeof descriptor.value === "string"
    ? descriptor.value
    : null;
}

function boundedMessage(candidate: string | null, fallback: string): string {
  const source = candidate !== null && candidate.length > 0
    ? candidate
    : fallback;
  return truncateUtf16(source, MAX_RUNTIME_FAILURE_MESSAGE_LENGTH);
}

function normalizeContext(
  context: Readonly<RuntimeFailureContext>
): Readonly<RuntimeFailureContext> {
  try {
    const normalized: {
      rendition?: string;
      profile?: string;
      codec?: string;
      unit?: string;
      state?: string;
      edge?: string;
      staticFrame?: string;
      path?: string;
      operation?: string;
      sourceCode?: string;
      sourcePath?: string;
      offset?: number;
      generation?: number;
      ordinal?: number;
      localFrame?: number;
      rank?: number;
    } = {};

    copyText(context, normalized, "rendition");
    copyText(context, normalized, "profile");
    copyText(context, normalized, "codec");
    copyText(context, normalized, "unit");
    copyText(context, normalized, "state");
    copyText(context, normalized, "edge");
    copyText(context, normalized, "staticFrame");
    copyText(context, normalized, "path");
    copyText(context, normalized, "operation");
    copyText(context, normalized, "sourceCode");
    copyText(context, normalized, "sourcePath");
    copyInteger(context, normalized, "offset");
    copyInteger(context, normalized, "generation");
    copyInteger(context, normalized, "ordinal");
    copyInteger(context, normalized, "localFrame");
    copyInteger(context, normalized, "rank");

    return Object.freeze(normalized);
  } catch {
    return Object.freeze({});
  }
}

type MutableFailureContext = {
  -readonly [Key in keyof RuntimeFailureContext]?: RuntimeFailureContext[Key];
};

type TextContextKey = {
  [Key in keyof RuntimeFailureContext]-?: RuntimeFailureContext[Key] extends
    | string
    | undefined
    ? Key
    : never;
}[keyof RuntimeFailureContext];

type IntegerContextKey =
  | "offset"
  | "generation"
  | "ordinal"
  | "localFrame"
  | "rank";

function copyText(
  source: Readonly<RuntimeFailureContext>,
  target: MutableFailureContext,
  key: TextContextKey
): void {
  const value = source[key];
  if (typeof value === "string" && value.length > 0) {
    target[key] = truncateUtf16(
      value,
      MAX_RUNTIME_DIAGNOSTIC_TEXT_LENGTH
    );
  }
}

function copyInteger(
  source: Readonly<RuntimeFailureContext>,
  target: MutableFailureContext,
  key: IntegerContextKey
): void {
  const value = source[key];
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    target[key] = value;
  }
}

function truncateUtf16(value: string, maximum: number): string {
  if (value.length <= maximum) {
    return value;
  }
  let result = value.slice(0, maximum);
  const last = result.charCodeAt(result.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) {
    result = result.slice(0, -1);
  }
  return result;
}

function hasNoContext(context: Readonly<RuntimeFailureContext>): boolean {
  try {
    return Object.keys(context).length === 0;
  } catch {
    return false;
  }
}
