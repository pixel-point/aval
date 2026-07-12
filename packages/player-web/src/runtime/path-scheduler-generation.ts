import type { DecodeTimeline } from "./decode-timeline.js";
import type { PathSchedulerWorkerAdapter } from "./path-scheduler-model.js";
import type { PathSchedulerOutput } from "./path-scheduler-output.js";

export interface PathSchedulerGenerationOptions {
  readonly timeline: DecodeTimeline;
  readonly worker: PathSchedulerWorkerAdapter;
  readonly output: PathSchedulerOutput;
}

export interface PathSchedulerGenerationReplacement {
  readonly retiredGeneration: number;
  readonly generation: number;
  readonly path: string;
}

export interface PathSchedulerGenerationPlan {
  readonly retiredGeneration: number;
  readonly generation: number;
  readonly path: string;
}

export interface PathSchedulerGenerationCommit
  extends PathSchedulerGenerationReplacement {
  readonly activateWorker: () => Promise<void>;
}

/** Owns decoder generation/path tokens and their worker/ring activation order. */
export class PathSchedulerGeneration {
  readonly #timeline: DecodeTimeline;
  readonly #worker: PathSchedulerWorkerAdapter;
  readonly #output: PathSchedulerOutput;

  #generation: number | null = null;
  #path: string | null = null;

  public constructor(options: PathSchedulerGenerationOptions) {
    this.#timeline = options.timeline;
    this.#worker = options.worker;
    this.#output = options.output;
  }

  public get current(): number | null {
    return this.#generation;
  }

  public get path(): string | null {
    return this.#path;
  }

  public get nextDecodeOrdinal(): number {
    return this.#timeline.snapshot().nextOrdinal;
  }

  public async start(path: string): Promise<number> {
    if (this.#generation !== null) {
      throw new RangeError("path scheduler generation already started");
    }
    const generation = this.#timeline.activateNextGeneration();
    this.#generation = generation;
    this.#path = path;
    this.#output.start(generation, path);
    await this.#worker.activateGeneration(generation);
    return generation;
  }

  public async replace(
    path: string
  ): Promise<Readonly<PathSchedulerGenerationReplacement>> {
    const committed = this.commitReplacement(this.planReplacement(path));
    await committed.activateWorker();
    return Object.freeze({
      retiredGeneration: committed.retiredGeneration,
      generation: committed.generation,
      path: committed.path
    });
  }

  /** Reserves identity only; the active generation remains unchanged. */
  public planReplacement(
    path: string
  ): Readonly<PathSchedulerGenerationPlan> {
    const retiredGeneration = this.requireGeneration();
    if (retiredGeneration >= Number.MAX_SAFE_INTEGER) {
      throw new RangeError("decode generation exceeds the safe-integer range");
    }
    return Object.freeze({
      retiredGeneration,
      generation: retiredGeneration + 1,
      path
    });
  }

  /**
   * Synchronously installs the exact planned identity, returning only the
   * worker acknowledgement that an external operation lane must await.
   */
  public commitReplacement(
    plan: Readonly<PathSchedulerGenerationPlan>
  ): Readonly<PathSchedulerGenerationCommit> {
    if (this.#generation !== plan.retiredGeneration) {
      throw new RangeError("planned path scheduler generation became stale");
    }
    const generation = this.#timeline.activateNextGeneration();
    if (generation !== plan.generation) {
      throw new RangeError("decode timeline diverged from its reserved generation");
    }
    this.#output.activate(generation, plan.path);
    this.#generation = generation;
    this.#path = plan.path;
    let activation: Promise<void> | null = null;
    const activateWorker = (): Promise<void> => {
      if (activation !== null) return activation;
      try {
        activation = this.#worker.activateGeneration(generation);
      } catch (error) {
        activation = Promise.reject(error);
      }
      return activation;
    };
    return Object.freeze({
      retiredGeneration: plan.retiredGeneration,
      generation,
      path: plan.path,
      activateWorker
    });
  }

  public async abortActive(): Promise<void> {
    const generation = this.#generation;
    if (generation !== null && this.#worker.activeGeneration === generation) {
      await this.#worker.abortGeneration(generation);
    }
  }

  public async dispose(): Promise<void> {
    await this.abortActive();
    this.#generation = null;
    this.#path = null;
  }

  public requireGeneration(): number {
    if (this.#generation === null) {
      throw new RangeError("path scheduler has no active generation");
    }
    return this.#generation;
  }

  public requirePath(): string {
    if (this.#path === null) {
      throw new RangeError("path scheduler has no active path");
    }
    return this.#path;
  }
}

export function abortablePathSchedulerActivation<T>(
  activation: Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  if (signal === undefined) return activation;
  if (signal.aborted) {
    void activation.catch(() => undefined);
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    void activation.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      }
    );
  });
}

export function checkedPathSchedulerSerial(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 ||
    value >= Number.MAX_SAFE_INTEGER) {
    throw new RangeError("scheduler replacement serial exceeded the safe range");
  }
  return value + 1;
}
