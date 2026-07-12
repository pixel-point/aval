import type { RenditionV01, UnitV01 } from "@rendered-motion/format";

import {
  DECODER_WORKER_HARD_LIMITS,
  type DecoderWorkerLimits,
  type DecoderWorkerSample
} from "../decoder-worker/protocol.js";
import type {
  RuntimeCatalogAccessUnit,
  RuntimeCatalogIdIndex,
  RuntimeCatalogRecordIndex
} from "./asset-catalog.js";
import {
  DecodeTimeline,
  type DecodeTimelineFrameRequest
} from "./decode-timeline.js";

export interface WorkerSampleCatalog {
  readonly renditions: Pick<RuntimeCatalogIdIndex<RenditionV01>, "require">;
  readonly units: Pick<RuntimeCatalogIdIndex<UnitV01>, "require">;
  readonly records: Pick<RuntimeCatalogRecordIndex, "require">;
  copySample(rendition: string, unit: string, localFrame: number): ArrayBuffer;
}

export interface WorkerSampleFrameRequest {
  readonly unitId: string;
  readonly unitFrame: number;
}

export interface CreateWorkerSampleBatchInput {
  readonly frames: readonly WorkerSampleFrameRequest[];
  readonly pendingSamples: number;
  readonly outstandingFrames: number;
}

export interface DecoderWorkerSampleBatch {
  readonly generation: number;
  readonly samples: readonly Readonly<DecoderWorkerSample>[];
}

export interface WorkerSampleFactoryOptions {
  readonly catalog: WorkerSampleCatalog;
  readonly timeline: DecodeTimeline;
  readonly rendition: string;
  readonly limits: DecoderWorkerLimits;
}

interface ValidatedFrameRequest {
  readonly request: WorkerSampleFrameRequest;
  readonly unit: Readonly<UnitV01>;
  readonly accessUnit: Readonly<RuntimeCatalogAccessUnit>;
}

/** Sole owner that joins catalog records, timeline identity, and sample bytes. */
export class WorkerSampleFactory {
  readonly #catalog: WorkerSampleCatalog;
  readonly #timeline: DecodeTimeline;
  readonly #rendition: string;
  readonly #limits: Readonly<DecoderWorkerLimits>;

  public constructor(options: WorkerSampleFactoryOptions) {
    validateWorkerLimits(options.limits);
    const rendition = options.catalog.renditions.require(options.rendition);
    if (
      rendition.profile !== "avc-annexb-opaque-v0" ||
      rendition.codec !== "avc1.42E020"
    ) {
      throw new RangeError(
        "worker sample factory requires an exact opaque AVC rendition"
      );
    }

    this.#catalog = options.catalog;
    this.#timeline = options.timeline;
    this.#rendition = options.rendition;
    this.#limits = Object.freeze({
      maxDecodeQueueSize: options.limits.maxDecodeQueueSize,
      maxPendingSamples: options.limits.maxPendingSamples,
      maxOutstandingFrames: options.limits.maxOutstandingFrames,
      maxDecodedBytes: options.limits.maxDecodedBytes
    });
  }

  public createBatch(
    input: CreateWorkerSampleBatchInput
  ): Readonly<DecoderWorkerSampleBatch> {
    validateBatchCredit(input, this.#limits);

    const validated: ValidatedFrameRequest[] = [];
    const timelineFrames: DecodeTimelineFrameRequest[] = [];
    for (const request of input.frames) {
      validateFrameRequest(request);
      const unit = this.#catalog.units.require(request.unitId);
      const accessUnit = this.#catalog.records.require(
        this.#rendition,
        request.unitId,
        request.unitFrame
      );
      validateCatalogRecord(
        accessUnit,
        unit,
        this.#rendition,
        request
      );
      validated.push(Object.freeze({ request, unit, accessUnit }));
      timelineFrames.push(Object.freeze({
        unitId: request.unitId,
        unitFrame: request.unitFrame,
        unitFrameCount: unit.frameCount
      }));
    }

    // Planning validates the complete occurrence grammar and clock without
    // advancing any counter. Payload allocation starts only after this point.
    const timelinePlan = this.#timeline.planSampleBatch(timelineFrames);
    const samples: DecoderWorkerSample[] = [];
    const buffers = new Set<ArrayBuffer>();
    for (let index = 0; index < validated.length; index += 1) {
      const frame = validated[index];
      const metadata = timelinePlan.samples[index];
      if (frame === undefined || metadata === undefined) {
        throw new RangeError("worker sample batch metadata relation is sparse");
      }

      const data = this.#catalog.copySample(
        this.#rendition,
        frame.request.unitId,
        frame.request.unitFrame
      );
      if (!(data instanceof ArrayBuffer)) {
        throw new RangeError("catalog sample copy must be an ArrayBuffer");
      }
      if (data.byteLength !== frame.accessUnit.range.length) {
        throw new RangeError(
          "catalog sample copy must have the exact record length"
        );
      }
      if (buffers.has(data)) {
        throw new RangeError(
          "every worker sample must own a distinct ArrayBuffer"
        );
      }
      buffers.add(data);

      samples.push(Object.freeze({
        ordinal: metadata.ordinal,
        unitId: metadata.unitId,
        unitInstance: metadata.unitInstance,
        unitFrame: metadata.unitFrame,
        unitFrameCount: metadata.unitFrameCount,
        type: frame.accessUnit.record.key ? "key" : "delta",
        timestamp: metadata.timestamp,
        duration: metadata.duration,
        data
      }));
    }

    const batch = Object.freeze({
      generation: timelinePlan.generation,
      samples: Object.freeze(samples)
    });
    timelinePlan.commit();
    return batch;
  }
}

function validateWorkerLimits(limits: DecoderWorkerLimits): void {
  validateBoundedPositiveInteger(
    limits.maxDecodeQueueSize,
    DECODER_WORKER_HARD_LIMITS.maxDecodeQueueSize,
    "worker decode queue limit"
  );
  validateBoundedPositiveInteger(
    limits.maxPendingSamples,
    DECODER_WORKER_HARD_LIMITS.maxPendingSamples,
    "worker pending sample limit"
  );
  validateBoundedPositiveInteger(
    limits.maxOutstandingFrames,
    DECODER_WORKER_HARD_LIMITS.maxOutstandingFrames,
    "worker outstanding frame limit"
  );
  validateBoundedPositiveInteger(
    limits.maxDecodedBytes,
    DECODER_WORKER_HARD_LIMITS.maxDecodedBytes,
    "worker decoded byte limit"
  );
}

function validateBatchCredit(
  input: CreateWorkerSampleBatchInput,
  limits: Readonly<DecoderWorkerLimits>
): void {
  if (
    !Array.isArray(input.frames) ||
    input.frames.length < 1 ||
    input.frames.length > DECODER_WORKER_HARD_LIMITS.maxPendingSamples
  ) {
    throw new RangeError(
      "worker sample batch length exceeds the hard sample limit"
    );
  }
  validateNonNegativeSafeInteger(input.pendingSamples, "pending sample count");
  validateNonNegativeSafeInteger(
    input.outstandingFrames,
    "outstanding frame count"
  );
  if (
    input.pendingSamples > limits.maxPendingSamples ||
    input.frames.length > limits.maxPendingSamples - input.pendingSamples
  ) {
    throw new RangeError("worker sample batch exceeds the pending sample limit");
  }
  if (
    input.outstandingFrames > limits.maxOutstandingFrames ||
    input.frames.length >
      limits.maxOutstandingFrames - input.outstandingFrames
  ) {
    throw new RangeError("worker sample batch exceeds the outstanding frame limit");
  }
}

function validateFrameRequest(request: WorkerSampleFrameRequest): void {
  if (
    typeof request.unitId !== "string" ||
    request.unitId.length < 1 ||
    request.unitId.length > 128
  ) {
    throw new RangeError("worker sample unit ID length must be 1-128");
  }
  validateNonNegativeSafeInteger(request.unitFrame, "worker sample unit frame");
}

function validateCatalogRecord(
  accessUnit: Readonly<RuntimeCatalogAccessUnit>,
  unit: Readonly<UnitV01>,
  rendition: string,
  request: WorkerSampleFrameRequest
): void {
  if (
    !Number.isSafeInteger(unit.frameCount) ||
    unit.frameCount <= 0 ||
    request.unitFrame >= unit.frameCount
  ) {
    throw new RangeError("worker sample unit frame is outside its unit");
  }
  if (
    accessUnit.rendition !== rendition ||
    accessUnit.unit !== request.unitId ||
    accessUnit.localFrame !== request.unitFrame ||
    accessUnit.record.frameIndex !== request.unitFrame
  ) {
    throw new RangeError("catalog access-unit identity did not match the request");
  }
  if (
    !Number.isSafeInteger(accessUnit.range.length) ||
    accessUnit.range.length < 1 ||
    accessUnit.range.length > DECODER_WORKER_HARD_LIMITS.maxSampleBytes ||
    accessUnit.record.payloadLength !== accessUnit.range.length
  ) {
    throw new RangeError("catalog sample byte length exceeds the worker limit");
  }
  if (typeof accessUnit.record.key !== "boolean") {
    throw new RangeError("catalog sample key marker must be boolean");
  }
}

function validateBoundedPositiveInteger(
  value: number,
  maximum: number,
  label: string
): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new RangeError(
      `${label} must be a positive integer no greater than ${String(maximum)}`
    );
  }
}

function validateNonNegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
}
