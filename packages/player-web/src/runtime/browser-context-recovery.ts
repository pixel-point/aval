import {
  normalizeRuntimeFailure,
  type RuntimeFailure
} from "./errors.js";

export interface BrowserContextRecoveryEvent {
  preventDefault(): void;
}

export interface BrowserContextRecoveryEventTarget {
  addEventListener(
    type: "webglcontextlost" | "webglcontextrestored",
    listener: (event: BrowserContextRecoveryEvent) => void
  ): void;
  removeEventListener(
    type: "webglcontextlost" | "webglcontextrestored",
    listener: (event: BrowserContextRecoveryEvent) => void
  ): void;
}

export interface BrowserContextRebuildInput {
  readonly generation: number;
  readonly signal: AbortSignal;
}

export interface BrowserContextRetirementInput {
  readonly generation: number;
  readonly signal: AbortSignal;
}

export interface BrowserContextRecoveryOptions {
  readonly target: BrowserContextRecoveryEventTarget;
  /** Must synchronously make retained strict pixels visible. */
  readonly coverStatic: () => void;
  /** Must synchronously freeze the rational playback clock. */
  readonly freeze: () => void;
  readonly retireAnimated: (
    input: Readonly<BrowserContextRetirementInput>
  ) => void | PromiseLike<void>;
  readonly canRestore: () => boolean;
  /** Creates fresh GL/media objects and draws current-state body frame zero. */
  readonly rebuild: (
    input: Readonly<BrowserContextRebuildInput>
  ) => boolean | PromiseLike<boolean>;
  /** Reveals animation only after rebuild has completed its first draw. */
  readonly revealAnimated: () => void;
  readonly onFailure?: (failure: Readonly<RuntimeFailure>) => void;
}

export type BrowserContextRecoveryState =
  | "ready"
  | "lost"
  | "restoring"
  | "static"
  | "disposed";

export interface BrowserContextRecoverySnapshot {
  readonly state: BrowserContextRecoveryState;
  readonly activeGeneration: number;
  readonly lossCount: number;
  readonly restorationCount: number;
  readonly successfulRestorations: number;
  readonly failures: number;
  readonly repeatedLosses: number;
  readonly sticky: boolean;
  readonly listenerCount: number;
  readonly pendingOperations: number;
}

interface CapturedTarget {
  readonly add: (
    type: "webglcontextlost" | "webglcontextrestored",
    listener: (event: BrowserContextRecoveryEvent) => void
  ) => void;
  readonly remove: (
    type: "webglcontextlost" | "webglcontextrestored",
    listener: (event: BrowserContextRecoveryEvent) => void
  ) => void;
}

interface CapturedCallbacks {
  readonly coverStatic: () => void;
  readonly freeze: () => void;
  readonly retireAnimated: BrowserContextRecoveryOptions["retireAnimated"];
  readonly canRestore: () => boolean;
  readonly rebuild: BrowserContextRecoveryOptions["rebuild"];
  readonly revealAnimated: () => void;
  readonly onFailure: ((failure: Readonly<RuntimeFailure>) => void) | null;
}

/**
 * Owns WebGL context listeners and recovery invalidation, but no GL objects.
 * Player semantics remain injected so this controller cannot bypass the
 * static-cover, decoder-lease, or all-routes readiness authorities.
 */
export class BrowserContextRecovery {
  readonly #target: CapturedTarget;
  readonly #callbacks: CapturedCallbacks;
  readonly #lossListener: (event: BrowserContextRecoveryEvent) => void;
  readonly #restoreListener: (event: BrowserContextRecoveryEvent) => void;
  readonly #operations = new Set<Promise<unknown>>();

  #state: BrowserContextRecoveryState = "ready";
  #generation = 0;
  #lossCount = 0;
  #restorationCount = 0;
  #successfulRestorations = 0;
  #failures = 0;
  #repeatedLosses = 0;
  #sticky = false;
  #restorationObserved = false;
  #listenersInstalled = false;
  #activeController: AbortController | null = null;
  #retirementTail: Promise<void> = Promise.resolve();
  #disposal: Promise<void> | null = null;

  public constructor(options: Readonly<BrowserContextRecoveryOptions>) {
    const captured = captureOptions(options);
    this.#target = captured.target;
    this.#callbacks = captured.callbacks;
    this.#lossListener = (event) => { this.#handleLoss(event); };
    this.#restoreListener = () => {
      this.#restorationObserved = true;
      this.requestRestore();
    };
    try {
      this.#target.add("webglcontextlost", this.#lossListener);
      this.#target.add("webglcontextrestored", this.#restoreListener);
      this.#listenersInstalled = true;
    } catch (error) {
      try {
        this.#target.remove("webglcontextlost", this.#lossListener);
        this.#target.remove("webglcontextrestored", this.#restoreListener);
      } catch {
        // Constructor rollback continues with the original listener failure.
      }
      throw error;
    }
  }

  public requestRestore(): void {
    if (
      this.#state === "disposed" ||
      this.#state === "ready" ||
      this.#state === "restoring" ||
      this.#sticky ||
      !this.#restorationObserved
    ) {
      return;
    }
    if (!this.#safeCanRestore()) {
      this.#state = "static";
      return;
    }
    const generation = this.#generation;
    const controller = new AbortController();
    this.#activeController?.abort(supersededAbort());
    this.#activeController = controller;
    this.#state = "restoring";
    this.#restorationCount = checkedIncrement(
      this.#restorationCount,
      "context restoration count"
    );
    const operation = this.#restore(generation, controller);
    this.#track(operation);
  }

  public snapshot(): Readonly<BrowserContextRecoverySnapshot> {
    return Object.freeze({
      state: this.#state,
      activeGeneration: this.#generation,
      lossCount: this.#lossCount,
      restorationCount: this.#restorationCount,
      successfulRestorations: this.#successfulRestorations,
      failures: this.#failures,
      repeatedLosses: this.#repeatedLosses,
      sticky: this.#sticky,
      listenerCount: this.#listenersInstalled ? 2 : 0,
      pendingOperations: this.#operations.size
    });
  }

  public async settled(): Promise<void> {
    while (this.#operations.size > 0) {
      await Promise.allSettled([...this.#operations]);
    }
    await this.#retirementTail;
  }

  public dispose(): Promise<void> {
    if (this.#disposal !== null) return this.#disposal;
    this.#state = "disposed";
    this.#activeController?.abort(disposedAbort());
    this.#activeController = null;
    this.#removeListeners();
    this.#disposal = this.settled();
    return this.#disposal;
  }

  #handleLoss(event: BrowserContextRecoveryEvent): void {
    if (this.#state === "disposed") return;
    try {
      event.preventDefault();
    } catch {
      // Context recovery may still proceed after a hostile event seam.
    }
    const repeated = this.#state === "restoring";
    this.#restorationObserved = false;
    this.#generation = checkedIncrement(
      this.#generation,
      "context recovery generation"
    );
    this.#lossCount = checkedIncrement(this.#lossCount, "context loss count");
    if (repeated) {
      this.#repeatedLosses = checkedIncrement(
        this.#repeatedLosses,
        "repeated context loss count"
      );
      this.#sticky = true;
    }
    this.#activeController?.abort(contextLossAbort());
    this.#activeController = null;
    this.#state = repeated ? "static" : "lost";

    this.#runSynchronousLossStep(
      this.#callbacks.coverStatic,
      "context-cover"
    );
    this.#runSynchronousLossStep(
      this.#callbacks.freeze,
      "context-freeze"
    );

    const generation = this.#generation;
    const controller = new AbortController();
    const retire = this.#retirementTail.then(async () => {
      try {
        await this.#callbacks.retireAnimated({
          generation,
          signal: controller.signal
        });
      } catch (error) {
        if (controller.signal.aborted || this.#state === "disposed") return;
        this.#fail(error, "context-retire");
      }
    });
    this.#retirementTail = retire.catch(() => undefined);
    this.#track(retire);
    if (repeated) {
      this.#recordFailure(
        new Error("rendering context was lost during restoration"),
        "context-repeated-loss"
      );
    }
  }

  async #restore(
    generation: number,
    controller: AbortController
  ): Promise<void> {
    try {
      await this.#retirementTail;
      if (!this.#isCurrentRestoration(generation, controller)) return;
      const rebuilt = await this.#callbacks.rebuild({
        generation,
        signal: controller.signal
      });
      if (!this.#isCurrentRestoration(generation, controller)) return;
      if (rebuilt !== true) {
        this.#fail(
          new Error("rendering context rebuild did not become ready"),
          "context-rebuild"
        );
        return;
      }
      try {
        this.#callbacks.revealAnimated();
      } catch (error) {
        this.#fail(error, "context-reveal");
        return;
      }
      if (!this.#isCurrentRestoration(generation, controller)) return;
      this.#successfulRestorations = checkedIncrement(
        this.#successfulRestorations,
        "successful context restoration count"
      );
      this.#state = "ready";
    } catch (error) {
      if (controller.signal.aborted || this.#state === "disposed") return;
      this.#fail(error, "context-rebuild");
    } finally {
      if (this.#activeController === controller) {
        this.#activeController = null;
      }
    }
  }

  #runSynchronousLossStep(
    operation: () => void,
    phase: string
  ): boolean {
    try {
      operation();
      return true;
    } catch (error) {
      this.#fail(error, phase);
      return false;
    }
  }

  #safeCanRestore(): boolean {
    try {
      return this.#callbacks.canRestore() === true;
    } catch (error) {
      this.#fail(error, "context-eligibility");
      return false;
    }
  }

  #isCurrentRestoration(
    generation: number,
    controller: AbortController
  ): boolean {
    return this.#state === "restoring" &&
      this.#generation === generation &&
      this.#activeController === controller &&
      !controller.signal.aborted &&
      !this.#sticky;
  }

  #fail(error: unknown, lifecyclePhase: string): void {
    if (this.#state === "disposed") return;
    this.#state = "static";
    this.#sticky = true;
    this.#activeController?.abort(contextFailureAbort());
    this.#activeController = null;
    this.#recordFailure(error, lifecyclePhase);
  }

  #recordFailure(error: unknown, lifecyclePhase: string): void {
    this.#failures = checkedIncrement(this.#failures, "context failure count");
    const failure = normalizeRuntimeFailure("context-loss", error, {
      lifecyclePhase,
      generation: this.#generation
    });
    try {
      this.#callbacks.onFailure?.(failure);
    } catch {
      // Observational diagnostics never own recovery state.
    }
  }

  #track<T>(operation: Promise<T>): void {
    this.#operations.add(operation);
    void operation.finally(() => {
      this.#operations.delete(operation);
    }).catch(() => undefined);
  }

  #removeListeners(): void {
    if (!this.#listenersInstalled) return;
    this.#listenersInstalled = false;
    try {
      this.#target.remove("webglcontextlost", this.#lossListener);
    } catch {
      // Terminal cleanup continues through hostile event targets.
    }
    try {
      this.#target.remove("webglcontextrestored", this.#restoreListener);
    } catch {
      // Terminal cleanup continues through hostile event targets.
    }
  }
}

function captureOptions(
  options: Readonly<BrowserContextRecoveryOptions>
): Readonly<{ target: CapturedTarget; callbacks: CapturedCallbacks }> {
  if (options === null || typeof options !== "object") {
    throw new TypeError("browser context recovery options must be an object");
  }
  const target = captureTarget(options.target);
  const callbacks = Object.freeze({
    coverStatic: requireCallback(options.coverStatic, "static cover"),
    freeze: requireCallback(options.freeze, "clock freeze"),
    retireAnimated: requireCallback(
      options.retireAnimated,
      "animated retirement"
    ),
    canRestore: requireCallback(options.canRestore, "restore eligibility"),
    rebuild: requireCallback(options.rebuild, "context rebuild"),
    revealAnimated: requireCallback(options.revealAnimated, "animated reveal"),
    onFailure: options.onFailure === undefined
      ? null
      : requireCallback(options.onFailure, "context failure observer")
  });
  return Object.freeze({ target, callbacks });
}

function captureTarget(target: BrowserContextRecoveryEventTarget): CapturedTarget {
  if (target === null || typeof target !== "object") {
    throw new TypeError("browser context event target must be an object");
  }
  let add: unknown;
  let remove: unknown;
  try {
    add = Reflect.get(target, "addEventListener");
    remove = Reflect.get(target, "removeEventListener");
  } catch {
    throw new TypeError("browser context event target is inaccessible");
  }
  if (typeof add !== "function" || typeof remove !== "function") {
    throw new TypeError("browser context event target is malformed");
  }
  const captured: CapturedTarget = {
    add: (
      type: "webglcontextlost" | "webglcontextrestored",
      listener: (event: BrowserContextRecoveryEvent) => void
    ) => {
      Reflect.apply(add as (...args: unknown[]) => unknown, target, [
        type,
        listener
      ]);
    },
    remove: (
      type: "webglcontextlost" | "webglcontextrestored",
      listener: (event: BrowserContextRecoveryEvent) => void
    ) => {
      Reflect.apply(remove as (...args: unknown[]) => unknown, target, [
        type,
        listener
      ]);
    }
  };
  return Object.freeze(captured);
}

function requireCallback<Value extends (...args: never[]) => unknown>(
  value: Value,
  label: string
): Value {
  if (typeof value !== "function") {
    throw new TypeError(`browser context ${label} callback is unavailable`);
  }
  return value;
}

function checkedIncrement(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value >= Number.MAX_SAFE_INTEGER) {
    throw new RangeError(`${label} exceeds the safe-integer range`);
  }
  return value + 1;
}

function contextLossAbort(): DOMException {
  return new DOMException("rendering context was lost", "AbortError");
}

function contextFailureAbort(): DOMException {
  return new DOMException("rendering context recovery failed", "AbortError");
}

function supersededAbort(): DOMException {
  return new DOMException("context restoration was superseded", "AbortError");
}

function disposedAbort(): DOMException {
  return new DOMException("context recovery was disposed", "AbortError");
}
