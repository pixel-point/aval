import {
  timestampForFrame,
  validateFrameRate,
  type RationalFrameRate
} from "./rational-time.js";
import {
  MAX_PRESENTATION_RING_CAPACITY,
  MIN_PRESENTATION_RING_CAPACITY
} from "./presentation-ring.js";

export const MIN_READINESS_MEASURED_OUTPUTS = 24 as const;
export const MIN_READINESS_THROUGHPUT_MULTIPLE = 1.5 as const;
export const READINESS_RECOVERY_MARGIN_FRAMES = 1 as const;
export const MIN_READINESS_RING_CAPACITY = MIN_PRESENTATION_RING_CAPACITY;
export const MAX_READINESS_RING_CAPACITY = MAX_PRESENTATION_RING_CAPACITY;

const MAX_MEDIA_ID_LENGTH = 128;

export interface ReadinessMediaIdentity {
  readonly path: string;
  readonly unit: string;
  readonly unitInstance: number;
  readonly localFrame: number;
}

/** One completed worker-output/upload observation on a monotonic millisecond clock. */
export interface ReadinessFrameMeasurement {
  readonly outputOrdinal: number;
  readonly media: Readonly<ReadinessMediaIdentity>;
  readonly submitTimeMs: number;
  readonly workerOutputTimeMs: number;
  readonly uploadReadyTimeMs: number;
  readonly idealDeadlineMs: number;
}

export interface ReadinessFrameMetric extends ReadinessFrameMeasurement {
  readonly sequenceIndex: number;
  readonly decodeLatencyMs: number;
  readonly uploadLatencyMs: number;
  readonly outputLeadMs: number;
  readonly uploadLeadMs: number;
  readonly rollingMinimumUploadLeadMs: number;
}

export type ReadinessMetricFailureReason =
  | "measured-output-count"
  | "throughput"
  | "upload-deadline"
  | "ring-capacity";

export interface ReadinessMetricsInput {
  readonly frameRate: Readonly<RationalFrameRate>;
  readonly measurements: readonly Readonly<ReadinessFrameMeasurement>[];
}

export interface ReadinessMetricsReport {
  readonly passed: boolean;
  readonly failureReasons: readonly ReadinessMetricFailureReason[];
  readonly frameRate: Readonly<RationalFrameRate>;
  readonly sampleCount: number;
  readonly measuredOutputsPassed: boolean;
  readonly nominalFrameDurationMs: number;
  readonly p99DecodeLatencyMs: number;
  readonly p99UploadLatencyMs: number;
  readonly decodeLeadFrames: number;
  /** Upload-inclusive lead including the normal one-frame scheduling guard. */
  readonly uploadLeadFrames: number;
  /** Decode lead plus the frozen one-frame recovery margin. */
  readonly recoveryLeadFrames: number;
  readonly requiredRingCapacity: number;
  readonly ringCapacity: number | null;
  readonly ringPassed: boolean;
  readonly measuredIntervalMs: number;
  readonly measuredMediaDurationMs: number;
  readonly throughputMultiple: number;
  readonly throughputPassed: boolean;
  readonly minimumUploadLeadMs: number;
  readonly minimumUploadLeadFrames: number;
  readonly frames: readonly Readonly<ReadinessFrameMetric>[];
}

export interface ReadinessMetricsRecorderOptions {
  readonly frameRate: Readonly<RationalFrameRate>;
  readonly now: () => number;
}

export interface ReadinessRecorderSubmission {
  readonly outputOrdinal: number;
  readonly media: Readonly<ReadinessMediaIdentity>;
  readonly idealDeadlineMs: number;
}

interface MutableRecordedMeasurement {
  readonly outputOrdinal: number;
  readonly media: Readonly<ReadinessMediaIdentity>;
  readonly submitTimeMs: number;
  readonly idealDeadlineMs: number;
  workerOutputTimeMs: number | null;
  uploadReadyTimeMs: number | null;
}

/**
 * Captures readiness observations from one injected high-resolution clock.
 * The recorder owns event ordering; the pure calculator below owns statistics.
 */
export class ReadinessMetricsRecorder {
  readonly #frameRate: Readonly<RationalFrameRate>;
  readonly #now: () => number;
  readonly #records = new Map<number, MutableRecordedMeasurement>();
  readonly #submissionOrder: number[] = [];
  #lastClockMs: number | null = null;
  #lastOutputOrdinal: number | null = null;
  #lastIdealDeadlineMs: number | null = null;

  public constructor(options: ReadinessMetricsRecorderOptions) {
    validateObject(options, "readiness recorder options");
    if (typeof options.now !== "function") {
      throw new TypeError("readiness recorder clock must be a function");
    }
    validateFrameRate(options.frameRate);
    this.#frameRate = Object.freeze({
      numerator: options.frameRate.numerator,
      denominator: options.frameRate.denominator
    });
    this.#now = options.now;
  }

  public submit(submission: ReadinessRecorderSubmission): void {
    validateObject(submission, "readiness submission");
    validateOrdinal(submission.outputOrdinal);
    const expected = this.#lastOutputOrdinal === null
      ? submission.outputOrdinal
      : checkedIncrement(this.#lastOutputOrdinal, "output ordinal");
    if (submission.outputOrdinal !== expected) {
      throw new RangeError(
        "readiness output ordinals must be contiguous and increasing"
      );
    }
    validateFiniteNonNegative(
      submission.idealDeadlineMs,
      "ideal readiness deadline"
    );
    if (
      this.#lastIdealDeadlineMs !== null &&
      submission.idealDeadlineMs <= this.#lastIdealDeadlineMs
    ) {
      throw new RangeError("ideal readiness deadlines must increase");
    }
    const media = copyMediaIdentity(submission.media);
    const submitTimeMs = this.#readClock();

    this.#records.set(submission.outputOrdinal, {
      outputOrdinal: submission.outputOrdinal,
      media,
      submitTimeMs,
      idealDeadlineMs: submission.idealDeadlineMs,
      workerOutputTimeMs: null,
      uploadReadyTimeMs: null
    });
    this.#submissionOrder.push(submission.outputOrdinal);
    this.#lastOutputOrdinal = submission.outputOrdinal;
    this.#lastIdealDeadlineMs = submission.idealDeadlineMs;
  }

  public workerOutput(outputOrdinal: number): void {
    const record = this.#requireRecord(outputOrdinal);
    if (record.workerOutputTimeMs !== null) {
      throw new RangeError("worker output was already recorded");
    }
    record.workerOutputTimeMs = this.#readClock();
  }

  public uploadReady(outputOrdinal: number): void {
    const record = this.#requireRecord(outputOrdinal);
    if (record.workerOutputTimeMs === null) {
      throw new RangeError("upload readiness requires a worker output");
    }
    if (record.uploadReadyTimeMs !== null) {
      throw new RangeError("upload readiness was already recorded");
    }
    record.uploadReadyTimeMs = this.#readClock();
  }

  public report(): Readonly<ReadinessMetricsReport> {
    if (this.#submissionOrder.length < 1) {
      throw new RangeError("readiness recorder has no measurements");
    }
    const measurements = this.#submissionOrder.map((ordinal) => {
      const record = this.#records.get(ordinal)!;
      if (
        record.workerOutputTimeMs === null ||
        record.uploadReadyTimeMs === null
      ) {
        throw new RangeError("readiness recorder has incomplete measurements");
      }
      return {
        outputOrdinal: record.outputOrdinal,
        media: record.media,
        submitTimeMs: record.submitTimeMs,
        workerOutputTimeMs: record.workerOutputTimeMs,
        uploadReadyTimeMs: record.uploadReadyTimeMs,
        idealDeadlineMs: record.idealDeadlineMs
      };
    });
    return calculateReadinessMetrics({
      frameRate: this.#frameRate,
      measurements
    });
  }

  #requireRecord(outputOrdinal: number): MutableRecordedMeasurement {
    validateOrdinal(outputOrdinal);
    const record = this.#records.get(outputOrdinal);
    if (record === undefined) {
      throw new RangeError("readiness output ordinal is unknown");
    }
    return record;
  }

  #readClock(): number {
    const value = this.#now();
    validateFiniteNonNegative(value, "readiness clock value");
    if (this.#lastClockMs !== null && value < this.#lastClockMs) {
      throw new RangeError("readiness clock must be monotonic");
    }
    this.#lastClockMs = value;
    return value;
  }
}

/** Calculates the frozen warm-up/readiness statistics from completed samples. */
export function calculateReadinessMetrics(
  input: ReadinessMetricsInput
): Readonly<ReadinessMetricsReport> {
  validateObject(input, "readiness metrics input");
  validateFrameRate(input.frameRate);
  if (!Array.isArray(input.measurements) || input.measurements.length < 1) {
    throw new RangeError("readiness metrics require at least one measurement");
  }

  const frameRate = Object.freeze({
    numerator: input.frameRate.numerator,
    denominator: input.frameRate.denominator
  });
  const nominalFrameDurationMs =
    1_000 * frameRate.denominator / frameRate.numerator;
  validateFinitePositive(
    nominalFrameDurationMs,
    "nominal content-frame duration"
  );

  let previousOrdinal: number | null = null;
  let previousSubmit = -1;
  let previousOutput = -1;
  let previousUpload = -1;
  let previousDeadline = -1;
  let rollingMinimumLead = Number.POSITIVE_INFINITY;
  const decodeLatencies: number[] = [];
  const uploadLatencies: number[] = [];
  const frames: ReadinessFrameMetric[] = [];

  for (let index = 0; index < input.measurements.length; index += 1) {
    const measurement = input.measurements[index]!;
    validateObject(measurement, "readiness frame measurement");
    validateOrdinal(measurement.outputOrdinal);
    if (
      previousOrdinal !== null &&
      measurement.outputOrdinal !== checkedIncrement(
        previousOrdinal,
        "output ordinal"
      )
    ) {
      throw new RangeError(
        "readiness output ordinals must be contiguous and increasing"
      );
    }
    const media = copyMediaIdentity(measurement.media);
    validateFiniteNonNegative(measurement.submitTimeMs, "submit time");
    validateFiniteNonNegative(
      measurement.workerOutputTimeMs,
      "worker output time"
    );
    validateFiniteNonNegative(
      measurement.uploadReadyTimeMs,
      "upload-ready time"
    );
    validateFiniteNonNegative(
      measurement.idealDeadlineMs,
      "ideal readiness deadline"
    );
    if (
      measurement.workerOutputTimeMs < measurement.submitTimeMs ||
      measurement.uploadReadyTimeMs < measurement.workerOutputTimeMs
    ) {
      throw new RangeError(
        "readiness frame times must follow submit, output, upload order"
      );
    }
    if (
      measurement.submitTimeMs < previousSubmit ||
      measurement.workerOutputTimeMs < previousOutput ||
      measurement.uploadReadyTimeMs < previousUpload
    ) {
      throw new RangeError("readiness measurement clocks must be monotonic");
    }
    if (measurement.idealDeadlineMs <= previousDeadline) {
      throw new RangeError("ideal readiness deadlines must increase");
    }

    const decodeLatencyMs =
      measurement.workerOutputTimeMs - measurement.submitTimeMs;
    const uploadLatencyMs =
      measurement.uploadReadyTimeMs - measurement.submitTimeMs;
    const outputLeadMs =
      measurement.idealDeadlineMs - measurement.workerOutputTimeMs;
    const uploadLeadMs =
      measurement.idealDeadlineMs - measurement.uploadReadyTimeMs;
    rollingMinimumLead = Math.min(rollingMinimumLead, uploadLeadMs);
    decodeLatencies.push(decodeLatencyMs);
    uploadLatencies.push(uploadLatencyMs);
    frames.push(Object.freeze({
      sequenceIndex: index,
      outputOrdinal: measurement.outputOrdinal,
      media,
      submitTimeMs: measurement.submitTimeMs,
      workerOutputTimeMs: measurement.workerOutputTimeMs,
      uploadReadyTimeMs: measurement.uploadReadyTimeMs,
      idealDeadlineMs: measurement.idealDeadlineMs,
      decodeLatencyMs,
      uploadLatencyMs,
      outputLeadMs,
      uploadLeadMs,
      rollingMinimumUploadLeadMs: rollingMinimumLead
    }));

    previousOrdinal = measurement.outputOrdinal;
    previousSubmit = measurement.submitTimeMs;
    previousOutput = measurement.workerOutputTimeMs;
    previousUpload = measurement.uploadReadyTimeMs;
    previousDeadline = measurement.idealDeadlineMs;
  }

  const p99DecodeLatencyMs = nearestRankPercentile(decodeLatencies, 0.99);
  const p99UploadLatencyMs = nearestRankPercentile(uploadLatencies, 0.99);
  const decodeLeadFrames = checkedIncrement(
    ceilRatioWithFloatingTolerance(
      p99DecodeLatencyMs,
      nominalFrameDurationMs
    ),
    "decode lead"
  );
  const uploadLeadFrames = checkedIncrement(
    ceilRatioWithFloatingTolerance(
      p99UploadLatencyMs,
      nominalFrameDurationMs
    ),
    "upload lead"
  );
  const recoveryLeadFrames = Math.max(
    checkedIncrement(decodeLeadFrames, "recovery lead"),
    uploadLeadFrames
  );
  const requiredRingCapacity = Math.max(
    MIN_READINESS_RING_CAPACITY,
    recoveryLeadFrames
  );
  const ringPassed = requiredRingCapacity <= MAX_READINESS_RING_CAPACITY;
  const ringCapacity = ringPassed ? requiredRingCapacity : null;
  const first = frames[0]!;
  const final = frames.at(-1)!;
  const measuredIntervalMs =
    final.uploadReadyTimeMs - first.submitTimeMs;
  const measuredMediaDurationMs = checkedFiniteProduct(
    frames.length,
    nominalFrameDurationMs,
    "measured media duration"
  );
  const throughputMultiple = measuredIntervalMs === 0
    ? Number.POSITIVE_INFINITY
    : measuredMediaDurationMs / measuredIntervalMs;
  const throughputPassed = measuredIntervalMs === 0 ||
    measuredMediaDurationMs * 2 >= measuredIntervalMs * 3;
  const measuredOutputsPassed =
    frames.length >= MIN_READINESS_MEASURED_OUTPUTS;
  const failureReasons: ReadinessMetricFailureReason[] = [];
  if (!measuredOutputsPassed) failureReasons.push("measured-output-count");
  if (!throughputPassed) failureReasons.push("throughput");
  if (rollingMinimumLead < 0) failureReasons.push("upload-deadline");
  if (!ringPassed) failureReasons.push("ring-capacity");

  return Object.freeze({
    passed: failureReasons.length === 0,
    failureReasons: Object.freeze(failureReasons),
    frameRate,
    sampleCount: frames.length,
    measuredOutputsPassed,
    nominalFrameDurationMs,
    p99DecodeLatencyMs,
    p99UploadLatencyMs,
    decodeLeadFrames,
    uploadLeadFrames,
    recoveryLeadFrames,
    requiredRingCapacity,
    ringCapacity,
    ringPassed,
    measuredIntervalMs,
    measuredMediaDurationMs,
    throughputMultiple,
    throughputPassed,
    minimumUploadLeadMs: rollingMinimumLead,
    minimumUploadLeadFrames: rollingMinimumLead / nominalFrameDurationMs,
    frames: Object.freeze(frames)
  });
}

/** Standard nearest-rank percentile where `percentile` is in `(0, 1]`. */
export function nearestRankPercentile(
  values: readonly number[],
  percentile: number
): number {
  if (!Array.isArray(values) || values.length < 1) {
    throw new RangeError("nearest-rank percentile requires values");
  }
  if (!Number.isFinite(percentile) || percentile <= 0 || percentile > 1) {
    throw new RangeError("nearest-rank percentile must be in (0, 1]");
  }
  const sorted = values.map((value) => {
    validateFiniteNonNegative(value, "percentile value");
    return value;
  }).sort((left, right) => left - right);
  const rank = Math.ceil(percentile * sorted.length);
  return sorted[rank - 1]!;
}

/** Adds an exact rational presentation timestamp to a monotonic origin. */
export function idealReadinessDeadlineMs(
  originMs: number,
  presentationOrdinal: number | bigint,
  frameRate: Readonly<RationalFrameRate>
): number {
  validateFiniteNonNegative(originMs, "readiness deadline origin");
  const result = originMs +
    timestampForFrame(presentationOrdinal, frameRate) / 1_000;
  if (!Number.isFinite(result) || Math.abs(result) > Number.MAX_SAFE_INTEGER) {
    throw new RangeError("ideal readiness deadline exceeds safe range");
  }
  return result;
}

function copyMediaIdentity(
  media: Readonly<ReadinessMediaIdentity>
): Readonly<ReadinessMediaIdentity> {
  validateObject(media, "readiness media identity");
  validateBoundedId(media.path, "readiness media path");
  validateBoundedId(media.unit, "readiness media unit");
  validateNonNegativeSafeInteger(media.unitInstance, "unit instance");
  validateNonNegativeSafeInteger(media.localFrame, "local frame");
  return Object.freeze({
    path: media.path,
    unit: media.unit,
    unitInstance: media.unitInstance,
    localFrame: media.localFrame
  });
}

function validateBoundedId(value: string, label: string): void {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > MAX_MEDIA_ID_LENGTH
  ) {
    throw new RangeError(`${label} must be from 1 to 128 characters`);
  }
}

function validateOrdinal(value: number): void {
  validateNonNegativeSafeInteger(value, "output ordinal");
}

function validateNonNegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
}

function checkedIncrement(value: number, label: string): number {
  validateNonNegativeSafeInteger(value, label);
  const result = value + 1;
  if (!Number.isSafeInteger(result)) {
    throw new RangeError(`${label} exceeds safe-integer range`);
  }
  return result;
}

function validateFiniteNonNegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be finite and non-negative`);
  }
}

function validateFinitePositive(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${label} must be finite and positive`);
  }
}

function checkedFiniteProduct(
  left: number,
  right: number,
  label: string
): number {
  const result = left * right;
  if (!Number.isFinite(result) || result > Number.MAX_SAFE_INTEGER) {
    throw new RangeError(`${label} exceeds safe range`);
  }
  return result;
}

function ceilRatioWithFloatingTolerance(
  numerator: number,
  denominator: number
): number {
  const ratio = numerator / denominator;
  if (!Number.isFinite(ratio) || ratio < 0) {
    throw new RangeError("readiness lead ratio is invalid");
  }
  const nearest = Math.round(ratio);
  const tolerance = Number.EPSILON * Math.max(1, Math.abs(ratio)) * 8;
  const ceiled = Math.abs(ratio - nearest) <= tolerance
    ? nearest
    : Math.ceil(ratio);
  if (!Number.isSafeInteger(ceiled)) {
    throw new RangeError("readiness lead exceeds safe-integer range");
  }
  return ceiled;
}

function validateObject(value: unknown, label: string): void {
  if (value === null || typeof value !== "object") {
    throw new TypeError(`${label} must be an object`);
  }
}
