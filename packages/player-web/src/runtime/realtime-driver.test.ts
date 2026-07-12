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
