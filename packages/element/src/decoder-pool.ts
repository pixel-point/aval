import {
  Decoder,
  DecoderLocalFailureError,
  type DecoderLimits,
  type DecoderOutputExpectation,
  type DecodeRun,
  type DecodeSample
} from "./decoder.js";
import { ELEMENT_DECODER_LANE_IDS } from "./decoder-capacity.js";
import type { DecoderFailureDiagnostic } from "./decoder-diagnostics.js";
import {
  freezePlaybackLifecycleCounters,
  saturatingIncrement
} from "./playback-lifecycle.js";
import type { AvalPlaybackLifecycleCounters } from "./public-types.js";

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
  readonly logicalRunId: number | null;
  readonly role: "foreground" | "candidate" | null;
}

export interface DecoderPoolSnapshot {
  readonly workerCount: number;
  readonly openFrames: number;
  readonly openFrameBytes: number;
  readonly playbackLifecycle: Readonly<AvalPlaybackLifecycleCounters>;
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
  #logicalRunsCreated = 0;
  #candidateCommits = 0;
  #disposed = false;
  #decoderDiagnostics: readonly Readonly<DecoderPoolDiagnostic>[] =
    Object.freeze([]);

  public constructor(
    config: Readonly<VideoDecoderConfig>,
    expectation: Readonly<DecoderOutputExpectation>,
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
    const support = await Promise.allSettled(
      this.#lanes.map((lane) => lane.decoder.supported())
    );
    const failures = [
      ...support.flatMap((result) => result.status === "rejected"
        ? [result.reason]
        : []),
      ...this.#lanes.flatMap(({ decoder }) => {
        const error = decoder.terminalError();
        return error === null ? [] : [error];
      })
    ];
    const terminal = failures.find((error) =>
      !(error instanceof DecoderLocalFailureError &&
        error.failure.kind === "unsupported-config")
    );
    if (terminal !== undefined) throw terminal;
    return support.every((result) =>
      result.status === "fulfilled" && result.value
    );
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
        this.#candidateCommits = saturatingIncrement(this.#candidateCommits);
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
    const firstLifecycle = first.lifecycle ?? EMPTY_DECODER_LIFECYCLE;
    const secondLifecycle = second.lifecycle ?? EMPTY_DECODER_LIFECYCLE;
    this.#captureDecoderDiagnostics(first.diagnostic, second.diagnostic);
    return Object.freeze({
      workerCount: first.workerCount + second.workerCount,
      openFrames: first.openFrames + second.openFrames,
      openFrameBytes: first.openFrameBytes + second.openFrameBytes,
      playbackLifecycle: freezePlaybackLifecycleCounters({
        outputsAccepted: checkedCounterAggregate(
          firstLifecycle.outputsAccepted,
          secondLifecycle.outputsAccepted
        ),
        drawsCompleted: 0,
        logicalRunsCreated: this.#logicalRunsCreated,
        candidateCommits: this.#candidateCommits,
        runsClosed: checkedCounterAggregate(
          firstLifecycle.runsClosed,
          secondLifecycle.runsClosed
        ),
        transitionStarts: 0,
        transitionEnds: 0,
        loopCrossings: 0,
        nativeDecoderCreatesByLane: [
          firstLifecycle.nativeDecoderCreates,
          secondLifecycle.nativeDecoderCreates
        ],
        nativeDecoderClosesByLane: [
          firstLifecycle.nativeDecoderCloses,
          secondLifecycle.nativeDecoderCloses
        ]
      }),
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
    expectation: Readonly<DecoderOutputExpectation>,
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
      const context = this.#diagnosticContext(id, diagnostic.run);
      this.#diagnosticByLane[id] = Object.freeze({
        lane: id,
        logicalRunId: context?.logicalRunId ?? null,
        role: context?.role ?? null,
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

  #diagnosticContext(
    lane: DecoderPoolLaneId,
    physicalRun: number | null
  ): Readonly<{
    logicalRunId: number;
    role: "foreground" | "candidate";
  }> | null {
    if (physicalRun === null) return null;
    for (const [role, run] of [
      ["foreground", this.#foregroundRun],
      ["candidate", this.#candidateRun]
    ] as const) {
      if (run === null || run.generation !== physicalRun) continue;
      const ownership = this.#ownership.get(run);
      if (ownership?.identity.lane !== lane) continue;
      return Object.freeze({
        logicalRunId: ownership.identity.logicalId,
        role
      });
    }
    return null;
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
    this.#logicalRunsCreated = saturatingIncrement(this.#logicalRunsCreated);
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

const EMPTY_DECODER_LIFECYCLE = Object.freeze({
  outputsAccepted: 0,
  runsClosed: 0,
  nativeDecoderCreates: 0,
  nativeDecoderCloses: 0
});

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

function checkedCounterAggregate(first: number, second: number): number {
  return second > MAX_BYTES - first ? MAX_BYTES : first + second;
}

function byteCeilingError(kind: "decoded" | "encoded"): RangeError {
  return new RangeError(kind === "decoded"
    ? "AVAL decoded surfaces exceed their byte ceiling"
    : "decoder encoded copies exceed their byte ceiling");
}

function abortError(): DOMException {
  return new DOMException("AVAL decoder candidate was aborted", "AbortError");
}
