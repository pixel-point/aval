import type { PlayerInput } from "./player-contract.js";
import {
  DEFAULT_PREPARATION_TIMEOUT_MS,
  MAX_PREPARATION_TIMEOUT_MS
} from "./preparation-budget.js";

type PreparationDeadlinePlatform = Readonly<Pick<
  PlayerInput["platform"],
  "setTimeout" | "clearTimeout" | "now"
>>;

interface PreparationDeadlineOptions {
  readonly parent: AbortSignal;
  readonly timeoutMs?: number;
  readonly platform: PreparationDeadlinePlatform;
}

/** Defers a preparation phase until its preceding installation is settled. */
export class PreparationGate {
  readonly #ready: Promise<void>;
  readonly #resolve: () => void;
  readonly #reject: (reason: unknown) => void;
  #settled = false;

  public constructor() {
    let resolve!: () => void;
    let reject!: (reason: unknown) => void;
    this.#ready = new Promise<void>((accepted, rejected) => {
      resolve = accepted;
      reject = rejected;
    });
    this.#resolve = resolve;
    this.#reject = reject;
    void this.#ready.catch(() => undefined);
  }

  public get settled(): boolean { return this.#settled; }
  public wait(): Promise<void> { return this.#ready; }

  public complete(): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#resolve();
  }

  public fail(reason: unknown): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#reject(reason);
  }
}

export class PreparationDeadline {
  readonly #controller = new AbortController();
  readonly #parent: AbortSignal;
  readonly #platform: PreparationDeadlinePlatform;
  readonly #parentAbort: () => void;
  readonly #timeoutMs: number;
  #expiresAt: number | null = null;
  #timer: number | undefined;
  #completed = false;
  #timedOut = false;

  private constructor(
    parent: AbortSignal,
    timeoutMs: number,
    platform: PreparationDeadlinePlatform
  ) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 ||
      timeoutMs > MAX_PREPARATION_TIMEOUT_MS) {
      throw new RangeError("AVAL preparation timeout is invalid");
    }
    this.#parent = parent;
    this.#platform = platform;
    this.#timeoutMs = timeoutMs;
    this.#parentAbort = () => {
      this.#clearTimer();
      this.#controller.abort(parent.reason);
    };
    if (parent.aborted) this.#parentAbort();
    else parent.addEventListener("abort", this.#parentAbort, { once: true });
  }

  public static begin(
    options: Readonly<PreparationDeadlineOptions>
  ): PreparationDeadline {
    const deadline = new PreparationDeadline(
      options.parent,
      options.timeoutMs ?? DEFAULT_PREPARATION_TIMEOUT_MS,
      options.platform
    );
    deadline.start();
    return deadline;
  }

  public get signal(): AbortSignal { return this.#controller.signal; }
  public get timedOut(): boolean { return this.#timedOut; }

  public start(): void {
    if (this.#expiresAt !== null || this.#completed ||
      this.#controller.signal.aborted) return;
    this.#expiresAt = this.#platform.now() + this.#timeoutMs;
    this.#timer = this.#platform.setTimeout(() => {
      this.#timer = undefined;
      this.#timedOut = true;
      this.#controller.abort(preparationTimeout());
    }, this.#timeoutMs);
  }

  public remainingMs(): number {
    if (this.#completed) return 0;
    if (this.#expiresAt === null) return this.#timeoutMs;
    return Math.max(0, Math.ceil(this.#expiresAt - this.#platform.now()));
  }

  public forkDeferred(maximumMs: number): PreparationDeadline {
    const timeoutMs = Math.min(maximumMs, this.remainingMs());
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      throw preparationTimeout();
    }
    return new PreparationDeadline(this.signal, timeoutMs, this.#platform);
  }

  public complete(): void {
    this.#completed = true;
    this.#clearTimer();
  }

  public cancel(reason: unknown): void {
    this.complete();
    this.#controller.abort(reason);
  }

  public dispose(): void {
    this.complete();
    this.#parent.removeEventListener("abort", this.#parentAbort);
    this.#controller.abort(abortError());
  }

  #clearTimer(): void {
    if (this.#timer === undefined) return;
    this.#platform.clearTimeout(this.#timer);
    this.#timer = undefined;
  }
}

export function preparationTimeout(): DOMException {
  return new DOMException("AVAL preparation timed out", "TimeoutError");
}

function abortError(): DOMException {
  return new DOMException("AVAL operation was superseded", "AbortError");
}
