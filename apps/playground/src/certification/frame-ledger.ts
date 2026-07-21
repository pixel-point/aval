export interface BrowserFrameLedgerEntry {
  readonly deadlineOrdinal: number;
  readonly expectedContentOrdinal: number;
  readonly submittedContentOrdinal: number | null;
  readonly boundary: boolean;
  readonly eventAvailableBeforeCutoff: boolean;
  readonly framePreparedBeforeCutoff: boolean;
  readonly eligibleAnimationFrameOrdinal: number;
  readonly callbackStartMicroseconds: number;
  readonly canvasSubmissionCompleteMicroseconds: number;
  readonly gpuFence: "not-supported" | "not-used" | "completed" | "failed";
  readonly state: string | null;
  readonly route: string | null;
  readonly port: string | null;
  readonly unit: string | null;
  readonly localFrame: number | null;
  readonly identitySource: "public-runtime-trace" | "functional-readback" | "unavailable";
}

export class BrowserFrameLedger {
  readonly #limit: number;
  readonly #entries: BrowserFrameLedgerEntry[] = [];

  public constructor(limit = 100_000) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 2_000_000) {
      throw new RangeError("frame ledger limit must be in 1..2000000");
    }
    this.#limit = limit;
  }

  public append(input: BrowserFrameLedgerEntry): void {
    if (this.#entries.length >= this.#limit) throw new RangeError("frame ledger limit exceeded");
    for (const field of [
      "deadlineOrdinal", "expectedContentOrdinal", "eligibleAnimationFrameOrdinal",
      "callbackStartMicroseconds", "canvasSubmissionCompleteMicroseconds"
    ] as const) nonnegativeInteger(input[field], field);
    if (input.submittedContentOrdinal !== null) nonnegativeInteger(input.submittedContentOrdinal, "submittedContentOrdinal");
    if (input.localFrame !== null) nonnegativeInteger(input.localFrame, "localFrame");
    if (input.canvasSubmissionCompleteMicroseconds < input.callbackStartMicroseconds) {
      throw new RangeError("canvas submission precedes callback start");
    }
    const previous = this.#entries.at(-1);
    if (previous !== undefined) {
      if (input.deadlineOrdinal <= previous.deadlineOrdinal) throw new RangeError("deadline ordinals must increase strictly");
      if (input.callbackStartMicroseconds < previous.callbackStartMicroseconds) throw new RangeError("callback clock moved backward");
    }
    for (const [name, value] of [["state", input.state], ["route", input.route], ["port", input.port], ["unit", input.unit]] as const) {
      if (value !== null && (value.length < 1 || value.length > 128)) throw new RangeError(`${name} is invalid`);
    }
    this.#entries.push(Object.freeze({ ...input }));
  }

  public snapshot(): readonly Readonly<BrowserFrameLedgerEntry>[] {
    return Object.freeze(this.#entries.map((entry) => Object.freeze({ ...entry })));
  }

}

function nonnegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a nonnegative safe integer`);
}
