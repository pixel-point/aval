import type { ManagedDecoderWorkerFrame } from "../decoder-worker/client.js";
import type { GraphBodyDefinition } from "@rendered-motion/graph";
import type { DecoderWorkerSample } from "../decoder-worker/protocol.js";
import type {
  RuntimeMediaCursor,
  RuntimeMediaPresentation
} from "./model.js";
import type {
  PathSchedulerClock,
  PathSchedulerWorkerAdapter
} from "./path-scheduler-model.js";
import {
  PresentationRing,
  type PresentationRingExpectedFrame
} from "./presentation-ring.js";
import type { PathFramePlan } from "./path-sequence.js";
import type { SourceBodyCursor } from "./submission-horizon.js";

export interface PathSchedulerExpectedOutput {
  readonly plan: Readonly<PathFramePlan>;
  readonly sample: Readonly<DecoderWorkerSample>;
  readonly expected: Readonly<PresentationRingExpectedFrame> | null;
}

export interface PathSchedulerOutputDrainReport {
  readonly decodedFrames: number;
  readonly discardedFrames: number;
  readonly staleFrames: number;
  readonly decodedCursor: Readonly<RuntimeMediaCursor> | null;
  readonly decodedSource: Readonly<SourceBodyCursor> | null;
  readonly decodedTarget: Readonly<SourceBodyCursor> | null;
}

export type PathSchedulerOutputTrace = (
  operation: "output" | "discard-output" | "stale-output",
  output: PathSchedulerExpectedOutput | null,
  reason: string | null
) => void;

export type PathSchedulerRingTakeResult =
  | { readonly kind: "underflow" }
  | {
      readonly kind: "frame";
      readonly output: Readonly<PathSchedulerExpectedOutput>;
      readonly frame: ManagedDecoderWorkerFrame;
    };

export interface PathSchedulerOutputOptions {
  readonly worker: PathSchedulerWorkerAdapter;
  readonly rendition: string;
  readonly ringCapacity: number;
  readonly clock: PathSchedulerClock;
  readonly onTrace: PathSchedulerOutputTrace;
}

/** Owns decoder-output expectations, resident frames, and the streaming ring. */
export class PathSchedulerOutput {
  readonly #worker: PathSchedulerWorkerAdapter;
  readonly #rendition: string;
  readonly #ringCapacity: number;
  readonly #clock: PathSchedulerClock;
  readonly #onTrace: PathSchedulerOutputTrace;
  readonly #expected: PathSchedulerExpectedOutput[] = [];
  readonly #ringPlans: PathSchedulerExpectedOutput[] = [];
  readonly #resident: Extract<
    RuntimeMediaPresentation,
    { readonly kind: "frame" }
  >[] = [];

  #ring: PresentationRing | null = null;
  #generation: number | null = null;
  #path: string | null = null;
  #discardedDependencyFrames = 0;
  #staleFrames = 0;

  public constructor(options: PathSchedulerOutputOptions) {
    this.#worker = options.worker;
    this.#rendition = options.rendition;
    this.#ringCapacity = options.ringCapacity;
    this.#clock = options.clock;
    this.#onTrace = options.onTrace;
  }

  public get expectedCount(): number {
    return this.#expected.length;
  }

  public get residentCount(): number {
    return this.#resident.length;
  }

  public get discardedDependencyFrames(): number {
    return this.#discardedDependencyFrames;
  }

  public get staleFrames(): number {
    return this.#staleFrames;
  }

  public get ringSize(): number {
    return this.#ring?.snapshot().size ?? 0;
  }

  public start(generation: number, path: string): void {
    if (this.#ring !== null) {
      throw new RangeError("path scheduler output already has a ring");
    }
    this.#generation = generation;
    this.#path = path;
    this.#ring = new PresentationRing({
      capacity: this.#ringCapacity,
      generation,
      path
    });
  }

  public activate(generation: number, path: string): void {
    const ring = this.#requireRing();
    this.#clearQueues();
    ring.activatePath({ generation, path });
    this.#generation = generation;
    this.#path = path;
  }

  public clear(): void {
    try {
      this.#ring?.clear();
    } finally {
      this.#clearQueues();
    }
  }

  public dispose(): void {
    try {
      this.#ring?.dispose();
    } finally {
      this.#clearQueues();
    }
  }

  public schedule(
    plans: readonly Readonly<PathFramePlan>[],
    samples: readonly Readonly<DecoderWorkerSample>[]
  ): readonly Readonly<PathSchedulerExpectedOutput>[] {
    if (plans.length !== samples.length || plans.length < 1) {
      throw new RangeError("scheduled path output relation is invalid");
    }
    const generation = this.#requireGeneration();
    const path = this.#requirePath();
    const outputs = plans.map((plan, index) => {
      const sample = samples[index]!;
      const expected = plan.discard
        ? null
        : Object.freeze({
            generation,
            path,
            unitId: sample.unitId,
            unitInstance: sample.unitInstance,
            unitFrame: sample.unitFrame,
            decodeOrdinal: sample.ordinal,
            timestamp: sample.timestamp,
            duration: sample.duration,
            intendedPresentationOrdinal:
              plan.intendedPresentationOrdinal ?? 0n
          });
      return Object.freeze({ plan, sample, expected });
    });
    this.#expected.push(...outputs);
    return Object.freeze(outputs);
  }

  public presentableExpectedCount(): number {
    let count = 0;
    for (const output of this.#expected) {
      if (!output.plan.discard) count += 1;
    }
    return count;
  }

  public hasExpected(): boolean {
    return this.#expected.length > 0;
  }

  public peekRingOutput(): Readonly<PathSchedulerExpectedOutput> | undefined {
    return this.#ringPlans[0];
  }

  public availableEdgeLead(): number {
    const first = this.#ringPlans.findIndex((output) =>
      output.plan.purpose !== "source"
    );
    return first < 0 ? 0 : this.#ringPlans.length - first;
  }

  /** Reclassifies retained decoded target lead as the new stable source ring. */
  public promoteTargetToSource(
    state: string,
    body: Readonly<GraphBodyDefinition>
  ): void {
    const promote = (
      output: Readonly<PathSchedulerExpectedOutput>
    ): Readonly<PathSchedulerExpectedOutput> => {
      if (output.plan.purpose !== "target") return output;
      const targetCursor = output.plan.targetCursor;
      if (targetCursor === null) {
        throw new RangeError("target output has no promotion cursor");
      }
      const cursor = body.kind === "loop"
        ? targetCursor
        : { occurrence: 0n, frame: targetCursor.frame };
      return Object.freeze({
        ...output,
        plan: Object.freeze({
          ...output.plan,
          purpose: "source" as const,
          state,
          edge: null,
          sourceCursor: Object.freeze({ ...cursor }),
          targetCursor: null
        })
      });
    };
    this.#expected.splice(
      0,
      this.#expected.length,
      ...this.#expected.map(promote)
    );
    this.#ringPlans.splice(
      0,
      this.#ringPlans.length,
      ...this.#ringPlans.map(promote)
    );
  }

  public takeRingOutput(): Readonly<PathSchedulerRingTakeResult> {
    const output = this.#ringPlans[0];
    if (output === undefined || output.expected === null) {
      return Object.freeze({ kind: "underflow" });
    }
    const result = this.#requireRing().takeExpected(output.expected);
    if (result.kind === "underflow") {
      return Object.freeze({ kind: "underflow" });
    }
    this.#ringPlans.shift();
    return Object.freeze({
      kind: "frame",
      output,
      frame: result.entry.frame
    });
  }

  public replaceResident(
    media: readonly Readonly<Extract<
      RuntimeMediaPresentation,
      { readonly kind: "frame" }
    >>[]
  ): void {
    this.#resident.length = 0;
    this.#resident.push(...media);
  }

  public takeResident(): Readonly<Extract<
    RuntimeMediaPresentation,
    { readonly kind: "frame" }
  >> | undefined {
    return this.#resident.shift();
  }

  public drain(): Readonly<PathSchedulerOutputDrainReport> {
    let decodedFrames = 0;
    let discardedFrames = 0;
    let staleFrames = 0;
    let decodedCursor: Readonly<RuntimeMediaCursor> | null = null;
    let decodedSource: Readonly<SourceBodyCursor> | null = null;
    let decodedTarget: Readonly<SourceBodyCursor> | null = null;
    while (true) {
      const frame = this.#worker.takeFrame();
      if (frame === undefined) break;
      if (frame.generation !== this.#generation) {
        frame.close();
        staleFrames += 1;
        this.#staleFrames += 1;
        this.#onTrace("stale-output", null, "obsolete-generation");
        continue;
      }
      const output = this.#expected.shift();
      if (output === undefined) {
        frame.close();
        throw new RangeError("worker produced an unplanned path frame");
      }
      validateManagedOutput(frame, output.sample);
      decodedFrames += 1;
      decodedCursor = Object.freeze({
        path: this.#requirePath(),
        unit: frame.unitId,
        unitInstance: frame.unitInstance,
        localFrame: frame.unitFrame
      });
      if (output.plan.sourceCursor !== null && !output.plan.discard) {
        decodedSource = Object.freeze({ ...output.plan.sourceCursor });
      }
      if (output.plan.targetCursor !== null && !output.plan.discard) {
        decodedTarget = Object.freeze({ ...output.plan.targetCursor });
      }
      if (output.plan.discard) {
        frame.close();
        discardedFrames += 1;
        this.#discardedDependencyFrames += 1;
        this.#onTrace("discard-output", output, null);
        continue;
      }
      if (output.expected === null) {
        frame.close();
        throw new Error("presentable output has no ring identity");
      }
      const enqueue = this.#requireRing().enqueue({
        expected: output.expected,
        frame,
        workerOutputTimeMs: this.#now(),
        uploadReadyTimeMs: null
      });
      if (enqueue.kind === "accepted") {
        this.#ringPlans.push(output);
      } else {
        staleFrames += 1;
        this.#staleFrames += 1;
      }
      this.#onTrace("output", output, null);
    }
    return Object.freeze({
      decodedFrames,
      discardedFrames,
      staleFrames,
      decodedCursor,
      decodedSource,
      decodedTarget
    });
  }

  public mediaFor(
    output: Readonly<PathSchedulerExpectedOutput>
  ): Extract<RuntimeMediaPresentation, { readonly kind: "frame" }> {
    const expected = output.expected;
    if (expected === null) throw new Error("media output has no identity");
    return Object.freeze({
      kind: "frame",
      graphKind: output.plan.graphKind,
      state: output.plan.state,
      edge: output.plan.edge,
      path: expected.path,
      frame: Object.freeze({
        rendition: this.#rendition,
        unit: expected.unitId,
        localFrame: expected.unitFrame
      }),
      drawSource: "streaming",
      generation: expected.generation,
      unitInstance: expected.unitInstance,
      decodeOrdinal: expected.decodeOrdinal,
      timestamp: expected.timestamp,
      intendedPresentationOrdinal: expected.intendedPresentationOrdinal
    });
  }

  #clearQueues(): void {
    this.#expected.length = 0;
    this.#ringPlans.length = 0;
    this.#resident.length = 0;
  }

  #now(): number {
    const value = this.#clock.now();
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError("scheduler clock must be finite and non-negative");
    }
    return value;
  }

  #requireRing(): PresentationRing {
    if (this.#ring === null) {
      throw new RangeError("path scheduler has no presentation ring");
    }
    return this.#ring;
  }

  #requireGeneration(): number {
    if (this.#generation === null) {
      throw new RangeError("path scheduler output has no active generation");
    }
    return this.#generation;
  }

  #requirePath(): string {
    if (this.#path === null) {
      throw new RangeError("path scheduler output has no active path");
    }
    return this.#path;
  }
}

function validateManagedOutput(
  frame: ManagedDecoderWorkerFrame,
  sample: Readonly<DecoderWorkerSample>
): void {
  if (
    frame.ordinal !== sample.ordinal ||
    frame.unitId !== sample.unitId ||
    frame.unitInstance !== sample.unitInstance ||
    frame.unitFrame !== sample.unitFrame ||
    frame.timestamp !== sample.timestamp ||
    frame.duration !== sample.duration
  ) {
    frame.close();
    throw new RangeError("worker output did not match submitted path identity");
  }
}
