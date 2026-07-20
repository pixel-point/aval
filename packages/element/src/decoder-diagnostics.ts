import { isPlainRecord } from "./plain-record.js";

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

export type DecoderOutputFailureKind =
  | "metadata-shape"
  | "unknown-output"
  | "timing"
  | "display-aspect"
  | "visible-rect"
  | "color-space"
  | "coded-allocation"
  | "duplicate-output"
  | "incomplete-output";

export type DecoderOutputField =
  | "timestamp"
  | "duration"
  | "coded-width"
  | "coded-height"
  | "display-aspect"
  | "visible-rect"
  | "color-space"
  | "allocation"
  | "ordinal"
  | "frame-count";

export interface DecoderExpectedOutputMetadata {
  readonly timestamp: number | null;
  readonly duration: number | null;
  readonly codedWidth: number;
  readonly codedHeight: number;
  readonly displayAspectWidth: number;
  readonly displayAspectHeight: number;
  readonly visibleRect: Readonly<DecoderVisibleRectMetadata>;
  readonly colorSpace: DecoderColorSpaceMetadata | null;
  readonly frameCount: number | null;
}

export interface DecoderObservedFrameMetadata {
  readonly timestamp: number | null;
  readonly duration: number | null;
  readonly codedWidth: number | null;
  readonly codedHeight: number | null;
  readonly displayWidth: number | null;
  readonly displayHeight: number | null;
  readonly visibleRect: Readonly<DecoderVisibleRectMetadata> | null;
  readonly colorSpace: DecoderColorSpaceMetadata | null;
  readonly receivedFrameCount: number | null;
}

export interface DecoderOutputFailure {
  readonly kind: DecoderOutputFailureKind;
  readonly validationLayer: "worker-shape" | "host-expectation";
  readonly field: DecoderOutputField | null;
  readonly expected: Readonly<DecoderExpectedOutputMetadata> | null;
  readonly actual: Readonly<DecoderObservedFrameMetadata> | null;
}

export interface DecoderFrameMetadataInspection {
  readonly metadata: Readonly<DecoderFrameMetadata> | null;
  readonly outputFailure: Readonly<DecoderOutputFailure> | null;
}

export interface DecoderFailureDiagnostic {
  readonly phase: DecoderDiagnosticPhase;
  readonly code: DecoderDiagnosticCode;
  readonly run: number | null;
  readonly decodeOrdinal: number | null;
  readonly exception: Readonly<{ name: string; message: string }> | null;
  readonly firstFrame: Readonly<DecoderFrameMetadata> | null;
  readonly lastGoodFrame: Readonly<DecoderFrameMetadata> | null;
  readonly outputFailure: Readonly<DecoderOutputFailure> | null;
}

export interface DecoderFailureDiagnosticInput {
  readonly phase: DecoderDiagnosticPhase;
  readonly code: DecoderDiagnosticCode;
  readonly run: number | null;
  readonly decodeOrdinal: number | null;
  readonly reason: unknown;
  readonly firstFrame: Readonly<DecoderFrameMetadata> | null;
  readonly lastGoodFrame?: Readonly<DecoderFrameMetadata> | null;
  readonly outputFailure?: Readonly<DecoderOutputFailure> | null;
}

export interface DecoderOutputFailureInput {
  readonly kind: DecoderOutputFailureKind;
  readonly validationLayer: "worker-shape" | "host-expectation";
  readonly field: DecoderOutputField | null;
  readonly expected: Readonly<DecoderExpectedOutputMetadata> | null;
  readonly actual: Readonly<DecoderObservedFrameMetadata> | null;
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
  "firstFrame",
  "lastGoodFrame",
  "outputFailure"
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
const OUTPUT_FAILURE_KEYS = Object.freeze([
  "kind",
  "validationLayer",
  "field",
  "expected",
  "actual"
]);
const EXPECTED_OUTPUT_KEYS = Object.freeze([
  "timestamp",
  "duration",
  "codedWidth",
  "codedHeight",
  "displayAspectWidth",
  "displayAspectHeight",
  "visibleRect",
  "colorSpace",
  "frameCount"
]);
const OBSERVED_OUTPUT_KEYS = Object.freeze([
  "timestamp",
  "duration",
  "codedWidth",
  "codedHeight",
  "displayWidth",
  "displayHeight",
  "visibleRect",
  "colorSpace",
  "receivedFrameCount"
]);
const OUTPUT_FAILURE_KINDS: readonly DecoderOutputFailureKind[] = Object.freeze([
  "metadata-shape",
  "unknown-output",
  "timing",
  "display-aspect",
  "visible-rect",
  "color-space",
  "coded-allocation",
  "duplicate-output",
  "incomplete-output"
]);
const OUTPUT_FIELDS: readonly DecoderOutputField[] = Object.freeze([
  "timestamp",
  "duration",
  "coded-width",
  "coded-height",
  "display-aspect",
  "visible-rect",
  "color-space",
  "allocation",
  "ordinal",
  "frame-count"
]);
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
const UNREADABLE = Symbol("unreadable-decoder-metadata");

export function createDecoderFailureDiagnostic(
  input: Readonly<DecoderFailureDiagnosticInput>
): Readonly<DecoderFailureDiagnostic> {
  const diagnostic: DecoderFailureDiagnostic = {
    phase: input.phase,
    code: input.code,
    run: input.run,
    decodeOrdinal: input.decodeOrdinal,
    exception: sanitizeDecoderException(input.reason),
    firstFrame: input.firstFrame,
    lastGoodFrame: input.lastGoodFrame ?? null,
    outputFailure: input.outputFailure ?? null
  };
  if (!isDecoderFailureDiagnostic(diagnostic)) {
    throw new TypeError("invalid decoder failure diagnostic");
  }
  return freezeDecoderFailureDiagnostic(diagnostic);
}

export function createDecoderOutputFailure(
  input: Readonly<DecoderOutputFailureInput>
): Readonly<DecoderOutputFailure> {
  const failure: DecoderOutputFailure = {
    kind: input.kind,
    validationLayer: input.validationLayer,
    field: input.field,
    expected: input.expected,
    actual: input.actual
  };
  if (!isDecoderOutputFailure(failure)) {
    throw new TypeError("invalid decoder output failure");
  }
  return freezeDecoderOutputFailure(failure);
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
  const inspection = inspectDecoderFrameMetadata(frame);
  if (inspection.metadata === null) {
    throw new TypeError("invalid decoder output metadata");
  }
  return inspection.metadata;
}

export function inspectDecoderFrameMetadata(
  frame: VideoFrame
): Readonly<DecoderFrameMetadataInspection> {
  const timestamp = readProperty(frame, "timestamp");
  const duration = readProperty(frame, "duration");
  const codedWidth = readProperty(frame, "codedWidth");
  const codedHeight = readProperty(frame, "codedHeight");
  const displayWidth = readProperty(frame, "displayWidth");
  const displayHeight = readProperty(frame, "displayHeight");
  const visibleRect = readProperty(frame, "visibleRect");
  const colorSpace = readProperty(frame, "colorSpace");
  const observed = freezeObservedOutputMetadata({
    timestamp: safeNonNegativeInteger(timestamp),
    duration: duration === null ? null : safeNonNegativeInteger(duration),
    codedWidth: safePositiveInteger(codedWidth),
    codedHeight: safePositiveInteger(codedHeight),
    displayWidth: safePositiveInteger(displayWidth),
    displayHeight: safePositiveInteger(displayHeight),
    visibleRect: observedVisibleRect(visibleRect),
    colorSpace: observedColorSpace(colorSpace),
    receivedFrameCount: null
  });
  const field = invalidMetadataField({
    timestamp,
    duration,
    codedWidth,
    codedHeight,
    displayWidth,
    displayHeight,
    visibleRect,
    colorSpace
  });
  if (field !== null) {
    return Object.freeze({
      metadata: null,
      outputFailure: createDecoderOutputFailure({
        kind: "metadata-shape",
        validationLayer: "worker-shape",
        field,
        expected: null,
        actual: observed
      })
    });
  }
  const metadata = freezeDecoderFrameMetadata({
    timestamp: timestamp as number,
    duration: duration as number | null,
    codedWidth: codedWidth as number,
    codedHeight: codedHeight as number,
    displayWidth: displayWidth as number,
    displayHeight: displayHeight as number,
    visibleRect: observed.visibleRect,
    colorSpace: observed.colorSpace
  });
  return Object.freeze({ metadata, outputFailure: null });
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
    (value.firstFrame === null || isDecoderFrameMetadata(value.firstFrame)) &&
    (value.lastGoodFrame === null || isDecoderFrameMetadata(value.lastGoodFrame)) &&
    (value.outputFailure === null || isDecoderOutputFailure(value.outputFailure));
}

export function freezeDecoderFailureDiagnostic(
  diagnostic: DecoderFailureDiagnostic
): Readonly<DecoderFailureDiagnostic> {
  if (diagnostic.exception !== null) Object.freeze(diagnostic.exception);
  if (diagnostic.firstFrame !== null) {
    freezeDecoderFrameMetadata(diagnostic.firstFrame);
  }
  if (diagnostic.lastGoodFrame !== null) {
    freezeDecoderFrameMetadata(diagnostic.lastGoodFrame);
  }
  if (diagnostic.outputFailure !== null) {
    freezeDecoderOutputFailure(diagnostic.outputFailure);
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

function isDecoderOutputFailure(value: unknown): value is DecoderOutputFailure {
  if (!isRecord(value) || !hasExactKeys(value, OUTPUT_FAILURE_KEYS)) return false;
  return typeof value.kind === "string" &&
    OUTPUT_FAILURE_KINDS.includes(value.kind as DecoderOutputFailureKind) &&
    (value.validationLayer === "worker-shape" ||
      value.validationLayer === "host-expectation") &&
    (value.field === null || typeof value.field === "string" &&
      OUTPUT_FIELDS.includes(value.field as DecoderOutputField)) &&
    (value.expected === null || isExpectedOutputMetadata(value.expected)) &&
    (value.actual === null || isObservedOutputMetadata(value.actual));
}

function isExpectedOutputMetadata(
  value: unknown
): value is DecoderExpectedOutputMetadata {
  if (!isRecord(value) || !hasExactKeys(value, EXPECTED_OUTPUT_KEYS)) return false;
  return isNullableNonNegativeSafeInteger(value.timestamp) &&
    isNullableNonNegativeSafeInteger(value.duration) &&
    isPositiveSafeInteger(value.codedWidth) &&
    isPositiveSafeInteger(value.codedHeight) &&
    isPositiveSafeInteger(value.displayAspectWidth) &&
    isPositiveSafeInteger(value.displayAspectHeight) &&
    isVisibleRect(value.visibleRect) &&
    value.visibleRect !== null &&
    isColorSpace(value.colorSpace) &&
    isNullableNonNegativeSafeInteger(value.frameCount);
}

function isObservedOutputMetadata(
  value: unknown
): value is DecoderObservedFrameMetadata {
  if (!isRecord(value) || !hasExactKeys(value, OBSERVED_OUTPUT_KEYS)) return false;
  return isNullableNonNegativeSafeInteger(value.timestamp) &&
    isNullableNonNegativeSafeInteger(value.duration) &&
    isNullablePositiveSafeInteger(value.codedWidth) &&
    isNullablePositiveSafeInteger(value.codedHeight) &&
    isNullablePositiveSafeInteger(value.displayWidth) &&
    isNullablePositiveSafeInteger(value.displayHeight) &&
    isVisibleRect(value.visibleRect) &&
    isColorSpace(value.colorSpace) &&
    isNullableNonNegativeSafeInteger(value.receivedFrameCount);
}

function freezeDecoderOutputFailure(
  failure: DecoderOutputFailure
): Readonly<DecoderOutputFailure> {
  if (failure.expected !== null) freezeExpectedOutputMetadata(failure.expected);
  if (failure.actual !== null) freezeObservedOutputMetadata(failure.actual);
  return Object.freeze(failure);
}

function freezeExpectedOutputMetadata(
  metadata: DecoderExpectedOutputMetadata
): Readonly<DecoderExpectedOutputMetadata> {
  Object.freeze(metadata.visibleRect);
  if (metadata.colorSpace !== null) Object.freeze(metadata.colorSpace);
  return Object.freeze(metadata);
}

function freezeObservedOutputMetadata(
  metadata: DecoderObservedFrameMetadata
): Readonly<DecoderObservedFrameMetadata> {
  if (metadata.visibleRect !== null) Object.freeze(metadata.visibleRect);
  if (metadata.colorSpace !== null) Object.freeze(metadata.colorSpace);
  return Object.freeze(metadata);
}

function invalidMetadataField(value: Readonly<{
  timestamp: unknown;
  duration: unknown;
  codedWidth: unknown;
  codedHeight: unknown;
  displayWidth: unknown;
  displayHeight: unknown;
  visibleRect: unknown;
  colorSpace: unknown;
}>): DecoderOutputField | null {
  if (!isNonNegativeSafeInteger(value.timestamp)) return "timestamp";
  if (value.duration !== null && !isNonNegativeSafeInteger(value.duration)) {
    return "duration";
  }
  if (!isPositiveSafeInteger(value.codedWidth)) return "coded-width";
  if (!isPositiveSafeInteger(value.codedHeight)) return "coded-height";
  if (!isPositiveSafeInteger(value.displayWidth) ||
    !isPositiveSafeInteger(value.displayHeight)) return "display-aspect";
  if (value.visibleRect !== null && observedVisibleRect(value.visibleRect) === null) {
    return "visible-rect";
  }
  if (value.colorSpace !== null && observedColorSpace(value.colorSpace) === null) {
    return "color-space";
  }
  return null;
}

function observedVisibleRect(
  value: unknown
): Readonly<DecoderVisibleRectMetadata> | null {
  if (value === null || value === UNREADABLE ||
    typeof value !== "object" && typeof value !== "function") return null;
  const x = readProperty(value, "x");
  const y = readProperty(value, "y");
  const width = readProperty(value, "width");
  const height = readProperty(value, "height");
  if (!isNonNegativeSafeInteger(x) || !isNonNegativeSafeInteger(y) ||
    !isPositiveSafeInteger(width) || !isPositiveSafeInteger(height)) return null;
  return Object.freeze({ x, y, width, height });
}

function observedColorSpace(value: unknown): DecoderColorSpaceMetadata | null {
  if (value === null || value === UNREADABLE ||
    typeof value !== "object" && typeof value !== "function") return null;
  const primaries = readProperty(value, "primaries");
  const transfer = readProperty(value, "transfer");
  const matrix = readProperty(value, "matrix");
  const fullRange = readProperty(value, "fullRange");
  if (!isNullableBoundedColorSource(primaries) ||
    !isNullableBoundedColorSource(transfer) ||
    !isNullableBoundedColorSource(matrix) ||
    !(fullRange === null || typeof fullRange === "boolean")) return null;
  return Object.freeze([
    boundedColorToken(primaries),
    boundedColorToken(transfer),
    boundedColorToken(matrix),
    fullRange
  ]);
}

function isNullableBoundedColorSource(value: unknown): boolean {
  return value === null || typeof value === "string" &&
    value.length > 0 && value.length <= COLOR_TOKEN_LIMIT &&
    boundedColorToken(value) === value;
}

function safeNonNegativeInteger(value: unknown): number | null {
  return isNonNegativeSafeInteger(value) ? value : null;
}

function safePositiveInteger(value: unknown): number | null {
  return isPositiveSafeInteger(value) ? value : null;
}

function readProperty(value: object, key: PropertyKey): unknown {
  try { return (value as Readonly<Record<PropertyKey, unknown>>)[key]; }
  catch { return UNREADABLE; }
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
  return isPlainRecord(value);
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
