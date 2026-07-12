import { RUNTIME_TRACE_CAPACITY } from "./model.js";
import type { PathSchedulerTraceRecord } from "./path-scheduler-model.js";

export type PathSchedulerTraceInput = Omit<PathSchedulerTraceRecord, "index">;

/** Bounded, immutable scheduler diagnostics with one monotonic record index. */
export class PathSchedulerTraceLog {
  readonly #records: Readonly<PathSchedulerTraceRecord>[] = [];
  #nextIndex = 0;

  public append(input: PathSchedulerTraceInput): void {
    if (this.#nextIndex >= Number.MAX_SAFE_INTEGER) {
      throw new RangeError("path scheduler trace index leaves no safe successor");
    }
    this.#records.push(Object.freeze({ index: this.#nextIndex, ...input }));
    this.#nextIndex += 1;
    if (this.#records.length > RUNTIME_TRACE_CAPACITY) {
      this.#records.shift();
    }
  }

  public snapshot(): readonly Readonly<PathSchedulerTraceRecord>[] {
    return Object.freeze([...this.#records]);
  }
}
