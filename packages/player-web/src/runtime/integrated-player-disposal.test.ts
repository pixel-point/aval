import type { MotionGraphResult } from "@rendered-motion/graph";
import { describe, expect, it } from "vitest";

import { createIntegratedOpaqueTestAsset } from "./asset-test-fixture.js";
import type { RuntimeFailure } from "./errors.js";
import {
  IntegratedPlayer,
  type IntegratedCandidateAttempt,
  type IntegratedCandidateFactory,
  type IntegratedPlaybackSession,
  type IntegratedStaticSurfaceStore
} from "./integrated-player.js";

describe("IntegratedPlayer terminal disposal", () => {
  it("releases every owner despite trace, candidate, static, and diagnostic throws", async () => {
    const store = new ThrowingStaticStore();
    const factory = new ThrowingCandidateFactory();
    let diagnostics = 0;
    const player = new IntegratedPlayer({
      bytes: createIntegratedOpaqueTestAsset(),
      createStaticStore: () => store,
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

  it("makes prepare join an in-flight recovery instead of returning stale animated readiness", async () => {
    const store = new GatedRecoveryStore();
    const factory = new ThrowingCandidateFactory();
    const player = new IntegratedPlayer({
      bytes: createIntegratedOpaqueTestAsset(),
      createStaticStore: () => store,
      candidateFactory: factory,
      timers: new IdleTimers()
    });
    await expect(player.prepare()).resolves.toMatchObject({ mode: "animated" });
    factory.session.tickFailure = new Error("injected runtime failure");

    expect(player.tryContentTick({
      presentationOrdinal: 1n,
      rationalDeadlineUs: 33_333
    })).toEqual({ status: "stopped" });
    const joined = player.prepare();
    await expectPending(joined);
    store.gate.resolve();

    await expect(joined).resolves.toMatchObject({
      mode: "static",
      reason: "animation-failure"
    });
    expect(player.snapshot().readiness).toBe("staticReady");
    await player.dispose();
  });

  it("does not resolve disposal before static decoder callbacks retire", async () => {
    const store = new GatedSettlementStore();
    const player = new IntegratedPlayer({
      bytes: createIntegratedOpaqueTestAsset(),
      createStaticStore: () => store,
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

class ThrowingStaticStore implements IntegratedStaticSurfaceStore {
  public throwDispose = false;
  public disposeCalls = 0;

  public async installInitial(_options: {
    readonly state: string;
    readonly signal: AbortSignal;
  }): Promise<void> {}
  public async validateAll(_options: {
    readonly signal: AbortSignal;
  }): Promise<void> {}
  public async presentState(
    _state: string,
    _options: { readonly signal: AbortSignal }
  ): Promise<void> {}
  public coverCurrent(): void {}
  public revealAnimated(): void {}
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
