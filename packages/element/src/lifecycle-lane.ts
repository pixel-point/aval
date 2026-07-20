export class LifecycleLane {
  #sequence = 0;
  #tail: Promise<void> = Promise.resolve();
  #pending = 0;

  public generation<T>(
    abortActive: () => void,
    operation: (token: number) => Promise<T>
  ): Promise<T> {
    const token = this.#supersede(abortActive);
    const queued = this.#tail.then(() => {
      if (!this.current(token)) throw abortError();
      return operation(token);
    });
    this.#pending += 1;
    const result = queued.finally(() => { this.#pending -= 1; });
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }

  public retirement(
    abortActive: () => void,
    operation: () => Promise<void>
  ): Promise<void> {
    this.#supersede(abortActive);
    const queued = this.#tail.then(operation);
    this.#pending += 1;
    const result = queued.finally(() => { this.#pending -= 1; });
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }

  public current(token: number): boolean {
    return token === this.#sequence;
  }

  public get pending(): number {
    return this.#pending;
  }

  #supersede(abortActive: () => void): number {
    this.#sequence += 1;
    abortActive();
    return this.#sequence;
  }
}

function abortError(): DOMException {
  return new DOMException("AVAL generation was superseded", "AbortError");
}
