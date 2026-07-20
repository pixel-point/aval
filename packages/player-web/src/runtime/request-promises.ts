import type {
  GraphSettlementError,
  MotionGraphEffect
} from "@pixel-point/aval-graph";
import { RuntimePlaybackError } from "./errors.js";

export type RequestSettlementEffect = Readonly<
  Extract<MotionGraphEffect, { readonly type: "settle" }>
>;

export interface RequestPromisesOptions {
  readonly scheduleMicrotask?: (callback: () => void) => void;
}

interface RequestCapability {
  readonly resolve: () => void;
  readonly reject: (reason: unknown) => void;
  status: "pending" | "scheduled";
}

export class RequestPromiseInvariantError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "RequestPromiseInvariantError";
  }
}

/** Stable rejection named exactly like the graph settlement contract. */
export class GraphRequestSettlementError extends Error {
  public declare readonly graphError: GraphSettlementError;

  public constructor(graphError: GraphSettlementError) {
    super(messageFor(graphError));
    Object.defineProperties(this, {
      name: {
        value: graphError,
        enumerable: false,
        configurable: false,
        writable: false
      },
      graphError: {
        value: graphError,
        enumerable: true,
        configurable: false,
        writable: false
      }
    });
    Object.freeze(this);
  }
}

/**
 * Close-once promise capabilities keyed only by graph-issued request IDs.
 * Completion groups are defined by each settle effect rather than duplicated
 * in this host.
 */
export class RequestPromises {
  readonly #scheduleMicrotask: (callback: () => void) => void;
  readonly #capabilities = new Map<number, RequestCapability>();
  #terminalPlaybackError: RuntimePlaybackError | null = null;
  #disposed = false;

  public constructor(options: RequestPromisesOptions = {}) {
    const scheduler = options.scheduleMicrotask ?? queueMicrotask;
    if (typeof scheduler !== "function") {
      throw new RequestPromiseInvariantError(
        "request promise microtask scheduler must be a function"
      );
    }
    // Store an arrow boundary instead of the bare host function. Calling a
    // function-valued private field as `this.#scheduleMicrotask()` supplies
    // the RequestPromises instance as its receiver; Chromium's native
    // queueMicrotask rejects that illegal invocation.
    this.#scheduleMicrotask = (callback) => {
      scheduler(callback);
    };
  }

  public get disposed(): boolean {
    return this.#disposed;
  }

  public get pendingCount(): number {
    return this.#capabilities.size;
  }

  public register(requestId: number): Promise<void> {
    this.#assertActive();
    validateRequestId(requestId);
    if (this.#capabilities.has(requestId)) {
      throw new RequestPromiseInvariantError(
        "graph request ID is already registered"
      );
    }

    let resolvePromise!: () => void;
    let rejectPromise!: (reason: unknown) => void;
    const promise = new Promise<void>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    this.#capabilities.set(requestId, {
      resolve: resolvePromise,
      reject: rejectPromise,
      status: "pending"
    });
    return promise;
  }

  public pendingRequestIds(): readonly number[] {
    return Object.freeze(
      [...this.#capabilities.keys()].sort((left, right) => left - right)
    );
  }

  /** Bind the one canonical error before terminal graph effects are applied. */
  public bindTerminalPlaybackError(error: RuntimePlaybackError): void {
    this.#assertActive();
    if (!(error instanceof RuntimePlaybackError)) {
      throw new RequestPromiseInvariantError(
        "terminal playback settlement requires a RuntimePlaybackError"
      );
    }
    if (this.#terminalPlaybackError === null) {
      this.#terminalPlaybackError = error;
      return;
    }
    if (this.#terminalPlaybackError !== error) {
      throw new RequestPromiseInvariantError(
        "terminal playback error cannot be rebound"
      );
    }
  }

  public queueSettlement(effect: RequestSettlementEffect): void {
    this.#assertActive();
    const requestIds = validateSettlement(effect, this.#capabilities);
    const terminalPlaybackError = effect.outcome.type === "reject" &&
        effect.outcome.error === "PlaybackError"
      ? this.#requireTerminalPlaybackError()
      : null;
    for (const requestId of requestIds) {
      this.#capabilities.get(requestId)!.status = "scheduled";
    }

    const outcome = Object.freeze({ ...effect.outcome });
    try {
      this.#scheduleMicrotask(() => {
        this.#complete(requestIds, outcome, terminalPlaybackError);
      });
    } catch {
      for (const requestId of requestIds) {
        const capability = this.#capabilities.get(requestId);
        if (capability?.status === "scheduled") capability.status = "pending";
      }
      throw new RequestPromiseInvariantError(
        "request settlement microtask could not be scheduled"
      );
    }
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    const error = new GraphRequestSettlementError("AbortError");
    for (const capability of this.#capabilities.values()) {
      capability.reject(error);
    }
    this.#capabilities.clear();
  }

  #complete(
    requestIds: readonly number[],
    outcome: RequestSettlementEffect["outcome"],
    terminalPlaybackError: RuntimePlaybackError | null
  ): void {
    if (this.#disposed) return;
    for (const requestId of requestIds) {
      const capability = this.#capabilities.get(requestId);
      if (capability?.status !== "scheduled") {
        continue;
      }
      this.#capabilities.delete(requestId);
      if (outcome.type === "resolve") {
        capability.resolve();
      } else {
        capability.reject(requestSettlementError(
          outcome.error,
          terminalPlaybackError
        ));
      }
    }
  }

  #assertActive(): void {
    if (this.#disposed) {
      throw new RequestPromiseInvariantError(
        "request promise host is disposed"
      );
    }
  }

  #requireTerminalPlaybackError(): RuntimePlaybackError {
    if (this.#terminalPlaybackError === null) {
      throw new RequestPromiseInvariantError(
        "PlaybackError settlement requires a bound terminal playback error"
      );
    }
    return this.#terminalPlaybackError;
  }
}

function validateSettlement(
  effect: RequestSettlementEffect,
  capabilities: ReadonlyMap<number, RequestCapability>
): readonly number[] {
  if (
    typeof effect !== "object" ||
    effect === null ||
    effect.type !== "settle" ||
    !Array.isArray(effect.requestIds) ||
    effect.requestIds.length < 1 ||
    typeof effect.outcome !== "object" ||
    effect.outcome === null ||
    effect.outcome.timing !== "microtask"
  ) {
    throw new RequestPromiseInvariantError(
      "graph request settlement is malformed"
    );
  }

  const requestIds = [...effect.requestIds];
  for (let index = 0; index < requestIds.length; index += 1) {
    const requestId = requestIds[index]!;
    validateRequestId(requestId);
    if (index > 0 && requestIds[index - 1]! >= requestId) {
      throw new RequestPromiseInvariantError(
        "graph settlement request IDs must be unique and increasing"
      );
    }
    const capability = capabilities.get(requestId);
    if (capability === undefined) {
      throw new RequestPromiseInvariantError(
        "graph settlement references an unknown request ID"
      );
    }
    if (capability.status !== "pending") {
      throw new RequestPromiseInvariantError(
        "graph request ID was settled more than once"
      );
    }
  }

  if (
    effect.outcome.type !== "resolve" &&
    effect.outcome.type !== "reject"
  ) {
    throw new RequestPromiseInvariantError(
      "graph request settlement outcome is malformed"
    );
  }
  return Object.freeze(requestIds);
}

function validateRequestId(requestId: number): void {
  if (!Number.isSafeInteger(requestId) || requestId <= 0) {
    throw new RequestPromiseInvariantError(
      "graph request ID must be a positive safe integer"
    );
  }
}

function messageFor(error: GraphSettlementError): string {
  switch (error) {
    case "NotReadyError":
      return "animation player is not ready";
    case "RouteError":
      return "animation route is unavailable";
    case "InputOverflowError":
      return "animation input limit was exceeded";
    case "AbortError":
      return "animation request was aborted";
    case "PlaybackError":
      return "animation state presentation failed";
  }
}

function requestSettlementError(
  error: GraphSettlementError,
  terminalPlaybackError: RuntimePlaybackError | null
): Error {
  if (error !== "PlaybackError") {
    return new GraphRequestSettlementError(error);
  }
  if (terminalPlaybackError === null) {
    throw new RequestPromiseInvariantError(
      "PlaybackError settlement lost its terminal playback error"
    );
  }
  return terminalPlaybackError;
}
