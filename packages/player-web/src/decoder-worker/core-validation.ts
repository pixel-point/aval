import { parseVideoCodecString } from "@pixel-point/aval-format";

import {
  DECODER_WORKER_HARD_LIMITS,
  type DecoderWorkerColorSpaceExpectation,
  type DecoderWorkerErrorCode,
  type DecoderWorkerLimits,
  type DecoderWorkerOutputExpectation,
  type DecoderWorkerProbeConfig,
  type DecoderWorkerSample,
  type DecoderWorkerVideoConfig,
  type DecoderWorkerVideoProfile
} from "./protocol.js";

const MAX_CODED_DIMENSION = 0xffff_ffff;
type BrowserVideoDecoderConfig = VideoDecoderConfig & {
  readonly rotation?: unknown;
  readonly flip?: unknown;
};
const VIDEO_CONFIG_KEYS = new Set<string>([
  "codec",
  "codedWidth",
  "codedHeight",
  "displayAspectWidth",
  "displayAspectHeight",
  "colorSpace",
  "hardwareAcceleration",
  "optimizeForLatency",
  "rotation",
  "flip"
]);

export class DecoderWorkerCoreError extends Error {
  public readonly code: DecoderWorkerErrorCode;
  public readonly fatal: boolean;

  public constructor(
    code: DecoderWorkerErrorCode,
    message: string,
    fatal = false
  ) {
    super(message);
    this.name = "DecoderWorkerCoreError";
    this.code = code;
    this.fatal = fatal;
  }
}

export function validateConfiguration(
  config: DecoderWorkerVideoConfig,
  profile: DecoderWorkerVideoProfile,
  expected: DecoderWorkerOutputExpectation,
  limits: DecoderWorkerLimits
): void {
  const parsed = validateVideoConfig(config, protocolError);
  validateVideoProfile(profile);
  validateOutputExpectation(expected);
  validateLimits(limits);

  if (parsed.family !== profile.codecFamily) {
    throw protocolError("decoder codec family does not match the video profile");
  }
  if (parsed.bitDepth !== undefined && parsed.bitDepth !== profile.bitDepth) {
    throw protocolError("decoder codec bit depth does not match the video profile");
  }
  if (
    profile.codecFamily !== "av1" &&
    profile.bitDepth !== 8
  ) {
    throw protocolError("only AV1 supports a 10-bit worker profile");
  }
  if (
    config.codedWidth !== profile.codedWidth ||
    config.codedHeight !== profile.codedHeight
  ) {
    throw protocolError("decoder config geometry does not match the video profile");
  }
  if (
    config.codedWidth !== expected.codedWidth ||
    config.codedHeight !== expected.codedHeight
  ) {
    throw protocolError("decoder config geometry does not match expected output");
  }
  if (
    config.displayAspectWidth !== undefined &&
    config.displayAspectWidth !== expected.displayWidth
  ) {
    throw protocolError("decoder displayAspectWidth does not match expected output");
  }
  if (
    config.displayAspectHeight !== undefined &&
    config.displayAspectHeight !== expected.displayHeight
  ) {
    throw protocolError("decoder displayAspectHeight does not match expected output");
  }
  if (config.colorSpace !== undefined) {
    requireBt709Limited(config.colorSpace, "decoder config colorSpace");
  }

  const decodedBytesPerSurface = checkedDecodedBytes(
    expected.codedWidth,
    expected.codedHeight
  );
  if (
    decodedBytesPerSurface >
      Math.floor(Number.MAX_SAFE_INTEGER / limits.maxOutstandingFrames)
  ) {
    throw protocolError("decoder decoded-surface byte count is unsafe");
  }
  const exactDecodedBytes =
    decodedBytesPerSurface * limits.maxOutstandingFrames;
  if (limits.maxDecodedBytes !== exactDecodedBytes) {
    throw protocolError(
      "maxDecodedBytes must exactly match the decoded-surface budget"
    );
  }
}

/** Validate the closed structured-clone request used before configuration. */
export function validateProbeConfiguration(
  config: DecoderWorkerProbeConfig
): void {
  validateVideoConfig(config, protocolError);
}

/** Validate WebCodecs' browser-owned dictionary and return its strict boolean. */
export function validateProbeSupportResult(
  support: VideoDecoderSupport,
  requested: DecoderWorkerProbeConfig
): boolean {
  if (!isRecord(support)) {
    throw probeResultError("decoder probe result is not an object");
  }
  const keys = Object.keys(support);
  if (keys.some((key) => key !== "supported" && key !== "config")) {
    throw probeResultError("decoder probe result has unknown fields");
  }
  if (typeof support.supported !== "boolean") {
    throw probeResultError("decoder probe result support flag is invalid");
  }
  if (!isRecord(support.config)) {
    throw probeResultError("decoder probe result omitted its config echo");
  }
  validateSupportResultConfiguration(
    support.config as unknown as BrowserVideoDecoderConfig,
    requested,
    probeResultError
  );
  return support.supported;
}

/**
 * Validate the browser-owned support echo. Standard defaulted fields are
 * accepted, but every requested member must remain exactly unchanged.
 */
export function validateSupportResultConfiguration(
  config: BrowserVideoDecoderConfig,
  requested: DecoderWorkerVideoConfig,
  error: (message: string) => DecoderWorkerCoreError = supportResultError
): void {
  validateVideoConfig(config, error);
  for (const key of Object.keys(requested)) {
    if (!VIDEO_CONFIG_KEYS.has(key)) {
      throw error("decoder support result request contains an unsupported field");
    }
    if (!sameConfigMember(
      config[key as keyof VideoDecoderConfig],
      requested[key as keyof VideoDecoderConfig]
    )) {
      throw error(`decoder support result changed requested ${key}`);
    }
  }
  if (
    !("hardwareAcceleration" in requested) &&
    config.hardwareAcceleration !== undefined &&
    config.hardwareAcceleration !== "no-preference"
  ) {
    throw error("decoder support result returned non-default hardwareAcceleration");
  }
  if (
    !("optimizeForLatency" in requested) &&
    config.optimizeForLatency !== undefined &&
    config.optimizeForLatency !== false
  ) {
    throw error("decoder support result returned non-default optimizeForLatency");
  }
}

export function validateGeneration(generation: number): void {
  if (!Number.isSafeInteger(generation) || generation <= 0) {
    throw protocolError("generation must be a positive safe integer");
  }
}

export function validateSampleShape(sample: DecoderWorkerSample): void {
  if (!isRecord(sample) || !hasExactKeys(sample, [
    "unitId",
    "unitInstance",
    "decodeIndex",
    "unitChunkCount",
    "unitFrameCount",
    "presentationOrdinalBase",
    "presentationIndices",
    "presentationTimestamp",
    "duration",
    "randomAccess",
    "displayedFrameCount",
    "data"
  ])) {
    throw protocolError("decode sample has unknown or missing fields");
  }
  if (
    typeof sample.unitId !== "string" ||
    sample.unitId.length < 1 ||
    sample.unitId.length > 128
  ) {
    throw protocolError("decode sample unitId length must be between 1 and 128");
  }
  requireNonNegativeInteger(sample.unitInstance, "unitInstance");
  requireNonNegativeInteger(sample.decodeIndex, "decodeIndex");
  requirePositiveInteger(sample.unitChunkCount, "unitChunkCount");
  if (sample.decodeIndex >= sample.unitChunkCount) {
    throw protocolError("decodeIndex exceeds unitChunkCount");
  }
  requirePositiveInteger(sample.unitFrameCount, "unitFrameCount");
  requireNonNegativeInteger(
    sample.presentationOrdinalBase,
    "presentationOrdinalBase"
  );
  if (
    sample.presentationOrdinalBase >
      Number.MAX_SAFE_INTEGER - sample.unitFrameCount
  ) {
    throw protocolError("presentation ordinal range exceeds safe integers");
  }
  requireNonNegativeInteger(
    sample.presentationTimestamp,
    "presentationTimestamp"
  );
  requireNonNegativeInteger(sample.duration, "duration");
  requireNonNegativeInteger(sample.displayedFrameCount, "displayedFrameCount");
  if (
    !Array.isArray(sample.presentationIndices) ||
    sample.presentationIndices.length !== sample.displayedFrameCount
  ) {
    throw protocolError(
      "presentationIndices must match displayedFrameCount"
    );
  }
  if (sample.displayedFrameCount > 0 && sample.duration === 0) {
    throw protocolError("displayed chunks must have a positive duration");
  }
  if (typeof sample.randomAccess !== "boolean") {
    throw protocolError("randomAccess must be a boolean");
  }
  const localIndices = new Set<number>();
  for (let index = 0; index < sample.presentationIndices.length; index += 1) {
    const presentationIndex = sample.presentationIndices[index];
    requireNonNegativeInteger(
      presentationIndex,
      `presentationIndices[${String(index)}]`
    );
    if (presentationIndex >= sample.unitFrameCount) {
      throw protocolError("presentation index exceeds unitFrameCount");
    }
    if (localIndices.has(presentationIndex)) {
      throw protocolError("presentation indices must be unique within a chunk");
    }
    localIndices.add(presentationIndex);
    checkedTimestamp(
      sample.presentationTimestamp,
      sample.duration,
      index,
      "decode sample presentation timeline"
    );
  }
  if (!(sample.data instanceof ArrayBuffer)) {
    throw protocolError("decode sample data must be an ArrayBuffer");
  }
  if (
    sample.data.byteLength < 1 ||
    sample.data.byteLength > DECODER_WORKER_HARD_LIMITS.maxSampleBytes
  ) {
    throw protocolError(
      `decode sample data length must be between 1 and ${String(
        DECODER_WORKER_HARD_LIMITS.maxSampleBytes
      )} bytes`
    );
  }
}

export function validateDecodedFrame(
  frame: VideoFrame,
  expected: DecoderWorkerOutputExpectation,
  timestamp: number,
  duration: number
): number {
  if (frame.timestamp !== timestamp || frame.duration !== duration) {
    throw new DecoderWorkerCoreError(
      "DECODER_OUTPUT_INVALID",
      "decoder output timing did not match its presentation metadata",
      true
    );
  }
  const rect = frame.visibleRect;
  // WebCodecs coded dimensions describe UA-owned allocation and may include
  // non-visible padding; only the visible storage dimensions are authored.
  if (
    rect === null ||
    !Number.isSafeInteger(frame.codedWidth) ||
    frame.codedWidth < 1 ||
    !Number.isSafeInteger(frame.codedHeight) ||
    frame.codedHeight < 1 ||
    frame.displayWidth !== expected.displayWidth ||
    frame.displayHeight !== expected.displayHeight ||
    !Number.isSafeInteger(rect.x) ||
    rect.x < 0 ||
    !Number.isSafeInteger(rect.y) ||
    rect.y < 0 ||
    rect.width !== expected.visibleRect.width ||
    rect.height !== expected.visibleRect.height ||
    rect.x > frame.codedWidth - rect.width ||
    rect.y > frame.codedHeight - rect.height
  ) {
    throw new DecoderWorkerCoreError(
      "DECODER_OUTPUT_INVALID",
      "decoder output geometry did not expose the exact rendition storage dimensions",
      true
    );
  }
  if (!matchesDecodedBt709ColorSpace(frame.colorSpace, expected.colorSpace)) {
    throw new DecoderWorkerCoreError(
      "DECODER_OUTPUT_INVALID",
      "decoder output color space did not match the configured rendition",
      true
    );
  }
  return checkedDecodedBytes(expected.codedWidth, expected.codedHeight);
}

export function expectedTimestamp(
  sample: Pick<
    DecoderWorkerSample,
    "presentationTimestamp" | "duration"
  >,
  displayedIndex: number
): number {
  return checkedTimestamp(
    sample.presentationTimestamp,
    sample.duration,
    displayedIndex,
    "decode sample presentation timeline"
  );
}

export function normalizeCoreError(
  error: unknown,
  code: DecoderWorkerErrorCode,
  message: string,
  fatal: boolean
): DecoderWorkerCoreError {
  if (error instanceof DecoderWorkerCoreError) return error;
  return new DecoderWorkerCoreError(code, message, fatal);
}

function validateVideoConfig(
  config: BrowserVideoDecoderConfig,
  error: (message: string) => DecoderWorkerCoreError
): NonNullable<ReturnType<typeof parseVideoCodecString>> {
  const unsupportedKeys = isRecord(config)
    ? Object.keys(config).filter((key) => !VIDEO_CONFIG_KEYS.has(key))
    : [];
  if (
    !isRecord(config) ||
    unsupportedKeys.length > 0
  ) {
    throw error(
      `decoder config has an unsupported field: ${unsupportedKeys.join(",")}`
    );
  }
  if (typeof config.codec !== "string") {
    throw error("decoder codec is invalid");
  }
  const parsed = parseVideoCodecString(config.codec);
  if (parsed === undefined) throw error("decoder codec is invalid");
  requireBoundedPositive(config.codedWidth, MAX_CODED_DIMENSION, "codedWidth", error);
  requireBoundedPositive(config.codedHeight, MAX_CODED_DIMENSION, "codedHeight", error);
  if (config.displayAspectWidth !== undefined) {
    requireBoundedPositive(
      config.displayAspectWidth,
      MAX_CODED_DIMENSION,
      "displayAspectWidth",
      error
    );
  }
  if (config.displayAspectHeight !== undefined) {
    requireBoundedPositive(
      config.displayAspectHeight,
      MAX_CODED_DIMENSION,
      "displayAspectHeight",
      error
    );
  }
  if (
    config.hardwareAcceleration !== undefined &&
    config.hardwareAcceleration !== "no-preference" &&
    config.hardwareAcceleration !== "prefer-hardware" &&
    config.hardwareAcceleration !== "prefer-software"
  ) {
    throw error("decoder hardwareAcceleration is invalid");
  }
  if (
    config.optimizeForLatency !== undefined &&
    typeof config.optimizeForLatency !== "boolean"
  ) {
    throw error("decoder optimizeForLatency is invalid");
  }
  if (config.rotation !== undefined && config.rotation !== 0) {
    throw error("decoder rotation must be zero");
  }
  if (config.flip !== undefined && config.flip !== false) {
    throw error("decoder flip must be false");
  }
  if (config.colorSpace !== undefined) {
    requireBt709Limited(config.colorSpace, "decoder config colorSpace", error);
  }
  return parsed;
}

function validateVideoProfile(profile: DecoderWorkerVideoProfile): void {
  if (!isRecord(profile) || !hasExactKeys(profile, [
    "codecFamily",
    "bitDepth",
    "codedWidth",
    "codedHeight",
    "frameRate",
    "requireBt709LimitedRange"
  ])) {
    throw protocolError("video profile has unknown or missing fields");
  }
  if (
    profile.codecFamily !== "h264" &&
    profile.codecFamily !== "h265" &&
    profile.codecFamily !== "vp9" &&
    profile.codecFamily !== "av1"
  ) {
    throw protocolError("video profile codec family is invalid");
  }
  if (profile.bitDepth !== 8 && profile.bitDepth !== 10) {
    throw protocolError("video profile bit depth is invalid");
  }
  requireDimension(profile.codedWidth, "videoProfile.codedWidth");
  requireDimension(profile.codedHeight, "videoProfile.codedHeight");
  if (!isRecord(profile.frameRate) || !hasExactKeys(profile.frameRate, [
    "numerator",
    "denominator"
  ])) {
    throw protocolError("video profile frame rate is invalid");
  }
  requirePositiveInteger(profile.frameRate.numerator, "frameRate.numerator");
  requirePositiveInteger(profile.frameRate.denominator, "frameRate.denominator");
  if (profile.requireBt709LimitedRange !== true) {
    throw protocolError("video profile must require BT.709 limited range");
  }
}

function validateOutputExpectation(
  expected: DecoderWorkerOutputExpectation
): void {
  if (!isRecord(expected) || !hasExactKeys(expected, [
    "codedWidth",
    "codedHeight",
    "displayWidth",
    "displayHeight",
    "visibleRect",
    "colorSpace"
  ])) {
    throw protocolError("expected output has unknown or missing fields");
  }
  requireDimension(expected.codedWidth, "codedWidth");
  requireDimension(expected.codedHeight, "codedHeight");
  requireDimension(expected.displayWidth, "displayWidth");
  requireDimension(expected.displayHeight, "displayHeight");
  const rect = expected.visibleRect;
  if (!isRecord(rect) || !hasExactKeys(rect, ["x", "y", "width", "height"])) {
    throw protocolError("expected visible rectangle has unknown or missing fields");
  }
  requireNonNegativeInteger(rect.x, "visibleRect.x");
  requireNonNegativeInteger(rect.y, "visibleRect.y");
  requireDimension(rect.width, "visibleRect.width");
  requireDimension(rect.height, "visibleRect.height");
  if (
    rect.x + rect.width > expected.codedWidth ||
    rect.y + rect.height > expected.codedHeight
  ) {
    throw protocolError("expected visible rectangle exceeds coded dimensions");
  }
  if (expected.colorSpace !== null) validateColorSpace(expected.colorSpace);
}

function validateColorSpace(value: DecoderWorkerColorSpaceExpectation): void {
  if (!isRecord(value) || !hasExactKeys(value, [
    "fullRange",
    "matrix",
    "primaries",
    "transfer"
  ])) {
    throw protocolError("expected color space has unknown or missing fields");
  }
  if (value.fullRange !== null && typeof value.fullRange !== "boolean") {
    throw protocolError("expected color-space fullRange is invalid");
  }
  for (const key of ["matrix", "primaries", "transfer"] as const) {
    if (value[key] !== null && typeof value[key] !== "string") {
      throw protocolError(`expected color-space ${key} is invalid`);
    }
  }
}

function validateLimits(limits: DecoderWorkerLimits): void {
  if (!isRecord(limits) || !hasExactKeys(limits, [
    "maxDecodeQueueSize",
    "maxPendingSamples",
    "maxOutstandingFrames",
    "maxDecodedBytes"
  ])) {
    throw protocolError("decoder limits have unknown or missing fields");
  }
  requireBoundedPositive(
    limits.maxDecodeQueueSize,
    DECODER_WORKER_HARD_LIMITS.maxDecodeQueueSize,
    "maxDecodeQueueSize"
  );
  requireBoundedPositive(
    limits.maxPendingSamples,
    DECODER_WORKER_HARD_LIMITS.maxPendingSamples,
    "maxPendingSamples"
  );
  requireBoundedPositive(
    limits.maxOutstandingFrames,
    DECODER_WORKER_HARD_LIMITS.maxOutstandingFrames,
    "maxOutstandingFrames"
  );
  requireBoundedPositive(
    limits.maxDecodedBytes,
    DECODER_WORKER_HARD_LIMITS.maxDecodedBytes,
    "maxDecodedBytes"
  );
}

function requireBt709Limited(
  value: VideoColorSpaceInit,
  label: string,
  error: (message: string) => DecoderWorkerCoreError = protocolError
): void {
  if (!isRecord(value) || !hasExactKeys(value, [
    "primaries",
    "transfer",
    "matrix",
    "fullRange"
  ])) {
    throw error(`${label} has unknown or missing fields`);
  }
  if (
    value.primaries !== "bt709" ||
    value.transfer !== "bt709" ||
    value.matrix !== "bt709" ||
    value.fullRange !== false
  ) {
    throw error(`${label} must be BT.709 limited range`);
  }
}

function matchesDecodedBt709ColorSpace(
  actual: VideoColorSpace,
  expected: DecoderWorkerColorSpaceExpectation | null
): boolean {
  const nonContradictory = actual.fullRange !== true &&
    (actual.matrix === null || actual.matrix === "bt709") &&
    (actual.primaries === null || actual.primaries === "bt709") &&
    (actual.transfer === null || actual.transfer === "bt709");
  const browserNormalized =
    (actual.fullRange === false || actual.fullRange === true) &&
    actual.matrix === "bt709" &&
    actual.primaries === "bt709" &&
    actual.transfer === "iec61966-2-1";
  if (!nonContradictory && !browserNormalized) return false;
  if (expected === null) return true;
  if (browserNormalized) {
    return expected.fullRange === false &&
      expected.matrix === "bt709" &&
      expected.primaries === "bt709" &&
      expected.transfer === "bt709";
  }
  return actual.fullRange === expected.fullRange &&
    actual.matrix === expected.matrix &&
    actual.primaries === expected.primaries &&
    actual.transfer === expected.transfer;
}

function sameConfigMember(left: unknown, right: unknown): boolean {
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return leftKeys.length === rightKeys.length &&
      leftKeys.every((key) => key in right && left[key] === right[key]);
  }
  return left === right;
}

function checkedDecodedBytes(width: number, height: number): number {
  const pixels = checkedProduct(width, height, "decoded frame pixels");
  return checkedProduct(pixels, 4, "decoded frame RGBA bytes");
}

function checkedTimestamp(
  timestamp: number,
  duration: number,
  index: number,
  label: string
): number {
  const result = BigInt(timestamp) + BigInt(duration) * BigInt(index);
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw protocolError(`${label} exceeds safe integers`);
  }
  return Number(result);
}

function checkedProduct(left: number, right: number, label: string): number {
  const product = BigInt(left) * BigInt(right);
  if (product > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw protocolError(`${label} exceeds safe integers`);
  }
  return Number(product);
}

function requireDimension(value: number, label: string): void {
  requireBoundedPositive(value, MAX_CODED_DIMENSION, label);
}

function requirePositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw protocolError(`${label} must be a positive safe integer`);
  }
}

function requireNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw protocolError(`${label} must be a non-negative safe integer`);
  }
}

function requireBoundedPositive(
  value: number | undefined,
  maximum: number,
  label: string,
  error: (message: string) => DecoderWorkerCoreError = protocolError
): void {
  if (
    value === undefined ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > maximum
  ) {
    throw error(`${label} must be an integer from 1 through ${String(maximum)}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[]
): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => key in value);
}

function protocolError(message: string): DecoderWorkerCoreError {
  return new DecoderWorkerCoreError("PROTOCOL_ERROR", message, true);
}

function supportResultError(message: string): DecoderWorkerCoreError {
  return new DecoderWorkerCoreError("DECODER_CONFIGURE_FAILED", message, true);
}

function probeResultError(message: string): DecoderWorkerCoreError {
  return new DecoderWorkerCoreError("DECODER_PROBE_FAILED", message, false);
}
