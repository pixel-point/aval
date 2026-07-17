import {
  Decoder,
  type DecoderLimits,
  type DecoderOutputExpectation,
  type DecodeRun,
  type DecodeSample
} from "./decoder.js";

const MAX_BYTES = Number.MAX_SAFE_INTEGER;

export type DecoderPoolLaneId = 0 | 1;

interface DecoderPoolLane {
  readonly id: DecoderPoolLaneId;
  readonly decoder: Decoder;
}

interface RunOwnership {
  readonly identity: DecoderPoolRunIdentity;
  readonly candidateEpoch: number | null;
}

export interface DecoderPoolRunIdentity {
  readonly logicalId: number;
  readonly lane: DecoderPoolLaneId;
}

export interface DecoderPoolSnapshot {
  readonly workerCount: number;
  readonly openFrames: number;
  readonly openFrameBytes: number;
}

/** Owns the two isolated serial decoders used for foreground/candidate playback. */
export class DecoderPool {
  readonly #lanes: readonly [DecoderPoolLane, DecoderPoolLane];
  readonly #ownership = new WeakMap<DecodeRun, RunOwnership>();
  readonly #decodedBytes: [number, number] = [0, 0];
  readonly #encodedBytes: [number, number] = [0, 0];
  readonly #maxDecodedBytes: number;
  readonly #onDecodedBytes: ((bytes: number) => void) | undefined;
  readonly #onEncodedBytes: ((bytes: number) => void) | undefined;
  #foreground: DecoderPoolLane;
  #candidate: DecoderPoolLane;
  #foregroundRun: DecodeRun | null = null;
  #candidateRun: DecodeRun | null = null;
  #sequence = 0;
  #candidateEpoch = 1;
  #disposed = false;

  public constructor(
    config: Readonly<VideoDecoderConfig>,
    expectation?: Readonly<DecoderOutputExpectation>,
    limits: Readonly<DecoderLimits> = {}
  ) {
    this.#maxDecodedBytes = limits.maxDecodedBytes ?? MAX_BYTES;
    if (!Number.isSafeInteger(this.#maxDecodedBytes) || this.#maxDecodedBytes < 1) {
      throw new RangeError("decoder byte ceiling is invalid");
    }
    if (limits.onDecodedBytes !== undefined && typeof limits.onDecodedBytes !== "function") {
      throw new TypeError("decoded byte observer is invalid");
    }
    if (limits.onEncodedBytes !== undefined && typeof limits.onEncodedBytes !== "function") {
      throw new TypeError("encoded byte observer is invalid");
    }
    this.#onDecodedBytes = limits.onDecodedBytes;
    this.#onEncodedBytes = limits.onEncodedBytes;

    let first: Decoder | undefined;
    try {
      first = this.#createDecoder(0, config, expectation, limits);
      const second = this.#createDecoder(1, config, expectation, limits);
      this.#lanes = Object.freeze([
        Object.freeze({ id: 0, decoder: first }),
        Object.freeze({ id: 1, decoder: second })
      ]);
    } catch (error) {
      first?.dispose();
      throw error;
    }
    this.#foreground = this.#lanes[0];
    this.#candidate = this.#lanes[1];
  }

  public async supported(): Promise<boolean> {
    const support = await Promise.all(this.#lanes.map((lane) => lane.decoder.supported()));
    return support.every(Boolean);
  }

  public createForegroundRun(samples: readonly Readonly<DecodeSample>[]): DecodeRun {
    this.#assertLive();
    if (
      (this.#foregroundRun !== null && !this.#foregroundRun.closed) ||
      !this.#foreground.decoder.available
    ) {
      throw new Error("decoder foreground lane already owns a run");
    }
    const run = this.#createRun(this.#foreground, samples, null);
    this.#foregroundRun = run;
    return run;
  }

  public createCandidateRun(samples: readonly Readonly<DecodeSample>[]): DecodeRun {
    this.#assertLive();
    if (
      (this.#candidateRun !== null && !this.#candidateRun.closed) ||
      !this.#candidate.decoder.available
    ) {
      throw new Error("decoder candidate lane already owns a run");
    }
    const run = this.#createRun(this.#candidate, samples, this.#candidateEpoch);
    this.#candidateRun = run;
    return run;
  }

  /** Makes the candidate's physical lane foreground without moving its run. */
  public promote(candidateRun: DecodeRun): void {
    this.#assertLive();
    const ownership = this.#ownership.get(candidateRun);
    if (
      ownership === undefined ||
      this.#candidateRun !== candidateRun ||
      ownership.identity.lane !== this.#candidate.id ||
      ownership.candidateEpoch !== this.#candidateEpoch ||
      candidateRun.closed
    ) {
      throw new Error("decoder run is not owned by the candidate lane");
    }
    if (this.#candidateEpoch === MAX_BYTES) {
      throw new RangeError("decoder candidate epoch is exhausted");
    }
    const previousForeground = this.#foregroundRun;
    [this.#foreground, this.#candidate] = [this.#candidate, this.#foreground];
    this.#foregroundRun = candidateRun;
    this.#candidateRun = previousForeground;
    this.#candidateEpoch += 1;
  }

  public identity(run: DecodeRun): DecoderPoolRunIdentity {
    const ownership = this.#ownership.get(run);
    if (ownership === undefined) throw new Error("decoder run is not owned by this pool");
    return ownership.identity;
  }

  public snapshot(): DecoderPoolSnapshot {
    const first = this.#lanes[0].decoder.snapshot();
    const second = this.#lanes[1].decoder.snapshot();
    return Object.freeze({
      workerCount: first.workerCount + second.workerCount,
      openFrames: first.openFrames + second.openFrames,
      openFrameBytes: first.openFrameBytes + second.openFrameBytes
    });
  }

  public get encodedBytes(): number {
    return checkedAggregate(this.#lanes[0].decoder.encodedBytes,
      this.#lanes[1].decoder.encodedBytes, "encoded");
  }

  public get candidateAvailable(): boolean {
    return !this.#disposed && (
      this.#candidateRun === null || this.#candidateRun.closed
    ) && this.#candidate.decoder.available;
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    let failure: unknown;
    for (const lane of this.#lanes) {
      try { lane.decoder.dispose(); }
      catch (error) { failure ??= error; }
    }
    if (failure !== undefined) throw failure;
  }

  #createDecoder(
    lane: DecoderPoolLaneId,
    config: Readonly<VideoDecoderConfig>,
    expectation: Readonly<DecoderOutputExpectation> | undefined,
    limits: Readonly<DecoderLimits>
  ): Decoder {
    return new Decoder(config, expectation, {
      ...limits,
      onDecodedBytes: (bytes) => this.#updateBytes(
        this.#decodedBytes,
        lane,
        bytes,
        "decoded",
        this.#maxDecodedBytes,
        this.#onDecodedBytes
      ),
      onEncodedBytes: (bytes) => this.#updateBytes(
        this.#encodedBytes,
        lane,
        bytes,
        "encoded",
        MAX_BYTES,
        this.#onEncodedBytes
      )
    });
  }

  #createRun(
    lane: DecoderPoolLane,
    samples: readonly Readonly<DecodeSample>[],
    candidateEpoch: number | null
  ): DecodeRun {
    if (this.#sequence === MAX_BYTES) {
      throw new RangeError("decoder logical run identity is exhausted");
    }
    const run = lane.decoder.createRun(samples);
    const identity = Object.freeze({
      logicalId: ++this.#sequence,
      lane: lane.id
    });
    this.#ownership.set(run, Object.freeze({ identity, candidateEpoch }));
    return run;
  }

  #updateBytes(
    values: [number, number],
    lane: DecoderPoolLaneId,
    bytes: number,
    kind: "decoded" | "encoded",
    maximum: number,
    observer: ((bytes: number) => void) | undefined
  ): void {
    const previous = values[lane];
    values[lane] = bytes;
    try {
      const aggregate = checkedAggregate(values[0], values[1], kind);
      if (aggregate > maximum) {
        throw byteCeilingError(kind);
      }
      observer?.(aggregate);
    } catch (error) {
      // Decoder rolls back failed claims, but releases remain committed.
      if (bytes > previous) values[lane] = previous;
      throw error;
    }
  }

  #assertLive(): void {
    if (this.#disposed) {
      throw new DOMException("AVAL decoder pool operation was aborted", "AbortError");
    }
  }
}

function checkedAggregate(
  first: number,
  second: number,
  kind: "decoded" | "encoded"
): number {
  if (second > MAX_BYTES - first) {
    throw byteCeilingError(kind);
  }
  return first + second;
}

function byteCeilingError(kind: "decoded" | "encoded"): RangeError {
  return new RangeError(kind === "decoded"
    ? "AVAL decoded surfaces exceed their byte ceiling"
    : "decoder encoded copies exceed their byte ceiling");
}
