import { maximumAvcDecodedRgbaBytes } from "@rendered-motion/format";

import type { DecoderWorkerConfigureOptions } from "../decoder-worker/client.js";
import { DECODER_WORKER_HARD_LIMITS } from "../decoder-worker/protocol.js";
import type { IntegratedCandidateAttemptContext } from "./integrated-player-contracts.js";
import type { OpaqueCandidateWorkerSetup } from "./opaque-candidate-factory-model.js";
import { RESOURCE_DECODE_SURFACE_COUNT } from "./resource-plan.js";

/** Derive the only accepted worker configuration from inspected asset facts. */
export function createOpaqueCandidateWorkerSetup(
  context: Readonly<IntegratedCandidateAttemptContext>
): Readonly<OpaqueCandidateWorkerSetup> {
  const rendition = context.candidate.rendition;
  const parameterSet = context.inspection.parameterSet;
  if (
    rendition.codec !== "avc1.42E020" ||
    rendition.codedWidth !== parameterSet.codedWidth ||
    rendition.codedHeight !== parameterSet.codedHeight ||
    parameterSet.crop.visibleWidth < 1 ||
    parameterSet.crop.visibleHeight < 1 ||
    parameterSet.crop.left < 0 ||
    parameterSet.crop.top < 0 ||
    parameterSet.crop.left + parameterSet.crop.visibleWidth >
      parameterSet.codedWidth ||
    parameterSet.crop.top + parameterSet.crop.visibleHeight >
      parameterSet.codedHeight ||
    parameterSet.color.fullRange ||
    parameterSet.color.colourPrimaries !== 1 ||
    parameterSet.color.transferCharacteristics !== 1 ||
    parameterSet.color.matrixCoefficients !== 1
  ) {
    throw new RangeError(
      "opaque candidate inspection does not match its exact decoder profile"
    );
  }

  const decodedBytesPerSurface = maximumAvcDecodedRgbaBytes(
    parameterSet.codedWidth,
    parameterSet.codedHeight
  );
  if (
    decodedBytesPerSurface >
      Math.floor(Number.MAX_SAFE_INTEGER / RESOURCE_DECODE_SURFACE_COUNT)
  ) {
    throw new RangeError("opaque candidate decoded byte limit is unsafe");
  }
  const maxDecodedBytes =
    decodedBytesPerSurface * RESOURCE_DECODE_SURFACE_COUNT;
  if (maxDecodedBytes > DECODER_WORKER_HARD_LIMITS.maxDecodedBytes) {
    throw new RangeError(
      "opaque candidate decoded surfaces exceed the worker byte limit"
    );
  }

  const limits = Object.freeze({
    maxDecodeQueueSize: DECODER_WORKER_HARD_LIMITS.maxDecodeQueueSize,
    maxPendingSamples: DECODER_WORKER_HARD_LIMITS.maxPendingSamples,
    maxOutstandingFrames: RESOURCE_DECODE_SURFACE_COUNT,
    maxDecodedBytes
  });
  const configure: Readonly<DecoderWorkerConfigureOptions> = Object.freeze({
    config: Object.freeze({
      codec: "avc1.42E020" as const,
      codedWidth: rendition.codedWidth,
      codedHeight: rendition.codedHeight,
      hardwareAcceleration: "no-preference" as const,
      optimizeForLatency: true as const
    }),
    avcProfile: Object.freeze({
      codedWidth: rendition.codedWidth,
      codedHeight: rendition.codedHeight,
      frameRate: Object.freeze({
        numerator: context.catalog.manifest.frameRate.numerator,
        denominator: context.catalog.manifest.frameRate.denominator
      }),
      averageBitrate: rendition.bitrate.average,
      peakBitrate: rendition.bitrate.peak,
      cpbBufferBits: rendition.bitrate.peak,
      requireBt709LimitedRange: true as const
    }),
    expectedOutput: Object.freeze({
      codedWidth: parameterSet.codedWidth,
      codedHeight: parameterSet.codedHeight,
      displayWidth: parameterSet.crop.visibleWidth,
      displayHeight: parameterSet.crop.visibleHeight,
      visibleRect: Object.freeze({
        x: parameterSet.crop.left,
        y: parameterSet.crop.top,
        width: parameterSet.crop.visibleWidth,
        height: parameterSet.crop.visibleHeight
      }),
      colorSpace: Object.freeze({
        fullRange: false,
        matrix: "bt709" as const,
        primaries: "bt709" as const,
        transfer: "bt709" as const
      })
    }),
    limits
  });
  return Object.freeze({ configure, limits });
}
