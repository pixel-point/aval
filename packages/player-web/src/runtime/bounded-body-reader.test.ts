import { describe, expect, it } from "vitest";

import { RuntimePlaybackError } from "./errors.js";
import {
  readBoundedBody,
  type BoundedBodyByteLease,
  type BoundedBodyByteResourceHost,
  type RuntimeBodyReader,
  type RuntimeBodyReadResult
} from "./bounded-body-reader.js";
import {
  createLoadWatchdogs,
  type LoadWatchdogTimerHost
} from "./load-watchdogs.js";

describe("bounded response-body reader", () => {
  it("reads a known exact body into one allocation and transfers its lease", async () => {
    const resources = new CountingResources();
    const reader = scriptedReader([
      chunk([1]),
      chunk([]),
      chunk([2, 3]),
      end()
    ]);
    const allocations: number[] = [];

    const body = await readBoundedBody({
      reader,
      mode: { kind: "known-exact", expectedBytes: 3, maximumBytes: 3 },
      resources,
      watchdogs: createLoadWatchdogs({ timers: new PassiveTimerHost() }),
      allocate(byteLength) {
        allocations.push(byteLength);
        return new Uint8Array(new ArrayBuffer(byteLength));
      }
    });

    expect([...body.bytes]).toEqual([1, 2, 3]);
    expect(body.byteLength).toBe(3);
    expect(allocations).toEqual([3]);
    expect(resources.reservations).toEqual([3]);
    expect(resources.snapshot()).toEqual({ liveBytes: 3, peakBytes: 3 });
    expect(reader.readCount).toBe(4);
    expect(reader.cancelCount).toBe(0);
    expect(reader.releaseLockCount).toBe(1);

    body.release();
    body.release();
    expect(resources.snapshot()).toEqual({ liveBytes: 0, peakBytes: 3 });
  });

  it("charges retained chunks plus the final compact copy at the exact cap", async () => {
    const resources = new CountingResources();
    const reader = scriptedReader([chunk([1, 2]), chunk([3, 4, 5]), end()]);
    const allocations: number[] = [];

    const body = await readBoundedBody({
      reader,
      mode: { kind: "bounded-unknown", maximumBytes: 5 },
      resources,
      watchdogs: createLoadWatchdogs({ timers: new PassiveTimerHost() }),
      allocate(byteLength) {
        allocations.push(byteLength);
        return new Uint8Array(new ArrayBuffer(byteLength));
      }
    });

    expect([...body.bytes]).toEqual([1, 2, 3, 4, 5]);
    expect(allocations).toEqual([2, 3, 5]);
    expect(resources.reservations).toEqual([2, 3, 5]);
    expect(resources.snapshot()).toEqual({ liveBytes: 5, peakBytes: 10 });
    body.release();
    expect(resources.snapshot()).toEqual({ liveBytes: 0, peakBytes: 10 });
  });

  it("rejects truncation after natural EOF and releases the exact lease", async () => {
    const resources = new CountingResources();
    const reader = scriptedReader([chunk([1, 2]), end()]);

    const outcome = readBoundedBody({
      reader,
      mode: { kind: "known-exact", expectedBytes: 3, maximumBytes: 3 },
      resources,
      watchdogs: createLoadWatchdogs({ timers: new PassiveTimerHost() }),
      context: { requestOrdinal: 4 }
    });

    await expect(outcome).rejects.toMatchObject({
      code: "load-failure",
      failure: {
        context: {
          requestOrdinal: 4,
          expectedBytes: 3,
          observedBytes: 2
        }
      }
    });
    expect(reader.cancelCount).toBe(0);
    expect(reader.releaseLockCount).toBe(1);
    expect(resources.snapshot().liveBytes).toBe(0);
  });

  it("detects a one-byte known or unknown overflow before copy/reservation", async () => {
    const knownResources = new CountingResources();
    const known = scriptedReader([chunk([1, 2, 3, 4])]);
    await expect(readBoundedBody({
      reader: known,
      mode: { kind: "known-exact", expectedBytes: 3, maximumBytes: 3 },
      resources: knownResources,
      watchdogs: createLoadWatchdogs({ timers: new PassiveTimerHost() })
    })).rejects.toMatchObject({ code: "load-failure" });
    expect(known.cancelCount).toBe(1);
    expect(knownResources.snapshot().liveBytes).toBe(0);

    const unknownResources = new CountingResources();
    const unknown = scriptedReader([chunk([1, 2, 3]), chunk([4])]);
    await expect(readBoundedBody({
      reader: unknown,
      mode: { kind: "bounded-unknown", maximumBytes: 3 },
      resources: unknownResources,
      watchdogs: createLoadWatchdogs({ timers: new PassiveTimerHost() })
    })).rejects.toMatchObject({ code: "load-failure" });
    expect(unknownResources.reservations).toEqual([3]);
    expect(unknownResources.snapshot().liveBytes).toBe(0);
  });

  it("rejects absent, empty, and malformed bodies without retaining resources", async () => {
    const absentResources = new CountingResources();
    await expect(readBoundedBody({
      reader: null,
      mode: { kind: "known-exact", expectedBytes: 1, maximumBytes: 1 },
      resources: absentResources,
      watchdogs: createLoadWatchdogs({ timers: new PassiveTimerHost() })
    })).rejects.toMatchObject({ code: "load-failure" });

    const emptyResources = new CountingResources();
    const empty = scriptedReader([chunk([]), chunk([]), end()]);
    await expect(readBoundedBody({
      reader: empty,
      mode: { kind: "bounded-unknown", maximumBytes: 3 },
      resources: emptyResources,
      watchdogs: createLoadWatchdogs({ timers: new PassiveTimerHost() })
    })).rejects.toMatchObject({ code: "load-failure" });
    expect(emptyResources.reservations).toEqual([]);

    const malformedResources = new CountingResources();
    const malformed = scriptedReader([
      { done: false, value: new DataView(new ArrayBuffer(1)) } as unknown as RuntimeBodyReadResult
    ]);
    await expect(readBoundedBody({
      reader: malformed,
      mode: { kind: "bounded-unknown", maximumBytes: 3 },
      resources: malformedResources,
      watchdogs: createLoadWatchdogs({ timers: new PassiveTimerHost() })
    })).rejects.toBeInstanceOf(RuntimePlaybackError);
    expect(malformed.cancelCount).toBe(1);
  });

  it("rejects oversized declared length before allocation and still cancels the body", async () => {
    const resources = new CountingResources();
    const reader = scriptedReader([chunk([1])]);
    const allocations: number[] = [];

    await expect(readBoundedBody({
      reader,
      mode: { kind: "known-exact", expectedBytes: 4, maximumBytes: 3 },
      resources,
      watchdogs: createLoadWatchdogs({ timers: new PassiveTimerHost() }),
      allocate(byteLength) {
        allocations.push(byteLength);
        return new Uint8Array(new ArrayBuffer(byteLength));
      }
    })).rejects.toMatchObject({ code: "load-failure" });

    expect(reader.readCount).toBe(0);
    expect(reader.cancelCount).toBe(1);
    expect(allocations).toEqual([]);
    expect(resources.reservations).toEqual([]);
  });

  it("normalizes read and cancel rejection once while completing all cleanup", async () => {
    const resources = new CountingResources();
    const reader = scriptedReader([Promise.reject(new Error("reader secret"))], {
      cancel: () => Promise.reject(new Error("cancel secret"))
    });

    await expect(readBoundedBody({
      reader,
      mode: { kind: "known-exact", expectedBytes: 2, maximumBytes: 2 },
      resources,
      watchdogs: createLoadWatchdogs({ timers: new PassiveTimerHost() })
    })).rejects.toMatchObject({ code: "load-failure" });

    expect(reader.cancelCount).toBe(1);
    expect(reader.releaseLockCount).toBe(1);
    expect(resources.snapshot().liveBytes).toBe(0);
  });

  it("aborts a pending read, cancels it, and awaits its late retirement", async () => {
    const resources = new CountingResources();
    const pendingRead = deferred<RuntimeBodyReadResult>();
    const cancel = deferred<void>();
    const reader = scriptedReader([pendingRead.promise], {
      cancel: () => cancel.promise
    });
    const controller = new AbortController();
    const watchdogs = createLoadWatchdogs({
      timers: new PassiveTimerHost(),
      signals: [controller.signal]
    });
    let settled = false;
    const outcome = readBoundedBody({
      reader,
      mode: { kind: "known-exact", expectedBytes: 1, maximumBytes: 1 },
      resources,
      watchdogs
    }).finally(() => {
      settled = true;
    });

    await Promise.resolve();
    controller.abort();
    await Promise.resolve();
    expect(reader.cancelCount).toBe(1);
    expect(settled).toBe(false);

    cancel.resolve();
    pendingRead.resolve(chunk([9]));
    await expect(outcome).rejects.toMatchObject({ code: "abort" });
    expect(resources.snapshot().liveBytes).toBe(0);
    expect(reader.releaseLockCount).toBe(1);
    expect(watchdogs.snapshot()).toMatchObject({
      pendingTimerCount: 0,
      linkedAbortListenerCount: 0,
      pendingWaitCount: 0
    });
  });

  it("does not publish a read that completes after the first-byte watchdog", async () => {
    const resources = new CountingResources();
    const timers = new ManualTimerHost();
    const pendingRead = deferred<RuntimeBodyReadResult>();
    const reader = scriptedReader([pendingRead.promise]);
    let settled = false;
    const outcome = readBoundedBody({
      reader,
      mode: { kind: "known-exact", expectedBytes: 1, maximumBytes: 1 },
      resources,
      watchdogs: createLoadWatchdogs({
        timers,
        overallTimeoutMs: 20,
        firstByteTimeoutMs: 5,
        idleBodyTimeoutMs: 5
      })
    }).finally(() => {
      settled = true;
    });

    await Promise.resolve();
    timers.advance(5);
    await Promise.resolve();
    expect(settled).toBe(false);
    pendingRead.resolve(chunk([7]));

    await expect(outcome).rejects.toMatchObject({ code: "watchdog-timeout" });
    expect(resources.snapshot().liveBytes).toBe(0);
    expect(reader.cancelCount).toBe(1);
  });

  it("releases a reservation that resolves after abort", async () => {
    const reservation = deferred<BoundedBodyByteLease>();
    const resources = new DeferredResources(reservation.promise);
    const reader = scriptedReader([chunk([1]), end()]);
    const controller = new AbortController();
    const watchdogs = createLoadWatchdogs({
      timers: new PassiveTimerHost(),
      signals: [controller.signal]
    });
    const outcome = readBoundedBody({
      reader,
      mode: { kind: "bounded-unknown", maximumBytes: 1 },
      resources,
      watchdogs
    });

    for (let index = 0; index < 8 && resources.reserveCount === 0; index += 1) {
      await Promise.resolve();
    }
    expect(resources.reserveCount).toBe(1);
    controller.abort();
    await expect(outcome).rejects.toMatchObject({ code: "abort" });
    expect(resources.releaseCount).toBe(0);

    reservation.resolve(resources.lease);
    for (let index = 0; index < 8 && resources.releaseCount === 0; index += 1) {
      await Promise.resolve();
    }
    expect(resources.releaseCount).toBe(1);
  });

  it("releases retained and final leases when compaction allocation fails", async () => {
    const resources = new CountingResources();
    const reader = scriptedReader([chunk([1, 2]), end()]);
    let allocation = 0;

    await expect(readBoundedBody({
      reader,
      mode: { kind: "bounded-unknown", maximumBytes: 2 },
      resources,
      watchdogs: createLoadWatchdogs({ timers: new PassiveTimerHost() }),
      allocate(byteLength) {
        allocation += 1;
        if (allocation === 2) throw new Error("allocation failed");
        return new Uint8Array(new ArrayBuffer(byteLength));
      }
    })).rejects.toMatchObject({ code: "load-failure" });

    expect(resources.reservations).toEqual([2, 2]);
    expect(resources.snapshot()).toEqual({ liveBytes: 0, peakBytes: 4 });
  });
});

interface ScriptedReader extends RuntimeBodyReader {
  readonly readCount: number;
  readonly cancelCount: number;
  readonly releaseLockCount: number;
}

function scriptedReader(
  steps: readonly (RuntimeBodyReadResult | Promise<RuntimeBodyReadResult>)[],
  options: Readonly<{ cancel?: () => PromiseLike<void> }> = {}
): ScriptedReader {
  let readCount = 0;
  let cancelCount = 0;
  let releaseLockCount = 0;
  return {
    get readCount() {
      return readCount;
    },
    get cancelCount() {
      return cancelCount;
    },
    get releaseLockCount() {
      return releaseLockCount;
    },
    read(): PromiseLike<RuntimeBodyReadResult> {
      const step = steps[readCount];
      readCount += 1;
      return step === undefined ? Promise.resolve(end()) : Promise.resolve(step);
    },
    cancel(): PromiseLike<void> {
      cancelCount += 1;
      return options.cancel?.() ?? Promise.resolve();
    },
    releaseLock(): void {
      releaseLockCount += 1;
    }
  };
}

function chunk(bytes: readonly number[]): RuntimeBodyReadResult {
  return Object.freeze({ done: false, value: Uint8Array.from(bytes) });
}

function end(): RuntimeBodyReadResult {
  return Object.freeze({ done: true, value: undefined });
}

class CountingResources implements BoundedBodyByteResourceHost {
  public readonly reservations: number[] = [];
  #liveBytes = 0;
  #peakBytes = 0;

  public reserve(byteLength: number): BoundedBodyByteLease {
    this.reservations.push(byteLength);
    this.#liveBytes += byteLength;
    this.#peakBytes = Math.max(this.#peakBytes, this.#liveBytes);
    let released = false;
    return Object.freeze({
      release: () => {
        if (released) return;
        released = true;
        this.#liveBytes -= byteLength;
      }
    });
  }

  public snapshot(): Readonly<{ liveBytes: number; peakBytes: number }> {
    return Object.freeze({
      liveBytes: this.#liveBytes,
      peakBytes: this.#peakBytes
    });
  }
}

class DeferredResources implements BoundedBodyByteResourceHost {
  public reserveCount = 0;
  public releaseCount = 0;
  public readonly lease: BoundedBodyByteLease = Object.freeze({
    release: () => {
      this.releaseCount += 1;
    }
  });

  public constructor(
    readonly reservation: PromiseLike<BoundedBodyByteLease>
  ) {}

  public reserve(): PromiseLike<BoundedBodyByteLease> {
    this.reserveCount += 1;
    return this.reservation;
  }
}

class PassiveTimerHost implements LoadWatchdogTimerHost {
  #nextId = 0;

  public now(): number {
    return 0;
  }

  public setTimeout(): number {
    this.#nextId += 1;
    return this.#nextId;
  }

  public clearTimeout(): void {}
}

class ManualTimerHost implements LoadWatchdogTimerHost {
  readonly #tasks = new Map<number, Readonly<{
    deadline: number;
    callback: () => void;
  }>>();
  #nextId = 1;
  #now = 0;

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
    const due = [...this.#tasks]
      .filter(([, task]) => task.deadline <= this.#now)
      .sort((left, right) =>
        left[1].deadline - right[1].deadline || left[0] - right[0]
      );
    for (const [id, task] of due) {
      if (!this.#tasks.delete(id)) continue;
      task.callback();
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
