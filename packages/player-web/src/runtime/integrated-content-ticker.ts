import { MotionGraphEngine, type MotionGraphTickOptions } from
  "@rendered-motion/graph";

import { EffectHost } from "./effect-host.js";
import type { RuntimeFailure, RuntimeFailureCode } from "./errors.js";
import {
  IntegratedPlaybackInvariantError,
  type IntegratedCandidateAttempt,
  type IntegratedContentTickContext,
  type IntegratedContentTickResult
} from "./integrated-player-contracts.js";
import { IntegratedOperationGate } from "./integrated-operation-gate.js";
import {
  assertIntegratedPresentationIdentity,
  integratedDisposedError,
  normalizeIntegratedAnimatedFailure,
  validateIntegratedContentTickContext,
  validateIntegratedPlaybackTraceState,
  validateIntegratedPreparedContentTick
} from "./integrated-player-support.js";
import { IntegratedTraceHarness } from "./integrated-trace-harness.js";

interface IntegratedContentTickerOptions {
  readonly graph: MotionGraphEngine;
  readonly effects: EffectHost;
  readonly trace: IntegratedTraceHarness;
  readonly operationGate: IntegratedOperationGate;
  readonly isDisposed: () => boolean;
  readonly isBlocked: () => boolean;
  readonly isVisibilityActive: () => boolean;
  readonly isRecoveryActive: () => boolean;
  readonly hasRealtime: () => boolean;
  readonly getPresentationOrdinal: () => bigint;
  readonly setPresentationOrdinal: (value: bigint) => void;
  readonly getActiveCandidate: () => IntegratedCandidateAttempt | null;
  readonly touch: () => void;
  readonly startRecovery: (failure: Readonly<RuntimeFailure>) => void;
  readonly now: () => number;
}

/** Owns the synchronous graph/playback/render transaction for one player. */
export class IntegratedContentTicker {
  readonly #options: Readonly<IntegratedContentTickerOptions>;

  public constructor(options: Readonly<IntegratedContentTickerOptions>) {
    this.#options = options;
  }

  public try(
    context: IntegratedContentTickContext
  ): Readonly<IntegratedContentTickResult> {
    const options = this.#options;
    if (options.isDisposed()) throw integratedDisposedError();
    if (options.operationGate.active) {
      throw new IntegratedPlaybackInvariantError(
        "content ticks cannot reenter an effect transaction"
      );
    }
    if (options.hasRealtime()) {
      throw new IntegratedPlaybackInvariantError(
        "manual content ticks are unavailable with a player-owned realtime clock"
      );
    }
    return options.operationGate.run(() => this.#run(context));
  }

  /** Realtime owns the clock, but shares the same guarded tick transaction. */
  public tryRealtime(
    context: IntegratedContentTickContext
  ): Readonly<IntegratedContentTickResult> {
    if (this.#options.isDisposed()) throw integratedDisposedError();
    return this.#options.operationGate.run(() => this.#run(context));
  }

  #run(
    context: IntegratedContentTickContext
  ): Readonly<IntegratedContentTickResult> {
    const options = this.#options;
    if (options.isDisposed()) throw integratedDisposedError();
    validateIntegratedContentTickContext(context);
    if (options.isBlocked() || !options.isVisibilityActive()) {
      return Object.freeze({ status: "stopped" });
    }
    if (options.effects.readiness !== "interactiveReady") {
      throw new IntegratedPlaybackInvariantError(
        "content ticks require an interactive-ready candidate"
      );
    }
    if (options.isRecoveryActive()) {
      return Object.freeze({ status: "stopped" });
    }
    if (
      context.presentationOrdinal !== options.getPresentationOrdinal() + 1n
    ) {
      throw new IntegratedPlaybackInvariantError(
        "content presentation ordinals must remain consecutive"
      );
    }
    const candidate = options.getActiveCandidate();
    if (candidate === null) {
      throw new IntegratedPlaybackInvariantError(
        "interactive readiness has no active playback session"
      );
    }
    const playback = candidate.playback;
    const callbackStartMicroseconds = context.callbackStartMicroseconds ??
      clockMicroseconds(options.now(), "content callback start");
    const eligibleAnimationFrameOrdinal = context.eligibleAnimationFrameOrdinal ?? null;
    let failureCode: RuntimeFailureCode = "worker-decode-failure";
    try {
      const prepared = playback.prepareContentTick(Object.freeze({
        presentationOrdinal: context.presentationOrdinal,
        rationalDeadlineUs: context.rationalDeadlineUs,
        graphSnapshot: options.graph.snapshot(),
        previewTick: (tick: Readonly<MotionGraphTickOptions>) =>
          options.graph.previewTick(tick)
      }));
      if (prepared === null) {
        const traceState = playback.traceState();
        validateIntegratedPlaybackTraceState(traceState);
        options.trace.recordUnderflow({
          context,
          playback: traceState,
          callbackStartMicroseconds,
          eligibleAnimationFrameOrdinal,
          readiness: options.effects.readiness
        });
        return Object.freeze({ status: "underflow" });
      }
      validateIntegratedPreparedContentTick(prepared);

      failureCode = "readiness-failure";
      const result = options.graph.tick({
        contentOrdinal: context.presentationOrdinal - 1n,
        routeReady: prepared.routeReady
      });
      const presentation = result.presentation;
      if (presentation === null) {
        throw new IntegratedPlaybackInvariantError(
          "animated graph tick produced no presentation"
        );
      }
      assertIntegratedPresentationIdentity(
        presentation,
        prepared.media,
        context.presentationOrdinal
      );

      failureCode = "renderer-failure";
      let readbackTag: string | null = null;
      options.effects.apply(result, (drawPresentation) => {
        assertIntegratedPresentationIdentity(
          drawPresentation,
          prepared.media,
          context.presentationOrdinal
        );
        readbackTag = playback.drawContentTick(prepared, drawPresentation);
        if (readbackTag !== null && typeof readbackTag !== "string") {
          throw new IntegratedPlaybackInvariantError(
            "playback readback tag must be a string or null"
          );
        }
      });
      failureCode = "readiness-failure";
      playback.synchronizeGraph(result);
      options.setPresentationOrdinal(context.presentationOrdinal);
      options.touch();
      // Timing observation is deliberately after the graph/media commit. The
      // injected clock is non-authoritative host code: a throw or re-entry may
      // make timing evidence unavailable, but can never roll back pixels that
      // were already submitted or start recovery for a committed frame.
      const canvasSubmissionCompleteMicroseconds = observeClockMicroseconds(
        options.now,
        callbackStartMicroseconds
      );
      options.trace.recordContentTick({
        context,
        result,
        prepared,
        readbackTag,
        callbackStartMicroseconds,
        canvasSubmissionCompleteMicroseconds,
        eligibleAnimationFrameOrdinal,
        readiness: options.effects.readiness
      });
      return Object.freeze({ status: "advanced" });
    } catch (error) {
      options.startRecovery(normalizeIntegratedAnimatedFailure(
        error,
        failureCode,
        context
      ));
      return Object.freeze({ status: "stopped" });
    }
  }
}

function clockMicroseconds(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${label} clock is invalid`);
  const microseconds = Math.floor(value * 1_000);
  if (!Number.isSafeInteger(microseconds)) throw new RangeError(`${label} clock exceeds safe microseconds`);
  return microseconds;
}

function observeClockMicroseconds(
  now: () => number,
  minimum: number
): number | null {
  try {
    const observed = clockMicroseconds(now(), "canvas submission completion");
    return observed < minimum ? null : observed;
  } catch {
    return null;
  }
}
