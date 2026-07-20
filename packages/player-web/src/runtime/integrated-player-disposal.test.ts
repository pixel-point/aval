import type { MotionGraphResult } from "@pixel-point/aval-graph";
import { describe, expect, it } from "vitest";

import { createIntegratedTestAsset } from "./asset-test-support.js";
import type { RuntimeFailure } from "./errors.js";
import {
  IntegratedPlayer,
  integratedStateStoreOption,
  type IntegratedCandidateAttempt,
  type IntegratedCandidateFactory,
  type IntegratedPlaybackSession,
  type IntegratedStateStore
} from "./integrated-player.js";
import { createIntegratedTestVideoSource } from "./integrated-player-video-test-support.js";

describe("IntegratedPlayer terminal disposal", () => {
  it("releases every owner despite trace, candidate, static, and diagnostic throws", async () => {
    const store = new ThrowingStaticStore();
    const factory = new ThrowingCandidateFactory();
    let diagnostics = 0;
    const player = new IntegratedPlayer({
      ...createIntegratedTestVideoSource(createIntegratedTestAsset()),
      ...integratedStateStoreOption(() => store),
      candidateFactory: factory,
      diagnosticsSink: (_failure: Readonly<RuntimeFailure>) => {
        diagnostics += 1;
        throw new Error("injected diagnostic sink failure");
      },
      timers: new IdleTimers()
    });
    await player.prepare();
    const catalog = player.catalog;
    const pending = player.requestState("hover");
    const outcome = pending.then(
      () => "resolved",
      (error: unknown) => error instanceof Error ? error.name : "unknown"
    );
    factory.session.throwTrace = true;
    factory.throwDispose = true;
    store.throwDispose = true;

    const first = player.dispose();
    const second = player.dispose();
    expect(second).toBe(first);
    await expect(first).resolves.toBeUndefined();

    expect(await outcome).toBe("AbortError");
    expect(factory.disposeCalls).toBe(1);
    expect(store.disposeCalls).toBe(1);
    expect(diagnostics).toBeGreaterThanOrEqual(3);
    expect(catalog.disposed).toBe(true);
    expect(catalog.ownedByteLength).toBe(0);
    expect(player.snapshot()).toMatchObject({
      readiness: "disposed",
      isTransitioning: false,
      disposed: true
    });
    await expect(player.prepare()).rejects.toMatchObject({ name: "AbortError" });
    await expect(player.requestState("idle")).rejects.toMatchObject({
      name: "AbortError"
    });
    expect(() => player.tryContentTick({
      presentationOrdinal: 1n,
      rationalDeadlineUs: 33_333
    })).toThrow("disposed");
  });

  it("makes prepare reject the retained in-flight terminal error", async () => {
    const store = new GatedRecoveryStore();
    const factory = new ThrowingCandidateFactory();
    const player = new IntegratedPlayer({
      ...createIntegratedTestVideoSource(createIntegratedTestAsset()),
      ...integratedStateStoreOption(() => store),
      candidateFactory: factory,
      timers: new IdleTimers()
    });
    await expect(player.prepare()).resolves.toMatchObject({ mode: "animated" });
    factory.session.tickFailure = new Error("injected runtime failure");

    let terminal: unknown;
    try {
      player.tryContentTick({
        presentationOrdinal: 1n,
        rationalDeadlineUs: 33_333
      });
    } catch (error) {
      terminal = error;
    }
    const joined = player.prepare();

    await expect(joined).rejects.toBe(terminal);
    await expect(player.settled()).rejects.toBe(terminal);
    expect(player.snapshot().readiness).toBe("error");
    await player.dispose();
  });

  it("does not resolve disposal before static decoder callbacks retire", async () => {
    const store = new GatedSettlementStore();
    const player = new IntegratedPlayer({
      ...createIntegratedTestVideoSource(createIntegratedTestAsset()),
      ...integratedStateStoreOption(() => store),
      candidateFactory: new ThrowingCandidateFactory(),
      timers: new IdleTimers()
    });
    await player.prepare();

    const disposal = player.dispose();
    await expectPending(disposal);
    await waitFor(() => store.settledCalls === 1);
    expect(store.disposeCalls).toBe(1);
    expect(store.settledCalls).toBe(1);

    store.settlement.resolve();
    await expect(disposal).resolves.toBeUndefined();
  });

  it.each([
    ["candidate", "direct"],
    ["candidate", "async-immediate"],
    ["static-store", "direct"],
    ["static-store", "async-immediate"]
  ] as const)(
    "does not self-await a %s %s disposal callback",
    async (owner, mode) => {
      const store = owner === "static-store"
        ? new ReentrantSettlementStore(mode)
        : new ThrowingStaticStore();
      const factory = owner === "candidate"
        ? new ReentrantCandidateFactory(mode)
        : new ThrowingCandidateFactory();
      const player = new IntegratedPlayer({
        ...createIntegratedTestVideoSource(createIntegratedTestAsset()),
        ...integratedStateStoreOption(() => store),
        candidateFactory: factory,
        timers: new IdleTimers()
      });
      if (store instanceof ReentrantSettlementStore) store.player = player;
      if (factory instanceof ReentrantCandidateFactory) factory.player = player;
      await player.prepare();
      const catalog = player.catalog;

      const first = player.dispose();
      const second = player.dispose();

      expect(second).toBe(first);
      await expect(first).resolves.toBeUndefined();
      await expect(player.dispose()).resolves.toBeUndefined();
      if (store instanceof ReentrantSettlementStore) {
        expect(store.settledCalls).toBe(1);
      }
      if (factory instanceof ReentrantCandidateFactory) {
        expect(factory.disposeCalls).toBe(1);
      }
      expect(catalog.disposed).toBe(true);
      expect(player.snapshot().disposed).toBe(true);
    }
  );

  it("settles aborted reduced-to-full re-entry cleanup before retiring static owners", async () => {
    const order: string[] = [];
    const store = new OrderedStaticStore(order);
    const factory = new GatedReentryCandidateFactory(order);
    const player = new IntegratedPlayer({
      ...createIntegratedTestVideoSource(createIntegratedTestAsset()),
      ...integratedStateStoreOption(() => store),
      candidateFactory: factory,
      motionPolicy: "reduce",
      timers: new IdleTimers()
    });
    await expect(player.prepare()).resolves.toMatchObject({
      mode: "static",
      reason: "reduced-motion"
    });
    const catalog = player.catalog;

    const reentry = player.setMotionPolicy("full");
    await waitFor(() => factory.prepareCalls === 1);

    const disposal = player.dispose();
    await waitFor(() => factory.disposeStarted);
    await expectPending(disposal);
    expect(store.disposeCalls).toBe(0);
    expect(catalog.disposed).toBe(false);
    expect(catalog.ownedByteLength).toBeGreaterThan(0);

    factory.disposal.resolve();
    await expect(disposal).resolves.toBeUndefined();
    await expect(reentry).resolves.toMatchObject({
      actualMode: "disposed",
      disposed: true
    });

    expect(order.indexOf("candidate:dispose-end")).toBeGreaterThan(
      order.indexOf("candidate:dispose-start")
    );
    expect(order.indexOf("static:dispose")).toBeGreaterThan(
      order.indexOf("candidate:dispose-end")
    );
    expect(store.disposeCalls).toBe(1);
    expect(catalog.disposed).toBe(true);
    expect(catalog.ownedByteLength).toBe(0);
  });
});

class ThrowingCandidateFactory implements IntegratedCandidateFactory {
  public readonly availability = Object.freeze({
    workerAvailable: true,
    rendererAvailable: true
  });
  public readonly session = new DisposalPlaybackSession();
  public disposeCalls = 0;
  public throwDispose = false;

  public create(): IntegratedCandidateAttempt {
    let disposed = false;
    return {
      playback: this.session,
      prepare: async () => undefined,
      prepareActivation: async ({ expectedPresentation }) =>
        Object.freeze({ expectedPresentation }),
      drawInitial: () => undefined,
      dispose: () => {
        if (disposed) return;
        disposed = true;
        this.disposeCalls += 1;
        if (this.throwDispose) throw new Error("injected candidate disposal failure");
      }
    };
  }
}

class DisposalPlaybackSession implements IntegratedPlaybackSession {
  public throwTrace = false;
  public tickFailure: unknown = null;

  public prepareContentTick(): null {
    if (this.tickFailure !== null) throw this.tickFailure;
    return null;
  }

  public drawContentTick(): null {
    return null;
  }

  public synchronizeGraph(_result: Readonly<MotionGraphResult>): void {}

  public traceState() {
    if (this.throwTrace) throw new Error("injected trace failure");
    return traceState();
  }
}

class ThrowingStaticStore implements IntegratedStateStore {
  public throwDispose = false;
  public disposeCalls = 0;
  #state = "idle";

  public async installInitial(_options: {
    readonly state: string;
    readonly signal: AbortSignal;
  }): Promise<void> { this.#state = _options.state; }
  public async validateAll(_options: {
    readonly signal: AbortSignal;
  }): Promise<void> {}
  public async presentState(
    _state: string,
    _options: { readonly signal: AbortSignal }
  ): Promise<void> { this.#state = _state; }
  public currentState(): string | null { return this.#state; }
  public async settled(): Promise<void> {}

  public dispose(): void {
    this.disposeCalls += 1;
    if (this.throwDispose) throw new Error("injected static disposal failure");
  }
}

class GatedRecoveryStore extends ThrowingStaticStore {
  public readonly gate = deferred<void>();

  public override async presentState(
    _state: string,
    options: { readonly signal: AbortSignal }
  ): Promise<void> {
    await Promise.race([
      this.gate.promise,
      new Promise<never>((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(options.signal.reason), {
          once: true
        });
      })
    ]);
  }
}

class GatedSettlementStore extends ThrowingStaticStore {
  public readonly settlement = deferred<void>();
  public settledCalls = 0;

  public override async settled(): Promise<void> {
    this.settledCalls += 1;
    await this.settlement.promise;
  }
}

type ReentrantDisposalMode = "direct" | "async-immediate";

class ReentrantSettlementStore extends ThrowingStaticStore {
  public player: IntegratedPlayer | null = null;
  public settledCalls = 0;
  readonly #mode: ReentrantDisposalMode;

  public constructor(mode: ReentrantDisposalMode) {
    super();
    this.#mode = mode;
  }

  public override settled(): Promise<void> {
    this.settledCalls += 1;
    const player = this.player!;
    return this.#mode === "direct"
      ? player.dispose()
      : (async () => player.dispose())();
  }
}

class ReentrantCandidateFactory implements IntegratedCandidateFactory {
  public readonly availability = Object.freeze({
    workerAvailable: true,
    rendererAvailable: true
  });
  public player: IntegratedPlayer | null = null;
  public disposeCalls = 0;
  readonly #mode: ReentrantDisposalMode;

  public constructor(mode: ReentrantDisposalMode) {
    this.#mode = mode;
  }

  public create(): IntegratedCandidateAttempt {
    const session = new DisposalPlaybackSession();
    let disposed = false;
    return {
      playback: session,
      prepare: async () => undefined,
      prepareActivation: async ({ expectedPresentation }) =>
        Object.freeze({ expectedPresentation }),
      drawInitial: () => undefined,
      dispose: () => {
        if (disposed) return Promise.resolve();
        disposed = true;
        this.disposeCalls += 1;
        const player = this.player!;
        return this.#mode === "direct"
          ? player.dispose()
          : (async () => player.dispose())();
      }
    };
  }
}

class OrderedStaticStore extends ThrowingStaticStore {
  readonly #order: string[];

  public constructor(order: string[]) {
    super();
    this.#order = order;
  }

  public override dispose(): void {
    this.#order.push("static:dispose");
    super.dispose();
  }
}

class GatedReentryCandidateFactory implements IntegratedCandidateFactory {
  public readonly availability = Object.freeze({
    workerAvailable: true,
    rendererAvailable: true
  });
  public readonly disposal = deferred<void>();
  public prepareCalls = 0;
  public disposeStarted = false;
  readonly #order: string[];

  public constructor(order: string[]) {
    this.#order = order;
  }

  public create(): IntegratedCandidateAttempt {
    let disposePromise: Promise<void> | null = null;
    return {
      playback: new DisposalPlaybackSession(),
      prepare: async ({ signal }) => {
        this.prepareCalls += 1;
        await new Promise<void>((resolve) => {
          if (signal.aborted) {
            resolve();
            return;
          }
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      },
      prepareActivation: async ({ expectedPresentation }) =>
        Object.freeze({ expectedPresentation }),
      drawInitial: () => undefined,
      dispose: () => {
        if (disposePromise !== null) return disposePromise;
        this.disposeStarted = true;
        this.#order.push("candidate:dispose-start");
        disposePromise = this.disposal.promise.then(() => {
          this.#order.push("candidate:dispose-end");
        });
        return disposePromise;
      }
    };
  }
}

class IdleTimers {
  #next = 1;
  public readonly setTimeout = (_callback: () => void, _ms: number): number =>
    this.#next++;
  public readonly clearTimeout = (_handle: number): void => undefined;
}

function traceState() {
  return Object.freeze({
    scheduler: Object.freeze({
      generation: 1,
      activePath: "disposal-test",
      sourceCursor: null,
      submittedCursor: null,
      decodedCursor: null,
      displayedCursor: null,
      ringSize: 0,
      ringCapacity: 6,
      smoothSession: true
    }),
    submitted: Object.freeze([]),
    selectedBoundary: null,
    decodeLeadFrames: 6
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function expectPending(promise: Promise<unknown>): Promise<void> {
  const marker = Symbol("pending");
  const outcome = await Promise.race([
    promise.then(() => "settled", () => "settled"),
    Promise.resolve(marker)
  ]);
  expect(outcome).toBe(marker);
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (condition()) return;
    await Promise.resolve();
  }
  throw new Error("timed out waiting for disposal test condition");
}
