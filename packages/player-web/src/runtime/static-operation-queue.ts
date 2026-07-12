export interface StaticOperationContext {
  readonly generation: number;
  readonly signal: AbortSignal;
}

export interface StaticOperationQueueSnapshot {
  readonly generation: number;
  readonly pending: number;
  readonly active: boolean;
  readonly disposed: boolean;
}

export class StaticOperationQueueDisposedError extends DOMException {
  public constructor() {
    super("static operation queue is disposed", "AbortError");
  }
}

/**
 * One-at-a-time host for static decode/presentation/commit operations. A
 * rejected operation never poisons the tail, while disposal aborts the active
 * operation and prevents every queued callback from starting.
 */
export class StaticOperationQueue {
  readonly #lifecycle = new AbortController();
  #tail: Promise<void> = Promise.resolve();
  #generation = 0;
  #pending = 0;
  #active = false;
  #disposed = false;

  public enqueue<T>(
    operation: (context: Readonly<StaticOperationContext>) => PromiseLike<T> | T
  ): Promise<T> {
    if (typeof operation !== "function") {
      return Promise.reject(new TypeError(
        "static queue operation must be a function"
      ));
    }
    if (this.#disposed) {
      return Promise.reject(new StaticOperationQueueDisposedError());
    }
    const generation = checkedIncrement(this.#generation, "static generation");
    this.#generation = generation;
    this.#pending = checkedIncrement(this.#pending, "static pending count");

    const result = this.#tail.then(async () => {
      this.#throwIfDisposed();
      this.#active = true;
      try {
        return await operation(Object.freeze({
          generation,
          signal: this.#lifecycle.signal
        }));
      } finally {
        this.#active = false;
      }
    });
    this.#tail = result.then(
      () => undefined,
      () => undefined
    ).finally(() => {
      this.#pending -= 1;
    });
    return result;
  }

  public snapshot(): Readonly<StaticOperationQueueSnapshot> {
    return Object.freeze({
      generation: this.#generation,
      pending: this.#pending,
      active: this.#active,
      disposed: this.#disposed
    });
  }

  public async settled(): Promise<void> {
    await this.#tail;
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#lifecycle.abort(new StaticOperationQueueDisposedError());
  }

  #throwIfDisposed(): void {
    if (this.#disposed || this.#lifecycle.signal.aborted) {
      throw new StaticOperationQueueDisposedError();
    }
  }
}

function checkedIncrement(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER) {
    throw new RangeError(`${label} exceeded the safe-integer range`);
  }
  return value + 1;
}
