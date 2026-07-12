import { describe, expect, it } from "vitest";

import {
  BrowserContextRecovery,
  type BrowserContextRecoveryEvent,
  type BrowserContextRecoveryEventTarget
} from "./browser-context-recovery.js";

describe("BrowserContextRecovery", () => {
  it("covers and freezes synchronously before retiring animated resources", async () => {
    const target = new FakeContextTarget();
    const order: string[] = [];
    const retirement = deferred<void>();
    const recovery = new BrowserContextRecovery({
      target,
      coverStatic: () => order.push("cover"),
      freeze: () => order.push("freeze"),
      retireAnimated: async () => {
        order.push("retire:start");
        await retirement.promise;
        order.push("retire:end");
      },
      canRestore: () => true,
      rebuild: async () => {
        order.push("rebuild");
        return true;
      },
      revealAnimated: () => order.push("reveal")
    });

    const event = target.dispatchLoss();
    expect(event.prevented).toBe(true);
    expect(order).toEqual(["cover", "freeze"]);
    expect(recovery.snapshot()).toMatchObject({
      state: "lost",
      lossCount: 1,
      activeGeneration: 1
    });

    target.dispatchRestore();
    await settleMicrotasks();
    expect(order).toEqual(["cover", "freeze", "retire:start"]);
    retirement.resolve();
    await recovery.settled();
    expect(order).toEqual([
      "cover",
      "freeze",
      "retire:start",
      "retire:end",
      "rebuild",
      "reveal"
    ]);
    expect(recovery.snapshot()).toMatchObject({
      state: "ready",
      restorationCount: 1,
      successfulRestorations: 1,
      activeGeneration: 1
    });
  });

  it("makes a repeated loss during restoration sticky and rejects late success", async () => {
    const target = new FakeContextTarget();
    const rebuild = deferred<boolean>();
    const order: string[] = [];
    const recovery = new BrowserContextRecovery({
      target,
      coverStatic: () => order.push("cover"),
      freeze: () => order.push("freeze"),
      retireAnimated: () => { order.push("retire"); },
      canRestore: () => true,
      rebuild: async ({ signal }) => {
        order.push("rebuild");
        const result = await rebuild.promise;
        order.push(signal.aborted ? "late-aborted" : "late-current");
        return result;
      },
      revealAnimated: () => order.push("reveal")
    });

    target.dispatchLoss();
    target.dispatchRestore();
    await waitFor(() => order.includes("rebuild"));
    target.dispatchLoss();
    expect(recovery.snapshot()).toMatchObject({
      state: "static",
      sticky: true,
      lossCount: 2,
      activeGeneration: 2
    });
    rebuild.resolve(true);
    await recovery.settled();
    expect(order).toContain("late-aborted");
    expect(order).not.toContain("reveal");

    target.dispatchRestore();
    await recovery.settled();
    expect(recovery.snapshot()).toMatchObject({
      state: "static",
      restorationCount: 1,
      successfulRestorations: 0
    });
  });

  it("keeps a reduced, hidden, or otherwise ineligible owner statically covered", async () => {
    const target = new FakeContextTarget();
    let eligible = false;
    let rebuilds = 0;
    const recovery = new BrowserContextRecovery({
      target,
      coverStatic() {},
      freeze() {},
      retireAnimated() {},
      canRestore: () => eligible,
      rebuild: async () => {
        rebuilds += 1;
        return true;
      },
      revealAnimated() {}
    });

    target.dispatchLoss();
    target.dispatchRestore();
    await recovery.settled();
    expect(rebuilds).toBe(0);
    expect(recovery.snapshot().state).toBe("static");

    eligible = true;
    recovery.requestRestore();
    await recovery.settled();
    expect(rebuilds).toBe(1);
    expect(recovery.snapshot().state).toBe("ready");
  });

  it("does not rebuild before the browser has reported context restoration", async () => {
    const target = new FakeContextTarget();
    let rebuilds = 0;
    const recovery = new BrowserContextRecovery({
      target,
      coverStatic() {},
      freeze() {},
      retireAnimated() {},
      canRestore: () => true,
      rebuild: async () => {
        rebuilds += 1;
        return true;
      },
      revealAnimated() {}
    });

    target.dispatchLoss();
    recovery.requestRestore();
    await recovery.settled();
    expect(rebuilds).toBe(0);
    expect(recovery.snapshot().state).toBe("lost");

    target.dispatchRestore();
    await recovery.settled();
    expect(rebuilds).toBe(1);
    expect(recovery.snapshot().state).toBe("ready");
  });

  it("makes a rebuild that returns false sticky instead of retrying in a loop", async () => {
    const target = new FakeContextTarget();
    let rebuilds = 0;
    const recovery = new BrowserContextRecovery({
      target,
      coverStatic() {},
      freeze() {},
      retireAnimated() {},
      canRestore: () => true,
      rebuild: async () => {
        rebuilds += 1;
        return false;
      },
      revealAnimated() {}
    });

    target.dispatchLoss();
    target.dispatchRestore();
    await recovery.settled();
    expect(recovery.snapshot()).toMatchObject({
      state: "static",
      sticky: true,
      failures: 1
    });
    recovery.requestRestore();
    await recovery.settled();
    expect(rebuilds).toBe(1);
  });

  it("normalizes cover, retirement, rebuild, and reveal failures without leaking", async () => {
    for (const seam of ["cover", "retire", "rebuild", "reveal"] as const) {
      const target = new FakeContextTarget();
      const failures: string[] = [];
      const recovery = new BrowserContextRecovery({
        target,
        coverStatic() {
          if (seam === "cover") throw new Error("cover failure");
        },
        freeze() {},
        retireAnimated() {
          if (seam === "retire") throw new Error("retire failure");
        },
        canRestore: () => true,
        async rebuild() {
          if (seam === "rebuild") throw new Error("rebuild failure");
          return true;
        },
        revealAnimated() {
          if (seam === "reveal") throw new Error("reveal failure");
        },
        onFailure: ({ code, context }) => {
          failures.push(`${code}:${context.lifecyclePhase ?? ""}`);
        }
      });

      expect(() => target.dispatchLoss()).not.toThrow();
      target.dispatchRestore();
      await recovery.settled();
      expect(recovery.snapshot()).toMatchObject({
        state: "static",
        failures: 1
      });
      expect(failures).toEqual([`context-loss:context-${seam}`]);
      await recovery.dispose();
      expect(target.listenerCount()).toBe(0);
    }
  });

  it("still freezes and retires animated ownership when static cover fails", async () => {
    const target = new FakeContextTarget();
    const order: string[] = [];
    const recovery = new BrowserContextRecovery({
      target,
      coverStatic() {
        order.push("cover");
        throw new Error("cover failed");
      },
      freeze: () => { order.push("freeze"); },
      retireAnimated: () => { order.push("retire"); },
      canRestore: () => true,
      rebuild: async () => true,
      revealAnimated() {}
    });

    target.dispatchLoss();
    await recovery.settled();
    expect(order).toEqual(["cover", "freeze", "retire"]);
    expect(recovery.snapshot()).toMatchObject({
      state: "static",
      sticky: true,
      failures: 1,
      pendingOperations: 0
    });
  });

  it("removes listeners, aborts restoration, and waits for retirement on disposal", async () => {
    const target = new FakeContextTarget();
    const retirement = deferred<void>();
    const rebuild = deferred<boolean>();
    let revealCount = 0;
    const recovery = new BrowserContextRecovery({
      target,
      coverStatic() {},
      freeze() {},
      retireAnimated: () => retirement.promise,
      canRestore: () => true,
      rebuild: () => rebuild.promise,
      revealAnimated: () => { revealCount += 1; }
    });

    target.dispatchLoss();
    target.dispatchRestore();
    const disposal = recovery.dispose();
    expect(target.listenerCount()).toBe(0);
    expect(recovery.snapshot().state).toBe("disposed");
    retirement.resolve();
    rebuild.resolve(true);
    await disposal;
    await recovery.dispose();
    expect(revealCount).toBe(0);
    expect(recovery.snapshot()).toMatchObject({
      state: "disposed",
      listenerCount: 0,
      pendingOperations: 0
    });
    expect(() => target.dispatchLoss()).not.toThrow();
  });

  it("captures listener capabilities once and rejects malformed targets", () => {
    let addReads = 0;
    let removeReads = 0;
    const raw = new FakeContextTarget();
    const target = Object.create(null) as BrowserContextRecoveryEventTarget;
    Object.defineProperties(target, {
      addEventListener: {
        get() {
          addReads += 1;
          return raw.addEventListener.bind(raw);
        }
      },
      removeEventListener: {
        get() {
          removeReads += 1;
          return raw.removeEventListener.bind(raw);
        }
      }
    });
    const recovery = createNoopRecovery(target);
    expect(addReads).toBe(1);
    expect(removeReads).toBe(1);
    expect(raw.listenerCount()).toBe(2);
    void recovery.dispose();
    expect(raw.listenerCount()).toBe(0);

    expect(() => createNoopRecovery({} as BrowserContextRecoveryEventTarget))
      .toThrow("event target");
  });
});

function createNoopRecovery(
  target: BrowserContextRecoveryEventTarget
): BrowserContextRecovery {
  return new BrowserContextRecovery({
    target,
    coverStatic() {},
    freeze() {},
    retireAnimated() {},
    canRestore: () => false,
    rebuild: async () => false,
    revealAnimated() {}
  });
}

class FakeContextEvent implements BrowserContextRecoveryEvent {
  public prevented = false;
  public preventDefault(): void {
    this.prevented = true;
  }
}

class FakeContextTarget implements BrowserContextRecoveryEventTarget {
  readonly #listeners = new Map<string, Set<(event: BrowserContextRecoveryEvent) => void>>();

  public addEventListener(
    type: "webglcontextlost" | "webglcontextrestored",
    listener: (event: BrowserContextRecoveryEvent) => void
  ): void {
    const listeners = this.#listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(type, listeners);
  }

  public removeEventListener(
    type: "webglcontextlost" | "webglcontextrestored",
    listener: (event: BrowserContextRecoveryEvent) => void
  ): void {
    this.#listeners.get(type)?.delete(listener);
  }

  public dispatchLoss(): FakeContextEvent {
    const event = new FakeContextEvent();
    for (const listener of this.#listeners.get("webglcontextlost") ?? []) {
      listener(event);
    }
    return event;
  }

  public dispatchRestore(): void {
    const event = new FakeContextEvent();
    for (const listener of this.#listeners.get("webglcontextrestored") ?? []) {
      listener(event);
    }
  }

  public listenerCount(): number {
    let total = 0;
    for (const listeners of this.#listeners.values()) total += listeners.size;
    return total;
  }
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

async function settleMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await settleMicrotasks();
  }
  throw new Error("condition did not settle");
}
