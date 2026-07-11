import {
  ContinuousLoopDecoder,
  type ContinuousLoopDecoderMetrics,
  type ManagedDecodedFrame
} from "./continuous-loop-decoder.js";
import type { EncodedLoopUnit } from "./encoded-loop.js";
import { durationForFrame, timestampForFrame } from "./rational-time.js";

const DEFAULT_PREBUFFER_FRAMES = 8;
const DEFAULT_PREPARE_TIMEOUT_MS = 5_000;

export type LoopCanvasPlayerState =
  | "idle"
  | "preparing"
  | "ready"
  | "running"
  | "paused"
  | "error"
  | "disposed";

export interface LoopCanvasPlayerSnapshot {
  readonly state: LoopCanvasPlayerState;
  readonly virtualFrame: bigint | null;
  readonly contentFrame: number | null;
  readonly canvasSeams: number;
  readonly underflows: number;
  readonly lateContentFrames: number;
  readonly canvasDrawnFrames: number;
  readonly decoder: ContinuousLoopDecoderMetrics;
  readonly error: string | null;
}

export interface LoopCanvasPlayerOptions {
  readonly prebufferFrames?: number;
  readonly prepareTimeoutMs?: number;
  readonly onSnapshot?: (snapshot: LoopCanvasPlayerSnapshot) => void;
  readonly decoder?: ContinuousLoopDecoder;
  readonly requestFrame?: typeof requestAnimationFrame;
  readonly cancelFrame?: typeof cancelAnimationFrame;
  readonly now?: () => number;
}

/**
 * Minimal opaque M1 presenter. It consumes an already decoded chronological
 * ring on one rational clock; authored loop seams have no lifecycle action.
 */
export class LoopCanvasPlayer {
  readonly #unit: EncodedLoopUnit;
  readonly #canvas: HTMLCanvasElement;
  readonly #context: CanvasRenderingContext2D;
  readonly #decoder: ContinuousLoopDecoder;
  readonly #prebufferFrames: number;
  readonly #prepareTimeoutMs: number;
  readonly #onSnapshot: ((snapshot: LoopCanvasPlayerSnapshot) => void) | null;
  readonly #requestFrame: typeof requestAnimationFrame;
  readonly #cancelFrame: typeof cancelAnimationFrame;
  readonly #now: () => number;
  readonly #visibilityListener: () => void;

  #state: LoopCanvasPlayerState = "idle";
  #animationFrame: number | null = null;
  #clockAnchorMs = 0;
  #pauseStartedMs: number | null = null;
  #nextPresentationFrame = 0n;
  #lastVirtualFrame: bigint | null = null;
  #lastContentFrame: number | null = null;
  #canvasSeams = 0;
  #underflows = 0;
  #lateContentFrames = 0;
  #canvasDrawnFrames = 0;
  #error: Error | null = null;
  #resumeAfterVisibility = false;
  #preparation: Promise<void> | null = null;
  #desiredRunning = false;
  #lifecycleGeneration = 0;

  public constructor(
    canvas: HTMLCanvasElement,
    unit: EncodedLoopUnit,
    options: LoopCanvasPlayerOptions = {}
  ) {
    const context = canvas.getContext("2d", {
      alpha: false,
      desynchronized: true
    });
    if (context === null) {
      throw new Error("The loop scheduling spike requires a 2D canvas");
    }

    this.#unit = unit;
    this.#canvas = canvas;
    this.#context = context;
    this.#prebufferFrames = validatePrebuffer(
      options.prebufferFrames ?? DEFAULT_PREBUFFER_FRAMES,
      unit.frames.length
    );
    this.#prepareTimeoutMs = validateTimeout(
      options.prepareTimeoutMs ?? DEFAULT_PREPARE_TIMEOUT_MS
    );
    this.#decoder =
      options.decoder ??
      new ContinuousLoopDecoder(unit, {
        maxInFlight: Math.max(16, this.#prebufferFrames)
      });
    this.#onSnapshot = options.onSnapshot ?? null;
    this.#requestFrame =
      options.requestFrame ?? window.requestAnimationFrame.bind(window);
    this.#cancelFrame =
      options.cancelFrame ?? window.cancelAnimationFrame.bind(window);
    this.#now = options.now ?? (() => performance.now());
    this.#canvas.width = unit.displayWidth;
    this.#canvas.height = unit.displayHeight;

    this.#visibilityListener = () => {
      if (document.visibilityState === "hidden") {
        this.#resumeAfterVisibility =
          this.#state === "running" || this.#desiredRunning;
        if (this.#resumeAfterVisibility) {
          this.pause();
        }
        return;
      }

      if (this.#resumeAfterVisibility) {
        this.#resumeAfterVisibility = false;
        void this.resume().catch((error: unknown) => {
          this.#fail(error);
        });
      }
    };
    document.addEventListener("visibilitychange", this.#visibilityListener);
    this.#emitSnapshot();
  }

  public get state(): LoopCanvasPlayerState {
    return this.#state;
  }

  public async prepare(): Promise<void> {
    this.#assertNotDisposed();
    if (this.#state === "ready" || this.#state === "running") {
      return;
    }
    if (this.#preparation !== null) {
      return this.#preparation;
    }

    this.#state = "preparing";
    this.#emitSnapshot();
    this.#preparation = (async () => {
      this.#decoder.fillToAhead(this.#prebufferFrames);
      await this.#decoder.waitForFrames(this.#prebufferFrames, {
        timeoutMs: this.#prepareTimeoutMs
      });
      if (this.#state === "disposed") {
        throw new Error("The loop canvas player was disposed during preparation");
      }
      this.#state = "ready";
      this.#emitSnapshot();
    })().catch((error: unknown) => {
      const normalized = normalizeError(error);
      if (this.#state !== "disposed") {
        this.#fail(normalized);
      }
      throw normalized;
    });

    return this.#preparation;
  }

  public async start(): Promise<void> {
    this.#assertNotDisposed();
    this.#desiredRunning = true;
    const generation = ++this.#lifecycleGeneration;
    await this.prepare();
    if (!this.#canEnterRunning(generation)) {
      this.#settlePausedIntent();
      return;
    }
    if (this.#state === "running") {
      return;
    }

    const now = this.#now();
    this.#clockAnchorMs =
      now - timestampForFrame(this.#nextPresentationFrame, this.#unit.frameRate) / 1_000;
    this.#pauseStartedMs = null;
    this.#state = "running";
    this.#emitSnapshot();
    this.#scheduleNextFrame();
  }

  public pause(): void {
    this.#assertNotDisposed();
    this.#desiredRunning = false;
    this.#lifecycleGeneration += 1;
    if (this.#state === "idle" || this.#state === "error") {
      return;
    }

    this.#cancelScheduledFrame();
    this.#pauseStartedMs = this.#now();
    if (this.#state !== "preparing") {
      this.#state = "paused";
    }
    this.#emitSnapshot();
  }

  public async resume(): Promise<void> {
    this.#assertNotDisposed();
    if (this.#state === "running") {
      return;
    }
    if (
      this.#state !== "paused" &&
      this.#state !== "ready" &&
      this.#state !== "preparing"
    ) {
      throw new Error(`Cannot resume a player in state ${this.#state}`);
    }

    this.#desiredRunning = true;
    const generation = ++this.#lifecycleGeneration;
    if (this.#state === "preparing") {
      await this.prepare();
      if (!this.#canEnterRunning(generation)) {
        this.#settlePausedIntent();
        return;
      }
    }
    this.#decoder.fillToAhead(this.#prebufferFrames);
    await this.#decoder.waitForFrames(this.#prebufferFrames, {
      timeoutMs: this.#prepareTimeoutMs
    });
    if (!this.#canEnterRunning(generation)) {
      this.#settlePausedIntent();
      return;
    }
    const now = this.#now();
    if (this.#pauseStartedMs !== null) {
      this.#clockAnchorMs += now - this.#pauseStartedMs;
    } else {
      this.#clockAnchorMs =
        now -
        timestampForFrame(this.#nextPresentationFrame, this.#unit.frameRate) /
          1_000;
    }
    this.#pauseStartedMs = null;
    this.#state = "running";
    this.#emitSnapshot();
    this.#scheduleNextFrame();
  }

  public snapshot(): LoopCanvasPlayerSnapshot {
    return Object.freeze({
      state: this.#state,
      virtualFrame: this.#lastVirtualFrame,
      contentFrame: this.#lastContentFrame,
      canvasSeams: this.#canvasSeams,
      underflows: this.#underflows,
      lateContentFrames: this.#lateContentFrames,
      canvasDrawnFrames: this.#canvasDrawnFrames,
      decoder: this.#decoder.snapshotMetrics(),
      error: this.#error?.message ?? null
    });
  }

  public dispose(): void {
    if (this.#state === "disposed") {
      return;
    }

    this.#desiredRunning = false;
    this.#lifecycleGeneration += 1;
    this.#cancelScheduledFrame();
    document.removeEventListener("visibilitychange", this.#visibilityListener);
    this.#decoder.dispose();
    this.#state = "disposed";
    this.#emitSnapshot();
  }

  #scheduleNextFrame(): void {
    if (this.#animationFrame !== null || this.#state !== "running") {
      return;
    }
    this.#animationFrame = this.#requestFrame((now) => {
      this.#animationFrame = null;
      try {
        this.#presentDueFrames(now);
      } catch (error) {
        this.#fail(error);
      }
      this.#scheduleNextFrame();
    });
  }

  #presentDueFrames(now: number): void {
    if (this.#state !== "running") {
      return;
    }

    let dueMs = this.#dueTimeMs(this.#nextPresentationFrame);
    if (now < dueMs) {
      return;
    }

    const frameDurationMs =
      durationForFrame(this.#nextPresentationFrame, this.#unit.frameRate) /
      1_000;
    if (now - dueMs >= frameDurationMs) {
      this.#lateContentFrames += Math.floor((now - dueMs) / frameDurationMs);
    }

    while (now >= dueMs && this.#state === "running") {
      const decoded = this.#decoder.takeFrame();
      if (decoded === undefined) {
        this.#underflows += 1;
        this.#clockAnchorMs =
          now + frameDurationMs -
          timestampForFrame(
            this.#nextPresentationFrame,
            this.#unit.frameRate
          ) /
            1_000;
        this.#emitSnapshot();
        return;
      }

      try {
        this.#presentFrame(decoded);
      } catch (error) {
        decoded.close();
        this.#fail(error);
        return;
      }
      decoded.close();
      this.#decoder.fillToAhead(this.#prebufferFrames);
      dueMs = this.#dueTimeMs(this.#nextPresentationFrame);
    }
  }

  #presentFrame(decoded: ManagedDecodedFrame): void {
    if (decoded.virtualFrame !== this.#nextPresentationFrame) {
      throw new Error(
        `Expected virtual frame ${String(
          this.#nextPresentationFrame
        )}, received ${String(decoded.virtualFrame)}`
      );
    }

    this.#context.drawImage(
      decoded.frame,
      0,
      0,
      this.#canvas.width,
      this.#canvas.height
    );
    if (decoded.contentFrame === 0 && decoded.virtualFrame > 0n) {
      this.#canvasSeams += 1;
    }
    this.#lastVirtualFrame = decoded.virtualFrame;
    this.#lastContentFrame = decoded.contentFrame;
    this.#canvasDrawnFrames += 1;
    this.#nextPresentationFrame += 1n;
    this.#emitSnapshot();
  }

  #dueTimeMs(virtualFrame: bigint): number {
    return (
      this.#clockAnchorMs +
      timestampForFrame(virtualFrame, this.#unit.frameRate) / 1_000
    );
  }

  #cancelScheduledFrame(): void {
    if (this.#animationFrame === null) {
      return;
    }
    this.#cancelFrame(this.#animationFrame);
    this.#animationFrame = null;
  }

  #fail(error: unknown): void {
    if (this.#state === "disposed") {
      return;
    }
    this.#cancelScheduledFrame();
    this.#desiredRunning = false;
    this.#lifecycleGeneration += 1;
    this.#error = normalizeError(error);
    this.#state = "error";
    this.#decoder.dispose();
    this.#emitSnapshot();
  }

  #assertNotDisposed(): void {
    if (this.#state === "disposed") {
      throw new Error("The loop canvas player is disposed");
    }
    if (this.#state === "error") {
      throw this.#error ?? new Error("The loop canvas player failed");
    }
  }

  #canEnterRunning(generation: number): boolean {
    if (
      generation !== this.#lifecycleGeneration ||
      !this.#desiredRunning ||
      this.#state === "disposed" ||
      this.#state === "error"
    ) {
      return false;
    }
    if (document.visibilityState === "hidden") {
      this.#resumeAfterVisibility = true;
      return false;
    }
    return true;
  }

  #settlePausedIntent(): void {
    if (this.#state === "disposed" || this.#state === "error") {
      return;
    }
    if (!this.#desiredRunning || document.visibilityState === "hidden") {
      this.#state = "paused";
      this.#pauseStartedMs ??= this.#now();
      this.#emitSnapshot();
    }
  }

  #emitSnapshot(): void {
    this.#onSnapshot?.(this.snapshot());
  }
}

function validatePrebuffer(value: number, unitFrameCount: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 16) {
    throw new RangeError("prebufferFrames must be an integer from 1 through 16");
  }
  if (unitFrameCount <= 0) {
    throw new RangeError("The encoded loop must contain frames");
  }
  return value;
}

function validateTimeout(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError("prepareTimeoutMs must be a positive finite number");
  }
  return value;
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error("Loop canvas player failed", { cause: error });
}
