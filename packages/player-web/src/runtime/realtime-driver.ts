import {
  timestampForFrame,
  validateFrameRate,
  type RationalFrameRate
} from "./rational-time.js";

/** Half of the integer-microsecond rounding quantum used by the rational clock. */
const CONTENT_DEADLINE_EPSILON_MS = 0.0005;

export type RealtimeContentTickResult =
  | { readonly status: "advanced" }
  | { readonly status: "underflow" }
  | { readonly status: "stopped" };

export interface RealtimeContentTickContext {
  /** Frame zero was installed by preparation; realtime advancement begins at one. */
  readonly presentationOrdinal: bigint;
  readonly deadlineMs: number;
  readonly opportunityTimeMs: number;
  /** Actual host-clock read at entry to the eligible callback, not the RAF timestamp argument. */
  readonly callbackStartMs: number;
  /** Null for manual tickOnce(); only scheduled RAF callbacks have an ordinal. */
  readonly eligibleAnimationFrameOrdinal: number | null;
  readonly manual: boolean;
}

export interface RealtimeUnderflowEvent {
  readonly presentationOrdinal: bigint;
  readonly deadlineMs: number;
  readonly opportunityTimeMs: number;
}

export interface RealtimeTickOutcome {
  readonly status: "advanced" | "underflow" | "stopped" | "not-due";
  readonly presentationOrdinal: bigint;
}

export interface RealtimeDriverSnapshot {
  readonly running: boolean;
  readonly disposed: boolean;
  readonly nextPresentationOrdinal: bigint;
  readonly nextDeadlineMs: number | null;
  readonly displayCallbacks: number;
  readonly advancedTicks: number;
  readonly underflows: number;
  readonly smoothSession: boolean;
}

export interface RealtimeDriverOptions {
  readonly frameRate: Readonly<RationalFrameRate>;
  readonly requestFrame: (callback: FrameRequestCallback) => number;
  readonly cancelFrame: (handle: number) => void;
  readonly now: () => number;
  readonly tryContentTick: (
    context: Readonly<RealtimeContentTickContext>
  ) => RealtimeContentTickResult;
  readonly onUnderflow?: (
    event: Readonly<RealtimeUnderflowEvent>
  ) => void;
}

/** Terminal lifecycle error kept separate from media underflow. */
export class RealtimeDriverDisposedError extends Error {
  public constructor() {
    super("realtime driver is disposed");
    this.name = "RealtimeDriverDisposedError";
  }
}

interface RealtimeFrameRequestToken {
  invalidated: boolean;
  synchronousCallback: boolean;
}

interface RealtimePendingFrame {
  readonly handle: number;
  readonly token: RealtimeFrameRequestToken;
}

interface RealtimeClockInitializationToken {
  reentered: boolean;
}

interface RealtimeContentTickToken {
  reentered: boolean;
}

/**
 * Converts display opportunities into at most one rational content tick.
 * It never advances semantic state itself: the injected tick path first proves
 * the exact media handle and returns `underflow` without ticking the graph.
 */
export class RealtimeDriver {
  readonly #frameRate: Readonly<RationalFrameRate>;
  readonly #frameDurationMs: number;
  readonly #requestFrame: (callback: FrameRequestCallback) => number;
  readonly #cancelFrame: (handle: number) => void;
  readonly #now: () => number;
  readonly #tryContentTick: RealtimeDriverOptions["tryContentTick"];
  readonly #onUnderflow: RealtimeDriverOptions["onUnderflow"];

  #initialized = false;
  #running = false;
  #disposed = false;
  #originMs = 0;
  #nextPresentationOrdinal = 1n;
  #nextDeadlineMs: number | null = null;
  #pendingFrame: RealtimePendingFrame | null = null;
  #frameRequestInFlight: RealtimeFrameRequestToken | null = null;
  #frameCancellationInFlight = false;
  #clockInitializationInFlight: RealtimeClockInitializationToken | null = null;
  #contentTickInFlight: RealtimeContentTickToken | null = null;
  #lifecycleGeneration = 0n;
  #lastDisplayCallbackMs: number | null = null;
  #underflowReportedFor: bigint | null = null;
  #displayCallbacks = 0;
  #advancedTicks = 0;
  #underflows = 0;
  #smoothSession = true;

  public constructor(options: RealtimeDriverOptions) {
    validateOptions(options);
    validateFrameRate(options.frameRate);
    this.#frameRate = Object.freeze({
      numerator: options.frameRate.numerator,
      denominator: options.frameRate.denominator
    });
    this.#frameDurationMs = timestampForFrame(1n, this.#frameRate) / 1_000;
    this.#requestFrame = options.requestFrame;
    this.#cancelFrame = options.cancelFrame;
    this.#now = options.now;
    this.#tryContentTick = options.tryContentTick;
    this.#onUnderflow = options.onUnderflow;
  }

  public start(): void {
    this.#assertUsable();
    this.#assertContentTickIdle();
    this.#assertFrameHostIdle();
    this.#assertClockHostIdle();
    if (this.#running) return;
    this.#ensureClockInitialized();
    this.#running = true;
    try {
      this.#scheduleFrame();
    } catch (error) {
      this.#running = false;
      this.#invalidateFrameOwnership();
      throw error;
    }
  }

  /** Deterministic proof adapter over the same single-tick attempt. */
  public tickOnce(): Readonly<RealtimeTickOutcome> {
    this.#assertUsable();
    this.#assertContentTickIdle();
    this.#assertFrameHostIdle();
    this.#assertClockHostIdle();
    if (this.#running) {
      throw new RangeError(
        "manual tick is unavailable while the realtime driver is running"
      );
    }
    this.#ensureClockInitialized();
    return this.#attemptContentTick(this.#nextDeadlineMs!, true);
  }

  public snapshot(): Readonly<RealtimeDriverSnapshot> {
    return Object.freeze({
      running: this.#running,
      disposed: this.#disposed,
      nextPresentationOrdinal: this.#nextPresentationOrdinal,
      nextDeadlineMs: this.#nextDeadlineMs,
      displayCallbacks: this.#displayCallbacks,
      advancedTicks: this.#advancedTicks,
      underflows: this.#underflows,
      smoothSession: this.#smoothSession
    });
  }

  /**
   * Suspends display ownership while reduced-motion state is
   * prepared. Unlike failure stop, this preserves the smoothness claim and
   * permits start() to resume the same candidate if policy flips precommit.
   */
  public pauseForPolicy(): void {
    this.#assertUsable();
    this.#running = false;
    this.#advanceLifecycleGeneration();
    this.#invalidateFrameOwnership();
  }

  /** Visibility suspension preserves the exact authored presentation ordinal. */
  public pauseForVisibility(): void {
    this.pauseForPolicy();
  }

  /**
   * Drops hidden wall time and optionally resumes the previously-running RAF
   * owner. The next authored frame remains one normal frame in the future.
   */
  public resumeAfterVisibility(wasRunning: boolean): void {
    this.#assertUsable();
    this.#assertContentTickIdle();
    this.#assertFrameHostIdle();
    this.#assertClockHostIdle();
    if (typeof wasRunning !== "boolean") {
      throw new TypeError("visibility resume running state must be a boolean");
    }
    if (this.#initialized) {
      const token: RealtimeClockInitializationToken = { reentered: false };
      const expectedGeneration = this.#lifecycleGeneration;
      this.#clockInitializationInFlight = token;
      let resumeMs: number;
      try {
        resumeMs = this.#now();
      } finally {
        if (this.#clockInitializationInFlight === token) {
          this.#clockInitializationInFlight = null;
        }
      }
      if (token.reentered) {
        throw new RangeError("realtime visibility resume reentered synchronously");
      }
      if (this.#disposed) throw new RealtimeDriverDisposedError();
      if (this.#lifecycleGeneration !== expectedGeneration) {
        throw new RangeError(
          "realtime lifecycle changed during visibility resume"
        );
      }
      validateClockValue(resumeMs, "visibility resume clock");
      const nextDeadlineMs = resumeMs + this.#frameDurationMs;
      validateClockValue(nextDeadlineMs, "visibility resume deadline");
      const authoredOffsetMs = timestampForFrame(
        this.#nextPresentationOrdinal,
        this.#frameRate
      ) / 1_000;
      const originMs = nextDeadlineMs - authoredOffsetMs;
      if (!Number.isFinite(originMs) || Math.abs(originMs) > Number.MAX_SAFE_INTEGER) {
        throw new RangeError("visibility resume origin exceeds safe range");
      }
      this.#originMs = originMs;
      this.#nextDeadlineMs = nextDeadlineMs;
      this.#lastDisplayCallbackMs = null;
    }
    if (wasRunning) this.start();
  }

  /** Fatal playback recovery freezes and cancels the owned callback immediately. */
  public stopAfterFailure(): void {
    if (this.#disposed) return;
    this.#running = false;
    this.#smoothSession = false;
    this.#advanceLifecycleGeneration();
    this.#invalidateFrameOwnership();
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#running = false;
    this.#advanceLifecycleGeneration();
    this.#invalidateFrameOwnership();
  }

  #ensureClockInitialized(): void {
    if (this.#initialized) return;
    const active = this.#clockInitializationInFlight;
    if (active !== null) {
      active.reentered = true;
      throw new RangeError("realtime clock initialization reentered synchronously");
    }
    const token: RealtimeClockInitializationToken = { reentered: false };
    const expectedGeneration = this.#lifecycleGeneration;
    this.#clockInitializationInFlight = token;
    let origin: number;
    try {
      origin = this.#now();
    } finally {
      if (this.#clockInitializationInFlight === token) {
        this.#clockInitializationInFlight = null;
      }
    }
    if (token.reentered) {
      throw new RangeError("realtime clock initialization reentered synchronously");
    }
    if (this.#disposed) throw new RealtimeDriverDisposedError();
    if (this.#lifecycleGeneration !== expectedGeneration) {
      throw new RangeError(
        "realtime lifecycle changed during clock initialization"
      );
    }
    validateClockValue(origin, "realtime clock origin");
    this.#originMs = origin;
    this.#nextDeadlineMs = deadlineFromOrigin(
      this.#originMs,
      this.#nextPresentationOrdinal,
      this.#frameRate
    );
    this.#initialized = true;
  }

  #handleScheduledFrame(
    token: RealtimeFrameRequestToken,
    timestamp: number
  ): void {
    if (this.#frameRequestInFlight === token) {
      token.invalidated = true;
      token.synchronousCallback = true;
      this.#running = false;
      this.#smoothSession = false;
      throw new RangeError(
        "animation-frame callback ran synchronously during its request"
      );
    }
    const pending = this.#pendingFrame;
    if (
      pending === null ||
      pending.token !== token ||
      token.invalidated
    ) {
      return;
    }
    this.#pendingFrame = null;
    token.invalidated = true;
    this.#handleDisplayCallback(timestamp);
  }

  #handleDisplayCallback(timestamp: number): void {
    if (!this.#running || this.#disposed) return;
    try {
      validateClockValue(timestamp, "animation-frame timestamp");
      if (
        this.#lastDisplayCallbackMs !== null &&
        timestamp < this.#lastDisplayCallbackMs
      ) {
        throw new RangeError("animation-frame clock must be monotonic");
      }
      const previousDisplayCallbackMs = this.#lastDisplayCallbackMs;
      this.#lastDisplayCallbackMs = timestamp;
      this.#displayCallbacks = checkedIncrement(
        this.#displayCallbacks,
        "display callback count"
      );
      if (timestamp + CONTENT_DEADLINE_EPSILON_MS >= this.#nextDeadlineMs!) {
        const missedDisplayCadence = previousDisplayCallbackMs !== null &&
          timestamp - previousDisplayCallbackMs >
            this.#frameDurationMs + CONTENT_DEADLINE_EPSILON_MS;
        this.#attemptContentTick(timestamp, false, missedDisplayCadence);
      }
      if (this.#running) this.#scheduleFrame();
    } catch (error) {
      this.#running = false;
      this.#smoothSession = false;
      this.#invalidateFrameOwnership();
      throw error;
    }
  }

  #attemptContentTick(
    opportunityTimeMs: number,
    manual: boolean,
    missedDisplayCadence = false
  ): Readonly<RealtimeTickOutcome> {
    const deadlineMs = this.#nextDeadlineMs!;
    const ordinal = this.#nextPresentationOrdinal;
    if (opportunityTimeMs + CONTENT_DEADLINE_EPSILON_MS < deadlineMs) {
      return Object.freeze({
        status: "not-due",
        presentationOrdinal: ordinal
      });
    }
    const token: RealtimeContentTickToken = { reentered: false };
    const expectedGeneration = this.#lifecycleGeneration;
    this.#contentTickInFlight = token;
    try {
      const callbackStartMs = this.#now();
      validateClockValue(callbackStartMs, "content callback start clock");
      const result = this.#tryContentTick(Object.freeze({
        presentationOrdinal: ordinal,
        deadlineMs,
        opportunityTimeMs,
        callbackStartMs,
        eligibleAnimationFrameOrdinal: manual ? null : this.#displayCallbacks,
        manual
      }));
      this.#assertContentTickAvailable(token);
      if (result === null || typeof result !== "object") {
        throw new TypeError("realtime content tick result is invalid");
      }
      const status = result.status;
      this.#assertContentTickCurrent(
        token,
        expectedGeneration,
        status === "stopped"
      );
      if (
        status !== "advanced" &&
        status !== "underflow" &&
        status !== "stopped"
      ) {
        throw new TypeError("realtime content tick result is invalid");
      }

      if (status === "underflow") {
        this.#smoothSession = false;
        if (this.#underflowReportedFor !== ordinal) {
          try {
            this.#onUnderflow?.(Object.freeze({
              presentationOrdinal: ordinal,
              deadlineMs,
              opportunityTimeMs
            }));
          } catch {
            // Underflow observers are diagnostics and cannot own the RAF loop.
          }
          this.#assertContentTickCurrent(token, expectedGeneration, false);
          this.#underflows = checkedIncrement(
            this.#underflows,
            "underflow count"
          );
          this.#underflowReportedFor = ordinal;
        }
        // Freeze the rational clock rather than trying to catch up missed media.
        this.#originMs += Math.max(0, opportunityTimeMs - deadlineMs);
        validateClockValue(this.#originMs, "shifted realtime clock origin");
        this.#nextDeadlineMs = deadlineFromOrigin(
          this.#originMs,
          ordinal,
          this.#frameRate
        );
        return Object.freeze({
          status: "underflow",
          presentationOrdinal: ordinal
        });
      }

      if (status === "stopped") {
        // A fatal media boundary owns its asynchronous static recovery. Freeze
        // this clock immediately and never issue another animated content tick.
        this.#running = false;
        this.#smoothSession = false;
        return Object.freeze({
          status: "stopped",
          presentationOrdinal: ordinal
        });
      }

      this.#advancedTicks = checkedIncrement(
        this.#advancedTicks,
        "advanced content-tick count"
      );
      this.#underflowReportedFor = null;
      this.#nextPresentationOrdinal += 1n;
      let nextDeadlineMs = deadlineFromOrigin(
        this.#originMs,
        this.#nextPresentationOrdinal,
        this.#frameRate
      );
      if (
        !manual &&
        (
          missedDisplayCadence ||
          nextDeadlineMs <= opportunityTimeMs + CONTENT_DEADLINE_EPSILON_MS
        )
      ) {
        // A throttled or missed display opportunity drops wall-clock debt. The
        // authored frame sequence resumes at its normal cadence and is never
        // burst-played to catch up with time that elapsed off-screen.
        this.#originMs += Math.max(0, opportunityTimeMs - deadlineMs);
        validateClockValue(this.#originMs, "rebased realtime clock origin");
        nextDeadlineMs = deadlineFromOrigin(
          this.#originMs,
          this.#nextPresentationOrdinal,
          this.#frameRate
        );
      }
      this.#nextDeadlineMs = nextDeadlineMs;
      return Object.freeze({
        status: "advanced",
        presentationOrdinal: ordinal
      });
    } catch (error) {
      if (token.reentered) throw contentTickReentryError();
      throw error;
    } finally {
      if (this.#contentTickInFlight === token) {
        this.#contentTickInFlight = null;
      }
    }
  }

  #scheduleFrame(): void {
    this.#assertFrameHostIdle();
    if (this.#pendingFrame !== null) {
      throw new RangeError("realtime driver already has a pending callback");
    }
    if (this.#frameRequestInFlight !== null) {
      throw new RangeError("realtime frame request reentered synchronously");
    }
    const token: RealtimeFrameRequestToken = {
      invalidated: false,
      synchronousCallback: false
    };
    const callback: FrameRequestCallback = (timestamp): void => {
      this.#handleScheduledFrame(token, timestamp);
    };
    this.#frameRequestInFlight = token;
    let handle: unknown;
    try {
      handle = this.#requestFrame(callback);
    } catch (error) {
      token.invalidated = true;
      this.#running = false;
      throw error;
    } finally {
      if (this.#frameRequestInFlight === token) {
        this.#frameRequestInFlight = null;
      }
    }
    if (token.synchronousCallback) {
      this.#running = false;
      this.#cancelReturnedFrame(handle);
      throw new RangeError(
        "animation-frame callback ran synchronously during its request"
      );
    }
    if (token.invalidated || !this.#running || this.#disposed) {
      token.invalidated = true;
      this.#cancelReturnedFrame(handle);
      if (this.#disposed) throw new RealtimeDriverDisposedError();
      throw new RangeError(
        "realtime frame ownership changed during its request"
      );
    }
    if (
      typeof handle !== "number" ||
      !Number.isSafeInteger(handle) ||
      handle < 0
    ) {
      token.invalidated = true;
      this.#running = false;
      this.#cancelReturnedFrame(handle);
      throw new RangeError(
        "animation-frame request must return a non-negative integer handle"
      );
    }
    this.#pendingFrame = { handle, token };
  }

  #invalidateFrameOwnership(): void {
    if (this.#frameRequestInFlight !== null) {
      this.#frameRequestInFlight.invalidated = true;
    }
    const pending = this.#pendingFrame;
    if (pending === null) return;
    this.#pendingFrame = null;
    pending.token.invalidated = true;
    this.#invokeCancelFrame(pending.handle);
  }

  #cancelReturnedFrame(handle: unknown): void {
    if (typeof handle !== "number") return;
    try {
      this.#invokeCancelFrame(handle);
    } catch {
      // The stable scheduling/lifecycle failure remains authoritative.
    }
  }

  #invokeCancelFrame(handle: number): void {
    if (this.#frameCancellationInFlight) {
      throw new RangeError("realtime frame cancellation reentered synchronously");
    }
    this.#frameCancellationInFlight = true;
    try {
      this.#cancelFrame(handle);
    } finally {
      this.#frameCancellationInFlight = false;
    }
  }

  #assertFrameHostIdle(): void {
    if (this.#frameCancellationInFlight) {
      throw new RangeError("realtime frame cancellation is in progress");
    }
  }

  #assertContentTickIdle(): void {
    const active = this.#contentTickInFlight;
    if (active === null) return;
    active.reentered = true;
    throw contentTickReentryError();
  }

  #assertContentTickCurrent(
    token: RealtimeContentTickToken,
    expectedGeneration: bigint,
    allowLifecycleChange: boolean
  ): void {
    this.#assertContentTickAvailable(token);
    if (
      !allowLifecycleChange &&
      this.#lifecycleGeneration !== expectedGeneration
    ) {
      throw new RangeError(
        "realtime lifecycle changed during a content tick"
      );
    }
  }

  #assertContentTickAvailable(token: RealtimeContentTickToken): void {
    if (token.reentered) throw contentTickReentryError();
    if (this.#disposed) throw new RealtimeDriverDisposedError();
  }

  #advanceLifecycleGeneration(): void {
    this.#lifecycleGeneration += 1n;
  }

  #assertUsable(): void {
    if (this.#disposed) throw new RealtimeDriverDisposedError();
  }

  #assertClockHostIdle(): void {
    const active = this.#clockInitializationInFlight;
    if (active === null) return;
    active.reentered = true;
    throw new RangeError("realtime clock initialization reentered synchronously");
  }
}

function deadlineFromOrigin(
  originMs: number,
  ordinal: bigint,
  frameRate: Readonly<RationalFrameRate>
): number {
  const deadline = originMs + timestampForFrame(ordinal, frameRate) / 1_000;
  if (!Number.isFinite(deadline) || Math.abs(deadline) > Number.MAX_SAFE_INTEGER) {
    throw new RangeError("realtime deadline exceeds safe range");
  }
  return deadline;
}

function validateOptions(options: RealtimeDriverOptions): void {
  if (options === null || typeof options !== "object") {
    throw new TypeError("realtime driver options must be an object");
  }
  for (const [value, label] of [
    [options.requestFrame, "requestFrame"],
    [options.cancelFrame, "cancelFrame"],
    [options.now, "now"],
    [options.tryContentTick, "tryContentTick"]
  ] as const) {
    if (typeof value !== "function") {
      throw new TypeError(`realtime driver ${label} must be a function`);
    }
  }
  if (
    options.onUnderflow !== undefined &&
    typeof options.onUnderflow !== "function"
  ) {
    throw new TypeError("realtime driver onUnderflow must be a function");
  }
}

function validateClockValue(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be finite and non-negative`);
  }
}

function checkedIncrement(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER) {
    throw new RangeError(`${label} exceeds safe-integer range`);
  }
  return value + 1;
}

function contentTickReentryError(): RangeError {
  return new RangeError("realtime content tick reentered synchronously");
}
