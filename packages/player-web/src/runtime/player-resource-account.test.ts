import { describe, expect, it } from "vitest";

import { PageResourceManager } from "./page-resource-manager.js";
import { createRuntimePageResourcePolicy } from "./page-resource-policy.js";
import {
  PlayerResourceAccount,
  adoptPlayerResourceLease,
  reclassifyPlayerResourceLease,
  shrinkPlayerResourceLease
} from "./player-resource-account.js";
import type { RuntimeByteLease } from "./model.js";

describe("player resource account", () => {
  it("wraps one participant and exposes immutable account snapshots", () => {
    const manager = testManager();
    const account = new PlayerResourceAccount(manager, {
      generation: 4,
      visibility: "hidden",
      phase: "loading"
    });
    const snapshot = account.snapshot();

    expect(snapshot).toMatchObject({
      participantId: account.participantId,
      activeLeaseCount: 0,
      disposed: false,
      participant: {
        generation: 4,
        visibility: "hidden",
        phase: "loading"
      }
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.participant)).toBe(true);
  });

  it("rolls back a reservation when allocation fails", () => {
    const manager = testManager();
    const account = new PlayerResourceAccount(manager);

    expect(() => account.reserveForAllocation(
      "png-scratch",
      12,
      () => {
        throw new Error("allocation failed");
      }
    )).toThrow("allocation failed");
    expect(manager.snapshot()).toMatchObject({
      physicalBytes: 0,
      byteLeaseCount: 0
    });
    expect(account.snapshot().activeLeaseCount).toBe(0);
  });

  it("transfers a successful allocation lease and releases exactly once", async () => {
    const manager = testManager();
    const account = new PlayerResourceAccount(manager);
    const allocation = account.reserveForAllocation(
      "current-static-surface",
      10,
      () => Object.freeze({ surface: true })
    );

    expect(Object.isFrozen(allocation)).toBe(true);
    expect(allocation.value).toEqual({ surface: true });
    expect(account.snapshot().activeLeaseCount).toBe(1);
    await allocation.lease.resize(14);
    expect(manager.snapshot().physicalBytes).toBe(14);
    allocation.lease.release();
    allocation.lease.release();
    expect(account.snapshot().activeLeaseCount).toBe(0);
    expect(manager.snapshot().physicalBytes).toBe(0);
  });

  it("publishes status/reclaimable bytes and touches through manager sequence", () => {
    const manager = testManager();
    const account = new PlayerResourceAccount(manager);
    const lease = account.reserve("verified-unit", 9);
    const initialTouch = account.snapshot().participant!.lastTouchSequence;

    const touched = account.touch();
    expect(touched.lastTouchSequence).toBe(initialTouch + 1);
    const updated = account.updateStatus({
      generation: 2,
      phase: "preparing",
      reclaimable: [{ category: "verified-unit", bytes: 4 }]
    });
    expect(updated).toMatchObject({
      generation: 2,
      phase: "preparing",
      reclaimable: [{ category: "verified-unit", bytes: 4 }]
    });
    expect(updated.lastTouchSequence).toBe(initialTouch + 2);
    lease.release();
  });

  it("atomically reclassifies only an authentic lease from the same account", () => {
    const manager = testManager();
    const first = new PlayerResourceAccount(manager);
    const second = new PlayerResourceAccount(manager);
    const lease = first.reserve("incoming-static-surface", 32);
    const hostile = Object.defineProperty({}, "snapshot", {
      get() {
        throw new Error("must not inspect forged facade");
      }
    }) as RuntimeByteLease;

    reclassifyPlayerResourceLease(
      first,
      lease,
      "current-static-surface"
    );
    expect(lease.snapshot()).toMatchObject({
      category: "current-static-surface",
      bytes: 32
    });
    shrinkPlayerResourceLease(first, lease, 12);
    expect(lease.snapshot()).toMatchObject({ bytes: 12 });
    expect(manager.snapshot().physicalBytes).toBe(12);
    expect(() => shrinkPlayerResourceLease(first, lease, 13))
      .toThrow("cannot grow");
    expect(manager.snapshot()).toMatchObject({
      physicalBytes: 12,
      byteLeaseCount: 1
    });
    expect(() => reclassifyPlayerResourceLease(
      second,
      lease,
      "decoded-static-cache"
    )).toThrow(TypeError);
    expect(() => reclassifyPlayerResourceLease(
      first,
      hostile,
      "decoded-static-cache"
    )).toThrow(TypeError);

    lease.release();
    expect(() => reclassifyPlayerResourceLease(
      first,
      lease,
      "decoded-static-cache"
    )).toThrowError(expect.objectContaining({ code: "disposed" }));
    first.dispose();
    second.dispose();
  });

  it("adopts only an authentic async lease from the account's manager", () => {
    const manager = testManager();
    const otherManager = testManager();
    const account = new PlayerResourceAccount(manager);
    const otherAccount = new PlayerResourceAccount(otherManager);
    const raw = manager.reserve(account.participantId, "response-body", 6);
    const otherRaw = otherManager.reserve(
      otherAccount.participantId,
      "response-body",
      6
    );

    const adopted = adoptPlayerResourceLease(account, manager, raw);
    expect(account.snapshot().activeLeaseCount).toBe(1);
    expect(() => adoptPlayerResourceLease(account, manager, otherRaw))
      .toThrow(TypeError);
    expect(otherRaw.snapshot().released).toBe(true);

    adopted.release();
    expect(account.snapshot().activeLeaseCount).toBe(0);
    account.dispose();
    otherAccount.dispose();
  });

  it("disposal auto-releases all account leases and unregisters the participant", () => {
    const manager = testManager();
    const account = new PlayerResourceAccount(manager);
    const first = account.reserve("asset-metadata", 5);
    const second = account.reserve("quarantine", 7);

    account.dispose();
    account.dispose();
    expect(first.snapshot().released).toBe(true);
    expect(second.snapshot().released).toBe(true);
    expect(account.snapshot()).toEqual({
      participantId: account.participantId,
      activeLeaseCount: 0,
      disposed: true,
      participant: null
    });
    expect(manager.snapshot()).toMatchObject({
      physicalBytes: 0,
      byteLeaseCount: 0,
      participants: []
    });
    first.release();
    expect(() => account.reserve("asset-full", 1)).toThrowError(
      expect.objectContaining({ code: "disposed" })
    );
    expect(() => account.touch()).toThrowError(
      expect.objectContaining({ code: "disposed" })
    );
  });

  it("remains safely disposable after manager-first disposal", () => {
    const manager = testManager();
    const account = new PlayerResourceAccount(manager);
    const lease = account.reserve("blob-assembly", 8);

    manager.dispose();
    expect(lease.snapshot().released).toBe(true);
    expect(() => account.dispose()).not.toThrow();
    expect(account.snapshot().disposed).toBe(true);
  });
});

function testManager(): PageResourceManager {
  return new PageResourceManager(createRuntimePageResourcePolicy({
    maximumPagePhysicalBytes: 64,
    maximumPlayerLogicalBytes: 32
  }));
}
