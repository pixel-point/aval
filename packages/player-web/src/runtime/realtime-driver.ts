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
  readonly #animationCallback: FrameRequestCallback;

  #initialized = false;
  #running = false;
  #disposed = false;
  #originMs = 0;
  #nextPresentationOrdinal = 1n;
  #nextDeadlineMs: number | null = null;
  #pendingFrameHandle: number | null = null;
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
    this.#animationCallback = (timestamp): void => {
      this.#handleDisplayCallback(timestamp);
    };
  }

  public start(): void {
    this.#assertUsable();
    if (this.#running) return;
    this.#ensureClockInitialized();
    this.#running = true;
    this.#scheduleFrame();
  }

  /** Deterministic proof adapter over the same single-tick attempt. */
  public tickOnce(): Readonly<RealtimeTickOutcome> {
    this.#assertUsable();
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

  /** Fatal playback recovery freezes and cancels the owned callback immediately. */
  public stopAfterFailure(): void {
    if (this.#disposed) return;
    this.#running = false;
    this.#smoothSession = false;
    if (this.#pendingFrameHandle !== null) {
      const handle = this.#pendingFrameHandle;
      this.#pendingFrameHandle = null;
      this.#cancelFrame(handle);
    }
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#running = false;
    if (this.#pendingFrameHandle !== null) {
      const handle = this.#pendingFrameHandle;
      this.#pendingFrameHandle = null;
      this.#cancelFrame(handle);
    }
  }

  #ensureClockInitialized(): void {
    if (this.#initialized) return;
    const origin = this.#now();
    validateClockValue(origin, "realtime clock origin");
    this.#originMs = origin;
    this.#nextDeadlineMs = deadlineFromOrigin(
      this.#originMs,
      this.#nextPresentationOrdinal,
      this.#frameRate
    );
    this.#initialized = true;
  }

  #handleDisplayCallback(timestamp: number): void {
    if (!this.#running || this.#disposed) return;
    this.#pendingFrameHandle = null;
    validateClockValue(timestamp, "animation-frame timestamp");
    if (
      this.#lastDisplayCallbackMs !== null &&
      timestamp < this.#lastDisplayCallbackMs
    ) {
      this.#running = false;
      throw new RangeError("animation-frame clock must be monotonic");
    }
    const previousDisplayCallbackMs = this.#lastDisplayCallbackMs;
    this.#lastDisplayCallbackMs = timestamp;
    this.#displayCallbacks = checkedIncrement(
      this.#displayCallbacks,
      "display callback count"
    );

    try {
      if (timestamp + CONTENT_DEADLINE_EPSILON_MS >= this.#nextDeadlineMs!) {
        const missedDisplayCadence = previousDisplayCallbackMs !== null &&
          timestamp - previousDisplayCallbackMs >
            this.#frameDurationMs + CONTENT_DEADLINE_EPSILON_MS;
        this.#attemptContentTick(timestamp, false, missedDisplayCadence);
      }
    } catch (error) {
      this.#running = false;
      throw error;
    }
    if (this.#running) this.#scheduleFrame();
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
    const result = this.#tryContentTick(Object.freeze({
      presentationOrdinal: ordinal,
      deadlineMs,
      opportunityTimeMs,
      manual
    }));
    if (
      result === null ||
      typeof result !== "object" ||
      (
        result.status !== "advanced" &&
        result.status !== "underflow" &&
        result.status !== "stopped"
      )
    ) {
      throw new TypeError("realtime content tick result is invalid");
    }

    if (result.status === "underflow") {
      this.#smoothSession = false;
      if (this.#underflowReportedFor !== ordinal) {
        this.#underflows = checkedIncrement(
          this.#underflows,
          "underflow count"
        );
        this.#underflowReportedFor = ordinal;
        try {
          this.#onUnderflow?.(Object.freeze({
            presentationOrdinal: ordinal,
            deadlineMs,
            opportunityTimeMs
          }));
        } catch {
          // Underflow observers are diagnostics and cannot own the RAF loop.
        }
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

    if (result.status === "stopped") {
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
  }

  #scheduleFrame(): void {
    if (this.#pendingFrameHandle !== null) {
      throw new RangeError("realtime driver already has a pending callback");
    }
    let handle: number;
    try {
      handle = this.#requestFrame(this.#animationCallback);
    } catch (error) {
      this.#running = false;
      throw error;
    }
    if (!Number.isSafeInteger(handle) || handle < 0) {
      this.#running = false;
      throw new RangeError(
        "animation-frame request must return a non-negative integer handle"
      );
    }
    this.#pendingFrameHandle = handle;
  }

  #assertUsable(): void {
    if (this.#disposed) throw new RealtimeDriverDisposedError();
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
