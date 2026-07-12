import {
  MotionGraphEngine,
  type GraphPresentation,
  type MotionGraphSnapshot
} from "@rendered-motion/graph";

import type { RuntimeAssetCatalog } from "./asset-catalog.js";
import {
  IntegratedPlaybackInvariantError,
  PlaybackFallbackError,
  type IntegratedCandidateAttempt,
  type IntegratedCandidateAvailability,
  type IntegratedCandidateFactory,
  type IntegratedPreparedActivation,
  type IntegratedPrepareOptions
} from "./integrated-player-contracts.js";
import {
  RuntimePlaybackError,
  normalizeRuntimeFailure,
  type RuntimeFailure
} from "./errors.js";
import {
  createIntegratedActivationPresentation,
  integratedAbortError,
  integratedAbortReason,
  integratedDisposedError,
  isIntegratedAbortError,
  normalizeIntegratedCandidateFailure,
  raceIntegratedAbort,
  sameGraphPresentation,
  throwIfIntegratedAborted,
  validateIntegratedCandidateAttempt,
  validateIntegratedPreparedActivation,
  validatePreparationTimeout
} from "./integrated-player-support.js";
import {
  IntegratedStaticPreparation,
  type IntegratedPreparationControl
} from "./integrated-player-static-preparation.js";
import {
  createRuntimeCandidateReport,
  createRuntimeReadinessReport,
  summarizeStaticReason,
  type RuntimeCandidateReport,
  type RuntimeReadinessResult
} from "./model.js";
import {
  createOpaqueRenditionCandidates,
  inspectOpaqueRenditionCandidate
} from "./rendition-selection.js";

const DEFAULT_PREPARATION_TIMEOUT_MS = 5_000;

export interface IntegratedAnimatedActivationCommit {
  readonly attempt: IntegratedCandidateAttempt;
  readonly activation: Readonly<IntegratedPreparedActivation>;
  readonly expectedPresentation: Readonly<GraphPresentation>;
  readonly renditionId: string;
  readonly result: Readonly<RuntimeReadinessResult>;
  readonly signal: AbortSignal;
}

interface IntegratedAnimatedPreparationOptions {
  readonly catalog: RuntimeAssetCatalog;
  readonly graph: MotionGraphEngine;
  readonly staticPreparation: IntegratedStaticPreparation;
  readonly candidateFactory: IntegratedCandidateFactory;
  readonly availability: Readonly<IntegratedCandidateAvailability>;
  readonly hostMaxRuntimeBytes: number | null;
  readonly isDisposed: () => boolean;
  readonly commitActivation: (
    commit: Readonly<IntegratedAnimatedActivationCommit>
  ) => Readonly<RuntimeReadinessResult>;
  readonly rollbackActivation: (attempt: IntegratedCandidateAttempt) => void;
  readonly recoverActivation: (
    failure: Readonly<RuntimeFailure>
  ) => Promise<Readonly<RuntimeReadinessResult> | null>;
  readonly reportFailure: (failure: Readonly<RuntimeFailure>) => void;
}

/**
 * Owns one bounded animated-preparation transaction. Active playback state,
 * host effects, recovery, and request settlement remain player authorities.
 */
export class IntegratedAnimatedPreparation {
  readonly #catalog: RuntimeAssetCatalog;
  readonly #graph: MotionGraphEngine;
  readonly #staticPreparation: IntegratedStaticPreparation;
  readonly #candidateFactory: IntegratedCandidateFactory;
  readonly #availability: Readonly<IntegratedCandidateAvailability>;
  readonly #hostMaxRuntimeBytes: number | null;
  readonly #isDisposed: () => boolean;
  readonly #commitActivation: (
    commit: Readonly<IntegratedAnimatedActivationCommit>
  ) => Readonly<RuntimeReadinessResult>;
  readonly #rollbackActivation: (
    attempt: IntegratedCandidateAttempt
  ) => void;
  readonly #recoverActivation: (
    failure: Readonly<RuntimeFailure>
  ) => Promise<Readonly<RuntimeReadinessResult> | null>;
  readonly #reportFailure: (failure: Readonly<RuntimeFailure>) => void;

  #control: IntegratedPreparationControl | null = null;
  #attempt: IntegratedCandidateAttempt | null = null;

  public constructor(options: Readonly<IntegratedAnimatedPreparationOptions>) {
    this.#catalog = options.catalog;
    this.#graph = options.graph;
    this.#staticPreparation = options.staticPreparation;
    this.#candidateFactory = options.candidateFactory;
    this.#availability = options.availability;
    this.#hostMaxRuntimeBytes = options.hostMaxRuntimeBytes;
    this.#isDisposed = options.isDisposed;
    this.#commitActivation = options.commitActivation;
    this.#rollbackActivation = options.rollbackActivation;
    this.#recoverActivation = options.recoverActivation;
    this.#reportFailure = options.reportFailure;
  }

  /** Idempotently interrupts the currently owned transaction, if any. */
  public abort(): void {
    const control = this.#control;
    if (control !== null && !control.controller.signal.aborted) {
      control.controller.abort(integratedAbortError());
    }
  }

  public async run(
    options: IntegratedPrepareOptions
  ): Promise<Readonly<RuntimeReadinessResult>> {
    const timeoutMs = validatePreparationTimeout(
      options.timeoutMs ?? DEFAULT_PREPARATION_TIMEOUT_MS
    );
    const control = this.#staticPreparation.createControl(
      options.signal,
      timeoutMs
    );
    if (this.#control !== null) {
      this.#staticPreparation.releaseControl(control);
      throw new IntegratedPlaybackInvariantError(
        "animated preparation already owns an active control"
      );
    }
    this.#control = control;
    const reports: RuntimeCandidateReport[] = [];
    const failures: RuntimeFailure[] = [];
    let hasOpaqueRendition = false;

    try {
      await this.#staticPreparation.ensure(control.controller.signal);
      const candidates = createOpaqueRenditionCandidates(
        this.#catalog.renditions.values()
      );
      hasOpaqueRendition = candidates.length > 0;

      for (const candidate of candidates) {
        throwIfIntegratedAborted(control.controller.signal);
        const inspected = inspectOpaqueRenditionCandidate(
          this.#catalog,
          candidate
        );
        if (!inspected.ok) {
          reports.push(inspected.report);
          if (inspected.report.failure !== null) {
            failures.push(inspected.report.failure);
          }
          continue;
        }

        let attempt: IntegratedCandidateAttempt | null = null;
        try {
          let activation: Readonly<IntegratedPreparedActivation>;
          let expectedPresentation: Readonly<GraphPresentation>;
          // Accepted graph input remains responsive while candidate media is
          // asynchronous. Restage from the newest semantic snapshot whenever
          // the activation prepared above is stale.
          for (;;) {
            attempt = this.#candidateFactory.create(Object.freeze({
              catalog: this.#catalog,
              candidate,
              inspection: inspected.inspection,
              graphSnapshot: this.#graph.snapshot(),
              hostMaxRuntimeBytes: this.#hostMaxRuntimeBytes
            }));
            validateIntegratedCandidateAttempt(attempt);
            this.#attempt = attempt;
            await raceIntegratedAbort(
              attempt.prepare({
                signal: control.controller.signal,
                deadlineMs: control.deadlineMs
              }),
              control.controller.signal
            );
            throwIfIntegratedAborted(control.controller.signal);

            const activationSnapshot = this.#graph.snapshot();
            expectedPresentation = createIntegratedActivationPresentation(
              this.#catalog.graph,
              activationSnapshot
            );
            activation = await raceIntegratedAbort(
              attempt.prepareActivation({
                signal: control.controller.signal,
                deadlineMs: control.deadlineMs,
                graphSnapshot: activationSnapshot,
                expectedPresentation
              }),
              control.controller.signal
            );
            validateIntegratedPreparedActivation(
              activation,
              expectedPresentation
            );
            throwIfIntegratedAborted(control.controller.signal);
            if (sameActivationState(
              this.#graph.snapshot(),
              activationSnapshot
            )) break;

            await attempt.dispose();
            if (this.#attempt === attempt) this.#attempt = null;
            attempt = null;
          }

          reports.push(createRuntimeCandidateReport({
            rendition: candidate.rendition.id,
            rank: candidate.rank,
            outcome: "selected",
            failure: null
          }));
          const report = createRuntimeReadinessReport({
            readiness: "interactiveReady",
            selectedRendition: candidate.rendition.id,
            candidates: reports
          });
          const result = Object.freeze({
            mode: "animated" as const,
            assurance: "best-effort" as const,
            report
          });
          if (attempt === null) {
            throw new IntegratedPlaybackInvariantError(
              "candidate activation completed without an owned attempt"
            );
          }

          const committed = this.#commitActivation(Object.freeze({
            attempt,
            activation,
            expectedPresentation,
            renditionId: candidate.rendition.id,
            result,
            signal: control.controller.signal
          }));
          if (this.#attempt === attempt) this.#attempt = null;
          return committed;
        } catch (error) {
          const aborted = control.controller.signal.aborted;
          const failure = normalizeIntegratedCandidateFailure(
            error,
            candidate.rendition.id,
            candidate.rank
          );
          if (this.#graph.snapshot().readiness === "animated") {
            if (this.#attempt === attempt) this.#attempt = null;
            const recovered = await this.#recoverActivation(failure);
            if (aborted) throw integratedAbortReason(control.controller.signal);
            if (recovered?.mode !== "static") {
              throw new IntegratedPlaybackInvariantError(
                "animated activation recovery produced no static result"
              );
            }
            return recovered;
          }

          if (attempt !== null) this.#rollbackActivation(attempt);
          let cleanupFailure: Readonly<RuntimeFailure> | null = null;
          if (attempt !== null) {
            try {
              await attempt.dispose();
            } catch (disposeError) {
              cleanupFailure = normalizeRuntimeFailure(
                "readiness-failure",
                disposeError,
                {
                  rendition: candidate.rendition.id,
                  rank: candidate.rank,
                  operation: "candidate-cleanup"
                }
              );
              this.#reportFailure(cleanupFailure);
              if (!aborted) failures.push(cleanupFailure);
            }
          }
          if (this.#attempt === attempt) this.#attempt = null;
          if (aborted) throw integratedAbortReason(control.controller.signal);
          failures.push(failure);
          reports.push(createRuntimeCandidateReport({
            rendition: candidate.rendition.id,
            rank: candidate.rank,
            outcome: "rejected",
            failure
          }));
          this.#reportFailure(failure);
          if (cleanupFailure !== null) {
            throw new RuntimePlaybackError(cleanupFailure);
          }
        }
      }

      return await this.#staticPreparation.finish(
        summarizeStaticReason({
          phase: "preparation",
          staticReady: this.#staticPreparation.staticReady,
          deadlineExpired: false,
          hasOpaqueRendition,
          workerAvailable: this.#availability.workerAvailable,
          rendererAvailable: this.#availability.rendererAvailable,
          candidateFailures: failures
        }) ?? "readiness-failed",
        reports,
        control.controller.signal
      );
    } catch (error) {
      if (this.#isDisposed()) throw integratedDisposedError();
      if (this.#graph.snapshot().readiness === "error") throw error;
      if (control.externalSignal?.aborted === true) {
        throw integratedAbortReason(control.externalSignal);
      }
      if (control.timedOut) {
        if (this.#staticPreparation.staticReady) {
          return await this.#staticPreparation.finishBounded(
            "preparation-timeout",
            reports,
            timeoutMs
          );
        }
        this.#staticPreparation.fail(
          "static readiness did not complete before timeout"
        );
        throw new PlaybackFallbackError(
          "static readiness did not complete before preparation timeout"
        );
      }
      if (isIntegratedAbortError(error)) throw error;
      if (!this.#staticPreparation.staticReady) {
        this.#staticPreparation.fail("static readiness failed");
        throw new PlaybackFallbackError("static readiness failed");
      }
      const failure = normalizeIntegratedCandidateFailure(
        error,
        "unknown",
        reports.length
      );
      failures.push(failure);
      this.#reportFailure(failure);
      return await this.#staticPreparation.finishBounded(
        "readiness-failed",
        reports,
        timeoutMs
      );
    } finally {
      this.#staticPreparation.releaseControl(control);
      if (this.#control === control) this.#control = null;
    }
  }
}

function sameActivationState(
  current: Readonly<MotionGraphSnapshot>,
  prepared: Readonly<MotionGraphSnapshot>
): boolean {
  return current.readiness === prepared.readiness &&
    current.phase === prepared.phase &&
    current.requestedState === prepared.requestedState &&
    current.visualState === prepared.visualState &&
    current.prospectiveState === prepared.prospectiveState &&
    current.isTransitioning === prepared.isTransitioning &&
    current.pendingEdgeId === prepared.pendingEdgeId &&
    current.activeEdgeId === prepared.activeEdgeId &&
    current.followOnEdgeId === prepared.followOnEdgeId &&
    current.direction === prepared.direction &&
    sameGraphPresentation(current.presentation, prepared.presentation);
}
