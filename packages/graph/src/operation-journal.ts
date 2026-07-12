import { MotionGraphError } from "./errors.js";
import { GRAPH_LIMITS } from "./limits.js";
import type {
  GraphPresentation,
  MotionGraphEffect,
  MotionGraphOperation,
  MotionGraphResult,
  MotionGraphSnapshot,
  MotionGraphTraceRecord
} from "./model.js";

export interface InputAdmission {
  readonly sequence: number;
  readonly withinLimit: boolean;
}

export interface OperationResultMetadata {
  readonly accepted?: boolean;
  readonly joined?: boolean;
  readonly sequence?: number;
  readonly requestId?: number;
}

export interface CompletedOperation {
  readonly operation: MotionGraphOperation;
  readonly effects: readonly MotionGraphEffect[];
  readonly presentation: Readonly<GraphPresentation> | null;
  readonly snapshot: Readonly<MotionGraphSnapshot>;
  readonly metadata?: Readonly<OperationResultMetadata>;
}

export interface OperationJournalCheckpoint {
  readonly contentOrdinal: bigint | null;
  readonly inputSequence: number;
  readonly inputsSinceTick: number;
  readonly routeOperationsLastTick: number;
  readonly traceIndex: number;
  readonly trace: readonly Readonly<MotionGraphTraceRecord>[];
}

/**
 * Owns the monotonically increasing operation counters and immutable result
 * trace for a graph engine. Tick work remains external: callers admit a tick,
 * perform it, and complete it only after that work succeeds.
 */
export class OperationJournal {
  #contentOrdinal: bigint | null = null;
  #inputSequence = 0;
  #inputsSinceTick = 0;
  #routeOperationsLastTick = 0;
  #traceIndex = 0;
  readonly #trace: MotionGraphTraceRecord[] = [];

  public get contentOrdinal(): bigint | null {
    return this.#contentOrdinal;
  }

  public get inputSequence(): number {
    return this.#inputSequence;
  }

  public get inputsSinceTick(): number {
    return this.#inputsSinceTick;
  }

  public get routeOperationsLastTick(): number {
    return this.#routeOperationsLastTick;
  }

  public beginInput(): Readonly<InputAdmission> {
    const sequence = this.#nextSequence();
    if (this.#inputsSinceTick >= GRAPH_LIMITS.maxInputsPerTick) {
      return Object.freeze({ sequence, withinLimit: false });
    }
    this.#inputsSinceTick += 1;
    return Object.freeze({ sequence, withinLimit: true });
  }

  public allocateInternalSequence(): number {
    return this.#nextSequence();
  }

  public beginTick(contentOrdinal: bigint): void {
    const expected = this.#contentOrdinal === null
      ? 0n
      : this.#contentOrdinal + 1n;
    if (contentOrdinal !== expected) {
      throw new MotionGraphError(
        "NON_CONSECUTIVE_TICK",
        `content ordinal must be ${String(expected)}`
      );
    }
    this.#contentOrdinal = contentOrdinal;
    this.#routeOperationsLastTick = 0;
  }

  /** Reset the input admission window only after the caller's tick succeeds. */
  public completeTick(): void {
    this.#inputsSinceTick = 0;
  }

  public incrementRouteOperations(): void {
    this.#routeOperationsLastTick += 1;
    if (
      this.#routeOperationsLastTick > GRAPH_LIMITS.maxRoutingOperationsPerTick
    ) {
      throw new MotionGraphError(
        "GRAPH_VALIDATION",
        "graph exceeded the per-tick routing-operation bound"
      );
    }
  }

  public record(completed: Readonly<CompletedOperation>): Readonly<MotionGraphResult> {
    const metadata = completed.metadata ?? {};
    const frozenEffects = Object.freeze([...completed.effects]);
    const result = Object.freeze({
      operation: completed.operation,
      ...(metadata.accepted === undefined
        ? {}
        : { accepted: metadata.accepted }),
      ...(metadata.joined === undefined ? {} : { joined: metadata.joined }),
      ...(metadata.sequence === undefined
        ? {}
        : { sequence: metadata.sequence }),
      ...(metadata.requestId === undefined
        ? {}
        : { requestId: metadata.requestId }),
      presentation: completed.presentation,
      effects: frozenEffects,
      snapshot: completed.snapshot
    });
    const record = Object.freeze({ index: ++this.#traceIndex, result });
    this.#trace.push(record);
    if (this.#trace.length > GRAPH_LIMITS.maxTraceRecords) {
      this.#trace.splice(0, this.#trace.length - GRAPH_LIMITS.maxTraceRecords);
    }
    return result;
  }

  public getTrace(): readonly Readonly<MotionGraphTraceRecord>[] {
    return Object.freeze([...this.#trace]);
  }

  public checkpoint(): Readonly<OperationJournalCheckpoint> {
    return Object.freeze({
      contentOrdinal: this.#contentOrdinal,
      inputSequence: this.#inputSequence,
      inputsSinceTick: this.#inputsSinceTick,
      routeOperationsLastTick: this.#routeOperationsLastTick,
      traceIndex: this.#traceIndex,
      trace: Object.freeze([...this.#trace])
    });
  }

  public restore(checkpoint: Readonly<OperationJournalCheckpoint>): void {
    this.#contentOrdinal = checkpoint.contentOrdinal;
    this.#inputSequence = checkpoint.inputSequence;
    this.#inputsSinceTick = checkpoint.inputsSinceTick;
    this.#routeOperationsLastTick = checkpoint.routeOperationsLastTick;
    this.#traceIndex = checkpoint.traceIndex;
    this.#trace.splice(0, this.#trace.length, ...checkpoint.trace);
  }

  #nextSequence(): number {
    this.#inputSequence += 1;
    if (!Number.isSafeInteger(this.#inputSequence)) {
      throw new RangeError("graph input sequence exceeds the safe-integer range");
    }
    return this.#inputSequence;
  }
}
