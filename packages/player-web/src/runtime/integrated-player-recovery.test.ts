import type {
  GraphPresentation,
  MotionGraphResult
} from "@rendered-motion/graph";
import { describe, expect, it } from "vitest";

import { createIntegratedOpaqueTestAsset } from "./asset-test-fixture.js";
import type { EffectHostEvent } from "./effect-host.js";
import {
  RuntimePlaybackError,
  normalizeRuntimeFailure,
  type RuntimeFailure
} from "./errors.js";
import {
  IntegratedPlayer,
  type IntegratedCandidateAttempt,
  type IntegratedCandidateFactory,
  type IntegratedPlaybackSession,
  type IntegratedPreparedContentTick,
  type IntegratedStaticSurfaceStore
} from "./integrated-player.js";

describe("IntegratedPlayer animated failure recovery", () => {
  it("recovers a fatal media boundary to the newest requested static state", async () => {
    const harness = await createHarness();
    const order = harness.order;
    const requestTrace: string[] = [];
    const request = harness.player.requestState("hover");
    void request.then(() => requestTrace.push("resolved"));
    harness.session.failure = fatalWorkerFailure();

    expect(harness.player.tryContentTick({
      presentationOrdinal: 1n,
      rationalDeadlineUs: 33_333
    })).toEqual({ status: "stopped" });
    await harness.player.settled();
    await request;
    await settleMicrotasks();

    expect(harness.player.snapshot()).toMatchObject({
      readiness: "staticReady",
      requestedState: "hover",
      visualState: "hover",
      selectedRendition: null,
      isTransitioning: false
    });
    expect(harness.factory.disposals).toBe(1);
    expect(harness.store.presented).toEqual(["hover"]);
    expect(harness.failures).toHaveLength(1);
    expect(harness.failures[0]).toMatchObject({
      code: "worker-decode-failure"
    });
    expect(requestTrace).toEqual(["resolved"]);

    const recovery = order.slice(order.indexOf("dispose:animated"));
    expect(recovery).toEqual([
      "dispose:animated",
      "present:hover",
      "effect:readinesschange",
      "effect:fallback",
      "effect:transitionstart",
      "draw:static",
      "effect:visualstatechange",
      "effect:transitionend"
    ]);

    await harness.player.requestState("idle");
    await settleMicrotasks();
    expect(harness.store.presented).toEqual(["hover", "idle"]);
    expect(harness.player.snapshot()).toMatchObject({
      readiness: "staticReady",
      requestedState: "idle",
      visualState: "idle"
    });
  });

  it("recovers a synchronous renderer failure after graph tick without advancing again", async () => {
    const harness = await createHarness();
    harness.session.failure = new Error("injected renderer draw failure");
    harness.session.failOnDraw = true;

    expect(harness.player.tryContentTick({
      presentationOrdinal: 1n,
      rationalDeadlineUs: 33_333
    })).toEqual({ status: "stopped" });
    expect(harness.player.tryContentTick({
      presentationOrdinal: 1n,
      rationalDeadlineUs: 33_333
    })).toEqual({ status: "stopped" });
    await harness.player.settled();

    expect(harness.failures[0]).toMatchObject({ code: "renderer-failure" });
    expect(harness.player.snapshot()).toMatchObject({
      readiness: "staticReady",
      requestedState: "idle",
      visualState: "idle"
    });
    expect(harness.store.presented).toEqual(["idle"]);
  });

  it("turns a live request synchronization failure into static recovery", async () => {
    const harness = await createHarness();
    harness.session.failOnSynchronize = true;

    let request!: Promise<void>;
    expect(() => {
      request = harness.player.requestState("hover");
    }).not.toThrow();
    await harness.player.settled();
    await expect(request).resolves.toBeUndefined();

    expect(harness.failures[0]).toMatchObject({
      code: "readiness-failure",
      context: { state: "hover", operation: "request-synchronization" }
    });
    expect(harness.player.snapshot()).toMatchObject({
      readiness: "staticReady",
      requestedState: "hover",
      visualState: "hover",
      isTransitioning: false
    });
    expect(harness.factory.disposals).toBe(1);
  });

  it("completes an interrupted transitionless draw barrier with the recovery pixels", async () => {
    const harness = await createHarness();
    harness.session.script.push(
      frame("intro", "idle", null, "intro", 1),
      frame("body", "idle", null, "idle-body", 0),
      frame("body", "hover", null, "hover-body", 0)
    );
    advanceOnce(harness, 1n);
    advanceOnce(harness, 2n);
    const request = harness.player.requestState("hover");
    harness.session.failure = new Error("injected cut target draw failure");
    harness.session.failOnDraw = true;

    expect(harness.player.tryContentTick({
      presentationOrdinal: 3n,
      rationalDeadlineUs: 99_999
    })).toEqual({ status: "stopped" });
    await harness.player.settled();
    await request;

    expect(harness.player.snapshot()).toMatchObject({
      readiness: "staticReady",
      requestedState: "hover",
      visualState: "hover",
      isTransitioning: false
    });
    const recoveryDraw = harness.order.lastIndexOf("draw:static");
    expect(harness.order.slice(recoveryDraw + 1)).toEqual([
      "effect:visualstatechange",
      "effect:transitionend"
    ]);
  });

  it("retains the last committed visual state if interrupted recovery also fails", async () => {
    const harness = await createHarness();
    harness.session.script.push(
      frame("intro", "idle", null, "intro", 1),
      frame("body", "idle", null, "idle-body", 0),
      frame("body", "hover", null, "hover-body", 0)
    );
    advanceOnce(harness, 1n);
    advanceOnce(harness, 2n);
    const request = harness.player.requestState("hover");
    const outcome = request.then(
      () => "resolved",
      (error: unknown) => error instanceof Error ? error.name : "unknown"
    );
    harness.session.failure = new Error("injected target draw failure");
    harness.session.failOnDraw = true;
    harness.store.failure = new Error("injected recovery draw failure");

    expect(harness.player.tryContentTick({
      presentationOrdinal: 3n,
      rationalDeadlineUs: 99_999
    }).status).toBe("stopped");
    await expect(harness.player.settled()).rejects.toThrow(
      "injected recovery draw failure"
    );

    expect(await outcome).toBe("PlaybackFallbackError");
    expect(harness.player.snapshot()).toMatchObject({
      readiness: "error",
      requestedState: "hover",
      visualState: "idle",
      isTransitioning: false
    });
    expect(harness.order).not.toContain("effect:visualstatechange");
  });

  it("aborts an interrupted draw transaction cleanly when disposal wins recovery", async () => {
    const harness = await createHarness();
    harness.session.script.push(
      frame("intro", "idle", null, "intro", 1),
      frame("body", "idle", null, "idle-body", 0),
      frame("body", "hover", null, "hover-body", 0)
    );
    advanceOnce(harness, 1n);
    advanceOnce(harness, 2n);
    const request = harness.player.requestState("hover");
    const outcome = request.then(
      () => "resolved",
      (error: unknown) => error instanceof Error ? error.name : "unknown"
    );
    harness.session.failure = new Error("injected target draw failure");
    harness.session.failOnDraw = true;
    harness.store.nextGate = deferred<void>();

    expect(harness.player.tryContentTick({
      presentationOrdinal: 3n,
      rationalDeadlineUs: 99_999
    }).status).toBe("stopped");
    await waitFor(() => harness.store.activePresentations === 1);
    await expect(harness.player.dispose()).resolves.toBeUndefined();

    expect(await outcome).toBe("AbortError");
    expect(harness.player.snapshot()).toMatchObject({
      readiness: "disposed",
      requestedState: "hover",
      visualState: "idle",
      isTransitioning: false,
      disposed: true
    });
    expect(harness.store.activePresentations).toBe(0);
  });

  it("admits the latest request while an interrupted draw awaits recovery", async () => {
    const harness = await createHarness();
    harness.session.script.push(
      frame("intro", "idle", null, "intro", 1),
      frame("body", "idle", null, "idle-body", 0),
      frame("body", "hover", null, "hover-body", 0)
    );
    advanceOnce(harness, 1n);
    advanceOnce(harness, 2n);
    const hover = harness.player.requestState("hover");
    const hoverOutcome = hover.then(
      () => "resolved",
      (error: unknown) => error instanceof Error ? error.name : "unknown"
    );
    harness.session.failure = new Error("injected target draw failure");
    harness.session.failOnDraw = true;
    harness.store.nextGate = deferred<void>();

    expect(harness.player.tryContentTick({
      presentationOrdinal: 3n,
      rationalDeadlineUs: 99_999
    }).status).toBe("stopped");
    await waitFor(() => harness.store.activePresentations === 1);

    let idle!: Promise<void>;
    expect(() => {
      idle = harness.player.requestState("idle");
    }).not.toThrow();
    await harness.player.settled();
    await expect(idle).resolves.toBeUndefined();

    expect(await hoverOutcome).toBe("AbortError");
    expect(harness.store.committed).toEqual(["idle"]);
    expect(harness.player.snapshot()).toMatchObject({
      readiness: "staticReady",
      requestedState: "idle",
      visualState: "idle",
      isTransitioning: false
    });
  });

  it("restarts recovery presentation when a newer accepted request arrives", async () => {
    const harness = await createHarness();
    const firstGate = deferred<void>();
    harness.store.nextGate = firstGate;
    const hover = harness.player.requestState("hover");
    const hoverOutcome = hover.then(
      () => "resolved",
      (error: unknown) => error instanceof Error ? error.name : "unknown"
    );
    harness.session.failure = fatalWorkerFailure();
    expect(harness.player.tryContentTick({
      presentationOrdinal: 1n,
      rationalDeadlineUs: 33_333
    }).status).toBe("stopped");
    await waitFor(() => harness.store.activePresentations === 1);

    const idle = harness.player.requestState("idle");
    firstGate.resolve();
    await harness.player.settled();
    await idle;

    expect(await hoverOutcome).toBe("AbortError");
    expect(harness.store.presented).toEqual(["hover", "idle"]);
    expect(harness.player.snapshot()).toMatchObject({
      readiness: "staticReady",
      requestedState: "idle",
      visualState: "idle"
    });
  });

  it("aborts a superseded recovery surface before obsolete pixels commit", async () => {
    const harness = await createHarness();
    harness.store.nextGate = deferred<void>();
    const hover = harness.player.requestState("hover");
    const hoverOutcome = hover.then(
      () => "resolved",
      (error: unknown) => error instanceof Error ? error.name : "unknown"
    );
    harness.session.failure = fatalWorkerFailure();
    expect(harness.player.tryContentTick({
      presentationOrdinal: 1n,
      rationalDeadlineUs: 33_333
    }).status).toBe("stopped");
    await waitFor(() => harness.store.activePresentations === 1);

    const idle = harness.player.requestState("idle");
    await harness.player.settled();
    await idle;

    expect(await hoverOutcome).toBe("AbortError");
    expect(harness.store.presented).toEqual(["hover", "idle"]);
    expect(harness.store.committed).toEqual(["idle"]);
    expect(harness.store.maximumActivePresentations).toBe(1);
    expect(harness.player.snapshot()).toMatchObject({
      readiness: "staticReady",
      requestedState: "idle",
      visualState: "idle"
    });
  });

  it("serializes later static requests and never commits out of draw order", async () => {
    const harness = await recoveredHarness();
    const gate = deferred<void>();
    harness.store.nextGate = gate;

    const idle = harness.player.requestState("idle");
    await waitFor(() => harness.store.activePresentations === 1);
    const hover = harness.player.requestState("hover");
    await settleMicrotasks();
    expect(harness.store.activePresentations).toBe(1);
    expect(harness.store.maximumActivePresentations).toBe(1);

    gate.resolve();
    await Promise.all([idle, hover]);
    await harness.player.settled();
    expect(harness.store.presented.slice(-2)).toEqual(["idle", "hover"]);
    expect(harness.store.maximumActivePresentations).toBe(1);
    expect(harness.player.snapshot()).toMatchObject({
      requestedState: "hover",
      visualState: "hover"
    });
  });

  it("rejects invalid static intents without drawing and terminalizes a failed valid replacement", async () => {
    const harness = await recoveredHarness();
    const before = [...harness.store.presented];
    await expect(harness.player.requestState("missing")).rejects.toMatchObject({
      name: "RouteError"
    });
    expect(harness.store.presented).toEqual(before);
    expect(harness.player.snapshot()).toMatchObject({
      requestedState: "hover",
      visualState: "hover",
      readiness: "staticReady"
    });

    harness.store.failure = new Error("injected later static failure");
    await expect(harness.player.requestState("idle")).rejects.toMatchObject({
      name: "PlaybackFallbackError"
    });
    expect(harness.player.snapshot()).toMatchObject({
      requestedState: "hover",
      visualState: "hover",
      readiness: "error",
      isTransitioning: false
    });
  });

  it("terminalizes with PlaybackFallbackError when recovery static draw fails", async () => {
    const harness = await createHarness();
    const request = harness.player.requestState("hover");
    const requestOutcome = request.then(
      () => "resolved",
      (error: unknown) => error instanceof Error ? error.name : "unknown"
    );
    harness.store.failure = new Error("injected static presentation failure");
    harness.session.failure = fatalWorkerFailure();

    expect(harness.player.tryContentTick({
      presentationOrdinal: 1n,
      rationalDeadlineUs: 33_333
    })).toEqual({ status: "stopped" });
    await expect(harness.player.settled()).rejects.toThrow(
      "injected static presentation failure"
    );
    expect(await requestOutcome).toBe("PlaybackFallbackError");
    expect(harness.player.snapshot()).toMatchObject({
      readiness: "error",
      requestedState: "hover",
      visualState: "idle"
    });
    expect(harness.store.coverCalls).toBeGreaterThan(0);
  });

  it("aborts an active static request and settles every owner on disposal", async () => {
    const harness = await recoveredHarness();
    const gate = deferred<void>();
    harness.store.nextGate = gate;
    const request = harness.player.requestState("idle");
    const requestOutcome = request.then(
      () => "resolved",
      (error: unknown) => error instanceof Error ? error.name : "unknown"
    );
    await waitFor(() => harness.store.activePresentations === 1);

    const firstDispose = harness.player.dispose();
    const secondDispose = harness.player.dispose();
    expect(secondDispose).toBe(firstDispose);
    await firstDispose;

    expect(await requestOutcome).toBe("AbortError");
    expect(harness.player.snapshot()).toMatchObject({
      readiness: "disposed",
      disposed: true
    });
    expect(harness.factory.disposals).toBe(1);
    expect(harness.store.disposeCalls).toBe(1);
    expect(harness.store.activePresentations).toBe(0);
    expect(() => harness.player.tryContentTick({
      presentationOrdinal: 1n,
      rationalDeadlineUs: 33_333
    })).toThrow("disposed");
  });
});

interface RecoveryHarness {
  readonly player: IntegratedPlayer;
  readonly factory: RecoveryCandidateFactory;
  readonly session: RecoveryPlaybackSession;
  readonly store: RecoveryStaticStore;
  readonly order: string[];
  readonly events: Readonly<EffectHostEvent>[];
  readonly failures: Readonly<RuntimeFailure>[];
}

async function createHarness(): Promise<RecoveryHarness> {
  const order: string[] = [];
  const store = new RecoveryStaticStore(order);
  const factory = new RecoveryCandidateFactory(order);
  const events: Readonly<EffectHostEvent>[] = [];
  const failures: Readonly<RuntimeFailure>[] = [];
  const player = new IntegratedPlayer({
    bytes: createIntegratedOpaqueTestAsset(),
    createStaticStore: () => store,
    candidateFactory: factory,
    eventSink(event) {
      events.push(event);
      order.push(`effect:${event.type}`);
    },
    diagnosticsSink(failure) {
      failures.push(failure);
    },
    timers: new IdleTimers()
  });
  await expect(player.prepare()).resolves.toMatchObject({ mode: "animated" });
  return {
    player,
    factory,
    session: factory.session,
    store,
    order,
    events,
    failures
  };
}

async function recoveredHarness(): Promise<RecoveryHarness> {
  const harness = await createHarness();
  const request = harness.player.requestState("hover");
  harness.session.failure = fatalWorkerFailure();
  expect(harness.player.tryContentTick({
    presentationOrdinal: 1n,
    rationalDeadlineUs: 33_333
  }).status).toBe("stopped");
  await harness.player.settled();
  await request;
  return harness;
}

function fatalWorkerFailure(): RuntimePlaybackError {
  return new RuntimePlaybackError(normalizeRuntimeFailure(
    "worker-decode-failure",
    "injected worker failure",
    { operation: "content-tick" }
  ));
}

class RecoveryCandidateFactory implements IntegratedCandidateFactory {
  public readonly availability = Object.freeze({
    workerAvailable: true,
    rendererAvailable: true
  });
  public disposals = 0;
  #session: RecoveryPlaybackSession | null = null;
  readonly #order: string[];

  public constructor(order: string[]) {
    this.#order = order;
  }

  public get session(): RecoveryPlaybackSession {
    if (this.#session === null) throw new Error("candidate was not created");
    return this.#session;
  }

  public create(): IntegratedCandidateAttempt {
    const session = new RecoveryPlaybackSession();
    this.#session = session;
    let disposed = false;
    return {
      playback: session,
      prepare: async () => undefined,
      prepareActivation: async ({ expectedPresentation }) =>
        Object.freeze({ expectedPresentation }),
      drawInitial: () => undefined,
      dispose: () => {
        if (disposed) return;
        disposed = true;
        this.disposals += 1;
        this.#order.push("dispose:animated");
      }
    };
  }
}

class RecoveryPlaybackSession implements IntegratedPlaybackSession {
  public failure: unknown = null;
  public failOnDraw = false;
  public failOnSynchronize = false;
  public readonly script: ScriptedFrame[] = [];

  public prepareContentTick(input: {
    readonly presentationOrdinal: bigint;
  }): Readonly<IntegratedPreparedContentTick> | null {
    if (this.failure !== null && !this.failOnDraw) throw this.failure;
    const scripted = this.script.shift();
    if (scripted === undefined && !this.failOnDraw) return null;
    const value = scripted ?? frame("intro", "idle", null, "intro", 1);
    const cursor = Object.freeze({
      path: "recovery-test",
      unit: value.unit,
      unitInstance: 0,
      localFrame: value.localFrame
    });
    return Object.freeze({
      routeReady: true,
      media: Object.freeze({
        kind: "frame" as const,
        graphKind: value.kind,
        state: value.state,
        edge: value.edge,
        path: "recovery-test",
        frame: Object.freeze({
          rendition: "opaque-high",
          unit: value.unit,
          localFrame: value.localFrame
        }),
        drawSource: "streaming" as const,
        generation: 1,
        unitInstance: 0,
        decodeOrdinal: 1,
        timestamp: 33_333,
        intendedPresentationOrdinal: input.presentationOrdinal
      }),
      scheduler: schedulerSnapshot(cursor),
      submitted: Object.freeze([cursor]),
      selectedBoundary: null,
      decodeLeadFrames: 6
    });
  }

  public drawContentTick(
    _prepared: Readonly<IntegratedPreparedContentTick>,
    _presentation: Readonly<GraphPresentation>
  ): string | null {
    if (this.failure !== null) throw this.failure;
    return null;
  }

  public synchronizeGraph(_result: Readonly<MotionGraphResult>): void {
    if (this.failOnSynchronize) {
      throw new Error("injected request synchronization failure");
    }
  }

  public traceState() {
    return Object.freeze({
      scheduler: schedulerSnapshot(null),
      submitted: Object.freeze([]),
      selectedBoundary: null,
      decodeLeadFrames: 6
    });
  }
}

interface ScriptedFrame {
  readonly kind: "intro" | "body" | "locked" | "reversible";
  readonly state: string | null;
  readonly edge: string | null;
  readonly unit: string;
  readonly localFrame: number;
}

function frame(
  kind: ScriptedFrame["kind"],
  state: string | null,
  edge: string | null,
  unit: string,
  localFrame: number
): Readonly<ScriptedFrame> {
  return Object.freeze({ kind, state, edge, unit, localFrame });
}

function advanceOnce(harness: RecoveryHarness, ordinal: bigint): void {
  expect(harness.player.tryContentTick({
    presentationOrdinal: ordinal,
    rationalDeadlineUs: Number(ordinal) * 33_333
  })).toEqual({ status: "advanced" });
}

function schedulerSnapshot(cursor: Readonly<{
  path: string;
  unit: string;
  unitInstance: number;
  localFrame: number;
}> | null) {
  return Object.freeze({
    generation: 1,
    activePath: "recovery-test",
    sourceCursor: cursor,
    submittedCursor: cursor,
    decodedCursor: cursor,
    displayedCursor: cursor,
    ringSize: cursor === null ? 0 : 1,
    ringCapacity: 6,
    smoothSession: false
  });
}

class RecoveryStaticStore implements IntegratedStaticSurfaceStore {
  public readonly presented: string[] = [];
  public readonly committed: string[] = [];
  public failure: Error | null = null;
  public nextGate: ReturnType<typeof deferred<void>> | null = null;
  public activePresentations = 0;
  public maximumActivePresentations = 0;
  public coverCalls = 0;
  public disposeCalls = 0;
  readonly #order: string[];

  public constructor(order: string[]) {
    this.#order = order;
  }

  public async installInitial(): Promise<void> {}
  public async validateAll(): Promise<void> {}

  public async presentState(
    state: string,
    options: { readonly signal: AbortSignal }
  ): Promise<void> {
    this.activePresentations += 1;
    this.maximumActivePresentations = Math.max(
      this.maximumActivePresentations,
      this.activePresentations
    );
    this.presented.push(state);
    this.#order.push(`present:${state}`);
    const gate = this.nextGate;
    this.nextGate = null;
    try {
      if (gate !== null) await abortableGate(gate.promise, options.signal);
      if (this.failure !== null) throw this.failure;
      throwIfAborted(options.signal);
      this.committed.push(state);
    } finally {
      this.activePresentations -= 1;
    }
  }

  public coverCurrent(): void {
    this.coverCalls += 1;
    this.#order.push("draw:static");
  }

  public revealAnimated(): void {}

  public async settled(): Promise<void> {}

  public dispose(): void {
    this.disposeCalls += 1;
  }
}

class IdleTimers {
  #next = 1;
  public readonly setTimeout = (_callback: () => void, _ms: number): number =>
    this.#next++;
  public readonly clearTimeout = (_handle: number): void => undefined;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function abortableGate<T>(
  promise: Promise<T>,
  signal: AbortSignal
): Promise<T> {
  throwIfAborted(signal);
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true
      });
    })
  ]);
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason;
}

async function settleMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (condition()) return;
    await Promise.resolve();
  }
  throw new Error("timed out waiting for recovery test condition");
}
