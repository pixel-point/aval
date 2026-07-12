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
});

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

  public prepareContentTick(
    context: Readonly<IntegratedPlaybackTickContext>
  ): Readonly<IntegratedPreparedContentTick> | null {
    this.tickContexts.push(context);
    if (!this.available) return null;
    if (context.presentationOrdinal !== 1n) return null;
    const cursor = Object.freeze({
      path: "intro:idle",
      unit: "intro",
      unitInstance: 0,
      localFrame: 1
    });
    return Object.freeze({
      routeReady: false,
      media: Object.freeze({
        kind: "frame" as const,
        graphKind: "intro" as const,
        state: "idle",
        edge: null,
        path: "intro:idle",
        frame: Object.freeze({
          rendition: "opaque-high",
          unit: "intro",
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
    activePath: "intro:idle",
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
  public async installInitial(): Promise<void> {}
  public async validateAll(): Promise<void> {}
  public async presentState(): Promise<void> {}
  public coverCurrent(): void {}
  public revealAnimated(): void {}
  public async settled(): Promise<void> {}
  public dispose(): void {}
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
