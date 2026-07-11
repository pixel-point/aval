const MEBIBYTE = 1024 * 1024;
const BYTES_PER_RGBA_PIXEL = 4n;
const GPU_OVERHEAD_NUMERATOR = 5n;
const GPU_OVERHEAD_DENOMINATOR = 4n;

export const MIN_REVERSIBLE_CLIP_FRAMES = 1;
export const MAX_REVERSIBLE_CLIP_FRAMES = 24;
export const MIN_ENDPOINT_RUNWAY_FRAMES = 6;
export const MAX_ENDPOINT_RUNWAY_FRAMES = 12;
export const MAX_RESIDENT_FRAME_LAYERS = 128;
/** The fixed-size RGBA continuation ring allocated beside resident layers. */
export const STREAMING_SLOT_COUNT = 3;
export const MAX_REVERSIBLE_CLIP_BYTES = 24 * MEBIBYTE;
export const MAX_RESIDENT_FRAME_BYTES = 48 * MEBIBYTE;
export const MAX_TRACKED_PLAYER_BYTES = 64 * MEBIBYTE;

/** A frame's stable authored identity. Pixel equality is deliberately ignored. */
export interface ResidentFrameKey {
  readonly rendition: string;
  readonly unit: string;
  readonly localFrame: number;
}

export interface ResidentFrameDeviceLimits {
  readonly maxArrayTextureLayers: number;
  readonly maxTextureSize: number;
}

export interface ResidentFramePlanInput {
  readonly width: number;
  readonly height: number;
  readonly sourceRunway: readonly ResidentFrameKey[];
  readonly clip: readonly ResidentFrameKey[];
  readonly targetRunway: readonly ResidentFrameKey[];
  readonly deviceLimits: Readonly<ResidentFrameDeviceLimits>;
}

export interface ResidentFrameLayer {
  readonly key: Readonly<ResidentFrameKey>;
  readonly layer: number;
}

/**
 * Frozen, allocation-independent description of the M2 resident texture.
 * Layer order is the first semantic occurrence across source, clip, then target.
 */
export interface ResidentFramePlan {
  readonly width: number;
  readonly height: number;
  readonly layerCount: number;
  readonly bytesPerFrame: number;
  readonly clipBytes: number;
  readonly residentBytes: number;
  readonly residentAllocationBytes: number;
  readonly streamingBytes: number;
  readonly streamingAllocationBytes: number;
  readonly gpuAllocationBytes: number;
  readonly stagingBytes: number;
  readonly trackedBytes: number;
  readonly uniqueFrames: readonly Readonly<ResidentFrameLayer>[];
  readonly sourceRunwayLayers: readonly number[];
  readonly clipLayers: readonly number[];
  readonly targetRunwayLayers: readonly number[];
  layerFor(key: ResidentFrameKey): number | undefined;
}

/**
 * Validates and freezes every resident-frame decision before WebGL allocation.
 * Byte arithmetic stays in bigint until all fixed memory limits have passed.
 */
export function createResidentFramePlan(
  input: ResidentFramePlanInput
): ResidentFramePlan {
  validateObject(input, "resident frame plan input");
  validatePositiveSafeInteger(input.width, "resident frame width");
  validatePositiveSafeInteger(input.height, "resident frame height");
  validateDeviceLimits(input.deviceLimits);

  if (input.width > input.deviceLimits.maxTextureSize) {
    throw new RangeError("resident frame width exceeds MAX_TEXTURE_SIZE");
  }
  if (input.height > input.deviceLimits.maxTextureSize) {
    throw new RangeError("resident frame height exceeds MAX_TEXTURE_SIZE");
  }

  validateSequenceLength(
    input.sourceRunway,
    "source endpoint runway",
    MIN_ENDPOINT_RUNWAY_FRAMES,
    MAX_ENDPOINT_RUNWAY_FRAMES
  );
  validateSequenceLength(
    input.clip,
    "reversible clip",
    MIN_REVERSIBLE_CLIP_FRAMES,
    MAX_REVERSIBLE_CLIP_FRAMES
  );
  validateSequenceLength(
    input.targetRunway,
    "target endpoint runway",
    MIN_ENDPOINT_RUNWAY_FRAMES,
    MAX_ENDPOINT_RUNWAY_FRAMES
  );

  const layerByIdentity = new Map<string, number>();
  const uniqueFrames: ResidentFrameLayer[] = [];

  const registerSequence = (
    sequence: readonly ResidentFrameKey[],
    label: string
  ): readonly number[] => {
    const layers: number[] = [];

    for (const [index, candidate] of sequence.entries()) {
      const key = cloneFrameKey(candidate, `${label} frame ${index}`);
      const identity = identityFor(key);
      let layer = layerByIdentity.get(identity);

      if (layer === undefined) {
        layer = uniqueFrames.length;
        layerByIdentity.set(identity, layer);
        uniqueFrames.push(Object.freeze({ key, layer }));
      }

      layers.push(layer);
    }

    return Object.freeze(layers);
  };

  const sourceRunwayLayers = registerSequence(
    input.sourceRunway,
    "source endpoint runway"
  );
  const clipLayers = registerSequence(input.clip, "reversible clip");
  const targetRunwayLayers = registerSequence(
    input.targetRunway,
    "target endpoint runway"
  );

  const layerCount = uniqueFrames.length;
  const effectiveLayerLimit = Math.min(
    MAX_RESIDENT_FRAME_LAYERS,
    input.deviceLimits.maxArrayTextureLayers
  );
  if (layerCount > effectiveLayerLimit) {
    throw new RangeError(
      `resident frame layer count ${layerCount} exceeds layer limit ${effectiveLayerLimit}`
    );
  }

  const frameBytes = rgbaBytes(input.width, input.height, 1);
  const clipUniqueLayerCount = new Set(clipLayers).size;
  const clipBytes = frameBytes * BigInt(clipUniqueLayerCount);
  if (clipBytes > BigInt(MAX_REVERSIBLE_CLIP_BYTES)) {
    throw new RangeError("reversible clip bytes exceed the 24 MiB cap");
  }

  const residentBytes = frameBytes * BigInt(layerCount);
  if (residentBytes > BigInt(MAX_RESIDENT_FRAME_BYTES)) {
    throw new RangeError("resident frame bytes exceed the 48 MiB cap");
  }

  const residentAllocationBytes = gpuAllocationBytes(residentBytes);
  const streamingBytes = frameBytes * BigInt(STREAMING_SLOT_COUNT);
  const streamingAllocationBytes = gpuAllocationBytes(streamingBytes);
  const totalGpuAllocationBytes =
    residentAllocationBytes + streamingAllocationBytes;
  const trackedBytes = totalGpuAllocationBytes + frameBytes;
  if (trackedBytes > BigInt(MAX_TRACKED_PLAYER_BYTES)) {
    throw new RangeError("tracked player bytes exceed the 64 MiB cap");
  }

  const frozenUniqueFrames = Object.freeze(uniqueFrames);
  const plan: ResidentFramePlan = {
    width: input.width,
    height: input.height,
    layerCount,
    bytesPerFrame: checkedNumber(frameBytes, "RGBA frame bytes"),
    clipBytes: checkedNumber(clipBytes, "reversible clip bytes"),
    residentBytes: checkedNumber(residentBytes, "resident frame bytes"),
    residentAllocationBytes: checkedNumber(
      residentAllocationBytes,
      "resident allocation bytes"
    ),
    streamingBytes: checkedNumber(streamingBytes, "streaming frame bytes"),
    streamingAllocationBytes: checkedNumber(
      streamingAllocationBytes,
      "streaming allocation bytes"
    ),
    gpuAllocationBytes: checkedNumber(
      totalGpuAllocationBytes,
      "GPU allocation bytes"
    ),
    stagingBytes: checkedNumber(frameBytes, "RGBA staging bytes"),
    trackedBytes: checkedNumber(trackedBytes, "tracked player bytes"),
    uniqueFrames: frozenUniqueFrames,
    sourceRunwayLayers,
    clipLayers,
    targetRunwayLayers,
    layerFor(key) {
      if (!isFrameKey(key)) {
        return undefined;
      }
      return layerByIdentity.get(identityFor(key));
    }
  };

  return Object.freeze(plan);
}

function gpuAllocationBytes(bytes: bigint): bigint {
  return (
    (bytes * GPU_OVERHEAD_NUMERATOR) /
    GPU_OVERHEAD_DENOMINATOR
  );
}

function rgbaBytes(width: number, height: number, layers: number): bigint {
  return (
    BigInt(width) *
    BigInt(height) *
    BYTES_PER_RGBA_PIXEL *
    BigInt(layers)
  );
}

function validateDeviceLimits(limits: ResidentFrameDeviceLimits): void {
  validateObject(limits, "resident frame device limits");
  validatePositiveSafeInteger(
    limits.maxArrayTextureLayers,
    "MAX_ARRAY_TEXTURE_LAYERS"
  );
  validatePositiveSafeInteger(limits.maxTextureSize, "MAX_TEXTURE_SIZE");
}

function validateSequenceLength(
  sequence: readonly ResidentFrameKey[],
  label: string,
  minimum: number,
  maximum: number
): void {
  if (!Array.isArray(sequence)) {
    throw new TypeError(`${label} must be an array`);
  }
  if (sequence.length < minimum || sequence.length > maximum) {
    throw new RangeError(
      `${label} must contain ${minimum}–${maximum} frames`
    );
  }
}

function cloneFrameKey(
  candidate: ResidentFrameKey,
  label: string
): Readonly<ResidentFrameKey> {
  if (!isFrameKey(candidate)) {
    throw new TypeError(
      `${label} must have non-empty rendition and unit strings and a non-negative safe local frame`
    );
  }

  return Object.freeze({
    rendition: candidate.rendition,
    unit: candidate.unit,
    localFrame: candidate.localFrame
  });
}

function isFrameKey(candidate: unknown): candidate is ResidentFrameKey {
  if (candidate === null || typeof candidate !== "object") {
    return false;
  }

  const record = candidate as Partial<ResidentFrameKey>;
  return (
    typeof record.rendition === "string" &&
    record.rendition.trim().length > 0 &&
    typeof record.unit === "string" &&
    record.unit.trim().length > 0 &&
    Number.isSafeInteger(record.localFrame) &&
    (record.localFrame ?? -1) >= 0
  );
}

function identityFor(key: ResidentFrameKey): string {
  return JSON.stringify([key.rendition, key.unit, key.localFrame]);
}

function checkedNumber(value: bigint, label: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`${label} exceeds JavaScript's safe-integer range`);
  }
  return Number(value);
}

function validatePositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
}

function validateObject(value: unknown, label: string): asserts value is object {
  if (value === null || typeof value !== "object") {
    throw new TypeError(`${label} must be an object`);
  }
}
