import { describe, expect, it } from "vitest";

import {
  StaticOperationQueue,
  StaticOperationQueueDisposedError
} from "./static-operation-queue.js";

describe("StaticOperationQueue", () => {
  it("runs operations in generation order without overlap", async () => {
    const queue = new StaticOperationQueue();
    const firstGate = deferred<void>();
    const trace: string[] = [];
    const first = queue.enqueue(async ({ generation }) => {
      trace.push(`start:${generation}`);
      await firstGate.promise;
      trace.push(`end:${generation}`);
      return "first";
    });
    const second = queue.enqueue(({ generation }) => {
      trace.push(`run:${generation}`);
      return "second";
    });
    await Promise.resolve();

    expect(trace).toEqual(["start:1"]);
    expect(queue.snapshot()).toMatchObject({
      generation: 2,
      pending: 2,
      active: true
    });
    firstGate.resolve();
    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second");
    expect(trace).toEqual(["start:1", "end:1", "run:2"]);
    expect(queue.snapshot()).toMatchObject({ pending: 0, active: false });
  });

  it("continues after rejection without leaking the failed tail", async () => {
    const queue = new StaticOperationQueue();
    const failed = queue.enqueue(() => {
      throw new Error("injected presentation failure");
    });
    const next = queue.enqueue(({ generation }) => generation);

    await expect(failed).rejects.toThrow("injected presentation failure");
    await expect(next).resolves.toBe(2);
    await queue.settled();
    expect(queue.snapshot().pending).toBe(0);
  });

  it("aborts active work and prevents queued callbacks after disposal", async () => {
    const queue = new StaticOperationQueue();
    const trace: string[] = [];
    const active = queue.enqueue(async ({ signal }) => {
      trace.push("active");
      await untilAbort(signal);
    });
    const queued = queue.enqueue(() => {
      trace.push("queued");
    });
    await Promise.resolve();

    queue.dispose();
    queue.dispose();
    await expect(active).rejects.toMatchObject({ name: "AbortError" });
    await expect(queued).rejects.toBeInstanceOf(
      StaticOperationQueueDisposedError
    );
    await queue.settled();
    expect(trace).toEqual(["active"]);
    expect(queue.snapshot()).toEqual({
      generation: 2,
      pending: 0,
      active: false,
      disposed: true
    });
    await expect(queue.enqueue(() => undefined)).rejects.toMatchObject({
      name: "AbortError"
    });
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function untilAbort(signal: AbortSignal): Promise<never> {
  if (signal.aborted) throw signal.reason;
  return new Promise<never>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), {
      once: true
    });
  });
}
