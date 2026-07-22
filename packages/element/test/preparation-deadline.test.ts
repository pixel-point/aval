import { describe, expect, it } from "vitest";

import {
  PreparationGate,
  PreparationDeadline,
  preparationTimeout
} from "../src/preparation-deadline.js";

describe("PreparationGate", () => {
  it("settles exactly once with completion", async () => {
    const gate = new PreparationGate();

    expect(gate.settled).toBe(false);
    gate.complete();
    gate.fail(new Error("late failure"));

    await expect(gate.wait()).resolves.toBeUndefined();
    expect(gate.settled).toBe(true);
  });

  it("settles exactly once with the original failure", async () => {
    const gate = new PreparationGate();
    const failure = new Error("installation failed");

    gate.fail(failure);
    gate.complete();

    await expect(gate.wait()).rejects.toBe(failure);
    expect(gate.settled).toBe(true);
  });
});

describe("PreparationDeadline", () => {
  it("starts an immediate deadline when it is created", () => {
    const clock = new ManualClock();
    const deadline = PreparationDeadline.begin({
      parent: new AbortController().signal,
      timeoutMs: 100,
      platform: clock
    });

    expect(clock.pendingTimers).toBe(1);
    expect(deadline.remainingMs()).toBe(100);
    clock.advance(25);
    expect(deadline.remainingMs()).toBe(75);
    expect(deadline.signal.aborted).toBe(false);
  });

  it("does not start a deferred child until requested", () => {
    const clock = new ManualClock();
    const root = PreparationDeadline.begin({
      parent: new AbortController().signal,
      timeoutMs: 1_000,
      platform: clock
    });
    const child = root.forkDeferred(100);

    expect(clock.pendingTimers).toBe(1);
    clock.advance(20);
    expect(child.remainingMs()).toBe(100);
    child.start();
    expect(clock.pendingTimers).toBe(2);

    clock.advance(99);
    expect(child.signal.aborted).toBe(false);
    clock.advance(1);
    expect(child.signal.aborted).toBe(true);
    expect(child.timedOut).toBe(true);
    expect(root.signal.aborted).toBe(false);
  });

  it("completes without aborting and cannot be restarted", () => {
    const clock = new ManualClock();
    const deadline = PreparationDeadline.begin({
      parent: new AbortController().signal,
      timeoutMs: 100,
      platform: clock
    });

    deadline.complete();
    expect(deadline.remainingMs()).toBe(0);
    expect(clock.pendingTimers).toBe(0);
    expect(clock.clearedTimers).toEqual([1]);

    deadline.start();
    clock.advance(100);
    expect(clock.pendingTimers).toBe(0);
    expect(deadline.signal.aborted).toBe(false);
    expect(deadline.timedOut).toBe(false);
  });

  it("disposes its timer, parent subscription, and signal", () => {
    const clock = new ManualClock();
    const parent = new AbortController();
    const deadline = PreparationDeadline.begin({
      parent: parent.signal,
      timeoutMs: 100,
      platform: clock
    });

    deadline.dispose();
    expect(clock.pendingTimers).toBe(0);
    expect(deadline.signal.aborted).toBe(true);
    expect(deadline.signal.reason).toMatchObject({ name: "AbortError" });

    const disposalReason = deadline.signal.reason;
    parent.abort(new Error("late parent abort"));
    expect(deadline.signal.reason).toBe(disposalReason);
  });

  it("propagates a parent abort before a deferred child starts", () => {
    const clock = new ManualClock();
    const parent = new AbortController();
    const root = PreparationDeadline.begin({
      parent: parent.signal,
      timeoutMs: 1_000,
      platform: clock
    });
    const child = root.forkDeferred(100);
    const reason = new Error("generation retired");

    parent.abort(reason);
    expect(root.signal.reason).toBe(reason);
    expect(child.signal.reason).toBe(reason);
    expect(root.timedOut).toBe(false);
    expect(child.timedOut).toBe(false);
    expect(clock.pendingTimers).toBe(0);

    child.start();
    expect(clock.pendingTimers).toBe(0);
  });

  it("marks only its own timer expiry as a timeout", () => {
    const clock = new ManualClock();
    const deadline = PreparationDeadline.begin({
      parent: new AbortController().signal,
      timeoutMs: 100,
      platform: clock
    });

    clock.advance(99);
    expect(deadline.signal.aborted).toBe(false);
    expect(deadline.timedOut).toBe(false);
    clock.advance(1);

    expect(deadline.signal.aborted).toBe(true);
    expect(deadline.signal.reason).toMatchObject({
      name: "TimeoutError",
      message: "AVAL preparation timed out"
    });
    expect(deadline.timedOut).toBe(true);
    expect(clock.pendingTimers).toBe(0);
  });

  it("caps deferred forks to the parent's rounded remaining time", () => {
    const clock = new ManualClock();
    const root = PreparationDeadline.begin({
      parent: new AbortController().signal,
      timeoutMs: 1_000,
      platform: clock
    });

    clock.advance(250.25);
    expect(root.remainingMs()).toBe(750);
    expect(root.forkDeferred(900).remainingMs()).toBe(750);
    expect(root.forkDeferred(200).remainingMs()).toBe(200);

    clock.advance(749.75);
    expect(() => root.forkDeferred(1)).toThrowError(
      expect.objectContaining({ name: "TimeoutError" })
    );
  });

  it("validates construction, fork limits, and canonical timeout errors", () => {
    const clock = new ManualClock();
    const parent = new AbortController().signal;

    expect(() => PreparationDeadline.begin({
      parent,
      timeoutMs: 0,
      platform: clock
    })).toThrowError(new RangeError("AVAL preparation timeout is invalid"));

    const deadline = PreparationDeadline.begin({
      parent,
      timeoutMs: 100,
      platform: clock
    });
    expect(() => deadline.forkDeferred(0)).toThrowError(
      expect.objectContaining({ name: "TimeoutError" })
    );
    expect(preparationTimeout()).toMatchObject({
      name: "TimeoutError",
      message: "AVAL preparation timed out"
    });
  });
});

class ManualClock {
  #now = 0;
  #nextHandle = 1;
  readonly #timers = new Map<number, Readonly<{
    callback: () => void;
    expiresAt: number;
  }>>();
  public readonly clearedTimers: number[] = [];

  public readonly now = (): number => this.#now;

  public readonly setTimeout = (
    callback: () => void,
    delay: number
  ): number => {
    const handle = this.#nextHandle;
    this.#nextHandle += 1;
    this.#timers.set(handle, Object.freeze({
      callback,
      expiresAt: this.#now + delay
    }));
    return handle;
  };

  public readonly clearTimeout = (handle: number): void => {
    if (!this.#timers.delete(handle)) return;
    this.clearedTimers.push(handle);
  };

  public get pendingTimers(): number {
    return this.#timers.size;
  }

  public advance(elapsedMs: number): void {
    const target = this.#now + elapsedMs;
    while (true) {
      const next = [...this.#timers.entries()]
        .filter(([, timer]) => timer.expiresAt <= target)
        .sort((left, right) => left[1].expiresAt - right[1].expiresAt)[0];
      if (next === undefined) break;
      const [handle, timer] = next;
      this.#now = timer.expiresAt;
      this.#timers.delete(handle);
      timer.callback();
    }
    this.#now = target;
  }
}
