import type {
  DecoderWorkerLimits,
  DecoderWorkerMetrics,
  DecoderWorkerSample
} from "../decoder-worker/protocol.js";
import type {
  DecoderWorkerClient,
  DecoderWorkerWaitOptions,
  ManagedDecoderWorkerFrame
} from "../decoder-worker/client.js";
import type { InteractionCachePlan } from "./interaction-cache-plan.js";
import {
  buildPreparations,
  draftFrames,
  validateBatch,
  validateFinalCounts,
  type InteractionCachePreparationUnitCatalog,
  type PreparationCursor
} from "./interaction-cache-preparation-planning.js";
import {
  assertActiveGeneration,
  assertQuiescent,
  awaitAbortable,
  checkedAdd,
  checkedIncrement,
  checkedSum,
  createDeadlineSignal,
  requirePositiveGeneration,
  supersededError,
  throwIfAborted,
  validateLimits,
  validateManagedOutput,
  validateMaximumBatch,
  validateMetrics,
  validateObject,
  validateTimeout
} from "./interaction-cache-preparation-support.js";
import type {
  FrameRenderer,
  ResidentFrameHandle
} from "./frame-renderer.js";
import type { WorkerSampleFactory } from "./worker-samples.js";

export {
  InteractionCachePreparationTimeoutError
} from "./interaction-cache-preparation-support.js";
export type {
  InteractionCachePreparationUnitCatalog
} from "./interaction-cache-preparation-planning.js";

export const DEFAULT_INTERACTION_CACHE_PREPARATION_TIMEOUT_MS = 5_000;

export interface InteractionCachePreparationWorker {
  readonly activeGeneration: number | null;
  readonly queuedFrames: number;
  readonly openFrames: number;
  submit(
    generation: number,
    samples: readonly DecoderWorkerSample[]
  ): Promise<void>;
  abortGeneration(generation: number): Promise<void>;
  takeFrame(): ManagedDecoderWorkerFrame | undefined;
  waitForFrames(
    minimum?: number,
    options?: DecoderWorkerWaitOptions
  ): Promise<void>;
  snapshotMetrics(): Promise<DecoderWorkerMetrics>;
}

export interface InteractionCachePreparationRenderer {
  readonly resourceGeneration: number;
  uploadResident(
    layer: number,
    source: ManagedDecoderWorkerFrame,
    resourceGeneration?: number
  ): Promise<ResidentFrameHandle | null>;
}

export interface InteractionCachePreparationInput {
  readonly plan: Readonly<InteractionCachePlan>;
  readonly catalog: InteractionCachePreparationUnitCatalog;
  readonly samples: Pick<WorkerSampleFactory, "createBatch">;
  readonly worker: InteractionCachePreparationWorker;
  readonly renderer: InteractionCachePreparationRenderer;
  readonly limits: Readonly<DecoderWorkerLimits>;
}

export interface PrepareInteractionCacheOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly maxBatchSamples?: number;
}

export interface InteractionCachePreparationReport {
  readonly generation: number;
  readonly resourceGeneration: number;
  readonly unitOccurrences: number;
  readonly submittedFrames: number;
  readonly decodedFrames: number;
  readonly uploadedFrames: number;
  readonly dependencyFramesClosed: number;
  readonly staleFrames: number;
  readonly releasedFrames: number;
}

interface ExpectedOutput {
  readonly sample: Readonly<DecoderWorkerSample>;
  readonly layer: number | null;
}

interface PreparationCounters {
  submittedFrames: number;
  decodedFrames: number;
  uploadedFrames: number;
  dependencyFramesClosed: number;
  staleFrames: number;
  releasedFrames: number;
}

/**
 * Decodes every required unit as one complete forward occurrence. Planned
 * identities become resident pixels; all other dependency outputs are closed.
 * The caller activates the worker/timeline generation before entering here.
 */
export async function prepareInteractionCache(
  input: InteractionCachePreparationInput,
  options: PrepareInteractionCacheOptions = {}
): Promise<Readonly<InteractionCachePreparationReport>> {
  validateObject(input, "interaction cache preparation input");
  validateLimits(input.limits);
  const timeoutMs = validateTimeout(
    options.timeoutMs ?? DEFAULT_INTERACTION_CACHE_PREPARATION_TIMEOUT_MS
  );
  const maxBatchSamples = validateMaximumBatch(
    options.maxBatchSamples ?? Math.min(
      input.limits.maxPendingSamples,
      input.limits.maxOutstandingFrames
    ),
    input.limits
  );
  throwIfAborted(options.signal);

  const preparations = buildPreparations(input.plan, input.catalog);
  const generation = requirePositiveGeneration(
    input.worker.activeGeneration,
    "active worker generation"
  );
  const resourceGeneration = requirePositiveGeneration(
    input.renderer.resourceGeneration,
    "renderer resource generation"
  );
  const deadline = createDeadlineSignal(options.signal, timeoutMs);
  const expected: ExpectedOutput[] = [];
  const counters: PreparationCounters = {
    submittedFrames: 0,
    decodedFrames: 0,
    uploadedFrames: 0,
    dependencyFramesClosed: 0,
    staleFrames: 0,
    releasedFrames: 0
  };
  let cursor: PreparationCursor = { unitIndex: 0, unitFrame: 0 };
  let generationTouched = false;
  let activeSubmit: Promise<void> | null = null;

  const releaseObservedFrame = (
    frame: ManagedDecoderWorkerFrame,
    close: boolean
  ): void => {
    try {
      if (close && !frame.closed) frame.close();
    } finally {
      counters.releasedFrames = checkedIncrement(
        counters.releasedFrames,
        "released preparation frames"
      );
    }
  };

  const drainAvailableFrames = async (): Promise<void> => {
    for (;;) {
      throwIfAborted(deadline.signal);
      assertActiveGeneration(input.worker, generation);
      const frame = input.worker.takeFrame();
      if (frame === undefined) return;

      if (!Number.isSafeInteger(frame.generation) || frame.generation < 1) {
        releaseObservedFrame(frame, true);
        throw new RangeError("worker produced an invalid output generation");
      }
      if (frame.generation < generation) {
        counters.staleFrames = checkedIncrement(
          counters.staleFrames,
          "stale preparation frames"
        );
        releaseObservedFrame(frame, true);
        continue;
      }
      if (frame.generation > generation) {
        counters.staleFrames = checkedIncrement(
          counters.staleFrames,
          "stale preparation frames"
        );
        releaseObservedFrame(frame, true);
        throw new RangeError(
          "worker output generation is newer than cache preparation"
        );
      }

      counters.decodedFrames = checkedIncrement(
        counters.decodedFrames,
        "decoded preparation frames"
      );
      const output = expected.shift();
      if (output === undefined) {
        releaseObservedFrame(frame, true);
        throw new RangeError("worker produced an unplanned cache frame");
      }
      try {
        validateManagedOutput(
          frame,
          output.sample,
          Math.floor(
            input.limits.maxDecodedBytes /
              input.limits.maxOutstandingFrames
          )
        );
      } catch (error) {
        releaseObservedFrame(frame, true);
        throw error;
      }

      if (output.layer === null) {
        releaseObservedFrame(frame, true);
        counters.dependencyFramesClosed = checkedIncrement(
          counters.dependencyFramesClosed,
          "closed dependency frames"
        );
        continue;
      }
      if (input.renderer.resourceGeneration !== resourceGeneration) {
        counters.staleFrames = checkedIncrement(
          counters.staleFrames,
          "stale preparation frames"
        );
        releaseObservedFrame(frame, true);
        throw supersededError("renderer resources changed during preparation");
      }

      let upload: Promise<ResidentFrameHandle | null>;
      try {
        upload = input.renderer.uploadResident(
          output.layer,
          frame,
          resourceGeneration
        );
      } catch (error) {
        releaseObservedFrame(frame, true);
        throw error;
      }
      let handle: ResidentFrameHandle | null;
      try {
        handle = await awaitAbortable(upload, deadline.signal);
      } catch (error) {
        // Renderer ownership is already transferred. Candidate cleanup aborts
        // its bounded copy; never wait here on a hostile browser promise.
        void upload.catch(() => undefined);
        releaseObservedFrame(frame, !frame.closed);
        throw error;
      }
      releaseObservedFrame(frame, !frame.closed);
      throwIfAborted(deadline.signal);
      if (handle === null) {
        counters.staleFrames = checkedIncrement(
          counters.staleFrames,
          "stale preparation frames"
        );
        throw supersededError("renderer upload was superseded");
      }
      if (
        handle.layer !== output.layer ||
        handle.resourceGeneration !== resourceGeneration
      ) {
        throw new RangeError("renderer returned an unexpected resident handle");
      }
      counters.uploadedFrames = checkedIncrement(
        counters.uploadedFrames,
        "uploaded preparation frames"
      );
    }
  };

  try {
    const initialMetrics = await awaitAbortable(
      input.worker.snapshotMetrics(),
      deadline.signal
    );
    throwIfAborted(deadline.signal);
    assertActiveGeneration(input.worker, generation);
    validateMetrics(initialMetrics, input.limits, generation);
    assertQuiescent(input.worker, initialMetrics, "before preparation");

    for (;;) {
      await drainAvailableFrames();
      assertActiveGeneration(input.worker, generation);
      if (cursor.unitIndex === preparations.length && expected.length === 0) {
        break;
      }

      const metrics = await awaitAbortable(
        input.worker.snapshotMetrics(),
        deadline.signal
      );
      throwIfAborted(deadline.signal);
      assertActiveGeneration(input.worker, generation);
      validateMetrics(metrics, input.limits, generation);
      const trackedOutputs = checkedSum(
        [metrics.pendingSamples, metrics.submittedFrames, metrics.leasedFrames],
        "tracked worker preparation outputs"
      );
      if (trackedOutputs !== expected.length) {
        throw new RangeError(
          "worker credit did not match expected cache outputs"
        );
      }
      const outstanding = checkedSum(
        [metrics.pendingSamples, metrics.submittedFrames, metrics.leasedFrames],
        "worker outstanding preparation frames"
      );
      const batchLimit = Math.min(
        maxBatchSamples,
        input.limits.maxPendingSamples - metrics.pendingSamples,
        input.limits.maxOutstandingFrames - outstanding
      );

      if (cursor.unitIndex < preparations.length && batchLimit > 0) {
        const draft = draftFrames(preparations, cursor, batchLimit);
        const batch = input.samples.createBatch({
          frames: draft.frames.map(({ unitId, unitFrame }) => ({
            unitId,
            unitFrame
          })),
          pendingSamples: metrics.pendingSamples,
          outstandingFrames: checkedSum(
            [metrics.submittedFrames, metrics.leasedFrames],
            "worker submitted and leased preparation frames"
          )
        });
        try {
          generationTouched = true;
          validateBatch(batch, draft.frames, generation);
          cursor = draft.next;
          expected.push(...batch.samples.map((sample, index) => Object.freeze({
            sample,
            layer: draft.frames[index]?.layer ?? null
          })));
          activeSubmit = input.worker.submit(batch.generation, batch.samples);
          await awaitAbortable(activeSubmit, deadline.signal);
          activeSubmit = null;
        } finally {
          batch.release?.();
        }
        throwIfAborted(deadline.signal);
        assertActiveGeneration(input.worker, generation);
        counters.submittedFrames = checkedAdd(
          counters.submittedFrames,
          batch.samples.length,
          "submitted preparation frames"
        );
        continue;
      }

      if (expected.length === 0) {
        throw new RangeError(
          "worker preparation credit is occupied by unowned work"
        );
      }
      const queuedBefore = input.worker.queuedFrames;
      await awaitAbortable(input.worker.waitForFrames(1, {
        signal: deadline.signal,
        timeoutMs
      }), deadline.signal);
      throwIfAborted(deadline.signal);
      assertActiveGeneration(input.worker, generation);
      if (
        input.worker.queuedFrames <= queuedBefore &&
        input.worker.queuedFrames === 0
      ) {
        throw new RangeError("worker frame wait resolved without cache output");
      }
    }

    const finalMetrics = await awaitAbortable(
      input.worker.snapshotMetrics(),
      deadline.signal
    );
    throwIfAborted(deadline.signal);
    assertActiveGeneration(input.worker, generation);
    validateMetrics(finalMetrics, input.limits, generation);
    assertQuiescent(input.worker, finalMetrics, "after preparation");
    validateFinalCounts(input.plan, preparations, counters);

    return Object.freeze({
      generation,
      resourceGeneration,
      unitOccurrences: preparations.length,
      ...counters
    });
  } catch (error) {
    if (activeSubmit !== null) {
      await activeSubmit.catch(() => undefined);
      activeSubmit = null;
    }
    if (generationTouched && input.worker.activeGeneration === generation) {
      try {
        await input.worker.abortGeneration(generation);
      } catch {
        // The initiating failure retains precedence; the client owns teardown.
      }
    }
    throw error;
  } finally {
    deadline.dispose();
  }
}

/** Real renderer already satisfies the preparation's narrow upload boundary. */
export function asInteractionCachePreparationRenderer(
  renderer: FrameRenderer
): InteractionCachePreparationRenderer {
  return renderer;
}

/** Real worker client satisfies the preparation's narrow ownership boundary. */
export function asInteractionCachePreparationWorker(
  worker: DecoderWorkerClient
): InteractionCachePreparationWorker {
  return worker;
}
