import {
  Decoder,
  type DecoderLimits,
  type DecoderOutputExpectation,
  type DecodeRun,
  type DecodeSample
} from "./decoder.js";
import { ELEMENT_DECODER_LANE_IDS } from "./decoder-capacity.js";
import type { DecoderFailureDiagnostic } from "./decoder-diagnostics.js";

const MAX_BYTES = Number.MAX_SAFE_INTEGER;

export type DecoderPoolLaneId = (typeof ELEMENT_DECODER_LANE_IDS)[number];

interface DecoderPoolLane {
  readonly id: DecoderPoolLaneId;
  readonly decoder: Decoder;
}

interface RunOwnership {
  readonly identity: DecoderPoolRunIdentity;
}

export interface DecoderPoolRunIdentity {
  readonly logicalId: number;
  readonly lane: DecoderPoolLaneId;
}

export interface DecoderPoolDiagnostic extends DecoderFailureDiagnostic {
  readonly lane: DecoderPoolLaneId;
}

export interface DecoderPoolSnapshot {
  readonly workerCount: number;
  readonly openFrames: number;
  readonly openFrameBytes: number;
  readonly decoderDiagnostics: readonly Readonly<DecoderPoolDiagnostic>[];
}

/**
 * Owns one discardable run until it is either installed as foreground or
 * retired. Both terminal operations are idempotent.
 */
export interface DecoderPoolCandidate {
  readonly unitId: string;
  readonly run: DecodeRun;
  ready(): Promise<void>;
  commit(): void;
  cancel(): void;
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
  readonly #failure: Promise<never>;
  readonly #diagnosticByLane: [
    Readonly<DecoderPoolDiagnostic> | null,
    Readonly<DecoderPoolDiagnostic> | null
  ] = [null, null];
  #foreground: DecoderPoolLane;
  #candidate: DecoderPoolLane;
  #foregroundRun: DecodeRun | null = null;
  #candidateRun: DecodeRun | null = null;
  #sequence = 0;
  #disposed = false;
  #decoderDiagnostics: readonly Readonly<DecoderPoolDiagnostic>[] =
    Object.freeze([]);

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

    const lanes: DecoderPoolLane[] = [];
    try {
      for (const id of ELEMENT_DECODER_LANE_IDS) {
        lanes.push(Object.freeze({
          id,
          decoder: this.#createDecoder(id, config, expectation, limits)
        }));
      }
    } catch (error) {
      for (const lane of lanes) lane.decoder.dispose();
      throw error;
    }
    const [foreground, candidate] = lanes;
    if (
      lanes.length !== 2 || foreground === undefined || candidate === undefined
    ) {
      for (const lane of lanes) lane.decoder.dispose();
      throw new Error("decoder capacity does not define two lanes");
    }
    this.#lanes = Object.freeze([foreground, candidate]);
    this.#foreground = foreground;
    this.#candidate = candidate;
    this.#failure = Promise.race(
      this.#lanes.map(({ decoder }) => decoder.failure())
    );
    void this.#failure.catch(() => undefined);
  }

  public async supported(): Promise<boolean> {
    const support = await Promise.all(this.#lanes.map((lane) => lane.decoder.supported()));
    return support.every(Boolean);
  }

  /** Rejects when either required physical decoder lane becomes unusable. */
  public failure(): Promise<never> {
    return this.#failure;
  }

  public createForegroundRun(samples: readonly Readonly<DecodeSample>[]): DecodeRun {
    this.#assertLive();
    if (
      (this.#foregroundRun !== null && !this.#foregroundRun.closed) ||
      !this.#foreground.decoder.available
    ) {
      throw new Error("decoder foreground lane already owns a run");
    }
    const run = this.#createRun(this.#foreground, samples);
    this.#foregroundRun = run;
    return run;
  }

  public createCandidate(
    unitId: string,
    samples: readonly Readonly<DecodeSample>[]
  ): DecoderPoolCandidate {
    this.#assertLive();
    if (typeof unitId !== "string" || unitId.length === 0) {
      throw new TypeError("decoder candidate unit is invalid");
    }
    if (
      (this.#candidateRun !== null && !this.#candidateRun.closed) ||
      !this.#candidate.decoder.available
    ) {
      throw new Error("decoder candidate lane already owns a run");
    }
    const run = this.#createRun(this.#candidate, samples);
    this.#candidateRun = run;
    let state: "preparing" | "ready" | "committed" | "canceled" =
      "preparing";
    let readiness: Promise<void> | null = null;
    return Object.freeze({
      unitId,
      run,
      ready: () => {
        if (state === "ready" || state === "committed") {
          return Promise.resolve();
        }
        if (state === "canceled") return Promise.reject(abortError());
        readiness ??= run.ready().then(() => {
          if (state === "preparing") state = "ready";
        });
        return readiness;
      },
      commit: () => {
        if (state === "committed" || state === "canceled") return;
        this.#assertLive();
        if (state !== "ready") {
          throw new Error("decoder candidate is not ready");
        }
        const ownership = this.#ownership.get(run);
        if (
          ownership === undefined ||
          this.#candidateRun !== run ||
          ownership.identity.lane !== this.#candidate.id ||
          run.closed
        ) {
          throw new Error("decoder candidate is no longer current");
        }
        const previousForeground = this.#foregroundRun;
        [this.#foreground, this.#candidate] = [this.#candidate, this.#foreground];
        this.#foregroundRun = run;
        this.#candidateRun = previousForeground;
        state = "committed";
        previousForeground?.close();
      },
      cancel: () => {
        if (state === "committed" || state === "canceled") return;
        state = "canceled";
        run.close();
      }
    });
  }

  public identity(run: DecodeRun): DecoderPoolRunIdentity {
    const ownership = this.#ownership.get(run);
    if (ownership === undefined) throw new Error("decoder run is not owned by this pool");
    return ownership.identity;
  }

  public snapshot(): DecoderPoolSnapshot {
    const first = this.#lanes[0].decoder.snapshot();
    const second = this.#lanes[1].decoder.snapshot();
    this.#captureDecoderDiagnostics(first.diagnostic, second.diagnostic);
    return Object.freeze({
      workerCount: first.workerCount + second.workerCount,
      openFrames: first.openFrames + second.openFrames,
      openFrameBytes: first.openFrameBytes + second.openFrameBytes,
      decoderDiagnostics: this.#decoderDiagnostics
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
    const first = this.#lanes[0].decoder.snapshot().diagnostic;
    const second = this.#lanes[1].decoder.snapshot().diagnostic;
    this.#captureDecoderDiagnostics(first, second);
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

  #captureDecoderDiagnostics(
    first: Readonly<DecoderFailureDiagnostic> | null,
    second: Readonly<DecoderFailureDiagnostic> | null
  ): void {
    let changed = false;
    for (const [lane, diagnostic] of [first, second].entries()) {
      if (diagnostic === null || this.#diagnosticByLane[lane] !== null) continue;
      const id = ELEMENT_DECODER_LANE_IDS[lane];
      if (id === undefined) continue;
      this.#diagnosticByLane[id] = Object.freeze({
        lane: id,
        ...diagnostic
      });
      changed = true;
    }
    if (!changed) return;
    this.#decoderDiagnostics = Object.freeze(
      this.#diagnosticByLane.filter(
        (diagnostic): diagnostic is Readonly<DecoderPoolDiagnostic> =>
          diagnostic !== null
      )
    );
  }

  #createRun(
    lane: DecoderPoolLane,
    samples: readonly Readonly<DecodeSample>[]
  ): DecodeRun {
    if (this.#sequence === MAX_BYTES) {
      throw new RangeError("decoder logical run identity is exhausted");
    }
    const run = lane.decoder.createRun(samples);
    const identity = Object.freeze({
      logicalId: ++this.#sequence,
      lane: lane.id
    });
    this.#ownership.set(run, Object.freeze({ identity }));
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

function abortError(): DOMException {
  return new DOMException("AVAL decoder candidate was aborted", "AbortError");
}
