import { DecoderWorkerCoreError, validateSample } from "./core-validation.js";
import { type DecoderWorkerSample } from "./protocol.js";

/** Owns global ordinal/timestamp continuity; AVC owns unit semantics. */
export class DecoderSampleSequence {
  #activeGeneration: number | null = null;
  #nextOrdinal = 0;
  #lastTimestamp: number | null = null;

  public get nextOrdinal(): number {
    return this.#nextOrdinal;
  }

  public activate(generation: number): void {
    this.#activeGeneration = generation;
  }

  public abort(generation: number): void {
    if (this.#activeGeneration === generation) {
      this.#activeGeneration = null;
    }
  }

  public clearActive(): void {
    this.#activeGeneration = null;
  }

  /** Validates the entire batch atomically before advancing the sequence. */
  public accept(
    generation: number,
    samples: readonly DecoderWorkerSample[]
  ): void {
    if (generation !== this.#activeGeneration) {
      throw new DecoderWorkerCoreError(
        "GENERATION_MISMATCH",
        "decode submission does not target the active generation"
      );
    }

    let ordinal = this.#nextOrdinal;
    let timestamp = this.#lastTimestamp;
    for (const sample of samples) {
      validateSample(sample, ordinal, timestamp);
      ordinal += 1;
      timestamp = sample.timestamp;
    }
    this.#nextOrdinal = ordinal;
    this.#lastTimestamp = timestamp;
  }
}
