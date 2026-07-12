import { describe, expect, it, vi } from "vitest";

import {
  RealtimeDriver,
  type RealtimeContentTickContext,
  type RealtimeContentTickResult
} from "./realtime-driver.js";

describe("RealtimeDriver", () => {
  it.each([
    { numerator: 24, refreshHz: 60 },
    { numerator: 24, refreshHz: 120 },
    { numerator: 30, refreshHz: 60 },
    { numerator: 30, refreshHz: 120 },
    { numerator: 60, refreshHz: 60 },
    { numerator: 60, refreshHz: 120 }
  ])("advances $numerator fps content on a $refreshHz Hz display", ({
    numerator,
    refreshHz
  }) => {
    const source = new FakeAnimationFrameSource();
    const ticks: bigint[] = [];
    const driver = createDriver(source, {
      numerator,
      onTick(context) {
        ticks.push(context.presentationOrdinal);
        return { status: "advanced" };
      }
    });
    driver.start();

    const refreshMs = 1_000 / refreshHz;
    for (let callback = 1; callback <= refreshHz; callback += 1) {
      source.run(callback * refreshMs);
    }

    expect(ticks).toHaveLength(numerator);
    expect(ticks[0]).toBe(1n);
    expect(ticks.at(-1)).toBe(BigInt(numerator));
    expect(new Set(ticks).size).toBe(ticks.length);
  });

  it("ignores refresh callbacks before the rational content deadline", () => {
    const source = new FakeAnimationFrameSource();
    const onTick = vi.fn(() => ({ status: "advanced" } as const));
    const driver = createDriver(source, { numerator: 30, onTick });
    driver.start();

    source.run(1);
    source.run(16);
    source.run(33);
    expect(onTick).not.toHaveBeenCalled();
    source.run(33.334);
    expect(onTick).toHaveBeenCalledTimes(1);
    source.run(50);
    expect(onTick).toHaveBeenCalledTimes(1);
    source.run(66.667);
    expect(onTick).toHaveBeenCalledTimes(2);
  });

  it("drops late wall-clock debt instead of burst-catching up", () => {
    const source = new FakeAnimationFrameSource();
    const ordinals: bigint[] = [];
    const driver = createDriver(source, {
      numerator: 60,
      onTick(context) {
        ordinals.push(context.presentationOrdinal);
        return { status: "advanced" };
      }
    });
    driver.start();

    source.run(100);
    expect(ordinals).toEqual([1n]);
    source.run(101);
    expect(ordinals).toEqual([1n]);
    source.run(116.667);
    expect(ordinals).toEqual([1n, 2n]);
    expect(driver.snapshot().advancedTicks).toBe(2);
  });

  it("rebases after a missed display cadence before resuming animation", () => {
    const source = new FakeAnimationFrameSource();
    const opportunities: number[] = [];
    const driver = createDriver(source, {
      numerator: 30,
      onTick(context) {
        opportunities.push(context.opportunityTimeMs);
        return { status: "advanced" };
      }
    });
    driver.start();

    source.run(16);
    source.run(80);
    source.run(81);
    expect(opportunities).toEqual([80]);
    source.run(113.334);
    expect(opportunities).toEqual([80, 113.334]);
  });

  it("freezes the content clock on underflow, emits once, and recovers", () => {
    const source = new FakeAnimationFrameSource();
    const trace: string[] = [];
    let available = false;
    const driver = createDriver(source, {
      numerator: 30,
      onTick(context) {
        trace.push(`try:${String(context.presentationOrdinal)}`);
        return available
          ? { status: "advanced" }
          : { status: "underflow" };
      },
      onUnderflow(event) {
        trace.push(`underflow:${String(event.presentationOrdinal)}`);
      }
    });
    driver.start();

    source.run(40);
    source.run(50);
    expect(trace).toEqual([
      "try:1",
      "underflow:1",
      "try:1"
    ]);
    expect(driver.snapshot()).toMatchObject({
      nextPresentationOrdinal: 1n,
      underflows: 1,
      smoothSession: false
    });

    available = true;
    source.run(60);
    expect(trace.at(-1)).toBe("try:1");
    expect(driver.snapshot().nextPresentationOrdinal).toBe(2n);
    // The underflow shifted the next deadline; it is not immediately caught up.
    source.run(80);
    expect(trace.filter((entry) => entry === "try:2")).toHaveLength(0);
    source.run(93.334);
    expect(trace.filter((entry) => entry === "try:2")).toHaveLength(1);
  });

  it("uses tickOnce as a manual adapter over the exact same tick path", () => {
    const source = new FakeAnimationFrameSource();
    const contexts: RealtimeContentTickContext[] = [];
    const driver = createDriver(source, {
      numerator: 24,
      onTick(context) {
        contexts.push(context);
        return { status: "advanced" };
      }
    });

    expect(driver.tickOnce()).toEqual({
      status: "advanced",
      presentationOrdinal: 1n
    });
    expect(driver.tickOnce()).toEqual({
      status: "advanced",
      presentationOrdinal: 2n
    });
    expect(contexts.map(({ manual }) => manual)).toEqual([true, true]);
    expect(contexts.map(({ callbackStartMs, eligibleAnimationFrameOrdinal }) => ({
      callbackStartMs,
      eligibleAnimationFrameOrdinal
    }))).toEqual([
      { callbackStartMs: 0, eligibleAnimationFrameOrdinal: null },
      { callbackStartMs: 0, eligibleAnimationFrameOrdinal: null }
    ]);
    expect(source.requestCount).toBe(0);
    expect(driver.snapshot().running).toBe(false);
  });

  it("freezes realtime and manual clocks when the media path terminalizes", () => {
    const source = new FakeAnimationFrameSource();
    const onTick = vi.fn(() => ({ status: "stopped" } as const));
    const realtime = createDriver(source, { numerator: 30, onTick });
    realtime.start();

    source.run(40);
    expect(realtime.snapshot()).toMatchObject({
      running: false,
      nextPresentationOrdinal: 1n,
      advancedTicks: 0,
      underflows: 0,
      smoothSession: false
    });
    expect(source.hasPending).toBe(false);

    const manualSource = new FakeAnimationFrameSource();
    const manual = createDriver(manualSource, { numerator: 30, onTick });
    expect(manual.tickOnce()).toEqual({
      status: "stopped",
      presentationOrdinal: 1n
    });
    expect(manual.snapshot().nextPresentationOrdinal).toBe(1n);
  });

  it("keeps ordinals unique across manual and realtime driving", () => {
    const source = new FakeAnimationFrameSource();
    const ordinals: bigint[] = [];
    const driver = createDriver(source, {
      numerator: 30,
      onTick(context) {
        ordinals.push(context.presentationOrdinal);
        return { status: "advanced" };
      }
    });
    driver.tickOnce();
    driver.start();
    source.run(66.667);

    expect(ordinals).toEqual([1n, 2n]);
    expect(new Set(ordinals).size).toBe(ordinals.length);
  });

  it("cancels the callback and rejects work after idempotent disposal", () => {
    const source = new FakeAnimationFrameSource();
    const onTick = vi.fn(() => ({ status: "advanced" } as const));
    const driver = createDriver(source, { numerator: 30, onTick });
    driver.start();
    const pending = source.pendingId;

    driver.dispose();
    driver.dispose();
    expect(source.cancelled).toEqual([pending]);
    expect(driver.snapshot()).toMatchObject({
      running: false,
      disposed: true
    });
    expect(() => driver.start()).toThrow("disposed");
    expect(() => driver.tickOnce()).toThrow("disposed");
    expect(onTick).not.toHaveBeenCalled();
  });

  it("pauses for reduced-policy preparation and resumes without catch-up", () => {
    const source = new FakeAnimationFrameSource();
    const ordinals: bigint[] = [];
    const driver = createDriver(source, {
      numerator: 30,
      onTick(context) {
        ordinals.push(context.presentationOrdinal);
        return { status: "advanced" };
      }
    });
    driver.start();
    const firstPending = source.pendingId;

    driver.pauseForPolicy();
    driver.pauseForPolicy();
    expect(source.cancelled).toEqual([firstPending]);
    expect(driver.snapshot()).toMatchObject({
      running: false,
      nextPresentationOrdinal: 1n,
      advancedTicks: 0,
      underflows: 0,
      smoothSession: true
    });

    driver.start();
    source.run(500);
    expect(ordinals).toEqual([1n]);
    expect(driver.snapshot()).toMatchObject({
      running: true,
      nextPresentationOrdinal: 2n,
      advancedTicks: 1,
      smoothSession: true
    });
    source.run(501);
    expect(ordinals).toEqual([1n]);
    source.run(533.334);
    expect(ordinals).toEqual([1n, 2n]);
  });

  it("rebases a visibility pause without advancing or wall-time catch-up", () => {
    const source = new FakeAnimationFrameSource();
    const ordinals: bigint[] = [];
    let now = 0;
    const driver = new RealtimeDriver({
      frameRate: { numerator: 30, denominator: 1 },
      requestFrame: source.request,
      cancelFrame: source.cancel,
      now: () => now,
      tryContentTick: (context) => {
        ordinals.push(context.presentationOrdinal);
        return { status: "advanced" };
      }
    });
    driver.start();
    source.run(40);
    expect(driver.snapshot().nextPresentationOrdinal).toBe(2n);

    const wasRunning = driver.snapshot().running;
    driver.pauseForVisibility();
    now = 10_000;
    driver.resumeAfterVisibility(wasRunning);

    expect(driver.snapshot()).toMatchObject({
      running: true,
      nextPresentationOrdinal: 2n,
      nextDeadlineMs: 10_033.333
    });
    source.run(10_001);
    expect(ordinals).toEqual([1n]);
    source.run(10_034);
    expect(ordinals).toEqual([1n, 2n]);
  });

  it("rejects regressing callback clocks and malformed tick results", () => {
    const source = new FakeAnimationFrameSource();
    const driver = createDriver(source, {
      numerator: 30,
      onTick: () => ({ status: "advanced" })
    });
    driver.start();
    source.run(40);
    expect(() => source.run(39)).toThrow("monotonic");

    const badSource = new FakeAnimationFrameSource();
    const bad = createDriver(badSource, {
      numerator: 30,
      onTick: () => ({ status: "bad" } as unknown as RealtimeContentTickResult)
    });
    bad.start();
    expect(() => badSource.run(40)).toThrow("tick result");
  });

  it("rolls back running state when the frame host rejects scheduling", () => {
    const driver = new RealtimeDriver({
      frameRate: { numerator: 30, denominator: 1 },
      requestFrame: () => {
        throw new Error("injected frame host failure");
      },
      cancelFrame: () => undefined,
      now: () => 0,
      tryContentTick: () => ({ status: "advanced" })
    });

    expect(() => driver.start()).toThrow("frame host failure");
    expect(driver.snapshot()).toMatchObject({
      running: false,
      disposed: false
    });
  });

  it("rejects a synchronous frame callback and cancels its returned handle", () => {
    const cancelled: number[] = [];
    let callbackFailure: unknown;
    const driver = new RealtimeDriver({
      frameRate: { numerator: 30, denominator: 1 },
      requestFrame: (callback) => {
        try {
          callback(40);
        } catch (error) {
          callbackFailure = error;
        }
        return 17;
      },
      cancelFrame: (handle) => cancelled.push(handle),
      now: () => 0,
      tryContentTick: () => ({ status: "advanced" })
    });

    expect(() => driver.start()).toThrow("ran synchronously");
    expect(callbackFailure).toBeInstanceOf(RangeError);
    expect((callbackFailure as Error).message).toContain("ran synchronously");
    expect(cancelled).toEqual([17]);
    expect(driver.snapshot()).toMatchObject({
      running: false,
      disposed: false,
      displayCallbacks: 0,
      advancedTicks: 0,
      smoothSession: false
    });
  });

  it("cancels a returned frame handle when its request disposes the driver", () => {
    const cancelled: number[] = [];
    let driver!: RealtimeDriver;
    driver = new RealtimeDriver({
      frameRate: { numerator: 30, denominator: 1 },
      requestFrame: () => {
        driver.dispose();
        return 23;
      },
      cancelFrame: (handle) => cancelled.push(handle),
      now: () => 0,
      tryContentTick: () => ({ status: "advanced" })
    });

    expect(() => driver.start()).toThrow("disposed");
    expect(cancelled).toEqual([23]);
    expect(driver.snapshot()).toMatchObject({
      running: false,
      disposed: true,
      displayCallbacks: 0
    });
  });

  it("cancels a returned frame handle when its request pauses ownership", () => {
    const cancelled: number[] = [];
    let driver!: RealtimeDriver;
    driver = new RealtimeDriver({
      frameRate: { numerator: 30, denominator: 1 },
      requestFrame: () => {
        driver.pauseForPolicy();
        return 29;
      },
      cancelFrame: (handle) => cancelled.push(handle),
      now: () => 0,
      tryContentTick: () => ({ status: "advanced" })
    });

    expect(() => driver.start()).toThrow("ownership changed");
    expect(cancelled).toEqual([29]);
    expect(driver.snapshot()).toMatchObject({
      running: false,
      disposed: false,
      displayCallbacks: 0
    });
  });

  it.each(["pause", "stop"] as const)(
    "does not let cancelFrame restart realtime during %s",
    (operation) => {
      let requests = 0;
      let reentryFailure: unknown;
      let driver!: RealtimeDriver;
      driver = new RealtimeDriver({
        frameRate: { numerator: 30, denominator: 1 },
        requestFrame: () => {
          requests += 1;
          return requests;
        },
        cancelFrame: () => {
          try {
            driver.start();
          } catch (error) {
            reentryFailure = error;
          }
        },
        now: () => 0,
        tryContentTick: () => ({ status: "advanced" })
      });
      driver.start();

      if (operation === "pause") driver.pauseForPolicy();
      else driver.stopAfterFailure();

      expect(reentryFailure).toBeInstanceOf(RangeError);
      expect((reentryFailure as Error).message).toContain(
        "frame cancellation is in progress"
      );
      expect(requests).toBe(1);
      expect(driver.snapshot()).toMatchObject({
        running: false,
        disposed: false,
        smoothSession: operation === "pause"
      });
    }
  );

  it("preserves a stable request failure when rollback cancellation throws", () => {
    let cancellationAttempts = 0;
    const driver = new RealtimeDriver({
      frameRate: { numerator: 30, denominator: 1 },
      requestFrame: (callback) => {
        try {
          callback(40);
        } catch {
          // Return the hostile host's handle so the driver must retire it.
        }
        return 31;
      },
      cancelFrame: () => {
        cancellationAttempts += 1;
        throw new Error("private cancelFrame failure");
      },
      now: () => 0,
      tryContentTick: () => ({ status: "advanced" })
    });

    expect(() => driver.start()).toThrow("ran synchronously");
    expect(cancellationAttempts).toBe(1);
    expect(driver.snapshot()).toMatchObject({
      running: false,
      disposed: false,
      displayCallbacks: 0,
      smoothSession: false
    });
  });

  it("does not resurrect when now disposes during clock initialization", () => {
    let requests = 0;
    let driver!: RealtimeDriver;
    driver = new RealtimeDriver({
      frameRate: { numerator: 30, denominator: 1 },
      requestFrame: () => {
        requests += 1;
        return requests;
      },
      cancelFrame: () => undefined,
      now: () => {
        driver.dispose();
        return 0;
      },
      tryContentTick: () => ({ status: "advanced" })
    });

    expect(() => driver.start()).toThrow("disposed");
    expect(requests).toBe(0);
    expect(driver.snapshot()).toMatchObject({
      running: false,
      disposed: true,
      nextDeadlineMs: null,
      displayCallbacks: 0
    });
  });

  it.each(["pause", "stop"] as const)(
    "does not start when now requests a lifecycle %s",
    (operation) => {
      let requests = 0;
      let driver!: RealtimeDriver;
      driver = new RealtimeDriver({
        frameRate: { numerator: 30, denominator: 1 },
        requestFrame: () => {
          requests += 1;
          return requests;
        },
        cancelFrame: () => undefined,
        now: () => {
          if (operation === "pause") driver.pauseForPolicy();
          else driver.stopAfterFailure();
          return 0;
        },
        tryContentTick: () => ({ status: "advanced" })
      });

      expect(() => driver.start()).toThrow(
        "lifecycle changed during clock initialization"
      );
      expect(requests).toBe(0);
      expect(driver.snapshot()).toMatchObject({
        running: false,
        disposed: false,
        nextDeadlineMs: null,
        smoothSession: operation === "pause"
      });
    }
  );

  it.each(["start", "tickOnce"] as const)(
    "rejects recursive %s even when now catches the inner failure",
    (operation) => {
      let innerFailure: unknown;
      let driver!: RealtimeDriver;
      driver = new RealtimeDriver({
        frameRate: { numerator: 30, denominator: 1 },
        requestFrame: () => 1,
        cancelFrame: () => undefined,
        now: () => {
          try {
            driver[operation]();
          } catch (error) {
            innerFailure = error;
          }
          return 0;
        },
        tryContentTick: () => ({ status: "advanced" })
      });

      expect(() => driver[operation]()).toThrow(
        "clock initialization reentered synchronously"
      );
      expect(innerFailure).toBeInstanceOf(RangeError);
      expect((innerFailure as Error).message).toContain(
        "clock initialization reentered synchronously"
      );
      expect(driver.snapshot()).toMatchObject({
        running: false,
        disposed: false,
        nextDeadlineMs: null,
        displayCallbacks: 0,
        advancedTicks: 0
      });
    }
  );

  it.each(["start", "tickOnce"] as const)(
    "rejects recursive %s from a content tick without duplicating its ordinal",
    (operation) => {
      const source = new FakeAnimationFrameSource();
      let innerFailure: unknown;
      let driver!: RealtimeDriver;
      driver = new RealtimeDriver({
        frameRate: { numerator: 30, denominator: 1 },
        requestFrame: source.request,
        cancelFrame: source.cancel,
        now: () => 0,
        tryContentTick: () => {
          try {
            driver[operation]();
          } catch (error) {
            innerFailure = error;
          }
          return { status: "advanced" };
        }
      });

      expect(() => driver.tickOnce()).toThrow(
        "content tick reentered synchronously"
      );
      expect(innerFailure).toBeInstanceOf(RangeError);
      expect((innerFailure as Error).message).toContain(
        "content tick reentered synchronously"
      );
      expect(source.requestCount).toBe(0);
      expect(driver.snapshot()).toMatchObject({
        running: false,
        disposed: false,
        nextPresentationOrdinal: 1n,
        advancedTicks: 0,
        underflows: 0
      });
    }
  );

  it.each([
    {
      operation: "dispose" as const,
      expectedFailure: "disposed",
      disposed: true,
      smoothSession: true
    },
    {
      operation: "pause" as const,
      expectedFailure: "lifecycle changed during a content tick",
      disposed: false,
      smoothSession: true
    },
    {
      operation: "stop" as const,
      expectedFailure: "lifecycle changed during a content tick",
      disposed: false,
      smoothSession: false
    }
  ])(
    "does not commit an advanced tick after callback lifecycle $operation",
    ({ operation, expectedFailure, disposed, smoothSession }) => {
      const source = new FakeAnimationFrameSource();
      let driver!: RealtimeDriver;
      driver = new RealtimeDriver({
        frameRate: { numerator: 30, denominator: 1 },
        requestFrame: source.request,
        cancelFrame: source.cancel,
        now: () => 0,
        tryContentTick: () => {
          if (operation === "dispose") driver.dispose();
          else if (operation === "pause") driver.pauseForPolicy();
          else driver.stopAfterFailure();
          return { status: "advanced" };
        }
      });

      expect(() => driver.tickOnce()).toThrow(expectedFailure);
      expect(source.requestCount).toBe(0);
      expect(driver.snapshot()).toMatchObject({
        running: false,
        disposed,
        nextPresentationOrdinal: 1n,
        advancedTicks: 0,
        underflows: 0,
        smoothSession
      });
    }
  );

  it("accepts the intentional failure stop paired with a stopped tick", () => {
    const source = new FakeAnimationFrameSource();
    let driver!: RealtimeDriver;
    driver = new RealtimeDriver({
      frameRate: { numerator: 30, denominator: 1 },
      requestFrame: source.request,
      cancelFrame: source.cancel,
      now: () => 0,
      tryContentTick: () => {
        driver.stopAfterFailure();
        return { status: "stopped" };
      }
    });

    expect(driver.tickOnce()).toEqual({
      status: "stopped",
      presentationOrdinal: 1n
    });
    expect(driver.snapshot()).toMatchObject({
      running: false,
      disposed: false,
      nextPresentationOrdinal: 1n,
      advancedTicks: 0,
      smoothSession: false
    });
  });

  it("does not let an underflow observer take ownership of the frame loop", () => {
    const source = new FakeAnimationFrameSource();
    let observerFailure: unknown;
    let driver!: RealtimeDriver;
    driver = new RealtimeDriver({
      frameRate: { numerator: 30, denominator: 1 },
      requestFrame: source.request,
      cancelFrame: source.cancel,
      now: () => 0,
      tryContentTick: () => ({ status: "underflow" }),
      onUnderflow: () => {
        try {
          driver.start();
        } catch (error) {
          observerFailure = error;
        }
      }
    });

    expect(() => driver.tickOnce()).toThrow(
      "content tick reentered synchronously"
    );
    expect(observerFailure).toBeInstanceOf(RangeError);
    expect(source.requestCount).toBe(0);
    expect(driver.snapshot()).toMatchObject({
      running: false,
      nextPresentationOrdinal: 1n,
      advancedTicks: 0,
      underflows: 0,
      smoothSession: false
    });
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])(
    "fails closed for malformed callback timestamp %s",
    (timestamp) => {
      const source = new FakeAnimationFrameSource();
      const driver = createDriver(source, {
        numerator: 30,
        onTick: () => ({ status: "advanced" })
      });
      driver.start();

      expect(() => source.run(timestamp)).toThrow(
        "animation-frame timestamp must be finite and non-negative"
      );
      expect(source.hasPending).toBe(false);
      expect(driver.snapshot()).toMatchObject({
        running: false,
        disposed: false,
        displayCallbacks: 0,
        advancedTicks: 0,
        smoothSession: false
      });
    }
  );
});

function createDriver(
  source: FakeAnimationFrameSource,
  options: {
    readonly numerator: number;
    readonly onTick: (
      context: Readonly<RealtimeContentTickContext>
    ) => RealtimeContentTickResult;
    readonly onUnderflow?: ConstructorParameters<typeof RealtimeDriver>[0]["onUnderflow"];
  }
): RealtimeDriver {
  return new RealtimeDriver({
    frameRate: { numerator: options.numerator, denominator: 1 },
    requestFrame: source.request,
    cancelFrame: source.cancel,
    now: () => 0,
    tryContentTick: options.onTick,
    ...(options.onUnderflow === undefined
      ? {}
      : { onUnderflow: options.onUnderflow })
  });
}

class FakeAnimationFrameSource {
  #nextId = 1;
  #pending: { id: number; callback: FrameRequestCallback } | null = null;
  public readonly cancelled: number[] = [];
  public requestCount = 0;

  public readonly request = (callback: FrameRequestCallback): number => {
    if (this.#pending !== null) {
      throw new Error("only one animation callback may be pending");
    }
    const id = this.#nextId;
    this.#nextId += 1;
    this.requestCount += 1;
    this.#pending = { id, callback };
    return id;
  };

  public readonly cancel = (id: number): void => {
    this.cancelled.push(id);
    if (this.#pending?.id === id) this.#pending = null;
  };

  public get pendingId(): number {
    if (this.#pending === null) throw new Error("no callback is pending");
    return this.#pending.id;
  }

  public get hasPending(): boolean {
    return this.#pending !== null;
  }

  public run(timestamp: number): void {
    const pending = this.#pending;
    if (pending === null) throw new Error("no callback is pending");
    this.#pending = null;
    pending.callback(timestamp);
  }
}
