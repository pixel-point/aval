import {
  RuntimePlaybackError,
  normalizeRuntimeFailure,
  type RuntimeFailureCode
} from "./errors.js";

export const DEFAULT_LOAD_OVERALL_TIMEOUT_MS = 5_000 as const;
export const DEFAULT_FIRST_BYTE_TIMEOUT_MS = 2_000 as const;
export const DEFAULT_IDLE_BODY_TIMEOUT_MS = 2_000 as const;

export type LoadWatchdogPhase = "overall" | "first-byte" | "idle-body";

export interface LoadWatchdogTimerHost {
  now(): number;
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface LoadWatchdogOptions {
  readonly signals?: readonly AbortSignal[];
  readonly timers?: LoadWatchdogTimerHost;
  /** Shared absolute operation authority; this request does not re-arm it. */
  readonly overallDeadline?: RuntimeLoadOperationDeadline;
  /**
   * Aggregate bounded-interest signal owned by a higher-level shared load.
   * It suppresses a request-local overall timer without transferring ownership.
   */
  readonly overallSignal?: AbortSignal;
  readonly overallTimeoutMs?: number;
  readonly firstByteTimeoutMs?: number;
  readonly idleBodyTimeoutMs?: number;
}

export interface LoadOperationDeadlineOptions {
  readonly signals?: readonly AbortSignal[];
  readonly timers?: LoadWatchdogTimerHost;
  readonly timeoutMs?: number;
}

export interface LoadOperationDeadlineSnapshot {
  readonly active: boolean;
  readonly deadlineMs: number | null;
  readonly terminalCode: RuntimeFailureCode | null;
  readonly pendingTimerCount: number;
  readonly linkedAbortListenerCount: number;
  readonly pendingWaitCount: number;
}

export interface LoadWatchdogSnapshot {
  readonly active: boolean;
  readonly headersReceived: boolean;
  readonly acceptedBodyBytes: number;
  readonly overallDeadlineMs: number | null;
  readonly firstByteDeadlineMs: number | null;
  readonly idleBodyDeadlineMs: number | null;
  readonly expiredPhase: LoadWatchdogPhase | null;
  readonly terminalCode: RuntimeFailureCode | null;
  readonly pendingTimerCount: number;
  readonly linkedAbortListenerCount: number;
  readonly pendingWaitCount: number;
}

interface CapturedTimerHost {
  readonly now: () => number;
  readonly setTimeout: (callback: () => void, milliseconds: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
}

interface TimerRecord {
  readonly phase: LoadWatchdogPhase;
  handle: unknown;
  armed: boolean;
}

interface AbortLink {
  readonly signal: AbortSignal;
  readonly listener: () => void;
}

interface PendingWait {
  active: boolean;
  readonly reject: (error: unknown) => void;
}

const DEFAULT_TIMER_HOST: Readonly<LoadWatchdogTimerHost> = Object.freeze({
  now(): number {
    return globalThis.performance?.now() ?? Date.now();
  },
  setTimeout(callback: () => void, milliseconds: number): unknown {
    return globalThis.setTimeout(callback, milliseconds);
  },
  clearTimeout(handle: unknown): void {
    Reflect.apply(globalThis.clearTimeout, globalThis, [handle]);
  }
});

/** One absolute caller-operation deadline shared by every owned async phase. */
export class RuntimeLoadOperationDeadline {
  readonly #timers: CapturedTimerHost;
  readonly #controller = new AbortController();
  readonly #abortLinks: AbortLink[] = [];
  readonly #pendingWaits = new Set<PendingWait>();

  #active = true;
  #deadlineMs: number | null = null;
  #terminalCause: unknown = null;
  #timerHandle: unknown;
  #timerArmed = false;
  #lastNow = -1;

  public constructor(options: Readonly<LoadOperationDeadlineOptions> = {}) {
    if (typeof options !== "object" || options === null) {
      throw new TypeError("load operation deadline options must be an object");
    }
    const timeoutMs = positiveTimeout(
      options.timeoutMs ?? DEFAULT_LOAD_OVERALL_TIMEOUT_MS,
      "overall load timeout"
    );
    this.#timers = captureTimerHost(options.timers ?? DEFAULT_TIMER_HOST);
    const signals = captureSignals(options.signals ?? []);
    if (signals.some((signal) => signal.aborted)) {
      this.#terminate(abortError());
      return;
    }

    try {
      for (const signal of signals) this.#linkAbortSignal(signal);
      const now = this.#monotonicNow();
      const deadline = now + timeoutMs;
      if (!Number.isFinite(deadline) || deadline > Number.MAX_SAFE_INTEGER) {
        throw new TypeError("load operation deadline exceeds safe range");
      }
      this.#deadlineMs = deadline;
      this.#timerArmed = true;
      const handle = this.#timers.setTimeout(() => {
        this.#expire();
      }, timeoutMs);
      this.#timerHandle = handle;
      if (!this.#timerArmed) this.#safeClearTimeout(handle);
    } catch (cause) {
      this.#terminate(runtimeError("load-failure"));
      if (cause instanceof RuntimePlaybackError) throw cause;
      throw runtimeError("load-failure");
    }
  }

  public get signal(): AbortSignal { return this.#controller.signal; }
  public get deadlineMs(): number | null { return this.#deadlineMs; }
  public get terminalCause(): unknown { return this.#terminalCause; }

  public assertActive(): void {
    if (!this.#active) throw this.#terminalCause ?? abortError();
    const deadline = this.#deadlineMs;
    let now: number;
    try { now = this.#monotonicNow(); } catch {
      const failure = runtimeError("load-failure");
      this.#terminate(failure);
      throw failure;
    }
    if (deadline !== null && now >= deadline) {
      this.#expire();
      throw this.#terminalCause ?? overallTimeoutError();
    }
  }

  public watch<Value>(operation: PromiseLike<Value>): Promise<Value> {
    const pending = Promise.resolve(operation);
    try {
      this.assertActive();
    } catch (cause) {
      void pending.catch(() => {});
      return Promise.reject(cause);
    }
    return new Promise<Value>((resolve, reject) => {
      const wait: PendingWait = { active: true, reject };
      this.#pendingWaits.add(wait);
      pending.then(
        (value) => {
          if (!wait.active) return;
          wait.active = false;
          this.#pendingWaits.delete(wait);
          resolve(value);
        },
        (cause: unknown) => {
          if (!wait.active) return;
          wait.active = false;
          this.#pendingWaits.delete(wait);
          reject(cause);
        }
      );
    });
  }

  public complete(): void {
    if (!this.#active) return;
    this.#active = false;
    this.#clearTimer();
    this.#removeAbortLinks();
    this.#settleWaits(abortError());
  }

  /** Abort an incompletely constructed owner operation and every linked wait. */
  public cancel(): void { this.#terminate(abortError()); }

  public snapshot(): Readonly<LoadOperationDeadlineSnapshot> {
    return Object.freeze({
      active: this.#active,
      deadlineMs: this.#deadlineMs,
      terminalCode: terminalCode(this.#terminalCause),
      pendingTimerCount: this.#timerArmed ? 1 : 0,
      linkedAbortListenerCount: this.#abortLinks.length,
      pendingWaitCount: this.#pendingWaits.size
    });
  }

  #linkAbortSignal(signal: AbortSignal): void {
    const listener = (): void => { this.#terminate(abortError()); };
    // Publish cleanup authority before registration because a hostile event
    // host may retain the listener and still throw from addEventListener().
    this.#abortLinks.push(Object.freeze({ signal, listener }));
    signal.addEventListener("abort", listener, { once: true });
    if (signal.aborted) listener();
  }

  #expire(): void {
    if (!this.#active) return;
    this.#terminate(overallTimeoutError());
  }

  #terminate(cause: unknown): void {
    if (!this.#active) return;
    this.#active = false;
    this.#terminalCause = cause;
    this.#clearTimer();
    this.#removeAbortLinks();
    this.#settleWaits(cause);
    try { this.#controller.abort(cause); } catch {
      try { this.#controller.abort(); } catch {}
    }
  }

  #settleWaits(cause: unknown): void {
    for (const wait of this.#pendingWaits) {
      if (!wait.active) continue;
      wait.active = false;
      wait.reject(cause);
    }
    this.#pendingWaits.clear();
  }

  #clearTimer(): void {
    const handle = this.#timerHandle;
    this.#timerHandle = undefined;
    const armed = this.#timerArmed;
    this.#timerArmed = false;
    this.#deadlineMs = null;
    if (armed && handle !== undefined) this.#safeClearTimeout(handle);
  }

  #safeClearTimeout(handle: unknown): void {
    try { this.#timers.clearTimeout(handle); } catch {}
  }

  #removeAbortLinks(): void {
    for (const link of this.#abortLinks.splice(0)) {
      try { link.signal.removeEventListener("abort", link.listener); } catch {}
    }
  }

  #monotonicNow(): number {
    const now = this.#timers.now();
    if (
      !Number.isFinite(now) || now < 0 || now > Number.MAX_SAFE_INTEGER ||
      now < this.#lastNow
    ) {
      throw new TypeError("load watchdog clock must be finite and monotonic");
    }
    this.#lastNow = now;
    return now;
  }
}

/**
 * One request-scoped deadline owner. It is also the sole abort bridge supplied
 * to Fetch, so upstream abort and watchdog expiry cannot leave a request live.
 */
export class RuntimeLoadWatchdogs {
  readonly #timers: CapturedTimerHost;
  readonly #overallTimeoutMs: number;
  readonly #firstByteTimeoutMs: number;
  readonly #idleBodyTimeoutMs: number;
  readonly #controller = new AbortController();
  readonly #timerRecords = new Map<LoadWatchdogPhase, TimerRecord>();
  readonly #abortLinks: AbortLink[] = [];
  readonly #pendingWaits = new Set<PendingWait>();

  #active = true;
  #headersReceived = false;
  #acceptedBodyBytes = 0;
  #overallDeadlineMs: number | null = null;
  #firstByteDeadlineMs: number | null = null;
  #idleBodyDeadlineMs: number | null = null;
  #expiredPhase: LoadWatchdogPhase | null = null;
  #terminalError: RuntimePlaybackError | null = null;
  #lastNow = -1;

  public constructor(options: Readonly<LoadWatchdogOptions> = {}) {
    if (typeof options !== "object" || options === null) {
      throw new TypeError("load watchdog options must be an object");
    }
    const overallDeadline = captureOverallDeadline(options.overallDeadline);
    const overallSignal = captureOptionalSignal(options.overallSignal);
    if (overallDeadline !== null && overallSignal !== null) {
      throw new TypeError("load watchdog overall authority is duplicated");
    }
    this.#overallTimeoutMs = positiveTimeout(
      options.overallTimeoutMs ?? DEFAULT_LOAD_OVERALL_TIMEOUT_MS,
      "overall load timeout"
    );
    this.#firstByteTimeoutMs = positiveTimeout(
      options.firstByteTimeoutMs ?? DEFAULT_FIRST_BYTE_TIMEOUT_MS,
      "first-byte load timeout"
    );
    this.#idleBodyTimeoutMs = positiveTimeout(
      options.idleBodyTimeoutMs ?? DEFAULT_IDLE_BODY_TIMEOUT_MS,
      "idle-body load timeout"
    );
    this.#timers = captureTimerHost(options.timers ?? DEFAULT_TIMER_HOST);

    const signals = captureSignals(options.signals ?? []).filter((signal) =>
      signal !== overallDeadline?.signal && signal !== overallSignal
    );
    if (overallDeadline?.signal.aborted === true) {
      const cause = overallDeadline.terminalCause;
      const timeout = isOverallTimeout(cause);
      this.#terminate(
        timeout ? cause : runtimeError("abort"),
        timeout ? "overall" : null
      );
      return;
    }
    if (overallSignal?.aborted === true || signals.some((signal) => signal.aborted)) {
      this.#terminate(runtimeError("abort"), null);
      return;
    }

    try {
      for (const signal of signals) this.#linkAbortSignal(signal);
      if (overallDeadline !== null) {
        this.#overallDeadlineMs = overallDeadline.deadlineMs;
        this.#linkOverallDeadline(overallDeadline);
      } else if (overallSignal !== null) {
        this.#linkAbortSignal(overallSignal);
      } else {
        this.#arm("overall", this.#overallTimeoutMs);
      }
      if (this.#active) this.#arm("first-byte", this.#firstByteTimeoutMs);
    } catch (cause) {
      this.#terminate(runtimeError("load-failure"), null);
      if (cause instanceof RuntimePlaybackError) throw cause;
      throw runtimeError("load-failure");
    }
  }

  public get signal(): AbortSignal {
    return this.#controller.signal;
  }

  /** Record response-header arrival without weakening the first-byte limit. */
  public noteHeadersReceived(): void {
    if (!this.#active) return;
    this.#headersReceived = true;
  }

  /** Empty chunks are deliberately ignored and cannot reset body liveness. */
  public noteBodyProgress(byteLength: number): void {
    requireNonNegativeSafeInteger(byteLength, "accepted body progress");
    if (!this.#active || byteLength === 0) return;
    const next = this.#acceptedBodyBytes + byteLength;
    if (!Number.isSafeInteger(next)) {
      throw new RangeError("accepted body progress exceeds safe integer range");
    }
    this.#acceptedBodyBytes = next;
    this.#clearTimer("first-byte");
    this.#firstByteDeadlineMs = null;
    this.#clearTimer("idle-body");
    this.#arm("idle-body", this.#idleBodyTimeoutMs);
  }

  /** Race one asynchronous boundary without retaining a settled waiter. */
  public watch<Value>(operation: PromiseLike<Value>): Promise<Value> {
    if (this.#terminalError !== null) {
      void Promise.resolve(operation).catch(() => {});
      return Promise.reject(this.#terminalError);
    }
    if (!this.#active) {
      void Promise.resolve(operation).catch(() => {});
      return Promise.reject(runtimeError("abort"));
    }

    return new Promise<Value>((resolve, reject) => {
      const wait: PendingWait = {
        active: true,
        reject
      };
      this.#pendingWaits.add(wait);
      Promise.resolve(operation).then(
        (value) => {
          if (!wait.active) return;
          wait.active = false;
          this.#pendingWaits.delete(wait);
          resolve(value);
        },
        (cause: unknown) => {
          if (!wait.active) return;
          wait.active = false;
          this.#pendingWaits.delete(wait);
          reject(cause);
        }
      );
    });
  }

  /** Clear every timer/listener after request success or owned failure. */
  public complete(): void {
    if (!this.#active) return;
    this.#active = false;
    this.#clearAllTimers();
    this.#removeAbortLinks();
    const error = runtimeError("abort");
    for (const wait of this.#pendingWaits) {
      if (!wait.active) continue;
      wait.active = false;
      wait.reject(error);
    }
    this.#pendingWaits.clear();
  }

  public snapshot(): Readonly<LoadWatchdogSnapshot> {
    return Object.freeze({
      active: this.#active,
      headersReceived: this.#headersReceived,
      acceptedBodyBytes: this.#acceptedBodyBytes,
      overallDeadlineMs: this.#overallDeadlineMs,
      firstByteDeadlineMs: this.#firstByteDeadlineMs,
      idleBodyDeadlineMs: this.#idleBodyDeadlineMs,
      expiredPhase: this.#expiredPhase,
      terminalCode: this.#terminalError?.code ?? null,
      pendingTimerCount: this.#timerRecords.size,
      linkedAbortListenerCount: this.#abortLinks.length,
      pendingWaitCount: this.#pendingWaits.size
    });
  }

  #linkAbortSignal(signal: AbortSignal): void {
    const listener = (): void => {
      this.#terminate(runtimeError("abort"), null);
    };
    this.#abortLinks.push(Object.freeze({ signal, listener }));
    signal.addEventListener("abort", listener, { once: true });
    if (signal.aborted) listener();
  }

  #linkOverallDeadline(deadline: RuntimeLoadOperationDeadline): void {
    const signal = deadline.signal;
    const listener = (): void => {
      const cause = deadline.terminalCause;
      const timeout = isOverallTimeout(cause);
      this.#terminate(
        timeout ? cause : runtimeError("abort"),
        timeout ? "overall" : null
      );
    };
    this.#abortLinks.push(Object.freeze({ signal, listener }));
    signal.addEventListener("abort", listener, { once: true });
    if (signal.aborted) listener();
  }

  #arm(phase: LoadWatchdogPhase, timeoutMs: number): void {
    if (!this.#active) return;
    const now = this.#monotonicNow();
    const deadline = now + timeoutMs;
    if (!Number.isFinite(deadline) || deadline > Number.MAX_SAFE_INTEGER) {
      throw new TypeError("load watchdog deadline exceeds safe range");
    }
    this.#setDeadline(phase, deadline);
    const record: TimerRecord = {
      phase,
      handle: undefined,
      armed: true
    };
    this.#timerRecords.set(phase, record);
    try {
      const handle = this.#timers.setTimeout(() => {
        this.#expire(record);
      }, timeoutMs);
      record.handle = handle;
      if (!record.armed) this.#safeClearTimeout(handle);
    } catch (cause) {
      record.armed = false;
      this.#timerRecords.delete(phase);
      this.#setDeadline(phase, null);
      throw cause;
    }
  }

  #expire(record: TimerRecord): void {
    if (
      !this.#active ||
      !record.armed ||
      this.#timerRecords.get(record.phase) !== record
    ) {
      return;
    }
    record.armed = false;
    this.#timerRecords.delete(record.phase);
    this.#setDeadline(record.phase, null);
    this.#terminate(runtimeError("watchdog-timeout", record.phase), record.phase);
  }

  #terminate(
    error: RuntimePlaybackError,
    expiredPhase: LoadWatchdogPhase | null
  ): void {
    if (!this.#active) return;
    this.#active = false;
    this.#terminalError = error;
    this.#expiredPhase = expiredPhase;
    this.#clearAllTimers();
    this.#removeAbortLinks();
    try {
      this.#controller.abort();
    } catch {
      // The terminal error and waiter cleanup remain authoritative.
    }
    for (const wait of this.#pendingWaits) {
      if (!wait.active) continue;
      wait.active = false;
      wait.reject(error);
    }
    this.#pendingWaits.clear();
  }

  #clearAllTimers(): void {
    for (const phase of [...this.#timerRecords.keys()]) {
      this.#clearTimer(phase);
    }
    this.#overallDeadlineMs = null;
    this.#firstByteDeadlineMs = null;
    this.#idleBodyDeadlineMs = null;
  }

  #clearTimer(phase: LoadWatchdogPhase): void {
    const record = this.#timerRecords.get(phase);
    if (record === undefined) return;
    this.#timerRecords.delete(phase);
    record.armed = false;
    if (record.handle !== undefined) this.#safeClearTimeout(record.handle);
    this.#setDeadline(phase, null);
  }

  #safeClearTimeout(handle: unknown): void {
    try {
      this.#timers.clearTimeout(handle);
    } catch {
      // A hostile timer host cannot prevent local ownership retirement.
    }
  }

  #removeAbortLinks(): void {
    for (const link of this.#abortLinks.splice(0)) {
      try {
        link.signal.removeEventListener("abort", link.listener);
      } catch {
        // Continue retiring all other links.
      }
    }
  }

  #monotonicNow(): number {
    const now = this.#timers.now();
    if (
      !Number.isFinite(now) ||
      now < 0 ||
      now > Number.MAX_SAFE_INTEGER ||
      now < this.#lastNow
    ) {
      throw new TypeError("load watchdog clock must be finite and monotonic");
    }
    this.#lastNow = now;
    return now;
  }

  #setDeadline(phase: LoadWatchdogPhase, value: number | null): void {
    if (phase === "overall") this.#overallDeadlineMs = value;
    else if (phase === "first-byte") this.#firstByteDeadlineMs = value;
    else this.#idleBodyDeadlineMs = value;
  }
}

export function createLoadWatchdogs(
  options: Readonly<LoadWatchdogOptions> = {}
): RuntimeLoadWatchdogs {
  return new RuntimeLoadWatchdogs(options);
}

export function createLoadOperationDeadline(
  options: Readonly<LoadOperationDeadlineOptions> = {}
): RuntimeLoadOperationDeadline {
  return new RuntimeLoadOperationDeadline(options);
}

function captureTimerHost(value: LoadWatchdogTimerHost): CapturedTimerHost {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("load watchdog timer host must be an object");
  }
  let now: unknown;
  let setTimeoutMethod: unknown;
  let clearTimeoutMethod: unknown;
  try {
    now = Reflect.get(value, "now");
    setTimeoutMethod = Reflect.get(value, "setTimeout");
    clearTimeoutMethod = Reflect.get(value, "clearTimeout");
  } catch {
    throw new TypeError("load watchdog timer capabilities are inaccessible");
  }
  if (
    typeof now !== "function" ||
    typeof setTimeoutMethod !== "function" ||
    typeof clearTimeoutMethod !== "function"
  ) {
    throw new TypeError("load watchdog timer host is malformed");
  }
  return Object.freeze({
    now: () => Reflect.apply(now, value, []) as number,
    setTimeout: (callback: () => void, milliseconds: number) =>
      Reflect.apply(setTimeoutMethod, value, [callback, milliseconds]),
    clearTimeout: (handle: unknown) => {
      Reflect.apply(clearTimeoutMethod, value, [handle]);
    }
  });
}

function captureSignals(values: readonly AbortSignal[]): readonly AbortSignal[] {
  if (!Array.isArray(values)) {
    throw new TypeError("load watchdog signals must be an array");
  }
  const unique = new Set<AbortSignal>();
  for (const signal of values) {
    if (!(signal instanceof AbortSignal)) {
      throw new TypeError("load watchdog signal must be an AbortSignal");
    }
    unique.add(signal);
  }
  return Object.freeze([...unique]);
}

function positiveTimeout(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function captureOverallDeadline(
  value: RuntimeLoadOperationDeadline | undefined
): RuntimeLoadOperationDeadline | null {
  if (value === undefined) return null;
  if (!(value instanceof RuntimeLoadOperationDeadline)) {
    throw new TypeError("load operation deadline is invalid");
  }
  return value;
}

function captureOptionalSignal(value: AbortSignal | undefined): AbortSignal | null {
  if (value === undefined) return null;
  if (!(value instanceof AbortSignal)) {
    throw new TypeError("load watchdog overall signal must be an AbortSignal");
  }
  return value;
}

function overallTimeoutError(): RuntimePlaybackError {
  return runtimeError("watchdog-timeout", "overall");
}

function isOverallTimeout(value: unknown): value is RuntimePlaybackError {
  return value instanceof RuntimePlaybackError &&
    value.code === "watchdog-timeout" &&
    value.failure.context.policyPhase === "overall";
}

function terminalCode(value: unknown): RuntimeFailureCode | null {
  if (value instanceof RuntimePlaybackError) return value.code;
  return value instanceof DOMException && value.name === "AbortError"
    ? "abort"
    : null;
}

function abortError(): DOMException {
  return new DOMException("runtime load operation was aborted", "AbortError");
}

function requireNonNegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
}

function runtimeError(
  code: "load-failure" | "watchdog-timeout" | "abort",
  phase: LoadWatchdogPhase | null = null
): RuntimePlaybackError {
  return new RuntimePlaybackError(normalizeRuntimeFailure(
    code,
    undefined,
    phase === null ? {} : { policyPhase: phase }
  ));
}
