import { describe, expect, it } from "vitest";

import {
  RUNTIME_BYTE_CATEGORIES,
  type RuntimeByteCategory,
  type RuntimeByteLease,
  type RuntimeParticipantId
} from "./model.js";
import {
  PageResourceManager,
  reclassifyPageResourceByteLease,
  registerPageResourceCounterContributor
} from "./page-resource-manager.js";
import { createRuntimePageResourcePolicy } from "./page-resource-policy.js";

describe("page resource manager byte accounting", () => {
  it("rejects externally forged certification status", () => {
    expect(() => new PageResourceManager({
      maximumDecoderLeases: 3,
      maximumPagePhysicalBytes: 192 * 1024 * 1024,
      maximumPlayerLogicalBytes: 64 * 1024 * 1024,
      referenceProfile: true
    })).toThrow(TypeError);
    expect(() => new PageResourceManager({
      maximumDecoderLeases: 1,
      maximumPagePhysicalBytes: 1024,
      maximumPlayerLogicalBytes: 512,
      referenceProfile: false
    })).toThrow(TypeError);
  });

  it("composes bounded counters without exposing collaborator control", () => {
    const manager = managerWithCaps(64, 32);
    expect("registerResourceCounterContributor" in manager).toBe(false);
    const unregister = registerPageResourceCounterContributor(manager, {
      resourceCounters: () => ({
        decoderLeaseCount: 2,
        decoderQueueLength: 3,
        pendingReclamations: 1
      })
    });
    expect(manager.snapshot()).toMatchObject({
      decoderLeaseCount: 2,
      decoderQueueLength: 3,
      pendingReclamations: 1
    });
    unregister();
    unregister();
    expect(manager.snapshot()).toMatchObject({
      decoderLeaseCount: 0,
      decoderQueueLength: 0,
      pendingReclamations: 0
    });
  });

  it("admits exact player/page limits and transactionally rejects one byte over", () => {
    const manager = managerWithCaps(10, 6);
    const first = manager.registerParticipant();
    const second = manager.registerParticipant();

    const firstLease = manager.reserve(first, "asset-full", 6);
    const beforePlayerFailure = manager.snapshot();
    expect(() => manager.reserve(first, "quarantine", 1)).toThrowError(
      expect.objectContaining({
        code: "resource-rejection",
        failure: expect.objectContaining({
          context: expect.objectContaining({
            expectedBytes: 1,
            playerBytes: 6,
            pageBytes: 6
          })
        })
      })
    );
    expect(manager.snapshot()).toEqual(beforePlayerFailure);

    const secondLease = manager.reserve(second, "verified-static", 4);
    const beforePageFailure = manager.snapshot();
    expect(() => manager.reserve(second, "png-copy", 1)).toThrowError(
      expect.objectContaining({ code: "resource-rejection" })
    );
    expect(manager.snapshot()).toEqual(beforePageFailure);
    expect(manager.snapshot()).toMatchObject({
      physicalBytes: 10,
      byteLeaseCount: 2
    });

    firstLease.release();
    secondLease.release();
    expect(manager.snapshot()).toMatchObject({
      physicalBytes: 0,
      byteLeaseCount: 0
    });
  });

  it("resizes by checked delta and makes release idempotent", async () => {
    const manager = managerWithCaps(8, 8);
    const participant = manager.registerParticipant();
    const lease = manager.reserve(participant, "frame-staging", 4);

    await lease.resize(8);
    expect(lease.snapshot()).toMatchObject({ bytes: 8, released: false });
    expect(manager.snapshot().physicalBytes).toBe(8);

    const beforeFailure = manager.snapshot();
    await expect(lease.resize(9)).rejects.toMatchObject({
      code: "resource-rejection"
    });
    expect(manager.snapshot()).toEqual(beforeFailure);

    await lease.resize(2);
    expect(manager.snapshot().physicalBytes).toBe(2);
    await lease.resize(0);
    expect(manager.snapshot().physicalBytes).toBe(0);
    expect(manager.snapshot().byteLeaseCount).toBe(1);

    lease.release();
    lease.release();
    expect(lease.snapshot()).toMatchObject({ bytes: 0, released: true });
    expect(manager.snapshot().byteLeaseCount).toBe(0);
    await expect(lease.resize(1)).rejects.toMatchObject({ code: "disposed" });
  });

  it("uses opaque monotonic IDs and manager-issued touch order", () => {
    const manager = managerWithCaps(64, 32);
    const first = manager.registerParticipant({
      generation: 3,
      visibility: "hidden",
      phase: "loading"
    });
    const second = manager.registerParticipant();

    expect(Number(second)).toBe(Number(first) + 1);
    expect(manager.participantSnapshot(first)).toMatchObject({
      generation: 3,
      visibility: "hidden",
      phase: "loading",
      lastTouchSequence: 1,
      logicalBytes: 0
    });
    expect(manager.participantSnapshot(second).lastTouchSequence).toBe(2);

    expect(manager.touchParticipant(first).lastTouchSequence).toBe(3);
    const lease = manager.reserve(second, "verified-unit", 7);
    const updated = manager.updateParticipant(second, {
      generation: 2,
      visibility: "visible",
      phase: "preparing",
      reclaimable: [{ category: "verified-unit", bytes: 5 }]
    });
    expect(updated).toMatchObject({
      generation: 2,
      visibility: "visible",
      phase: "preparing",
      lastTouchSequence: 4,
      logicalBytes: 7,
      reclaimable: [{ category: "verified-unit", bytes: 5 }]
    });
    lease.release();
    expect(manager.participantSnapshot(second).reclaimable).toEqual([]);
  });

  it("reports every closed category in canonical order", () => {
    const manager = managerWithCaps(100, 100);
    const participant = manager.registerParticipant();
    const leases = RUNTIME_BYTE_CATEGORIES.map((category) =>
      manager.reserve(participant, category, 1)
    );

    expect(manager.snapshot().categories).toEqual(
      RUNTIME_BYTE_CATEGORIES.map((category) => ({ category, bytes: 1 }))
    );
    expect(manager.participantSnapshot(participant).logicalBytes).toBe(
      RUNTIME_BYTE_CATEGORIES.length
    );
    for (const lease of leases) lease.release();
  });

  it("atomically reclassifies an authentic live lease without changing totals", () => {
    const manager = managerWithCaps(4, 4);
    const participant = manager.registerParticipant();
    const lease = manager.reserve(participant, "incoming-static-surface", 4);
    const before = manager.snapshot();

    reclassifyPageResourceByteLease(
      manager,
      lease,
      "current-static-surface"
    );

    expect(lease.snapshot()).toMatchObject({
      category: "current-static-surface",
      bytes: 4,
      released: false
    });
    const after = manager.snapshot();
    expect(after.physicalBytes).toBe(before.physicalBytes);
    expect(after.byteLeaseCount).toBe(before.byteLeaseCount);
    expect(after.categories.find(({ category }) =>
      category === "incoming-static-surface")?.bytes).toBe(0);
    expect(after.categories.find(({ category }) =>
      category === "current-static-surface")?.bytes).toBe(4);
    expect(manager.participantSnapshot(participant).logicalBytes).toBe(4);

    // The operation is an idempotent category transition, not a reservation.
    reclassifyPageResourceByteLease(
      manager,
      lease,
      "current-static-surface"
    );
    expect(manager.snapshot()).toEqual(after);
    lease.release();
  });

  it("rejects forged, cross-manager, retired, and inaccessible lease identities", () => {
    const first = managerWithCaps(8, 8);
    const second = managerWithCaps(8, 8);
    const participant = first.registerParticipant();
    second.registerParticipant();
    const lease = first.reserve(participant, "incoming-static-surface", 3);
    const hostile = Object.defineProperty({}, "snapshot", {
      get() {
        throw new Error("must not inspect a forged lease");
      }
    }) as RuntimeByteLease;

    expect(() => reclassifyPageResourceByteLease(
      second,
      lease,
      "current-static-surface"
    )).toThrow(TypeError);
    expect(() => reclassifyPageResourceByteLease(
      first,
      hostile,
      "current-static-surface"
    )).toThrow(TypeError);
    expect(first.snapshot().physicalBytes).toBe(3);

    lease.release();
    expect(() => reclassifyPageResourceByteLease(
      first,
      lease,
      "decoded-static-cache"
    )).toThrowError(expect.objectContaining({ code: "disposed" }));
    first.dispose();
    expect(() => reclassifyPageResourceByteLease(
      first,
      lease,
      "decoded-static-cache"
    )).toThrowError(expect.objectContaining({ code: "disposed" }));
  });

  it("survives reentrant release immediately after a category transition", () => {
    const manager = managerWithCaps(8, 8);
    const participant = manager.registerParticipant({
      reclaimable: []
    });
    const lease = manager.reserve(participant, "incoming-static-surface", 8);

    reclassifyPageResourceByteLease(
      manager,
      lease,
      "decoded-static-cache"
    );
    lease.release();
    lease.release();

    expect(manager.snapshot()).toMatchObject({
      physicalBytes: 0,
      byteLeaseCount: 0
    });
    expect(manager.snapshot().categories.every(({ bytes }) => bytes === 0))
      .toBe(true);
  });

  it("rejects unknown categories, hostile numbers, stale generations, and unknown participants", async () => {
    const manager = managerWithCaps(64, 32);
    const participant = manager.registerParticipant({ generation: 4 });

    for (const bytes of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => manager.reserve(participant, "asset-full", bytes)).toThrow(
        RangeError
      );
    }
    expect(() => manager.reserve(
      participant,
      "other" as RuntimeByteCategory,
      1
    )).toThrow(TypeError);
    expect(() => manager.updateParticipant(participant, {
      generation: 3
    })).toThrow(RangeError);
    expect(() => manager.touchParticipant(99 as RuntimeParticipantId)).toThrow();
    expect(() => manager.registerParticipant({
      surprise: true
    } as never)).toThrow(TypeError);

    const lease = manager.reserve(participant, "asset-full", 1);
    for (const bytes of [-1, 0.5, Number.POSITIVE_INFINITY]) {
      await expect(lease.resize(bytes)).rejects.toBeInstanceOf(RangeError);
    }
    expect(manager.snapshot().physicalBytes).toBe(1);
    lease.release();
  });

  it("deep-freezes sanitized snapshots", () => {
    const manager = managerWithCaps(64, 32);
    const participant = manager.registerParticipant();
    manager.reserve(participant, "quarantine", 3);
    manager.updateParticipant(participant, {
      reclaimable: [{ category: "quarantine", bytes: 2 }]
    });
    const snapshot = manager.snapshot();

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.policy)).toBe(true);
    expect(Object.isFrozen(snapshot.categories)).toBe(true);
    expect(snapshot.categories.every(Object.isFrozen)).toBe(true);
    expect(Object.isFrozen(snapshot.participants)).toBe(true);
    expect(snapshot.participants.every(Object.isFrozen)).toBe(true);
    expect(snapshot.participants.every((state) =>
      Object.isFrozen(state.reclaimable) && state.reclaimable.every(Object.isFrozen)
    )).toBe(true);
    expect("url" in snapshot).toBe(false);
  });

  it("disposes a participant with live leases and makes late releases inert", () => {
    const manager = managerWithCaps(64, 32);
    const first = manager.registerParticipant();
    const second = manager.registerParticipant();
    const firstLease = manager.reserve(first, "asset-metadata", 4);
    const secondLease = manager.reserve(second, "verified-static", 5);

    manager.disposeParticipant(first);
    expect(firstLease.snapshot()).toMatchObject({ released: true, bytes: 4 });
    expect(manager.snapshot()).toMatchObject({
      physicalBytes: 5,
      byteLeaseCount: 1
    });
    expect(manager.snapshot().participants.map(({ id }) => id)).toEqual([second]);
    firstLease.release();
    expect(manager.snapshot().physicalBytes).toBe(5);

    secondLease.release();
    manager.disposeParticipant(first);
    manager.disposeParticipant(second);
  });

  it("disposal retires all leases and leaves an all-zero immutable snapshot", () => {
    const manager = managerWithCaps(64, 32);
    const participant = manager.registerParticipant();
    const lease = manager.reserve(participant, "decoded-static-cache", 12);

    manager.dispose();
    manager.dispose();
    expect(lease.snapshot()).toMatchObject({ released: true });
    expect(manager.snapshot()).toMatchObject({
      physicalBytes: 0,
      byteLeaseCount: 0,
      decoderLeaseCount: 0,
      decoderQueueLength: 0,
      pendingReclamations: 0,
      participants: []
    });
    expect(manager.snapshot().categories.every(({ bytes }) => bytes === 0))
      .toBe(true);
    expect(() => manager.registerParticipant()).toThrowError(
      expect.objectContaining({ code: "disposed" })
    );
    lease.release();
  });

  it("matches a seeded integer oracle across reserve/resize/release schedules", async () => {
    const manager = managerWithCaps(73, 41);
    const participants = [
      manager.registerParticipant(),
      manager.registerParticipant(),
      manager.registerParticipant()
    ];
    const leases: Array<{
      readonly participant: number;
      category: RuntimeByteCategory;
      readonly lease: RuntimeByteLease;
      bytes: number;
      active: boolean;
    }> = [];
    const random = lcg(0x7a11ce);

    for (let step = 0; step < 500; step += 1) {
      const choice = random() % 4;
      const active = leases.filter((lease) => lease.active);
      if (choice === 0 || active.length === 0) {
        const participantIndex = random() % participants.length;
        const category = RUNTIME_BYTE_CATEGORIES[
          random() % RUNTIME_BYTE_CATEGORIES.length
        ]!;
        const bytes = (random() % 11) + 1;
        const pageTotal = oraclePageBytes(leases);
        const playerTotal = oraclePlayerBytes(leases, participantIndex);
        if (pageTotal + bytes <= 73 && playerTotal + bytes <= 41) {
          leases.push({
            participant: participantIndex,
            category,
            lease: manager.reserve(participants[participantIndex]!, category, bytes),
            bytes,
            active: true
          });
        } else {
          const before = manager.snapshot();
          expect(() => manager.reserve(
            participants[participantIndex]!,
            category,
            bytes
          )).toThrowError(expect.objectContaining({ code: "resource-rejection" }));
          expect(manager.snapshot()).toEqual(before);
        }
      } else if (choice === 1) {
        const selected = active[random() % active.length]!;
        selected.lease.release();
        selected.active = false;
      } else if (choice === 2) {
        const selected = active[random() % active.length]!;
        const nextBytes = random() % 15;
        const delta = nextBytes - selected.bytes;
        const pageTotal = oraclePageBytes(leases);
        const playerTotal = oraclePlayerBytes(leases, selected.participant);
        if (
          delta <= 0 ||
          (pageTotal + delta <= 73 && playerTotal + delta <= 41)
        ) {
          await selected.lease.resize(nextBytes);
          selected.bytes = nextBytes;
        } else {
          const before = manager.snapshot();
          await expect(selected.lease.resize(nextBytes)).rejects.toMatchObject({
            code: "resource-rejection"
          });
          expect(manager.snapshot()).toEqual(before);
        }
      } else {
        const selected = active[random() % active.length]!;
        const category = RUNTIME_BYTE_CATEGORIES[
          random() % RUNTIME_BYTE_CATEGORIES.length
        ]!;
        reclassifyPageResourceByteLease(manager, selected.lease, category);
        selected.category = category;
      }

      const snapshot = manager.snapshot();
      expect(snapshot.physicalBytes).toBe(oraclePageBytes(leases));
      expect(snapshot.byteLeaseCount).toBe(
        leases.filter((lease) => lease.active).length
      );
      for (let index = 0; index < participants.length; index += 1) {
        expect(manager.participantSnapshot(participants[index]!).logicalBytes)
          .toBe(oraclePlayerBytes(leases, index));
      }
      for (const category of RUNTIME_BYTE_CATEGORIES) {
        expect(snapshot.categories.find((entry) => entry.category === category)?.bytes)
          .toBe(leases.reduce(
            (sum, lease) => sum + (
              lease.active && lease.category === category ? lease.bytes : 0
            ),
            0
          ));
      }
    }
  });
});

function managerWithCaps(pageBytes: number, playerBytes: number): PageResourceManager {
  return new PageResourceManager(createRuntimePageResourcePolicy({
    maximumPagePhysicalBytes: pageBytes,
    maximumPlayerLogicalBytes: playerBytes
  }));
}

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state;
  };
}

function oraclePageBytes(
  leases: readonly { readonly active: boolean; readonly bytes: number }[]
): number {
  return leases.reduce(
    (sum, lease) => sum + (lease.active ? lease.bytes : 0),
    0
  );
}

function oraclePlayerBytes(
  leases: readonly {
    readonly active: boolean;
    readonly bytes: number;
    readonly participant: number;
  }[],
  participant: number
): number {
  return leases.reduce(
    (sum, lease) => sum + (
      lease.active && lease.participant === participant ? lease.bytes : 0
    ),
    0
  );
}
