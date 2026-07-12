import {
  MotionGraphEngine,
  type GraphPresentation,
  type MotionGraphResult,
  type MotionGraphSnapshot,
  type ValidatedMotionGraph
} from "@rendered-motion/graph";

import {
  RuntimePlaybackError,
  normalizeRuntimeFailure
} from "./errors.js";
import {
  type IntegratedCandidateAttempt,
  type IntegratedCandidateAttemptContext,
  type IntegratedCandidateFactory,
  type IntegratedPlaybackSession,
  type IntegratedPlaybackTickContext,
  type IntegratedPlaybackTraceState,
  type IntegratedPreparedActivation,
  type IntegratedPreparedContentTick,
  type IntegratedStaticSurfaceStore
} from "./integrated-player.js";
import { createIntegratedActivationPresentation } from "./integrated-player-support.js";
import {
  assertFuzzMirrorResult,
  assertFuzzMirrorSnapshot,
  fuzzInvariant,
  fuzzPresentationTag,
  type FuzzRecorder
} from "./integrated-player-fuzz-oracle.js";
import type {
  RuntimeMediaCursor,
  RuntimeMediaPresentation,
  RuntimeSchedulerSnapshot
} from "./model.js";

export type FuzzFailurePhase = "prepare" | "draw";

export class FuzzCandidateFactory implements IntegratedCandidateFactory {
  public readonly availability = Object.freeze({
    workerAvailable: true,
    rendererAvailable: true
  });
  public activeAttempts = 0;
  public maximumActiveAttempts = 0;
  public readonly sessions: FuzzPlaybackSession[] = [];

  readonly #recorder: FuzzRecorder;
  readonly #failHigh: boolean;
  readonly #preparationTargets: string[] = [];
  #session: FuzzPlaybackSession | null = null;

  public constructor(recorder: FuzzRecorder, failHigh: boolean) {
    this.#recorder = recorder;
    this.#failHigh = failHigh;
  }

  public get session(): FuzzPlaybackSession {
    if (this.#session === null) throw new Error("fuzz candidate has no session");
    return this.#session;
  }

  public noteRequest(target: string): void {
    if (this.#session === null || this.#session.disposed) {
      this.#preparationTargets.push(target);
    } else {
      this.#session.queueRequest(target);
    }
  }

  public create(
    context: Readonly<IntegratedCandidateAttemptContext>
  ): IntegratedCandidateAttempt {
    const rendition = context.candidate.rendition.id;
    const session = new FuzzPlaybackSession({
      graph: context.catalog.graph,
      rendition,
      preparationTargets: this.#preparationTargets,
      recorder: this.#recorder
    });
    this.#session = session;
    this.sessions.push(session);
    this.activeAttempts += 1;
    this.maximumActiveAttempts = Math.max(
      this.maximumActiveAttempts,
      this.activeAttempts
    );
    this.#recorder.push(`candidate:create:${rendition}`);
    let disposed = false;
    let activation: Readonly<IntegratedPreparedActivation> | null = null;
    return {
      playback: session,
      prepare: async () => {
        this.#recorder.push(`candidate:prepare:${rendition}`);
        if (this.#failHigh && rendition === "opaque-high") {
          throw new RuntimePlaybackError(normalizeRuntimeFailure(
            "readiness-failure",
            "seeded high-candidate readiness failure",
            { rendition }
          ));
        }
      },
      prepareActivation: async (options) => {
        const expected = createIntegratedActivationPresentation(
          context.catalog.graph,
          options.graphSnapshot
        );
        fuzzInvariant(
          fuzzPresentationTag(expected) ===
            fuzzPresentationTag(options.expectedPresentation),
          this.#recorder,
          "activation used a stale graph snapshot"
        );
        session.assertSnapshot(options.graphSnapshot);
        activation = Object.freeze({
          expectedPresentation: options.expectedPresentation
        });
        this.#recorder.push(
          `candidate:activation:${rendition}:${fuzzPresentationTag(expected)}`
        );
        return activation;
      },
      drawInitial: (token, presentation) => {
        fuzzInvariant(
          token === activation,
          this.#recorder,
          "initial draw token was fabricated"
        );
        fuzzInvariant(
          fuzzPresentationTag(token.expectedPresentation) ===
            fuzzPresentationTag(presentation),
          this.#recorder,
          "initial draw presentation diverged"
        );
        session.drawInitial(presentation);
      },
      dispose: () => {
        if (disposed) return;
        disposed = true;
        session.dispose();
        this.activeAttempts -= 1;
        this.#recorder.push(`candidate:dispose:${rendition}`);
      }
    };
  }
}

export class FuzzPlaybackSession implements IntegratedPlaybackSession {
  public disposed = false;

  readonly #mirror = new MotionGraphEngine();
  readonly #rendition: string;
  readonly #recorder: FuzzRecorder;
  readonly #requestTargets: string[] = [];
  #predicted: Readonly<MotionGraphResult> | null = null;
  #lastCursor: Readonly<RuntimeMediaCursor> | null = null;
  #lastMedia: Readonly<RuntimeMediaPresentation> | null = null;
  #path: string | null = null;
  #generation = 1;
  #routeReady = true;
  #underflow = false;
  #failure: FuzzFailurePhase | null = null;

  public constructor(options: {
    readonly graph: Readonly<ValidatedMotionGraph>;
    readonly rendition: string;
    readonly preparationTargets: readonly string[];
    readonly recorder: FuzzRecorder;
  }) {
    this.#rendition = options.rendition;
    this.#recorder = options.recorder;
    this.#mirror.install(options.graph);
    for (const target of options.preparationTargets) this.#mirror.request(target);
  }

  public queueRequest(target: string): void {
    this.#requestTargets.push(target);
  }

  public configureNext(options: {
    readonly routeReady: boolean;
    readonly underflow: boolean;
  }): void {
    this.#routeReady = options.routeReady;
    this.#underflow = options.underflow;
  }

  public failNext(phase: FuzzFailurePhase): void {
    this.#failure = phase;
  }

  public assertSnapshot(snapshot: Readonly<MotionGraphSnapshot>): void {
    assertFuzzMirrorSnapshot(snapshot, this.#mirror.snapshot(), this.#recorder);
  }

  public drawInitial(presentation: Readonly<GraphPresentation>): void {
    this.#recorder.recordDraw(`animated:${fuzzPresentationTag(presentation)}`);
  }

  public synchronizeGraph(result: Readonly<MotionGraphResult>): void {
    let mirrored: Readonly<MotionGraphResult>;
    switch (result.operation) {
      case "begin-animated":
        mirrored = this.#mirror.beginAnimated();
        if (mirrored.presentation !== null) {
          this.#path = pathFor(mirrored.presentation);
        }
        break;
      case "request": {
        const target = this.#requestTargets.shift();
        fuzzInvariant(
          target !== undefined,
          this.#recorder,
          "request target tape underflowed"
        );
        mirrored = this.#mirror.request(target);
        break;
      }
      case "tick":
        fuzzInvariant(
          this.#predicted !== null,
          this.#recorder,
          "tick was not predicted"
        );
        mirrored = this.#predicted;
        this.#predicted = null;
        break;
      default:
        return;
    }
    assertFuzzMirrorResult(result, mirrored, this.#recorder);
  }

  public prepareContentTick(
    input: Readonly<IntegratedPlaybackTickContext>
  ): Readonly<IntegratedPreparedContentTick> | null {
    this.assertSnapshot(input.graphSnapshot);
    if (this.#failure === "prepare") {
      this.#failure = null;
      throw new Error("seeded worker preparation failure");
    }
    if (this.#underflow) {
      this.#underflow = false;
      return null;
    }
    fuzzInvariant(
      this.#predicted === null,
      this.#recorder,
      "prediction leaked across ticks"
    );
    const predicted = this.#mirror.tick({
      contentOrdinal: input.presentationOrdinal - 1n,
      routeReady: this.#routeReady
    });
    const presentation = predicted.presentation;
    fuzzInvariant(
      presentation !== null && presentation.kind !== "static",
      this.#recorder,
      "animated tick predicted no animated presentation"
    );
    const path = pathFor(presentation);
    if (this.#path !== null && path !== this.#path) this.#generation += 1;
    this.#path = path;
    const media = mediaFor(
      presentation,
      this.#rendition,
      input.presentationOrdinal,
      this.#generation,
      path
    );
    const cursor = Object.freeze({
      path,
      unit: media.frame.unit,
      unitInstance: media.unitInstance,
      localFrame: media.frame.localFrame
    });
    this.#predicted = predicted;
    this.#lastMedia = media;
    this.#lastCursor = cursor;
    return Object.freeze({
      routeReady: this.#routeReady,
      selectedBoundary: this.#routeReady
        ? `boundary:${fuzzPresentationTag(presentation)}`
        : null,
      scheduler: schedulerSnapshot(this.#generation, path, cursor),
      submitted: Object.freeze([cursor]),
      media,
      decodeLeadFrames: 6
    });
  }

  public drawContentTick(
    prepared: Readonly<IntegratedPreparedContentTick>,
    presentation: Readonly<GraphPresentation>
  ): string {
    fuzzInvariant(
      prepared.media === this.#lastMedia,
      this.#recorder,
      "draw token changed"
    );
    const tag = fuzzPresentationTag(presentation);
    if (this.#failure === "draw") {
      this.#failure = null;
      this.#recorder.push(`draw-failure:animated:${tag}`);
      throw new Error("seeded renderer draw failure");
    }
    this.#recorder.recordDraw(`animated:${tag}`);
    return `readback:${tag}`;
  }

  public traceState(): Readonly<IntegratedPlaybackTraceState> {
    return Object.freeze({
      selectedBoundary: null,
      scheduler: schedulerSnapshot(
        this.#generation,
        this.#path ?? "path:initial",
        this.#lastCursor
      ),
      submitted: Object.freeze([]),
      decodeLeadFrames: 6
    });
  }

  public dispose(): void {
    this.disposed = true;
  }
}

export class FuzzStaticStore implements IntegratedStaticSurfaceStore {
  public readonly presented: string[] = [];
  public disposed = false;
  public activePresentations = 0;
  public maximumActivePresentations = 0;

  readonly #recorder: FuzzRecorder;
  #lastPresented = "idle";

  public constructor(recorder: FuzzRecorder) {
    this.#recorder = recorder;
  }

  public async installInitial(options: {
    readonly state: string;
    readonly signal: AbortSignal;
  }): Promise<void> {
    throwIfAborted(options.signal);
    this.#lastPresented = options.state;
    this.#recorder.push(`static:install:${options.state}`);
  }

  public async validateAll(options: { readonly signal: AbortSignal }): Promise<void> {
    throwIfAborted(options.signal);
    this.#recorder.push("static:validate-all");
  }

  public async presentState(
    state: string,
    options: { readonly signal: AbortSignal }
  ): Promise<void> {
    throwIfAborted(options.signal);
    this.activePresentations += 1;
    this.maximumActivePresentations = Math.max(
      this.maximumActivePresentations,
      this.activePresentations
    );
    try {
      this.#recorder.push(`static:present:${state}`);
      await Promise.resolve();
      throwIfAborted(options.signal);
      this.#lastPresented = state;
      this.presented.push(state);
    } finally {
      this.activePresentations -= 1;
    }
  }

  public coverCurrent(): void {
    this.#recorder.recordDraw(`static:${this.#lastPresented}`);
  }

  public revealAnimated(): void {
    this.#recorder.push("static:reveal-animated");
  }

  public async settled(): Promise<void> {}

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.#recorder.push("static:dispose");
  }
}

export class IdleFuzzTimers {
  #next = 1;

  public setTimeout(_callback: () => void, _milliseconds: number): number {
    const handle = this.#next;
    this.#next += 1;
    return handle;
  }

  public clearTimeout(_handle: number): void {}
}

function mediaFor(
  presentation: Exclude<Readonly<GraphPresentation>, { readonly kind: "static" }>,
  rendition: string,
  ordinal: bigint,
  generation: number,
  path: string
): Extract<RuntimeMediaPresentation, { readonly kind: "frame" }> {
  const state = presentation.kind === "body" || presentation.kind === "intro"
    ? presentation.state
    : null;
  const edge = presentation.kind === "locked" || presentation.kind === "reversible"
    ? presentation.edgeId
    : null;
  return Object.freeze({
    kind: "frame",
    graphKind: presentation.kind,
    state,
    edge,
    path,
    frame: Object.freeze({
      rendition,
      unit: presentation.unitId,
      localFrame: presentation.frameIndex
    }),
    drawSource: presentation.kind === "reversible" ? "resident" : "streaming",
    generation,
    unitInstance: generation,
    decodeOrdinal: Number(ordinal),
    timestamp: Number(ordinal) * 33_333,
    intendedPresentationOrdinal: ordinal
  });
}

function schedulerSnapshot(
  generation: number,
  path: string,
  cursor: Readonly<RuntimeMediaCursor> | null
): Readonly<RuntimeSchedulerSnapshot> {
  return Object.freeze({
    generation,
    activePath: path,
    sourceCursor: cursor,
    submittedCursor: cursor,
    decodedCursor: cursor,
    displayedCursor: cursor,
    ringSize: cursor === null ? 0 : 6,
    ringCapacity: 6,
    smoothSession: true
  });
}

function pathFor(presentation: Readonly<GraphPresentation>): string {
  if (presentation.kind === "static") return `path:static:${presentation.state}`;
  if (presentation.kind === "body" || presentation.kind === "intro") {
    return `path:state:${presentation.state}`;
  }
  return `path:edge:${presentation.edgeId}`;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException("fuzz operation aborted", "AbortError");
  }
}
