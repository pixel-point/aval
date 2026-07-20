export interface RouteLedgerEntry {
  readonly ordinal: number;
  readonly event: "requestedstatechange" | "transitionstart" | "visualstatechange" | "transitionend" | "error" | "underflow";
  readonly timestampMicroseconds: number;
  readonly generation: number;
  readonly from: string | null;
  readonly to: string | null;
  readonly edge: string | null;
  readonly requestedState: string | null;
  readonly visualState: string | null;
  readonly transitioning: boolean;
}

export class RouteLedger {
  readonly #limit: number;
  readonly #entries: RouteLedgerEntry[] = [];

  public constructor(limit = 100_000) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000_000) throw new RangeError("route ledger limit is invalid");
    this.#limit = limit;
  }

  public append(input: Omit<RouteLedgerEntry, "ordinal">): void {
    if (this.#entries.length >= this.#limit) throw new RangeError("route ledger limit exceeded");
    if (!Number.isSafeInteger(input.timestampMicroseconds) || input.timestampMicroseconds < 0) throw new RangeError("route timestamp is invalid");
    if (!Number.isSafeInteger(input.generation) || input.generation < 0) throw new RangeError("route generation is invalid");
    const previous = this.#entries.at(-1);
    if (previous !== undefined && input.timestampMicroseconds < previous.timestampMicroseconds) throw new RangeError("route clock moved backward");
    this.#entries.push(Object.freeze({ ordinal: this.#entries.length, ...input }));
  }

  public snapshot(): readonly Readonly<RouteLedgerEntry>[] {
    return Object.freeze(this.#entries.map((entry) => Object.freeze({ ...entry })));
  }
}
