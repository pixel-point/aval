import { describe, expect, it } from "vitest";

import { LifecycleLane } from "../src/lifecycle-lane.js";

describe("element lifecycle lane", () => {
  it("runs only the newest queued generation without overlapping the active attempt", async () => {
    const lane = new LifecycleLane();
    const held = deferred<void>();
    const order: string[] = [];
    let active = 0;
    let maximumActive = 0;
    let aborts = 0;

    const first = lane.generation(
      () => { aborts += 1; },
      async () => {
        order.push("first:start");
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await held.promise;
        active -= 1;
        order.push("first:end");
        return "first";
      }
    );
    await Promise.resolve();

    const skipped = lane.generation(
      () => { aborts += 1; },
      async () => {
        order.push("skipped:start");
        return "skipped";
      }
    );
    const newest = lane.generation(
      () => { aborts += 1; },
      async () => {
        order.push("newest:start");
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        active -= 1;
        order.push("newest:end");
        return "newest";
      }
    );
    expect(lane.pending).toBe(3);

    held.resolve();
    await expect(first).resolves.toBe("first");
    await expect(skipped).rejects.toMatchObject({ name: "AbortError" });
    await expect(newest).resolves.toBe("newest");
    expect(order).toEqual([
      "first:start",
      "first:end",
      "newest:start",
      "newest:end"
    ]);
    expect(maximumActive).toBe(1);
    expect(aborts).toBe(3);
    expect(lane.pending).toBe(0);
  });

  it("orders disconnect retirement before a reconnect generation", async () => {
    const lane = new LifecycleLane();
    const held = deferred<void>();
    const order: string[] = [];

    const initial = lane.generation(
      () => undefined,
      async () => {
        order.push("initial:start");
        await held.promise;
        order.push("initial:end");
      }
    );
    await Promise.resolve();

    const retirement = lane.retirement(
      () => order.push("initial:abort"),
      async () => { order.push("retire"); }
    );
    const reconnect = lane.generation(
      () => undefined,
      async () => { order.push("reconnect"); }
    );
    held.resolve();

    await initial;
    await retirement;
    await reconnect;
    expect(order).toEqual([
      "initial:start",
      "initial:abort",
      "initial:end",
      "retire",
      "reconnect"
    ]);
  });

  it("runs terminal retirement after superseding a queued replacement", async () => {
    const lane = new LifecycleLane();
    const held = deferred<void>();
    const order: string[] = [];

    const active = lane.generation(
      () => undefined,
      async () => { await held.promise; }
    );
    await Promise.resolve();
    const replacement = lane.generation(
      () => undefined,
      async () => { order.push("replacement"); }
    );
    const terminal = lane.retirement(
      () => undefined,
      async () => { order.push("terminal"); }
    );
    held.resolve();

    await active;
    await expect(replacement).rejects.toMatchObject({ name: "AbortError" });
    await terminal;
    expect(order).toEqual(["terminal"]);
  });
});

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}
