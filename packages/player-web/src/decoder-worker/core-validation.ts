import {
  avcLevelLimits,
  maximumAvcDecodedRgbaBytes,
  maximumAvcDecoderSurfaceDimension,
  parseAvcCodec
} from "@pixel-point/aval-format";

import {
  DECODER_WORKER_HARD_LIMITS,
  type DecoderWorkerColorSpaceExpectation,
  type DecoderWorkerAvcConfig,
  type DecoderWorkerAvcProfile,
  type DecoderWorkerErrorCode,
  type DecoderWorkerLimits,
  type DecoderWorkerOutputExpectation,
  type DecoderWorkerSample
} from "./protocol.js";

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
  config: DecoderWorkerAvcConfig | VideoDecoderConfig,
  avcProfile: DecoderWorkerAvcProfile,
  expected: DecoderWorkerOutputExpectation,
  limits: DecoderWorkerLimits
): void {
  if (!isRecord(config) || !hasExactKeys(config, [
    "codec",
    "codedWidth",
    "codedHeight",
    "hardwareAcceleration",
    "optimizeForLatency"
  ])) {
    throw protocolError("decoder config has unknown or missing fields");
  }
  let level: ReturnType<typeof parseAvcCodec>;
  try {
    level = parseAvcCodec(config.codec);
  } catch {
    throw protocolError("decoder codec is invalid");
  }
  if (
    config.hardwareAcceleration !== "no-preference" &&
    config.hardwareAcceleration !== "prefer-hardware" &&
    config.hardwareAcceleration !== "prefer-software"
  ) {
    throw protocolError("decoder hardwareAcceleration is invalid");
  }
  if (config.optimizeForLatency !== true) {
    throw protocolError("decoder optimizeForLatency must be true");
  }
  validateAvcProfile(avcProfile, level.levelIdc);
  validateOutputExpectation(expected);
  validateLimits(limits);

  if (
    config.codedWidth !== undefined &&
    config.codedWidth !== expected.codedWidth
  ) {
    throw protocolError("decoder config codedWidth does not match expected output");
  }
  if (
    config.codedHeight !== undefined &&
    config.codedHeight !== expected.codedHeight
  ) {
    throw protocolError("decoder config codedHeight does not match expected output");
  }
  if (
    config.codedWidth !== avcProfile.codedWidth ||
    config.codedHeight !== avcProfile.codedHeight
  ) {
    throw protocolError("decoder config geometry does not match the AVC profile");
  }
  let decodedBytesPerSurface: number;
  try {
    decodedBytesPerSurface = maximumAvcDecodedRgbaBytes(
      config.codedWidth,
      config.codedHeight
    );
  } catch {
    throw protocolError("decoder decoded-surface byte count is unsafe");
  }
  if (
    decodedBytesPerSurface >
      Math.floor(Number.MAX_SAFE_INTEGER / limits.maxOutstandingFrames)
  ) {
    throw protocolError("decoder decoded-surface budget is unsafe");
  }
  const exactDecodedBytes =
    decodedBytesPerSurface * limits.maxOutstandingFrames;
  if (limits.maxDecodedBytes !== exactDecodedBytes) {
    throw protocolError(
      "maxDecodedBytes must exactly match the decoded-surface budget"
    );
  }
}

/**
 * Validate the user agent's support-probe echo without treating standard
 * defaulted members as caller protocol fields. The decoder is configured with
 * the already validated request, never with this browser-owned object.
 */
export function validateSupportResultConfiguration(
  config: VideoDecoderConfig,
  requested: DecoderWorkerAvcConfig
): void {
  const required = [
    "codec",
    "codedWidth",
    "codedHeight",
    "hardwareAcceleration",
    "optimizeForLatency"
  ] as const;
  const allowed = new Set<string>([...required, "flip", "rotation"]);
  if (
    !isRecord(config) ||
    !required.every((key) => key in config) ||
    Object.keys(config).some((key) => !allowed.has(key))
  ) {
    throw supportResultError("decoder support result has unexpected fields");
  }
  for (const key of required) {
    if (config[key] !== requested[key]) {
      throw supportResultError(
        `decoder support result changed requested ${key}`
      );
    }
  }
  if ("flip" in config && config.flip !== false) {
    throw supportResultError("decoder support result returned non-default flip");
  }
  if ("rotation" in config && config.rotation !== 0) {
    throw supportResultError("decoder support result returned non-default rotation");
  }
}

export function validateGeneration(generation: number): void {
  if (!Number.isSafeInteger(generation) || generation <= 0) {
    throw protocolError("generation must be a positive safe integer");
  }
}

export function validateSample(
  sample: DecoderWorkerSample,
  expectedOrdinal: number,
  previousTimestamp: number | null
): void {
  if (!isRecord(sample) || !hasExactKeys(sample, [
    "ordinal",
    "unitId",
    "unitInstance",
    "unitFrame",
    "unitFrameCount",
    "type",
    "timestamp",
    "duration",
    "data"
  ])) {
    throw protocolError("decode sample has unknown or missing fields");
  }
  if (sample.ordinal !== expectedOrdinal) {
    throw protocolError(
      `decode ordinal must be ${String(expectedOrdinal)}`
    );
  }
  if (sample.ordinal >= Number.MAX_SAFE_INTEGER) {
    throw protocolError("decode ordinal leaves no safe successor");
  }
  if (typeof sample.unitId !== "string" || sample.unitId.length < 1 || sample.unitId.length > 128) {
    throw protocolError("decode sample unitId length must be between 1 and 128");
  }
  requireNonNegativeInteger(sample.unitInstance, "unitInstance");
  requireNonNegativeInteger(sample.unitFrame, "unitFrame");
  requirePositiveInteger(sample.unitFrameCount, "unitFrameCount");
  if (sample.unitFrame >= sample.unitFrameCount) {
    throw protocolError("decode sample unitFrame exceeds its unitFrameCount");
  }
  if (sample.type !== "key" && sample.type !== "delta") {
    throw protocolError("decode sample type must be key or delta");
  }
  requireNonNegativeInteger(sample.timestamp, "timestamp");
  requirePositiveInteger(sample.duration, "duration");
  if (sample.timestamp > Number.MAX_SAFE_INTEGER - sample.duration) {
    throw protocolError("decode timestamp plus duration exceeds safe integer range");
  }
  if (previousTimestamp !== null && sample.timestamp <= previousTimestamp) {
    throw protocolError("decode timestamps must be strictly increasing");
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
      "decoder output timing did not match the submitted access unit",
      true
    );
  }
  const rect = frame.visibleRect;
  const maximumCodedWidth = maximumAvcDecoderSurfaceDimension(
    expected.codedWidth
  );
  const maximumCodedHeight = maximumAvcDecoderSurfaceDimension(
    expected.codedHeight
  );
  if (
    rect === null ||
    frame.displayWidth !== expected.displayWidth ||
    frame.displayHeight !== expected.displayHeight ||
    rect.x !== expected.visibleRect.x ||
    rect.y !== expected.visibleRect.y ||
    rect.width !== expected.visibleRect.width ||
    rect.height !== expected.visibleRect.height ||
    frame.codedWidth < rect.x + rect.width ||
    frame.codedHeight < rect.y + rect.height ||
    frame.codedWidth > maximumCodedWidth ||
    frame.codedHeight > maximumCodedHeight
  ) {
    throw new DecoderWorkerCoreError(
      "DECODER_OUTPUT_INVALID",
      `decoder output geometry ${String(frame.codedWidth)}x${String(
        frame.codedHeight
      )}/${String(frame.displayWidth)}x${String(
        frame.displayHeight
      )} did not match the bounded ${String(expected.codedWidth)}x${String(
        expected.codedHeight
      )} rendition surface and exact ${String(expected.displayWidth)}x${String(
        expected.displayHeight
      )} display/visible rectangle`,
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

  const pixels = checkedProduct(
    frame.codedWidth,
    frame.codedHeight,
    "decoded frame pixels"
  );
  return checkedProduct(pixels, 4, "decoded frame RGBA bytes");
}

function isNonContradictoryBt709Limited(actual: VideoColorSpace): boolean {
  return (
    actual.fullRange !== true &&
    (actual.matrix === null || actual.matrix === "bt709") &&
    (actual.primaries === null || actual.primaries === "bt709") &&
    (actual.transfer === null || actual.transfer === "bt709")
  );
}

function matchesDecodedBt709ColorSpace(
  actual: VideoColorSpace,
  expected: DecoderWorkerColorSpaceExpectation | null
): boolean {
  if (isNonContradictoryBt709Limited(actual)) {
    return expected === null || matchesColorSpace(actual, expected);
  }
  return isWebKitNormalizedBt709(actual) &&
    (expected === null || isExactBt709Limited(expected));
}

/** WebKit exposes decoded BT.709 video through this complete normalized tuple. */
function isWebKitNormalizedBt709(actual: VideoColorSpace): boolean {
  return actual.fullRange === true &&
    actual.matrix === "bt709" &&
    actual.primaries === "bt709" &&
    actual.transfer === "iec61966-2-1";
}

function isExactBt709Limited(
  expected: DecoderWorkerColorSpaceExpectation
): boolean {
  return expected.fullRange === false &&
    expected.matrix === "bt709" &&
    expected.primaries === "bt709" &&
    expected.transfer === "bt709";
}

export function normalizeCoreError(
  error: unknown,
  code: DecoderWorkerErrorCode,
  message: string,
  fatal: boolean
): DecoderWorkerCoreError {
  if (error instanceof DecoderWorkerCoreError) {
    return error;
  }
  // Browser codec exceptions and driver text are intentionally not exposed.
  return new DecoderWorkerCoreError(code, message, fatal);
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
  if (expected.colorSpace !== null) {
    validateColorSpace(expected.colorSpace);
  }
}

function validateAvcProfile(
  profile: DecoderWorkerAvcProfile,
  levelIdc: number
): void {
  if (!isRecord(profile) || !hasExactKeys(profile, [
    "codedWidth",
    "codedHeight",
    "frameRate",
    "averageBitrate",
    "peakBitrate",
    "cpbBufferBits",
    "requireBt709LimitedRange",
    "quantizationPolicy"
  ])) {
    throw protocolError("AVC profile has unknown or missing fields");
  }
  requirePositiveInteger(profile.codedWidth, "avcProfile.codedWidth");
  requirePositiveInteger(profile.codedHeight, "avcProfile.codedHeight");
  if (!isRecord(profile.frameRate) || !hasExactKeys(profile.frameRate, [
    "numerator",
    "denominator"
  ])) {
    throw protocolError("AVC frame rate has unknown or missing fields");
  }
  requirePositiveInteger(
    profile.frameRate.numerator,
    "avcProfile.frameRate.numerator"
  );
  requireBoundedPositive(
    profile.frameRate.denominator,
    1_001,
    "avcProfile.frameRate.denominator"
  );
  if (
    profile.frameRate.numerator > 60 * profile.frameRate.denominator ||
    greatestCommonDivisor(
      profile.frameRate.numerator,
      profile.frameRate.denominator
    ) !== 1
  ) {
    throw protocolError("AVC frame rate must be reduced and no greater than 60 fps");
  }
  const macroblockWidth = Math.ceil(profile.codedWidth / 16);
  const macroblockHeight = Math.ceil(profile.codedHeight / 16);
  const macroblocksPerFrame = macroblockWidth * macroblockHeight;
  const level = avcLevelLimits(levelIdc);
  if (
    macroblockWidth > level.maximumMacroblockDimension ||
    macroblockHeight > level.maximumMacroblockDimension ||
    macroblocksPerFrame > level.maximumMacroblocksPerFrame ||
    BigInt(macroblocksPerFrame) * BigInt(profile.frameRate.numerator) >
      BigInt(level.maximumMacroblocksPerSecond) *
        BigInt(profile.frameRate.denominator)
  ) {
    throw protocolError("AVC profile exceeds its declared level macroblock limits");
  }
  requirePositiveInteger(profile.averageBitrate, "averageBitrate");
  requirePositiveInteger(profile.peakBitrate, "peakBitrate");
  requirePositiveInteger(profile.cpbBufferBits, "cpbBufferBits");
  if (
    profile.peakBitrate > level.maximumBitrate ||
    profile.cpbBufferBits > level.maximumCpbBits
  ) {
    throw protocolError("AVC bitrate or CPB exceeds its declared level");
  }
  if (
    profile.averageBitrate > profile.peakBitrate ||
    profile.cpbBufferBits !== profile.peakBitrate
  ) {
    throw protocolError("AVC bitrate and CPB fields are inconsistent");
  }
  if (profile.requireBt709LimitedRange !== true) {
    throw protocolError("AVC profile must require BT.709 limited range");
  }
  if (
    profile.quantizationPolicy !== "fixed-qp26-v0" &&
    profile.quantizationPolicy !== "bounded-qp-v1"
  ) {
    throw protocolError("AVC quantization policy is invalid");
  }
}

function validateColorSpace(
  value: DecoderWorkerColorSpaceExpectation
): void {
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

function matchesColorSpace(
  actual: VideoColorSpace,
  expected: DecoderWorkerColorSpaceExpectation
): boolean {
  return (
    actual.fullRange === expected.fullRange &&
    actual.matrix === expected.matrix &&
    actual.primaries === expected.primaries &&
    actual.transfer === expected.transfer
  );
}

function checkedProduct(left: number, right: number, label: string): number {
  const product = left * right;
  if (!Number.isSafeInteger(product) || product <= 0) {
    throw new DecoderWorkerCoreError(
      "DECODER_OUTPUT_INVALID",
      `${label} exceeds safe integer range`,
      true
    );
  }
  return product;
}

function requireDimension(value: number, label: string): void {
  requirePositiveInteger(value, label);
}

function requireBoundedPositive(
  value: number,
  maximum: number,
  label: string
): void {
  requirePositiveInteger(value, label);
  if (value > maximum) {
    throw protocolError(`${label} exceeds ${String(maximum)}`);
  }
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

function protocolError(message: string): DecoderWorkerCoreError {
  return new DecoderWorkerCoreError("PROTOCOL_ERROR", message, true);
}

function supportResultError(message: string): DecoderWorkerCoreError {
  return new DecoderWorkerCoreError(
    "DECODER_CONFIGURE_FAILED",
    message,
    true
  );
}

function greatestCommonDivisor(left: number, right: number): number {
  let a = left;
  let b = right;
  while (b !== 0) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[]
): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length && expected.every((key) => key in value);
}
