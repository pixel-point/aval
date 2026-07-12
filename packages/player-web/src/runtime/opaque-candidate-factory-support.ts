import type {
  GraphPresentation,
  MotionGraphResult
} from "@rendered-motion/graph";

import type {
  IntegratedPlaybackSession,
  IntegratedPlaybackTickContext,
  IntegratedPlaybackTraceState,
  IntegratedPreparedContentTick
} from "./integrated-player-contracts.js";
import type {
  OpaqueCandidateFactoryOptions,
  OpaqueCandidateTimerHost
} from "./opaque-candidate-factory-model.js";
import type { PathSchedulerClock } from "./path-scheduler.js";

const MAX_TIMER_DELAY_MS = 2_147_483_647;

export const DEFAULT_OPAQUE_CANDIDATE_CLOCK: PathSchedulerClock = Object.freeze({
  now: (): number => typeof performance === "undefined"
    ? Date.now()
    : performance.now()
});

export const DEFAULT_OPAQUE_CANDIDATE_TIMERS: OpaqueCandidateTimerHost =
  Object.freeze({
    setTimeout(callback: () => void, milliseconds: number): unknown {
      return globalThis.setTimeout(callback, milliseconds);
    },
    clearTimeout(handle: unknown): void {
      globalThis.clearTimeout(handle as number);
    }
  });

/** Stable public playback identity that binds only after activation precommit. */
export class DeferredOpaquePlaybackSession
  implements IntegratedPlaybackSession {
  #session: IntegratedPlaybackSession | null = null;
  #disposed = false;

  public bind(session: IntegratedPlaybackSession): void {
    if (this.#disposed) {
      throw new Error("candidate playback delegate is disposed");
    }
    if (this.#session !== null) {
      throw new Error("candidate playback delegate was already bound");
    }
    validatePlaybackSession(session);
    this.#session = session;
  }

  public prepareContentTick(
    context: Readonly<IntegratedPlaybackTickContext>
  ): Readonly<IntegratedPreparedContentTick> | null {
    return this.#requireSession().prepareContentTick(context);
  }

  public drawContentTick(
    prepared: Readonly<IntegratedPreparedContentTick>,
    presentation: Readonly<GraphPresentation>
  ): string | null {
    return this.#requireSession().drawContentTick(prepared, presentation);
  }

  public synchronizeGraph(result: Readonly<MotionGraphResult>): void {
    this.#requireSession().synchronizeGraph(result);
  }

  public traceState(): Readonly<IntegratedPlaybackTraceState> {
    return this.#requireSession().traceState();
  }

  public dispose(): void {
    this.#disposed = true;
    this.#session = null;
  }

  #requireSession(): IntegratedPlaybackSession {
    if (this.#disposed) {
      throw new Error("candidate playback delegate is disposed");
    }
    if (this.#session === null) {
      throw new Error("candidate playback is not activated");
    }
    return this.#session;
  }
}

export class OpaqueCandidateOperationControl {
  readonly #clock: PathSchedulerClock;
  readonly #deadlineMs: number;
  readonly #timers: OpaqueCandidateTimerHost;
  readonly #controller = new AbortController();
  readonly #removeListeners: Array<() => void> = [];
  #timer: unknown = null;
  #disposed = false;

  public constructor(options: {
    readonly signal: AbortSignal;
    readonly lifecycleSignal: AbortSignal;
    readonly deadlineMs: number;
    readonly clock: PathSchedulerClock;
    readonly timers: OpaqueCandidateTimerHost;
  }) {
    validateDeadline(options.deadlineMs);
    this.#clock = options.clock;
    this.#deadlineMs = options.deadlineMs;
    this.#timers = options.timers;
    this.#link(options.signal);
    this.#link(options.lifecycleSignal);
    if (!this.#controller.signal.aborted) this.#armDeadline();
  }

  public get signal(): AbortSignal {
    return this.#controller.signal;
  }

  public get deadlineMs(): number {
    return this.#deadlineMs;
  }

  public remainingMs(): number {
    this.throwIfStopped();
    const remaining = this.#deadlineMs - checkedNow(this.#clock);
    if (remaining <= 0) {
      this.#expire();
      this.throwIfStopped();
    }
    return remaining;
  }

  public throwIfStopped(): void {
    if (this.#controller.signal.aborted) {
      throw abortReason(this.#controller.signal);
    }
    if (checkedNow(this.#clock) >= this.#deadlineMs) {
      this.#expire();
      throw abortReason(this.#controller.signal);
    }
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    const timer = this.#timer;
    this.#timer = null;
    for (const remove of this.#removeListeners.splice(0)) {
      try {
        remove();
      } catch {
        // Listener cleanup must continue across hostile host objects.
      }
    }
    if (timer !== null) {
      try {
        this.#timers.clearTimeout(timer);
      } catch {
        // Cleanup cannot replace the candidate operation's result.
      }
    }
  }

  #link(source: AbortSignal): void {
    if (source.aborted) {
      this.#abort(abortReason(source));
      return;
    }
    const listener = (): void => this.#abort(abortReason(source));
    source.addEventListener("abort", listener, { once: true });
    this.#removeListeners.push(() => {
      source.removeEventListener("abort", listener);
    });
  }

  #armDeadline(): void {
    const remaining = this.#deadlineMs - checkedNow(this.#clock);
    if (remaining <= 0) {
      this.#expire();
      return;
    }
    this.#timer = this.#timers.setTimeout(
      () => {
        this.#timer = null;
        if (checkedNow(this.#clock) >= this.#deadlineMs) {
          this.#expire();
        } else {
          this.#armDeadline();
        }
      },
      Math.min(remaining, MAX_TIMER_DELAY_MS)
    );
  }

  #expire(): void {
    this.#abort(new DOMException(
      "opaque candidate preparation deadline expired",
      "TimeoutError"
    ));
  }

  #abort(reason: DOMException): void {
    if (!this.#controller.signal.aborted) this.#controller.abort(reason);
  }
}

export async function raceOpaqueCandidateOperation<T>(
  operation: PromiseLike<T> | T,
  signal: AbortSignal
): Promise<T> {
  if (signal.aborted) throw abortReason(signal);
  const pending = Promise.resolve(operation);
  // A loser may settle after its resource was disposed. Always observe it.
  void pending.catch(() => undefined);
  let remove = (): void => undefined;
  const stopped = new Promise<never>((_resolve, reject) => {
    const listener = (): void => reject(abortReason(signal));
    signal.addEventListener("abort", listener, { once: true });
    remove = () => signal.removeEventListener("abort", listener);
  });
  try {
    return await Promise.race([pending, stopped]);
  } finally {
    remove();
  }
}

export function validateOpaqueCandidateFactoryOptions(
  options: Readonly<OpaqueCandidateFactoryOptions>
): void {
  if (options === null || typeof options !== "object") {
    throw new TypeError("opaque candidate factory options must be an object");
  }
  validateFactory(options.workerFactory, "worker");
  validateFactory(options.rendererFactory, "renderer");
  if (
    options.readinessFactory === null ||
    typeof options.readinessFactory !== "object" ||
    typeof options.readinessFactory.create !== "function"
  ) {
    throw new TypeError("opaque candidate readiness factory is malformed");
  }
  if (options.clock !== undefined) checkedNow(options.clock);
  if (
    options.timers !== undefined &&
    (
      options.timers === null ||
      typeof options.timers !== "object" ||
      typeof options.timers.setTimeout !== "function" ||
      typeof options.timers.clearTimeout !== "function"
    )
  ) {
    throw new TypeError("opaque candidate timer host is malformed");
  }
  if (
    options.prepareCache !== undefined &&
    typeof options.prepareCache !== "function"
  ) {
    throw new TypeError("opaque candidate cache preparer must be a function");
  }
}

export function abortReason(signal: AbortSignal): DOMException {
  return signal.reason instanceof DOMException
    ? signal.reason
    : new DOMException("opaque candidate operation aborted", "AbortError");
}

function validateFactory(
  factory: { readonly available: boolean; readonly create: unknown },
  label: string
): void {
  if (
    factory === null ||
    typeof factory !== "object" ||
    typeof factory.available !== "boolean" ||
    typeof factory.create !== "function"
  ) {
    throw new TypeError(`opaque candidate ${label} factory is malformed`);
  }
}

function validatePlaybackSession(session: IntegratedPlaybackSession): void {
  if (
    session === null ||
    typeof session !== "object" ||
    typeof session.prepareContentTick !== "function" ||
    typeof session.drawContentTick !== "function" ||
    typeof session.synchronizeGraph !== "function" ||
    typeof session.traceState !== "function"
  ) {
    throw new TypeError("prepared opaque playback session is malformed");
  }
}

function validateDeadline(value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
    throw new RangeError("opaque candidate deadline must be finite and safe");
  }
}

function checkedNow(clock: PathSchedulerClock): number {
  const value = clock.now();
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError("opaque candidate clock must be finite and non-negative");
  }
  return value;
}
