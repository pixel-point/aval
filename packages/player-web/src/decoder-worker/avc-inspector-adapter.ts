import { AvcIncrementalInspector } from "@rendered-motion/format";

import {
  type DecoderWorkerAvcProfile,
  type DecoderWorkerSample
} from "./protocol.js";

export interface WorkerAvcSampleInspection {
  readonly chunkType: EncodedVideoChunkType;
}

export interface WorkerAvcInspector {
  inspect(input: {
    readonly unitId: string;
    readonly unitInstance: number;
    readonly unitFrame: number;
    readonly unitFrameCount: number;
    readonly key: boolean;
    readonly bytes: Uint8Array;
  }): WorkerAvcSampleInspection;
  resetUnitSequence(): void;
}

export type WorkerAvcInspectorFactory = (
  profile: DecoderWorkerAvcProfile
) => WorkerAvcInspector;

export function createDefaultWorkerAvcInspector(
  profile: DecoderWorkerAvcProfile
): WorkerAvcInspector {
  return new AvcIncrementalInspector(profile);
}

export function inspectWorkerSample(
  inspector: WorkerAvcInspector,
  sample: DecoderWorkerSample
): DecoderWorkerSample {
  const inspection = inspector.inspect({
    unitId: sample.unitId,
    unitInstance: sample.unitInstance,
    unitFrame: sample.unitFrame,
    unitFrameCount: sample.unitFrameCount,
    key: sample.type === "key",
    bytes: new Uint8Array(sample.data)
  });
  return inspection.chunkType === sample.type
    ? sample
    : Object.freeze({ ...sample, type: inspection.chunkType });
}
