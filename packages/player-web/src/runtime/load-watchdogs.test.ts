import { describe, expect, it, vi } from "vitest";

import { RuntimePlaybackError } from "./errors.js";
import {
  DEFAULT_FIRST_BYTE_TIMEOUT_MS,
  DEFAULT_IDLE_BODY_TIMEOUT_MS,
  DEFAULT_LOAD_OVERALL_TIMEOUT_MS,
  createLoadOperationDeadline,
  createLoadWatchdogs,
  type LoadWatchdogTimerHost
} from "./load-watchdogs.js";

describe("load watchdogs", () => {
  it("arms finite defaults and resets idle only for accepted non-empty bytes", () => {
    const timers = new ManualTimerHost();
    const watchdogs = createLoadWatchdogs({ timers });

    expect(watchdogs.snapshot()).toMatchObject({
      active: true,
      acceptedBodyBytes: 0,
      overallDeadlineMs: DEFAULT_LOAD_OVERALL_TIMEOUT_MS,
      firstByteDeadlineMs: DEFAULT_FIRST_BYTE_TIMEOUT_MS,
      idleBodyDeadlineMs: null,
      pendingTimerCount: 2
    });

    timers.advance(100);
    watchdogs.noteHeadersReceived();
    watchdogs.noteBodyProgress(0);
    expect(watchdogs.snapshot()).toMatchObject({
      firstByteDeadlineMs: DEFAULT_FIRST_BYTE_TIMEOUT_MS,
      idleBodyDeadlineMs: null,
      pendingTimerCount: 2
    });

    watchdogs.noteBodyProgress(3);
    expect(watchdogs.snapshot()).toMatchObject({
      acceptedBodyBytes: 3,
      firstByteDeadlineMs: null,
      idleBodyDeadlineMs: 100 + DEFAULT_IDLE_BODY_TIMEOUT_MS,
      pendingTimerCount: 2
    });

    timers.advance(200);
    watchdogs.noteBodyProgress(2);
    expect(watchdogs.snapshot()).toMatchObject({
      acceptedBodyBytes: 5,
      idleBodyDeadlineMs: 300 + DEFAULT_IDLE_BODY_TIMEOUT_MS,
      pendingTimerCount: 2
    });

    watchdogs.complete();
    watchdogs.complete();
    expect(watchdogs.snapshot()).toMatchObject({
      active: false,
      pendingTimerCount: 0,
      linkedAbortListenerCount: 0,
      pendingWaitCount: 0
    });
    expect(timers.pendingCount).toBe(0);
  });

  it("rejects a stalled header/first-byte wait with one stable failure", async () => {
    const timers = new ManualTimerHost();
    const watchdogs = createLoadWatchdogs({
      timers,
      overallTimeoutMs: 100,
      firstByteTimeoutMs: 10,
      idleBodyTimeoutMs: 20
    });
    const late = deferred<string>();
    let resolutions = 0;
    const outcome = watchdogs.watch(late.promise).then(
      (value) => {
        resolutions += 1;
        return value;
      },
      (error: unknown) => error
    );

    timers.advance(10);
    const error = await outcome;
    expect(error).toBeInstanceOf(RuntimePlaybackError);
    expect(error).toMatchObject({
      code: "watchdog-timeout",
      failure: { context: { policyPhase: "first-byte" } }
    });
    expect(watchdogs.signal.aborted).toBe(true);
    expect(watchdogs.snapshot()).toMatchObject({
      active: false,
      expiredPhase: "first-byte",
      pendingTimerCount: 0,
      pendingWaitCount: 0
    });

    late.resolve("too late");
    await Promise.resolve();
    expect(resolutions).toBe(0);
  });

  it("expires idle after the last non-empty body progress", async () => {
    const timers = new ManualTimerHost();
    const watchdogs = createLoadWatchdogs({
      timers,
      overallTimeoutMs: 100,
      firstByteTimeoutMs: 20,
      idleBodyTimeoutMs: 5
    });
    watchdogs.noteBodyProgress(1);
    timers.advance(4);
    watchdogs.noteBodyProgress(0);
    const stalled = watchdogs.watch(new Promise<never>(() => {})).catch(
      (error: unknown) => error
    );

    timers.advance(1);

    await expect(stalled).resolves.toMatchObject({
      code: "watchdog-timeout",
      failure: { context: { policyPhase: "idle-body" } }
    });
  });

  it("keeps the overall deadline finite despite continuing body progress", async () => {
    const timers = new ManualTimerHost();
    const watchdogs = createLoadWatchdogs({
      timers,
      overallTimeoutMs: 12,
      firstByteTimeoutMs: 10,
      idleBodyTimeoutMs: 10
    });
    watchdogs.noteBodyProgress(1);
    timers.advance(6);
    watchdogs.noteBodyProgress(1);
    const stalled = watchdogs.watch(new Promise<never>(() => {})).catch(
      (error: unknown) => error
    );

    timers.advance(6);

    await expect(stalled).resolves.toMatchObject({
      code: "watchdog-timeout",
      failure: { context: { policyPhase: "overall" } }
    });
  });

  it("shares one absolute deadline across requests instead of restarting it", async () => {
    const timers = new ManualTimerHost();
    const deadline = createLoadOperationDeadline({ timers, timeoutMs: 10 });
    const first = createLoadWatchdogs({
      timers,
      overallDeadline: deadline,
      firstByteTimeoutMs: 20,
      idleBodyTimeoutMs: 20
    });
    timers.advance(6);
    first.noteBodyProgress(1);
    first.complete();

    const second = createLoadWatchdogs({
      timers,
      overallDeadline: deadline,
      firstByteTimeoutMs: 20,
      idleBodyTimeoutMs: 20
    });
    expect(second.snapshot()).toMatchObject({
      overallDeadlineMs: 10,
      pendingTimerCount: 1
    });
    const stalled = second.watch(new Promise<never>(() => {})).catch(
      (cause: unknown) => cause
    );
    timers.advance(4);

    await expect(stalled).resolves.toMatchObject({
      code: "watchdog-timeout",
      failure: { context: { policyPhase: "overall" } }
    });
    expect(second.snapshot()).toMatchObject({
      active: false,
      expiredPhase: "overall",
      pendingTimerCount: 0,
      linkedAbortListenerCount: 0,
      pendingWaitCount: 0
    });
    expect(deadline.snapshot()).toMatchObject({
      active: false,
      terminalCode: "watchdog-timeout",
      pendingTimerCount: 0,
      linkedAbortListenerCount: 0,
      pendingWaitCount: 0
    });
    expect(timers.pendingCount).toBe(0);
  });

  it("allows sequential request work that completes before the boundary", () => {
    const timers = new ManualTimerHost();
    const deadline = createLoadOperationDeadline({ timers, timeoutMs: 10 });
    for (const elapsed of [4, 5]) {
      const request = createLoadWatchdogs({
        timers,
        overallDeadline: deadline,
        firstByteTimeoutMs: 20,
        idleBodyTimeoutMs: 20
      });
      timers.advance(elapsed);
      request.noteBodyProgress(1);
      request.complete();
      deadline.assertActive();
    }
    deadline.complete();
    expect(deadline.snapshot()).toMatchObject({
      active: false,
      terminalCode: null,
      pendingTimerCount: 0,
      linkedAbortListenerCount: 0,
      pendingWaitCount: 0
    });
    expect(timers.pendingCount).toBe(0);
  });

  it("borrows aggregate bounded interest without arming another overall timer", () => {
    const timers = new ManualTimerHost();
    const interest = new AbortController();
    const watchdogs = createLoadWatchdogs({
      timers,
      overallSignal: interest.signal,
      firstByteTimeoutMs: 20,
      idleBodyTimeoutMs: 20
    });
    expect(watchdogs.snapshot()).toMatchObject({
      overallDeadlineMs: null,
      pendingTimerCount: 1,
      linkedAbortListenerCount: 1
    });
    watchdogs.complete();
    expect(timers.pendingCount).toBe(0);
  });

  it("links caller and session abort one-way and removes both listeners", async () => {
    const timers = new ManualTimerHost();
    const caller = new AbortController();
    const session = new AbortController();
    const callerAdd = vi.spyOn(caller.signal, "addEventListener");
    const callerRemove = vi.spyOn(caller.signal, "removeEventListener");
    const sessionAdd = vi.spyOn(session.signal, "addEventListener");
    const sessionRemove = vi.spyOn(session.signal, "removeEventListener");
    const watchdogs = createLoadWatchdogs({
      timers,
      signals: [caller.signal, session.signal]
    });
    const stalled = watchdogs.watch(new Promise<never>(() => {})).catch(
      (error: unknown) => error
    );

    session.abort();

    await expect(stalled).resolves.toMatchObject({ code: "abort" });
    expect(watchdogs.signal.aborted).toBe(true);
    expect(callerAdd).toHaveBeenCalledTimes(1);
    expect(sessionAdd).toHaveBeenCalledTimes(1);
    expect(callerRemove).toHaveBeenCalledTimes(1);
    expect(sessionRemove).toHaveBeenCalledTimes(1);
    expect(watchdogs.snapshot()).toMatchObject({
      pendingTimerCount: 0,
      linkedAbortListenerCount: 0,
      pendingWaitCount: 0
    });
    expect(timers.pendingCount).toBe(0);
  });

  it("handles an already-aborted signal without installing listeners or timers", () => {
    const timers = new ManualTimerHost();
    const controller = new AbortController();
    controller.abort();
    const add = vi.spyOn(controller.signal, "addEventListener");

    const watchdogs = createLoadWatchdogs({
      timers,
      signals: [controller.signal]
    });

    expect(add).not.toHaveBeenCalled();
    expect(watchdogs.snapshot()).toMatchObject({
      active: false,
      terminalCode: "abort",
      pendingTimerCount: 0,
      linkedAbortListenerCount: 0
    });
    expect(timers.pendingCount).toBe(0);
  });

  it("removes abort listeners when registration attaches then throws", () => {
    for (const create of [
      (signal: AbortSignal) => createLoadOperationDeadline({ signals: [signal] }),
      (signal: AbortSignal) => createLoadWatchdogs({ signals: [signal] })
    ]) {
      const controller = new AbortController();
      const nativeAdd = controller.signal.addEventListener;
      const remove = vi.spyOn(controller.signal, "removeEventListener");
      const add = vi.spyOn(controller.signal, "addEventListener")
        .mockImplementation(function (
          this: AbortSignal,
          ...args: Parameters<AbortSignal["addEventListener"]>
        ): void {
          Reflect.apply(nativeAdd, this, args);
          throw new Error("attached then failed");
        });
      try {
        expect(() => create(controller.signal)).toThrow();
        expect(remove).toHaveBeenCalledOnce();
      } finally {
        add.mockRestore();
        remove.mockRestore();
      }
    }
  });

  it("rejects hostile deadlines before any timer is retained", () => {
    const timers = new ManualTimerHost();

    expect(() => createLoadWatchdogs({
      timers,
      overallTimeoutMs: Number.POSITIVE_INFINITY
    })).toThrow(TypeError);
    expect(() => createLoadWatchdogs({
      timers,
      firstByteTimeoutMs: 0
    })).toThrow(TypeError);
    expect(() => createLoadWatchdogs({
      timers,
      idleBodyTimeoutMs: 1.5
    })).toThrow(TypeError);
    expect(timers.pendingCount).toBe(0);
  });
});

class ManualTimerHost implements LoadWatchdogTimerHost {
  readonly #tasks = new Map<number, Readonly<{
    deadline: number;
    callback: () => void;
  }>>();
  #nextId = 1;
  #now = 0;

  public get pendingCount(): number {
    return this.#tasks.size;
  }

  public now(): number {
    return this.#now;
  }

  public setTimeout(callback: () => void, milliseconds: number): number {
    const id = this.#nextId;
    this.#nextId += 1;
    this.#tasks.set(id, Object.freeze({
      deadline: this.#now + milliseconds,
      callback
    }));
    return id;
  }

  public clearTimeout(handle: unknown): void {
    if (typeof handle === "number") this.#tasks.delete(handle);
  }

  public advance(milliseconds: number): void {
    this.#now += milliseconds;
    while (true) {
      const due = [...this.#tasks]
        .filter(([, task]) => task.deadline <= this.#now)
        .sort((left, right) =>
          left[1].deadline - right[1].deadline || left[0] - right[0]
        )[0];
      if (due === undefined) return;
      this.#tasks.delete(due[0]);
      due[1].callback();
    }
  }
}

function deferred<Value>(): {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
} {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return Object.freeze({ promise, resolve });
}
