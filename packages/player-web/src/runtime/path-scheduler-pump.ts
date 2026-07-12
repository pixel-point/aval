import type { DecoderWorkerLimits } from "../decoder-worker/protocol.js";
import type {
  PathSchedulerPumpOptions,
  PathSchedulerPumpReport,
  PathSchedulerWorkerAdapter
} from "./path-scheduler-model.js";
import {
  type PathSchedulerExpectedOutput,
  type PathSchedulerOutputDrainReport,
  PathSchedulerOutput
} from "./path-scheduler-output.js";
import {
  clonePathSequenceState,
  type PathFramePlan,
  type PathSequenceState
} from "./path-sequence.js";
import type { WorkerSampleFactory } from "./worker-samples.js";

const DEFAULT_PUMP_TIMEOUT_MS = 2_000;
const MAX_PUMP_ITERATIONS = 256;

export interface PumpPathSchedulerInput {
  readonly options: Readonly<PathSchedulerPumpOptions>;
  readonly ringCapacity: number;
  readonly limits: Readonly<DecoderWorkerLimits>;
  readonly maxBatchSamples: number;
  readonly worker: PathSchedulerWorkerAdapter;
  readonly samples: WorkerSampleFactory;
  readonly output: PathSchedulerOutput;
  readonly build: PathSequenceState;
  readonly buildFrame: (
    state: PathSequenceState
  ) => Readonly<PathFramePlan> | null;
  readonly commitBuild: (state: PathSequenceState) => void;
  readonly recordSubmitted: (
    outputs: readonly Readonly<PathSchedulerExpectedOutput>[]
  ) => void;
  readonly onDrain: (
    report: Readonly<PathSchedulerOutputDrainReport>
  ) => void;
}

/** Bounded credit/request loop; graph routing remains in PathScheduler. */
export async function pumpPathScheduler(
  input: PumpPathSchedulerInput
): Promise<Readonly<PathSchedulerPumpReport>> {
  const targetRingFrames = input.options.targetRingFrames ?? input.ringCapacity;
  if (
    !Number.isSafeInteger(targetRingFrames) ||
    targetRingFrames < 1 ||
    targetRingFrames > input.ringCapacity
  ) {
    throw new RangeError("pump target must fit the presentation ring");
  }
  const timeoutMs = input.options.timeoutMs ?? DEFAULT_PUMP_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("pump timeout must be finite and positive");
  }

  let submittedFrames = 0;
  let decodedFrames = 0;
  let discardedFrames = 0;
  let staleFrames = 0;
  let waits = 0;
  let build = input.build;
  for (let iteration = 0; iteration < MAX_PUMP_ITERATIONS; iteration += 1) {
    const drained = input.output.drain();
    input.onDrain(drained);
    decodedFrames += drained.decodedFrames;
    discardedFrames += drained.discardedFrames;
    staleFrames += drained.staleFrames;

    const ringSize = input.output.ringSize;
    if (ringSize >= targetRingFrames) {
      return report(input.output, {
        submittedFrames,
        decodedFrames,
        discardedFrames,
        staleFrames,
        waits
      });
    }

    const metrics = await input.worker.snapshotMetrics();
    const deficit = targetRingFrames - ringSize -
      input.output.presentableExpectedCount();
    const pendingCredit = Math.max(
      0,
      input.limits.maxPendingSamples - metrics.pendingSamples
    );
    const outstanding = checkedAdd(
      metrics.submittedFrames,
      metrics.leasedFrames,
      "worker outstanding frames"
    );
    const outstandingCredit = Math.max(
      0,
      input.limits.maxOutstandingFrames - outstanding
    );
    const batchLimit = Math.min(
      input.maxBatchSamples,
      pendingCredit,
      outstandingCredit,
      Math.max(1, deficit)
    );

    if (batchLimit > 0 && deficit > 0) {
      const draft = clonePathSequenceState(build);
      const plans: Readonly<PathFramePlan>[] = [];
      for (let index = 0; index < batchLimit; index += 1) {
        const plan = input.buildFrame(draft);
        if (plan === null) break;
        plans.push(plan);
      }
      // A phase-only transition is semantic progress too. Persist terminal
      // finite state even when it emits no decoder request, otherwise reserve
      // reports an underflow forever instead of a held presentation.
      input.commitBuild(draft);
      build = draft;
      if (plans.length > 0) {
        const batch = input.samples.createBatch({
          frames: plans.map((plan) => ({
            unitId: plan.unitId,
            unitFrame: plan.unitFrame
          })),
          pendingSamples: metrics.pendingSamples,
          outstandingFrames: outstanding
        });
        const outputs = input.output.schedule(plans, batch.samples);
        input.recordSubmitted(outputs);
        submittedFrames += batch.samples.length;
        await input.worker.submit(batch.generation, batch.samples);
        continue;
      }
    }

    if (input.output.hasExpected()) {
      const queuedBefore = input.worker.queuedFrames;
      waits += 1;
      await input.worker.waitForFrames(1, {
        ...(input.options.signal === undefined
          ? {}
          : { signal: input.options.signal }),
        timeoutMs
      });
      if (
        input.worker.queuedFrames <= queuedBefore &&
        input.worker.queuedFrames === 0
      ) {
        throw new RangeError("worker frame wait resolved without output");
      }
      continue;
    }

    return report(input.output, {
      submittedFrames,
      decodedFrames,
      discardedFrames,
      staleFrames,
      waits
    });
  }
  throw new RangeError("path scheduler pump exceeded its bounded iterations");
}

function report(
  output: PathSchedulerOutput,
  input: Omit<PathSchedulerPumpReport, "ringSize" | "expectedOutputs">
): Readonly<PathSchedulerPumpReport> {
  return Object.freeze({
    ...input,
    ringSize: output.ringSize,
    expectedOutputs: output.expectedCount
  });
}

function checkedAdd(left: number, right: number, label: string): number {
  if (
    !Number.isSafeInteger(left) ||
    !Number.isSafeInteger(right) ||
    left < 0 ||
    right < 0 ||
    left > Number.MAX_SAFE_INTEGER - right
  ) {
    throw new RangeError(`${label} exceeded the safe-integer range`);
  }
  return left + right;
}
