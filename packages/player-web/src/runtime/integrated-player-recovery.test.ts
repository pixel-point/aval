import type {
  GraphPresentation,
  MotionGraphResult
} from "@pixel-point/aval-graph";
import { describe, expect, it } from "vitest";

import { createIntegratedTestAsset } from "./asset-test-support.js";
import { createIntegratedTestVideoSource } from "./integrated-player-video-test-support.js";
import type { EffectHostEvent } from "./effect-host.js";
import {
  RuntimePlaybackError,
  normalizeRuntimeFailure,
  type RuntimeFailure
} from "./errors.js";
import {
  IntegratedPlayer,
  integratedStateStoreOption,
  type IntegratedCandidateAttempt,
  type IntegratedCandidateFactory,
  type IntegratedPlaybackSession,
  type IntegratedPreparedContentTick,
  type IntegratedStateStore
} from "./integrated-player.js";

describe("IntegratedPlayer terminal playback failure", () => {
  it("raises and retains one canonical worker failure without alternate UI", async () => {
    const harness = await createHarness();
    harness.session.failure = fatalWorkerFailure();

    const terminal = caughtRuntimeError(() => harness.player.tryContentTick({
      presentationOrdinal: 1n,
      rationalDeadlineUs: 33_333
    }));

    expect(terminal.code).toBe("worker-decode-failure");
    expect(harness.player.snapshot()).toMatchObject({
      readiness: "error",
      requestedState: "idle",
      visualState: "idle",
      selectedRendition: null,
      isTransitioning: false
    });
    expect(harness.store.presented).toEqual([]);
    await expect(harness.player.settled()).rejects.toBe(terminal);
    await expect(harness.player.prepare()).rejects.toBe(terminal);
    await expect(harness.player.requestState("hover")).rejects.toBe(terminal);
    expect(caughtRuntimeError(() => harness.player.send("pointerenter")))
      .toBe(terminal);
    expect(harness.factory.disposals).toBe(1);
    expect(harness.failures).toEqual([
      expect.objectContaining({ code: "worker-decode-failure" })
    ]);
  });

  it("publishes terminal error before asynchronous candidate cleanup", async () => {
    const harness = await createHarness();
    const disposalGate = deferred<void>();
    harness.factory.nextDisposeGate = disposalGate;
    harness.session.failure = fatalWorkerFailure();

    const terminal = caughtRuntimeError(() => harness.player.tryContentTick({
      presentationOrdinal: 1n,
      rationalDeadlineUs: 33_333
    }));
    await waitFor(() => harness.order.includes("dispose:animated:start"));

    expect(harness.player.snapshot().readiness).toBe("error");
    expect(harness.store.presented).toEqual([]);
    expect(harness.factory.disposals).toBe(0);

    const settlement = harness.player.settled();
    const observed = settlement.then(
      () => "resolved",
      () => "rejected"
    );
    await settleMicrotasks();
    expect(await Promise.race([observed, Promise.resolve("pending")]))
      .toBe("pending");

    disposalGate.resolve();
    await expect(settlement).rejects.toBe(terminal);
    expect(harness.factory.disposals).toBe(1);
    expect(harness.order).toContain("dispose:animated:end");
  });

  it("retains one canonical renderer failure across repeated content ticks", async () => {
    const harness = await createHarness();
    harness.session.failure = new Error("injected renderer draw failure");
    harness.session.failOnDraw = true;

    const terminal = caughtRuntimeError(() => harness.player.tryContentTick({
      presentationOrdinal: 1n,
      rationalDeadlineUs: 33_333
    }));

    expect(terminal.code).toBe("renderer-failure");
    expect(caughtRuntimeError(() => harness.player.tryContentTick({
      presentationOrdinal: 1n,
      rationalDeadlineUs: 33_333
    }))).toBe(terminal);
    await expect(harness.player.settled()).rejects.toBe(terminal);
    expect(harness.store.presented).toEqual([]);
    expect(harness.player.snapshot().readiness).toBe("error");
  });

  it("rejects request synchronization with the retained canonical error", async () => {
    const harness = await createHarness();
    harness.session.failOnSynchronize = true;

    const terminal = await rejectedRuntimeError(
      harness.player.requestState("hover")
    );

    expect(terminal).toMatchObject({
      code: "readiness-failure",
      failure: {
        context: {
          state: "hover",
          operation: "request-synchronization"
        }
      }
    });
    await expect(harness.player.settled()).rejects.toBe(terminal);
    await expect(harness.player.requestState("idle")).rejects.toBe(terminal);
    expect(harness.store.presented).toEqual([]);
    expect(harness.player.snapshot()).toMatchObject({
      readiness: "error",
      requestedState: "hover",
      visualState: "idle"
    });
  });

  it("terminalizes a failed reduced-motion state staging operation", async () => {
    const harness = await createHarness();
    harness.store.failure = new Error("injected reduced state failure");

    const terminal = await rejectedRuntimeError(
      harness.player.setMotionPolicy("reduce")
    );

    expect(terminal.code).toBe("renderer-failure");
    await expect(harness.player.settled()).rejects.toBe(terminal);
    await expect(harness.player.setMotionPolicy("full")).rejects.toBe(terminal);
    expect(harness.player.snapshot().readiness).toBe("error");
    expect(harness.player.motionSnapshot().actualMode).toBe("animated");
  });

  it("sinks report-only recovery handling without changing public rejection", async () => {
    const harness = await createHarness();
    harness.session.failure = fatalWorkerFailure();

    const terminal = caughtRuntimeError(() => harness.player.tryContentTick({
      presentationOrdinal: 1n,
      rationalDeadlineUs: 33_333
    }));
    await settleMicrotasks();

    expect(harness.player.snapshot().readiness).toBe("error");
    await expect(harness.player.prepare()).rejects.toBe(terminal);
    await harness.player.dispose();
    expect(harness.factory.disposals).toBe(1);
  });

});

function caughtRuntimeError(operation: () => unknown): RuntimePlaybackError {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(RuntimePlaybackError);
    return error as RuntimePlaybackError;
  }
  throw new Error("expected RuntimePlaybackError");
}

async function rejectedRuntimeError(
  promise: Promise<unknown>
): Promise<RuntimePlaybackError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(RuntimePlaybackError);
    return error as RuntimePlaybackError;
  }
  throw new Error("expected RuntimePlaybackError rejection");
}

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
    ...createIntegratedTestVideoSource(createIntegratedTestAsset()),
    ...integratedStateStoreOption(() => store),
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
  public nextDisposeGate: ReturnType<typeof deferred<void>> | null = null;
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
      dispose: async () => {
        if (disposed) return;
        disposed = true;
        const gate = this.nextDisposeGate;
        this.nextDisposeGate = null;
        if (gate !== null) {
          this.#order.push("dispose:animated:start");
          await gate.promise;
          this.disposals += 1;
          this.#order.push("dispose:animated:end");
          return;
        }
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

class RecoveryStaticStore implements IntegratedStateStore {
  public readonly presented: string[] = [];
  public readonly committed: string[] = [];
  public failure: Error | null = null;
  public nextGate: ReturnType<typeof deferred<void>> | null = null;
  public activePresentations = 0;
  public maximumActivePresentations = 0;
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

  public currentState(): string | null {
    return this.committed.at(-1) ?? "idle";
  }

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
