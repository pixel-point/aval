import {
  validateFrameRate,
  type RationalFrameRate
} from "./rational-time.js";

export interface OwnedEncodedFrame {
  readonly type: EncodedVideoChunkType;
  readonly data: Uint8Array;
}

export interface EncodedLoopUnit {
  readonly config: Readonly<VideoDecoderConfig>;
  readonly codedWidth: number;
  readonly codedHeight: number;
  readonly displayWidth: number;
  readonly displayHeight: number;
  readonly frameRate: Readonly<RationalFrameRate>;
  readonly frames: readonly OwnedEncodedFrame[];
}

/**
 * Creates a disposal-independent encoded loop. Every frame payload and the
 * optional decoder-description payload are copied into storage owned by the
 * returned unit.
 */
export function createEncodedLoopUnit(input: EncodedLoopUnit): EncodedLoopUnit {
  validateEncodedLoopUnit(input);

  const frames = input.frames.map((frame) =>
    Object.freeze({
      type: frame.type,
      data: cloneBytes(frame.data)
    })
  );
  const frameRate = Object.freeze({
    numerator: input.frameRate.numerator,
    denominator: input.frameRate.denominator
  });
  const config = cloneDecoderConfig(input.config);

  return Object.freeze({
    config,
    codedWidth: input.codedWidth,
    codedHeight: input.codedHeight,
    displayWidth: input.displayWidth,
    displayHeight: input.displayHeight,
    frameRate,
    frames: Object.freeze(frames)
  });
}

/**
 * Validates the in-memory M1 loop contract without touching browser codec APIs.
 */
export function validateEncodedLoopUnit(unit: EncodedLoopUnit): void {
  if (unit === null || typeof unit !== "object") {
    throw new TypeError("encoded loop unit must be an object");
  }

  validateDimension(unit.codedWidth, "coded width");
  validateDimension(unit.codedHeight, "coded height");
  validateDimension(unit.displayWidth, "display width");
  validateDimension(unit.displayHeight, "display height");
  validateFrameRate(unit.frameRate);
  validateDecoderConfig(unit);

  if (!Array.isArray(unit.frames) || unit.frames.length === 0) {
    throw new RangeError("encoded loop unit must contain at least one frame");
  }

  for (const [index, frame] of unit.frames.entries()) {
    if (frame === null || typeof frame !== "object") {
      throw new TypeError(`encoded frame ${index} must be an object`);
    }
    if (frame.type !== "key" && frame.type !== "delta") {
      throw new TypeError(`encoded frame ${index} has an invalid chunk type`);
    }
    if (!(frame.data instanceof Uint8Array)) {
      throw new TypeError(`encoded frame ${index} data must be a Uint8Array`);
    }
    if (frame.data.byteLength === 0) {
      throw new RangeError(`encoded frame ${index} data must not be empty`);
    }
  }

  if (unit.frames[0]?.type !== "key") {
    throw new TypeError("encoded loop unit frame zero must be a key frame");
  }
}

function validateDecoderConfig(unit: EncodedLoopUnit): void {
  const { config } = unit;

  if (config === null || typeof config !== "object") {
    throw new TypeError("decoder config must be an object");
  }
  if (typeof config.codec !== "string" || config.codec.trim().length === 0) {
    throw new TypeError("decoder config codec must be a non-empty string");
  }

  requireMatchingDimension(config.codedWidth, unit.codedWidth, "coded width");
  requireMatchingDimension(
    config.codedHeight,
    unit.codedHeight,
    "coded height"
  );
  requireMatchingDimension(
    config.displayAspectWidth,
    unit.displayWidth,
    "display width"
  );
  requireMatchingDimension(
    config.displayAspectHeight,
    unit.displayHeight,
    "display height"
  );
}

function requireMatchingDimension(
  configured: number | undefined,
  declared: number,
  label: string
): void {
  if (configured === undefined) {
    throw new TypeError(`decoder config ${label} is required`);
  }
  validateDimension(configured, `decoder config ${label}`);
  if (configured !== declared) {
    throw new RangeError(
      `decoder config ${label} must match the encoded loop unit`
    );
  }
}

function validateDimension(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
}

function cloneDecoderConfig(
  config: Readonly<VideoDecoderConfig>
): Readonly<VideoDecoderConfig> {
  const description =
    config.description === undefined
      ? undefined
      : cloneBufferSource(config.description);
  const colorSpace =
    config.colorSpace === undefined
      ? undefined
      : Object.freeze({ ...config.colorSpace });
  const copy: VideoDecoderConfig = {
    ...config,
    ...(description === undefined ? {} : { description }),
    ...(colorSpace === undefined ? {} : { colorSpace })
  };

  return Object.freeze(copy);
}

function cloneBufferSource(source: AllowSharedBufferSource): ArrayBuffer {
  const sourceBytes = ArrayBuffer.isView(source)
    ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
    : new Uint8Array(source);
  const copy = new Uint8Array(sourceBytes.byteLength);
  copy.set(sourceBytes);

  return copy.buffer;
}

function cloneBytes(source: Uint8Array): Uint8Array {
  const copy = new Uint8Array(source.byteLength);
  copy.set(source);

  return copy;
}
