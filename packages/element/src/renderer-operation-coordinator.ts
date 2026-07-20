import type { RendererDiagnosticOperation } from "./renderer-diagnostics.js";

export interface RendererOperationPolicy<TerminalError extends Error> {
  readonly accepting: () => boolean;
  readonly unavailable: () => Error;
  readonly classify: (
    reason: unknown,
    operation: RendererDiagnosticOperation,
    operationOrdinal: number
  ) => TerminalError | null;
  readonly terminal: (error: TerminalError) => void;
}

/** Owns serialized renderer work, operation identity, and terminal publication. */
export class RendererOperationCoordinator<TerminalError extends Error> {
  readonly #policy: Readonly<RendererOperationPolicy<TerminalError>>;
  #tail: Promise<void> = Promise.resolve();
  #pending = 0;
  #operationSequence = 0;

  public constructor(policy: Readonly<RendererOperationPolicy<TerminalError>>) {
    this.#policy = policy;
  }

  public get pendingOperations(): number { return this.#pending; }

  public settled(): Promise<void> { return this.#tail; }

  public beginOperation(): number {
    if (this.#operationSequence === Number.MAX_SAFE_INTEGER) {
      throw new RangeError("renderer operation identity is exhausted");
    }
    const ordinal = this.#operationSequence;
    this.#operationSequence += 1;
    return ordinal;
  }

  public enqueue<T>(
    operation: RendererDiagnosticOperation,
    task: (operationOrdinal: number) => T | Promise<T>
  ): Promise<T> {
    return this.#queue(operation, undefined, task);
  }

  public enqueueIf(
    operation: RendererDiagnosticOperation,
    shouldRun: () => boolean,
    task: (operationOrdinal: number) => void | Promise<void>
  ): Promise<void> {
    return this.#queue(operation, shouldRun, task).then(() => undefined);
  }

  #queue<T>(
    operation: RendererDiagnosticOperation,
    shouldRun: undefined,
    task: (operationOrdinal: number) => T | Promise<T>
  ): Promise<T>;
  #queue<T>(
    operation: RendererDiagnosticOperation,
    shouldRun: () => boolean,
    task: (operationOrdinal: number) => T | Promise<T>
  ): Promise<T | undefined>;
  #queue<T>(
    operation: RendererDiagnosticOperation,
    shouldRun: (() => boolean) | undefined,
    task: (operationOrdinal: number) => T | Promise<T>
  ): Promise<T | undefined> {
    if (!this.#policy.accepting()) {
      return Promise.reject(this.#policy.unavailable());
    }
    this.#pending += 1;
    const job = this.#tail.then(async () => {
      if (!this.#policy.accepting()) throw this.#policy.unavailable();
      if (shouldRun !== undefined && !shouldRun()) return undefined;
      const operationOrdinal = this.beginOperation();
      try {
        return await task(operationOrdinal);
      } catch (reason) {
        const terminal = this.#policy.classify(
          reason,
          operation,
          operationOrdinal
        );
        if (terminal === null) throw reason;
        this.#policy.terminal(terminal);
        throw terminal;
      }
    }).finally(() => { this.#pending -= 1; });
    this.#tail = job.then(() => undefined, () => undefined);
    return job;
  }
}
