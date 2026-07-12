import { describe, expect, it, vi } from "vitest";

import {
  RUNTIME_SESSION_CLEANUP_PHASES,
  RuntimeSessionLifecycle,
  type RuntimeSessionCleanupPhase
} from "./runtime-session-lifecycle.js";

describe("runtime session lifecycle", () => {
  it("starts one frozen root generation", () => {
    const lifecycle = new RuntimeSessionLifecycle();
    const generation = lifecycle.current();

    expect(generation.generation).toBe(1);
    expect(generation.signal.aborted).toBe(false);
    expect(generation.isCurrent()).toBe(true);
    expect(Object.isFrozen(generation)).toBe(true);
    expect(lifecycle.snapshot()).toEqual({
      currentGeneration: 1,
      reservedGeneration: 1,
      state: "active",
      registeredCleanupCount: 0,
      trackedWorkCount: 0,
      pendingWaitCount: 0,
      cleanupFailureCount: 0,
      retiredGenerationCount: 0
    });
    expect(Object.isFrozen(lifecycle.snapshot())).toBe(true);
  });

  it("runs the exact terminal order with LIFO ownership inside a phase", async () => {
    const lifecycle = new RuntimeSessionLifecycle();
    const generation = lifecycle.current();
    const order: string[] = [];
    for (const phase of RUNTIME_SESSION_CLEANUP_PHASES) {
      generation.registerCleanup(phase, () => {
        expect(generation.signal.aborted).toBe(true);
        order.push(phase);
      });
    }
    generation.registerCleanup("candidate-gl", () => {
      order.push("candidate-gl-inner");
    });
    const wait = generation.createPendingWait<void>();
    wait.promise.catch(() => { order.push("waiters"); });

    await lifecycle.dispose();

    expect(order).toEqual([
      "network-digest",
      "readers-timers",
      "realtime",
      "candidate-gl-inner",
      "candidate-gl",
      "statics",
      "leases",
      "listeners",
      "participant",
      "queues",
      "waiters"
    ]);
    await expect(wait.promise).rejects.toMatchObject({ name: "AbortError" });
    expect(lifecycle.snapshot()).toMatchObject({
      state: "disposed",
      currentGeneration: null,
      registeredCleanupCount: 0,
      trackedWorkCount: 0,
      pendingWaitCount: 0,
      retiredGenerationCount: 1
    });
  });

  it("continues through synchronous and asynchronous failure in every phase", async () => {
    const lifecycle = new RuntimeSessionLifecycle();
    const generation = lifecycle.current();
    const reached: string[] = [];
    RUNTIME_SESSION_CLEANUP_PHASES.forEach((phase, index) => {
      generation.registerCleanup(phase, () => {
        reached.push(`${phase}:after`);
      });
      generation.registerCleanup(phase, index % 2 === 0
        ? () => { throw new Error(`sync ${phase}`); }
        : async () => { throw new Error(`async ${phase}`); });
    });

    await expect(lifecycle.dispose()).resolves.toBeUndefined();
    expect(reached).toEqual(
      RUNTIME_SESSION_CLEANUP_PHASES.map((phase) => `${phase}:after`)
    );
    expect(lifecycle.snapshot()).toMatchObject({
      cleanupFailureCount: RUNTIME_SESSION_CLEANUP_PHASES.length,
      registeredCleanupCount: 0,
      trackedWorkCount: 0,
      pendingWaitCount: 0
    });
  });

  it("waits for all registered in-flight work, including rejection", async () => {
    const lifecycle = new RuntimeSessionLifecycle();
    const generation = lifecycle.current();
    const first = deferred<void>();
    const second = deferred<void>();
    generation.track(first.promise);
    generation.track(second.promise).catch(() => undefined);
    const disposal = lifecycle.dispose();
    let settled = false;
    disposal.then(() => { settled = true; });

    await Promise.resolve();
    expect(generation.signal.aborted).toBe(true);
    expect(settled).toBe(false);
    first.resolve();
    second.reject(new Error("late failure"));
    await disposal;
    expect(settled).toBe(true);
    expect(lifecycle.snapshot()).toMatchObject({
      trackedWorkCount: 0,
      state: "disposed"
    });
  });

  it("waits for an asynchronous current-generation publisher", async () => {
    const lifecycle = new RuntimeSessionLifecycle();
    const generation = lifecycle.current();
    const publication = deferred<string>();
    const operation = generation.publish(
      Promise.resolve("ready"),
      () => publication.promise
    );
    await Promise.resolve();
    const disposal = lifecycle.dispose();
    let settled = false;
    disposal.then(() => { settled = true; });

    await Promise.resolve();
    expect(settled).toBe(false);
    publication.resolve("published");
    await expect(operation).resolves.toBe("published");
    await disposal;
    expect(lifecycle.snapshot().trackedWorkCount).toBe(0);
  });

  it("invalidates replacement synchronously and blocks stale publication", async () => {
    const lifecycle = new RuntimeSessionLifecycle();
    const first = lifecycle.current();
    const work = deferred<string>();
    const publish = vi.fn((value: string) => value.toUpperCase());
    const publication = first.publish(work.promise, publish);
    const pending = first.createPendingWait<string>();
    let rejectionCount = 0;
    pending.promise.catch(() => { rejectionCount += 1; });

    const replacement = lifecycle.replace();
    expect(first.signal.aborted).toBe(true);
    expect(first.isCurrent()).toBe(false);
    work.resolve("late");
    await expect(publication).rejects.toMatchObject({ name: "AbortError" });
    await expect(pending.promise).rejects.toMatchObject({ name: "AbortError" });
    const second = await replacement;

    expect(publish).not.toHaveBeenCalled();
    expect(rejectionCount).toBe(1);
    expect(second.generation).toBe(2);
    expect(second.isCurrent()).toBe(true);
    expect(() => first.registerCleanup("leases", () => undefined))
      .toThrowError(expect.objectContaining({ name: "AbortError" }));
    await lifecycle.dispose();
  });

  it("serializes rapid replacements into monotonically increasing generations", async () => {
    const lifecycle = new RuntimeSessionLifecycle();
    const first = lifecycle.current();
    const cleanup = vi.fn();
    first.registerCleanup("network-digest", cleanup);

    const secondPromise = lifecycle.replace();
    const thirdPromise = lifecycle.replace();
    const [second, third] = await Promise.all([secondPromise, thirdPromise]);

    expect(cleanup).toHaveBeenCalledOnce();
    expect(second.generation).toBe(2);
    expect(second.signal.aborted).toBe(true);
    expect(second.isCurrent()).toBe(false);
    expect(third.generation).toBe(3);
    expect(third.signal.aborted).toBe(false);
    expect(third.isCurrent()).toBe(true);
    expect(lifecycle.snapshot()).toMatchObject({
      currentGeneration: 3,
      reservedGeneration: 3,
      retiredGenerationCount: 2
    });
    await lifecycle.dispose();
  });

  it("settles each public wait exactly once", async () => {
    const lifecycle = new RuntimeSessionLifecycle();
    const generation = lifecycle.current();
    const resolved = generation.createPendingWait<number>();
    const aborted = generation.createPendingWait<number>();
    resolved.resolve(7);
    resolved.reject(new Error("ignored"));
    let abortCount = 0;
    aborted.promise.catch(() => { abortCount += 1; });

    await lifecycle.dispose();
    aborted.resolve(9);
    aborted.reject(new Error("ignored"));

    await expect(resolved.promise).resolves.toBe(7);
    await expect(aborted.promise).rejects.toMatchObject({ name: "AbortError" });
    expect(abortCount).toBe(1);
    expect(lifecycle.snapshot().pendingWaitCount).toBe(0);
  });

  it("allows cleanup registrations to be withdrawn idempotently", async () => {
    const lifecycle = new RuntimeSessionLifecycle();
    const cleanup = vi.fn();
    const unregister = lifecycle.current().registerCleanup("statics", cleanup);
    unregister();
    unregister();

    await lifecycle.dispose();
    expect(cleanup).not.toHaveBeenCalled();
  });

  it("returns one idempotent disposal promise and supersedes queued replacement", async () => {
    const lifecycle = new RuntimeSessionLifecycle();
    const replacement = lifecycle.replace();
    const firstDisposal = lifecycle.dispose();
    const secondDisposal = lifecycle.dispose();

    expect(firstDisposal).toBe(secondDisposal);
    await expect(replacement).rejects.toMatchObject({ code: "disposed" });
    await firstDisposal;
    expect(lifecycle.snapshot().state).toBe("disposed");
    expect(() => lifecycle.current()).toThrowError(
      expect.objectContaining({ code: "disposed" })
    );
    await expect(lifecycle.replace()).rejects.toMatchObject({ code: "disposed" });
  });

  it.each([
    "metadata",
    "current-static",
    "all-statics",
    "payload",
    "digest",
    "candidate",
    "readiness",
    "suspension",
    "eviction",
    "context-recovery",
    "disposal"
  ])("retires rejected %s work without poisoning disposal", async () => {
    const lifecycle = new RuntimeSessionLifecycle();
    lifecycle.current().track(Promise.reject(new Error("injected")))
      .catch(() => undefined);
    await expect(lifecycle.dispose()).resolves.toBeUndefined();
    expect(lifecycle.snapshot()).toMatchObject({
      trackedWorkCount: 0,
      state: "disposed"
    });
  });

  it("rejects unknown cleanup phases and hostile callbacks before registration", () => {
    const lifecycle = new RuntimeSessionLifecycle();
    expect(() => lifecycle.current().registerCleanup(
      "unknown" as RuntimeSessionCleanupPhase,
      () => undefined
    )).toThrow(TypeError);
    expect(() => lifecycle.current().registerCleanup(
      "leases",
      null as unknown as () => void
    )).toThrow(TypeError);
    expect(lifecycle.snapshot().registeredCleanupCount).toBe(0);
  });
});

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  return {
    promise: new Promise<T>((done, fail) => {
      resolve = done;
      reject = fail;
    }),
    resolve,
    reject
  };
}
