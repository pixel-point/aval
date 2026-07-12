/**
 * Serializes listener-originated public inputs behind the synchronous graph,
 * draw, playback-synchronization transaction that emitted the listener call.
 */
export class IntegratedOperationGate {
  readonly #queue: Array<() => void> = [];
  #depth = 0;
  #drainScheduled = false;

  public get active(): boolean {
    return this.#depth > 0;
  }

  public run<T>(operation: () => T): T {
    this.#depth += 1;
    try {
      return operation();
    } finally {
      this.#depth -= 1;
      this.#scheduleDrain();
    }
  }

  public enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = new Promise<T>((resolve, reject) => {
      this.#queue.push(() => {
        let outcome: Promise<T>;
        try {
          outcome = operation();
        } catch (error) {
          reject(error);
          return;
        }
        void outcome.then(resolve, reject);
      });
    });
    this.#scheduleDrain();
    return result;
  }

  #scheduleDrain(): void {
    if (this.active || this.#drainScheduled || this.#queue.length === 0) return;
    this.#drainScheduled = true;
    void Promise.resolve().then(() => {
      this.#drainScheduled = false;
      this.#drain();
    });
  }

  #drain(): void {
    if (this.active) {
      this.#scheduleDrain();
      return;
    }
    while (!this.active && this.#queue.length > 0) {
      this.#queue.shift()!();
    }
    this.#scheduleDrain();
  }
}
