import {
  timestampForFrame,
  validateFrameRate,
  type RationalFrameRate
} from "./rational-time.js";

const MAX_UNIT_ID_LENGTH = 128;

/** Immutable clock/occurrence fields before record type and bytes are attached. */
export interface DecodeSampleMetadata {
  readonly generation: number;
  readonly ordinal: number;
  readonly unitId: string;
  readonly unitInstance: number;
  readonly unitFrame: number;
  readonly unitFrameCount: number;
  readonly timestamp: number;
  readonly duration: number;
}

export interface DecodeUnitOccurrence {
  readonly unitId: string;
  readonly unitFrameCount: number;
}

export interface DecodeTimelineFrameRequest {
  readonly unitId: string;
  readonly unitFrame: number;
  readonly unitFrameCount: number;
}

export interface DecodeTimelineBatchPlan {
  readonly generation: number;
  readonly samples: readonly Readonly<DecodeSampleMetadata>[];
  commit(): readonly Readonly<DecodeSampleMetadata>[];
}

export interface DecodeTimelineSnapshot {
  readonly frameRate: Readonly<RationalFrameRate>;
  readonly activeGeneration: number | null;
  readonly nextOrdinal: number;
  readonly nextUnitInstance: number;
}

/**
 * Owns the decoder session's global clock and generation-local unit identity.
 * It neither owns bytes nor submits work.
 */
export class DecodeTimeline {
  readonly #frameRate: Readonly<RationalFrameRate>;
  #activeGeneration: number | null = null;
  #nextOrdinal = 0;
  #nextUnitInstance = 0;
  #activeOccurrence: {
    readonly unitId: string;
    readonly unitFrameCount: number;
    readonly unitInstance: number;
    readonly nextUnitFrame: number;
  } | null = null;
  #revision = 0;

  public constructor(frameRate: RationalFrameRate) {
    validateFrameRate(frameRate);
    this.#frameRate = Object.freeze({
      numerator: frameRate.numerator,
      denominator: frameRate.denominator
    });
  }

  /** Activates the next positive generation without resetting decode time. */
  public activateNextGeneration(): number {
    if (this.#activeGeneration === Number.MAX_SAFE_INTEGER) {
      throw new RangeError("decode generation exceeds the safe-integer range");
    }

    const generation = (this.#activeGeneration ?? 0) + 1;
    this.#activeGeneration = generation;
    this.#nextUnitInstance = 0;
    this.#activeOccurrence = null;
    this.#revision += 1;
    return generation;
  }

  /**
   * Atomically assigns one complete independently-decodable occurrence.
   * Failure leaves every timeline counter unchanged.
   */
  public allocateUnitOccurrence(
    unitId: string,
    unitFrameCount: number
  ): readonly DecodeSampleMetadata[] {
    return this.allocateUnitOccurrences([{ unitId, unitFrameCount }]);
  }

  /** Assigns one or more complete occurrences in one atomic timeline step. */
  public allocateUnitOccurrences(
    occurrences: readonly DecodeUnitOccurrence[]
  ): readonly DecodeSampleMetadata[] {
    if (this.#activeGeneration === null) {
      throw new RangeError(
        "decode timeline requires an active generation before an occurrence"
      );
    }
    if (occurrences.length < 1) {
      throw new RangeError("decode timeline requires at least one occurrence");
    }

    const frames: DecodeTimelineFrameRequest[] = [];
    for (const occurrence of occurrences) {
      validateUnitId(occurrence.unitId);
      validatePositiveSafeInteger(
        occurrence.unitFrameCount,
        "unit frame count"
      );
      for (
        let unitFrame = 0;
        unitFrame < occurrence.unitFrameCount;
        unitFrame += 1
      ) {
        frames.push({
          unitId: occurrence.unitId,
          unitFrame,
          unitFrameCount: occurrence.unitFrameCount
        });
      }
    }

    return this.planSampleBatch(frames).commit();
  }

  /**
   * Builds immutable metadata without mutating counters. The returned commit
   * is atomic and rejects if another operation changed the timeline first.
   */
  public planSampleBatch(
    frames: readonly DecodeTimelineFrameRequest[]
  ): Readonly<DecodeTimelineBatchPlan> {
    const generation = this.#activeGeneration;
    if (generation === null) {
      throw new RangeError(
        "decode timeline requires an active generation before an occurrence"
      );
    }
    if (frames.length < 1) {
      throw new RangeError("decode timeline batch must contain a frame");
    }
    const finalOrdinal = BigInt(this.#nextOrdinal) + BigInt(frames.length) - 1n;
    if (finalOrdinal >= BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new RangeError("decode ordinal leaves no safe successor");
    }

    const revision = this.#revision;
    let nextUnitInstance = this.#nextUnitInstance;
    let activeOccurrence = this.#activeOccurrence === null
      ? null
      : { ...this.#activeOccurrence };
    let ordinal = this.#nextOrdinal;
    let timestamp = timestampForFrame(ordinal, this.#frameRate);
    const samples: DecodeSampleMetadata[] = [];

    for (const frame of frames) {
      validateFrameRequest(frame);
      let unitInstance: number;
      if (activeOccurrence === null) {
        if (frame.unitFrame !== 0) {
          throw new RangeError(
            "every decode unit occurrence must begin at frame zero"
          );
        }
        if (nextUnitInstance >= Number.MAX_SAFE_INTEGER) {
          throw new RangeError("unit instance leaves no safe successor");
        }
        unitInstance = nextUnitInstance;
        nextUnitInstance += 1;
        activeOccurrence = frame.unitFrameCount === 1
          ? null
          : {
              unitId: frame.unitId,
              unitFrameCount: frame.unitFrameCount,
              unitInstance,
              nextUnitFrame: 1
            };
      } else {
        if (
          frame.unitId !== activeOccurrence.unitId ||
          frame.unitFrameCount !== activeOccurrence.unitFrameCount ||
          frame.unitFrame !== activeOccurrence.nextUnitFrame
        ) {
          throw new RangeError(
            "decode unit occurrence frames must remain complete and contiguous"
          );
        }
        unitInstance = activeOccurrence.unitInstance;
        const nextUnitFrame = frame.unitFrame + 1;
        activeOccurrence = nextUnitFrame === frame.unitFrameCount
          ? null
          : { ...activeOccurrence, nextUnitFrame };
      }

      const nextTimestamp = timestampForFrame(
        BigInt(ordinal) + 1n,
        this.#frameRate
      );
      const duration = nextTimestamp - timestamp;
      if (
        !Number.isSafeInteger(duration) ||
        duration <= 0 ||
        timestamp > Number.MAX_SAFE_INTEGER - duration
      ) {
        throw new RangeError(
          "decode timestamp duration must be positive and remain in the safe-integer range"
        );
      }
      samples.push(Object.freeze({
        generation,
        ordinal,
        unitId: frame.unitId,
        unitInstance,
        unitFrame: frame.unitFrame,
        unitFrameCount: frame.unitFrameCount,
        timestamp,
        duration
      }));
      ordinal += 1;
      timestamp = nextTimestamp;
    }

    const immutableSamples = Object.freeze(samples);
    let committed = false;
    return Object.freeze({
      generation,
      samples: immutableSamples,
      commit: (): readonly Readonly<DecodeSampleMetadata>[] => {
        if (committed) {
          throw new RangeError("decode timeline batch was already committed");
        }
        if (
          this.#revision !== revision ||
          this.#activeGeneration !== generation
        ) {
          throw new RangeError("decode timeline batch plan became stale");
        }
        this.#nextOrdinal = ordinal;
        this.#nextUnitInstance = nextUnitInstance;
        this.#activeOccurrence = activeOccurrence;
        this.#revision += 1;
        committed = true;
        return immutableSamples;
      }
    });
  }

  public snapshot(): Readonly<DecodeTimelineSnapshot> {
    return Object.freeze({
      frameRate: this.#frameRate,
      activeGeneration: this.#activeGeneration,
      nextOrdinal: this.#nextOrdinal,
      nextUnitInstance: this.#nextUnitInstance
    });
  }
}

function validateUnitId(unitId: string): void {
  if (
    typeof unitId !== "string" ||
    unitId.length < 1 ||
    unitId.length > MAX_UNIT_ID_LENGTH
  ) {
    throw new RangeError(
      `unit ID length must be between 1 and ${String(MAX_UNIT_ID_LENGTH)}`
    );
  }
}

function validateFrameRequest(frame: DecodeTimelineFrameRequest): void {
  validateUnitId(frame.unitId);
  validatePositiveSafeInteger(frame.unitFrameCount, "unit frame count");
  if (
    !Number.isSafeInteger(frame.unitFrame) ||
    frame.unitFrame < 0 ||
    frame.unitFrame >= frame.unitFrameCount
  ) {
    throw new RangeError("unit frame must be within the unit frame count");
  }
}

function validatePositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
}
