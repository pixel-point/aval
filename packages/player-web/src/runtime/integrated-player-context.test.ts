import { describe, expect, it } from "vitest";

import type {
  BrowserContextRecoveryEvent,
  BrowserContextRecoveryEventTarget
} from "./browser-context-recovery.js";
import { RuntimePlaybackError } from "./errors.js";
import { IntegratedPlayerContext } from "./integrated-player-context.js";
import {
  Deferred,
  createPreparationHarness as createHarness,
  waitForCall
} from "./integrated-player-preparation-test-support.js";

describe("IntegratedPlayerContext", () => {
  it("composes immediate cover/freeze with cleanup and a fresh body-zero rebuild", async () => {
    const target = new FakeTarget();
    const cleanup = deferred<void>();
    const order: string[] = [];
    const context = new IntegratedPlayerContext({
      target,
      coverCurrent: () => order.push("cover"),
      freezeRealtime: () => {
        order.push("freeze");
        return true;
      },
      retireCandidate: async ({ reason }) => {
        order.push(`retire:${reason}:start`);
        await cleanup.promise;
        order.push(`retire:${reason}:end`);
      },
      canRebuild: () => true,
      rebuildCurrentBodyZero: async ({ generation }) => {
        order.push(`body-zero:${String(generation)}`);
        return true;
      },
      revealAnimated: () => order.push("reveal"),
      resumeRealtime: (wasRunning) => order.push(`resume:${String(wasRunning)}`)
    });

    const loss = target.loss();
    expect(loss.prevented).toBe(true);
    expect(order).toEqual(["cover", "freeze"]);
    target.restore();
    await settleMicrotasks();
    expect(order).toEqual([
      "cover",
      "freeze",
      "retire:context-loss:start"
    ]);
    cleanup.resolve();
    await context.settled();
    expect(order).toEqual([
      "cover",
      "freeze",
      "retire:context-loss:start",
      "retire:context-loss:end",
      "body-zero:1",
      "reveal",
      "resume:true"
    ]);
    expect(context.snapshot()).toMatchObject({
      state: "ready",
      resumeOnRestore: false,
      successfulRestorations: 1
    });
  });

  it("leaves hidden/reduced/sticky players statically covered", async () => {
    const target = new FakeTarget();
    let eligible = false;
    let rebuilds = 0;
    let resumes = 0;
    const context = new IntegratedPlayerContext({
      target,
      coverCurrent() {},
      freezeRealtime: () => true,
      retireCandidate() {},
      canRebuild: () => eligible,
      rebuildCurrentBodyZero: async () => {
        rebuilds += 1;
        return true;
      },
      revealAnimated() {},
      resumeRealtime: () => { resumes += 1; }
    });

    target.loss();
    target.restore();
    await context.settled();
    expect(context.snapshot().state).toBe("static");
    expect(rebuilds).toBe(0);
    expect(resumes).toBe(0);

    eligible = true;
    context.requestRestore();
    await context.settled();
    expect(context.snapshot().state).toBe("ready");
    expect(rebuilds).toBe(1);
    expect(resumes).toBe(1);
  });

  it("does not resume time after rebuild rejection or repeated loss", async () => {
    const target = new FakeTarget();
    const rebuild = deferred<boolean>();
    let resumes = 0;
    const context = new IntegratedPlayerContext({
      target,
      coverCurrent() {},
      freezeRealtime: () => true,
      retireCandidate() {},
      canRebuild: () => true,
      rebuildCurrentBodyZero: () => rebuild.promise,
      revealAnimated() {},
      resumeRealtime: () => { resumes += 1; }
    });

    target.loss();
    target.restore();
    await settleMicrotasks();
    target.loss();
    rebuild.resolve(true);
    await context.settled();
    expect(context.snapshot()).toMatchObject({
      state: "static",
      sticky: true,
      repeatedLosses: 1
    });
    expect(resumes).toBe(0);
  });

  it("removes listeners and waits for candidate retirement on final disposal", async () => {
    const target = new FakeTarget();
    const cleanup = deferred<void>();
    const context = new IntegratedPlayerContext({
      target,
      coverCurrent() {},
      freezeRealtime: () => false,
      retireCandidate: () => cleanup.promise,
      canRebuild: () => true,
      rebuildCurrentBodyZero: async () => true,
      revealAnimated() {},
      resumeRealtime() {}
    });
    target.loss();
    const disposal = context.dispose();
    expect(target.listenerCount()).toBe(0);
    cleanup.resolve();
    await disposal;
    await context.dispose();
    expect(context.snapshot()).toMatchObject({
      state: "disposed",
      pendingOperations: 0,
      listenerCount: 0
    });
  });
});

describe("IntegratedPlayer context binding", () => {
  it("freezes synchronously, then restarts an unfinished intro", async () => {
    const target = new FakeTarget();
    const harness = createHarness({
      contextTarget: target,
      behaviors: [{ kind: "success" }, { kind: "success" }]
    });
    await harness.player.prepare();

    const loss = target.loss();
    expect(loss.prevented).toBe(true);
    expect(harness.stateStore.currentState()).toBe("idle");
    expect(harness.player.contextSnapshot()).toMatchObject({
      state: "lost",
      lossCount: 1
    });

    target.restore();
    await harness.player.settled();

    expect(harness.factory.calls.filter((call) =>
      call === "dispose:opaque-high"
    )).toHaveLength(1);
    expect(harness.factory.draws.map((presentation) => [
      presentation.kind,
      presentation.kind === "static" ? null : presentation.frameIndex
    ])).toEqual([["intro", 0], ["intro", 0]]);
    expect(harness.player.contextSnapshot()).toMatchObject({
      state: "ready",
      successfulRestorations: 1
    });
    expect(harness.factory.activeAttempts).toBe(1);
  });

  it("waits while hidden, then uses the visibility lane for one rebuild", async () => {
    const target = new FakeTarget();
    const harness = createHarness({
      contextTarget: target,
      behaviors: [{ kind: "success" }, { kind: "success" }]
    });
    await harness.player.prepare();
    await harness.player.setVisibility("hidden");

    target.loss();
    target.restore();
    await harness.player.settled();
    expect(harness.player.contextSnapshot()?.state).toBe("static");

    await harness.player.setVisibility("visible");
    await harness.player.settled();

    expect(harness.factory.calls.filter((call) =>
      call === "create:opaque-high"
    )).toHaveLength(2);
    expect(harness.factory.draws.at(-1)).toMatchObject({
      kind: "intro",
      frameIndex: 0
    });
    expect(harness.player.contextSnapshot()?.state).toBe("ready");
  });

  it("waits under reduced motion and rebuilds only after full eligibility", async () => {
    const target = new FakeTarget();
    const harness = createHarness({
      contextTarget: target,
      motionPolicy: "reduce",
      behaviors: [{ kind: "success" }]
    });
    await harness.player.prepare();
    target.loss();
    target.restore();
    await harness.player.settled();
    expect(harness.factory.calls).toEqual([]);

    await harness.player.setMotionPolicy("full");
    await harness.player.settled();

    expect(harness.factory.draws).toEqual([
      expect.objectContaining({ kind: "intro", frameIndex: 0 })
    ]);
    expect(harness.player.contextSnapshot()?.state).toBe("ready");
  });

  it("terminalizes a repeated loss during rebuild and rejects late media", async () => {
    const gate = new Deferred<void>();
    const target = new FakeTarget();
    const harness = createHarness({
      contextTarget: target,
      behaviors: [
        { kind: "success" },
        { kind: "gated", gate }
      ]
    });
    await harness.player.prepare();
    target.loss();
    target.restore();
    await waitForFactoryCreates(harness.factory.calls, 2);

    target.loss();
    gate.resolve(undefined);
    const terminal = await harness.player.settled().catch(
      (error: unknown) => error
    );

    expect(terminal).toBeInstanceOf(RuntimePlaybackError);
    expect(harness.player.contextSnapshot()).toMatchObject({
      state: "static",
      sticky: true,
      repeatedLosses: 1
    });
    expect(harness.player.motionSnapshot().actualMode).toBe("static");
    await expect(harness.player.prepare()).rejects.toBe(terminal);
    expect(harness.factory.activeAttempts).toBe(0);
  });

  it("recovers a loss during initial candidate preparation with the intro intact", async () => {
    const target = new FakeTarget();
    const harness = createHarness({
      contextTarget: target,
      behaviors: [{ kind: "pending" }, { kind: "success" }]
    });
    const preparing = harness.player.prepare();
    await waitForCall(harness.factory.calls, "prepare:opaque-high");

    target.loss();
    target.restore();
    await preparing;
    await harness.player.settled();

    expect(harness.factory.draws).toEqual([
      expect.objectContaining({ kind: "intro", frameIndex: 0 })
    ]);
    expect(harness.factory.maximumActiveAttempts).toBe(1);
    expect(harness.player.contextSnapshot()?.state).toBe("ready");
  });

  it("removes both canvas listeners and retires media on player disposal", async () => {
    const target = new FakeTarget();
    const harness = createHarness({ contextTarget: target });
    await harness.player.prepare();
    expect(target.listenerCount()).toBe(2);

    await harness.player.dispose();

    expect(target.listenerCount()).toBe(0);
    expect(harness.factory.activeAttempts).toBe(0);
    expect(harness.player.contextSnapshot()).toMatchObject({
      state: "disposed",
      listenerCount: 0,
      pendingOperations: 0
    });
  });

  it("rebases realtime after context restoration without hidden-time debt", async () => {
    const target = new FakeTarget();
    const frames = new ManualFrames();
    let now = 0;
    const harness = createHarness({
      contextTarget: target,
      behaviors: [{ kind: "success" }, { kind: "success" }],
      realtime: {
        requestFrame: frames.request,
        cancelFrame: frames.cancel,
        now: () => now
      }
    });
    await harness.player.prepare();
    harness.player.startRealtime();
    const ordinal = harness.player.realtimeSnapshot()?.nextPresentationOrdinal;

    target.loss();
    now = 30_000;
    target.restore();
    await harness.player.settled();

    expect(harness.player.realtimeSnapshot()).toMatchObject({
      running: true,
      nextPresentationOrdinal: ordinal,
      nextDeadlineMs: 30_033.333
    });
  });

  it("retires a lost context through logical state only", async () => {
    const target = new FakeTarget();
    const harness = createHarness({ contextTarget: target });
    await harness.player.prepare();

    target.loss();
    await harness.player.settled();

    expect(harness.player.contextSnapshot()).toMatchObject({
      state: "lost",
      sticky: false,
      failures: 0
    });
    expect(harness.player.snapshot().readiness).toBe("staticReady");
    expect(harness.stateStore.currentState()).toBe("idle");
    expect(harness.factory.activeAttempts).toBe(0);
  });

  it("terminalizes an exhausted rebuild without a restore retry loop", async () => {
    const target = new FakeTarget();
    const harness = createHarness({
      contextTarget: target,
      behaviors: [
        { kind: "success" },
        { kind: "failure", code: "readiness-failure" },
        { kind: "failure", code: "readiness-failure" }
      ]
    });
    await harness.player.prepare();
    target.loss();
    target.restore();
    const terminal = await harness.player.settled().catch(
      (error: unknown) => error
    );
    expect(terminal).toBeInstanceOf(RuntimePlaybackError);
    const creates = harness.factory.calls.filter((call) =>
      call.startsWith("create:")
    ).length;

    target.restore();
    await expect(harness.player.settled()).rejects.toBe(terminal);

    expect(harness.player.contextSnapshot()).toMatchObject({
      state: "static",
      sticky: true,
      failures: 1
    });
    expect(harness.factory.calls.filter((call) =>
      call.startsWith("create:")
    )).toHaveLength(creates);
  });

  it("continues restoration when terminal candidate cleanup throws", async () => {
    const target = new FakeTarget();
    const harness = createHarness({
      contextTarget: target,
      behaviors: [
        { kind: "success", cleanupFailure: true },
        { kind: "success" }
      ]
    });
    await harness.player.prepare();
    target.loss();
    target.restore();
    await harness.player.settled();

    expect(harness.player.contextSnapshot()?.state).toBe("ready");
    expect(harness.factory.activeAttempts).toBe(1);
    expect(harness.failures).toContainEqual(expect.objectContaining({
      context: { operation: "context-suspension-cleanup" }
    }));
  });

  it("aborts a gated restoration and removes listeners during disposal", async () => {
    const gate = new Deferred<void>();
    const target = new FakeTarget();
    const harness = createHarness({
      contextTarget: target,
      behaviors: [
        { kind: "success" },
        { kind: "gated", gate }
      ]
    });
    await harness.player.prepare();
    target.loss();
    target.restore();
    await waitForFactoryCreates(harness.factory.calls, 2);

    const disposal = harness.player.dispose();
    expect(target.listenerCount()).toBe(0);
    gate.resolve(undefined);
    await disposal;

    expect(harness.factory.activeAttempts).toBe(0);
    expect(harness.player.contextSnapshot()).toMatchObject({
      state: "disposed",
      pendingOperations: 0,
      listenerCount: 0
    });
  });
});

class FakeEvent implements BrowserContextRecoveryEvent {
  public prevented = false;
  public preventDefault(): void { this.prevented = true; }
}

class FakeTarget implements BrowserContextRecoveryEventTarget {
  readonly #listeners = new Map<string, Set<(event: BrowserContextRecoveryEvent) => void>>();

  public addEventListener(
    type: "webglcontextlost" | "webglcontextrestored",
    listener: (event: BrowserContextRecoveryEvent) => void
  ): void {
    const values = this.#listeners.get(type) ?? new Set();
    values.add(listener);
    this.#listeners.set(type, values);
  }

  public removeEventListener(
    type: "webglcontextlost" | "webglcontextrestored",
    listener: (event: BrowserContextRecoveryEvent) => void
  ): void {
    this.#listeners.get(type)?.delete(listener);
  }

  public loss(): FakeEvent {
    const event = new FakeEvent();
    for (const listener of this.#listeners.get("webglcontextlost") ?? []) {
      listener(event);
    }
    return event;
  }

  public restore(): void {
    const event = new FakeEvent();
    for (const listener of this.#listeners.get("webglcontextrestored") ?? []) {
      listener(event);
    }
  }

  public listenerCount(): number {
    return [...this.#listeners.values()].reduce(
      (total, listeners) => total + listeners.size,
      0
    );
  }
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((settle) => { resolve = settle; }),
    resolve
  };
}

async function settleMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function waitForFactoryCreates(
  calls: readonly string[],
  count: number
): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (calls.filter((call) => call.startsWith("create:")).length >= count) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error("timed out waiting for context rebuild candidate");
}

class ManualFrames {
  #next = 1;
  #pending: { readonly id: number; readonly callback: FrameRequestCallback } | null = null;

  public readonly request = (callback: FrameRequestCallback): number => {
    if (this.#pending !== null) throw new Error("frame already pending");
    const id = this.#next;
    this.#next += 1;
    this.#pending = { id, callback };
    return id;
  };

  public readonly cancel = (id: number): void => {
    if (this.#pending?.id === id) this.#pending = null;
  };
}
