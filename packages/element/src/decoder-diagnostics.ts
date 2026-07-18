export type DecoderDiagnosticPhase =
  | "probe"
  | "configure"
  | "decode"
  | "flush"
  | "output-validation"
  | "frame-transfer";

export type DecoderDiagnosticCode =
  | "unsupported-config"
  | "decoder-operation"
  | "invalid-output"
  | "transport"
  | "watchdog-timeout";

export type DecoderColorSpaceMetadata = readonly [
  primaries: string | null,
  transfer: string | null,
  matrix: string | null,
  fullRange: boolean | null
];

export interface DecoderVisibleRectMetadata {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface DecoderFrameMetadata {
  readonly timestamp: number;
  readonly duration: number | null;
  readonly codedWidth: number;
  readonly codedHeight: number;
  readonly displayWidth: number;
  readonly displayHeight: number;
  readonly visibleRect: Readonly<DecoderVisibleRectMetadata> | null;
  readonly colorSpace: DecoderColorSpaceMetadata | null;
}

export interface DecoderFailureDiagnostic {
  readonly phase: DecoderDiagnosticPhase;
  readonly code: DecoderDiagnosticCode;
  readonly run: number | null;
  readonly decodeOrdinal: number | null;
  readonly exception: Readonly<{ name: string; message: string }> | null;
  readonly firstFrame: Readonly<DecoderFrameMetadata> | null;
}

export interface DecoderFailureDiagnosticInput {
  readonly phase: DecoderDiagnosticPhase;
  readonly code: DecoderDiagnosticCode;
  readonly run: number | null;
  readonly decodeOrdinal: number | null;
  readonly reason: unknown;
  readonly firstFrame: Readonly<DecoderFrameMetadata> | null;
}

const PHASES: readonly DecoderDiagnosticPhase[] = Object.freeze([
  "probe",
  "configure",
  "decode",
  "flush",
  "output-validation",
  "frame-transfer"
]);
const CODES: readonly DecoderDiagnosticCode[] = Object.freeze([
  "unsupported-config",
  "decoder-operation",
  "invalid-output",
  "transport",
  "watchdog-timeout"
]);
const DIAGNOSTIC_KEYS = Object.freeze([
  "phase",
  "code",
  "run",
  "decodeOrdinal",
  "exception",
  "firstFrame"
]);
const FRAME_KEYS = Object.freeze([
  "timestamp",
  "duration",
  "codedWidth",
  "codedHeight",
  "displayWidth",
  "displayHeight",
  "visibleRect",
  "colorSpace"
]);
const RECT_KEYS = Object.freeze(["x", "y", "width", "height"]);
const EXCEPTION_KEYS = Object.freeze(["name", "message"]);
const NAME_LIMIT = 64;
const MESSAGE_LIMIT = 512;
const COLOR_TOKEN_LIMIT = 32;
const TEXT_INSPECTION_LIMIT = 1_024;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/gu;
const CONTROL_CHARACTERS_TEST = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const URL_LIKE = /(?:\b[a-z][a-z0-9+.-]{0,31}:(?:\/\/)?[^\s"'<>]+|(?<!:)\/\/[^\s"'<>]+|\bwww\.[^\s"'<>]+)/giu;
const URL_LIKE_TEST = /(?:\b[a-z][a-z0-9+.-]{0,31}:(?:\/\/)?[^\s"'<>]+|(?<!:)\/\/[^\s"'<>]+|\bwww\.[^\s"'<>]+)/iu;
const QUERY_LIKE = /[^\s"'<>]*[?&][^\s"'<>]*=[^\s"'<>]*/gu;
const QUERY_LIKE_TEST = /[^\s"'<>]*[?&][^\s"'<>]*=[^\s"'<>]*/u;
const PATH_LIKE = /[^\s"'<>]*[\\/][^\s"'<>]*/giu;
const PATH_LIKE_TEST = /[^\s"'<>]*[\\/][^\s"'<>]*/iu;
const BARE_HOST = /(?:\b(?:\d{1,3}\.){3}\d{1,3}|\[[0-9a-f:.]+\]|\blocalhost|\b(?:[a-z0-9](?:[a-z0-9-]{0,62})\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59}))(?![a-z0-9-])(?::\d{1,5})?(?:[/?#][^\s"'<>]*)?/giu;
const BARE_HOST_TEST = /(?:\b(?:\d{1,3}\.){3}\d{1,3}|\[[0-9a-f:.]+\]|\blocalhost|\b(?:[a-z0-9](?:[a-z0-9-]{0,62})\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59}))(?![a-z0-9-])(?::\d{1,5})?(?:[/?#][^\s"'<>]*)?/iu;

export function createDecoderFailureDiagnostic(
  input: Readonly<DecoderFailureDiagnosticInput>
): Readonly<DecoderFailureDiagnostic> {
  const diagnostic: DecoderFailureDiagnostic = {
    phase: input.phase,
    code: input.code,
    run: input.run,
    decodeOrdinal: input.decodeOrdinal,
    exception: sanitizeDecoderException(input.reason),
    firstFrame: input.firstFrame
  };
  if (!isDecoderFailureDiagnostic(diagnostic)) {
    throw new TypeError("invalid decoder failure diagnostic");
  }
  return freezeDecoderFailureDiagnostic(diagnostic);
}

export function sanitizeDecoderException(
  reason: unknown
): Readonly<{ name: string; message: string }> | null {
  if (reason === null || reason === undefined) return null;
  let name: string | undefined;
  let message: string | undefined;
  if (typeof reason === "object" || typeof reason === "function") {
    name = readStringProperty(reason, "name");
    message = readStringProperty(reason, "message");
  } else if (typeof reason === "string") {
    message = reason;
  } else {
    try { message = String(reason); } catch { /* no diagnostic text */ }
  }
  const sanitized = {
    name: sanitizeText(name ?? "Error", NAME_LIMIT) || "Error",
    message: sanitizeText(message ?? "", MESSAGE_LIMIT)
  };
  return Object.freeze(sanitized);
}

export function captureDecoderFrameMetadata(
  frame: VideoFrame
): Readonly<DecoderFrameMetadata> {
  const visibleRect = frame.visibleRect;
  const colorSpace = frame.colorSpace;
  const metadata: DecoderFrameMetadata = {
    timestamp: frame.timestamp,
    duration: frame.duration,
    codedWidth: frame.codedWidth,
    codedHeight: frame.codedHeight,
    displayWidth: frame.displayWidth,
    displayHeight: frame.displayHeight,
    visibleRect: visibleRect === null
      ? null
      : {
        x: visibleRect.x,
        y: visibleRect.y,
        width: visibleRect.width,
        height: visibleRect.height
      },
    colorSpace: colorSpace === null
      ? null
      : [
        boundedColorToken(colorSpace.primaries),
        boundedColorToken(colorSpace.transfer),
        boundedColorToken(colorSpace.matrix),
        typeof colorSpace.fullRange === "boolean" ? colorSpace.fullRange : null
      ]
  };
  if (!isDecoderFrameMetadata(metadata)) {
    throw new TypeError("invalid decoder output metadata");
  }
  return freezeDecoderFrameMetadata(metadata);
}

export function isDecoderFailureDiagnostic(
  value: unknown
): value is DecoderFailureDiagnostic {
  if (!isRecord(value) || !hasExactKeys(value, DIAGNOSTIC_KEYS)) return false;
  return isPhase(value.phase) &&
    isCode(value.code) &&
    isNullablePositiveSafeInteger(value.run) &&
    isNullableNonNegativeSafeInteger(value.decodeOrdinal) &&
    isDecoderException(value.exception) &&
    (value.firstFrame === null || isDecoderFrameMetadata(value.firstFrame));
}

export function freezeDecoderFailureDiagnostic(
  diagnostic: DecoderFailureDiagnostic
): Readonly<DecoderFailureDiagnostic> {
  if (diagnostic.exception !== null) Object.freeze(diagnostic.exception);
  if (diagnostic.firstFrame !== null) {
    freezeDecoderFrameMetadata(diagnostic.firstFrame);
  }
  return Object.freeze(diagnostic);
}

function freezeDecoderFrameMetadata(
  metadata: DecoderFrameMetadata
): Readonly<DecoderFrameMetadata> {
  if (metadata.visibleRect !== null) Object.freeze(metadata.visibleRect);
  if (metadata.colorSpace !== null) Object.freeze(metadata.colorSpace);
  return Object.freeze(metadata);
}

function isDecoderFrameMetadata(value: unknown): value is DecoderFrameMetadata {
  if (!isRecord(value) || !hasExactKeys(value, FRAME_KEYS)) return false;
  return isNonNegativeSafeInteger(value.timestamp) &&
    isNullableNonNegativeSafeInteger(value.duration) &&
    isPositiveSafeInteger(value.codedWidth) &&
    isPositiveSafeInteger(value.codedHeight) &&
    isPositiveSafeInteger(value.displayWidth) &&
    isPositiveSafeInteger(value.displayHeight) &&
    isVisibleRect(value.visibleRect) &&
    isColorSpace(value.colorSpace);
}

function isDecoderException(
  value: unknown
): value is Readonly<{ name: string; message: string }> | null {
  if (value === null) return true;
  if (!isRecord(value) || !hasExactKeys(value, EXCEPTION_KEYS)) return false;
  return isSanitizedText(value.name, NAME_LIMIT, false) &&
    isSanitizedText(value.message, MESSAGE_LIMIT, true);
}

function isVisibleRect(value: unknown): boolean {
  if (value === null) return true;
  if (!isRecord(value) || !hasExactKeys(value, RECT_KEYS)) return false;
  return isNonNegativeSafeInteger(value.x) &&
    isNonNegativeSafeInteger(value.y) &&
    isPositiveSafeInteger(value.width) &&
    isPositiveSafeInteger(value.height);
}

function isColorSpace(value: unknown): boolean {
  if (value === null) return true;
  if (!Array.isArray(value) || value.length !== 4) return false;
  if (!hasExactArrayKeys(value, ["0", "1", "2", "3", "length"])) {
    return false;
  }
  return isNullableColorToken(value[0]) &&
    isNullableColorToken(value[1]) &&
    isNullableColorToken(value[2]) &&
    (typeof value[3] === "boolean" || value[3] === null);
}

function isNullableColorToken(value: unknown): boolean {
  return value === null || isSanitizedText(value, COLOR_TOKEN_LIMIT, false);
}

function boundedColorToken(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = sanitizeText(value, COLOR_TOKEN_LIMIT);
  return normalized.length === 0 ? null : normalized;
}

function sanitizeText(value: string, limit: number): string {
  return value
    .slice(0, TEXT_INSPECTION_LIMIT)
    .replace(CONTROL_CHARACTERS, " ")
    .replace(QUERY_LIKE, "[redacted-url]")
    .replace(BARE_HOST, "[redacted-url]")
    .replace(URL_LIKE, "[redacted-url]")
    .replace(PATH_LIKE, "[redacted-url]")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, limit);
}

function isSanitizedText(
  value: unknown,
  limit: number,
  emptyAllowed: boolean
): value is string {
  return typeof value === "string" &&
    value.length <= limit &&
    (emptyAllowed || value.length > 0) &&
    !CONTROL_CHARACTERS_TEST.test(value) &&
    !URL_LIKE_TEST.test(value) &&
    !QUERY_LIKE_TEST.test(value) &&
    !PATH_LIKE_TEST.test(value) &&
    !BARE_HOST_TEST.test(value) &&
    sanitizeText(value, limit) === value;
}

function readStringProperty(
  value: object,
  key: "name" | "message"
): string | undefined {
  try {
    const candidate = (value as Readonly<Record<string, unknown>>)[key];
    return typeof candidate === "string" ? candidate : undefined;
  } catch {
    return undefined;
  }
}

function isPhase(value: unknown): value is DecoderDiagnosticPhase {
  return typeof value === "string" &&
    PHASES.includes(value as DecoderDiagnosticPhase);
}

function isCode(value: unknown): value is DecoderDiagnosticCode {
  return typeof value === "string" &&
    CODES.includes(value as DecoderDiagnosticCode);
}

function isNullablePositiveSafeInteger(value: unknown): boolean {
  return value === null || isPositiveSafeInteger(value);
}

function isNullableNonNegativeSafeInteger(value: unknown): boolean {
  return value === null || isNonNegativeSafeInteger(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[]
): boolean {
  let actual: readonly PropertyKey[];
  try { actual = Reflect.ownKeys(value); }
  catch { return false; }
  return actual.length === keys.length && keys.every((key) => actual.includes(key));
}

function hasExactArrayKeys(
  value: readonly unknown[],
  keys: readonly string[]
): boolean {
  let actual: readonly PropertyKey[];
  try { actual = Reflect.ownKeys(value); }
  catch { return false; }
  return actual.length === keys.length && keys.every((key) => actual.includes(key));
}
