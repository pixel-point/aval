import {
  MAX_INTERACTION_CACHE_LAYERS,
  MAX_REVERSIBLE_CLIP_BYTES,
  MAX_REVERSIBLE_CLIP_FRAMES,
  MAX_REVERSIBLE_ENDPOINT_PAIR_BYTES,
  MAX_ENDPOINT_RUNWAY_FRAMES,
  MIN_ENDPOINT_RUNWAY_FRAMES,
  MIN_REVERSIBLE_CLIP_FRAMES,
  createInteractionCachePlanFromSemanticSequences,
  type InteractionCacheDeviceLimits,
  type InteractionCacheLayer
} from "../runtime/interaction-cache-plan.js";
import {
  MAX_PLAYER_RUNTIME_BYTES,
  STREAMING_TEXTURE_LAYER_COUNT,
  checkedByteNumber,
  checkedByteSum,
  roundedGpuAllocationBytes,
  validatePositiveSafeInteger
} from "../runtime/checked-runtime-bytes.js";
import type { RuntimeFrameKey } from "../runtime/model.js";

export {
  MAX_ENDPOINT_RUNWAY_FRAMES,
  MAX_REVERSIBLE_CLIP_BYTES,
  MAX_REVERSIBLE_CLIP_FRAMES,
  MIN_ENDPOINT_RUNWAY_FRAMES,
  MIN_REVERSIBLE_CLIP_FRAMES
};
export const MAX_RESIDENT_FRAME_LAYERS = MAX_INTERACTION_CACHE_LAYERS;
export const STREAMING_SLOT_COUNT = STREAMING_TEXTURE_LAYER_COUNT;
/** Legacy M2 name; the generalized owner applies this to each endpoint pair. */
export const MAX_RESIDENT_FRAME_BYTES = MAX_REVERSIBLE_ENDPOINT_PAIR_BYTES;
export const MAX_TRACKED_PLAYER_BYTES = MAX_PLAYER_RUNTIME_BYTES;

export type ResidentFrameKey = RuntimeFrameKey;
export type ResidentFrameDeviceLimits = InteractionCacheDeviceLimits;

export interface ResidentFramePlanInput {
  readonly width: number;
  readonly height: number;
  readonly sourceRunway: readonly ResidentFrameKey[];
  readonly clip: readonly ResidentFrameKey[];
  readonly targetRunway: readonly ResidentFrameKey[];
  readonly deviceLimits: Readonly<ResidentFrameDeviceLimits>;
}

export type ResidentFrameLayer = InteractionCacheLayer;

/** Compatibility view retained for the M2 renderer and tests. */
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

/** Thin M2 adapter over the sole generalized frame-key/layer planner. */
export function createResidentFramePlan(
  input: ResidentFramePlanInput
): Readonly<ResidentFramePlan> {
  validateObject(input, "resident frame plan input");
  validatePositiveSafeInteger(input.width, "resident frame width");
  validatePositiveSafeInteger(input.height, "resident frame height");
  validateLegacyDeviceLimits(input.deviceLimits);
  if (input.width > input.deviceLimits.maxTextureSize) {
    throw new RangeError("resident frame width exceeds MAX_TEXTURE_SIZE");
  }
  if (input.height > input.deviceLimits.maxTextureSize) {
    throw new RangeError("resident frame height exceeds MAX_TEXTURE_SIZE");
  }
  validateLegacySequence(
    input.sourceRunway,
    "source endpoint runway",
    MIN_ENDPOINT_RUNWAY_FRAMES,
    MAX_ENDPOINT_RUNWAY_FRAMES
  );
  validateLegacySequence(
    input.clip,
    "reversible clip",
    MIN_REVERSIBLE_CLIP_FRAMES,
    MAX_REVERSIBLE_CLIP_FRAMES
  );
  validateLegacySequence(
    input.targetRunway,
    "target endpoint runway",
    MIN_ENDPOINT_RUNWAY_FRAMES,
    MAX_ENDPOINT_RUNWAY_FRAMES
  );

  const plan = createInteractionCachePlanFromSemanticSequences({
    rendition: firstRendition(input),
    width: input.width,
    height: input.height,
    reversibleClips: [{
      unit: "legacy.reversible",
      sourceEndpoint: {
        state: "legacy.source",
        port: "default",
        frames: input.sourceRunway
      },
      clip: input.clip,
      targetEndpoint: {
        state: "legacy.target",
        port: "default",
        frames: input.targetRunway
      }
    }],
    cutRunways: [],
    deviceLimits: input.deviceLimits,
    allowMixedRenditions: true
  });
  const reversible = plan.reversibleClips[0]!;
  if (plan.persistentBytes > MAX_RESIDENT_FRAME_BYTES) {
    throw new RangeError("resident frame bytes exceed the 48 MiB cap");
  }

  const residentAllocation = roundedGpuAllocationBytes(plan.persistentBytes);
  const streamingBytes = BigInt(plan.bytesPerFrame) *
    BigInt(STREAMING_SLOT_COUNT);
  const streamingAllocation = roundedGpuAllocationBytes(streamingBytes);
  const gpuAllocation = checkedByteSum(
    [residentAllocation, streamingAllocation],
    "GPU allocation bytes"
  );
  const tracked = checkedByteSum(
    [gpuAllocation, plan.bytesPerFrame],
    "tracked player bytes"
  );
  if (tracked > BigInt(MAX_TRACKED_PLAYER_BYTES)) {
    throw new RangeError("tracked player bytes exceed the 64 MiB cap");
  }

  return Object.freeze({
    width: input.width,
    height: input.height,
    layerCount: plan.layerCount,
    bytesPerFrame: plan.bytesPerFrame,
    clipBytes: reversible.clipBytes,
    residentBytes: plan.persistentBytes,
    residentAllocationBytes: checkedByteNumber(
      residentAllocation,
      "resident allocation bytes"
    ),
    streamingBytes: checkedByteNumber(streamingBytes, "streaming frame bytes"),
    streamingAllocationBytes: checkedByteNumber(
      streamingAllocation,
      "streaming allocation bytes"
    ),
    gpuAllocationBytes: checkedByteNumber(gpuAllocation, "GPU allocation bytes"),
    stagingBytes: plan.bytesPerFrame,
    trackedBytes: checkedByteNumber(tracked, "tracked player bytes"),
    uniqueFrames: plan.uniqueFrames,
    sourceRunwayLayers: reversible.sourceEndpoint.layers,
    clipLayers: reversible.clip.layers,
    targetRunwayLayers: reversible.targetEndpoint.layers,
    layerFor(key: ResidentFrameKey) {
      return plan.layerFor(key);
    }
  });
}

function firstRendition(input: ResidentFramePlanInput): string {
  for (const sequence of [input.sourceRunway, input.clip, input.targetRunway]) {
    const rendition = sequence[0]?.rendition;
    if (typeof rendition === "string" && rendition.trim().length > 0) {
      return rendition;
    }
  }
  return "legacy";
}

function validateLegacyDeviceLimits(limits: ResidentFrameDeviceLimits): void {
  validateObject(limits, "resident frame device limits");
  validatePositiveSafeInteger(
    limits.maxArrayTextureLayers,
    "MAX_ARRAY_TEXTURE_LAYERS"
  );
  validatePositiveSafeInteger(limits.maxTextureSize, "MAX_TEXTURE_SIZE");
}

function validateLegacySequence(
  sequence: readonly ResidentFrameKey[],
  label: string,
  minimum: number,
  maximum: number
): void {
  if (!Array.isArray(sequence)) throw new TypeError(`${label} must be an array`);
  if (sequence.length < minimum || sequence.length > maximum) {
    throw new RangeError(
      `${label} must contain ${String(minimum)}–${String(maximum)} frames`
    );
  }
}

function validateObject(value: unknown, label: string): asserts value is object {
  if (value === null || typeof value !== "object") {
    throw new TypeError(`${label} must be an object`);
  }
}
