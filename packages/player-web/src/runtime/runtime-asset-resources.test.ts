import { describe, expect, it } from "vitest";

import { PageResourceManager } from "./page-resource-manager.js";
import { PlayerResourceAccount } from "./player-resource-account.js";
import type { LoadWatchdogTimerHost } from "./load-watchdogs.js";
import {
  createPlayerRuntimeAssetSessionResources,
  createRuntimeAssetOperationDeadline,
  reserveRuntimeAssetBytesWithinDeadline
} from "./runtime-asset-resources.js";

describe("runtime asset resource composition", () => {
  it("keeps partial bodies transient and promotes only complete sources", async () => {
    const manager = new PageResourceManager();
    const account = new PlayerResourceAccount(manager);
    const resources = createPlayerRuntimeAssetSessionResources(account);

    const metadata = await resources.metadata.reserve(3);
    const response = await resources.response.reserve(7);
    const complete = await resources.full.reserve(11);
    expect(nonzeroCategories(manager)).toEqual({
      "asset-metadata": 3,
      "response-body": 7,
      quarantine: 11
    });

    complete.promoteToAssetFull?.();
    expect(nonzeroCategories(manager)).toEqual({
      "asset-metadata": 3,
      "asset-full": 11,
      "response-body": 7
    });

    metadata.release();
    response.release();
    complete.release();
    account.dispose();
    expect(manager.snapshot().physicalBytes).toBe(0);
    manager.dispose();
  });

  it("rejects unauthentic accounts", () => {
    expect(() => createPlayerRuntimeAssetSessionResources(
      {} as PlayerResourceAccount
    )).toThrow(TypeError);
  });

  it("releases a metadata reservation that resolves after its deadline", async () => {
    const timers = new ManualTimerHost();
    const reservation = deferred<{ release(): void }>();
    let releases = 0;
    const deadline = createRuntimeAssetOperationDeadline(10, timers, []);
    const pending = reserveRuntimeAssetBytesWithinDeadline({
      reserve: () => reservation.promise
    }, 7, deadline);

    timers.advance(10);
    await expect(pending).rejects.toMatchObject({
      code: "watchdog-timeout",
      failure: { context: { policyPhase: "overall" } }
    });
    reservation.resolve({ release: () => { releases += 1; } });
    await flushMicrotasks();

    expect(releases).toBe(1);
    expect(deadline.snapshot()).toMatchObject({
      active: false,
      pendingTimerCount: 0,
      linkedAbortListenerCount: 0,
      pendingWaitCount: 0
    });
    expect(timers.pendingCount).toBe(0);
  });
});

function nonzeroCategories(
  manager: PageResourceManager
): Readonly<Record<string, number>> {
  return Object.fromEntries(manager.snapshot().categories.flatMap((entry) =>
    entry.bytes === 0 ? [] : [[entry.category, entry.bytes]]
  ));
}

class ManualTimerHost implements LoadWatchdogTimerHost {
  readonly #tasks = new Map<number, Readonly<{
    deadline: number;
    callback: () => void;
  }>>();
  #nextId = 1;
  #now = 0;
  public get pendingCount(): number { return this.#tasks.size; }
  public now(): number { return this.#now; }
  public setTimeout(callback: () => void, milliseconds: number): number {
    const id = this.#nextId;
    this.#nextId += 1;
    this.#tasks.set(id, { deadline: this.#now + milliseconds, callback });
    return id;
  }
  public clearTimeout(handle: unknown): void {
    if (typeof handle === "number") this.#tasks.delete(handle);
  }
  public advance(milliseconds: number): void {
    this.#now += milliseconds;
    for (const [id, task] of [...this.#tasks]) {
      if (task.deadline > this.#now) continue;
      this.#tasks.delete(id);
      task.callback();
    }
  }
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((accept) => { resolve = accept; });
  return { promise, resolve };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}
