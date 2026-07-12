import { describe, expect, it, vi } from "vitest";

import type {
  RuntimeByteCategory,
  RuntimeByteLease,
  RuntimeParticipantId,
  RuntimeParticipantPhase,
  RuntimeParticipantVisibility,
  RuntimeReclamationRequest,
  RuntimeReclamationResult
} from "./model.js";
import {
  PageReclamationCoordinator,
  type RuntimeReclamationParticipant
} from "./page-reclamation.js";
import { PageResourceManager } from "./page-resource-manager.js";
import { createRuntimePageResourcePolicy } from "./page-resource-policy.js";

describe("page reclamation", () => {
  it("uses all five deterministic classes and protects equal visible animation", async () => {
    const { manager, coordinator, participants } = setup(20, 20, 6);
    const log: string[] = [];
    const decoded = ownedReclaimable(
      manager, participants[0]!, "decoded-static-cache", 4, "visible", "animated"
    );
    const abandoned = ownedReclaimable(
      manager, participants[1]!, "quarantine", 4, "visible", "preparing"
    );
    const hidden = ownedReclaimable(
      manager, participants[2]!, "streaming-texture", 4, "hidden", "animated"
    );
    const optional = ownedReclaimable(
      manager, participants[3]!, "png-copy", 4, "visible", "static"
    );
    const protectedAnimation = ownedReclaimable(
      manager, participants[4]!, "streaming-texture", 4, "visible", "animated"
    );
    registerRelease(coordinator, decoded, log);
    registerRelease(coordinator, abandoned, log);
    registerRelease(coordinator, hidden, log);
    registerRelease(coordinator, optional, log);
    const protectedCallback = registerRelease(
      coordinator,
      protectedAnimation,
      log
    );

    const reserved = await coordinator.reserveWithReclamation({
      participantId: participants[5]!,
      generation: 1,
      category: "asset-full",
      bytes: 16
    });

    expect(log).toEqual([
      "decoded-static",
      "abandoned-animation",
      "hidden-animation",
      "optional-cache"
    ]);
    expect(protectedCallback).not.toHaveBeenCalled();
    expect(protectedAnimation.lease.snapshot().released).toBe(false);
    expect(reserved.snapshot().bytes).toBe(16);
    reserved.release();
    protectedAnimation.lease.release();
  });

  it("breaks ties by oldest touch then participant identity", async () => {
    const { manager, coordinator, participants } = setup(8, 8, 3);
    const first = ownedReclaimable(
      manager, participants[0]!, "decoded-static-cache", 4, "visible", "animated"
    );
    const second = ownedReclaimable(
      manager, participants[1]!, "decoded-static-cache", 4, "visible", "animated"
    );
    const order: number[] = [];
    registerRelease(coordinator, first, [], () => order.push(0));
    registerRelease(coordinator, second, [], () => order.push(1));

    const lease = await coordinator.reserveWithReclamation({
      participantId: participants[2]!,
      generation: 1,
      category: "asset-full",
      bytes: 4
    });
    expect(order).toEqual([0]);
    expect(first.lease.snapshot().released).toBe(true);
    expect(second.lease.snapshot().released).toBe(false);
    lease.release();
    second.lease.release();
  });

  it("uses requester self-fallback for player-cap pressure", async () => {
    const { manager, coordinator, participants } = setup(12, 10, 2);
    const ownAnimation = ownedReclaimable(
      manager, participants[0]!, "persistent-animation", 8, "visible", "animated"
    );
    const pinned = manager.reserve(participants[1]!, "verified-static", 4);
    const calls: RuntimeReclamationRequest[] = [];
    coordinator.registerParticipant(participants[0]!, {
      async reclaim(request) {
        calls.push(request);
        ownAnimation.lease.release();
        return resultFor(request, 8, true);
      }
    });

    const lease = await coordinator.reserveWithReclamation({
      participantId: participants[0]!,
      generation: 1,
      category: "decoder-output",
      bytes: 4
    });
    expect(calls.map(({ reason }) => reason)).toEqual(["requester-fallback"]);
    expect(calls[0]!.requestedBytes).toBeGreaterThanOrEqual(2);
    expect(lease.snapshot().bytes).toBe(4);
    lease.release();
    pinned.release();
  });

  it("satisfies player pressure from the requester before reclaiming page pressure", async () => {
    const { manager, coordinator, participants } = setup(12, 8, 2);
    const requesterPinned = manager.reserve(
      participants[0]!,
      "asset-metadata",
      4
    );
    const requesterAnimation = ownedReclaimable(
      manager,
      participants[0]!,
      "persistent-animation",
      3,
      "visible",
      "animated"
    );
    const otherDecoded = ownedReclaimable(
      manager,
      participants[1]!,
      "decoded-static-cache",
      5,
      "visible",
      "animated"
    );
    const order: string[] = [];
    registerRelease(coordinator, requesterAnimation, order);
    registerRelease(coordinator, otherDecoded, order);

    const lease = await coordinator.reserveWithReclamation({
      participantId: participants[0]!,
      generation: 1,
      category: "decoder-output",
      bytes: 4
    });
    expect(order).toEqual(["requester-fallback", "decoded-static"]);
    lease.release();
    requesterPinned.release();
  });

  it("rejects insufficient and equal-visible plans without partial counters", async () => {
    const { manager, coordinator, participants } = setup(8, 8, 3);
    const small = ownedReclaimable(
      manager, participants[0]!, "decoded-static-cache", 2, "visible", "animated"
    );
    const equalVisible = ownedReclaimable(
      manager, participants[1]!, "streaming-texture", 6, "visible", "animated"
    );
    const smallCallback = registerRelease(coordinator, small, []);
    const equalCallback = registerRelease(coordinator, equalVisible, []);
    const before = manager.snapshot();

    await expect(coordinator.reserveWithReclamation({
      participantId: participants[2]!,
      generation: 1,
      category: "asset-full",
      bytes: 4
    })).rejects.toMatchObject({ code: "resource-rejection" });
    expect(smallCallback).not.toHaveBeenCalled();
    expect(equalCallback).not.toHaveBeenCalled();
    expect(manager.snapshot()).toEqual(before);
    small.lease.release();
    equalVisible.lease.release();
  });

  it("rejects a stale requester after an in-flight victim completion", async () => {
    const { manager, coordinator, participants } = setup(4, 4, 2);
    const victim = ownedReclaimable(
      manager, participants[0]!, "decoded-static-cache", 4, "visible", "animated"
    );
    const pending = deferred<RuntimeReclamationResult>();
    let request!: RuntimeReclamationRequest;
    coordinator.registerParticipant(participants[0]!, {
      reclaim(value) {
        request = value;
        return pending.promise;
      }
    });
    const operation = coordinator.reserveWithReclamation({
      participantId: participants[1]!,
      generation: 1,
      category: "asset-full",
      bytes: 4
    });
    await Promise.resolve();
    expect(manager.snapshot().pendingReclamations).toBe(1);

    manager.updateParticipant(participants[1]!, { generation: 2 });
    victim.lease.release();
    pending.resolve(resultFor(request, 4, true));
    await expect(operation).rejects.toMatchObject({ name: "AbortError" });
    expect(manager.participantSnapshot(participants[1]!).logicalBytes).toBe(0);
    expect(manager.snapshot().pendingReclamations).toBe(0);
  });

  it("does not hold a decision lock across a reentrant stale-victim callback", async () => {
    const { manager, coordinator, participants } = setup(4, 4, 3);
    const victim = ownedReclaimable(
      manager, participants[0]!, "decoded-static-cache", 4, "visible", "animated"
    );
    const callbackSnapshots: number[] = [];
    coordinator.registerParticipant(participants[0]!, {
      async reclaim(request) {
        callbackSnapshots.push(coordinator.snapshot().pendingCount);
        const unregister = coordinator.registerParticipant(participants[2]!, {
          reclaim: async (nested) => resultFor(nested, 0, true)
        });
        unregister();
        manager.updateParticipant(participants[0]!, { generation: 2 });
        victim.lease.release();
        return resultFor(request, 4, true);
      }
    });

    const lease = await coordinator.reserveWithReclamation({
      participantId: participants[1]!,
      generation: 1,
      category: "asset-full",
      bytes: 4
    });
    expect(callbackSnapshots).toEqual([1]);
    lease.release();
  });

  it("allows a callback to await a nested reclamation without deadlock", async () => {
    const { manager, coordinator, participants } = setup(8, 8, 4);
    const outerVictim = ownedReclaimable(
      manager, participants[0]!, "decoded-static-cache", 4, "visible", "animated"
    );
    const nestedVictim = ownedReclaimable(
      manager, participants[1]!, "decoded-static-cache", 4, "visible", "animated"
    );
    registerRelease(coordinator, nestedVictim, []);
    let nestedLease: RuntimeByteLease | null = null;
    coordinator.registerParticipant(participants[0]!, {
      async reclaim(request) {
        nestedLease = await coordinator.reserveWithReclamation({
          participantId: participants[3]!,
          generation: 1,
          category: "asset-full",
          bytes: 4
        });
        outerVictim.lease.release();
        return resultFor(request, 4, true);
      }
    });

    const outerLease = await coordinator.reserveWithReclamation({
      participantId: participants[2]!,
      generation: 1,
      category: "asset-full",
      bytes: 4
    });
    expect(nestedLease).not.toBeNull();
    outerLease.release();
    (nestedLease as RuntimeByteLease | null)?.release();
  });

  it("continues deterministic cleanup after one participant callback rejects", async () => {
    const { manager, coordinator, participants } = setup(8, 8, 3);
    const failing = ownedReclaimable(
      manager, participants[0]!, "decoded-static-cache", 4, "visible", "animated"
    );
    const succeeding = ownedReclaimable(
      manager, participants[1]!, "decoded-static-cache", 4, "visible", "animated"
    );
    const order: string[] = [];
    coordinator.registerParticipant(participants[0]!, {
      async reclaim() {
        order.push("failing");
        throw new Error("cleanup rejected");
      }
    });
    registerRelease(coordinator, succeeding, [], () => order.push("succeeding"));

    const lease = await coordinator.reserveWithReclamation({
      participantId: participants[2]!,
      generation: 1,
      category: "asset-full",
      bytes: 4
    });
    expect(order).toEqual(["failing", "succeeding"]);
    expect(failing.lease.snapshot().released).toBe(false);
    lease.release();
    failing.lease.release();
  });

  it("reclaims policy-reduction pressure in deterministic class order", async () => {
    const { manager, coordinator, participants } = setup(12, 12, 3);
    const first = ownedReclaimable(
      manager, participants[0]!, "decoded-static-cache", 4, "visible", "animated"
    );
    const second = ownedReclaimable(
      manager, participants[1]!, "png-copy", 4, "visible", "static"
    );
    const pinned = manager.reserve(participants[2]!, "verified-static", 4);
    const reasons: string[] = [];
    registerRelease(coordinator, first, reasons);
    registerRelease(coordinator, second, reasons);

    await expect(coordinator.reclaimForPolicyReduction(6)).resolves.toBe(8);
    expect(reasons).toEqual(["policy-reduction", "policy-reduction"]);
    expect(manager.snapshot().physicalBytes).toBe(4);
    pinned.release();
  });

  it("cancels in-flight callbacks and reaches terminal zero on disposal", async () => {
    const { manager, coordinator, participants } = setup(4, 4, 2);
    const victim = ownedReclaimable(
      manager, participants[0]!, "decoded-static-cache", 4, "visible", "animated"
    );
    const pending = deferred<RuntimeReclamationResult>();
    let request!: RuntimeReclamationRequest;
    coordinator.registerParticipant(participants[0]!, {
      reclaim(value) {
        request = value;
        return pending.promise;
      }
    });
    const operation = coordinator.reserveWithReclamation({
      participantId: participants[1]!,
      generation: 1,
      category: "asset-full",
      bytes: 4
    });
    operation.catch(() => undefined);
    await Promise.resolve();
    const disposal = coordinator.dispose();
    await disposal;
    await expect(operation).rejects.toMatchObject({ code: "disposed" });
    expect(coordinator.snapshot()).toMatchObject({
      pendingCount: 0,
      registeredParticipantCount: 0,
      disposed: true
    });
    expect(manager.snapshot().pendingReclamations).toBe(0);
    // A detached late callback is observed but cannot resurrect coordinator
    // pending/claim ownership after terminal disposal.
    pending.resolve(resultFor(request, 0, true));
    await Promise.resolve();
    expect(coordinator.snapshot().pendingCount).toBe(0);
    victim.lease.release();
  });

  it("cancels one generation reservation without waiting for its victim", async () => {
    const { manager, coordinator, participants } = setup(4, 4, 2);
    const victim = ownedReclaimable(
      manager, participants[0]!, "decoded-static-cache", 4, "visible", "animated"
    );
    const pending = deferred<RuntimeReclamationResult>();
    let request!: RuntimeReclamationRequest;
    coordinator.registerParticipant(participants[0]!, {
      reclaim(value) {
        request = value;
        return pending.promise;
      }
    });
    const controller = new AbortController();
    const operation = coordinator.reserveWithReclamation({
      participantId: participants[1]!,
      generation: 1,
      category: "asset-full",
      bytes: 4,
      signal: controller.signal
    });
    operation.catch(() => undefined);
    await Promise.resolve();
    expect(coordinator.snapshot().pendingCount).toBe(1);

    controller.abort();
    await expect(operation).rejects.toMatchObject({ name: "AbortError" });
    expect(coordinator.snapshot()).toMatchObject({
      pendingCount: 0,
      disposed: false
    });
    expect(manager.snapshot()).toMatchObject({
      physicalBytes: 4,
      byteLeaseCount: 1,
      pendingReclamations: 0
    });

    victim.lease.release();
    pending.resolve(resultFor(request, 4, true));
    await coordinator.dispose();
  });
});

interface OwnedReclaimable {
  readonly participantId: RuntimeParticipantId;
  readonly lease: RuntimeByteLease;
  readonly bytes: number;
}

function setup(pageBytes: number, playerBytes: number, count: number): {
  readonly manager: PageResourceManager;
  readonly coordinator: PageReclamationCoordinator;
  readonly participants: readonly RuntimeParticipantId[];
} {
  const manager = new PageResourceManager(createRuntimePageResourcePolicy({
    maximumPagePhysicalBytes: pageBytes,
    maximumPlayerLogicalBytes: playerBytes
  }));
  const participants = Array.from({ length: count }, () =>
    manager.registerParticipant()
  );
  return {
    manager,
    coordinator: new PageReclamationCoordinator(manager),
    participants
  };
}

function ownedReclaimable(
  manager: PageResourceManager,
  participantId: RuntimeParticipantId,
  category: RuntimeByteCategory,
  bytes: number,
  visibility: RuntimeParticipantVisibility,
  phase: RuntimeParticipantPhase
): OwnedReclaimable {
  const lease = manager.reserve(participantId, category, bytes);
  manager.updateParticipant(participantId, {
    visibility,
    phase,
    reclaimable: [{ category, bytes }]
  });
  return { participantId, lease, bytes };
}

function registerRelease(
  coordinator: PageReclamationCoordinator,
  owned: OwnedReclaimable,
  log: string[],
  beforeRelease: () => void = () => undefined
): ReturnType<typeof vi.fn<RuntimeReclamationParticipant["reclaim"]>> {
  const reclaim = vi.fn(async (request: RuntimeReclamationRequest) => {
    log.push(request.reason);
    beforeRelease();
    owned.lease.release();
    return resultFor(request, owned.bytes, true);
  });
  coordinator.registerParticipant(owned.participantId, { reclaim });
  return reclaim;
}

function resultFor(
  request: RuntimeReclamationRequest,
  releasedBytes: number,
  covered: boolean
): RuntimeReclamationResult {
  return Object.freeze({ token: request.token, releasedBytes, covered });
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((done) => { resolve = done; }),
    resolve
  };
}
