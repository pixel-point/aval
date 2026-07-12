import {
  GRAPH_LIMITS,
  type GraphPresentation,
  type MotionGraphResult,
  type MotionGraphSnapshot
} from "@rendered-motion/graph";

import type { EffectHostEvent } from "./effect-host.js";
import type { IntegratedPlayer } from "./integrated-player.js";
import {
  RUNTIME_TRACE_CAPACITY,
  type RuntimeMediaPresentation,
  type RuntimeTraceRecord
} from "./model.js";

export interface TrackedFuzzRequest {
  readonly id: number;
  readonly target: string;
  readonly visualAtIssue: string | null;
  readonly issuedOrder: number;
  readonly observed: Promise<void>;
  status: "pending" | "resolved" | "rejected";
  errorName: string | null;
  settlementOrder: number | null;
}

export interface FuzzCleanupFactoryView {
  readonly activeAttempts: number;
  readonly sessions: readonly { readonly disposed: boolean }[];
}

export interface FuzzCleanupStoreView {
  readonly disposed: boolean;
  readonly activePresentations: number;
  readonly maximumActivePresentations: number;
}

export interface FuzzPlaybackBoundsView {
  traceState(): {
    readonly scheduler: {
      readonly generation: number | null;
      readonly ringSize: number;
      readonly ringCapacity: number;
    };
  };
}

export class FuzzRecorder {
  public readonly entries: string[] = [];
  public step = -100;

  readonly #seed: number;

  public constructor(seed: number) {
    this.#seed = seed;
  }

  public setStep(step: number): void {
    this.step = step;
  }

  public push(value: string): number {
    this.entries.push(value);
    return this.entries.length;
  }

  public recordDraw(tag: string): void {
    this.push(`draw:${tag}`);
  }

  public recordEvent(event: Readonly<EffectHostEvent>): void {
    const tag = fuzzEventTag(event);
    const order = this.push(`event:${tag}`);
    if (event.type === "visualstatechange") {
      const previous = this.entries[order - 2];
      fuzzInvariant(
        previous?.startsWith("draw:") === true &&
          drawRepresentsState(previous, event.to),
        this,
        "visual state committed without its exact preceding draw"
      );
    } else if (event.type === "transitionend") {
      fuzzInvariant(
        this.entries[order - 2] ===
          `event:visualstatechange:${event.from}->${event.to}`,
        this,
        "transition ended before its visual commit"
      );
    }
  }

  public wrap(error: unknown): Error {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("seed=0x")) {
      return error instanceof Error ? error : new Error(message);
    }
    return new Error(
      `seed=0x${this.#seed.toString(16)} step=${String(this.step)}: ${message}; recent=${JSON.stringify(this.entries.slice(-16))}`,
      { cause: error }
    );
  }

  public failure(message: string): Error {
    return new Error(
      `seed=0x${this.#seed.toString(16)} step=${String(this.step)}: ${message}; recent=${JSON.stringify(this.entries.slice(-16))}`
    );
  }
}

export function assertFuzzLiveBounds(
  player: IntegratedPlayer,
  session: FuzzPlaybackBoundsView,
  recorder: FuzzRecorder
): void {
  const snapshot = player.snapshot();
  fuzzInvariant(
    snapshot.readiness === "interactiveReady",
    recorder,
    "readiness drifted"
  );
  const trace = session.traceState();
  fuzzInvariant(
    trace.scheduler.ringSize >= 0 &&
      trace.scheduler.ringSize <= trace.scheduler.ringCapacity,
    recorder,
    "scheduler ring escaped its capacity"
  );
  fuzzInvariant(
    trace.scheduler.generation !== null && trace.scheduler.generation >= 1,
    recorder,
    "scheduler generation is invalid"
  );
}

export function assertFuzzConverged(
  player: IntegratedPlayer,
  target: string,
  recorder: FuzzRecorder,
  label: string
): void {
  const snapshot = player.snapshot();
  fuzzInvariant(
    snapshot.requestedState === target &&
      snapshot.visualState === target &&
      !snapshot.isTransitioning,
    recorder,
    `${label} did not converge to ${target}`
  );
}

export function assertFuzzRequestOrdering(
  requests: readonly TrackedFuzzRequest[],
  recorder: FuzzRecorder
): void {
  for (const request of requests) {
    fuzzInvariant(
      request.status !== "pending",
      recorder,
      `request ${String(request.id)} is pending`
    );
    fuzzInvariant(
      request.settlementOrder !== null,
      recorder,
      "settled request has no order"
    );
    if (
      request.status !== "resolved" ||
      request.visualAtIssue === request.target
    ) continue;
    const committed = recorder.entries.findIndex((entry, index) =>
      index + 1 > request.issuedOrder &&
      index + 1 < request.settlementOrder! &&
      entry.startsWith("event:transitionend:") &&
      entry.endsWith(`->${request.target}`)
    );
    fuzzInvariant(
      committed >= 0,
      recorder,
      `request ${String(request.id)} settled before target commit`
    );
  }
}

export function assertIntegratedFuzzTrace(
  trace: readonly Readonly<RuntimeTraceRecord>[],
  recorder: FuzzRecorder
): void {
  fuzzInvariant(
    trace.length === RUNTIME_TRACE_CAPACITY,
    recorder,
    "integrated trace did not exercise its exact capacity"
  );
  let expectedOrdinal: bigint | null = null;
  let previousGeneration = 0;
  let previousCounters = {
    underflows: 0,
    fallbacks: 0,
    settledRequests: 0,
    cleanedFrames: 0
  };
  for (let index = 0; index < trace.length; index += 1) {
    const record = trace[index]!;
    fuzzInvariant(Object.isFrozen(record), recorder, "trace record is mutable");
    if (index > 0) {
      fuzzInvariant(
        record.index === trace[index - 1]!.index + 1,
        recorder,
        "trace indexes are not consecutive"
      );
    }
    const scheduler = record.scheduler;
    fuzzInvariant(
      scheduler.ringCapacity === 6 &&
        scheduler.ringSize >= 0 &&
        scheduler.ringSize <= scheduler.ringCapacity,
      recorder,
      "trace scheduler bounds diverged"
    );
    const generation = scheduler.generation ?? previousGeneration;
    fuzzInvariant(generation >= previousGeneration, recorder, "generation regressed");
    previousGeneration = generation;
    fuzzInvariant(
      record.submitted.length <= 1,
      recorder,
      "submitted trace is unbounded"
    );
    if (record.graph !== null) {
      fuzzInvariant(
        record.graph.snapshot.inputsSinceTick <= GRAPH_LIMITS.maxInputsPerTick,
        recorder,
        "graph input window exceeded its cap"
      );
      fuzzInvariant(
        record.settledRequestIds.every((id, position, ids) =>
          position === 0 || ids[position - 1]! < id
        ),
        recorder,
        "settlement IDs are not unique and ordered"
      );
    }
    if (record.kind === "content-tick") {
      const ordinal = record.presentationOrdinal;
      fuzzInvariant(ordinal !== null, recorder, "content trace has no ordinal");
      if (expectedOrdinal === null) expectedOrdinal = ordinal;
      fuzzInvariant(
        ordinal === expectedOrdinal,
        recorder,
        "content ordinal skipped or regressed"
      );
      if (record.media === null) {
        fuzzInvariant(
          record.graph === null && record.readbackTag === null,
          recorder,
          "underflow trace retained graph/media output"
        );
      } else {
        assertContentIdentity(record, ordinal, recorder);
        expectedOrdinal += 1n;
      }
    }
    const counters = record.counters;
    fuzzInvariant(
      counters.underflows >= previousCounters.underflows &&
        counters.fallbacks >= previousCounters.fallbacks &&
        counters.settledRequests >= previousCounters.settledRequests &&
        counters.cleanedFrames >= previousCounters.cleanedFrames,
      recorder,
      "trace counters regressed"
    );
    previousCounters = counters;
  }
  fuzzInvariant(
    trace.some(({ kind }) => kind === "fallback"),
    recorder,
    "no failure trace"
  );
  fuzzInvariant(
    trace.at(-1)?.kind === "fallback" &&
      trace.at(-1)?.readiness === "staticReady",
    recorder,
    "recovery is not the final animated trace"
  );
}

export function assertFuzzCleanup(
  player: IntegratedPlayer,
  factory: FuzzCleanupFactoryView,
  store: FuzzCleanupStoreView,
  requests: readonly TrackedFuzzRequest[],
  recorder: FuzzRecorder
): void {
  fuzzInvariant(player.catalog.disposed, recorder, "catalog leaked");
  fuzzInvariant(store.disposed, recorder, "static store leaked");
  fuzzInvariant(
    store.activePresentations === 0,
    recorder,
    "static presentation leaked"
  );
  fuzzInvariant(
    store.maximumActivePresentations === 1,
    recorder,
    "static operations overlapped"
  );
  fuzzInvariant(factory.activeAttempts === 0, recorder, "candidate attempt leaked");
  fuzzInvariant(
    factory.sessions.every(({ disposed }) => disposed),
    recorder,
    "session leaked"
  );
  fuzzInvariant(
    requests.every(({ status }) => status !== "pending"),
    recorder,
    "request leaked"
  );
  fuzzInvariant(
    player.snapshot().disposed && player.snapshot().readiness === "disposed",
    recorder,
    "player did not terminalize disposal"
  );
}

export function assertFuzzMirrorResult(
  actual: Readonly<MotionGraphResult>,
  expected: Readonly<MotionGraphResult>,
  recorder: FuzzRecorder
): void {
  fuzzInvariant(
    stable(actual) === stable(expected),
    recorder,
    `playback mirror diverged: actual=${stable(actual)} expected=${stable(expected)}`
  );
}

export function assertFuzzMirrorSnapshot(
  actual: Readonly<MotionGraphSnapshot>,
  expected: Readonly<MotionGraphSnapshot>,
  recorder: FuzzRecorder
): void {
  fuzzInvariant(
    stable(actual) === stable(expected),
    recorder,
    `playback snapshot diverged: actual=${stable(actual)} expected=${stable(expected)}`
  );
}

export function fuzzPresentationTag(
  presentation: Readonly<GraphPresentation>
): string {
  switch (presentation.kind) {
    case "static":
      return `static:${presentation.state}:${presentation.staticFrameId}`;
    case "intro":
    case "body":
      return `${presentation.kind}:${presentation.state}:${presentation.unitId}:${String(presentation.frameIndex)}`;
    case "locked":
    case "reversible":
      return `${presentation.kind}:${presentation.edgeId}:${presentation.unitId}:${String(presentation.frameIndex)}`;
  }
}

export function fuzzMediaTag(media: Readonly<RuntimeMediaPresentation>): string {
  if (media.kind === "static") {
    return `static:${media.state}:${media.staticFrame}`;
  }
  return `${media.graphKind}:${media.state ?? media.edge}:${media.frame.unit}:${String(media.frame.localFrame)}`;
}

export function summarizeIntegratedFuzzTrace(
  record: Readonly<RuntimeTraceRecord>
): unknown {
  return Object.freeze({
    index: record.index,
    kind: record.kind,
    ordinal: record.presentationOrdinal,
    graph: record.graph?.presentation === undefined ||
      record.graph.presentation === null
      ? null
      : fuzzPresentationTag(record.graph.presentation),
    media: record.media === null ? null : fuzzMediaTag(record.media),
    generation: record.scheduler.generation,
    readiness: record.readiness,
    counters: record.counters
  });
}

export function fuzzInvariant(
  condition: unknown,
  recorder: FuzzRecorder,
  message: string
): asserts condition {
  if (!condition) throw recorder.failure(message);
}

function assertContentIdentity(
  record: Readonly<RuntimeTraceRecord>,
  ordinal: bigint,
  recorder: FuzzRecorder
): void {
  const media = record.media;
  fuzzInvariant(media?.kind === "frame", recorder, "animated trace is static media");
  const presentation = record.graph?.presentation;
  fuzzInvariant(
    presentation !== null && presentation !== undefined &&
      fuzzPresentationTag(presentation) === fuzzMediaTag(media),
    recorder,
    "graph/media identity diverged in trace"
  );
  fuzzInvariant(
    media.intendedPresentationOrdinal === ordinal &&
      media.decodeOrdinal === Number(ordinal),
    recorder,
    "media ordinal identity diverged"
  );
  fuzzInvariant(
    record.readbackTag === `readback:${fuzzPresentationTag(presentation)}`,
    recorder,
    "readback identity diverged"
  );
  fuzzInvariant(
    record.graph?.snapshot.contentOrdinal === ordinal - 1n,
    recorder,
    "graph content ordinal diverged"
  );
}

function fuzzEventTag(event: Readonly<EffectHostEvent>): string {
  switch (event.type) {
    case "readinesschange":
      return `readinesschange:${event.from}->${event.to}`;
    case "requestedstatechange":
      return `requestedstatechange:${event.from}->${event.to}`;
    case "transitionstart":
      return `transitionstart:${event.from}->${event.to}`;
    case "visualstatechange":
      return `visualstatechange:${event.from}->${event.to}`;
    case "transitionend":
      return `transitionend:${event.from}->${event.to}`;
    case "fallback":
      return `fallback:${event.reason}`;
  }
}

function drawRepresentsState(entry: string, state: string): boolean {
  return entry === `draw:static:${state}` ||
    entry.startsWith(`draw:animated:body:${state}:`) ||
    entry.startsWith(`draw:animated:intro:${state}:`);
}

function stable(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === "bigint" ? `${item.toString()}n` : item
  );
}
