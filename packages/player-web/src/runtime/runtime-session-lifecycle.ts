import {
  RuntimePlaybackError,
  normalizeRuntimeFailure
} from "./errors.js";

export const RUNTIME_SESSION_CLEANUP_PHASES = Object.freeze([
  "network-digest",
  "readers-timers",
  "realtime",
  "candidate-gl",
  "statics",
  "leases",
  "listeners",
  "participant",
  "queues"
] as const);

export type RuntimeSessionCleanupPhase =
  (typeof RUNTIME_SESSION_CLEANUP_PHASES)[number];

export type RuntimeSessionCleanup = () => void | PromiseLike<void>;

export interface RuntimeSessionPendingWait<Value> {
  readonly promise: Promise<Value>;
  resolve(value: Value): void;
  reject(error: unknown): void;
}

export interface RuntimeSessionGenerationContext {
  readonly generation: number;
  readonly signal: AbortSignal;
  isCurrent(): boolean;
  registerCleanup(
    phase: RuntimeSessionCleanupPhase,
    cleanup: RuntimeSessionCleanup
  ): () => void;
  track<Value>(work: PromiseLike<Value>): Promise<Value>;
  publish<Value, Result>(
    work: PromiseLike<Value>,
    publish: (value: Value) => Result
  ): Promise<Result>;
  createPendingWait<Value>(): RuntimeSessionPendingWait<Value>;
}

export type RuntimeSessionLifecycleState =
  | "active"
  | "replacing"
  | "disposing"
  | "disposed";

export interface RuntimeSessionLifecycleSnapshot {
  readonly currentGeneration: number | null;
  readonly reservedGeneration: number;
  readonly state: RuntimeSessionLifecycleState;
  readonly registeredCleanupCount: number;
  readonly trackedWorkCount: number;
  readonly pendingWaitCount: number;
  readonly cleanupFailureCount: number;
  readonly retiredGenerationCount: number;
}

interface CleanupEntry {
  readonly cleanup: RuntimeSessionCleanup;
  active: boolean;
  called: boolean;
}

interface PendingWaitRecord<Value = unknown> {
  readonly promise: Promise<Value>;
  readonly resolvePromise: (value: Value) => void;
  readonly rejectPromise: (error: unknown) => void;
  settled: boolean;
}

type GenerationState = "active" | "terminal" | "retired";

interface GenerationRecord {
  readonly generation: number;
  readonly controller: AbortController;
  readonly cleanups: Map<RuntimeSessionCleanupPhase, CleanupEntry[]>;
  readonly trackedWork: Set<Promise<unknown>>;
  readonly pendingWaits: Set<PendingWaitRecord>;
  context: Readonly<RuntimeSessionGenerationContext> | null;
  state: GenerationState;
  termination: Promise<void> | null;
}

const CLEANUP_PHASE_SET: ReadonlySet<string> = new Set(
  RUNTIME_SESSION_CLEANUP_PHASES
);

/** One root generation/controller and one ordered retirement lane per session. */
export class RuntimeSessionLifecycle {
  #current: GenerationRecord | null;
  #reservedGeneration = 1;
  #lane: Promise<void> = Promise.resolve();
  #disposeRequested = false;
  #disposed = false;
  #disposal: Promise<void> | null = null;
  #cleanupFailureCount = 0;
  #retiredGenerationCount = 0;

  public constructor() {
    this.#current = this.#createGeneration(1);
  }

  public current(): Readonly<RuntimeSessionGenerationContext> {
    if (this.#disposed || this.#disposeRequested || this.#current === null) {
      throw disposedError();
    }
    if (this.#current.state !== "active") throw staleGenerationError();
    return requireGenerationContext(this.#current);
  }

  public replace(): Promise<Readonly<RuntimeSessionGenerationContext>> {
    if (this.#disposed || this.#disposeRequested) {
      return Promise.reject(disposedError());
    }
    const targetGeneration = checkedIncrement(
      this.#reservedGeneration,
      "runtime session generation"
    );
    this.#reservedGeneration = targetGeneration;
    this.#invalidate(this.#current);

    const transition = this.#lane.then(async () => {
      if (this.#disposeRequested) throw disposedError();
      const previous = this.#current;
      if (previous !== null) await this.#terminate(previous);
      if (this.#disposeRequested) throw disposedError();
      const next = this.#createGeneration(targetGeneration);
      this.#current = next;
      return requireGenerationContext(next);
    });
    this.#lane = transition.then(
      () => undefined,
      () => undefined
    );
    return transition;
  }

  public dispose(): Promise<void> {
    if (this.#disposal !== null) return this.#disposal;
    this.#disposeRequested = true;
    this.#invalidate(this.#current);
    this.#disposal = this.#lane.then(async () => {
      const current = this.#current;
      if (current !== null) await this.#terminate(current);
      this.#current = null;
      this.#disposed = true;
    });
    this.#lane = this.#disposal.then(
      () => undefined,
      () => undefined
    );
    return this.#disposal;
  }

  public snapshot(): Readonly<RuntimeSessionLifecycleSnapshot> {
    const current = this.#current;
    return Object.freeze({
      currentGeneration: current?.generation ?? null,
      reservedGeneration: this.#reservedGeneration,
      state: this.#state(),
      registeredCleanupCount: current === null
        ? 0
        : countActiveCleanups(current),
      trackedWorkCount: current?.trackedWork.size ?? 0,
      pendingWaitCount: current?.pendingWaits.size ?? 0,
      cleanupFailureCount: this.#cleanupFailureCount,
      retiredGenerationCount: this.#retiredGenerationCount
    });
  }

  #createGeneration(generation: number): GenerationRecord {
    const record: GenerationRecord = {
      generation,
      controller: new AbortController(),
      cleanups: new Map(),
      trackedWork: new Set(),
      pendingWaits: new Set(),
      context: null,
      state: "active",
      termination: null
    };
    for (const phase of RUNTIME_SESSION_CLEANUP_PHASES) {
      record.cleanups.set(phase, []);
    }
    record.context = this.#createContext(record);
    return record;
  }

  #createContext(
    record: GenerationRecord
  ): Readonly<RuntimeSessionGenerationContext> {
    return Object.freeze({
      generation: record.generation,
      signal: record.controller.signal,
      isCurrent: (): boolean => this.#isCurrent(record),
      registerCleanup: (
        phase: RuntimeSessionCleanupPhase,
        cleanup: RuntimeSessionCleanup
      ): (() => void) => this.#registerCleanup(record, phase, cleanup),
      track: <Value>(work: PromiseLike<Value>): Promise<Value> =>
        this.#track(record, work),
      publish: <Value, Result>(
        work: PromiseLike<Value>,
        publish: (value: Value) => Result
      ): Promise<Result> => this.#publish(record, work, publish),
      createPendingWait: <Value>(): RuntimeSessionPendingWait<Value> =>
        this.#createPendingWait<Value>(record)
    });
  }

  #registerCleanup(
    record: GenerationRecord,
    phaseValue: RuntimeSessionCleanupPhase,
    cleanupValue: RuntimeSessionCleanup
  ): () => void {
    this.#assertCurrent(record);
    const phase = requireCleanupPhase(phaseValue);
    if (typeof cleanupValue !== "function") {
      throw new TypeError("runtime session cleanup must be a function");
    }
    const entry: CleanupEntry = {
      cleanup: cleanupValue,
      active: true,
      called: false
    };
    record.cleanups.get(phase)!.push(entry);
    let registered = true;
    return () => {
      if (!registered) return;
      registered = false;
      entry.active = false;
    };
  }

  #track<Value>(
    record: GenerationRecord,
    work: PromiseLike<Value>
  ): Promise<Value> {
    try {
      this.#assertCurrent(record);
    } catch (error) {
      return Promise.reject(error);
    }
    const promise = Promise.resolve(work);
    record.trackedWork.add(promise);
    promise.then(
      () => { record.trackedWork.delete(promise); },
      () => { record.trackedWork.delete(promise); }
    );
    return promise;
  }

  #publish<Value, Result>(
    record: GenerationRecord,
    work: PromiseLike<Value>,
    publishValue: (value: Value) => Result
  ): Promise<Result> {
    if (typeof publishValue !== "function") {
      return Promise.reject(new TypeError(
        "runtime session publisher must be a function"
      ));
    }
    const publication = this.#track(record, work).then((value) => {
      this.#assertCurrent(record);
      return Reflect.apply(publishValue, undefined, [value]) as Result;
    });
    record.trackedWork.add(publication);
    publication.then(
      () => { record.trackedWork.delete(publication); },
      () => { record.trackedWork.delete(publication); }
    );
    return publication;
  }

  #createPendingWait<Value>(
    record: GenerationRecord
  ): RuntimeSessionPendingWait<Value> {
    this.#assertCurrent(record);
    let resolvePromise!: (value: Value) => void;
    let rejectPromise!: (error: unknown) => void;
    const promise = new Promise<Value>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const wait: PendingWaitRecord<Value> = {
      promise,
      resolvePromise,
      rejectPromise,
      settled: false
    };
    record.pendingWaits.add(wait as PendingWaitRecord);
    const settle = (
      kind: "resolve" | "reject",
      value: Value | unknown
    ): void => {
      if (wait.settled) return;
      wait.settled = true;
      record.pendingWaits.delete(wait as PendingWaitRecord);
      if (kind === "resolve") resolvePromise(value as Value);
      else rejectPromise(value);
    };
    return Object.freeze({
      promise,
      resolve: (value: Value): void => { settle("resolve", value); },
      reject: (error: unknown): void => { settle("reject", error); }
    });
  }

  #invalidate(record: GenerationRecord | null): void {
    if (record === null || record.state !== "active") return;
    record.state = "terminal";
    record.controller.abort(sessionAbortError());
  }

  #terminate(record: GenerationRecord): Promise<void> {
    this.#invalidate(record);
    if (record.termination !== null) return record.termination;
    record.termination = this.#retire(record);
    return record.termination;
  }

  async #retire(record: GenerationRecord): Promise<void> {
    for (const phase of RUNTIME_SESSION_CLEANUP_PHASES) {
      const entries = record.cleanups.get(phase) ?? [];
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index]!;
        if (!entry.active || entry.called) continue;
        entry.called = true;
        entry.active = false;
        try {
          await Reflect.apply(entry.cleanup, undefined, []);
        } catch {
          this.#cleanupFailureCount = checkedIncrement(
            this.#cleanupFailureCount,
            "runtime cleanup failure count"
          );
        }
      }
      entries.length = 0;
    }

    for (const wait of [...record.pendingWaits]) {
      if (wait.settled) continue;
      wait.settled = true;
      record.pendingWaits.delete(wait);
      wait.rejectPromise(sessionAbortError());
    }
    await Promise.allSettled([...record.trackedWork]);
    record.trackedWork.clear();
    record.pendingWaits.clear();
    record.cleanups.clear();
    record.state = "retired";
    this.#retiredGenerationCount = checkedIncrement(
      this.#retiredGenerationCount,
      "retired generation count"
    );
  }

  #isCurrent(record: GenerationRecord): boolean {
    return !this.#disposeRequested &&
      !this.#disposed &&
      this.#current === record &&
      record.state === "active";
  }

  #assertCurrent(record: GenerationRecord): void {
    if (!this.#isCurrent(record)) throw staleGenerationError();
  }

  #state(): RuntimeSessionLifecycleState {
    if (this.#disposed) return "disposed";
    if (this.#disposeRequested) return "disposing";
    if (this.#current?.state !== "active") return "replacing";
    return "active";
  }
}

function requireGenerationContext(
  record: GenerationRecord
): Readonly<RuntimeSessionGenerationContext> {
  const context = record.context;
  if (context === null) {
    throw new Error("runtime session generation context is not initialized");
  }
  return context;
}

function countActiveCleanups(record: GenerationRecord): number {
  let count = 0;
  for (const entries of record.cleanups.values()) {
    for (const entry of entries) {
      if (entry.active && !entry.called) count += 1;
    }
  }
  return count;
}

function requireCleanupPhase(
  value: RuntimeSessionCleanupPhase
): RuntimeSessionCleanupPhase {
  if (typeof value !== "string" || !CLEANUP_PHASE_SET.has(value)) {
    throw new TypeError("runtime session cleanup phase is invalid");
  }
  return value;
}

function checkedIncrement(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER) {
    throw new RangeError(`${label} exceeded the safe-integer range`);
  }
  return value + 1;
}

function sessionAbortError(): DOMException {
  return new DOMException("runtime session generation was aborted", "AbortError");
}

function staleGenerationError(): DOMException {
  return new DOMException("runtime session generation is stale", "AbortError");
}

function disposedError(): RuntimePlaybackError {
  return new RuntimePlaybackError(normalizeRuntimeFailure("disposed"));
}
