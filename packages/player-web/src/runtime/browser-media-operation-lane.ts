export class BrowserMediaOperationSupersededError extends Error {
  public constructor() {
    super("browser media operation was superseded");
    this.name = "BrowserMediaOperationSupersededError";
  }
}

export interface BrowserMediaOperationLaneOptions {
  readonly signal: AbortSignal;
  readonly track: <T>(operation: Promise<T>) => Promise<T>;
}

/** Sole serialized, cancellation-aware lane for decoder and upload mutation. */
export class BrowserMediaOperationLane {
  readonly #signal: AbortSignal;
  readonly #track: BrowserMediaOperationLaneOptions["track"];
  readonly #controllers = new Set<AbortController>();
  #tail: Promise<unknown> = Promise.resolve();
  #pending = 0;
  #disposed = false;

  public constructor(options: Readonly<BrowserMediaOperationLaneOptions>) {
    this.#signal = options.signal;
    this.#track = options.track;
  }

  public get pending(): number {
    return this.#pending;
  }

  public enqueue<T>(
    operation: (signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    if (this.#disposed) {
      return Promise.reject(new DOMException(
        "browser media lane is disposed",
        "AbortError"
      ));
    }
    const controller = new AbortController();
    const unlink = linkAbortSignal(this.#signal, controller);
    this.#controllers.add(controller);
    this.#pending += 1;
    const queued = this.#tail.catch(() => undefined).then(async () => {
      throwIfAborted(controller.signal);
      return operation(controller.signal);
    }).finally(() => {
      unlink();
      this.#controllers.delete(controller);
      this.#pending -= 1;
    });
    this.#tail = queued;
    return this.#track(queued);
  }

  public supersede(): void {
    const reason = new BrowserMediaOperationSupersededError();
    for (const controller of this.#controllers) {
      if (!controller.signal.aborted) controller.abort(reason);
    }
  }

  public async settled(): Promise<void> {
    for (;;) {
      const tail = this.#tail;
      await Promise.allSettled([tail]);
      if (tail === this.#tail && this.#pending === 0) return;
    }
  }

  public async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.supersede();
    await this.settled();
  }
}

export function isBrowserMediaSuperseded(error: unknown): boolean {
  return error instanceof BrowserMediaOperationSupersededError;
}

function linkAbortSignal(
  source: AbortSignal,
  target: AbortController
): () => void {
  if (source.aborted) {
    target.abort(source.reason);
    return () => undefined;
  }
  const abort = () => target.abort(source.reason);
  source.addEventListener("abort", abort, { once: true });
  return () => source.removeEventListener("abort", abort);
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason;
}
