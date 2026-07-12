import type { GraphPresentation, MotionGraphResult } from "@rendered-motion/graph";
import { describe, expect, it } from "vitest";

import { createIntegratedOpaqueTestAsset } from "./asset-test-fixture.js";
import {
  IntegratedPlayer,
  type IntegratedCandidateAttempt,
  type IntegratedCandidateFactory,
  type IntegratedPlaybackSession,
  type IntegratedPlaybackTickContext,
  type IntegratedPreparedContentTick,
  type IntegratedStaticSurfaceStore
} from "./integrated-player.js";
import {
  integratedActivationPresentationOrdinal
} from "./integrated-player-support.js";

describe("IntegratedPlayer realtime clock ownership", () => {
  it("owns the RAF callback, advances the integrated tick, and cancels on disposal", async () => {
    const frames = new ManualFrames();
    const factory = new RealtimeCandidateFactory();
    const player = new IntegratedPlayer({
      bytes: createIntegratedOpaqueTestAsset(),
      createStaticStore: () => new ImmediateStaticStore(),
      candidateFactory: factory,
      realtime: {
        requestFrame: frames.request,
        cancelFrame: frames.cancel,
        now: () => 0
      },
      now: () => 0,
      timers: new IdleTimers()
    });

    expect(() => player.startRealtime()).toThrow("interactive readiness");
    await player.prepare();
    expect(() => player.tryContentTick({
      presentationOrdinal: 1n,
      rationalDeadlineUs: 33_333
    })).toThrow("manual content ticks");
    player.startRealtime();
    player.startRealtime();
    expect(frames.requestCount).toBe(1);

    frames.run(34);

    expect(factory.session.draws).toBe(1);
    expect(factory.session.tickContexts[0]).toMatchObject({
      presentationOrdinal: 1n,
      rationalDeadlineUs: 33_333
    });
    expect(player.getTrace().filter(({ kind }) => kind === "content-tick")).toMatchObject([{
      presentationOrdinal: 1n,
      rationalDeadlineUs: 33_333,
      callbackStartMicroseconds: 0,
      canvasSubmissionCompleteMicroseconds: 0,
      eligibleAnimationFrameOrdinal: 1
    }]);
    expect(player.realtimeSnapshot()).toMatchObject({
      running: true,
      advancedTicks: 1,
      nextPresentationOrdinal: 2n
    });
    expect(frames.hasPending).toBe(true);

    const pending = frames.pendingId;
    await player.dispose();
    expect(frames.cancelled).toEqual([pending]);
    expect(player.realtimeSnapshot()).toMatchObject({
      running: false,
      disposed: true
    });
  });

  it.each(["throw", "reenter"] as const)(
    "keeps a submitted frame committed when the post-draw timing clock tries to %s",
    async (hostility) => {
      const frames = new ManualFrames();
      const factory = new RealtimeCandidateFactory();
      const diagnostics: string[] = [];
      let player: IntegratedPlayer;
      let hostileObservation = false;
      const observationalClock = (): number => {
        if (factory.session.draws > 0 && !hostileObservation) {
          hostileObservation = true;
          if (hostility === "throw") throw new Error("hostile observational clock");
          player.startRealtime();
        }
        return 0;
      };
      player = new IntegratedPlayer({
        bytes: createIntegratedOpaqueTestAsset(),
        createStaticStore: () => new ImmediateStaticStore(),
        candidateFactory: factory,
        diagnosticsSink: (failure) => diagnostics.push(failure.code),
        realtime: {
          requestFrame: frames.request,
          cancelFrame: frames.cancel,
          now: observationalClock
        },
        now: observationalClock,
        timers: new IdleTimers()
      });
      await player.prepare();
      player.startRealtime();

      expect(() => frames.run(34)).not.toThrow();

      expect(hostileObservation).toBe(true);
      expect(factory.session.draws).toBe(1);
      expect(player.snapshot()).toMatchObject({ readiness: "interactiveReady", visualState: "idle" });
      expect(player.realtimeSnapshot()).toMatchObject({ advancedTicks: 1, nextPresentationOrdinal: 2n });
      expect(player.getTrace().filter(({ kind }) => kind === "content-tick")).toMatchObject([{
        presentationOrdinal: 1n,
        canvasSubmissionCompleteMicroseconds: null
      }]);
      expect(diagnostics).toEqual([]);
      await player.dispose();
    }
  );

  it("isolates a throwing underflow observer and retries the same ordinal", async () => {
    const frames = new ManualFrames();
    const factory = new RealtimeCandidateFactory();
    factory.session.available = false;
    const player = new IntegratedPlayer({
      bytes: createIntegratedOpaqueTestAsset(),
      createStaticStore: () => new ImmediateStaticStore(),
      candidateFactory: factory,
      realtime: {
        requestFrame: frames.request,
        cancelFrame: frames.cancel,
        now: () => 0,
        onUnderflow: () => {
          throw new Error("injected observer failure");
        }
      },
      timers: new IdleTimers()
    });
    await player.prepare();
    player.startRealtime();

    expect(() => frames.run(34)).not.toThrow();
    expect(player.realtimeSnapshot()).toMatchObject({
      running: true,
      underflows: 1,
      nextPresentationOrdinal: 1n
    });
    factory.session.available = true;
    expect(() => frames.run(35)).not.toThrow();
    expect(player.realtimeSnapshot()).toMatchObject({
      running: true,
      advancedTicks: 1,
      nextPresentationOrdinal: 2n
    });

    await player.dispose();
  });

  it("cancels the pending RAF immediately when request recovery starts", async () => {
    const frames = new ManualFrames();
    const factory = new RealtimeCandidateFactory();
    const player = new IntegratedPlayer({
      bytes: createIntegratedOpaqueTestAsset(),
      createStaticStore: () => new ImmediateStaticStore(),
      candidateFactory: factory,
      realtime: {
        requestFrame: frames.request,
        cancelFrame: frames.cancel,
        now: () => 0
      },
      timers: new IdleTimers()
    });
    await player.prepare();
    player.startRealtime();
    const pending = frames.pendingId;
    factory.session.failSynchronize = true;

    const request = player.requestState("hover");
    await player.settled();
    await request;

    expect(frames.cancelled).toEqual([pending]);
    expect(player.realtimeSnapshot()).toMatchObject({
      running: false,
      smoothSession: false
    });
    expect(player.snapshot()).toMatchObject({
      readiness: "staticReady",
      requestedState: "hover",
      visualState: "hover"
    });
    await player.dispose();
  });

  it("rejects realtime start when no presentation source was configured", async () => {
    const player = new IntegratedPlayer({
      bytes: createIntegratedOpaqueTestAsset(),
      createStaticStore: () => new ImmediateStaticStore(),
      candidateFactory: new RealtimeCandidateFactory(),
      timers: new IdleTimers()
    });
    await player.prepare();

    expect(player.realtimeSnapshot()).toBeNull();
    expect(() => player.startRealtime()).toThrow("no realtime");
    await player.dispose();
  });

  it("pauses through reduced mode and resumes the same rational ordinal after re-entry", async () => {
    const frames = new ManualFrames();
    const factory = new RealtimeCandidateFactory();
    const player = new IntegratedPlayer({
      bytes: createIntegratedOpaqueTestAsset(),
      createStaticStore: () => new ImmediateStaticStore(),
      candidateFactory: factory,
      realtime: {
        requestFrame: frames.request,
        cancelFrame: frames.cancel,
        now: () => 0
      },
      timers: new IdleTimers()
    });
    await player.prepare();
    player.startRealtime();
    const pendingBeforeReduce = frames.pendingId;

    await player.setMotionPolicy("reduce");

    expect(frames.cancelled).toContain(pendingBeforeReduce);
    expect(frames.hasPending).toBe(false);
    expect(player.realtimeSnapshot()).toMatchObject({
      running: false,
      nextPresentationOrdinal: 1n,
      smoothSession: true
    });

    await player.setMotionPolicy("full");

    expect(frames.hasPending).toBe(true);
    expect(player.realtimeSnapshot()).toMatchObject({
      running: true,
      nextPresentationOrdinal: 1n,
      smoothSession: true
    });
    frames.run(34);
    expect(player.realtimeSnapshot()).toMatchObject({
      advancedTicks: 1,
      nextPresentationOrdinal: 2n,
      smoothSession: true
    });
    await player.dispose();
  });

  it("restarts realtime without replaying visibility after cancelled reduction", async () => {
    const frames = new ManualFrames();
    const factory = new RealtimeCandidateFactory();
    const store = new HostileCancellationStaticStore();
    const diagnostics: string[] = [];
    const player = new IntegratedPlayer({
      bytes: createIntegratedOpaqueTestAsset(),
      createStaticStore: () => store,
      candidateFactory: factory,
      diagnosticsSink: (failure) => diagnostics.push(failure.code),
      realtime: {
        requestFrame: frames.request,
        cancelFrame: frames.cancel,
        now: () => 0
      },
      timers: new IdleTimers()
    });
    await player.prepare();
    store.armRevealFailure();
    player.startRealtime();

    const reducing = player.setMotionPolicy("reduce");
    await store.stageStarted;
    const restoring = player.setMotionPolicy("full");
    await Promise.all([reducing, restoring]);

    expect(store.revealCalls).toBe(0);
    expect(diagnostics).not.toContain("renderer-failure");
    expect(frames.hasPending).toBe(true);
    expect(player.realtimeSnapshot()).toMatchObject({
      running: true,
      nextPresentationOrdinal: 1n,
      smoothSession: true
    });
    expect(player.motionSnapshot()).toMatchObject({
      desiredMode: "full",
      actualMode: "animated",
      transition: null
    });

    frames.run(34);
    expect(factory.session.draws).toBe(1);
    await player.dispose();
  });

  it("continues the candidate ordinal after two advances and reduced-motion re-entry", async () => {
    const frames = new ManualFrames();
    const factory = new ContinuingRealtimeCandidateFactory();
    const diagnostics: string[] = [];
    const player = new IntegratedPlayer({
      bytes: createIntegratedOpaqueTestAsset(),
      createStaticStore: () => new ImmediateStaticStore(),
      candidateFactory: factory,
      diagnosticsSink: (failure) => diagnostics.push(failure.code),
      realtime: {
        requestFrame: frames.request,
        cancelFrame: frames.cancel,
        now: () => 0
      },
      timers: new IdleTimers()
    });
    await player.prepare();
    player.startRealtime();

    frames.run(34);
    frames.run(67);
    expect(player.realtimeSnapshot()).toMatchObject({
      advancedTicks: 2,
      nextPresentationOrdinal: 3n,
      smoothSession: true
    });

    await player.setMotionPolicy("reduce");
    await player.setMotionPolicy("full");

    expect(factory.activationOrdinals).toEqual([0n, 2n]);
    expect(factory.sessions[1]?.initialPresentation?.kind).toBe("body");
    expect(player.realtimeSnapshot()).toMatchObject({
      running: true,
      nextPresentationOrdinal: 3n,
      smoothSession: true
    });

    frames.run(100);

    expect(factory.sessions[1]?.tickContexts).toMatchObject([
      { presentationOrdinal: 3n, rationalDeadlineUs: 100_000 }
    ]);
    expect(player.realtimeSnapshot()).toMatchObject({
      running: true,
      advancedTicks: 3,
      nextPresentationOrdinal: 4n,
      smoothSession: true
    });
    expect(player.snapshot().readiness).toBe("interactiveReady");
    expect(diagnostics).toEqual([]);
    await player.dispose();
  });

  it("keeps committed re-entry animated when the RAF host rejects restart", async () => {
    const frames = new ManualFrames();
    const factory = new RealtimeCandidateFactory();
    const diagnostics: Array<{
      readonly code: string;
      readonly operation: string | undefined;
    }> = [];
    let rejectRequest = false;
    const player = new IntegratedPlayer({
      bytes: createIntegratedOpaqueTestAsset(),
      createStaticStore: () => new ImmediateStaticStore(),
      candidateFactory: factory,
      diagnosticsSink: (failure) => diagnostics.push({
        code: failure.code,
        operation: failure.context.operation
      }),
      realtime: {
        requestFrame: (callback) => {
          if (rejectRequest) throw new Error("injected RAF request failure");
          return frames.request(callback);
        },
        cancelFrame: frames.cancel,
        now: () => 0
      },
      timers: new IdleTimers()
    });
    await player.prepare();
    player.startRealtime();
    await player.setMotionPolicy("reduce");
    rejectRequest = true;

    await expect(player.setMotionPolicy("full")).resolves.toMatchObject({
      actualMode: "animated",
      desiredMode: "full"
    });

    expect(player.snapshot()).toMatchObject({
      readiness: "interactiveReady",
      selectedRendition: "opaque-high",
      visualState: "idle"
    });
    expect(player.motionSnapshot()).toMatchObject({
      actualMode: "animated",
      staticOrigin: null,
      stickyFailure: false
    });
    expect(player.realtimeSnapshot()).toMatchObject({ running: false });
    expect(frames.hasPending).toBe(false);
    expect(diagnostics).toContainEqual({
      code: "readiness-failure",
      operation: "reentry-realtime-resume"
    });
    await player.dispose();
  });
});

class ContinuingRealtimeCandidateFactory implements IntegratedCandidateFactory {
  public readonly availability = Object.freeze({
    workerAvailable: true,
    rendererAvailable: true
  });
  public readonly activationOrdinals: bigint[] = [];
  public readonly sessions: ContinuingRealtimePlaybackSession[] = [];

  public create(): IntegratedCandidateAttempt {
    const session = new ContinuingRealtimePlaybackSession();
    this.sessions.push(session);
    return {
      playback: session,
      prepare: async () => undefined,
      prepareActivation: async ({ expectedPresentation, graphSnapshot }) => {
        const ordinal = integratedActivationPresentationOrdinal(graphSnapshot);
        session.activate(ordinal);
        this.activationOrdinals.push(ordinal);
        return Object.freeze({ expectedPresentation });
      },
      drawInitial: (_activation, presentation) => {
        session.initialPresentation = presentation;
      },
      dispose: () => undefined
    };
  }
}

class ContinuingRealtimePlaybackSession implements IntegratedPlaybackSession {
  public readonly tickContexts: Readonly<IntegratedPlaybackTickContext>[] = [];
  public initialPresentation: Readonly<GraphPresentation> | null = null;
  #nextPresentationOrdinal = 1n;
  #cursor: Readonly<{
    path: string;
    unit: string;
    unitInstance: number;
    localFrame: number;
  }> | null = null;

  public activate(activationPresentationOrdinal: bigint): void {
    this.#nextPresentationOrdinal = activationPresentationOrdinal + 1n;
  }

  public prepareContentTick(
    context: Readonly<IntegratedPlaybackTickContext>
  ): Readonly<IntegratedPreparedContentTick> | null {
    this.tickContexts.push(context);
    const predicted = context.previewTick({
      contentOrdinal: context.presentationOrdinal - 1n,
      routeReady: false
    });
    const presentation = predicted.presentation;
    if (
      presentation?.kind !== "intro" &&
      presentation?.kind !== "body"
    ) return null;
    const path = `${presentation.kind}:${presentation.state}`;
    const cursor = Object.freeze({
      path,
      unit: presentation.unitId,
      unitInstance: 0,
      localFrame: presentation.frameIndex
    });
    this.#cursor = cursor;
    return Object.freeze({
      routeReady: false,
      media: Object.freeze({
        kind: "frame" as const,
        graphKind: presentation.kind,
        state: presentation.state,
        edge: null,
        path,
        frame: Object.freeze({
          rendition: "opaque-high",
          unit: presentation.unitId,
          localFrame: presentation.frameIndex
        }),
        drawSource: "streaming" as const,
        generation: 1,
        unitInstance: 0,
        decodeOrdinal: Number(this.#nextPresentationOrdinal),
        timestamp: Number(this.#nextPresentationOrdinal) * 33_333,
        intendedPresentationOrdinal: this.#nextPresentationOrdinal
      }),
      scheduler: scheduler(cursor),
      submitted: Object.freeze([cursor]),
      selectedBoundary: null,
      decodeLeadFrames: 6
    });
  }

  public drawContentTick(): null {
    return null;
  }

  public synchronizeGraph(result: Readonly<MotionGraphResult>): void {
    if (result.operation === "tick") this.#nextPresentationOrdinal += 1n;
  }

  public traceState() {
    return Object.freeze({
      scheduler: scheduler(this.#cursor),
      submitted: this.#cursor === null
        ? Object.freeze([])
        : Object.freeze([this.#cursor]),
      selectedBoundary: null,
      decodeLeadFrames: 6
    });
  }
}

class RealtimeCandidateFactory implements IntegratedCandidateFactory {
  public readonly availability = Object.freeze({
    workerAvailable: true,
    rendererAvailable: true
  });
  public readonly session = new RealtimePlaybackSession();

  public create(): IntegratedCandidateAttempt {
    return {
      playback: this.session,
      prepare: async () => undefined,
      prepareActivation: async ({ expectedPresentation }) =>
        Object.freeze({ expectedPresentation }),
      drawInitial: () => undefined,
      dispose: () => undefined
    };
  }
}

class RealtimePlaybackSession implements IntegratedPlaybackSession {
  public readonly tickContexts: Readonly<IntegratedPlaybackTickContext>[] = [];
  public draws = 0;
  public available = true;
  public failSynchronize = false;
  public graphKind: "intro" | "body" = "intro";

  public prepareContentTick(
    context: Readonly<IntegratedPlaybackTickContext>
  ): Readonly<IntegratedPreparedContentTick> | null {
    this.tickContexts.push(context);
    if (!this.available) return null;
    if (context.presentationOrdinal !== 1n) return null;
    const unit = this.graphKind === "intro" ? "intro" : "idle-body";
    const path = `${this.graphKind}:idle`;
    const cursor = Object.freeze({
      path,
      unit,
      unitInstance: 0,
      localFrame: 1
    });
    return Object.freeze({
      routeReady: false,
      media: Object.freeze({
        kind: "frame" as const,
        graphKind: this.graphKind,
        state: "idle",
        edge: null,
        path,
        frame: Object.freeze({
          rendition: "opaque-high",
          unit,
          localFrame: 1
        }),
        drawSource: "streaming" as const,
        generation: 1,
        unitInstance: 0,
        decodeOrdinal: 1,
        timestamp: 33_333,
        intendedPresentationOrdinal: 1n
      }),
      scheduler: scheduler(cursor),
      submitted: Object.freeze([cursor]),
      selectedBoundary: null,
      decodeLeadFrames: 6
    });
  }

  public drawContentTick(
    _prepared: Readonly<IntegratedPreparedContentTick>,
    _presentation: Readonly<GraphPresentation>
  ): null {
    this.draws += 1;
    return null;
  }

  public synchronizeGraph(_result: Readonly<MotionGraphResult>): void {
    if (this.failSynchronize) throw new Error("injected synchronization failure");
    if (_result.presentation?.kind === "intro" || _result.presentation?.kind === "body") {
      this.graphKind = _result.presentation.kind;
    }
  }

  public traceState() {
    return Object.freeze({
      scheduler: scheduler(null),
      submitted: Object.freeze([]),
      selectedBoundary: null,
      decodeLeadFrames: 6
    });
  }
}

function scheduler(cursor: Readonly<{
  path: string;
  unit: string;
  unitInstance: number;
  localFrame: number;
}> | null) {
  return Object.freeze({
    generation: 1,
    activePath: cursor?.path ?? "intro:idle",
    sourceCursor: cursor,
    submittedCursor: cursor,
    decodedCursor: cursor,
    displayedCursor: cursor,
    ringSize: cursor === null ? 0 : 1,
    ringCapacity: 6,
    smoothSession: true
  });
}

class ImmediateStaticStore implements IntegratedStaticSurfaceStore {
  #state = "idle";
  public async installInitial(options: {
    readonly state: string;
    readonly signal: AbortSignal;
  }): Promise<void> { this.#state = options.state; }
  public async validateAll(): Promise<void> {}
  public async presentState(
    state: string,
    _options: { readonly signal: AbortSignal; readonly cover?: boolean }
  ): Promise<void> { this.#state = state; }
  public currentState(): string | null { return this.#state; }
  public coverCurrent(): void {}
  public revealAnimated(): void {}
  public async settled(): Promise<void> {}
  public dispose(): void {}
}

class HostileCancellationStaticStore extends ImmediateStaticStore {
  public readonly stageStarted: Promise<void>;
  public revealCalls = 0;
  #failReveal = false;
  readonly #resolveStageStarted: () => void;

  public constructor() {
    super();
    let resolve!: () => void;
    this.stageStarted = new Promise<void>((done) => {
      resolve = done;
    });
    this.#resolveStageStarted = resolve;
  }

  public override async presentState(
    _state: string,
    options: { readonly signal: AbortSignal; readonly cover?: boolean }
  ): Promise<void> {
    if (options.cover !== false) return;
    this.#resolveStageStarted();
    await new Promise<never>((_resolve, reject) => {
      const fail = (): void => reject(new DOMException(
        "reduction staging aborted",
        "AbortError"
      ));
      if (options.signal.aborted) fail();
      else options.signal.addEventListener("abort", fail, { once: true });
    });
  }

  public override revealAnimated(): void {
    this.revealCalls += 1;
    if (this.#failReveal) {
      throw new Error("injected cancelled-reduction reveal failure");
    }
  }

  public armRevealFailure(): void {
    this.revealCalls = 0;
    this.#failReveal = true;
  }
}

class IdleTimers {
  #next = 1;
  public readonly setTimeout = (): number => this.#next++;
  public readonly clearTimeout = (): void => undefined;
}

class ManualFrames {
  #next = 1;
  #pending: { readonly id: number; readonly callback: FrameRequestCallback } | null =
    null;
  public requestCount = 0;
  public readonly cancelled: number[] = [];

  public readonly request = (callback: FrameRequestCallback): number => {
    if (this.#pending !== null) throw new Error("frame callback already pending");
    const id = this.#next++;
    this.requestCount += 1;
    this.#pending = { id, callback };
    return id;
  };

  public readonly cancel = (id: number): void => {
    this.cancelled.push(id);
    if (this.#pending?.id === id) this.#pending = null;
  };

  public get hasPending(): boolean {
    return this.#pending !== null;
  }

  public get pendingId(): number {
    if (this.#pending === null) throw new Error("no pending frame");
    return this.#pending.id;
  }

  public run(timestamp: number): void {
    const pending = this.#pending;
    if (pending === null) throw new Error("no pending frame");
    this.#pending = null;
    pending.callback(timestamp);
  }
}
